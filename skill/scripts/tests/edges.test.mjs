// @ts-check
// The proposal relationship graph (moonshot 2026-11-04, core#4, store side): append-only edges between cards
// (unblocks, duplicate-of, follow-up-of, conflicts-with, related); `show` lists them; and the run's allocation lifts
// a prerequisite: a reserve card that `unblocks` a ranked card takes a ranked slot from the weakest plain one,
// because the most valuable item on a deck may be the least glamorous one everything else waits on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { getProposal, move, openStore, propose, runStart } from '../lib/store.mjs';
import { allocateRun } from '../lib/budget.mjs';
import { EDGE_KINDS, link, linksOf } from '../lib/edges.mjs';
import { KINDS, candidate, removeDir, tempDir } from './_fixture.mjs';

/** @param {number} n */
const scored = (n) => ({ impact: n, impact_why: 'why', risk: 2, effort: { size: 'S', days_low: 1, days_high: 2, basis: ['x'] } });

test('link stores a typed edge once; refuses a self-loop, an unknown kind and an unknown fp; links lists both directions', () => {
  const home = tempDir('edges');
  const db = openStore(join(home, 'dowser.db'));
  try {
    const run = String(runStart(db, { mode: 'full' }).id);
    const a = String(propose(db, run, candidate({ topic: 'event bus' }), { kinds: KINDS }).fp);
    const b = String(propose(db, run, candidate({ topic: 'audit trail', anchors: ['src/audit.js'] }), { kinds: KINDS }).fp);
    assert.deepEqual(EDGE_KINDS, ['unblocks', 'duplicate-of', 'follow-up-of', 'conflicts-with', 'related']);
    assert.equal(link(db, { from: a, to: b, kind: 'unblocks', by: 'human:jane', note: 'audit needs the bus' }).result, 'linked');
    assert.equal(link(db, { from: a, to: b, kind: 'unblocks', by: 'human:jane' }).result, 'exists', 'idempotent');
    assert.throws(() => link(db, { from: a, to: a, kind: 'related', by: 'human:jane' }), (e) => /** @type {any} */ (e).code === 2);
    assert.throws(() => link(db, { from: a, to: b, kind: 'blocks', by: 'human:jane' }), (e) => /** @type {any} */ (e).code === 2);
    assert.throws(() => link(db, { from: a, to: 'ffffffffffffffff', kind: 'related', by: 'human:jane' }), (e) => /** @type {any} */ (e).code === 2);
    assert.deepEqual(linksOf(db, b).map((l) => [l.kind, l.dir, l.fp]), [['unblocks', 'in', a]]);
    assert.deepEqual(linksOf(db, a).map((l) => [l.kind, l.dir, l.fp, l.note]), [['unblocks', 'out', b, 'audit needs the bus']]);
  } finally { db.close(); removeDir(home); }
});

test('the allocation lifts a reserve prerequisite of a ranked card over the weakest plain ranked card', () => {
  const home = tempDir('edges-lift');
  const db = openStore(join(home, 'dowser.db'));
  try {
    const run = String(runStart(db, { mode: 'full' }).id);
    const fp = (/** @type {string} */ topic, /** @type {number} */ impact) => {
      const f = String(propose(db, run, candidate({ topic, anchors: [`src/${topic.replace(/ /g, '-')}.js`], ...scored(impact) }), { kinds: KINDS }).fp);
      move(db, f, 'verified', { by: 'skill:dowser-verify' });
      return f;
    };
    const top = fp('audit trail', 9);
    const mid = fp('rate limits', 6);
    const low = fp('dark corners', 5);
    const prereq = fp('event bus', 3);
    const before = allocateRun(db, run, { perLens: 3, perRun: 3 });
    assert.equal(getProposal(db, prereq)?.band, 'reserve', 'scored alone, the prerequisite is cut');
    assert.equal(before.lifted, undefined);
    link(db, { from: prereq, to: top, kind: 'unblocks', by: 'human:jane' });
    const after = allocateRun(db, run, { perLens: 3, perRun: 3 });
    assert.equal(getProposal(db, prereq)?.band, 'ranked', 'it unblocks a ranked card: lifted');
    assert.equal(getProposal(db, low)?.band, 'reserve', 'the weakest plain ranked card gives up its slot');
    assert.equal(getProposal(db, top)?.band, 'ranked');
    assert.equal(getProposal(db, mid)?.band, 'ranked');
    assert.deepEqual(after.lifted, [{ fp: prereq, unblocks: top, displaced: low }]);
  } finally { db.close(); removeDir(home); }
});
