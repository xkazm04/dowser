#!/usr/bin/env node
// @ts-check
// temper - the /temper director's one CLI (.claude/skills/temper/SKILL.md). Zero dependencies; JSON on stdout;
// exit 0 done, 1 refused or red, 2 bad arguments. Working state is in <dowser>/.temper/ (gitignored); the committed
// day records are in docs/evals/temper/ (<date>.jsonl cycle rows, <date>.md report, modules.json, quality.jsonl).
//
//   charter init --from <json> --operator <name>   only in the start dialog: needs TEMPER_CHARTER_DIALOG=1 (guard.mjs)
//   charter show
//   day start [--date YYYY-MM-DD] [--approve a,b] [--veto c]   loop/<date> from master in Dowser; --approve/--veto are
//                                          the operator's answers on directions and need TEMPER_CHARTER_DIALOG=1 too
//   day resume | day end
//   repo start --repo <name> [--paths a,b] [--title t]   another build repo's branch in a worktree (+ its ledger)
//   repo paths --repo <name> --add a,b   widen a ledger repo's registered paths (active-runs check, then the same
//                                          entry completed and registered again with every path; a conflict refuses)
//   repo end --repo <name> [--status t]
//   cycle begin --target <module>|direction:<id> | --repo <name> --target <focus>   prints, with the rest, the `runner`
//                                          block: the launch inputs of the cycle runner (references/runner.md)
//   cycle end --file <cycle.json> [--repo <r>]   npm ci where a lockfile is newer than its node_modules (root, forge,
//                                          forge/static/app), then the gates, reads the e2e results, appends the row; the open
//                                          cycle is the --repo's, else the file's repo's, else the only one open
//   cycle reverify --n <n> [--repo <r>]   the same gates and e2e again on cycle n's unchanged tree (HEAD past it only by
//                                          record-only commits); appends a kind "reverify" row, the cycle's newest verdict
//   triage check --verdicts <json> --inbox <key>   reject/snooze share and the day's caps, before verdicts are recorded
//   modules bar [--instruments <dir>]      the five-part bar per Dowser module; writes docs/evals/temper/modules.json
//   proposals resolve --id <p> --commit <sha> [--note t]   a landed fix of a lens-scan proposal, for the bar
//                                          (docs/evals/temper/resolved.json; the lens-scan store is never written)
//   clock [--rate-limited --until <iso>]   {elapsed_min, remaining_min, ends_at, drain, stop}
//   report [--date YYYY-MM-DD]             writes docs/evals/temper/<date>.md (with the runners' skill issues, by where)
//   land [--repo <name>] [--dry-run]       the repo's own landing law (charter repos[].landing):
//                                          loop-ff (Dowser): ff master, push origin master, deploy Forge development
//                                            when green; red: reset loop/<date> to the last green commit
//                                          rebase-push (bp): rebase onto origin/master, gates + secret scan, push
//                                            HEAD:master; red: nothing pushed
//                                          commit-only (personas): gates + secret scan; never pushes
//
// Verified vs self-reported: what this script reads from a tool's own output (the runner's exit code, e2e result
// files, the scan ledger, quality-snapshot rows, e2e-coverage) is `verified`; what only the director's cycle file
// claims is `self-reported`; a missing, stale or signed-out instrument is `unverifiable`, never a pass.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { coverage as e2eCoverage } from '../../../../tools/e2e-coverage.mjs';
import { UsageError, checkProjectKey, isMain, parseFlags, temperHome } from '../../../../tools/temper-lib.mjs';
import { parseVerdicts } from '../../../../tools/temper-verdicts.mjs';

export const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO = resolve(SKILL_DIR, '..', '..', '..');
/** The day's default length (minutes) when the charter names no `until`, and the margin under which no cycle starts. */
export const WALL_MIN = 480;
export const DRAIN_MARGIN_MIN = 60;
/** The minimum share of reject + snooze among a cycle's decided cards. */
export const REJECT_SHARE = 0.2;
export const MAX_DIRECTIONS = 3;
/** Local-triage caps when the charter gives none (a delegation's caps are set in Jira; these stand in for them). */
export const DEFAULT_CAPS = { accepts_per_day: 10, rejects_per_day: 30 };
export const E2E_PROJECTS = /** @type {const} */ (['fixture', 'local', 'live']);
/** Every cycle runs these two; live runs after a deploy, and unverifiable there never blocks. */
const REQUIRED_E2E = ['fixture', 'local'];
export const DECIDER = 'delegate:temper';
const DEFAULT_LENS_SCAN = 'C:/Users/kazda/kiro/bp/.claude/skills/lens-scan';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const REFSPEC_RE = /^[A-Za-z0-9._-][A-Za-z0-9._/*-]*$/;
/** lens-scan statuses that still need work (declined, accepted, descoped and released do not). */
const OPEN_LENS = new Set(['proposed', 'approved', 'executing', 'failed', 'rework', 'done']);
/** quality-snapshot fields that must not grow (lib_cycles is a list: its length). */
export const QUALITY_KEYS = ['long_functions', 'dup_windows', 'lib_cycles', 'todos'];
const PARTS = /** @type {const} */ (['uat', 'proposals', 'scan_yield', 'quality', 'coverage']);
const CHARTER_KEYS = ['repos', 'until', 'out_of_bounds', 'limits', 'delegation', 'live'];
const REPO_KEYS = ['name', 'path', 'inbox_key', 'build', 'landing', 'gates', 'ledger', 'caps'];
const CYCLE_KEYS = ['target', 'repo', 'scan', 'other_scans', 'verdicts', 'built', 'uat', 'findings', 'outcomes', 'directions', 'parked', 'notes', 'skill_issues'];
/** What the cycle runner learned about the loop itself: each issue names where (a file, step or brief), what, the evidence and the fix. */
const SKILL_ISSUE_KEYS = ['where', 'what', 'evidence', 'fix'];
const VERDICT_KINDS = ['accept', 'reject', 'snooze', 'merge'];
const VERDICT_KEYS = ['ref', 'verdict', 'reason', 'note', 'into', 'until', 'inbox', 'recorded', 'deferred'];
/** Each landing kind's defaults: the branch, and the refspecs a push may target (guard.mjs reads the same). */
export const LANDINGS = {
  'loop-ff': { branch: 'loop/<date>', push: ['master', 'loop/*'] },
  'rebase-push': { branch: 'temper/<date>', push: ['master'] },
  'commit-only': { branch: 'temper/<date>', push: [] },
};
/** Secret patterns of the built-in scan (names only are ever printed, never the match). */
const SECRET_PATTERNS = [
  ['aws-access-key', /AKIA[0-9A-Z]{16}/], ['anthropic-key', /sk-ant-[A-Za-z0-9_-]{20,}/], ['openai-key', /sk-(?:proj-)?[A-Za-z0-9]{32,}/],
  ['github-token', /gh[pousr]_[A-Za-z0-9]{36,}/], ['slack-token', /xox[abpr]-[A-Za-z0-9-]{10,}/], ['atlassian-token', /ATATT[A-Za-z0-9_=-]{40,}/],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/], ['google-key', /AIza[0-9A-Za-z_-]{35}/],
];

/** A rule said no (exit 1). */
export class Refusal extends Error {}

/** @typedef {{status: number | null, stdout: string}} RunResult */
/** @typedef {(cmd: string, args: string[], o?: {cwd?: string, shell?: boolean}) => RunResult} Runner */
/** @typedef {{pid: number, cmd: string}} Proc */
/** @typedef {{list: () => Proc[], kill: (pid: number) => boolean}} Procs  the process lister and killer (injected in tests) */
/** @typedef {{root: string, home: string, env: NodeJS.ProcessEnv, now: () => Date, run: Runner, procs?: Procs}} Ctx */
/** @typedef {{contexts: string[], focus: string, uat: string[] | 'tests', coverage: string[]}} Module */
/** @typedef {{state: 'verified' | 'self-reported' | 'unverifiable', ok: boolean, detail: string}} Part */
/** @typedef {{kind: keyof typeof LANDINGS, branch: string, push: string[], deploy?: string}} Landing */
/** @typedef {{name: string, path: string, inbox_key: string, build: boolean, landing: Landing, gates: {run: string, when: 'land' | 'item'}[], ledger?: string, caps: {accepts_per_day: number, rejects_per_day: number}}} Repo */

/** The real runner: npm and shell lines through the shell, everything else directly. Output is captured, never printed. @type {Runner} */
export const realRun = (cmd, args, o = {}) => {
  const viaShell = o.shell === true || (process.platform === 'win32' && (cmd === 'npm' || cmd === 'npx'));
  /** @type {import('node:child_process').SpawnSyncOptionsWithStringEncoding} */
  const opts = { cwd: o.cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] };
  const r = viaShell ? spawnSync([cmd, ...args].join(' '), { ...opts, shell: true }) : spawnSync(cmd, args, opts);
  return { status: r.status, stdout: r.stdout ?? '' };
};

/**
 * The real process lister and killer. Windows: node processes with their command lines from Win32_Process, each
 * stopped by its PID with its child tree. Elsewhere: ps, and SIGTERM.
 * @type {Procs}
 */
export const realProcs = {
  list: () => {
    if (process.platform === 'win32') {
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"], { encoding: 'utf8', windowsHide: true });
      if (r.status !== 0 || !r.stdout.trim()) return [];
      try {
        const rows = JSON.parse(r.stdout);
        return (Array.isArray(rows) ? rows : [rows]).filter((x) => x && typeof x.CommandLine === 'string').map((x) => ({ pid: Number(x.ProcessId), cmd: x.CommandLine }));
      } catch { return []; }
    }
    const r = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
    return (r.stdout ?? '').split('\n').map((l) => l.trim().match(/^(\d+)\s+(.*)$/)).filter((m) => m !== null).map((m) => ({ pid: Number(m[1]), cmd: m[2] }));
  },
  kill: (pid) => {
    if (process.platform === 'win32') return spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).status === 0;
    try { process.kill(pid); return true; } catch { return false; }
  },
};

/** @returns {Ctx} */
export const realCtx = () => ({ root: REPO, home: temperHome(), env: process.env, now: () => new Date(), run: realRun, procs: realProcs });

// ------------------------------------------------------------------------------------------- small helpers

/** The local calendar day. @param {Date} d */
export const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** @param {string} root */
export const paths = (root) => ({
  state: join(root, '.temper'),
  charter: join(root, '.temper', 'charter.json'),
  day: join(root, '.temper', 'day.json'),
  /** the one open cycle file of the first version (repo dowser); read as Dowser's open cycle so a live day continues */
  legacyCycle: join(root, '.temper', 'cycle.json'),
  directions: join(root, '.temper', 'directions.json'),
  records: join(root, 'docs', 'evals', 'temper'),
  results: join(root, 'e2e', 'results'),
});

/** The open cycle of one repo: one file per repo, so builds in several repos run in parallel. @param {string} root @param {string} repo */
export const cycleFile = (root, repo) => join(root, '.temper', `cycle-${repo}.json`);

/**
 * Every open cycle, by repo, with the file that holds it. The first version's `.temper/cycle.json` counts as the open
 * cycle of the repo it names (dowser when it names none), unless that repo already has its own file.
 * @param {string} root @returns {Record<string, {file: string, cycle: any}>}
 */
export function openCycles(root) {
  const dir = join(root, '.temper');
  /** @type {Record<string, {file: string, cycle: any}>} */
  const out = {};
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir).sort()) {
    const m = n.match(/^cycle-([a-z0-9][a-z0-9-]*)\.json$/);
    if (m) out[m[1]] = { file: join(dir, n), cycle: readJson(join(dir, n)) };
  }
  const legacy = readJson(paths(root).legacyCycle);
  if (legacy) { const r = typeof legacy.repo === 'string' ? legacy.repo : 'dowser'; if (!out[r]) out[r] = { file: paths(root).legacyCycle, cycle: { ...legacy, repo: r } }; }
  return out;
}

/** "cycle 1 (lenses) in dowser, cycle 2 (area:src) in bp" @param {Record<string, {cycle: any}>} open */
const describeOpen = (open) => Object.entries(open).map(([r, o]) => `cycle ${o.cycle.n} (${o.cycle.target}) in ${r}`).join(', ');

/** @param {string} file @returns {any} undefined when the file is absent */
export function readJson(file) {
  if (!existsSync(file)) return undefined;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Refusal(`${file} is not valid JSON`); }
}

/** @param {string} file @param {unknown} value */
function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Rows of a JSONL file; unreadable lines are skipped. @param {string} file @returns {any[]} */
export function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim()).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}

/** git in a checkout (Dowser by default); throws Refusal on a non-zero exit. @param {Ctx} ctx @param {string} dir @param {...string} args */
function gitIn(ctx, dir, ...args) {
  const r = ctx.run('git', ['-C', dir, ...args]);
  if (r.status !== 0) throw new Refusal(`git ${args[0]} in ${dir} failed (exit ${r.status})`);
  return r.stdout.trim();
}
/** @param {Ctx} ctx @param {...string} args */
const git = (ctx, ...args) => gitIn(ctx, ctx.root, ...args);
/** @param {Ctx} ctx @param {string} dir @param {...string} args */
const gitOkIn = (ctx, dir, ...args) => ctx.run('git', ['-C', dir, ...args]).status === 0;
/** @param {Ctx} ctx @param {...string} args */
const gitOk = (ctx, ...args) => gitOkIn(ctx, ctx.root, ...args);

