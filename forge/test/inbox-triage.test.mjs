// @ts-check
// The inbox's triage reducer (static/app/src/routes/inbox/triage.js): a decided card's lifecycle, Undo and a failed
// commit, the selection after a decision, the checked set (only open cards), the snooze step and the dialog, a reload.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkedVisible, flatOf, initialTriage, phaseOf, phaseSets, snoozingRef, tallyOf, triage,
} from '../static/app/src/routes/inbox/triage.js';

/** @param {string} ref @param {string} [status] @param {string} [project_key] */
const card = (ref, status = 'open', project_key = 'P1') => ({ ref, status, project_key });
const A = card('DW-1');
const B = card('DW-2');
const C = card('DW-3', 'open', 'P2');
const LIST = [A, B, C];

/** @param {import('../static/app/src/routes/inbox/triage.js').TriageState} s @param {...import('../static/app/src/routes/inbox/triage.js').TriageEvent} evs */
const run = (s, ...evs) => evs.reduce(triage, s);
/** @param {import('../static/app/src/routes/inbox/triage.js').TriageState} s */
const order = (s) => flatOf(s, LIST).map((c) => c.ref);
/** @param {string} focus @param {Partial<import('../static/app/src/routes/inbox/triage.js').TriageState>} [over] */
const start = (focus, over = {}) => ({ ...initialTriage(), focus, ...over });

test('decide: the card leaves, is unchecked, counts in the tally and the selection moves to the next row', () => {
  const s0 = start(B.ref, { checked: new Set([A.ref, B.ref]), errors: { [B.ref]: 'old' } });
  const s = triage(s0, { type: 'decide', cards: [B], to: 'rejected', order: order(s0) });
  assert.equal(phaseOf(s, B.ref), 'leaving');
  assert.deepEqual(order(s), [A.ref, C.ref]);
  assert.equal(tallyOf(s).rejected, 1);
  assert.equal(tallyOf(s).total, 1);
  assert.deepEqual([...s.checked], [A.ref]);
  assert.equal(s.errors[B.ref], undefined);
  assert.equal(s.focus, C.ref);
  assert.equal(s.focusRequest, C.ref, 'the next row takes the DOM focus');
  assert.equal(s0.focus, B.ref, 'the reducer does not mutate');
});

test('exitDone then undo: leaving -> gone -> open, the tally drops and the card takes the focus back', () => {
  const s0 = start(B.ref);
  const left = triage(s0, { type: 'decide', cards: [B], to: 'rejected', order: order(s0) });
  const gone = triage(left, { type: 'exitDone', ref: B.ref });
  assert.equal(phaseOf(gone, B.ref), 'gone');
  assert.deepEqual([...phaseSets(gone).removed], [B.ref]);
  for (const from of [left, gone]) {
    const back = triage(from, { type: 'undo', refs: [B.ref] });
    assert.equal(phaseOf(back, B.ref), 'open');
    assert.equal(tallyOf(back).rejected, 0);
    assert.equal(back.focus, B.ref);
    assert.equal(back.focusRequest, B.ref);
  }
});

test('commitFailed: the card is back open with its error, and no focus request (the old restore(refs, false))', () => {
  const s0 = start(A.ref);
  const gone = run(s0, { type: 'decide', cards: [B], to: 'snoozed', order: order(s0) }, { type: 'exitDone', ref: B.ref });
  const s = triage(gone, { type: 'commitFailed', refs: [B.ref], message: 'conflict' });
  assert.equal(phaseOf(s, B.ref), 'open');
  assert.equal(s.errors[B.ref], 'conflict');
  assert.equal(s.focusRequest, '');
  assert.equal(s.focus, A.ref);
});

test('decide the last row: the selection clamps to the row now last, not none and not the first', () => {
  const s0 = start(C.ref);
  const s = triage(s0, { type: 'decide', cards: [C], to: 'snoozed', order: order(s0) });
  assert.equal(s.focus, B.ref);
});

test('a decision that leaves no row keeps the selection; one off the selected row does not move it', () => {
  const only = start(A.ref);
  assert.equal(triage(only, { type: 'decide', cards: [A], to: 'accepted', order: [A.ref] }).focus, A.ref);
  const other = start(A.ref);
  const s = triage(other, { type: 'decide', cards: [B, C], to: 'rejected', order: order(other) });
  assert.equal(s.focus, A.ref);
  assert.equal(s.focusRequest, '');
});

test('the per-inbox open counts follow: a decision keeps the card inbox, undo takes it back', () => {
  const s0 = start(A.ref);
  const s = triage(s0, { type: 'decide', cards: [A, C], to: 'rejected', order: order(s0) });
  assert.deepEqual([...s.decided.values()].map((d) => [d.to, d.project_key]), [['rejected', 'P1'], ['rejected', 'P2']]);
  assert.deepEqual([...triage(s, { type: 'undo', refs: [C.ref] }).decided.keys()], [A.ref]);
});

