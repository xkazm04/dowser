// @ts-check
// The card the Custom UI and the Rovo agent read: the stored proposal record plus inbox state and its evidence
// with links (F2). Read-side queries: the inbox (F8 run-diff groups), one card, the panel, the byline.
import { parseRef } from '../shared/fingerprint.mjs';
import { withNames } from './names.mjs';
import { evidenceOf, findProposal, getInbox, listInboxRows, toProposal } from './store.mjs';
import { AppError, omitAbsent } from './util.mjs';
import { INBOX_STATUSES, PAGE_SIZE } from './types.mjs';
import { LENSES, isOneOf } from '../shared/model.mjs';

/**
 * @typedef {import('./ports.mjs').Db} Db
 * @typedef {import('./ports.mjs').Row} Row
 * @typedef {import('./store.mjs').ProposalRow} ProposalRow
 * @typedef {import('./store.mjs').EvidenceRow} EvidenceRow
 * @typedef {import('./types.mjs').Card} Card
 * @typedef {import('./types.mjs').CardEvidence} CardEvidence
 * @typedef {import('./types.mjs').Verdict} Verdict
 * @typedef {import('./types.mjs').InboxGroup} InboxGroup
 * @typedef {import('./types.mjs').InboxSummary} InboxSummary
 */

/**
 * The web link of a code/doc evidence ref at a revision (F2): GitHub `<repo>/blob/<sha>/<path>#L<line>`,
 * Bitbucket `<repo>/src/<sha>/<path>#lines-<line>`; undefined for any other host, or without repo/sha.
 * @param {string | undefined} repoUrl
 * @param {string | undefined} sha
 * @param {string} ref
 * @returns {string | undefined}
 */
