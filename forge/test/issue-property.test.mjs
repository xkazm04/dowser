// @ts-check
// Dowser facts as Jira data (moonshot 2026-11-04, idea 5): an accepted or merged item writes the indexed issue
// property `dowser`, so JQL, boards and Automation can use lens, score and band. A Jira failure never costs the
// decision; the daily backfill writes what is missing, once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ME, makeDeps, pushArgs, record } from './helpers.mjs';
import { runResolver, runTool } from '../src/core/app.mjs';
import { backfillIssueProperties, issuePropertyOf } from '../src/core/issue-property.mjs';

const PK = 'github-com-Acme-Shop';
/** @param {any} d @param {string} key @param {Record<string, unknown>} p */
const res = (d, key, p) => /** @type {Promise<any>} */ (runResolver(d, key, p, ME, 'inbox'));

async function seeded() {
  const d = makeDeps();
  const scored = { ...record({ topic: 'alpha' }), category: 'product', impact: 8, impact_why: 'asked in 12 tickets', risk: 2,
    effort: { size: 'S', basis: ['one module'], score: 2 }, score: 61.5,
    score_parts: { impact: 8, confidence_w: 0.75, effort_div: 1.111, risk_factor: 0.95, formula: 'scan-score/1' }, band: 'ranked', mvp: true };
  await runTool(d, 'dowser_proposals_push', pushArgs([scored, record({ topic: 'beta' }), record({ topic: 'gamma' })], { run_id: 'r-1' }), ME);
  await res(d, 'settings.set', { project_key: PK, jira_project_key: 'SHOP', issue_type_id: '10001' });
  return d;
}

test('accept writes the dowser issue property with the card facts; absent facts are omitted', async () => {
  const d = await seeded();
  const out = await res(d, 'verdict.accept', { ref: 'DW-1' });
  const prop = /** @type {any} */ (d.jira.properties[out.card.issue_ref]?.dowser);
  assert.ok(prop, 'the created issue carries the property');
  assert.equal(prop.ref, 'DW-1');
  assert.equal(prop.lens, 'opportunity');
  assert.equal(prop.kind, 'missing-capability');
  assert.equal(prop.score, 61.5);
  assert.equal(prop.impact, 8);
  assert.equal(prop.band, 'ranked');
  assert.equal(prop.mvp, 'yes');
  assert.equal(prop.via, 'accepted');
  const plain = issuePropertyOf(/** @type {any} */ ({ ref: 'DW-9', fp: 'f'.repeat(16), lens: 'doc-drift', kind: 'stale', confidence: 'low' }), 'accepted');
  assert.deepEqual(Object.keys(plain).sort(), ['confidence', 'fp', 'kind', 'lens', 'ref', 'via'], 'no score, band or mvp invented');
});

test('merge into a Jira key writes the property; a merge into an issue an accepted card owns does not overwrite it', async () => {
  const d = await seeded();
  await res(d, 'verdict.merge', { ref: 'DW-2', into: 'SHOP-7' });
  assert.equal(/** @type {any} */ (d.jira.properties['SHOP-7']?.dowser)?.ref, 'DW-2');
  assert.equal(/** @type {any} */ (d.jira.properties['SHOP-7']?.dowser)?.via, 'merged');
  const acc = await res(d, 'verdict.accept', { ref: 'DW-1' });
  await res(d, 'verdict.merge', { ref: 'DW-3', into: acc.card.issue_ref });
  assert.equal(/** @type {any} */ (d.jira.properties[acc.card.issue_ref]?.dowser)?.ref, 'DW-1', 'the accepted card keeps the issue');
});

test('a property failure never costs the accept; the daily backfill writes it once', async () => {
  const d = await seeded();
  d.jira.failProp = true;
  const out = await res(d, 'verdict.accept', { ref: 'DW-1' });
  assert.equal(out.card.status, 'accepted');
  assert.equal(d.jira.properties[out.card.issue_ref], undefined);
  assert.ok(d.logs.some((l) => l.includes('issue property')), 'the failure is logged');
  d.jira.failProp = false;
  assert.deepEqual(await backfillIssueProperties(d), { written: 1, failed: 0 });
  assert.equal(/** @type {any} */ (d.jira.properties[out.card.issue_ref]?.dowser)?.ref, 'DW-1');
  assert.deepEqual(await backfillIssueProperties(d), { written: 0, failed: 0 }, 'idempotent: nothing left to write');
});
