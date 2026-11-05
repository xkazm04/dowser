// @ts-check
// The Dowser store's runs: runStart (which wakes due snoozes), checkLenses, runFinish, and the status summary
// (truncationNote, statusSummary) and where a run stands (runProgress, openRuns). Imports store-core.mjs and
// proposals.mjs.
import { DowserError, LENSES, LENS_STATES, RUN_MODES, isOneOf } from './model.mjs';
import { clean, getRun, lastDoneRun, localDate, newRunId, now, sql, tx } from './store-core.mjs';
import { checkedEvidenceOf, wakeSnoozed } from './proposals.mjs';
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
 * fetched ticket, page and goal text is dropped like a finished run's; the row lists them as `abandoned`. Runs
 * still `running` inside that window are left open, neither closed nor refused (one may be live elsewhere, or be
 * resumed with `run status`); the row lists them as `open_runs`.
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
    const open = openRunIds(db);
    const base = lastDoneRun(db);
    const lost = mode === 'incremental' && base?.head_sha && hasCommit ? !hasCommit(base.head_sha) : false;
    const id = newRunId();
    db.prepare(`INSERT INTO runs (id, started_at, head_sha, base_sha, mode, focus, harness, model, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running')`)
      .run(id, now(), sql(headSha), lost ? null : sql(base?.head_sha), lost ? 'full' : mode, sql(focus), sql(harness), sql(model));
    const row = /** @type {Row} */ (getRun(db, id));
    const woke = wakeSnoozed(db, { today, runId: id });
    return /** @type {Row} */ (clean({ ...row, fallback: lost ? `base ${base?.head_sha} is not in this history; started a full run` : undefined,
      woke: woke.length ? woke : undefined, abandoned: abandoned.length ? abandoned : undefined, open_runs: open.length ? open : undefined }));
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
  const open = openRuns(db);
  return clean({ proposals: total, by_status: byStatus, by_lens: byLens, runs: last, truncation: truncation.length ? truncation : undefined,
    open: open.length ? open : undefined }) ?? {};
}

// ------------------------------------------------------------------------------------------------ run progress

/** @param {Db} db @returns {string[]} the ids of runs still `running`, oldest first */
function openRunIds(db) {
  return /** @type {Row[]} */ (db.prepare("SELECT id FROM runs WHERE status = 'running' ORDER BY started_at, id").all()).map((r) => String(r.id));
}

/**
 * Every run still `running`, oldest first, with the next command of each: `[{run_id, started_at, next}]`. Read-only.
 * @param {Db} db
 * @returns {Row[]}
 */
export function openRuns(db) {
  return openRunIds(db).map((id) => {
    const p = runProgress(db, id);
    return { run_id: id, started_at: p.started_at, next: p.next };
  });
}

/**
 * How many cards `outbox` would send now: every `verified` card, and every `pushed` card whose evidence grew since
 * its last push. Store-wide, like the outbox (not per run). Mirrors sync.mjs outbox's selection and its pushedSeq
 * (sync_state `push_seq:<fp>`, else the seq of the fp's last `pushed` transition) without its 50-record page and
 * without writing `outbox:last`, and the same sendable evidence (store.checkedEvidenceOf); run-status.test.mjs pins the two equal.
 * @param {Db} db
 * @returns {number}
 */
function pushPending(db) {
  const state = db.prepare('SELECT value FROM sync_state WHERE key = ?');
  const pushedT = db.prepare("SELECT evidence_seq FROM transitions WHERE fp = ? AND to_status = 'pushed' ORDER BY id DESC LIMIT 1");
  let n = 0;
  for (const r of /** @type {Row[]} */ (db.prepare("SELECT fp, status FROM proposals WHERE status IN ('verified', 'pushed')").all())) {
    const fp = String(r.fp);
    if (r.status === 'pushed') {
      const s = /** @type {Row | undefined} */ (state.get(`push_seq:${fp}`));
      const t = s ? undefined : /** @type {Row | undefined} */ (pushedT.get(fp));
      const last = s ? Number(s.value) : t ? Number(t.evidence_seq) : undefined;
      const sendable = checkedEvidenceOf(db, fp).reduce((m, e) => Math.max(m, Number(e.id)), 0);
      if (last !== undefined && sendable <= last) continue;
    }
    n++;
  }
  return n;
}

