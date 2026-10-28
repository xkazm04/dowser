#!/usr/bin/env node
// @ts-check
// dowser - the single CLI entry of the Dowser skill. The agent never writes SQL: every store write goes
// through this script. Output is JSON on stdout (one object; JSONL for `propose`); diagnostics go to stderr.
// The store lives at ~/.dowser/projects/<project-key>/dowser.db (DOWSER_HOME overrides); nothing is ever
// written inside the scanned repo.
//
//   node dowser.mjs <command> [--repo <path>] [flags]          (--repo defaults to the cwd)
//   init                                   create the store -> {db, project_key, repo, user_version}
//   run start --mode full|incremental|focused [--harness h] [--model m] [--focus goal:..|area:..]
//                                          -> {run_id, base_sha?, head_sha?, db}  (base_sha = last done run's head)
//   run finish --run <id> --lenses <json | @file> [--status done|failed]
//                                          lenses: {<lens>: {state: ran|skipped|partial, reason?, emitted?,
//                                          verified?, dropped?, truncated?}}
//   propose --run <id> --file <jsonl> --kinds <lens>=<k1,k2> [--kinds ...]
//                                          JSONL out, one line per input line: {line, result, fp?, ...} where
//                                          result is created | evidence-grew | suppressed | duplicate |
//                                          invalid:<why>; then one {summary} line
//   verify --run <id>                      re-check code/doc quotes -> verified | dropped (verify-failed:<ref>)
//   move <fp> --to <status> --by <kind:name> [--from s] [--reason code] [--note t] [--into fp] [--run id]
//   status [--runs n]                      counts by status and lens, last runs, "top N of M" truncation
//   context --run <id> --lens <l> [--focus f]  -> {lens, lens_version, kinds, budget, suppressed, near, rules,
//                                          exemplars, outcomes?: {right, partly, wrong}, since_sha?, focus?}
//   similar <fp>                           same-lens items sharing an anchor or 2+ topic tokens, with the overlap
//   show <fp>                              ask-why: the card, every evidence row, every transition (no rescan)
//   list [--lens l] [--status s] [--title substring]  -> {proposals: [{fp, lens, status, title, decided_at?}]}
//   rules offer | rules list [--lens l] | rules accept|decline <id> --by human:<name> [--text t]
//   reflect export                         -> {project_key, rules_json?, more?}: the dowser_reflect_sync arguments
//                                          (rules in state `offered`, oldest first, at most 50; read-only;
//                                          run `rules offer` first)
//   reflect ingest --file <json>           apply a dowser_reflect_sync response: each rule Forge decided is a CAS
//                                          offered -> accepted|declined (others skipped), each outcome an
//                                          append-only row -> {rules_applied, rules_skipped, outcomes_added,
//                                          outcomes_seen}; idempotent
//   prefs get [key ...] | prefs set key=value ...   ~/.dowser/user.json (mode dev|guided, verbosity short|full)
//   outbox --run <id>                      -> {project_key, run_id, proposals_json, repo_url?, head_sha?, more?}:
//                                          the dowser_proposals_push arguments (verified, not pushed yet; pushed
//                                          items whose evidence grew), at most 50; `more: true` = run it again
//   ingest-push --file <json>              apply a dowser_proposals_push response -> pushed | merged | refused
//   ingest-verdicts --file <json>          apply a dowser_verdicts_pull response (CAS, idempotent), keep cursor;
//                                          an accepted verdict records issue_ref/issue_url
//   areas --run <id> [--top 40]            -> {project_key, run_id, areas_json}: the dowser_areas_push arguments
//                                          (directories at depth 1-2: files, churn_90d, authors_90d?, last_change?)
//   ingest-sources --run <id> --type ticket|page|goal --file <json>   cache a dowser_sources_* response -> refs
//                                          (contract: docs/contracts/forge-mcp-2.md; the agent calls the tools)
//   ingest-direction --run <id> --file <json>   cache a dowser_direction_get response on the run; context
//                                          --lens then carries that lens's direction
//   deps --run <id>                        run the dependency auditors present (read-only), cache their findings
//                                          as dep items -> {auditors: [{tool, state, reason?, found?}], refs}
//
// Exit codes: 0 ok; 1 partial (some propose lines invalid); 2 bad input or refused move (stdout carries
// {"error":"refused","current":<status>,...}); 3 store or connection unavailable, or not implemented.

