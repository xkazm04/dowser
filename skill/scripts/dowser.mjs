#!/usr/bin/env node
// @ts-check
// dowser - the single CLI entry of the Dowser skill. The agent never writes SQL: every store write goes
// through this script. Output is JSON on stdout (one object; JSONL for `propose`); diagnostics go to stderr.
// The store lives at ~/.dowser/projects/<project-key>/dowser.db (DOWSER_HOME overrides); nothing is ever
// written inside the scanned repo.
//
//   node dowser.mjs <command> [sub] [--repo <path>] [flags]   (--repo defaults to the cwd; --help prints every command)
//
// Every command is ONE entry in COMMANDS below: its flags, its positional args, its help text and its handler.
// The dispatcher refuses a flag the entry does not declare (exit 2, naming the command's flags), enforces the
// required ones, and --help is generated from the same entries. A command with subcommands (`run start`) is an
// entry with `subs`, each sub a full entry. Adding a command or a flag is that one edit.
//
// Exit codes: 0 ok; 1 partial - part of the input was invalid, refused or skipped and the rest applied (propose,
// ingest-push, ingest-verdicts, ingest-sources, ingest-direction, reflect ingest); 2 bad input or refused move (stdout carries
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
import { hasCommit, headSha, originUrl, webUrl } from './lib/git.mjs';

const store = await import('./lib/store.mjs');
const verifyLib = await import('./lib/verify.mjs');
const syncLib = await import('./lib/sync.mjs');
const memory = await import('./lib/memory.mjs');
const reflectLib = await import('./lib/reflect.mjs');
const directionLib = await import('./lib/direction.mjs');
const depsLib = await import('./lib/deps.mjs');
const shareLib = await import('./lib/share.mjs');
const trustLib = await import('./lib/trust.mjs');

/**
 * @typedef {{_: string[], [flag: string]: string | string[] | true | string[] | undefined}} Args
 * @typedef {{code?: number, out?: unknown, lines?: unknown[]}} Result
 * @typedef {{root: string, open: () => import('./lib/store.mjs').Db, dbFile: () => string}} Ctx
 * @typedef {(a: Args, ctx: Ctx) => Result | Promise<Result>} Handler
 * @typedef {{arg: string, required?: true, repeat?: true}} Flag
 *   arg: the value placeholder help prints; required: the dispatcher refuses the command without it; repeat: the
 *   flag may be given more than once (its values are collected into an array)
 * @typedef {{flags?: Record<string, Flag>, args?: string, help: string, run: Handler}} Command
 *   args: the positionals help prints after the command (`<fp>`); help: what it does and prints
 * @typedef {{subs: Record<string, Command>}} Group
 * @typedef {Command | Group} Entry
 */

/** Flags every command takes. */
export const GLOBAL_FLAGS = /** @type {Record<string, Flag>} */ ({ repo: { arg: '<path>' }, help: { arg: '' } });

/**
 * Parses argv: positionals in `_`, `--flag value` / `--flag=value`, a flag with no value is `true`. A flag in
 * `repeatable` collects its values into an array; any other repeated flag keeps the last value.
 * @param {string[]} argv
 * @param {ReadonlySet<string>} [repeatable]
 * @returns {Args}
 */
