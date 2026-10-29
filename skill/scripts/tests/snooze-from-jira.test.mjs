// @ts-check
// A snooze decided in the Jira inbox with a date (DW-42): the pulled verdict's `snooze_until` reaches the store.
// A date already past when the skill pulls it is still recorded, and the next run start wakes the item.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { getProposal, move, openStore, propose, runStart } from '../lib/store.mjs';
import { ingestVerdicts } from '../lib/sync.mjs';
import { KINDS, candidate, removeDir, tempDir } from './_fixture.mjs';

/** @type {string} */ let dir;
/** @type {import('../lib/store.mjs').Db} */ let db;
/** @type {string} */ let run;

before(() => {
  dir = tempDir('snooze-jira');
  db = openStore(join(dir, 'dowser.db'));
  run = runStart(db, { mode: 'full', harness: 'claude', model: 'm' }).id;
});
after(() => { db.close(); removeDir(dir); });

/** @param {string} topic @returns {string} a verified proposal's fp */
function verified(topic) {
  const fp = /** @type {string} */ (propose(db, run, candidate({ topic }), { kinds: KINDS }).fp);
  move(db, fp, 'verified', { from: 'candidate', by: 'skill:dowser-verify' });
  return fp;
}

/** @param {string} fp @param {string} ref @param {string} at @param {Record<string, string>} [extra] */
const snoozed = (fp, ref, at, extra = {}) => ({ fp, status: 'snoozed', decided_by: 'forge:jane', decided_at: at, external_ref: ref, ...extra });

test('a pulled snooze with a future snooze_until sets the store date', () => {
  const fp = verified('dated snooze future');
  const r = ingestVerdicts(db, { verdicts: [snoozed(fp, 'DW-81', '2026-10-27T09:00:00.000Z', { snooze_until: '2099-03-01' })], cursor: '1' });
  assert.equal(r.code, 0);
  assert.equal(r.out.verdicts[0].outcome, 'applied');
  assert.equal(r.out.verdicts[0].snooze_until, '2099-03-01');
  const p = getProposal(db, fp);
  assert.equal(p?.status, 'snoozed');
  assert.equal(p?.snooze_until, '2099-03-01');
  assert.equal(p?.decided_by, 'forge:jane');
});

test('a pulled snooze whose date has passed is recorded with it and woken by the next run start', () => {
  const fp = verified('dated snooze past');
  const r = ingestVerdicts(db, { verdicts: [snoozed(fp, 'DW-82', '2026-10-27T09:01:00.000Z', { snooze_until: '2026-01-02' })], cursor: '2' });
  assert.equal(r.out.verdicts[0].outcome, 'applied', 'a past date from the inbox is not refused');
  assert.equal(getProposal(db, fp)?.snooze_until, '2026-01-02');
  const next = runStart(db, { mode: 'full', harness: 'claude', model: 'm' });
  assert.ok(Array.isArray(next.woke) && next.woke.includes(fp), JSON.stringify(next.woke));
  assert.equal(getProposal(db, fp)?.status, 'verified');
  assert.equal(getProposal(db, fp)?.snooze_until, undefined, 'the wake clears the date');
});

test('a snooze without a date stays undated; a malformed date is invalid, never forced', () => {
  const plain = verified('undated snooze');
  const bad = verified('malformed snooze date');
  const r = ingestVerdicts(db, { verdicts: [
    snoozed(plain, 'DW-83', '2026-10-27T09:02:00.000Z'),
    snoozed(bad, 'DW-84', '2026-10-27T09:03:00.000Z', { snooze_until: '01.03.2099' }),
  ], cursor: '4' });
  assert.deepEqual(r.out.verdicts.map((/** @type {any} */ v) => v.outcome), ['applied', 'invalid']);
  assert.equal(getProposal(db, plain)?.snooze_until, undefined);
  assert.equal(getProposal(db, bad)?.status, 'verified');
});

test('a person still cannot snooze to a past date', () => {
  const fp = verified('human past snooze');
  assert.throws(() => move(db, fp, 'snoozed', { by: 'human:jane', until: '2026-01-02', today: '2026-10-29' }), /after today/);
});