/** A comma list flag. @param {string | true | undefined} v */
const list = (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
/** The store form of a focus (`area: x` -> `area:x`). @param {unknown} f */
export const normFocus = (f) => (typeof f === 'string' ? f.trim().replace(/^(goal|area):\s+/, '$1:') : undefined);
/** @param {string} p */
const normPath = (p) => resolve(p).replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();

/** @param {string} [file] @returns {{order: string[], modules: Record<string, Module>}} */
export function loadModules(file = join(SKILL_DIR, 'modules.json')) {
  const m = JSON.parse(readFileSync(file, 'utf8'));
  return { order: Object.keys(m.modules), modules: m.modules };
}

// ------------------------------------------------------------------------------------------------ charter

/**
 * One repo of the charter, with its landing defaults filled in. @param {any} r @param {number} i @param {string} root
 * @returns {Repo}
 */
function validateRepo(r, i, root) {
  const at = `repos[${i}]`;
  if (!r || typeof r !== 'object') throw new UsageError(`${at} is {name, path, inbox_key, build, landing, gates, ledger?, caps?}`);
  for (const k of Object.keys(r)) if (!REPO_KEYS.includes(k)) throw new UsageError(`unknown key ${at}.${k} (${REPO_KEYS.join(', ')})`);
  if (typeof r.name !== 'string' || !SLUG_RE.test(r.name)) throw new UsageError(`${at}.name is a lowercase slug`);
  if (typeof r.path !== 'string' || !isAbsolute(r.path)) throw new UsageError(`${at}.path must be an absolute path`);
  if (!existsSync(r.path)) throw new UsageError(`${at}.path ${r.path} does not exist`);
  const inbox = checkProjectKey(r.inbox_key);
  if (typeof r.build !== 'boolean') throw new UsageError(`${at}.build is true or false`);
  const isDowser = normPath(r.path) === normPath(root);
  const kind = r.landing?.kind ?? (isDowser ? 'loop-ff' : 'commit-only');
  if (!(kind in LANDINGS)) throw new UsageError(`${at}.landing.kind is one of ${Object.keys(LANDINGS).join(', ')}`);
  if (kind === 'loop-ff' && !isDowser) throw new UsageError(`${at}: loop-ff (ff master + Forge deploy) is Dowser's landing only`);
  const def = LANDINGS[/** @type {keyof typeof LANDINGS} */ (kind)];
  const branch = r.landing?.branch ?? def.branch;
  if (typeof branch !== 'string' || !branch.includes('<date>') || !REFSPEC_RE.test(branch.replace('<date>', '2026-01-01'))) throw new UsageError(`${at}.landing.branch is a branch name with <date>`);
  const push = r.landing?.push ?? def.push;
  if (!Array.isArray(push) || push.some((x) => typeof x !== 'string' || !REFSPEC_RE.test(x))) throw new UsageError(`${at}.landing.push is a list of branch names (master, loop/*)`);
  if (kind === 'commit-only' && push.length) throw new UsageError(`${at}: a commit-only landing never pushes (landing.push must be empty)`);
  for (const k of Object.keys(r.landing ?? {})) if (!['kind', 'branch', 'push', 'deploy'].includes(k)) throw new UsageError(`unknown key ${at}.landing.${k}`);
  if (r.landing?.deploy !== undefined && (kind !== 'loop-ff' || r.landing.deploy !== 'forge-development')) throw new UsageError(`${at}.landing.deploy is only forge-development, only for loop-ff`);
  const gates = (r.gates ?? []).map((/** @type {any} */ g, /** @type {number} */ j) => {
    const run = typeof g === 'string' ? g : g?.run;
    const when = typeof g === 'string' ? 'land' : g?.when ?? 'land';
    if (typeof run !== 'string' || !run.trim() || !['land', 'item'].includes(when)) throw new UsageError(`${at}.gates[${j}] is a command line, or {run, when: land|item}`);
    return { run: run.trim(), when };
  });
  if (r.ledger !== undefined && typeof r.ledger !== 'string') throw new UsageError(`${at}.ledger is the repo-relative path of its active-runs ledger`);
  const caps = { ...DEFAULT_CAPS, ...(r.caps ?? {}) };
  if (!Number.isInteger(caps.accepts_per_day) || !Number.isInteger(caps.rejects_per_day) || caps.accepts_per_day < 0 || caps.rejects_per_day < 0) throw new UsageError(`${at}.caps are whole numbers`);
  const landing = /** @type {Landing} */ ({ kind, branch, push, ...(kind === 'loop-ff' ? { deploy: r.landing?.deploy ?? 'forge-development' } : {}) });
  return { name: r.name, path: r.path, inbox_key: inbox, build: r.build, landing, gates, ...(r.ledger ? { ledger: r.ledger } : {}), caps };
}

/**
 * Checks a charter draft; returns the stored form (without operator and signed_at).
 * @param {any} raw @param {{home: string, root: string}} o
 */
export function validateCharter(raw, { home, root }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new UsageError('the charter is a JSON object');
  if ('themes' in raw) throw new UsageError('a charter holds no themes: the operator does not rank them; directions come from the loop\'s proposals');
  for (const k of Object.keys(raw)) if (!CHARTER_KEYS.includes(k)) throw new UsageError(`unknown charter key ${k} (${CHARTER_KEYS.join(', ')})`);
  if (!Array.isArray(raw.repos) || !raw.repos.length || raw.repos.length > 4) throw new UsageError('repos is a list of 1-4 repos: Dowser and 2-3 others');
  const repos = raw.repos.map((/** @type {any} */ r, /** @type {number} */ i) => validateRepo(r, i, root));
  for (const k of ['name', 'inbox_key']) {
    const seen = repos.map((/** @type {any} */ r) => String(r[k]));
    const dup = seen.find((/** @type {string} */ v, /** @type {number} */ i) => seen.indexOf(v) !== i);
    if (dup) throw new UsageError(`repos: ${k} ${dup} is used twice`);
  }
  if (!repos.some((/** @type {Repo} */ r) => r.name === 'dowser' && normPath(r.path) === normPath(root))) throw new UsageError(`repos needs {name: "dowser"} at this checkout (${root})`);
  if (raw.until !== undefined && (typeof raw.until !== 'string' || !LOCAL_TIME_RE.test(raw.until) || Number.isNaN(Date.parse(raw.until)))) throw new UsageError('until is a local time, YYYY-MM-DDTHH:MM');
  const oob = raw.out_of_bounds ?? [];
  if (!Array.isArray(oob) || oob.some((x) => typeof x !== 'string' || !x.trim())) throw new UsageError('out_of_bounds is a list of paths or topics');
  const lim = raw.limits ?? {};
  const wall = lim.wall_min ?? WALL_MIN;
  if (!Number.isInteger(wall) || wall < 30 || wall > 24 * 60) throw new UsageError('limits.wall_min is a whole number of minutes');
  if (lim.usage_window !== undefined && typeof lim.usage_window !== 'string') throw new UsageError('limits.usage_window is text (the plan\'s window, e.g. "5 h rolling")');
  /** @type {Record<string, {until: string}>} */
  const delegation = {};
  for (const [k, v] of Object.entries(raw.delegation ?? {})) {
    if (!repos.some((/** @type {Repo} */ r) => r.inbox_key === k)) throw new UsageError(`delegation.${k} is not one of the charter's inboxes`);
    if (typeof v?.until !== 'string' || !DATE_RE.test(v.until)) throw new UsageError(`delegation.${k}.until is the date set in Jira Settings (YYYY-MM-DD)`);
    delegation[k] = { until: v.until };
  }
  const profile = raw.live?.profile ?? join(home, 'chrome-profile');
  if (typeof profile !== 'string') throw new UsageError('live.profile is a folder path');
  return {
    repos, ...(raw.until ? { until: raw.until } : {}), out_of_bounds: oob,
    limits: { wall_min: wall, ...(lim.usage_window ? { usage_window: lim.usage_window } : {}) },
    delegation, live: { profile },
  };
}

/** @param {Ctx} ctx @param {Record<string, string | true>} f */
function charterInit(ctx, f) {
  if (typeof f.operator !== 'string' || !f.operator.trim()) throw new UsageError('charter init needs --operator <name>: the operator signs the charter in the start dialog');
  if (typeof f.from !== 'string') throw new UsageError('charter init needs --from <json>');
  if (ctx.env.TEMPER_CHARTER_DIALOG !== '1') throw new Refusal('the charter is written only by the start dialog (TEMPER_CHARTER_DIALOG=1, with the operator present)');
  const raw = readJson(resolve(f.from));
  if (raw === undefined) throw new UsageError(`--from ${f.from} does not exist`);
  const charter = { version: 1, operator: f.operator.trim(), signed_at: ctx.now().toISOString(), ...validateCharter(raw, ctx) };
  const p = paths(ctx.root).charter;
  writeJson(p, charter);
  return { written: p, charter };
}

/** @param {Ctx} ctx */
function needCharter(ctx) {
  const c = readJson(paths(ctx.root).charter);
  if (!c) throw new Refusal('no charter: run the day-1 charter dialog (references/charter.md)');
  return c;
}

/** @param {any} charter @param {string} name @returns {Repo} */
function repoOf(charter, name) {
  const r = (charter.repos ?? []).find((/** @type {Repo} */ x) => x.name === name);
  if (!r) throw new UsageError(`--repo ${name} is not in the charter (${(charter.repos ?? []).map((/** @type {Repo} */ x) => x.name).join(', ')})`);
  return r;
}
/** @param {any} charter */
const dowserRepo = (charter) => repoOf(charter, 'dowser');

// -------------------------------------------------------------------------------------------------- day

/** @param {Ctx} ctx */
function needDay(ctx) {
  const d = readJson(paths(ctx.root).day);
  if (!d) throw new Refusal('no day: run day start');
  return d;
}

/** @param {Ctx} ctx @param {string} [dir] */
const cleanTree = (ctx, dir = ctx.root) => gitIn(ctx, dir, 'status', '--porcelain', '--untracked-files=no') === '';
/** Clean but for the day records (yesterday's report, regenerated at the start, rides onto the new branch). @param {Ctx} ctx */
const cleanButRecords = (ctx) => ctx.run('git', ['-C', ctx.root, 'status', '--porcelain', '--untracked-files=no']).stdout.split(/\r?\n/).filter(Boolean)
  .every((l) => l.slice(3).replaceAll('\\', '/').startsWith('docs/evals/temper/'));

/** @param {Ctx} ctx */
function readDirections(ctx) {
  return readJson(paths(ctx.root).directions) ?? { proposed: {}, approved: [], vetoed: [] };
}

/** @param {Ctx} ctx @param {Record<string, string | true>} f */
function dayStart(ctx, f) {
  const charter = needCharter(ctx);
  const date = typeof f.date === 'string' ? f.date : localDate(ctx.now());
  if (!DATE_RE.test(date)) throw new UsageError('--date is YYYY-MM-DD');
  const approve = list(f.approve), veto = list(f.veto);
  if ((approve.length || veto.length) && ctx.env.TEMPER_CHARTER_DIALOG !== '1') throw new Refusal('direction approvals are the operator\'s: they are given only in the start dialog (TEMPER_CHARTER_DIALOG=1)');
  const p = paths(ctx.root);
  const prev = readJson(p.day);
  if (prev && prev.date === date && !prev.ended_at) throw new Refusal(`the day ${date} is already started: run day resume`);
  const branch = dowserRepo(charter).landing.branch.replace('<date>', date);
  if (gitOk(ctx, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`)) throw new Refusal(`${branch} already exists: run day resume, or pick another --date`);
  if (!cleanButRecords(ctx)) throw new Refusal('the working tree has uncommitted changes outside docs/evals/temper/: commit or stash them first');
  const dirs = readDirections(ctx);
  for (const id of [...approve, ...veto]) if (!dirs.proposed[id]) throw new UsageError(`direction ${id} is not a pending proposal`);
  for (const id of approve) { dirs.approved.push(id); delete dirs.proposed[id]; }
  for (const id of veto) { dirs.vetoed.push(id); delete dirs.proposed[id]; }
  if (approve.length || veto.length) writeJson(p.directions, dirs);
  const base = git(ctx, 'rev-parse', 'master');
  git(ctx, 'branch', branch, 'master');
  // the day records ride onto the new branch, uncommitted (a red day's never reached master): set aside, then back
  const records = readRecords(ctx.root);
  if (records.size) gitOk(ctx, 'checkout', '-q', '--', 'docs/evals/temper');
  git(ctx, 'checkout', '-q', branch);
  if (records.size) mkdirSync(p.records, { recursive: true });
  for (const [n, text] of records) writeFileSync(join(p.records, n), text);
  const day = { date, branch, base, last_green: base, started_at: ctx.now().toISOString(), repos: {} };
  writeJson(p.day, day);
  for (const o of Object.values(openCycles(ctx.root))) rmSync(o.file);
  return { ...day, clock: clockOf(ctx, day), other_repos_due: otherReposDue(ctx, charter, date), approved: approve, vetoed: veto };
}

/** @param {Ctx} ctx */
function dayResume(ctx) {
  const day = needDay(ctx);
  if (day.ended_at) throw new Refusal(`the day ${day.date} has ended: run day start for a new day`);
  if (!gitOk(ctx, 'rev-parse', '--verify', '--quiet', `refs/heads/${day.branch}`)) throw new Refusal(`${day.branch} is gone`);
  if (git(ctx, 'rev-parse', '--abbrev-ref', 'HEAD') !== day.branch) {
    if (!cleanTree(ctx)) throw new Refusal(`not on ${day.branch}, and the working tree has uncommitted changes`);
    git(ctx, 'checkout', '-q', day.branch);
  }
  day.resumed = [...(day.resumed ?? []), ctx.now().toISOString()];
  writeJson(paths(ctx.root).day, day);
  const open = openCycles(ctx.root);
  const cycles = Object.values(open).map((o) => o.cycle);
  return { date: day.date, branch: day.branch, repos: day.repos ?? {}, ...(cycles.length ? { open_cycles: cycles } : {}), clock: clockOf(ctx, day),
    next: cycles.length ? `${describeOpen(open)} ${cycles.length > 1 ? 'were' : 'was'} open: re-read the files and finish each with cycle end --file <f> --repo <r>` : 'cycle begin' };
}

/** @param {Ctx} ctx */
function dayEnd(ctx) {
  const day = needDay(ctx);
  const openNow = openCycles(ctx.root);
  if (Object.keys(openNow).length) throw new Refusal(`${describeOpen(openNow)} still open: end each first (cycle end --file <f> --repo <r>)`);
  const open = Object.entries(day.repos ?? {}).filter(([, r]) => /** @type {any} */ (r).registered && !/** @type {any} */ (r).ended_at).map(([k]) => k);
  if (open.length) throw new Refusal(`deregister first: repo end --repo ${open.join(', ')}`);
  day.ended_at = ctx.now().toISOString();
  writeJson(paths(ctx.root).day, day);
  return { date: day.date, ended_at: day.ended_at, cycles: cycleRows(ctx.root, day.date).length, ...(day.landing ? { landing: day.landing } : {}), ...(day.landings ? { landings: day.landings } : {}) };
}

// ----------------------------------------------------------------------------------------- other repos

/** Where a build repo's day branch is checked out: outside every repo, under the Temper home. @param {Ctx} ctx @param {string} name @param {string} date */
export const repoWorktree = (ctx, name, date) => join(ctx.home, 'worktrees', `${name}-${date}`);

/**
 * Files a registered path drags in: a fix there moves them too, so a run that cannot write them cannot land green.
 * Each applies only when the repo has the file. personas: a UI fix lowers a census baseline (the ratchet), c6.
 */
export const PATH_COMPANIONS = [{ when: /^src\//, path: 'scripts/census/rules.json', why: 'a fix under src/ lowers the census baseline (the ratchet)' }];

/** A registered path (a file, a dir, or a glob with * and **) as a test on repo-relative file paths. @param {string} p */
export function pathMatcher(p) {
  const s = p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!/[*?]/.test(s)) return (/** @type {string} */ f) => f === s || f.startsWith(`${s}/`);
  const re = new RegExp(`^${s.split(/(\*\*\/?|\*|\?)/).map((t) => (t === '**' || t === '**/' ? '.*' : t === '*' ? '[^/]*' : t === '?' ? '[^/]' : t.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join('')}$`);
  return (/** @type {string} */ f) => re.test(f);
}

/**
 * Files the repo itself marks as read-only to agents: a quoted file path on a source line that says READ_ONLY or
 * "needs a human" (personas: scripts/docs/check-doc-counts.mjs `READ_ONLY = new Set(['.claude/CLAUDE.md'])`).
 * @param {Ctx} ctx @param {string} repoPath @returns {{path: string, at: string}[]}
 */
export function readOnlyMarks(ctx, repoPath) {
  const r = ctx.run('git', ['-C', repoPath, 'grep', '-n', '-I', '-E', 'READ_ONLY|needs a human', '--', '*.mjs', '*.js', '*.cjs', '*.ts']);
  if (r.status !== 0) return [];
  /** @type {{path: string, at: string}[]} */
  const out = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = line.match(/^([^:]+):(\d+):(.*)$/);
    if (!m) continue;
    for (const q of m[3].matchAll(/['"`]([\w.-][\w./-]*\.[A-Za-z0-9]+)['"`]/g)) if (q[1].includes('/') || q[1].startsWith('.')) out.push({ path: q[1], at: `${m[1]}:${m[2]}` });
  }
  return out;
}

/**
 * The paths to register, with their companions added, and a warning for each one the repo marks as needing a human.
 * @param {Ctx} ctx @param {string} repoPath @param {string[]} asked
 * @returns {{paths: string[], companions: {path: string, why: string}[], warnings: string[]}}
 */
export function pathAdvice(ctx, repoPath, asked) {
  const companions = PATH_COMPANIONS.filter((c) => asked.some((p) => c.when.test(p)) && !asked.some((p) => pathMatcher(p)(c.path)) && existsSync(join(repoPath, c.path)))
    .map(({ path, why }) => ({ path, why }));
  const all = [...asked, ...companions.map((c) => c.path)];
  const warnings = readOnlyMarks(ctx, repoPath).filter((m) => asked.some((p) => pathMatcher(p)(m.path)))
    .map((m) => `${m.path} is marked read-only for agents by the repo (${m.at}): a change there needs a human, unless the operator lifted it`);
  return { paths: all, companions, warnings };
}

/** @param {Ctx} ctx @param {Record<string, string | true>} f */
function repoStart(ctx, f) {
  const charter = needCharter(ctx);
  const day = needDay(ctx);
  if (typeof f.repo !== 'string') throw new UsageError('repo start needs --repo <name>');
  const r = repoOf(charter, f.repo);
  if (r.name === 'dowser') throw new UsageError('Dowser\'s branch is made by day start');
  if (!r.build) throw new Refusal(`${r.name} is scanned only (build: false in the charter)`);
  if (day.repos?.[r.name]) throw new Refusal(`${r.name} is already started today: ${day.repos[r.name].worktree}`);
  const asked = list(f.paths);
  if (r.ledger && !asked.length) throw new UsageError(`${r.name} keeps an active-runs ledger: name the paths you will touch (--paths a,b)`);
  const advice = asked.length ? pathAdvice(ctx, r.path, asked) : { paths: asked, companions: [], warnings: [] };
  const pathsArg = advice.paths;
  const branch = r.landing.branch.replace('<date>', day.date);
  const wt = repoWorktree(ctx, r.name, day.date);
  let base;
  if (r.landing.kind === 'rebase-push') { gitIn(ctx, r.path, 'fetch', '-q', 'origin'); base = gitIn(ctx, r.path, 'rev-parse', 'origin/master'); }
  else base = gitIn(ctx, r.path, 'rev-parse', 'HEAD');
  const slug = `temper-${day.date}`;
  if (r.ledger) {
    const script = join(r.path, 'scripts', 'active-runs.mjs');
    if (!existsSync(script)) throw new Refusal(`${r.name} names a ledger, but has no scripts/active-runs.mjs to keep it`);
    const check = ctx.run('node', [script, 'check', '--paths', ...pathsArg], { cwd: r.path });
    if (check.status === 2) throw new Refusal(`${r.name}: a live session holds these paths (active-runs check); pick others`);
    if (check.status !== 0) throw new Refusal(`${r.name}: active-runs check failed (exit ${check.status})`);
  }
  mkdirSync(dirname(wt), { recursive: true });
  gitIn(ctx, r.path, 'worktree', 'add', '-q', '-b', branch, wt, base);
  let registered = false;
  if (r.ledger) {
    const title = typeof f.title === 'string' ? f.title : `temper: the daily loop's builds (${day.date})`;
    const reg = ctx.run('node', [join(r.path, 'scripts', 'active-runs.mjs'), 'register', '--slug', slug, '--title', title, '--paths', ...pathsArg], { cwd: r.path });
    if (reg.status !== 0) throw new Refusal(`${r.name}: active-runs register failed (exit ${reg.status}); the worktree ${wt} is made`);
    registered = true;
  }
  day.repos = { ...(day.repos ?? {}), [r.name]: { branch, worktree: wt, base, ...(registered ? { registered: slug, paths: pathsArg, title: typeof f.title === 'string' ? f.title : undefined } : {}), started_at: ctx.now().toISOString() } };
  writeJson(paths(ctx.root).day, day);
  return { repo: r.name, ...day.repos[r.name], landing: r.landing.kind, item_gates: r.gates.filter((g) => g.when === 'item').map((g) => g.run),
    ...(advice.companions.length ? { companions: advice.companions } : {}), ...(advice.warnings.length ? { warnings: advice.warnings } : {}) };
}

/**
 * Paths another session's live ledger entry holds among `paths` (active-runs check --json), the day's own entry left
 * out. Refuses when the check itself fails. @param {Ctx} ctx @param {Repo} r @param {string[]} paths @param {string} [own]
 * @returns {{slug: string, overlap: string[]}[]}
 */
function ledgerConflicts(ctx, r, paths, own) {
  const c = ctx.run('node', [join(r.path, 'scripts', 'active-runs.mjs'), 'check', '--json', '--paths', ...paths], { cwd: r.path });
  if (c.status === 0) return [];
  if (c.status !== 2) throw new Refusal(`${r.name}: active-runs check failed (exit ${c.status})`);
  let out;
  try { out = JSON.parse(c.stdout); } catch { throw new Refusal(`${r.name}: active-runs check found a conflict, and its --json answer is unreadable`); }
  return (Array.isArray(out?.conflicts) ? out.conflicts : []).filter((/** @type {any} */ x) => x?.slug !== own);
}

/**
 * Widens the paths a ledger repo's day entry holds. The ledger has one writer (the repo's scripts/active-runs.mjs) and
 * no update command, so the entry is completed and registered again under the same slug with every path: one active
 * entry, its paths widened. A path another live entry holds refuses it before anything is written.
 * @param {Ctx} ctx @param {Record<string, string | true>} f
 */
function repoPaths(ctx, f) {
  const charter = needCharter(ctx);
  const day = needDay(ctx);
  if (typeof f.repo !== 'string') throw new UsageError('repo paths needs --repo <name>');
  const r = repoOf(charter, f.repo);
  const s = day.repos?.[r.name];
  if (!r.ledger) throw new UsageError(`${r.name} keeps no active-runs ledger: its paths are not registered`);
  if (!s?.registered || s.ended_at) throw new Refusal(`${r.name} has no registered run today (repo start --repo ${r.name} --paths a,b)`);
  const add = list(f.add);
  if (!add.length) throw new UsageError('repo paths needs --add a,b (the paths to add)');
  /** @type {string[] | undefined} */
  const had = Array.isArray(s.paths) ? s.paths : (f.paths !== undefined ? list(f.paths) : undefined);
  if (!had?.length) throw new UsageError(`${r.name}'s day entry predates recorded paths: also pass --paths <the paths given at repo start>`);
  const advice = pathAdvice(ctx, r.path, add);
  const fresh = advice.paths.filter((p) => !had.includes(p));
  const extra = { ...(advice.companions.length ? { companions: advice.companions } : {}), ...(advice.warnings.length ? { warnings: advice.warnings } : {}) };
  if (!fresh.length) return { repo: r.name, slug: s.registered, paths: had, added: [], ...extra };
  const conflicts = ledgerConflicts(ctx, r, fresh, s.registered);
  if (conflicts.length) throw new Refusal(`${r.name}: a live session holds ${conflicts.map((c) => `${(c.overlap ?? []).join(', ')} (${c.slug})`).join('; ')}; pick other paths`);
  const script = join(r.path, 'scripts', 'active-runs.mjs');
  const all = [...had, ...fresh];
  const title = s.title ?? `temper: the daily loop's builds (${day.date})`;
  const done = ctx.run('node', [script, 'complete', '--slug', s.registered, '--status', `re-registered with paths widened (+${fresh.join(', ')})`], { cwd: r.path });
  if (done.status !== 0) throw new Refusal(`${r.name}: active-runs complete failed (exit ${done.status}); the entry is unchanged`);
  const reg = ctx.run('node', [script, 'register', '--slug', s.registered, '--title', title, '--paths', ...all], { cwd: r.path });
  if (reg.status !== 0) {
    s.ended_at = ctx.now().toISOString();
    writeJson(paths(ctx.root).day, day);
    throw new Refusal(`${r.name}: active-runs register failed (exit ${reg.status}) after the old entry was completed: the run is no longer registered; repo start again`);
  }
  s.paths = all;
  s.title = title;
  writeJson(paths(ctx.root).day, day);
  return { repo: r.name, slug: s.registered, paths: all, added: fresh, ...extra };
}

/** @param {Ctx} ctx @param {Record<string, string | true>} f */
function repoEnd(ctx, f) {
  const charter = needCharter(ctx);
  const day = needDay(ctx);
  if (typeof f.repo !== 'string') throw new UsageError('repo end needs --repo <name>');
  const r = repoOf(charter, f.repo);
  const s = day.repos?.[r.name];
  if (!s) throw new Refusal(`${r.name} was not started today`);
  if (s.ended_at) return { repo: r.name, ...s };
  if (s.registered) {
    const status = typeof f.status === 'string' ? f.status : `completed (branch ${s.branch}, ${gitIn(ctx, s.worktree, 'rev-parse', '--short', 'HEAD')})`;
    const c = ctx.run('node', [join(r.path, 'scripts', 'active-runs.mjs'), 'complete', '--slug', s.registered, '--status', status], { cwd: r.path });
    if (c.status !== 0) throw new Refusal(`${r.name}: active-runs complete failed (exit ${c.status})`);
  }
  s.ended_at = ctx.now().toISOString();
  writeJson(paths(ctx.root).day, day);
  return { repo: r.name, ...s };
}

// ------------------------------------------------------------------------------------------------ clock

/**
 * The day's end is the charter's `until` (a local time), else start + limits.wall_min (default 8 h). It drains under
 * DRAIN_MARGIN_MIN left, or while rate-limited (the usage window).
 * @param {Ctx} ctx @param {any} day
 */
export function clockOf(ctx, day) {
  const charter = readJson(paths(ctx.root).charter);
  const now = ctx.now().getTime();
  const start = Date.parse(day.started_at);
  const end = typeof charter?.until === 'string' ? Date.parse(charter.until) : start + (charter?.limits?.wall_min ?? WALL_MIN) * 60000;
  const elapsed = Math.max(0, Math.floor((now - start) / 60000));
  const limited = typeof day.rate_limited_until === 'string' && Date.parse(day.rate_limited_until) > now;
  const remaining = Math.max(0, Math.floor((end - now) / 60000));
  return {
    elapsed_min: elapsed, remaining_min: remaining, ends_at: new Date(end).toISOString(), ...(charter?.until ? { until: charter.until } : { wall_min: Math.round((end - start) / 60000) }),
    drain: remaining < DRAIN_MARGIN_MIN || limited, stop: now >= end,
    ...(limited ? { rate_limited_until: day.rate_limited_until, wake_in_s: Math.ceil((Date.parse(day.rate_limited_until) - now) / 1000) } : {}),
  };
}

/** @param {Ctx} ctx @param {Record<string, string | true>} f */
function clock(ctx, f) {
  const day = needDay(ctx);
  if (f['rate-limited'] === true) {
    if (typeof f.until !== 'string' || Number.isNaN(Date.parse(f.until))) throw new UsageError('--rate-limited needs --until <ISO time> (when the usage window resets)');
    day.rate_limited_until = new Date(Date.parse(f.until)).toISOString();
    writeJson(paths(ctx.root).day, day);
  }
  return clockOf(ctx, day);
}

// ------------------------------------------------------------------------------------------------ cycles

/** The raw rows (cycle and reverify) of one day, or of every day. @param {string} root @param {string} [date] */
function dayRows(root, date) {
  const dir = paths(root).records;
  if (!existsSync(dir)) return [];
  const files = date ? [`${date}.jsonl`] : readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort();
  return files.flatMap((n) => readJsonl(join(dir, n)));
}

/**
 * Each cycle with its newest verdict: a later `kind: "reverify"` row of the same date, repo and n replaces the cycle's
 * head, green, red_because and verified, and `reverified` keeps what it replaced. The bar, the report and land read
 * these. @param {any[]} rows
 */
export function newestVerdicts(rows) {
  const key = (/** @type {any} */ r) => `${r.date}|${r.repo ?? 'dowser'}|${r.n}`;
  /** @type {Map<string, any>} */
  const last = new Map();
  for (const r of rows) if (r.kind === 'reverify') last.set(key(r), r);
  return rows.filter((r) => r.kind === 'cycle').map((c) => {
    const v = last.get(key(c));
    if (!v) return c;
    const { red_because: _rb, ...rest } = c;
    return { ...rest, head: v.head, green: v.green, ...(v.green ? {} : { red_because: v.red_because ?? [] }), verified: v.verified,
      reverified: { at: v.at, first: { head: c.head, green: c.green, ...(c.red_because ? { red_because: c.red_because } : {}) } } };
  });
}

/** Cycle rows of one day, or of every day, each with its newest verdict. @param {string} root @param {string} [date] */
export function cycleRows(root, date) {
  return newestVerdicts(dayRows(root, date));
}

/** The other repos are scanned every second day: due when the ledger has no scan of the inbox today or yesterday. @param {Ctx} ctx @param {any} charter @param {string} date */
function otherReposDue(ctx, charter, date) {
  const scans = readJsonl(join(ctx.home, 'scans.jsonl'));
  const yesterday = localDate(new Date(Date.parse(`${date}T12:00:00`) - 86400000));
  return (charter.repos ?? []).filter((/** @type {Repo} */ r) => r.name !== 'dowser' && !scans.some((s) => s.project_key === r.inbox_key && s.ok && typeof s.ts === 'string'
    && [date, yesterday].includes(localDate(new Date(s.ts))))).map((/** @type {Repo} */ r) => ({ name: r.name, path: r.path, inbox_key: r.inbox_key }));
}

/** @param {Ctx} ctx @param {string} target */
function resolveTarget(ctx, target) {
  const { modules } = loadModules();
  if (modules[target]) return { kind: 'module', module: target, focus: modules[target].focus };
  const m = target.match(/^direction:(.+)$/);
  if (!m) throw new UsageError(`--target is a module (${Object.keys(modules).join(', ')}) or direction:<id>`);
  const dirs = readDirections(ctx);
  if (!dirs.approved.includes(m[1])) throw new Refusal(`direction ${m[1]} is not approved by the operator (the start dialog approves directions)`);
  const d = readJson(join(paths(ctx.root).records, 'modules.json'))?.directions_log?.[m[1]] ?? {};
  return { kind: 'direction', direction: m[1], ...(d.module ? { module: d.module } : {}), focus: d.title ? `goal:${d.title}` : modules[d.module]?.focus };
}

const FOCUS_FORMS = 'area:<path> (a path in the repo) or goal:<text>, with no space after the colon (the lens-scan store refuses "goal: text")';

/**
 * Another repo's target is a focus in the store's exact form. A space after the colon, an unknown prefix, an empty
 * goal or an area path the worktree does not hold is a usage error that names the accepted forms.
 * @param {string} target @param {string} worktree @returns {string}
 */
export function checkFocus(target, worktree) {
  const m = target.match(/^(area|goal):(.*)$/s);
  if (!m) throw new UsageError(`--target ${JSON.stringify(target)} is not a focus: ${FOCUS_FORMS}`);
  if (/^\s/.test(m[2])) throw new UsageError(`--target ${JSON.stringify(target)}: write ${m[1]}:${m[2].trim()} (${FOCUS_FORMS})`);
  if (!m[2].trim()) throw new UsageError(`--target ${m[1]}: is empty: ${FOCUS_FORMS}`);
  if (m[1] === 'area' && !existsSync(resolve(worktree, m[2]))) throw new UsageError(`--target ${target}: ${m[2]} is not a path in ${worktree}`);
  return target;
}

/** @param {Ctx} ctx @param {Record<string, string | true>} f */
function cycleBegin(ctx, f) {
  const charter = needCharter(ctx);
  const day = needDay(ctx);
  if (day.ended_at) throw new Refusal(`the day ${day.date} has ended`);
  const c = clockOf(ctx, day);
  if (c.drain) throw new Refusal(c.rate_limited_until ? `draining: rate-limited until ${c.rate_limited_until}` : `draining: ${c.remaining_min} min left before ${c.ends_at}`);
  const repo = typeof f.repo === 'string' ? repoOf(charter, f.repo) : dowserRepo(charter);
  if (typeof f.target !== 'string') {
    throw new UsageError(repo.name === 'dowser' ? 'cycle begin needs --target <module>|direction:<id>' : `cycle begin --repo ${repo.name} needs --target <focus>: ${FOCUS_FORMS}`);
  }
  const openNow = openCycles(ctx.root);
  if (openNow[repo.name]) throw new Refusal(`cycle ${openNow[repo.name].cycle.n} (${openNow[repo.name].cycle.target}) is still open in ${repo.name}: end it first (one open cycle per repo)`);
  /** @type {Record<string, unknown>} */
  let t;
  if (repo.name === 'dowser') t = resolveTarget(ctx, f.target);
  else {
    if (!repo.build) throw new Refusal(`${repo.name} is scanned only (build: false)`);
    if (!day.repos?.[repo.name]) throw new Refusal(`start ${repo.name} first: repo start --repo ${repo.name}`);
    const focus = checkFocus(f.target, day.repos[repo.name].worktree);
    t = { kind: 'focus', focus, worktree: day.repos[repo.name].worktree, branch: day.repos[repo.name].branch, item_gates: repo.gates.filter((g) => g.when === 'item').map((g) => g.run) };
  }
  const head = repo.name === 'dowser' ? git(ctx, 'rev-parse', 'HEAD') : gitIn(ctx, day.repos[repo.name].worktree, 'rev-parse', 'HEAD');
  // numbers stay unique per day across repos: past the day's rows and every open cycle
  const n = Math.max(0, ...cycleRows(ctx.root, day.date).map((r) => (Number.isInteger(r.n) ? r.n : 0)),
    ...Object.values(openNow).filter((o) => o.cycle.date === day.date).map((o) => (Number.isInteger(o.cycle.n) ? o.cycle.n : 0))) + 1;
  const cycle = { n, date: day.date, repo: repo.name, target: f.target, begun_at: ctx.now().toISOString(), head };
  writeJson(cycleFile(ctx.root, repo.name), cycle);
  // a scan reads the day's work, never the repo's master: Dowser's loop/<date>, a started repo's temper/<date>
  const dayRef = (/** @type {string} */ name) => (name === 'dowser' ? day.branch : day.repos?.[name]?.branch);
  const scan = (/** @type {string} */ name, /** @type {string} */ path, /** @type {string} */ inbox, /** @type {unknown} */ focus) => {
    const ref = dayRef(name);
    return `node tools/temper-scan.mjs --repo "${path}" --project-key ${inbox}${typeof ref === 'string' ? ` --ref ${ref}` : ''}${typeof focus === 'string' ? ` --focus "${focus}"` : ''} --budget-usd 8`;
  };
  const command = scan(repo.name, repo.path, repo.inbox_key, t.focus);
  return {
    ...cycle, ...t, ...(repo.name === 'dowser' ? { branch: day.branch } : {}), clock: c,
    scan: { [repo.name]: command,
      others_due: otherReposDue(ctx, charter, day.date).filter((/** @type {any} */ r) => r.name !== repo.name).map((/** @type {any} */ r) => ({ ...r, command: scan(r.name, r.path, r.inbox_key, undefined) })) },
    triage: { min_reject_share: REJECT_SHARE, caps: repo.caps, check: `temper.mjs triage check --verdicts <file> --inbox ${repo.inbox_key}`, out_of_bounds: charter.out_of_bounds ?? [] },
    runner: runnerBlock(ctx, { charter, day, repo, cycle, focus: t.focus, command, ...(Array.isArray(t.item_gates) ? { itemGates: t.item_gates } : {}) }),
  };
}

/** The repo law files a runner reads, those present. */
const LAW_FILES = ['CLAUDE.md', 'AGENTS.md', '.claude/CLAUDE.md'];

/**
 * The cycle runner's launch inputs (references/runner.md): the director's launch message is a copy of this block.
 * Dowser builds in a worktree of its own off the day branch (temper/c<n>), which the director merges; another repo
 * builds in its day worktree from repo start, on its temper/<date> branch.
 * @param {Ctx} ctx
 * @param {{charter: any, day: any, repo: Repo, cycle: {n: number, date: string, target: string}, focus: unknown, command: string, itemGates?: unknown}} o
 */
export function runnerBlock(ctx, { charter, day, repo, cycle, focus, command, itemGates }) {
  const { n, date, target } = cycle;
  const isDowser = repo.name === 'dowser';
  const today = triageLimits([], verdictsToday(ctx.root, date, repo.inbox_key), repo.caps).today;
  const yesterday = localDate(new Date(Date.parse(`${date}T12:00:00`) - 86400000));
  const carried = carriedOf(cycleRows(ctx.root, yesterday)).filter((v) => v.inbox === repo.inbox_key)
    .map((v) => ({ ref: v.ref, ...(typeof v.note === 'string' ? { note: v.note } : {}) }));
  let work;
  if (isDowser) {
    const worktree = join(ctx.home, 'worktrees', `dowser-c${n}`);
    work = { worktree, branch: `temper/c${n}`, from: day.branch, create: `git worktree add -b temper/c${n} "${worktree}" ${day.branch}`,
      reaches_day_branch: `the director merges temper/c${n} into ${day.branch}; cycle end verifies the merged tree` };
  } else {
    const r = day.repos?.[repo.name] ?? {};
    work = { worktree: r.worktree, branch: r.branch, from: r.branch, reaches_day_branch: `commits in the worktree are on ${r.branch}; the director lands it under the repo's law` };
  }
  return {
    brief: join(SKILL_DIR, 'references', 'runner.md'), loop_root: ctx.root,
    repo: repo.name, path: repo.path, inbox: repo.inbox_key, n, target, ...(typeof focus === 'string' ? { focus } : {}), scan: command,
    caps: { ...repo.caps, used: today, left: { accepts: Math.max(0, repo.caps.accepts_per_day - today.accepts), rejects: Math.max(0, repo.caps.rejects_per_day - today.rejects) } },
    carried, work, ...(Array.isArray(itemGates) ? { item_gates: itemGates } : {}), out_of_bounds: charter.out_of_bounds ?? [],
    laws: LAW_FILES.map((f) => join(repo.path, f)).filter((f) => existsSync(f)),
    cycle_file: join(ctx.home, 'runs', `cycle-${n}-${repo.name}.json`),
  };
}

/** Counts of one e2e result file. @param {any[]} rows */
const e2eCounts = (rows) => ({
  pass: rows.filter((r) => r.state === 'pass').length, fail: rows.filter((r) => r.state === 'fail').length,
  unverifiable: rows.filter((r) => r.state === 'unverifiable').length, flaky: rows.filter((r) => r.flaky).length,
});

/** The e2e result files with their age. @param {string} root @returns {Record<string, {rows: any[], mtimeMs: number}>} */
function readE2eResults(root) {
  /** @type {Record<string, {rows: any[], mtimeMs: number}>} */
  const out = {};
  for (const p of E2E_PROJECTS) {
    const f = join(paths(root).results, `${p}.json`);
    const rows = readJson(f);
    if (Array.isArray(rows)) out[p] = { rows, mtimeMs: statSync(f).mtimeMs };
  }
  return out;
}

/**
 * The verified UAT of a moment: per project its counts when its file is newer than `sinceMs`, else `stale` or `missing`.
 * green: fixture and local fresh with a pass and no fail, and no fresh live fail (live unverifiable never blocks).
 * @param {string} root @param {number} sinceMs
 */
export function uatSince(root, sinceMs) {
  const res = readE2eResults(root);
  /** @type {Record<string, any>} */
  const uat = {};
  const why = [];
  for (const p of E2E_PROJECTS) {
    const r = res[p];
    if (!r) uat[p] = { state: 'missing' };
    else if (r.mtimeMs < sinceMs) uat[p] = { state: 'stale' };
    else uat[p] = { state: 'fresh', ...e2eCounts(r.rows) };
    const u = uat[p];
    if (REQUIRED_E2E.includes(p) && u.state !== 'fresh') why.push(`e2e ${p}: ${u.state}`);
    else if (u.state === 'fresh' && u.fail) why.push(`e2e ${p}: ${u.fail} failed`);
    else if (REQUIRED_E2E.includes(p) && !u.pass) why.push(`e2e ${p}: no spec passed`);
  }
  return { uat, green: !why.length, why };
}

/** Dowser's package folders: each installed tree must match its lockfile before a gate runs there. */
export const DEP_DIRS = ['.', 'forge', 'forge/static/app'];

/**
 * The comparable content of a lockfile's `packages`: one line per installed package (`node_modules/...`, never the root
 * entry, never an optional one, which a platform may skip), sorted. npm's hidden lockfile
 * (node_modules/.package-lock.json) has the same entries for what is installed, so the two projections hash alike
 * exactly when the tree is the lockfile's.
 * @param {any} lock @returns {{required: string[], optional: Map<string, string>}}
 */
function lockProjection(lock) {
  const required = [];
  /** @type {Map<string, string>} */
  const optional = new Map();
  for (const [k, v] of Object.entries(lock?.packages ?? {})) {
    if (!k.startsWith('node_modules/') && !k.includes('/node_modules/')) continue;
    const line = `${k} ${/** @type {any} */ (v)?.version ?? ''} ${/** @type {any} */ (v)?.integrity ?? /** @type {any} */ (v)?.resolved ?? ''}`;
    if (/** @type {any} */ (v)?.optional) optional.set(k, line); else required.push(line);
  }
  return { required: required.sort(), optional };
}

/** @param {string[]} lines */
const hashLines = (lines) => createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16);

/**
 * Whether one folder's node_modules is its package-lock.json: `no lockfile`, `in sync`, or `drift` with why. A missing
 * or unreadable hidden lockfile is drift (the tree was never installed by npm 7+, or predates the lockfile).
 * @param {string} dir @returns {{state: 'no lockfile' | 'in sync' | 'drift', lock?: string, installed?: string, why?: string}}
 */
export function depDrift(dir) {
  const lockFile = join(dir, 'package-lock.json');
  if (!existsSync(lockFile)) return { state: 'no lockfile' };
  /** @param {string} f */
  const parse = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return undefined; } };
  const lock = lockProjection(parse(lockFile));
  const lockHash = hashLines(lock.required);
  const hidden = join(dir, 'node_modules', '.package-lock.json');
  if (!existsSync(hidden)) return { state: 'drift', lock: lockHash, why: 'node_modules has no .package-lock.json' };
  const raw = parse(hidden);
  if (!raw) return { state: 'drift', lock: lockHash, why: 'node_modules/.package-lock.json is unreadable' };
  const inst = lockProjection(raw);
  const instHash = hashLines(inst.required);
  if (instHash !== lockHash) return { state: 'drift', lock: lockHash, installed: instHash, why: 'the installed tree is not the lockfile\'s' };
  for (const [k, line] of inst.optional) if (lock.optional.get(k) !== line) return { state: 'drift', lock: lockHash, installed: instHash, why: `optional ${k} differs from the lockfile` };
  return { state: 'in sync', lock: lockHash, installed: instHash };
}

/**
 * Before the gates: every Dowser package folder whose node_modules is not its lockfile gets `npm ci` first. A failed
 * install is a red with its reason (a gate run on a stale tree fails for a reason that is not the build's).
 * @param {Ctx} ctx @returns {{deps: Record<string, {state: string, why?: string, exit?: number | null}>, why: string[]}}
 */
export function syncDeps(ctx) {
  /** @type {Record<string, {state: string, why?: string, exit?: number | null}>} */
  const deps = {};
  const why = [];
  for (const d of DEP_DIRS) {
    const dir = d === '.' ? ctx.root : join(ctx.root, d);
    const s = depDrift(dir);
    if (s.state !== 'drift') { if (s.state === 'in sync') deps[d] = { state: s.state }; continue; }
    const r = ctx.run('npm', ['ci'], { cwd: dir });
    if (r.status === 0) deps[d] = { state: 'installed', why: /** @type {string} */ (s.why) };
    else {
      deps[d] = { state: 'failed', why: /** @type {string} */ (s.why), exit: r.status };
      why.push(`npm ci in ${d} failed (exit ${r.status}; ${s.why})`);
    }
  }
  return { deps, why };
}

/** npm scripts in a checkout. @param {Ctx} ctx @param {string[]} scripts @param {string} [cwd] @returns {Record<string, 'pass' | 'fail'>} */
function runGates(ctx, scripts, cwd = ctx.root) {
  return Object.fromEntries(scripts.map((s) => [s, ctx.run('npm', ['run', s], { cwd }).status === 0 ? 'pass' : 'fail']));
}
/** The charter's command-line gates of one repo. @param {Ctx} ctx @param {Repo} repo @param {string} cwd @returns {Record<string, 'pass' | 'fail'>} */
function runRepoGates(ctx, repo, cwd) {
  return Object.fromEntries(repo.gates.filter((g) => g.when === 'land').map((g) => [g.run, ctx.run(g.run, [], { cwd, shell: true }).status === 0 ? 'pass' : 'fail']));
}

/**
 * The reject/snooze share of decided cards. A merge folds a card into another item: it is neither an accept nor a
 * reject, so it stays out of the share (it still counts against Forge's reject cap, triageLimits).
 * @param {Record<string, number>} c
 */
export function rejectShare(c) {
  const decided = (c.accept ?? 0) + (c.reject ?? 0) + (c.snooze ?? 0);
  const share = decided ? ((c.reject ?? 0) + (c.snooze ?? 0)) / decided : undefined;
  return { decided, ...(share !== undefined ? { share: Number(share.toFixed(3)) } : {}), ok: !decided || /** @type {number} */ (share) >= REJECT_SHARE };
}

/**
 * Checks verdicts as recorded (live, through temper-verdicts) or local only (the inbox had no valid delegation, so the
 * live inbox keeps its cards undecided). Each gets decided_by delegate:temper.
 * @param {unknown} arr @returns {any[]}
 */
export function checkVerdicts(arr) {
  if (!Array.isArray(arr)) throw new UsageError('verdicts is a list of {ref, verdict, reason?, note?, into?, until?, inbox, recorded: live|local, deferred?: "cap"}');
  return arr.map((v, i) => {
    if (!v || typeof v !== 'object') throw new UsageError(`verdicts[${i}] is an object`);
    for (const k of Object.keys(v)) if (!VERDICT_KEYS.includes(k)) throw new UsageError(`unknown key verdicts[${i}].${k}`);
    if (typeof v.ref !== 'string' || !VERDICT_KINDS.includes(v.verdict)) throw new UsageError(`verdicts[${i}] needs ref and verdict (${VERDICT_KINDS.join(', ')})`);
    if (v.verdict === 'reject' && (typeof v.reason !== 'string' || (v.reason === 'other' && typeof v.note !== 'string'))) throw new UsageError(`${v.ref}: a reject needs its honest reason code (other needs a note)`);
    if (v.verdict === 'merge' && typeof v.into !== 'string') throw new UsageError(`${v.ref}: a merge needs into`);
    if (!['live', 'local'].includes(v.recorded)) throw new UsageError(`${v.ref}: recorded is live (temper-verdicts recorded it) or local (no valid delegation)`);
    if (typeof v.inbox !== 'string') throw new UsageError(`${v.ref}: inbox is the inbox key`);
    if (v.deferred !== undefined && (v.deferred !== 'cap' || v.verdict !== 'snooze')) throw new UsageError(`${v.ref}: deferred is "cap", and only on a snooze (snoozed only because the day's accept cap is reached)`);
    return { ...v, decided_by: DECIDER };
  });
}

/** A snooze made only because the day's accept cap is reached: carried to tomorrow, not a triage judgement. @param {any} v */
export const isCarried = (v) => v?.verdict === 'snooze' && v.deferred === 'cap';

/**
 * Verdicts per kind. A cap-deferred snooze counts as `carried`, not `snooze`: it lifts no reject-or-snooze share and
 * uses none of the rejects cap (rejectShare and triageLimits never read `carried`). @param {any[]} vs
 */
const countKinds = (vs) => {
  /** @type {Record<string, number>} */
  const c = {};
  for (const v of vs) { const k = isCarried(v) ? 'carried' : v.verdict; c[k] = (c[k] ?? 0) + 1; }
  return c;
};

/**
 * The share floor and the day's caps of one inbox (as Forge counts them: snoozes and merges count against rejects),
 * over today's earlier verdicts plus these. The floor is per day per inbox, not per cycle: a cycle that decides one or
 * two genuinely good cards could not meet it honestly. A card decided again today counts once there, at its newest
 * verdict; the caps count every decision, as Forge does. `cycle` is these verdicts' own share, for the record.
 * @param {any[]} verdicts @param {any[]} earlier today's earlier verdicts of the same inbox @param {{accepts_per_day: number, rejects_per_day: number}} caps
 */
export function triageLimits(verdicts, earlier, caps) {
  const c = countKinds(verdicts);
  const redecided = new Set(verdicts.map((v) => v.ref).filter((r) => typeof r === 'string'));
  const q = rejectShare(countKinds([...earlier.filter((e) => typeof e.ref !== 'string' || !redecided.has(e.ref)), ...verdicts]));
  const all = countKinds([...earlier, ...verdicts]);
  const accepts = all.accept ?? 0;
  const rejects = (all.reject ?? 0) + (all.snooze ?? 0) + (all.merge ?? 0);
  const why = [];
  if (!q.ok) why.push(`only ${Math.round((q.share ?? 0) * 100)}% of the ${q.decided} cards decided today in this inbox are rejected or snoozed; the floor is ${REJECT_SHARE * 100}% per day`);
  if (accepts > caps.accepts_per_day) why.push(`${accepts} accepts today, over the cap of ${caps.accepts_per_day}`);
  if (rejects > caps.rejects_per_day) why.push(`${rejects} rejects, snoozes and merges today, over the cap of ${caps.rejects_per_day}`);
  // a snooze is carried to tomorrow only when the cap is what stops the accept: at the cap, never under it
  const carried = c.carried ?? 0;
  const deferral_ok = !carried || accepts >= caps.accepts_per_day;
  if (!deferral_ok) why.push(`${carried} snoozes say deferred: "cap", but only ${accepts} of ${caps.accepts_per_day} accepts are used today: accept them, or snooze them for a real reason`);
  return { counts: c, ...q, floor_ok: q.ok, cycle: rejectShare(c), today: { accepts, rejects, carried: all.carried ?? 0 }, caps, deferral_ok, ok: !why.length, why };
}

/** Today's earlier verdicts of an inbox, from the cycle rows. @param {string} root @param {string} date @param {string} inbox */
const verdictsToday = (root, date, inbox) => cycleRows(root, date).flatMap((r) => r.self_reported?.verdicts ?? []).filter((v) => v.inbox === inbox);

/** @param {unknown} v */
const isStrings = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
/**
 * The informational keys a runner's cycle file may carry (references/cycle.md), with their types. They are stored as
 * written (self-reported); a key not listed here is kept too, but a listed one of the wrong type is a usage error.
 */
const SCAN_INFO = /** @type {Record<string, [string, (v: unknown) => boolean]>} */ ({
  cost_usd: ['a number', (v) => typeof v === 'number'], minutes: ['a number', (v) => typeof v === 'number'], turns: ['a whole number', (v) => Number.isInteger(v)],
  run_id: ['text', (v) => typeof v === 'string'], ref: ['a branch or commit name (the ledger row ref)', (v) => typeof v === 'string' && v.trim() !== ''], head: ['a commit', (v) => typeof v === 'string' && /^[0-9a-f]{7,40}$/i.test(v)],
  pushed: ['a list of refs', isStrings], lens_states: ['text', (v) => typeof v === 'string'],
});
const BUILT_INFO = /** @type {Record<string, [string, (v: unknown) => boolean]>} */ ({
  slice: ['text like 1/2', (v) => typeof v === 'string'], commits: ['a list of commits', isStrings], specs: ['a list of paths', isStrings],
  qa: ['text (who wrote the specs: subagent, ...)', (v) => typeof v === 'string'],
});
/**
 * The exploratory persona pass's states (references/cycle.md, Simulated UAT): `run` (with what it found after a colon),
 * `skipped: <why>` (no UI surface touched), `not-reachable: <why>` (a UI-visible change that neither the fixture
 * bridge nor the local doubles can reach, such as a server-only message or a Jira body). `not run: <why>` is the first
 * runners' form, still read.
 */
const PERSONA_PASS_RE = /^(run(: \S.*)?|(skipped|not-reachable|not run): \S.*)$/s;
const PERSONA_PASS_FORMS = '"run", "run: <what it found>", "skipped: <why>" or "not-reachable: <why>"';
/** @param {any} o @param {Record<string, [string, (v: unknown) => boolean]>} spec @param {string} at */
function checkInfo(o, spec, at) {
  for (const [k, [what, ok]] of Object.entries(spec)) if (o[k] !== undefined && !ok(o[k])) throw new UsageError(`${at}.${k} is ${what}`);
}

/**
 * The runner's skill issues: a list of {where, what, evidence, fix}, each a non-empty string, no other key.
 * @param {unknown} arr
 */
export function checkSkillIssues(arr) {
  const shape = `skill_issues is a list of {${SKILL_ISSUE_KEYS.join(', ')}}, each a non-empty string`;
  if (!Array.isArray(arr)) throw new UsageError(shape);
  arr.forEach((x, i) => {
    if (!x || typeof x !== 'object' || Array.isArray(x)) throw new UsageError(`skill_issues[${i}] is an object: ${shape}`);
    for (const k of Object.keys(x)) if (!SKILL_ISSUE_KEYS.includes(k)) throw new UsageError(`unknown key skill_issues[${i}].${k} (${SKILL_ISSUE_KEYS.join(', ')})`);
    for (const k of SKILL_ISSUE_KEYS) if (typeof x[k] !== 'string' || !x[k].trim()) throw new UsageError(`skill_issues[${i}] needs ${k}: ${shape}`);
  });
  return arr;
}

/**
 * Checks the director's cycle file. @param {any} raw @param {{target: string, metModules: string[], proposedPerModule: Record<string, number>}} o
 */
export function validateCycleFile(raw, o) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new UsageError('the cycle file is a JSON object');
  for (const k of Object.keys(raw)) if (!CYCLE_KEYS.includes(k)) throw new UsageError(`unknown cycle key ${k} (${CYCLE_KEYS.join(', ')})`);
  if (raw.target !== o.target) throw new UsageError(`target ${raw.target} is not the open cycle's ${o.target}`);
  for (const k of ['built', 'other_scans', 'findings', 'outcomes', 'directions', 'parked']) if (raw[k] !== undefined && !Array.isArray(raw[k])) throw new UsageError(`${k} is a list`);
  for (const b of raw.built ?? []) {
    if (typeof b?.ref !== 'string' || !['XS', 'S', 'M', 'L', 'XL'].includes(b.size)) throw new UsageError('each built item is {ref, size: XS..XL, slice?, commits?, specs?, qa?}');
    checkInfo(b, BUILT_INFO, `built ${b.ref}`);
  }
  for (const x of raw.outcomes ?? []) if (typeof x?.ref !== 'string' || !['right', 'partly', 'wrong'].includes(x.rating) || typeof x.basis !== 'string') throw new UsageError('each outcome is {ref, rating: right|partly|wrong, basis}');
  for (const x of raw.parked ?? []) if (typeof x?.item !== 'string' || typeof x.why !== 'string') throw new UsageError('each parked entry is {item, why}');
  if (raw.skill_issues !== undefined) checkSkillIssues(raw.skill_issues);
  const per = { ...o.proposedPerModule };
  for (const d of raw.directions ?? []) {
    for (const k of ['id', 'module', 'title', 'evidence', 'value', 'size', 'first_slice']) if (typeof d?.[k] !== 'string' || !d[k].trim()) throw new UsageError(`each direction has ${k}`);
    if (!SLUG_RE.test(d.id)) throw new UsageError(`direction id ${d.id} is a lowercase slug`);
    if (!o.metModules.includes(d.module)) throw new Refusal(`module ${d.module} does not meet the bar (modules bar): stabilize it before proposing directions`);
    per[d.module] = (per[d.module] ?? 0) + 1;
    if (per[d.module] > MAX_DIRECTIONS) throw new Refusal(`at most ${MAX_DIRECTIONS} pending directions per module (${d.module})`);
  }
  if (raw.scan !== undefined) {
    if (typeof raw.scan?.project_key !== 'string' || !Number.isInteger(raw.scan.created)) throw new UsageError('scan is {project_key, created, cost_usd?, minutes?, turns?, run_id?, ref?, head?, pushed?, lens_states?}');
    checkInfo(raw.scan, SCAN_INFO, 'scan');
  }
  const persona = raw.uat && typeof raw.uat === 'object' ? raw.uat.persona_pass : undefined;
  if (persona !== undefined && (typeof persona !== 'string' || !PERSONA_PASS_RE.test(persona))) throw new UsageError(`uat.persona_pass is ${PERSONA_PASS_FORMS}`);
  return raw.verdicts === undefined ? [] : checkVerdicts(raw.verdicts);
}

