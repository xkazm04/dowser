// @ts-check
// The card the Custom UI and the Rovo agent read: the stored proposal record plus inbox state and its evidence
// with links (F2). Read-side queries: the inbox (F8 run-diff groups), one card, the panel, the byline.
import { parseRef } from '../shared/fingerprint.mjs';
import { areasOfProposal } from './areas.mjs';
import { withNames } from './names.mjs';
import { evidenceOf, evidenceOfMany, evidenceRefsOfMany, findProposal, getInbox, isSampleKey, itemScope, listInboxRows, toProposal } from './store.mjs';
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
 * @typedef {import('./types.mjs').CardDelta} CardDelta
 * @typedef {import('./types.mjs').CardDecision} CardDecision
 * @typedef {import('./types.mjs').Verdict} Verdict
 * @typedef {import('./types.mjs').InboxGroup} InboxGroup
 * @typedef {import('./types.mjs').InboxSummary} InboxSummary
 * @typedef {import('./types.mjs').InboxStatus} InboxStatus
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
 * Why an open card is back (F3, F8), from the rows already read: which of its evidence rows are new, and the delta.
 * Reopened: the rows added after the decision (`added_at > decided_at`), and the decision as the row still holds it;
 * the row says `open` now, so the prior status is derived from the stamp (a reason means rejected, else snoozed: only
 * those two reopen). Grew: the rows of the push that grew it (`added_run_id = last_run_id`, a run after the first).
 * A card first seen in its push, and every decided card, has no delta.
 * @param {ProposalRow} p
 * @param {EvidenceRow[]} evidence
 * @returns {{delta?: CardDelta, isNew: (e: EvidenceRow) => boolean}}
 */
export function deltaOf(p, evidence) {
  const none = { isNew: () => false };
  if (p.status !== 'open') return none;
  if (p.change_kind === 'reopened' && p.decided_at) {
    const since = p.decided_at;
    const isNew = (/** @type {EvidenceRow} */ e) => e.added_at > since;
    const decision = /** @type {CardDecision} */ (omitAbsent({
      status: p.reason ? 'rejected' : 'snoozed', reason: p.reason, note: p.note, decided_by: p.decided_by, decided_at: p.decided_at,
      snooze_until: p.reason ? undefined : p.snooze_until,
    }));
    return { delta: { since: 'decision', new_evidence: evidence.filter(isNew).length, decision }, isNew };
  }
  if (p.change_kind === 'grew' && p.last_run_id !== p.first_run_id) {
    const isNew = (/** @type {EvidenceRow} */ e) => e.added_run_id === p.last_run_id;
    const n = evidence.filter(isNew).length;
    if (n > 0) return { delta: { since: 'previous-push', new_evidence: n }, isNew };
  }
  return none;
}

/**
 * @param {ProposalRow} p
 * @param {EvidenceRow[]} evidence
 * @param {string | undefined} repoUrl
 * @returns {Card}
 */