// node:sqlite prints an ExperimentalWarning on Node 22; it is noise in an agent's transcript. Filter it before
// the store module (and with it node:sqlite) is loaded - hence the dynamic imports below.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = /** @type {typeof process.emitWarning} */ ((w, ...a) =>
  (/SQLite/i.test(String(typeof w === 'string' ? w : w?.message)) ? undefined : /** @type {any} */ (emitWarning)(w, ...a)));

import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DowserError, LENSES } from './lib/model.mjs';
import { dbPath, projectKey, repoRoot } from './lib/paths.mjs';
import { headSha, originUrl, webUrl } from './lib/git.mjs';

const store = await import('./lib/store.mjs');
const verifyLib = await import('./lib/verify.mjs');
const syncLib = await import('./lib/sync.mjs');
const memory = await import('./lib/memory.mjs');
const reflectLib = await import('./lib/reflect.mjs');
const directionLib = await import('./lib/direction.mjs');
const depsLib = await import('./lib/deps.mjs');

/**
 * @typedef {{_: string[], [flag: string]: string | string[] | true | string[] | undefined}} Args
 * @typedef {{code?: number, out?: unknown, lines?: unknown[]}} Result
 * @typedef {{root: string, open: () => import('./lib/store.mjs').Db, dbFile: () => string}} Ctx
 * @typedef {(a: Args, ctx: Ctx) => Result} Handler
 */

/** Flags that may repeat (collected into an array). */
const REPEATABLE = new Set(['kinds']);

/**
 * Parses argv: positionals in `_`, `--flag value` / `--flag=value`, a flag with no value is `true`.
 * @param {string[]} argv
 * @returns {Args}
 */
export function parseArgs(argv) {
  /** @type {Args} */
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--') || a === '--') { out._.push(a); continue; }
    let key = a.slice(2);
    /** @type {string | true} */
    let val;
    const eq = key.indexOf('=');
    if (eq >= 0) { val = key.slice(eq + 1); key = key.slice(0, eq); } else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) val = true;
      else { val = next; i++; }
    }
    if (REPEATABLE.has(key)) {
      const prev = out[key];
      out[key] = [...(Array.isArray(prev) ? prev : []), String(val)];
    } else out[key] = val;
  }
  return out;
}

/**
 * A string flag's value; `true` (given without a value) or a repeated flag is bad input.
 * @param {Args} a
 * @param {string} k
 * @param {boolean} [required]
 * @returns {string | undefined}
 */
function opt(a, k, required = false) {
  const v = a[k];
  if (v === undefined) {
    if (required) throw new DowserError(`--${k} is required`, 2);
    return undefined;
  }
  if (typeof v !== 'string') throw new DowserError(`--${k} needs a value`, 2);
  return v;
}

/**
 * `--kinds opportunity=gap,friction --kinds doc-drift=stale` -> {opportunity: [...], 'doc-drift': [...]}.
 * @param {Args} a
 * @returns {Record<string, string[]>}
 */
export function parseKinds(a) {
  const raw = a.kinds;
  if (!Array.isArray(raw) || raw.length === 0) throw new DowserError('--kinds <lens>=<k1,k2> is required (one per lens; kinds come from the lens pack frontmatter)', 2);
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const item of raw) {
    for (const part of item.split(';').map((s) => s.trim()).filter(Boolean)) {
      const m = part.match(/^([a-z-]+)=(.+)$/);
      if (!m) throw new DowserError(`--kinds ${JSON.stringify(part)} is not <lens>=<k1,k2>`, 2);
      if (!(/** @type {readonly string[]} */ (LENSES)).includes(m[1])) throw new DowserError(`--kinds: unknown lens ${m[1]}`, 2);
      out[m[1]] = [...new Set([...(out[m[1]] ?? []), ...m[2].split(',').map((s) => s.trim()).filter(Boolean)])];
    }
  }
  return out;
}

