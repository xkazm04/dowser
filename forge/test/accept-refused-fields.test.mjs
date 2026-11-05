// @ts-check
// DW-63: when Jira refuses to create an accepted card's issue, the person is told which fields Jira named, never
// what Jira said about them. The adapter keeps the KEYS of a 400's `errors` object (values can quote issue content)
// on the thrown error as `fields`, and the accept answer names them with the next step.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ME, makeDeps, pushArgs, record } from './helpers.mjs';
import { jira, useForgeApi } from '../src/adapters/atlassian.mjs';
import { runResolver, runTool } from '../src/core/app.mjs';

/**
 * @typedef {{who: 'app' | 'user', path: string, method: string, body?: any}} Call
 * @typedef {{status: number, body?: any}} Answer
 */

/** A response as @forge/api answers it. @param {Answer} a */
const response = (a) => ({ ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.body ?? {} });

/** @type {(() => void) | undefined} */
let restore;
afterEach(() => { restore?.(); restore = undefined; });

/**
 * Scripts the product (as adapters.test.mjs does): `answer(call)` gives each request's answer.
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
    return { requestJira: req, requestConfluence: req };
  };
  restore = useForgeApi(/** @type {any} */ ({
    asApp: () => as('app'),
    asUser: () => as('user'),
    getAppContext: () => ({ installationAri: { installationId: 'inst-1' }, appAri: { appId: 'app' }, environmentAri: { environmentId: 'env' } }),
    route: (/** @type {TemplateStringsArray} */ s, /** @type {unknown[]} */ ...v) => s.reduce((a, part, i) => a + part + (i < v.length ? String(v[i]) : ''), ''),
  }));
  return calls;
}

/** @type {import('../src/core/ports.mjs').AdfDoc} */
const DESC = { type: 'doc', version: 1, content: [] };
const REFUSED = { status: 400, body: { errors: { customfield_10010: 'Team is required', priority: 'HR-7 Salary review' } } };

/** Every own property of `e` (message included), as one string. @param {any} e */
const ownText = (e) => Object.getOwnPropertyNames(e).map((k) => { try { return JSON.stringify(e[k]) ?? String(e[k]); } catch { return String(e[k]); } }).join(' ');

test('adapter: a refused create keeps the field keys of errors, in order, and none of their values', async () => {
  const calls = script(() => REFUSED);
  await assert.rejects(() => jira.createIssue({ projectKey: 'SHOP', issueTypeId: '1', summary: 's', description: DESC }),
    (/** @type {any} */ e) => {
      assert.equal(e.status, 400);
      assert.deepEqual(e.fields, ['customfield_10010', 'priority']);
      assert.doesNotMatch(e.message, /Team is required|Salary/);
      assert.doesNotMatch(ownText(e), /Team is required|Salary/, 'no own property carries a value');
      return true;
    });
  assert.equal(calls.filter((c) => c.method === 'POST').length, 1, 'no labels: no retry');
});

test('adapter: with labels sent, both posts refused, the second answer\'s field keys are kept', async () => {
  const calls = script(() => REFUSED);
  await assert.rejects(() => jira.createIssue({ projectKey: 'SHOP', issueTypeId: '1', summary: 's', description: DESC, labels: ['dowser-delegate'] }),
    (/** @type {any} */ e) => {
      assert.equal(e.status, 400);
      assert.deepEqual(e.fields, ['customfield_10010', 'priority']);
      assert.doesNotMatch(ownText(e), /Team is required|Salary/);
      return true;
    });
  assert.equal(calls.filter((c) => c.method === 'POST').length, 2, 'the label retry ran');
});

test('adapter: a key outside [A-Za-z0-9_.-]{1,64} is left out', async () => {
  script(() => ({ status: 400, body: { errors: { 'HR-7 Salary review': 'x', priority: 'y', ['a'.repeat(65)]: 'z', 'cf.10_1-a': 'w' } } }));
  await assert.rejects(() => jira.createIssue({ projectKey: 'SHOP', issueTypeId: '1', summary: 's', description: DESC }),
    (/** @type {any} */ e) => {
      assert.deepEqual(e.fields, ['priority', 'cf.10_1-a']);
      assert.doesNotMatch(ownText(e), /Salary/);
      return true;
    });
});

test('adapter: a 400 with no errors object carries no fields at all', async () => {
  script(() => ({ status: 400, body: { errorMessages: ['HR-7 Salary review'] } }));
  await assert.rejects(() => jira.createIssue({ projectKey: 'SHOP', issueTypeId: '1', summary: 's', description: DESC }),
    (/** @type {any} */ e) => {
      assert.equal(e.status, 400);
      assert.equal('fields' in e, false, 'absent, not empty');
      assert.doesNotMatch(ownText(e), /Salary/);
      return true;
    });
});

const PK = 'github-com-Acme-Shop';
/** @param {any} d @param {string} key @param {Record<string, unknown>} p */
const res = async (d, key, p) => /** @type {any} */ (await runResolver(d, key, p, ME, 'inbox'));

async function seeded() {
  const d = makeDeps();
  await runTool(d, 'dowser_proposals_push', pushArgs([record()]), ME);
  await res(d, 'settings.set', { project_key: PK, jira_project_key: 'SHOP', issue_type_id: '10001' });
  return d;
}

test('core: an accept Jira refused names the fields and the next step; DW-1 stays open', async () => {
  const d = await seeded();
  d.jira.createIssue = async () => { throw Object.assign(new Error('x'), { status: 400, fields: ['customfield_10010', 'priority'] }); };
  const out = await res(d, 'verdict.accept', { ref: 'DW-1' });
  assert.equal(out.error, 'unavailable');
  assert.match(out.message, /HTTP 400/);
  assert.match(out.message, /customfield_10010/);
  assert.match(out.message, /priority/);
  assert.match(out.message, /stays open/);
  assert.match(out.message, /another project or issue type/);
});

test('core: a refusal without fields reads as today (guard)', async () => {
  const d = await seeded();
  d.jira.createIssue = async () => { throw Object.assign(new Error('x'), { status: 400 }); };
  const out = await res(d, 'verdict.accept', { ref: 'DW-1' });
  assert.equal(out.error, 'unavailable');
  assert.equal(out.message, 'Jira did not create the issue (HTTP 400); DW-1 stays open');
});
