// @ts-check
// The Dowser store - the ONLY writer of ~/.dowser/projects/<key>/dowser.db, so the agent never writes SQL.
// Pattern taken from ai-registry lens-scan store.mjs: node:sqlite DatabaseSync, WAL, the DDL applied inside one
// BEGIN IMMEDIATE transaction that re-reads user_version, compare-and-set status moves
// (`UPDATE ... WHERE fp = ? AND status = ? RETURNING *`), deciders written as `<kind>:<name>`, NULL columns never
// printed. The schema is Dowser's own (docs/data-model.md).
//
// Store rules this module owns:
//  - `evidence` and `transitions` are append-only: no code path UPDATEs or DELETEs them, and triggers refuse it;
//  - every status move is a compare-and-set against model.TRANSITIONS and appends one `transitions` row;
//  - proposals are written only into a run whose status is `running`;
//  - absent values are NULL in SQL and omitted in JSON, never 0 or null placeholders.
//  - `outcomes` is append-only too (triggers); lib/reflect.mjs writes it.
// `rules`, `sources_cache` and `sync_state` are DDL only here; WP2 (memory) and WP4 (sync) own their logic.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  DECIDER_RE, DowserError, LENSES, LENS_STATES, MoveRefused, RUN_MODES, STATUSES,
  canMove, deciderAllowed, decisionProblem, isOneOf, resurfaces, validateCandidate,
} from './model.mjs';
import { evidenceKey, fingerprint, normalizeAnchor, normalizeTopic } from './fingerprint.mjs';

export const USER_VERSION = 4;
/** The decider the store itself writes for machine moves (creation, resurfacing). */
export const SYSTEM_DECIDER = 'skill:dowser';

