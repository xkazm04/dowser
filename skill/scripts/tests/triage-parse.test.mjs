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
