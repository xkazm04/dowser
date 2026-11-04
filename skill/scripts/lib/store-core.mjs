// @ts-check
// The Dowser store's core: schema and connection. The DDL and its in-place MIGRATIONS, openStore (WAL, the DDL
// applied inside one BEGIN IMMEDIATE transaction that re-reads user_version), tx, clean, the time and run-id
// helpers, and the run lookups every other store module needs (getRun, lastDoneRun, requireRunning).
// It imports nothing from proposals.mjs or runs.mjs. lib/store.mjs is the facade; see its header for the rules.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  BANDS, CATEGORIES, CONFIDENCES, DowserError, EVIDENCE_TYPES, LENSES, MVP_RULES, REASONS, RUN_MODES, RUN_STATUSES, STATUSES, VERDICTS,
} from './model.mjs';

export const USER_VERSION = 7;
/** The decider the store itself writes for machine moves (creation, resurfacing). */
export const SYSTEM_DECIDER = 'skill:dowser';

/**
 * The closed model.mjs enums the DDL turns into CHECK (<col> IN (...)) lists. One map, so the SQL can never be a
 * hand-typed copy that drifts from the model.
 * @typedef {{lenses: readonly string[], statuses: readonly string[], reasons: readonly string[], confidences: readonly string[],
 *   evidenceTypes: readonly string[], runModes: readonly string[], runStatuses: readonly string[], categories: readonly string[],
 *   bands: readonly string[], mvpRules: readonly string[], verdicts: readonly string[]}} Enums
 */
/** @type {Readonly<Enums>} */
export const ENUMS = Object.freeze({
  lenses: LENSES, statuses: STATUSES, reasons: REASONS, confidences: CONFIDENCES, evidenceTypes: EVIDENCE_TYPES, runModes: RUN_MODES,
  runStatuses: RUN_STATUSES, categories: CATEGORIES, bands: BANDS, mvpRules: MVP_RULES, verdicts: VERDICTS,
});
/** A SQL IN-list body: `'a','b'`. @param {readonly string[]} list */
const inList = (list) => list.map((v) => `'${v.replace(/'/g, "''")}'`).join(',');

/** The model-backed CHECKs per table: column -> ENUMS key. Order is the rebuild order. */
const CHECKED = /** @type {const} */ ([
  ['runs', { mode: 'runModes', status: 'runStatuses' }],
  ['proposals', { lens: 'lenses', confidence: 'confidences', status: 'statuses', reason: 'reasons', category: 'categories', band: 'bands',
    mvp_rule: 'mvpRules', predicted_verdict: 'verdicts' }],
  ['evidence', { type: 'evidenceTypes' }],
]);

/** The proposals columns v6 added (scan-finding/1), in DDL order. */
export const V6_COLUMNS = Object.freeze(['impact', 'impact_why', 'risk', 'category', 'score', 'score_parts_json', 'band', 'mvp', 'mvp_rule',
  'mvp_why', 'predicted_verdict', 'predicted_why', 'predicted_by', 'pretriaged_by']);

/**
 * v6: per-slice trust (scan-finding/1 autonomy ladder; lib/trust.mjs owns the logic). trust_state is the current
 * level per slice and the transition id its agreement window starts after; trust_events is the append-only log of
 * every level change.
 */
const TRUST_DDL = `
CREATE TABLE IF NOT EXISTS trust_state (
  slice         TEXT PRIMARY KEY,
  level         INTEGER NOT NULL,
  window_after  INTEGER NOT NULL DEFAULT 0, -- transitions.id: decisions after it count (a demotion resets the window)
  changed_at    TEXT,
  reason        TEXT
);
CREATE TABLE IF NOT EXISTS trust_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  slice       TEXT NOT NULL,
  from_level  INTEGER NOT NULL,
  to_level    INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  agreement   REAL,
  n           INTEGER NOT NULL,
  item_id     TEXT
);
CREATE TRIGGER IF NOT EXISTS trust_events_no_update BEFORE UPDATE ON trust_events BEGIN SELECT RAISE(ABORT, 'trust_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trust_events_no_delete BEFORE DELETE ON trust_events BEGIN SELECT RAISE(ABORT, 'trust_events is append-only'); END;
`;

