// @ts-check
// No internals leak (app.mjs `answer`, observe.mjs): an unexpected error is said by its HTTP status, code or name,
// never by its message, in the answer a caller reads and in the log lines the core writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ME, makeDeps, pushArgs, record } from './helpers.mjs';
import { runResolver, runTool } from '../src/core/app.mjs';
import { errTag, AppError } from '../src/core/util.mjs';

const PK = 'github-com-Acme-Shop';
const SECRET = 'Field summary of HR-7 Salary review is too long; SELECT * FROM proposals WHERE id = 3';
/** @param {number} [status] */
const leaky = (status) => Object.assign(new Error(SECRET), status ? { status } : {});
/** @param {any} d @param {string} key @param {Record<string, unknown>} p */
const res = async (d, key, p) => /** @type {any} */ (await runResolver(d, key, p, ME, 'inbox'));

async function seeded() {
  const d = makeDeps();
  await runTool(d, 'dowser_proposals_push', pushArgs([record({ topic: 'a' }), record({ topic: 'b' })]), ME);
  await res(d, 'settings.set', { project_key: PK, jira_project_key: 'SHOP', issue_type_id: '10001' });
  return d;
}

test('errTag says a status, a code or a name, never the message', () => {
  assert.equal(errTag(leaky(503)), 'HTTP 503');
  assert.equal(errTag(Object.assign(new Error(SECRET), { code: 'ER_LOCK_WAIT_TIMEOUT' })), 'ER_LOCK_WAIT_TIMEOUT');
  assert.equal(errTag(new TypeError(SECRET)), 'TypeError');
  assert.equal(errTag(Object.assign(new Error(SECRET), { code: SECRET })), 'Error', 'a code that is not a plain token is dropped');
  assert.equal(errTag('boom'), 'string');
  assert.equal(errTag(new AppError('unauthorized', 'sign in again')), 'sign in again', "Dowser's own text is kept");
});

test('a Jira or Confluence failure reaches the caller as its status, not its response text', async () => {
  const d = await seeded();
  d.jira.createIssue = async () => { throw leaky(400); };
  const acc = await res(d, 'verdict.accept', { ref: 'DW-1' });
  assert.equal(acc.error, 'unavailable');
  assert.match(acc.message, /HTTP 400/);
  assert.doesNotMatch(acc.message, /Salary|SELECT/);

  d.jira.addComment = async () => { throw leaky(403); };
  const mg = await res(d, 'verdict.merge', { ref: 'DW-1', into: 'SHOP-9' });
  assert.match(mg.message, /HTTP 403/);
  assert.doesNotMatch(mg.message, /Salary/);

  d.jira.listProjects = async () => { throw leaky(); };
  const pj = await res(d, 'jira.projects', {});
  assert.equal(pj.error, 'unavailable');
  assert.doesNotMatch(pj.message, /Salary/);

  d.sources = { ...(/** @type {any} */ (d.sources)), tickets: async () => { throw leaky(500); } };
  const tk = /** @type {any} */ (await runTool(d, 'dowser_sources_tickets', { query: 'csv', limit: 5 }, ME));
  assert.equal(tk.error, 'unavailable');
  assert.doesNotMatch(tk.message, /Salary/);
});

test('soft failures log a status or a name, never the message', async () => {
  const d = await seeded();
  const lines = /** @type {string[]} */ ([]);
  const warn = console.warn;
  console.warn = (/** @type {unknown[]} */ ...a) => { lines.push(a.map(String).join(' ')); };
  try {
    d.users.names = async () => { throw leaky(403); };
    d.jira.setIssueProperty = async () => { throw leaky(500); };
    d.db.failNext = /INSERT INTO verdicts/;
    const out = await res(d, 'verdict.accept', { ref: 'DW-1' });
    assert.equal(out.card.status, 'accepted', 'soft failures never cost the decision');
    await res(d, 'verdict.reject', { refs: ['DW-2'], reason: 'already-known' });
    await res(d, 'proposal.get', { ref: 'DW-2' }); // its history names the decider
  } finally {
    console.warn = warn;
  }
  const all = [...d.logs, ...lines];
  assert.ok(all.some((l) => /issue property/.test(l) && /HTTP 500/.test(l)), all.join('\n'));
  assert.ok(all.some((l) => /user names/.test(l)), all.join('\n'));
  assert.ok(all.some((l) => /not logged yet/.test(l)), all.join('\n'));
  assert.ok(all.every((l) => !/Salary|SELECT|injected failure/.test(l)), all.join('\n'));
});
