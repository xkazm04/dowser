#!/usr/bin/env node
// @ts-check
// temper-scan - one connected /dowser scan of a local repository into its own LIVE Dowser inbox, for /temper's
// "more data" scans (Dowser plus 2-3 other repos, read-only). The mechanics are tools/dogfood.mjs's
// (tools/scan-workspace.mjs): a clone of the repo's day branch (or its committed HEAD) in the OS temp folder, the skill installed there at
// project scope, one headless `claude -p` scan. The difference: the scan connects to the live `dowser` MCP server
// (tools/live-mcp.mjs) instead of the mock, keeps every card and pushes them to the inbox `--project-key`.
//
//   node tools/temper-scan.mjs --repo <path> --project-key <k> [--ref r] [--focus "goal: ..."|"area: ..."] [--budget-usd n]
//                              [--model m] [--lenses a,b] [--hide <path>]... [--keep] [--dry-run]
//     --repo         the repository to scan; only committed history is read, and nothing is written into it
//     --ref          the branch (or commit) to scan. Without it, the day's branch from the /temper day file of the
//                    checkout this tool belongs to (<checkout>/.temper/day.json, TEMPER_ROOT in tests): Dowser's
//                    `loop/<date>` when --repo is that checkout, a started build repo's `temper/<date>` when --repo
//                    is the charter's path for it (or its day worktree). Else the repo's HEAD. A day branch the
//                    repo lacks is an error, never a silent fallback to HEAD.
//     --project-key  the live inbox key (the push's rule; never the sample's reserved key). The clone's origin is set
//                    to it, so the skill's project key is exactly this.
//     --focus        a focused scan (`goal: <text>` or `area: <path>`, SKILL.md Arguments; passed on as `goal:<text>`)
//     --budget-usd   passed to claude as --max-budget-usd
//     --hide         a repo-relative path left out of the clone by a sparse checkout (repeatable)
//     --keep         keep the temp work folder
//     --dry-run      build the workspace and print the plan; no Claude call, no Temper home written
//
// The Dowser memory lives in DOWSER_HOME = <temper home>/homes/<project-key> (TEMPER_HOME, default ~/.temper), so the
// next scan of the same key pulls the verdicts and follows the rules. Each scan appends one row to
// <temper home>/scans.jsonl: {ts, repo, ref, ref_from, head, sha, project_key, focus?, ok, minutes, cost_usd?, turns?, cards, report}, where
// ref is the scanned branch (or commit), ref_from says how it was chosen (flag, day, head), head the short sha, sha the full one;
// report is <temper home>/scans/<stamp>-<project-key>.json: the row, the scan's summary and every card the scan created
// or moved as {fp, ref?, status, lens, title, evidence, created} (tools/temper-cards.mjs lists the whole scan home).
// Exit codes: 0 done (or dry run), 1 the scan failed, 2 bad arguments.
import { existsSync, appendFileSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FOCUS_RE, LENSES, isOneOf } from '../skill/scripts/lib/model.mjs';
import { liveDowserServer, writeMcpConfig } from './live-mcp.mjs';
import { changedCards, cloneRepo, dowserCli, git, gitOk, installSkill, removeWork, runScan, scanArgs, stamp, statusMap } from './scan-workspace.mjs';
import { cardRow } from './temper-cards.mjs';
import { UsageError, checkProjectKey, isMain, parseFlags, temperHome } from './temper-lib.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const USAGE = 'usage: node tools/temper-scan.mjs --repo <path> --project-key <k> [--ref r] [--focus "goal: .."|"area: .."] [--budget-usd n] [--model m] [--lenses a,b] [--hide path]... [--keep] [--dry-run]';

/** @typedef {{repo: string, projectKey: string, ref?: string, focus?: string, budget?: string, model?: string, lenses: string[], hide: string[], keep: boolean, dryRun: boolean}} ScanOpts */

/**
 * The command line as options; throws UsageError.
 * @param {string[]} argv
 * @returns {ScanOpts}
 */
export function parseScanArgs(argv) {
  const { flags: f, multi, rest } = parseFlags(argv, { values: ['repo', 'project-key', 'ref', 'focus', 'budget-usd', 'model', 'lenses'], bool: ['keep', 'dry-run'], multi: ['hide'] });
  if (rest.length) throw new UsageError(`unexpected argument ${rest[0]}`);
  if (typeof f.repo !== 'string') throw new UsageError('--repo is required');
  const repo = resolve(f.repo);
  if (!existsSync(repo) || !statSync(repo).isDirectory()) throw new UsageError(`--repo ${repo} is not a folder`);
  const projectKey = checkProjectKey(f['project-key']);
  // the store's form has no space after the colon (skill/scripts/lib/runs.mjs): `goal: x` is passed as `goal:x`
  const focus = typeof f.focus === 'string' ? f.focus.trim().replace(/^(goal|area):\s+/, '$1:') : undefined;
  if (focus !== undefined && !FOCUS_RE.test(focus)) throw new UsageError('--focus must be "goal: <text>" or "area: <path or feature>"');
  const budget = typeof f['budget-usd'] === 'string' ? f['budget-usd'] : undefined;
  if (budget !== undefined && !(Number(budget) > 0)) throw new UsageError('--budget-usd must be a positive number');
  const lenses = typeof f.lenses === 'string' ? f.lenses.split(',').map((s) => s.trim()).filter(Boolean) : [...LENSES];
  for (const l of lenses) if (!isOneOf(LENSES, l)) throw new UsageError(`unknown lens ${l} (one of ${LENSES.join(', ')})`);
  const ref = typeof f.ref === 'string' ? f.ref.trim() : undefined;
  if (ref !== undefined && !/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(ref)) throw new UsageError('--ref is a branch name or a commit');
  return { repo, projectKey, ref, focus, budget, model: typeof f.model === 'string' ? f.model : undefined, lenses, hide: multi.hide ?? [],
    keep: f.keep === true, dryRun: f['dry-run'] === true };
}

