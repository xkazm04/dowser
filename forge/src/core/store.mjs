// @ts-check
// Row-level access to the Forge SQL tables (src/sql/migrations.mjs) through the Db port: counters, inboxes,
// proposals and evidence. Every write is a compare-and-set or a check-then-insert (see ports.mjs).
import { evidenceKey } from '../shared/fingerprint.mjs';
import { AppError, DuplicateKey, FP_RE, num, omitAbsent, sha256, sqlv } from './util.mjs';
import { REF_RE } from './types.mjs';

/**
 * @typedef {import('./ports.mjs').Db} Db
 * @typedef {import('./ports.mjs').Row} Row
 * @typedef {import('./types.mjs').InboxStatus} InboxStatus
 * @typedef {{
 *   id: number, ref: string, project_key: string, fp: string, status: InboxStatus, lens: string, title: string,
 *   confidence: string, record: Record<string, any>, evidence_count: number, evidence_types: string[],
 *   refs_at_status?: number, types_at_status?: string[], first_run_id: string, last_run_id: string,
 *   first_seen: string, last_push_at: string, reopened: boolean, issue_ref?: string, issue_url?: string,
 *   reason?: string, note?: string, merged_into?: string, decided_by?: string, decided_at?: string, via?: string,
 *   accept_claim?: string, change_kind: 'new' | 'grew' | 'reopened', snooze_until?: string
 * }} ProposalRow
 * @typedef {{type: string, ref: string, quote?: string, url?: string, head_sha?: string, added_run_id: string, added_at: string}} EvidenceRow
 * @typedef {{project_key: string, repo_url?: string, jira_project_key?: string, issue_type_id?: string, created_at: string}} InboxRow
 */

const CAS_TRIES = 20;

/**
 * Issues the next value of counter `name` (1, 2, ...) by compare-and-set, so two concurrent callers never get
 * the same value without needing a transaction.
 * @param {Db} db
 * @param {string} name
 * @returns {Promise<number>}
 */
export async function nextCounter(db, name) {
  for (let i = 0; i < CAS_TRIES; i++) {
    const rows = await db.query('SELECT value FROM counters WHERE name = ?', [name]);
    if (rows.length === 0) {
      try {
        await db.exec('INSERT INTO counters (name, value) VALUES (?, ?)', [name, 1]);
        return 1;
      } catch (e) {
        if (!(e instanceof DuplicateKey)) throw e;
        continue;
      }
    }
    const v = Number(rows[0].value);
    const r = await db.exec('UPDATE counters SET value = ? WHERE name = ? AND value = ?', [v + 1, name, v]);
    if (r.affectedRows === 1) return v + 1;
  }
  throw new AppError('unavailable', `could not allocate the next ${name}; try again`);
}

/**
 * The last value counter `name` issued, or 0 when it never issued one.
 * @param {Db} db
 * @param {string} name
 * @returns {Promise<number>}
 */
export async function counterValue(db, name) {
  const rows = await db.query('SELECT value FROM counters WHERE name = ?', [name]);
  return rows.length ? Number(rows[0].value) : 0;
}

// ------------------------------------------------------------------------------------------------ inboxes

/** @param {Row} r @returns {InboxRow} */
const toInbox = (r) => /** @type {InboxRow} */ (omitAbsent({
  project_key: String(r.project_key), repo_url: r.repo_url, jira_project_key: r.jira_project_key,
  issue_type_id: r.issue_type_id, created_at: String(r.created_at),
}));

/**
 * @param {Db} db
 * @param {string} projectKey
 * @returns {Promise<InboxRow | undefined>}
 */
export async function getInbox(db, projectKey) {
  const rows = await db.query('SELECT * FROM inboxes WHERE project_key = ?', [projectKey]);
  return rows.length ? toInbox(rows[0]) : undefined;
}

/**
 * The inbox of `projectKey`, else `unknown-project`.
 * @param {Db} db
 * @param {string} projectKey
 * @returns {Promise<InboxRow>}
 */
export async function needInbox(db, projectKey) {
  const inbox = await getInbox(db, projectKey);
  if (!inbox) throw new AppError('unknown-project', `Dowser has no inbox for project ${projectKey}; push proposals first`);
  return inbox;
}

/**
 * Creates the inbox on first use; records `repo_url` when given (the newest push wins).
 * @param {Db} db
 * @param {string} projectKey
 * @param {{repoUrl?: string, at: string}} o
 * @returns {Promise<InboxRow>}
 */
export async function ensureInbox(db, projectKey, { repoUrl, at }) {
  let inbox = await getInbox(db, projectKey);
  if (!inbox) {
    try {
      await db.exec('INSERT INTO inboxes (project_key, repo_url, created_at) VALUES (?, ?, ?)', [projectKey, sqlv(repoUrl), at]);
    } catch (e) {
      if (!(e instanceof DuplicateKey)) throw e;
    }
    inbox = /** @type {InboxRow} */ (await getInbox(db, projectKey));
  }
  if (repoUrl && inbox.repo_url !== repoUrl) {
    await db.exec('UPDATE inboxes SET repo_url = ? WHERE project_key = ?', [repoUrl, projectKey]);
    inbox = { ...inbox, repo_url: repoUrl };
  }
  return inbox;
}

/**
 * @param {Db} db
 * @returns {Promise<InboxRow[]>}
 */
