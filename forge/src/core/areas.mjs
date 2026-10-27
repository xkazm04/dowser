// @ts-check
// `dowser_areas_push` (replace the project's area set) and the `map.data` resolver: areas joined to the
// proposals whose anchors / code evidence fall under them (longest area-path prefix wins), plus the
// effort-vs-confidence points of open proposals.
import { normalizeAnchor, parseRef } from '../shared/fingerprint.mjs';
import { AREAS_MAX } from './types.mjs';
import { parseJsonArray } from './push.mjs';
import { ensureInbox, needInbox, toProposal } from './store.mjs';
import { AppError, isIso, isObj, needStr, num, omitAbsent, sqlv } from './util.mjs';

/**
 * @typedef {import('./ports.mjs').Deps} Deps
 * @typedef {import('./ports.mjs').Db} Db
 * @typedef {import('./types.mjs').Area} Area
 */

const AREA_KEYS = ['path', 'files', 'churn_90d', 'authors_90d', 'last_change'];
/** @param {unknown} v @param {number} min */
const intAtLeast = (v, min) => Number.isInteger(v) && /** @type {number} */ (v) >= min;

/**
 * Validates one area per the contract table; returns why it is invalid, or undefined.
 * @param {unknown} a
 * @returns {string | undefined}
 */
export function areaProblem(a) {
  if (!isObj(a)) return 'not an object';
  const extra = Object.keys(a).find((k) => !AREA_KEYS.includes(k));
  if (extra) return `unknown field ${extra}`;
  const p = a.path;
  if (typeof p !== 'string' || !p) return 'path is required';
  if (p.startsWith('/') || p.endsWith('/') || p.includes('\\') || p.includes('//')) return `path ${JSON.stringify(p)} must be repo-relative with forward slashes and no trailing slash`;
  const segs = p.split('/');
  if (segs.length > 2) return `path ${JSON.stringify(p)} is deeper than two levels`;
  if (segs.some((s) => s === '.' || s === '..')) return `path ${JSON.stringify(p)} must not contain . or ..`;
  if (p.length > 512) return 'path is longer than 512 characters';
  if (!intAtLeast(a.files, 1)) return 'files must be an integer >= 1';
  if (!intAtLeast(a.churn_90d, 0)) return 'churn_90d must be an integer >= 0';
  if (a.churn_90d === 0 && a.authors_90d !== undefined) return 'authors_90d must be omitted when churn_90d is 0 (not measured)';
  if (a.churn_90d > 0 && !intAtLeast(a.authors_90d, 1)) return 'authors_90d must be an integer >= 1 when churn_90d > 0';
  if (a.last_change !== undefined && !isIso(a.last_change)) return 'last_change must be an ISO timestamp';
  return undefined;
}

/**
 * `dowser_areas_push`: validate every area, then make the stored set equal to it. Without a transaction the
 * replace is upsert-each then delete-the-rest, so an interrupted push leaves old plus new areas, never none.
 * @param {Deps} deps
 * @param {Record<string, unknown>} args
 * @returns {Promise<{stored: number}>}
 */
