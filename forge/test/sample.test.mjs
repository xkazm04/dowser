// @ts-check
// The sample inbox and the setup checklist (core/sample.mjs) through the dispatch door: load (bundled self-scan,
// resumable, idempotent), the reserved key every MCP write refuses, remove (every table, creator or admin), the
// marked Jira issue an accept creates, and the tool-call record behind `setup.status`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MCP_URL, ME, makeDeps, pushArgs, record } from './helpers.mjs';
import { runResolver, runRovo, runTool } from '../src/core/app.mjs';
import { SAMPLE_CHUNK, SAMPLE_KEY, checkSample, loadSample } from '../src/core/sample.mjs';
import { pushProposals } from '../src/core/push.mjs';
import { pushAreas } from '../src/core/areas.mjs';
import { reflectSync } from '../src/core/reflect.mjs';
import { SAMPLE_NOTE } from '../src/core/adf.mjs';
import { SAMPLE_RESERVED } from '../src/core/types.mjs';
import { AppError } from '../src/core/util.mjs';
import BUNDLED from '../src/sample/self-scan.json' with { type: 'json' };

const OTHER = '557058:other-person';
const PK = 'github-com-Acme-Shop';

/** @param {ReturnType<typeof makeDeps>} d @param {string} key @param {object} [payload] @param {string} [who] */
const res = async (d, key, payload = {}, who = ME) => /** @type {any} */ (await runResolver(d, key, payload, who, 'inbox'));
/** @param {ReturnType<typeof makeDeps>} d @param {string} name @param {object} args @param {string} [who] */
const tool = async (d, name, args, who = ME) => /** @type {any} */ (await runTool(d, name, args, who));

/** Row counts of every app table (the sample's and everyone else's). @param {ReturnType<typeof makeDeps>} d */
const counts = (d) => Object.fromEntries(d.db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()
  .map((r) => String(r.name)).map((t) => [t, Number(/** @type {any} */ (d.db.raw.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get()).n)]));

/** Rows that name the sample, per table: by project_key, evidence by proposal id, counters by name. @param {ReturnType<typeof makeDeps>} d @param {number[]} ids */
function sampleRows(d, ids) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const t of d.db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => String(r.name))) {
    const cols = d.db.raw.prepare(`PRAGMA table_info("${t}")`).all().map((c) => String(c.name));
    if (cols.includes('project_key')) out[t] = Number(/** @type {any} */ (d.db.raw.prepare(`SELECT COUNT(*) AS n FROM "${t}" WHERE project_key = ?`).get(SAMPLE_KEY)).n);
  }
  out.evidence = ids.length ? Number(/** @type {any} */ (d.db.raw.prepare(`SELECT COUNT(*) AS n FROM evidence WHERE proposal_id IN (${ids.join(',')})`).get()).n) : 0;
  out.counters = Number(/** @type {any} */ (d.db.raw.prepare('SELECT COUNT(*) AS n FROM counters WHERE name = ?').get(`seq:${SAMPLE_KEY}`)).n);
  return out;
}

/**
 * A sample file of `n` records, each with `ev` code evidence rows, under one area (the timing test's shape).
 * @param {number} n @param {number} [ev]
 */
function bigSample(n, ev = 3) {
  const proposals = Array.from({ length: n }, (_, i) => record({
    topic: `sample topic ${i}`, anchors: [`forge/src/m${i}.mjs#f${i}`],
    evidence: Array.from({ length: ev }, (_, j) => ({ type: 'code', ref: `forge/src/m${i}.mjs:${j + 1}`, quote: `export const line${j} = ${i};` })),
  }));
  return {
    schema: 'dowser-sample/1',
    source: { repo_url: 'https://github.com/xkazm04/dowser', head_sha: 'abc123', scanned_at: '2026-11-01T10:00:00.000Z', run_id: 'r-big' },
    lens_kinds_json: JSON.stringify({ opportunity: ['missing-capability'] }),
    proposals,
    areas: [{ path: 'forge/src', files: n, churn_90d: 5, authors_90d: 1 }],
    trust_json: JSON.stringify({ slices: [{ slice: 'product|opportunity|low|S', level: 0, ceiling: 1, start: 0, n: 0 }], events: [] }),
  };
}

