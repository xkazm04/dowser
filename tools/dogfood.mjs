#!/usr/bin/env node
// @ts-check
// dogfood - scans a real repository (default: this one) with all four lenses, against a mock Forge seeded with an
// invented but code-checked world (default: tools/dogfood/dowser-world.json), and writes the cards out for hand
// evaluation. lens-eval scores one lens on a fixture with an answer key; this has no answer key - the judge is a
// person reading each card against the code.
//
// It clones the source's committed HEAD into the OS temp folder, leaves the --hide paths out of the working tree by
// a sparse checkout (by default the seed itself, so the scan cannot read the world it is being tested against), installs
// the skill there at project scope (a copy: tests/ left out), gives it a fresh DOWSER_HOME and runs one headless
// Claude Code scan. Nothing is written into the source repository.
//
//   node tools/dogfood.mjs [--source <repo>] [--seed <file>] [--hide <path>]... [--lenses a,b] [--model m]
//                          [--budget-usd n] [--out <dir>] [--campaign <dir>] [--keep] [--dry-run]
//     --source     the repository to scan (default: this checkout); only its committed HEAD is scanned
//     --seed       the mock Forge seed; its `directions` placeholder key DOWSER_PROJECT is re-keyed to the clone's
//                  project key (default tools/dogfood/dowser-world.json)
//     --hide       a repo-relative path removed from the clone before the scan (repeatable; default tools/dogfood
//                  and docs/evals when --source is this checkout - the seed and the judged results - none otherwise)
//     --lenses     comma-separated lens ids (default all four)
//     --out        where the report goes (default <campaign>/reports, else <DOWSER_HOME or ~/.dowser>/dogfood/)
//     --campaign   a folder that persists across scans: the Dowser home (memory, verdicts, rules) and the mock
//                  Forge state (inbox, verdicts, outcomes). The scan pushes its cards to the inbox (section 8),
//                  tools/dogfood-decide.mjs decides them there as the team, and the next scan pulls the verdicts.
//                  Before each scan the state's tickets, pages, goals and direction are refreshed from --seed.
//     --keep       keep the temp work folder (clone, temp home, claude output) and print its path
//     --dry-run    build the workspace and print the plan without calling Claude
//
// Output: <out>/dogfood-<stamp>.json (run summary, every card with evidence and transitions, cost) and a .md of
// the same with an empty verdict line per card for the judge. Env: CLAUDE_BIN (default `claude`).
// Exit codes: 0 done (or dry run), 1 the scan failed, 2 bad arguments.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LENSES, isOneOf } from '../skill/scripts/lib/model.mjs';
import { dowserHome } from '../skill/scripts/lib/paths.mjs';
import { seeded } from './mock-forge-mcp.mjs';
import { resolveClaude } from './claude-bin.mjs';
import { changedCards, cloneRepo, dowserCli as cli, installSkill, removeWork, runScan, scanArgs, stamp, statusMap } from './scan-workspace.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PLACEHOLDER = 'DOWSER_PROJECT';
const MOCK = join(ROOT, 'tools/mock-forge-mcp.mjs');
const CLAUDE = process.env.CLAUDE_BIN ?? 'claude';
/** How CLAUDE is started here (an npm claude.cmd on Windows runs its target directly: tools/claude-bin.mjs). */
const CLAUDE_CMD = resolveClaude(CLAUDE);

/** @typedef {{source: string, seed: string, hide: string[], lenses: string[], model?: string, budget?: string, out: string, campaign?: string, keep: boolean, dryRun: boolean}} Opts */

/** @param {string} msg @returns {never} */
function usage(msg) {
  console.error(`dogfood: ${msg}\nusage: node tools/dogfood.mjs [--source repo] [--seed file] [--hide path]... [--lenses a,b] [--model m] [--budget-usd n] [--out dir] [--campaign dir] [--keep] [--dry-run]`);
  process.exit(2);
}