/**
 * v7: delivery truth from the code (lib/delivery.mjs). One row each time an accepted card's re-check CHANGES: its
 * quoted evidence at the scanned commit (present / partly / resolved) and the commits that named its issue or
 * inbox item. Append-only; the newest row per fp is the card's current delivery state.
 */
const DELIVERIES_DDL = `
CREATE TABLE IF NOT EXISTS deliveries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  fp            TEXT NOT NULL REFERENCES proposals (fp),
  run_id        TEXT NOT NULL REFERENCES runs (id),
  head_sha      TEXT,
  state         TEXT NOT NULL CHECK (state IN ('present','partly','resolved')),
  found         INTEGER NOT NULL,
  total         INTEGER NOT NULL,
  commits_json  TEXT,
  checked_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS deliveries_fp ON deliveries (fp, id);
CREATE TRIGGER IF NOT EXISTS deliveries_no_update BEFORE UPDATE ON deliveries BEGIN SELECT RAISE(ABORT, 'deliveries is append-only'); END;
CREATE TRIGGER IF NOT EXISTS deliveries_no_delete BEFORE DELETE ON deliveries BEGIN SELECT RAISE(ABORT, 'deliveries is append-only'); END;
`;

/**
 * The DDL a fresh store gets, its model-backed CHECK lists built from `e` (default ENUMS, so a fresh store can never
 * disagree with model.mjs). `rules.state` and `outcomes.rating` are not model enums and stay literal.
 * @param {Enums} [e]
 * @returns {string}
 */
export function buildDDL(e = ENUMS) {
  return `
PRAGMA user_version = ${USER_VERSION};

CREATE TABLE IF NOT EXISTS runs (
  id           TEXT PRIMARY KEY,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  head_sha     TEXT,
  base_sha     TEXT,
  mode         TEXT NOT NULL CHECK (mode IN (${inList(e.runModes)})),
  focus        TEXT,
  harness      TEXT,
  model        TEXT,
  status       TEXT NOT NULL DEFAULT 'running' CHECK (status IN (${inList(e.runStatuses)})),
  lenses_json  TEXT
);
CREATE INDEX IF NOT EXISTS runs_status_finished ON runs (status, finished_at);

CREATE TABLE IF NOT EXISTS proposals (
  fp                  TEXT PRIMARY KEY,
  lens                TEXT NOT NULL CHECK (lens IN (${inList(e.lenses)})),
  kind                TEXT NOT NULL,
  topic               TEXT NOT NULL,
  anchors_json        TEXT NOT NULL,
  title               TEXT NOT NULL,
  rationale           TEXT NOT NULL,
  body                TEXT NOT NULL,
  effort_json         TEXT NOT NULL,
  confidence          TEXT NOT NULL CHECK (confidence IN (${inList(e.confidences)})),
  confidence_why      TEXT NOT NULL,
  doc_impact_json     TEXT,
  delivery_risk_json  TEXT,
  provenance_json     TEXT NOT NULL,
  asserted_json       TEXT NOT NULL DEFAULT '[]', -- [{type, key, ref, line?}] the newest propose line carried: what verify checks
  status              TEXT NOT NULL CHECK (status IN (${inList(e.statuses)})),
  reason              TEXT CHECK (reason IN (${inList(e.reasons)})),
  note                TEXT,
  merged_into         TEXT REFERENCES proposals (fp),
  external_ref        TEXT,
  external_url        TEXT,
  issue_ref           TEXT, -- v2: the Jira issue an accepted verdict created (forge-mcp-2), else NULL
  issue_url           TEXT, -- v2: a link to that issue
  artifacts_json      TEXT, -- v4: the card's supporting views (model.mjs ARTIFACT_KINDS), else NULL
  snooze_until        TEXT, -- v5: YYYY-MM-DD a snoozed item wakes on (run start); NULL = no date, and NULL once it leaves snoozed
  impact              INTEGER, -- v6 (scan-finding/1): 1-10 as the judge set it; NULL = not judged (the card is unscored)
  impact_why          TEXT,
  risk                INTEGER, -- v6: 1-10 risk of making the change (judge's, else from delivery_risk.blast); NULL = unknown
  category            TEXT CHECK (category IN (${inList(e.categories)})),
  score               REAL,    -- v6: scan-score/1, computed by propose; NULL = unscored, never 0
  score_parts_json    TEXT,
  band                TEXT CHECK (band IN (${inList(e.bands)})), -- v6: the slot allocation of the card's last verify
  mvp                 INTEGER, -- v6: 1 on each lens's top card of that allocation, else NULL
  mvp_rule            TEXT CHECK (mvp_rule IN (${inList(e.mvpRules)})),
  mvp_why             TEXT,
  predicted_verdict   TEXT CHECK (predicted_verdict IN (${inList(e.verdicts)})),
  predicted_why       TEXT,
  predicted_by        TEXT,
  pretriaged_by       TEXT,    -- v6: machine:dowser when an L1 slice skipped the person's pre-triage (pretriage)
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
  type      TEXT NOT NULL CHECK (type IN (${inList(e.evidenceTypes)})),
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
${TRUST_DDL}
${DELIVERIES_DDL}`;
}

