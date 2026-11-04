// @ts-check
// The proposal-quality ledger (moonshot 2026-11-04, idea 4): per lens, lens version and model, how the cards a
// scan produced actually fared - acceptance, ranked vs reserve, prediction agreement, outcome ratings, delivery -
// each with its n. A rate is present only when its n is above zero: unmeasured is never 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { move, openStore, propose, runStart } from '../lib/store.mjs';
import { qualityReport } from '../lib/quality.mjs';
import { KINDS, candidate, removeDir, tempDir } from './_fixture.mjs';

test('quality per lens version: accept rate, ranked vs reserve, prediction agreement, outcomes and delivery, each with n', () => {
  const home = tempDir('quality');
  const db = openStore(join(home, 'dowser.db'));
  try {
    const run = String(runStart(db, { mode: 'full', model: 'm1' }).id);
    /** @param {string} topic @param {string} band @param {string} predicted @param {string} to */
    const card = (topic, band, predicted, to) => {
      const fp = String(propose(db, run, candidate({ topic, anchors: [`src/${topic}.js`], predicted_verdict: predicted, predicted_why: 'p' }), { kinds: KINDS }).fp);
      move(db, fp, 'verified', { by: 'skill:dowser-verify' });
      db.prepare('UPDATE proposals SET band = ? WHERE fp = ?').run(band, fp);
      move(db, fp, 'pushed', { by: 'skill:dowser-sync' });
      if (to !== 'pushed') move(db, fp, to, { by: 'forge:jane', ...(to === 'rejected' ? { reason: 'not-worth-it' } : {}) });
      return fp;
    };
    const a = card('a', 'ranked', 'accept', 'accepted');
    card('b', 'ranked', 'accept', 'rejected');
    card('c', 'reserve', 'reject', 'rejected');
    card('d', 'ranked', 'accept', 'pushed');
    db.prepare("INSERT INTO outcomes (fp, ref, rating, issue_ref, decided_by, recorded_at) VALUES (?, 'DW-1', 'right', 'SHOP-1', 'forge:bob', '2026-11-05T00:00:00Z')").run(a);
    db.prepare("INSERT INTO deliveries (fp, run_id, state, found, total, checked_at) VALUES (?, ?, 'resolved', 0, 1, '2026-11-05T00:00:00Z')").run(a, run);

    const q = qualityReport(db);
    assert.equal(q.slices.length, 1);
    const s = q.slices[0];
    assert.deepEqual([s.lens, s.lens_version, s.model], ['security-cra', '1.0.0', 'm1']);
    assert.deepEqual(s.decided, { n: 3, accepted: 1 });
    assert.equal(s.accept_rate, 0.333);
    assert.deepEqual(s.by_band, { ranked: { n: 2, accepted: 1, accept_rate: 0.5 }, reserve: { n: 1, accepted: 0, accept_rate: 0 } });
    assert.deepEqual(s.prediction, { n: 3, agreed: 2, rate: 0.667 });
    assert.deepEqual(s.outcomes, { right: 1, partly: 0, wrong: 0 });
    assert.deepEqual(s.delivery, { checked: 1, resolved: 1, partly: 0, present: 0 });
    assert.equal(s.pending, 1, 'pushed, nobody has decided yet');

    const empty = openStore(join(home, 'empty.db'));
    try { assert.deepEqual(qualityReport(empty), { slices: [] }, 'nothing decided: no slice, no zeros'); } finally { empty.close(); }
  } finally { db.close(); removeDir(home); }
});
