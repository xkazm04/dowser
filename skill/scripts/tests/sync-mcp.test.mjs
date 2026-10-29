// @ts-check
// Smoke test of the Forge seam (forge-mcp-2) end to end: the mock Forge MCP server spawned over stdio and spoken to
// in JSON-RPC (as a harness would), and the dowser CLI as a child process ingesting what the tools returned (D11:
// the agent carries the payload between them; this test plays the agent).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { candidate, gitRepo, listFiles, removeDir, tempDir } from './_fixture.mjs';
import { callTool, emptyBackend } from '../../../tools/mock-forge-mcp.mjs';

const CLI = fileURLToPath(new URL('../dowser.mjs', import.meta.url));
const MOCK = fileURLToPath(new URL('../../../tools/mock-forge-mcp.mjs', import.meta.url));

/** @type {string} */ let home;
/** @type {string} */ let repo;
/** @type {string} */ let work;
/** @type {import('node:child_process').ChildProcessWithoutNullStreams} */ let server;
/** @type {Map<number, (msg: any) => void>} */
const pending = new Map();
let nextId = 1;

before(() => {
  home = tempDir('mcp-home');
  repo = tempDir('mcp-repo');
  work = tempDir('mcp-work');
  gitRepo(repo, { 'src/auth.js': 'export function login(user) {\n  return check(user.password);\n}\n', 'docs/guide/setup.md': '# Setup\n' });
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://x-token:secret@github.com/Acme/Shop.git'], { stdio: 'ignore' });
  const seed = join(work, 'seed.json');
  writeFileSync(seed, JSON.stringify({
    tickets: [
      { ref: 'SUP-1', title: 'Password stored in plain text?', url: 'https://mock-forge.example/browse/SUP-1', body: 'A customer asks how passwords are stored.', created_at: '2026-10-01T00:00:00Z', labels: ['security'] },
      { ref: 'SUP-2', title: 'Dark mode', url: 'https://mock-forge.example/browse/SUP-2', body: 'Please add dark mode.', created_at: '2026-10-02T00:00:00Z' },
    ],
    pages: [], goals: [{ ref: 'GOAL-1', title: 'Pass the CRA audit', url: 'https://mock-forge.example/goal/1', body: 'b', status: 'on-track' }],
  }));
  server = spawn(process.execPath, [MOCK, '--seed', seed], { stdio: ['pipe', 'pipe', 'pipe'] });
  createInterface({ input: server.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  });
});
after(() => { server.kill(); removeDir(home); removeDir(repo); removeDir(work); });

/**
 * One JSON-RPC request to the mock.
 * @param {string} method
 * @param {unknown} [params]
 * @returns {Promise<any>}
 */
function rpc(method, params) {
  const id = nextId++;
  return new Promise((done, fail) => {
    const t = setTimeout(() => fail(new Error(`${method}: no reply`)), 10000);
    pending.set(id, (msg) => { clearTimeout(t); done(msg); });
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

/**
 * Calls a tool; returns the parsed JSON of its text content (what the agent saves verbatim).
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @returns {Promise<any>}
 */
async function tool(name, args) {
  const r = await rpc('tools/call', { name, arguments: args });
  assert.ok(r.result, JSON.stringify(r));
  assert.notEqual(r.result.isError, true, r.result.content?.[0]?.text);
  const out = JSON.parse(r.result.content[0].text);
  assert.deepEqual(r.result.structuredContent, out);
  return out;
}

/**
 * @param {string[]} args
 * @returns {{code: number | null, out: any, lines: any[], stderr: string}}
 */
function cli(...args) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--repo', repo], { encoding: 'utf8', env: { ...process.env, DOWSER_HOME: home }, cwd: work });
  /** @type {any} */
  let out;
  try { out = JSON.parse(r.stdout); } catch { out = undefined; }
  return { code: r.status, out, lines: out !== undefined ? [out] : r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l)), stderr: r.stderr };
}

/**
 * Saves a tool response verbatim, as SKILL.md tells the agent to.
 * @param {string} name
 * @param {unknown} doc
 */
const save = (name, doc) => { const f = join(work, name); writeFileSync(f, JSON.stringify(doc, null, 2)); return f; };

