// @ts-check
// Triage decisions and the verdict log (F4, F5). One code path for the inbox, the Rovo agent and a delegate's
// tool: `via` records which. The log is append-only; the pull returns it oldest first behind a cursor.
//
// Write-back must land (triage-queues, "Verdict write-back"): a decision is a CAS on the proposal row that
// also stamps the decision (reason, note, merged_into, decided_by, decided_at, via), then the verdict row is
// appended. Forge SQL has no multi-statement transaction (ports.mjs), so if the append is lost the stamp is
// the record: `repairVerdicts` rebuilds the missing row before every pull. An accept creates the Jira issue
// FIRST; a Jira failure writes nothing and the item stays open.
import { REASONS, decisionProblem, isOneOf } from '../shared/model.mjs';
import { issueDescription, mergeComment } from './adf.mjs';
import { cardOf, toCard, toVerdict } from './cards.mjs';
import { delegateName } from './names.mjs';
import { writeIssueProperty } from './issue-property.mjs';
import { counterValue, evidenceOfMany, findProposal, inboxRowsByKey, insertMany, isSampleKey, needInbox, nextCounter, nextCounterBlock, proposalsMatching, toProposal } from './store.mjs';
import { DELEGATE_KIND, DELEGATE_LABEL, NOTE_MAX, REF_RE, SAMPLE_LABEL, VERDICT_STATUSES } from './types.mjs';
import { AppError, DuplicateKey, FP_RE, errTag, ISSUE_KEY_RE, isSchemaBehind, needStr, optStr, sqlv, str } from './util.mjs';

/**
 * @typedef {import('./ports.mjs').Deps} Deps
 * @typedef {import('./ports.mjs').Db} Db
 * @typedef {import('./store.mjs').ProposalRow} ProposalRow
 * @typedef {import('./types.mjs').Card} Card
 * @typedef {import('./types.mjs').Verdict} Verdict
 * @typedef {import('./types.mjs').Via} Via
 * @typedef {import('./types.mjs').VerdictStatus} VerdictStatus
 * @typedef {{by: string, via: Via}} Decider  `by` = `forge:<accountId>`, or `delegate:<name>` for a delegate (core/delegate.mjs)
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
 * The answer to a create Jira refused. When the adapter kept the refused field keys (`fields`, a 400's `errors`
 * keys, never their values), it names them and the next step; otherwise only the status.
 * @param {unknown} e @param {string} ref
 */
