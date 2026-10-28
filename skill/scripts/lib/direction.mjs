// @ts-check
// Per-lens direction (lens-quality-plan WP3): what a team set in Forge Settings for one inbox - focus, exclude,
// notes and, for doc-drift, the Confluence spaces to search - cached on the run so `context --lens` can hand it
// to the lens pack. The agent calls `dowser_direction_get` and runs `ingest-direction` with the saved response.
//
// The cache is `sources_cache` rows of type `direction`, one per lens (ref = the lens id, body = the
// LensDirection as JSON). An ingest replaces what the run held for every lens. The caps mirror Forge's
// (forge/src/core/direction.mjs): a lens that breaks them is skipped and reported, never half-stored.
import { DowserError, LENSES, isOneOf } from './model.mjs';
import * as store from './store.mjs';

/**
 * @typedef {{focus?: string[], exclude?: string[], notes?: string, spaces?: string[]}} LensDirection
 * @typedef {{lenses: Partial<Record<import('./model.mjs').Lens, LensDirection>>}} DirectionDoc
 * @typedef {import('./store.mjs').Db} Db
 * @typedef {import('./store.mjs').Row} Row
 */

/** The sources_cache type direction rows use. */
export const DIRECTION_TYPE = 'direction';
/** Caps, as Forge enforces them (forge-mcp-2 `dowser_direction_get`). */
export const DIRECTION_ITEMS_MAX = 10;
export const DIRECTION_LINE_MAX = 120;
export const DIRECTION_NOTES_MAX = 2000;
export const DIRECTION_SPACES_MAX = 10;
export const SPACE_KEY_RE = /^[A-Za-z0-9_~-]+$/;
/** The only lens whose direction may name Confluence spaces. */
export const SPACES_LENS = 'doc-drift';
const KEYS = ['focus', 'exclude', 'notes', 'spaces'];

/** @param {unknown} v @returns {v is Record<string, any>} */
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * A list field: trimmed strings, empty ones dropped; undefined when absent or empty. Throws a reason past the caps.
 * @param {unknown} v
 * @param {string} key
 * @param {number} max
 * @returns {string[] | undefined}
 */
function list(v, key, max) {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new Error(`${key} is a list of strings`);
  const out = v.map((x) => x.trim()).filter(Boolean);
  if (out.length > max) throw new Error(`${key} holds ${out.length} items; at most ${max}`);
  if (out.some((x) => x.length > DIRECTION_LINE_MAX || /[\r\n]/.test(x))) throw new Error(`each ${key} item is one line of at most ${DIRECTION_LINE_MAX} characters`);
  return out.length ? out : undefined;
}

/**
 * One lens's direction, validated and normalised (absent fields omitted), or undefined when nothing is set.
 * Throws an Error whose message is the reason it is refused.
 * @param {string} lens
 * @param {unknown} raw
 * @returns {LensDirection | undefined}
 */
export function checkDirection(lens, raw) {
  if (!isObj(raw)) throw new Error('a direction is an object');
  const extra = Object.keys(raw).find((k) => !KEYS.includes(k));
  if (extra) throw new Error(`unknown field ${extra}`);
  const focus = list(raw.focus, 'focus', DIRECTION_ITEMS_MAX);
  const exclude = list(raw.exclude, 'exclude', DIRECTION_ITEMS_MAX);
  if (raw.notes !== undefined && typeof raw.notes !== 'string') throw new Error('notes is a string');
  const notes = typeof raw.notes === 'string' && raw.notes.trim() ? raw.notes.trim() : undefined;
  if (notes !== undefined && notes.length > DIRECTION_NOTES_MAX) throw new Error(`notes is longer than ${DIRECTION_NOTES_MAX} characters`);
  const spaces = list(raw.spaces, 'spaces', DIRECTION_SPACES_MAX);
  if (spaces && lens !== SPACES_LENS) throw new Error(`spaces go only with the ${SPACES_LENS} lens`);
  const bad = spaces?.find((s) => !SPACE_KEY_RE.test(s));
  if (bad !== undefined) throw new Error(`${bad} is not a Confluence space key`);
  /** @type {LensDirection} */
  const d = {};
  if (focus) d.focus = focus;
  if (exclude) d.exclude = exclude;
  if (notes !== undefined) d.notes = notes;
  if (spaces) d.spaces = spaces;
  return Object.keys(d).length ? d : undefined;
}

/**
 * Applies a `dowser_direction_get` response `{lenses: {[lens]: LensDirection}}` to the run: the run's direction
 * rows are replaced whole (a lens Forge no longer has a direction for loses its row). An unknown lens or a
 * direction past the caps is skipped and reported (exit 1); a lens with nothing set is simply absent.
 * @param {Db} db
 * @param {{runId: string, doc: unknown}} o
 * @returns {{code: number, out: Row}}
 */
export function ingestDirection(db, { runId, doc }) {
  store.requireRunning(db, runId);
  if (!isObj(doc) || !isObj(doc.lenses)) throw new DowserError('not a dowser_direction_get response: expected {"lenses": {...}}', 2);
  /** @type {[string, LensDirection][]} */
  const keep = [];
  /** @type {Row[]} */
  const skipped = [];
  for (const [lens, raw] of Object.entries(doc.lenses)) {
    if (!isOneOf(LENSES, lens)) { skipped.push({ lens, why: `unknown lens; one of ${LENSES.join(', ')}` }); continue; }
    try {
      const d = checkDirection(lens, raw);
      if (d) keep.push([lens, d]);
    } catch (e) {
      skipped.push({ lens, why: /** @type {Error} */ (e).message });
    }
  }
  keep.sort(([a], [b]) => LENSES.indexOf(/** @type {any} */ (a)) - LENSES.indexOf(/** @type {any} */ (b)));
  return store.tx(db, () => {
    db.prepare('DELETE FROM sources_cache WHERE run_id = ? AND type = ?').run(runId, DIRECTION_TYPE);
    const ins = db.prepare('INSERT INTO sources_cache (run_id, type, ref, body, fetched_at) VALUES (?, ?, ?, ?, ?)');
    const at = store.now();
    for (const [lens, d] of keep) ins.run(runId, DIRECTION_TYPE, lens, JSON.stringify(d), at);
    return {
      code: skipped.length ? 1 : 0,
      out: /** @type {Row} */ (store.clean({ run_id: runId, lenses: keep.map(([l]) => l), skipped: skipped.length ? skipped : undefined })),
    };
  });
}

/**
 * The direction the run holds for one lens, or undefined (absent: the run has none for that lens).
 * @param {Db} db
 * @param {string} runId
 * @param {string} lens
 * @returns {LensDirection | undefined}
 */
export function directionFor(db, runId, lens) {
  const row = /** @type {Row | undefined} */ (db.prepare('SELECT body FROM sources_cache WHERE run_id = ? AND type = ? AND ref = ?').get(runId, DIRECTION_TYPE, lens));
  if (!row || typeof row.body !== 'string') return undefined;
  try {
    const d = JSON.parse(row.body);
    return isObj(d) && Object.keys(d).length ? /** @type {LensDirection} */ (d) : undefined;
  } catch {
    return undefined;
  }
}