export function toCard(p, evidence, repoUrl) {
  const { delta, isNew } = deltaOf(p, evidence);
  return /** @type {Card} */ (omitAbsent({
    ...p.record,
    fp: p.fp, ref: p.ref, status: p.status, project_key: p.project_key,
    evidence: evidence.map((e) => (isNew(e) ? { ...cardEvidence(e, repoUrl), new: true } : cardEvidence(e, repoUrl))),
    delta,
    reopened: p.reopened || undefined,
    issue_ref: p.issue_ref, issue_url: p.issue_url,
    reason: p.reason, note: p.note, merged_into: p.merged_into, decided_by: p.decided_by, decided_at: p.decided_at,
    snooze_until: p.status === 'snoozed' ? p.snooze_until : undefined,
    first_seen: p.first_seen, last_push_at: p.last_push_at,
    // The source owns the sample predicate: every card of the sample inbox says so, from the server.
    sample: isSampleKey(p.project_key) || undefined,
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
  issue_ref: r.issue_ref, issue_url: r.issue_url, snooze_until: r.snooze_until,
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
 * The inbox summaries (settings, the inbox header and its empty state): target settings, the open count, the
 * count per status (`by_status`, every status present: a zero is a count, not an absence) and the newest push
 * (`last_push`), whatever status the inbox is filtered to. `visible` (core/access.mjs) limits it to those inboxes;
 * the dispatch door always passes it.
 * @param {Db} db
 * @param {string[]} [visible]
 * @param {import('./store.mjs').InboxRow[]} [inboxRows]  every inbox row, when the caller has read them already
 * @returns {Promise<InboxSummary[]>}
 */
export async function inboxSummaries(db, visible, inboxRows) {
  /** @returns {Record<InboxStatus, number>} */
  const zero = () => /** @type {any} */ (Object.fromEntries(INBOX_STATUSES.map((s) => [s, 0])));
  /** @type {Map<string, Record<string, number>>} */
  const counts = new Map();
  for (const r of await db.query('SELECT project_key, status, COUNT(*) AS n FROM proposals GROUP BY project_key, status')) {
    const by = /** @type {Record<string, number>} */ (counts.get(String(r.project_key)) ?? zero());
    counts.set(String(r.project_key), by);
    if (String(r.status) in by) by[String(r.status)] = Number(r.n);
  }
  /** @type {InboxSummary[]} */
  const out = [];
  for (const i of inboxRows ?? await listInboxRows(db)) {
    if (visible && !visible.includes(i.project_key)) continue;
    const push = (await db.query('SELECT * FROM pushes WHERE project_key = ? ORDER BY at DESC, id LIMIT 1', [i.project_key]))[0];
    const sample = isSampleKey(i.project_key);
    out.push(/** @type {InboxSummary} */ (omitAbsent({
      project_key: i.project_key, repo_url: i.repo_url, jira_project_key: i.jira_project_key, issue_type_id: i.issue_type_id,
      open: counts.get(i.project_key)?.open ?? 0,
      by_status: counts.get(i.project_key) ?? zero(),
      last_push: push ? omitAbsent({ run_id: String(push.run_id), at: String(push.at), head_sha: push.head_sha, created: Number(push.created), updated: Number(push.updated) }) : undefined,
      sample: sample || undefined,
      // What the sample is a scan of: the repo and commit its evidence links point at, and when that scan ran.
      source: sample && push ? omitAbsent({ repo_url: push.repo_url ?? i.repo_url, head_sha: push.head_sha, scanned_at: push.scanned_at }) : undefined,
    })));
  }
  return out;
}

/**
 * Policy order inside a group (F8, scan-finding/1): each lens's MVP first, then ranked before reserve, then the
 * producer's stored `score` desc with unscored cards after every scored one (the inbox never recomputes a score),
 * then the older tie-breakers: confidence desc, evidence count desc, first seen asc. Cards pushed before v019 have no
 * score, band or mvp and keep the old order among themselves.
 */
const ORDER = `ORDER BY last_push_at DESC, last_run_id,
  CASE WHEN mvp = 1 THEN 0 ELSE 1 END, CASE WHEN band = 'reserve' THEN 1 ELSE 0 END, CASE WHEN score IS NULL THEN 1 ELSE 0 END, score DESC,
  CASE confidence WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, evidence_count DESC, first_seen, id`;

/**
 * `inbox.list` (F8): the items of one status (default `open`), newest push first, grouped by the push that
 * created, grew or reopened them; policy order inside a group. Pages of PAGE_SIZE items; `next` is an opaque
 * offset cursor. A group can continue on the next page under the same `run_id`. `visible` (core/access.mjs)
 * limits the items and the summaries to those inboxes; the dispatch door always passes it. `pretriaged: true`
 * keeps only the cards the skill's L1 trust gate pre-triaged (`pretriaged_by` set). `area` (with `project_key`) keeps
 * the cards that count in that map area (`inArea`), so a map cell links to exactly what it counts.
 * @param {Db} db
 * @param {{project_key?: string, status?: string, lens?: string, area?: string, cursor?: string, pretriaged?: boolean, visible?: string[]}} q
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
  if (q.pretriaged) where.push('pretriaged_by IS NOT NULL');
  if (q.visible && !q.visible.length) return { inboxes: [], groups: [] };
  /** @type {import('./store.mjs').InboxRow[] | undefined} */
  let inboxRows;
  const allInboxes = async () => (inboxRows ??= await listInboxRows(db));
  // All inboxes (no project_key): the sample's items stay out of the aggregate unless it is all there is
  // (store.mjs itemScope); its summary still comes back in `inboxes`.
  const scope = q.project_key ? q.visible : itemScope(q.visible ?? (await allInboxes()).map((i) => i.project_key));
  if (scope) {
    where.push(`project_key IN (${scope.map(() => '?').join(', ')})`);
    params.push(...scope);
  }
  const rows = q.area === undefined
    ? await db.query(`SELECT * FROM proposals WHERE ${where.join(' AND ')} ${ORDER} LIMIT ${PAGE_SIZE + 1} OFFSET ${offset}`, params)
    : (await inArea(db, q.project_key ?? '', q.area, await db.query(`SELECT * FROM proposals WHERE ${where.join(' AND ')} ${ORDER}`, params)))
      .slice(offset, offset + PAGE_SIZE + 1);
  const page = rows.slice(0, PAGE_SIZE).map(toProposal);
  const repos = new Map((await allInboxes()).map((i) => [i.project_key, i.repo_url]));
  // One read each for the page: the evidence of its cards, and the head of the push behind each of its groups.
  const evidence = await evidenceOfMany(db, page);
  /** @type {ProposalRow[]} */
  const starts = page.filter((p, k) => k === 0 || page[k - 1].last_run_id !== p.last_run_id);
  const heads = await pushHeads(db, starts);
  /** @type {InboxGroup[]} */
  const groups = [];
  for (const p of page) {
    let g = groups[groups.length - 1];
    if (!g || g.run_id !== p.last_run_id) {
      g = /** @type {InboxGroup} */ (omitAbsent({ run_id: p.last_run_id, at: p.last_push_at, head_sha: heads.get(`${p.project_key}
${p.last_run_id}`), items: [] }));
      groups.push(g);
    }
    const card = toCard(p, evidence.get(p.id) ?? [], repos.get(p.project_key));
    if (p.status === 'open') card.change = p.change_kind;
    g.items.push(card);
  }
  return omitAbsent({ inboxes: await inboxSummaries(db, q.visible, await allInboxes()), groups, next: rows.length > PAGE_SIZE ? String(offset + PAGE_SIZE) : undefined });
}

/**
 * The head_sha of the newest push of each (project_key, run_id) the proposals name, in one read: key
 * `<project_key>
<run_id>`; a run without a push row, or a push without head_sha, is absent.
 * @param {Db} db
 * @param {ProposalRow[]} ps
 * @returns {Promise<Map<string, string>>}
 */
async function pushHeads(db, ps) {
  /** @type {Map<string, string>} */
  const out = new Map();
  if (ps.length === 0) return out;
  const keys = [...new Set(ps.map((p) => p.project_key))];
  const runs = [...new Set(ps.map((p) => p.last_run_id))];
  const wanted = new Set(ps.map((p) => `${p.project_key}
${p.last_run_id}`));
  /** @type {Set<string>} */
  const seen = new Set();
  const rows = await db.query(
    `SELECT project_key, run_id, head_sha FROM pushes WHERE project_key IN (${keys.map(() => '?').join(', ')}) AND run_id IN (${runs.map(() => '?').join(', ')}) ORDER BY at DESC`,
    [...keys, ...runs],
  );
  for (const r of rows) {
    const k = `${r.project_key}
${r.run_id}`;
    if (!wanted.has(k) || seen.has(k)) continue;
    seen.add(k); // the newest push of the run decides, with or without a head_sha
    if (r.head_sha !== null && r.head_sha !== undefined) out.set(k, String(r.head_sha));
  }
  return out;
}

/**
 * The rows that count in `area` of the inbox, by the mapping `map.data` counts with (core/areas.mjs), order kept.
 * An area path the inbox has not pushed keeps nothing. The area filter pages in memory: an inbox holds hundreds
 * of proposals, not millions, and the mapping (longest area prefix of each touched path) is not SQL.
 * @param {Db} db @param {string} projectKey @param {string} area @param {Row[]} rows
 */
async function inArea(db, projectKey, area, rows) {
  const areaPaths = (await db.query('SELECT path FROM areas WHERE project_key = ?', [projectKey])).map((r) => String(r.path));
  if (!areaPaths.includes(area)) return [];
  const ps = rows.map(toProposal);
  const refs = await evidenceRefsOfMany(db, ps);
  return rows.filter((_, k) => areasOfProposal(ps[k].record, refs.get(ps[k].id) ?? [], areaPaths).has(area));
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
 * `byline.forPage`: open and accepted proposals whose `page` evidence ref or `doc_impact` entry is the page id,
 * from the `visible` inboxes only (core/access.mjs; the dispatch door always passes it).
 * @param {Db} db
 * @param {string} pageId
 * @param {string[]} [visible]
 * @returns {Promise<{count: number, cards: Card[]}>}
 */
export async function bylineForPage(db, pageId, visible) {
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
  // A page byline spans every inbox: the sample's cards stay out unless it is the only inbox visible (itemScope).
  const scope = itemScope(visible ?? (await listInboxRows(db)).map((i) => i.project_key));
  for (const id of [...ids].sort((a, b) => a - b)) {
    const rows = await db.query('SELECT * FROM proposals WHERE id = ?', [id]);
    if (rows.length && scope.includes(String(rows[0].project_key))) cards.push(await cardOf(db, toProposal(rows[0])));
  }
  return { count: cards.length, cards };
}
