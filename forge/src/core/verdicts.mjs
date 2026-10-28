// @ts-check
// Triage decisions and the verdict log (F4, F5). One code path for the inbox, the evidence panel and the Rovo
// agent: `via` records which. The log is append-only; the pull returns it oldest first behind a cursor.
//
// Write-back must land (triage-queues, "Verdict write-back"): a decision is a CAS on the proposal row that
// also stamps the decision (reason, note, merged_into, decided_by, decided_at, via), then the verdict row is
// appended. Forge SQL has no multi-statement transaction (ports.mjs), so if the append is lost the stamp is
// the record: `repairVerdicts` rebuilds the missing row before every pull. An accept creates the Jira issue
// FIRST; a Jira failure writes nothing and the item stays open.
import { REASONS, decisionProblem, isOneOf } from '../shared/model.mjs';
import { issueDescription, mergeComment } from './adf.mjs';
import { cardOf, toVerdict } from './cards.mjs';
import { counterValue, findProposal, needInbox, nextCounter, toProposal } from './store.mjs';
import { NOTE_MAX, REF_RE, VERDICT_STATUSES } from './types.mjs';
import { AppError, DuplicateKey, FP_RE, ISSUE_KEY_RE, needStr, optStr, sqlv, str } from './util.mjs';

/**
 * @typedef {import('./ports.mjs').Deps} Deps
 * @typedef {import('./ports.mjs').Db} Db
 * @typedef {import('./store.mjs').ProposalRow} ProposalRow
 * @typedef {import('./types.mjs').Card} Card
 * @typedef {import('./types.mjs').Verdict} Verdict
 * @typedef {import('./types.mjs').Via} Via
 * @typedef {import('./types.mjs').VerdictStatus} VerdictStatus
 * @typedef {{by: string, via: Via}} Decider  `by` = `forge:<accountId>`
 */

/** Max verdicts per pull. */
export const PULL_MAX = 200;
/** How long a verdict seq may stay unwritten before the pull skips the gap / a stamp is repaired (ms). */
export const GRACE_MS = 60_000;
/** An accept claim older than this is abandoned (the function died between the claim and the Jira call). */
export const CLAIM_MS = 120_000;

/** @param {string} accountId @returns {string} */
export const deciderOf = (accountId) => `forge:${accountId}`;

/**
 * An optional decision note: trimmed, absent when empty, at most NOTE_MAX characters.
 * @param {unknown} v
 * @returns {string | undefined}
 */
function noteOf(v) {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new AppError('bad-input', 'note must be a string');
  const n = v.trim();
  if (n.length > NOTE_MAX) throw new AppError('bad-input', `note is longer than ${NOTE_MAX} characters`);
  return n || undefined;
}

/** @param {string} projectKey */
const seqName = (projectKey) => `seq:${projectKey}`;

/**
 * Appends the verdict row for a decision stamped on `p`, unless that decision is already logged.
 * @param {Db} db
 * @param {ProposalRow} p  the row after the decision CAS (status, stamp, issue fields)
 * @returns {Promise<void>}
 */
