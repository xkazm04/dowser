// @ts-check
// DW-166: a pulled verdict the store could not apply stays pending and is retried on later ingests. The acceptance:
// "no pulled verdict is dropped because it could not be applied at first"; "the same sequence ends accepted with the
// issue recorded, once the push result arrives"; "a retried verdict must stay idempotent per fp and decided_at".
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { getProposal, move, openStore, propose, runStart, transitionsOf } from '../lib/store.mjs';
import { getState, ingestPush, ingestVerdicts, verdictsCursor } from '../lib/sync.mjs';
import { KINDS, candidate, removeDir, tempDir } from './_fixture.mjs';

/** @type {string} */ let dir;
/** @type {import('../lib/store.mjs').Db} */ let db;
/** @type {string} */ let run;

beforeEach(() => {
  dir = tempDir('sync-pending');
  db = openStore(join(dir, 'dowser.db'));
  run = runStart(db, { mode: 'full', harness: 'claude', model: 'm' }).id;
});
afterEach(() => { db.close(); removeDir(dir); });

/** @param {string} topic @returns {string} */
function verified(topic) {
  const fp = /** @type {string} */ (propose(db, run, candidate({ topic }), { kinds: KINDS }).fp);
  move(db, fp, 'verified', { from: 'candidate', by: 'skill:dowser-verify' });
  return fp;
}
const T1 = '2026-11-01T10:00:00.000Z';
const T2 = '2026-11-01T11:00:00.000Z';
/** @param {string} fp @param {string} [at] */
const accept = (fp, at = T1) => ({ fp, status: 'accepted', decided_by: 'forge:jane', decided_at: at, external_ref: 'DW-1', issue_ref: 'SHOP-9', issue_url: 'https://j/SHOP-9' });
/** @param {string} fp @param {string} [at] */
const reject = (fp, at = T2) => ({ fp, status: 'rejected', reason: 'not-worth-it', decided_by: 'forge:jane', decided_at: at, external_ref: 'DW-1' });

test('the card\'s probe: an accept that conflicts on a verified card, then ingest-push created, ends accepted with the issue recorded', () => {
  const fp = verified('crash between push and ingest');
  const first = ingestVerdicts(db, { verdicts: [accept(fp)], cursor: '6' });
  assert.equal(first.out.verdicts[0].outcome, 'conflict');
  assert.equal(first.code, 1, 'a verdict first seen this ingest that fails still exits 1');
  assert.equal(verdictsCursor(db), '6', 'the cursor still moves');
  assert.equal(getProposal(db, fp)?.status, 'verified');
  assert.ok(getState(db, `pending_verdict:${fp}@${T1}`) !== undefined, 'kept in sync_state');
  assert.equal(first.out.pending?.length, 1, JSON.stringify(first.out));
  const row = first.out.pending[0];
  assert.deepEqual([row.fp, row.status, row.decided_at], [fp, 'accepted', T1]);
  assert.equal(typeof row.why, 'string');

  const pushed = ingestPush(db, { results: [{ fp, result: 'created', external_ref: 'DW-1' }] });
  assert.equal(pushed.code, 0);
  const p = getProposal(db, fp);
  assert.equal(p?.status, 'accepted', 'retried at the end of ingestPush');
  assert.equal(p?.issue_ref, 'SHOP-9');
  assert.equal(p?.issue_url, 'https://j/SHOP-9');
  assert.equal(p?.decided_by, 'forge:jane');
  assert.equal(p?.decided_at, T1);
  assert.equal(p?.external_ref, 'DW-1');
  assert.equal(getState(db, `pending_verdict:${fp}@${T1}`), undefined, 'the key is cleared once it lands');
  assert.equal(JSON.parse(String(getState(db, `verdict:${fp}@${T1}`))).outcome, 'applied', 'recorded as applied');
  assert.equal(pushed.out.pending, undefined, 'nothing pending once it landed');
});

test('an empty later verdicts page lands a pending verdict: the retry runs at the start of ingestVerdicts', () => {
  const fp = verified('retry on an empty page');
  ingestVerdicts(db, { verdicts: [accept(fp)], cursor: '6' });
  // the card reached pushed outside ingestPush, so only the retry in ingestVerdicts can land the verdict
  move(db, fp, 'pushed', { from: 'verified', by: 'skill:dowser-sync' });
  const later = ingestVerdicts(db, { verdicts: [], cursor: '6' });
  assert.equal(later.code, 0);
  assert.equal(getProposal(db, fp)?.status, 'accepted');
  assert.equal(getProposal(db, fp)?.issue_ref, 'SHOP-9');
  assert.equal(later.out.pending, undefined);
  assert.equal(getState(db, `pending_verdict:${fp}@${T1}`), undefined);
});

