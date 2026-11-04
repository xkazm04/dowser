// @ts-check
// `dowser_proposals_push` (forge-mcp-2): validate every record, file it in the project's inbox idempotently on
// (project_key, fp), unite evidence by evidence key, reopen snoozed/rejected items on growth (F3), and record
// the push. Reuses the shared skill modules: `validateCandidate`, `fingerprint`, `resurfaces`, STORE_OWNED.
// The optional `lens_kinds_json` carries the pusher's lens kind lists; with it, a kind its lens lacks is refused.
import { fingerprint } from '../shared/fingerprint.mjs';
import { STORE_OWNED, resurfaces, validateCandidate } from '../shared/model.mjs';
import { PUSH_MAX } from './types.mjs';
import { DuplicateKey, AppError, isObj, needStr, optStr, sqlv } from './util.mjs';
import {
  EVIDENCE_COLS, ekeysOfMany, ensureInbox, evidenceRows, getByFp, insertMany, nextCounter, nextCounterBlock, proposalRowsByFp, refuseSampleKey,
  toProposal, uniteEvidence,
} from './store.mjs';
import { deciderOf } from './verdicts.mjs';
import { markRecurred } from './delivery.mjs';

/**
 * @typedef {import('./ports.mjs').Deps} Deps
 * @typedef {import('./ports.mjs').Db} Db
 * @typedef {import('./types.mjs').PushResultRow} PushResultRow
 * @typedef {import('./types.mjs').PushOutput} PushOutput
 * @typedef {import('./store.mjs').ProposalRow} ProposalRow
 * @typedef {import('./ports.mjs').Row} Row
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

/** `lens_kinds_json` caps: lenses, kinds per lens, chars per lens or kind name, bytes of the whole string. */
export const LENS_KINDS_MAX = { lenses: 16, kinds: 50, name: 64, bytes: 64 * 1024 };

/**
 * Parses the optional `lens_kinds_json` input: a JSON object `{<lens>: [<kind>, ...]}`, the closed kind lists of
 * the pusher's lens packs (the skill's `outbox --kinds`). Absent or empty -> undefined (an older skill: kind
 * membership is not checked). Any other shape is `bad-input` for the whole call.
 * @param {Record<string, unknown>} args
 * @returns {Record<string, string[]> | undefined}
 */
export function parseLensKinds(args) {
  const raw = args.lens_kinds_json;
  if (raw === undefined || raw === null || raw === '') return undefined;
  const shape = 'lens_kinds_json must be a JSON object of lens -> non-empty array of kind names, as a string';
  if (typeof raw !== 'string') throw new AppError('bad-input', shape);
  if (Buffer.byteLength(raw, 'utf8') > LENS_KINDS_MAX.bytes) throw new AppError('bad-input', 'lens_kinds_json is larger than 64 KB');
  /** @type {unknown} */
  let v;
  try { v = JSON.parse(raw); } catch (e) { throw new AppError('bad-input', `lens_kinds_json is not valid JSON (${/** @type {Error} */ (e).message})`); }
  if (!isObj(v)) throw new AppError('bad-input', shape);
  const entries = Object.entries(v);
  if (entries.length === 0 || entries.length > LENS_KINDS_MAX.lenses) throw new AppError('bad-input', `lens_kinds_json declares 1-${LENS_KINDS_MAX.lenses} lenses`);
  const name = (/** @type {unknown} */ s) => typeof s === 'string' && s.trim().length > 0 && s.length <= LENS_KINDS_MAX.name;
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const [lens, kinds] of entries) {
    if (!name(lens) || !Array.isArray(kinds) || kinds.length === 0 || kinds.length > LENS_KINDS_MAX.kinds || !kinds.every(name)) {
      throw new AppError('bad-input', `lens_kinds_json.${lens.slice(0, LENS_KINDS_MAX.name)}: ${LENS_KINDS_MAX.kinds} kind names at most, each 1-${LENS_KINDS_MAX.name} chars, at least one`);
    }
    out[lens] = /** @type {string[]} */ (kinds);
  }
  return out;
}

/**
 * Checks one pushed record. Returns the candidate (store-owned fields removed) or why it is refused.
 * With `lensKinds` (the push's `lens_kinds_json`), the record's kind must be one of its lens's kinds, as the
 * skill's `propose` requires locally; a lens the push declares no kinds for is refused too.
 * @param {unknown} raw
 * @param {Record<string, string[]>} [lensKinds]
 * @returns {{ok: true, fp: string, record: Record<string, any>} | {ok: false, fp: string, why: string}}
 */
