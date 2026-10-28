#!/usr/bin/env node
// @ts-check
// lens-eval - measures one lens pack on the seeded fixture (lens-quality-plan WP5). It builds a throwaway copy
// of skill/scripts/tests/fixtures/lens-fixture/ in the OS temp folder (files starting with `_` left out, history
// replayed from _history/commits.json as real git commits), gives it a fresh DOWSER_HOME, connects the mock
// Forge seeded from the fixture's _sources.json, runs one headless Claude Code scan restricted to the lens,
// reads the run's cards back through the dowser CLI, scores them against _expected.json (skill/scripts/lib/
// score.mjs) and appends one row to the evals file. Nothing is written into the fixture or this repository.
//
//   node tools/lens-eval.mjs --lens <id> [--model <m>] [--budget-usd <n>] [--evals <file>] [--keep] [--dry-run]
//                            [--dev-link]
//     --evals      the evals file to append to (default <DOWSER_HOME or ~/.dowser>/evals.jsonl of the caller,
//                  never the temp home the scan used)
//     --keep       keep the temp work folder (repo copy, temp home, claude output) and print its path
//     --dry-run    build the temp workspace and print the plan and the exact commands, without calling Claude
//                  and without appending a row; the workspace is removed unless --keep
//     --dev-link   install the skill as a junction/symlink to this repo's skill/ instead of a copy. Off by
//                  default: a linked skill folder also exposes scripts/tests/, the fixture's _expected.json
//                  among it, to the agent under evaluation (the copying installer leaves tests/ out)
//     --budget-usd passed to claude as --max-budget-usd
//
// For security-cra, `npm audit` is answered from the fixture's _auditor/npm-audit.json by an `npm` shim put
// first on the scan's PATH, so `dowser deps` and the pack's own audit step see captured, offline output.
// Env: CLAUDE_BIN (default `claude`). Exit codes: 0 scored (or dry run), 1 the scan failed, 2 bad arguments.
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LENSES, isOneOf } from '../skill/scripts/lib/model.mjs';
import { dowserHome } from '../skill/scripts/lib/paths.mjs';
import { scoreLens } from '../skill/scripts/lib/score.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE = join(ROOT, 'skill/scripts/tests/fixtures/lens-fixture');
const CLI = join(ROOT, 'skill/scripts/dowser.mjs');
const INSTALL = join(ROOT, 'skill/install.mjs');
const MOCK = join(ROOT, 'tools/mock-forge-mcp.mjs');
const CLAUDE = process.env.CLAUDE_BIN ?? 'claude';
const ALLOWED_TOOLS = ['Bash', 'Read', 'Grep', 'Glob', 'Write', 'Edit', 'Skill', 'mcp__dowser__*'];

/** @typedef {{lens: string, model?: string, budget?: string, evals: string, keep: boolean, dryRun: boolean, devLink: boolean}} Opts */

/** @param {string} msg @returns {never} */
function usage(msg) {
  console.error(`lens-eval: ${msg}\nusage: node tools/lens-eval.mjs --lens ${LENSES.join('|')} [--model m] [--budget-usd n] [--evals file] [--keep] [--dry-run] [--dev-link]`);
  process.exit(2);
}

/** @param {string[]} argv @returns {Opts} */
function parseArgs(argv) {
  /** @type {Record<string, string | true>} */
  const f = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) usage(`unexpected argument ${a}`);
    const k = a.slice(2);
    if (['keep', 'dry-run', 'dev-link'].includes(k)) f[k] = true;
    else if (['lens', 'model', 'budget-usd', 'evals'].includes(k) && argv[i + 1] && !argv[i + 1].startsWith('--')) f[k] = argv[++i];
    else usage(`unknown or valueless flag ${a}`);
  }
  if (!isOneOf(LENSES, f.lens)) usage('--lens is required');
  return {
    lens: /** @type {string} */ (f.lens),
    model: typeof f.model === 'string' ? f.model : undefined,
    budget: typeof f['budget-usd'] === 'string' ? f['budget-usd'] : undefined,
    evals: typeof f.evals === 'string' ? f.evals : join(dowserHome(), 'evals.jsonl'),
    keep: f.keep === true,
    dryRun: f['dry-run'] === true,
    devLink: f['dev-link'] === true,
  };
}

