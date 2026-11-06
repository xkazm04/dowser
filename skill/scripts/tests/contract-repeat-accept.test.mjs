// @ts-check
// DW-191: "Contract says a repeat delegate accept is refused, but it reports recorded". The contract's
// dowser_verdicts_record results state what an accept of an item already accepted answers: `recorded`, with its issue, and
// it counts toward the day's accepts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const doc = readFileSync(fileURLToPath(new URL('../../../docs/contracts/forge-mcp-2.md', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
const start = doc.indexOf('\n## `dowser_verdicts_record`');
const section = doc.slice(start, doc.indexOf('\n## ', start + 1));

/** The sentences (or table rows) of the section that speak of an item already accepted. */
const repeat = () => section.split(/\n|(?<=\.)\s+/).filter((s) => /already[- ]accepted|already been accepted|accepted already|(re-?accept|repeat(ed)? accept|accept(ed)? again)/i.test(s)).join(' ');

test('DW-191: the results say an accept of an item already accepted answers recorded with its issue', () => {
  assert.ok(start >= 0, 'the section is there');
  const said = repeat();
  assert.match(said, /`recorded`|\brecorded\b/, 'the contract says what it answers');
  assert.match(said, /\bissue(_ref)?\b/, 'and that the answer carries its issue');
});

test('DW-191: the results say that accept counts toward the day\'s accepts', () => {
  assert.match(repeat(), /\b(count|counts|counted)\b[^.]*\b(accept|cap)|\b(uses?|spends?)\b[^.]*\b(accept|cap)/i);
});