function refusedCreate(e, ref) {
  const fields = /** @type {any} */ (e)?.fields;
  const named = Array.isArray(fields) ? fields.filter((f) => typeof f === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(f)) : [];
  if (!named.length) return `Jira did not create the issue (${errTag(e)}); ${ref} stays open`;
  return `Jira did not create the issue (${errTag(e)}; refused fields: ${named.join(', ')}); ${ref} stays open. `
    + 'Choose another project or issue type, or ask a Jira admin about those fields.';
}

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
      `INSERT INTO verdicts (seq, project_key, fp, status, reason, note, merged_into, decided_by, decided_at, external_ref, issue_ref, issue_url, via, snooze_until)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [seq, p.project_key, p.fp, p.status, sqlv(p.reason), sqlv(p.note), sqlv(p.merged_into), p.decided_by, p.decided_at, p.ref,
        p.status === 'accepted' ? sqlv(p.issue_ref) : null, p.status === 'accepted' ? sqlv(p.issue_url) : null, p.via ?? 'inbox',
        p.status === 'snoozed' ? sqlv(p.snooze_until) : null],
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
 * @param {{to: VerdictStatus, reason?: string, note?: string, merged_into?: string, issue_ref?: string, issue_url?: string, claim?: string, snooze_until?: string}} d
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
        issue_ref = ?, issue_url = ?, reopened = 0, refs_at_status = ?, types_at_status = ?, accept_claim = NULL, snooze_until = ?
        WHERE id = ? AND status = 'open'${d.claim ? ' AND accept_claim = ?' : ''}`,
      [d.to, sqlv(d.reason), sqlv(d.note), sqlv(d.merged_into), who.by, at, who.via,
        sqlv(d.issue_ref ?? p.issue_ref), sqlv(d.issue_url ?? p.issue_url), p.evidence_count, p.evidence_types.join(','), sqlv(d.snooze_until),
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
      console.warn(`dowser: verdict for ${p.ref} not logged yet (${errTag(e)}); the next pull repairs it`);
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
 *
 * One accepted card maps to one Jira issue, even across failures. The issue key is stamped on the claimed row
 * (`issue_ref`, `issue_url`, status still `open`) as soon as Jira answers, before the decision is recorded. If the
 * record step then fails (a SQL error, or the invocation is cut), the answer names the issue, and the next accept
 * finds the stamp and finishes the record instead of creating a second issue. Only a failure between Jira's answer
 * and the stamp itself can still orphan an issue, and that answer names it too.
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
  // An open item that already carries an issue: an earlier accept created it and did not get to record it.
  const made = p.issue_ref && p.issue_url ? { key: p.issue_ref, url: p.issue_url } : undefined;
  const inbox = await needInbox(db, p.project_key);
  const projectKey = optStr(args, 'jira_project_key') ?? inbox.jira_project_key;
  const issueTypeId = optStr(args, 'issue_type_id') ?? inbox.issue_type_id;
  if (!made && (!projectKey || !issueTypeId)) {
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

  /** @type {{key: string, url: string}} */
  let issue;
  if (made) {
    issue = made;
  } else {
    const card = await cardOf(db, p);
    // A sample card's issue is real but marked: the label and an opening line say it came from sample data. A
    // delegate's accept is labelled too, so Jira shows which issues no person accepted, and its description opens
    // with a line naming the delegate: the adapter drops labels when a project's create screen refuses them.
    const sample = isSampleKey(p.project_key);
    const delegate = who.by.startsWith(`${DELEGATE_KIND}:`) ? delegateName(who.by) : undefined;
    const labels = [...(sample ? [SAMPLE_LABEL] : []), ...(delegate ? [DELEGATE_LABEL] : [])];
    try {
      issue = await deps.jira.createIssue({
        projectKey: /** @type {string} */ (projectKey), issueTypeId: /** @type {string} */ (issueTypeId), summary: card.title,
        description: issueDescription(card, await links.inboxUrl(p.ref), { sample, delegate }),
        ...(labels.length ? { labels } : {}),
      });
    } catch (e) {
      await db.exec('UPDATE proposals SET accept_claim = NULL WHERE id = ? AND accept_claim = ?', [p.id, claim]);
      throw new AppError('unavailable', refusedCreate(e, p.ref));
    }
    try {
      await db.exec("UPDATE proposals SET issue_ref = ?, issue_url = ? WHERE id = ? AND status = 'open' AND accept_claim = ?", [issue.key, issue.url, p.id, claim]);
    } catch (e) {
      // Not stamped: the claim stays (released only by age), so a quick retry cannot create a second issue either.
      throw new AppError('unavailable', `Dowser did not record the accept of ${p.ref} (${errTag(e)}). Jira issue ${issue.key} was created; link or delete it by hand`);
    }
  }
  try {
    const after = await decide(deps, p, { to: 'accepted', note, issue_ref: issue.key, issue_url: issue.url, claim }, who);
    await writeIssueProperty(deps, after, issue.key, 'accepted'); // best effort: logged, backfilled daily
    return { card: await cardOf(db, after) };
  } catch (e) {
    if (e instanceof AppError) throw new AppError(e.code, `${e.message}. Jira issue ${issue.key} was created; link or delete it by hand`);
    // Stamped: release the claim so accepting again finishes the record with this issue, now.
    await db.exec('UPDATE proposals SET accept_claim = NULL WHERE id = ? AND accept_claim = ?', [p.id, claim]).catch(() => undefined);
    if (isSchemaBehind(e)) throw e; // the entry point migrates and retries the call, which finds the stamp
    throw new AppError('unavailable', `Dowser did not record the accept of ${p.ref} (${errTag(e)}). Jira issue ${issue.key} was created and is kept on the item: accept it again to finish, and no second issue is created`);
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
  const found = await proposalsMatching(db, refs);
  /** @type {Map<number, ProposalRow>} */
  const items = new Map();
  for (const ref of refs) {
    const r = ref.trim();
    const rows = found.get(r) ?? [];
    if (rows.length === 0) throw new AppError('bad-input', `no Dowser proposal ${r}`);
    if (rows.length > 1) throw new AppError('bad-input', `fingerprint ${r} is in more than one inbox; use its DW ref`);
    needOpen(rows[0]);
    items.set(rows[0].id, rows[0]);
  }
  return [...items.values()];
}

/** The verdicts table's columns, in the order `appendVerdicts` writes them. */
const VERDICT_COLS = ['seq', 'project_key', 'fp', 'status', 'reason', 'note', 'merged_into', 'decided_by', 'decided_at', 'external_ref',
  'issue_ref', 'issue_url', 'via', 'snooze_until'];

/**
 * Appends the verdict rows of decisions just stamped on `after` (one decision, so one `decided_at`): per inbox, one
 * read of what is logged already, one block of seqs and one multi-row INSERT. Best effort as in `decide`: a failure
 * is logged and `repairVerdicts` appends the missing rows before the next pull.
 * @param {Db} db
 * @param {ProposalRow[]} after
 */
async function appendVerdicts(db, after) {
  /** @type {Map<string, ProposalRow[]>} */
  const byInbox = new Map();
  for (const p of after) byInbox.set(p.project_key, [...(byInbox.get(p.project_key) ?? []), p]);
  for (const [projectKey, ps] of byInbox) {
    try {
      const at = /** @type {string} */ (ps[0].decided_at);
      const have = new Set((await db.query(`SELECT fp FROM verdicts WHERE project_key = ? AND decided_at = ? AND fp IN (${ps.map(() => '?').join(', ')})`,
        [projectKey, at, ...ps.map((p) => p.fp)])).map((r) => String(r.fp)));
      const todo = ps.filter((p) => !have.has(p.fp));
      if (!todo.length) continue;
      const first = await nextCounterBlock(db, seqName(projectKey), todo.length);
      await insertMany(db, 'verdicts', VERDICT_COLS, todo.map((p, i) => [first + i, p.project_key, p.fp, p.status, sqlv(p.reason), sqlv(p.note),
        sqlv(p.merged_into), p.decided_by, p.decided_at, p.ref, null, null, p.via ?? 'inbox', p.status === 'snoozed' ? sqlv(p.snooze_until) : null]));
    } catch (e) {
      console.warn(`dowser: ${ps.length} verdicts of one inbox not logged yet (${errTag(e)}); the next pull repairs them`);
    }
  }
}

/**
 * Applies one decision (reject or snooze) to many items as sets: one CAS UPDATE over every id still open, one read
 * back, the verdict rows in blocks and the cards from one evidence read, so a page of 50 cards is about a dozen
 * statements, not 550, and stays inside the resolver time limit. An item someone decided in between is left as they
 * decided it (the CAS), and the answer names it and what landed. An item whose last decision is not older than now
 * (a clock tie) is decided on its own, so `decided_at` stays unique per fp.
 * @param {Deps} deps
 * @param {ProposalRow[]} items
 * @param {{to: 'rejected' | 'snoozed', reason?: string, note?: string, snooze_until?: string}} d
 * @param {Decider} who
 * @returns {Promise<{cards: Card[]}>}
 */
async function decideAll(deps, items, d, who) {
  const { db } = deps;
  const at = deps.now().toISOString();
  const tied = items.filter((p) => p.decided_at && at <= p.decided_at);
  const batch = items.filter((p) => !tied.includes(p));
  /** @type {Map<number, ProposalRow>} */
  const landed = new Map();
  /** @type {ProposalRow | undefined} */
  let lost;
  if (batch.length) {
    const ids = batch.map((p) => p.id);
    const marks = ids.map(() => '?').join(', ');
    await db.exec(
      `UPDATE proposals SET status = ?, reason = ?, note = ?, merged_into = NULL, decided_by = ?, decided_at = ?, via = ?,
        reopened = 0, refs_at_status = evidence_count, types_at_status = evidence_types, accept_claim = NULL, snooze_until = ?
        WHERE id IN (${marks}) AND status = 'open'`,
      [d.to, sqlv(d.reason), sqlv(d.note), who.by, at, who.via, sqlv(d.snooze_until), ...ids],
    );
    const now = new Map((await db.query(`SELECT * FROM proposals WHERE id IN (${marks})`, ids)).map((r) => [Number(r.id), toProposal(r)]));
    /** @type {ProposalRow[]} */
    const mine = [];
    for (const p of batch) {
      const n = now.get(p.id);
      if (n && n.status === d.to && n.decided_at === at && n.decided_by === who.by) mine.push(n);
      else lost ??= n ?? p;
    }
    await appendVerdicts(db, mine);
    for (const n of mine) landed.set(n.id, n);
  }
  for (const p of tied) {
    if (lost) break;
    try {
      const n = await decide(deps, p, d, who);
      landed.set(n.id, n);
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      lost = p;
    }
  }
  const after = /** @type {ProposalRow[]} */ (items.map((p) => landed.get(p.id)).filter((p) => p !== undefined));
  if (lost) {
    const why = `${lost.ref} is ${lost.status === 'open' ? 'no longer open' : `${lost.status}, not open`}; reload it`;
    throw new AppError('bad-input', after.length ? `${why}; already ${d.to}: ${after.map((p) => p.ref).join(', ')}` : why);
  }
  const repos = await inboxRowsByKey(db, after.map((p) => p.project_key));
  const evidence = await evidenceOfMany(db, after);
  return { cards: after.map((p) => toCard(p, evidence.get(p.id) ?? [], repos.get(p.project_key)?.repo_url)) };
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
 * An optional snooze date: a real calendar day `YYYY-MM-DD` after today, else `bad-input`. "Today" is the date
 * where it is earliest on Earth (UTC-12): the browser checks the person's own today, and a person west of UTC
 * late in the evening is already on the next UTC day, so a plain UTC check would refuse their "tomorrow".
 * @param {unknown} v
 * @param {Date} now
 * @returns {string | undefined}
 */
export function untilOf(v, now) {
  if (v === undefined || v === null || v === '') return undefined;
  const m = typeof v === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(v) : null;
  const d = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : undefined;
  if (!m || !d || d.toISOString().slice(0, 10) !== v) throw new AppError('bad-input', `until is a calendar date YYYY-MM-DD (got ${JSON.stringify(v)})`);
  const today = new Date(now.getTime() - 12 * 3_600_000).toISOString().slice(0, 10);
  if (m[0] <= today) throw new AppError('bad-input', `until must be after today (${today}); got ${m[0]}`);
  return m[0];
}

/**
 * Snooze one or more items; any new evidence key reopens them (F3). `until` (optional) is the day it comes back:
 * stored with the decision and sent to the skill as the verdict's `snooze_until`, which wakes it on that day.
 * @param {Deps} deps
 * @param {{refs: unknown, note?: unknown, until?: unknown}} args
 * @param {Decider} who
 * @returns {Promise<{cards: Card[]}>}
 */
export async function snooze(deps, args, who) {
  const note = noteOf(args.note);
  const snoozeUntil = untilOf(args.until, deps.now());
  return decideAll(deps, await openItems(deps.db, args.refs), { to: 'snoozed', note, snooze_until: snoozeUntil }, who);
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
    // As accept stamps its issue: the comment is noted on the open row before the decision, so a retry after a failed
    // record does not post it again. Only a failure between Jira's answer and the stamp can still leave a second copy.
    if (p.merge_comment_on !== into) {
      const card = await cardOf(db, p);
      try {
        await deps.jira.addComment(into, mergeComment(card, await deps.links.inboxUrl(p.ref)));
      } catch (e) {
        throw new AppError('unavailable', `Jira did not take the comment on ${into} (${errTag(e)}); ${p.ref} stays open`);
      }
      await db.exec("UPDATE proposals SET merge_comment_on = ? WHERE id = ? AND status = 'open'", [into, p.id]);
    }
    const after = await decide(deps, p, { to: 'merged', merged_into: into }, who);
    await writeIssueProperty(deps, after, into, 'merged'); // best effort: logged, backfilled daily
    return { card: await cardOf(db, after) };
  }
  const target = await findProposal(db, into);
  if (target.id === p.id) throw new AppError('bad-input', 'an item cannot be merged into itself');
  if (target.project_key !== p.project_key) throw new AppError('bad-input', `${target.ref} is in another inbox (${target.project_key})`);
  if (target.status === 'merged') throw new AppError('bad-input', `${target.ref} is itself merged; merge into the item it was merged into`);
  return { card: await cardOf(db, await decide(deps, p, { to: 'merged', merged_into: target.fp }, who)) };
}

/**
 * The Rovo `dowser_verdict_record` action, a delegate's `dowser_verdicts_record` and any single-item decision by
 * status. `until` is a snooze's return day (untilOf).
 * @param {Deps} deps
 * @param {{ref: unknown, status: unknown, reason?: unknown, note?: unknown, merged_into?: unknown, until?: unknown}} args
 * @param {Decider} who
 * @returns {Promise<{card: Card}>}
 */
export async function record(deps, args, who) {
  const ref = needStr(args, 'ref');
  switch (args.status) {
    case 'accepted': return accept(deps, { ref, note: args.note }, who);
    case 'rejected': return { card: (await reject(deps, { refs: [ref], reason: args.reason, note: args.note }, who)).cards[0] };
    case 'snoozed': return { card: (await snooze(deps, { refs: [ref], note: args.note, until: args.until }, who)).cards[0] };
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

