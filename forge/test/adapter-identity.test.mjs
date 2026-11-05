// @ts-check
// Which identity each Jira read in the Atlassian adapter uses. The adapter imports @forge/api, so it is read as
// source (comments stripped first, so a comment naming the rule cannot satisfy it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/adapters/atlassian.mjs', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** The source of one method of the `jira` port object, up to the next method. @param {string} name */
function method(name) {
  const at = src.indexOf(`async ${name}(`);
  assert.ok(at >= 0, `${name} not found`);
  const next = src.indexOf('\n  async ', at + 1);
  return src.slice(at, next < 0 ? undefined : next);
}

test('issue statuses are read as the user, never as the app (no status leak across project permissions)', () => {
  const body = method('issueStatuses');
  assert.match(body, /api\.asUser\(\)\.requestJira/);
  assert.doesNotMatch(body, /asApp\(\)/);
});

test('the header lists every REST path the adapter calls, and says statuses are read as the user', () => {
  const raw = readFileSync(new URL('../src/adapters/atlassian.mjs', import.meta.url), 'utf8');
  const header = raw.slice(0, raw.indexOf('import '));
  const paths = [...src.matchAll(/api\.route`([^`?$]+)/g)].map((m) => m[1].replace(/\/$/, ''));
  assert.ok(paths.length >= 10, `${paths.length} routes found`);
  for (const p of new Set(paths)) assert.ok(header.includes(p.split('/').slice(0, 5).join('/')), `${p} is missing from the header`);
  assert.doesNotMatch(header, /statuses[^\n]*AS APP/i);
  assert.match(header, /issue statuses[^\n]*\n?[^\n]*AS USER|AS USER[^.]*issue statuses/i);
  assert.match(header, /footer-comments/);
  assert.match(header, /Teamwork Graph/);
});
