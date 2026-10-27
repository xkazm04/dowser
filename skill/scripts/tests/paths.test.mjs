// @ts-check
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { dbPath, dowserHome, isInside, normalizeRemote, projectKey } from '../lib/paths.mjs';
import { authorsOf, diffNames, headSha } from '../lib/git.mjs';
import { DowserError } from '../lib/model.mjs';
import { gitRepo, removeDir, tempDir, writeFiles } from './_fixture.mjs';

/** @type {string} */ let repo;
/** @type {string} */ let home;
const saved = process.env.DOWSER_HOME;

before(() => {
  repo = tempDir('paths-repo');
  home = tempDir('paths-home');
  gitRepo(repo, { 'a.txt': 'a\n' });
  process.env.DOWSER_HOME = home;
});
after(() => {
  if (saved === undefined) delete process.env.DOWSER_HOME; else process.env.DOWSER_HOME = saved;
  removeDir(repo);
  removeDir(home);
});

test('normalizeRemote strips protocol, credentials and .git, lowercases the host', () => {
  assert.equal(normalizeRemote('https://user:tok@GitHub.com/Org/Repo.git'), 'github-com-Org-Repo');
  assert.equal(normalizeRemote('git@github.com:Org/Repo.git'), 'github-com-Org-Repo');
  assert.equal(normalizeRemote('ssh://git@Example.org:2222/team/my.repo.git'), 'example-org-2222-team-my-repo');
  assert.equal(normalizeRemote('https://dev.azure.com/acme/Proj/_git/web/'), 'dev-azure-com-acme-Proj-git-web');
});

test('projectKey: local-<sha12> without origin, the remote slug with one; dbPath under DOWSER_HOME', () => {
  assert.equal(dowserHome(), home);
  const local = projectKey(repo);
  assert.match(local, /^local-[0-9a-f]{12}$/);
  assert.equal(projectKey(repo), local, 'stable');
  assert.equal(dbPath(repo), join(home, 'projects', local, 'dowser.db'));
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://tok@github.com/Acme/Shop.git']);
  assert.equal(projectKey(repo), 'github-com-Acme-Shop');
  execFileSync('git', ['-C', repo, 'remote', 'remove', 'origin']);
});

test('dbPath refuses a DOWSER_HOME inside the scanned repo (exit 3)', () => {
  process.env.DOWSER_HOME = join(repo, '.dowser');
  try {
    assert.throws(() => dbPath(repo), (e) => e instanceof DowserError && e.code === 3);
  } finally { process.env.DOWSER_HOME = home; }
  assert.ok(isInside(repo, join(repo, 'x', 'y')));
  assert.ok(!isInside(repo, home));
});

test('git helpers: headSha, diffNames, authorsOf', () => {
  const first = /** @type {string} */ (headSha(repo));
  assert.match(first, /^[0-9a-f]{40}$/);
  writeFiles(repo, { 'b.txt': 'b\n' });
  execFileSync('git', ['-C', repo, 'add', '-A']);
  execFileSync('git', ['-C', repo, '-c', 'user.email=other@example.com', 'commit', '-q', '-m', 'b']);
  writeFiles(repo, { 'a.txt': 'a2\n' });
  execFileSync('git', ['-C', repo, '-c', 'user.email=other@example.com', 'commit', '-q', '-am', 'a2']);
  const head = /** @type {string} */ (headSha(repo));
  assert.deepEqual(diffNames(repo, first, head), ['a.txt', 'b.txt']);
  assert.equal(diffNames(repo, 'deadbeef', head), undefined, 'unknown sha -> undefined, not []');
  assert.deepEqual(authorsOf(repo, ['a.txt', 'b.txt', 'never.txt']), { 'a.txt': 2, 'b.txt': 1 }, 'unknown path omitted, never 0');
  assert.equal(headSha(home), undefined);
});
