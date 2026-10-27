// @ts-check
// WP2 commands end to end: the CLI as a child process against a temp git repo, DOWSER_HOME in a temp dir.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { candidate, gitRepo, listFiles, removeDir, tempDir } from './_fixture.mjs';

const CLI = fileURLToPath(new URL('../dowser.mjs', import.meta.url));
/** @type {string} */ let home;
/** @type {string} */ let repo;
/** @type {string} */ let scratch;

before(() => {
  home = tempDir('mcli-home');
  repo = tempDir('mcli-repo');
  scratch = tempDir('mcli-scratch');
  gitRepo(repo, { 'src/auth.js': 'export function login(user) {\n  return check(user.password);\n}\n' });
});
after(() => { removeDir(home); removeDir(repo); removeDir(scratch); });

/** @param {string[]} args */
function cli(...args) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--repo', repo], { encoding: 'utf8', env: { ...process.env, DOWSER_HOME: home }, cwd: scratch });
  /** @type {any} */
  let out;
  try { out = JSON.parse(r.stdout); } catch { out = undefined; }
  return { code: r.status, out, stdout: r.stdout, stderr: r.stderr };
}

test('prefs round-trip under DOWSER_HOME', () => {
  assert.deepEqual(cli('prefs', 'get', 'mode').out, {}, 'absent: omitted');
  const set = cli('prefs', 'set', 'mode=guided', 'verbosity=short');
  assert.equal(set.code, 0, set.stderr);
  assert.deepEqual(set.out, { mode: 'guided', verbosity: 'short' });
  assert.deepEqual(cli('prefs', 'get', 'mode').out, { mode: 'guided' });
  assert.equal(cli('prefs', 'set', 'mode=dev').code, 0);
  assert.deepEqual(cli('prefs', 'get').out, { mode: 'dev', verbosity: 'short' });
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'user.json'), 'utf8')), { mode: 'dev', verbosity: 'short' });
  assert.equal(cli('prefs', 'set', 'mode=loud').code, 2);
  assert.equal(cli('prefs', 'set', 'colour=red').code, 2);
  assert.equal(cli('prefs', 'get', 'colour').code, 2);
});

test('context, similar, show, list, rules through the CLI; nothing written inside the repo', () => {
  const filesBefore = listFiles(repo);
  const statusBefore = execFileSync('git', ['-C', repo, 'status', '--porcelain', '--ignored'], { encoding: 'utf8' });

  const run = cli('run', 'start', '--mode', 'full').out.run_id;
  const kinds = 'security-cra=vulnerable-dependency,risky-pattern,secret-exposure';
  const file = join(scratch, 'c.jsonl');
  writeFileSync(file, `${JSON.stringify(candidate({ kind: 'secret-exposure', topic: 'plaintext password' }))}\n`);
  const p = cli('propose', '--run', run, '--file', file, '--kinds', kinds);
  assert.equal(p.code, 0, p.stdout);
  const fp = JSON.parse(p.stdout.split('\n')[0]).fp;
  assert.equal(cli('verify', '--run', run).code, 0);

  const ctx = cli('context', '--run', run, '--lens', 'security-cra');
  assert.equal(ctx.code, 0, ctx.stderr);
  assert.ok(ctx.out.kinds.includes('secret-exposure'));
  assert.equal(ctx.out.near[0].fp, fp);
  assert.equal(cli('context', '--run', run, '--lens', 'bogus').code, 2);
  assert.equal(cli('context', '--lens', 'security-cra').code, 2);

  assert.equal(cli('move', fp, '--to', 'rejected', '--by', 'human:ann', '--reason', 'false-positive').code, 0);
  assert.deepEqual(cli('context', '--run', run, '--lens', 'security-cra').out.suppressed, [fp]);

  assert.deepEqual(cli('similar', fp).out.similar, []);
  const sh = cli('show', fp);
  assert.equal(sh.code, 0);
  assert.deepEqual(sh.out.transitions.map((/** @type {any} */ t) => t.to_status), ['candidate', 'verified', 'rejected']);
  assert.equal(cli('show', 'f'.repeat(16)).code, 2);

  assert.deepEqual(cli('list', '--title', 'password').out.proposals.map((/** @type {any} */ r) => r.fp), [fp]);
  assert.deepEqual(cli('rules', 'offer').out, { offers: [] });
  assert.deepEqual(cli('rules', 'list', '--lens', 'security-cra').out, { rules: [] });
  assert.equal(cli('rules', 'accept', 'rule-nope', '--by', 'human:ann').code, 2);
  assert.equal(cli('rules').code, 2);

  assert.deepEqual(listFiles(repo), filesBefore, 'no file created inside the fixture repo');
  assert.equal(execFileSync('git', ['-C', repo, 'status', '--porcelain', '--ignored'], { encoding: 'utf8' }), statusBefore);
  assert.ok(!existsSync(join(repo, 'user.json')));
});
