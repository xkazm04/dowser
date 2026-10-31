// @ts-check
// The Forge seam, local side (D11): the AGENT calls the Forge MCP tools (the harness owns the connection and
// its OAuth); this module only builds the push payload and ingests the tool responses. No MCP client, no
// network, no auth here. Contract: docs/contracts/forge-mcp-2.md.
//
//   outbox          -> the `dowser_proposals_push` arguments {project_key, run_id, proposals_json, repo_url?,
//                      head_sha?, more?}: verified items not yet pushed, plus pushed items whose evidence grew
//                      since their last push (tracked in sync_state `push_seq:<fp>`), at most PUSH_MAX per call
//   ingestPush      <- the `dowser_proposals_push` response: created|updated -> pushed + external_ref/url (the
//                      inbox item, `DW-12`), merged-existing -> merged|linked, refused -> unchanged and reported
//   ingestVerdicts  <- the `dowser_verdicts_pull` response: each verdict through store.move (CAS), idempotent
//                      per (fp, decided_at); an accepted verdict records issue_ref/issue_url (the Jira issue);
//                      the cursor is kept in sync_state `verdicts_cursor`
//   areas           -> the `dowser_areas_push` arguments {project_key, run_id, areas_json}: per-directory files,
//                      churn and authors relative to the run's head commit (read-only git; writes nothing)
//   ingestSources   <- a `dowser_sources_*` response: rows in sources_cache, refs returned for citing
//
// sync_state keys this module owns:
//   verdicts_cursor            the cursor of the last ingested verdicts page (absent before the first pull)
//   push_seq:<fp>              the fp's evidence seq (max evidence id) when it was last pushed
//   outbox:last                {run_id, at, seqs: {fp: seq}} - the evidence seq each fp had in the last outbox,
//                              so ingest-push records what was actually sent, not what grew in between
//   verdict:<fp>@<decided_at>  {status, outcome, at} - a verdict already ingested (the idempotency key)
import { readFileSync } from 'node:fs';
import { DowserError, MoveRefused, QUOTED_TYPES, REASONS, isOneOf } from './model.mjs';
import { quoteSha } from './fingerprint.mjs';
import * as store from './store.mjs';
import { commitDate, commitsSince, lastChange, treeFiles } from './git.mjs';
import { syncTrust } from './trust.mjs';

/** The decider written for the moves this module makes on its own (verified -> pushed, merged-existing). */
export const SYNC_DECIDER = 'skill:dowser-sync';
/** The fields of a `dowser-proposal/2` record, in order (skill/schema/dowser-proposal-2.schema.json). */
export const RECORD_KEYS = /** @type {const} */ (['fp', 'lens', 'kind', 'topic', 'anchors', 'title', 'rationale', 'body',
  'evidence', 'effort', 'confidence', 'confidence_why', 'doc_impact', 'delivery_risk', 'artifacts', 'provenance',
  'category', 'impact', 'impact_why', 'risk', 'score', 'score_parts', 'band', 'mvp', 'mvp_rule', 'mvp_why',
  'predicted_verdict', 'predicted_why', 'predicted_by', 'pretriaged_by', 'status', 'reason',
  'note', 'merged_into', 'external_ref', 'external_url', 'decided_by', 'decided_at']);
export const PUSH_RESULTS = /** @type {const} */ (['created', 'updated', 'merged-existing', 'refused']);
export const VERDICT_STATUSES = /** @type {const} */ (['accepted', 'rejected', 'merged', 'snoozed']);
export const SOURCE_TYPES = /** @type {const} */ (['ticket', 'page', 'goal']);
/** At most this many records per `dowser_proposals_push` call (forge-mcp-2). */
export const PUSH_MAX = 50;
/** `areas --top` default and ceiling (forge-mcp-2 `areas_json`: at most 200). */
export const AREAS_TOP = 40;
export const AREAS_MAX = 200;
/** The churn window, in days before the run's head commit. */
export const CHURN_DAYS = 90;

/**
 * @typedef {import('./store.mjs').Db} Db
 * @typedef {import('./store.mjs').Row} Row
 * @typedef {{project_key: string, run_id: string, proposals_json: string, repo_url?: string, head_sha?: string, lens_kinds_json?: string, more?: true}} OutboxArgs
 */

