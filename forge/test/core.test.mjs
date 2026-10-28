// @ts-check
// The Forge backend core against in-memory ports (test/helpers.mjs): forge-mcp-2 tools, resolvers, Rovo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ME, makeDeps, pushArgs, record } from './helpers.mjs';
import { actionName, answer, isNoTable, runResolver, runRovo, runTool } from '../src/core/app.mjs';
import { GRACE_MS } from '../src/core/verdicts.mjs';
import { areaOf } from '../src/core/areas.mjs';
import { codeLink } from '../src/core/cards.mjs';
import { adfToText, htmlToText } from '../src/core/adf.mjs';

const PK = 'github-com-Acme-Shop';

/** @param {any} deps @param {string} name @param {object} args @param {string} [who] */
const tool = (deps, name, args, who = ME) => /** @type {Promise<any>} */ (runTool(deps, name, args, who));
/** @param {any} deps @param {string} key @param {object} p @param {string} [who] */
const res = (deps, key, p, who = ME) => /** @type {Promise<any>} */ (runResolver(deps, key, p, who, 'inbox'));
/** @param {any} deps */
const verdictRows = (deps) => deps.db.raw.prepare('SELECT * FROM verdicts ORDER BY seq').all();
/** @param {any} deps */
const proposalRows = (deps) => deps.db.raw.prepare('SELECT * FROM proposals ORDER BY id').all();

test('push is idempotent on (project_key, fp) across three pushes', async () => {
  const d = makeDeps();
  const r = record();
  const a = await tool(d, 'dowser_proposals_push', pushArgs([r], { run_id: 'r-1' }));
  assert.deepEqual(a.results, [{ fp: r.fp, result: 'created', external_ref: 'DW-1', external_url: 'https://acme.atlassian.net/jira/apps/app/env/inbox?ref=DW-1' }]);
  const b = await tool(d, 'dowser_proposals_push', pushArgs([{ ...r, status: 'pushed' }], { run_id: 'r-2' }));
  const c = await tool(d, 'dowser_proposals_push', pushArgs([{ ...r, status: 'pushed', external_ref: 'DW-1' }], { run_id: 'r-3' }));
  for (const x of [b, c]) assert.equal(x.results[0].result, 'updated');
  assert.equal(c.results[0].external_ref, 'DW-1');
  assert.equal(proposalRows(d).length, 1);
  assert.equal(d.db.raw.prepare('SELECT COUNT(*) AS n FROM pushes').get()?.n, 3);
});

test('evidence is a union by evidence key and never loses a row', async () => {
  const d = makeDeps();
  const e1 = { type: 'code', ref: 'src/reports/export.js:12', quote: 'export function exportReport() {' };
  const e2 = { type: 'ticket', ref: 'SUP-1', url: 'https://acme.atlassian.net/browse/SUP-1' };
  await tool(d, 'dowser_proposals_push', pushArgs([record({ evidence: [e1] })]));
  // the same quote on a shifted line is the same key; e2 is new; e1 missing from the push is kept
  await tool(d, 'dowser_proposals_push', pushArgs([record({ evidence: [{ ...e1, ref: 'src/reports/export.js:14' }, e2] })], { run_id: 'r-2' }));
  await tool(d, 'dowser_proposals_push', pushArgs([record({ evidence: [e2] })], { run_id: 'r-3' }));
  const { card } = await res(d, 'proposal.get', { ref: 'DW-1' });
  assert.deepEqual(card.evidence.map((/** @type {any} */ e) => e.ref), ['src/reports/export.js:12', 'SUP-1']);
  assert.equal(card.evidence[0].link, 'https://github.com/Acme/Shop/blob/abc123/src/reports/export.js#L12');
  assert.equal(card.evidence[1].link, 'https://acme.atlassian.net/browse/SUP-1');
});