/**
 * The quality instrument fills itself: when quality.jsonl has no row written since the cycle began (the director's
 * update step did not run quality-snapshot), run it now with --label c<n> --append. It never makes a cycle red; its
 * state goes in the row (present, appended, no row written, failed).
 * @param {Ctx} ctx @param {any} open @returns {{state: string, head?: string, exit?: number | null}}
 */
function qualityRowOf(ctx, open) {
  const file = join(paths(ctx.root).records, 'quality.jsonl');
  const since = Date.parse(open.begun_at);
  const fresh = () => readJsonl(file).filter((r) => typeof r.ts === 'string' && Date.parse(r.ts) >= since).at(-1);
  const had = fresh();
  if (had) return { state: 'present', ...(typeof had.head === 'string' ? { head: had.head } : {}) };
  mkdirSync(dirname(file), { recursive: true });
  const r = ctx.run(process.execPath, [join(ctx.root, 'tools', 'quality-snapshot.mjs'), '--label', `c${open.n}`, '--append', file], { cwd: ctx.root });
  if (r.status !== 0) return { state: 'failed', exit: r.status };
  const now = fresh();
  return now ? { state: 'appended', ...(typeof now.head === 'string' ? { head: now.head } : {}) } : { state: 'no row written' };
}

/** The e2e projects every Dowser cycle runs. */
const E2E_SCRIPTS = REQUIRED_E2E.map((p) => `e2e:${p}`);

