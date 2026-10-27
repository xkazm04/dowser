// @ts-check
// Smoke test of the Forge seam end to end: the mock Forge MCP server spawned over stdio and spoken to in JSON-RPC
// (as a harness would), and the dowser CLI as a child process ingesting what the tools returned (D11: the agent
// carries the payload between them; this test plays the agent).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { candidate, gitRepo, listFiles, removeDir, tempDir } from './_fixture.mjs';

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
  gitRepo(repo, { 'src/auth.js': 'export function login(user) {\n  return check(user.password);\n}\n' });
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

test('mock Forge over stdio: push, verdict, idempotent ingest, re-push updates', async () => {
  const filesBefore = listFiles(repo);
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const names = (await rpc('tools/list')).result.tools.map((/** @type {any} */ t) => t.name);
  for (const n of ['dowser_sources_tickets', 'dowser_sources_pages', 'dowser_sources_goals', 'dowser_proposals_push', 'dowser_verdicts_pull', 'mock_decide']) {
    assert.ok(names.includes(n), n);
  }
  assert.equal((await rpc('nope/method')).error.code, -32601);

  const di = cli('init');
  assert.equal(di.code, 0, di.stderr);
  const projectKey = di.out.project_key;
  assert.equal(di.out.verdicts_cursor, undefined, 'no cursor before the first pull');
  const start = cli('run', 'start', '--mode', 'full', '--harness', 'claude-code', '--model', 'm');
  assert.equal(start.code, 0, start.stderr);
  const runId = start.out.run_id;

  // sources: the agent calls the tool, saves the response, ingests it, cites the returned ref
  const tickets = await tool('dowser_sources_tickets', { query: 'password OR passwords', limit: 50 });
  assert.deepEqual(tickets.items.map((/** @type {any} */ t) => t.ref), ['SUP-1']);
  const src = cli('ingest-sources', '--run', runId, '--type', 'ticket', '--file', save('tickets.json', tickets));
  assert.equal(src.code, 0, src.stderr);
  const cite = src.out.refs[0];
  assert.equal((await tool('dowser_sources_goals', {})).items[0].status, 'on-track');

  writeFileSync(join(work, 'sec.jsonl'), `${JSON.stringify(candidate({
    evidence: [{ type: 'code', ref: 'src/auth.js:2', quote: 'return check(user.password);' }, { type: 'ticket', ref: cite.ref, url: cite.url }],
  }))}\n`);
  const prop = cli('propose', '--run', runId, '--file', join(work, 'sec.jsonl'), '--kinds', 'security-cra=secret,vuln');
  assert.equal(prop.code, 0, prop.stderr);
  const fp = prop.lines[0].fp;
  assert.equal(cli('verify', '--run', runId).code, 0);

  // push
  const ob = cli('outbox', '--run', runId);
  assert.equal(ob.code, 0, ob.stderr);
  assert.equal(ob.out.project_key, projectKey);
  assert.deepEqual(ob.out.proposals.map((/** @type {any} */ p) => p.fp), [fp]);
  const pushed = await tool('dowser_proposals_push', ob.out);
  assert.equal(pushed.results[0].result, 'created');
  const ip = cli('ingest-push', '--file', save('push.json', pushed));
  assert.equal(ip.code, 0, ip.stderr);
  assert.equal(ip.out.results[0].outcome, 'pushed');
  const show1 = cli('outbox', '--run', runId);
  assert.deepEqual(show1.out.proposals, [], 'nothing left to push');

  // a person rejects it in Jira; the next pull brings the verdict
  await tool('mock_decide', { fp, status: 'rejected', reason: 'already-known', note: 'tracked as SEC-12', decided_by: 'forge:jane' });
  const page = await tool('dowser_verdicts_pull', { project_key: projectKey });
  assert.equal(page.verdicts.length, 1);
  const vf = save('verdicts.json', page);
  const iv = cli('ingest-verdicts', '--file', vf);
  assert.equal(iv.code, 0, iv.stderr);
  assert.equal(iv.out.verdicts[0].outcome, 'applied');

  const list = cli('move', fp, '--to', 'verified', '--by', 'human:probe');
  assert.equal(list.code, 2, 'rejected -> verified is refused');
  assert.equal(list.out.current, 'rejected');
  assert.equal(list.out.error, 'refused');

  // re-ingesting the same file is a no-op
  const again = cli('ingest-verdicts', '--file', vf);
  assert.equal(again.code, 0);
  assert.equal(again.out.verdicts[0].outcome, 'already-applied');

  // the cursor is stored and handed to the agent by init; the next pull from it is empty
  const di2 = cli('init');
  assert.equal(di2.out.verdicts_cursor, page.cursor);
  assert.deepEqual((await tool('dowser_verdicts_pull', { project_key: projectKey, cursor: di2.out.verdicts_cursor })).verdicts, []);

  // re-pushing the same fp updates the Jira item, never duplicates it
  const repush = await tool('dowser_proposals_push', ob.out);
  assert.deepEqual(repush.results.map((/** @type {any} */ r) => [r.fp, r.result, r.external_ref]), [[fp, 'updated', pushed.results[0].external_ref]]);

  // a bad call is an isError tool result, not a protocol error
  const bad = await rpc('tools/call', { name: 'dowser_verdicts_pull', arguments: { project_key: projectKey, cursor: 'zzz' } });
  assert.equal(bad.result.isError, true);
  assert.equal(JSON.parse(bad.result.content[0].text).error, 'bad-cursor');

  assert.deepEqual(listFiles(repo), filesBefore, 'nothing written inside the repo');
});