test('a record whose fp does not match its identity, or that is invalid, is refused', async () => {
  const d = makeDeps();
  const good = record();
  const bad = { ...record({ topic: 'other thing' }), fp: good.fp.replace(/^./, (c) => (c === '0' ? '1' : '0')) };
  const out = await tool(d, 'dowser_proposals_push', pushArgs([bad, { ...good, title: '' }, { ...good, status: 'rejected' }, good]));
  assert.deepEqual(out.results.map((/** @type {any} */ r) => r.result), ['refused', 'refused', 'refused', 'created']);
  assert.match(out.results[0].why, /does not match its identity/);
  assert.match(out.results[1].why, /title/);
  assert.match(out.results[2].why, /status/);
  assert.equal(out.results[3].external_ref, 'DW-1');
});

test('push input errors: > 50 records, bad JSON, missing project_key', async () => {
  const d = makeDeps();
  const many = Array.from({ length: 51 }, (_, i) => record({ topic: `t ${i}` }));
  assert.deepEqual(Object.keys(await tool(d, 'dowser_proposals_push', pushArgs(many))), ['error', 'message']);
  assert.equal((await tool(d, 'dowser_proposals_push', pushArgs(many))).error, 'bad-input');
  assert.equal((await tool(d, 'dowser_proposals_push', { ...pushArgs([]), proposals_json: '[{' })).error, 'bad-input');
  assert.equal((await tool(d, 'dowser_proposals_push', { ...pushArgs([]), project_key: '' })).error, 'bad-input');
  assert.equal((await tool(d, 'dowser_proposals_push', { ...pushArgs([]), repo_url: 'https://u:p@github.com/a/b' })).error, 'bad-input');
});

test('every tool needs a signed-in account', async () => {
  const d = makeDeps();
  const out = await runTool(d, 'dowser_verdicts_pull', { project_key: PK }, undefined);
  assert.deepEqual(Object.keys(out), ['error', 'message']);
  assert.equal(/** @type {any} */ (out).error, 'unauthorized');
  assert.equal(/** @type {any} */ (await runResolver(d, 'settings.get', {}, '', 'inbox')).error, 'unauthorized');
});

test('a snoozed item reopens on any new evidence key, and only then', async () => {
  const d = makeDeps();
  const e1 = { type: 'code', ref: 'src/a.js:1', quote: 'a()' };
  await tool(d, 'dowser_proposals_push', pushArgs([record({ evidence: [e1] })]));
  await res(d, 'verdict.snooze', { refs: ['DW-1'] });
  await tool(d, 'dowser_proposals_push', pushArgs([record({ evidence: [e1] })], { run_id: 'r-2' }));
  assert.equal(proposalRows(d)[0].status, 'snoozed');
  await tool(d, 'dowser_proposals_push', pushArgs([record({ evidence: [e1, { type: 'code', ref: 'src/b.js:2', quote: 'b()' }] })], { run_id: 'r-3' }));
  const p = proposalRows(d)[0];
  assert.equal(p.status, 'open');
  assert.equal(p.reopened, 1);
  assert.equal(verdictRows(d).length, 1, 'a reopen writes no verdict');
  const page = await res(d, 'inbox.list', {});
  assert.equal(page.groups[0].run_id, 'r-3');
  assert.equal(page.groups[0].items[0].change, 'reopened');
  assert.equal(page.groups[0].items[0].reopened, true);
});