export const DDL = `
PRAGMA user_version = ${USER_VERSION};

CREATE TABLE IF NOT EXISTS runs (
  id           TEXT PRIMARY KEY,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  head_sha     TEXT,
  base_sha     TEXT,
  mode         TEXT NOT NULL CHECK (mode IN ('full','incremental','focused')),
  focus        TEXT,
  harness      TEXT,
  model        TEXT,
  status       TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','failed')),
  lenses_json  TEXT
);
CREATE INDEX IF NOT EXISTS runs_status_finished ON runs (status, finished_at);

CREATE TABLE IF NOT EXISTS proposals (
  fp                  TEXT PRIMARY KEY,
  lens                TEXT NOT NULL CHECK (lens IN ('opportunity','ux-friction','doc-drift','security-cra')),
  kind                TEXT NOT NULL,
  topic               TEXT NOT NULL,
  anchors_json        TEXT NOT NULL,
  title               TEXT NOT NULL,
  rationale           TEXT NOT NULL,
  body                TEXT NOT NULL,
  effort_json         TEXT NOT NULL,
  confidence          TEXT NOT NULL CHECK (confidence IN ('low','medium','high')),
  confidence_why      TEXT NOT NULL,
  doc_impact_json     TEXT,
  delivery_risk_json  TEXT,
  provenance_json     TEXT NOT NULL,
  asserted_json       TEXT NOT NULL DEFAULT '[]', -- [{type, key, ref, line?}] the newest propose line carried: what verify checks
  status              TEXT NOT NULL CHECK (status IN ('candidate','verified','dropped','rejected','snoozed','merged','pushed','accepted')),
  reason              TEXT CHECK (reason IN ('false-positive','already-known','not-our-direction','not-worth-it','wrong-size','other')),
  note                TEXT,
  merged_into         TEXT REFERENCES proposals (fp),
  external_ref        TEXT,
  external_url        TEXT,
  issue_ref           TEXT, -- v2: the Jira issue an accepted verdict created (forge-mcp-2), else NULL
  issue_url           TEXT, -- v2: a link to that issue
  artifacts_json      TEXT, -- v4: the card's supporting views (model.mjs ARTIFACT_KINDS), else NULL
  decided_by          TEXT,
  decided_at          TEXT,
  first_run_id        TEXT NOT NULL REFERENCES runs (id),
  last_run_id         TEXT NOT NULL REFERENCES runs (id),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS proposals_external_ref ON proposals (external_ref) WHERE external_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS proposals_lens_status ON proposals (lens, status);
CREATE INDEX IF NOT EXISTS proposals_last_run ON proposals (last_run_id, status);

-- append-only. key = the evidence identity: code/doc '<path>' + newline + '<whitespace-normalized quote>' (the
-- line is only a hint, kept in column line, so a line shift is not new evidence); every other type the trimmed
-- ref. One row per (fp, type, key), written the first time the key is seen. "New evidence" means a new key.
CREATE TABLE IF NOT EXISTS evidence (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  fp        TEXT NOT NULL REFERENCES proposals (fp),
  run_id    TEXT NOT NULL REFERENCES runs (id),
  type      TEXT NOT NULL CHECK (type IN ('code','doc','git','ticket','page','goal','dep','sarif')),
  ref       TEXT NOT NULL,
  key       TEXT NOT NULL,
  path      TEXT,
  line      INTEGER,
  quote     TEXT,
  url       TEXT,
  added_at  TEXT NOT NULL,
  UNIQUE (fp, type, key)
);
CREATE TRIGGER IF NOT EXISTS evidence_no_update BEFORE UPDATE ON evidence BEGIN SELECT RAISE(ABORT, 'evidence is append-only'); END;
CREATE TRIGGER IF NOT EXISTS evidence_no_delete BEFORE DELETE ON evidence BEGIN SELECT RAISE(ABORT, 'evidence is append-only'); END;

-- append-only. evidence_seq = max(evidence.id) of the fp when the move happened: the evidence snapshot the
-- resurfacing rule compares against ("refs at rejection time").
CREATE TABLE IF NOT EXISTS transitions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  fp            TEXT NOT NULL REFERENCES proposals (fp),
  from_status   TEXT,
  to_status     TEXT NOT NULL,
  by            TEXT NOT NULL,
  at            TEXT NOT NULL,
  reason        TEXT,
  note          TEXT,
  run_id        TEXT,
  evidence_seq  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS transitions_fp ON transitions (fp, id);
CREATE TRIGGER IF NOT EXISTS transitions_no_update BEFORE UPDATE ON transitions BEGIN SELECT RAISE(ABORT, 'transitions is append-only'); END;
CREATE TRIGGER IF NOT EXISTS transitions_no_delete BEFORE DELETE ON transitions BEGIN SELECT RAISE(ABORT, 'transitions is append-only'); END;

-- WP2 (memory) owns the logic
CREATE TABLE IF NOT EXISTS rules (
  id            TEXT PRIMARY KEY,
  lens          TEXT NOT NULL,
  text          TEXT NOT NULL,
  cluster_json  TEXT,
  state         TEXT NOT NULL CHECK (state IN ('offered','accepted','declined')),
  offered_at    TEXT NOT NULL,
  decided_at    TEXT
);

-- WP4 (sync) owns the logic
CREATE TABLE IF NOT EXISTS sources_cache (
  run_id      TEXT NOT NULL,
  type        TEXT NOT NULL,
  ref         TEXT NOT NULL,
  title       TEXT,
  url         TEXT,
  body        TEXT,
  fetched_at  TEXT NOT NULL,
  PRIMARY KEY (run_id, type, ref)
);
CREATE TABLE IF NOT EXISTS sync_state (
  key    TEXT PRIMARY KEY,
  value  TEXT
);

-- v3: what a person said about an accepted item once it was built (dowser_reflect_sync). Append-only; unique
-- (fp, recorded_at) makes a replayed sync a no-op. No FK on fp: an outcome may name an item this store never saw.
CREATE TABLE IF NOT EXISTS outcomes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  fp           TEXT NOT NULL,
  ref          TEXT NOT NULL,
  rating       TEXT NOT NULL CHECK (rating IN ('right','partly','wrong')),
  note         TEXT,
  issue_ref    TEXT NOT NULL,
  decided_by   TEXT NOT NULL,
  recorded_at  TEXT NOT NULL,
  UNIQUE (fp, recorded_at)
);
CREATE INDEX IF NOT EXISTS outcomes_fp ON outcomes (fp, id);
CREATE TRIGGER IF NOT EXISTS outcomes_no_update BEFORE UPDATE ON outcomes BEGIN SELECT RAISE(ABORT, 'outcomes is append-only'); END;
CREATE TRIGGER IF NOT EXISTS outcomes_no_delete BEFORE DELETE ON outcomes BEGIN SELECT RAISE(ABORT, 'outcomes is append-only'); END;
`;

/**
 * In-place upgrades, keyed by the version they start from. Each runs inside openStore's BEGIN IMMEDIATE after
 * user_version was re-read, and ends by setting the next version. Columns are only ever added (no rewrite).
 * @type {Record<number, string>}
 */
