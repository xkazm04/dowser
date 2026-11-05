// @ts-check
// Row-level access to the Forge SQL tables (src/sql/migrations.mjs) through the Db port: counters, inboxes,
// proposals and evidence. Every write is a compare-and-set or a check-then-insert (see ports.mjs).
import { evidenceKey } from '../shared/fingerprint.mjs';
import { AppError, DuplicateKey, FP_RE, num, omitAbsent, sha256, sqlv } from './util.mjs';
import { REF_RE, SAMPLE_KEY, SAMPLE_RESERVED } from './types.mjs';

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
 * @typedef {{project_key: string, repo_url?: string, jira_project_key?: string, issue_type_id?: string, created_at: string, created_by?: string,
 *   delegate_until?: string, delegate_accepts_per_day?: number, delegate_rejects_per_day?: number}} InboxRow
 *   `created_by` = the decider (forge:<accountId>) whose first push created it; absent before migration v018.
 *   `delegate_*` = the delegation set in Settings (core/delegate.mjs); absent when off, and before v032-v034.
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
  return nextCounterBlock(db, name, 1);
}

/**
 * Issues the next `n` values of counter `name` at once: one compare-and-set `value -> value + n` (two statements
 * however large the block) answering the first; the caller owns `first .. first + n - 1`. Two concurrent callers
 * get disjoint blocks. A value issued and then not used (a push that lost an fp race) is burnt, as with
 * `nextCounter`.
 * @param {Db} db
 * @param {string} name
 * @param {number} n  1 or more
 * @returns {Promise<number>}
 */
export async function nextCounterBlock(db, name, n) {
  if (!Number.isInteger(n) || n < 1) throw new AppError('bad-input', `a counter block holds 1 or more values, not ${n}`);
  for (let i = 0; i < CAS_TRIES; i++) {
    const rows = await db.query('SELECT value FROM counters WHERE name = ?', [name]);
    if (rows.length === 0) {
      try {
        await db.exec('INSERT INTO counters (name, value) VALUES (?, ?)', [name, n]);
        return 1;
      } catch (e) {
        if (!(e instanceof DuplicateKey)) throw e;
        continue;
      }
    }
    const v = Number(rows[0].value);
    const r = await db.exec('UPDATE counters SET value = ? WHERE name = ? AND value = ?', [v + n, name, v]);
    if (r.affectedRows === 1) return v + 1;
  }
  throw new AppError('unavailable', `could not allocate the next ${name}; try again`);
}

// ------------------------------------------------------------------------------------------- set statements
//
// Every statement is one Forge SQL request (30-60 ms), so bulk work is a few multi-row statements, not one per row.
// `INSERT ... VALUES (...), (...)` and `IN (...)` are plain SQL in both TiDB and SQLite. A request carries at most
// 1 MiB and an answer at most 4 MiB (Forge SQL limits), so writes are chunked by size and parameter count, and
// evidence reads by the rows they may answer.

/**
 * Bytes of SQL plus bound values one statement may carry: half of Forge SQL's 1 MiB request, leaving room for the
 * JSON escaping of the request body (a quoted line of code can grow when escaped).
 */
export const STATEMENT_BYTES_MAX = 512 * 1024;
/** Bound parameters per statement: far under TiDB's 65535 and SQLite's 32766. */
export const STATEMENT_PARAMS_MAX = 5000;
/**
 * Evidence rows one full read may answer: a row is at most ~5 KB (ref 500, quote 2000, url 2000 chars, plus keys),
 * so 500 rows stay well under Forge SQL's 4 MiB response. A key-only or ref-only read has far smaller rows.
 */
export const EVIDENCE_READ_ROWS = 500;

/** @param {unknown} v */
const valueBytes = (v) => (typeof v === 'string' ? Buffer.byteLength(v, 'utf8') : 8);