export async function listInboxRows(db) {
  return (await db.query('SELECT * FROM inboxes ORDER BY project_key')).map(toInbox);
}

// ---------------------------------------------------------------------------------------------- proposals

/** @param {unknown} v @returns {string[]} */
const typeList = (v) => (typeof v === 'string' && v ? v.split(',') : []);

/**
 * @param {Row} r
 * @returns {ProposalRow}
 */
export function toProposal(r) {
  return /** @type {ProposalRow} */ (omitAbsent({
    id: Number(r.id), ref: String(r.ref), project_key: String(r.project_key), fp: String(r.fp),
    status: r.status, lens: String(r.lens), title: String(r.title), confidence: String(r.confidence),
    record: JSON.parse(String(r.record_json)), evidence_count: Number(r.evidence_count),
    evidence_types: typeList(r.evidence_types), refs_at_status: num(r.refs_at_status),
    types_at_status: r.types_at_status === null || r.types_at_status === undefined ? undefined : typeList(r.types_at_status),
    first_run_id: String(r.first_run_id), last_run_id: String(r.last_run_id), first_seen: String(r.first_seen),
    last_push_at: String(r.last_push_at), reopened: Number(r.reopened) === 1, issue_ref: r.issue_ref,
    issue_url: r.issue_url, reason: r.reason, note: r.note, merged_into: r.merged_into, decided_by: r.decided_by,
    decided_at: r.decided_at, via: r.via, accept_claim: r.accept_claim, change_kind: r.change_kind,
    snooze_until: r.snooze_until,
  }));
}

/**
 * @param {Db} db
 * @param {string} projectKey
 * @param {string} fp
 * @returns {Promise<ProposalRow | undefined>}
 */
export async function getByFp(db, projectKey, fp) {
  const rows = await db.query('SELECT * FROM proposals WHERE project_key = ? AND fp = ?', [projectKey, fp]);
  return rows.length ? toProposal(rows[0]) : undefined;
}

/**
 * A proposal by inbox ref (`DW-12`) or by fingerprint (any project; an fp in two projects is ambiguous).
 * @param {Db} db
 * @param {string} ref
 * @returns {Promise<ProposalRow>}
 */
export async function findProposal(db, ref) {
  const r = String(ref ?? '').trim();
  /** @type {Row[]} */
  let rows;
  if (REF_RE.test(r)) rows = await db.query('SELECT * FROM proposals WHERE ref = ?', [r]);
  else if (FP_RE.test(r)) rows = await db.query('SELECT * FROM proposals WHERE fp = ?', [r]);
  else throw new AppError('bad-input', `${JSON.stringify(r)} is neither an inbox ref (DW-12) nor a fingerprint`);
  if (rows.length === 0) throw new AppError('bad-input', `no Dowser proposal ${r}`);
  if (rows.length > 1) throw new AppError('bad-input', `fingerprint ${r} is in more than one inbox; use its DW ref`);
  return toProposal(rows[0]);
}

// ----------------------------------------------------------------------------------------------- evidence

/** @param {Row} r @returns {EvidenceRow} */
const toEvidence = (r) => /** @type {EvidenceRow} */ (omitAbsent({
  type: String(r.type), ref: String(r.ref), quote: r.quote, url: r.url, head_sha: r.head_sha,
  added_run_id: String(r.added_run_id), added_at: String(r.added_at),
}));

/**
 * Every evidence row of a proposal, oldest first.
 * @param {Db} db
 * @param {number} proposalId
 * @returns {Promise<EvidenceRow[]>}
 */
export async function evidenceOf(db, proposalId) {
  const rows = await db.query('SELECT * FROM evidence WHERE proposal_id = ? ORDER BY added_at, pos', [proposalId]);
  return rows.map(toEvidence);
}

/**
 * Unites `items` into the proposal's evidence by evidence key (shared `evidenceKey`): a key already present is
 * left as it is, a new key is inserted. Never deletes or rewrites a row.
 * @param {Db} db
 * @param {number} proposalId
 * @param {{type: string, ref: string, quote?: string, url?: string}[]} items
 * @param {{runId: string, headSha?: string, at: string}} o
 * @returns {Promise<{added: number, count: number, types: string[]}>} rows added, and the union's size and types
 */
export async function uniteEvidence(db, proposalId, items, { runId, headSha, at }) {
  const have = new Set((await db.query('SELECT ekey_hash FROM evidence WHERE proposal_id = ?', [proposalId])).map((r) => String(r.ekey_hash)));
  let added = 0;
  for (const [pos, e] of items.entries()) {
    const ekey = evidenceKey(e).key;
    const h = sha256(`${e.type}\n${ekey}`);
    if (have.has(h)) continue;
    try {
      await db.exec(
        'INSERT INTO evidence (proposal_id, ekey_hash, ekey, type, ref, quote, url, head_sha, added_run_id, added_at, pos) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [proposalId, h, ekey, e.type, e.ref, sqlv(e.quote), sqlv(e.url), sqlv(headSha), runId, at, pos],
      );
      added++;
    } catch (err) {
      if (!(err instanceof DuplicateKey)) throw err;
    }
    have.add(h);
  }
  const rows = await db.query('SELECT type FROM evidence WHERE proposal_id = ?', [proposalId]);
  const types = [...new Set(rows.map((r) => String(r.type)))].sort();
  return { added, count: rows.length, types };
}