export const MIGRATIONS = {
  1: `
ALTER TABLE proposals ADD COLUMN issue_ref TEXT;
ALTER TABLE proposals ADD COLUMN issue_url TEXT;
PRAGMA user_version = 2;
`,
  2: `
-- v3: what a person said about an accepted item once it was built (dowser_reflect_sync). Append-only; unique
-- (fp, recorded_at) makes a replayed sync a no-op. No FK on fp: an outcome may name an item this store never saw.
CREATE TABLE IF NOT EXISTS outcomes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  fp           TEXT NOT NULL,
  ref          TEXT NOT NULL,
  rating       TEXT NOT NULL CHECK (rating IN ('right','partly','wrong')),
  note         TEXT,
  issue_ref    TEXT NOT NULL,
  decided_by   TEXT NOT NULL,
  recorded_at  TEXT NOT NULL,
  UNIQUE (fp, recorded_at)
);
CREATE INDEX IF NOT EXISTS outcomes_fp ON outcomes (fp, id);
CREATE TRIGGER IF NOT EXISTS outcomes_no_update BEFORE UPDATE ON outcomes BEGIN SELECT RAISE(ABORT, 'outcomes is append-only'); END;
CREATE TRIGGER IF NOT EXISTS outcomes_no_delete BEFORE DELETE ON outcomes BEGIN SELECT RAISE(ABORT, 'outcomes is append-only'); END;
PRAGMA user_version = 3;
`,
  3: `
-- v4: supporting views (tables, flows, before/after, matrices) a card may carry.
ALTER TABLE proposals ADD COLUMN artifacts_json TEXT;
PRAGMA user_version = 4;
`,
};

/**
 * @typedef {import('node:sqlite').DatabaseSync} Db
 * @typedef {Record<string, any>} Row
 * @typedef {import('./model.mjs').Candidate} Candidate
 * @typedef {import('./model.mjs').Proposal} Proposal
 * @typedef {{refs: number, types: string[]}} EvidenceSnapshot
 * @typedef {'created' | 'evidence-grew' | 'suppressed' | 'duplicate'} ProposeOutcome
 * @typedef {{result: ProposeOutcome | `invalid:${string}`, fp?: string, added?: number, resurfaced?: {from: string, rule: string}, status?: string, note?: string}} ProposeResult
 * @typedef {{state: 'ran'|'skipped'|'partial', reason?: string, emitted?: number, verified?: number, dropped?: number, truncated?: number}} LensRecord
 */

export const now = () => new Date().toISOString();
const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
/** A run id: `r-YYYYMMDDHHMMSS-xxxx` (UTC). */
export const newRunId = (d = new Date()) =>
  `r-${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}-${randomBytes(2).toString('hex')}`;

/**
 * The row without NULL/undefined columns: absent is omitted, never null.
 * @param {Row | undefined} row
 * @returns {Row | undefined}
 */
export function clean(row) {
  if (!row) return row;
  /** @type {Row} */
  const out = {};
  for (const [k, v] of Object.entries(row)) if (v !== null && v !== undefined) out[k] = v;
  return out;
}

/** @param {unknown} v @returns {import('node:sqlite').SQLInputValue} */
const sql = (v) => (v === undefined ? null : /** @type {import('node:sqlite').SQLInputValue} */ (v));
/** @param {unknown} v */
const json = (v) => (v === undefined ? null : JSON.stringify(v));

/**
 * Opens (and on first use creates) the store at `path`: WAL, busy timeout, the DDL in one BEGIN IMMEDIATE
 * transaction that re-reads user_version. An older known version (v1) is upgraded in place inside that same
 * transaction (MIGRATIONS); a file with any other version is refused. Any failure is a
 * DowserError with exit 3 (store unavailable).
 * @param {string} path
 * @returns {Db}
 */
export function openStore(path) {
  /** @type {Db | undefined} */
  let db;
  try {
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
    db = new DatabaseSync(path);
    db.exec('PRAGMA busy_timeout = 5000');
    for (let i = 0; ; i++) {
      try { db.exec('PRAGMA journal_mode = WAL'); break; } catch (e) {
        if (/** @type {any} */ (e).errcode !== 5 || i >= 100) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 + Math.random() * 30);
      }
    }
    db.exec('PRAGMA foreign_keys = ON');
    const before = version(db);
    if (before === 0 || (before < USER_VERSION && MIGRATIONS[before] !== undefined)) {
      db.exec('BEGIN IMMEDIATE');
      try {
        // re-read under the write lock: another process may have created or upgraded the file meanwhile
        let v = version(db);
        if (v === 0) db.exec(DDL);
        while ((v = version(db)) < USER_VERSION && MIGRATIONS[v] !== undefined) db.exec(MIGRATIONS[v]);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    }
    const v = version(db);
    if (v !== USER_VERSION) throw new Error(`${path} has user_version ${v}; this Dowser knows ${USER_VERSION}`);
    return db;
  } catch (e) {
    try { db?.close(); } catch { /* already closed */ }
    if (e instanceof DowserError) throw e;
    throw new DowserError(`store unavailable: ${/** @type {Error} */ (e).message}`, 3);
  }
}

/** @param {Db} db @returns {number} */
const version = (db) => Number(/** @type {Row} */ (db.prepare('PRAGMA user_version').get()).user_version);