/**
 * The independent check of one repo's tree, the same for cycle end and cycle reverify. Dowser: npm ci where a lockfile
 * is newer than its node_modules, typecheck and test, the e2e projects (unless a charter gate already runs them), the
 * charter's land gates, then the e2e result files newer than `sinceMs`. Another repo: its charter land gates.
 * @param {Ctx} ctx @param {Repo} repo @param {string} dir @param {number} sinceMs
 */
function verifyTree(ctx, repo, dir, sinceMs) {
  if (repo.name !== 'dowser') {
    const gates = runRepoGates(ctx, repo, dir);
    const why = Object.entries(gates).filter(([, s]) => s !== 'pass').map(([k]) => `${k} failed`);
    return { green: !why.length, why, verified: { gates } };
  }
  // a lockfile newer than its installed tree (a merge added a dependency) is installed first: npm ci, or red
  const deps = syncDeps(ctx);
  const charterRuns = repo.gates.filter((g) => g.when === 'land').map((g) => g.run);
  const e2e = E2E_SCRIPTS.filter((s) => !charterRuns.some((r) => new RegExp(`\\bnpm run ${s}(\\s|$)`).test(r)));
  const gates = { ...runGates(ctx, ['typecheck', 'test', ...e2e]), ...runRepoGates(ctx, repo, dir) };
  const u = uatSince(ctx.root, sinceMs);
  const why = [...deps.why, ...Object.entries(gates).filter(([, s]) => s !== 'pass').map(([k]) => `${k} failed`), ...u.why];
  return { green: !why.length, why, verified: { deps: deps.deps, gates, uat: u.uat } };
}

