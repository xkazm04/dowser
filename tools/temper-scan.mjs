#!/usr/bin/env node
// @ts-check
// temper-scan - one connected /dowser scan of a local repository into its own LIVE Dowser inbox, for /temper's
// "more data" scans (Dowser plus 2-3 other repos, read-only). The mechanics are tools/dogfood.mjs's
// (tools/scan-workspace.mjs): a clone of the repo's committed HEAD in the OS temp folder, the skill installed there at
// project scope, one headless `claude -p` scan. The difference: the scan connects to the live `dowser` MCP server
// (tools/live-mcp.mjs) instead of the mock, keeps every card and pushes them to the inbox `--project-key`.
//
//   node tools/temper-scan.mjs --repo <path> --project-key <k> [--focus "goal: ..."|"area: ..."] [--budget-usd n]
//                              [--model m] [--lenses a,b] [--hide <path>]... [--keep] [--dry-run]
//     --repo         the repository to scan; only its committed HEAD is read, and nothing is written into it
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
// <temper home>/scans.jsonl: {ts, repo, head, project_key, focus?, ok, minutes, cost_usd?, turns?, cards}.
// Exit codes: 0 done (or dry run), 1 the scan failed, 2 bad arguments.
import { existsSync, appendFileSync, mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FOCUS_RE, LENSES, isOneOf } from '../skill/scripts/lib/model.mjs';
import { liveDowserServer, writeMcpConfig } from './live-mcp.mjs';
import { changedCards, cloneRepo, dowserCli, git, installSkill, removeWork, runScan, scanArgs, statusMap } from './scan-workspace.mjs';
import { UsageError, checkProjectKey, isMain, parseFlags, temperHome } from './temper-lib.mjs';

const USAGE = 'usage: node tools/temper-scan.mjs --repo <path> --project-key <k> [--focus "goal: .."|"area: .."] [--budget-usd n] [--model m] [--lenses a,b] [--hide path]... [--keep] [--dry-run]';

/** @typedef {{repo: string, projectKey: string, focus?: string, budget?: string, model?: string, lenses: string[], hide: string[], keep: boolean, dryRun: boolean}} ScanOpts */

/**
 * The command line as options; throws UsageError.
 * @param {string[]} argv
 * @returns {ScanOpts}
 */
export function parseScanArgs(argv) {
  const { flags: f, multi, rest } = parseFlags(argv, { values: ['repo', 'project-key', 'focus', 'budget-usd', 'model', 'lenses'], bool: ['keep', 'dry-run'], multi: ['hide'] });
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
  return { repo, projectKey, focus, budget, model: typeof f.model === 'string' ? f.model : undefined, lenses, hide: multi.hide ?? [],
    keep: f.keep === true, dryRun: f['dry-run'] === true };
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

/** @param {ScanOpts} o */
function main(o) {
  const home = temperHome();
  const work = mkdtempSync(join(tmpdir(), 'temper-scan-'));
  const w = { repo: join(work, 'repo'), home: o.dryRun ? join(work, 'home') : join(home, 'homes', o.projectKey) };
  let failed = false;
  try {
    git(o.repo, ['rev-parse', '--verify', 'HEAD']);
    const server = liveDowserServer();
    const cloned = cloneRepo(o.repo, w.repo, o.hide, { origin: o.projectKey });
    mkdirSync(w.home, { recursive: true });
    installSkill(w.repo);
    const { project_key: key } = dowserCli(w, 'init');
    if (key !== o.projectKey) throw new Error(`the clone's project key is ${key}, not ${o.projectKey}`);
    dowserCli(w, 'prefs', 'set', 'mode=dev');
    const mcpConfig = writeMcpConfig(join(work, 'mcp.json'), server);
    const args = scanArgs({ prompt: scanPrompt(o), mcpConfig, addDir: tmpdir(), model: o.model, budget: o.budget });
    const plan = { repo: o.repo, head: cloned.head, hidden: cloned.hidden, project_key: o.projectKey, ...(o.focus ? { focus: o.focus } : {}), lenses: o.lenses,
      dowser_home: o.dryRun ? join(home, 'homes', o.projectKey) : w.home, ledger: join(home, 'scans.jsonl'), mcp: { type: server.type, ...(server.url ? { url: server.url } : {}) },
      ...(o.budget ? { budget_usd: Number(o.budget) } : {}), work };
    if (o.dryRun) {
      console.log(JSON.stringify({ dry_run: true, ...plan, command: `claude ${args.length} args, cwd ${w.repo}` }, null, 2));
      return;
    }
    console.error(`temper-scan: scanning ${o.repo}@${cloned.head} into the live inbox ${o.projectKey} (this calls Claude and costs tokens)`);
    const before = statusMap(w);
    const scan = runScan(args, { work, w });
    const r = scan.result ?? {};
    let cards = { created: 0, moved: 0, pushed: 0, by_status: {} };
    try { cards = cardCounts(changedCards(w, before), before); } catch { /* the store is unreadable: counts stay empty */ }
    const row = { ts: new Date().toISOString(), repo: o.repo, head: cloned.head, project_key: o.projectKey, ...(o.focus ? { focus: o.focus } : {}),
      ok: scan.ok, minutes: scan.minutes, ...(typeof r.total_cost_usd === 'number' ? { cost_usd: Number(r.total_cost_usd.toFixed(4)) } : {}),
      ...(typeof r.num_turns === 'number' ? { turns: r.num_turns } : {}), cards };
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