/** @type {WeakSet<Db>} */
const inTx = new WeakSet();
/**
 * Runs `fn` in one BEGIN IMMEDIATE transaction (re-entrant: a nested call joins the outer one).
 * @template T
 * @param {Db} db
 * @param {() => T} fn
 * @returns {T}
 */
export function tx(db, fn) {
  if (inTx.has(db)) return fn();
  db.exec('BEGIN IMMEDIATE');
  inTx.add(db);
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    inTx.delete(db);
  }
}

// ------------------------------------------------------------------------------------------------ runs

/**
 * A run row as JSON (lenses parsed), or undefined.
 * @param {Db} db
 * @param {string} id
 * @returns {Row | undefined}
 */
export function getRun(db, id) {
  const r = clean(/** @type {Row | undefined} */ (db.prepare('SELECT * FROM runs WHERE id = ?').get(id)));
  if (r && r.lenses_json) { r.lenses = JSON.parse(r.lenses_json); delete r.lenses_json; }
  return r;
}

/**
 * The most recent run with status `done`, or undefined.
 * @param {Db} db
 * @returns {Row | undefined}
 */
export function lastDoneRun(db) {
  const r = /** @type {Row | undefined} */ (db.prepare("SELECT id FROM runs WHERE status = 'done' ORDER BY finished_at DESC, id DESC LIMIT 1").get());
  return r ? getRun(db, r.id) : undefined;
}

/**
 * Starts a run. `base_sha` is the last done run's `head_sha` (absent on a first run). An incremental run whose
 * base is no longer in the repository's history (`hasCommit` says so) starts as `full` instead, without a base,
 * and the returned row carries `fallback` saying why: a diff against a missing commit cannot be taken.
 * @param {Db} db
 * @param {{mode: string, harness?: string, model?: string, focus?: string, headSha?: string, hasCommit?: (sha: string) => boolean}} o
 * @returns {Row}
 */
export function runStart(db, { mode, harness, model, focus, headSha, hasCommit }) {
  if (!isOneOf(RUN_MODES, mode)) throw new DowserError(`--mode must be one of ${RUN_MODES.join('|')}`, 2);
  if (mode === 'focused' && !focus) throw new DowserError('a focused run needs --focus goal:<...> or area:<...>', 2);
  if (focus !== undefined && !/^(goal|area):\S/.test(focus)) throw new DowserError('--focus is goal:<...> or area:<...>', 2);
  if (focus !== undefined && mode !== 'focused') throw new DowserError('--focus goes with --mode focused', 2);
  return tx(db, () => {
    const base = lastDoneRun(db);
    const lost = mode === 'incremental' && base?.head_sha && hasCommit ? !hasCommit(base.head_sha) : false;
    const id = newRunId();
    db.prepare(`INSERT INTO runs (id, started_at, head_sha, base_sha, mode, focus, harness, model, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running')`)
      .run(id, now(), sql(headSha), lost ? null : sql(base?.head_sha), lost ? 'full' : mode, sql(focus), sql(harness), sql(model));
    const row = /** @type {Row} */ (getRun(db, id));
    return lost ? { ...row, fallback: `base ${base?.head_sha} is not in this history; started a full run` } : row;
  });
}

/**
 * Validates a run's per-lens record: `{<lens>: {state: ran|skipped|partial, reason?, emitted?, verified?,
 * dropped?, truncated?}}`. skipped/partial need a reason; counts are integers >= 0 (omit when unmeasured).
 * @param {unknown} lenses
 * @returns {Record<string, LensRecord>}
 */
export function checkLenses(lenses) {
  if (!lenses || typeof lenses !== 'object' || Array.isArray(lenses)) throw new DowserError('--lenses is a JSON object {<lens>: {state, ...}}', 2);
  for (const [lens, rec] of Object.entries(lenses)) {
    if (!isOneOf(LENSES, lens)) throw new DowserError(`--lenses: unknown lens ${lens}`, 2);
    if (!rec || typeof rec !== 'object') throw new DowserError(`--lenses.${lens} is an object`, 2);
    const r = /** @type {Row} */ (rec);
    const extra = Object.keys(r).find((k) => !['state', 'reason', 'emitted', 'verified', 'dropped', 'truncated'].includes(k));
    if (extra) throw new DowserError(`--lenses.${lens}: unknown field ${extra}`, 2);
    if (!isOneOf(LENS_STATES, r.state)) throw new DowserError(`--lenses.${lens}.state must be one of ${LENS_STATES.join('|')}`, 2);
    if (r.state !== 'ran' && !(typeof r.reason === 'string' && r.reason.trim())) throw new DowserError(`--lenses.${lens}: a ${r.state} lens needs a reason`, 2);
    for (const k of ['emitted', 'verified', 'dropped', 'truncated']) {
      if (r[k] !== undefined && !(Number.isInteger(r[k]) && r[k] >= 0)) throw new DowserError(`--lenses.${lens}.${k} must be an integer >= 0 (omit when unmeasured)`, 2);
    }
  }
  return /** @type {Record<string, LensRecord>} */ (lenses);
}