/** @param {Ctx} ctx @param {Record<string, string | true>} f */
function cycleEnd(ctx, f) {
  const charter = needCharter(ctx);
  const day = needDay(ctx);
  const p = paths(ctx.root);
  if (typeof f.file !== 'string') throw new UsageError('cycle end needs --file <cycle.json>');
  const raw = readJson(resolve(f.file));
  if (raw === undefined) throw new UsageError(`--file ${f.file} does not exist`);
  // which open cycle: --repo, else the file's repo, else the only one open
  const all = openCycles(ctx.root);
  if (typeof f.repo === 'string' && typeof raw?.repo === 'string' && f.repo !== raw.repo) throw new UsageError(`--repo ${f.repo} and the file's repo ${raw.repo} differ`);
  const want = typeof f.repo === 'string' ? f.repo : typeof raw?.repo === 'string' ? raw.repo : undefined;
  if (!Object.keys(all).length) throw new Refusal('no open cycle: run cycle begin');
  if (want === undefined && Object.keys(all).length > 1) throw new UsageError(`${describeOpen(all)} are open: name the repo (the file's repo, or --repo <r>)`);
  const slot = want === undefined ? Object.values(all)[0] : all[want];
  if (!slot) throw new Refusal(`no open cycle in ${want} (open: ${describeOpen(all)})`);
  const open = slot.cycle;
  const bar = readJson(join(p.records, 'modules.json'));
  const dirs = readDirections(ctx);
  /** @type {Record<string, number>} */
  const proposedPerModule = {};
  for (const d of Object.values(dirs.proposed)) proposedPerModule[/** @type {any} */ (d).module] = (proposedPerModule[/** @type {any} */ (d).module] ?? 0) + 1;
  const metModules = Object.entries(bar?.modules ?? {}).filter(([, m]) => /** @type {any} */ (m).met).map(([k]) => k);
  const verdicts = validateCycleFile(raw, { target: open.target, metModules, proposedPerModule });
  // the share floor and the caps, both per inbox per day
  /** @type {Record<string, any>} */
  const limits = {};
  for (const inbox of [...new Set(verdicts.map((v) => v.inbox))]) {
    const r = (charter.repos ?? []).find((/** @type {Repo} */ x) => x.inbox_key === inbox);
    if (!r) throw new UsageError(`verdict inbox ${inbox} is not in the charter`);
    limits[inbox] = triageLimits(verdicts.filter((v) => v.inbox === inbox), verdictsToday(ctx.root, open.date, inbox), r.caps);
    if (limits[inbox].today.accepts > r.caps.accepts_per_day || limits[inbox].today.rejects > r.caps.rejects_per_day || !limits[inbox].deferral_ok) throw new Refusal(`${inbox}: ${limits[inbox].why.join('; ')}`);
  }
  const repo = repoOf(charter, open.repo ?? 'dowser');
  const isDowser = repo.name === 'dowser';
  const dir = isDowser ? ctx.root : day.repos?.[repo.name]?.worktree;
  const head = gitIn(ctx, dir, 'rev-parse', 'HEAD');
  const v = verifyTree(ctx, repo, dir, Date.parse(open.begun_at));
  const quality = isDowser ? qualityRowOf(ctx, open) : undefined;
  // the cycle's own share for the record; ok is the day's floor in every inbox it decided in
  const carried = verdicts.filter(isCarried).length;
  const quota = { ...rejectShare(countKinds(verdicts)), ...(carried ? { carried } : {}), ok: Object.values(limits).every((l) => l.floor_ok),
    ...(Object.keys(limits).length ? { day: Object.fromEntries(Object.entries(limits).map(([k, l]) => [k, { decided: l.decided, ...(l.share !== undefined ? { share: l.share } : {}), ok: l.floor_ok }])) } : {}) };
  const { target: _t, repo: _r, ...claims } = raw;
  const green = v.green;
  const row = {
    kind: 'cycle', n: open.n, date: open.date, repo: repo.name, target: open.target, begun_at: open.begun_at, ended_at: ctx.now().toISOString(), head,
    green, ...(green ? {} : { red_because: v.why }),
    verified: { ...v.verified, ...(quality ? { quality } : {}) },
    quota,
    self_reported: { ...claims, ...(raw.verdicts ? { verdicts } : {}) },
  };
  mkdirSync(p.records, { recursive: true });
  appendFileSync(join(p.records, `${open.date}.jsonl`), `${JSON.stringify(row)}\n`);
  rmSync(slot.file);
  if (green && isDowser) { day.last_green = head; writeJson(p.day, day); }
  if (raw.directions?.length) {
    for (const d of raw.directions) dirs.proposed[d.id] = { ...d, proposed_on: open.date };
    writeJson(p.directions, dirs);
  }
  return row;
}

/**
 * cycle reverify --n <n> [--repo r]: re-runs the same gates and e2e on the unchanged tree of a cycle of the day, for a
 * red that was environmental (a stale node_modules, a dead dev server). HEAD must be the cycle's head, or past it only
 * by record-only commits (docs/evals/temper/), and the tree must be clean outside the records. It appends a
 * `kind: "reverify"` row, which becomes the cycle's newest verdict; a green one moves the day's last green to HEAD.
 * The cycle's own row is never rewritten.
 * @param {Ctx} ctx @param {Record<string, string | true>} f
 */
function cycleReverify(ctx, f) {
  const charter = needCharter(ctx);
  const day = needDay(ctx);
  const n = typeof f.n === 'string' && /^\d+$/.test(f.n) ? Number(f.n) : NaN;
  if (!Number.isInteger(n) || n < 1) throw new UsageError('cycle reverify needs --n <cycle number>');
  const rows = dayRows(ctx.root, day.date);
  const mine = rows.filter((r) => r.kind === 'cycle' && r.n === n && (typeof f.repo !== 'string' || (r.repo ?? 'dowser') === f.repo));
  if (!mine.length) throw new Refusal(`no cycle ${n}${typeof f.repo === 'string' ? ` in ${f.repo}` : ''} on ${day.date}`);
  const c = mine[0];
  const repo = repoOf(charter, c.repo ?? 'dowser');
  const isDowser = repo.name === 'dowser';
  const dir = isDowser ? ctx.root : day.repos?.[repo.name]?.worktree;
  if (typeof dir !== 'string' || !existsSync(dir)) throw new Refusal(`${repo.name}'s day worktree is gone`);
  if (typeof c.head !== 'string') throw new Refusal(`cycle ${n} recorded no head`);
  const head = gitIn(ctx, dir, 'rev-parse', 'HEAD');
  const RECORDS = 'docs/evals/temper/';
  if (head !== c.head) {
    if (!gitOkIn(ctx, dir, 'merge-base', '--is-ancestor', c.head, head)) throw new Refusal(`HEAD ${head.slice(0, 7)} is not past cycle ${n}'s head ${c.head.slice(0, 7)}: a reverify checks that cycle's tree only`);
    const changed = gitIn(ctx, dir, 'diff', '--name-only', c.head, head).split(/\r?\n/).filter(Boolean).filter((x) => !x.startsWith(RECORDS));
    if (changed.length) throw new Refusal(`HEAD moved past cycle ${n}'s head ${c.head.slice(0, 7)} with more than record-only commits (${changed.slice(0, 5).join(', ')}${changed.length > 5 ? ', ...' : ''}): end a new cycle instead`);
  }
  const dirty = ctx.run('git', ['-C', dir, 'status', '--porcelain', '--untracked-files=no']).stdout.split(/\r?\n/).filter(Boolean)
    .filter((l) => !l.slice(3).replaceAll('\\', '/').startsWith(RECORDS));
  if (dirty.length) throw new Refusal(`${dir} has uncommitted changes outside ${RECORDS}: a reverify checks the committed tree`);
  const start = ctx.now();
  const v = verifyTree(ctx, repo, dir, start.getTime());
  const prev = newestVerdicts(rows).find((r) => r.n === n && (r.repo ?? 'dowser') === repo.name);
  const row = {
    kind: 'reverify', n, date: c.date, repo: repo.name, target: c.target, at: start.toISOString(), head, of_head: c.head,
    before: { green: prev?.green ?? c.green, ...(prev?.red_because ? { red_because: prev.red_because } : {}) },
    green: v.green, ...(v.green ? {} : { red_because: v.why }), verified: v.verified,
  };
  mkdirSync(paths(ctx.root).records, { recursive: true });
  appendFileSync(join(paths(ctx.root).records, `${c.date}.jsonl`), `${JSON.stringify(row)}\n`);
  if (v.green && isDowser) { day.last_green = head; writeJson(paths(ctx.root).day, day); }
  return row;
}

/** @param {Ctx} ctx @param {Record<string, string | true>} f */
function triageCheck(ctx, f) {
  if (typeof f.verdicts !== 'string') throw new UsageError('triage check needs --verdicts <json>');
  if (typeof f.inbox !== 'string') throw new UsageError('triage check needs --inbox <key>');
  const charter = needCharter(ctx);
  const r = (charter.repos ?? []).find((/** @type {Repo} */ x) => x.inbox_key === f.inbox);
  if (!r) throw new UsageError(`--inbox ${f.inbox} is not in the charter`);
  const raw = readJson(resolve(f.verdicts));
  // one file for both tools: temper-verdicts' own contract check (inbox and recorded optional, inbox = --inbox), then
  // the ledger defaults filled in for the caps
  parseVerdicts(raw, f.inbox);
  const vs = checkVerdicts(raw.map((/** @type {any} */ v) => ({ inbox: f.inbox, recorded: 'live', ...v })));
  const day = needDay(ctx);
  const lim = triageLimits(vs, verdictsToday(ctx.root, day.date, f.inbox), r.caps);
  if (!lim.ok) throw new Refusal(`${lim.why.join('; ')}: look again for the weak cards`);
  return lim;
}

// --------------------------------------------------------------------------------------------- the bar

/** @typedef {{e2e: Record<string, {rows: any[], stale: boolean} | undefined>, lens?: {proposals: any[], features: {slug: string, contexts: string[]}[]}, resolved?: Record<string, {commit: string}>, scans: any[], cycles: any[], quality: any[], coverage?: {ids: Record<string, string[]>}, inbox?: string}} Instruments */

/** @param {string} p @returns {Part} */
const unverifiable = (p) => ({ state: 'unverifiable', ok: false, detail: p });

/** @param {Module} mod @param {Instruments} inst @returns {Part} */
export function uatPart(mod, inst) {
  if (mod.uat === 'tests') {
    const q = inst.quality.at(-1);
    if (!q || q.typecheck === undefined || q.tests_status === undefined) return unverifiable('no quality-snapshot row with the gates (its surface is the CLI and its tests)');
    const ok = q.typecheck === 'pass' && q.tests_status === 'pass';
    return { state: 'verified', ok, detail: `typecheck ${q.typecheck}, tests ${q.tests_status}${q.tests ? ` (${q.tests})` : ''} at ${q.head}` };
  }
  const pats = mod.uat;
  const res = pats.map((r) => new RegExp(r));
  const projects = E2E_PROJECTS.filter((p) => pats.some((r) => r.startsWith(`^e2e/${p}/`)));
  const rows = [];
  for (const p of projects) {
    const r = inst.e2e[p];
    if (!r) return unverifiable(`no ${p} results (npm run e2e:${p})`);
    if (r.stale) return unverifiable(`the ${p} results are older than HEAD`);
    const mine = r.rows.filter((x) => res.some((re) => re.test(x.spec)));
    if (!mine.length) return unverifiable(`no ${p} spec matched the module's surfaces`);
    rows.push(...mine);
  }
  const c = e2eCounts(rows);
  if (c.fail) return { state: 'verified', ok: false, detail: `${c.fail} of ${rows.length} specs failed` };
  if (c.unverifiable) return unverifiable(`${c.unverifiable} of ${rows.length} specs unverifiable (live sign-in?)`);
  if (c.flaky) return { state: 'verified', ok: false, detail: `${c.flaky} of ${rows.length} specs flaky` };
  const thin = rows.filter((x) => (x.attempts ?? 0) < 3).length;
  if (thin) return { state: 'verified', ok: false, detail: `${thin} of ${rows.length} specs ran fewer than 3 times (--repeat-each 3)` };
  return { state: 'verified', ok: true, detail: `${rows.length} specs green over 3 runs on ${projects.join(', ')}` };
}

/** @param {Module} mod @param {Instruments} inst @returns {Part} */
export function proposalsPart(mod, inst) {
  if (!inst.lens) return unverifiable('the lens-scan store or app-structure was not read');
  const feats = new Set(inst.lens.features.filter((f) => (f.contexts ?? []).some((c) => mod.contexts.includes(c))).map((f) => f.slug));
  const mine = inst.lens.proposals.filter((x) => feats.has(x.feature) && OPEN_LENS.has(x.status));
  // a fix that landed (resolved.json, its commit on HEAD's history) closes the proposal for the bar; one being executed stays open
  const fixed = mine.filter((x) => x.status !== 'executing' && inst.resolved?.[x.id]);
  const open = mine.filter((x) => !fixed.includes(x));
  const blocking = open.filter((x) => Number.isInteger(x.tier) && x.tier <= 2);
  if (blocking.length) return { state: 'verified', ok: false, detail: `open at tier 0-2: ${blocking.map((x) => `${x.id} (t${x.tier})`).join(', ')}` };
  const untriaged = open.filter((x) => !Number.isInteger(x.tier));
  if (untriaged.length) return unverifiable(`untriaged (rank them): ${untriaged.map((x) => x.id).join(', ')}`);
  const by = fixed.length ? `; resolved by a landed commit: ${fixed.map((x) => `${x.id} (${inst.resolved?.[x.id].commit.slice(0, 7)})`).join(', ')}` : '';
  return { state: 'verified', ok: true, detail: `${open.length} open, none at tier 0-2 (${feats.size} features)${by}` };
}

/** @param {string} name @param {Module} mod @param {Instruments} inst @returns {Part} */
export function scanPart(name, mod, inst) {
  if (!inst.inbox) return unverifiable('no Dowser inbox (charter)');
  const rows = inst.scans.filter((s) => s.project_key === inst.inbox && normFocus(s.focus) === normFocus(mod.focus) && s.ok && s.cards)
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts))).slice(-2);
  if (rows.length === 2) {
    const ok = rows.every((r) => r.cards.created <= 2);
    return { state: 'verified', ok, detail: `last two scans created ${rows.map((r) => r.cards.created).join(', ')} cards` };
  }
  const claimed = inst.cycles.filter((r) => r.target === name && Number.isInteger(r.self_reported?.scan?.created)).slice(-2);
  if (claimed.length === 2) {
    const ok = claimed.every((r) => r.self_reported.scan.created <= 2);
    return { state: 'self-reported', ok, detail: `cycle rows claim ${claimed.map((r) => r.self_reported.scan.created).join(', ')} cards (no ledger rows)` };
  }
  return unverifiable(`${rows.length} scan(s) with focus ${mod.focus} in the ledger; the bar needs two`);
}

/** @param {any} row @param {string} k */
const qMetric = (row, k) => (k === 'lib_cycles' ? (Array.isArray(row?.lib_cycles) ? row.lib_cycles.length : undefined) : (typeof row?.[k] === 'number' ? row[k] : undefined));

/** quality-snapshot is repo-wide, so this part is the same for every module. @param {Instruments} inst @returns {Part} */
export function qualityPart(inst) {
  if (inst.quality.length < 2) return unverifiable(`${inst.quality.length} quality-snapshot row(s); the bar compares two`);
  const [a, b] = inst.quality.slice(-2);
  const grew = [];
  for (const k of QUALITY_KEYS) {
    const x = qMetric(a, k), y = qMetric(b, k);
    if (x === undefined || y === undefined) return unverifiable(`quality-snapshot row lacks ${k}`);
    if (y > x) grew.push(`${k} ${x} -> ${y}`);
  }
  return { state: 'verified', ok: !grew.length, detail: grew.length ? `grew: ${grew.join(', ')}` : `not growing (${a.head} -> ${b.head})` };
}

/** @param {Module} mod @param {Instruments} inst @returns {Part} */
export function coveragePart(mod, inst) {
  if (!mod.coverage.length) return { state: 'verified', ok: true, detail: 'no routes or resolver keys' };
  if (!inst.coverage) return unverifiable('e2e-coverage was not read');
  const res = mod.coverage.map((r) => new RegExp(r));
  const ids = Object.keys(inst.coverage.ids).filter((id) => res.some((re) => re.test(id)));
  if (!ids.length) return unverifiable('no coverage id matched the module (stale patterns in modules.json?)');
  const un = ids.filter((id) => !(inst.coverage?.ids[id] ?? []).length);
  return { state: 'verified', ok: !un.length, detail: un.length ? `uncovered: ${un.join(', ')}` : `${ids.length} ids covered` };
}

/**
 * The bar of every module. met: all five parts verified and ok. next: the least-stable module.
 * @param {{order: string[], modules: Record<string, Module>}} defs @param {Instruments} inst
 */
export function evaluateBar(defs, inst) {
  /** @type {Record<string, {met: boolean, parts: Record<string, Part>}>} */
  const modules = {};
  const q = qualityPart(inst);
  for (const name of defs.order) {
    const m = defs.modules[name];
    const parts = { uat: uatPart(m, inst), proposals: proposalsPart(m, inst), scan_yield: scanPart(name, m, inst), quality: q, coverage: coveragePart(m, inst) };
    modules[name] = { met: PARTS.every((k) => parts[k].state === 'verified' && parts[k].ok), parts };
  }
  const held = (/** @type {string} */ n) => PARTS.filter((k) => modules[n].parts[k].state === 'verified' && modules[n].parts[k].ok).length;
  const next = [...defs.order].filter((n) => !modules[n].met).sort((a, b) => held(a) - held(b))[0];
  return { modules, ...(next ? { next } : {}) };
}