export function checkRecord(raw, lensKinds) {
  const fpIn = isObj(raw) && typeof raw.fp === 'string' ? raw.fp : '';
  if (!isObj(raw)) return { ok: false, fp: fpIn, why: 'not a dowser-proposal/1 record (not an object)' };
  if (!PUSHABLE.includes(raw.status)) return { ok: false, fp: fpIn, why: `status must be verified or pushed, not ${JSON.stringify(raw.status)}` };
  /** @type {Record<string, any>} */
  const cand = {};
  for (const [k, v] of Object.entries(raw)) if (!DROP.includes(k)) cand[k] = v;
  if (typeof cand.fp !== 'string' || !cand.fp) return { ok: false, fp: fpIn, why: 'fp is required' };
  const v = validateCandidate(cand, { wire: true });
  if (!v.ok) return { ok: false, fp: fpIn, why: `invalid record: ${v.why}` };
  // The lens's closed kind list lives in the skill's lens packs, not here: the push carries it (`lens_kinds_json`),
  // and the fingerprint then checks kind membership as the skill does. A push without it (an older skill) is
  // recomputed with the record's own kind: the identity hash (lens|kind|topic|anchors) without membership.
  if (lensKinds && !Object.hasOwn(lensKinds, cand.lens)) {
    return { ok: false, fp: fpIn, why: `the push declares no kinds for lens ${String(cand.lens)} (lens_kinds_json)` };
  }
  const kinds = lensKinds ? lensKinds[cand.lens] : [cand.kind];
  if (!kinds.includes(cand.kind)) return { ok: false, fp: fpIn, why: `kind ${JSON.stringify(cand.kind)} is not one of ${cand.lens}'s kinds (${kinds.join(',')})` };
  /** @type {string} */
  let fp;
  try { fp = fingerprint({ lens: cand.lens, kind: cand.kind, topic: cand.topic, anchors: cand.anchors }, kinds); } catch (e) {
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
 * The sortable / filterable copies of the record's scan-finding/1 fields (migrations v019-v022): score, band, mvp
 * (1 or NULL) and pretriaged_by. Absent on the record -> NULL; never 0.
 * @param {Record<string, any>} record
 * @returns {unknown[]}
 */
const rankCols = (record) => [
  typeof record.score === 'number' ? record.score : null, sqlv(record.band), record.mvp === true ? 1 : null, sqlv(record.pretriaged_by),
];

/**
 * `dowser_proposals_push`. `o.sample` is the sample load's bypass of the reserved-key refusal (core/sample.mjs) and
 * `o.scannedAt` the time of the scan it replays, stored on the push row (`pushes.scanned_at`, v025).
 * @param {Deps} deps
 * @param {Record<string, unknown>} args
 * @param {string} accountId  the caller; a new inbox records it as its creator
 * @param {{sample?: boolean, scannedAt?: string}} [o]
 * @returns {Promise<PushOutput>}
 */
export async function pushProposals(deps, args, accountId, o = {}) {
  const { db } = deps;
  const projectKey = needStr(args, 'project_key');
  refuseSampleKey(projectKey, o);
  if (!PROJECT_KEY_RE.test(projectKey)) throw new AppError('bad-input', 'project_key must be 1-191 letters, digits or hyphens, starting with a letter or digit');
  const runId = needStr(args, 'run_id');
  const repoUrl = optStr(args, 'repo_url');
  const headSha = optStr(args, 'head_sha');
  if (repoUrl && /\/\/[^/]*@/.test(repoUrl)) throw new AppError('bad-input', 'repo_url must not carry credentials');
  if (repoUrl && !webRepoUrl(repoUrl)) throw new AppError('bad-input', `repo_url must be an https:// (or http://) URL of at most ${REPO_URL_MAX} chars`);
  const records = parseJsonArray(args, 'proposals_json', PUSH_MAX);
  const lensKinds = parseLensKinds(args);
  const at = deps.now().toISOString();
  await ensureInbox(db, projectKey, { repoUrl, at, by: deciderOf(accountId) });

  /** @type {PushResultRow[]} */
  const results = new Array(records.length);
  /** @type {FileJob[]} */
  const jobs = [];
  for (const [i, raw] of records.entries()) {
    const c = checkRecord(raw, lensKinds);
    if (!c.ok) results[i] = { fp: c.fp, result: 'refused', why: c.why };
    else jobs.push({ i, o: { projectKey, runId, headSha, at, fp: c.fp, record: c.record } });
  }
  await fileAll(deps, jobs, results);
  const created = results.filter((r) => r.result === 'created').length;
  const updated = results.filter((r) => r.result === 'updated').length;
  // scanned_at only on a sample push, so a scan's push never depends on the v025 column.
  const extra = o.scannedAt ? { col: ', scanned_at', mark: ', ?', vals: [o.scannedAt] } : { col: '', mark: '', vals: [] };
  await db.exec(`INSERT INTO pushes (id, project_key, run_id, head_sha, repo_url, at, created, updated${extra.col}) VALUES (?, ?, ?, ?, ?, ?, ?, ?${extra.mark})`,
    [crypto.randomUUID(), projectKey, runId, sqlv(headSha), sqlv(repoUrl), at, created, updated, ...extra.vals]);
  return { results };
}

/**
 * @typedef {{projectKey: string, runId: string, headSha?: string, at: string, fp: string, record: Record<string, any>}} FileOpts
 * @typedef {{i: number, o: FileOpts}} FileJob  `i` = the record's position in the push (its result's position)
 * @typedef {{added: number, count: number, types: string[]}} Union
 */

/** The proposals columns a new item is inserted with (`fileAll`), in order. */
const PROPOSAL_COLS = ['id', 'ref', 'project_key', 'fp', 'status', 'lens', 'title', 'confidence', 'record_json', 'evidence_count', 'evidence_types',
  'first_run_id', 'last_run_id', 'first_seen', 'last_push_at', 'reopened', 'change_kind', 'score', 'band', 'mvp', 'pretriaged_by'];

/**
 * Files the valid records of one push as sets, with the answers and rows the per-record path (`fileOne`) gives:
 * one IN read of the fps the inbox holds; for the new ones one block of DW numbers (counter CAS value -> value + n),
 * multi-row INSERTs of the proposals (counts set from their own evidence) and of their evidence; for the held ones
 * one key read, multi-row INSERTs of the new evidence, one count read where rows were added, and an UPDATE only for
 * a card that changed. A new fp a concurrent push filed first makes its chunk fall back row by row
 * (store.mjs `insertMany`); that record is then updated as an existing one, its DW number burnt. A second record
 * of an fp already in this push is filed after the rest, by `fileOne`, as the per-record path would.
 * @param {Deps} deps
 * @param {FileJob[]} jobs
 * @param {PushResultRow[]} results  written at each job's `i`
 */
async function fileAll(deps, jobs, results) {
  const { db, links } = deps;
  if (jobs.length === 0) return;
  const { projectKey } = jobs[0].o;
  /** @type {Set<string>} */
  const fps = new Set();
  /** @type {FileJob[]} */
  const firsts = [];
  /** @type {FileJob[]} */
  const repeats = [];
  for (const j of jobs) {
    if (fps.has(j.o.fp)) repeats.push(j);
    else { fps.add(j.o.fp); firsts.push(j); }
  }
  const stored = await proposalRowsByFp(db, projectKey, [...fps]);
  /** @type {{j: FileJob, p: ProposalRow}[]} */
  const lost = [];

  const fresh = firsts.filter((j) => !stored.has(j.o.fp));
  if (fresh.length > 0) {
    const first = await nextCounterBlock(db, 'ref', fresh.length);
    const plans = fresh.map((j, k) => ({ j, n: first + k, ev: evidenceRows(first + k, j.o.record.evidence, new Set(), j.o) }));
    const filed = await insertMany(db, 'proposals', PROPOSAL_COLS, plans.map(({ j: { o }, n, ev }) => [
      n, `DW-${n}`, o.projectKey, o.fp, 'open', o.record.lens, o.record.title, o.record.confidence, storedRecord(o.record),
      ev.rows.length, [...new Set(ev.types)].sort().join(','), o.runId, o.runId, o.at, o.at, 0, 'new', ...rankCols(o.record),
    ]));
    await insertMany(db, 'evidence', EVIDENCE_COLS, plans.filter((_, k) => filed[k]).flatMap((pl) => pl.ev.rows));
    for (const [k, { j, n }] of plans.entries()) {
      if (filed[k]) {
        results[j.i] = { fp: j.o.fp, result: 'created', external_ref: `DW-${n}`, external_url: await links.inboxUrl(`DW-${n}`) };
        continue;
      }
      // A concurrent push filed the same fp first (UNIQUE (project_key, fp)); the DW number is burnt. Update it.
      const p = await getByFp(db, projectKey, j.o.fp);
      if (!p) throw new DuplicateKey(`DW-${n} could not be filed and no proposal holds fp ${j.o.fp}`);
      lost.push({ j, p });
    }
  }

  const held = firsts.flatMap((j) => {
    const row = stored.get(j.o.fp);
    return row ? [{ j, row, p: toProposal(row) }] : [];
  });
  if (held.length > 0) {
    const before = await ekeysOfMany(db, held.map(({ p }) => p));
    const plans = held.map((h) => ({ ...h, ev: evidenceRows(h.p.id, h.j.o.record.evidence, /** @type {any} */ (before.get(h.p.id)).keys, h.j.o), added: 0 }));
    const ok = await insertMany(db, 'evidence', EVIDENCE_COLS, plans.flatMap((pl) => pl.ev.rows));
    let at = 0;
    for (const pl of plans) {
      pl.added = ok.slice(at, at + pl.ev.rows.length).filter(Boolean).length;
      at += pl.ev.rows.length;
    }
    // The union's size and types: re-read where rows were tried (a concurrent push may have added some), else as read.
    const tried = plans.filter((pl) => pl.ev.rows.length > 0);
    const after = tried.length > 0 ? await ekeysOfMany(db, tried.map((pl) => ({ id: pl.p.id, evidence_count: pl.p.evidence_count + pl.ev.rows.length }))) : new Map();
    for (const pl of plans) {
      const k = /** @type {{types: Set<string>, count: number}} */ (after.get(pl.p.id) ?? before.get(pl.p.id));
      /** @type {Union} */
      const u = { added: pl.added, count: k.count, types: [...k.types].sort() };
      await refresh(db, pl.p, pl.j.o, u, pl.row);
      if (pl.p.status === 'accepted') await markRecurred(deps, pl.p.id, pl.j.o.at);
      results[pl.j.i] = await settle(deps, pl.p, pl.j.o, u);
    }
  }

  for (const { j, p } of lost) results[j.i] = await updateOne(deps, p, j.o);
  for (const j of repeats) results[j.i] = await fileOne(deps, j.o);
}

/** A stored or bound value, compared as text (a driver may answer a number as a string). @param {unknown} v */
const same = (v) => (v === null || v === undefined ? '\u0000' : String(v));

/**
 * Refreshes the card of a held item: the stored copies of the record and the union's counts; the item moves to
 * this push's group only when its evidence grew (F8 run diff). With `row` (the stored row as read), an item that
 * neither grew nor changed is not written: the UPDATE would rewrite every value with itself.
 * @param {Db} db
 * @param {ProposalRow} p
 * @param {FileOpts} o
 * @param {Union} u
 * @param {Row} [row]
 */
async function refresh(db, p, o, u, row) {
  const grew = u.added > 0;
  const values = [o.record.lens, o.record.title, o.record.confidence, storedRecord(o.record), u.count, u.types.join(','), ...rankCols(o.record)];
  if (!grew && row) {
    const now = [row.lens, row.title, row.confidence, row.record_json, row.evidence_count, row.evidence_types, row.score, row.band, row.mvp, row.pretriaged_by];
    if (values.every((v, i) => same(v) === same(now[i]))) return;
  }
  await db.exec(
    `UPDATE proposals SET lens = ?, title = ?, confidence = ?, record_json = ?, evidence_count = ?, evidence_types = ?,
      score = ?, band = ?, mvp = ?, pretriaged_by = ?
      ${grew ? ", last_run_id = ?, last_push_at = ?, change_kind = 'grew'" : ''} WHERE id = ?`,
    [...values, ...(grew ? [o.runId, o.at] : []), p.id],
  );
}

/**
 * Files one valid record: create, or update + unite + maybe reopen, or redirect to the surviving item.
 * @param {Deps} deps
 * @param {FileOpts} o
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
          first_run_id, last_run_id, first_seen, last_push_at, reopened, change_kind, score, band, mvp, pretriaged_by)
          VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, 0, '', ?, ?, ?, ?, 0, 'new', ?, ?, ?, ?)`,
        [n, ref, o.projectKey, o.fp, o.record.lens, o.record.title, o.record.confidence, storedRecord(o.record), o.runId, o.runId, o.at, o.at, ...rankCols(o.record)],
      );
      const u = await uniteEvidence(db, n, o.record.evidence, { runId: o.runId, headSha: o.headSha, at: o.at, fresh: true });
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
 * @param {FileOpts} o
 * @returns {Promise<PushResultRow>}
 */
async function updateOne(deps, p, o) {
  const u = await uniteEvidence(deps.db, p.id, o.record.evidence, { runId: o.runId, headSha: o.headSha, at: o.at });
  await refresh(deps.db, p, o, u);
  // a delivered card a later scan finds again: the finding came back (core/delivery.mjs)
  if (p.status === 'accepted') await markRecurred(deps, p.id, o.at);
  return settle(deps, p, o, u);
}

/**
 * What a held item answers after its evidence was united and its card refreshed: the survivor of a merge, or
 * itself, reopened first when a dated snooze is due or its growth resurfaces it (F3).
 * @param {Deps} deps
 * @param {ProposalRow} p  the item as it was before this push
 * @param {FileOpts} o
 * @param {Union} u
 * @returns {Promise<PushResultRow>}
 */
async function settle(deps, p, o, u) {
  const { db, links } = deps;
  const grew = u.added > 0;
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

