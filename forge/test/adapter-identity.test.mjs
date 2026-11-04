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
  assert.match(body, /asUser\(\)\.requestJira/);
  assert.doesNotMatch(body, /asApp\(\)/);
});
