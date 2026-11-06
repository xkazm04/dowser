// @ts-check
// DW-168: "a card valid with its quotes stays valid once they are withheld". The card's two probes through
// validateCandidate in wire mode: "a view ref became 'the line at ...:3:3' and was refused; a title grew to 101
// characters and was refused". After: "both cards pass the wire validator once masked, checked by a test on these two
// shapes". Done means "refs are never masked and an over-limit field is shortened rather than refused". Built reading:
// a masked title over 80 is cut at a word boundary to 80 with no part of the quote left; a view's limits hold too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ARTIFACT_LIMITS, FIELD_LIMITS, STORE_OWNED, validateCandidate } from '../lib/model.mjs';
import { withheldQuotes } from '../lib/sync.mjs';
import { candidate } from './_fixture.mjs';

const TITLE_MAX = 80; // docs/contracts/forge-mcp-2.md: `title` | 80, one line
const LINE = 'return check(user.password);';
const LONG_REF = 'src/services/authentication/login-handler.js:120';

/** @param {Record<string, any>} rec */
const wire = (rec) => {
  const v = validateCandidate(Object.fromEntries(Object.entries(rec).filter(([k]) => !STORE_OWNED.includes(k))), { wire: true });
  return v.ok ? 'ok' : v.why;
};
const PATH_QUOTE = 'src/auth.js:3';
const PATH_EVIDENCE = [
  { type: 'doc', ref: 'docs/guide.md:9', quote: PATH_QUOTE },
  { type: 'code', ref: `${PATH_QUOTE}:3`, quote: LINE },
];

test('shape 1: a quote naming a path its view also cites: the view ref stays and the card passes', () => {
  const rec = candidate({
    evidence: PATH_EVIDENCE,
    artifacts: [{ kind: 'table', message: 'One row of one view', alt: 'A table with one row.', refs: [`${PATH_QUOTE}:3`, 'docs/guide.md:9'],
      data: { columns: ['Place', 'Count'], rows: [['login', '1']] } }],
  });
  assert.equal(wire(rec), 'ok', 'valid with its quotes');
  const out = withheldQuotes(rec);
  assert.deepEqual(out.artifacts[0].refs, [`${PATH_QUOTE}:3`, 'docs/guide.md:9'], 'refs inside artifacts are never masked');
  assert.equal(wire(out), 'ok');
});

test('a view keeps its refs while the text beside them is masked', () => {
  const rec = candidate({
    evidence: PATH_EVIDENCE,
    artifacts: [{ kind: 'flow', message: `Input reaches ${PATH_QUOTE}`, alt: 'Two steps of a flow.', refs: [`${PATH_QUOTE}:3`],
      data: { steps: [{ label: 'login' }, { label: PATH_QUOTE, mark: 'failure' }] } }],
  });
  assert.equal(wire(rec), 'ok', 'valid with its quotes');
  const out = withheldQuotes(rec);
  assert.deepEqual(out.artifacts[0].refs, [`${PATH_QUOTE}:3`]);
  assert.equal(out.artifacts[0].message, 'Input reaches the line at docs/guide.md:9', 'the text is still masked');
  assert.equal(wire(out), 'ok');
});

test('shape 2: a title the mask grows past 80 is cut at a word boundary to 80, with no part of the quote', () => {
  const title = `Hash before ${LINE} runs in the login path`;
  assert.ok(title.length <= TITLE_MAX);
  const rec = candidate({ title, evidence: [{ type: 'code', ref: LONG_REF, quote: LINE }] });
  assert.equal(wire(rec), 'ok', 'valid with its quotes');
  const out = withheldQuotes(rec);
  const masked = `Hash before the line at ${LONG_REF} runs in the login path`;
  assert.ok(masked.length > TITLE_MAX, 'the probe\'s shape');
  assert.ok(out.title.length <= TITLE_MAX, `${out.title.length} chars: ${out.title}`);
  assert.ok(!out.title.includes('user.password'), out.title);
  assert.ok(masked.startsWith(out.title), `cut, not rewritten: ${out.title}`);
  assert.equal(masked[out.title.length], ' ', 'cut at a word boundary');
  assert.equal(out.title, out.title.trim());
  assert.ok(!out.title.includes('…'), 'no ellipsis beyond the limit');
  assert.equal(wire(out), 'ok');
});

test('a title under 80 once masked is left whole', () => {
  const rec = candidate({ title: `Hash before ${LINE}`, evidence: [{ type: 'code', ref: 'src/a.js:1', quote: LINE }] });
  assert.equal(withheldQuotes(rec).title, 'Hash before the line at src/a.js:1');
});

test('a view\'s message and alt stay within their limits once masked, with no part of the quote', () => {
  const message = `${LINE} ${'x'.repeat(ARTIFACT_LIMITS.message - LINE.length - 1)}`;
  const alt = `${LINE} ${'y'.repeat(ARTIFACT_LIMITS.alt - LINE.length - 1)}`;
  const rec = candidate({
    evidence: [{ type: 'code', ref: LONG_REF, quote: LINE }],
    artifacts: [{ kind: 'table', message, alt, refs: [LONG_REF], data: { columns: ['Place'], rows: [['login']] } }],
  });
  assert.equal(wire(rec), 'ok', 'valid with its quotes');
  const out = withheldQuotes(rec);
  assert.ok(!JSON.stringify(out).includes('user.password'));
  assert.equal(wire(out), 'ok');
});

test('the acceptance holds for the other capped text too: a view label and cell, and the rationale at its cap', () => {
  const rec = candidate({
    rationale: `${LINE} ${'r'.repeat(FIELD_LIMITS.rationale - LINE.length - 1)}`,
    evidence: [{ type: 'code', ref: LONG_REF, quote: LINE }],
    artifacts: [{ kind: 'table', message: 'm', alt: 'a', refs: [LONG_REF], data: { columns: [LINE], rows: [[`${LINE} ${'c'.repeat(ARTIFACT_LIMITS.cell - LINE.length - 1)}`]] } }],
  });
  assert.equal(wire(rec), 'ok', 'valid with its quotes');
  const out = withheldQuotes(rec);
  assert.ok(!JSON.stringify(out).includes('user.password'));
  assert.equal(wire(out), 'ok');
});
