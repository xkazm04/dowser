// @ts-check
// The Dowser store's runs: runStart (which wakes due snoozes), checkLenses, runFinish, and the status summary
// (truncationNote, statusSummary). Imports store-core.mjs and proposals.mjs.
import { DowserError, LENSES, LENS_STATES, RUN_MODES, isOneOf } from './model.mjs';
import { clean, getRun, lastDoneRun, localDate, newRunId, now, sql, tx } from './store-core.mjs';
import { wakeSnoozed } from './proposals.mjs';
import { allocationOf } from './budget.mjs';

/** @import { Db, Row, LensRecord } from './store-core.mjs' */

// ------------------------------------------------------------------------------------------------ runs

/**
 * Starts a run. `base_sha` is the last done run's `head_sha` (absent on a first run). An incremental run whose
 * base is no longer in the repository's history (`hasCommit` says so) starts as `full` instead, without a base,
 * and the returned row carries `fallback` saying why: a diff against a missing commit cannot be taken.
 * In the same transaction it wakes every snoozed item whose `snooze_until` is on or before `today` (the local
 * date; see wakeSnoozed); the returned row carries `woke: [fp, ...]` when any woke. It also closes runs left
 * `running` for more than ABANDONED_AFTER_MS (an interrupted scan never calls `run finish`) as `failed`, so their
 * fetched ticket, page and goal text is dropped like a finished run's; the row lists them as `abandoned`.
 * @param {Db} db
 * @param {{mode: string, harness?: string, model?: string, focus?: string, headSha?: string, hasCommit?: (sha: string) => boolean, today?: string}} o
 * @returns {Row}
 */
export function runStart(db, { mode, harness, model, focus, headSha, hasCommit, today = localDate() }) {
  if (!isOneOf(RUN_MODES, mode)) throw new DowserError(`--mode must be one of ${RUN_MODES.join('|')}`, 2);
  if (mode === 'focused' && !focus) throw new DowserError('a focused run needs --focus goal:<...> or area:<...>', 2);
  if (focus !== undefined && !/^(goal|area):\S/.test(focus)) throw new DowserError('--focus is goal:<...> or area:<...>', 2);
  if (focus !== undefined && mode !== 'focused') throw new DowserError('--focus goes with --mode focused', 2);
  return tx(db, () => {
    const abandoned = closeAbandoned(db);
    const base = lastDoneRun(db);
    const lost = mode === 'incremental' && base?.head_sha && hasCommit ? !hasCommit(base.head_sha) : false;
    const id = newRunId();
    db.prepare(`INSERT INTO runs (id, started_at, head_sha, base_sha, mode, focus, harness, model, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running')`)
      .run(id, now(), sql(headSha), lost ? null : sql(base?.head_sha), lost ? 'full' : mode, sql(focus), sql(harness), sql(model));
    const row = /** @type {Row} */ (getRun(db, id));
    const woke = wakeSnoozed(db, { today, runId: id });
    return /** @type {Row} */ (clean({ ...row, fallback: lost ? `base ${base?.head_sha} is not in this history; started a full run` : undefined,
      woke: woke.length ? woke : undefined, abandoned: abandoned.length ? abandoned : undefined }));
  });
}

/** A run still `running` after this long was interrupted: a scan takes minutes, not a day. */
export const ABANDONED_AFTER_MS = 24 * 3_600_000;

/**
 * Closes interrupted runs (`running`, started more than ABANDONED_AFTER_MS ago) as `failed` and drops the source
 * text no run uses any more. A run started within the window is left alone: it may be a live scan elsewhere.
 * @param {Db} db
 * @returns {string[]} the run ids it closed
 */
function closeAbandoned(db) {
  const cutoff = new Date(Date.now() - ABANDONED_AFTER_MS).toISOString();
  const ids = /** @type {{id: string}[]} */ (db.prepare("UPDATE runs SET status = 'failed', finished_at = ? WHERE status = 'running' AND started_at < ? RETURNING id")
    .all(now(), cutoff)).map((r) => String(r.id));
  if (ids.length) dropSourceText(db);
  return ids.sort();
}

/**
 * Ticket, page and goal text is the team's, fetched for one run only: once no run is using it, keep the ref, title
 * and url a card cites and drop the body (also for runs that ended before this rule existed).
 * @param {Db} db
 */
function dropSourceText(db) {
  db.prepare(`UPDATE sources_cache SET body = NULL WHERE body IS NOT NULL AND type IN ('ticket', 'page', 'goal')
    AND run_id IN (SELECT id FROM runs WHERE status <> 'running')`).run();
}

/**
 * Validates a run's per-lens record: `{<lens>: {state: ran|skipped|partial, reason?, emitted?, verified?,
 * dropped?, truncated?}}`. skipped/partial need a reason; counts are integers >= 0 (omit when unmeasured).
 * @param {unknown} lenses
 * @returns {Record<string, LensRecord>}
 */
