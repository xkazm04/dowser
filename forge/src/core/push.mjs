// @ts-check
// `dowser_proposals_push` (forge-mcp-2): validate every record, file it in the project's inbox idempotently on
// (project_key, fp), unite evidence by evidence key, reopen snoozed/rejected items on growth (F3), and record
// the push. Reuses the shared skill modules: `validateCandidate`, `fingerprint`, `resurfaces`, STORE_OWNED.
import { fingerprint } from '../shared/fingerprint.mjs';
import { STORE_OWNED, resurfaces, validateCandidate } from '../shared/model.mjs';
import { PUSH_MAX } from './types.mjs';
import { DuplicateKey, AppError, isObj, needStr, optStr, sqlv } from './util.mjs';
import { ensureInbox, getByFp, nextCounter, uniteEvidence } from './store.mjs';
import { deciderOf } from './verdicts.mjs';

/**
 * @typedef {import('./ports.mjs').Deps} Deps
 * @typedef {import('./ports.mjs').Db} Db
 * @typedef {import('./types.mjs').PushResultRow} PushResultRow
 * @typedef {import('./types.mjs').PushOutput} PushOutput
 * @typedef {import('./store.mjs').ProposalRow} ProposalRow
 */

/** Parsed `_json` inputs are capped at 4 MB (contract "JSON-string inputs"). */
export const JSON_INPUT_MAX = 4 * 1024 * 1024;
/**
 * A pushed `project_key`: the skill's `projectKey` slug (`[A-Za-z0-9-]`, or `local-<12 hex>`), within the
 * VARCHAR(191) column.
 */
export const PROJECT_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,190}$/;
export const REPO_URL_MAX = 2000;
/**
 * True when `v` is a web URL a repo link may carry: `https:`, or `http:` because the skill keeps the scheme of
 * an `http://` git remote (git.mjs `webUrl`, a self-hosted server). Any other scheme (`javascript:`, `data:`)
 * is refused.
 * @param {string} v
 */
export function webRepoUrl(v) {
  if (v.length > REPO_URL_MAX) return false;
  try { return ['https:', 'http:'].includes(new URL(v).protocol); } catch { return false; }
}
/** Statuses a pushed record may carry: a first push (`verified`) or a re-push after growth (`pushed`). */
const PUSHABLE = ['verified', 'pushed'];
/** Store-owned fields of a full record, plus the v2 issue fields; the inbox owns these, so they are dropped. */
const DROP = [...STORE_OWNED, 'issue_ref', 'issue_url'];

/**
 * Parses a `_json` string argument into an array, else `bad-input`.
 * @param {Record<string, unknown>} args
 * @param {string} key
 * @param {number} max
 * @returns {unknown[]}
 */
export function parseJsonArray(args, key, max) {
  const raw = args[key];
  if (typeof raw !== 'string' || !raw.trim()) throw new AppError('bad-input', `${key} is required: a JSON array as a string`);
  if (Buffer.byteLength(raw, 'utf8') > JSON_INPUT_MAX) throw new AppError('bad-input', `${key} is larger than 4 MB`);
  /** @type {unknown} */
  let v;
  try { v = JSON.parse(raw); } catch (e) { throw new AppError('bad-input', `${key} is not valid JSON (${/** @type {Error} */ (e).message})`); }
  if (!Array.isArray(v)) throw new AppError('bad-input', `${key} must be a JSON array`);
  if (v.length > max) throw new AppError('bad-input', `${key} holds ${v.length} items; the limit is ${max}`);
  return v;
}

/**
 * Checks one pushed record. Returns the candidate (store-owned fields removed) or why it is refused.
 * @param {unknown} raw
 * @returns {{ok: true, fp: string, record: Record<string, any>} | {ok: false, fp: string, why: string}}
 */