/** @param {Ctx} ctx @param {{dir?: string, inbox?: string}} o @returns {Instruments} */
export function readInstruments(ctx, { dir, inbox }) {
  if (dir) {
    const at = (/** @type {string} */ n) => join(dir, n);
    const props = readJson(at('lens-proposals.json'));
    const st = readJson(at('app-structure.json'));
    const cov = readJson(at('coverage.json'));
    const res = readJson(at('resolved.json'));
    return {
      e2e: Object.fromEntries(E2E_PROJECTS.map((p) => { const rows = readJson(at(join('e2e', `${p}.json`))); return [p, Array.isArray(rows) ? { rows, stale: false } : undefined]; })),
      ...(Array.isArray(props) && Array.isArray(st?.features) ? { lens: { proposals: props, features: st.features } } : {}),
      ...(res && typeof res === 'object' ? { resolved: res } : {}),
      scans: readJsonl(at('scans.jsonl')), quality: readJsonl(at('quality.jsonl')),
      cycles: existsSync(at('cycles.jsonl')) ? newestVerdicts(readJsonl(at('cycles.jsonl'))) : cycleRows(ctx.root),
      ...(cov ? { coverage: cov } : {}), ...(inbox ? { inbox } : {}),
    };
  }
  const headMs = Number(git(ctx, 'log', '-1', '--format=%ct')) * 1000;
  const res = readE2eResults(ctx.root);
  const lens = readLens(ctx);
  /** @type {{ids: Record<string, string[]>} | undefined} */
  let cov;
  try { cov = e2eCoverage({ root: ctx.root, against: 'none' }); } catch { cov = undefined; }
  return {
    e2e: Object.fromEntries(E2E_PROJECTS.map((p) => [p, res[p] ? { rows: res[p].rows, stale: res[p].mtimeMs < headMs } : undefined])),
    ...(lens ? { lens } : {}), resolved: landedResolutions(ctx),
    scans: readJsonl(join(ctx.home, 'scans.jsonl')), quality: readJsonl(join(paths(ctx.root).records, 'quality.jsonl')), cycles: cycleRows(ctx.root),
    ...(cov ? { coverage: cov } : {}), ...(inbox ? { inbox } : {}),
  };
}

/**
 * The recorded resolutions whose commit is still on HEAD's history (a reset or a red day's rollback drops them).
 * @param {Ctx} ctx @returns {Record<string, {commit: string}>}
 */
function landedResolutions(ctx) {
  const all = readJson(join(paths(ctx.root).records, 'resolved.json')) ?? {};
  return Object.fromEntries(Object.entries(all).filter(([, v]) => typeof v?.commit === 'string' && gitOk(ctx, 'merge-base', '--is-ancestor', v.commit, 'HEAD')));
}

/**
 * proposals resolve --id <p> --commit <sha> [--note t]: records that a landed commit fixed a lens-scan proposal, in
 * docs/evals/temper/resolved.json, which the bar's proposals part honours. The lens-scan store is never written: its
 * statuses are lens-scan's and the operator's. The commit must be on HEAD's history; when the store is readable, the
 * proposal must be in it.
 * @param {Ctx} ctx @param {Record<string, string | true>} f
 */
function proposalsResolve(ctx, f) {
  if (typeof f.id !== 'string' || !/^p-[a-z0-9]+$/.test(f.id)) throw new UsageError('proposals resolve needs --id p-<id> (a lens-scan proposal id)');
  if (typeof f.commit !== 'string' || !/^[0-9a-f]{7,40}$/i.test(f.commit)) throw new UsageError('proposals resolve needs --commit <sha> (the commit that fixed it)');
  if (!gitOk(ctx, 'cat-file', '-e', `${f.commit}^{commit}`)) throw new Refusal(`${f.commit} is not a commit in ${ctx.root}`);
  const commit = git(ctx, 'rev-parse', `${f.commit}^{commit}`);
  if (!gitOk(ctx, 'merge-base', '--is-ancestor', commit, 'HEAD')) throw new Refusal(`${f.commit} is not on HEAD's history: only a landed fix resolves a proposal`);
  const lens = readLens(ctx);
  const prop = lens?.proposals.find((x) => x.id === f.id);
  if (lens && !prop) throw new Refusal(`${f.id} is not in the lens-scan store`);
  if (prop?.status === 'executing') throw new Refusal(`${f.id} is being executed (lens-scan): it resolves when that run ends`);
  const file = join(paths(ctx.root).records, 'resolved.json');
  const all = readJson(file) ?? {};
  all[f.id] = { commit, subject: git(ctx, 'log', '-1', '--format=%s', commit), resolved_at: ctx.now().toISOString(), by: DECIDER,
    ...(prop ? { status_then: prop.status, ...(Number.isInteger(prop.tier) ? { tier: prop.tier } : {}) } : { checked_in_store: false }),
    ...(typeof f.note === 'string' ? { note: f.note } : {}) };
  writeJson(file, all);
  return { id: f.id, ...all[f.id], written: file };
}

/** The lens-scan proposals (its store CLI, read-only) and the app-structure's features. @param {Ctx} ctx */
function readLens(ctx) {
  const db = join(ctx.root, '.ai', 'lens-scan', 'scan.db');
  const st = readJson(join(ctx.root, '.ai', 'lens-scan', 'app-structure.json'));
  const store = join(ctx.env.TEMPER_LENS_SCAN ?? DEFAULT_LENS_SCAN, 'scripts', 'store.mjs');
  if (!existsSync(db) || !Array.isArray(st?.features) || !existsSync(store)) return undefined;
  const r = ctx.run(process.execPath, [store, '--db', db, 'proposals'], { cwd: ctx.root });
  if (r.status !== 0) return undefined;
  try {
    const props = JSON.parse(r.stdout);
    return Array.isArray(props) ? { proposals: props, features: st.features } : undefined;
  } catch { return undefined; }
}

/** @param {Ctx} ctx @param {Record<string, string | true>} f */
function modulesBar(ctx, f) {
  const charter = readJson(paths(ctx.root).charter);
  const inbox = typeof f.inbox === 'string' ? f.inbox : charter?.repos?.find((/** @type {Repo} */ r) => r.name === 'dowser')?.inbox_key;
  const inst = readInstruments(ctx, { dir: typeof f.instruments === 'string' ? resolve(f.instruments) : undefined, inbox });
  const bar = evaluateBar(loadModules(), inst);
  const p = paths(ctx.root);
  const prev = readJson(join(p.records, 'modules.json'));
  const dirs = readDirections(ctx);
  const out = { at: ctx.now().toISOString(), ...bar, directions: Object.values(dirs.proposed),
    directions_log: { ...(prev?.directions_log ?? {}), ...dirs.proposed } };
  writeJson(join(p.records, 'modules.json'), out);
  return { ...bar, written: join(p.records, 'modules.json') };
}

// ---------------------------------------------------------------------------------------------- report

/** @typedef {{sha: string, subject: string, parents: number, at?: number, files: string[]}} Commit  one commit of a day branch */
/** @typedef {'product' | 'skill' | 'record' | 'merge'} CommitKind */

/** The /temper skill's own files (its scripts, tools/temper-* and the scan workspace they share, their tests, the records README). */
const SKILL_FILE_RE = /^(\.claude\/skills\/temper\/|tools\/temper-[^/]*$|tools\/scan-workspace\.mjs$|skill\/scripts\/tests\/temper[^/]*$|docs\/evals\/temper\/README\.md$)/;
/** A record commit: chore(temper) touching only the day records. */
const RECORD_FILE_RE = /^docs\/evals\/temper\//;
/** A Jira-style card ref, alone. */
const REF_ONLY_RE = /^[A-Z][A-Z0-9]*-\d+$/;

/**
 * `git log --format=%x1e%h%x1f%p%x1f%at%x1f%s --name-only` as commits, newest first.
 * @param {string} out @returns {Commit[]}
 */
export function parseCommitLog(out) {
  return String(out).split('\x1e').map((chunk) => chunk.replace(/^\r?\n+/, '')).filter((c) => c.trim()).map((chunk) => {
    const [head, ...files] = chunk.split(/\r?\n/);
    const [sha, parents, at, ...subject] = head.split('\x1f');
    return { sha, subject: subject.join('\x1f'), parents: parents.trim() ? parents.trim().split(/\s+/).length : 0, at: Number(at) * 1000, files: files.map((f) => f.trim()).filter(Boolean) };
  });
}

/**
 * What a commit is, for the report: a merge; a record (chore(temper) touching only docs/evals/temper/); skill
 * hardening (only the /temper skill's files: .claude/skills/temper/, tools/temper-*, their tests, the records README);
 * else product. A commit that mixes skill and product files is product.
 * @param {Commit} c @returns {CommitKind}
 */
export function commitKind(c) {
  if (c.parents > 1) return 'merge';
  const files = c.files ?? [];
  if (/^chore\(temper\)/.test(c.subject) && files.length && files.every((f) => RECORD_FILE_RE.test(f) && !SKILL_FILE_RE.test(f))) return 'record';
  if (files.length && files.every((f) => SKILL_FILE_RE.test(f))) return 'skill';
  return 'product';
}

/**
 * The day's commits by repo and kind. @param {Record<string, Commit[]>} byRepo
 * @returns {{repos: [string, {product: Commit[], record: number, merge: number}][], skill: {repo: string, c: Commit}[]}}
 */
export function commitGroups(byRepo) {
  /** @type {[string, {product: Commit[], record: number, merge: number}][]} */
  const repos = [];
  /** @type {{repo: string, c: Commit}[]} */
  const skill = [];
  for (const [repo, cs] of Object.entries(byRepo)) {
    const g = { product: /** @type {Commit[]} */ ([]), record: 0, merge: 0 };
    for (const c of cs) {
      const k = commitKind(c);
      if (k === 'product') g.product.push(c);
      else if (k === 'skill') skill.push({ repo, c });
      else g[k]++;
    }
    repos.push([repo, g]);
  }
  return { repos, skill };
}

/** Cycles, newest first (ended_at, then n). @param {any[]} cycles */
const newestFirst = (cycles) => [...cycles].sort((a, b) => String(b.ended_at ?? '').localeCompare(String(a.ended_at ?? '')) || (b.n ?? 0) - (a.n ?? 0));

/**
 * Parked items by repo, deduplicated: one row per item (its text, trimmed) with the newest cycle's reason and how many
 * cycles parked it. An item that is only a card ref and was built by a later cycle of the same repo is dropped (the
 * build answered it) and listed in `unparked`.
 * @param {any[]} cycles
 * @returns {{repos: [string, {item: string, why: string, n: number, times: number}[]][], unparked: {repo: string, item: string, n: number}[]}}
 */
export function parkedGroups(cycles) {
  const order = newestFirst(cycles);
  /** @type {Map<string, Map<string, {item: string, why: string, n: number, times: number}>>} */
  const by = new Map();
  /** @type {{repo: string, item: string, n: number}[]} */
  const unparked = [];
  order.forEach((r, i) => {
    const repo = r.repo ?? 'dowser';
    for (const p of r.self_reported?.parked ?? []) {
      if (!p || typeof p.item !== 'string' || !p.item.trim()) continue;
      const item = p.item.trim();
      if (!by.has(repo)) by.set(repo, new Map());
      const m = /** @type {Map<string, {item: string, why: string, n: number, times: number}>} */ (by.get(repo));
      const seen = m.get(item);
      if (seen) { seen.times++; continue; }
      // newer cycles come first in `order`: a build there answers this park
      const builtLater = REF_ONLY_RE.test(item) && order.slice(0, i).find((x) => (x.repo ?? 'dowser') === repo && (x.self_reported?.built ?? []).some((/** @type {any} */ b) => b?.ref === item));
      if (builtLater) { if (!unparked.some((u) => u.repo === repo && u.item === item)) unparked.push({ repo, item, n: builtLater.n }); m.set(item, { item, why: '', n: -1, times: 1 }); continue; }
      m.set(item, { item, why: typeof p.why === 'string' ? p.why.trim() : '', n: r.n, times: 1 });
    }
  });
  return { repos: [...by.entries()].map(([repo, m]) => /** @type {[string, {item: string, why: string, n: number, times: number}[]]} */ ([repo, [...m.values()].filter((x) => x.n !== -1)])).filter(([, xs]) => xs.length), unparked };
}

/**
 * The repo an inbox belongs to: the charter's inbox_key, else the cycle whose scan or verdicts name it.
 * @param {any} charter @param {any[]} cycles @returns {(inbox: string) => string}
 */
function inboxRepo(charter, cycles) {
  /** @type {Map<string, string>} */
  const m = new Map();
  for (const r of cycles) {
    const repo = r.repo ?? 'dowser';
    if (typeof r.self_reported?.scan?.project_key === 'string') m.set(r.self_reported.scan.project_key, repo);
    for (const v of r.self_reported?.verdicts ?? []) if (typeof v?.inbox === 'string' && !m.has(v.inbox)) m.set(v.inbox, repo);
  }
  for (const r of charter?.repos ?? []) if (typeof r?.inbox_key === 'string') m.set(r.inbox_key, r.name);
  return (inbox) => m.get(inbox) ?? inbox.replace(/-temper$/, '');
}

/**
 * A cycle file's own UAT claim as pass and fail counts: its top-level pass/fail, else the sum of its e2e_fixture,
 * e2e_local and e2e_live results (a Dowser runner's shape), so verified and self-reported compare like for like.
 * @param {any} u @returns {{pass: number, fail: number}}
 */
export function selfUat(u) {
  if (!u || typeof u !== 'object') return { pass: 0, fail: 0 };
  if (typeof u.pass === 'number' || typeof u.fail === 'number') return { pass: Number(u.pass) || 0, fail: Number(u.fail) || 0 };
  const runs = E2E_PROJECTS.map((p) => u[`e2e_${p}`]).filter((x) => x && typeof x === 'object');
  return { pass: runs.reduce((n, x) => n + (Number(x.pass) || 0), 0), fail: runs.reduce((n, x) => n + (Number(x.fail) || 0), 0) };
}

const short = (/** @type {unknown} */ s) => (typeof s === 'string' ? s.slice(0, 7) : '');

/** One landing in words. @param {any} l @param {string} [branch] */
export function landingWords(l, branch) {
  if (!l) return `not landed${branch ? ` (on ${branch})` : ''}`;
  if (l.decision === 'land' && l.ok !== false) return `pushed ${short(l.head)}${l.pushed ? ` to ${l.pushed}` : ''}${l.deployed ? `, deployed ${l.deployed}` : ''}`;
  if (l.decision === 'land') return `land failed at ${l.stage ?? 'an unknown stage'}${branch ? ` (on ${branch})` : ''}`;
  if (l.decision === 'commit-only') return `committed ${short(l.head)} on ${branch ?? 'its branch'}, not pushed (commit-only)`;
  if (l.decision === 'rollback') return `rolled back to ${short(l.target)}`;
  if (l.decision === 'none') return 'nothing to land';
  return `${l.decision}${(l.reasons ?? []).length ? `: ${l.reasons.join('; ')}` : ''}, not landed${branch ? ` (on ${branch})` : ''}`;
}

/**
 * The summary block, one entry per repo: cycles (green/red), cards scanned, accepted and built (with refs), rejected,
 * snoozed, carried, the landing, the scan cost, and UAT passes verified vs self-reported. Verdict counts are per card
 * at its newest verdict of the day (a card decided twice counts once).
 * @param {{charter?: any, cycles: any[], scans: any[], landings: Record<string, any>, branches?: Record<string, string>, commits?: Record<string, Commit[]>}} d
 */
export function repoSummaries(d) {
  const repoOf = inboxRepo(d.charter, d.cycles);
  /** @type {Map<string, any>} */
  const newest = new Map();
  for (const r of [...newestFirst(d.cycles)].reverse()) for (const v of r.self_reported?.verdicts ?? []) if (v && typeof v.inbox === 'string') newest.set(`${v.inbox}|${v.ref}`, v);
  const names = [...new Set(['dowser', ...(d.charter?.repos ?? []).map((/** @type {any} */ r) => r.name), ...d.cycles.map((r) => r.repo ?? 'dowser'),
    ...Object.keys(d.landings), ...d.scans.map((s) => repoOf(String(s.project_key)))])];
  return names.map((repo) => {
    const cs = d.cycles.filter((r) => (r.repo ?? 'dowser') === repo);
    const scans = d.scans.filter((s) => repoOf(String(s.project_key)) === repo);
    const vs = [...newest.values()].filter((v) => repoOf(v.inbox) === repo);
    const kinds = countKinds(vs);
    const built = [...new Set(cs.flatMap((r) => (r.self_reported?.built ?? []).map((/** @type {any} */ b) => b?.ref)).filter((x) => typeof x === 'string'))];
    const verified = cs.reduce((n, r) => n + E2E_PROJECTS.reduce((m, p) => m + (r.verified?.uat?.[p]?.pass ?? 0), 0), 0);
    const anyVerified = cs.some((r) => E2E_PROJECTS.some((p) => typeof r.verified?.uat?.[p]?.pass === 'number'));
    const self = cs.reduce((n, r) => n + selfUat(r.self_reported?.uat).pass, 0);
    return {
      repo, cycles: cs.length, green: cs.filter((r) => r.green).length, red: cs.filter((r) => !r.green).map((r) => r.n),
      scans: scans.length, scanned: scans.reduce((n, s) => n + (s.cards?.created ?? 0), 0), cost: scans.reduce((n, s) => n + (typeof s.cost_usd === 'number' ? s.cost_usd : 0), 0),
      accepted: kinds.accept ?? 0, built, rejected: kinds.reject ?? 0, snoozed: kinds.snooze ?? 0, merged: kinds.merge ?? 0, carried: kinds.carried ?? 0,
      landed: landingWords(d.landings[repo], d.branches?.[repo]), uat: { verified: anyVerified ? verified : undefined, self },
    };
  }).filter((s) => s.cycles || s.scans || d.landings[s.repo] || (d.commits?.[s.repo] ?? []).length);
}

/** Refs as a short list: consecutive numbers of one prefix collapse to a range (DW-100..DW-106). @param {string[]} refs */
export function refList(refs) {
  const nums = refs.map((r) => r.match(/^([A-Z][A-Z0-9]*-)(\d+)$/));
  if (!refs.length || nums.some((m) => !m) || new Set(nums.map((m) => m?.[1])).size > 1) return refs.join(', ');
  const p = /** @type {RegExpMatchArray} */ (nums[0])[1];
  const ns = [...new Set(nums.map((m) => Number(m?.[2])))].sort((a, b) => a - b);
  /** @type {string[]} */
  const out = [];
  for (let i = 0; i < ns.length; i++) {
    let j = i;
    while (j + 1 < ns.length && ns[j + 1] === ns[j] + 1) j++;
    out.push(j - i >= 2 ? `${p}${ns[i]}..${p}${ns[j]}` : ns.slice(i, j + 1).map((n) => `${p}${n}`).join(', '));
    i = j;
  }
  return out.join(', ');
}