export function checkLenses(lenses) {
  if (!lenses || typeof lenses !== 'object' || Array.isArray(lenses)) throw new DowserError('--lenses is a JSON object {<lens>: {state, ...}}', 2);
  for (const [lens, rec] of Object.entries(lenses)) {
    if (!isOneOf(LENSES, lens)) throw new DowserError(`--lenses: unknown lens ${lens}`, 2);
    if (!rec || typeof rec !== 'object') throw new DowserError(`--lenses.${lens} is an object`, 2);
    const r = /** @type {Row} */ (rec);
    const extra = Object.keys(r).find((k) => !['state', 'reason', 'emitted', 'verified', 'dropped', 'truncated'].includes(k));
    if (extra) throw new DowserError(`--lenses.${lens}: unknown field ${extra}`, 2);
    if (!isOneOf(LENS_STATES, r.state)) throw new DowserError(`--lenses.${lens}.state must be one of ${LENS_STATES.join('|')}`, 2);
    if (r.state !== 'ran' && !(typeof r.reason === 'string' && r.reason.trim())) throw new DowserError(`--lenses.${lens}: a ${r.state} lens needs a reason`, 2);
    for (const k of ['emitted', 'verified', 'dropped', 'truncated']) {
      if (r[k] !== undefined && !(Number.isInteger(r[k]) && r[k] >= 0)) throw new DowserError(`--lenses.${lens}.${k} must be an integer >= 0 (omit when unmeasured)`, 2);
    }
  }
  return /** @type {Record<string, LensRecord>} */ (lenses);
}

/**
 * Finishes a running run (CAS running -> done|failed) with its per-lens record, and drops the cached ticket,
 * page and goal bodies of every run that is no longer running (refs, titles and urls stay).
 * @param {Db} db
 * @param {{runId: string, lenses: unknown, status?: string}} o
 * @returns {Row}
 */
export function runFinish(db, { runId, lenses, status = 'done' }) {
  if (status !== 'done' && status !== 'failed') throw new DowserError('--status must be done|failed', 2);
  const rec = checkLenses(lenses);
  // the store's own slot allocation (budget.mjs) overrides what the agent counted: ranked and reserve per lens, and
  // the reserve titles, so the summary's "top N of M" names what was held back
  const alloc = allocationOf(db, runId);
  for (const [lens, a] of Object.entries(alloc)) {
    const r = /** @type {Row} */ (rec[lens] ??= { state: 'ran' });
    r.ranked = a.ranked;
    r.reserve = a.reserve;
    if (a.reserve_titles) r.reserve_titles = a.reserve_titles;
  }
  return tx(db, () => {
    const r = db.prepare("UPDATE runs SET status = ?, finished_at = ?, lenses_json = ? WHERE id = ? AND status = 'running' RETURNING id")
      .get(status, now(), JSON.stringify(rec), runId);
    if (!r) {
      const cur = getRun(db, runId);
      throw new DowserError(cur ? `run ${runId} is ${cur.status}, not running` : `run ${runId} does not exist`, 2,
        { error: 'refused', run: runId, current: cur ? cur.status : 'not-found' });
    }
    dropSourceText(db);
    return /** @type {Row} */ (getRun(db, runId));
  });
}

// ------------------------------------------------------------------------------------------------ status

/**
 * "top N of M" for a lens record with cards in reserve (N = ranked, M = ranked + reserve: the store's allocation),
 * or, on a record written before the budget moved into code, with truncated > 0 (N = emitted, M = emitted +
 * truncated); else undefined.
 * @param {LensRecord} rec
 * @returns {string | undefined}
 */
export function truncationNote(rec) {
  if (rec.reserve) return `top ${rec.ranked ?? 0} of ${(rec.ranked ?? 0) + rec.reserve}`;
  if (!rec.truncated) return undefined;
  const n = rec.emitted ?? 0;
  return `top ${n} of ${n + rec.truncated}`;
}

/**
 * Counts by status and by lens, and the last runs with their per-lens state.
 * @param {Db} db
 * @param {{runs?: number}} [o]
 * @returns {Row}
 */
export function statusSummary(db, { runs = 5 } = {}) {
  /** @type {Record<string, number>} */
  const byStatus = {};
  /** @type {Record<string, Record<string, number>>} */
  const byLens = {};
  let total = 0;
  for (const r of /** @type {Row[]} */ (db.prepare('SELECT lens, status, COUNT(*) AS n FROM proposals GROUP BY lens, status ORDER BY lens, status').all())) {
    const n = Number(r.n);
    total += n;
    byStatus[r.status] = (byStatus[r.status] ?? 0) + n;
    (byLens[r.lens] ??= {})[r.status] = n;
  }
  /** @type {string[]} */
  const truncation = [];
  const last = /** @type {Row[]} */ (db.prepare('SELECT id FROM runs ORDER BY started_at DESC, id DESC LIMIT ?').all(runs)).map((r) => {
    const run = /** @type {Row} */ (getRun(db, String(r.id)));
    if (run.lenses) {
      for (const [lens, rec] of Object.entries(/** @type {Record<string, LensRecord>} */ (run.lenses))) {
        const t = truncationNote(rec);
        if (t) { /** @type {Row} */ (rec).shown = t; truncation.push(`${run.id} ${lens}: ${t}`); }
      }
    }
    return run;
  });
  return clean({ proposals: total, by_status: byStatus, by_lens: byLens, runs: last, truncation: truncation.length ? truncation : undefined }) ?? {};
}
