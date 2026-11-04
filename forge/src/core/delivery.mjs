// @ts-check
// Delivery truth (moonshot 2026-11-04, idea 1). Three signals about what became of an accepted card, kept in one
// row per inbox item (`deliveries`, migration v027):
//  - Jira, as it happens: the issue-updated and issue-deleted triggers (manifest `dowser-issue-events`, filtered on
//    the `dowser` issue property, so only Dowser's issues invoke the app) record delivered / abandoned /
//    in_progress / open from the status category and resolution (onIssueEvent);
//  - the code, from the skill: `dowser_reflect_sync`'s `deliveries_json` carries the skill's re-check of the
//    card's quoted evidence at its scanned commit (present / partly / resolved) (storeCodeDeliveries);
//  - recurrence: a later push of a card already delivered (in Jira or in the code) marks it recurred (markRecurred).
// The Learning tab's candidates read the row: `delivery`, `code_state`, `still_in_code` (Jira Done, quoted problem
// still present) and `recurred`.
import { logLine } from './observe.mjs';
import { AppError, ISSUE_KEY_RE, isObj, str } from './util.mjs';

/** @typedef {import('./ports.mjs').Deps} Deps */
/** @typedef {import('./ports.mjs').Db} Db */

export const JIRA_STATES = /** @type {const} */ (['open', 'in_progress', 'delivered', 'abandoned']);
export const CODE_STATES = /** @type {const} */ (['present', 'partly', 'resolved']);
/** Resolutions that close an issue without doing the work. */
const ABANDONED_RESOLUTIONS = new Set(["won't do", "won't fix", 'duplicate', 'cannot reproduce', 'declined', 'not a bug', 'obsolete', 'rejected']);
/** Entries per `deliveries_json`. */
export const DELIVERIES_MAX = 500;

/**
 * The Jira fate an issue event says, or undefined when the event carries no status.
 * @param {Record<string, any>} event
 * @returns {{state: typeof JIRA_STATES[number], status: string} | undefined}
 */
export function jiraStateOf(event) {
  if (event?.eventType === 'avi:jira:deleted:issue') return { state: 'abandoned', status: 'Deleted' };
  const st = event?.issue?.fields?.status;
  const cat = st?.statusCategory?.key;
  if (typeof cat !== 'string') return undefined;
  const status = String(st.name ?? cat);
  if (cat === 'done') {
    const res = (event?.changelog?.items ?? []).find((/** @type {any} */ i) => i?.field === 'resolution')?.toString;
    return { state: typeof res === 'string' && ABANDONED_RESOLUTIONS.has(res.toLowerCase()) ? 'abandoned' : 'delivered', status };
  }
  return { state: cat === 'indeterminate' ? 'in_progress' : 'open', status };
}

/**
 * The rows a delivery belongs to: accepted items that created the issue, and items merged into it.
 * @param {Db} db
 * @param {string} key
 */
const ownersOf = (db, key) => db.query(
  "SELECT id, project_key FROM proposals WHERE (status = 'accepted' AND issue_ref = ?) OR (status = 'merged' AND merged_into = ?)", [key, key]);

/**
 * Inserts the item's delivery row when it has none (a concurrent insert is fine: the update below follows it).
 * @param {Db} db
 * @param {number} id
 * @param {string} projectKey
 */
async function ensureRow(db, id, projectKey) {
  try { await db.exec('INSERT INTO deliveries (proposal_id, project_key) VALUES (?, ?)', [id, projectKey]); } catch { /* exists */ }
}

/**
 * A Jira issue event (trigger `dowser-issue-events`). Never throws for a bad event: it is logged and dropped.
 * @param {Deps} deps
 * @param {Record<string, any>} event
 * @returns {Promise<{matched: number}>}
 */
