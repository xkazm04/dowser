// @ts-check
// forge-mcp-2 helpers on the git side: the repo web URL `outbox` sends, and `areas` (per-directory files, churn
// and authors relative to the run's head commit) on a fixture with back-dated commits.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { webUrl } from '../lib/git.mjs';
import { areasOf } from '../lib/sync.mjs';
import { listFiles, removeDir, tempDir, writeFiles } from './_fixture.mjs';

const CLI = fileURLToPath(new URL('../dowser.mjs', import.meta.url));

test('webUrl: credentials and .git stripped, scp and ssh remotes become https, no web form -> undefined', () => {
  assert.equal(webUrl('https://x-token:abc@github.com/Acme/Shop.git'), 'https://github.com/Acme/Shop');
  assert.equal(webUrl('git@github.com:Acme/Shop.git'), 'https://github.com/Acme/Shop');
  assert.equal(webUrl('ssh://git@bitbucket.org:7999/acme/shop.git'), 'https://bitbucket.org/acme/shop');
  assert.equal(webUrl('git://GitHub.com/Acme/Shop/'), 'https://github.com/Acme/Shop');
  assert.equal(webUrl('http://user@git.local:8080/team/repo'), 'http://git.local:8080/team/repo');
  assert.equal(webUrl('/srv/git/repo.git'), undefined);
  assert.equal(webUrl('file:///srv/git/repo.git'), undefined);
  assert.equal(webUrl('C:\\repos\\shop'), undefined);
  assert.equal(webUrl('https://github.com/'), undefined);
});

test('areasOf: depth 1 and 2 only; a top-level file has none', () => {
  assert.deepEqual(areasOf('src/checkout/pay/a.js'), ['src', 'src/checkout']);
  assert.deepEqual(areasOf('src/a.js'), ['src']);
  assert.deepEqual(areasOf('README.md'), []);
});

/** @type {string} */ let home;
/** @type {string} */ let repo;

/**
 * Commits `files` with author and committer date both set to `at`.
 * @param {string} at
 * @param {string} email
 * @param {Record<string, string>} files
 */
function commitAt(at, email, files) {
  writeFiles(repo, files);
  const env = { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_NAME: email.split('@')[0] };
  execFileSync('git', ['-C', repo, 'add', '-A'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', `at ${at}`], { stdio: 'ignore', env });
}

before(() => {
  home = tempDir('areas-home');
  repo = tempDir('areas-repo');
  const git = (/** @type {string[]} */ ...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'committer@example.com');
  git('config', 'user.name', 'committer');
  git('config', 'core.autocrlf', 'false');
  commitAt('2026-01-01T10:00:00Z', 'alice@example.com', { 'src/a.js': '1\n', 'old/x.js': '1\n', 'lib/z.js': '1\n' });
  // inside the 90 days before the head commit (2026-07-03 onwards), but not the 90 days before the wall clock
  commitAt('2026-07-15T10:00:00Z', 'dave@example.com', { 'old/y.js': '1\n' });
  commitAt('2026-09-01T10:00:00Z', 'Bob@Example.com', { 'src/a.js': '2\n', 'src/checkout/b.js': '1\n' });
  commitAt('2026-09-20T10:00:00Z', 'carol@example.com', { 'src/checkout/b.js': '2\n' });
  commitAt('2026-10-01T12:00:00Z', 'bob@example.com', { 'README.md': 'r\n' });
});
after(() => { removeDir(home); removeDir(repo); });

/**
 * @param {string[]} args
 * @returns {{code: number | null, out: any, stderr: string}}
 */
function cli(...args) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--repo', repo], { encoding: 'utf8', env: { ...process.env, DOWSER_HOME: home } });
  /** @type {any} */
  let out;
  try { out = JSON.parse(r.stdout); } catch { out = undefined; }
  return { code: r.status, out, stderr: r.stderr };
}

test('areas: churn and authors in the 90 days before the head commit, ranked, capped; nothing written in the repo', () => {
  const before = listFiles(repo);
  assert.equal(cli('init').code, 0);
  const start = cli('run', 'start', '--mode', 'full');
  assert.equal(start.code, 0, start.stderr);
  const runId = start.out.run_id;

  const r = cli('areas', '--run', runId);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(Object.keys(r.out), ['project_key', 'run_id', 'areas_json']);
  assert.equal(r.out.run_id, runId);
  assert.equal(typeof r.out.areas_json, 'string');
  assert.deepEqual(JSON.parse(r.out.areas_json), [
    { path: 'src', files: 2, churn_90d: 2, authors_90d: 2, last_change: '2026-09-20T10:00:00.000Z' },
    { path: 'src/checkout', files: 1, churn_90d: 2, authors_90d: 2, last_change: '2026-09-20T10:00:00.000Z' },
    { path: 'old', files: 2, churn_90d: 1, authors_90d: 1, last_change: '2026-07-15T10:00:00.000Z' },
    { path: 'lib', files: 1, churn_90d: 0, last_change: '2026-01-01T10:00:00.000Z' },
  ], 'authors_90d omitted at churn 0; e-mails compared case-insensitively; the window ends at the head commit');

  const top = cli('areas', '--run', runId, '--top', '2');
  assert.deepEqual(JSON.parse(top.out.areas_json).map((/** @type {any} */ a) => a.path), ['src', 'src/checkout']);
  assert.equal(cli('areas', '--run', runId, '--top', '201').code, 2);
  assert.equal(cli('areas', '--run', runId, '--top', 'x').code, 2);
  assert.equal(cli('areas', '--run', 'r-nope').code, 2);

  assert.deepEqual(listFiles(repo), before, 'areas creates no file in the repo');
  assert.equal(execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' }), '', 'the work tree is untouched');
});
