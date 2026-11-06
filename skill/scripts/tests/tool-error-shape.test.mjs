// @ts-check
// DW-192: "Contract promises an error flag the live app does not set on tool failures". The app answers a plain
// {error, message}; the mock adds isError. After: "one shape on the app, the mock and the contract". A saved answer of the
// plain shape is a tool error for the skill too, and the contract names `error` as the signal.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeDir, tempDir } from './_fixture.mjs';
import { readResponse } from '../lib/sync.mjs';

const CONTRACT = fileURLToPath(new URL('../../../docs/contracts/forge-mcp-2.md', import.meta.url));
const FORBIDDEN = { error: 'forbidden', message: 'This account may not open the inbox.' };

/** @type {string} */ let dir;
before(() => { dir = tempDir('tool-error'); });
after(() => { removeDir(dir); });

/** @param {string} name @param {unknown} doc */
const save = (name, doc) => { const f = join(dir, name); writeFileSync(f, JSON.stringify(doc)); return f; };
/** The refusal that isError gets today. @param {string} file */
const isToolError = (file) => assert.throws(() => readResponse(file), (/** @type {any} */ e) => {
  assert.equal(e.name, 'DowserError');
  assert.equal(e.code, 2);
  assert.match(e.message, /tool error/);
  assert.equal(e.detail?.error, 'tool-error');
  return true;
});

test('DW-192: the isError form stays a tool error (the shape the others must match)', () => {
  isToolError(save('flag.json', { content: [{ type: 'text', text: JSON.stringify(FORBIDDEN) }], isError: true }));
});

test('DW-192: a bare {error, message} is a tool error', () => {
  isToolError(save('bare.json', FORBIDDEN));
});

test('DW-192: an MCP result whose text holds {error, message} is a tool error', () => {
  isToolError(save('wrapped.json', { content: [{ type: 'text', text: JSON.stringify(FORBIDDEN) }] }));
});

test('DW-192: structuredContent holding {error, message} is a tool error', () => {
  isToolError(save('structured.json', { structuredContent: FORBIDDEN }));
});

test('DW-192: an answer that is no error still reads as itself', () => {
  assert.deepEqual(readResponse(save('fine.json', { items: [] })), { items: [] });
  assert.deepEqual(readResponse(save('fine2.json', { content: [{ type: 'text', text: '{"items":[]}' }] })), { items: [] });
});

/** The prose of the contract's Errors section, without its table. */
function errorsProse() {
  const doc = readFileSync(CONTRACT, 'utf8').replace(/\r\n/g, '\n');
  const start = doc.indexOf('\n## Errors\n');
  assert.ok(start >= 0, 'the contract has an Errors section');
  const end = doc.indexOf('\n## ', start + 1);
  return doc.slice(start, end).split('\n').filter((l) => !l.startsWith('|')).join(' ');
}

test('DW-192: the contract names `error` as the signal of a failure', () => {
  assert.match(errorsProse(), /`error`[^.]*\b(signal|marks?|tells?|means?|is how|identif)|\b(signal|marked by|read|check|look at|test)[^.]*`error`/i);
});

test('DW-192: the contract does not state that every failure has isError: true', () => {
  const flagged = errorsProse().split(/(?<=[.:])\s+/).filter((s) => s.includes('isError'));
  const claims = flagged.filter((s) => !/\b(may|might|some|not|never|only|optional|whether|mock|local)\b|\bcan (also )?(carry|set|have|add)\b/i.test(s));
  assert.deepEqual(claims, [], 'a sentence that states the flag as the shape of every failure');
});
