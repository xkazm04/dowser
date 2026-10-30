// @ts-check
// scan-finding/1 on the Forge side (dowser-proposal/2): a pushed record's score, band, mvp and pretriaged_by reach the
// sortable columns (v019-v022) and the card; the inbox orders a push group MVP first, ranked before reserve, by the
// stored score with unscored cards last (never recomputed); the pre-triaged filter; a /1 record still files; the
// issue an accept creates opens with the facts table; dowser_reflect_sync stores the skill's trust for reflect.data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ME, makeDeps, pushArgs, record } from './helpers.mjs';
import { runResolver, runTool } from '../src/core/app.mjs';
import { factsTable } from '../src/core/adf.mjs';
import { FACT_MAX, factsOf } from '../src/shared/model.mjs';

const PK = 'github-com-Acme-Shop';
/** @param {any} d @param {string} name @param {Record<string, unknown>} args */
const tool = (d, name, args) => /** @type {Promise<any>} */ (runTool(d, name, args, ME));
/** @param {any} d @param {string} key @param {Record<string, unknown>} p */
const res = (d, key, p) => /** @type {Promise<any>} */ (runResolver(d, key, p, ME, 'inbox'));

const PARTS = (/** @type {number} */ impact) => ({ impact, confidence_w: 0.75, effort_div: 1.111, risk_factor: 0.95, formula: 'scan-score/1' });
/**
 * A /2 record as the skill's outbox sends it.
 * @param {string} topic @param {Record<string, unknown>} [over]
 */
const scored = (topic, over = {}) => ({
  ...record({ topic, anchors: [`src/${topic.replace(/ /g, '-')}.js`] }),
  category: 'product', impact: 6, impact_why: 'Asked for in 12 tickets', risk: 2, effort: { size: 'S', basis: ['one module'], score: 2 },
  score: 38.5, score_parts: PARTS(6), band: 'ranked', predicted_verdict: 'accept', predicted_why: 'no recorded decision on similar work',
  predicted_by: 'dowser-opportunity@0.3.0:m', ...over,
});

/** @param {any} n @returns {string} */
const txt = (n) => (n.type === 'text' ? n.text : (n.content ?? []).map(txt).join(''));

test('factsOf: impact, score with its breakdown, confidence, effort, risk, lens/kind, MVP - only the rows a card has', () => {
  const card = { ...scored('csv export', { mvp: true }), confidence_why: 'two sources agree', effort: { size: 'S', days_low: 1, days_high: 2, score: 2 } };
  assert.deepEqual(factsOf(card, { opportunity: 'Opportunity' }), [
    { label: 'Impact', value: '6/10 - Asked for in 12 tickets' },
    { label: 'Score', value: '38.5 = 10 x impact 6 x confidence 0.75 / effort 1.111 x risk 0.95 (scan-score/1)' },
    { label: 'Confidence', value: 'Medium - two sources agree' },
    { label: 'Effort', value: '2/10 (S, 1-2 days)' },
    { label: 'Risk', value: '2/10 (blast low)' },
    { label: 'Lens / kind', value: 'Opportunity / missing-capability' },
    { label: 'MVP', value: 'MVP of the Opportunity lens' },
  ]);
  const old = factsOf(record());
  assert.deepEqual(old.map((r) => r.label), ['Score', 'Confidence', 'Effort', 'Risk', 'Lens / kind'], 'a /1 card: no impact, no MVP');
  assert.equal(old[0].value, 'unscored (no impact or effort judged)', 'unscored is said, never 0');
  assert.equal(old[3].value, 'blast low');
  const long = factsOf({ ...card, impact_why: 'x'.repeat(5000) });
  assert.equal(long[0].value.length, FACT_MAX, 'each value is clipped: the table stays inside the description cap');
});

test('push: /2 fields reach the columns and the card; the group orders MVP, ranked by score, unscored, reserve', async () => {
  const d = makeDeps();
  const recs = [
    scored('low ranked', { score: 12.3 }),
    scored('reserve high', { score: 90, band: 'reserve' }),
    { ...record({ topic: 'no score', anchors: ['src/n.js'] }), band: 'ranked' },
    scored('mvp opp', { score: 20, mvp: true, mvp_rule: 'top-score' }),
    scored('high ranked', { score: 55.1, pretriaged_by: 'machine:dowser' }),
  ];
  const pushed = await tool(d, 'dowser_proposals_push', pushArgs(recs));
  assert.deepEqual(pushed.results.map((/** @type {any} */ r) => r.result), ['created', 'created', 'created', 'created', 'created'], JSON.stringify(pushed));
  const cols = d.db.raw.prepare('SELECT title, score, band, mvp, pretriaged_by FROM proposals ORDER BY id').all().map((r) => ({ ...r }));
  assert.deepEqual(cols.map((r) => [r.score, r.band, r.mvp, r.pretriaged_by]), [
    [12.3, 'ranked', null, null], [90, 'reserve', null, null], [null, 'ranked', null, null], [20, 'ranked', 1, null], [55.1, 'ranked', null, 'machine:dowser'],
  ], 'absent is NULL, never 0');
  const inbox = await res(d, 'inbox.list', { project_key: PK });
  const items = inbox.groups[0].items;
  assert.deepEqual(items.map((/** @type {any} */ c) => c.title), ['Add mvp opp', 'Add high ranked', 'Add low ranked', 'Add no score', 'Add reserve high'],
    'MVP pinned, then ranked by the stored score, unscored after every scored card, reserve last whatever its score');
  const top = items[0];
  assert.deepEqual([top.mvp, top.score, top.score_parts.formula, top.impact_why, top.predicted_verdict, top.category], [true, 20, 'scan-score/1', 'Asked for in 12 tickets', 'accept', 'product']);
  assert.equal(items[3].score, undefined, 'an unscored card carries no score key');
  const pre = await res(d, 'inbox.list', { project_key: PK, pretriaged: true });
  assert.deepEqual(pre.groups.flatMap((/** @type {any} */ g) => g.items).map((/** @type {any} */ c) => [c.title, c.pretriaged_by]), [['Add high ranked', 'machine:dowser']]);
  assert.equal((await res(d, 'inbox.list', { project_key: PK, pretriaged: 'yes' })).error, 'bad-input');

  // a re-push refreshes the columns from the newer record
  await tool(d, 'dowser_proposals_push', pushArgs([{ ...recs[1], band: 'ranked', score: 91, status: 'pushed' }], { run_id: 'r-1' }));
  assert.deepEqual({ ...d.db.raw.prepare("SELECT score, band FROM proposals WHERE title = 'Add reserve high'").get() }, { score: 91, band: 'ranked' });
});