test('a rejected item reopens only on a new evidence type AND at least twice the evidence', async () => {
  const d = makeDeps();
  const c = (/** @type {number} */ i) => ({ type: 'code', ref: `src/f${i}.js:1`, quote: `f${i}()` });
  await tool(d, 'dowser_proposals_push', pushArgs([record({ evidence: [c(1), c(2)] })]));
  await res(d, 'verdict.reject', { refs: ['DW-1'], reason: 'not-worth-it' });
  // doubled, same type: stays rejected
  await tool(d, 'dowser_proposals_push', pushArgs([record({ evidence: [c(1), c(2), c(3), c(4)] })], { run_id: 'r-2' }));
  assert.equal(proposalRows(d)[0].status, 'rejected');
  // a new type without doubling stays rejected too
  const d2 = makeDeps();
  await tool(d2, 'dowser_proposals_push', pushArgs([record({ evidence: [c(1), c(2)] })]));
  await res(d2, 'verdict.reject', { refs: ['DW-1'], reason: 'false-positive' });
  await tool(d2, 'dowser_proposals_push', pushArgs([record({ evidence: [c(1), c(2), { type: 'ticket', ref: 'SUP-9' }] })], { run_id: 'r-2' }));
  assert.equal(proposalRows(d2)[0].status, 'rejected', 'new type but 3 < 2 x 2');
  await tool(d2, 'dowser_proposals_push', pushArgs([record({ evidence: [{ type: 'ticket', ref: 'SUP-10' }] })], { run_id: 'r-3' }));
  assert.equal(proposalRows(d2)[0].status, 'open', 'new type and 4 >= 2 x 2');
  // and the first item, now with a new type on top of the doubling
  await tool(d, 'dowser_proposals_push', pushArgs([record({ evidence: [{ type: 'page', ref: '123' }] })], { run_id: 'r-3' }));
  assert.equal(proposalRows(d)[0].status, 'open');
});

test('accepted and merged items only gain evidence; a merged fp answers merged-existing with the survivor', async () => {
  const d = makeDeps();
  const a = record({ topic: 'alpha' });
  const b = record({ topic: 'beta' });
  await tool(d, 'dowser_proposals_push', pushArgs([a, b]));
  await res(d, 'settings.set', { project_key: PK, jira_project_key: 'SHOP', issue_type_id: '10001' });
  await res(d, 'verdict.accept', { ref: 'DW-1' });
  await res(d, 'verdict.merge', { ref: 'DW-2', into: 'DW-1' });
  const more = (/** @type {any} */ r) => ({ ...r, status: 'pushed', evidence: [...r.evidence, { type: 'ticket', ref: 'SUP-77' }] });
  const out = await tool(d, 'dowser_proposals_push', pushArgs([more(a), more(b)], { run_id: 'r-2' }));
  assert.deepEqual(out.results.map((/** @type {any} */ r) => [r.result, r.external_ref]), [['updated', 'DW-1'], ['merged-existing', 'DW-1']]);
  const rows = proposalRows(d);
  assert.deepEqual(rows.map((/** @type {any} */ r) => [r.status, r.evidence_count]), [['accepted', 2], ['merged', 2]]);
});

test('accept with a failing Jira leaves the item open and writes no verdict', async () => {
  const d = makeDeps();
  await tool(d, 'dowser_proposals_push', pushArgs([record()]));
  await res(d, 'settings.set', { project_key: PK, jira_project_key: 'SHOP', issue_type_id: '10001' });
  d.jira.fail = true;
  const out = await res(d, 'verdict.accept', { ref: 'DW-1' });
  assert.equal(out.error, 'unavailable');
  assert.match(out.message, /DW-1 stays open/);
  assert.equal(proposalRows(d)[0].status, 'open');
  assert.equal(proposalRows(d)[0].accept_claim, null, 'the claim is released');
  assert.equal(verdictRows(d).length, 0);
  d.jira.fail = false;
  assert.equal((await res(d, 'verdict.accept', { ref: 'DW-1' })).card.status, 'accepted', 'a retry works');
});

