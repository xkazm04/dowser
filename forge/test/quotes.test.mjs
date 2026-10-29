// @ts-check
// DW-9: a team with `quotes=omit` pushes code/doc evidence with `quote_sha` in place of `quote`. Forge accepts
// it, keys it on path + sha (two withheld lines in one file stay two), and renders the ref and its link.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ME, makeDeps, pushArgs, record } from './helpers.mjs';
import { runResolver, runTool } from '../src/core/app.mjs';
import { checkRecord } from '../src/core/push.mjs';
import { adfToText, issueDescription } from '../src/core/adf.mjs';
import { quoteSha } from '../src/shared/fingerprint.mjs';

/** @param {any} deps @param {string} name @param {object} args */
const tool = (deps, name, args) => /** @type {Promise<any>} */ (runTool(deps, name, args, ME));
/** @param {any} deps @param {string} key @param {object} p */
const res = (deps, key, p) => /** @type {Promise<any>} */ (runResolver(deps, key, p, ME, 'inbox'));

const A = 'export function exportReport() {';
const B = 'return rows.map(toCsv).join("\\n");';

test('checkRecord takes quote_sha in place of quote, and never neither', () => {
  assert.equal(checkRecord(record({ evidence: /** @type {any} */ ([{ type: 'code', ref: 'src/reports/export.js:12', quote_sha: quoteSha(A) }]) })).ok, true);
  const bare = checkRecord(record({ evidence: [{ type: 'code', ref: 'src/reports/export.js:12' }] }));
  assert.equal(bare.ok, false);
  assert.match(/** @type {any} */ (bare).why, /quote:required for code evidence \(or quote_sha\)/);
  assert.equal(checkRecord(record()).ok, true, 'a quoted record is accepted as before');
});

test('a push with withheld quotes is created, two lines in one file stay two, and a line shift is not growth', async () => {
  const d = makeDeps();
  const ev = /** @type {any[]} */ ([
    { type: 'code', ref: 'src/reports/export.js:12', quote_sha: quoteSha(A) },
    { type: 'code', ref: 'src/reports/export.js:30', quote_sha: quoteSha(B) },
  ]);
  const a = await tool(d, 'dowser_proposals_push', pushArgs([record({ evidence: ev })]));
  assert.equal(a.results[0].result, 'created', JSON.stringify(a.results[0]));
  const { card } = await res(d, 'proposal.get', { ref: 'DW-1' });
  assert.deepEqual(card.evidence.map((/** @type {any} */ e) => e.ref), ['src/reports/export.js:12', 'src/reports/export.js:30']);
  assert.ok(card.evidence.every((/** @type {any} */ e) => !('quote' in e) && !('quote_sha' in e)), 'no quote is stored or shown');
  assert.equal(card.evidence[0].link, 'https://github.com/Acme/Shop/blob/abc123/src/reports/export.js#L12');

  // the same withheld lines on shifted line numbers are the same keys: nothing new
  const shifted = ev.map((e, i) => ({ ...e, ref: `src/reports/export.js:${40 + i}` }));
  await tool(d, 'dowser_proposals_push', pushArgs([record({ evidence: shifted, status: 'pushed' })], { run_id: 'r-2' }));
  assert.equal(/** @type {any} */ (d.db.raw.prepare('SELECT COUNT(*) AS n FROM evidence').get()).n, 2);

  // the Jira issue text renders the ref with its link and no quote
  const adf = issueDescription(card, 'https://acme.atlassian.net/jira/apps/app/env/inbox?ref=DW-1');
  const text = adfToText(adf);
  assert.match(text, /code: src\/reports\/export\.js:12/);
  assert.match(text, /code: src\/reports\/export\.js:30/);
  assert.ok(!text.includes(A) && !text.includes('toCsv'), text);
  assert.ok(JSON.stringify(adf).includes('https://github.com/Acme/Shop/blob/abc123/src/reports/export.js#L12'), 'the ref links to the code');
});