/** @param {string[]} argv @returns {Opts} */
function parseArgs(argv) {
  /** @type {Record<string, string | true>} */
  const f = {};
  /** @type {string[]} */
  const hide = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) usage(`unexpected argument ${a}`);
    const k = a.slice(2);
    const v = argv[i + 1];
    if (['keep', 'dry-run'].includes(k)) f[k] = true;
    else if (k === 'hide' && v && !v.startsWith('--')) { hide.push(v); i++; }
    else if (['source', 'seed', 'lenses', 'model', 'budget-usd', 'out', 'campaign'].includes(k) && v && !v.startsWith('--')) { f[k] = v; i++; }
    else usage(`unknown or valueless flag ${a}`);
  }
  const source = resolve(typeof f.source === 'string' ? f.source : ROOT);
  const self = source === resolve(ROOT);
  const lenses = typeof f.lenses === 'string' ? f.lenses.split(',').map((s) => s.trim()).filter(Boolean) : [...LENSES];
  for (const l of lenses) if (!isOneOf(LENSES, l)) usage(`unknown lens ${l} (one of ${LENSES.join(', ')})`);
  const campaign = typeof f.campaign === 'string' ? resolve(f.campaign) : undefined;
  return {
    source,
    seed: resolve(typeof f.seed === 'string' ? f.seed : join(ROOT, 'tools/dogfood/dowser-world.json')),
    hide: hide.length ? hide : self ? ['tools/dogfood', 'docs/evals'] : [],
    lenses,
    model: typeof f.model === 'string' ? f.model : undefined,
    budget: typeof f['budget-usd'] === 'string' ? f['budget-usd'] : undefined,
    out: resolve(typeof f.out === 'string' ? f.out : campaign ? join(campaign, 'reports') : join(dowserHome(), 'dogfood')),
    campaign,
    keep: f.keep === true,
    dryRun: f['dry-run'] === true,
  };
}

/** @param {string} lenses @param {boolean} push */
const prompt = (lenses, push) => [
  'Use the dowser skill to scan this repository. This is an unattended evaluation run: no person is present, so never ask a question and never wait for an answer.',
  '- Mode: dev (already stored in prefs).',
  `- Run these lenses: ${lenses}. Report any other lens in run finish as {"state":"skipped","reason":"not in this evaluation"}.`,
  '- The dowser MCP server is connected. Pull verdicts, get the direction and reflect as the skill says.',
  '- Section 7 (pre-triage): record no moves and keep every card, as if the runner chose "keep the rest". Do not accept or decline rule offers.',
  push ? '- Push the kept cards (section 8), as the skill says.' : '- Skip section 8 (push).',
  '- Finish the run (section 9) and print the summary.',
].join('\n');

/** One card as markdown for the judge. @param {any} s the `show` output @param {number} i */
function cardMd(s, i) {
  const c = s.card;
  const ev = (s.evidence ?? []).map((/** @type {any} */ e) => `  - ${e.type} \`${e.ref}\`${e.quote ? `: ${JSON.stringify(e.quote)}` : ''}`);
  return [
    `### ${i}. [${c.lens}] ${c.title}`,
    '',
    `\`${c.fp}\` · ${c.kind} · ${c.status} · confidence ${c.confidence ?? '?'} · effort ${c.effort?.size ?? '?'}${c.artifacts ? ` · views: ${c.artifacts.map((/** @type {any} */ a) => a.kind).join(', ')}` : ''}`,
    '',
    `> ${String(c.rationale ?? '').replace(/\n/g, ' ')}`,
    '',
    String(c.body ?? ''),
    '',
    '- Evidence:',
    ...ev,
    '',
    '**Verdict:** real | partly | wrong · **would keep:** yes | no · **note:**',
    '',
  ].join('\n');
}

/**
 * The mock's backend before this scan: the campaign state with its sources and direction refreshed from the seed
 * (inbox items, verdicts, rules and outcomes kept), or the seed alone.
 * @param {any} seed @param {string | undefined} stateFile
 */
function backendFor(seed, stateFile) {
  const fresh = seeded(seed);
  if (!stateFile || !existsSync(stateFile)) return fresh;
  const prev = JSON.parse(readFileSync(stateFile, 'utf8'));
  return { ...prev, tickets: fresh.tickets, pages: fresh.pages, goals: fresh.goals, directions: fresh.directions };
}