test('accept creates the issue first, then records issue_ref/issue_url and an accepted verdict; a repeat is a no-op', async () => {
  const d = makeDeps();
  await tool(d, 'dowser_proposals_push', pushArgs([record()]));
  assert.equal((await res(d, 'verdict.accept', { ref: 'DW-1' })).error, 'bad-input', 'no target configured');
  const out = await res(d, 'verdict.accept', { ref: 'DW-1', jira_project_key: 'SHOP', issue_type_id: '10001' });
  assert.equal(out.card.issue_ref, 'SHOP-41');
  assert.equal(out.card.issue_url, 'https://acme.atlassian.net/browse/SHOP-41');
  const again = await res(d, 'verdict.accept', { ref: 'DW-1', jira_project_key: 'SHOP', issue_type_id: '10001' });
  assert.equal(again.card.issue_ref, 'SHOP-41');
  assert.equal(d.jira.created.length, 1);
  const pull = await tool(d, 'dowser_verdicts_pull', { project_key: PK });
  assert.deepEqual(pull.verdicts, [{
    fp: record().fp, status: 'accepted', decided_by: `forge:${ME}`, decided_at: '2026-10-27T10:00:00.000Z',
    external_ref: 'DW-1', issue_ref: 'SHOP-41', issue_url: 'https://acme.atlassian.net/browse/SHOP-41',
  }]);
  // the issue text: rationale, the five sections, the evidence list, then the closing line
  const text = adfToText(d.jira.created[0].description);
  const order = ['Customers keep asking', 'Summary', 'Description', 'Flow', 'Expected impact', 'Evaluation', 'Evidence', 'Proposed by Dowser (DW-1)'];
  let at = -1;
  for (const s of order) { const i = text.indexOf(s, at + 1); assert.ok(i > at, `${s} in order`); at = i; }
  assert.ok(text.trimEnd().endsWith('Proposed by Dowser (DW-1)'));
  assert.equal(d.jira.created[0].summary, 'Add csv export');
  const panel = await res(d, 'panel.forIssue', { issue_key: 'SHOP-41' });
  assert.equal(panel.card.ref, 'DW-1');
  assert.equal(panel.history.length, 1);
});

test('pull: oldest first, monotonic cursor, bad-cursor, unknown-project', async () => {
  const d = makeDeps();
  assert.equal((await tool(d, 'dowser_verdicts_pull', { project_key: PK })).error, 'unknown-project');
  await tool(d, 'dowser_proposals_push', pushArgs([record({ topic: 'a' }), record({ topic: 'b' }), record({ topic: 'c' })]));
  const first = await tool(d, 'dowser_verdicts_pull', { project_key: PK });
  assert.deepEqual(first, { verdicts: [], cursor: '0' });
  await res(d, 'verdict.reject', { refs: ['DW-2'], reason: 'other', note: 'tracked as SEC-12' });
  d.clock.tick();
  await res(d, 'verdict.snooze', { refs: ['DW-1'] });
  const p1 = await tool(d, 'dowser_verdicts_pull', { project_key: PK, cursor: first.cursor });
  assert.deepEqual(p1.verdicts.map((/** @type {any} */ v) => [v.external_ref, v.status]), [['DW-2', 'rejected'], ['DW-1', 'snoozed']]);
  assert.equal(p1.verdicts[0].reason, 'other');
  assert.equal(p1.verdicts[0].note, 'tracked as SEC-12');
  assert.equal(p1.verdicts[1].reason, undefined);
  assert.equal(p1.cursor, '2');
  d.clock.tick();
  await res(d, 'verdict.merge', { ref: 'DW-3', into: 'DW-1' });
  const p2 = await tool(d, 'dowser_verdicts_pull', { project_key: PK, cursor: p1.cursor });
  assert.deepEqual(p2.verdicts.map((/** @type {any} */ v) => [v.external_ref, v.status, v.merged_into]), [['DW-3', 'merged', record({ topic: 'a' }).fp]]);
  assert.equal(p2.cursor, '3');
  assert.deepEqual(await tool(d, 'dowser_verdicts_pull', { project_key: PK, cursor: p2.cursor }), { verdicts: [], cursor: p2.cursor });
  for (const bad of ['abc', '-1', '01', '1.5', '99']) {
    assert.equal((await tool(d, 'dowser_verdicts_pull', { project_key: PK, cursor: bad })).error, 'bad-cursor', bad);
  }
  // re-pulling from 0 returns the whole log again (re-ingesting is idempotent on the skill side)
  assert.equal((await tool(d, 'dowser_verdicts_pull', { project_key: PK, cursor: '0' })).verdicts.length, Number(p2.cursor));
});

