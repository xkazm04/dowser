// @ts-check
// The adapters' own branches, against scripted product answers: the Atlassian adapter through its @forge/api seam
// (useForgeApi), the Forge SQL adapter with @forge/sql's `sql.prepare` replaced. The core tests use fake ports, so
// these are the only tests that reach adapter code.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from '@forge/sql';
import { jira, perms, sources, useForgeApi, users } from '../src/adapters/atlassian.mjs';
import { forgeDb } from '../src/adapters/forge-sql.mjs';
import { AppError, DuplicateKey } from '../src/core/util.mjs';

/**
 * @typedef {{who: 'app' | 'user', path: string, method: string, body?: any}} Call
 * @typedef {{status: number, body?: any}} Answer
 */

/** A response as @forge/api answers it. @param {Answer} a */
const response = (a) => ({ ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.body ?? {} });

/**
 * Scripts the product: `answer(call)` gives each request's answer; every call is recorded.
 * @param {(c: Call) => Answer} answer
 */
function script(answer) {
  /** @type {Call[]} */
  const calls = [];
  /** @param {'app' | 'user'} who */
  const as = (who) => {
    /** @param {string} path @param {any} [init] */
    const req = async (path, init) => {
      const c = { who, path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : undefined };
      calls.push(c);
      return response(answer(c));
    };
    return { requestJira: req, requestConfluence: req, requestTeamworkGraph: async () => response(answer({ who, path: 'twg', method: 'POST' })) };
  };
  restore = useForgeApi(/** @type {any} */ ({
    asApp: () => as('app'),
    asUser: () => as('user'),
    getAppContext: () => ({ installationAri: { installationId: 'inst-1' }, appAri: { appId: 'app' }, environmentAri: { environmentId: 'env' } }),
    route: (/** @type {TemplateStringsArray} */ s, /** @type {unknown[]} */ ...v) => s.reduce((a, part, i) => a + part + (i < v.length ? String(v[i]) : ''), ''),
  }));
  return calls;
}
/** @type {(() => void) | undefined} */
let restore;
afterEach(() => { restore?.(); restore = undefined; });

const SERVER = { status: 200, body: { baseUrl: 'https://acme.atlassian.net/' } };

test('perms: a 404 is no permission at all, a body answers per key, 401 is unauthorized, a failure throws with its status', async () => {
  let next = /** @type {Answer} */ ({ status: 404 });
  const calls = script(() => next);
  assert.deepEqual(await perms.mine(['BROWSE_PROJECTS', 'CREATE_ISSUES'], { projectKey: 'HR' }), { BROWSE_PROJECTS: false, CREATE_ISSUES: false });
  assert.equal(calls[0].who, 'user');
  assert.match(calls[0].path, /mypermissions\?permissions=BROWSE_PROJECTS%2CCREATE_ISSUES&projectKey=HR/);
  next = { status: 200, body: { permissions: { BROWSE_PROJECTS: { havePermission: true }, CREATE_ISSUES: { havePermission: false } } } };
  assert.deepEqual(await perms.mine(['BROWSE_PROJECTS', 'CREATE_ISSUES']), { BROWSE_PROJECTS: true, CREATE_ISSUES: false });
  next = { status: 401 };
  await assert.rejects(() => perms.mine(['ADMINISTER']), (e) => e instanceof AppError && e.code === 'unauthorized');
  next = { status: 503, body: { errorMessages: ['secret detail'] } };
  await assert.rejects(() => perms.mine(['ADMINISTER']), (/** @type {any} */ e) => e.status === 503 && !/secret/.test(e.message));
});

test('listProjects pages until isLast, drops subtask types, and stops at 1000', async () => {
  const page = (/** @type {number} */ start, /** @type {number} */ n, /** @type {boolean} */ last) => ({ status: 200, body: {
    isLast: last, values: Array.from({ length: n }, (_, i) => ({ key: `P${start + i}`, name: `Project ${start + i}`,
      issueTypes: [{ id: '1', name: 'Story' }, { id: '2', name: 'Sub-task', subtask: true }] })) } });
  let calls = script((c) => {
    const start = Number(new URLSearchParams(c.path.split('?')[1]).get('startAt'));
    return start === 0 ? page(0, 50, false) : page(50, 20, true);
  });
  const two = await jira.listProjects();
  assert.equal(two.length, 70);
  assert.deepEqual(two[0], { key: 'P0', name: 'Project 0', issue_types: [{ id: '1', name: 'Story' }] });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.who === 'user'));

  restore?.();
  calls = script((c) => page(Number(new URLSearchParams(c.path.split('?')[1]).get('startAt')), 50, false));
  assert.equal((await jira.listProjects()).length, 1000, 'cut at 1000 projects');
  assert.equal(calls.length, 20);
});