export function checkRecord(raw) {
  const fpIn = isObj(raw) && typeof raw.fp === 'string' ? raw.fp : '';
  if (!isObj(raw)) return { ok: false, fp: fpIn, why: 'not a dowser-proposal/1 record (not an object)' };
  if (!PUSHABLE.includes(raw.status)) return { ok: false, fp: fpIn, why: `status must be verified or pushed, not ${JSON.stringify(raw.status)}` };
  /** @type {Record<string, any>} */
  const cand = {};
  for (const [k, v] of Object.entries(raw)) if (!DROP.includes(k)) cand[k] = v;
  if (typeof cand.fp !== 'string' || !cand.fp) return { ok: false, fp: fpIn, why: 'fp is required' };
  const v = validateCandidate(cand, { wire: true });
  if (!v.ok) return { ok: false, fp: fpIn, why: `invalid record: ${v.why}` };
  // The lens's closed kind list lives in the skill's lens packs, not here; recompute with the record's own kind.
  // That checks the identity hash (lens|kind|topic|anchors) without re-checking kind membership.
  /** @type {string} */
  let fp;
  try { fp = fingerprint({ lens: cand.lens, kind: cand.kind, topic: cand.topic, anchors: cand.anchors }, [cand.kind]); } catch (e) {
    return { ok: false, fp: fpIn, why: `fingerprint: ${/** @type {Error} */ (e).message}` };
  }
  if (fp !== cand.fp) return { ok: false, fp: fpIn, why: `fp ${cand.fp} does not match its identity (lens, kind, topic, anchors hash to ${fp})` };
  return { ok: true, fp, record: cand };
}

/**
 * The record as stored in `record_json`: without evidence (that lives in the evidence table).
 * @param {Record<string, any>} record
 */
const storedRecord = (record) => {
  const { evidence, ...rest } = record;
  return JSON.stringify(rest);
};

/**
 * `dowser_proposals_push`.
 * @param {Deps} deps
 * @param {Record<string, unknown>} args
 * @param {string} accountId  the caller; a new inbox records it as its creator
 * @returns {Promise<PushOutput>}
 */