/**
 * Inserts `rows` (each the values of `cols`, in order) in as few multi-row INSERTs as the byte and parameter caps
 * allow. A chunk that hits a UNIQUE / PRIMARY KEY duplicate is retried row by row (one statement is atomic in TiDB
 * and SQLite alike: the failed chunk wrote nothing), so a row a concurrent writer filed first answers `false` and
 * every other row lands. Any other error is thrown.
 * @param {Db} db
 * @param {string} table
 * @param {string[]} cols
 * @param {unknown[][]} rows
 * @returns {Promise<boolean[]>}  per row: inserted (true) or a duplicate (false)
 */
export async function insertMany(db, table, cols, rows) {
  /** @type {boolean[]} */
  const out = rows.map(() => false);
  const head = `INSERT INTO ${table} (${cols.join(', ')}) VALUES `;
  const tuple = `(${cols.map(() => '?').join(', ')})`;
  /** @param {number} from @param {number} to */
  const run = async (from, to) => {
    if (to - from > 1) {
      try {
        await db.exec(head + rows.slice(from, to).map(() => tuple).join(', '), rows.slice(from, to).flat());
        for (let i = from; i < to; i++) out[i] = true;
        return;
      } catch (e) {
        if (!(e instanceof DuplicateKey)) throw e;
      }
    }
    for (let i = from; i < to; i++) {
      try {
        await db.exec(head + tuple, rows[i]);
        out[i] = true;
      } catch (e) {
        if (!(e instanceof DuplicateKey)) throw e;
      }
    }
  };
  const headBytes = Buffer.byteLength(head, 'utf8');
  let from = 0;
  let bytes = headBytes;
  for (let i = 0; i < rows.length; i++) {
    const rowBytes = tuple.length + 2 + rows[i].reduce((/** @type {number} */ n, v) => n + valueBytes(v), 0);
    if (i > from && (bytes + rowBytes > STATEMENT_BYTES_MAX || (i - from + 1) * cols.length > STATEMENT_PARAMS_MAX)) {
      await run(from, i);
      from = i;
      bytes = headBytes;
    }
    bytes += rowBytes;
  }
  if (from < rows.length) await run(from, rows.length);
  return out;
}

/**
 * Splits `items` into IN-list chunks of at most STATEMENT_PARAMS_MAX - `reserve` values and, with `weight`, at
 * most `budget` weight each (a chunk always holds at least one item).
 * @template T
 * @param {T[]} items
 * @param {{reserve?: number, weight?: (t: T) => number, budget?: number}} [o]
 * @returns {T[][]}
 */