test('a pending verdict alone does not make exit 1, and it stays listed until it lands; a new failure still does', () => {
  const fp = verified('still pending');
  ingestVerdicts(db, { verdicts: [accept(fp)] });
  const later = ingestVerdicts(db, { verdicts: [] });
  assert.equal(later.code, 0, 'a retried pending verdict alone is not a failure');
  assert.deepEqual(later.out.pending?.map((/** @type {any} */ x) => x.fp), [fp]);
  assert.equal(getProposal(db, fp)?.status, 'verified');

  const other = verified('a second conflict');
  const next = ingestVerdicts(db, { verdicts: [accept(other, T2)] });
  assert.equal(next.code, 1, 'first seen this ingest and failing');
  assert.deepEqual(next.out.pending?.map((/** @type {any} */ x) => x.decided_at), [T1, T2], 'oldest first');
});

test('a newer verdict that applied first drops the older pending one', () => {
  const fp = verified('reject beats the pending accept');
  ingestVerdicts(db, { verdicts: [accept(fp)] });
  const r = ingestVerdicts(db, { verdicts: [reject(fp)] });
  assert.equal(r.out.verdicts[0].outcome, 'applied');
  assert.equal(r.out.pending, undefined, JSON.stringify(r.out));
  assert.equal(getState(db, `pending_verdict:${fp}@${T1}`), undefined);
  ingestVerdicts(db, { verdicts: [] });
  assert.equal(getProposal(db, fp)?.status, 'rejected', 'the older accept does not come back');
  assert.equal(getProposal(db, fp)?.issue_ref, undefined);
});

test('idempotent per (fp, decided_at): a re-read page does not double it, and after landing it is already-applied', () => {
  const fp = verified('idempotent');
  const page = { verdicts: [accept(fp)] };
  ingestVerdicts(db, page);
  const again = ingestVerdicts(db, page);
  assert.equal(again.out.pending?.length, 1, 'one key per (fp, decided_at)');
  ingestPush(db, { results: [{ fp, result: 'created', external_ref: 'DW-1' }] });
  const accepts = () => transitionsOf(db, fp).filter((t) => t.to_status === 'accepted').length;
  assert.equal(accepts(), 1);
  const third = ingestVerdicts(db, page);
  assert.equal(third.out.verdicts[0].outcome, 'already-applied');
  assert.equal(third.code, 0);
  assert.equal(accepts(), 1, 'moved once');
});

test('an unknown fp is pending on a store that holds cards, and lands when the card arrives', () => {
  // the same card in another store gives the fp this store does not hold yet
  const otherDir = tempDir('sync-pending-other');
  const other = openStore(join(otherDir, 'dowser.db'));
  const otherRun = runStart(other, { mode: 'full', harness: 'claude', model: 'm' }).id;
  const fp = /** @type {string} */ (propose(other, otherRun, candidate({ topic: 'arrives later' }), { kinds: KINDS }).fp);
  other.close();
  removeDir(otherDir);

  verified('so the store is not fresh');
  const first = ingestVerdicts(db, { verdicts: [reject(fp)] });
  assert.equal(first.out.verdicts[0].outcome, 'unknown');
  assert.equal(first.code, 1);
  assert.deepEqual(first.out.pending?.map((/** @type {any} */ x) => x.fp), [fp]);

  assert.equal(verified('arrives later'), fp);
  const later = ingestVerdicts(db, { verdicts: [] });
  assert.equal(getProposal(db, fp)?.status, 'rejected');
  assert.equal(later.out.pending, undefined);
});

test('on a fresh store an unknown verdict is not kept: the fresh-store rule stays', () => {
  const r = ingestVerdicts(db, { verdicts: [reject('ffffffffffffffff')] });
  assert.equal(r.code, 0);
  assert.equal(r.out.fresh_store, true);
  assert.equal(r.out.pending, undefined);
  assert.equal(getState(db, `pending_verdict:ffffffffffffffff@${T2}`), undefined);
});

test('a malformed verdict is reported and never kept', () => {
  const fp = verified('malformed');
  const { issue_url: _, ...bad } = accept(fp);
  const r = ingestVerdicts(db, { verdicts: [bad] });
  assert.equal(r.out.verdicts[0].outcome, 'invalid');
  assert.equal(r.out.pending, undefined);
  assert.equal(getState(db, `pending_verdict:${fp}@${T1}`), undefined);
});
