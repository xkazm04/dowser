// @ts-check
// Forge as the team's memory (moonshot 2026-11-04, idea 3): `dowser_memory_pull` pages the inbox's DECIDED items
// (accepted, rejected, snoozed, merged) with their records, and the decided rules on the first page, so a fresh
// store (a teammate, a CI runner) starts with the team's decisions instead of re-proposing them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ME, makeDeps, pushArgs, record } from './helpers.mjs';
import { actionName, runResolver, runTool } from '../src/core/app.mjs';
import { MEMORY_PAGE } from '../src/core/memory.mjs';

const PK = 'github-com-Acme-Shop';
/** @param {any} d @param {string} name @param {Record<string, unknown>} a @param {string} [who] */
const tool = (d, name, a, who = ME) => /** @type {Promise<any>} */ (runTool(d, name, a, who));
/** @param {any} d @param {string} key @param {Record<string, unknown>} p */
const res = (d, key, p) => /** @type {Promise<any>} */ (runResolver(d, key, p, ME, 'inbox'));

async function seeded() {
  const d = makeDeps();
  await tool(d, 'dowser_proposals_push', pushArgs(['alpha', 'beta', 'gamma', 'delta'].map((topic) => record({ topic })), { run_id: 'r-1' }));
  await res(d, 'settings.set', { project_key: PK, jira_project_key: 'SHOP', issue_type_id: '10001' });
  await res(d, 'verdict.reject', { refs: ['DW-1'], reason: 'already-known', note: 'we ship this in Q1' });
  await res(d, 'verdict.accept', { ref: 'DW-2' });
  await res(d, 'verdict.merge', { ref: 'DW-3', into: 'DW-2' });
  await tool(d, 'dowser_reflect_sync', { project_key: PK, rules_json: JSON.stringify([{ id: 'r1', lens: 'opportunity', text: 'skip demos', offered_at: '2026-10-27T09:00:00.000Z' }]) });
  await res(d, 'rule.decide', { project_key: PK, id: 'r1', state: 'accepted' });
  return d;
}

test('memory pull returns decided items with their records and decisions, never open ones', async () => {
  const d = await seeded();
  const out = await tool(d, 'dowser_memory_pull', { project_key: PK, after: '0' });
  assert.deepEqual(out.items.map((/** @type {any} */ i) => [i.external_ref, i.status]), [['DW-1', 'rejected'], ['DW-2', 'accepted'], ['DW-3', 'merged']]);
  const rej = out.items[0];
  assert.equal(rej.reason, 'already-known');
  assert.equal(rej.note, 'we ship this in Q1');
  assert.equal(rej.decided_by, `forge:${ME}`);
  assert.ok(rej.topic && rej.anchors && rej.title && rej.evidence?.length, 'the record comes along: what suppression and precedents need');
  assert.equal(out.items[1].issue_ref.startsWith('SHOP-'), true);
  assert.equal(out.items[2].merged_into, out.items[1].fp, 'a merge into an inbox item names its fp');
  assert.deepEqual(out.rules.map((/** @type {any} */ r) => [r.id, r.state, r.text]), [['r1', 'accepted', 'skip demos']]);
  assert.ok(!('more' in out));
  const next = await tool(d, 'dowser_memory_pull', { project_key: PK, after: out.cursor });
  assert.deepEqual(next.items, [], 'nothing after the cursor');
  assert.ok(!('rules' in next), 'rules ride on the first page only');
});

test('memory pull pages, refuses a foreign cursor, and is routed by shape', async () => {
  const d = makeDeps();
  const topics = Array.from({ length: MEMORY_PAGE + 3 }, (_, i) => `topic ${i}`);
  // a push carries at most 50 items: two pushes
  await tool(d, 'dowser_proposals_push', pushArgs(topics.slice(0, 40).map((topic) => record({ topic })), { run_id: 'r-1' }));
  await tool(d, 'dowser_proposals_push', pushArgs(topics.slice(40).map((topic) => record({ topic })), { run_id: 'r-2' }));
  await res(d, 'verdict.reject', { refs: topics.map((_, i) => `DW-${i + 1}`), reason: 'not-worth-it' });
  const p1 = await tool(d, 'dowser_memory_pull', { project_key: PK, after: '0' });
  assert.equal(p1.items.length, MEMORY_PAGE);
  assert.equal(p1.more, true);
  const p2 = await tool(d, 'dowser_memory_pull', { project_key: PK, after: p1.cursor });
  assert.equal(p2.items.length, 3);
  assert.equal((await tool(d, 'dowser_memory_pull', { project_key: PK, after: 'x' })).error, 'bad-cursor');
  assert.equal(actionName('mcp', [], { project_key: PK, after: '0' }), 'dowser_memory_pull');
});