export const DDL = buildDDL();

/**
 * In-place upgrades, keyed by the version they start from. Each runs inside openStore's BEGIN IMMEDIATE after
 * user_version was re-read, and ends by setting the next version. Columns are only ever added (no rewrite); a
 * CHECK list that grew is widened after them, by reconcileChecks's table rebuild, without a version bump.
 * @param {Enums} [e]
 * @returns {Record<number, string>}
 */
export function buildMigrations(e = ENUMS) {
  return {
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
  5: `
-- v6: the scan-finding/1 fields (docs/contracts/scan-finding-1.md) and per-slice trust. Rows from v5 keep NULL in
-- every new column: unscored, unallocated, no prediction - never 0.
ALTER TABLE proposals ADD COLUMN impact INTEGER;
ALTER TABLE proposals ADD COLUMN impact_why TEXT;
ALTER TABLE proposals ADD COLUMN risk INTEGER;
ALTER TABLE proposals ADD COLUMN category TEXT CHECK (category IN (${inList(e.categories)}));
ALTER TABLE proposals ADD COLUMN score REAL;
ALTER TABLE proposals ADD COLUMN score_parts_json TEXT;
ALTER TABLE proposals ADD COLUMN band TEXT CHECK (band IN (${inList(e.bands)}));
ALTER TABLE proposals ADD COLUMN mvp INTEGER;
ALTER TABLE proposals ADD COLUMN mvp_rule TEXT CHECK (mvp_rule IN (${inList(e.mvpRules)}));
ALTER TABLE proposals ADD COLUMN mvp_why TEXT;
ALTER TABLE proposals ADD COLUMN predicted_verdict TEXT CHECK (predicted_verdict IN (${inList(e.verdicts)}));
ALTER TABLE proposals ADD COLUMN predicted_why TEXT;
ALTER TABLE proposals ADD COLUMN predicted_by TEXT;
ALTER TABLE proposals ADD COLUMN pretriaged_by TEXT;
${TRUST_DDL}
PRAGMA user_version = 6;
`,
  6: `
-- v7: delivery truth from the code (lib/delivery.mjs).
${DELIVERIES_DDL}
PRAGMA user_version = 7;
`,
  };
}

export const MIGRATIONS = buildMigrations();