test('push: a malformed store-computed field is refused with the field named; a /1 record still files', async () => {
  const d = makeDeps();
  const bad = [
    scored('zero score', { score: 0 }), scored('mvp false', { mvp: false }), scored('band x', { band: 'top' }),
    scored('parts alone', { score: undefined }), scored('override', { mvp: true, mvp_rule: 'override' }),
    scored('impact no why', { impact_why: undefined }), scored('verdict', { predicted_verdict: 'maybe' }),
  ];
  const out = await tool(d, 'dowser_proposals_push', pushArgs([...bad, record({ topic: 'old record', anchors: ['src/o.js'] })]));
  assert.deepEqual(out.results.map((/** @type {any} */ r) => r.result), [...bad.map(() => 'refused'), 'created']);
  assert.deepEqual(out.results.slice(0, bad.length).map((/** @type {any} */ r) => /invalid record: ([a-z_]+)/.exec(r.why)?.[1]),
    ['score', 'mvp', 'band', 'score_parts', 'mvp_why', 'impact_why', 'predicted_verdict']);
});

test('accept: the created issue opens with the facts table, then the rationale', async () => {
  const d = makeDeps();
  await tool(d, 'dowser_proposals_push', pushArgs([scored('csv export', { mvp: true })]));
  await res(d, 'settings.set', { project_key: PK, jira_project_key: 'SHOP', issue_type_id: '10001' });
  const acc = await res(d, 'verdict.accept', { ref: 'DW-1' });
  assert.equal(acc.error, undefined, JSON.stringify(acc));
  const content = d.jira.created[0].description.content;
  assert.equal(content[0].type, 'table');
  assert.deepEqual(content[0], factsTable(acc.card));
  const rows = content[0].content.map((/** @type {any} */ r) => r.content.map(txt));
  assert.deepEqual(rows[0], ['Fact', 'Value']);
  assert.deepEqual(rows.map((/** @type {string[]} */ r) => r[0]).slice(1), ['Impact', 'Score', 'Confidence', 'Effort', 'Risk', 'Lens / kind', 'MVP']);
  assert.equal(rows.at(-1)[1], 'MVP of the Opportunity lens');
  assert.equal(txt(content[1]), 'Customers keep asking for csv export.', 'the rationale follows the table');
});

test('dowser_reflect_sync stores trust_json whole; reflect.data shows it; a bad one is refused; omitted keeps the last', async () => {
  const d = makeDeps();
  await tool(d, 'dowser_proposals_push', pushArgs([record()]));
  const rd0 = await res(d, 'reflect.data', { project_key: PK });
  assert.equal(rd0.trust, undefined, 'omitted until the skill sends one');
  const trust = {
    slices: [{ slice: 'technical|doc-drift|-|S', level: 1, ceiling: 1, start: 0, n: 20, agreement: 1, changed_at: '2026-10-27T09:00:00.000Z', reason: 'earned: 100 %' }],
    events: [{ slice: 'technical|doc-drift|-|S', from: 0, to: 1, reason: 'earned: 100 %', agreement: 1, n: 20, item_id: 'a'.repeat(16), at: '2026-10-27T09:00:00.000Z' }],
  };
  assert.deepEqual(await tool(d, 'dowser_reflect_sync', { project_key: PK, trust_json: JSON.stringify(trust) }), { rules: [], outcomes: [] });
  const rd1 = await res(d, 'reflect.data', { project_key: PK });
  assert.deepEqual(rd1.trust, { ...trust, updated_at: '2026-10-27T10:00:00.000Z' });
  await tool(d, 'dowser_reflect_sync', { project_key: PK });
  assert.deepEqual((await res(d, 'reflect.data', { project_key: PK })).trust.slices, trust.slices, 'a sync without trust_json leaves it');
  for (const badTrust of ['{', '[]', JSON.stringify({ slices: [{ slice: 'x', level: 9, ceiling: 1, start: 0, n: 1 }], events: [] }),
    JSON.stringify({ slices: [], events: [{ ...trust.events[0], item_id: 'DW-1' }] }), JSON.stringify({ slices: Array.from({ length: 201 }, () => trust.slices[0]), events: [] })]) {
    assert.equal((await tool(d, 'dowser_reflect_sync', { project_key: PK, trust_json: badTrust })).error, 'bad-input', badTrust.slice(0, 40));
  }
  assert.equal((await tool(d, 'dowser_reflect_sync', { project_key: PK, trust_json: { slices: [] } })).error, 'bad-input', 'a JSON string, not an object');
});
