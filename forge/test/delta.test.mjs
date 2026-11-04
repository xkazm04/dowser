// @ts-check
// Why a card is back (F3, F8): an open card that a push reopened or grew carries `delta` (since the decision, or since
// the previous push; the prior decision as the row holds it) and marks each evidence item that push brought with
// `new: true`. Derived at read time from the rows already read: no extra statement. A card first seen in its push,
// and every decided card, carries neither. The clock starts at 2026-10-27T10:00Z (helpers.mjs) and is ticked
// between a push and a decision, so the add times and the decision time differ as they do in real use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ME, countingDb, makeDeps, pushArgs, record } from './helpers.mjs';
import { runResolver, runRovo, runTool } from '../src/core/app.mjs';
// The Custom UI modules are loaded by URL: they sit outside this package's typecheck (static/app has its own).
/** @param {string} rel @returns {Promise<any>} */
const ui = (rel) => import(String(new URL(rel, import.meta.url)));
/** @type {(card: any) => string | undefined} */
const deltaLine = (await ui('../static/app/src/components/labels.js')).deltaLine;

const PK = 'github-com-Acme-Shop';
const HOUR = 3_600_000;

/** @param {any} deps @param {string} name @param {object} args */
const tool = (deps, name, args) => /** @type {Promise<any>} */ (runTool(deps, name, args, ME));
/** @param {any} deps @param {string} key @param {object} p */
const res = (deps, key, p) => /** @type {Promise<any>} */ (runResolver(deps, key, p, ME, 'inbox'));
/** @param {any} deps @param {object} [q] @returns {Promise<any[]>} */
const items = async (deps, q = {}) => (await res(deps, 'inbox.list', { project_key: PK, ...q })).groups.flatMap((/** @type {any} */ g) => g.items);
/** @param {any} deps @param {string} ref */
const row = (deps, ref) => /** @type {any} */ (deps.db.raw.prepare('SELECT * FROM proposals WHERE ref = ?').get(ref));
/** @param {any} c */
const newMarks = (c) => c.evidence.map((/** @type {any} */ e, /** @type {number} */ i) => ('new' in e ? i : -1)).filter((/** @type {number} */ i) => i >= 0);

const t = (/** @type {number} */ i) => ({ type: 'ticket', ref: `SUP-${i}`, url: `https://acme.atlassian.net/browse/SUP-${i}` });

/**
 * DW-1 (another card), then A = DW-2 with one ticket; A rejected as already known, then pushed again with a code
 * quote: a new type at twice the evidence, so it reopens (resurfaces, model.mjs).
 */
async function reopenedA() {
  const d = makeDeps();
  const a = record({ topic: 'saved carts', evidence: [t(1)] });
  await tool(d, 'dowser_proposals_push', pushArgs([record(), a], { run_id: 'r-1' }));
  d.clock.tick(HOUR);
  await res(d, 'verdict.reject', { refs: ['DW-2'], reason: 'already-known', note: 'same as DW-1' });
  d.clock.tick(HOUR);
  await tool(d, 'dowser_proposals_push', pushArgs([{ ...a, evidence: [t(1), { type: 'code', ref: 'src/cart.js:4', quote: 'saveCart()' }] }], { run_id: 'r-2' }));
  return d;
}

test('a rejected card reopened by new evidence says how much is new and what was decided', async () => {
  const d = await reopenedA();
  const a = (await items(d)).find((c) => c.ref === 'DW-2');
  assert.equal(a.change, 'reopened');
  assert.deepEqual(newMarks(a), [1], 'exactly the item the reopening push brought');
  assert.equal(a.evidence[1].new, true);
  const r = row(d, 'DW-2');
  assert.deepEqual(a.delta, {
    since: 'decision', new_evidence: 1,
    decision: { status: 'rejected', reason: 'already-known', note: 'same as DW-1', decided_by: r.decided_by, decided_at: r.decided_at },
  });
  assert.equal(r.status, 'open', 'the row says open: the prior status is derived from the stamp');
});