/**
 * @typedef {import('node:sqlite').DatabaseSync} Db
 * @typedef {Record<string, any>} Row
 * @typedef {import('./model.mjs').Candidate} Candidate
 * @typedef {import('./model.mjs').Proposal} Proposal
 * @typedef {{refs: number, types: string[]}} EvidenceSnapshot
 * @typedef {'created' | 'evidence-grew' | 'suppressed' | 'duplicate'} ProposeOutcome
 * @typedef {{result: ProposeOutcome | `invalid:${string}`, fp?: string, added?: number, resurfaced?: {from: string, rule: string}, status?: string, note?: string, warning?: 'no-predicted-verdict', clamped?: {category: {asked: string, stored: string}}}} ProposeResult
 * @typedef {{state: 'ran'|'skipped'|'partial', reason?: string, emitted?: number, verified?: number, dropped?: number, truncated?: number,
 *   ranked?: number, reserve?: number, reserve_titles?: string[]}} LensRecord
 *   ranked / reserve / reserve_titles are the store's slot allocation (run finish writes them; the agent does not).
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
 * transaction (MIGRATIONS); a file with any other version is refused. Then reconcileChecks widens any stored CHECK
 * list the model grew (a table rebuild, user_version unchanged). Any failure is a DowserError with exit 3 (store
 * unavailable).
 * @param {string} path
 * @param {OpenOptions} [opts]
 * @returns {Db}
 */
export function openStore(path, opts = {}) {
  const enums = { ...ENUMS, ...opts.enums };
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
        if (v === 0) db.exec(buildDDL(enums));
        const migrations = buildMigrations(enums);
        while ((v = version(db)) < USER_VERSION && migrations[v] !== undefined) db.exec(migrations[v]);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    }
    const v = version(db);
    if (v !== USER_VERSION) throw new Error(`${path} has user_version ${v}; this Dowser knows ${USER_VERSION}`);
    reconcileChecks(db, enums, opts.hooks);
    return db;
  } catch (e) {
    try { db?.close(); } catch { /* already closed */ }
    if (e instanceof DowserError) throw e;
    throw new DowserError(`store unavailable: ${/** @type {Error} */ (e).message}`, 3);
  }
}

/**
 * @typedef {{enums?: Partial<Enums>, hooks?: {afterCopy?: (db: Db, table: string) => void}}} OpenOptions
 *   enums overrides model lists (tests: a lens the model does not ship yet); hooks.afterCopy is a test seam that
 *   runs inside the rebuild transaction after a table's rows were copied (a throw there must roll everything back).
 * @typedef {{table: string, sql: string, widen: {col: string, list: readonly string[]}[]}} RebuildPlan
 */

/** The CHECK (<col> IN (...)) lists of a stored CREATE TABLE, by column. @param {string} sql */
function storedChecks(sql) {
  /** @type {Map<string, string[]>} */
  const out = new Map();
  for (const m of sql.matchAll(/CHECK \((\w+) IN \(([^)]*)\)\)/g)) out.set(m[1], [...m[2].matchAll(/'((?:[^']|'')*)'/g)].map((x) => x[1].replace(/''/g, "'")));
  return out;
}

/**
 * Which tables need a wider CHECK. Throws DowserError 3 when a stored row holds a value the model's list lacks
 * (widening may never lose a row, and narrowing is refused). Read-only.
 * @param {Db} db
 * @param {Enums} enums
 * @returns {RebuildPlan[]}
 */
