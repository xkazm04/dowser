// @ts-check
// The shared modules are byte-copies of the skill's (design F6): a drift fails here, not in production.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHARED } from '../scripts/sync-shared.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

test('src/shared matches skill/scripts/lib byte for byte', () => {
  for (const name of SHARED) {
    const want = readFileSync(join(HERE, '..', '..', 'skill', 'scripts', 'lib', name));
    const have = readFileSync(join(HERE, '..', 'src', 'shared', name));
    assert.ok(have.equals(want), `${name} differs; run npm --prefix forge run sync-shared`);
  }
});

test('the shared model exposes the resurfacing predicate the inbox reuses (F3)', async () => {
  const { resurfaces } = await import('../src/shared/model.mjs');
  assert.equal(resurfaces('snoozed', { refs: 1, types: ['code'] }, { refs: 2, types: ['code'] }).resurface, true);
  assert.equal(resurfaces('rejected', { refs: 2, types: ['code'] }, { refs: 4, types: ['code', 'ticket'] }).resurface, true);
});
