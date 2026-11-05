// @ts-check
// The store is set-based (card forge-backend-A): a push of 50 cards and an inbox page each cost tens of Forge SQL
// statements, not hundreds (every statement is its own HTTP request at 30-60 ms, ports.mjs), with the same rows,
// the same answers and the same concurrency guarantees as the per-row path: CAS counters, UNIQUE fps, and a
// multi-row INSERT that hits a duplicate retried row by row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ME, countingDb, makeDeps, pushArgs, record } from './helpers.mjs';
import { runResolver, runTool } from '../src/core/app.mjs';
import { pushProposals } from '../src/core/push.mjs';
import { cardOf } from '../src/core/cards.mjs';
import { loadSample } from '../src/core/sample.mjs';
import * as store from '../src/core/store.mjs';
import { evidenceKey } from '../src/shared/fingerprint.mjs';
import { sha256 } from '../src/core/util.mjs';

const PK = 'github-com-Acme-Shop';
const URL = (/** @type {string} */ ref) => `https://acme.atlassian.net/jira/apps/app/env/inbox?ref=${ref}`;

/** @param {any} d @param {string} name @param {object} args */
const tool = (d, name, args) => /** @type {Promise<any>} */ (runTool(d, name, args, ME));
/** @param {any} d @param {string} key @param {object} p */
const res = (d, key, p) => /** @type {Promise<any>} */ (runResolver(d, key, p, ME, 'inbox'));

/** Deps whose Db counts statements. */
function counted() {
  const d = makeDeps();
  const db = countingDb(d.db);
  return Object.assign(d, { db });
}

/**
 * `n` valid records, record i with `ev` code evidence items (quotes of `quoteLen` chars when given).
 * @param {number} n @param {number} [ev] @param {{quoteLen?: number, tag?: string}} [o]
 */
function records(n, ev = 3, o = {}) {
  const tag = o.tag ?? 't';
  return Array.from({ length: n }, (_, i) => record({
    topic: `${tag} topic ${i}`, anchors: [`src/${tag}${i}.js#f${i}`],
    evidence: Array.from({ length: ev }, (_, j) => ({
      type: 'code', ref: `src/${tag}${i}.js:${j + 1}`,
      quote: o.quoteLen ? `${i}:${j}:`.padEnd(o.quoteLen, 'q') : `export const line${j} = ${i};`,
    })),
  }));
}

/** Every evidence row as stored, by proposal then position. @param {any} d */
const evidenceRows = (d) => d.db.raw.prepare('SELECT * FROM evidence ORDER BY proposal_id, pos').all().map((/** @type {any} */ r) => ({ ...r }));

/** The evidence rows the per-row path writes for `recs` filed as DW-1.. in order. */
function expectedEvidence(/** @type {any[]} */ recs, /** @type {{runId: string, headSha: string, at: string}} */ o) {
  return recs.flatMap((rec, i) => rec.evidence.map((/** @type {any} */ e, /** @type {number} */ pos) => {
    const ekey = evidenceKey(e).key;
    return {
      proposal_id: i + 1, ekey_hash: sha256(`${e.type}\n${ekey}`), ekey, type: e.type, ref: e.ref, quote: e.quote ?? null,
      url: e.url ?? null, head_sha: o.headSha, added_run_id: o.runId, added_at: o.at, pos,
    };
  }));
}

test('a push of 50 new records x 3 evidence: at most 40 statements, the same answers and rows as the per-row path', async () => {
  const d = counted();
  const recs = records(50);
  const out = await tool(d, 'dowser_proposals_push', pushArgs(recs));
  const n = d.db.count();
  assert.ok(n <= 40, `${n} statements`);
  assert.deepEqual(out.results, recs.map((r, i) => ({ fp: r.fp, result: 'created', external_ref: `DW-${i + 1}`, external_url: URL(`DW-${i + 1}`) })));
  assert.deepEqual(evidenceRows(d), expectedEvidence(recs, { runId: 'r-1', headSha: 'abc123', at: d.now().toISOString() }));
  const props = d.db.raw.prepare('SELECT id, ref, fp, status, evidence_count, evidence_types, change_kind, first_run_id, last_run_id FROM proposals ORDER BY id').all();
  assert.deepEqual(props.map((r) => ({ ...r })), recs.map((r, i) => ({
    id: i + 1, ref: `DW-${i + 1}`, fp: r.fp, status: 'open', evidence_count: 3, evidence_types: 'code', change_kind: 'new', first_run_id: 'r-1', last_run_id: 'r-1',
  })));
});

