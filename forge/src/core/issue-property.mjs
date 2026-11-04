// @ts-check
// Dowser facts as Jira data. An accepted item, and an item merged into an existing Jira issue, writes the issue
// entity property `dowser` (indexed by the manifest's jira:entityProperty module), so JQL, boards, dashboards and
// Automation can use lens, kind, score and band: `dowserLens = "security-cra" AND dowserBand = "ranked"`.
// The write is best effort: the decision is the record, and a Jira failure is logged and left for the daily
// backfill (`issue_prop_at` stays NULL until a write lands). An issue an accepted card owns is never overwritten
// by a later merge into it.
import { cardOf } from './cards.mjs';
import { logLine } from './observe.mjs';
import { toProposal } from './store.mjs';
import { FP_RE, ISSUE_KEY_RE, omitAbsent } from './util.mjs';

/** @typedef {import('./ports.mjs').Deps} Deps */
/** @typedef {import('./types.mjs').Card} Card */
/** @typedef {import('./store.mjs').ProposalRow} ProposalRow */

/** The issue property key (manifest `jira:entityProperty` propertyKey). */
export const ISSUE_PROPERTY_KEY = 'dowser';
/** Items the daily backfill writes per run. */
export const BACKFILL_MAX = 50;

/**
 * The property value for a card. A fact the card does not carry is omitted, never 0. `mvp` is a string
 * (`yes` / `no`) because the index type is `string`.
 * @param {Card} card
 * @param {'accepted' | 'merged'} via
 * @returns {Record<string, string | number>}
 */
export function issuePropertyOf(card, via) {
  const c = /** @type {Record<string, any>} */ (card);
  return /** @type {Record<string, string | number>} */ (omitAbsent({
    ref: c.ref, fp: c.fp, lens: c.lens, kind: c.kind, confidence: c.confidence, category: c.category,
    impact: typeof c.impact === 'number' ? c.impact : undefined,
    score: typeof c.score === 'number' ? c.score : undefined,
    band: c.band,
    mvp: c.mvp === true ? 'yes' : c.mvp === false ? 'no' : undefined,
    via,
  }));
}

/**
 * Whether another item already owns `issueKey`'s property: an accepted card that created it, or an earlier
 * merge whose write landed.
 * @param {Deps} deps
 * @param {string} issueKey
 * @param {number} id  the item being written
 */
async function ownedElsewhere(deps, issueKey, id) {
  const rows = await deps.db.query(
    `SELECT 1 FROM proposals WHERE id <> ? AND ((status = 'accepted' AND issue_ref = ?)
       OR (status = 'merged' AND merged_into = ? AND issue_prop_at IS NOT NULL)) LIMIT 1`,
    [id, issueKey, issueKey],
  );
  return rows.length > 0;
}

/**
 * Writes the property for one decided item. Returns `written`, `owned` (a merge into an issue another item owns:
 * nothing written, stamped done) or `failed` (logged; the backfill retries). Without the port: `failed`.
 * @param {Deps} deps
 * @param {ProposalRow} p  the item after its decision
 * @param {string} issueKey
 * @param {'accepted' | 'merged'} via
 * @returns {Promise<'written' | 'owned' | 'failed'>}
 */
export async function writeIssueProperty(deps, p, issueKey, via) {
  const set = deps.jira?.setIssueProperty;
  if (!set) return 'failed';
  const stamp = () => deps.db.exec('UPDATE proposals SET issue_prop_at = ? WHERE id = ?', [deps.now().toISOString(), p.id]);
  if (via === 'merged' && await ownedElsewhere(deps, issueKey, p.id)) { await stamp(); return 'owned'; }
  try {
    await set(issueKey, ISSUE_PROPERTY_KEY, issuePropertyOf(await cardOf(deps.db, p), via));
  } catch (e) {
    logLine(deps, { dowser: 'warn', what: 'issue property', issue: issueKey, message: String(/** @type {Error} */ (e)?.message ?? e).slice(0, 200) });
    return 'failed';
  }
  await stamp();
  return 'written';
}

/**
 * The daily backfill: accepted items, and items merged into a Jira key, whose property never landed (decided
 * before this existed, or the write failed). At most BACKFILL_MAX per run, oldest decision first; idempotent.
 * @param {Deps} deps
 * @returns {Promise<{written: number, failed: number}>}
 */
export async function backfillIssueProperties(deps) {
  const rows = (await deps.db.query(
    `SELECT * FROM proposals WHERE issue_prop_at IS NULL AND (
       (status = 'accepted' AND issue_ref IS NOT NULL) OR (status = 'merged' AND merged_into LIKE '%-%'))
     ORDER BY decided_at, id LIMIT ${BACKFILL_MAX}`,
  )).map(toProposal);
  let written = 0;
  let failed = 0;
  for (const p of rows) {
    const accepted = p.status === 'accepted';
    const key = accepted ? p.issue_ref : p.merged_into;
    // a merge into another inbox item names its fp (no '-'), not a Jira key: the SQL leaves those out
    if (!key || (!accepted && (FP_RE.test(key) || !ISSUE_KEY_RE.test(key)))) continue;
    const r = await writeIssueProperty(deps, p, key, accepted ? 'accepted' : 'merged');
    if (r === 'written') written++;
    else if (r === 'failed') failed++;
  }
  return { written, failed };
}
