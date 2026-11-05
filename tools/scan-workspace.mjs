// @ts-check
// scan-workspace - the mechanics a headless /dowser scan of a real repository shares between tools/dogfood.mjs (mock
// Forge) and tools/temper-scan.mjs (the live Forge app): a clone of the source's committed HEAD in a temp work folder
// (hidden paths left out by a sparse checkout), the skill installed there at project scope, the dowser CLI run against
// the clone with its own DOWSER_HOME, one `claude -p` scan, and the cards the scan created or moved. Nothing here
// writes into the source repository.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { appendFileSync, lstatSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveClaude, spawnClaude } from './claude-bin.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'skill/scripts/dowser.mjs');
const INSTALL = join(ROOT, 'skill/install.mjs');

/** The tools a scan may use; `mcp__dowser__*` reaches the dowser server, mock or live. */
export const SCAN_TOOLS = ['Bash', 'Read', 'Grep', 'Glob', 'Write', 'Edit', 'Skill', 'mcp__dowser__*'];

/** @typedef {{repo: string, home: string}} Workspace */

/** @param {string} repo @param {string[]} args @param {Record<string, string>} [env] */
export const git = (repo, args, env = {}) => execFileSync('git', ['-C', repo, '-c', 'core.autocrlf=false', ...args],
  { encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/**
 * Clones the source's HEAD (or `ref`: a branch of the source, else any commit it names) with the hidden paths left out
 * of the working tree by a sparse checkout. HEAD stays the source's real commit, so a later incremental scan finds the
 * previous scan's head in the clone's history. `origin`, when given, replaces the clone's origin URL (the skill derives
 * its project key from it: skill/scripts/lib/paths.mjs). The source is only read.
 * @param {string} source @param {string} repo @param {string[]} hide @param {{origin?: string, ref?: string}} [o]
 * @returns {{head: string, sha: string, hidden: string[]}}
 */
export function cloneRepo(source, repo, hide, o = {}) {
  const branch = o.ref !== undefined && gitOk(source, ['rev-parse', '--verify', '--quiet', `refs/heads/${o.ref}`]) ? o.ref : undefined;
  /** a ref that is no branch (a tag, a sha): resolved in the source, then made the clone's detached HEAD */
  let commit;
  if (o.ref !== undefined && branch === undefined) {
    try { commit = git(source, ['rev-parse', '--verify', '--quiet', `${o.ref}^{commit}`]); } catch { throw new Error(`${source} has no ref ${o.ref}`); }
  }
  execFileSync('git', ['clone', '-q', '--no-hardlinks', '--no-checkout', ...(branch ? ['--branch', branch] : []), source, repo], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (commit) git(repo, ['update-ref', '--no-deref', 'HEAD', commit]);
  const head = git(repo, ['rev-parse', '--short', 'HEAD']);
  const sha = git(repo, ['rev-parse', 'HEAD']);
  const hidden = hide.filter((p) => git(repo, ['ls-tree', '-r', '--name-only', 'HEAD', '--', p]) !== '');
  if (hidden.length) git(repo, ['sparse-checkout', 'set', '--no-cone', '/*', ...hidden.map((p) => `!/${p.replace(/\/+$/, '')}/`)]);
  git(repo, ['checkout', '-q']);
  if (o.origin) git(repo, ['remote', 'set-url', 'origin', o.origin]);
  // The project-scope install lands in .claude/skills/dowser; keep it out of the scan's git view.
  appendFileSync(join(repo, '.git/info/exclude'), '\n.claude/skills/dowser/\n');
  return { head, sha, hidden };
}

/** True when git exits 0. @param {string} repo @param {string[]} args */
export function gitOk(repo, args) {
  try { git(repo, args); return true; } catch { return false; }
}

/** Installs this checkout's skill into the clone at project scope (a copy: tests/ left out). @param {string} repo */
export function installSkill(repo) {
  const r = spawnSync(process.execPath, [INSTALL, '--harness', 'claude', '--scope', 'project'], { cwd: repo, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`install -> ${r.status}\n${r.stderr}`);
}

/** Runs the dowser CLI on the clone with the workspace's home; throws on failure. @param {Workspace} w @param {...string} args @returns {any} */
export function dowserCli(w, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--repo', w.repo], { encoding: 'utf8', env: { ...process.env, DOWSER_HOME: w.home } });
  if (r.status !== 0) throw new Error(`dowser ${args.join(' ')} -> ${r.status}\n${r.stderr}${r.stdout}`);
  return JSON.parse(r.stdout);
}

/** Removes the work folder (and a dev-link install inside the clone first). @param {string} work @param {string} repo */
export function removeWork(work, repo) {
  const link = join(repo, '.claude/skills/dowser');
  try {
    if (lstatSync(link).isSymbolicLink()) { try { unlinkSync(link); } catch { rmdirSync(link); } }
  } catch { /* no install */ }
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

/**
 * The `claude -p` arguments of one scan. `--setting-sources` without `user`: a user-scope dowser skill
 * (~/.claude/skills/dowser, often a link to another checkout) otherwise wins over the project-scope copy installed in
 * the clone, and the scan runs that skill. `--strict-mcp-config`: only the server in `mcpConfig` is connected.
 * ScheduleWakeup is denied: a scan that sets a fallback heartbeat while its lens agents run keeps `claude -p` alive
 * until the wakeup fires (a 30-minute heartbeat held a finished 11-minute scan open for 33 minutes, 2026-11-05),
 * and the answer is then the wakeup's turn, not the run summary.
 * `stream`: `--output-format stream-json --verbose` (one JSON event a line, the last the same result object `json`
 * prints), so a long scan can say what it is doing (runScanStream).
 * @param {{prompt: string, mcpConfig: string, addDir: string, model?: string, budget?: string, stream?: boolean}} o
 * @returns {string[]}
 */
export function scanArgs(o) {
  return ['-p', o.prompt, '--setting-sources', 'project,local', '--mcp-config', o.mcpConfig, '--strict-mcp-config', '--add-dir', o.addDir,
    '--allowedTools', ...SCAN_TOOLS, '--disallowedTools', 'ScheduleWakeup', '--output-format', ...(o.stream ? ['stream-json', '--verbose'] : ['json']),
    ...(o.model ? ['--model', o.model] : []), ...(o.budget ? ['--max-budget-usd', o.budget] : [])];
}

/**
 * Runs one scan in the clone and keeps its output in the work folder. `ok` is false on a non-zero exit, an
 * unparseable answer or `is_error`.
 * @param {string[]} args @param {{work: string, w: Workspace, timeoutMs?: number}} o
 * @returns {{ok: boolean, status: number | null, error?: string, result: any, minutes: number}}
 */
export function runScan(args, o) {
  const started = Date.now();
  const r = spawnClaude(args, { cwd: o.w.repo, env: { ...process.env, DOWSER_HOME: o.w.home }, encoding: 'utf8', timeout: o.timeoutMs ?? 90 * 60000,
    maxBuffer: 64 * 1024 * 1024 }, resolveClaude());
  writeFileSync(join(o.work, 'claude.json'), r.stdout ?? '');
  writeFileSync(join(o.work, 'claude.stderr.txt'), r.stderr ?? '');
  /** @type {any} */
  let result = {};
  try { result = JSON.parse(r.stdout); } catch { /* not JSON: ok is false below */ }
  const ok = r.status === 0 && typeof result === 'object' && result !== null && !result.is_error && 'result' in result;
  return { ok, status: r.status, ...(r.error ? { error: r.error.message } : {}), result, minutes: Math.round((Date.now() - started) / 60000) };
}

/**
 * The last tool step one stream-json event names, as `Tool detail` (the command, path or pattern, cut to 80
 * characters), or undefined when the event calls no tool. @param {any} ev @returns {string | undefined}
 */
export function toolStep(ev) {
  const uses = ev?.type === 'assistant' && Array.isArray(ev.message?.content) ? ev.message.content.filter((/** @type {any} */ c) => c?.type === 'tool_use') : [];
  const u = uses.at(-1);
  if (!u || typeof u.name !== 'string') return undefined;
  const i = u.input ?? {};
  const detail = [i.command, i.file_path, i.path, i.pattern, i.skill, i.description].find((v) => typeof v === 'string' && v.trim());
  const one = typeof detail === 'string' ? detail.replace(/\s+/g, ' ').trim() : '';
  return one ? `${u.name} ${one.length > 80 ? `${one.slice(0, 79)}...` : one}` : u.name;
}

/** The heartbeat line: elapsed minutes, and the last tool step when the stream gave one. @param {number} ms @param {string} [step] */
export const heartbeatLine = (ms, step) => `temper-scan: ${Math.floor(ms / 60000)} min elapsed${step ? `, last step: ${step}` : ''}`;

/**
 * The result object of a stream-json answer: its last `type: "result"` line (the object `--output-format json` prints).
 * @param {string} text @returns {any}
 */
export function streamResult(text) {
  let result;
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { const ev = JSON.parse(line); if (ev?.type === 'result') result = ev; } catch { /* a partial line */ }
  }
  return result ?? {};
}

/**
 * runScan with a heartbeat: the scan runs with `scanArgs({stream: true})` arguments, and every `everyMs` (60 s)
 * `beat` gets heartbeatLine (elapsed, the last tool step). The answer is the same as runScan's, read from the
 * stream's result line; the whole stream is kept as claude.json.
 * @param {string[]} args @param {{work: string, w: Workspace, timeoutMs?: number, everyMs?: number, beat?: (line: string) => void, claude?: import('./claude-bin.mjs').ClaudeCommand}} o
 * @returns {Promise<{ok: boolean, status: number | null, error?: string, result: any, minutes: number}>}
 */
export function runScanStream(args, o) {
  const started = Date.now();
  const c = o.claude ?? resolveClaude();
  const beat = o.beat ?? ((/** @type {string} */ l) => console.error(l));
  /** @type {import('node:child_process').SpawnOptionsWithStdioTuple<'ignore', 'pipe', 'pipe'>} */
  const opts = { cwd: o.w.repo, env: { ...process.env, DOWSER_HOME: o.w.home }, stdio: ['ignore', 'pipe', 'pipe'] };
  const quote = (/** @type {string} */ a) => `"${String(a).replace(/"/g, '""')}"`;
  /** @type {import('node:child_process').ChildProcessByStdio<null, import('node:stream').Readable, import('node:stream').Readable>} */
  const child = c.shell ? spawn([c.command, ...c.args, ...args].map(quote).join(' '), { ...opts, shell: true }) : spawn(c.command, [...c.args, ...args], opts);
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const err = [];
  let pending = '';
  /** @type {string | undefined} */
  let step;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (/** @type {string} */ d) => {
    out.push(d);
    const lines = (pending + d).split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const l of lines) { try { step = toolStep(JSON.parse(l)) ?? step; } catch { /* not an event */ } }
  });
  child.stderr.on('data', (/** @type {string} */ d) => err.push(d));
  const timer = setInterval(() => beat(heartbeatLine(Date.now() - started, step)), o.everyMs ?? 60000);
  /** @type {string | undefined} */
  let error;
  const kill = setTimeout(() => { error = 'timed out'; child.kill(); }, o.timeoutMs ?? 90 * 60000);
  return new Promise((done) => {
    child.on('error', (e) => { error = e.message; });
    child.on('close', (status) => {
      clearInterval(timer);
      clearTimeout(kill);
      const stdout = out.join('');
      writeFileSync(join(o.work, 'claude.json'), stdout);
      writeFileSync(join(o.work, 'claude.stderr.txt'), err.join(''));
      const result = streamResult(stdout);
      const ok = status === 0 && !error && !result.is_error && 'result' in result;
      done({ ok, status, ...(error ? { error } : {}), result, minutes: Math.round((Date.now() - started) / 60000) });
    });
  });
}

/** The store's fp -> status map, taken before a scan. @param {Workspace} w @returns {Map<string, string>} */
export const statusMap = (w) => new Map(dowserCli(w, 'list').proposals.map((/** @type {{fp: string, status: string}} */ p) => [p.fp, p.status]));

/**
 * `show` of every card the scan created or moved (its status differs from `before`).
 * @param {Workspace} w @param {Map<string, string>} before @returns {any[]}
 */
export function changedCards(w, before) {
  const { proposals } = dowserCli(w, 'list');
  return proposals.filter((/** @type {{fp: string, status: string}} */ p) => before.get(p.fp) !== p.status).map((/** @type {{fp: string}} */ p) => dowserCli(w, 'show', p.fp));
}

/** A file-name-safe UTC stamp, `2026-11-05T09-30-00`. */
export const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