export function inChunks(items, { reserve = 0, weight, budget = Infinity } = {}) {
  /** @type {T[][]} */
  const out = [];
  /** @type {T[]} */
  let cur = [];
  let w = 0;
  for (const t of items) {
    const tw = weight ? Math.max(1, weight(t)) : 1;
    if (cur.length > 0 && (cur.length >= STATEMENT_PARAMS_MAX - reserve || w + tw > budget)) { out.push(cur); cur = []; w = 0; }
    cur.push(t);
    w += tw;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** `?, ?, ...` for an IN list of `n` values. @param {number} n */
const marks = (n) => Array.from({ length: n }, () => '?').join(', ');

/**
 * The proposals of `ps` once each, by id (an IN list asks each id once).
 * @template {{id: number}} T
 * @param {T[]} ps
 * @returns {T[]}
 */
const uniqueById = (ps) => [...new Map(ps.map((p) => [p.id, p])).values()];

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

/**
 * Sets counter `name` to `value` (a progress cursor with one writer: the daily trigger; not a CAS).
 * @param {Db} db
 * @param {string} name
 * @param {number} value
 */
export async function setCounter(db, name, value) {
  const r = await db.exec('UPDATE counters SET value = ? WHERE name = ?', [value, name]);
  if (r.affectedRows > 0) return;
  try {
    await db.exec('INSERT INTO counters (name, value) VALUES (?, ?)', [name, value]);
  } catch (e) {
    if (!(e instanceof DuplicateKey)) throw e;
    await db.exec('UPDATE counters SET value = ? WHERE name = ?', [value, name]);
  }
}

// ------------------------------------------------------------------------------------------------ inboxes

/** True for the sample inbox's reserved key (types.mjs SAMPLE_KEY). @param {unknown} projectKey */
export const isSampleKey = (projectKey) => typeof projectKey === 'string' && projectKey.trim() === SAMPLE_KEY;

/**
 * The inboxes an all-inbox view lists ITEMS from (mixed-plane rule: the source owns the sample predicate): the
 * visible keys without the sample, unless the sample is the only one visible (a judge's first run). Summaries
 * (`inboxes[]`) still list the sample, so a picker can offer it; only the aggregate leaves it out.
 * @param {string[]} keys  the caller's visible inbox keys
 * @returns {string[]}
 */
export function itemScope(keys) {
  const rest = keys.filter((k) => !isSampleKey(k));
  return rest.length > 0 ? rest : keys;
}

/**
 * Refuses a write to the sample inbox's reserved key with `bad-input`, unless `o.sample` (only core/sample.mjs
 * passes it: the sample load replays its scan through the same push code). The tool door (app.mjs) refuses first,
 * before any access check; this is the core's own guard, so no other caller can mix a scan into the sample.
 * @param {unknown} projectKey
 * @param {{sample?: boolean}} [o]
 */
export function refuseSampleKey(projectKey, o = {}) {
  if (!o.sample && isSampleKey(projectKey)) throw new AppError('bad-input', SAMPLE_RESERVED);
}

/** @param {Row} r @returns {InboxRow} */
const toInbox = (r) => /** @type {InboxRow} */ (omitAbsent({
  project_key: String(r.project_key), repo_url: r.repo_url, jira_project_key: r.jira_project_key,
  issue_type_id: r.issue_type_id, created_at: String(r.created_at), created_by: r.created_by,
  delegate_until: r.delegate_until ?? undefined,
  delegate_accepts_per_day: r.delegate_accepts_per_day === null || r.delegate_accepts_per_day === undefined ? undefined : Number(r.delegate_accepts_per_day),
  delegate_rejects_per_day: r.delegate_rejects_per_day === null || r.delegate_rejects_per_day === undefined ? undefined : Number(r.delegate_rejects_per_day),
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
 * Creates the inbox on first use, stamped with its creator; records `repo_url` when given (the newest push
 * wins). Whether the caller may push to an inbox that already exists is decided before this (core/access.mjs).
 * @param {Db} db
 * @param {string} projectKey
 * @param {{repoUrl?: string, at: string, by: string}} o  `by` = the creator's decider id
 * @returns {Promise<InboxRow>}
 */
export async function ensureInbox(db, projectKey, { repoUrl, at, by }) {
  let inbox = await getInbox(db, projectKey);
  if (!inbox) {
    try {
      await db.exec('INSERT INTO inboxes (project_key, repo_url, created_at, created_by) VALUES (?, ?, ?, ?)', [projectKey, sqlv(repoUrl), at, by]);
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

/**
 * The inbox rows of `keys`, in one IN read per STATEMENT_PARAMS_MAX keys; a key with no inbox is absent.
 * @param {Db} db
 * @param {string[]} keys
 * @returns {Promise<Map<string, InboxRow>>}
 */
export async function inboxRowsByKey(db, keys) {
  /** @type {Map<string, InboxRow>} */
  const out = new Map();
  for (const chunk of inChunks([...new Set(keys)])) {
    for (const r of await db.query(`SELECT * FROM inboxes WHERE project_key IN (${marks(chunk.length)})`, chunk)) out.set(String(r.project_key), toInbox(r));
  }
  return out;
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
 * The stored rows (as read, not mapped) of the fps of one inbox, in one IN read per STATEMENT_PARAMS_MAX fps.
 * @param {Db} db
 * @param {string} projectKey
 * @param {string[]} fps
 * @returns {Promise<Map<string, Row>>}  fp -> row; an fp the inbox does not hold is absent
 */
export async function proposalRowsByFp(db, projectKey, fps) {
  /** @type {Map<string, Row>} */
  const out = new Map();
  for (const chunk of inChunks([...new Set(fps)], { reserve: 1 })) {
    for (const r of await db.query(`SELECT * FROM proposals WHERE project_key = ? AND fp IN (${marks(chunk.length)})`, [projectKey, ...chunk])) out.set(String(r.fp), r);
  }
  return out;
}

/**
 * Every proposal each of `refs` names, by inbox ref (`DW-12`) or fingerprint (an fp may sit in several inboxes), in
 * one IN read per kind of ref; a ref that is neither form is `bad-input`. Keys are the trimmed refs; a ref nothing
 * matches maps to an empty list. Whether the caller may open them is not decided here (core/access.mjs).
 * @param {Db} db
 * @param {unknown[]} refs
 * @returns {Promise<Map<string, ProposalRow[]>>}
 */
export async function proposalsMatching(db, refs) {
  const keys = [...new Set(refs.map((ref) => String(ref ?? '').trim()))];
  for (const r of keys) if (!REF_RE.test(r) && !FP_RE.test(r)) throw new AppError('bad-input', `${JSON.stringify(r)} is neither an inbox ref (DW-12) nor a fingerprint`);
  /** @type {Map<string, ProposalRow[]>} */
  const out = new Map(keys.map((r) => [r, []]));
  for (const [col, test] of /** @type {const} */ ([['ref', REF_RE], ['fp', FP_RE]])) {
    for (const chunk of inChunks(keys.filter((r) => test.test(r)))) {
      for (const row of await db.query(`SELECT * FROM proposals WHERE ${col} IN (${marks(chunk.length)}) ORDER BY id`, chunk)) out.get(String(row[col]))?.push(toProposal(row));
    }
  }
  return out;
}

/**
 * A proposal by inbox ref (`DW-12`) or by fingerprint (any project; an fp in two projects is ambiguous).
 * @param {Db} db
 * @param {string} ref
 * @returns {Promise<ProposalRow>}
 */
export async function findProposal(db, ref) {
  const r = String(ref ?? '').trim();
  const rows = /** @type {ProposalRow[]} */ ((await proposalsMatching(db, [r])).get(r));
  if (rows.length === 0) throw new AppError('bad-input', `no Dowser proposal ${r}`);
  if (rows.length > 1) throw new AppError('bad-input', `fingerprint ${r} is in more than one inbox; use its DW ref`);
  return rows[0];
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
 * @param {{runId: string, headSha?: string, at: string, fresh?: boolean}} o  `fresh`: the proposal was just inserted
 *   and has no evidence yet, so the two reads (keys present, the union's types) are answered from `items` alone
 *   (two statements fewer per new card: a push of 50 new cards, or the sample load, is 100 statements shorter)
 * @returns {Promise<{added: number, count: number, types: string[]}>} rows added, and the union's size and types
 */
export async function uniteEvidence(db, proposalId, items, { runId, headSha, at, fresh = false }) {
  const have = new Set(fresh ? [] : (await db.query('SELECT ekey_hash FROM evidence WHERE proposal_id = ?', [proposalId])).map((r) => String(r.ekey_hash)));
  const plan = evidenceRows(proposalId, items, have, { runId, headSha, at });
  const added = (await insertMany(db, 'evidence', EVIDENCE_COLS, plan.rows)).filter(Boolean).length;
  if (fresh) return { added, count: plan.rows.length, types: [...new Set(plan.types)].sort() };
  const rows = await db.query('SELECT type FROM evidence WHERE proposal_id = ?', [proposalId]);
  return { added, count: rows.length, types: [...new Set(rows.map((r) => String(r.type)))].sort() };
}

/**
 * Every evidence row of each proposal, oldest first (as `evidenceOf`), in IN reads of at most EVIDENCE_READ_ROWS
 * rows by the proposals' `evidence_count`.
 * @param {Db} db
 * @param {{id: number, evidence_count?: number}[]} proposals
 * @returns {Promise<Map<number, EvidenceRow[]>>}  every asked id is present (an empty list when it has none)
 */
export async function evidenceOfMany(db, proposals) {
  /** @type {Map<number, EvidenceRow[]>} */
  const out = new Map(proposals.map((p) => [p.id, []]));
  for (const chunk of inChunks(uniqueById(proposals), { weight: (p) => p.evidence_count ?? 1, budget: EVIDENCE_READ_ROWS })) {
    const rows = await db.query(`SELECT * FROM evidence WHERE proposal_id IN (${marks(chunk.length)}) ORDER BY proposal_id, added_at, pos`, chunk.map((p) => p.id));
    for (const r of rows) out.get(Number(r.proposal_id))?.push(toEvidence(r));
  }
  return out;
}

/**
 * The evidence `{type, ref}` of each proposal, oldest first: what the area mapping reads (areas.mjs), without the
 * quotes and urls, so one read answers many more proposals.
 * @param {Db} db
 * @param {{id: number, evidence_count?: number}[]} proposals
 * @returns {Promise<Map<number, {type: string, ref: string}[]>>}
 */
export async function evidenceRefsOfMany(db, proposals) {
  /** @type {Map<number, {type: string, ref: string}[]>} */
  const out = new Map(proposals.map((p) => [p.id, []]));
  for (const chunk of inChunks(uniqueById(proposals), { weight: (p) => p.evidence_count ?? 1, budget: EVIDENCE_READ_ROWS * 8 })) {
    const rows = await db.query(`SELECT proposal_id, type, ref FROM evidence WHERE proposal_id IN (${marks(chunk.length)}) ORDER BY proposal_id, added_at, pos`, chunk.map((p) => p.id));
    for (const r of rows) out.get(Number(r.proposal_id))?.push({ type: String(r.type), ref: String(r.ref) });
  }
  return out;
}

/**
 * The evidence keys (ekey_hash) and types each proposal holds, in key-only IN reads.
 * @param {Db} db
 * @param {{id: number, evidence_count?: number}[]} proposals
 * @returns {Promise<Map<number, {keys: Set<string>, types: Set<string>, count: number}>>}  every asked id present
 */
export async function ekeysOfMany(db, proposals) {
  /** @type {Map<number, {keys: Set<string>, types: Set<string>, count: number}>} */
  const out = new Map(proposals.map((p) => [p.id, { keys: new Set(), types: new Set(), count: 0 }]));
  for (const chunk of inChunks(uniqueById(proposals), { weight: (p) => p.evidence_count ?? 1, budget: EVIDENCE_READ_ROWS * 40 })) {
    for (const r of await db.query(`SELECT proposal_id, ekey_hash, type FROM evidence WHERE proposal_id IN (${marks(chunk.length)})`, chunk.map((p) => p.id))) {
      const k = out.get(Number(r.proposal_id));
      if (!k) continue;
      k.keys.add(String(r.ekey_hash));
      k.types.add(String(r.type));
      k.count++;
    }
  }
  return out;
}

/** The evidence table's columns, in the order `evidenceRows` writes them. */
export const EVIDENCE_COLS = ['proposal_id', 'ekey_hash', 'ekey', 'type', 'ref', 'quote', 'url', 'head_sha', 'added_run_id', 'added_at', 'pos'];

/**
 * The rows `items` add to a proposal holding the keys `have`: one per evidence key not held yet; the first item of
 * a key wins and keeps its position in `items` (`pos`). Pure.
 * @param {number} proposalId
 * @param {{type: string, ref: string, quote?: string, url?: string}[]} items
 * @param {Set<string>} have  ekey hashes the proposal holds
 * @param {{runId: string, headSha?: string, at: string}} o
 * @returns {{rows: unknown[][], types: string[]}}  rows in EVIDENCE_COLS order, and the type of each
 */
export function evidenceRows(proposalId, items, have, { runId, headSha, at }) {
  const seen = new Set(have);
  /** @type {unknown[][]} */
  const rows = [];
  /** @type {string[]} */
  const types = [];
  for (const [pos, e] of items.entries()) {
    const ekey = evidenceKey(e).key;
    const h = sha256(`${e.type}\n${ekey}`);
    if (seen.has(h)) continue;
    seen.add(h);
    rows.push([proposalId, h, ekey, e.type, e.ref, sqlv(e.quote), sqlv(e.url), sqlv(headSha), runId, at, pos]);
    types.push(e.type);
  }
  return { rows, types };
}
