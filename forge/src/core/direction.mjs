// @ts-check
// Lens direction: what a team set in Settings, per inbox and per lens - what the lens should focus on and leave
// out, the team's intent, and for doc-drift the Confluence spaces to search. `direction.get` / `direction.set`
// serve the Settings page; `dowser_direction_get` (tool 8) hands the same shape to the skill at run start.
//
// No transactions on Forge SQL: a set is an UPDATE, else an INSERT guarded by the primary key, else (someone
// inserted first) the UPDATE again - the last writer wins, and every step is one statement. A clear is a DELETE.
import { needInbox } from './store.mjs';
import { deciderOf } from './verdicts.mjs';
import { AppError, DuplicateKey, isObj, needStr, optStr } from './util.mjs';
import { DIRECTION_ITEMS_MAX, DIRECTION_LINE_MAX, DIRECTION_SPACES_MAX, NOTE_MAX, SPACE_KEY_RE } from './types.mjs';
import { LENSES, isOneOf } from '../shared/model.mjs';

/**
 * @typedef {import('./ports.mjs').Deps} Deps
 * @typedef {import('./ports.mjs').Db} Db
 * @typedef {import('./types.mjs').LensDirection} LensDirection
 * @typedef {import('./types.mjs').DirectionOutput} DirectionOutput
 */

/** The lens whose direction may name Confluence spaces. */
export const SPACES_LENS = 'doc-drift';

/**
 * A list field: an array of strings (or one string, one item per line), trimmed, empty lines and repeats
 * dropped; undefined when nothing is left. `bad-input` past the caps.
 * @param {unknown} v
 * @param {string} key
 * @returns {string[] | undefined}
 */
function lines(v, key) {
  if (v === undefined || v === null) return undefined;
  const raw = typeof v === 'string' ? v.split(/\r?\n/) : v;
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string')) throw new AppError('bad-input', `${key} must be a list of strings`);
  const out = [...new Set(/** @type {string[]} */ (raw).map((x) => x.trim()).filter(Boolean))];
  if (out.length > DIRECTION_ITEMS_MAX) throw new AppError('bad-input', `${key} holds ${out.length} items; at most ${DIRECTION_ITEMS_MAX}`);
  const long = out.find((x) => x.length > DIRECTION_LINE_MAX || /[\r\n]/.test(x));
  if (long !== undefined) throw new AppError('bad-input', `each ${key} item is one line of at most ${DIRECTION_LINE_MAX} characters`);
  return out.length ? out : undefined;
}

/**
 * The direction a `direction.set` payload describes, validated and normalised (absent fields omitted), or
 * undefined when nothing is set.
 * @param {string} lens
 * @param {Record<string, any>} p
 * @returns {LensDirection | undefined}
 */
export function directionOf(lens, p) {
  const focus = lines(p.focus, 'focus');
  const exclude = lines(p.exclude, 'exclude');
  const notes = optStr(p, 'notes');
  if (notes !== undefined && notes.length > NOTE_MAX) throw new AppError('bad-input', `notes is longer than ${NOTE_MAX} characters`);
  const spaces = lines(p.spaces, 'spaces');
  if (spaces !== undefined) {
    if (lens !== SPACES_LENS) throw new AppError('bad-input', `spaces go only with the ${SPACES_LENS} lens`);
    if (spaces.length > DIRECTION_SPACES_MAX) throw new AppError('bad-input', `spaces holds ${spaces.length} keys; at most ${DIRECTION_SPACES_MAX}`);
    const bad = spaces.find((s) => !SPACE_KEY_RE.test(s));
    if (bad !== undefined) throw new AppError('bad-input', `${bad} is not a Confluence space key`);
  }
  /** @type {LensDirection} */
  const d = {};
  if (focus) d.focus = focus;
  if (exclude) d.exclude = exclude;
  if (notes !== undefined) d.notes = notes;
  if (spaces) d.spaces = spaces;
  return Object.keys(d).length ? d : undefined;
}

/** @param {unknown} v @returns {string} */
function needLens(v) {
  if (!isOneOf(LENSES, v)) throw new AppError('bad-input', `lens must be one of ${LENSES.join(', ')}`);
  return /** @type {string} */ (v);
}

/**
 * Every lens of the inbox that has a direction, in lens order. A row that no longer parses is left out.
 * @param {Db} db
 * @param {string} projectKey
 * @returns {Promise<DirectionOutput>}
 */
async function lensesOf(db, projectKey) {
  const rows = await db.query('SELECT lens, direction_json FROM directions WHERE project_key = ?', [projectKey]);
  /** @type {DirectionOutput['lenses']} */
  const lenses = {};
  for (const lens of LENSES) {
    const row = rows.find((r) => r.lens === lens);
    if (!row) continue;
    try {
      const d = JSON.parse(String(row.direction_json));
      if (isObj(d) && Object.keys(d).length) lenses[lens] = /** @type {LensDirection} */ (d);
    } catch { /* an unreadable row reads as no direction */ }
  }
  return { lenses };
}

/**
 * `direction.get`: the inbox's direction per lens (lenses without one omitted).
 * @param {Deps} d
 * @param {Record<string, any>} p
 * @returns {Promise<DirectionOutput>}
 */
export async function directionGet(d, p) {
  const projectKey = needStr(p, 'project_key');
  await needInbox(d.db, projectKey);
  return lensesOf(d.db, projectKey);
}

/**
 * `dowser_direction_get` (tool 8): as `direction.get`; `lens` narrows it to one lens (`all`, or absent, is every
 * lens). The skill sends `lens: "all"` so a transport without tool names still routes the call here.
 * @param {Deps} d
 * @param {Record<string, any>} a
 * @returns {Promise<DirectionOutput>}
 */
export async function directionTool(d, a) {
  const lens = optStr(a, 'lens');
  if (lens !== undefined && lens !== 'all') needLens(lens);
  const out = await directionGet(d, a);
  if (lens === undefined || lens === 'all') return out;
  const one = out.lenses[lens];
  return { lenses: one ? { [lens]: one } : {} };
}

/**
 * `direction.set`: replaces one lens's direction whole. Nothing set clears it: the row is deleted and the
 * answer carries no `direction`.
 * @param {Deps} d
 * @param {Record<string, any>} p
 * @param {string} accountId
 * @returns {Promise<{lens: string, direction?: LensDirection}>}
 */
export async function directionSet(d, p, accountId) {
  const { db } = d;
  const projectKey = needStr(p, 'project_key');
  const lens = needLens(p.lens);
  const direction = directionOf(lens, p);
  await needInbox(db, projectKey);
  if (!direction) {
    await db.exec('DELETE FROM directions WHERE project_key = ? AND lens = ?', [projectKey, lens]);
    return { lens };
  }
  const json = JSON.stringify(direction);
  const by = deciderOf(accountId);
  const at = d.now().toISOString();
  const update = () => db.exec('UPDATE directions SET direction_json = ?, updated_by = ?, updated_at = ? WHERE project_key = ? AND lens = ?',
    [json, by, at, projectKey, lens]);
  if ((await update()).affectedRows === 0) {
    try {
      await db.exec('INSERT INTO directions (project_key, lens, direction_json, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)',
        [projectKey, lens, json, by, at]);
    } catch (e) {
      // MySQL counts an UPDATE that changed nothing as 0 rows, and a concurrent set may have inserted first:
      // the row exists either way, so write ours over it.
      if (!(e instanceof DuplicateKey)) throw e;
      await update();
    }
  }
  return { lens, direction };
}
