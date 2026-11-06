// @ts-check
// DW-160: "a line repeated word for word never leaves under quotes=omit, whatever the evidence order". The card's
// probe: short quote first left "const token = the line at src/a.js:1 + internalSalt;"; long quote first gave
// "the line at src/a.js:2". After: both orders give the second form.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withheldQuotes } from '../lib/sync.mjs';

const LONG = 'const token = readSecret(env) + internalSalt;';
const SHORT = 'readSecret(env)';
const short = { type: 'code', ref: 'src/a.js:1', quote: SHORT };
const long = { type: 'code', ref: 'src/a.js:2', quote: LONG };
/** @param {Record<string, unknown>[]} evidence */
const card = (evidence) => ({ fp: 'f', title: 't', rationale: `It runs ${LONG}`, body: `## Description\nRead \`${LONG}\` closely.`, evidence });

test('a fragment cited first does not leave the rest of the whole line', () => {
  const out = withheldQuotes(card([short, long]));
  assert.ok(!out.rationale.includes('internalSalt'), out.rationale);
  assert.equal(out.rationale, 'It runs the line at src/a.js:2');
  assert.equal(out.body, '## Description\nRead the line at src/a.js:2 closely.');
});

test('both evidence orders give the same masked text', () => {
  const a = withheldQuotes(card([short, long]));
  const b = withheldQuotes(card([long, short]));
  assert.equal(a.rationale, b.rationale);
  assert.equal(a.body, b.body);
});

test('the fragment alone, where the card repeats only it, is still masked', () => {
  const out = withheldQuotes({ ...card([short, long]), rationale: `It calls ${SHORT} once.` });
  assert.equal(out.rationale, 'It calls the line at src/a.js:1 once.');
});

test('three nested quotes in any order leave none of the long line', () => {
  const mid = { type: 'doc', ref: 'docs/a.md:3', quote: 'token = readSecret(env)' };
  for (const order of [[short, mid, long], [mid, short, long], [short, long, mid], [long, mid, short]]) {
    const out = withheldQuotes(card(order));
    assert.equal(out.rationale, 'It runs the line at src/a.js:2', JSON.stringify(order.map((e) => e.ref)));
  }
});
