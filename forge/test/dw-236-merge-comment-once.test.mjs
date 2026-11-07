// @ts-check
// DW-236: one merge into a Jira issue leaves one comment on it, whatever failed in between. A merge comments first and
// records after, so a record step that fails leaves the item open with the comment already on the issue, and the retry
// must not post it again. A retry into a different issue is a different comment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ME, makeDeps, pushArgs, record } from './helpers.mjs';
import { runResolver, runTool } from '../src/core/app.mjs';

/** The record step: decide's compare-and-set of the status (accept-claim.test.mjs fails the same statement). */
const RECORD_STEP = /^\s*UPDATE proposals SET status/;

/** @param {ReturnType<typeof makeDeps>} d @param {string} into */
const merge = async (d, into) => /** @type {any} */ (await runResolver(d, 'verdict.merge', { ref: 'DW-1', into }, ME, 'inbox'));
/** @param {ReturnType<typeof makeDeps>} d */
const commented = (d) => d.jira.comments.map((c) => c.issueKey);
/** @param {ReturnType<typeof makeDeps>} d */
const row = (d) => /** @type {any} */ ({ ...d.db.raw.prepare("SELECT status, merged_into FROM proposals WHERE ref = 'DW-1'").get() });
/** @param {ReturnType<typeof makeDeps>} d */
const verdicts = (d) => d.db.raw.prepare('SELECT status FROM verdicts').all().map((v) => v.status);

async function seeded() {
  const d = makeDeps();
  await runTool(d, 'dowser_proposals_push', pushArgs([record()]), ME);
  return d;
}

/** A merge into SHOP-7 whose comment landed and whose record step failed. */
async function failedOnce() {
  const d = await seeded();
  d.db.failNext = RECORD_STEP;
  const first = await merge(d, 'SHOP-7');
  assert.equal(first.error, 'unavailable', `answered ${JSON.stringify(first)}`);
  assert.deepEqual(commented(d), ['SHOP-7'], 'the comment landed before the record step failed');
  assert.deepEqual(row(d), { status: 'open', merged_into: null }, 'the item stays open');
  return d;
}

test('a plain merge into a Jira key posts exactly one comment', async () => {
  const d = await seeded();
  const out = await merge(d, 'SHOP-7');
  assert.equal(out.card.status, 'merged');
  assert.equal(out.card.merged_into, 'SHOP-7');
  assert.deepEqual(commented(d), ['SHOP-7']);
});

test('the record step fails once: the retry answers merged and the issue still has one comment', async () => {
  const d = await failedOnce();
  const second = await merge(d, 'SHOP-7');
  assert.equal(second.card?.status, 'merged', `answered ${JSON.stringify(second)}`);
  assert.equal(second.card.merged_into, 'SHOP-7');
  assert.deepEqual(commented(d), ['SHOP-7'], 'no second comment');
  assert.deepEqual(verdicts(d), ['merged']);
});

test('the record step fails on two calls in a row: the third answers merged, still one comment', async () => {
  const d = await failedOnce();
  d.db.failNext = RECORD_STEP;
  assert.equal((await merge(d, 'SHOP-7')).error, 'unavailable');
  assert.deepEqual(commented(d), ['SHOP-7'], 'no second comment on the failed retry');
  assert.equal((await merge(d, 'SHOP-7')).card?.status, 'merged');
  assert.deepEqual(commented(d), ['SHOP-7'], 'no second comment on the retry that lands');
});

test('after the failure, a retry into a different issue posts its comment there: one on each', async () => {
  const d = await failedOnce();
  const second = await merge(d, 'SHOP-8');
  assert.equal(second.card?.status, 'merged', `answered ${JSON.stringify(second)}`);
  assert.equal(second.card.merged_into, 'SHOP-8');
  assert.deepEqual(commented(d), ['SHOP-7', 'SHOP-8']);
});