test('the bundled sample is a valid dowser-sample/1 file every record of which a push accepts', () => {
  const s = checkSample(BUNDLED);
  assert.equal(s.schema, 'dowser-sample/1');
  assert.ok(s.proposals.length > 0 && s.areas.length > 0);
  assert.equal(s.source.repo_url, 'https://github.com/xkazm04/dowser');
});

test('sample.load files the sample for the loader: marked summary and cards, map, learning; a second load changes nothing', async () => {
  const d = makeDeps();
  assert.deepEqual(await res(d, 'setup.status'), { mcp_url: MCP_URL, tools: { calls: 0 }, sample: { loaded: false } }, 'fresh store: 0 calls is a measured count');
  const n = BUNDLED.proposals.length;
  assert.deepEqual(await res(d, 'sample.load'), { project_key: SAMPLE_KEY, created: n });

  const list = await res(d, 'inbox.list', {});
  const summary = list.inboxes.find((/** @type {any} */ i) => i.project_key === SAMPLE_KEY);
  assert.equal(summary.sample, true);
  assert.deepEqual(summary.source, { repo_url: BUNDLED.source.repo_url, head_sha: BUNDLED.source.head_sha, scanned_at: BUNDLED.source.scanned_at });
  assert.equal(summary.open, n);
  const cards = list.groups.flatMap((/** @type {any} */ g) => g.items);
  assert.equal(cards.length, n);
  assert.ok(cards.every((/** @type {any} */ c) => c.sample === true && c.project_key === SAMPLE_KEY));
  const code = cards.flatMap((/** @type {any} */ c) => c.evidence).find((/** @type {any} */ e) => e.type === 'code');
  assert.equal(code.link.startsWith(`${BUNDLED.source.repo_url}/blob/${BUNDLED.source.head_sha}/`), true, 'evidence links point at the scanned commit');
  assert.equal((await res(d, 'settings.get')).inboxes[0].sample, true);
  assert.equal((await res(d, 'proposal.get', { ref: cards[0].ref })).card.sample, true);

  const map = await res(d, 'map.data', { project_key: SAMPLE_KEY });
  assert.equal(map.areas.length, BUNDLED.areas.length);
  assert.ok(map.areas.some((/** @type {any} */ a) => a.proposals.length > 0), 'the map counts cards in its areas');
  assert.equal(map.points.length, n);
  const learn = await res(d, 'reflect.data', { project_key: SAMPLE_KEY });
  assert.equal(learn.totals.open, n);
  assert.equal(learn.pushes.length, 1);
  if (/** @type {{trust_json?: string}} */ (BUNDLED).trust_json) assert.ok(learn.trust.slices.length > 0, 'the trust the scan had is on the Learning tab');
  assert.equal((await res(d, 'setup.status')).sample.loaded, true);

  const before = counts(d);
  assert.deepEqual(await res(d, 'sample.load'), { project_key: SAMPLE_KEY, created: 0, already: true });
  assert.deepEqual(counts(d), before, 'a second load writes nothing');
});

test('a scan inbox is never marked sample', async () => {
  const d = makeDeps();
  await tool(d, 'dowser_proposals_push', pushArgs([record()]));
  const list = await res(d, 'inbox.list', {});
  assert.equal('sample' in list.inboxes[0], false);
  assert.equal('source' in list.inboxes[0], false);
  assert.equal('sample' in list.groups[0].items[0], false);
});

