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
    JSON.stringify(candidate({ kind: 'secret-exposure' })),
    JSON.stringify(candidate({ kind: 'secret-exposure', topic: 'too long', title: 'x'.repeat(90) })),
    '',
    '{not json',
  ].join('\n'));
  const prop = cli('propose', '--run', run, '--file', file, '--kinds', 'security-cra=secret-exposure,risky-pattern', '--kinds', 'opportunity=goal-gap');
  assert.equal(prop.code, 1, 'some lines invalid -> partial');
  assert.equal(prop.lines[0].result, 'created');
  assert.equal(prop.lines[0].line, 1);
  assert.match(prop.lines[1].result, /^invalid:title:/);
  assert.match(prop.lines[2].result, /^invalid:json/);
  assert.equal(prop.lines[2].line, 4, 'line numbers count the blank line');
  assert.equal(prop.lines[0].warning, 'no-predicted-verdict', 'the lens worker left its verdict out');
  assert.deepEqual(prop.lines[3].summary, { lines: 3, created: 1, 'evidence-grew': 0, suppressed: 0, duplicate: 0, invalid: 2, unpredicted: 1 });
  const fp = prop.lines[0].fp;

  const noFile = cli('propose', '--run', run);
  assert.equal(noFile.code, 2);
  assert.match(noFile.stderr, /--file is required/, 'a required flag of the spec');

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

// ---------------------------------------------------------------------------- kinds from the packs, flags from the spec

/** Starts a fresh run in the shared fixture repo. @returns {string} */
const freshRun = () => { const s = cli('run', 'start', '--mode', 'full'); assert.equal(s.code, 0, s.stderr); return s.out.run_id; };
/** Writes candidates to a JSONL file in scratch. @param {string} name @param {Record<string, unknown>[]} cands */
const jsonl = (name, cands) => { const f = join(scratch, name); writeFileSync(f, cands.map((c) => JSON.stringify(c)).join('\n') + '\n'); return f; };

test('propose without --kinds: the kinds come from the lens packs', () => {
  cli('init');
  const run = freshRun();
  const p = cli('propose', '--run', run, '--file', jsonl('derived.jsonl', [candidate({ kind: 'secret-exposure', topic: 'derived kinds' })]));
  assert.equal(p.code, 0, p.stdout + p.stderr);
  assert.equal(p.lines[0].result, 'created');
});

test('propose stamps provenance.lens_version from the loaded pack and notes a different one', async () => {
  const { loadLensPack } = await import('../lib/memory.mjs');
  const pack = loadLensPack('security-cra').version;
  cli('init');
  const run = freshRun();
  const p = cli('propose', '--run', run, '--file', jsonl('version.jsonl', [
    candidate({ kind: 'secret-exposure', topic: 'stale version copied', provenance: { lens_version: '0.0.1' } }),
    candidate({ kind: 'secret-exposure', topic: 'right version', provenance: { lens_version: pack } }),
  ]));
  assert.equal(p.code, 0, p.stdout + p.stderr);
  assert.equal(p.lines[0].note, `provenance.lens_version 0.0.1 replaced by ${pack} (lenses/security-cra.md)`);
  assert.equal(p.lines[1].note, undefined, 'the pack\'s own version: no note');
  const shown = cli('show', p.lines[0].fp);
  assert.equal(shown.code, 0, shown.stderr);
  assert.equal(shown.out.card.provenance.lens_version, pack);
});

test('propose --kinds must be a subset of the pack: kinds the pack lacks exit 2 and are named', () => {
  cli('init');
  const run = freshRun();
  const p = cli('propose', '--run', run, '--file', jsonl('subset.jsonl', [candidate({ kind: 'secret-exposure', topic: 'subset kinds' })]), '--kinds', 'security-cra=secret,vuln');
  assert.equal(p.code, 2);
  assert.match(p.stderr, /secret, vuln are not kinds of lenses\/security-cra\.md/);
  const ok = cli('propose', '--run', run, '--file', join(scratch, 'subset.jsonl'), '--kinds', 'security-cra=secret-exposure');
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
});