test('a card whose evidence grew in a later push marks the items of that push, with no decision', async () => {
  const d = makeDeps();
  const b = record({ topic: 'gift wrap', evidence: [t(1), t(2)] });
  await tool(d, 'dowser_proposals_push', pushArgs([b], { run_id: 'r-1' }));
  d.clock.tick(HOUR);
  await tool(d, 'dowser_proposals_push', pushArgs([{ ...b, evidence: [t(1), t(2), t(3), t(4)] }], { run_id: 'r-2' }));
  const [c] = await items(d);
  assert.equal(c.change, 'grew');
  assert.deepEqual(newMarks(c), [2, 3]);
  assert.deepEqual(c.delta, { since: 'previous-push', new_evidence: 2 });
  assert.equal('decision' in c.delta, false);
});

test('a card first seen in its push wears no new marks and no delta', async () => {
  const d = makeDeps();
  await tool(d, 'dowser_proposals_push', pushArgs([record({ evidence: [t(1), t(2)] })], { run_id: 'r-1' }));
  d.clock.tick(HOUR);
  // pushed again, nothing new: still the card of its first push
  await tool(d, 'dowser_proposals_push', pushArgs([record({ evidence: [t(1), t(2)] })], { run_id: 'r-2' }));
  const [c] = await items(d);
  assert.equal(c.change, 'new');
  assert.deepEqual(newMarks(c), []);
  assert.equal('delta' in c, false);
});

test('a dated snooze back on its day says so with no new evidence and the snooze it had', async () => {
  const d = makeDeps();
  const r = record();
  await tool(d, 'dowser_proposals_push', pushArgs([r], { run_id: 'r-1' }));
  d.clock.tick(HOUR);
  await res(d, 'verdict.snooze', { refs: ['DW-1'], until: '2026-11-15' });
  d.clock.tick(Date.parse('2026-11-15T12:00:00.000Z') - Date.parse('2026-10-27T11:00:00.000Z'));
  await tool(d, 'dowser_proposals_push', pushArgs([{ ...r, status: 'pushed', external_ref: 'DW-1' }], { run_id: 'r-2' }));
  const [c] = await items(d);
  assert.equal(c.change, 'reopened');
  assert.deepEqual(newMarks(c), []);
  const s = row(d, 'DW-1');
  assert.deepEqual(c.delta, { since: 'decision', new_evidence: 0, decision: { status: 'snoozed', decided_by: s.decided_by, decided_at: s.decided_at, snooze_until: '2026-11-15' } });
});

test('a decided card never wears a change: accepted, and rejected without reopening', async () => {
  const d = makeDeps();
  const a = record({ topic: 'alpha', evidence: [t(1), t(2)] });
  const b = record({ topic: 'beta', evidence: [t(1), t(2)] });
  await tool(d, 'dowser_proposals_push', pushArgs([a, b], { run_id: 'r-1' }));
  await res(d, 'settings.set', { project_key: PK, jira_project_key: 'SHOP', issue_type_id: '10001' });
  d.clock.tick(HOUR);
  await res(d, 'verdict.accept', { ref: 'DW-1' });
  await res(d, 'verdict.reject', { refs: ['DW-2'], reason: 'not-worth-it' });
  d.clock.tick(HOUR);
  // both gain evidence; neither reopens (accepted never does; a rejected one needs a new type at twice the count)
  await tool(d, 'dowser_proposals_push', pushArgs([{ ...a, evidence: [t(3)] }, { ...b, evidence: [t(3)] }], { run_id: 'r-2' }));
  for (const [status, ref] of [['accepted', 'DW-1'], ['rejected', 'DW-2']]) {
    const [c] = await items(d, { status });
    assert.equal(c.ref, ref);
    assert.equal(c.evidence.length, 3);
    assert.deepEqual(newMarks(c), [], `${ref} has no new marks`);
    assert.equal('delta' in c, false, `${ref} has no delta`);
    const got = await res(d, 'proposal.get', { ref });
    assert.equal('delta' in got.card, false);
  }
});

