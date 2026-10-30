// @ts-check
// End to end: the CLI as a child process against a temp git repo fixture, DOWSER_HOME in a temp dir.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { candidate, gitRepo, listFiles, removeDir, tempDir } from './_fixture.mjs';

const CLI = fileURLToPath(new URL('../dowser.mjs', import.meta.url));
/** @type {string} */ let home;
/** @type {string} */ let repo;
/** @type {string} */ let scratch;

before(() => {
  home = tempDir('cli-home');
  repo = tempDir('cli-repo');
  scratch = tempDir('cli-scratch');
  gitRepo(repo, { 'src/auth.js': 'export function login(user) {\n  return check(user.password);\n}\n', 'README.md': '# App\n' });
});
after(() => { removeDir(home); removeDir(repo); removeDir(scratch); });

/**
 * @param {string[]} args
 * @returns {{code: number | null, out: any, lines: any[], stdout: string, stderr: string}}
 */
function cli(...args) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--repo', repo], {
    encoding: 'utf8', env: { ...process.env, DOWSER_HOME: home }, cwd: scratch,
  });
  const lines = r.stdout.split('\n').filter(Boolean);
  /** @type {any} */
  let out;
  try { out = JSON.parse(r.stdout); } catch { out = undefined; }
  return { code: r.status, out, lines: lines.map((l) => { try { return JSON.parse(l); } catch { return l; } }), stdout: r.stdout, stderr: r.stderr };
}

test('init -> run start -> propose -> verify -> move -> status, nothing written inside the repo', () => {
  const filesBefore = listFiles(repo);
  const statusBefore = execFileSync('git', ['-C', repo, 'status', '--porcelain', '--ignored'], { encoding: 'utf8' });

  const init = cli('init');
  assert.equal(init.code, 0, init.stderr);
  assert.match(init.out.project_key, /^local-[0-9a-f]{12}$/);
  assert.ok(init.out.db.startsWith(home));
  assert.ok(existsSync(init.out.db));
  assert.equal(init.stderr, '', 'no ExperimentalWarning or other noise on stderr');

  const start = cli('run', 'start', '--mode', 'full', '--harness', 'claude', '--model', 'opus');
  assert.equal(start.code, 0, start.stderr);
  const run = start.out.run_id;
  assert.match(run, /^r-\d{14}-[0-9a-f]{4}$/);
  assert.match(start.out.head_sha, /^[0-9a-f]{40}$/);
  assert.equal(start.out.base_sha, undefined, 'first run: no base');

  const file = join(scratch, 'cands.jsonl');
  writeFileSync(file, [
    JSON.stringify(candidate()),
    JSON.stringify(candidate({ topic: 'too long', title: 'x'.repeat(90) })),
    '',
    '{not json',
  ].join('\n'));
  const prop = cli('propose', '--run', run, '--file', file, '--kinds', 'security-cra=secret,vuln', '--kinds', 'opportunity=gap');
  assert.equal(prop.code, 1, 'some lines invalid -> partial');
  assert.equal(prop.lines[0].result, 'created');
  assert.equal(prop.lines[0].line, 1);
  assert.match(prop.lines[1].result, /^invalid:title:/);
  assert.match(prop.lines[2].result, /^invalid:json/);
  assert.equal(prop.lines[2].line, 4, 'line numbers count the blank line');
  assert.equal(prop.lines[0].warning, 'no-predicted-verdict', 'the lens worker left its verdict out');
  assert.deepEqual(prop.lines[3].summary, { lines: 3, created: 1, 'evidence-grew': 0, suppressed: 0, duplicate: 0, invalid: 2, unpredicted: 1 });
  const fp = prop.lines[0].fp;

  const noKinds = cli('propose', '--run', run, '--file', file);
  assert.equal(noKinds.code, 2);

  const ver = cli('verify', '--run', run);
  assert.equal(ver.code, 0, ver.stderr);
  assert.equal(ver.out.verified, 1);
  assert.equal(ver.out.results[0].checks[0].found, 'near-line');

  const illegal = cli('move', fp, '--to', 'dropped', '--by', 'human:jane');
  assert.equal(illegal.code, 2);
  assert.equal(illegal.out.error, 'refused');
  assert.equal(illegal.out.current, 'verified');
  assert.match(illegal.stderr, /verified -> dropped is not allowed/);

  const agentAccept = cli('move', fp, '--to', 'accepted', '--by', 'agent:claude');
  assert.equal(agentAccept.code, 2, 'verified -> accepted needs a human decider');
  assert.equal(agentAccept.out.current, 'verified');
  assert.match(agentAccept.stderr, /needs a human decider/);

  const mv = cli('move', fp, '--to', 'rejected', '--by', 'human:jane', '--reason', 'other', '--note', 'handled in v2');
  assert.equal(mv.code, 0, mv.stderr);
  assert.equal(mv.out.status, 'rejected');
  assert.equal(mv.out.reason, 'other');

  const stale = cli('move', fp, '--to', 'snoozed', '--from', 'verified', '--by', 'human:jane');
  assert.equal(stale.code, 2);
  assert.equal(stale.out.current, 'rejected');

  const fin = cli('run', 'finish', '--run', run, '--lenses', JSON.stringify({
    'security-cra': { state: 'ran', emitted: 1, verified: 1, dropped: 0, truncated: 3 },
    opportunity: { state: 'skipped', reason: 'tickets source not connected' },
  }));
  assert.equal(fin.code, 0, fin.stderr);
  assert.equal(fin.out.status, 'done');

  const st = cli('status');
  assert.equal(st.code, 0, st.stderr);
  assert.equal(st.out.proposals, 1);
  assert.deepEqual(st.out.by_status, { rejected: 1 });
  assert.deepEqual(st.out.by_lens, { 'security-cra': { rejected: 1 } });
  assert.equal(st.out.runs[0].lenses['security-cra'].shown, 'top 1 of 4');
  assert.equal(st.out.runs[0].lenses.opportunity.state, 'skipped');

  const next = cli('run', 'start', '--mode', 'incremental');
  assert.equal(next.out.base_sha, start.out.head_sha, 'base = last done run head');

  for (const cmd of ['outbox', 'ingest-push', 'ingest-verdicts', 'ingest-sources']) {
    assert.equal(cli(cmd).code, 2, `${cmd} without its required flags is bad input`);
  }
  assert.equal(cli('bogus').code, 2);

  assert.deepEqual(listFiles(repo), filesBefore, 'no file created inside the fixture repo');
  assert.equal(execFileSync('git', ['-C', repo, 'status', '--porcelain', '--ignored'], { encoding: 'utf8' }), statusBefore);
});
