// @ts-check
// Per-lens direction (lens-quality-plan WP3): `ingest-direction` caches a dowser_direction_get response on the run,
// replaces it on re-ingest, skips and reports a bad lens, refuses a run that is not running; `context --lens`
// carries `direction` only for the lens that has one. The last test takes a seeded direction from the mock Forge
// over stdio, as a harness would, and ingests what it returned.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitRepo, listFiles, removeDir, tempDir } from './_fixture.mjs';
import { checkDirection } from '../lib/direction.mjs';

const CLI = fileURLToPath(new URL('../dowser.mjs', import.meta.url));
const MOCK = fileURLToPath(new URL('../../../tools/mock-forge-mcp.mjs', import.meta.url));
const PK = 'github-com-Acme-Shop';

/** @type {string} */ let home;
/** @type {string} */ let repo;
/** @type {string} */ let work;

before(() => {
  home = tempDir('dir-home');
  repo = tempDir('dir-repo');
  work = tempDir('dir-work');
  gitRepo(repo, { 'src/a.js': 'export const a = 1;\n' });
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/Acme/Shop.git'], { stdio: 'ignore' });
});
after(() => { removeDir(home); removeDir(repo); removeDir(work); });

/**
 * @param {string[]} args
 * @returns {{code: number | null, out: any, stderr: string}}
 */
function cli(...args) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--repo', repo], { encoding: 'utf8', env: { ...process.env, DOWSER_HOME: home }, cwd: work });
  /** @type {any} */
  let out;
  try { out = JSON.parse(r.stdout); } catch { out = undefined; }
  return { code: r.status, out, stderr: r.stderr };
}

/** @param {string} name @param {unknown} doc */
const save = (name, doc) => { const f = join(work, name); writeFileSync(f, JSON.stringify(doc, null, 2)); return f; };

test('checkDirection: normalises, enforces the caps, spaces only for doc-drift', () => {
  assert.deepEqual(checkDirection('opportunity', { focus: [' a ', ''], exclude: [], notes: '  n ' }), { focus: ['a'], notes: 'n' });
  assert.equal(checkDirection('opportunity', {}), undefined);
  assert.deepEqual(checkDirection('doc-drift', { spaces: ['DOCS', '~pat'] }), { spaces: ['DOCS', '~pat'] });
  for (const [lens, bad] of /** @type {[string, unknown][]} */ ([
    ['opportunity', { spaces: ['DOCS'] }], ['doc-drift', { spaces: ['no spaces'] }], ['opportunity', { focus: Array(11).fill('x') }],
    ['opportunity', { focus: ['x'.repeat(121)] }], ['opportunity', { exclude: ['a\nb'] }], ['opportunity', { notes: 'n'.repeat(2001) }],
    ['opportunity', { focus: 'a' }], ['opportunity', { other: 1 }], ['opportunity', 'x'],
  ])) assert.throws(() => checkDirection(lens, bad), JSON.stringify(bad).slice(0, 60));
});

