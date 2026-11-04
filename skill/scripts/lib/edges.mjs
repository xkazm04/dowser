// @ts-check
// The proposal relationship graph: typed edges between cards of this store, beyond `merged_into`.
//  - unblocks: the from-card is a prerequisite of the to-card (the run's allocation lifts it, budget.mjs);
//  - duplicate-of, follow-up-of, conflicts-with, related: recorded and shown (`show`, `links`), for people and for
//    later readers (precedents, decision consistency).
// Append-only: an edge is never edited or removed (store triggers); one row per (from, to, kind).
import { DECIDER_RE, DowserError } from './model.mjs';
import { clean, now, sql } from './store-core.mjs';

/** @typedef {import('./store-core.mjs').Db} Db */
/** @typedef {Record<string, any>} Row */

export const EDGE_KINDS = /** @type {const} */ (['unblocks', 'duplicate-of', 'follow-up-of', 'conflicts-with', 'related']);

/**
 * Records one edge. `exists` when the same (from, to, kind) is already there (the first note stands).
 * @param {Db} db
 * @param {{from: string, to: string, kind: string, by: string, note?: string}} e
 * @returns {{result: 'linked' | 'exists', from: string, to: string, kind: string}}
 */
export function link(db, { from, to, kind, by, note }) {
  if (!(/** @type {readonly string[]} */ (EDGE_KINDS)).includes(kind)) throw new DowserError(`--kind must be one of ${EDGE_KINDS.join('|')}`, 2);
  if (from === to) throw new DowserError('a card cannot be linked to itself', 2);
  if (!DECIDER_RE.test(by)) throw new DowserError('--by is a decider <kind>:<name>', 2);
  const has = db.prepare('SELECT 1 FROM proposals WHERE fp = ?');
  for (const fp of [from, to]) if (!has.get(fp)) throw new DowserError(`no card ${fp} in this store`, 2);
  const r = db.prepare('INSERT OR IGNORE INTO edges (from_fp, to_fp, kind, by, at, note) VALUES (?, ?, ?, ?, ?, ?)')
    .run(from, to, kind, by, now(), sql(note && note.trim() ? note.trim() : undefined));
  return { result: Number(r.changes) > 0 ? 'linked' : 'exists', from, to, kind };
}

/**
 * Every edge touching `fp`, oldest first: `dir` `out` (fp -> other) or `in` (other -> fp), with the other card's title
 * and status.
 * @param {Db} db
 * @param {string} fp
 * @returns {{kind: string, dir: 'in' | 'out', fp: string, title?: string, status?: string, by: string, at: string, note?: string}[]}
 */
export function linksOf(db, fp) {
  return /** @type {Row[]} */ (db.prepare(
    `SELECT e.kind, e.from_fp, e.to_fp, e.by, e.at, e.note, p.title, p.status FROM edges e
     JOIN proposals p ON p.fp = CASE WHEN e.from_fp = ? THEN e.to_fp ELSE e.from_fp END
     WHERE e.from_fp = ? OR e.to_fp = ? ORDER BY e.id`,
  ).all(fp, fp, fp)).map((r) => /** @type {any} */ (clean({
    kind: r.kind, dir: r.from_fp === fp ? 'out' : 'in', fp: r.from_fp === fp ? r.to_fp : r.from_fp,
    title: r.title, status: r.status, by: r.by, at: r.at, note: r.note ?? undefined,
  })));
}