test('a load cut short is completed by the next load, which files only what is missing', async () => {
  const d = makeDeps();
  const s = bigSample(5);
  await pushProposals(d, { project_key: SAMPLE_KEY, run_id: 'r-big', proposals_json: JSON.stringify(s.proposals.slice(0, 2)), lens_kinds_json: s.lens_kinds_json }, ME, { sample: true });
  assert.deepEqual(await loadSample(d, ME, s), { project_key: SAMPLE_KEY, created: 3 });
  assert.equal(d.db.raw.prepare('SELECT COUNT(*) AS n FROM proposals WHERE project_key = ?').get(SAMPLE_KEY)?.n, 5);
  assert.deepEqual(await loadSample(d, ME, s), { project_key: SAMPLE_KEY, created: 0, already: true });
});

test('a sample that would not push is refused whole, before anything is written', async () => {
  const d = makeDeps();
  const s = bigSample(3);
  s.proposals[2] = { ...s.proposals[2], fp: '0000000000000000' };
  await assert.rejects(() => loadSample(d, ME, s), (/** @type {any} */ e) => e instanceof AppError && e.code === 'unavailable' && /proposals\[2\]/.test(e.message));
  assert.equal(d.db.raw.prepare('SELECT COUNT(*) AS n FROM inboxes').get()?.n, 0);
});

test('every MCP write to the reserved key is refused with bad-input, loaded or not; the core refuses without the bypass', async () => {
  const d = makeDeps();
  const calls = [
    ['dowser_proposals_push', pushArgs([record()], { project_key: SAMPLE_KEY })],
    ['dowser_areas_push', { project_key: SAMPLE_KEY, run_id: 'r-1', areas_json: '[]' }],
    ['dowser_reflect_sync', { project_key: SAMPLE_KEY, rules_json: '[]' }],
    ['dowser_direction_get', { project_key: SAMPLE_KEY, lens: 'all' }],
  ];
  for (const loaded of [false, true]) {
    if (loaded) await res(d, 'sample.load');
    const before = counts(d);
    for (const [name, args] of calls) {
      assert.deepEqual(await tool(d, /** @type {string} */ (name), /** @type {object} */ (args)), { error: 'bad-input', message: SAMPLE_RESERVED }, `${name} (loaded: ${loaded})`);
      assert.deepEqual(await runRovo(d, /** @type {string} */ (name), args, ME), { error: 'bad-input', message: SAMPLE_RESERVED }, `${name} through Rovo`);
      assert.deepEqual(await tool(d, /** @type {string} */ (name), { ...(/** @type {object} */ (args)), project_key: ` ${SAMPLE_KEY} ` }), { error: 'bad-input', message: SAMPLE_RESERVED }, 'padding does not slip past');
    }
    const after = counts(d);
    assert.deepEqual({ ...after, tool_calls: 0 }, { ...before, tool_calls: 0 }, 'nothing but the call record was written');
  }
  const refused = (/** @type {any} */ e) => e instanceof AppError && e.code === 'bad-input' && e.message === SAMPLE_RESERVED;
  await assert.rejects(() => pushProposals(d, pushArgs([record()], { project_key: SAMPLE_KEY }), ME), refused);
  await assert.rejects(() => pushAreas(d, { project_key: SAMPLE_KEY, run_id: 'r-1', areas_json: '[]' }, ME), refused);
  await assert.rejects(() => reflectSync(d, { project_key: SAMPLE_KEY }), refused);
  // the pull is a read of the person's verdicts, not a write: it stays open to who may open the sample
  assert.ok(Array.isArray((await tool(d, 'dowser_verdicts_pull', { project_key: SAMPLE_KEY })).verdicts));
});

test('an existing sample opens like any inbox: someone who cannot see it gets forbidden from load', async () => {
  const d = makeDeps();
  await res(d, 'sample.load');
  d.perms.deny.add('ADMINISTER');
  const out = await res(d, 'sample.load', {}, OTHER);
  assert.equal(out.error, 'forbidden');
  d.perms.deny.clear();
  assert.deepEqual(await res(d, 'sample.load', {}, OTHER), { project_key: SAMPLE_KEY, created: 0, already: true }, 'a Jira admin sees it');
});