/** A lens pack's frontmatter `version`. @param {string} lens */
function lensVersion(lens) {
  const m = readFileSync(join(ROOT, 'skill/lenses', `${lens}.md`), 'utf8').match(/^version:\s*(\S+)/m);
  return m ? m[1] : 'unknown';
}

/** Every file of the final fixture tree, repo-relative with forward slashes; top-level `_` entries left out. */
function fixtureFiles() {
  /** @type {string[]} */
  const out = [];
  /** @param {string} dir */
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, e.name);
      const rel = relative(FIXTURE, abs).replace(/\\/g, '/');
      if (dir === FIXTURE && e.name.startsWith('_')) continue;
      if (e.isDirectory()) walk(abs); else out.push(rel);
    }
  };
  walk(FIXTURE);
  return out.sort();
}

/**
 * Runs git in `repo`; LF content is committed as is on every platform.
 * @param {string} repo @param {string[]} args @param {Record<string, string>} [env]
 */
const git = (repo, args, env = {}) => execFileSync('git', ['-C', repo, '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', ...args],
  { encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * Builds the repo copy: one commit per _history entry, each the final tree with that entry's overrides.
 * @param {string} repo
 * @returns {{commits: number, files: number}}
 */
function buildRepo(repo) {
  const history = JSON.parse(readFileSync(join(FIXTURE, '_history/commits.json'), 'utf8'));
  const final = fixtureFiles();
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  /** @type {Set<string>} */
  let present = new Set();
  for (const c of history.commits) {
    /** @type {Map<string, string>} */
    const tree = new Map(final.map((p) => [p, join(FIXTURE, p)]));
    for (const [p, src] of Object.entries(c.files ?? {})) {
      if (src === null) tree.delete(p); else tree.set(p, join(FIXTURE, String(src)));
    }
    for (const p of present) if (!tree.has(p)) rmSync(join(repo, p), { force: true });
    for (const [p, src] of tree) { mkdirSync(dirname(join(repo, p)), { recursive: true }); copyFileSync(src, join(repo, p)); }
    present = new Set(tree.keys());
    const when = new Date(Date.now() - c.days_ago * 86400000).toISOString();
    const who = history.author;
    // Re-hash every file: an override written in the same second as the last commit, with the same size (50 ->
    // 20), passes git's stat check as unchanged.
    git(repo, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '.']);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '--no-verify', '-m', c.message], {
      GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email,
      GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when,
    });
  }
  // The project-scope skill install lands in .claude/; keep it out of the scan's git view.
  appendFileSync(join(repo, '.git/info/exclude'), '\n.claude/\n');
  return { commits: history.commits.length, files: final.length };
}

/**
 * The `npm` shim for security-cra: `npm audit ...` prints the captured report and exits 1 (npm audit's code when
 * it finds vulnerabilities); anything else goes to the real npm when one was found.
 * @param {string} bin
 * @returns {string | undefined} the real npm it forwards to
 */