test('a re-push of the same 50 records unchanged: all updated, no evidence added, at most 25 statements', async () => {
  const d = counted();
  const recs = records(50);
  await tool(d, 'dowser_proposals_push', pushArgs(recs));
  const before = d.db.raw.prepare('SELECT * FROM proposals ORDER BY id').all().map((r) => ({ ...r }));
  const evBefore = evidenceRows(d);
  d.clock.tick(60_000);
  d.db.reset();
  const out = await tool(d, 'dowser_proposals_push', pushArgs(recs, { run_id: 'r-2' }));
  const n = d.db.count();
  assert.ok(n <= 25, `${n} statements`);
  assert.deepEqual(out.results, recs.map((r, i) => ({ fp: r.fp, result: 'updated', external_ref: `DW-${i + 1}`, external_url: URL(`DW-${i + 1}`) })));
  assert.deepEqual(evidenceRows(d), evBefore, 'no evidence row added or changed');
  assert.deepEqual(d.db.raw.prepare('SELECT * FROM proposals ORDER BY id').all().map((r) => ({ ...r })), before, 'no proposal row changed');
});

test('GUARD: a re-push that grows one card and retitles another updates exactly those, as the per-row path does', async () => {
  const d = counted();
  const recs = records(5);
  await tool(d, 'dowser_proposals_push', pushArgs(recs));
  d.clock.tick(60_000);
  const next = recs.map((r) => structuredClone(r));
  next[1].evidence.push({ type: 'ticket', ref: 'SHOP-9', url: 'https://acme.atlassian.net/browse/SHOP-9' });
  next[3].title = 'Add a better export';
  await tool(d, 'dowser_proposals_push', pushArgs(next, { run_id: 'r-2', head_sha: 'def456' }));
  const rows = /** @type {any[]} */ (d.db.raw.prepare('SELECT id, title, evidence_count, evidence_types, last_run_id, change_kind FROM proposals ORDER BY id').all());
  assert.deepEqual(rows.map((r) => [r.id, r.evidence_count, r.evidence_types, r.last_run_id, r.change_kind]), [
    [1, 3, 'code', 'r-1', 'new'], [2, 4, 'code,ticket', 'r-2', 'grew'], [3, 3, 'code', 'r-1', 'new'], [4, 3, 'code', 'r-1', 'new'], [5, 3, 'code', 'r-1', 'new'],
  ]);
  assert.equal(rows[3].title, 'Add a better export');
  const added = /** @type {any[]} */ (d.db.raw.prepare("SELECT * FROM evidence WHERE type = 'ticket'").all());
  assert.deepEqual(added.map((r) => [r.proposal_id, r.pos, r.added_run_id, r.head_sha]), [[2, 3, 'r-2', 'def456']]);
});

test('GUARD: one fp twice in one push answers created then updated; a key twice in one record lands once, at its first position', async () => {
  const d = counted();
  const [a, b] = records(2);
  a.evidence.push({ ...a.evidence[0] });
  const a2 = structuredClone(a);
  a2.evidence.push({ type: 'ticket', ref: 'SHOP-1', url: 'https://acme.atlassian.net/browse/SHOP-1' });
  const out = await tool(d, 'dowser_proposals_push', pushArgs([a, b, a2]));
  assert.deepEqual(out.results.map((/** @type {any} */ r) => [r.result, r.external_ref]), [['created', 'DW-1'], ['created', 'DW-2'], ['updated', 'DW-1']]);
  const ev = /** @type {any[]} */ (d.db.raw.prepare('SELECT proposal_id, type, pos FROM evidence ORDER BY proposal_id, pos').all());
  assert.deepEqual(ev.map((r) => [r.proposal_id, r.type, r.pos]), [[1, 'code', 0], [1, 'code', 1], [1, 'code', 2], [1, 'ticket', 4], [2, 'code', 0], [2, 'code', 1], [2, 'code', 2]]);
  assert.deepEqual({ ...d.db.raw.prepare('SELECT evidence_count, evidence_types FROM proposals WHERE id = 1').get() }, { evidence_count: 4, evidence_types: 'code,ticket' });
});