function checkPlan(db, enums) {
  /** @type {RebuildPlan[]} */
  const plans = [];
  for (const [table, cols] of CHECKED) {
    const row = /** @type {Row | undefined} */ (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
    if (!row) continue;
    const stored = storedChecks(String(row.sql));
    /** @type {RebuildPlan['widen']} */
    const widen = [];
    for (const [col, key] of Object.entries(cols)) {
      const have = stored.get(col);
      const want = enums[/** @type {keyof Enums} */ (key)];
      if (!have) continue;
      if (have.some((x) => !want.includes(x))) {
        const bad = /** @type {Row[]} */ (db.prepare(`SELECT DISTINCT ${col} AS v FROM ${table} WHERE ${col} IS NOT NULL AND ${col} NOT IN (${inList(want)}) ORDER BY 1`).all());
        if (bad.length) {
          throw new DowserError(`store unavailable: ${table}.${col} holds ${col} ${bad.map((b) => b.v).join(', ')}, which this Dowser does not know; `
            + 'refusing to rebuild (a newer Dowser wrote it)', 3);
        }
      }
      if (want.some((x) => !have.includes(x))) widen.push({ col, list: want });
    }
    if (widen.length) plans.push({ table, sql: String(row.sql), widen });
  }
  return plans;
}

/**
 * Widens every stored CHECK list the model grew, by the table-rebuild pattern (registry technique
 * migrations/transactional-ddl): foreign keys off OUTSIDE the transaction (the pragma is a no-op inside one),
 * BEGIN IMMEDIATE, the plan re-read under the lock, then per table: dependents read from sqlite_master, CREATE at the
 * target shape under a temp name, copy every column, DROP, RENAME, dependents recreated, the AUTOINCREMENT high-water
 * kept; PRAGMA foreign_key_check must be empty before COMMIT; foreign keys back on whatever happened. Columns do not
 * change, so user_version stays. A store whose lists already match does nothing (one sqlite_master read per table).
 * @param {Db} db
 * @param {Enums} enums
 * @param {OpenOptions['hooks']} [hooks]
 */
function reconcileChecks(db, enums, hooks = {}) {
  if (!checkPlan(db, enums).length) return;
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const plan of checkPlan(db, enums)) rebuild(db, plan, hooks);
      const orphans = /** @type {Row[]} */ (db.prepare('PRAGMA foreign_key_check').all());
      if (orphans.length) throw new Error(`table rebuild left ${orphans.length} foreign key violation(s), first in ${orphans[0].table}`);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  if (Number(/** @type {Row} */ (db.prepare('PRAGMA foreign_keys').get()).foreign_keys) !== 1) throw new Error('foreign keys did not turn back on');
}

/**
 * One table's rebuild, inside reconcileChecks's transaction.
 * @param {Db} db
 * @param {RebuildPlan} plan
 * @param {NonNullable<OpenOptions['hooks']>} hooks
 */
function rebuild(db, { table, sql, widen }, hooks) {
  const temp = `${table}__dowser_rebuild`;
  let target = sql.replace(/^CREATE TABLE\s+(?:"[^"]+"|\w+)/, `CREATE TABLE "${temp}"`);
  if (target === sql) throw new Error(`cannot read the CREATE TABLE of ${table}`);
  for (const { col, list } of widen) target = target.replace(new RegExp(`CHECK \\(${col} IN \\([^)]*\\)\\)`), `CHECK (${col} IN (${inList(list)}))`);
  const dependents = /** @type {Row[]} */ (db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY type, name").all(table));
  const seq = /** @type {Row | undefined} */ (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'").get())
    ? /** @type {Row | undefined} */ (db.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').get(table)) : undefined;
  const cols = /** @type {Row[]} */ (db.prepare(`PRAGMA table_info("${table}")`).all()).map((c) => `"${c.name}"`).join(', ');
  const count = (/** @type {string} */ t) => Number(/** @type {Row} */ (db.prepare(`SELECT count(*) AS n FROM "${t}"`).get()).n);
  db.exec(target);
  db.exec(`INSERT INTO "${temp}" (${cols}) SELECT ${cols} FROM "${table}"`);
  if (count(temp) !== count(table)) throw new Error(`table rebuild of ${table} copied a different row count`);
  hooks.afterCopy?.(db, table);
  db.exec(`DROP TABLE "${table}"`);
  db.exec(`ALTER TABLE "${temp}" RENAME TO "${table}"`);
  for (const d of dependents) db.exec(String(d.sql));
  if (seq) db.prepare('UPDATE sqlite_sequence SET seq = max(seq, ?) WHERE name = ?').run(seq.seq, table);
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
  // a hydrate run (lib/hydrate.mjs) scanned nothing: it is never the base of an incremental run
  const r = /** @type {Row | undefined} */ (db.prepare("SELECT id FROM runs WHERE status = 'done' AND (harness IS NULL OR harness <> 'dowser-hydrate') ORDER BY finished_at DESC, id DESC LIMIT 1").get());
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