function writeNpmShim(bin) {
  let real;
  try {
    const found = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['npm'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    real = process.platform === 'win32' ? found.find((s) => s.toLowerCase().endsWith('.cmd')) ?? found[0] : found[0];
  } catch { /* no npm on PATH: only `npm audit` is answered */ }
  mkdirSync(bin, { recursive: true });
  const audit = join(FIXTURE, '_auditor/npm-audit.json');
  writeFileSync(join(bin, 'npm-shim.mjs'), [
    '// lens-eval npm shim: `npm audit` answers from the fixture\'s captured report; the rest goes to the real npm.',
    "import { readFileSync } from 'node:fs';",
    "import { spawnSync } from 'node:child_process';",
    'const args = process.argv.slice(2);',
    "if (args.includes('audit')) { process.stdout.write(readFileSync(" + JSON.stringify(audit) + ", 'utf8')); process.exit(1); }",
    'const real = ' + JSON.stringify(real ?? '') + ';',
    "if (!real) { console.error('npm is not available in this evaluation (only npm audit is)'); process.exit(127); }",
    '// A .cmd needs a shell on Windows; quote the command and every argument for it.',
    "const win = process.platform === 'win32';",
    "const r = win ? spawnSync([real, ...args].map((a) => JSON.stringify(a)).join(' '), { stdio: 'inherit', shell: true }) : spawnSync(real, args, { stdio: 'inherit' });",
    'process.exit(r.status ?? 1);',
    '',
  ].join('\n'));
  writeFileSync(join(bin, 'npm.cmd'), `@"${process.execPath}" "%~dp0npm-shim.mjs" %*\r\n`);
  writeFileSync(join(bin, 'npm'), `#!/bin/sh\nexec "${process.execPath.replace(/\\/g, '/')}" "$(dirname "$0")/npm-shim.mjs" "$@"\n`, { mode: 0o755 });
  return real;
}

/** The scan instruction: the skill as written, restricted to one lens, with no person present. @param {string} lens */
const prompt = (lens) => [
  'Use the dowser skill to scan this repository. This is an unattended lens evaluation: no person is present, so never ask a question and never wait for an answer.',
  '- Mode: dev (already stored in prefs).',
  `- Run only the ${lens} lens. Do not load or run the other lens packs; in run finish report each of them as {"state":"skipped","reason":"not in this lens evaluation"}.`,
  '- The dowser MCP server is connected. Pull verdicts and reflect as the skill says.',
  '- Section 7 (pre-triage): record no moves and keep every card, as if the runner chose "keep the rest". Do not accept or decline rule offers.',
  '- Skip section 8 (push).',
  '- Finish the run (section 9) and print the summary.',
].join('\n');

/**
 * Runs the dowser CLI against the repo copy with the temp home. Returns the parsed JSON stdout.
 * @param {{repo: string, home: string}} w @param {...string} args
 * @returns {any}
 */
function cli(w, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--repo', w.repo], { encoding: 'utf8', env: { ...process.env, DOWSER_HOME: w.home } });
  if (r.status !== 0) throw new Error(`dowser ${args.join(' ')} -> ${r.status}\n${r.stderr}${r.stdout}`);
  return JSON.parse(r.stdout);
}

/** Removes the work folder; a linked skill install is unlinked first so the removal never follows it. @param {string} work @param {string} repo */
function removeWork(work, repo) {
  const link = join(repo, '.claude/skills/dowser');
  try {
    if (lstatSync(link).isSymbolicLink()) { try { unlinkSync(link); } catch { rmdirSync(link); } }
  } catch { /* no install */ }
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

/** @param {string} s */
const q = (s) => (/[\s"'&|<>^]/.test(s) ? JSON.stringify(s) : s);

const o = parseArgs(process.argv.slice(2));
const version = lensVersion(o.lens);
const work = mkdtempSync(join(tmpdir(), `dowser-lens-eval-${o.lens}-`));
const w = { repo: join(work, 'repo'), home: join(work, 'home') };
const bin = join(work, 'bin');
const mcpConfig = join(work, 'mcp.json');
let failed = false;
try {
  const built = buildRepo(w.repo);
  mkdirSync(w.home, { recursive: true });
  const install = spawnSync(process.execPath, [INSTALL, '--harness', 'claude', '--scope', 'project', ...(o.devLink ? ['--dev-link'] : [])], { cwd: w.repo, encoding: 'utf8' });
  if (install.status !== 0) throw new Error(`install -> ${install.status}\n${install.stderr}`);
  cli(w, 'init');
  cli(w, 'prefs', 'set', 'mode=dev');
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { dowser: { type: 'stdio', command: process.execPath,
    args: [MOCK, '--seed', join(FIXTURE, '_sources.json'), '--state', join(work, 'forge-state.json')] } } }, null, 2));
  const realNpm = o.lens === 'security-cra' ? writeNpmShim(bin) : undefined;
  const env = { ...process.env, DOWSER_HOME: w.home, ...(o.lens === 'security-cra' ? { PATH: `${bin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}` } : {}) };
  const args = ['-p', prompt(o.lens), '--mcp-config', mcpConfig, '--strict-mcp-config', '--add-dir', tmpdir(),
    '--allowedTools', ...ALLOWED_TOOLS, '--output-format', 'json', ...(o.model ? ['--model', o.model] : []), ...(o.budget ? ['--max-budget-usd', o.budget] : [])];

  if (o.dryRun) {
    const userSkill = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'skills/dowser');
    console.log(JSON.stringify({
      dry_run: true,
      lens: o.lens,
      lens_version: version,
      work,
      repo: { path: w.repo, ...built, excluded: ['fixture files starting with _', '.claude/ (git info/exclude)'] },
      dowser_home: w.home,
      skill: { target: join(w.repo, '.claude/skills/dowser'), method: o.devLink ? 'link (exposes scripts/tests to the agent)' : 'copy (tests/ left out)' },
      mock_forge: mcpConfig,
      npm_audit_shim: o.lens === 'security-cra' ? { bin, serves: join(FIXTURE, '_auditor/npm-audit.json'), forwards_to: realNpm ?? 'nothing (no npm found)' } : 'not used for this lens',
      steps: [
        `cd ${q(w.repo)}`,
        `DOWSER_HOME=${q(w.home)}${o.lens === 'security-cra' ? ` PATH=${q(bin)}:$PATH` : ''} ${CLAUDE} ${args.map(q).join(' ')} > ${q(join(work, 'claude.json'))}`,
        `node ${q(CLI)} list --lens ${o.lens} --repo ${q(w.repo)}   (DOWSER_HOME=${q(w.home)}), then show <fp> for each`,
        `score the cards that survived verify against ${q(join(FIXTURE, '_expected.json'))} (skill/scripts/lib/score.mjs)`,
        `append {ts, lens, lens_version, recall?, precision?, decoy_hits, artifacts_valid, artifacts_total, verify_dropped, n} to ${q(o.evals)}`,
      ],
      warnings: existsSync(userSkill) ? [`a user-scope dowser skill exists at ${userSkill}; the scan may load it instead of the project-scope copy`] : [],
      kept: o.keep,
    }, null, 2));
  } else {
    console.error(`lens-eval: scanning ${o.lens} ${version} in ${w.repo} (this calls Claude and costs tokens)`);
    const r = spawnSync(CLAUDE, args, { cwd: w.repo, env, encoding: 'utf8', timeout: 45 * 60000, maxBuffer: 64 * 1024 * 1024 });
    writeFileSync(join(work, 'claude.json'), r.stdout ?? '');
    writeFileSync(join(work, 'claude.stderr.txt'), r.stderr ?? '');
    /** @type {any} */
    let result = {};
    try { result = JSON.parse(r.stdout); } catch { /* not JSON: reported below */ }
    if (r.status !== 0 || result.is_error) {
      failed = true;
      console.error(`lens-eval: the scan failed (exit ${r.status}${r.error ? `, ${r.error.message}` : ''}); see ${work}`);
    } else {
      const { proposals } = cli(w, 'list', '--lens', o.lens);
      const shown = proposals.map((/** @type {{fp: string}} */ p) => cli(w, 'show', p.fp));
      const survivors = shown.filter((/** @type {any} */ s) => !['dropped', 'merged'].includes(s.card.status));
      const dropped = shown.filter((/** @type {any} */ s) => s.card.status === 'dropped').length;
      const emitted = survivors.map((/** @type {any} */ s) => ({ lens: s.card.lens, kind: s.card.kind, title: s.card.title, anchors: s.card.anchors,
        evidence: s.evidence, ...(s.card.artifacts !== undefined ? { artifacts: s.card.artifacts } : {}) }));
      const expected = JSON.parse(readFileSync(join(FIXTURE, '_expected.json'), 'utf8'));
      const score = scoreLens({ expected, emitted, lens: o.lens, verify_dropped: dropped });
      /** @type {Record<string, unknown>} */
      const row = { ts: new Date().toISOString(), lens: o.lens, lens_version: version };
      if (score.recall !== undefined) row.recall = score.recall;
      if (score.precision !== undefined) row.precision = score.precision;
      Object.assign(row, { decoy_hits: score.decoy_hits, artifacts_valid: score.artifacts_valid, artifacts_total: score.artifacts_total,
        verify_dropped: dropped, n: score.emitted });
      if (o.model) row.model = o.model;
      mkdirSync(dirname(o.evals), { recursive: true });
      appendFileSync(o.evals, JSON.stringify(row) + '\n');
      console.log(JSON.stringify({ score, appended_to: o.evals, cost_usd: result.total_cost_usd, turns: result.num_turns, ...(o.keep ? { work } : {}) }, null, 2));
    }
  }
} catch (e) {
  failed = true;
  console.error(`lens-eval: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  if (o.keep || (failed && !o.dryRun)) console.error(`lens-eval: work folder kept at ${work}`);
  else removeWork(work, w.repo);
}
process.exit(failed ? 1 : 0);
