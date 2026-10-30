// @ts-check
// The full loop against the REAL Forge core: tools/local-forge.mjs (forge/src/core over node:sqlite) spawned once
// with both doors open - MCP on stdio for the skill's side, HTTP /invoke for the person's side (the Custom UI's
// resolvers). The test plays the agent (as in sync-mcp.test.mjs) and the person in the inbox: push, triage with
// notes, pull, rescan (suppressed / reopened), rule offer -> decide in Forge -> back into the skill, an issue
// shipping in Jira, an outcome rated, and an idempotent second sync.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { candidate, gitRepo, listFiles, removeDir, tempDir } from './_fixture.mjs';

const CLI = fileURLToPath(new URL('../dowser.mjs', import.meta.url));
const SERVER = fileURLToPath(new URL('../../../tools/local-forge.mjs', import.meta.url));
const KINDS = ['--kinds', 'opportunity=gap', '--kinds', 'doc-drift=stale'];

/** @type {string} */ let home;
/** @type {string} */ let repo;
/** @type {string} */ let work;
/** @type {import('node:child_process').ChildProcessWithoutNullStreams} */ let server;
/** @type {string} */ let base;
let stderr = '';
/** @type {Map<number, (msg: any) => void>} */
const pending = new Map();
let nextId = 1;

before(async () => {
  home = tempDir('lf-home');
  repo = tempDir('lf-repo');
  work = tempDir('lf-work');
  gitRepo(repo, {
    'src/export.js': 'export function exportReport(rows) {\n  return rows.map(String).join("\\n");\n}\n',
    'src/onboarding.js': 'export function startTour() {}\nexport function showChecklist() {}\nexport function skipOnboarding() {}\n',
    'docs/setup.md': '# Setup\nRun npm install first.\nThen run npm start.\n',
  });
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/Acme/Shop.git'], { stdio: 'ignore' });
  const seed = join(work, 'seed.json');
  writeFileSync(seed, JSON.stringify({
    tickets: [{ ref: 'SUP-7', title: 'Export to CSV please', url: 'http://jira.local/browse/SUP-7', body: 'We need a CSV export.', created_at: '2026-10-01T00:00:00.000Z' }],
  }));
  server = spawn(process.execPath, [SERVER, '--stdio', '--http', '0', '--db', join(work, 'forge.db'), '--seed', seed], { stdio: ['pipe', 'pipe', 'pipe'] });
  createInterface({ input: server.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  });
  base = await new Promise((done, fail) => {
    const t = setTimeout(() => fail(new Error(`local-forge did not listen:\n${stderr}`)), 10000);
    server.stderr.on('data', (/** @type {Buffer} */ c) => {
      stderr += c.toString();
      const m = /http listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(stderr);
      if (m) { clearTimeout(t); done(m[1]); }
    });
    server.once('exit', (code) => fail(new Error(`local-forge exited ${code}:\n${stderr}`)));
  });
});

after(async () => {
  if (server && server.exitCode === null) {
    const gone = new Promise((done) => server.once('exit', done));
    server.kill();
    await gone; // the db file is released before its folder is removed
  }
  removeDir(home); removeDir(repo); removeDir(work);
});