/**
 * Finishes a running run (CAS running -> done|failed) with its per-lens record.
 * @param {Db} db
 * @param {{runId: string, lenses: unknown, status?: string}} o
 * @returns {Row}
 */
export function runFinish(db, { runId, lenses, status = 'done' }) {
  if (status !== 'done' && status !== 'failed') throw new DowserError('--status must be done|failed', 2);
  const rec = checkLenses(lenses);
  return tx(db, () => {
    const r = db.prepare("UPDATE runs SET status = ?, finished_at = ?, lenses_json = ? WHERE id = ? AND status = 'running' RETURNING id")
      .get(status, now(), JSON.stringify(rec), runId);
    if (!r) {
      const cur = getRun(db, runId);
      throw new DowserError(cur ? `run ${runId} is ${cur.status}, not running` : `run ${runId} does not exist`, 2,
        { error: 'refused', run: runId, current: cur ? cur.status : 'not-found' });
    }
    return /** @type {Row} */ (getRun(db, runId));
  });
}

/**
 * The running run `id`, or a DowserError (exit 2).
 * @param {Db} db
 * @param {string | undefined} id
 * @returns {Row}
 */
export function requireRunning(db, id) {
  if (!id) throw new DowserError('--run <id> is required', 2);
  const r = getRun(db, id);
  if (!r) throw new DowserError(`run ${id} does not exist`, 2);
  if (r.status !== 'running') throw new DowserError(`run ${id} is ${r.status}, not running`, 2);
  return r;
}

// ------------------------------------------------------------------------------------------------ proposals

/**
 * A proposal row as a `dowser-proposal/1` record (JSON columns parsed, absent keys omitted), with its evidence.
 * @param {Db} db
 * @param {string} fp
 * @returns {Row | undefined}
 */
export function getProposal(db, fp) {
  const r = clean(/** @type {Row | undefined} */ (db.prepare('SELECT * FROM proposals WHERE fp = ?').get(fp)));
  if (!r) return undefined;
  /** @type {Row} */
  const out = {};
  for (const [k, v] of Object.entries(r)) {
    if (k.endsWith('_json')) out[k.slice(0, -5)] = JSON.parse(v);
    else out[k] = v;
  }
  delete out.asserted;
  out.evidence = evidenceOf(db, fp).map(({ type, ref, quote, url }) => clean({ type, ref, quote, url }));
  return out;
}

/**
 * The append-only evidence rows of a fingerprint, oldest first.
 * @param {Db} db
 * @param {string} fp
 * @returns {Row[]}
 */
export function evidenceOf(db, fp) {
  return /** @type {Row[]} */ (db.prepare('SELECT * FROM evidence WHERE fp = ? ORDER BY id').all(fp)).map((r) => /** @type {Row} */ (clean(r)));
}

/**
 * The append-only transition history of a fingerprint, oldest first.
 * @param {Db} db
 * @param {string} fp
 * @returns {Row[]}
 */
export function transitionsOf(db, fp) {
  return /** @type {Row[]} */ (db.prepare('SELECT * FROM transitions WHERE fp = ? ORDER BY id').all(fp)).map((r) => /** @type {Row} */ (clean(r)));
}

/**
 * The evidence the fingerprint's NEWEST propose line carried (`proposals.asserted_json`), each joined to its
 * evidence row, with the ref and line hint as that line gave them. This is what `verify` checks: a quote an
 * earlier line carried and the newest one no longer does is stale and never re-checked.
 * @param {Db} db
 * @param {string} fp
 * @returns {Row[]}
 */
export function assertedEvidence(db, fp) {
  const p = /** @type {Row | undefined} */ (db.prepare('SELECT asserted_json FROM proposals WHERE fp = ?').get(fp));
  if (!p) return [];
  const get = db.prepare('SELECT * FROM evidence WHERE fp = ? AND type = ? AND key = ?');
  /** @type {Row[]} */
  const out = [];
  for (const a of /** @type {Row[]} */ (JSON.parse(p.asserted_json))) {
    const row = /** @type {Row | undefined} */ (get.get(fp, a.type, a.key));
    if (row) out.push(/** @type {Row} */ (clean({ ...row, ref: a.ref, line: a.line ?? null })));
  }
  return out;
}

/**
 * The evidence snapshot of a fingerprint (all of it, or up to evidence id `seq`): `refs` counts distinct
 * evidence keys, so a re-assertion or a line shift never counts as new evidence.
 * @param {Db} db
 * @param {string} fp
 * @param {number} [seq]
 * @returns {EvidenceSnapshot & {seq: number}}
 */