test('a decision whose verdict row did not land is rebuilt before the pull', async () => {
  const d = makeDeps();
  await tool(d, 'dowser_proposals_push', pushArgs([record()]));
  d.db.failNext = /INSERT INTO verdicts/;
  const out = await res(d, 'verdict.snooze', { refs: ['DW-1'] });
  assert.equal(out.cards[0].status, 'snoozed');
  assert.equal(verdictRows(d).length, 0);
  assert.equal((await tool(d, 'dowser_verdicts_pull', { project_key: PK })).verdicts.length, 0, 'within the grace period');
  d.clock.tick(GRACE_MS + 1000);
  const pull = await tool(d, 'dowser_verdicts_pull', { project_key: PK });
  assert.deepEqual(pull.verdicts.map((/** @type {any} */ v) => v.status), ['snoozed']);
  assert.equal(pull.cursor, '2', 'the lost allocation (seq 1) is a gap the pull stepped over');
});

test('a young gap in the verdict log stops the page so a late row is never skipped', async () => {
  const d = makeDeps();
  await tool(d, 'dowser_proposals_push', pushArgs([record({ topic: 'a' }), record({ topic: 'b' })]));
  d.db.raw.prepare("INSERT INTO counters (name, value) VALUES (?, 1)").run(`seq:${PK}`); // seq 1 allocated, not written yet
  await res(d, 'verdict.snooze', { refs: ['DW-2'] }); // seq 2
  assert.deepEqual(await tool(d, 'dowser_verdicts_pull', { project_key: PK }), { verdicts: [], cursor: '0' });
  d.clock.tick(GRACE_MS + 1);
  assert.equal((await tool(d, 'dowser_verdicts_pull', { project_key: PK })).cursor, '2');
});

test('reject needs a closed reason, other needs a note; bulk decisions are checked up front', async () => {
  const d = makeDeps();
  await tool(d, 'dowser_proposals_push', pushArgs([record({ topic: 'a' }), record({ topic: 'b' })]));
  assert.equal((await res(d, 'verdict.reject', { refs: ['DW-1'], reason: 'meh' })).error, 'bad-input');
  assert.equal((await res(d, 'verdict.reject', { refs: ['DW-1'], reason: 'other' })).error, 'bad-input');
  assert.equal((await res(d, 'verdict.reject', { refs: ['DW-1', 'DW-9'], reason: 'wrong-size' })).error, 'bad-input');
  assert.equal(proposalRows(d)[0].status, 'open', 'nothing decided when one ref is bad');
  const out = await res(d, 'verdict.reject', { refs: ['DW-1', 'DW-2'], reason: 'already-known' });
  assert.deepEqual(out.cards.map((/** @type {any} */ c) => c.status), ['rejected', 'rejected']);
});

test('merge into a Jira key comments first; a failing Jira writes nothing', async () => {
  const d = makeDeps();
  await tool(d, 'dowser_proposals_push', pushArgs([record()]));
  d.jira.fail = true;
  assert.equal((await res(d, 'verdict.merge', { ref: 'DW-1', into: 'SHOP-7' })).error, 'unavailable');
  assert.equal(proposalRows(d)[0].status, 'open');
  d.jira.fail = false;
  const out = await res(d, 'verdict.merge', { ref: 'DW-1', into: 'SHOP-7' });
  assert.equal(out.card.merged_into, 'SHOP-7');
  assert.equal(d.jira.comments[0].issueKey, 'SHOP-7');
});