export async function pushProposals(deps, args, accountId) {
  const { db } = deps;
  const projectKey = needStr(args, 'project_key');
  if (!PROJECT_KEY_RE.test(projectKey)) throw new AppError('bad-input', 'project_key must be 1-191 letters, digits or hyphens, starting with a letter or digit');
  const runId = needStr(args, 'run_id');
  const repoUrl = optStr(args, 'repo_url');
  const headSha = optStr(args, 'head_sha');
  if (repoUrl && /\/\/[^/]*@/.test(repoUrl)) throw new AppError('bad-input', 'repo_url must not carry credentials');
  if (repoUrl && !webRepoUrl(repoUrl)) throw new AppError('bad-input', `repo_url must be an https:// (or http://) URL of at most ${REPO_URL_MAX} chars`);
  const records = parseJsonArray(args, 'proposals_json', PUSH_MAX);
  const at = deps.now().toISOString();
  await ensureInbox(db, projectKey, { repoUrl, at, by: deciderOf(accountId) });

  /** @type {PushResultRow[]} */
  const results = [];
  let created = 0;
  let updated = 0;
  for (const raw of records) {
    const c = checkRecord(raw);
    if (!c.ok) { results.push({ fp: c.fp, result: 'refused', why: c.why }); continue; }
    const r = await fileOne(deps, { projectKey, runId, headSha, at, fp: c.fp, record: c.record });
    if (r.result === 'created') created++;
    if (r.result === 'updated') updated++;
    results.push(r);
  }
  await db.exec('INSERT INTO pushes (id, project_key, run_id, head_sha, repo_url, at, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [crypto.randomUUID(), projectKey, runId, sqlv(headSha), sqlv(repoUrl), at, created, updated]);
  return { results };
}

/**
 * Files one valid record: create, or update + unite + maybe reopen, or redirect to the surviving item.
 * @param {Deps} deps
 * @param {{projectKey: string, runId: string, headSha?: string, at: string, fp: string, record: Record<string, any>}} o
 * @returns {Promise<PushResultRow>}
 */
async function fileOne(deps, o) {
  const { db, links } = deps;
  let p = await getByFp(db, o.projectKey, o.fp);
  if (!p) {
    const n = await nextCounter(db, 'ref');
    const ref = `DW-${n}`;
    try {
      await db.exec(
        `INSERT INTO proposals (id, ref, project_key, fp, status, lens, title, confidence, record_json, evidence_count, evidence_types,
          first_run_id, last_run_id, first_seen, last_push_at, reopened, change_kind) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, 0, '', ?, ?, ?, ?, 0, 'new')`,
        [n, ref, o.projectKey, o.fp, o.record.lens, o.record.title, o.record.confidence, storedRecord(o.record), o.runId, o.runId, o.at, o.at],
      );
      const u = await uniteEvidence(db, n, o.record.evidence, { runId: o.runId, headSha: o.headSha, at: o.at });
      await db.exec('UPDATE proposals SET evidence_count = ?, evidence_types = ? WHERE id = ?', [u.count, u.types.join(','), n]);
      return { fp: o.fp, result: 'created', external_ref: ref, external_url: await links.inboxUrl(ref) };
    } catch (e) {
      // A concurrent push filed the same fp first (UNIQUE (project_key, fp)); the DW number is burnt. Update it.
      if (!(e instanceof DuplicateKey)) throw e;
      p = await getByFp(db, o.projectKey, o.fp);
      if (!p) throw e;
    }
  }
  return updateOne(deps, p, o);
}

/**
 * @param {Deps} deps
 * @param {ProposalRow} p
 * @param {{runId: string, headSha?: string, at: string, fp: string, record: Record<string, any>}} o
 * @returns {Promise<PushResultRow>}
 */
async function updateOne(deps, p, o) {
  const { db, links } = deps;
  const u = await uniteEvidence(db, p.id, o.record.evidence, { runId: o.runId, headSha: o.headSha, at: o.at });
  const grew = u.added > 0;
  // The card is refreshed; the item moves to this push's group only when its evidence grew (F8 run diff).
  await db.exec(
    `UPDATE proposals SET lens = ?, title = ?, confidence = ?, record_json = ?, evidence_count = ?, evidence_types = ?
      ${grew ? ", last_run_id = ?, last_push_at = ?, change_kind = 'grew'" : ''} WHERE id = ?`,
    [o.record.lens, o.record.title, o.record.confidence, storedRecord(o.record), u.count, u.types.join(','),
      ...(grew ? [o.runId, o.at] : []), p.id],
  );

  if (p.status === 'merged') {
    // A person folded this fp into another item. Into an inbox item: answer that survivor. Into a Jira issue
    // there is no surviving inbox item, so the item answers as itself (`updated`); its `merged` verdict reaches
    // the skill through the pull.
    if (p.merged_into && /^[0-9a-f]{16}$/.test(p.merged_into)) {
      const target = await getByFp(db, p.project_key, p.merged_into);
      if (target) {
        return { fp: o.fp, result: 'merged-existing', external_ref: target.ref, external_url: await links.inboxUrl(target.ref), why: `merged into ${target.ref}` };
      }
    }
  }

  // A dated snooze whose day has come (DW-42): the skill woke it on that day and pushes it again, so it reopens
  // even without new evidence. "That day" is checked in the latest time zone (UTC+14): the skill wakes on the
  // runner's local date, which may already be ahead of UTC.
  const due = p.status === 'snoozed' && p.snooze_until !== undefined
    && p.snooze_until <= new Date(Date.parse(o.at) + 14 * 3_600_000).toISOString().slice(0, 10);
  if (due || (grew && (p.status === 'snoozed' || p.status === 'rejected'))) {
    const then = { refs: p.refs_at_status ?? p.evidence_count, types: p.types_at_status ?? p.evidence_types };
    if (due || resurfaces(p.status, then, { refs: u.count, types: u.types }).resurface) {
      // A reopen writes no verdict; the item is simply open again (CAS on the status it had).
      await db.exec("UPDATE proposals SET status = 'open', reopened = 1, change_kind = 'reopened', last_run_id = ?, last_push_at = ? WHERE id = ? AND status = ?",
        [o.runId, o.at, p.id, p.status]);
    }
  }
  return { fp: o.fp, result: 'updated', external_ref: p.ref, external_url: await links.inboxUrl(p.ref) };
}

