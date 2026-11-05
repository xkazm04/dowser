// @ts-check
// One accepted card is one Jira issue (verdicts.mjs accept): the issue key is stamped on the item before the
// decision is recorded, so a record step that fails, or an invocation cut short, never leads to a second issue.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ME, makeDeps, pushArgs, record } from './helpers.mjs';
import { runResolver, runTool } from '../src/core/app.mjs';
import { CLAIM_MS } from '../src/core/verdicts.mjs';

const PK = 'github-com-Acme-Shop';
/** @param {any} d @param {string} key @param {Record<string, unknown>} p */
const res = async (d, key, p) => /** @type {any} */ (await runResolver(d, key, p, ME, 'inbox'));
/** @param {any} d */
const row = (d) => /** @type {any} */ ({ ...d.db.raw.prepare("SELECT status, issue_ref, accept_claim FROM proposals WHERE ref = 'DW-1'").get() });
/** @param {any} d */
const verdicts = (d) => d.db.raw.prepare('SELECT status, issue_ref FROM verdicts').all().map((/** @type {any} */ v) => [v.status, v.issue_ref]);

async function seeded() {
  const d = makeDeps();
  await runTool(d, 'dowser_proposals_push', pushArgs([record()]), ME);
  await res(d, 'settings.set', { project_key: PK, jira_project_key: 'SHOP', issue_type_id: '10001' });
  return d;
}

test('the record step fails after Jira created the issue: the answer names it, and accepting again finishes with it', async () => {
  const d = await seeded();
  d.db.failNext = /^\s*UPDATE proposals SET status/; // decide's CAS
  const out = await res(d, 'verdict.accept', { ref: 'DW-1' });
  assert.equal(out.error, 'unavailable');
  assert.match(out.message, /Jira issue SHOP-41 was created and is kept on the item: accept it again/);
  assert.doesNotMatch(out.message, /injected failure/, 'no internals');
  assert.deepEqual(row(d), { status: 'open', issue_ref: 'SHOP-41', accept_claim: null }, 'stamped, claim released');

  const again = await res(d, 'verdict.accept', { ref: 'DW-1' });
  assert.equal(again.card.status, 'accepted');
  assert.equal(again.card.issue_ref, 'SHOP-41');
  assert.equal(d.jira.created.length, 1, 'no second issue');
  assert.deepEqual(verdicts(d), [['accepted', 'SHOP-41']]);
});

test('an invocation cut after the stamp: the claim expires and the next accept records the same issue', async () => {
  const d = await seeded();
  const exec = d.db.exec;
  // the function dies after the stamp: decide never runs and nothing releases the claim
  d.db.exec = async (sql, params) => {
    if (/SET status = \?/.test(sql) || /SET accept_claim = NULL/.test(sql)) throw new Error('invocation cut');
    return exec(sql, params);
  };
  await res(d, 'verdict.accept', { ref: 'DW-1' });
  d.db.exec = exec;
  assert.equal(row(d).issue_ref, 'SHOP-41');
  assert.match((await res(d, 'verdict.accept', { ref: 'DW-1' })).message, /already in progress/);
  d.clock.tick(CLAIM_MS + 1);
  const late = await res(d, 'verdict.accept', { ref: 'DW-1' });
  assert.deepEqual([late.card.status, late.card.issue_ref], ['accepted', 'SHOP-41']);
  assert.equal(d.jira.created.length, 1, 'the retry finished the record instead of creating SHOP-42');
});
