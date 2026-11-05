// @ts-check
// The two @forge/bridge stand-ins (static/app/src/dev/bridge.js for the fixture, http-bridge.js for the local
// server) share dev/link.js: the same deep-link keys, and the module each surface stands for as Forge names it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MODULE_KEYS } from '../src/core/app.mjs';

/** @type {any} */
const link = await import(String(new URL('../static/app/src/dev/link.js', import.meta.url)));
const src = (/** @type {string} */ f) => readFileSync(new URL(`../static/app/src/dev/${f}`, import.meta.url), 'utf8');

test('dev bridges: a map heat-cell link keeps project, lens and area; every surface names a real module', () => {
  const q = new URL('https://x/jira/apps/dev/dowser/inbox?project=PK&lens=doc-drift&area=src&mode=dark&ref=DW-3').searchParams;
  assert.equal(link.linkQuery(q), '?ref=DW-3&project=PK&lens=doc-drift&area=src');
  assert.equal(link.linkQuery(new URLSearchParams('mode=dark')), '');
  for (const s of ['inbox', 'map', 'reflect', 'settings', 'panel', 'byline', 'banner']) assert.ok(Object.hasOwn(MODULE_KEYS, link.moduleOf(s)), s);
  for (const f of ['bridge.js', 'http-bridge.js']) {
    assert.match(src(f), /from '\.\/link\.js'/, `${f} uses the shared link keys`);
    assert.match(src(f), /close: async/, `${f} has view.close`);
    assert.match(src(f), /s === 'banner'/, `${f} serves the banner surface`);
  }
});
