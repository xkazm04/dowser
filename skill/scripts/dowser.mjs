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
//   context | similar | show | rules       (WP2, not implemented yet: exit 3)
//   outbox | ingest-push | ingest-verdicts | ingest-sources   (WP4, not implemented yet: exit 3)
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
import { headSha } from './lib/git.mjs';

const store = await import('./lib/store.mjs');
const verifyLib = await import('./lib/verify.mjs');

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
    ctx.open();
    return { out: { db: ctx.dbFile(), project_key: projectKey(ctx.root), repo: ctx.root, user_version: store.USER_VERSION } };
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
  context: notImplemented('WP2'),
  similar: notImplemented('WP2'),
  show: notImplemented('WP2'),
  rules: notImplemented('WP2'),
  // WP4 - the Forge seam
  outbox: notImplemented('WP4'),
  'ingest-push': notImplemented('WP4'),
  'ingest-verdicts': notImplemented('WP4'),
  'ingest-sources': notImplemented('WP4'),
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
