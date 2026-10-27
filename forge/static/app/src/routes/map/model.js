// Pure shaping of `map.data` for the two views. No React here.
import { LENSES } from '../../components/labels.js';

export const SIZES = ['XS', 'S', 'M', 'L', 'XL'];
export const CONFIDENCES = ['low', 'medium', 'high'];
export const BLASTS = ['low', 'medium', 'high'];

/**
 * One heat row per area: open/accepted per lens (the four lenses, in their fixed order), totals, and the
 * area annotations as sent (an absent `authors_90d` stays absent). Rows sort by total open desc, then
 * churn desc, then path.
 * @param {any[]} areas  `map.data` areas
 */
export function heatRows(areas) {
  const rows = areas.map((a) => {
    const byLens = Object.fromEntries(LENSES.map((l) => [l, { open: 0, accepted: 0 }]));
    const other = { open: 0, accepted: 0 };
    for (const p of a.proposals ?? []) {
      const slot = byLens[p.lens] ?? other;
      slot.open += Number(p.open) || 0;
      slot.accepted += Number(p.accepted) || 0;
    }
    const open = LENSES.reduce((n, l) => n + byLens[l].open, 0) + other.open;
    const accepted = LENSES.reduce((n, l) => n + byLens[l].accepted, 0) + other.accepted;
    return { area: a, byLens, open, accepted };
  });
  rows.sort((x, y) => y.open - x.open || (y.area.churn_90d ?? 0) - (x.area.churn_90d ?? 0) || String(x.area.path).localeCompare(String(y.area.path)));
  return rows;
}

/**
 * Heat level 0..4 for a cell, relative to the largest open count in the grid. 0 means no open proposal.
 * @param {number} open @param {number} max
 */
export function heatLevel(open, max) {
  if (!open || max <= 0) return 0;
  return Math.max(1, Math.min(4, Math.ceil((open / max) * 4)));
}

/** A bus-factor risk: measured, and at most one author in 90 days. Absent authors are "not measured". */
export function singleAuthor(area) {
  return area.authors_90d !== undefined && area.authors_90d <= 1;
}

/**
 * Places points in the effort x confidence grid. Points with an effort or confidence outside the closed
 * vocabularies are returned in `unplaced`, never guessed into a cell.
 * @param {{ref: string, lens: string, effort: string, confidence: string, blast?: string}[]} points
 */
export function placePoints(points) {
  /** @type {Map<string, any[]>} */
  const cells = new Map();
  const unplaced = [];
  for (const p of points) {
    const x = SIZES.indexOf(String(p.effort).toUpperCase());
    const y = CONFIDENCES.indexOf(String(p.confidence).toLowerCase());
    if (x < 0 || y < 0) { unplaced.push(p); continue; }
    const key = `${x}:${y}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(p);
  }
  for (const list of cells.values()) list.sort((a, b) => refNum(a.ref) - refNum(b.ref));
  return { cells, unplaced };
}

function refNum(ref) {
  const n = Number(String(ref).replace(/^\D+/, ''));
  return Number.isFinite(n) ? n : 0;
}