test('mock Forge over stdio: push to the inbox, accept with a Jira issue, idempotent ingest, reopen on growth, areas', async () => {
  const filesBefore = listFiles(repo);
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const tools = (await rpc('tools/list')).result.tools;
  const names = tools.map((/** @type {any} */ t) => t.name);
  for (const n of ['dowser_sources_tickets', 'dowser_sources_pages', 'dowser_sources_goals', 'dowser_proposals_push', 'dowser_verdicts_pull', 'dowser_areas_push', 'mock_decide', 'mock_inbox']) {
    assert.ok(names.includes(n), n);
  }
  for (const t of tools) {
    for (const [k, v] of Object.entries(t.inputSchema.properties)) {
      assert.ok(['string', 'integer'].includes(/** @type {any} */ (v).type), `${t.name}.${k} is scalar, as rovo:mcp requires`);
    }
  }
  assert.equal((await rpc('nope/method')).error.code, -32601);

  const di = cli('init');
  assert.equal(di.code, 0, di.stderr);
  const projectKey = di.out.project_key;
  assert.equal(projectKey, 'github-com-Acme-Shop');
  assert.equal(di.out.verdicts_cursor, undefined, 'no cursor before the first pull');
  const start = cli('run', 'start', '--mode', 'full', '--harness', 'claude-code', '--model', 'm');
  assert.equal(start.code, 0, start.stderr);
  const runId = start.out.run_id;
  const headSha = start.out.head_sha;
  assert.match(headSha, /^[0-9a-f]{40}$/);

  // sources: the agent calls the tool, saves the response, ingests it, cites the returned ref
  const tickets = await tool('dowser_sources_tickets', { query: 'password OR passwords', limit: 50 });
  assert.deepEqual(tickets.items.map((/** @type {any} */ t) => t.ref), ['SUP-1']);
  const src = cli('ingest-sources', '--run', runId, '--type', 'ticket', '--file', save('tickets.json', tickets));
  assert.equal(src.code, 0, src.stderr);
  const cite = src.out.refs[0];
  assert.equal((await tool('dowser_sources_goals', {})).items[0].status, 'on-track');

  const code = { type: 'code', ref: 'src/auth.js:2', quote: 'return check(user.password);' };
  writeFileSync(join(work, 'sec.jsonl'), [
    candidate({ evidence: [code, { type: 'ticket', ref: cite.ref, url: cite.url }] }),
    candidate({ topic: 'Login has no rate limit', title: 'Login can be brute-forced', kind: 'vuln', evidence: [code] }),
  ].map((c) => JSON.stringify(c)).join('\n') + '\n');
  const prop = cli('propose', '--run', runId, '--file', join(work, 'sec.jsonl'), '--kinds', 'security-cra=secret,vuln');
  assert.equal(prop.code, 0, prop.stderr);
  const [fp, fp2] = [prop.lines[0].fp, prop.lines[1].fp];
  assert.equal(cli('verify', '--run', runId).code, 0);

  // push: outbox prints the tool arguments exactly; the agent passes them unedited
  const ob = cli('outbox', '--run', runId);
  assert.equal(ob.code, 0, ob.stderr);
  assert.deepEqual(Object.keys(ob.out).sort(), ['head_sha', 'project_key', 'proposals_json', 'repo_url', 'run_id']);
  assert.equal(ob.out.project_key, projectKey);
  assert.equal(ob.out.repo_url, 'https://github.com/Acme/Shop', 'credentials and .git stripped');
  assert.equal(ob.out.head_sha, headSha);
  const sent = JSON.parse(ob.out.proposals_json);
  assert.deepEqual(sent.map((/** @type {any} */ p) => p.fp).sort(), [fp, fp2].sort());
  // the CLI passes the runner's quotes preference to outbox: omit sends quote_sha instead of the line
  assert.equal(cli('prefs', 'set', 'quotes=omit').code, 0);
  const withheld = JSON.parse(cli('outbox', '--run', runId).out.proposals_json).flatMap((/** @type {any} */ p) => p.evidence);
  assert.ok(withheld.every((/** @type {any} */ e) => e.type !== 'code' || (!('quote' in e) && /^[0-9a-f]{16}$/.test(e.quote_sha))));
  assert.equal(cli('prefs', 'set', 'quotes=send').code, 0);
  const pushed = await tool('dowser_proposals_push', ob.out);
  assert.deepEqual(pushed.results.map((/** @type {any} */ r) => r.result), ['created', 'created']);
  const refOf = (/** @type {string} */ f) => pushed.results.find((/** @type {any} */ r) => r.fp === f).external_ref;
  assert.deepEqual([refOf(sent[0].fp), refOf(sent[1].fp)], ['DW-1', 'DW-2'], 'a push files inbox items, not Jira issues');
  const ip = cli('ingest-push', '--file', save('push.json', pushed));
  assert.equal(ip.code, 0, ip.stderr);
  assert.deepEqual(ip.out.results.map((/** @type {any} */ r) => r.outcome), ['pushed', 'pushed']);
  assert.deepEqual(JSON.parse(cli('outbox', '--run', runId).out.proposals_json), [], 'nothing left to push');

  // a bad proposals_json is a bad-input tool error
  const badPush = await rpc('tools/call', { name: 'dowser_proposals_push', arguments: { project_key: projectKey, run_id: runId, proposals_json: '[{' } });
  assert.equal(badPush.result.isError, true);
  assert.equal(JSON.parse(badPush.result.content[0].text).error, 'bad-input');

  // a person accepts the first item in the inbox: the accept creates the Jira issue, the verdict carries it
  await tool('mock_decide', { fp, status: 'accepted', decided_by: 'forge:jane' });
  const page = await tool('dowser_verdicts_pull', { project_key: projectKey });
  assert.equal(page.verdicts.length, 1);
  assert.equal(page.verdicts[0].external_ref, refOf(fp));
  assert.match(page.verdicts[0].issue_ref, /^MOCK-\d+$/);
  const vf = save('verdicts.json', page);
  const iv = cli('ingest-verdicts', '--file', vf);
  assert.equal(iv.code, 0, iv.stderr);
  assert.equal(iv.out.verdicts[0].outcome, 'applied');
  const shown = cli('show', fp);
  assert.equal(shown.out.card.status, 'accepted');
  assert.equal(shown.out.issue_ref, page.verdicts[0].issue_ref, 'show carries the Jira issue');
  assert.equal(shown.out.issue_url, page.verdicts[0].issue_url);
  assert.equal(shown.out.external_ref, refOf(fp), 'external_ref stays the inbox item');

  const refused = cli('move', fp, '--to', 'verified', '--by', 'human:probe');
  assert.equal(refused.code, 2, 'accepted -> verified is refused');
  assert.equal(refused.out.current, 'accepted');
  assert.equal(refused.out.error, 'refused');

  // re-ingesting the same file is a no-op
  const again = cli('ingest-verdicts', '--file', vf);
  assert.equal(again.code, 0);
  assert.equal(again.out.verdicts[0].outcome, 'already-applied');

  // the cursor is stored and handed to the agent by init; the next pull from it is empty
  const di2 = cli('init');
  assert.equal(di2.out.verdicts_cursor, page.cursor);
  assert.deepEqual((await tool('dowser_verdicts_pull', { project_key: projectKey, cursor: di2.out.verdicts_cursor })).verdicts, []);

  // the second item is snoozed in the inbox; new evidence resurfaces it locally and the re-push reopens it
  await tool('mock_decide', { fp: fp2, status: 'snoozed', decided_by: 'forge:jane' });
  const page2 = await tool('dowser_verdicts_pull', { project_key: projectKey, cursor: di2.out.verdicts_cursor });
  assert.equal(cli('ingest-verdicts', '--file', save('verdicts2.json', page2)).code, 0);
  assert.equal(cli('show', fp2).out.card.status, 'snoozed');
  writeFileSync(join(work, 'grow.jsonl'), `${JSON.stringify(candidate({
    topic: 'Login has no rate limit', title: 'Login can be brute-forced', kind: 'vuln', evidence: [code, { type: 'ticket', ref: cite.ref, url: cite.url }],
  }))}\n`);
  const grow = cli('propose', '--run', runId, '--file', join(work, 'grow.jsonl'), '--kinds', 'security-cra=secret,vuln');
  assert.equal(grow.code, 0, grow.stderr);
  assert.equal(grow.lines[0].result, 'evidence-grew');
  assert.equal(cli('verify', '--run', runId).code, 0);
  const ob2 = cli('outbox', '--run', runId);
  assert.deepEqual(JSON.parse(ob2.out.proposals_json).map((/** @type {any} */ p) => p.fp), [fp2]);
  const repush = await tool('dowser_proposals_push', ob2.out);
  assert.deepEqual(repush.results.map((/** @type {any} */ r) => [r.fp, r.result, r.external_ref]), [[fp2, 'updated', refOf(fp2)]], 'a re-push never duplicates');
  const inbox = await tool('mock_inbox', { fp: fp2 });
  assert.equal(inbox.item.status, 'open');
  assert.equal(inbox.item.reopened, true, 'grown evidence reopens a snoozed item');
  assert.equal(inbox.item.evidence, 2, 'evidence is united by key');
  const ip2 = cli('ingest-push', '--file', save('push2.json', repush));
  assert.equal(ip2.code, 0, ip2.stderr);
  assert.equal(cli('show', fp2).out.card.status, 'pushed');

  // areas: printed arguments go to dowser_areas_push unedited; no ingest step
  const ar = cli('areas', '--run', runId);
  assert.equal(ar.code, 0, ar.stderr);
  const areas = JSON.parse(ar.out.areas_json);
  assert.deepEqual(areas.map((/** @type {any} */ a) => a.path).sort(), ['docs', 'docs/guide', 'src']);
  const stored = await tool('dowser_areas_push', ar.out);
  assert.deepEqual(stored, { stored: areas.length });
  const badAreas = await rpc('tools/call', { name: 'dowser_areas_push', arguments: { ...ar.out, areas_json: JSON.stringify([{ path: 'a/b/c', files: 1, churn_90d: 0 }]) } });
  assert.equal(badAreas.result.isError, true, 'a path deeper than two levels is bad input');

  // a bad call is an isError tool result, not a protocol error
  const bad = await rpc('tools/call', { name: 'dowser_verdicts_pull', arguments: { project_key: projectKey, cursor: 'zzz' } });
  assert.equal(bad.result.isError, true);
  assert.equal(JSON.parse(bad.result.content[0].text).error, 'bad-cursor');

  assert.deepEqual(listFiles(repo), filesBefore, 'nothing written inside the repo');
});