test('accepting a sample card creates a labelled, marked Jira issue; a scan card does not', async () => {
  const d = makeDeps();
  await res(d, 'sample.load');
  await tool(d, 'dowser_proposals_push', pushArgs([record()]));
  const sampleRef = (await res(d, 'inbox.list', { project_key: SAMPLE_KEY })).groups[0].items[0].ref;
  const scanRef = (await res(d, 'inbox.list', { project_key: PK })).groups[0].items[0].ref;
  const a = await res(d, 'verdict.accept', { ref: sampleRef, jira_project_key: 'SHOP', issue_type_id: '10001' });
  assert.equal(a.card.status, 'accepted');
  assert.equal(a.card.sample, true);
  await res(d, 'verdict.accept', { ref: scanRef, jira_project_key: 'SHOP', issue_type_id: '10001' });
  const [s, n] = d.jira.created;
  assert.deepEqual(s.labels, ['dowser-sample']);
  assert.deepEqual(s.description.content[0], { type: 'paragraph', content: [{ type: 'text', text: SAMPLE_NOTE }] });
  assert.equal(SAMPLE_NOTE, "Created from Dowser sample data: a scan of Dowser's own public repository.");
  assert.equal(n.labels, undefined);
  assert.equal(n.description.content[0].type, 'table', 'a scan card opens with its facts table');
  const panel = await runResolver(d, 'panel.forIssue', { issue_key: /** @type {any} */ (a).card.issue_ref }, ME, 'panel');
  assert.equal(/** @type {any} */ (panel).card.sample, true, 'the evidence panel says it is a sample card');
});

test('sample.remove deletes every row of the sample in every table, keeps the issues, and is for the loader or an admin', async () => {
  const d = makeDeps();
  await tool(d, 'dowser_proposals_push', pushArgs([record()]));
  await res(d, 'sample.load');
  const items = (await res(d, 'inbox.list', { project_key: SAMPLE_KEY })).groups.flatMap((/** @type {any} */ g) => g.items);
  const ids = items.map((/** @type {any} */ c) => Number(c.ref.slice(3)));
  // decisions, an outcome, a direction and a rule: every table the sample can reach
  const acc = await res(d, 'verdict.accept', { ref: items[0].ref, jira_project_key: 'SHOP', issue_type_id: '10001' });
  if (items[1]) await res(d, 'verdict.reject', { refs: [items[1].ref], reason: 'not-worth-it', note: 'demo' });
  await res(d, 'outcome.record', { ref: items[0].ref, rating: 'right' });
  await res(d, 'direction.set', { project_key: SAMPLE_KEY, lens: 'opportunity', focus: ['exports'] });
  await reflectSync(d, { project_key: SAMPLE_KEY, rules_json: JSON.stringify([{ id: 'rule-1', lens: 'opportunity', text: 'skip demos', offered_at: '2026-10-27T10:00:00.000Z' }]) }, { sample: true });
  const loaded = sampleRows(d, ids);
  for (const t of ['inboxes', 'proposals', 'evidence', 'verdicts', 'pushes', 'areas', 'rules', 'outcomes', 'directions', 'counters']) assert.ok(loaded[t] > 0, `${t} holds sample rows before the remove`);
  const others = counts(d);

  d.perms.deny.add('ADMINISTER');
  const no = await res(d, 'sample.remove', {}, OTHER);
  assert.equal(no.error, 'forbidden');
  assert.deepEqual(sampleRows(d, ids), loaded, 'a refused remove deletes nothing');

  assert.deepEqual(await res(d, 'sample.remove'), { removed: true, issues_kept: 1 });
  const gone = sampleRows(d, ids);
  assert.deepEqual(Object.values(gone).filter((v) => v !== 0), [], `no sample row is left: ${JSON.stringify(gone)}`);
  assert.equal(d.jira.created.length, 1, 'the Jira issue stays');
  assert.equal(acc.card.issue_ref.startsWith('SHOP-'), true);
  const after = counts(d);
  assert.equal(after.proposals, others.proposals - items.length, 'the scan inbox is untouched');
  assert.equal((await res(d, 'inbox.list', { project_key: PK })).groups[0].items.length, 1);
  assert.equal((await res(d, 'setup.status')).sample.loaded, false);

  // removing nothing is not an error; a reload numbers its cards anew (DW numbers are never reused)
  assert.deepEqual(await res(d, 'sample.remove'), { removed: true, issues_kept: 0 });
  assert.equal((await res(d, 'sample.load')).created, items.length);
  const again = (await res(d, 'inbox.list', { project_key: SAMPLE_KEY })).groups.flatMap((/** @type {any} */ g) => g.items).map((/** @type {any} */ c) => Number(c.ref.slice(3)));
  assert.ok(Math.min(...again) > Math.max(...ids));

  // a Jira admin may remove a sample someone else loaded
  d.perms.deny.clear();
  assert.deepEqual(await res(d, 'sample.remove', {}, OTHER), { removed: true, issues_kept: 0 });
});

