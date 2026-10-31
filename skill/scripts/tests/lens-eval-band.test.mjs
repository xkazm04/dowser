// @ts-check
// lens-eval measures a pack on the cards the store RANKED (card 137ec244cc591c32): recall_at_budget, priority1_found
// and focus_found count only `band: ranked` survivors; recall and precision keep every survivor; a seeded item found
// only in reserve is listed under `reserve_hits`. Emissions without a band (older callers) score as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emittedOf, scoreLens } from '../lib/score.mjs';

const EXP = [
  { lens: 'doc-drift', id: 'a', anchor: 'docs/a.md', priority: 1, why: 'w' },
  { lens: 'doc-drift', id: 'b', anchor: 'docs/b.md', priority: 1, why: 'w' },
  { lens: 'doc-drift', id: 'c', anchor: 'docs/c.md', why: 'w' },
  { lens: 'doc-drift', id: 'd', anchor: 'docs/d.md', why: 'w' },
  { lens: 'doc-drift', id: 'e', anchor: 'docs/e.md', focus_by_direction: true, why: 'w' },
];
/** @param {string} id @param {'ranked' | 'reserve'} [band] */
const card = (id, band) => ({ lens: 'doc-drift', title: id, anchors: [`docs/${id}.md`], ...(band ? { band } : {}) });

test('a seeded item found only in reserve counts in recall, not in recall_at_budget, and is listed as a reserve hit', () => {
  const s = scoreLens({ expected: EXP, lens: 'doc-drift', budget: 2, emitted: [card('a', 'ranked'), card('c', 'ranked'), card('b', 'reserve'), card('e', 'reserve')] });
  assert.equal(s.recall, 0.8, 'all survivors: 4 of 5');
  assert.equal(s.precision, 1);
  assert.equal(s.recall_at_budget, 1, 'ranked a and c fill the budget of 2');
  assert.equal(s.priority1_found, 1, 'b (priority 1) was only in reserve');
  assert.equal(s.focus_found, 0, 'the focus item was only in reserve');
  assert.deepEqual(s.reserve_hits, ['b', 'e']);
  assert.equal(s.budget_scope, 'ranked');
});

test('a ranked band that misses lowers recall_at_budget even when reserve holds the finding', () => {
  const s = scoreLens({ expected: EXP, lens: 'doc-drift', budget: 4, emitted: [card('a', 'ranked'), card('b', 'reserve'), card('c', 'reserve'), card('d', 'reserve')] });
  assert.equal(s.recall_at_budget, 0.25);
  assert.equal(s.recall, 0.8);
});

test('without bands every survivor counts, as before; budget_scope says so', () => {
  const s = scoreLens({ expected: EXP, lens: 'doc-drift', budget: 2, emitted: [card('a'), card('b')] });
  assert.deepEqual([s.recall_at_budget, s.priority1_found, s.budget_scope, 'reserve_hits' in s], [1, 2, 'all', false]);
});

test('emittedOf: the eval loop keeps survivors with their band and drops dropped and merged cards', () => {
  const shown = [
    { card: { lens: 'doc-drift', kind: 'k', title: 'r', anchors: ['docs/a.md'], status: 'verified', band: 'ranked' }, evidence: [] },
    { card: { lens: 'doc-drift', kind: 'k', title: 's', anchors: ['docs/b.md'], status: 'pushed', band: 'reserve' }, evidence: [] },
    { card: { lens: 'doc-drift', kind: 'k', title: 'x', anchors: ['docs/c.md'], status: 'dropped' }, evidence: [] },
    { card: { lens: 'doc-drift', kind: 'k', title: 'm', anchors: ['docs/d.md'], status: 'merged' }, evidence: [] },
  ];
  const { emitted, dropped } = emittedOf(shown);
  assert.equal(dropped, 1);
  assert.deepEqual(emitted.map((e) => [e.title, e.band]), [['r', 'ranked'], ['s', 'reserve']]);
});