async function appendVerdict(db, p) {
  if (!p.decided_at || !p.decided_by || !isOneOf(VERDICT_STATUSES, p.status)) return;
  const have = await db.query('SELECT seq FROM verdicts WHERE project_key = ? AND fp = ? AND decided_at = ?', [p.project_key, p.fp, p.decided_at]);
  if (have.length) return;
  const seq = await nextCounter(db, seqName(p.project_key));
  try {
    await db.exec(
      `INSERT INTO verdicts (seq, project_key, fp, status, reason, note, merged_into, decided_by, decided_at, external_ref, issue_ref, issue_url, via)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [seq, p.project_key, p.fp, p.status, sqlv(p.reason), sqlv(p.note), sqlv(p.merged_into), p.decided_by, p.decided_at, p.ref,
        p.status === 'accepted' ? sqlv(p.issue_ref) : null, p.status === 'accepted' ? sqlv(p.issue_url) : null, p.via ?? 'inbox'],
    );
  } catch (e) {
    if (!(e instanceof DuplicateKey)) throw e; // logged concurrently; this seq stays a gap the pull steps over
  }
}

/**
 * Rebuilds verdict rows whose decision is stamped on a proposal but never landed in the log (older than
 * GRACE_MS, so a decision still being written is left alone).
 * @param {Db} db
 * @param {string} projectKey
 * @param {Date} now
 * @returns {Promise<number>} rows rebuilt
 */
export async function repairVerdicts(db, projectKey, now) {
  const before = new Date(now.getTime() - GRACE_MS).toISOString();
  const rows = await db.query(
    `SELECT * FROM proposals p WHERE p.project_key = ? AND p.status IN ('accepted', 'rejected', 'snoozed', 'merged')
      AND p.decided_at IS NOT NULL AND p.decided_at < ?
      AND NOT EXISTS (SELECT 1 FROM verdicts v WHERE v.project_key = p.project_key AND v.fp = p.fp AND v.decided_at = p.decided_at)
      ORDER BY p.decided_at`,
    [projectKey, before],
  );
  for (const r of rows) await appendVerdict(db, toProposal(r));
  return rows.length;
}

/**
 * The decision CAS: `open` -> `to`, with the stamp; then the verdict row. Fails with `bad-input` when the item
 * is no longer open (someone else decided first).
 * @param {Deps} deps
 * @param {ProposalRow} p
 * @param {{to: VerdictStatus, reason?: string, note?: string, merged_into?: string, issue_ref?: string, issue_url?: string, claim?: string}} d
 * @param {Decider} who
 * @returns {Promise<ProposalRow>}
 */
async function decide(deps, p, d, who) {
  const { db } = deps;
  let at = deps.now().toISOString();
  if (p.decided_at && at <= p.decided_at) at = new Date(Date.parse(p.decided_at) + 1).toISOString(); // unique per fp
  return db.tx(async () => {
    const r = await db.exec(
      `UPDATE proposals SET status = ?, reason = ?, note = ?, merged_into = ?, decided_by = ?, decided_at = ?, via = ?,
        issue_ref = ?, issue_url = ?, reopened = 0, refs_at_status = ?, types_at_status = ?, accept_claim = NULL
        WHERE id = ? AND status = 'open'${d.claim ? ' AND accept_claim = ?' : ''}`,
      [d.to, sqlv(d.reason), sqlv(d.note), sqlv(d.merged_into), who.by, at, who.via,
        sqlv(d.issue_ref ?? p.issue_ref), sqlv(d.issue_url ?? p.issue_url), p.evidence_count, p.evidence_types.join(','),
        p.id, ...(d.claim ? [d.claim] : [])],
    );
    if (r.affectedRows !== 1) {
      const now = toProposal((await db.query('SELECT * FROM proposals WHERE id = ?', [p.id]))[0]);
      throw new AppError('bad-input', `${p.ref} is ${now.status}, not open; reload it`);
    }
    const after = toProposal((await db.query('SELECT * FROM proposals WHERE id = ?', [p.id]))[0]);
    try {
      await appendVerdict(db, after);
    } catch (e) {
      // The decision is stamped on the row; repairVerdicts appends it before the next pull.
      console.warn(`dowser: verdict for ${p.ref} not logged yet (${/** @type {Error} */ (e).message}); the next pull repairs it`);
    }
    return after;
  });
}

/** @param {ProposalRow} p */
const needOpen = (p) => {
  if (p.status !== 'open') throw new AppError('bad-input', `${p.ref} is ${p.status}, not open`);
};

/**
 * Accept (F5): create the Jira issue as the app, then record status + verdict. An item already accepted
 * returns its card (and issue) unchanged.
 * @param {Deps} deps
 * @param {{ref: string, jira_project_key?: string, issue_type_id?: string, note?: unknown}} args
 * @param {Decider} who
 * @returns {Promise<{card: Card}>}
 */
export async function accept(deps, args, who) {
  const { db, links } = deps;
  if (!deps.jira) throw new AppError('unavailable', 'Jira is not reachable from this module');
  const note = noteOf(args.note);
  const p = await findProposal(db, needStr(args, 'ref'));
  if (p.status === 'accepted') return { card: await cardOf(db, p) };
  needOpen(p);
  const inbox = await needInbox(db, p.project_key);
  const projectKey = optStr(args, 'jira_project_key') ?? inbox.jira_project_key;
  const issueTypeId = optStr(args, 'issue_type_id') ?? inbox.issue_type_id;
  if (!projectKey || !issueTypeId) {
    throw new AppError('bad-input', `choose the Jira project and issue type for ${p.project_key} in Dowser settings, or pass them with the accept`);
  }

  // Claim the accept so a double click or a second agent cannot create two issues.
  const now = deps.now();
  const claim = now.toISOString();
  const stale = new Date(now.getTime() - CLAIM_MS).toISOString();
  const c = await db.exec("UPDATE proposals SET accept_claim = ? WHERE id = ? AND status = 'open' AND (accept_claim IS NULL OR accept_claim < ?)", [claim, p.id, stale]);
  if (c.affectedRows !== 1) {
    const cur = await findProposal(db, p.ref);
    if (cur.status === 'accepted') return { card: await cardOf(db, cur) };
    if (cur.status !== 'open') needOpen(cur);
    throw new AppError('bad-input', `an accept of ${p.ref} is already in progress; reload in a minute`);
  }

  const card = await cardOf(db, p);
  /** @type {{key: string, url: string}} */
  let issue;
  try {
    issue = await deps.jira.createIssue({ projectKey, issueTypeId, summary: card.title, description: issueDescription(card, await links.inboxUrl(p.ref)) });
  } catch (e) {
    await db.exec('UPDATE proposals SET accept_claim = NULL WHERE id = ? AND accept_claim = ?', [p.id, claim]);
    throw new AppError('unavailable', `Jira did not create the issue (${/** @type {Error} */ (e).message}); ${p.ref} stays open`);
  }
  try {
    const after = await decide(deps, p, { to: 'accepted', note, issue_ref: issue.key, issue_url: issue.url, claim }, who);
    return { card: await cardOf(db, after) };
  } catch (e) {
    if (e instanceof AppError) throw new AppError(e.code, `${e.message}. Jira issue ${issue.key} was created; link or delete it by hand`);
    throw e;
  }
}

/**
 * Resolves `refs` and checks every one is open before deciding any (a bulk decision is all-or-nothing up front).
 * @param {Db} db
 * @param {unknown} refs
 * @returns {Promise<ProposalRow[]>}
 */
async function openItems(db, refs) {
  if (!Array.isArray(refs) || refs.length === 0 || !refs.every(str)) throw new AppError('bad-input', 'refs must be a non-empty array of inbox refs');
  if (refs.length > 200) throw new AppError('bad-input', 'at most 200 refs per call');
  const items = [];
  for (const r of new Set(refs)) {
    const p = await findProposal(db, r);
    needOpen(p);
    items.push(p);
  }
  return items;
}

/**
 * Applies one decision to many items; a failure part-way names what landed.
 * @param {Deps} deps
 * @param {ProposalRow[]} items
 * @param {Parameters<typeof decide>[2]} d
 * @param {Decider} who
 * @returns {Promise<{cards: Card[]}>}
 */
async function decideAll(deps, items, d, who) {
  /** @type {Card[]} */
  const cards = [];
  for (const p of items) {
    try {
      cards.push(await cardOf(deps.db, await decide(deps, p, d, who)));
    } catch (e) {
      if (!cards.length || !(e instanceof AppError)) throw e;
      throw new AppError(e.code, `${e.message}; already ${d.to}: ${cards.map((c) => c.ref).join(', ')}`);
    }
  }
  return { cards };
}

/**
 * Reject one or more items with a closed reason (`other` needs a note).
 * @param {Deps} deps
 * @param {{refs: unknown, reason?: unknown, note?: unknown}} args
 * @param {Decider} who
 * @returns {Promise<{cards: Card[]}>}
 */
export async function reject(deps, args, who) {
  const reason = typeof args.reason === 'string' ? args.reason : undefined;
  const note = noteOf(args.note);
  if (!isOneOf(REASONS, reason)) throw new AppError('bad-input', `reason must be one of ${REASONS.join(', ')}`);
  const problem = decisionProblem({ to: 'rejected', reason, note });
  if (problem) throw new AppError('bad-input', problem.replace(/--/g, ''));
  return decideAll(deps, await openItems(deps.db, args.refs), { to: 'rejected', reason, note }, who);
}

/**
 * Snooze one or more items; any new evidence key reopens them (F3).
 * @param {Deps} deps
 * @param {{refs: unknown, note?: unknown}} args
 * @param {Decider} who
 * @returns {Promise<{cards: Card[]}>}
 */
export async function snooze(deps, args, who) {
  const note = noteOf(args.note);
  return decideAll(deps, await openItems(deps.db, args.refs), { to: 'snoozed', note }, who);
}

/**
 * Merge an item into another inbox item (`into` = DW ref or fp -> `merged_into` = its fp) or into an existing
 * Jira issue (`into` = issue key -> a comment with the evidence is added first, `merged_into` = the key).
 * @param {Deps} deps
 * @param {{ref: unknown, into: unknown}} args
 * @param {Decider} who
 * @returns {Promise<{card: Card}>}
 */
export async function merge(deps, args, who) {
  const { db } = deps;
  const p = await findProposal(db, needStr(args, 'ref'));
  const into = needStr(args, 'into');
  needOpen(p);
  // A DW ref or fp names an inbox item, even when it also looks like a Jira key (`DW-3`).
  if (!REF_RE.test(into) && !FP_RE.test(into) && ISSUE_KEY_RE.test(into)) {
    if (!deps.jira) throw new AppError('unavailable', 'Jira is not reachable from this module');
    const card = await cardOf(db, p);
    try {
      await deps.jira.addComment(into, mergeComment(card, await deps.links.inboxUrl(p.ref)));
    } catch (e) {
      throw new AppError('unavailable', `Jira did not take the comment on ${into} (${/** @type {Error} */ (e).message}); ${p.ref} stays open`);
    }
    return { card: await cardOf(db, await decide(deps, p, { to: 'merged', merged_into: into }, who)) };
  }
  const target = await findProposal(db, into);
  if (target.id === p.id) throw new AppError('bad-input', 'an item cannot be merged into itself');
  if (target.project_key !== p.project_key) throw new AppError('bad-input', `${target.ref} is in another inbox (${target.project_key})`);
  if (target.status === 'merged') throw new AppError('bad-input', `${target.ref} is itself merged; merge into the item it was merged into`);
  return { card: await cardOf(db, await decide(deps, p, { to: 'merged', merged_into: target.fp }, who)) };
}

/**
 * The Rovo `dowser_verdict_record` action and any single-item decision by status.
 * @param {Deps} deps
 * @param {{ref: unknown, status: unknown, reason?: unknown, note?: unknown, merged_into?: unknown}} args
 * @param {Decider} who
 * @returns {Promise<{card: Card}>}
 */
export async function record(deps, args, who) {
  const ref = needStr(args, 'ref');
  switch (args.status) {
    case 'accepted': return accept(deps, { ref, note: args.note }, who);
    case 'rejected': return { card: (await reject(deps, { refs: [ref], reason: args.reason, note: args.note }, who)).cards[0] };
    case 'snoozed': return { card: (await snooze(deps, { refs: [ref], note: args.note }, who)).cards[0] };
    case 'merged': return merge(deps, { ref, into: args.merged_into }, who);
    default: throw new AppError('bad-input', `status must be one of ${VERDICT_STATUSES.join(', ')}`);
  }
}

/**
 * `dowser_verdicts_pull` (F4): verdicts with seq > cursor, oldest first, at most PULL_MAX. The cursor is the last
 * seq returned (decimal string), or the given cursor (`"0"` on an empty first pull) when nothing is new. A
 * verdict seq that is allocated but not yet written stops the page there, so a late row is never skipped; a
 * gap older than GRACE_MS is an abandoned allocation and is stepped over.
 * @param {Deps} deps
 * @param {Record<string, unknown>} args
 * @returns {Promise<import('./types.mjs').PullOutput>}
 */
export async function pullVerdicts(deps, args) {
  const { db } = deps;
  const projectKey = needStr(args, 'project_key');
  const raw = args.cursor;
  if (raw !== undefined && raw !== null && (typeof raw !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(raw))) {
    throw new AppError('bad-cursor', `cursor ${JSON.stringify(raw)} was not issued by this server; pull again without it`);
  }
  await needInbox(db, projectKey);
  const now = deps.now();
  await repairVerdicts(db, projectKey, now);
  const after = typeof raw === 'string' ? Number(raw) : 0;
  if (after > await counterValue(db, seqName(projectKey))) {
    throw new AppError('bad-cursor', `cursor ${raw} is beyond this inbox's verdict log; pull again without it`);
  }
  const rows = await db.query(`SELECT * FROM verdicts WHERE project_key = ? AND seq > ? ORDER BY seq LIMIT ${PULL_MAX}`, [projectKey, after]);
  const settled = new Date(now.getTime() - GRACE_MS).toISOString();
  /** @type {Verdict[]} */
  const verdicts = [];
  let last = after;
  for (const r of rows) {
    const seq = Number(r.seq);
    if (seq !== last + 1 && String(r.decided_at) > settled) break; // a younger gap: an earlier verdict may still land
    verdicts.push(toVerdict(r));
    last = seq;
  }
  return { verdicts, cursor: String(last) };
}