/**
 * Reads `--lenses` as inline JSON or `@<file>`.
 * @param {string} v
 * @returns {unknown}
 */
function readJsonArg(v) {
  try {
    return JSON.parse(v.startsWith('@') ? readFileSync(v.slice(1), 'utf8') : v);
  } catch (e) {
    throw new DowserError(`--lenses is not readable JSON (${/** @type {Error} */ (e).message})`, 2);
  }
}

/** @param {'WP2' | 'WP4'} pkg @returns {Handler} */
const notImplemented = (pkg) => () => ({ code: 3, out: { error: 'not-implemented', package: pkg } });

/** @type {Record<string, Handler>} */
export const COMMANDS = {
  init(_a, ctx) {
    const db = ctx.open();
    return { out: store.clean({ db: ctx.dbFile(), project_key: projectKey(ctx.root), verdicts_cursor: syncLib.verdictsCursor(db), repo: ctx.root, user_version: store.USER_VERSION }) };
  },

  run(a, ctx) {
    const sub = a._[1];
    if (sub === 'start') {
      const db = ctx.open();
      const r = store.runStart(db, { mode: /** @type {string} */ (opt(a, 'mode', true)), harness: opt(a, 'harness'), model: opt(a, 'model'), focus: opt(a, 'focus'), headSha: headSha(ctx.root) });
      return { out: store.clean({ run_id: r.id, mode: r.mode, focus: r.focus, base_sha: r.base_sha, head_sha: r.head_sha, db: ctx.dbFile() }) };
    }
    if (sub === 'finish') {
      const db = ctx.open();
      const r = store.runFinish(db, { runId: /** @type {string} */ (opt(a, 'run', true)), lenses: readJsonArg(/** @type {string} */ (opt(a, 'lenses', true))), status: opt(a, 'status') });
      return { out: r };
    }
    throw new DowserError('run start | run finish', 2);
  },

  propose(a, ctx) {
    const runId = /** @type {string} */ (opt(a, 'run', true));
    const file = /** @type {string} */ (opt(a, 'file', true));
    const kinds = parseKinds(a);
    /** @type {string} */
    let text;
    try { text = readFileSync(file, 'utf8'); } catch (e) { throw new DowserError(`--file ${file} is not readable (${/** @type {Error} */ (e).message})`, 2); }
    const db = ctx.open();
    store.requireRunning(db, runId);
    /** @type {unknown[]} */
    const lines = [];
    /** @type {Record<string, number>} */
    const counts = { lines: 0, created: 0, 'evidence-grew': 0, suppressed: 0, duplicate: 0, invalid: 0 };
    text.split(/\r?\n/).forEach((raw, i) => {
      if (!raw.trim()) return;
      counts.lines++;
      /** @type {unknown} */
      let obj;
      try { obj = JSON.parse(raw); } catch (e) {
        counts.invalid++;
        lines.push({ line: i + 1, result: `invalid:json (${/** @type {Error} */ (e).message})` });
        return;
      }
      const r = store.propose(db, runId, obj, { kinds });
      counts[r.result.startsWith('invalid:') ? 'invalid' : r.result]++;
      lines.push({ line: i + 1, ...r });
    });
    lines.push({ summary: counts });
    return { code: counts.invalid > 0 ? 1 : 0, lines };
  },

  verify(a, ctx) {
    const db = ctx.open();
    return { out: verifyLib.verifyRun(db, ctx.root, /** @type {string} */ (opt(a, 'run', true))) };
  },

  move(a, ctx) {
    const fp = a._[1];
    if (!fp) throw new DowserError('move <fp> --to <status> --by <kind:name>', 2);
    const db = ctx.open();
    const row = store.move(db, fp, /** @type {string} */ (opt(a, 'to', true)), {
      from: opt(a, 'from'), by: /** @type {string} */ (opt(a, 'by', true)), reason: opt(a, 'reason'),
      note: opt(a, 'note'), into: opt(a, 'into'), runId: opt(a, 'run'),
    });
    return { out: { fp: row.fp, status: row.status, ...store.clean({ reason: row.reason, note: row.note, merged_into: row.merged_into }), decided_by: row.decided_by, decided_at: row.decided_at } };
  },

  status(a, ctx) {
    const db = ctx.open();
    const n = opt(a, 'runs');
    const runs = n === undefined ? 5 : Number(n);
    if (!Number.isInteger(runs) || runs < 1) throw new DowserError('--runs is a positive integer', 2);
    return { out: { db: ctx.dbFile(), project_key: projectKey(ctx.root), ...store.statusSummary(db, { runs }) } };
  },

  // WP2 - memory and learning
  context(a, ctx) {
    const db = ctx.open();
    return { out: memory.contextPack(db, { runId: /** @type {string} */ (opt(a, 'run', true)), lens: /** @type {string} */ (opt(a, 'lens', true)), focus: opt(a, 'focus') }) };
  },

  similar(a, ctx) {
    const fp = a._[1];
    if (!fp) throw new DowserError('similar <fp>', 2);
    return { out: memory.similar(ctx.open(), fp) };
  },

  show(a, ctx) {
    const fp = a._[1];
    if (!fp) throw new DowserError('show <fp>', 2);
    return { out: memory.show(ctx.open(), fp) };
  },

  list(a, ctx) {
    return { out: memory.list(ctx.open(), { lens: opt(a, 'lens'), status: opt(a, 'status'), title: opt(a, 'title') }) };
  },

  rules(a, ctx) {
    const sub = a._[1];
    if (sub === 'offer') return { out: memory.offerRules(ctx.open()) };
    if (sub === 'list') return { out: memory.listRules(ctx.open(), { lens: opt(a, 'lens') }) };
    if (sub === 'accept' || sub === 'decline') {
      const id = a._[2];
      if (!id) throw new DowserError(`rules ${sub} <id> --by human:<name>`, 2);
      return { out: memory.decideRule(ctx.open(), id, sub === 'accept' ? 'accepted' : 'declined', { by: /** @type {string} */ (opt(a, 'by', true)), text: opt(a, 'text') }) };
    }
    throw new DowserError('rules offer | rules list [--lens l] | rules accept|decline <id> --by human:<name> [--text t]', 2);
  },

  reflect(a, ctx) {
    const sub = a._[1];
    if (sub === 'export') return { out: reflectLib.exportOffers(ctx.open(), projectKey(ctx.root)) };
    if (sub === 'ingest') return reflectLib.ingestReflect(ctx.open(), syncLib.readResponse(/** @type {string} */ (opt(a, 'file', true))));
    throw new DowserError('reflect export | reflect ingest --file <json>', 2);
  },

  prefs(a, ctx) {
    const sub = a._[1];
    if (sub === 'get') return { out: memory.getPrefs(a._.slice(2), ctx.root) };
    if (sub === 'set') return { out: memory.setPrefs(a._.slice(2), ctx.root) };
    throw new DowserError('prefs get [key ...] | prefs set key=value [key=value ...]', 2);
  },
  // WP4 - the Forge seam
  outbox(a, ctx) {
    const origin = originUrl(ctx.root);
    return { out: syncLib.outbox(ctx.open(), { projectKey: projectKey(ctx.root), runId: /** @type {string} */ (opt(a, 'run', true)), repoUrl: origin ? webUrl(origin) : undefined }) };
  },
  'ingest-push'(a, ctx) {
    const doc = syncLib.readResponse(/** @type {string} */ (opt(a, 'file', true)));
    return syncLib.ingestPush(ctx.open(), doc);
  },
  'ingest-verdicts'(a, ctx) {
    const doc = syncLib.readResponse(/** @type {string} */ (opt(a, 'file', true)));
    return syncLib.ingestVerdicts(ctx.open(), doc);
  },
  areas(a, ctx) {
    const topArg = opt(a, 'top');
    const top = topArg === undefined ? undefined : Number(topArg);
    return { out: syncLib.areas(ctx.open(), { root: ctx.root, projectKey: projectKey(ctx.root), runId: /** @type {string} */ (opt(a, 'run', true)), top }) };
  },
  'ingest-sources'(a, ctx) {
    const runId = /** @type {string} */ (opt(a, 'run', true));
    const type = /** @type {string} */ (opt(a, 'type', true));
    const doc = syncLib.readResponse(/** @type {string} */ (opt(a, 'file', true)));
    return syncLib.ingestSources(ctx.open(), { runId, type, doc });
  },
  'ingest-direction'(a, ctx) {
    const runId = /** @type {string} */ (opt(a, 'run', true));
    const doc = syncLib.readResponse(/** @type {string} */ (opt(a, 'file', true)));
    return directionLib.ingestDirection(ctx.open(), { runId, doc });
  },
  deps(a, ctx) {
    return depsLib.runDeps(ctx.open(), { root: ctx.root, runId: /** @type {string} */ (opt(a, 'run', true)) });
  },
};