/** A path as compared on this platform (case-insensitive on Windows). @param {string} p */
const samePath = (p) => { const r = resolve(p).replace(/[\\/]+$/, ''); return process.platform === 'win32' ? r.toLowerCase() : r; };

/** @param {string} file @returns {any} */
const readJsonOr = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return undefined; } };

/**
 * Which ref of `repo` a scan reads. An explicit `--ref` wins. Else the open /temper day of `root` (its
 * .temper/day.json, with .temper/charter.json naming the repos' paths): Dowser's day branch when `repo` is `root`, a
 * started build repo's branch when `repo` is that repo's charter path or its day worktree. Else HEAD (no day, an ended
 * day, a repo not started today).
 * @param {{repo: string, ref?: string}} o @param {string} root the checkout whose .temper/ holds the day
 * @returns {{ref?: string, from: 'flag' | 'day' | 'head', repo_name?: string}}
 */
export function resolveScanRef(o, root) {
  if (o.ref) return { ref: o.ref, from: 'flag' };
  const day = readJsonOr(join(root, '.temper', 'day.json'));
  if (!day || typeof day !== 'object' || day.ended_at) return { from: 'head' };
  const want = samePath(o.repo);
  if (want === samePath(root) && typeof day.branch === 'string') return { ref: day.branch, from: 'day', repo_name: 'dowser' };
  const charter = readJsonOr(join(root, '.temper', 'charter.json'));
  for (const [name, s] of Object.entries(day.repos ?? {})) {
    const r = (charter?.repos ?? []).find((/** @type {any} */ x) => x?.name === name);
    const at = [typeof r?.path === 'string' ? r.path : undefined, typeof s?.worktree === 'string' ? s.worktree : undefined].filter((x) => x !== undefined);
    if (typeof s?.branch === 'string' && at.some((p) => samePath(/** @type {string} */ (p)) === want)) return { ref: s.branch, from: 'day', repo_name: name };
  }
  return { from: 'head' };
}

/**
 * The scan prompt: a connected, unattended run that keeps every card and pushes it (the delegate triages later).
 * @param {{lenses: string[], focus?: string}} o
 */