/**
 * The morning report's markdown (operator-facing; not a Dowser runner surface, so it has no guided form). Read in two
 * minutes: the summary per repo first, then what needs the operator, the commits by repo, the rest after.
 * @param {{date: string, commits: Record<string, Commit[]>, landings: Record<string, any>, branches?: Record<string, string>, charter?: any, cycles: any[], scans: any[], bar?: any, directions: any[], questions: string[], later: string[]}} d
 */
export function renderReport(d) {
  const L = [`# /temper - ${d.date}`, ''];
  const sum = (/** @type {string} */ k) => d.cycles.reduce((n, r) => n + E2E_PROJECTS.reduce((m, p) => m + (r.verified?.uat?.[p]?.[k] ?? 0), 0), 0);
  const groups = commitGroups(d.commits);
  L.push('## Summary', '');
  const sums = repoSummaries(d);
  if (sums.length) {
    for (const s of sums) {
      const cyc = s.cycles ? `${s.cycles} cycles (${s.green} green${s.red.length ? `, ${s.red.length} red: ${s.red.map((n) => `c${n}`).join(', ')}` : ''})` : 'no cycle';
      const scan = s.scans ? `${s.scanned} cards scanned in ${s.scans} scans ($${s.cost.toFixed(2)})` : 'no scan';
      const verdicts = `accepted ${s.accepted}, built ${s.built.length}${s.built.length ? ` (${refList(s.built)})` : ''}; rejected ${s.rejected}, snoozed ${s.snoozed}${s.merged ? `, merged ${s.merged}` : ''}, carried to tomorrow ${s.carried}`;
      const uat = `UAT pass: verified ${s.uat.verified ?? 'none (no runner results)'}, self-reported ${s.uat.self}`;
      L.push(`- **${s.repo}**: ${cyc}; ${scan}; ${verdicts}; landed: ${s.landed}; ${uat}.`);
    }
    const cost = d.scans.reduce((n, s) => n + (typeof s.cost_usd === 'number' ? s.cost_usd : 0), 0);
    L.push(`- **/temper itself**: ${groups.skill.length} skill-hardening commits; scans cost $${cost.toFixed(2)} in all.`);
  } else L.push('Nothing ran today.');
  L.push('', '## Needs you', '');
  if (d.questions.length) d.questions.forEach((q, i) => L.push(`${i + 1}. ${q}`)); else L.push('Nothing blocks the next day.');
  if (d.later.length) L.push('', `Also waiting: ${d.later.join('; ')}`);
  L.push('', '## Commits', '');
  const line = (/** @type {Commit} */ c) => `- ${c.sha} ${c.subject}`;
  if (!groups.repos.length && !Object.keys(d.landings).length) L.push('No commit on the day branches.');
  const repos = [...new Set([...groups.repos.map(([r]) => r), ...Object.keys(d.landings)])];
  for (const repo of repos) {
    const g = groups.repos.find(([r]) => r === repo)?.[1] ?? { product: [], record: 0, merge: 0 };
    L.push(`### ${repo}`, '', `Landing: ${landingWords(d.landings[repo], d.branches?.[repo])}.`, '');
    if (g.product.length) for (const c of g.product) L.push(line(c)); else L.push('No product commit.');
    const folded = [g.record ? `${g.record} record commits (chore(temper) under docs/evals/temper)` : '', g.merge ? `${g.merge} merges` : ''].filter(Boolean);
    if (folded.length) L.push(`- and ${folded.join(' and ')}, not listed`);
    L.push('');
  }
  if (groups.skill.length) {
    L.push(`### Skill hardening (/temper: .claude/skills/temper, tools/temper-*): ${groups.skill.length}`, '');
    for (const { repo, c } of groups.skill) L.push(`${line(c)}${repo === 'dowser' ? '' : ` (${repo})`}`);
    L.push('');
  }
  if (L.at(-1) === '') L.pop();
  const pass = sum('pass'), fail = sum('fail'), unv = sum('unverifiable');
  L.push('', '## UAT', '', '| | pass | fail | unverifiable | pass rate |', '|---|---|---|---|---|');
  L.push(`| verified (runner results) | ${pass} | ${fail} | ${unv} | ${pass + fail ? `${Math.round((100 * pass) / (pass + fail))}%` : 'n/a'} |`);
  const claims = d.cycles.map((r) => selfUat(r.self_reported?.uat));
  const cp = claims.reduce((n, u) => n + u.pass, 0), cf = claims.reduce((n, u) => n + u.fail, 0);
  L.push(`| self-reported (cycle files) | ${cp} | ${cf} | | ${cp + cf ? `${Math.round((100 * cp) / (cp + cf))}%` : 'n/a'} |`);
  L.push('', `Cycles: ${d.cycles.length}, green ${d.cycles.filter((r) => r.green).length}.`);
  for (const r of d.cycles) {
    const re = r.reverified ? `, reverified at ${String(r.head).slice(0, 7)} (first ${r.reverified.first.green ? 'green' : `red: ${(r.reverified.first.red_because ?? []).join('; ')}`})` : '';
    L.push(`- ${r.n} ${r.repo ?? 'dowser'} ${r.target}: ${r.green ? 'green' : `red (${(r.red_because ?? []).join('; ')})`}${re}${r.quota && !r.quota.ok ? ', the day\'s reject share under 20%' : ''}`);
  }
  L.push('', '## Scans and costs', '');
  if (d.scans.length) {
    L.push('| inbox | focus | scanned | cards created | minutes | cost |', '|---|---|---|---|---|---|');
    for (const s of d.scans) L.push(`| ${s.project_key} | ${s.focus ?? 'full'} | ${s.ref ? `${s.ref}@` : ''}${s.head ?? ''} | ${s.cards?.created ?? ''} | ${s.minutes ?? ''} | ${typeof s.cost_usd === 'number' ? `$${s.cost_usd.toFixed(2)}` : ''} |`);
    const cost = d.scans.reduce((n, s) => n + (typeof s.cost_usd === 'number' ? s.cost_usd : 0), 0);
    L.push('', `Total: ${d.scans.length} scans, $${cost.toFixed(2)} (the scan ledger).`);
  } else L.push('No scan today.');
  const vs = d.cycles.flatMap((r) => r.self_reported?.verdicts ?? []);
  L.push('', '## Verdicts (decided by delegate:temper)', '');
  if (vs.length) {
    L.push('Every decision of the day (a card decided twice counts twice, as the caps count; the summary counts each card once).', '');
    L.push('| inbox | recorded | accept | reject | snooze | merge | carried |', '|---|---|---|---|---|---|---|');
    const keys = [...new Set(vs.map((v) => `${v.inbox}|${v.recorded}`))].sort();
    for (const k of keys) {
      const [inbox, rec] = k.split('|');
      const c = countKinds(vs.filter((v) => v.inbox === inbox && v.recorded === rec));
      L.push(`| ${inbox} | ${rec === 'local' ? 'local only (no delegation; the live inbox keeps them undecided)' : 'live (Forge recorded)'} | ${[...VERDICT_KINDS, 'carried'].map((x) => c[x] ?? 0).join(' | ')} |`);
    }
    const carried = carriedOf(d.cycles);
    if (carried.length) {
      L.push('', `Carried to tomorrow (snoozed only because the day's accept cap was reached; outside the reject-or-snooze floor and the rejects cap): ${carried.length}.`);
      for (const v of carried) L.push(`- ${v.ref} (${v.inbox})${typeof v.note === 'string' && v.note.trim() ? `: ${v.note.trim()}` : ''}`);
    }
    const local = vs.filter((v) => v.recorded === 'local').length;
    L.push('', `Live ${vs.length - local}, local only ${local}. Live counts are what temper-verdicts answered; local ones are the cycle files' (self-reported).`);
  } else L.push('None.');
  L.push('', '## Stability bar', '');
  if (d.bar?.modules) {
    L.push(`| module | met | ${PARTS.join(' | ')} |`, `|---|---|${PARTS.map(() => '---').join('|')}|`);
    const cell = (/** @type {Part} */ p) => `${p.ok ? 'ok' : 'no'} (${p.state})`;
    for (const [n, m] of Object.entries(d.bar.modules)) L.push(`| ${n} | ${/** @type {any} */ (m).met ? 'yes' : 'no'} | ${PARTS.map((k) => cell(/** @type {any} */ (m).parts[k])).join(' | ')} |`);
    if (d.bar.next) L.push('', `Least stable: ${d.bar.next}.`);
  } else L.push('Not measured (run modules bar).');
  L.push('', '## Direction proposals', '');
  if (d.directions.length) for (const x of d.directions) L.push(`- **${x.id}** (${x.module}, ${x.size}): ${x.title}. Value: ${x.value}. Evidence: ${x.evidence}. First slice: ${x.first_slice}.`);
  else L.push('None.');
  const parked = parkedGroups(d.cycles);
  L.push('', '## Parked', '');
  if (parked.repos.length) {
    L.push('Each item once, with its newest reason (the cycle that gave it), by repo.');
    for (const [repo, xs] of parked.repos) {
      L.push('', `### ${repo}`, '');
      for (const x of xs) L.push(`- ${x.item} (c${x.n}${x.times > 1 ? `, parked ${x.times} times` : ''}): ${x.why}`);
    }
    if (parked.unparked.length) L.push('', `Built since they were parked: ${parked.unparked.map((u) => `${u.item} (${u.repo}, c${u.n})`).join(', ')}.`);
  } else L.push('None.');
  L.push('', '## Skill issues', '');
  const issues = skillIssueGroups(d.cycles);
  if (issues.length) {
    L.push('What the cycle runners found wrong with the loop itself (self-reported), by where, newest first.');
    for (const [where, items] of issues) {
      L.push('', `### ${where}`, '');
      const end = (/** @type {string} */ s) => s.trim().replace(/([^.!?])$/, '$1.');
      for (const x of items) L.push(`- c${x.n} (${x.repo}): ${end(x.what)} Evidence: ${end(x.evidence)} Fix: ${end(x.fix)}`);
    }
  } else L.push('None.');
  return `${L.join('\n')}\n`;
}

/**
 * The cycles' skill issues grouped by `where`: the newest cycle's first, both across and within the groups.
 * @param {any[]} cycles @returns {[string, {n: number, repo: string, what: string, evidence: string, fix: string}[]][]}
 */
export function skillIssueGroups(cycles) {
  /** @type {Map<string, {n: number, repo: string, what: string, evidence: string, fix: string}[]>} */
  const by = new Map();
  for (const r of newestFirst(cycles)) {
    for (const x of r.self_reported?.skill_issues ?? []) {
      if (!x || typeof x.where !== 'string') continue;
      const key = x.where.trim();
      if (!by.has(key)) by.set(key, []);
      by.get(key)?.push({ n: r.n, repo: r.repo ?? 'dowser', what: x.what, evidence: x.evidence, fix: x.fix });
    }
  }
  return [...by.entries()];
}

/**
 * The cards carried to tomorrow: those whose newest verdict of the day (per inbox) is a cap-deferred snooze.
 * @param {any[]} cycles @returns {any[]}
 */
export function carriedOf(cycles) {
  /** @type {Map<string, any>} */
  const last = new Map();
  for (const v of cycles.flatMap((r) => r.self_reported?.verdicts ?? [])) last.set(`${v.inbox}|${v.ref}`, v);
  return [...last.values()].filter(isCarried);
}

/**
 * The accept-cap question: inboxes whose accepts reached the day's cap, with the numbers and a request for real caps in
 * the charter (the charter's caps default to DEFAULT_CAPS when the day-1 dialog set none). Several inboxes make one
 * question that lists them, so they take one of the three places in Needs you. Accepts count every decision, as the
 * caps do. @param {any} charter @param {any[]} cycles @returns {string[]} none or one question
 */
export function capQuestions(charter, cycles) {
  const vs = cycles.flatMap((r) => r.self_reported?.verdicts ?? []);
  /** @type {{inbox: string, accepts: number, caps: {accepts_per_day: number, rejects_per_day: number}, carried: number, dflt: boolean}[]} */
  const hits = (charter?.repos ?? []).flatMap((/** @type {Repo} */ r) => {
    const caps = r.caps ?? DEFAULT_CAPS;
    const mine = vs.filter((v) => v.inbox === r.inbox_key);
    const accepts = mine.filter((v) => v.verdict === 'accept').length;
    if (accepts < caps.accepts_per_day) return [];
    const carried = mine.filter(isCarried).length;
    const dflt = caps.accepts_per_day === DEFAULT_CAPS.accepts_per_day && caps.rejects_per_day === DEFAULT_CAPS.rejects_per_day;
    return [{ inbox: r.inbox_key, accepts, caps, carried, dflt }];
  });
  if (!hits.length) return [];
  if (hits.length === 1) {
    const { inbox, accepts, caps, carried, dflt } = hits[0];
    return [`${inbox} reached its accept cap: ${accepts} of ${caps.accepts_per_day} accepts${carried ? `, ${carried} real cards carried to the next day` : ''}. `
      + `${dflt ? `Its caps are the defaults (${caps.accepts_per_day} accepts, ${caps.rejects_per_day} rejects a day), not a choice of yours` : `Its caps are ${caps.accepts_per_day} accepts and ${caps.rejects_per_day} rejects a day`}: `
      + 'set real caps for it in the charter (repos[].caps, in the start dialog).'];
  }
  const each = hits.map((h) => `${h.inbox} ${h.accepts} of ${h.caps.accepts_per_day}${h.carried ? ` (${h.carried} real cards carried to the next day)` : ''}${h.dflt ? ' on the default caps' : ` on caps of ${h.caps.accepts_per_day} accepts and ${h.caps.rejects_per_day} rejects a day`}`);
  const allDefault = hits.every((h) => h.dflt);
  return [`${hits.length} inboxes reached their accept cap: ${each.join('; ')}. `
    + `${allDefault ? `The defaults (${DEFAULT_CAPS.accepts_per_day} accepts, ${DEFAULT_CAPS.rejects_per_day} rejects a day) are not a choice of yours: set` : 'Set'}`
    + ' real caps for each in the charter (repos[].caps, in the start dialog).'];
}

/**
 * The start questions, in order: the cards carried to today (first), inboxes at their accept cap (one question for
 * all), delegation, directions, live sign-in, parked. At most three are asked.
 * @param {{date: string, charter?: any, directions: any[], cycles: any[], liveState?: string}} d
 */
export function startQuestions(d) {
  const q = [];
  const carried = carriedOf(d.cycles);
  if (carried.length) {
    const by = [...new Set(carried.map((v) => v.inbox))].map((k) => `${k}: ${carried.filter((v) => v.inbox === k).map((v) => v.ref).join(', ')}`);
    q.push(`${carried.length} cards were carried to today because the accept cap was reached (${by.join('; ')}). They are triaged first today, before new cards: keep that order?`);
  }
  q.push(...capQuestions(d.charter, d.cycles));
  const soon = localDate(new Date(Date.parse(`${d.date}T12:00:00`) + 2 * 86400000));
  for (const [k, v] of Object.entries(d.charter?.delegation ?? {})) {
    const until = /** @type {any} */ (v).until;
    if (until < d.date) q.push(`The delegation for ${k} ended on ${until}: switch it on again in Jira Settings and tell me the new date.`);
    else if (until <= soon) q.push(`The delegation for ${k} ends on ${until}: extend it in Jira Settings?`);
  }
  const local = d.cycles.flatMap((r) => r.self_reported?.verdicts ?? []).filter((v) => v.recorded === 'local');
  if (local.length) q.push(`${local.length} verdicts are local only (no delegation): switch on "Delegate triage" in Jira Settings so the next day records them live.`);
  else if (d.charter && !Object.keys(d.charter.delegation ?? {}).length) q.push('No inbox is delegated: switch on "Delegate triage" in Jira Settings, or I triage locally only again.');
  if (d.directions.length) q.push(`Approve, reorder or veto the direction proposals: ${d.directions.map((x) => x.id).join(', ')}.`);
  if (d.liveState !== 'signed-in') q.push('The live suite was unverifiable: sign in with node e2e/live/sign-in.mjs.');
  const parked = parkedGroups(d.cycles).repos;
  const items = parked.flatMap(([, xs]) => xs);
  if (items.length) q.push(`${items.length} items are parked (${parked.map(([r, xs]) => `${r} ${xs.length}`).join(', ')}; see Parked): unpark, drop or decide?`);
  return { questions: q.slice(0, 3), later: q.slice(3) };
}

/**
 * The day's commits of each repo, newest first: Dowser's day branch from its base, and each started repo's branch from
 * its base, read in its day worktree (else the charter's path). After a rebase onto a moved origin/master the range
 * also holds other people's commits, so a started repo keeps only those authored since it was started.
 * @param {Ctx} ctx @param {any} day @param {any} charter @returns {Record<string, Commit[]>}
 */
export function dayCommits(ctx, day, charter) {
  const FORMAT = '--format=%x1e%h%x1f%p%x1f%at%x1f%s';
  /** @type {Record<string, Commit[]>} */
  const out = {};
  const log = (/** @type {string} */ dir, /** @type {string} */ range) => {
    const r = ctx.run('git', ['-C', dir, 'log', FORMAT, '--name-only', range]);
    return r.status === 0 ? parseCommitLog(r.stdout) : undefined;
  };
  if (day?.branch && day.base && gitOk(ctx, 'rev-parse', '--verify', '--quiet', `refs/heads/${day.branch}`)) out.dowser = log(ctx.root, `${day.base}..${day.branch}`) ?? [];
  for (const [name, s] of Object.entries(day?.repos ?? {})) {
    const st = /** @type {any} */ (s);
    if (typeof st?.branch !== 'string' || typeof st.base !== 'string') continue;
    const path = (charter?.repos ?? []).find((/** @type {any} */ r) => r.name === name)?.path;
    const dir = [st.worktree, path].find((p) => typeof p === 'string' && existsSync(p));
    if (!dir) continue;
    const since = Date.parse(st.started_at ?? '') - 60000;
    const cs = log(dir, `${st.base}..${st.branch}`);
    if (cs) out[name] = Number.isFinite(since) ? cs.filter((c) => !(c.at && c.at < since)) : cs;
  }
  return out;
}

