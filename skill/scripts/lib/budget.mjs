// @ts-check
// The run's budget, enforced in code (scan-finding/1 "Coverage: every lens, nothing paid-for discarded"). Every
// verified card the run touched is allocated a slot: (1) each lens with a verified card gets one ranked slot, its
// MVP (its top card); (2) the remaining slots go by score across lenses, at most `perLens` ranked per lens and
// `perRun` in all; (3) run slots still free after that pass go to the best remaining cards of ANY lens, past the
// per-lens cap (operator decision 2026-10-30: the self-scan ranked 14 of 16 while 5 verified doc-drift cards sat in
// reserve); (4) everything else verified is `band: reserve` - stored, pushed and shown collapsed, never lost.
// Order (the tie-break) inside a lens, across lenses and for the free slots: score desc (unscored after every
// scored card), then confidence (high, medium, low), then evidence count desc, then fp asc. verifyRun calls allocateRun after every verify, so a re-verify re-allocates; the result is the same
// for the same cards. Imports store-core.mjs only (runs.mjs imports it; the lens packs' `budget` comes in as `capOf`).
import { DowserError, LENSES } from './model.mjs';
import { tx } from './store-core.mjs';

/** @import { Db, Row } from './store-core.mjs' */

/** The defaults when neither the lens pack nor the caller says otherwise: 4 per lens, 16 per run. */
export const PER_LENS = 4;
export const PER_RUN = 16;
const CONF = /** @type {Record<string, number>} */ ({ high: 0, medium: 1, low: 2 });

/**
 * @param {Row} a
 * @param {Row} b
 */
export const byRank = (a, b) => {
  const sa = typeof a.score === 'number' ? a.score : -1;
  const sb = typeof b.score === 'number' ? b.score : -1;
  return sb - sa || (CONF[a.confidence] ?? 3) - (CONF[b.confidence] ?? 3) || Number(b.evidence) - Number(a.evidence) || String(a.fp).localeCompare(String(b.fp));
};

/**
 * Allocates the run's verified cards to `ranked` / `reserve` and marks each lens's MVP (mvp_rule `top-score`).
 * The per-lens cap is `perLens` when given, else `capOf(lens)` (the lens pack's `budget`), else PER_LENS; it bounds
 * the first pass only. `perRun` is the run cap: slots it leaves free after that pass go to the best held-back cards
 * of any lens (byRank), so a lens's `ranked` may exceed its `cap`. Returns per lens the ranked and reserve counts and the MVP, and the reserve cards by title (the
 * run summary prints them).
 * @param {Db} db
 * @param {string} runId
 * @param {{perLens?: number, perRun?: number, capOf?: (lens: string) => number | undefined}} [o]
 * @returns {Row}
 */
export function allocateRun(db, runId, { perLens, perRun = PER_RUN, capOf } = {}) {
  for (const [k, v] of [['--per-lens', perLens], ['--per-run', perRun]]) {
    if (v !== undefined && !(Number.isInteger(v) && /** @type {number} */ (v) >= 1)) throw new DowserError(`${k} is a positive integer`, 2);
  }
  const rows = /** @type {Row[]} */ (db.prepare(
    `SELECT p.fp, p.lens, p.title, p.score, p.confidence, (SELECT COUNT(*) FROM evidence e WHERE e.fp = p.fp) AS evidence
     FROM proposals p WHERE p.last_run_id = ? AND p.status = 'verified'`,
  ).all(runId)).sort(byRank);
  /** @type {Record<string, number>} */
  const cap = {};
  for (const lens of new Set(rows.map((r) => String(r.lens)))) {
    cap[lens] = perLens ?? capOf?.(lens) ?? PER_LENS;
  }
  /** @type {Map<string, {band: 'ranked' | 'reserve', mvp: boolean}>} */
  const slot = new Map();
  /** @type {Record<string, number>} */
  const ranked = {};
  for (const r of rows) {
    if (ranked[r.lens] === undefined) { ranked[r.lens] = 1; slot.set(String(r.fp), { band: 'ranked', mvp: true }); }
  }
  let used = Object.keys(ranked).length;
  for (const r of rows) {
    if (slot.has(String(r.fp))) continue;
    if (used < perRun && ranked[r.lens] < cap[r.lens]) {
      ranked[r.lens]++;
      used++;
      slot.set(String(r.fp), { band: 'ranked', mvp: false });
    }
  }
  // free run slots: the best cards the per-lens cap held back, from any lens (rows are already in byRank order)
  for (const r of rows) {
    if (slot.has(String(r.fp))) continue;
    if (used < perRun) {
      ranked[r.lens]++;
      used++;
      slot.set(String(r.fp), { band: 'ranked', mvp: false });
    } else slot.set(String(r.fp), { band: 'reserve', mvp: false });
  }
  tx(db, () => {
    const up = db.prepare('UPDATE proposals SET band = ?, mvp = ?, mvp_rule = ? WHERE fp = ?');
    for (const [fp, s] of slot) up.run(s.band, s.mvp ? 1 : null, s.mvp ? 'top-score' : null, fp);
  });
  /** @type {Row} */
  const perLensOut = {};
  /** @type {Row[]} */
  const reserve = [];
  for (const lens of LENSES) {
    const mine = rows.filter((r) => r.lens === lens);
    if (!mine.length) continue;
    const mvp = mine.find((r) => slot.get(String(r.fp))?.mvp);
    const res = mine.filter((r) => slot.get(String(r.fp))?.band === 'reserve');
    perLensOut[lens] = {
      ranked: ranked[lens], reserve: res.length, cap: cap[lens],
      ...(mvp ? { mvp: { fp: mvp.fp, title: mvp.title, ...(typeof mvp.score === 'number' ? { score: mvp.score } : {}) } } : {}),
    };
    for (const r of res) reserve.push({ lens, fp: r.fp, title: r.title, ...(typeof r.score === 'number' ? { score: r.score } : {}) });
  }
  return { per_run: perRun, ranked: used, per_lens: perLensOut, ...(reserve.length ? { reserve } : {}) };
}

/**
 * The run's allocation as stored (the band of every card whose last run is `runId`): per lens the ranked and
 * reserve counts and the reserve titles; lenses with no allocated card are absent (not zero).
 * @param {Db} db
 * @param {string} runId
 * @returns {Record<string, {ranked: number, reserve: number, reserve_titles?: string[]}>}
 */
export function allocationOf(db, runId) {
  /** @type {Record<string, {ranked: number, reserve: number, reserve_titles?: string[]}>} */
  const out = {};
  for (const r of /** @type {Row[]} */ (db.prepare(
    "SELECT lens, band, title FROM proposals WHERE last_run_id = ? AND band IS NOT NULL AND status NOT IN ('candidate', 'dropped') ORDER BY lens, score DESC, fp",
  ).all(runId))) {
    const o = (out[r.lens] ??= { ranked: 0, reserve: 0 });
    if (r.band === 'ranked') o.ranked++;
    else { o.reserve++; (o.reserve_titles ??= []).push(String(r.title)); }
  }
  return out;
}