test('mock Forge backend: reopen rules (snoozed any new key, rejected by resurfaces, accepted never), caps, areas replace', () => {
  const b = emptyBackend();
  const code = { type: 'code', ref: 'src/a.js:1', quote: 'x' };
  /** @param {string} fp @param {Record<string, unknown>[]} evidence */
  const rec = (fp, evidence) => ({ fp, title: 't', status: 'verified', evidence });
  /** @param {Record<string, unknown>[]} records */
  const push = (records) => callTool(b, 'dowser_proposals_push', { project_key: 'pk', run_id: 'r', proposals_json: JSON.stringify(records) }).results;
  /** @param {string} fp */
  const item = (fp) => callTool(b, 'mock_inbox', { fp }).item;
  const [rej, acc] = ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'];
  const codeB = { type: 'code', ref: 'src/b.js:1', quote: 'y' };
  assert.deepEqual(push([rec(rej, [code, codeB]), rec(acc, [code])]).map((/** @type {any} */ r) => r.external_ref), ['DW-1', 'DW-2']);

  callTool(b, 'mock_decide', { fp: rej, status: 'rejected', reason: 'not-worth-it' });
  push([rec(rej, [code, codeB])]);
  assert.equal(item(rej).status, 'rejected', 'a re-push with no new key changes nothing');
  push([rec(rej, [code, { type: 'ticket', ref: 'SUP-1' }])]);
  assert.equal(item(rej).status, 'rejected', '3 refs with a new type, but not 2x the 2 it had: still rejected');
  push([rec(rej, [{ type: 'ticket', ref: 'SUP-2' }])]);
  assert.deepEqual([item(rej).status, item(rej).reopened, item(rej).evidence], ['open', true, 4], 'a new type and 2x refs reopens it');

  callTool(b, 'mock_decide', { fp: acc, status: 'accepted' });
  assert.match(item(acc).issue_ref, /^MOCK-\d+$/);
  push([rec(acc, [{ type: 'ticket', ref: 'SUP-9' }, { type: 'page', ref: 'P-1' }])]);
  assert.deepEqual([item(acc).status, item(acc).evidence], ['accepted', 3], 'an accepted item only gains evidence');

  assert.throws(() => push(Array.from({ length: 51 }, (_, i) => rec(String(i).padStart(16, 'c'), [code]))), /at most 50/);
  assert.throws(() => callTool(b, 'dowser_proposals_push', { project_key: 'pk', run_id: 'r', proposals_json: '{}' }), /JSON array/);

  const areas = (/** @type {unknown[]} */ list) => callTool(b, 'dowser_areas_push', { project_key: 'pk', run_id: 'r', areas_json: JSON.stringify(list) });
  assert.deepEqual(areas([{ path: 'src', files: 2, churn_90d: 1, authors_90d: 1 }, { path: 'src/x', files: 1, churn_90d: 0 }]), { stored: 2 });
  assert.deepEqual(areas([{ path: 'lib', files: 1, churn_90d: 0, last_change: '2026-01-01T00:00:00.000Z' }]), { stored: 1 });
  assert.deepEqual(b.projects.pk.areas.map((a) => a.path), ['lib'], 'the set replaces the previous one whole');
  for (const bad of [
    [{ path: 'src/', files: 1, churn_90d: 0 }], [{ path: 'src', files: 0, churn_90d: 0 }], [{ path: 'src', files: 1, churn_90d: 0, authors_90d: 1 }],
    [{ path: 'src', files: 1, churn_90d: 1, authors_90d: null }], [{ path: 'src', files: 1, churn_90d: 0 }, { path: 'src', files: 1, churn_90d: 0 }],
  ]) assert.throws(() => areas(bad), /areas_json/, JSON.stringify(bad));
});