const o = parseArgs(process.argv.slice(2));
const work = mkdtempSync(join(tmpdir(), 'dowser-dogfood-'));
const w = { repo: join(work, 'repo'), home: o.campaign ? join(o.campaign, 'home') : join(work, 'home') };
const mcpConfig = join(work, 'mcp.json');
const stateFile = o.campaign ? join(o.campaign, 'forge-state.json') : join(work, 'forge-state.json');
let failed = false;
try {
  const cloned = cloneRepo(o.source, w.repo, o.hide);
  mkdirSync(w.home, { recursive: true });
  installSkill(w.repo);
  const { project_key: projectKey } = cli(w, 'init');
  cli(w, 'prefs', 'set', 'mode=dev');
  const seed = JSON.parse(readFileSync(o.seed, 'utf8'));
  if (seed.directions?.[PLACEHOLDER]) seed.directions = { [projectKey]: seed.directions[PLACEHOLDER] };
  if (!o.dryRun) writeFileSync(stateFile, JSON.stringify(backendFor(seed, o.campaign ? stateFile : undefined), null, 2));
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { dowser: { type: 'stdio', command: process.execPath,
    args: [MOCK, '--state', stateFile] } } }, null, 2));
  const args = scanArgs({ prompt: prompt(o.lenses.join(', '), Boolean(o.campaign)), mcpConfig, addDir: tmpdir(), model: o.model, budget: o.budget });
  const plan = {
    source: o.source, head: cloned.head, ...(o.campaign ? { campaign: o.campaign } : {}), hidden: cloned.hidden, work, project_key: projectKey, lenses: o.lenses,
    seed: { file: o.seed, tickets: seed.tickets?.length ?? 0, pages: seed.pages?.length ?? 0, goals: seed.goals?.length ?? 0, direction: Boolean(seed.directions?.[projectKey]) },
  };
  if (o.dryRun) {
    console.log(JSON.stringify({ dry_run: true, ...plan, claude: CLAUDE_CMD, command: `${CLAUDE} ${args.length} args, cwd ${w.repo}, DOWSER_HOME=${w.home}` }, null, 2));
  } else {
    console.error(`dogfood: scanning ${o.source}@${cloned.head} with ${o.lenses.join(', ')} in ${w.repo} (this calls Claude and costs tokens)`);
    // what the store held before: the report shows the cards this scan created or moved, not a campaign's history
    const before = statusMap(w);
    const scan = runScan(args, { work, w });
    const result = scan.result;
    if (!scan.ok) {
      failed = true;
      console.error(`dogfood: the scan failed (exit ${scan.status}${scan.error ? `, ${scan.error}` : ''}); see ${work}`);
    } else {
      const status = cli(w, 'status', '--runs', '1');
      const cards = changedCards(w, before);
      const at = stamp();
      const report = { ts: new Date().toISOString(), ...plan, minutes: scan.minutes,
        cost_usd: result.total_cost_usd, turns: result.num_turns, summary: result.result, status, cards };
      mkdirSync(o.out, { recursive: true });
      const jsonFile = join(o.out, `dogfood-${at}.json`);
      const mdFile = join(o.out, `dogfood-${at}.md`);
      writeFileSync(jsonFile, JSON.stringify(report, null, 2));
      const live = cards.filter((/** @type {any} */ s) => !['dropped', 'merged'].includes(s.card.status));
      writeFileSync(mdFile, [
        `# Dogfood scan - ${o.source}@${cloned.head}`, '',
        `${report.ts} · lenses ${o.lenses.join(', ')} · ${live.length} cards (${cards.length - live.length} dropped or merged) · $${result.total_cost_usd?.toFixed?.(2) ?? '?'} · ${report.minutes} min`, '',
        '## Run summary', '', String(result.result ?? ''), '',
        '## Cards', '', ...live.map((/** @type {any} */ s, /** @type {number} */ i) => cardMd(s, i + 1)),
      ].join('\n'));
      console.log(JSON.stringify({ cards: live.length, dropped_or_merged: cards.length - live.length, cost_usd: result.total_cost_usd,
        turns: result.num_turns, report: { json: jsonFile, md: mdFile }, ...(o.keep ? { work } : {}) }, null, 2));
    }
  }
} catch (e) {
  failed = true;
  console.error(`dogfood: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  if (o.keep || (failed && !o.dryRun)) console.error(`dogfood: work folder kept at ${work}`);
  else removeWork(work, w.repo);
}
process.exit(failed ? 1 : 0);
