// @ts-check
// The Dowser store's core: schema and connection. The DDL and its in-place MIGRATIONS, openStore (WAL, the DDL
// applied inside one BEGIN IMMEDIATE transaction that re-reads user_version), tx, clean, the time and run-id
// helpers, and the run lookups every other store module needs (getRun, lastDoneRun, requireRunning).
// It imports nothing from proposals.mjs or runs.mjs. lib/store.mjs is the facade; see its header for the rules.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DowserError } from './model.mjs';

export const USER_VERSION = 5;
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
  snooze_until        TEXT, -- v5: YYYY-MM-DD a snoozed item wakes on (run start); NULL = no date, and NULL once it leaves snoozed
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
  4: `
-- v5: an optional date a snoozed item wakes on (move --to snoozed --until YYYY-MM-DD).
ALTER TABLE proposals ADD COLUMN snooze_until TEXT;
PRAGMA user_version = 5;
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
/** The local calendar date `YYYY-MM-DD`: snooze dates are the runner's days, not UTC days. */
export const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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
export const sql = (v) => (v === undefined ? null : /** @type {import('node:sqlite').SQLInputValue} */ (v));

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