test('an fp a concurrent push files between the batch read and the batch insert: the chunk falls back row by row', async () => {
  const d = counted();
  const recs = records(50);
  const rival = structuredClone(recs[5]);
  rival.evidence = [{ type: 'ticket', ref: 'SHOP-5', url: 'https://acme.atlassian.net/browse/SHOP-5' }];
  /** @type {string | undefined} */
  let rivalRef;
  d.db.before = async (s) => {
    if (!/^\s*INSERT INTO proposals/.test(s.sql)) return;
    d.db.before = undefined;
    const inner = { ...d, db: d.db.inner };
    rivalRef = (await pushProposals(inner, pushArgs([rival], { run_id: 'r-rival' }), ME)).results[0].external_ref;
  };
  const out = await tool(d, 'dowser_proposals_push', pushArgs(recs));
  assert.ok(rivalRef);
  assert.ok(d.db.statements.some((s) => /^\s*INSERT INTO proposals/.test(s.sql) && (s.sql.match(/\), \(/g) ?? []).length > 0), 'a multi-row INSERT was tried');
  assert.deepEqual(out.results.map((/** @type {any} */ r) => r.result), recs.map((_, i) => (i === 5 ? 'updated' : 'created')));
  assert.equal(out.results[5].external_ref, rivalRef);
  assert.equal(d.db.raw.prepare('SELECT COUNT(*) AS n FROM proposals').get()?.n, 50, 'no second proposal for the fp');
  const refs = /** @type {any[]} */ (d.db.raw.prepare('SELECT ref FROM proposals').all()).map((r) => r.ref);
  assert.equal(new Set(refs).size, 50);
  const ev5 = /** @type {any[]} */ (d.db.raw.prepare('SELECT e.type, e.ref FROM evidence e JOIN proposals p ON p.id = e.proposal_id WHERE p.fp = ? ORDER BY e.type, e.ref').all(recs[5].fp));
  assert.deepEqual(ev5.map((r) => r.ref), [...recs[5].evidence.map((e) => e.ref), 'SHOP-5'], 'both pushes\' evidence is kept');
  assert.equal(d.db.raw.prepare('SELECT COUNT(*) AS n FROM evidence').get()?.n, 50 * 3 + 1, 'no evidence lost');
});

test('block counter allocation: two interleaved nextCounterBlock calls get disjoint ranges', async () => {
  assert.equal(typeof store.nextCounterBlock, 'function', 'store.mjs exports nextCounterBlock');
  const d = counted();
  await store.nextCounter(d.db, 'ref'); // the counter row exists: value 1
  /** @type {Promise<number> | undefined} */
  let other;
  d.db.before = async (s) => {
    if (!/^SELECT value FROM counters/.test(s.sql) || other) return;
    // A read of the counter by the first caller; a second caller reads the same value and wins the CAS first.
    const inner = d.db.inner;
    other = store.nextCounterBlock(inner, 'ref', 50);
    await other;
  };
  const first = await store.nextCounterBlock(d.db, 'ref', 50);
  const second = await /** @type {Promise<number>} */ (other);
  const range = (/** @type {number} */ s) => Array.from({ length: 50 }, (_, i) => s + i);
  const all = [...range(first), ...range(second)];
  assert.equal(new Set(all).size, 100, `disjoint: ${first} and ${second}`);
  assert.ok(all.every((v) => v > 1), 'never the value already issued');
  assert.equal(await store.counterValue(d.db, 'ref'), Math.max(first, second) + 49);
});

test('two pushes interleaved on one store: no DW number twice, one proposal per fp', async () => {
  const d = makeDeps();
  const [a, b] = [records(30, 2, { tag: 'a' }), records(30, 2, { tag: 'b' })];
  const [oa, ob] = await Promise.all([
    pushProposals(d, pushArgs(a, { run_id: 'r-a' }), ME), pushProposals(d, pushArgs(b, { run_id: 'r-b' }), ME),
  ]);
  const refs = [...oa.results, ...ob.results].map((r) => r.external_ref);
  assert.equal(new Set(refs).size, 60);
  assert.ok([...oa.results, ...ob.results].every((r) => r.result === 'created'));

  // the same records pushed twice at once: each fp is filed once, the other push answers updated
  const same = records(20, 2, { tag: 's' });
  const [s1, s2] = await Promise.all([pushProposals(d, pushArgs(same, { run_id: 'r-s1' }), ME), pushProposals(d, pushArgs(same, { run_id: 'r-s2' }), ME)]);
  for (const [i, r] of same.entries()) {
    assert.deepEqual([s1.results[i].result, s2.results[i].result].sort(), ['created', 'updated'], `fp ${i}`);
    assert.equal(s1.results[i].external_ref, s2.results[i].external_ref);
  }
  assert.equal(d.db.raw.prepare('SELECT COUNT(*) AS n FROM proposals').get()?.n, 80);
  assert.equal(d.db.raw.prepare('SELECT COUNT(*) AS n FROM evidence').get()?.n, 80 * 2);
});

