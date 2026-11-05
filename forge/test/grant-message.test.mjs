// @ts-check
// DW-65: a scanning agent whose source read lacks the person's grant is told where to give it, in the same words
// the entry point uses (forge/src/index.js): open Dowser in Jira once and allow access. The contract's
// `unauthorized` row says so too.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sources, useForgeApi } from '../src/adapters/atlassian.mjs';
import { AppError } from '../src/core/util.mjs';

const GRANT = 'Dowser needs your permission to read Jira on your behalf; open Dowser in Jira once and allow access';

/** @param {string} rel */
const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

/** Stands in for @forge/api's NeedsAuthenticationError (the adapter checks `instanceof api.NeedsAuthenticationError`). */
class NeedsAuth extends Error {}

/** @type {(() => void) | undefined} */
let restore;
afterEach(() => { restore?.(); restore = undefined; });

/** Every as-user call throws the missing-grant error, as @forge/api does before the person allowed access. */
function noGrant() {
  const refuse = async () => { throw new NeedsAuth('needs auth'); };
  const as = () => ({ requestJira: refuse, requestConfluence: refuse, requestTeamworkGraph: refuse });
  restore = useForgeApi(/** @type {any} */ ({
    asApp: as,
    asUser: as,
    NeedsAuthenticationError: NeedsAuth,
    getAppContext: () => ({ installationAri: { installationId: 'inst-1' }, appAri: { appId: 'app' }, environmentAri: { environmentId: 'env' } }),
    route: (/** @type {TemplateStringsArray} */ s, /** @type {unknown[]} */ ...v) => s.reduce((a, part, i) => a + part + (i < v.length ? String(v[i]) : ''), ''),
  }));
}

test('the entry point\'s wording is the one the adapter must use (guard)', () => {
  assert.ok(read('forge/src/index.js').includes(GRANT));
});

for (const [name, call] of /** @type {[string, () => Promise<unknown>][]} */ ([
  ['tickets', () => sources.tickets({ jql: 'project = SUP', limit: 5 })],
  ['pages', () => sources.pages({ cql: 'type = page', limit: 5 })],
  ['goals', () => sources.goals()],
])) {
  test(`sources.${name} without the person's grant says where to give it`, async () => {
    noGrant();
    await assert.rejects(call, (/** @type {any} */ e) => {
      assert.ok(e instanceof AppError, 'an AppError');
      assert.equal(e.code, 'unauthorized');
      assert.equal(e.message, GRANT);
      return true;
    });
  });
}

test('the contract\'s unauthorized row names where to grant access', () => {
  const row = read('docs/contracts/forge-mcp-2.md').split('\n').find((l) => l.startsWith('| `unauthorized` |'));
  assert.ok(row, 'the contract has an unauthorized row');
  assert.match(row, /open Dowser in Jira once/);
});