/** @param {string} method @param {unknown} [params] @returns {Promise<any>} */
function rpc(method, params) {
  const id = nextId++;
  return new Promise((done, fail) => {
    const t = setTimeout(() => fail(new Error(`${method}: no reply`)), 10000);
    pending.set(id, (msg) => { clearTimeout(t); done(msg); });
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

/** A tool call; returns the parsed text content (what the agent saves verbatim). @param {string} name @param {Record<string, unknown>} args */
async function tool(name, args) {
  const r = await rpc('tools/call', { name, arguments: args });
  assert.ok(r.result, JSON.stringify(r));
  assert.notEqual(r.result.isError, true, r.result.content?.[0]?.text);
  const out = JSON.parse(r.result.content[0].text);
  assert.deepEqual(r.result.structuredContent, out);
  return out;
}

/** @param {string} path @param {unknown} [body] @returns {Promise<{status: number, body: any}>} */
async function http(path, body) {
  const res = await fetch(`${base}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

/** A resolver call as the Custom UI makes it; fails the test on `{error}`. @param {string} key @param {Record<string, unknown>} [payload] */
async function invoke(key, payload = {}) {
  const r = await http('/invoke', { key, payload });
  assert.equal(r.status, 200);
  assert.equal(r.body.error, undefined, `${key}: ${JSON.stringify(r.body)}`);
  return r.body;
}

/** @param {string[]} args */
function cli(...args) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--repo', repo], { encoding: 'utf8', env: { ...process.env, DOWSER_HOME: home }, cwd: work });
  /** @type {any} */
  let out;
  try { out = JSON.parse(r.stdout); } catch { out = undefined; }
  return { code: r.status, out, lines: out !== undefined ? [out] : r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l)), stdout: r.stdout, stderr: r.stderr };
}

/** @param {string} name @param {unknown} doc */
const save = (name, doc) => { const f = join(work, name); writeFileSync(f, JSON.stringify(doc, null, 2)); return f; };

/** @param {string} runId @param {string} name @param {Record<string, unknown>[]} lines */
function proposeFile(runId, name, lines) {
  writeFileSync(join(work, name), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const p = cli('propose', '--run', runId, '--file', join(work, name), ...KINDS);
  assert.equal(p.code, 0, p.stdout + p.stderr);
  return p.lines.filter((/** @type {any} */ l) => l.fp);
}

const EXPORT = { type: 'code', ref: 'src/export.js:2', quote: 'return rows.map(String).join("\\n");' };
const SETUP = { type: 'code', ref: 'docs/setup.md:2', quote: 'Run npm install first.' };
const SETUP2 = { type: 'code', ref: 'docs/setup.md:3', quote: 'Then run npm start.' };
const ONB = ['export function startTour() {}', 'export function showChecklist() {}', 'export function skipOnboarding() {}']
  .map((quote, i) => ({ type: 'code', ref: `src/onboarding.js:${i + 1}`, quote }));
const ONB_TOPICS = ['onboarding tour', 'onboarding checklist', 'skip onboarding'];
const onbCandidate = (/** @type {number} */ i) => candidate({ lens: 'opportunity', kind: 'gap', topic: ONB_TOPICS[i], anchors: [`src/onboarding.js#${i}`], title: `Onboarding idea ${i}`, evidence: [ONB[i]] });
const staleCandidate = (/** @type {Record<string, unknown>[]} */ evidence) => candidate({ lens: 'doc-drift', kind: 'stale', topic: 'stale setup guide', anchors: ['docs/setup.md'], title: 'Setup guide is stale', evidence });

test('local Forge, real core: push, triage over HTTP, pull, rescan, rules and outcomes round trip, idempotent', async () => {
  const filesBefore = listFiles(repo);

  // --- MCP handshake: eight tools, scalar inputs
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  assert.equal(init.result.serverInfo.name, 'dowser-forge-local');
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  assert.deepEqual(await rpc('ping').then((r) => r.result), {});
  const tools = (await rpc('tools/list')).result.tools;
  assert.deepEqual(tools.map((/** @type {any} */ t) => t.name), ['dowser_sources_tickets', 'dowser_sources_pages', 'dowser_sources_goals',
    'dowser_proposals_push', 'dowser_verdicts_pull', 'dowser_areas_push', 'dowser_reflect_sync', 'dowser_direction_get']);
  for (const t of tools) for (const [k, v] of Object.entries(t.inputSchema.properties)) assert.ok(['string', 'integer'].includes(/** @type {any} */ (v).type), `${t.name}.${k}`);
  assert.equal((await rpc('nope/method')).error.code, -32601);
  assert.deepEqual((await tool('dowser_sources_tickets', { query: 'csv OR export', limit: 10 })).items.map((/** @type {any} */ i) => i.ref), ['SUP-7'], 'seeded sources answer through the core');

  // --- 1. scan, verify, push, areas
  const di = cli('init');
  assert.equal(di.code, 0, di.stderr);
  const projectKey = di.out.project_key;
  const run1 = cli('run', 'start', '--mode', 'full', '--harness', 'claude-code', '--model', 'm').out.run_id;
  const proposed = proposeFile(run1, 'run1.jsonl', [
    candidate({ lens: 'opportunity', kind: 'gap', topic: 'csv export', anchors: ['src/export.js#exportReport'], title: 'Add CSV export', evidence: [EXPORT],
      impact: 7, impact_why: 'One ticket asks; the writer exists', delivery_risk: { blast: 'low' },
      artifacts: [{ kind: 'table', message: 'One writer, no route', alt: 'A table of the CSV writer and its callers.', refs: [EXPORT.ref], data: { columns: ['Code', 'Callers'], rows: [['exportReport', '0']] } }] }),
    onbCandidate(0), onbCandidate(1), onbCandidate(2),
    staleCandidate([SETUP]),
  ]);
  assert.equal(proposed.length, 5);
  const [fpA, fpR1, fpR2, fpR3, fpS] = proposed.map((/** @type {any} */ l) => l.fp);
  const v1 = cli('verify', '--run', run1);
  assert.equal(v1.code, 0, v1.stdout + v1.stderr);
  const ob = cli('outbox', '--run', run1);
  assert.equal(JSON.parse(ob.out.proposals_json).length, 5, 'verify kept every candidate');
  const pushed = await tool('dowser_proposals_push', ob.out);
  assert.deepEqual(pushed.results.map((/** @type {any} */ r) => r.result), ['created', 'created', 'created', 'created', 'created']);
  /** @type {Record<string, string>} */
  const ref = Object.fromEntries(pushed.results.map((/** @type {any} */ r) => [r.fp, r.external_ref]));
  for (const r of pushed.results) assert.equal(r.external_url, `http://127.0.0.1:5173/#inbox&ref=${r.external_ref}`);
  assert.equal(cli('ingest-push', '--file', save('push1.json', pushed)).code, 0);
  const ar = cli('areas', '--run', run1);
  assert.equal(ar.code, 0, ar.stderr);
  assert.deepEqual(await tool('dowser_areas_push', ar.out), { stored: JSON.parse(ar.out.areas_json).length });
  assert.equal(cli('run', 'finish', '--run', run1, '--lenses', JSON.stringify({ opportunity: { state: 'ran' }, 'doc-drift': { state: 'ran' } })).code, 0);

  // --- 2. the person triages in the inbox (HTTP /invoke, the Custom UI's resolver door)
  const inbox = await invoke('inbox.list', { project_key: projectKey });
  assert.equal(inbox.groups.length, 1);
  assert.equal(inbox.groups[0].run_id, run1);
  assert.equal(inbox.groups[0].items.length, 5);
  assert.deepEqual((await invoke('jira.projects')).projects.map((/** @type {any} */ p) => p.key), ['DOW']);
  // the map -> inbox link: over the areas the skill pushed, each map cell's open count is what inbox.list?area lists
  const map = await invoke('map.data', { project_key: projectKey });
  assert.ok(map.areas.length > 0, 'the skill pushed areas');
  for (const a of map.areas) {
    for (const c of a.proposals) {
      const cell = await invoke('inbox.list', { project_key: projectKey, lens: c.lens, area: a.path });
      assert.equal(cell.groups.flatMap((/** @type {any} */ g) => g.items).length, c.open, `${a.path} x ${c.lens}`);
    }
  }
  // the seam: a card's supporting view reaches the inbox card through outbox and the real core
  const cardA = (await invoke('proposal.get', { ref: ref[fpA] })).card;
  assert.equal(cardA.artifacts?.[0]?.kind, 'table');
  // the seam (scan-finding/1): the store's score, breakdown, allocation and shadow prediction reach the inbox card
  // as computed - (7, high, S=2, blast low=2) = 7 * 10 * 0.95 / 1.111 * 0.95 = 56.9 - and the inbox never recomputes
  assert.deepEqual([cardA.score, cardA.score_parts.formula, cardA.impact, cardA.effort.score, cardA.risk, cardA.category, cardA.band, cardA.mvp],
    [56.9, 'scan-score/1', 7, 2, 2, 'product', 'ranked', true]);
  assert.deepEqual([cardA.predicted_verdict, cardA.predicted_by], ['defer', 'dowser-opportunity@1.0.0:memory'], 'no judge verdict, no precedent: the store says defer');
  assert.equal(cardA.predicted_why, 'no recorded decision on similar work; a person decides');
  assert.equal(inbox.groups[0].items[0].ref, ref[fpA], 'the opportunity MVP is pinned at the top of its push group');
  const unscored = inbox.groups[0].items.filter((/** @type {any} */ c) => c.score === undefined);
  assert.equal(unscored.length, 4, 'cards without an impact are unscored: no score key, never 0');
  await invoke('settings.set', { project_key: projectKey, jira_project_key: 'DOW', issue_type_id: '10001' });
  const acc = await invoke('verdict.accept', { ref: ref[fpA], note: 'Ship it this sprint' });
  assert.equal(acc.card.status, 'accepted');
  assert.equal(acc.card.issue_ref, 'DOW-1');
  const issue = (await http('/browse/DOW-1')).body.issue;
  assert.equal(issue.summary, 'Add CSV export');
  assert.equal(issue.status.category, 'new');
  const facts = issue.description.content[0];
  assert.equal(facts.type, 'table', 'the Jira description opens with the facts table');
  /** @param {any} n @returns {string} */
  const txt = (n) => (n.type === 'text' ? n.text : (n.content ?? []).map(txt).join(''));
  const factRows = Object.fromEntries(facts.content.slice(1).map((/** @type {any} */ r) => r.content.map(txt)));
  assert.equal(factRows.Impact, '7/10 - One ticket asks; the writer exists');
  assert.match(factRows.Score, /^56\.9 = 10 x impact 7 x confidence 0\.95 \/ effort 1\.111 x risk 0\.95 \(scan-score\/1\)$/);
  assert.equal(factRows.MVP, 'MVP of the Opportunity lens');
  const rej = await invoke('verdict.reject', { refs: [ref[fpR1], ref[fpR2], ref[fpR3]], reason: 'not-our-direction' });
  assert.deepEqual(rej.cards.map((/** @type {any} */ c) => c.status), ['rejected', 'rejected', 'rejected']);
  await invoke('verdict.snooze', { refs: [ref[fpS]], note: 'After the redesign', until: '2099-01-01' }); // a dated snooze (DW-42)
  assert.equal((await invoke('inbox.list', { project_key: projectKey })).groups.length, 0, 'nothing open');

  // --- 3. pull the verdicts into the skill
  const page = await tool('dowser_verdicts_pull', { project_key: projectKey });
  assert.equal(page.verdicts.length, 5);
  const iv = cli('ingest-verdicts', '--file', save('verdicts1.json', page));
  assert.equal(iv.code, 0, iv.stdout + iv.stderr);
  assert.deepEqual(iv.out.verdicts.map((/** @type {any} */ v) => v.outcome), ['applied', 'applied', 'applied', 'applied', 'applied']);
  const showA = cli('show', fpA).out;
  assert.equal(showA.card.status, 'accepted');
  assert.equal(showA.issue_ref, 'DOW-1');
  assert.equal(showA.transitions.at(-1).note, 'Ship it this sprint');
  assert.equal(showA.transitions.at(-1).by, 'forge:local-user');
  const showS = cli('show', fpS).out;
  assert.equal(showS.card.status, 'snoozed');
  assert.equal(showS.transitions.at(-1).note, 'After the redesign');
  assert.equal(showS.card.snooze_until, '2099-01-01', 'the inbox date reaches the store');
  for (const fp of [fpR1, fpR2, fpR3]) assert.equal(cli('show', fp).out.card.status, 'rejected');

  // --- 4. rescan: a rejected item stays suppressed; the snoozed one with new evidence reopens on push
  const run2 = cli('run', 'start', '--mode', 'full', '--harness', 'claude-code', '--model', 'm').out.run_id;
  const again = proposeFile(run2, 'run2.jsonl', [onbCandidate(0), staleCandidate([SETUP, SETUP2])]);
  assert.deepEqual(again.map((/** @type {any} */ l) => [l.fp, l.result]), [[fpR1, 'suppressed'], [fpS, 'evidence-grew']]);
  assert.equal(cli('verify', '--run', run2).code, 0);
  const ob2 = cli('outbox', '--run', run2);
  assert.deepEqual(JSON.parse(ob2.out.proposals_json).map((/** @type {any} */ p) => p.fp), [fpS]);
  const repush = await tool('dowser_proposals_push', ob2.out);
  assert.deepEqual(repush.results.map((/** @type {any} */ r) => [r.result, r.external_ref]), [['updated', ref[fpS]]]);
  assert.equal(cli('ingest-push', '--file', save('push2.json', repush)).code, 0);
  const reopened = (await invoke('inbox.list', { project_key: projectKey })).groups.flatMap((/** @type {any} */ g) => g.items);
  assert.deepEqual(reopened.map((/** @type {any} */ c) => [c.ref, c.change, c.reopened]), [[ref[fpS], 'reopened', true]]);

  // --- 5. rules: offer -> sync -> decide in Forge (edited) -> issue ships -> outcome -> sync back
  const offers = cli('rules', 'offer').out.offers;
  assert.equal(offers.length, 1);
  const rule = offers[0];
  assert.equal(rule.lens, 'opportunity');
  const ex = cli('reflect', 'export');
  assert.equal(JSON.parse(ex.out.rules_json)[0].id, rule.id);
  const sync0 = await tool('dowser_reflect_sync', ex.out);
  assert.deepEqual(sync0, { rules: [], outcomes: [] });
  assert.deepEqual(cli('reflect', 'ingest', '--file', save('sync0.json', sync0)).out, { rules_applied: 0, rules_skipped: 0, outcomes_added: 0, outcomes_seen: 0 });

  const rd0 = await invoke('reflect.data', { project_key: projectKey });
  assert.deepEqual(rd0.rules.map((/** @type {any} */ r) => [r.id, r.state]), [[rule.id, 'offered']]);
  assert.deepEqual(rd0.rules[0].titles.slice().sort(), ['Onboarding idea 0', 'Onboarding idea 1', 'Onboarding idea 2']);
  const edited = 'Skip onboarding ideas unless they cut time-to-value';
  const dec = await invoke('rule.decide', { project_key: projectKey, id: rule.id, state: 'accepted', text: edited });
  assert.deepEqual([dec.rule.state, dec.rule.text, dec.rule.decided_by_name], ['accepted', edited, 'Local Operator']);

  assert.deepEqual(rd0.candidates.map((/** @type {any} */ c) => [c.ref, c.issue_status, c.done]), [[ref[fpA], 'To Do', false]]);
  const moved = await http('/dev/jira-status', { key: 'DOW-1', category: 'done' });
  assert.equal(moved.status, 200);
  assert.equal((await http('/dev/jira-status', { key: 'DOW-404', category: 'done' })).status, 404);
  const rd1 = await invoke('reflect.data', { project_key: projectKey });
  assert.deepEqual(rd1.candidates.map((/** @type {any} */ c) => [c.ref, c.issue_status, c.done]), [[ref[fpA], 'Done', true]], 'a shipped issue comes first');
  const out = await invoke('outcome.record', { ref: ref[fpA], rating: 'partly', note: 'Half of it shipped' });
  assert.equal(out.outcome.decided_by_name, 'Local Operator');
  assert.deepEqual(out.candidates, []);

  const sync1 = await tool('dowser_reflect_sync', cli('reflect', 'export').out);
  assert.deepEqual(sync1.rules.map((/** @type {any} */ r) => [r.id, r.state, r.text, r.decided_by]), [[rule.id, 'accepted', edited, 'forge:local-user']]);
  assert.deepEqual(sync1.outcomes.map((/** @type {any} */ o) => [o.ref, o.fp, o.rating, o.issue_ref]), [[ref[fpA], fpA, 'partly', 'DOW-1']]);
  const ing1 = cli('reflect', 'ingest', '--file', save('sync1.json', sync1));
  assert.equal(ing1.code, 0, ing1.stdout + ing1.stderr);
  assert.deepEqual(ing1.out, { rules_applied: 1, rules_skipped: 0, outcomes_added: 1, outcomes_seen: 1 });
  const local = cli('rules', 'list', '--lens', 'opportunity').out.rules[0];
  assert.deepEqual([local.state, local.text], ['accepted', edited]);
  const ctx = cli('context', '--run', run2, '--lens', 'opportunity').out;
  assert.ok(ctx.rules.some((/** @type {any} */ r) => r.text === edited), 'the accepted rule reaches the lens context');
  assert.deepEqual(ctx.outcomes, { right: 0, partly: 1, wrong: 0, notes: [{ title: 'Add CSV export', rating: 'partly', note: 'Half of it shipped' }] });

  const rd2 = await invoke('reflect.data', { project_key: projectKey });
  assert.deepEqual(rd2.pushes.map((/** @type {any} */ p) => [p.run_id, p.created, p.updated, p.dup_rate]), [[run2, 0, 1, 1], [run1, 5, 0, 0]]);
  assert.deepEqual([rd2.pushes[1].accepted, rd2.pushes[1].rejected, rd2.pushes[1].open], [1, 3, 1]);
  assert.deepEqual(rd2.rejects, [{ lens: 'opportunity', reason: 'not-our-direction', count: 3 }]);
  assert.deepEqual(rd2.notes.map((/** @type {any} */ n) => [n.ref, n.note, n.decided_by_name]).sort(),
    [[ref[fpA], 'Ship it this sprint', 'Local Operator'], [ref[fpS], 'After the redesign', 'Local Operator']].sort());
  assert.equal(rd2.outcomes[0].decided_by_name, 'Local Operator');
  assert.equal(rd2.rules[0].decided_by_name, 'Local Operator');

  // --- 6. idempotency: another round trip applies nothing new
  const ex2 = cli('reflect', 'export').out;
  assert.equal(ex2.rules_json, undefined, 'nothing is offered any more');
  const sync2 = await tool('dowser_reflect_sync', { ...ex2, rules_json: '[]' });
  assert.deepEqual(cli('reflect', 'ingest', '--file', save('sync2.json', sync2)).out, { rules_applied: 0, rules_skipped: 1, outcomes_added: 0, outcomes_seen: 1 });
  assert.deepEqual((await tool('dowser_verdicts_pull', { project_key: projectKey, cursor: page.cursor })).verdicts, [], 'no new verdicts');

  const state = (await http('/dev/state')).body.tables;
  assert.deepEqual([state.proposals, state.verdicts, state.rules, state.outcomes, state.local_jira_issues, state.pushes], [5, 5, 1, 1, 1, 2]);

  // --- 7. budget in code, earned L1, machine pre-triage, a person's reversal, trust in the Learning tab
  // 7a. twenty doc-drift cards in one run: the store keeps 4 ranked (the MVP first) and files 16 in reserve - all pushed
  const run3 = cli('run', 'start', '--mode', 'full', '--harness', 'claude-code', '--model', 'm').out.run_id;
  const drift = Array.from({ length: 20 }, (_, i) => candidate({
    lens: 'doc-drift', kind: 'stale', topic: `setup drift ${i}`, anchors: [`docs/setup.md#part${i}`], title: `Setup drift ${i}`, evidence: [SETUP],
    impact: 1 + (i % 10), impact_why: 'A reader runs the wrong command', predicted_verdict: 'reject', predicted_why: 'cosmetic doc drift; the team rejects these',
  }));
  assert.equal(proposeFile(run3, 'run3.jsonl', drift).length, 20);
  const v3 = cli('verify', '--run', run3, '--per-run', '4'); // a run budget of 4 keeps 16 of the 20 in reserve (free slots fill by score)
  assert.equal(v3.code, 0, v3.stdout);
  assert.deepEqual([v3.out.allocation.per_lens['doc-drift'].ranked, v3.out.allocation.per_lens['doc-drift'].reserve], [4, 16]);
  const ob3 = cli('outbox', '--run', run3);
  const sent3 = JSON.parse(ob3.out.proposals_json);
  assert.equal(sent3.length, 20, 'reserve cards are pushed too: filed, not discarded');
  assert.deepEqual(sent3.filter((/** @type {any} */ p) => p.band === 'ranked').length, 4);
  const push3 = await tool('dowser_proposals_push', ob3.out);
  assert.equal(cli('ingest-push', '--file', save('push3.json', push3)).code, 0);
  const fin3 = cli('run', 'finish', '--run', run3, '--lenses', JSON.stringify({ 'doc-drift': { state: 'ran' } }));
  assert.equal(fin3.code, 0, fin3.stdout);
  assert.deepEqual([fin3.out.lenses['doc-drift'].ranked, fin3.out.lenses['doc-drift'].reserve, fin3.out.lenses['doc-drift'].reserve_titles.length], [4, 16, 16],
    'run finish names the reserve by title');
  const group3 = (await invoke('inbox.list', { project_key: projectKey })).groups.find((/** @type {any} */ g) => g.run_id === run3);
  assert.deepEqual(group3.items.slice(0, 5).map((/** @type {any} */ c) => [c.mvp ?? false, c.band]), [[true, 'ranked'], [false, 'ranked'], [false, 'ranked'], [false, 'ranked'], [false, 'reserve']],
    'the inbox orders the group MVP first, ranked by score, reserve after');
  const scores = group3.items.slice(1, 4).map((/** @type {any} */ c) => c.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a), 'ranked by the stored score, descending');

  // 7b. the person rejects all twenty and the predictions agreed. doc-drift is a technical slice, which starts at its
  // ceiling L1 (technical items default to automation), so the agreement holds it there and no event is written
  await invoke('verdict.reject', { refs: push3.results.map((/** @type {any} */ r) => r.external_ref), reason: 'not-worth-it' });
  const page3 = await tool('dowser_verdicts_pull', { project_key: projectKey, cursor: page.cursor });
  const iv3 = cli('ingest-verdicts', '--file', save('verdicts3.json', page3));
  assert.equal(iv3.code, 0, iv3.stdout);
  const SLICE = 'technical|doc-drift|-|S';
  assert.deepEqual((iv3.out.trust_events ?? []).map((/** @type {any} */ e) => [e.slice, e.from, e.to, e.n]), []);
  const held = cli('trust', '--slice', SLICE).out.slices[0];
  assert.deepEqual([held.level, held.start, held.n, held.agreement], [1, 1, 20, 1]);

  // 7c. next run: an L1 slice's ranked card predicted `accept` skips the person's pre-triage; acceptance stays human
  const run4 = cli('run', 'start', '--mode', 'full', '--harness', 'claude-code', '--model', 'm').out.run_id;
  const [nextCard] = proposeFile(run4, 'run4.jsonl', [candidate({ lens: 'doc-drift', kind: 'stale', topic: 'start command renamed', anchors: ['docs/setup.md#start'],
    title: 'Start command renamed', evidence: [SETUP2], impact: 6, impact_why: 'Every new developer hits it', predicted_verdict: 'accept', predicted_why: 'a broken first step' })]);
  assert.equal(cli('verify', '--run', run4).code, 0);
  const pre = cli('pretriage', '--run', run4);
  assert.equal(pre.code, 0, pre.stdout);
  assert.deepEqual(pre.out.pretriaged.map((/** @type {any} */ p) => [p.fp, p.level]), [[nextCard.fp, 1]]);
  const machineAccept = cli('move', nextCard.fp, '--to', 'accepted', '--by', 'machine:dowser');
  assert.equal(machineAccept.code, 2, 'the machine never accepts: verified -> accepted stays human-only');
  const ob4 = cli('outbox', '--run', run4);
  assert.equal(JSON.parse(ob4.out.proposals_json)[0].pretriaged_by, 'machine:dowser');
  const push4 = await tool('dowser_proposals_push', ob4.out);
  assert.equal(cli('ingest-push', '--file', save('push4.json', push4)).code, 0);
  const marked = await invoke('inbox.list', { project_key: projectKey, pretriaged: true });
  assert.deepEqual(marked.groups.flatMap((/** @type {any} */ g) => g.items).map((/** @type {any} */ c) => [c.fp, c.pretriaged_by]), [[nextCard.fp, 'machine:dowser']],
    'the inbox filters to the machine pre-triaged cards');

  // 7d. the person rejects the machine's pre-triage: a reversal, so the slice drops back to L0 and says why
  await invoke('verdict.reject', { refs: [push4.results[0].external_ref], reason: 'false-positive' });
  const page4 = await tool('dowser_verdicts_pull', { project_key: projectKey, cursor: page3.cursor });
  const iv4 = cli('ingest-verdicts', '--file', save('verdicts4.json', page4));
  assert.equal(iv4.code, 0, iv4.stdout);
  assert.deepEqual(iv4.out.trust_events.map((/** @type {any} */ e) => [e.from, e.to, e.item_id]), [[1, 0, nextCard.fp]]);
  assert.match(iv4.out.trust_events[0].reason, /^reversal: forge:local-user rejected/);

  // 7e. trust reaches the Learning tab through dowser_reflect_sync
  const ex3 = cli('reflect', 'export').out;
  assert.ok(ex3.trust_json);
  await tool('dowser_reflect_sync', ex3);
  const rd3 = await invoke('reflect.data', { project_key: projectKey });
  const slice = rd3.trust.slices.find((/** @type {any} */ s) => s.slice === SLICE);
  assert.deepEqual([slice.level, slice.ceiling, slice.start], [0, 1, 1], 'a technical slice starts at L1 and a reversal took it to L0');
  assert.deepEqual(rd3.trust.events.filter((/** @type {any} */ e) => e.slice === SLICE).map((/** @type {any} */ e) => [e.from, e.to]), [[1, 0]]);
  assert.deepEqual(listFiles(repo), filesBefore, 'nothing written inside the repo');
});
