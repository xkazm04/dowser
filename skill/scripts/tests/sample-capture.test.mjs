// @ts-check
// tools/sample-capture.mjs builds the public sample inbox (forge/src/sample/self-scan.json). Its header promises a
// deterministic file that Forge loads; this checks both against a real store built through the CLI.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { candidate, gitRepo, listFiles, removeDir, tempDir } from './_fixture.mjs';
import { STORE_OWNED } from '../lib/model.mjs';
import { SAMPLE_SCHEMA, capture, parseArgs } from '../../../tools/sample-capture.mjs';

const CLI = fileURLToPath(new URL('../dowser.mjs', import.meta.url));
const URL_ = 'https://github.com/xkazm04/dowser';

/** @type {string} */ let home;
/** @type {string} */ let repo;
/** @type {string} */ let work;
/** @type {string} */ let runId;
const before_ = { home: process.env.DOWSER_HOME };

before(() => {
  home = tempDir('cap-home');
  repo = tempDir('cap-repo');
  work = tempDir('cap-work');
  gitRepo(repo, { 'src/auth.js': 'export function login(user) {\n  return check(user.password);\n}\n', 'src/export.js': 'export const exportReport = () => 1;\n' });
});
after(() => {
  if (before_.home === undefined) delete process.env.DOWSER_HOME; else process.env.DOWSER_HOME = before_.home;
  removeDir(home); removeDir(repo); removeDir(work);
});

/** @param {string[]} args */
function cli(...args) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--repo', repo], { encoding: 'utf8', env: { ...process.env, DOWSER_HOME: home }, cwd: work });
  /** @type {any} */
  let out;
  try { out = JSON.parse(r.stdout); } catch { out = undefined; }
  return { code: r.status, out, stdout: r.stdout, stderr: r.stderr };
}

test('setup: a done run with two verified cards', () => {
  assert.equal(cli('init').code, 0);
  runId = cli('run', 'start', '--mode', 'full').out.run_id;
  const lines = [
    candidate({ lens: 'security-cra', kind: 'secret-exposure', topic: 'plaintext password', impact: 8, impact_why: 'a live credential path' }),
    candidate({ lens: 'opportunity', kind: 'missing-capability', topic: 'csv export', anchors: ['src/export.js#exportReport'], title: 'Add CSV export',
      evidence: [{ type: 'code', ref: 'src/export.js:1', quote: 'export const exportReport = () => 1;' }] }),
  ];
  writeFileSync(join(work, 'c.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const p = cli('propose', '--run', runId, '--file', join(work, 'c.jsonl'));
  assert.equal(p.code, 0, p.stdout + p.stderr);
  assert.equal(cli('verify', '--run', runId).code, 0);
  const fin = cli('run', 'finish', '--run', runId, '--lenses', '{}');
  assert.equal(fin.code, 0, fin.stderr);
});

test('capture: dowser-sample/1, cards sorted lens-first, no store-owned key, every card Forge-checked; byte-equal on a second call', async () => {
  const filesBefore = listFiles(repo);
  const doc = await capture({ home, repo, repoUrl: URL_ });
  assert.equal(doc.schema, SAMPLE_SCHEMA);
  assert.equal(doc.source.repo_url, URL_);
  assert.equal(doc.source.run_id, runId);
  assert.match(doc.source.head_sha, /^[0-9a-f]{40}$/);
  assert.deepEqual(doc.proposals.map((/** @type {any} */ p) => p.lens), ['opportunity', 'security-cra'], 'lens order of LENSES');
  for (const p of doc.proposals) {
    assert.equal(p.status, 'verified');
    for (const k of STORE_OWNED.filter((k) => k !== 'status')) assert.equal(k in p, false, `${p.fp} carries ${k}`);
  }
  assert.deepEqual(Object.keys(JSON.parse(doc.lens_kinds_json)), ['opportunity', 'security-cra']);
  assert.ok(Array.isArray(doc.areas) && doc.areas.some((/** @type {any} */ a) => a.path === 'src'));
  const again = await capture({ home, repo, repoUrl: URL_ });
  assert.equal(JSON.stringify(again), JSON.stringify(doc), 'deterministic for a given store');
  assert.deepEqual(listFiles(repo), filesBefore, 'nothing written into the scanned repo');
});

test('capture refuses a run that is not done or does not exist', async () => {
  await assert.rejects(capture({ home, repo, run: 'no-such-run', repoUrl: URL_ }), /does not exist/);
});

test('parseArgs: required flags, an https URL without credentials, resolved paths', () => {
  const base = ['--home', 'h', '--repo', 'r', '--repo-url', URL_, '--out', 'o.json'];
  const o = parseArgs(base);
  assert.equal(o.repoUrl, URL_);
  assert.ok(o.out.endsWith('o.json') && o.out !== 'o.json', 'out is resolved');
  assert.throws(() => parseArgs(base.map((a) => (a === URL_ ? 'https://user:tok@github.com/xkazm04/dowser' : a))), /without credentials/);
  assert.throws(() => parseArgs(base.map((a) => (a === URL_ ? 'ftp://github.com/x/y' : a))), /web URL/);
  assert.throws(() => parseArgs(base.slice(2)), /--home is required/);
  assert.throws(() => parseArgs([...base, '--nope', 'x']), /unknown argument/);
  assert.throws(() => parseArgs(['--home']), /needs a value/);
});