test('areas replace the project set; validation follows the contract table', async () => {
  const d = makeDeps();
  const areas = (/** @type {object[]} */ a) => ({ project_key: PK, run_id: 'r-1', areas_json: JSON.stringify(a) });
  assert.deepEqual(await tool(d, 'dowser_areas_push', areas([
    { path: 'src', files: 10, churn_90d: 4, authors_90d: 2, last_change: '2026-10-01T00:00:00.000Z' },
    { path: 'src/checkout', files: 3, churn_90d: 0 },
  ])), { stored: 2 });
  assert.deepEqual(await tool(d, 'dowser_areas_push', areas([{ path: 'docs', files: 1, churn_90d: 1, authors_90d: 1 }])), { stored: 1 });
  assert.deepEqual(d.db.raw.prepare('SELECT path FROM areas').all().map((r) => r.path), ['docs']);
  for (const bad of [
    [{ path: 'a/b/c', files: 1, churn_90d: 0 }], [{ path: 'src/', files: 1, churn_90d: 0 }], [{ path: 'src', files: 0, churn_90d: 0 }],
    [{ path: 'src', files: 1, churn_90d: 0, authors_90d: 0 }], [{ path: 'src', files: 1, churn_90d: 2 }], [{ path: 'src', files: 1, churn_90d: 0, x: 1 }],
  ]) assert.equal((await tool(d, 'dowser_areas_push', areas(bad))).error, 'bad-input', JSON.stringify(bad));
  assert.equal((await tool(d, 'dowser_areas_push', areas(Array.from({ length: 201 }, (_, i) => ({ path: `p${i}`, files: 1, churn_90d: 0 }))))).error, 'bad-input');
});

test('map.data assigns a proposal to the longest area prefix, once per area', async () => {
  assert.equal(areaOf('src/checkout/pay.js', ['src', 'src/checkout', 'src/check']), 'src/checkout');
  assert.equal(areaOf('srcx/a.js', ['src']), undefined);
  const d = makeDeps();
  await tool(d, 'dowser_proposals_push', pushArgs([
    record({ topic: 'pay', anchors: ['src/checkout/pay.js#pay'], evidence: [{ type: 'code', ref: 'src/checkout/pay.js:3', quote: 'pay()' }] }),
    record({ topic: 'docs', lens: 'doc-drift', kind: 'stale-doc', anchors: ['src/util.js'], evidence: [{ type: 'doc', ref: 'README.md:1', quote: 'x' }] }),
  ]));
  await tool(d, 'dowser_areas_push', { project_key: PK, run_id: 'r-1', areas_json: JSON.stringify([
    { path: 'src', files: 5, churn_90d: 0 }, { path: 'src/checkout', files: 2, churn_90d: 3, authors_90d: 1 },
  ]) });
  const m = await res(d, 'map.data', { project_key: PK });
  assert.deepEqual(m.areas.map((/** @type {any} */ a) => [a.path, a.proposals]), [
    ['src', [{ lens: 'doc-drift', open: 1, accepted: 0 }]],
    ['src/checkout', [{ lens: 'opportunity', open: 1, accepted: 0 }]],
  ]);
  assert.equal(m.areas[0].authors_90d, undefined, 'unmeasured stays omitted');
  assert.deepEqual(m.points[0], { ref: 'DW-1', lens: 'opportunity', effort: 'S', confidence: 'medium', blast: 'low' });
});