test('setup.status counts MCP tool calls (not Rovo actions, not resolvers); a failing record never fails the call', async () => {
  const d = makeDeps();
  await tool(d, 'dowser_sources_goals', {});
  d.clock.tick(5000);
  await tool(d, 'dowser_verdicts_pull', { project_key: 'nope' }); // an error answer is still a call that reached the app
  await tool(d, 'dowser_unknown', {}); // not a tool: not counted
  await runRovo(d, 'dowser_inbox_list', {}, ME);
  await runRovo(d, 'dowser_sources_goals', {}, ME); // the shared tool through Rovo counts as rovo
  await res(d, 'settings.get');
  const st = await res(d, 'setup.status');
  assert.deepEqual(st.tools, { calls: 2, last_at: '2026-10-27T10:00:05.000Z', last_tool: 'dowser_verdicts_pull' });
  assert.deepEqual(d.db.raw.prepare('SELECT name, calls FROM tool_calls ORDER BY name').all().map((r) => [r.name, r.calls]),
    [['mcp:dowser_sources_goals', 1], ['mcp:dowser_verdicts_pull', 1], ['rovo:dowser_inbox_list', 1], ['rovo:dowser_sources_goals', 1]]);

  d.db.failNext = /tool_calls/;
  assert.deepEqual(await tool(d, 'dowser_sources_goals', {}), { items: [] }, 'the tool answers as if nothing happened');
  assert.ok(d.logs.some((l) => /"what":"tool-call-not-counted","error":"Error"/.test(l)), 'logged by error name only');
  assert.equal((await res(d, 'setup.status')).tools.calls, 2);
  await tool(d, 'dowser_sources_goals', {});
  assert.equal((await res(d, 'setup.status')).tools.calls, 3);

  const local = makeDeps();
  local.links = { inboxUrl: local.links.inboxUrl }; // a port without an MCP URL (local-forge)
  assert.deepEqual(await res(local, 'setup.status'), { tools: { calls: 0 }, sample: { loaded: false } }, 'no URL: the key is omitted');
});