export function evidenceSnapshot(db, fp, seq) {
  const rows = /** @type {Row[]} */ (db.prepare('SELECT id, type, key FROM evidence WHERE fp = ? AND id <= ? ORDER BY id').all(fp, seq ?? Number.MAX_SAFE_INTEGER));
  const keys = new Set(rows.map((r) => `${r.type}\u0000${r.key}`));
  return { refs: keys.size, types: [...new Set(rows.map((r) => String(r.type)))].sort(), seq: rows.length ? Number(rows[rows.length - 1].id) : 0 };
}

/** The resurfacing predicate lives in model.mjs (pure, shared with the Forge app); re-exported here. */
export { resurfaces } from './model.mjs';

/**
 * Proposes one candidate line into a running run.
 *  - new fp -> inserted as `candidate` (`created`);
 *  - existing fp -> evidence appended (one row per evidence key per run). A `snoozed`/`rejected` item that
 *    meets the resurfacing rule moves to `candidate` (`evidence-grew`, with `resurfaced`); one that does not
 *    is `suppressed`. A `dropped` item with a NEW evidence key moves to `candidate` (a retry); with only known
 *    keys it stays dropped. Any other status: `evidence-grew` when a new key landed, else `duplicate`.
 *  - `provenance.run_id` is stamped from `runId`; a different one on the line is overwritten and noted.
 *  - an invalid candidate: `invalid:<why>`; nothing is written.
 * Card text is refreshed only while the item is a `candidate` (a verified/pushed card is what a person saw).
 * @param {Db} db
 * @param {string} runId
 * @param {unknown} input
 * @param {{kinds: Record<string, readonly string[]>}} opts
 * @returns {ProposeResult}
 */