// ------------------------------------------------------------------------------------------------ sync_state

/**
 * @param {Db} db
 * @param {string} key
 * @returns {string | undefined}
 */
export function getState(db, key) {
  const r = /** @type {Row | undefined} */ (db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key));
  return r && r.value !== null ? String(r.value) : undefined;
}

/**
 * @param {Db} db
 * @param {string} key
 * @param {string} value
 */
export function setState(db, key, value) {
  db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
}

/**
 * The stored verdicts cursor, or undefined before the first pull (init prints it as `verdicts_cursor`).
 * @param {Db} db
 * @returns {string | undefined}
 */
export const verdictsCursor = (db) => getState(db, 'verdicts_cursor');

/**
 * The fp's evidence seq at its last push: sync_state `push_seq:<fp>`, else the seq of its `pushed` transition.
 * @param {Db} db
 * @param {string} fp
 * @returns {number | undefined}
 */
function pushedSeq(db, fp) {
  const s = getState(db, `push_seq:${fp}`);
  if (s !== undefined) return Number(s);
  const t = /** @type {Row | undefined} */ (db.prepare("SELECT evidence_seq FROM transitions WHERE fp = ? AND to_status = 'pushed' ORDER BY id DESC LIMIT 1").get(fp));
  return t ? Number(t.evidence_seq) : undefined;
}

// ------------------------------------------------------------------------------------------------ outbox

/**
 * The `dowser-proposal/1` record of `fp`: the stored card, every evidence row, the triage fields; absent keys
 * omitted, store-internal columns (run ids, timestamps) left out.
 * @param {Db} db
 * @param {string} fp
 * @returns {Row}
 */
export function proposalRecord(db, fp) {
  const p = store.getProposal(db, fp);
  if (!p) throw new DowserError(`proposal ${fp} does not exist`, 2);
  /** @type {Row} */
  const out = {};
  for (const k of RECORD_KEYS) if (p[k] !== undefined) out[k] = p[k];
  return out;
}

/**
 * Builds the `dowser_proposals_push` arguments `{project_key, run_id, proposals_json, repo_url?, head_sha?}`:
 * every `verified` item (not pushed yet - a pre-rejected, snoozed or merged item is not verified, so never
 * included), plus every `pushed` item whose evidence grew since its last push, as a JSON string of
 * `dowser-proposal/1` records. At most `limit` (PUSH_MAX) records; when more are pending, `more: true` is added
 * (push, ingest, then run outbox again). `head_sha` is the run's; `repo_url` is the caller's web URL of origin.
 * Records the evidence seq of each record sent in sync_state `outbox:last`.
 * `quotes` is the runner's `quotes` preference, which the CLI reads and passes (default `send`): `omit` sends each
 * code/doc quote as `quote_sha` (its `quoteSha`) instead of the line.
 * The store is untouched either way; `verify` and ask-why keep the stored quotes.
 * `lensKinds` (the CLI's `--kinds`, the lens packs' closed kind lists) is sent as `lens_kinds_json`, narrowed to
 * the lenses of the records sent; Forge then refuses a record whose kind its lens lacks. Absent -> key omitted.
 * @param {Db} db
 * @param {{projectKey: string, runId: string, repoUrl?: string, limit?: number, quotes?: 'send' | 'omit', lensKinds?: Record<string, string[]>}} o
 * @returns {OutboxArgs}
 */