export async function pushAreas(deps, args) {
  const { db } = deps;
  const projectKey = needStr(args, 'project_key');
  const runId = needStr(args, 'run_id');
  const areas = parseJsonArray(args, 'areas_json', AREAS_MAX);
  const seen = new Set();
  for (const [i, a] of areas.entries()) {
    const why = areaProblem(a);
    if (why) throw new AppError('bad-input', `areas_json[${i}]: ${why}`);
    const path = /** @type {Area} */ (a).path;
    if (seen.has(path)) throw new AppError('bad-input', `areas_json[${i}]: path ${path} appears twice`);
    seen.add(path);
  }
  await ensureInbox(db, projectKey, { at: deps.now().toISOString() });
  for (const raw of areas) {
    const a = /** @type {Area} */ (raw);
    const vals = [a.files, a.churn_90d, sqlv(a.authors_90d), sqlv(a.last_change), runId];
    const u = await db.exec('UPDATE areas SET files = ?, churn_90d = ?, authors_90d = ?, last_change = ?, run_id = ? WHERE project_key = ? AND path = ?',
      [...vals, projectKey, a.path]);
    if (u.affectedRows === 0) {
      await db.exec('INSERT INTO areas (files, churn_90d, authors_90d, last_change, run_id, project_key, path) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [...vals, projectKey, a.path]);
    }
  }
  const keep = [...seen];
  if (keep.length) {
    await db.exec(`DELETE FROM areas WHERE project_key = ? AND path NOT IN (${keep.map(() => '?').join(', ')})`, [projectKey, ...keep]);
  } else {
    await db.exec('DELETE FROM areas WHERE project_key = ?', [projectKey]);
  }
  return { stored: keep.length };
}

/**
 * The area a repo path belongs to: the longest area path equal to it or a directory prefix of it.
 * @param {string} path
 * @param {string[]} areaPaths
 * @returns {string | undefined}
 */
export function areaOf(path, areaPaths) {
  let best;
  for (const a of areaPaths) {
    if ((path === a || path.startsWith(`${a}/`)) && (!best || a.length > best.length)) best = a;
  }
  return best;
}

/**
 * The repo paths a proposal touches: its anchors (`path#symbol` -> path) and its code/doc evidence refs.
 * @param {Record<string, any>} record
 * @param {{type: string, ref: string}[]} evidence
 * @returns {string[]}
 */
export function pathsOf(record, evidence) {
  const out = new Set();
  for (const a of Array.isArray(record.anchors) ? record.anchors : []) out.add(normalizeAnchor(String(a)).split('#')[0]);
  for (const e of evidence) if (e.type === 'code' || e.type === 'doc') out.add(parseRef(e.ref).path);
  return [...out].filter(Boolean);
}

/**
 * `map.data`: every area with per-lens open/accepted counts (a proposal counts once per area), and the
 * effort-vs-confidence points of the open proposals.
 * @param {Db} db
 * @param {string} projectKey
 * @returns {Promise<import('./types.mjs').ResolverContract['map.data'][1]>}
 */
export async function mapData(db, projectKey) {
  await needInbox(db, projectKey);
  const areaRows = await db.query('SELECT * FROM areas WHERE project_key = ? ORDER BY path', [projectKey]);
  const areaPaths = areaRows.map((r) => String(r.path));
  /** @type {Map<string, Map<string, {open: number, accepted: number}>>} */
  const counts = new Map(areaPaths.map((p) => [p, new Map()]));
  /** @type {{ref: string, lens: string, effort: string, confidence: string, blast?: string}[]} */
  const points = [];
  const rows = await db.query("SELECT * FROM proposals WHERE project_key = ? AND status IN ('open', 'accepted') ORDER BY id", [projectKey]);
  const evRows = await db.query(
    "SELECT e.proposal_id, e.type, e.ref FROM evidence e JOIN proposals p ON p.id = e.proposal_id WHERE p.project_key = ? AND p.status IN ('open', 'accepted') AND e.type IN ('code', 'doc')",
    [projectKey],
  );
  /** @type {Map<number, {type: string, ref: string}[]>} */
  const evBy = new Map();
  for (const e of evRows) {
    const id = Number(e.proposal_id);
    if (!evBy.has(id)) evBy.set(id, []);
    /** @type {{type: string, ref: string}[]} */ (evBy.get(id)).push({ type: String(e.type), ref: String(e.ref) });
  }
  for (const r of rows) {
    const p = toProposal(r);
    const hit = new Set(pathsOf(p.record, evBy.get(p.id) ?? []).map((x) => areaOf(x, areaPaths)).filter((x) => x !== undefined));
    for (const area of hit) {
      const byLens = /** @type {Map<string, {open: number, accepted: number}>} */ (counts.get(/** @type {string} */ (area)));
      const c = byLens.get(p.lens) ?? { open: 0, accepted: 0 };
      if (p.status === 'open') c.open++; else c.accepted++;
      byLens.set(p.lens, c);
    }
    if (p.status === 'open') {
      points.push(omitAbsent({ ref: p.ref, lens: p.lens, effort: String(p.record.effort?.size), confidence: p.confidence, blast: p.record.delivery_risk?.blast }));
    }
  }
  const areas = areaRows.map((r) => /** @type {Area & {proposals: {lens: string, open: number, accepted: number}[]}} */ (omitAbsent({
    path: String(r.path), files: Number(r.files), churn_90d: Number(r.churn_90d), authors_90d: num(r.authors_90d),
    last_change: r.last_change ?? undefined,
    proposals: [.../** @type {Map<string, {open: number, accepted: number}>} */ (counts.get(String(r.path))).entries()]
      .sort(([a], [b]) => a.localeCompare(b)).map(([lens, c]) => ({ lens, ...c })),
  })));
  return { areas, points };
}