export function codeLink(repoUrl, sha, ref) {
  if (!repoUrl || !sha) return undefined;
  /** @type {URL} */
  let u;
  try { u = new URL(repoUrl); } catch { return undefined; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
  const repo = `${u.origin}${u.pathname.replace(/\.git$/, '').replace(/\/+$/, '')}`;
  const { path, line } = parseRef(ref);
  const p = path.split('/').map(encodeURIComponent).join('/');
  const host = u.hostname.toLowerCase();
  if (host === 'github.com') return `${repo}/blob/${sha}/${p}${line ? `#L${line}` : ''}`;
  if (host === 'bitbucket.org') return `${repo}/src/${sha}/${p}${line ? `#lines-${line}` : ''}`;
  return undefined;
}

/**
 * @param {EvidenceRow} e
 * @param {string | undefined} repoUrl
 * @returns {CardEvidence}
 */
export function cardEvidence(e, repoUrl) {
  const link = e.type === 'code' || e.type === 'doc' ? codeLink(repoUrl, e.head_sha, e.ref) : e.url;
  return /** @type {CardEvidence} */ (omitAbsent({ type: e.type, ref: e.ref, url: e.url, quote: e.quote, link }));
}

/**
 * @param {ProposalRow} p
 * @param {EvidenceRow[]} evidence
 * @param {string | undefined} repoUrl
 * @returns {Card}
 */
export function toCard(p, evidence, repoUrl) {
  return /** @type {Card} */ (omitAbsent({
    ...p.record,
    fp: p.fp, ref: p.ref, status: p.status, project_key: p.project_key,
    evidence: evidence.map((e) => cardEvidence(e, repoUrl)),
    reopened: p.reopened || undefined,
    issue_ref: p.issue_ref, issue_url: p.issue_url,
    reason: p.reason, note: p.note, merged_into: p.merged_into, decided_by: p.decided_by, decided_at: p.decided_at,
    first_seen: p.first_seen, last_push_at: p.last_push_at,
  }));
}

/**
 * @param {Db} db
 * @param {ProposalRow} p
 * @returns {Promise<Card>}
 */
export async function cardOf(db, p) {
  const inbox = await getInbox(db, p.project_key);
  return toCard(p, await evidenceOf(db, p.id), inbox?.repo_url);
}

/** @param {Row} r @returns {Verdict} */
export const toVerdict = (r) => /** @type {Verdict} */ (omitAbsent({
  fp: String(r.fp), status: r.status, reason: r.reason, note: r.note, merged_into: r.merged_into,
  decided_by: String(r.decided_by), decided_at: String(r.decided_at), external_ref: String(r.external_ref),
  issue_ref: r.issue_ref, issue_url: r.issue_url,
}));

/**
 * The verdict history of one proposal, oldest first.
 * @param {Db} db
 * @param {ProposalRow} p
 * @returns {Promise<Verdict[]>}
 */
export async function historyOf(db, p) {
  const rows = await db.query('SELECT * FROM verdicts WHERE project_key = ? AND fp = ? ORDER BY seq', [p.project_key, p.fp]);
  return rows.map(toVerdict);
}

/**
 * `proposal.get`: one card and its history, by DW ref or fp.
 * @param {import('./ports.mjs').Deps} deps
 * @param {string} ref
 * @returns {Promise<{card: Card, history: import('./types.mjs').HistoryRow[]}>}
 */
export async function getProposal(deps, ref) {
  const p = await findProposal(deps.db, ref);
  return { card: await cardOf(deps.db, p), history: await withNames(deps, await historyOf(deps.db, p)) };
}

/**
 * The inbox summaries (settings, the inbox header and its empty state): target settings, the open count and
 * the newest push (`last_push`), whatever status the inbox is filtered to.
 * @param {Db} db
 * @returns {Promise<InboxSummary[]>}
 */
export async function inboxSummaries(db) {
  const counts = new Map((await db.query("SELECT project_key, COUNT(*) AS n FROM proposals WHERE status = 'open' GROUP BY project_key"))
    .map((r) => [String(r.project_key), Number(r.n)]));
  /** @type {InboxSummary[]} */
  const out = [];
  for (const i of await listInboxRows(db)) {
    const push = (await db.query('SELECT * FROM pushes WHERE project_key = ? ORDER BY at DESC, id LIMIT 1', [i.project_key]))[0];
    out.push(/** @type {InboxSummary} */ (omitAbsent({
      project_key: i.project_key, repo_url: i.repo_url, jira_project_key: i.jira_project_key, issue_type_id: i.issue_type_id,
      open: counts.get(i.project_key) ?? 0,
      last_push: push ? omitAbsent({ run_id: String(push.run_id), at: String(push.at), head_sha: push.head_sha, created: Number(push.created), updated: Number(push.updated) }) : undefined,
    })));
  }
  return out;
}

/** Policy order inside a group (F8): confidence desc, evidence count desc, first seen asc. */
const ORDER = `ORDER BY last_push_at DESC, last_run_id,
  CASE confidence WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, evidence_count DESC, first_seen, id`;

/**
 * `inbox.list` (F8): the items of one status (default `open`), newest push first, grouped by the push that
 * created, grew or reopened them; policy order inside a group. Pages of PAGE_SIZE items; `next` is an opaque
 * offset cursor. A group can continue on the next page under the same `run_id`.
 * @param {Db} db
 * @param {{project_key?: string, status?: string, lens?: string, cursor?: string}} q
 * @returns {Promise<{inboxes: InboxSummary[], groups: InboxGroup[], next?: string}>}
 */
export async function listInbox(db, q) {
  const status = q.status ?? 'open';
  if (!isOneOf(INBOX_STATUSES, status)) throw new AppError('bad-input', `status must be one of ${INBOX_STATUSES.join(', ')}`);
  if (q.lens !== undefined && !isOneOf(LENSES, q.lens)) throw new AppError('bad-input', `lens must be one of ${LENSES.join(', ')}`);
  if (q.cursor !== undefined && !/^(0|[1-9][0-9]{0,8})$/.test(String(q.cursor))) throw new AppError('bad-cursor', 'this inbox cursor was not issued here; reload the inbox');
  const offset = q.cursor === undefined ? 0 : Number(q.cursor);
  const where = ['status = ?'];
  /** @type {unknown[]} */
  const params = [status];
  if (q.project_key) { where.push('project_key = ?'); params.push(q.project_key); }
  if (q.lens) { where.push('lens = ?'); params.push(q.lens); }
  const rows = await db.query(`SELECT * FROM proposals WHERE ${where.join(' AND ')} ${ORDER} LIMIT ${PAGE_SIZE + 1} OFFSET ${offset}`, params);
  const page = rows.slice(0, PAGE_SIZE).map(toProposal);
  const repos = new Map((await listInboxRows(db)).map((i) => [i.project_key, i.repo_url]));
  /** @type {InboxGroup[]} */
  const groups = [];
  for (const p of page) {
    let g = groups[groups.length - 1];
    if (!g || g.run_id !== p.last_run_id) {
      const push = await db.query('SELECT head_sha FROM pushes WHERE project_key = ? AND run_id = ? ORDER BY at DESC LIMIT 1', [p.project_key, p.last_run_id]);
      g = /** @type {InboxGroup} */ (omitAbsent({ run_id: p.last_run_id, at: p.last_push_at, head_sha: push[0]?.head_sha, items: [] }));
      groups.push(g);
    }
    const card = toCard(p, await evidenceOf(db, p.id), repos.get(p.project_key));
    if (p.status === 'open') card.change = p.change_kind;
    g.items.push(card);
  }
  return omitAbsent({ inboxes: await inboxSummaries(db), groups, next: rows.length > PAGE_SIZE ? String(offset + PAGE_SIZE) : undefined });
}

/**
 * `panel.forIssue`: the accepted proposal behind a Jira issue, and its history.
 * @param {import('./ports.mjs').Deps} deps
 * @param {string} issueKey
 * @returns {Promise<{card?: Card, history: import('./types.mjs').HistoryRow[]}>}
 */
export async function panelForIssue(deps, issueKey) {
  const { db } = deps;
  const rows = await db.query('SELECT * FROM proposals WHERE issue_ref = ? ORDER BY id', [issueKey]);
  if (rows.length === 0) return { history: [] };
  const p = toProposal(rows[0]);
  return { card: await cardOf(db, p), history: await withNames(deps, await historyOf(db, p)) };
}

/**
 * `byline.forPage`: open and accepted proposals whose `page` evidence ref or `doc_impact` entry is the page id.
 * @param {Db} db
 * @param {string} pageId
 * @returns {Promise<{count: number, cards: Card[]}>}
 */
export async function bylineForPage(db, pageId) {
  const byEvidence = await db.query(
    "SELECT DISTINCT p.id FROM proposals p JOIN evidence e ON e.proposal_id = p.id WHERE e.type = 'page' AND e.ref = ? AND p.status IN ('open', 'accepted')",
    [pageId],
  );
  // doc_impact lives in record_json; LIKE narrows, the parse below decides.
  // `!` as the LIKE escape: a backslash means different things in MySQL and SQLite string literals.
  const like = `%${JSON.stringify(pageId).replace(/[!%_]/g, (c) => `!${c}`)}%`;
  const byImpact = await db.query("SELECT * FROM proposals WHERE status IN ('open', 'accepted') AND record_json LIKE ? ESCAPE '!'", [like]);
  const ids = new Set(byEvidence.map((r) => Number(r.id)));
  for (const r of byImpact) {
    const p = toProposal(r);
    if (Array.isArray(p.record.doc_impact) && p.record.doc_impact.includes(pageId)) ids.add(p.id);
  }
  /** @type {Card[]} */
  const cards = [];
  for (const id of [...ids].sort((a, b) => a - b)) {
    const rows = await db.query('SELECT * FROM proposals WHERE id = ?', [id]);
    if (rows.length) cards.push(await cardOf(db, toProposal(rows[0])));
  }
  return { count: cards.length, cards };
}