/** @param {Ctx} ctx @param {Record<string, string | true>} f */
function report(ctx, f) {
  const day = readJson(paths(ctx.root).day);
  const date = typeof f.date === 'string' ? f.date : day?.date ?? localDate(ctx.now());
  if (!DATE_RE.test(date)) throw new UsageError('--date is YYYY-MM-DD');
  const charter = readJson(paths(ctx.root).charter);
  const cycles = cycleRows(ctx.root, date);
  const scans = readJsonl(join(ctx.home, 'scans.jsonl')).filter((s) => typeof s.ts === 'string' && localDate(new Date(s.ts)) === date);
  const bar = readJson(join(paths(ctx.root).records, 'modules.json'));
  const directions = Object.values(readDirections(ctx).proposed);
  const today = day?.date === date;
  const commits = today ? dayCommits(ctx, day, charter) : {};
  const branches = today ? { ...(day.branch ? { dowser: day.branch } : {}), ...Object.fromEntries(Object.entries(day.repos ?? {}).map(([k, v]) => [k, /** @type {any} */ (v).branch])) } : {};
  const live = readE2eResults(ctx.root).live;
  const liveState = live && live.rows.length && !live.rows.some((r) => r.state === 'unverifiable') ? 'signed-in' : 'unverifiable';
  const { questions, later } = startQuestions({ date, charter, directions, cycles, liveState });
  const landings = today ? { ...(day.landing ? { dowser: day.landing } : {}), ...(day.landings ?? {}) } : {};
  const md = renderReport({ date, commits, landings, branches, charter, cycles, scans, bar, directions, questions, later });
  const file = join(paths(ctx.root).records, `${date}.md`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, md);
  return { written: file, questions, later };
}

// ------------------------------------------------------------------------------------------------ land

/** PowerShell with the operator's User-scope Forge credentials loaded; the token is never printed. @param {string} forgeDir @param {string} cmd */
export const forgeShell = (forgeDir, cmd) => ['-NoProfile', '-NonInteractive', '-Command',
  "$env:FORGE_EMAIL=[Environment]::GetEnvironmentVariable('FORGE_EMAIL','User'); $env:FORGE_API_TOKEN=[Environment]::GetEnvironmentVariable('FORGE_API_TOKEN','User'); "
  + `Set-Location -LiteralPath '${forgeDir.replaceAll("'", "''")}'; ${cmd}; exit $LASTEXITCODE`];

/**
 * Vite dev servers whose command line is inside this checkout (not a build, not another checkout): left running, they
 * lock files under node_modules, and `npm ci` then fails to replace them.
 * @param {Proc[]} procs @param {string} root
 */
export function viteServersIn(procs, root) {
  const dir = `${normPath(root)}/`;
  return procs.filter((p) => p.pid !== process.pid && /(^|[\\/\s"])vite(\.js|\.cmd|\.mjs)?(["\s]|$)/i.test(p.cmd) && !/vite(\.js|\.cmd|\.mjs)?"?\s+build\b/i.test(p.cmd)
    && p.cmd.replaceAll('\\', '/').toLowerCase().includes(dir));
}

/** The installation rows of `forge install list --json`, or undefined when unreadable. @param {string} stdout */
export function installRows(stdout) {
  const a = stdout.indexOf('['), b = stdout.lastIndexOf(']');
  if (a < 0 || b < a) return undefined;
  try { const rows = JSON.parse(stdout.slice(a, b + 1)); return Array.isArray(rows) ? rows.length : undefined; } catch { return undefined; }
}

/**
 * The built-in secret scan over a range: an env file in the diff, or a known token shape in an added line. Only file
 * names and pattern names are returned, never the match.
 * @param {string} names `git diff --name-only` @param {string} patch `git diff -U0`
 */
export function secretScan(names, patch) {
  /** @type {{file: string, pattern: string}[]} */
  const hits = [];
  for (const n of names.split(/\r?\n/).filter(Boolean)) {
    const base = n.split('/').at(-1) ?? n;
    if (/^\.env(\..+)?$/.test(base) && base !== '.env.example') hits.push({ file: n, pattern: 'env-file' });
  }
  let file = '';
  for (const line of patch.split(/\r?\n/)) {
    const m = line.match(/^\+\+\+ b\/(.+)$/);
    if (m) { file = m[1]; continue; }
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    for (const [name, re] of SECRET_PATTERNS) if (/** @type {RegExp} */ (re).test(line)) hits.push({ file, pattern: /** @type {string} */ (name) });
  }
  return { clean: !hits.length, hits: hits.filter((h, i) => hits.findIndex((x) => x.file === h.file && x.pattern === h.pattern) === i) };
}

/**
 * Dowser's landing (loop-ff): checks (gates, e2e freshness, fast-forward), then the decision and its steps.
 * @param {Ctx} ctx @param {any} day @param {Repo} [repo]
 */
export function landPlan(ctx, day, repo) {
  const branch = day.branch;
  const reasons = [];
  if (!gitOk(ctx, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`)) throw new Refusal(`${branch} is gone`);
  if (git(ctx, 'rev-parse', '--abbrev-ref', 'HEAD') !== branch) throw new Refusal(`check out ${branch} first`);
  if (!cleanTree(ctx)) throw new Refusal('the working tree has uncommitted changes');
  const openNow = openCycles(ctx.root);
  if (Object.keys(openNow).length) throw new Refusal(`${describeOpen(openNow)} still open: end each first`);
  const ahead = Number(git(ctx, 'rev-list', '--count', `master..${branch}`));
  const head = git(ctx, 'rev-parse', 'HEAD');
  if (!ahead) return { repo: 'dowser', landing: 'loop-ff', decision: 'none', branch, head, reasons: ['nothing on the branch beyond master'], steps: [] };
  if (!gitOk(ctx, 'merge-base', '--is-ancestor', 'master', branch)) reasons.push('master moved since the day started: a fast-forward is impossible');
  const forgeChanged = git(ctx, 'diff', '--name-only', `master...${branch}`, '--', 'forge/') !== '';
  // the gates run on the tree the lockfiles name: a folder whose node_modules predates its lockfile gets npm ci first
  const deps = syncDeps(ctx);
  reasons.push(...deps.why);
  const gates = { ...runGates(ctx, ['typecheck', 'test', 'e2e:coverage', ...(forgeChanged ? ['forge:typecheck', 'forge:test', 'forge:check-shared'] : [])]),
    ...(repo ? runRepoGates(ctx, repo, ctx.root) : {}) };
  for (const [k, s] of Object.entries(gates)) if (s !== 'pass') reasons.push(`${k} failed`);
  const u = uatSince(ctx.root, Number(git(ctx, 'log', '-1', '--format=%ct')) * 1000);
  reasons.push(...u.why);
  const checks = { deps: deps.deps, gates, uat: u.uat, forge_changed: forgeChanged, ahead };
  const deploy = forgeChanged && repo?.landing.deploy !== undefined ? repo.landing.deploy : forgeChanged && !repo ? 'forge-development' : undefined;
  if (!reasons.length) {
    const forgeDir = join(ctx.root, 'forge');
    const steps = [['git', 'checkout', '-q', 'master'], ['git', 'merge', '--ff-only', branch], ['git', 'push', 'origin', 'master'],
      // a deploy ships what is installed and built now: stop this checkout's leftover vite servers (they lock
      // node_modules), install both Forge packages fresh, build the UI; any failure stops before the deploy
      ...(deploy ? [['stop-vite'], ['npm', 'ci', '--prefix', 'forge'], ['npm', 'ci', '--prefix', 'forge/static/app'], ['npm', 'run', 'forge:build-ui'], ['powershell.exe', ...forgeShell(forgeDir, 'forge deploy -e development --non-interactive')],
        ['powershell.exe', ...forgeShell(forgeDir, 'forge install list --json')]] : [])];
    return { repo: 'dowser', landing: 'loop-ff', decision: 'land', branch, head, checks, reasons: [], steps, deploy: deploy ? 'development' : 'skipped: no forge/ change' };
  }
  const greens = cycleRows(ctx.root, day.date).filter((r) => (r.repo ?? 'dowser') === 'dowser' && r.green && typeof r.head === 'string').map((r) => r.head).reverse();
  const target = greens.find((h) => gitOk(ctx, 'merge-base', '--is-ancestor', h, branch)) ?? day.base;
  return { repo: 'dowser', landing: 'loop-ff', decision: 'rollback', branch, head, checks, reasons, target, steps: target === head ? [] : [['git', 'reset', '--hard', target]] };
}

/**
 * Another repo's landing: rebase-push (rebase onto origin/master, gates, secret scan, push HEAD:master) or commit-only
 * (gates, secret scan; never a push). In a dry run nothing is rebased; a branch behind origin/master is reported as "would rebase".
 * @param {Ctx} ctx @param {any} day @param {Repo} repo @param {boolean} dry
 */
export function repoLand(ctx, day, repo, dry) {
  const s = day.repos?.[repo.name];
  if (!s) throw new Refusal(`${repo.name} was not started today (repo start)`);
  // only this repo's cycle blocks its landing: its worktree is its own, and a shared master rewards landing early
  const own = openCycles(ctx.root)[repo.name];
  if (own) throw new Refusal(`${describeOpen({ [repo.name]: own })} still open: end it first`);
  const wt = s.worktree;
  if (!cleanTree(ctx, wt)) throw new Refusal(`${repo.name}: ${wt} has uncommitted changes`);
  const head0 = gitIn(ctx, wt, 'rev-parse', 'HEAD');
  const base = repo.landing.kind === 'rebase-push' ? 'origin/master' : s.base;
  const out = { repo: repo.name, landing: repo.landing.kind, branch: s.branch, worktree: wt };
  if (repo.landing.kind === 'rebase-push') gitIn(ctx, wt, 'fetch', '-q', 'origin');
  const ahead = Number(gitIn(ctx, wt, 'rev-list', '--count', `${base}..HEAD`));
  if (!ahead) return { ...out, decision: 'none', head: head0, reasons: [`nothing on ${s.branch} beyond ${base}`], steps: [] };
  const reasons = [];
  /** @type {Record<string, unknown>} */
  const checks = { ahead };
  if (repo.landing.kind === 'rebase-push') {
    if (!gitOkIn(ctx, wt, 'merge-base', '--is-ancestor', 'origin/master', 'HEAD')) {
      if (dry) checks.rebase = 'would rebase onto origin/master';
      else if (ctx.run('git', ['-C', wt, 'rebase', '-q', 'origin/master']).status !== 0) {
        ctx.run('git', ['-C', wt, 'rebase', '--abort']);
        reasons.push('the rebase onto origin/master conflicts: resolve it in the worktree (keep both sides\' intent)');
        checks.rebase = 'conflict';
      } else checks.rebase = 'rebased';
    }
  }
  const head = gitIn(ctx, wt, 'rev-parse', 'HEAD');
  if (!reasons.length) {
    const gates = runRepoGates(ctx, repo, wt);
    checks.gates = gates;
    if (!Object.keys(gates).length) reasons.push('the charter names no land gate for this repo');
    for (const [k, v] of Object.entries(gates)) if (v !== 'pass') reasons.push(`${k} failed`);
    // every landing kind: a repo's own hook may skip its scan silently (personas: gitleaks not installed, c7)
    const range = `${base}...HEAD`;
    const scan = secretScan(gitIn(ctx, wt, 'diff', '--name-only', range), gitIn(ctx, wt, 'diff', '-U0', range));
    checks.secret_scan = scan;
    if (!scan.clean) reasons.push(`the secret scan found ${scan.hits.map((h) => `${h.pattern} in ${h.file}`).join(', ')}`);
  }
  if (repo.landing.kind === 'commit-only') return { ...out, decision: reasons.length ? 'red' : 'commit-only', head, checks, reasons, steps: [] };
  if (reasons.length) return { ...out, decision: 'red', head, checks, reasons, steps: [] };
  return { ...out, decision: 'land', head, checks, reasons, steps: [['git', 'push', 'origin', 'HEAD:master']] };
}

/** The day records as they are now. @param {string} root @returns {Map<string, string>} */
function readRecords(root) {
  const dir = paths(root).records;
  return new Map(existsSync(dir) ? readdirSync(dir).filter((n) => statSync(join(dir, n)).isFile()).map((n) => [n, readFileSync(join(dir, n), 'utf8')]) : []);
}

/** @param {Ctx} ctx @param {Record<string, string | true>} f */
function land(ctx, f) {
  const day = needDay(ctx);
  const charter = readJson(paths(ctx.root).charter);
  const name = typeof f.repo === 'string' ? f.repo : 'dowser';
  const repo = charter ? repoOf(charter, name) : undefined;
  if (!repo && name !== 'dowser') throw new Refusal('no charter: only Dowser can land');
  const dry = f['dry-run'] === true;
  const plan = name === 'dowser' ? landPlan(ctx, day, repo) : repoLand(ctx, day, /** @type {Repo} */ (repo), dry);
  if (dry) return { dry_run: true, ...plan, steps: plan.steps.map((s) => s.join(' ')) };
  const dir = name === 'dowser' ? ctx.root : day.repos[name].worktree;
  /** @type {Record<string, unknown>} */
  const landing = { decision: plan.decision, at: ctx.now().toISOString(), head: plan.head };
  // a rollback must not lose the day's records: they are read before the reset and written back after it (uncommitted)
  const records = plan.decision === 'rollback' ? readRecords(ctx.root) : undefined;
  for (const [cmd, ...args] of plan.steps) {
    if (cmd === 'stop-vite') {
      const procs = ctx.procs ?? realProcs;
      const vite = viteServersIn(procs.list(), ctx.root);
      const failed = vite.filter((p) => !procs.kill(p.pid));
      landing.stopped_vite = vite.filter((p) => !failed.includes(p)).map((p) => p.pid);
      if (failed.length) { landing.ok = false; landing.stage = 'stop vite'; landing.vite_left = failed.map((p) => p.pid); break; }
      continue;
    }
    const r = ctx.run(cmd, cmd === 'git' ? ['-C', dir, ...args] : args, { cwd: cmd === 'git' ? undefined : ctx.root });
    const stage = cmd === 'git' ? `git ${args[0]}` : cmd === 'npm' && args[0] === 'ci' ? `npm ci --prefix ${args[2]}` : args.includes('forge:build-ui') ? 'build-ui' : args.at(-1)?.includes('install list') ? 'install list' : 'deploy';
    if (r.status !== 0) { landing.ok = false; landing.stage = stage; break; }
    if (stage === 'git push') landing.pushed = args.at(-1);
    if (stage === 'install list') {
      const n = installRows(r.stdout);
      landing.installations = n ?? 'unreadable';
      if (n !== 1) { landing.ok = false; landing.stage = 'install list'; break; }
    }
  }
  if (landing.ok === undefined) landing.ok = ['land', 'none', 'commit-only'].includes(plan.decision);
  if (plan.decision === 'rollback') {
    landing.target = /** @type {any} */ (plan).target;
    if (records) { for (const [n, text] of records) { mkdirSync(paths(ctx.root).records, { recursive: true }); writeFileSync(join(paths(ctx.root).records, n), text); } landing.records_restored = records.size; }
  }
  if (plan.decision === 'land' && landing.ok && /** @type {any} */ (plan).deploy) landing.deployed = /** @type {any} */ (plan).deploy;
  if (plan.reasons.length) landing.reasons = plan.reasons;
  if (name === 'dowser') day.landing = landing; else day.landings = { ...(day.landings ?? {}), [name]: landing };
  writeJson(paths(ctx.root).day, day);
  return { ...plan, steps: plan.steps.map((s) => s.join(' ')), landing, ok: landing.ok === true };
}

// ------------------------------------------------------------------------------------------------- main

const SPEC = { values: ['from', 'operator', 'date', 'approve', 'veto', 'target', 'file', 'verdicts', 'instruments', 'inbox', 'until', 'repo', 'paths', 'title', 'status', 'id', 'commit', 'note', 'n', 'add'], bool: ['dry-run', 'rate-limited'] };
const USAGE = 'usage: temper.mjs charter init --from <json> --operator <name> | charter show | day start|resume|end | repo start|end --repo <r> | repo paths --repo <r> --add a,b | cycle begin --target <t> [--repo <r>] | cycle end --file <f> | cycle reverify --n <n> [--repo <r>] | triage check --verdicts <f> --inbox <k> | modules bar | proposals resolve --id <p> --commit <sha> [--note t] | clock | report | land [--repo <r>] [--dry-run]';

/**
 * Runs one command. @param {string[]} argv @param {Ctx} [ctx]
 * @returns {{code: number, out: any}}
 */
export function main(argv, ctx = realCtx()) {
  try {
    const [cmd, maybeSub] = argv;
    const single = ['clock', 'report', 'land'].includes(cmd);
    const sub = single ? '' : maybeSub ?? '';
    const { flags: f, rest } = parseFlags(argv.slice(single ? 1 : 2), SPEC);
    if (rest.length) throw new UsageError(`unexpected argument ${rest[0]}`);
    /** @type {Record<string, () => any>} */
    const table = {
      'charter init': () => charterInit(ctx, f), 'charter show': () => needCharter(ctx),
      'day start': () => dayStart(ctx, f), 'day resume': () => dayResume(ctx), 'day end': () => dayEnd(ctx),
      'repo start': () => repoStart(ctx, f), 'repo paths': () => repoPaths(ctx, f), 'repo end': () => repoEnd(ctx, f),
      'cycle begin': () => cycleBegin(ctx, f), 'cycle end': () => cycleEnd(ctx, f), 'cycle reverify': () => cycleReverify(ctx, f), 'triage check': () => triageCheck(ctx, f),
      'modules bar': () => modulesBar(ctx, f), 'proposals resolve': () => proposalsResolve(ctx, f), 'clock ': () => clock(ctx, f), 'report ': () => report(ctx, f), 'land ': () => land(ctx, f),
    };
    const run = table[`${cmd} ${sub}`];
    if (!run) throw new UsageError(`unknown command ${[cmd, sub].filter(Boolean).join(' ') || '(none)'}`);
    const out = run();
    const red = (cmd === 'land' && out.ok === false && !out.dry_run) || (cmd === 'cycle' && ['end', 'reverify'].includes(sub) && out.green === false);
    return { code: red ? 1 : 0, out };
  } catch (e) {
    if (e instanceof UsageError) return { code: 2, out: { ok: false, error: e.message, usage: USAGE } };
    if (e instanceof Refusal) return { code: 1, out: { ok: false, error: e.message } };
    throw e;
  }
}

if (isMain(import.meta.url)) {
  const { code, out } = main(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  process.exitCode = code;
}
