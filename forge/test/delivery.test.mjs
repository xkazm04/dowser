// @ts-check
// Delivery truth, Forge slice (moonshot 2026-11-04, idea 1): Jira issue events record each accepted card's fate
// (delivered / abandoned / in progress) as it happens; reflect_sync carries the skill's code re-check (present /
// partly / resolved); a delivered card pushed again is marked recurred. The Learning tab reads all three.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ME, makeDeps, pushArgs, record } from './helpers.mjs';
import { runResolver, runTool } from '../src/core/app.mjs';
import { onIssueEvent } from '../src/core/delivery.mjs';

const PK = 'github-com-Acme-Shop';
/** @param {any} d @param {string} key @param {Record<string, unknown>} p */
const res = (d, key, p) => /** @type {Promise<any>} */ (runResolver(d, key, p, ME, 'inbox'));
/** @param {string} key @param {string} cat @param {string} name @param {{field: string, toString: string}[]} [items] */
const updated = (key, cat, name, items = [{ field: 'status', toString: name }]) => ({
  eventType: 'avi:jira:updated:issue', issue: { key, fields: { status: { name, statusCategory: { key: cat } }, updated: '2026-11-05T10:00:00.000+0000' } },
  changelog: { items },
});

async function seeded() {
  const d = makeDeps();
  await runTool(d, 'dowser_proposals_push', pushArgs([record({ topic: 'alpha' }), record({ topic: 'beta' }), record({ topic: 'gamma' })], { run_id: 'r-1' }), ME);
  await res(d, 'settings.set', { project_key: PK, jira_project_key: 'SHOP', issue_type_id: '10001' });
  const keys = [];
  for (const ref of ['DW-1', 'DW-2', 'DW-3']) keys.push((await res(d, 'verdict.accept', { ref })).card.issue_ref);
  return { d, keys };
}
/** @param {any} d */
const cands = async (d) => Object.fromEntries((await res(d, 'reflect.data', { project_key: PK })).candidates.map((/** @type {any} */ c) => [c.ref, c]));

test('Jira issue events record delivered, abandoned (Won\'t Do, deleted) and in progress', async () => {
  const { d, keys } = await seeded();
  assert.deepEqual(await onIssueEvent(d, updated(keys[0], 'done', 'Done')), { matched: 1 });
  await onIssueEvent(d, updated(keys[1], 'done', 'Closed', [{ field: 'status', toString: 'Closed' }, { field: 'resolution', toString: "Won't Do" }]));
  await onIssueEvent(d, { eventType: 'avi:jira:deleted:issue', issue: { key: keys[2], fields: {} } });
  const c = await cands(d);
  assert.equal(c['DW-1'].delivery, 'delivered');
  assert.equal(c['DW-1'].done, true);
  assert.equal(c['DW-1'].issue_status, 'Done');
  assert.equal(c['DW-2'].delivery, 'abandoned');
  assert.equal(c['DW-3'].delivery, 'abandoned');
  assert.deepEqual(await onIssueEvent(d, updated('NOPE-9', 'done', 'Done')), { matched: 0 }, 'an issue no card owns is a no-op');
  await onIssueEvent(d, updated(keys[0], 'indeterminate', 'In Progress'));
  assert.equal((await cands(d))['DW-1'].delivery, 'in_progress', 'reopened in Jira: no longer delivered');
});

test('reflect_sync carries the code check; Done in Jira with the problem still present is flagged; a re-push of a delivered card recurs', async () => {
  const { d, keys } = await seeded();
  await onIssueEvent(d, updated(keys[0], 'done', 'Done'));
  const fp1 = record({ topic: 'alpha' }).fp;
  const fp2 = record({ topic: 'beta' }).fp;
  const deliveries = [
    { fp: fp1, state: 'present', found: 2, total: 2, checked_at: '2026-11-05T11:00:00.000Z' },
    { fp: fp2, state: 'resolved', found: 0, total: 1, commits: 2, checked_at: '2026-11-05T11:00:00.000Z' },
  ];
  const out = await runTool(d, 'dowser_reflect_sync', { project_key: PK, rules_json: '[]', deliveries_json: JSON.stringify(deliveries) }, ME);
  assert.ok(!('error' in /** @type {any} */ (out)), JSON.stringify(out));
  let c = await cands(d);
  assert.equal(c['DW-1'].code_state, 'present');
  assert.equal(c['DW-1'].still_in_code, true, 'Jira says Done, the quoted problem is still in the code');
  assert.equal(c['DW-2'].code_state, 'resolved');
  assert.ok(!c['DW-2'].still_in_code);
  assert.equal(/** @type {any} */ (await runTool(d, 'dowser_reflect_sync', { project_key: PK, deliveries_json: '[{"fp":"x","state":"maybe"}]' }, ME)).error, 'bad-input');

  await runTool(d, 'dowser_proposals_push', pushArgs([record({ topic: 'alpha' })], { run_id: 'r-2' }), ME);
  c = await cands(d);
  assert.equal(c['DW-1'].recurred, true, 'delivered, then found again by a later scan');
});