test('time: sample.load of 40 records with 3 evidence rows each, statement count', async (t) => {
  const d = makeDeps();
  let statements = 0;
  const { query, exec } = d.db;
  d.db.query = (sql, p) => { statements++; return query(sql, p); };
  d.db.exec = (sql, p) => { statements++; return exec(sql, p); };
  const t0 = performance.now();
  const out = await loadSample(d, ME, bigSample(40));
  const ms = performance.now() - t0;
  assert.equal(out.created, 40);
  // The push files its cards as sets (one fp read, one counter block, multi-row proposal and evidence INSERTs), then
  // the areas and the trust: about 30 statements, ~1-2 s at 30-60 ms a Forge SQL statement (docs/forge-app.md
  // "Sample inbox"). It was ~8 statements a card (340) before the store was set-based.
  t.diagnostic(`sample.load 40 records x 3 evidence: ${statements} statements, ${ms.toFixed(0)} ms on node:sqlite; at 30-60 ms each on Forge SQL: ${(statements * 0.03).toFixed(1)}-${(statements * 0.06).toFixed(1)} s`);
  assert.ok(statements <= 40, `${statements} statements`);
});

test('sample.load keeps to its time budget: no new step past it, more: true, the next call resumes, the last answers without more', async () => {
  const d = makeDeps();
  const n = 2 * SAMPLE_CHUNK + 5;
  const s = bigSample(n, 1);
  // budget 0: every call runs exactly its first step (chunks of SAMPLE_CHUNK, then the areas, then the trust)
  const calls = [];
  for (let i = 0; i < 6; i++) calls.push(await loadSample(d, ME, s, { budgetMs: 0 }));
  assert.deepEqual(calls, [
    { project_key: SAMPLE_KEY, created: SAMPLE_CHUNK, more: true },
    { project_key: SAMPLE_KEY, created: SAMPLE_CHUNK, more: true },
    { project_key: SAMPLE_KEY, created: n - 2 * SAMPLE_CHUNK, more: true },
    { project_key: SAMPLE_KEY, created: 0, more: true }, // the areas; the trust is still to do
    { project_key: SAMPLE_KEY, created: 0 }, // the trust: done, so no more and not already
    { project_key: SAMPLE_KEY, created: 0, already: true },
  ]);
  assert.equal(d.db.raw.prepare('SELECT COUNT(*) AS n FROM proposals WHERE project_key = ?').get(SAMPLE_KEY)?.n, n);
  assert.equal(d.db.raw.prepare('SELECT COUNT(*) AS n FROM areas WHERE project_key = ?').get(SAMPLE_KEY)?.n, 1);
  assert.equal(d.db.raw.prepare('SELECT COUNT(*) AS n FROM trust WHERE project_key = ?').get(SAMPLE_KEY)?.n, 1);

  // the default budget against the injected clock: a slow store (every clock read 4 s later) stops early and resumes.
  // Four chunks of cards, not the bundle: the bundled scan may fit one call, which would prove nothing here.
  const slow = makeDeps();
  const base = slow.now;
  slow.now = () => { slow.clock.tick(4000); return base(); };
  const big = bigSample(4 * SAMPLE_CHUNK, 1);
  const first = await loadSample(slow, ME, big);
  assert.equal(first.more, true);
  assert.ok(first.created > 0 && first.created < 4 * SAMPLE_CHUNK);
  let last = first;
  for (let i = 0; i < 20 && last.more; i++) last = await loadSample(slow, ME, big);
  assert.equal(last.more, undefined);
  assert.deepEqual(await loadSample(slow, ME, big), { project_key: SAMPLE_KEY, created: 0, already: true });
  assert.equal(slow.db.raw.prepare('SELECT COUNT(*) AS n FROM proposals WHERE project_key = ?').get(SAMPLE_KEY)?.n, 4 * SAMPLE_CHUNK);

  // through the resolver, the bundled sample completes by calling again while it answers more
  const viaResolver = makeDeps();
  let r = await res(viaResolver, 'sample.load');
  for (let i = 0; i < 20 && r.more; i++) r = await res(viaResolver, 'sample.load');
  assert.equal(r.more, undefined);
  assert.equal(viaResolver.db.raw.prepare('SELECT COUNT(*) AS n FROM proposals WHERE project_key = ?').get(SAMPLE_KEY)?.n, BUNDLED.proposals.length);
});