test('evidence over the per-statement byte or parameter cap is split into several multi-row INSERTs, each under both', async () => {
  const bytesMax = store.STATEMENT_BYTES_MAX;
  const paramsMax = store.STATEMENT_PARAMS_MAX;
  assert.equal(typeof bytesMax, 'number', 'store.mjs exports STATEMENT_BYTES_MAX');
  assert.equal(typeof paramsMax, 'number', 'store.mjs exports STATEMENT_PARAMS_MAX');
  const d = counted();
  const recs = records(20, 30, { quoteLen: 1900 }); // 600 rows: ~1.1 MB of quotes, 6600 parameters
  const out = await tool(d, 'dowser_proposals_push', pushArgs(recs));
  assert.ok(out.results.every((/** @type {any} */ r) => r.result === 'created'), JSON.stringify(out).slice(0, 300));
  const inserts = d.db.statements.filter((s) => /^\s*INSERT INTO evidence/.test(s.sql));
  assert.ok(inserts.length > 1 && inserts.length < 600, `${inserts.length} evidence INSERTs`);
  for (const s of inserts) {
    const bytes = Buffer.byteLength(s.sql, 'utf8') + s.params.reduce((/** @type {number} */ n, p) => n + (typeof p === 'string' ? Buffer.byteLength(p, 'utf8') : 8), 0);
    assert.ok(bytes <= /** @type {number} */ (bytesMax), `${bytes} bytes`);
    assert.ok(s.params.length <= /** @type {number} */ (paramsMax), `${s.params.length} parameters`);
  }
  assert.ok(/** @type {number} */ (bytesMax) * 2 <= 1024 * 1024, 'the cap leaves room under Forge SQL\'s 1 MiB request for JSON escaping');
  assert.deepEqual(evidenceRows(d), expectedEvidence(recs, { runId: 'r-1', headSha: 'abc123', at: d.now().toISOString() }));
});

/** The page the per-row read builds: each item as cardOf reads it alone, plus its change kind. */
async function referenceItems(/** @type {any} */ d, /** @type {any[]} */ items) {
  const out = [];
  for (const c of items) {
    const p = await store.findProposal(d.db.inner ?? d.db, c.ref);
    const card = /** @type {any} */ (await cardOf(d.db.inner ?? d.db, p));
    if (p.status === 'open') card.change = p.change_kind;
    out.push(card);
  }
  return out;
}

test('inbox.list of a page of 50 open cards: at most 10 statements, the same page as the per-row read', async () => {
  const d = counted();
  await tool(d, 'dowser_proposals_push', pushArgs(records(30, 3, { tag: 'x' }), { run_id: 'r-1', head_sha: 'aaa111' }));
  d.clock.tick(60_000);
  await tool(d, 'dowser_proposals_push', pushArgs(records(30, 3, { tag: 'y' }), { run_id: 'r-2', head_sha: 'bbb222' }));
  d.db.reset();
  const out = await res(d, 'inbox.list', { project_key: PK });
  const n = d.db.count();
  assert.ok(n <= 10, `${n} statements`);
  const items = out.groups.flatMap((/** @type {any} */ g) => g.items);
  assert.equal(items.length, 50);
  assert.equal(out.next, '50');
  assert.deepEqual(out.groups.map((/** @type {any} */ g) => [g.run_id, g.head_sha, g.items.length]), [['r-2', 'bbb222', 30], ['r-1', 'aaa111', 20]]);
  assert.deepEqual(items, await referenceItems(d, items));
  assert.ok(items[0].evidence[0].link.startsWith('https://github.com/Acme/Shop/blob/bbb222/'), 'code links at the push head');

  d.db.reset();
  const all = await res(d, 'inbox.list', {}); // all inboxes: the scope and the summaries read the inbox rows too
  assert.ok(d.db.count() <= 10, `${d.db.count()} statements`);
  assert.deepEqual(all.groups, out.groups);
});