export function propose(db, runId, input, { kinds }) {
  const run = requireRunning(db, runId);
  const v = validateCandidate(input);
  if (!v.ok) return { result: `invalid:${v.why}` };
  const c = v.value;
  /** @type {string} */
  let fp;
  try { fp = fingerprint(c, kinds[c.lens] ?? []); } catch (e) {
    if (e instanceof DowserError) return { result: `invalid:${e.message}` };
    throw e;
  }
  if (c.fp !== undefined && c.fp !== fp) return { result: `invalid:fp-mismatch (computed ${fp})` };
  const note = c.provenance.run_id !== undefined && c.provenance.run_id !== runId
    ? `provenance.run_id ${c.provenance.run_id} replaced by ${runId}` : undefined;
  const provenance = clean({ ...c.provenance, run_id: runId, model: c.provenance.model ?? run.model, harness: c.provenance.harness ?? run.harness, focus: c.provenance.focus ?? run.focus });
  const anchors = [...new Set(c.anchors.map(normalizeAnchor).filter(Boolean))].sort();
  const card = {
    title: c.title, rationale: c.rationale, body: c.body, effort_json: json(c.effort), confidence: c.confidence,
    confidence_why: c.confidence_why, doc_impact_json: json(c.doc_impact), delivery_risk_json: json(c.delivery_risk),
    provenance_json: json(provenance), artifacts_json: json(c.artifacts),
  };

  return tx(db, () => {
    const at = now();
    const existing = /** @type {Row | undefined} */ (db.prepare('SELECT status FROM proposals WHERE fp = ?').get(fp));
    const addEvidence = () => {
      const known = new Set(/** @type {Row[]} */ (db.prepare('SELECT DISTINCT type, key FROM evidence WHERE fp = ?').all(fp)).map((r) => `${r.type}\u0000${r.key}`));
      const ins = db.prepare('INSERT INTO evidence (fp, run_id, type, ref, key, path, line, quote, url, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      let added = 0;
      /** @type {Map<string, Row>} */
      const asserted = new Map();
      for (const e of c.evidence) {
        const k = evidenceKey(e);
        const id = `${e.type}\u0000${k.key}`;
        asserted.set(id, clean({ type: e.type, key: k.key, ref: e.ref.trim(), line: k.line }) ?? {});
        if (known.has(id)) continue;
        ins.run(fp, runId, e.type, e.ref.trim(), k.key, sql(k.path), sql(k.line), sql(e.quote), sql(e.url), at);
        known.add(id);
        added++;
      }
      db.prepare('UPDATE proposals SET asserted_json = ? WHERE fp = ?').run(JSON.stringify([...asserted.values()]), fp);
      return added;
    };
    const refreshCard = () => db.prepare(`UPDATE proposals SET title = ?, rationale = ?, body = ?, effort_json = ?, confidence = ?,
        confidence_why = ?, doc_impact_json = ?, delivery_risk_json = ?, provenance_json = ?, artifacts_json = ?, updated_at = ? WHERE fp = ?`)
      .run(card.title, card.rationale, card.body, card.effort_json, card.confidence, card.confidence_why,
        card.doc_impact_json, card.delivery_risk_json, card.provenance_json, card.artifacts_json, at, fp);

    if (!existing) {
      db.prepare(`INSERT INTO proposals (fp, lens, kind, topic, anchors_json, title, rationale, body, effort_json, confidence,
          confidence_why, doc_impact_json, delivery_risk_json, provenance_json, artifacts_json, status, first_run_id, last_run_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?, ?, ?)`)
        .run(fp, c.lens, c.kind, normalizeTopic(c.topic), JSON.stringify(anchors), card.title, card.rationale, card.body,
          card.effort_json, card.confidence, card.confidence_why, card.doc_impact_json, card.delivery_risk_json,
          card.provenance_json, card.artifacts_json, runId, runId, at, at);
      const added = addEvidence();
      appendTransition(db, { fp, from: undefined, to: 'candidate', by: SYSTEM_DECIDER, at, runId });
      return /** @type {ProposeResult} */ (clean({ result: 'created', fp, added, status: 'candidate', note }));
    }

    const status = String(existing.status);
    const added = addEvidence();
    db.prepare('UPDATE proposals SET last_run_id = ?, updated_at = ? WHERE fp = ?').run(runId, at, fp);

    if (status === 'snoozed' || status === 'rejected' || status === 'dropped') {
      const then = enteredSnapshot(db, fp, status);
      const nowSnap = evidenceSnapshot(db, fp);
      const r = resurfaces(status, then, nowSnap);
      if (!r.resurface) {
        const stays = status === 'dropped' ? (added > 0 ? 'evidence-grew' : 'duplicate') : 'suppressed';
        return /** @type {ProposeResult} */ (clean({ result: stays, fp, added, status, note }));
      }
      move(db, fp, 'candidate', { from: status, by: SYSTEM_DECIDER, note: `resurfaced:${r.rule}`, runId });
      refreshCard();
      return /** @type {ProposeResult} */ (clean({ result: 'evidence-grew', fp, added, status: 'candidate', resurfaced: { from: status, rule: r.rule }, note }));
    }
    if (status === 'candidate') refreshCard();
    return /** @type {ProposeResult} */ (clean({ result: added > 0 ? 'evidence-grew' : 'duplicate', fp, added, status, note }));
  });
}

/**
 * The evidence snapshot recorded when the fp last entered `status` (from its transition's evidence_seq).
 * @param {Db} db
 * @param {string} fp
 * @param {string} status
 * @returns {EvidenceSnapshot}
 */
function enteredSnapshot(db, fp, status) {
  const t = /** @type {Row | undefined} */ (db.prepare('SELECT evidence_seq FROM transitions WHERE fp = ? AND to_status = ? ORDER BY id DESC LIMIT 1').get(fp, status));
  return evidenceSnapshot(db, fp, t ? Number(t.evidence_seq) : 0);
}

/**
 * @param {Db} db
 * @param {{fp: string, from: string | undefined, to: string, by: string, at: string, reason?: string, note?: string, runId?: string}} t
 */
function appendTransition(db, { fp, from, to, by, at, reason, note, runId }) {
  const seq = evidenceSnapshot(db, fp).seq;
  db.prepare('INSERT INTO transitions (fp, from_status, to_status, by, at, reason, note, run_id, evidence_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(fp, sql(from), to, by, at, sql(reason), sql(note), sql(runId), seq);
}

/**
 * Moves a proposal's status: a compare-and-set against model.TRANSITIONS. `from` (when given) is the status
 * the caller expects; a different current status is a stale refusal. An illegal or stale move throws
 * MoveRefused (exit 2) carrying the current status. Every move appends one `transitions` row and sets
 * reason / note / merged_into / decided_by / decided_at on the card.
 * @param {Db} db
 * @param {string} fp
 * @param {string} to
 * @param {{from?: string, by: string, reason?: string, note?: string, into?: string, runId?: string}} opts
 * @returns {Row} the updated proposal row (absent columns omitted)
 */
export function move(db, fp, to, { from, by, reason, note, into, runId }) {
  if (!isOneOf(STATUSES, to)) throw new DowserError(`--to must be one of ${STATUSES.join('|')}`, 2);
  if (from !== undefined && !isOneOf(STATUSES, from)) throw new DowserError(`--from must be one of ${STATUSES.join('|')}`, 2);
  if (!by || !DECIDER_RE.test(by)) throw new DowserError(`--by names the decider as <kind>:<name>, e.g. operator:jane (got ${JSON.stringify(by)})`, 2);
  const problem = decisionProblem({ to, reason, note });
  if (problem) throw new DowserError(problem, 2);
  if (to === 'merged' && !into) throw new DowserError('a merge needs --into <fp>', 2);
  if (to !== 'merged' && into !== undefined) throw new DowserError('--into goes only with --to merged', 2);
  if (into !== undefined && into === fp) throw new DowserError('a proposal cannot merge into itself', 2);

  return tx(db, () => {
    const cur = /** @type {Row | undefined} */ (db.prepare('SELECT status FROM proposals WHERE fp = ?').get(fp));
    if (!cur) throw new MoveRefused(`proposal ${fp} does not exist`, { fp, current: 'not-found', to });
    const current = String(cur.status);
    if (from !== undefined && from !== current) {
      throw new MoveRefused(`stale move: ${fp} is ${current}, not ${from}`, { fp, current, to, from });
    }
    if (!canMove(current, to)) throw new MoveRefused(`illegal move: ${fp} is ${current}; ${current} -> ${to} is not allowed`, { fp, current, to });
    if (!deciderAllowed(current, to, by)) {
      throw new MoveRefused(`refused: ${current} -> ${to} needs a human decider (--by human:<name>), got ${by}`, { fp, current, to });
    }
    if (into !== undefined && !db.prepare('SELECT 1 FROM proposals WHERE fp = ?').get(into)) {
      throw new DowserError(`--into ${into} is not a known proposal`, 2);
    }
    const at = now();
    const row = /** @type {Row | undefined} */ (db.prepare(`UPDATE proposals SET status = ?, reason = ?, note = ?, merged_into = ?,
        decided_by = ?, decided_at = ?, updated_at = ? WHERE fp = ? AND status = ? RETURNING *`)
      .get(to, sql(reason), sql(note), sql(into), by, at, at, fp, current));
    if (!row) {
      const again = /** @type {Row | undefined} */ (db.prepare('SELECT status FROM proposals WHERE fp = ?').get(fp));
      throw new MoveRefused(`stale move: ${fp} changed under us`, { fp, current: again ? String(again.status) : 'not-found', to, from: current });
    }
    appendTransition(db, { fp, from: current, to, by, at, reason, note, runId });
    return /** @type {Row} */ (clean(row));
  });
}

/**
 * Fingerprints of `candidate` proposals the run touched (proposed or re-proposed in it).
 * @param {Db} db
 * @param {string} runId
 * @returns {string[]}
 */
export function candidatesOfRun(db, runId) {
  return /** @type {Row[]} */ (db.prepare("SELECT fp FROM proposals WHERE last_run_id = ? AND status = 'candidate' ORDER BY fp").all(runId)).map((r) => String(r.fp));
}

// ------------------------------------------------------------------------------------------------ status

/**
 * "top N of M" for a lens record whose truncated > 0 (N = emitted, M = emitted + truncated), else undefined.
 * @param {LensRecord} rec
 * @returns {string | undefined}
 */
export function truncationNote(rec) {
  if (!rec.truncated) return undefined;
  const n = rec.emitted ?? 0;
  return `top ${n} of ${n + rec.truncated}`;
}

/**
 * Counts by status and by lens, and the last runs with their per-lens state.
 * @param {Db} db
 * @param {{runs?: number}} [o]
 * @returns {Row}
 */
export function statusSummary(db, { runs = 5 } = {}) {
  /** @type {Record<string, number>} */
  const byStatus = {};
  /** @type {Record<string, Record<string, number>>} */
  const byLens = {};
  let total = 0;
  for (const r of /** @type {Row[]} */ (db.prepare('SELECT lens, status, COUNT(*) AS n FROM proposals GROUP BY lens, status ORDER BY lens, status').all())) {
    const n = Number(r.n);
    total += n;
    byStatus[r.status] = (byStatus[r.status] ?? 0) + n;
    (byLens[r.lens] ??= {})[r.status] = n;
  }
  /** @type {string[]} */
  const truncation = [];
  const last = /** @type {Row[]} */ (db.prepare('SELECT id FROM runs ORDER BY started_at DESC, id DESC LIMIT ?').all(runs)).map((r) => {
    const run = /** @type {Row} */ (getRun(db, String(r.id)));
    if (run.lenses) {
      for (const [lens, rec] of Object.entries(/** @type {Record<string, LensRecord>} */ (run.lenses))) {
        const t = truncationNote(rec);
        if (t) { /** @type {Row} */ (rec).shown = t; truncation.push(`${run.id} ${lens}: ${t}`); }
      }
    }
    return run;
  });
  return clean({ proposals: total, by_status: byStatus, by_lens: byLens, runs: last, truncation: truncation.length ? truncation : undefined }) ?? {};
}