test('ingest-direction caches per lens, replaces on re-ingest, skips a bad lens; context carries only that lens', () => {
  const filesBefore = listFiles(repo);
  assert.equal(cli('init').code, 0);
  const runId = cli('run', 'start', '--mode', 'focused', '--focus', 'area:src').out.run_id;

  const first = cli('ingest-direction', '--run', runId, '--file', save('d1.json', {
    lenses: {
      'doc-drift': { focus: ['setup guide'], spaces: ['DOCS'] },
      opportunity: { focus: ['checkout', 'exports'], exclude: ['admin pages'], notes: 'Q4 is about retention.' },
    },
  }));
  assert.equal(first.code, 0, first.stderr);
  assert.deepEqual(first.out, { run_id: runId, lenses: ['opportunity', 'doc-drift'] });

  const opp = cli('context', '--run', runId, '--lens', 'opportunity').out;
  assert.deepEqual(opp.direction, { focus: ['checkout', 'exports'], exclude: ['admin pages'], notes: 'Q4 is about retention.' });
  assert.equal(opp.focus, 'area:src', 'the local --focus still applies on top');
  assert.deepEqual(cli('context', '--run', runId, '--lens', 'doc-drift').out.direction, { focus: ['setup guide'], spaces: ['DOCS'] });
  assert.equal('direction' in cli('context', '--run', runId, '--lens', 'ux-friction').out, false, 'no direction, no key');

  // a re-ingest replaces the run's directions whole; an unknown lens and an over-cap lens are skipped and reported
  const second = cli('ingest-direction', '--run', runId, '--file', save('d2.json', {
    structuredContent: { lenses: { 'ux-friction': { focus: ['onboarding'] }, nope: { focus: ['x'] }, 'security-cra': { spaces: ['SEC'] } } },
  }));
  assert.equal(second.code, 1);
  assert.deepEqual(second.out.lenses, ['ux-friction']);
  assert.deepEqual(second.out.skipped.map((/** @type {any} */ s) => s.lens), ['nope', 'security-cra']);
  assert.equal('direction' in cli('context', '--run', runId, '--lens', 'opportunity').out, false, 'replaced: opportunity is gone');
  assert.deepEqual(cli('context', '--run', runId, '--lens', 'ux-friction').out.direction, { focus: ['onboarding'] });

  // an empty answer clears the run's directions
  assert.deepEqual(cli('ingest-direction', '--run', runId, '--file', save('d3.json', { lenses: {} })).out, { run_id: runId, lenses: [] });
  assert.equal('direction' in cli('context', '--run', runId, '--lens', 'ux-friction').out, false);

  // not a direction response (an error result), and a run that is not running
  assert.equal(cli('ingest-direction', '--run', runId, '--file', save('e.json', { error: 'unknown-project', message: 'm' })).code, 2);
  assert.equal(cli('run', 'finish', '--run', runId, '--lenses', '{}').code, 0);
  const done = cli('ingest-direction', '--run', runId, '--file', save('d4.json', { lenses: {} }));
  assert.equal(done.code, 2);
  assert.match(done.stderr, /not running/);
  assert.equal(cli('ingest-direction', '--run', 'no-such-run', '--file', save('d5.json', { lenses: {} })).code, 2);
  assert.deepEqual(listFiles(repo), filesBefore, 'nothing written into the scanned repo');
});

test('mock Forge over stdio: a seeded direction comes back from dowser_direction_get and lands in context', async () => {
  const seed = save('seed.json', { directions: { [PK]: { lenses: { 'doc-drift': { exclude: ['changelog'], spaces: ['DOCS', 'ENG'] }, opportunity: { notes: 'Retention first.' } } } } });
  const server = spawn(process.execPath, [MOCK, '--seed', seed], { stdio: ['pipe', 'pipe', 'pipe'] });
  /** @type {Map<number, (msg: any) => void>} */
  const pending = new Map();
  createInterface({ input: server.stdout }).on('line', (line) => { const m = JSON.parse(line); pending.get(m.id)?.(m); pending.delete(m.id); });
  let id = 1;
  /** @param {string} method @param {unknown} [params] @returns {Promise<any>} */
  const rpc = (method, params) => new Promise((done, fail) => {
    const n = id++;
    const t = setTimeout(() => fail(new Error(`${method}: no reply`)), 10000);
    pending.set(n, (m) => { clearTimeout(t); done(m); });
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
  });
  try {
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    const tools = (await rpc('tools/list')).result.tools;
    const t = tools.find((/** @type {any} */ x) => x.name === 'dowser_direction_get');
    assert.ok(t, 'the tool is listed');
    for (const v of Object.values(t.inputSchema.properties)) assert.equal(/** @type {any} */ (v).type, 'string');

    const unknown = (await rpc('tools/call', { name: 'dowser_direction_get', arguments: { project_key: 'other', lens: 'all' } })).result;
    assert.equal(unknown.isError, true);
    assert.equal(unknown.structuredContent.error, 'unknown-project');
    const one = (await rpc('tools/call', { name: 'dowser_direction_get', arguments: { project_key: PK, lens: 'opportunity' } })).result;
    assert.deepEqual(one.structuredContent, { lenses: { opportunity: { notes: 'Retention first.' } } });

    const r = (await rpc('tools/call', { name: 'dowser_direction_get', arguments: { project_key: PK, lens: 'all' } })).result;
    assert.notEqual(r.isError, true);
    const file = save('direction.json', r); // the agent saves the result envelope verbatim
    assert.equal(cli('init').code, 0);
    const runId = cli('run', 'start', '--mode', 'full').out.run_id;
    const ing = cli('ingest-direction', '--run', runId, '--file', file);
    assert.equal(ing.code, 0, ing.stderr);
    assert.deepEqual(ing.out.lenses, ['opportunity', 'doc-drift']);
    assert.deepEqual(cli('context', '--run', runId, '--lens', 'doc-drift').out.direction, { exclude: ['changelog'], spaces: ['DOCS', 'ENG'] });
  } finally {
    server.kill();
  }
});