test('inbox.list with area over an inbox of 200 proposals: at most 10 statements, the same items in the same order', async () => {
  const d = counted();
  for (let k = 0; k < 4; k++) {
    const recs = Array.from({ length: 50 }, (_, i) => record({
      topic: `area topic ${k} ${i}`, anchors: [`src/${i % 2 ? 'checkout' : 'other'}/m${k}${i}.js#f`],
      evidence: [{ type: 'code', ref: `src/${i % 3 ? 'checkout' : 'misc'}/e${k}${i}.js:1`, quote: 'x()' }],
    }));
    await tool(d, 'dowser_proposals_push', pushArgs(recs, { run_id: `r-${k}` }));
    d.clock.tick(60_000);
  }
  await tool(d, 'dowser_areas_push', { project_key: PK, run_id: 'r-3', areas_json: JSON.stringify([
    { path: 'src', files: 400, churn_90d: 0 }, { path: 'src/checkout', files: 200, churn_90d: 2, authors_90d: 1 },
  ]) });
  d.db.reset();
  const out = await res(d, 'inbox.list', { project_key: PK, area: 'src/checkout' });
  const n = d.db.count();
  assert.ok(n <= 10, `${n} statements`);
  const items = out.groups.flatMap((/** @type {any} */ g) => g.items);
  assert.equal(items.length, 50);
  assert.deepEqual(items, await referenceItems(d, items));
  // in src/checkout: an anchor there (odd i) or an evidence ref there (i % 3 != 0); 41 of every 50
  const seen = items.map((/** @type {any} */ c) => c.ref);
  for (let page = out; page.next;) {
    page = await res(d, 'inbox.list', { project_key: PK, area: 'src/checkout', cursor: page.next });
    seen.push(...page.groups.flatMap((/** @type {any} */ g) => g.items.map((/** @type {any} */ c) => c.ref)));
  }
  assert.equal(seen.length, 4 * 41);
  assert.equal(new Set(seen).size, seen.length);
});

test('sample.load at 40 ms a statement completes in one call: the bundled self-scan, and a 50-card sample', async () => {
  const d = counted();
  d.db.before = () => { d.clock.tick(40); };
  const out = await loadSample(d, ME);
  assert.equal(out.more, undefined, `${d.db.count()} statements: ${JSON.stringify(out)}`);
  assert.ok(out.created > 0);

  const big = counted();
  big.db.before = () => { big.clock.tick(40); };
  const sample = {
    schema: 'dowser-sample/1',
    source: { repo_url: 'https://github.com/xkazm04/dowser', head_sha: 'abc123', scanned_at: '2026-11-01T10:00:00.000Z', run_id: 'r-big' },
    lens_kinds_json: JSON.stringify({ opportunity: ['missing-capability'] }),
    proposals: records(50),
    areas: [{ path: 'src', files: 50, churn_90d: 5, authors_90d: 1 }],
    trust_json: JSON.stringify({ slices: [{ slice: 'product|opportunity|low|S', level: 0, ceiling: 1, start: 0, n: 0 }], events: [] }),
  };
  const outBig = await loadSample(big, ME, sample);
  assert.deepEqual(outBig, { project_key: 'dowser-sample', created: 50 }, `${big.db.count()} statements`);
});

test('byline.forPage on a page nothing names: one statement and no Jira permission call, whatever the inbox count', async () => {
  const d = counted();
  for (let i = 0; i < 20; i++) {
    const pk = `github-com-Acme-R${i}`;
    await tool(d, 'dowser_proposals_push', pushArgs([record({ topic: `t${i}`, doc_impact: i === 7 ? ['4242'] : undefined })], { project_key: pk }));
    await res(d, 'settings.set', { project_key: pk, jira_project_key: `P${i}`, issue_type_id: '10001' });
  }
  d.db.reset();
  d.perms.calls.length = 0;
  assert.deepEqual(await res(d, 'byline.forPage', { page_id: '999' }), { count: 0, cards: [] });
  assert.equal(d.db.count(), 1, 'one indexed read of page_links');
  assert.equal(d.perms.calls.length, 0, 'no permission asked');

  d.db.reset();
  d.perms.calls.length = 0;
  const hit = await res(d, 'byline.forPage', { page_id: '4242' });
  assert.deepEqual(hit.cards.map((/** @type {any} */ c) => c.project_key), ['github-com-Acme-R7']);
  assert.deepEqual(d.perms.calls.map((c) => c.on?.projectKey), ['P7'], 'only the inbox the page names is checked');
  assert.ok(d.db.count() <= 6, `${d.db.count()} statements`);
});