test('inbox.list groups by push (new / grew), policy order inside, last_push on every inbox', async () => {
  const d = makeDeps();
  await tool(d, 'dowser_proposals_push', pushArgs([record({ topic: 'low', confidence: 'low' }), record({ topic: 'high', confidence: 'high' })]));
  d.clock.tick();
  await tool(d, 'dowser_proposals_push', pushArgs([
    { ...record({ topic: 'low', confidence: 'low' }), status: 'pushed', evidence: [...record().evidence, { type: 'ticket', ref: 'SUP-1' }] },
    record({ topic: 'high', confidence: 'high' }),
  ], { run_id: 'r-2', head_sha: 'def456' }));
  const page = await res(d, 'inbox.list', {});
  assert.deepEqual(page.groups.map((/** @type {any} */ g) => [g.run_id, g.head_sha, g.items.map((/** @type {any} */ c) => [c.ref, c.change])]), [
    ['r-2', 'def456', [['DW-1', 'grew']]],
    ['r-1', 'abc123', [['DW-2', 'new']]],
  ]);
  assert.deepEqual(page.inboxes, [{ project_key: PK, repo_url: 'https://github.com/Acme/Shop', open: 2,
    last_push: { run_id: 'r-2', at: '2026-10-27T10:00:01.000Z', head_sha: 'def456', created: 0, updated: 2 } }]);
  const rejected = await res(d, 'inbox.list', { status: 'rejected' });
  assert.deepEqual(rejected.groups, []);
  assert.equal(rejected.inboxes[0].last_push.run_id, 'r-2', 'last_push regardless of the status filter');
  assert.equal((await res(d, 'inbox.list', { cursor: 'x' })).error, 'bad-cursor');
});

test('byline.forPage finds page evidence and doc_impact entries', async () => {
  const d = makeDeps();
  await tool(d, 'dowser_proposals_push', pushArgs([
    record({ topic: 'a', evidence: [{ type: 'page', ref: '98765', url: 'https://acme.atlassian.net/wiki/x' }] }),
    record({ topic: 'b', doc_impact: ['98765'] }),
    record({ topic: 'c', doc_impact: ['987650'] }),
  ]));
  const out = await res(d, 'byline.forPage', { page_id: '98765' });
  assert.equal(out.count, 2);
  assert.deepEqual(out.cards.map((/** @type {any} */ c) => c.ref), ['DW-1', 'DW-2']);
});

test('rovo: list, explain, and a verdict recorded as the chatting person via rovo', async () => {
  const d = makeDeps();
  await tool(d, 'dowser_proposals_push', pushArgs([record()]));
  const list = /** @type {any} */ (await runRovo(d, 'dowser_inbox_list', {}, 'someone'));
  assert.equal(list.items[0].ref, 'DW-1');
  const ex = /** @type {any} */ (await runRovo(d, 'dowser_proposal_explain', { ref: record().fp }, 'someone'));
  assert.equal(ex.card.ref, 'DW-1');
  const out = /** @type {any} */ (await runRovo(d, 'dowser_verdict_record', { ref: 'DW-1', status: 'rejected', reason: 'not-our-direction' }, '557058:chatter'));
  assert.equal(out.recorded, 'rejected');
  const v = verdictRows(d)[0];
  assert.equal(v.decided_by, 'forge:557058:chatter');
  assert.equal(v.via, 'rovo');
  assert.equal(/** @type {any} */ (await runRovo(d, 'dowser_verdict_record', { ref: 'DW-1', status: 'snoozed' }, undefined)).error, 'unauthorized');
});

test('the action key comes from the invocation, else from the argument shape', () => {
  assert.equal(actionName('mcp', [undefined, 'dowser_verdicts_pull'], { proposals_json: '[]' }), 'dowser_verdicts_pull');
  assert.equal(actionName('mcp', ['dowser-mcp'], { project_key: 'k', proposals_json: '[]' }), 'dowser_proposals_push');
  assert.equal(actionName('mcp', [], { project_key: 'k', areas_json: '[]' }), 'dowser_areas_push');
  assert.equal(actionName('mcp', [], { query: 'x', limit: 5 }), 'dowser_sources_tickets');
  assert.equal(actionName('mcp', [], { query: 'x' }), 'dowser_sources_pages');
  assert.equal(actionName('mcp', [], { project_key: 'k', cursor: '3' }), 'dowser_verdicts_pull');
  assert.equal(actionName('mcp', [], {}), 'dowser_sources_goals');
  assert.equal(actionName('rovo', [], { ref: 'DW-1', status: 'accepted' }), 'dowser_verdict_record');
  assert.equal(actionName('rovo', [], { ref: 'DW-1' }), 'dowser_proposal_explain');
  assert.equal(actionName('rovo', ['dowser_sources_goals'], {}), 'dowser_sources_goals');
});