test('instant decide (reduced motion) goes straight to gone; a late exit timer does nothing', () => {
  const s0 = start(A.ref);
  const s = triage(s0, { type: 'decide', cards: [A], to: 'accepted', order: order(s0), instant: true });
  assert.equal(phaseOf(s, A.ref), 'gone');
  assert.equal(triage(s, { type: 'exitDone', ref: A.ref }), s);
  const after = triage(triage(s, { type: 'reset' }), { type: 'exitDone', ref: A.ref });
  assert.equal(phaseOf(after, A.ref), 'open', 'an exit timer from before a reload does not hide a card');
});

test('toggle (key x) refuses a card that is not open: no bulk reject of a decided card', () => {
  const X = card('DW-9', 'accepted');
  const s0 = start(X.ref);
  const s = triage(s0, { type: 'toggle', card: X });
  assert.equal(s.checked.size, 0);
  assert.equal(checkedVisible(s, new Map([[X.ref, X]])).length, 0);
  const left = triage(start(B.ref), { type: 'decide', cards: [B], to: 'rejected', order: [A.ref, B.ref, C.ref] });
  assert.equal(triage(left, { type: 'toggle', card: B }).checked.size, 0, 'a card decided on this page is not checked');
  const on = triage(s0, { type: 'toggle', card: A });
  assert.deepEqual([...on.checked], [A.ref]);
  assert.equal(triage(on, { type: 'toggle', card: A }).checked.size, 0);
});

test('openSnooze bulk is a step, not a sentinel ref; a deciding dialog closes the step', () => {
  const s = triage(start(A.ref, { checked: new Set([A.ref]) }), { type: 'openSnooze', bulk: true });
  assert.deepEqual(s.step, { kind: 'bulk' });
  assert.equal(snoozingRef(s), '');
  const d = triage(s, { type: 'openDialog', kind: 'accept', refs: [A.ref] });
  assert.equal(d.step, null);
  assert.deepEqual(d.dialog, { kind: 'accept', refs: [A.ref] });
  assert.equal(triage(s, { type: 'openDialog', kind: 'reject', refs: [] }), s, 'a deciding dialog with no cards does not open');
  const one = triage(start(A.ref), { type: 'openSnooze', ref: B.ref });
  assert.deepEqual(one.step, { kind: 'card', ref: B.ref });
  assert.equal(one.focus, B.ref);
  assert.equal(snoozingRef(one), B.ref);
  assert.equal(triage(one, { type: 'decide', cards: [B], to: 'snoozed', order: order(one) }).step, null);
});

test('reset after a reload: nothing decided, checked, failed or selected, no step and no dialog', () => {
  const s0 = start(A.ref);
  const busy = run(s0,
    { type: 'toggle', card: C },
    { type: 'decide', cards: [A], to: 'rejected', order: order(s0) },
    { type: 'decide', cards: [B], to: 'snoozed', order: [B.ref, C.ref] },
    { type: 'exitDone', ref: B.ref },
    { type: 'fail', refs: [C.ref], message: 'nope' },
    { type: 'openSnooze', ref: C.ref },
    { type: 'openDialog', kind: 'help', refs: [] });
  const s = triage(busy, { type: 'reset' });
  assert.equal(s.decided.size, 0);
  assert.equal(s.checked.size, 0);
  assert.deepEqual(s.errors, {});
  assert.equal(s.focus, '');
  assert.equal(s.focusRequest, '');
  assert.equal(s.step, null);
  assert.equal(s.dialog, null);
  assert.deepEqual(phaseSets(s), { leaving: new Set(), removed: new Set() });
});

test('select: a click on another row selects it; on the selected row in the narrow layout it folds the accordion', () => {
  const s0 = start(A.ref, { step: { kind: 'card', ref: A.ref } });
  const other = triage(s0, { type: 'select', ref: B.ref, wide: false });
  assert.equal(other.focus, B.ref);
  assert.equal(other.expanded, true);
  assert.equal(other.step, null);
  assert.equal(triage(s0, { type: 'select', ref: A.ref, wide: false }).expanded, false);
  assert.equal(triage(s0, { type: 'select', ref: A.ref, wide: true }).expanded, true);
  assert.equal(triage(start(''), { type: 'focusFirst', ref: A.ref }).focus, A.ref);
  assert.equal(triage(start(B.ref), { type: 'focusFirst', ref: A.ref }).focus, B.ref, 'a landed deep link is not overwritten');
});