/**
 * Where run `runId` stands, from the store alone (read-only): `{run_id, status, mode, focus?, started_at,
 * finished_at?, head_sha?, lenses?, stages, next}`.
 *  - stages.direction: the lenses the run cached a direction for; stages.sources: `{<type>: n}` per cached type;
 *  - stages.proposed: `{<lens>: n}` cards the run proposed or re-proposed; stages.not_reached: the other lenses,
 *    in LENSES order (a running run with at least one lens proposed);
 *  - stages.verify: `pending` while a card of the run is still `candidate`, else `{state: done, verified, dropped}`
 *    (the run's verify moves);
 *  - stages.pretriage: `{pretriaged: n}` cards of the run marked by `pretriage`;
 *  - stages.push: `{pending?, pushed?}`: pending is exactly what `outbox` would send now (store-wide), pushed the
 *    run's cards that reached `pushed`.
 * A stage not reached is omitted, never 0. `next` holds literal CLI lines for a running run (`[]` once it ended).
 * An unknown run is bad input (exit 2).
 * @param {Db} db
 * @param {string} runId
 * @returns {Row}
 */
export function runProgress(db, runId) {
  const run = getRun(db, runId);
  if (!run) throw new DowserError(`run ${runId} does not exist`, 2);
  /** @type {(l: string) => number} */
  const order = (l) => LENSES.indexOf(/** @type {any} */ (l));
  /** @type {Row} */
  const stages = {};
  const direction = /** @type {Row[]} */ (db.prepare("SELECT ref FROM sources_cache WHERE run_id = ? AND type = 'direction'").all(runId))
    .map((r) => String(r.ref)).sort((a, b) => order(a) - order(b));
  if (direction.length) stages.direction = direction;
  /** @type {Record<string, number>} */
  const sources = {};
  for (const r of /** @type {Row[]} */ (db.prepare("SELECT type, COUNT(*) AS n FROM sources_cache WHERE run_id = ? AND type <> 'direction' GROUP BY type ORDER BY type").all(runId))) {
    sources[String(r.type)] = Number(r.n);
  }
  if (Object.keys(sources).length) stages.sources = sources;
  /** @type {Record<string, number>} */
  const proposed = {};
  for (const r of /** @type {Row[]} */ (db.prepare('SELECT lens, COUNT(*) AS n FROM proposals WHERE last_run_id = ? GROUP BY lens').all(runId))) {
    proposed[String(r.lens)] = Number(r.n);
  }
  const reached = LENSES.filter((l) => proposed[l]);
  if (reached.length) stages.proposed = Object.fromEntries(reached.map((l) => [l, proposed[l]]));
  const running = run.status === 'running';
  const notReached = LENSES.filter((l) => !proposed[l]);
  if (running && reached.length && notReached.length) stages.not_reached = notReached;
  const candidates = Number(/** @type {Row} */ (db.prepare("SELECT COUNT(*) AS n FROM proposals WHERE last_run_id = ? AND status = 'candidate'").get(runId)).n);
  /** @type {Record<string, number>} */
  const checked = {};
  for (const r of /** @type {Row[]} */ (db.prepare(`SELECT to_status, COUNT(DISTINCT fp) AS n FROM transitions
    WHERE run_id = ? AND from_status = 'candidate' AND to_status IN ('verified', 'dropped') GROUP BY to_status`).all(runId))) {
    checked[String(r.to_status)] = Number(r.n);
  }
  if (candidates > 0) stages.verify = 'pending';
  else if (Object.keys(checked).length) stages.verify = { state: 'done', verified: checked.verified ?? 0, dropped: checked.dropped ?? 0 };
  const marked = Number(/** @type {Row} */ (db.prepare('SELECT COUNT(*) AS n FROM proposals WHERE last_run_id = ? AND pretriaged_by IS NOT NULL').get(runId)).n);
  if (marked) stages.pretriage = { pretriaged: marked };
  const pending = pushPending(db);
  const pushed = Number(/** @type {Row} */ (db.prepare(`SELECT COUNT(*) AS n FROM proposals p WHERE p.last_run_id = ?
    AND EXISTS (SELECT 1 FROM transitions t WHERE t.fp = p.fp AND t.to_status = 'pushed')`).get(runId)).n);
  if (pending || pushed) stages.push = clean({ pending: pending || undefined, pushed: pushed || undefined });

  /** @type {string[]} */
  const next = [];
  if (running) {
    if (candidates > 0) next.push(`verify --run ${runId}`);
    else if (!reached.length) for (const l of LENSES) next.push(`context --run ${runId} --lens ${l}`);
    else {
      if (!marked) next.push(`pretriage --run ${runId}`);
      if (pending) next.push(`outbox --run ${runId}`);
      next.push(`run finish --run ${runId} --lenses <json>`);
    }
  }
  return /** @type {Row} */ (clean({ run_id: run.id, status: run.status, mode: run.mode, focus: run.focus, started_at: run.started_at,
    finished_at: run.finished_at, head_sha: run.head_sha, lenses: run.lenses, stages, next }));
}
