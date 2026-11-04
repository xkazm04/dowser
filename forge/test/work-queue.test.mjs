// @ts-check
// The agent work queue over MCP (moonshot 2026-11-04, idea 2): any coding agent can list the human-accepted work
// that is not delivered yet, fetch one item's brief (evidence pinned to the scanned commit, and what "done" means in
// terms `delivery` re-checks), and report progress back into Jira. Acceptance stays a person's click: the queue
// holds only accepted items.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ME, makeDeps, pushArgs, record } from './helpers.mjs';
import { actionName, runResolver, runTool } from '../src/core/app.mjs';
import { onIssueEvent } from '../src/core/delivery.mjs';

const PK = 'github-com-Acme-Shop';
/** @param {any} d @param {string} name @param {Record<string, unknown>} a @param {string} [who] */
const tool = (d, name, a, who = ME) => /** @type {Promise<any>} */ (runTool(d, name, a, who));
/** @param {any} d @param {string} key @param {Record<string, unknown>} p */
const res = (d, key, p) => /** @type {Promise<any>} */ (runResolver(d, key, p, ME, 'inbox'));

async function seeded() {
  const d = makeDeps();
  await tool(d, 'dowser_proposals_push', pushArgs(['alpha', 'beta', 'gamma', 'delta'].map((topic) => record({ topic })), { run_id: 'r-1' }));
  await res(d, 'settings.set', { project_key: PK, jira_project_key: 'SHOP', issue_type_id: '10001' });
  const a = (await res(d, 'verdict.accept', { ref: 'DW-1' })).card.issue_ref;
  const b = (await res(d, 'verdict.accept', { ref: 'DW-2' })).card.issue_ref;
  await res(d, 'verdict.reject', { refs: ['DW-3'], reason: 'not-worth-it' });
  return { d, a, b };
}

test('work_list holds accepted, undelivered items only, oldest decision first; delivered work leaves it', async () => {
  const { d, a } = await seeded();
  let out = await tool(d, 'dowser_work_list', { project_key: PK, queue: 'open' });
  assert.deepEqual(out.items.map((/** @type {any} */ i) => i.ref), ['DW-1', 'DW-2'], 'no open, rejected or other item');
  assert.equal(out.items[0].issue_ref, a);
  assert.ok(out.items[0].title && out.items[0].lens);
  await onIssueEvent(d, { eventType: 'avi:jira:updated:issue', issue: { key: a, fields: { status: { name: 'Done', statusCategory: { key: 'done' } } } }, changelog: { items: [{ field: 'status', toString: 'Done' }] } });
  out = await tool(d, 'dowser_work_list', { project_key: PK, queue: 'open' });
  assert.deepEqual(out.items.map((/** @type {any} */ i) => i.ref), ['DW-2'], 'delivered in Jira: no longer work');
  assert.equal((await tool(d, 'dowser_work_list', { project_key: PK, queue: 'all' })).items.length, 2);
  assert.equal((await tool(d, 'dowser_work_list', { project_key: PK, queue: 'mine' })).error, 'bad-input');
  assert.equal(actionName('mcp', [], { project_key: PK, queue: 'open' }), 'dowser_work_list');
});

test('work_get gives the brief: the card, its evidence, and done-when lines delivery re-checks; open items are refused', async () => {
  const { d, b } = await seeded();
  const w = await tool(d, 'dowser_work_get', { ref: 'DW-2' });
  assert.equal(w.card.ref, 'DW-2');
  assert.equal(w.issue_ref, b);
  assert.ok(w.card.body.includes('## Summary'));
  assert.deepEqual(w.done_when, ['src/reports/export.js:12 no longer contains: export function exportReport() {']);
  assert.equal((await tool(d, 'dowser_work_get', { ref: 'DW-4' })).error, 'bad-input', 'an open item is not work: a person has not accepted it');
  assert.equal(actionName('mcp', [], { ref: 'DW-2' }), 'dowser_work_get');
});

test('work_report records progress, comments on the Jira issue, and the list shows the latest status', async () => {
  const { d, b } = await seeded();
  const r = await tool(d, 'dowser_work_report', { ref: 'DW-2', status: 'pr_open', note: 'tests green', url: 'https://github.com/acme/shop/pull/7' });
  assert.equal(r.report.status, 'pr_open');
  assert.equal(r.report.by, `forge:${ME}`);
  const comment = d.jira.comments.at(-1);
  assert.equal(comment?.issueKey, b);
  assert.match(JSON.stringify(comment?.body), /pull\/7/);
  const list = await tool(d, 'dowser_work_list', { project_key: PK, queue: 'open' });
  assert.equal(list.items.find((/** @type {any} */ i) => i.ref === 'DW-2').work_status, 'pr_open');
  assert.equal((await tool(d, 'dowser_work_report', { ref: 'DW-2', status: 'shipped' })).error, 'bad-input');
  assert.equal((await tool(d, 'dowser_work_report', { ref: 'DW-2', status: 'done', url: 'javascript:alert(1)' })).error, 'bad-input');
  assert.equal((await tool(d, 'dowser_work_report', { ref: 'DW-3', status: 'started' })).error, 'bad-input', 'a rejected item is not work');
  assert.equal(actionName('mcp', [], { ref: 'DW-2', status: 'done' }), 'dowser_work_report');
});
