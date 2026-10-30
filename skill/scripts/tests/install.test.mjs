// @ts-check
// skill/install.mjs: the installed copy carries no tests or fixtures, records its version and source
// (install.json), and `--check` compares that version with the newest release tag of its source.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitRepo, listFiles, removeDir, tempDir } from './_fixture.mjs';

const SKILL = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const INSTALLER = join(SKILL, 'install.mjs');
const VERSION = /** @type {RegExpMatchArray} */ (readFileSync(join(SKILL, 'SKILL.md'), 'utf8').match(/^version:\s*(\S+)\s*$/m))[1];

/** @type {string[]} */
const dirs = [];
after(() => { for (const d of dirs) removeDir(d); });

/** @param {string} config @param {string[]} args */
function run(config, args) {
  const r = spawnSync(process.execPath, [INSTALLER, '--harness', 'claude', ...args], {
    encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: config },
  });
  return { code: r.status, out: r.stdout ? JSON.parse(r.stdout) : undefined, err: r.stderr };
}

/** A git repo whose tags are the given release names. @param {string[]} tags */
function releases(tags) {
  const root = tempDir('install-releases');
  dirs.push(root);
  gitRepo(root, { 'README.md': 'x\n' });
  for (const t of tags) execFileSync('git', ['-C', root, 'tag', t], { stdio: 'ignore' });
  return root;
}

test('the installed copy holds no tests, no fixtures and no fixture secrets', () => {
  const config = tempDir('install-copy');
  dirs.push(config);
  const r = run(config, []);
  assert.equal(r.code, 0, r.err);
  const files = listFiles(join(config, 'skills', 'dowser'));
  assert.ok(files.includes('SKILL.md') && files.includes('scripts/dowser.mjs'));
  assert.deepEqual(files.filter((f) => /(^|\/)(tests|fixtures)\//.test(f)), []);
  const leaked = files.filter((f) => readFileSync(join(config, 'skills', 'dowser', f), 'utf8').includes('psk_live_'));
  assert.deepEqual(leaked, []);
});

test('install writes install.json: the skill version and its source commit, no credentials', () => {
  const config = tempDir('install-stamp');
  dirs.push(config);
  const r = run(config, []);
  assert.equal(r.code, 0, r.err);
  const stampPath = join(config, 'skills', 'dowser', 'install.json');
  assert.ok(existsSync(stampPath), 'install.json written into the installed copy');
  const stamp = JSON.parse(readFileSync(stampPath, 'utf8'));
  assert.equal(stamp.name, 'dowser');
  assert.equal(stamp.version, VERSION);
  assert.equal(stamp.harness, 'claude');
  assert.equal(stamp.scope, 'user');
  assert.match(stamp.installed_at, /^\d{4}-\d\d-\d\dT/);
  assert.match(stamp.source.commit, /^[0-9a-f]{40}$/);
  if (stamp.source.repo_url) assert.doesNotMatch(stamp.source.repo_url, /\/\/[^/]*@/);
  assert.deepEqual(r.out.stamp, stamp);
});

test('--check names a newer release tag and how to update', () => {
  const config = tempDir('install-check');
  dirs.push(config);
  assert.equal(run(config, []).code, 0);
  const from = releases(['v0.0.1', `v${VERSION}`, 'v99.0.0', 'not-a-release']);
  const r = run(config, ['--check', '--from', from]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.check, true);
  assert.equal(r.out.installed_version, VERSION);
  assert.equal(r.out.latest_release, 'v99.0.0');
  assert.equal(r.out.behind, true);
  assert.match(r.out.notice, /v99\.0\.0/);
  assert.match(r.out.notice, /git pull/);
  assert.match(r.err, /v99\.0\.0/, 'the notice is printed to stderr too');
});

test('--check: up to date, no release tags yet, nothing installed, unreachable source', () => {
  const config = tempDir('install-check2');
  dirs.push(config);
  const none = run(config, ['--check', '--from', releases([])]);
  assert.equal(none.code, 3, 'nothing installed yet');
  assert.equal(run(config, []).code, 0);

  const same = run(config, ['--check', '--from', releases(['v0.0.1', `v${VERSION}`])]);
  assert.equal(same.code, 0, same.err);
  assert.equal(same.out.behind, false);
  assert.equal(same.out.latest_release, `v${VERSION}`);

  const untagged = run(config, ['--check', '--from', releases([])]);
  assert.equal(untagged.code, 0, untagged.err);
  assert.equal(untagged.out.behind, false);
  assert.equal('latest_release' in untagged.out, false, 'absent, not null');
  assert.match(untagged.out.notice, /no release tags/);

  const gone = run(config, ['--check', '--from', join(config, 'no-such-repo')]);
  assert.equal(gone.code, 4);
  assert.match(gone.err, /could not list release tags/);
});

test('install.json drops the credentials an origin url carries', () => {
  const repo = tempDir('install-src');
  const config = tempDir('install-cred');
  dirs.push(repo, config);
  gitRepo(repo, { 'README.md': 'x\n' });
  cpSync(SKILL, join(repo, 'skill'), { recursive: true, filter: (s) => !/[\\/]tests$/.test(s) });
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://someone:ghp_secret123@github.com/x/dowser.git'], { stdio: 'ignore' });
  const r = spawnSync(process.execPath, [join(repo, 'skill', 'install.mjs'), '--harness', 'claude'], {
    encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: config },
  });
  assert.equal(r.status, 0, r.stderr);
  const stamp = JSON.parse(readFileSync(join(config, 'skills', 'dowser', 'install.json'), 'utf8'));
  assert.equal(stamp.source.repo_url, 'https://github.com/x/dowser.git');
  assert.equal(stamp.source.dirty, true, 'the copied skill folder is uncommitted in that repo');
  assert.doesNotMatch(readFileSync(join(config, 'skills', 'dowser', 'install.json'), 'utf8'), /ghp_secret123/);
});

test('--dry-run shows the stamp it would write and changes nothing', () => {
  const config = tempDir('install-dry');
  dirs.push(config);
  const r = run(config, ['--dry-run']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.stamp.version, VERSION);
  assert.equal(existsSync(join(config, 'skills')), false);
});