export async function onIssueEvent(deps, event) {
  const key = event?.issue?.key;
  const fate = jiraStateOf(event);
  if (typeof key !== 'string' || !ISSUE_KEY_RE.test(key) || !fate) return { matched: 0 };
  const at = deps.now().toISOString();
  const rows = await ownersOf(deps.db, key);
  for (const r of rows) {
    await ensureRow(deps.db, Number(r.id), String(r.project_key));
    await deps.db.exec('UPDATE deliveries SET jira_state = ?, jira_status = ?, jira_at = ? WHERE proposal_id = ?', [fate.state, fate.status, at, Number(r.id)]);
  }
  if (rows.length) logLine(deps, { dowser: 'delivery', issue: key, state: fate.state, items: rows.length });
  return { matched: rows.length };
}

/**
 * Checks and stores `deliveries_json` (the skill's delivery report: the newest re-check per accepted card). An
 * fp the inbox does not hold as accepted is skipped. Malformed is `bad-input` and stores nothing.
 * @param {Deps} deps
 * @param {string} projectKey
 * @param {unknown} raw
 * @returns {Promise<number>} rows stored
 */
export async function storeCodeDeliveries(deps, projectKey, raw) {
  if (raw === undefined || raw === null || raw === '') return 0;
  if (typeof raw !== 'string') throw new AppError('bad-input', 'deliveries_json must be a JSON array as a string');
  /** @type {unknown} */
  let doc;
  try { doc = JSON.parse(raw); } catch { throw new AppError('bad-input', 'deliveries_json is not valid JSON'); }
  if (!Array.isArray(doc) || doc.length > DELIVERIES_MAX) throw new AppError('bad-input', `deliveries_json must be an array of at most ${DELIVERIES_MAX}`);
  doc.forEach((e, i) => {
    const ok = isObj(e) && str(e.fp) && CODE_STATES.includes(e.state) && Number.isInteger(e.found) && Number.isInteger(e.total)
      && e.found >= 0 && e.total >= 1 && e.found <= e.total && str(e.checked_at) && (e.commits === undefined || (Number.isInteger(e.commits) && e.commits >= 0));
    if (!ok) throw new AppError('bad-input', `deliveries_json[${i}] must be {fp, state: present|partly|resolved, found, total, checked_at, commits?}`);
  });
  let stored = 0;
  for (const e of /** @type {Record<string, any>[]} */ (doc)) {
    const rows = await deps.db.query("SELECT id FROM proposals WHERE project_key = ? AND fp = ? AND status = 'accepted'", [projectKey, e.fp]);
    if (!rows.length) continue;
    const id = Number(rows[0].id);
    await ensureRow(deps.db, id, projectKey);
    await deps.db.exec('UPDATE deliveries SET code_state = ?, code_found = ?, code_total = ?, code_commits = ?, code_at = ? WHERE proposal_id = ?',
      [e.state, e.found, e.total, e.commits ?? null, e.checked_at, id]);
    stored++;
  }
  return stored;
}

/**
 * A push carried an accepted item again: when it was already delivered (Jira Done, or its quoted problem gone from
 * the code), the finding came back - mark it recurred.
 * @param {Deps} deps
 * @param {number} proposalId
 * @param {string} at
 */
export async function markRecurred(deps, proposalId, at) {
  await deps.db.exec(
    "UPDATE deliveries SET recurred_at = ? WHERE proposal_id = ? AND recurred_at IS NULL AND (jira_state = 'delivered' OR code_state = 'resolved')",
    [at, proposalId]);
}

/**
 * The delivery rows of some items, by proposal id.
 * @param {Db} db
 * @param {number[]} ids
 * @returns {Promise<Map<number, Record<string, any>>>}
 */
export async function deliveriesOf(db, ids) {
  if (!ids.length) return new Map();
  const rows = await db.query(`SELECT * FROM deliveries WHERE proposal_id IN (${ids.map(() => '?').join(', ')})`, ids);
  return new Map(rows.map((r) => [Number(r.proposal_id), r]));
}
