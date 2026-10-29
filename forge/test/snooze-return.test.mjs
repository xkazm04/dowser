// @ts-check
// The return of a dated snooze as the inbox reads it (DW-53, DW-55): a bulk snooze with one `until` dates every
// selected item, and the card and its history row carry `snooze_until` so the view can say when it comes back.
// Without a date nothing new appears. The clock starts at 2026-10-27T10:00Z (helpers.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ME, makeDeps, pushArgs, record } from './helpers.mjs';
import { runResolver, runTool } from '../src/core/app.mjs';

/** @param {any} deps @param {string} name @param {object} args */
const tool = (deps, name, args) => /** @type {Promise<any>} */ (runTool(deps, name, args, ME));
/** @param {any} deps @param {string} key @param {object} p */
const res = (deps, key, p) => /** @type {Promise<any>} */ (runResolver(deps, key, p, ME, 'inbox'));

async function threeItems() {
  const d = makeDeps();
  await tool(d, 'dowser_proposals_push', pushArgs([record(), record({ topic: 'a second topic' }), record({ topic: 'a third topic' })]));
  return d;
}

test('a bulk snooze with one until dates every selected card and its history row', async () => {
  const d = await threeItems();
  const out = await res(d, 'verdict.snooze', { refs: ['DW-1', 'DW-3'], until: '2026-11-20' });
  assert.deepEqual(out.cards.map((/** @type {any} */ c) => [c.ref, c.status, c.snooze_until]), [['DW-1', 'snoozed', '2026-11-20'], ['DW-3', 'snoozed', '2026-11-20']]);
  for (const ref of ['DW-1', 'DW-3']) {
    const got = await res(d, 'proposal.get', { ref });
    assert.equal(got.card.snooze_until, '2026-11-20');
    assert.deepEqual(got.history.map((/** @type {any} */ v) => [v.status, v.snooze_until]), [['snoozed', '2026-11-20']]);
  }
  const list = await res(d, 'inbox.list', { status: 'snoozed' });
  const cards = list.groups.flatMap((/** @type {any} */ g) => g.items);
  assert.deepEqual(cards.map((/** @type {any} */ c) => c.snooze_until).sort(), ['2026-11-20', '2026-11-20']);
  const open = await res(d, 'proposal.get', { ref: 'DW-2' });
  assert.equal(open.card.status, 'open');
  assert.equal('snooze_until' in open.card, false);
});

test('a bulk snooze without until carries no snooze_until on the cards or the history', async () => {
  const d = await threeItems();
  const out = await res(d, 'verdict.snooze', { refs: ['DW-1', 'DW-2'] });
  assert.equal(out.cards.some((/** @type {any} */ c) => 'snooze_until' in c), false);
  const got = await res(d, 'proposal.get', { ref: 'DW-2' });
  assert.equal('snooze_until' in got.card, false);
  assert.equal(got.history.some((/** @type {any} */ v) => 'snooze_until' in v), false);
});