test('createIssue retries without labels on a 400, and a 400 without labels is a failure with its status', async () => {
  const calls = script((c) => {
    if (c.path.includes('serverInfo')) return SERVER;
    if (c.body?.fields?.labels) return { status: 400, body: { errors: { labels: 'Field labels cannot be set' } } };
    return { status: 201, body: { key: 'SHOP-7' } };
  });
  const out = await jira.createIssue({ projectKey: 'SHOP', issueTypeId: '1', summary: 's', description: { type: 'doc', version: 1, content: [] }, labels: ['dowser-sample'] });
  assert.deepEqual(out, { key: 'SHOP-7', url: 'https://acme.atlassian.net/browse/SHOP-7' });
  const posts = calls.filter((c) => c.method === 'POST');
  assert.deepEqual(posts.map((c) => [c.who, c.body.fields.labels]), [['app', ['dowser-sample']], ['app', undefined]]);

  restore?.();
  script(() => ({ status: 400, body: { errors: { summary: 'HR-7 Salary review' } } }));
  await assert.rejects(() => jira.createIssue({ projectKey: 'SHOP', issueTypeId: '1', summary: 's', description: { type: 'doc', version: 1, content: [] } }),
    (/** @type {any} */ e) => e.status === 400 && !/Salary/.test(e.message), 'no label to drop: no retry, the body stays out');
});

test('users.names skips a failed batch and keeps the others', async () => {
  const ids = Array.from({ length: 60 }, (_, i) => `acc-${i}`);
  const calls = script((c) => {
    const asked = new URLSearchParams(c.path.split('?')[1]).getAll('accountId');
    if (asked.includes('acc-0')) return { status: 500 };
    return { status: 200, body: { values: asked.map((a) => ({ accountId: a, displayName: `Name ${a}` })) } };
  });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const out = await users.names(ids);
    assert.equal(calls.length, 2, 'two batches of at most 50');
    assert.ok(calls.every((c) => c.who === 'app'));
    assert.deepEqual(Object.keys(out), ids.slice(50), 'the failed first batch is omitted, the second kept');
  } finally {
    console.warn = warn;
  }
});

test('goals: a refused Teamwork Graph is unavailable with the allowlist step; goals without links are unavailable too', async () => {
  let next = /** @type {Answer} */ ({ status: 403 });
  script(() => next);
  await assert.rejects(() => sources.goals(), (e) => e instanceof AppError && e.code === 'unavailable' && /allowlisted/.test(e.message));
  next = { status: 200, body: { data: { cypherQuery: { edges: [{ node: { columns: [{ value: { nodes: [{ id: 'g1', data: { id: 'g1', name: 'Grow' } }] } }] } }] } } } };
  await assert.rejects(() => sources.goals(), (e) => e instanceof AppError && /1 goals without links/.test(e.message));
  next = { status: 200, body: { errors: [{ message: 'internal detail about tenant 42', extensions: { errorType: 'FORBIDDEN' } }] } };
  await assert.rejects(() => sources.goals(), (e) => e instanceof AppError && /FORBIDDEN/.test(e.message) && !/tenant 42/.test(e.message));
});

test('forgeDb: a TiDB duplicate-entry error is DuplicateKey; any other error is rethrown as it is', async () => {
  const prepare = sql.prepare;
  const fail = (/** @type {Error} */ err) => /** @type {any} */ (() => ({ bindParams: () => ({ execute: async () => { throw err; } }) }));
  try {
    sql.prepare = fail(Object.assign(new Error("Duplicate entry 'seq:x' for key 'counters.PRIMARY'"), { code: 'SQL_EXECUTION_ERROR' }));
    await assert.rejects(() => forgeDb.exec('INSERT INTO counters (name, value) VALUES (?, ?)', ['seq:x', 1]), (e) => e instanceof DuplicateKey);
    const other = new Error('Unknown SQL execution error');
    sql.prepare = fail(other);
    await assert.rejects(() => forgeDb.query('SELECT 1'), (e) => e === other);
    sql.prepare = /** @type {any} */ (() => ({ bindParams: () => ({ execute: async () => ({ rows: { affectedRows: 3 } }) }) }));
    assert.deepEqual(await forgeDb.exec('UPDATE x SET y = 1'), { affectedRows: 3 });
  } finally {
    sql.prepare = prepare;
  }
});
