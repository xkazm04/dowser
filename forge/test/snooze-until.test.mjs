// @ts-check
// A dated snooze (DW-42): `verdict.snooze` takes `until`, stores it with the decision and the pull returns it
// as `snooze_until`. The clock starts at 2026-10-27T10:00Z (helpers.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ME, makeDeps, pushArgs, record } from './helpers.mjs';
import { runResolver, runTool } from '../src/core/app.mjs';
import { GRACE_MS } from '../src/core/verdicts.mjs';

const PK = 'github-com-Acme-Shop';

/** @param {any} deps @param {string} name @param {object} args */
const tool = (deps, name, args) => /** @type {Promise<any>} */ (runTool(deps, name, args, ME));
/** @param {any} deps @param {string} key @param {object} p */
const res = (deps, key, p) => /** @type {Promise<any>} */ (runResolver(deps, key, p, ME, 'inbox'));

/** Two pushed items, DW-1 and DW-2. */
async function twoItems() {
  const d = makeDeps();
  await tool(d, 'dowser_proposals_push', pushArgs([record(), record({ topic: 'a second topic' })]));
  return d;
}

test('a snooze with until stores the date and the pull returns it as snooze_until', async () => {
  const d = await twoItems();
  const out = await res(d, 'verdict.snooze', { refs: ['DW-1'], until: '2026-11-15' });
  assert.equal(out.cards[0].status, 'snoozed');
  assert.equal(out.cards[0].snooze_until, '2026-11-15');
  const pull = await tool(d, 'dowser_verdicts_pull', { project_key: PK });
  assert.equal(pull.verdicts.length, 1);
  assert.equal(pull.verdicts[0].status, 'snoozed');
  assert.equal(pull.verdicts[0].snooze_until, '2026-11-15');
});

test('a snooze without until is unchanged: no snooze_until key anywhere', async () => {
  const d = await twoItems();
  const out = await res(d, 'verdict.snooze', { refs: ['DW-1'] });
  assert.equal('snooze_until' in out.cards[0], false);
  const pull = await tool(d, 'dowser_verdicts_pull', { project_key: PK });
  assert.equal('snooze_until' in pull.verdicts[0], false);
  assert.equal(d.db.raw.prepare('SELECT snooze_until FROM verdicts').get()?.snooze_until, null);
});

test('a past, malformed or impossible until is bad-input and decides nothing', async () => {
  const d = await twoItems();
  for (const until of ['2026-10-26', '2025-12-31', '15.11.2026', '2026-02-30', 20261115]) {
    const out = await res(d, 'verdict.snooze', { refs: ['DW-1'], until });
    assert.equal(out.error, 'bad-input', `until ${JSON.stringify(until)}`);
  }
  assert.equal(d.db.raw.prepare("SELECT status FROM proposals WHERE ref = 'DW-1'").get()?.status, 'open');
  assert.equal((await tool(d, 'dowser_verdicts_pull', { project_key: PK })).verdicts.length, 0);
});

test('a bulk dated snooze dates every item; a rebuilt verdict keeps the date', async () => {
  const d = await twoItems();
  d.db.failNext = /INSERT INTO verdicts/;
  await res(d, 'verdict.snooze', { refs: ['DW-1', 'DW-2'], until: '2026-12-01' });
  d.clock.tick(GRACE_MS + 1000);
  const pull = await tool(d, 'dowser_verdicts_pull', { project_key: PK });
  assert.deepEqual(pull.verdicts.map((/** @type {any} */ v) => [v.external_ref, v.snooze_until]), [['DW-2', '2026-12-01'], ['DW-1', '2026-12-01']]);
});

test('a later decision clears the date: a reopened item rejected later carries no snooze_until', async () => {
  const d = await twoItems();
  await res(d, 'verdict.snooze', { refs: ['DW-1'], until: '2026-11-15' });
  d.db.raw.prepare("UPDATE proposals SET status = 'open' WHERE ref = 'DW-1'").run();
  await res(d, 'verdict.reject', { refs: ['DW-1'], reason: 'already-known' });
  assert.equal(d.db.raw.prepare("SELECT snooze_until FROM proposals WHERE ref = 'DW-1'").get()?.snooze_until, null);
  const pull = await tool(d, 'dowser_verdicts_pull', { project_key: PK });
  assert.deepEqual(pull.verdicts.map((/** @type {any} */ v) => v.snooze_until), ['2026-11-15', undefined]);
});

test('a push of a dated snooze reopens it from its day on, even with no new evidence', async () => {
  const d = makeDeps();
  const r = record();
  await tool(d, 'dowser_proposals_push', pushArgs([r], { run_id: 'r-1' }));
  await res(d, 'verdict.snooze', { refs: ['DW-1'], until: '2026-11-15' });
  const status = () => d.db.raw.prepare("SELECT status FROM proposals WHERE ref = 'DW-1'").get()?.status;
  d.clock.tick(Date.parse('2026-11-13T12:00:00.000Z') - Date.parse('2026-10-27T10:00:00.000Z'));
  await tool(d, 'dowser_proposals_push', pushArgs([{ ...r, status: 'pushed', external_ref: 'DW-1' }], { run_id: 'r-2' }));
  assert.equal(status(), 'snoozed', 'two days early: still snoozed');
  d.clock.tick(2 * 86_400_000);
  await tool(d, 'dowser_proposals_push', pushArgs([{ ...r, status: 'pushed', external_ref: 'DW-1' }], { run_id: 'r-3' }));
  assert.equal(status(), 'open');
  const open = (await res(d, 'inbox.list', { project_key: PK })).groups.flatMap((/** @type {any} */ g) => g.items);
  assert.deepEqual(open.map((/** @type {any} */ c) => [c.ref, c.change, c.reopened, 'snooze_until' in c]), [['DW-1', 'reopened', true, false]]);
});
