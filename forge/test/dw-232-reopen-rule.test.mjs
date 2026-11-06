// @ts-check
// DW-232: the contract states both ways a snoozed item reopens. A re-push reopens it when the evidence grew, and also
// when its dated snooze has come due, with no new evidence (core/push.mjs updateOne, docs/forge-app.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** The **Reopening.** paragraph of the contract, as one line. */
function reopening() {
  const contract = readFileSync(new URL('../../docs/contracts/forge-mcp-2.md', import.meta.url), 'utf8');
  const para = contract.split(/\r?\n\s*\r?\n/).filter((p) => p.startsWith('**Reopening.**'));
  assert.equal(para.length, 1, 'one Reopening paragraph in the contract');
  return para[0].replace(/\s*\r?\n\s*/g, ' ');
}

test('the Reopening paragraph names evidence growth', () => {
  assert.match(reopening(), /\bgrew the evidence\b|\bevidence (grew|growth|grows)\b/i);
});

test('the Reopening paragraph names a dated snooze whose day has come', () => {
  assert.match(reopening(), /(dated snooze|snooze[^.]*\b(day|date)\b)[^.]*\b(has come|has arrived|has passed|is due|comes due|came due|is reached)\b/i);
});

test('the Reopening paragraph says the due snooze reopens with no new evidence', () => {
  assert.match(reopening(), /\b(no|without( any)?)\s+((new|added|more)\s+evidence|evidence growth|growth)\b/i);
});