export function outbox(db, { projectKey, runId, repoUrl, limit = PUSH_MAX, quotes, lensKinds }) {
  const run = store.getRun(db, runId);
  if (!run) throw new DowserError(`run ${runId} does not exist`, 2);
  const omit = quotes === 'omit';
  return store.tx(db, () => {
    /** @type {Row[]} */
    const proposals = [];
    /** @type {Record<string, number>} */
    const seqs = {};
    let more = false;
    const rows = /** @type {Row[]} */ (db.prepare("SELECT fp, status FROM proposals WHERE status IN ('verified', 'pushed') ORDER BY lens, fp").all());
    for (const r of rows) {
      const fp = String(r.fp);
      const seq = store.evidenceSnapshot(db, fp).seq;
      if (r.status === 'pushed') {
        const last = pushedSeq(db, fp);
        if (last !== undefined && seq <= last) continue;
      }
      if (proposals.length >= limit) { more = true; break; }
      proposals.push(omit ? withheldQuotes(proposalRecord(db, fp)) : proposalRecord(db, fp));
      seqs[fp] = seq;
    }
    setState(db, 'outbox:last', JSON.stringify({ run_id: runId, at: store.now(), seqs }));
    // Narrowed to the lenses sent. A sent lens --kinds does not name stays out, so Forge refuses its records and
    // names the lens; when no sent lens is named, the whole map goes (Forge never gets an empty one).
    /** @type {string | undefined} */
    let kindsJson;
    if (lensKinds && proposals.length) {
      const named = [...new Set(proposals.map((p) => String(p.lens)))].filter((l) => Object.hasOwn(lensKinds, l));
      kindsJson = JSON.stringify(named.length ? Object.fromEntries(named.map((l) => [l, lensKinds[l]])) : lensKinds);
    }
    return /** @type {OutboxArgs} */ (store.clean({
      project_key: projectKey, run_id: runId, proposals_json: JSON.stringify(proposals),
      repo_url: repoUrl, head_sha: typeof run.head_sha === 'string' ? run.head_sha : undefined, lens_kinds_json: kindsJson,
      more: more || undefined,
    }));
  });
}

/** The card fields a withheld quote is masked in: every text field a person reads, views included. */
const MASKED_FIELDS = /** @type {const} */ (['title', 'rationale', 'body', 'confidence_why', 'artifacts', 'impact_why', 'predicted_why']);

/**
 * `value` with every string in it (deeply, so a view's message, alt, cells and step labels too) passed through `f`.
 * @param {unknown} value @param {(s: string) => string} f @returns {unknown}
 */
const mapStrings = (value, f) => typeof value === 'string' ? f(value)
  : Array.isArray(value) ? value.map((v) => mapStrings(v, f))
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, f)]))
      : value;

/**
 * The record with each code/doc evidence quote replaced by its `quote_sha` (`quotes=omit`); type, ref and url
 * stay. A quoted line the card repeats verbatim in any text a person reads (MASKED_FIELDS) becomes "the line at
 * <ref>" (backticks around it included), so the sentence still reads and the line does not leave. The procedure
 * asks the agent to describe such lines in words under `omit`; this is the backstop. Fragments of a line are not
 * matched. A new record and new evidence objects: the stored row is not touched.
 * @param {Row} record
 * @returns {Row}
 */
export function withheldQuotes(record) {
  if (!Array.isArray(record.evidence)) return record;
  const quoted = record.evidence.filter((/** @type {Row} */ e) => isOneOf(QUOTED_TYPES, e.type) && typeof e.quote === 'string' && e.quote.trim().length >= 8);
  /** @param {string} t */
  const mask = (t) => quoted.reduce((acc, /** @type {Row} */ e) => {
    const q = String(e.quote).trim();
    return acc.split(`\`${q}\``).join(`the line at ${e.ref}`).split(q).join(`the line at ${e.ref}`);
  }, t);
  const text = Object.fromEntries(MASKED_FIELDS.filter((k) => record[k] !== undefined).map((k) => [k, mapStrings(record[k], mask)]));
  const evidence = record.evidence.map((/** @type {Row} */ e) => {
    if (!isOneOf(QUOTED_TYPES, e.type) || typeof e.quote !== 'string') return e;
    const { quote, ...rest } = e;
    /** @type {Row} */
    const out = { type: rest.type, ref: rest.ref, quote_sha: quoteSha(quote) };
    if (rest.url !== undefined) out.url = rest.url;
    return out;
  });
  return { ...record, ...text, evidence };
}

// ------------------------------------------------------------------------------------------------ helpers

/**
 * Reads a saved tool response (`--file`): the JSON object the tool returned. A file holding an MCP tool result
 * envelope (`{content: [{type: 'text', text}]}` or `{structuredContent}`) is unwrapped, so either form works.
 * @param {string} file
 * @returns {unknown}
 */
