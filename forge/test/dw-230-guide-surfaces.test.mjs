// @ts-check
// DW-230: the guide names only the surfaces that decide. The evidence panel may call one read-only resolver key, so
// neither the guide's opening nor the two code comments that repeat it may name the panel as a place a verdict is made.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MODULE_KEYS } from '../src/core/app.mjs';

/** A repo file's text. @param {string} path relative to the repo root */
const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
/** Prose as one line, so a claim wrapped across lines or comment markers is still found. @param {string} text */
const flat = (text) => text.replace(/\s*\r?\n\s*(\/\/\s*)?/g, ' ');

test('the evidence panel may call only its one read key', () => {
  assert.deepEqual(MODULE_KEYS['dowser-evidence'], ['panel.forIssue']);
});

test('docs/forge-app.md does not say a verdict is made in the evidence panel', () => {
  assert.doesNotMatch(flat(read('docs/forge-app.md')), /verdict[^.]*\bin the evidence panel/i);
});

test('forge/src/index.js does not call the issue panel a surface that decides', () => {
  assert.doesNotMatch(flat(read('forge/src/index.js')), /The issue panel is the only surface that decides/);
});

test('forge/src/core/verdicts.mjs does not open with the evidence panel as a decision path', () => {
  const opening = flat(read('forge/src/core/verdicts.mjs').split(/\r?\n/).slice(0, 5).join('\n'));
  assert.doesNotMatch(opening, /the inbox, the evidence panel and the Rovo/);
});