test('proposal.get and the Rovo answers carry the same delta and marks as the inbox', async () => {
  const d = await reopenedA();
  const listed = (await items(d)).find((c) => c.ref === 'DW-2');
  const got = (await res(d, 'proposal.get', { ref: 'DW-2' })).card;
  assert.deepEqual(got.delta, listed.delta);
  assert.deepEqual(got.evidence, listed.evidence);
  const explained = /** @type {any} */ (await runRovo(d, 'dowser_proposal_explain', { ref: 'DW-2' }, ME)).card;
  assert.deepEqual(explained.delta, listed.delta);
  assert.deepEqual(explained.evidence, listed.evidence);
  const compact = /** @type {any} */ (await runRovo(d, 'dowser_inbox_list', {}, ME)).items;
  assert.equal(compact.find((/** @type {any} */ c) => c.ref === 'DW-2').new_evidence, 1);
  assert.equal('new_evidence' in compact.find((/** @type {any} */ c) => c.ref === 'DW-1'), false, 'a new card has no count');
});

test('the delta costs inbox.list no statement: a reopened inbox reads as many as an untouched one', async () => {
  const count = async (/** @type {any} */ d) => {
    const c = countingDb(d.db);
    await runResolver({ ...d, db: c }, 'inbox.list', { project_key: PK }, ME, 'inbox');
    return c.count();
  };
  const reopened = await reopenedA();
  const plain = makeDeps();
  await tool(plain, 'dowser_proposals_push', pushArgs([record(), record({ topic: 'saved carts', evidence: [t(1)] })], { run_id: 'r-1' }));
  assert.ok((await items(reopened)).some((c) => c.delta), 'the reopened inbox carries a delta');
  assert.equal(await count(reopened), await count(plain));
});

// The reading pane's delta line (labels.js deltaLine, rendered by Detail.jsx) over the server's card and the fixture's.
test('the delta line says what the card holds and nothing it lacks', async () => {
  const d = await reopenedA();
  const a = (await items(d)).find((c) => c.ref === 'DW-2');
  assert.equal(deltaLine(a), '1 new evidence item since it was rejected as Already known on 27 Oct 2026: same as DW-1');
  assert.equal(deltaLine({ delta: { since: 'previous-push', new_evidence: 2 } }), '2 new evidence items since the previous push');
  assert.equal(deltaLine({ delta: { since: 'decision', new_evidence: 0, decision: { status: 'snoozed', decided_by: 'x', decided_at: '2026-10-27T11:00:00.000Z', snooze_until: '2026-11-15' } } }),
    'Back on its snooze date, 15 Nov 2026, with no new evidence since it was snoozed on 27 Oct 2026');
  assert.equal(deltaLine({ delta: { since: 'decision', new_evidence: 1, decision: { status: 'snoozed', decided_by: 'x', decided_at: '2026-10-27T11:00:00.000Z' } } }),
    '1 new evidence item since it was snoozed on 27 Oct 2026', 'no note, no reason: none invented');
  assert.equal(deltaLine({}), undefined);
});

test('fixture journey: the reopened and the grew cards of the dev fixture wear the delta as the server sends it', async () => {
  /** @type {any[]} */
  const CARDS = (await ui('../static/app/src/dev/fixture.js')).CARDS;
  const reopened = CARDS.find((/** @type {any} */ c) => c.change === 'reopened');
  const grew = CARDS.find((/** @type {any} */ c) => c.change === 'grew');
  assert.ok(reopened?.delta && grew?.delta);
  assert.equal(reopened.delta.since, 'decision');
  assert.equal(grew.delta.since, 'previous-push');
  assert.equal('decision' in grew.delta, false);
  for (const c of [reopened, grew]) {
    assert.equal(c.evidence.filter((/** @type {any} */ e) => e.new === true).length, c.delta.new_evidence, `${c.ref}: the marks match the count`);
    assert.equal(c.evidence.some((/** @type {any} */ e) => 'new' in e && e.new !== true), false);
    assert.match(String(deltaLine(c)), /^\d+ new evidence items? since /);
  }
  // the prior decision is what the row would hold: a reason means rejected
  assert.equal(reopened.delta.decision.status, reopened.delta.decision.reason ? 'rejected' : 'snoozed');
  for (const c of CARDS.filter((/** @type {any} */ x) => x.change === 'new' || x.status !== 'open')) {
    assert.equal('delta' in c, false, `${c.ref}: no delta`);
    assert.equal(c.evidence.some((/** @type {any} */ e) => 'new' in e), false);
  }
});