export function readResponse(file) {
  /** @type {unknown} */
  let doc;
  try { doc = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (e) {
    throw new DowserError(`--file ${file} is not readable JSON (${/** @type {Error} */ (e).message})`, 2);
  }
  if (isObj(doc) && doc.isError === true) throw new DowserError(`--file ${file} holds a tool error, not a response`, 2, { error: 'tool-error', response: doc });
  if (isObj(doc) && isObj(doc.structuredContent)) return doc.structuredContent;
  if (isObj(doc) && Array.isArray(doc.content) && doc.content.length === 1 && isObj(doc.content[0]) && typeof doc.content[0].text === 'string') {
    try { return JSON.parse(doc.content[0].text); } catch { /* not JSON text: fall through */ }
  }
  return doc;
}

/** @param {unknown} v */
const str = (v) => typeof v === 'string' && v.trim().length > 0;
/** @param {unknown} v @returns {v is Row} */
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The array under `key` of a tool response, or a DowserError (exit 2).
 * @param {unknown} doc
 * @param {string} key
 * @param {string} tool
 * @returns {unknown[]}
 */
function listOf(doc, key, tool) {
  if (!isObj(doc) || !Array.isArray(doc[key])) throw new DowserError(`not a ${tool} response: expected {"${key}": [...]}`, 2);
  return doc[key];
}

/**
 * @param {Db} db
 * @param {string} fp
 * @returns {string | undefined}
 */
const statusOf = (db, fp) => {
  const r = /** @type {Row | undefined} */ (db.prepare('SELECT status FROM proposals WHERE fp = ?').get(fp));
  return r ? String(r.status) : undefined;
};

/**
 * The local fp an external ref (inbox item, `DW-12`) belongs to, if any.
 * @param {Db} db
 * @param {string} ref
 * @returns {string | undefined}
 */
const fpOfRef = (db, ref) => {
  const r = /** @type {Row | undefined} */ (db.prepare('SELECT fp FROM proposals WHERE external_ref = ?').get(ref));
  return r ? String(r.fp) : undefined;
};

/**
 * Sets external_ref / external_url on fp. Returns a conflict reason when the ref already belongs to another fp.
 * @param {Db} db
 * @param {string} fp
 * @param {string} ref
 * @param {string | undefined} url
 * @returns {string | undefined}
 */
function link(db, fp, ref, url) {
  const owner = fpOfRef(db, ref);
  if (owner !== undefined && owner !== fp) return `external_ref ${ref} already belongs to ${owner}`;
  db.prepare('UPDATE proposals SET external_ref = ?, external_url = COALESCE(?, external_url), updated_at = ? WHERE fp = ?')
    .run(ref, url ?? null, store.now(), fp);
  return undefined;
}

// ------------------------------------------------------------------------------------------------ ingest-push

/**
 * Applies a `dowser_proposals_push` response `{results: [{fp, result, external_ref?, external_url?, why?}]}`.
 *  - created | updated: external_ref/url recorded; `verified -> pushed` (CAS, by skill:dowser-sync); an item
 *    already `pushed` stays pushed (outcome `updated`); any other local status is a `conflict`, nothing changed.
 *  - merged-existing: the item merged into the local fp that owns external_ref (outcome `merged`); when no local
 *    item owns it, the item is linked to that inbox item and moved to `pushed` (outcome `linked`) - see the contract.
 *  - refused: status unchanged, reported with `why`.
 *  - unknown fp, a malformed result, or a CAS refusal: reported, never forced.
 * The evidence seq sent (from `outbox:last`, else the current one) is stored as `push_seq:<fp>`.
 * @param {Db} db
 * @param {unknown} doc
 * @returns {{code: number, out: Row}}
 */
export function ingestPush(db, doc) {
  const results = listOf(doc, 'results', 'dowser_proposals_push');
  /** @type {Record<string, number>} */
  let sent = {};
  try { sent = JSON.parse(getState(db, 'outbox:last') ?? '{}').seqs ?? {}; } catch { /* no usable snapshot */ }
  /** @type {Row[]} */
  const items = [];
  /** @type {Record<string, number>} */
  const summary = {};
  for (const [i, raw] of results.entries()) {
    const item = store.tx(db, () => pushOne(db, raw, i, sent));
    summary[String(item.outcome)] = (summary[String(item.outcome)] ?? 0) + 1;
    items.push(item);
  }
  const bad = items.filter((x) => !['pushed', 'updated', 'merged', 'linked'].includes(String(x.outcome))).length;
  return { code: bad > 0 ? 1 : 0, out: { results: items, summary } };
}

/**
 * @param {Db} db
 * @param {unknown} raw
 * @param {number} i
 * @param {Record<string, number>} sent
 * @returns {Row}
 */
function pushOne(db, raw, i, sent) {
  if (!isObj(raw) || !str(raw.fp)) return { index: i, outcome: 'invalid', why: 'a result needs fp' };
  const fp = String(raw.fp);
  if (!isOneOf(PUSH_RESULTS, raw.result)) return { index: i, fp, outcome: 'invalid', why: `result must be one of ${PUSH_RESULTS.join('|')}` };
  const result = String(raw.result);
  const current = statusOf(db, fp);
  if (current === undefined) return { fp, result, outcome: 'unknown', why: 'no local proposal with this fp' };
  if (result === 'refused') return store.clean({ fp, result, outcome: 'refused', status: current, why: str(raw.why) ? raw.why : undefined }) ?? {};
  if (!str(raw.external_ref)) return { fp, result, outcome: 'invalid', status: current, why: `${result} needs external_ref` };
  const ref = String(raw.external_ref);
  const url = str(raw.external_url) ? String(raw.external_url) : undefined;
  const seq = String(sent[fp] ?? store.evidenceSnapshot(db, fp).seq);
  /** @param {Row} r */
  const done = (r) => /** @type {Row} */ (store.clean({ fp, result, ...r, external_ref: ref, external_url: url }));

  if (result === 'merged-existing') {
    const owner = fpOfRef(db, ref);
    if (owner !== undefined && owner !== fp) {
      try {
        store.move(db, fp, 'merged', { from: current, by: SYNC_DECIDER, into: owner, note: `forge:merged-existing ${ref}` });
      } catch (e) {
        if (e instanceof MoveRefused) return done({ outcome: 'conflict', status: e.current, why: e.message });
        throw e;
      }
      return done({ outcome: 'merged', status: 'merged', merged_into: owner });
    }
    // no local item owns the inbox ref: this fp is now represented by it - link it and treat it as pushed
  }

  if (current !== 'verified' && current !== 'pushed') {
    return done({ outcome: 'conflict', status: current, why: `local status is ${current}; only verified or pushed items take a push result` });
  }
  const clash = link(db, fp, ref, url);
  if (clash) return done({ outcome: 'conflict', status: current, why: clash });
  if (current === 'verified') {
    try {
      store.move(db, fp, 'pushed', { from: 'verified', by: SYNC_DECIDER, note: result === 'merged-existing' ? `forge:merged-existing ${ref}` : undefined });
    } catch (e) {
      if (e instanceof MoveRefused) return done({ outcome: 'conflict', status: e.current, why: e.message });
      throw e;
    }
  }
  setState(db, `push_seq:${fp}`, seq);
  const outcome = result === 'merged-existing' ? 'linked' : current === 'verified' ? 'pushed' : 'updated';
  return done({ outcome, status: 'pushed' });
}

// ------------------------------------------------------------------------------------------------ ingest-verdicts

/**
 * Applies a `dowser_verdicts_pull` response `{verdicts: [...], cursor}`. Each verdict goes through store.move
 * (CAS) with `by` = its `decided_by`; `decided_at` on the card becomes the verdict's. Idempotent per
 * (fp, decided_at): an ingested verdict is recorded in sync_state and skipped next time (`already-applied`).
 * A verdict that matches the local status already is `in-sync`. An `accepted` verdict needs `issue_ref` and
 * `issue_url` (else `invalid`) and records both on the proposal. A `snoozed` verdict's `snooze_until` becomes the
 * card's snooze date, even one already past (the next run start wakes it). An unknown fp, a malformed verdict or an
 * illegal transition is reported (`unknown`, `invalid`, `conflict`), never forced. The cursor is stored as `verdicts_cursor`.
 * @param {Db} db
 * @param {unknown} doc
 * @returns {{code: number, out: Row}}
 */
export function ingestVerdicts(db, doc) {
  const verdicts = listOf(doc, 'verdicts', 'dowser_verdicts_pull');
  const d = /** @type {Row} */ (doc);
  if (d.cursor !== undefined && typeof d.cursor !== 'string') throw new DowserError('cursor must be a string (omit it when absent)', 2);
  /** @type {Row[]} */
  const items = [];
  /** @type {Record<string, number>} */
  const summary = {};
  for (const [i, raw] of verdicts.entries()) {
    const item = store.tx(db, () => verdictOne(db, raw, i));
    summary[String(item.outcome)] = (summary[String(item.outcome)] ?? 0) + 1;
    items.push(item);
  }
  if (typeof d.cursor === 'string') setState(db, 'verdicts_cursor', d.cursor);
  // the people's verdicts are what each slice's trust is measured against (trust.mjs)
  const trust = syncTrust(db);
  const bad = items.filter((x) => !['applied', 'already-applied', 'in-sync'].includes(String(x.outcome))).length;
  return { code: bad > 0 ? 1 : 0, out: store.clean({ verdicts: items, summary, cursor: typeof d.cursor === 'string' ? d.cursor : undefined, trust_events: trust.length ? trust : undefined }) ?? {} };
}

/**
 * @param {Db} db
 * @param {unknown} raw
 * @param {number} i
 * @returns {Row}
 */
function verdictOne(db, raw, i) {
  if (!isObj(raw) || !str(raw.fp)) return { index: i, outcome: 'invalid', why: 'a verdict needs fp' };
  const fp = String(raw.fp);
  /** @param {string} why */
  const invalid = (why) => ({ index: i, fp, outcome: 'invalid', why });
  if (!isOneOf(VERDICT_STATUSES, raw.status)) return invalid(`status must be one of ${VERDICT_STATUSES.join('|')}`);
  if (!str(raw.decided_by)) return invalid('decided_by is required');
  if (!str(raw.decided_at)) return invalid('decided_at is required');
  if (!str(raw.external_ref)) return invalid('external_ref is required');
  if (raw.reason !== undefined && !isOneOf(REASONS, raw.reason)) return invalid(`reason must be one of ${REASONS.join('|')}`);
  const to = String(raw.status);
  if (to === 'accepted' && (!str(raw.issue_ref) || !str(raw.issue_url))) return invalid('an accepted verdict needs issue_ref and issue_url');
  const issue = to === 'accepted' ? { issue_ref: String(raw.issue_ref), issue_url: String(raw.issue_url) } : undefined;
  const by = String(raw.decided_by);
  const decidedAt = String(raw.decided_at);
  const key = `verdict:${fp}@${decidedAt}`;
  const base = { fp, status: to, decided_by: by, decided_at: decidedAt, ...issue };
  const seen = getState(db, key);
  if (seen !== undefined) return { ...base, outcome: 'already-applied' };

  const current = statusOf(db, fp);
  if (current === undefined) return { ...base, outcome: 'unknown', why: 'no local proposal with this fp' };
  if (current === to) {
    if (issue) recordIssue(db, fp, issue);
    setState(db, key, JSON.stringify({ status: to, outcome: 'in-sync', at: store.now() }));
    return { ...base, outcome: 'in-sync' };
  }
  /** @type {string | undefined} */
  let into;
  if (to === 'merged') {
    if (!str(raw.merged_into)) return invalid('a merged verdict needs merged_into');
    const m = String(raw.merged_into);
    into = statusOf(db, m) !== undefined ? m : fpOfRef(db, m);
    if (into === undefined) return { ...base, outcome: 'conflict', current, why: `merged_into ${m} is neither a local fp nor a known external_ref` };
  }
  try {
    store.move(db, fp, to, {
      by, into,
      reason: str(raw.reason) ? String(raw.reason) : undefined,
      note: str(raw.note) ? String(raw.note) : undefined,
      // a dated snooze from the inbox (DW-42); a date already past is kept and woken by the next run start
      ...(to === 'snoozed' && str(raw.snooze_until) ? { until: String(raw.snooze_until), untilMayBePast: true } : {}),
    });
  } catch (e) {
    if (e instanceof MoveRefused) return { ...base, outcome: 'conflict', current: e.current, why: e.message };
    if (e instanceof DowserError) return invalid(e.message);
    throw e;
  }
  db.prepare('UPDATE proposals SET decided_at = ? WHERE fp = ?').run(decidedAt, fp);
  if (issue) recordIssue(db, fp, issue);
  const ref = String(raw.external_ref);
  const clash = link(db, fp, ref, undefined);
  setState(db, key, JSON.stringify({ status: to, outcome: 'applied', at: store.now() }));
  return /** @type {Row} */ (store.clean({ ...base, outcome: 'applied', from: current, merged_into: into, link_conflict: clash,
    snooze_until: to === 'snoozed' && str(raw.snooze_until) ? String(raw.snooze_until) : undefined }));
}

/**
 * Records on the proposal the Jira issue an accepted verdict created.
 * @param {Db} db
 * @param {string} fp
 * @param {{issue_ref: string, issue_url: string}} issue
 */
function recordIssue(db, fp, issue) {
  db.prepare('UPDATE proposals SET issue_ref = ?, issue_url = ?, updated_at = ? WHERE fp = ?').run(issue.issue_ref, issue.issue_url, store.now(), fp);
}

// ------------------------------------------------------------------------------------------------ ingest-sources

/**
 * The non-empty strings of a source item's list field, or undefined (an absent list is an omitted key).
 * @param {unknown} v
 * @returns {string[] | undefined}
 */
function strList(v) {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter(str).map(String);
  return out.length ? out : undefined;
}

/**
 * Caches a `dowser_sources_tickets|pages|goals` response `{items: [{ref, title, url, body, ...}]}` in
 * sources_cache for the run (a re-fetch of the same ref in the same run refreshes it) and returns the refs the
 * agent may cite as evidence `{type, ref, url?, title?, components?, labels?, created_at?}`. The ticket fields a
 * demand table groups by (components, labels, created_at) are returned to the agent only; the cache keeps
 * ref/title/url/body.
 * @param {Db} db
 * @param {{runId: string, type: string, doc: unknown}} o
 * @returns {{code: number, out: Row}}
 */
export function ingestSources(db, { runId, type, doc }) {
  if (!isOneOf(SOURCE_TYPES, type)) throw new DowserError(`--type must be one of ${SOURCE_TYPES.join('|')}`, 2);
  store.requireRunning(db, runId);
  const items = listOf(doc, 'items', `dowser_sources_${type === 'ticket' ? 'tickets' : type === 'page' ? 'pages' : 'goals'}`);
  return store.tx(db, () => {
    const ins = db.prepare(`INSERT INTO sources_cache (run_id, type, ref, title, url, body, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (run_id, type, ref) DO UPDATE SET title = excluded.title, url = excluded.url, body = excluded.body, fetched_at = excluded.fetched_at`);
    /** @type {Row[]} */
    const refs = [];
    /** @type {Row[]} */
    const skipped = [];
    const at = store.now();
    for (const [i, raw] of items.entries()) {
      if (!isObj(raw) || !str(raw.ref)) { skipped.push({ index: i, why: 'an item needs ref' }); continue; }
      const ref = String(raw.ref).trim();
      const title = str(raw.title) ? String(raw.title) : undefined;
      const url = str(raw.url) ? String(raw.url) : undefined;
      ins.run(runId, type, ref, title ?? null, url ?? null, typeof raw.body === 'string' ? raw.body : null, at);
      refs.push(/** @type {Row} */ (store.clean({
        type, ref, url, title, components: strList(raw.components), labels: strList(raw.labels),
        created_at: str(raw.created_at) ? String(raw.created_at) : undefined,
      })));
    }
    return { code: skipped.length ? 1 : 0, out: store.clean({ run_id: runId, type, cached: refs.length, refs, skipped: skipped.length ? skipped : undefined }) ?? {} };
  });
}

/**
 * The cached sources of a run (optionally one type), for `show` and tests.
 * @param {Db} db
 * @param {string} runId
 * @param {string} [type]
 * @returns {Row[]}
 */
export function sourcesOf(db, runId, type) {
  const rows = type === undefined
    ? db.prepare('SELECT * FROM sources_cache WHERE run_id = ? ORDER BY type, ref').all(runId)
    : db.prepare('SELECT * FROM sources_cache WHERE run_id = ? AND type = ? ORDER BY ref').all(runId, type);
  return /** @type {Row[]} */ (rows).map((r) => /** @type {Row} */ (store.clean(r)));
}


// ------------------------------------------------------------------------------------------------ areas

/**
 * The directories a repo-relative file path lies under, at depth 1 and 2 (`src/checkout/a.js` -> `src`,
 * `src/checkout`; a top-level file -> none).
 * @param {string} path
 * @returns {string[]}
 */
export function areasOf(path) {
  const parts = path.split('/');
  /** @type {string[]} */
  const out = [];
  if (parts.length >= 2) out.push(parts[0]);
  if (parts.length >= 3) out.push(`${parts[0]}/${parts[1]}`);
  return out;
}

/**
 * Builds the `dowser_areas_push` arguments `{project_key, run_id, areas_json}`: the repo's directories at depth
 * 1 and 2 in the tree of the run's head commit, each `{path, files, churn_90d, authors_90d?, last_change?}`,
 * ranked by churn_90d desc, then files desc, then path, capped at `top` (at most AREAS_MAX).
 *  - files: files under the path in the head commit's tree (`git ls-tree -r`);
 *  - churn_90d / authors_90d: non-merge commits reachable from head_sha, committed in the CHURN_DAYS before the
 *    head commit's own date (not the wall clock), that touched the path, and their distinct author e-mails -
 *    from ONE `git log` pass over the repo; authors_90d is omitted when churn_90d is 0 (not measured);
 *  - last_change: the newest commit touching the path - from that pass when it falls in the window, else one
 *    `git log -1` per kept area with no churn; omitted when there is none.
 * Reads git and the run row only; writes nothing (not the store, not the repo).
 * @param {Db} db
 * @param {{root: string, projectKey: string, runId: string, top?: number}} o
 * @returns {{project_key: string, run_id: string, areas_json: string}}
 */
export function areas(db, { root, projectKey, runId, top = AREAS_TOP }) {
  if (!Number.isInteger(top) || top < 1 || top > AREAS_MAX) throw new DowserError(`--top is an integer from 1 to ${AREAS_MAX}`, 2);
  const run = store.getRun(db, runId);
  if (!run) throw new DowserError(`run ${runId} does not exist`, 2);
  const head = typeof run.head_sha === 'string' ? run.head_sha : undefined;
  if (!head) throw new DowserError(`run ${runId} has no head commit; areas needs a repo with at least one commit`, 2, { error: 'no-head' });
  const files = treeFiles(root, head);
  const headAt = commitDate(root, head);
  if (files === undefined || headAt === undefined) throw new DowserError(`git cannot read commit ${head} in ${root}`, 2, { error: 'no-head' });

  /** @type {Map<string, {files: number, churn: number, authors: Set<string>, last?: string}>} */
  const stats = new Map();
  for (const f of files) {
    for (const a of areasOf(f)) {
      const st = stats.get(a) ?? { files: 0, churn: 0, authors: new Set() };
      st.files++;
      stats.set(a, st);
    }
  }
  const since = new Date(Date.parse(headAt) - CHURN_DAYS * 86400000).toISOString();
  for (const c of commitsSince(root, head, since) ?? []) {
    for (const a of new Set(c.paths.flatMap(areasOf))) {
      const st = stats.get(a);
      if (!st) continue; // a directory that no longer exists at head
      st.churn++;
      st.authors.add(c.email);
      if (st.last === undefined || c.at > st.last) st.last = c.at;
    }
  }
  const ranked = [...stats.entries()]
    .sort(([pa, a], [pb, b]) => b.churn - a.churn || b.files - a.files || (pa < pb ? -1 : pa > pb ? 1 : 0))
    .slice(0, top);
  const out = ranked.map(([path, st]) => store.clean({
    path,
    files: st.files,
    churn_90d: st.churn,
    authors_90d: st.churn > 0 ? st.authors.size : undefined,
    last_change: st.last ?? lastChange(root, head, path),
  }));
  return { project_key: projectKey, run_id: runId, areas_json: JSON.stringify(out) };
}