test('inbox summaries cost the same few statements for 1 or 20 inboxes, and keep the newest push of each', async () => {
  const d = counted();
  /** @param {number} n */
  const cost = async (n) => {
    for (let i = 0; i < n; i++) {
      const pk = `github-com-Acme-S${i}`;
      if (await store.getInbox(d.db.inner, pk)) continue;
      await tool(d, 'dowser_proposals_push', pushArgs([record({ topic: `s${i}` })], { project_key: pk, run_id: 'r-1', head_sha: 'old' }));
      d.clock.tick(1000);
      await tool(d, 'dowser_proposals_push', pushArgs([record({ topic: `s${i}` }), record({ topic: `s${i} more` })], { project_key: pk, run_id: 'r-2', head_sha: 'new' }));
    }
    d.db.reset();
    const out = await res(d, 'settings.get', {});
    return { n: d.db.count(), out };
  };
  const one = await cost(1);
  const twenty = await cost(20);
  assert.equal(twenty.n, one.n, `${one.n} statements for 1 inbox, ${twenty.n} for 20`);
  assert.ok(twenty.n <= 4, `${twenty.n} statements`);
  assert.equal(twenty.out.inboxes.length, 20);
  for (const i of twenty.out.inboxes) {
    assert.deepEqual([i.last_push.run_id, i.last_push.head_sha, i.open], ['r-2', 'new', 2], i.project_key);
  }
});

test('a bulk reject of 50 refs is about a dozen statements, logs 50 verdicts in order, and answers the same cards', async () => {
  const d = counted();
  await tool(d, 'dowser_proposals_push', pushArgs(records(50, 2), { run_id: 'r-1' }));
  const refs = Array.from({ length: 50 }, (_, i) => `DW-${i + 1}`);
  d.clock.tick(1000);
  d.db.reset();
  const out = await res(d, 'verdict.reject', { refs, reason: 'already-known' });
  const n = d.db.count();
  assert.ok(n <= 14, `${n} statements for 50 refs`);
  assert.deepEqual(out.cards.map((/** @type {any} */ c) => [c.ref, c.status, c.reason]), refs.map((r) => [r, 'rejected', 'already-known']));
  const one = await res(d, 'proposal.get', { ref: 'DW-7' });
  assert.deepEqual(out.cards[6], one.card, 'the card answered is the card as read');
  const pull = await tool(d, 'dowser_verdicts_pull', { project_key: PK });
  assert.deepEqual(pull.verdicts.map((/** @type {any} */ v) => v.external_ref), refs);
  const row = d.db.raw.prepare("SELECT refs_at_status, types_at_status FROM proposals WHERE ref = 'DW-3'").get();
  assert.deepEqual({ ...row }, { refs_at_status: 2, types_at_status: 'code' }, 'the stamp keeps the evidence at decision time');
});

test('GUARD: an item decided by someone else between the check and the bulk update keeps their decision, and the answer says so', async () => {
  const d = counted();
  await tool(d, 'dowser_proposals_push', pushArgs(records(3, 1), { run_id: 'r-1' }));
  d.db.before = async (s) => {
    if (/^UPDATE proposals SET status/.test(s.sql)) {
      d.db.before = undefined;
      await d.db.inner.exec("UPDATE proposals SET status = 'snoozed', decided_by = 'forge:someone', decided_at = '2026-10-27T09:00:00.000Z' WHERE ref = 'DW-2'");
    }
  };
  const out = await res(d, 'verdict.reject', { refs: ['DW-1', 'DW-2', 'DW-3'], reason: 'already-known' });
  assert.equal(out.error, 'bad-input');
  assert.match(out.message, /DW-2 is snoozed, not open; reload it; already rejected: DW-1, DW-3/);
  const st = d.db.raw.prepare('SELECT ref, status, decided_by FROM proposals ORDER BY id').all().map((/** @type {any} */ r) => [r.ref, r.status, r.decided_by]);
  assert.deepEqual(st, [['DW-1', 'rejected', `forge:${ME}`], ['DW-2', 'snoozed', 'forge:someone'], ['DW-3', 'rejected', `forge:${ME}`]]);
});
