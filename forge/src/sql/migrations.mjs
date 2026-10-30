// @ts-check
// Forge SQL schema, as an ordered list of one-statement migrations. `migrate` (index.js) enqueues them on
// @forge/sql's `migrationRunner`, which records each name in `__migrations` and runs only the new ones; the
// tests run the same statements on node:sqlite. Append only: never edit a migration that has shipped.
//
// The DDL is portable between MySQL/TiDB and SQLite on purpose:
//  - no AUTO_INCREMENT (the Forge SQL docs advise against it - hotspots - and TiDB does not promise
//    monotonic values across nodes, which a verdict cursor needs). Ids come from the `counters` table (CAS);
//  - UNIQUE is declared as `CONSTRAINT <name> UNIQUE (...)`, valid in both. The Forge SQL docs show UNIQUE in a
//    schema example but do not promise it, so every insert is also check-then-insert (core);
//  - timestamps are ISO 8601 strings (VARCHAR(32)): the wire format, and sortable as text;
//  - indexed VARCHARs stay under TiDB's 3072-byte key limit at utf8mb4 (4 bytes a char);
//  - no foreign keys (Forge SQL does not support them).
// SQL NULL is an absent value; the core maps it to an omitted key.

/** @type {readonly {name: string, statement: string}[]} */
export const MIGRATIONS = Object.freeze([
  {
    name: 'v001_counters',
    // `ref` -> the last DW number issued (one row per installation); `seq:<project_key>` -> the last verdict seq.
    statement: `CREATE TABLE IF NOT EXISTS counters (
  name VARCHAR(255) NOT NULL,
  value BIGINT NOT NULL,
  PRIMARY KEY (name)
)`,
  },
  {
    name: 'v002_inboxes',
    statement: `CREATE TABLE IF NOT EXISTS inboxes (
  project_key VARCHAR(191) NOT NULL,
  repo_url TEXT,
  jira_project_key VARCHAR(255),
  issue_type_id VARCHAR(64),
  created_at VARCHAR(32) NOT NULL,
  PRIMARY KEY (project_key)
)`,
  },
  {
    name: 'v003_proposals',
    // id = the DW number of `ref`. record_json = the dowser-proposal/1 record without evidence and without the
    // store-owned triage fields. The decision stamp (status + reason/note/merged_into/decided_by/decided_at/via)
    // is written by the status CAS, so a verdict row that failed to land can be rebuilt from it. change_kind =
    // what the push in last_run_id did to the item: new | grew | reopened (the Card's `change`).
    statement: `CREATE TABLE IF NOT EXISTS proposals (
  id BIGINT NOT NULL,
  ref VARCHAR(32) NOT NULL,
  project_key VARCHAR(191) NOT NULL,
  fp CHAR(16) NOT NULL,
  status VARCHAR(16) NOT NULL,
  lens VARCHAR(32) NOT NULL,
  title VARCHAR(255) NOT NULL,
  confidence VARCHAR(16) NOT NULL,
  record_json MEDIUMTEXT NOT NULL,
  evidence_count INT NOT NULL,
  evidence_types VARCHAR(255) NOT NULL,
  refs_at_status INT,
  types_at_status VARCHAR(255),
  first_run_id VARCHAR(255) NOT NULL,
  last_run_id VARCHAR(255) NOT NULL,
  first_seen VARCHAR(32) NOT NULL,
  last_push_at VARCHAR(32) NOT NULL,
  reopened TINYINT NOT NULL DEFAULT 0,
  change_kind VARCHAR(16) NOT NULL,
  issue_ref VARCHAR(64),
  issue_url TEXT,
  reason VARCHAR(32),
  note TEXT,
  merged_into VARCHAR(64),
  decided_by VARCHAR(255),
  decided_at VARCHAR(32),
  via VARCHAR(16),
  accept_claim VARCHAR(32),
  PRIMARY KEY (id),
  CONSTRAINT uq_proposals_ref UNIQUE (ref),
  CONSTRAINT uq_proposals_fp UNIQUE (project_key, fp)
)`,
  },
  { name: 'v004_proposals_status_ix', statement: 'CREATE INDEX ix_proposals_status ON proposals (project_key, status, last_push_at)' },
  { name: 'v005_proposals_issue_ix', statement: 'CREATE INDEX ix_proposals_issue ON proposals (issue_ref)' },
  {
    name: 'v006_evidence',
    // One row per evidence key (shared evidenceKey); ekey_hash = sha256(ekey) keeps the key short enough to
    // index. head_sha = the commit of the push that added the row, so a code link points at the revision the
    // quote was verified against (F2). pos = the item's position in that push (card order). Append-only: a re-push never deletes or rewrites a row.
    statement: `CREATE TABLE IF NOT EXISTS evidence (
  proposal_id BIGINT NOT NULL,
  ekey_hash CHAR(64) NOT NULL,
  ekey TEXT NOT NULL,
  type VARCHAR(16) NOT NULL,
  ref TEXT NOT NULL,
  quote TEXT,
  url TEXT,
  head_sha VARCHAR(64),
  added_run_id VARCHAR(255) NOT NULL,
  added_at VARCHAR(32) NOT NULL,
  pos INT NOT NULL,
  PRIMARY KEY (proposal_id, ekey_hash)
)`,
  },
  { name: 'v007_evidence_type_ix', statement: 'CREATE INDEX ix_evidence_type ON evidence (type)' },
  {
    name: 'v008_verdicts',
    // Append-only verdict log. seq is per project_key (counter `seq:<project_key>`); the pull cursor is the
    // last seq returned. One row per decision: UNIQUE (project_key, fp, decided_at).
    statement: `CREATE TABLE IF NOT EXISTS verdicts (
  seq BIGINT NOT NULL,
  project_key VARCHAR(191) NOT NULL,
  fp CHAR(16) NOT NULL,
  status VARCHAR(16) NOT NULL,
  reason VARCHAR(32),
  note TEXT,
  merged_into VARCHAR(64),
  decided_by VARCHAR(255) NOT NULL,
  decided_at VARCHAR(32) NOT NULL,
  external_ref VARCHAR(32) NOT NULL,
  issue_ref VARCHAR(64),
  issue_url TEXT,
  via VARCHAR(16) NOT NULL,
  PRIMARY KEY (project_key, seq),
  CONSTRAINT uq_verdicts_decision UNIQUE (project_key, fp, decided_at)
)`,
  },
  {
    name: 'v009_pushes',
    statement: `CREATE TABLE IF NOT EXISTS pushes (
  id CHAR(36) NOT NULL,
  project_key VARCHAR(191) NOT NULL,
  run_id VARCHAR(255) NOT NULL,
  head_sha VARCHAR(64),
  repo_url TEXT,
  at VARCHAR(32) NOT NULL,
  created INT NOT NULL,
  updated INT NOT NULL,
  PRIMARY KEY (id)
)`,
  },
  { name: 'v010_pushes_run_ix', statement: 'CREATE INDEX ix_pushes_run ON pushes (project_key, run_id)' },
  {
    name: 'v011_areas',
    statement: `CREATE TABLE IF NOT EXISTS areas (
  project_key VARCHAR(191) NOT NULL,
  path VARCHAR(512) NOT NULL,
  files INT NOT NULL,
  churn_90d INT NOT NULL,
  authors_90d INT,
  last_change VARCHAR(32),
  run_id VARCHAR(255) NOT NULL,
  PRIMARY KEY (project_key, path)
)`,
  },
  {
    name: 'v012_rules',
    // Rules the skill offered (dowser_reflect_sync). text/titles refresh while state = offered; a decided rule
    // (accepted|declined, by a person in Forge) is never reverted by a later push. decided_by = forge:<accountId>.
    statement: `CREATE TABLE IF NOT EXISTS rules (
  project_key VARCHAR(191) NOT NULL,
  id VARCHAR(64) NOT NULL,
  lens VARCHAR(32) NOT NULL,
  text TEXT NOT NULL,
  titles_json TEXT,
  state VARCHAR(16) NOT NULL,
  offered_at VARCHAR(32) NOT NULL,
  decided_by VARCHAR(255),
  decided_at VARCHAR(32),
  PRIMARY KEY (project_key, id)
)`,
  },
  {
    name: 'v013_outcomes',
    // One outcome per accepted item (PK ref): how the person who owns the issue rates it. Append-only.
    statement: `CREATE TABLE IF NOT EXISTS outcomes (
  ref VARCHAR(32) NOT NULL,
  project_key VARCHAR(191) NOT NULL,
  fp CHAR(16) NOT NULL,
  rating VARCHAR(16) NOT NULL,
  note TEXT,
  issue_ref VARCHAR(64) NOT NULL,
  decided_by VARCHAR(255) NOT NULL,
  recorded_at VARCHAR(32) NOT NULL,
  PRIMARY KEY (ref)
)`,
  },
  { name: 'v014_outcomes_project_ix', statement: 'CREATE INDEX ix_outcomes_project ON outcomes (project_key, recorded_at)' },
  {
    name: 'v015_directions',
    // Lens direction set in Settings: one row per (inbox, lens). direction_json = a LensDirection with at least one
    // key (no row = no direction; a clear deletes the row). Last writer wins; updated_by = forge:<accountId>.
    statement: `CREATE TABLE IF NOT EXISTS directions (
  project_key VARCHAR(191) NOT NULL,
  lens VARCHAR(32) NOT NULL,
  direction_json TEXT NOT NULL,
  updated_by VARCHAR(128) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  PRIMARY KEY (project_key, lens)
)`,
  },
  // A dated snooze (DW-42): the day (YYYY-MM-DD) the item comes back, set only with status = snoozed. On the
  // proposal as part of the decision stamp (so repairVerdicts can rebuild it) and on the verdict the pull returns.
  { name: 'v016_proposals_snooze_until', statement: 'ALTER TABLE proposals ADD COLUMN snooze_until VARCHAR(10)' },
  { name: 'v017_verdicts_snooze_until', statement: 'ALTER TABLE verdicts ADD COLUMN snooze_until VARCHAR(10)' },
  // Inbox access (core/access.mjs): the decider (forge:<accountId>) whose first push created the inbox. It may
  // see the inbox until a Jira project is configured for it. NULL on inboxes created before v018: until a Jira
  // project is configured, only Jira admins see those.
  { name: 'v018_inboxes_created_by', statement: 'ALTER TABLE inboxes ADD COLUMN created_by VARCHAR(191)' },
]);