test('sources: input checks and the JQL/CQL handed to the port', async () => {
  const d = makeDeps();
  /** @type {any[]} */
  const calls = [];
  d.sources = {
    tickets: async (q) => { calls.push(q); return [{ ref: 'SUP-1', title: 't', url: 'u', body: 'b', created_at: '2026-10-01T00:00:00.000Z' }]; },
    pages: async (q) => { calls.push(q); return []; },
    goals: async () => { throw new Error('403'); },
  };
  assert.equal((await tool(d, 'dowser_sources_tickets', { query: 'x' })).error, 'bad-input');
  const t = await tool(d, 'dowser_sources_tickets', { query: 'export OR "csv"', since: '2026-09-01T00:00:00Z', limit: 500 });
  assert.equal(t.items[0].ref, 'SUP-1');
  assert.deepEqual(calls[0], { jql: '(text ~ "export" OR text ~ "csv") AND created >= "2026-09-01 00:00" ORDER BY created DESC', limit: 50 });
  await tool(d, 'dowser_sources_pages', { query: 'export', space: 'ENG' });
  assert.equal(calls[1].cql, 'type = page AND (text ~ "export") AND space = "ENG" ORDER BY lastmodified DESC');
  assert.equal((await tool(d, 'dowser_sources_pages', { query: 'x', space: 'a" OR 1=1' })).error, 'bad-input');
  assert.equal((await tool(d, 'dowser_sources_goals', {})).error, 'unavailable');
});

test('code links follow F2: GitHub, Bitbucket, plain ref elsewhere', () => {
  assert.equal(codeLink('https://bitbucket.org/acme/shop', 's1', 'src/a b.js:7'), 'https://bitbucket.org/acme/shop/src/s1/src/a%20b.js#lines-7');
  assert.equal(codeLink('https://github.com/acme/shop.git', 's1', 'src/a.js'), 'https://github.com/acme/shop/blob/s1/src/a.js');
  assert.equal(codeLink('https://gitlab.com/acme/shop', 's1', 'src/a.js:1'), undefined);
  assert.equal(codeLink('https://github.com/acme/shop', undefined, 'src/a.js:1'), undefined);
});

test('ADF and HTML to plain text', () => {
  const adf = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }, { type: 'hardBreak' }, { type: 'text', text: 'world' }] }, { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] }] }] };
  assert.equal(adfToText(adf), 'Hello\nworld\none');
  assert.equal(htmlToText('<p>A &amp; B</p><p>C&#39;s<br/>D</p><script>x</script>'), "A & B\nC's\nD");
});

test('a missing table escapes answer() so the entry point migrates: node:sqlite and Forge SQL error shapes', async () => {
  // Forge SQL keeps the cause in context.debug; its message is generic.
  const forge = Object.assign(new Error('Unknown SQL execution error'), {
    code: 'SQL_EXECUTION_ERROR', context: { debug: { code: 'ER_NO_SUCH_TABLE', errno: 1146, message: "Table 'x.rules' doesn't exist" } },
  });
  assert.equal(isNoTable(forge), true);
  assert.equal(isNoTable(new Error('no such table: rules')), true);
  assert.equal(isNoTable(new Error('Unknown SQL execution error')), false);
  await assert.rejects(answer(async () => { throw forge; }), forge);
  assert.equal(/** @type {any} */ (await answer(async () => { throw new Error('boom'); })).error, 'unavailable');
});