export const scanPrompt = (o) => [
  `Use the dowser skill to scan this repository${o.focus ? ` with the focus \`${o.focus}\` (pass it as --focus, a focused run)` : ''}. This is an unattended /temper scan: no person is present, so never ask a question and never wait for an answer.`,
  '- Mode: dev (already stored in prefs).',
  `- Run these lenses: ${o.lenses.join(', ')}. Report any other lens in run finish as {"state":"skipped","reason":"not in this scan"}.`,
  '- The LIVE dowser MCP server is connected (tool names may end with _development). Pull verdicts, get the direction and reflect as the skill says.',
  '- Section 7 (pre-triage): run pretriage, then record no moves and keep every card, as if the runner chose "keep the rest". Do not accept or decline rule offers.',
  '- The operator authorized this push: push the kept cards (section 8) as the skill says, then send the areas.',
  '- Finish the run (section 9) and print the summary.',
].join('\n');

/**
 * Card counts of one scan from the cards it created or moved.
 * @param {any[]} cards `show` outputs @param {Map<string, string>} before
 * @returns {{created: number, moved: number, pushed: number, by_status: Record<string, number>}}
 */
export function cardCounts(cards, before) {
  /** @type {Record<string, number>} */
  const byStatus = {};
  let created = 0, pushed = 0;
  for (const s of cards) {
    const c = s.card ?? {};
    byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
    if (!before.has(c.fp)) created++;
    if (c.external_ref) pushed++;
  }
  return { created, moved: cards.length - created, pushed, by_status: byStatus };
}

/** Where one scan's report goes. @param {string} home the Temper home @param {string} key */
export const reportFile = (home, key) => join(home, 'scans', `${stamp()}-${key}.json`);

/**
 * Writes one scan's report: its ledger row, its summary and the cards it created or moved, so triage needs neither the
 * deleted clone nor a store query.
 * @param {string} file @param {Record<string, unknown>} row @param {string | undefined} summary
 * @param {any[]} changed `show` outputs @param {Map<string, string>} before
 */
export function writeReport(file, row, summary, changed, before) {
  mkdirSync(dirname(file), { recursive: true });
  const cards = changed.map((s) => ({ ...cardRow(s), created: !before.has(s.fp) }));
  writeFileSync(file, `${JSON.stringify({ ...row, ...(summary ? { summary } : {}), cards }, null, 2)}\n`);
}

/** @param {ScanOpts} o */
function main(o) {
  const home = temperHome();
  const work = mkdtempSync(join(tmpdir(), 'temper-scan-'));
  const w = { repo: join(work, 'repo'), home: o.dryRun ? join(work, 'home') : join(home, 'homes', o.projectKey) };
  let failed = false;
  try {
    git(o.repo, ['rev-parse', '--verify', 'HEAD']);
    const pick = resolveScanRef(o, process.env.TEMPER_ROOT ? resolve(process.env.TEMPER_ROOT) : ROOT);
    if (pick.from === 'day' && pick.ref && !gitOk(o.repo, ['rev-parse', '--verify', '--quiet', `${pick.ref}^{commit}`])) {
      throw new Error(`the day names ${pick.ref} for ${o.repo}, and the repo has no such branch: pass --ref to scan another`);
    }
    const server = liveDowserServer();
    const cloned = cloneRepo(o.repo, w.repo, o.hide, { origin: o.projectKey, ...(pick.ref ? { ref: pick.ref } : {}) });
    const ref = pick.ref ?? (git(w.repo, ['rev-parse', '--abbrev-ref', 'HEAD']) || 'HEAD');
    const scanned = { ref, ref_from: pick.from, head: cloned.head, sha: cloned.sha };
    mkdirSync(w.home, { recursive: true });
    installSkill(w.repo);
    const { project_key: key } = dowserCli(w, 'init');
    if (key !== o.projectKey) throw new Error(`the clone's project key is ${key}, not ${o.projectKey}`);
    dowserCli(w, 'prefs', 'set', 'mode=dev');
    const mcpConfig = writeMcpConfig(join(work, 'mcp.json'), server);
    const args = scanArgs({ prompt: scanPrompt(o), mcpConfig, addDir: tmpdir(), model: o.model, budget: o.budget });
    const plan = { repo: o.repo, ...scanned, hidden: cloned.hidden, project_key: o.projectKey, ...(o.focus ? { focus: o.focus } : {}), lenses: o.lenses,
      dowser_home: o.dryRun ? join(home, 'homes', o.projectKey) : w.home, ledger: join(home, 'scans.jsonl'), mcp: { type: server.type, ...(server.url ? { url: server.url } : {}) },
      ...(o.budget ? { budget_usd: Number(o.budget) } : {}), work };
    if (o.dryRun) {
      console.log(JSON.stringify({ dry_run: true, ...plan, command: `claude ${args.length} args, cwd ${w.repo}` }, null, 2));
      return;
    }
    console.error(`temper-scan: scanning ${o.repo} ${ref}@${cloned.head} into the live inbox ${o.projectKey} (this calls Claude and costs tokens)`);
    const before = statusMap(w);
    const scan = runScan(args, { work, w });
    const r = scan.result ?? {};
    let cards = { created: 0, moved: 0, pushed: 0, by_status: {} };
    /** @type {any[]} */
    let changed = [];
    try { changed = changedCards(w, before); cards = cardCounts(changed, before); } catch { /* the store is unreadable: counts stay empty */ }
    const report = reportFile(home, o.projectKey);
    const row = { ts: new Date().toISOString(), repo: o.repo, ...scanned, project_key: o.projectKey, ...(o.focus ? { focus: o.focus } : {}),
      ok: scan.ok, minutes: scan.minutes, ...(typeof r.total_cost_usd === 'number' ? { cost_usd: Number(r.total_cost_usd.toFixed(4)) } : {}),
      ...(typeof r.num_turns === 'number' ? { turns: r.num_turns } : {}), cards, report };
    writeReport(report, row, typeof r.result === 'string' ? r.result : undefined, changed, before);
    mkdirSync(home, { recursive: true });
    appendFileSync(join(home, 'scans.jsonl'), JSON.stringify(row) + '\n');
    if (!scan.ok) {
      failed = true;
      console.error(`temper-scan: the scan failed (exit ${scan.status}${scan.error ? `, ${scan.error}` : ''}); see ${work}`);
    }
    console.log(JSON.stringify({ ...row, ...(typeof r.result === 'string' ? { summary: r.result } : {}), ...(o.keep || failed ? { work } : {}) }, null, 2));
  } catch (e) {
    failed = true;
    console.error(`temper-scan: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    if (o.keep || failed) console.error(`temper-scan: work folder kept at ${work}`);
    else removeWork(work, w.repo);
    process.exitCode = failed ? 1 : 0;
  }
}

if (isMain(import.meta.url)) {
  try { main(parseScanArgs(process.argv.slice(2))); } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`temper-scan: ${e.message}\n${USAGE}`);
    process.exitCode = 2;
  }
}