export function parseArgs(argv, repeatable = REPEATABLE) {
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
    if (repeatable.has(key)) {
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

/** A required string flag's value (the dispatcher has already refused a command without it). @param {Args} a @param {string} k */
const req = (a, k) => /** @type {string} */ (opt(a, k, true));

/**
 * The lens kinds a command works with: without `--kinds`, every lens pack's frontmatter kinds (`packKinds`);
 * with `--kinds opportunity=gap-x --kinds doc-drift=stale-y` (or `a=..;b=..`), exactly the lenses named, each
 * list a subset of its pack's kinds - a kind the pack lacks is bad input, named with the pack.
 * @param {Args} a
 * @param {Record<string, string[]>} [packs] the packs' kinds (default: read from skill/lenses/)
 * @returns {Record<string, string[]>}
 */
export function parseKinds(a, packs) {
  const raw = a.kinds;
  const pack = packs ?? memory.packKinds();
  if (raw === undefined) return pack;
  if (!Array.isArray(raw) || raw.length === 0) throw new DowserError('--kinds needs <lens>=<k1,k2>', 2);
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
  for (const [lens, kinds] of Object.entries(out)) {
    const extra = kinds.filter((k) => !(pack[lens] ?? []).includes(k));
    if (extra.length) {
      throw new DowserError(`--kinds ${lens}: ${extra.join(', ')} ${extra.length === 1 ? 'is not a kind' : 'are not kinds'} of lenses/${lens}.md (${(pack[lens] ?? []).join(', ')})`, 2);
    }
  }
  return out;
}

/**
 * A positive-integer flag's value, or undefined when absent.
 * @param {Args} a
 * @param {string} k
 * @returns {number | undefined}
 */
function intOpt(a, k) {
  const v = opt(a, k);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new DowserError(`--${k} is a positive integer`, 2);
  return n;
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

/** @param {'accepted' | 'declined'} verdict @returns {Command} */
const decideRule = (verdict) => ({
  args: '<id>',
  flags: { by: { arg: 'human:<name>', required: true }, text: { arg: '<t>' } },
  help: `${verdict === 'accepted' ? 'accept' : 'decline'} an offered rule (CAS offered -> ${verdict}); --text edits its wording`,
  run(a, ctx) {
    const id = a._[2];
    if (!id) throw new DowserError(`rules ${verdict === 'accepted' ? 'accept' : 'decline'} <id> --by human:<name>`, 2);
    return { out: memory.decideRule(ctx.open(), id, verdict, { by: req(a, 'by'), text: opt(a, 'text') }) };
  },
});

const RUN_FLAG = /** @type {Flag} */ ({ arg: '<id>', required: true });
const FILE_FLAG = /** @type {Flag} */ ({ arg: '<json>', required: true });
const KINDS_FLAG = /** @type {Flag} */ ({ arg: '<lens>=<k1,k2>', repeat: true });

/** Every command: flags, positionals, help and handler in one entry (see the header). @type {Record<string, Entry>} */
export const COMMANDS = {
  init: {
    help: 'create the store -> {db, project_key, verdicts_cursor?, repo, user_version}',
    run(_a, ctx) {
      const db = ctx.open();
      return { out: store.clean({ db: ctx.dbFile(), project_key: projectKey(ctx.root), verdicts_cursor: syncLib.verdictsCursor(db), repo: ctx.root, user_version: store.USER_VERSION }) };
    },
  },

  run: {
    subs: {
      start: {
        flags: { mode: { arg: 'full|incremental|focused', required: true }, harness: { arg: '<h>' }, model: { arg: '<m>' }, focus: { arg: 'goal:..|area:..' } },
        help: '-> {run_id, mode, base_sha?, head_sha?, fallback?, woke?, abandoned?, open_runs?, db} (base_sha = last done run\'s head; ' +
          'incremental with that head gone from history -> full; woke = snoozed fps whose --until date passed, now verified; ' +
          'abandoned = run ids left running over a day, now closed failed; open_runs = run ids still running under a day, left open)',
        run(a, ctx) {
          const db = ctx.open();
          const r = store.runStart(db, { mode: req(a, 'mode'), harness: opt(a, 'harness'), model: opt(a, 'model'), focus: opt(a, 'focus'), headSha: headSha(ctx.root),
            hasCommit: (sha) => hasCommit(ctx.root, sha) });
          return { out: store.clean({ run_id: r.id, mode: r.mode, focus: r.focus, base_sha: r.base_sha, head_sha: r.head_sha, fallback: r.fallback, woke: r.woke, abandoned: r.abandoned, open_runs: r.open_runs, db: ctx.dbFile() }) };
        },
      },
      status: {
        flags: { run: RUN_FLAG },
        help: 'where a run stands, read-only -> {run_id, status, mode, started_at, finished_at?, lenses?, stages: {direction?, ' +
          'sources?, proposed?, not_reached?, verify?: pending | {state: done, verified, dropped}, pretriage?, push?: {pending?, pushed?}}, ' +
          'next: [CLI lines]} (push.pending = what outbox would send now, store-wide; next is [] once the run ended)',
        run(a, ctx) { return { out: store.runProgress(ctx.open(), req(a, 'run')) }; },
      },
      finish: {
        flags: { run: RUN_FLAG, lenses: { arg: '<json | @file>', required: true }, status: { arg: 'done|failed' } },
        help: 'lenses: {<lens>: {state: ran|skipped|partial, reason?, emitted?, verified?, dropped?, truncated?}}',
        run(a, ctx) {
          const db = ctx.open();
          return { out: store.runFinish(db, { runId: req(a, 'run'), lenses: readJsonArg(req(a, 'lenses')), status: opt(a, 'status') }) };
        },
      },
    },
  },

  propose: {
    flags: { run: RUN_FLAG, file: { arg: '<jsonl>', required: true }, kinds: KINDS_FLAG },
    help: 'JSONL out, one line per input line: {line, result, fp?, ...} where result is created | evidence-grew | suppressed | ' +
      'duplicate | invalid:<why>; a line without predicted_verdict adds warning: no-predicted-verdict; a category the lens may ' +
      'not set (product lens -> technical) is stored as the lens default and adds clamped: {category: {asked, stored}}; then one ' +
      '{summary} line (unpredicted: n, clamped: n when any). A kind is checked against the lens pack\'s frontmatter kinds; ' +
      '--kinds narrows to the lenses and kinds named (each one of its pack\'s kinds)',
    run(a, ctx) {
      const runId = req(a, 'run');
      const file = req(a, 'file');
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
      let unpredicted = 0;
      let clamped = 0;
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
        if (r.warning === 'no-predicted-verdict') unpredicted++;
        if (r.clamped) clamped++;
        lines.push({ line: i + 1, ...r });
      });
      lines.push({ summary: { ...counts, ...(unpredicted ? { unpredicted } : {}), ...(clamped ? { clamped } : {}) } });
      return { code: counts.invalid > 0 ? 1 : 0, lines };
    },
  },

  verify: {
    flags: { run: RUN_FLAG, 'per-lens': { arg: '<n>' }, 'per-run': { arg: '<n>' } },
    help: 're-check code/doc quotes -> verified | dropped (verify-failed:<ref>); a ticket/page/goal/dep ref this run did not ' +
      'ingest -> dropped (ref-not-ingested:<type>:<ref>); each check gives the line the quote was found on (claimed_line when the ' +
      'hint differs, drift when > 3 lines); bus_factor measured from git (anchor paths, 90 days before head); per_lens {emitted, ' +
      'verified, dropped}; then allocate the verified cards: each lens\'s MVP, then by score up to the pack budget (4) per lens, ' +
      'then free run slots (16 per run) to the best reserve of any lens -> band ranked; the rest band reserve (stored, pushed) -> allocation',
    run(a, ctx) {
      const db = ctx.open();
      return { out: verifyLib.verifyRun(db, ctx.root, req(a, 'run'), { perLens: intOpt(a, 'per-lens'), perRun: intOpt(a, 'per-run') }) };
    },
  },

  pretriage: {
    flags: { run: RUN_FLAG },
    help: 'the L1 gate: mark verified ranked cards predicted `accept` in slices at trust level 1 pretriaged_by machine:dowser -> {pretriaged, for_person}',
    run(a, ctx) { return { out: trustLib.pretriageRun(ctx.open(), req(a, 'run')) }; },
  },

  trust: {
    flags: { slice: { arg: '<key>' } },
    help: 'per-slice trust -> {slices: [{slice, level, ceiling, start, n, agreement?, changed_at?, reason?}], events: [...]} ' +
      '(append-only events); every slice with history or with a card, a new one at its start level',
    run(a, ctx) { return { out: trustLib.trustReport(ctx.open(), { slice: opt(a, 'slice') }) }; },
  },

  move: {
    args: '<fp>',
    flags: {
      to: { arg: '<status>', required: true }, by: { arg: '<kind:name>', required: true }, from: { arg: '<s>' }, reason: { arg: '<code>' },
      note: { arg: '<t>' }, into: { arg: '<fp>' }, run: { arg: '<id>' }, until: { arg: 'YYYY-MM-DD' },
    },
    help: 'a compare-and-set status move; --until only with --to snoozed, a date after today',
    run(a, ctx) {
      const fp = a._[1];
      if (!fp) throw new DowserError('move <fp> --to <status> --by <kind:name>', 2);
      const db = ctx.open();
      const row = store.move(db, fp, req(a, 'to'), {
        from: opt(a, 'from'), by: req(a, 'by'), reason: opt(a, 'reason'),
        note: opt(a, 'note'), into: opt(a, 'into'), runId: opt(a, 'run'), until: opt(a, 'until'),
      });
      const events = trustLib.syncTrust(db);
      return { out: { fp: row.fp, status: row.status, ...store.clean({ reason: row.reason, note: row.note, merged_into: row.merged_into, snooze_until: row.snooze_until }), decided_by: row.decided_by, decided_at: row.decided_at, ...(events.length ? { trust_events: events } : {}) } };
    },
  },

  status: {
    flags: { runs: { arg: '<n>' } },
    help: 'counts by status and lens, last runs (default 5), "top N of M" truncation, open?: [{run_id, started_at, next}] (runs still running)',
    run(a, ctx) {
      const db = ctx.open();
      const n = opt(a, 'runs');
      const runs = n === undefined ? 5 : Number(n);
      if (!Number.isInteger(runs) || runs < 1) throw new DowserError('--runs is a positive integer', 2);
      return { out: { db: ctx.dbFile(), project_key: projectKey(ctx.root), ...store.statusSummary(db, { runs }) } };
    },
  },

  // WP2 - memory and learning
  context: {
    flags: { run: RUN_FLAG, lens: { arg: '<l>', required: true }, focus: { arg: '<f>' } },
    help: '-> {lens, lens_version, kinds, budget, suppressed, near (open and held-back items, then up to 20 accepted ones, each ' +
      'with fp, topic, anchors), rules, exemplars, outcomes?: {right, partly, wrong}, since_sha?, focus?, direction?}',
    run(a, ctx) {
      const db = ctx.open();
      return { out: memory.contextPack(db, { runId: req(a, 'run'), lens: req(a, 'lens'), focus: opt(a, 'focus') }) };
    },
  },

  similar: {
    args: '<fp>',
    help: 'same-lens items sharing an anchor or 2+ topic tokens (generic words such as docs, md, lens ignored), and other-lens ' +
      'items sharing a SYMBOL anchor path#symbol (cross_lens: true; a shared whole file never counts), with the overlap',
    run(a, ctx) {
      const fp = a._[1];
      if (!fp) throw new DowserError('similar <fp>', 2);
      return { out: memory.similar(ctx.open(), fp) };
    },
  },

  show: {
    args: '<fp>',
    help: 'ask-why: the card, every evidence row, every transition (no rescan)',
    run(a, ctx) {
      const fp = a._[1];
      if (!fp) throw new DowserError('show <fp>', 2);
      return { out: memory.show(ctx.open(), fp) };
    },
  },

  list: {
    flags: { lens: { arg: '<l>' }, status: { arg: '<s>' }, title: { arg: '<substring>' } },
    help: '-> {proposals: [{fp, lens, status, title, decided_at?, snooze_until?}]}',
    run(a, ctx) {
      const db = ctx.open();
      const out = memory.list(db, { lens: opt(a, 'lens'), status: opt(a, 'status'), title: opt(a, 'title') });
      return { out: { ...out, proposals: store.withSnoozeUntil(db, out.proposals) } };
    },
  },

  rules: {
    subs: {
      offer: { help: 'offer a rule for every (lens, reason, token) rejected 3+ times', run: (_a, ctx) => ({ out: memory.offerRules(ctx.open()) }) },
      list: { flags: { lens: { arg: '<l>' } }, help: 'the rules and their states', run: (a, ctx) => ({ out: memory.listRules(ctx.open(), { lens: opt(a, 'lens') }) }) },
      accept: decideRule('accepted'),
      decline: decideRule('declined'),
    },
  },

  reflect: {
    subs: {
      export: {
        help: '-> {project_key, rules_json?, trust_json?, more?}: the dowser_reflect_sync arguments (rules in state `offered`, oldest ' +
          'first, at most 50, and the per-slice trust with its newest 50 events; read-only; run `rules offer` first)',
        run: (_a, ctx) => ({ out: reflectLib.exportOffers(ctx.open(), projectKey(ctx.root)) }),
      },
      ingest: {
        flags: { file: FILE_FLAG },
        help: 'apply a dowser_reflect_sync response: each rule Forge decided is a CAS offered -> accepted|declined (others skipped), ' +
          'each outcome an append-only row -> {rules_applied, rules_skipped, outcomes_added, outcomes_seen}; idempotent',
        run: (a, ctx) => reflectLib.ingestReflect(ctx.open(), syncLib.readResponse(req(a, 'file'))),
      },
    },
  },

  prefs: {
    subs: {
      get: { args: '[key ...]', help: '~/.dowser/user.json (mode dev|guided, verbosity short|full, quotes send|omit)', run: (a, ctx) => ({ out: memory.getPrefs(a._.slice(2), ctx.root) }) },
      set: { args: 'key=value ...', help: 'set preferences in ~/.dowser/user.json', run: (a, ctx) => ({ out: memory.setPrefs(a._.slice(2), ctx.root) }) },
    },
  },

  // WP4 - the Forge seam
  outbox: {
    flags: { run: RUN_FLAG, kinds: KINDS_FLAG },
    help: '-> {project_key, run_id, proposals_json, repo_url?, head_sha?, lens_kinds_json?, more?}: the dowser_proposals_push ' +
      'arguments (verified, not pushed yet; pushed items whose evidence grew), at most 50; `more: true` = run it again. ' +
      'lens_kinds_json carries the lens packs\' kinds (narrowed to the lenses sent; --kinds as at propose), so Forge refuses a kind its lens lacks',
    run(a, ctx) {
      const origin = originUrl(ctx.root);
      const quotes = memory.readPrefs(ctx.root).quotes === 'omit' ? 'omit' : 'send';
      return { out: syncLib.outbox(ctx.open(), { projectKey: projectKey(ctx.root), runId: req(a, 'run'), repoUrl: origin ? webUrl(origin) : undefined, quotes, lensKinds: parseKinds(a) }) };
    },
  },
  'ingest-push': {
    flags: { file: FILE_FLAG },
    help: 'apply a dowser_proposals_push response -> pushed | merged | refused',
    run: (a, ctx) => syncLib.ingestPush(ctx.open(), syncLib.readResponse(req(a, 'file'))),
  },
  'ingest-verdicts': {
    flags: { file: FILE_FLAG },
    help: 'apply a dowser_verdicts_pull response (CAS, idempotent), keep cursor; an accepted verdict records issue_ref/issue_url',
    run: (a, ctx) => syncLib.ingestVerdicts(ctx.open(), syncLib.readResponse(req(a, 'file'))),
  },
  areas: {
    flags: { run: RUN_FLAG, top: { arg: '<n>' } },
    help: '-> {project_key, run_id, areas_json}: the dowser_areas_push arguments (directories at depth 1-2: files, churn_90d, ' +
      'authors_90d?, last_change?; --top defaults to 40)',
    run(a, ctx) {
      const topArg = opt(a, 'top');
      const top = topArg === undefined ? undefined : Number(topArg);
      return { out: syncLib.areas(ctx.open(), { root: ctx.root, projectKey: projectKey(ctx.root), runId: req(a, 'run'), top }) };
    },
  },
  'ingest-sources': {
    flags: { run: RUN_FLAG, type: { arg: 'ticket|page|goal', required: true }, file: FILE_FLAG },
    help: 'cache a dowser_sources_* response -> refs (contract: docs/contracts/forge-mcp-2.md; the agent calls the tools)',
    run: (a, ctx) => syncLib.ingestSources(ctx.open(), { runId: req(a, 'run'), type: req(a, 'type'), doc: syncLib.readResponse(req(a, 'file')) }),
  },
  'ingest-direction': {
    flags: { run: RUN_FLAG, file: FILE_FLAG },
    help: 'cache a dowser_direction_get response on the run; context --lens then carries that lens\'s direction',
    run: (a, ctx) => directionLib.ingestDirection(ctx.open(), { runId: req(a, 'run'), doc: syncLib.readResponse(req(a, 'file')) }),
  },
  deps: {
    flags: { run: RUN_FLAG },
    help: 'run the dependency auditors present (read-only), cache their findings as dep items -> {auditors: [{tool, dir?, state, ' +
      'reason?, found?}], refs, not_audited?}',
    run: (a, ctx) => depsLib.runDeps(ctx.open(), { root: ctx.root, runId: req(a, 'run') }),
  },

  share: {
    flags: { run: RUN_FLAG },
    help: 'the run\'s kept proposals as markdown, evidence by ref only (read-only) -> {run_id, cards, markdown}',
    run(a, ctx) { return { out: shareLib.shareRun(ctx.open(), req(a, 'run')) }; },
  },
};

/** Flags that may repeat, from the spec. */
const REPEATABLE = new Set(Object.values(COMMANDS).flatMap((e) => ('subs' in e ? Object.values(e.subs) : [e]))
  .flatMap((c) => Object.entries(c.flags ?? {}).filter(([, f]) => f.repeat).map(([k]) => k)));

/**
 * Resolves the command (and subcommand) argv names, then checks its flags against the spec: an undeclared flag or a
 * missing required one is bad input (exit 2).
 * @param {Args} a
 * @param {Record<string, Entry>} [commands]
 * @returns {{path: string, command: Command}}
 */
export function resolveCommand(a, commands = COMMANDS) {
  const cmd = a._[0];
  const entry = Object.hasOwn(commands, cmd) ? commands[cmd] : undefined;
  if (!entry) throw new DowserError(`unknown command ${JSON.stringify(cmd)} (one of ${Object.keys(commands).join(', ')})`, 2);
  /** @type {Command} */
  let command;
  let path = cmd;
  if ('subs' in entry) {
    const sub = a._[1];
    if (!sub || !Object.hasOwn(entry.subs, sub)) throw new DowserError(Object.entries(entry.subs).map(([s, c]) => usage(`${cmd} ${s}`, c)).join(' | '), 2);
    command = entry.subs[sub];
    path = `${cmd} ${sub}`;
  } else command = entry;
  const flags = command.flags ?? {};
  for (const k of Object.keys(a)) {
    if (k === '_' || Object.hasOwn(GLOBAL_FLAGS, k) || Object.hasOwn(flags, k)) continue;
    const accepted = [...Object.keys(flags), ...Object.keys(GLOBAL_FLAGS).filter((g) => g !== 'help')].map((f) => `--${f}`).join(', ');
    throw new DowserError(`unknown flag --${k} for ${path} (accepted: ${accepted})`, 2);
  }
  for (const [k, f] of Object.entries(flags)) if (f.required && a[k] === undefined) throw new DowserError(`--${k} is required`, 2);
  return { path, command };
}

/** One command's usage line: `propose --run <id> --file <jsonl> [--kinds <lens>=<k1,k2> ...]`. @param {string} path @param {Command} c */
function usage(path, c) {
  const flags = Object.entries(c.flags ?? {}).map(([k, f]) => {
    const s = `--${k}${f.arg ? ` ${f.arg}` : ''}${f.repeat ? ' ...' : ''}`;
    return f.required ? s : `[${s}]`;
  });
  return [path, ...(c.args ? [c.args] : []), ...flags].join(' ');
}

/** @param {string} text @param {string} indent @param {number} width */
function wrap(text, indent, width) {
  /** @type {string[]} */
  const lines = [];
  let line = '';
  for (const w of text.split(/\s+/)) {
    if (line && indent.length + line.length + 1 + w.length > width) { lines.push(indent + line); line = w; } else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(indent + line);
  return lines.join('\n');
}

/**
 * The --help text, generated from the command spec.
 * @param {Record<string, Entry>} [commands]
 * @returns {string}
 */
export function helpText(commands = COMMANDS) {
  const out = ['dowser - the single CLI of the Dowser skill. JSON on stdout (JSONL for propose), diagnostics on stderr.',
    'The store lives at ~/.dowser/projects/<project-key>/dowser.db (DOWSER_HOME overrides); nothing is written in the repo.', '',
    '  node dowser.mjs <command> [sub] [--repo <path>] [flags]   (--repo defaults to the cwd)', ''];
  for (const [name, e] of Object.entries(commands)) {
    for (const [path, c] of 'subs' in e ? Object.entries(e.subs).map(([s, c]) => /** @type {[string, Command]} */ ([`${name} ${s}`, c])) : [/** @type {[string, Command]} */ ([name, e])]) {
      out.push(wrap(usage(path, c), '  ', 118), wrap(c.help, '      ', 118));
    }
  }
  out.push('', 'Exit codes: 0 ok, 1 partial, 2 bad input or refused move, 3 store/connection unavailable or not implemented.', '');
  return out.join('\n');
}

/**
 * Runs one command. Never exits the process; returns the exit code and what to print.
 * @param {string[]} argv
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
export async function main(argv) {
  const a = parseArgs(argv);
  const cmd = a._[0];
  if (!cmd || a.help === true) return { code: cmd ? 0 : 2, stdout: helpText(), stderr: '' };
  /** @type {import('./lib/store.mjs').Db | undefined} */
  let db;
  try {
    const { command } = resolveCommand(a);
    const repoArg = opt(a, 'repo');
    const root = repoRoot(resolve(repoArg ?? process.cwd()));
    /** @type {string | undefined} */
    let file;
    const dbFile = () => (file ??= dbPath(root));
    const ctx = { root, dbFile, open: () => (db ??= store.openStore(dbFile())) };
    // a handler may be async (deps); awaiting inside the try keeps its rejection on the same error path
    const r = await command.run(a, ctx);
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

// run as a script: compare real paths, so a skill dir reached through a junction or symlink still runs
if (process.argv[1] && isEntry(process.argv[1], import.meta.url)) {
  const r = await main(process.argv.slice(2));
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exitCode = r.code;
}

/** @param {string} argv1 @param {string} url */
function isEntry(argv1, url) {
  try { return realpathSync(resolve(argv1)) === realpathSync(fileURLToPath(url)); } catch { return resolve(argv1) === fileURLToPath(url); }
}
