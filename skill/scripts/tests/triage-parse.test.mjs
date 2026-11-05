// @ts-check
// lib/triage.mjs parseDecisions: the decision grammar a person types at pre-triage, as pure unit tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDecisions, splitEntries } from '../lib/triage.mjs';

test('parseDecisions: a ";" inside a quoted reject note stays in the note', () => {
  const { decisions, problems } = parseDecisions('1 keep; 3 reject other "dup of DW-4; same root cause"; 4 keep');
  assert.deepEqual(problems, []);
  assert.deepEqual(decisions.map((d) => [d.line, d.ns, d.to, d.reason, d.note]), [
    [1, [1], undefined, undefined, undefined],
    [2, [3], 'rejected', 'other', 'dup of DW-4; same root cause'],
    [3, [4], undefined, undefined, undefined],
  ]);
  assert.deepEqual(splitEntries('2 reject not-worth-it; 5 snooze 2026-12-01\nrest keep'), ['2 reject not-worth-it', '5 snooze 2026-12-01', 'rest keep']);
});

test('parseDecisions: the grammar, table-driven (ranges of numbers, every verb, rest, and each refusal)', () => {
  /** @type {[string, unknown[], string[]][]} [input, decisions as [ns, to, reason|until|into, note], problems] */
  const cases = [
    ['1 keep', [[[1], undefined, undefined, undefined]], []],
    ['1,2,3 reject not-worth-it', [[[1, 2, 3], 'rejected', 'not-worth-it', undefined]], []],
    ['2 reject other "needs a design call"', [[[2], 'rejected', 'other', 'needs a design call']], []],
    ['2 reject other plain words note', [[[2], 'rejected', 'other', 'plain words note']], []],
    ['4 snooze 2026-12-01', [[[4], 'snoozed', '2026-12-01', undefined]], []],
    ['4 snooze', [[[4], 'snoozed', undefined, undefined]], []],
    ['5 merge 2', [[[5], 'merged', '2', undefined]], []],
    ['5 merge 0123456789abcdef', [[[5], 'merged', '0123456789abcdef', undefined]], []],
    ['1 keep\n2 reject wrong-size;rest keep', [[[1], undefined, undefined, undefined], [[2], 'rejected', 'wrong-size', undefined], [[], undefined, undefined, undefined]], []],
    ['  ;; 1 keep ;  ', [[[1], undefined, undefined, undefined]], []],
    ['1 keep now', [], ['keep takes nothing after it']],
    ['rest reject', [], ['rest only takes keep (rest keep)']],
    ['1-3 keep', [], ['starts with a card number (or rest)']],
    ['DW-4 keep', [], ['starts with a card number (or rest)']],
    ['4 snooze next week', [], ['snooze takes one date YYYY-MM-DD, or none']],
    ['5 merge 2 3', [], ['merge takes one card number or fp']],
    ['6 accept', [], ['"accept" after the number: each card is keep, reject, snooze or merge']],
    ['6', [], ['nothing after the number: each card is keep, reject, snooze or merge']],
  ];
  for (const [input, want, problems] of cases) {
    const r = parseDecisions(input);
    const got = r.decisions.map((d) => [d.ns, d.to, d.reason ?? d.until ?? d.into, d.note]);
    assert.deepEqual(got, want, input);
    assert.deepEqual(r.problems.map((p) => p.problem), problems, input);
  }
  // entries are numbered in order, so a problem names the one the person typed
  const mixed = parseDecisions('1 keep; 2 accept; 3 keep');
  assert.deepEqual(mixed.problems.map((p) => [p.line, p.text]), [[2, '2 accept']]);
  assert.deepEqual(mixed.decisions.map((d) => d.line), [1, 3]);
  assert.equal(parseDecisions('rest keep').decisions[0].rest, true);
});