test('outbox without --kinds sends lens_kinds_json from the pack frontmatter (kind-in-lens on by default)', async () => {
  const { loadLensPack } = await import('../lib/memory.mjs');
  const { LENSES } = await import('../lib/model.mjs');
  cli('init');
  const run = freshRun();
  const kindOf = { opportunity: 'missing-capability', 'ux-friction': 'dead-end', 'doc-drift': 'stale-example', 'security-cra': 'secret-exposure' };
  const p = cli('propose', '--run', run, '--file', jsonl('four.jsonl', LENSES.map((lens) => candidate({ lens, kind: kindOf[lens], topic: `four lenses ${lens}`, anchors: [`src/auth.js#${lens}`] }))));
  assert.equal(p.code, 0, p.stdout + p.stderr);
  assert.equal(cli('verify', '--run', run).code, 0);
  const ob = cli('outbox', '--run', run);
  assert.equal(ob.code, 0, ob.stderr);
  assert.ok(ob.out.lens_kinds_json, 'lens_kinds_json is sent without --kinds');
  const sent = JSON.parse(ob.out.lens_kinds_json);
  assert.deepEqual(Object.keys(sent).sort(), [...LENSES].sort());
  for (const lens of LENSES) assert.deepEqual(sent[lens], loadLensPack(lens).kinds, `${lens}: the pack's kinds`);
});

test('an unknown flag is refused, naming the flag, the command and its declared flags', () => {
  cli('init');
  const run = freshRun();
  const v = cli('verify', '--run', run, '--per_lens', '2');
  assert.equal(v.code, 2);
  assert.match(v.stderr, /unknown flag --per_lens for verify/);
  assert.match(v.stderr, /--per-lens/);
  assert.match(v.stderr, /--per-run/);
  const sub = cli('run', 'finish', '--run', run, '--lens', '{}');
  assert.equal(sub.code, 2);
  assert.match(sub.stderr, /unknown flag --lens for run finish/);
});

test('--help lists each command\'s declared flags from the spec', async () => {
  const { COMMANDS: spec, helpText } = await import('../dowser.mjs');
  const COMMANDS = /** @type {Record<string, any>} */ (spec);
  const help = cli('--help');
  assert.equal(help.code, 2, 'no command: help, exit 2');
  /** @type {[string, any][]} */
  const entries = [];
  for (const [name, e] of Object.entries(COMMANDS)) {
    if (e.subs) for (const [sub, c] of Object.entries(e.subs)) entries.push([`${name} ${sub}`, c]);
    else entries.push([name, e]);
  }
  assert.ok(entries.length > 20);
  for (const [path, c] of entries) {
    assert.ok(help.stdout.includes(path), `help names ${path}`);
    for (const flag of Object.keys(c.flags ?? {})) assert.ok(help.stdout.includes(`--${flag}`), `help names ${path} --${flag}`);
  }
  const grown = { ...COMMANDS, share: { ...COMMANDS.share, flags: { ...COMMANDS.share.flags, 'brand-new': { arg: '<x>' } } } };
  assert.match(helpText(grown), /share --run <id> \[--brand-new <x>\]/, 'a flag added to the spec shows up in help');
});

test('a bug in a handler is error internal with its stack on stderr; a SQLite error stays unavailable (both exit 3)', async () => {
  const { COMMANDS, main } = await import('../dowser.mjs');
  const commands = /** @type {Record<string, any>} */ (COMMANDS);
  commands['test-bug'] = { help: 'test only', run: (/** @type {any} */ a) => a.no.such.field };
  commands['test-sqlite'] = { help: 'test only', run: () => { throw Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR' }); } };
  try {
    const bug = await main(['test-bug', '--repo', repo]);
    assert.equal(bug.code, 3);
    assert.equal(JSON.parse(bug.stdout).error, 'internal');
    assert.match(bug.stderr, /internal error \(a Dowser bug, not the store\): TypeError/);
    assert.match(bug.stderr, /\n\s+at /, 'the stack locates it');
    const db = await main(['test-sqlite', '--repo', repo]);
    assert.equal(db.code, 3);
    assert.deepEqual(JSON.parse(db.stdout), { error: 'unavailable', message: 'database is locked' });
    assert.equal(db.stderr, 'dowser: database is locked\n');
  } finally {
    delete commands['test-bug'];
    delete commands['test-sqlite'];
  }
});