test('mixed planes: All inboxes leaves the sample out of items and aggregates unless it is the only inbox; the picker still lists it', async () => {
  const d = makeDeps();
  await res(d, 'sample.load');
  const only = await res(d, 'inbox.list', {});
  assert.ok(only.groups.flatMap((/** @type {any} */ g) => g.items).every((/** @type {any} */ c) => c.sample === true), 'the sample alone: All shows it');
  assert.ok(only.groups.length > 0);

  await tool(d, 'dowser_proposals_push', pushArgs([record({ doc_impact: ['98765'] })]));
  const all = await res(d, 'inbox.list', {});
  const items = all.groups.flatMap((/** @type {any} */ g) => g.items);
  assert.deepEqual(items.map((/** @type {any} */ c) => c.project_key), [PK], 'All: no sample card');
  assert.deepEqual(all.inboxes.map((/** @type {any} */ i) => [i.project_key, i.sample]).sort(), [[SAMPLE_KEY, true], [PK, undefined]], 'the picker still offers the sample');
  assert.ok((await res(d, 'inbox.list', { project_key: SAMPLE_KEY })).groups.length > 0, 'picked, the sample lists its own cards');
  for (const status of ['open', 'accepted']) {
    assert.ok((await res(d, 'inbox.list', { status })).groups.flatMap((/** @type {any} */ g) => g.items).every((/** @type {any} */ c) => c.project_key === PK), status);
  }

  const rovo = /** @type {any} */ (await runRovo(d, 'dowser_inbox_list', {}, ME));
  assert.deepEqual([...new Set(rovo.items.map((/** @type {any} */ c) => c.project_key))], [PK], 'Rovo across inboxes: no sample card');
  assert.ok(rovo.inboxes.some((/** @type {any} */ i) => i.project_key === SAMPLE_KEY));

  // the page byline spans inboxes too: a sample card citing the page stays out while a scan inbox is visible
  const d2 = makeDeps();
  const s = bigSample(1, 1);
  s.proposals[0] = record({ topic: 'byline sample', anchors: ['forge/src/b.mjs#b'], doc_impact: ['98765'], evidence: [{ type: 'code', ref: 'forge/src/b.mjs:1', quote: 'export const b = 1;' }] });
  await loadSample(d2, ME, s);
  const alone = await runResolver(d2, 'byline.forPage', { page_id: '98765' }, ME, 'inbox');
  assert.equal(/** @type {any} */ (alone).count, 1, 'the sample alone: its card shows');
  await tool(d2, 'dowser_proposals_push', pushArgs([record({ doc_impact: ['98765'] })]));
  const mixed = /** @type {any} */ (await runResolver(d2, 'byline.forPage', { page_id: '98765' }, ME, 'inbox'));
  assert.deepEqual(mixed.cards.map((/** @type {any} */ c) => c.project_key), [PK]);
});

test('a tool call on a store without tool_calls migrates through ensureSchema and is counted; the tool answers once', async () => {
  const d = makeDeps();
  d.db.raw.exec('DROP TABLE tool_calls');
  let migrations = 0;
  d.ensureSchema = async (/** @type {unknown} */ e) => {
    if (migrations > 0 || !/no such table/i.test(String(/** @type {any} */ (e)?.message))) return false;
    migrations += 1;
    d.db.raw.exec('CREATE TABLE tool_calls (name VARCHAR(96) PRIMARY KEY, calls INT NOT NULL, last_at VARCHAR(32) NOT NULL)');
    return true;
  };
  const out = await runTool(d, 'dowser_verdicts_pull', { project_key: 'github-com-acme-shop' }, ME);
  assert.equal(migrations, 1);
  assert.equal(/** @type {any} */ (out).error === undefined || /** @type {any} */ (out).error === 'unknown-project', true);
  assert.equal(d.db.raw.prepare('SELECT calls FROM tool_calls WHERE name = ?').get('mcp:dowser_verdicts_pull')?.calls, 1);
});