/**
 * Runs one command. Never exits the process; returns the exit code and what to print.
 * @param {string[]} argv
 * @returns {{code: number, stdout: string, stderr: string}}
 */
export function main(argv) {
  const a = parseArgs(argv);
  const cmd = a._[0];
  if (!cmd || a.help === true) return { code: cmd ? 0 : 2, stdout: HELP, stderr: '' };
  /** @type {import('./lib/store.mjs').Db | undefined} */
  let db;
  try {
    const handler = Object.hasOwn(COMMANDS, cmd) ? COMMANDS[cmd] : undefined;
    if (!handler) throw new DowserError(`unknown command ${JSON.stringify(cmd)} (one of ${Object.keys(COMMANDS).join(', ')})`, 2);
    const repoArg = opt(a, 'repo');
    const root = repoRoot(resolve(repoArg ?? process.cwd()));
    /** @type {string | undefined} */
    let file;
    const dbFile = () => (file ??= dbPath(root));
    const ctx = { root, dbFile, open: () => (db ??= store.openStore(dbFile())) };
    const r = handler(a, ctx);
    const stdout = r.lines ? r.lines.map((l) => JSON.stringify(l)).join('\n') + '\n' : `${JSON.stringify(r.out, null, 2)}\n`;
    return { code: r.code ?? 0, stdout, stderr: '' };
  } catch (e) {
    if (e instanceof DowserError) {
      const detail = e.detail ?? { error: e.code === 3 ? 'unavailable' : 'bad-input' };
      return { code: e.code, stdout: `${JSON.stringify({ ...detail, message: e.message }, null, 2)}\n`, stderr: `dowser: ${e.message}\n` };
    }
    const msg = /** @type {Error} */ (e)?.message ?? String(e);
    return { code: 3, stdout: `${JSON.stringify({ error: 'unavailable', message: msg }, null, 2)}\n`, stderr: `dowser: ${msg}\n` };
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

const HELP = readFileSync(fileURLToPath(import.meta.url), 'utf8')
  .split('\n// Exit codes')[0].replace(/^#!.*\n/, '').replace(/^\/\/ @ts-check\n/, '').replace(/^\/\/ ?/gm, '') +
  '\nExit codes: 0 ok, 1 partial, 2 bad input or refused move, 3 store/connection unavailable or not implemented.\n';

// run as a script: compare real paths, so a skill dir reached through a junction or symlink still runs
if (process.argv[1] && isEntry(process.argv[1], import.meta.url)) {
  const r = main(process.argv.slice(2));
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exitCode = r.code;
}

/** @param {string} argv1 @param {string} url */
function isEntry(argv1, url) {
  try { return realpathSync(resolve(argv1)) === realpathSync(fileURLToPath(url)); } catch { return resolve(argv1) === fileURLToPath(url); }
}
