// @ts-check
// DW-60: the read-only reflect call matches the routing rule the contract states. A transport with no tool name
// routes a call by its shape (forge/src/core/app.mjs actionName), and only `rules_json` marks a reflect call, so
// `reflect export` always sends it: `"[]"` when nothing is offered. SKILL.md and the contract say the same.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { removeDir, tempDir } from './_fixture.mjs';
import { openStore } from '../lib/store.mjs';
import { exportOffers } from '../lib/reflect.mjs';
import { actionName } from '../../../forge/src/core/app.mjs';

/** @param {string} rel */
const read = (rel) => readFileSync(new URL(`../../../${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('exportOffers with nothing offered still sends rules_json "[]"', () => {
  const home = tempDir('reflect-ro');
  const db = openStore(join(home, 'dowser.db'));
  try {
    const out = exportOffers(db, 'pk');
    assert.equal(out.rules_json, '[]');
  } finally { db.close(); removeDir(home); }
});

test('the bare export, sent with no tool name, routes to dowser_reflect_sync', () => {
  const home = tempDir('reflect-ro-route');
  const db = openStore(join(home, 'dowser.db'));
  try {
    const out = exportOffers(db, 'pk');
    assert.equal(actionName('mcp', [], out), 'dowser_reflect_sync', 'not dowser_verdicts_pull');
  } finally { db.close(); removeDir(home); }
});

test('SKILL.md no longer says rules_json is omitted when nothing is offered', () => {
  const skill = read('skill/SKILL.md');
  assert.doesNotMatch(skill, /`rules_json` is omitted when nothing is offered/);
  const at = skill.indexOf('1. `reflect export`.');
  assert.ok(at >= 0, 'SKILL.md has the reflect export step');
  const step = skill.slice(at, skill.indexOf('\n2. ', at));
  assert.match(step, /"\[\]"/, 'the export step says rules_json is "[]" when nothing is offered');
});

test('the contract row for rules_json no longer offers to omit it', () => {
  const row = read('docs/contracts/forge-mcp-2.md').split('\n').find((l) => l.startsWith('| `rules_json` |'));
  assert.ok(row, 'the contract has a rules_json row');
  assert.doesNotMatch(row, /or omit it/);
  assert.match(row, /"\[\]"/);
});
