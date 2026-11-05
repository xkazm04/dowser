// @ts-check
// The global page's tab comes from the app history's pathname (Jira's sidebar keeps the iframe mounted and only
// changes the URL), or from the page URL; a query string, hash or trailing slash never hides the route.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { pageRoute, locationKey, PAGE_ROUTES } = await import(String(new URL('../static/app/src/components/route.js', import.meta.url)));
const PAGE = 'https://dowser.atlassian.net/jira/apps/68371a5c-644f-4311-b1c8-8d9582995796/646b63dc-cbf7-4575-b2ff-dfac59ca68c6';

test('the tab is the last path segment of a history path or a page URL', () => {
  assert.equal(pageRoute('/settings'), 'settings');
  assert.equal(pageRoute('/map'), 'map');
  assert.equal(pageRoute(`${PAGE}/reflect`), 'reflect');
  assert.equal(pageRoute(`${PAGE}/settings/`), 'settings', 'a trailing slash');
  assert.equal(pageRoute(`${PAGE}/map?project=p&lens=opportunity`), 'map', 'a query string');
  assert.equal(pageRoute('/inbox?ref=DW-3'), 'inbox');
  assert.equal(pageRoute('/settings#top'), 'settings', 'a hash');
});

test('an unknown, empty or root path is the inbox', () => {
  for (const p of [undefined, '', '/', PAGE, `${PAGE}/`, '/nope', 'not a url ://']) assert.equal(pageRoute(p), 'inbox', String(p));
});

test('the remount key changes with the route and with the query string', () => {
  assert.equal(locationKey({ pathname: '/inbox', search: '?ref=DW-1' }, undefined), 'inbox?ref=DW-1');
  assert.notEqual(locationKey({ pathname: '/inbox', search: '?lens=opportunity' }, undefined), locationKey({ pathname: '/inbox', search: '' }, undefined));
  assert.equal(locationKey(undefined, `${PAGE}/map?x=1`), 'map?x=1', 'falls back to the page URL');
});

test('every manifest page route is a tab the router knows', () => {
  const manifest = readFileSync(new URL('../manifest.yml', import.meta.url), 'utf8');
  const routes = [...manifest.matchAll(/^\s+route:\s*(\S+)\s*$/gm)].map((m) => m[1]);
  assert.ok(routes.length >= 4, 'manifest pages found');
  assert.deepEqual([...routes].sort(), [...PAGE_ROUTES].sort());
});

test('the router follows the app history instead of reading the context once', () => {
  const router = readFileSync(new URL('../static/app/src/router.jsx', import.meta.url), 'utf8');
  assert.match(router, /view\.createHistory\(\)/);
  assert.match(router, /history\.listen\(/);
});
