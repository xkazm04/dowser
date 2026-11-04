// @ts-check
// The store's CHECK enums come from model.mjs, and openStore widens a stored CHECK by a safe table rebuild
// (foreign keys off outside the transaction, copy, drop, rename, dependents recreated, foreign_key_check, commit).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  BANDS, CATEGORIES, CONFIDENCES, DowserError, EVIDENCE_TYPES, LENSES, MVP_RULES, REASONS, RUN_MODES, RUN_STATUSES, STATUSES, VERDICTS,
} from '../lib/model.mjs';
import { DDL, ENUMS, MIGRATIONS, USER_VERSION, V6_COLUMNS, buildDDL, openStore } from '../lib/store-core.mjs';
import { removeDir, tempDir } from './_fixture.mjs';

/** @type {string} */ let dir;
before(() => { dir = tempDir('store-schema'); });
after(() => { removeDir(dir); });

const WIDE = [...LENSES, 'tech-debt'];
const AT = '2026-10-01T00:00:00.000Z';

/** @param {DatabaseSync} db @param {string} sql @returns {any[]} */
const all = (db, sql) => /** @type {any[]} */ (db.prepare(sql).all());
/** @param {DatabaseSync} db @param {string} sql @returns {any} */
const one = (db, sql) => db.prepare(sql).get();
/** The schema objects (tables, indexes, triggers) with their columns, comparable across files. @param {DatabaseSync} db */
const shape = (db) => all(db, "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
  .map((o) => ({ ...o, cols: o.type === 'table' ? all(db, `PRAGMA table_info(${o.name})`) : undefined }));
/** The CHECK (<col> IN (...)) lists of one table's sql, by column. @param {string} sql */
function checks(sql) {
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const m of sql.matchAll(/CHECK \((\w+) IN \(([^)]*)\)\)/g)) out[m[1]] = [...m[2].matchAll(/'([^']*)'/g)].map((x) => x[1]);
  return out;
}
/** @param {DatabaseSync} db @param {string} table */
const tableSql = (db, table) => String(one(db, `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = '${table}'`).sql);

const MODEL = {
  runs: { mode: RUN_MODES, status: RUN_STATUSES },
  proposals: { lens: LENSES, confidence: CONFIDENCES, status: STATUSES, reason: REASONS, category: CATEGORIES, band: BANDS, mvp_rule: MVP_RULES, predicted_verdict: VERDICTS },
  evidence: { type: EVIDENCE_TYPES },
};
/** Every model-backed CHECK in the file equals its model constant (with `lenses` as given). @param {DatabaseSync} db @param {readonly string[]} lenses */
function assertChecksMatchModel(db, lenses) {
  for (const [table, cols] of Object.entries(MODEL)) {
    const got = checks(tableSql(db, table));
    for (const [col, list] of Object.entries(cols)) assert.deepEqual(got[col], [...(col === 'lens' ? lenses : list)], `${table}.${col}`);
  }
}

/** A 4-lens file (today's DDL) with 2 proposals, 3 evidence rows, 2 transitions. @param {string} file @param {string} [ddl] */
function seed(file, ddl = DDL) {
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA journal_mode = WAL');
  raw.exec(ddl);
  raw.prepare("INSERT INTO runs (id, started_at, mode, status) VALUES ('r-1', ?, 'full', 'done')").run(AT);
  for (const [fp, lens] of [['aaaaaaaaaaaaaaaa', 'doc-drift'], ['bbbbbbbbbbbbbbbb', 'security-cra']]) {
    raw.prepare(`INSERT INTO proposals (fp, lens, kind, topic, anchors_json, title, rationale, body, effort_json, confidence, confidence_why,
      provenance_json, status, external_ref, first_run_id, last_run_id, created_at, updated_at)
      VALUES (?, ?, 'k', 't', '["a#b"]', 'Title', 'why', 'body', '{"size":"S"}', 'high', 'q', '{}', 'verified', ?, 'r-1', 'r-1', ?, ?)`)
      .run(fp, lens, `DOW-${fp[0]}`, AT, AT);
  }
  for (const [fp, ref] of [['aaaaaaaaaaaaaaaa', 'T-1'], ['aaaaaaaaaaaaaaaa', 'T-2'], ['bbbbbbbbbbbbbbbb', 'T-3']]) {
    raw.prepare("INSERT INTO evidence (fp, run_id, type, ref, key, added_at) VALUES (?, 'r-1', 'ticket', ?, ?, ?)").run(fp, ref, ref, AT);
  }
  for (const fp of ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb']) {
    raw.prepare("INSERT INTO transitions (fp, from_status, to_status, by, at) VALUES (?, 'candidate', 'verified', 'skill:dowser', ?)").run(fp, AT);
  }
  raw.close();
}

/** @param {DatabaseSync} db */
const insertTechDebt = (db) => db.prepare(`INSERT INTO proposals (fp, lens, kind, topic, anchors_json, title, rationale, body, effort_json,
  confidence, confidence_why, provenance_json, status, first_run_id, last_run_id, created_at, updated_at)
  VALUES ('cccccccccccccccc', 'tech-debt', 'k', 't', '[]', 'T', 'w', 'b', '{}', 'low', 'q', '{}', 'candidate', 'r-1', 'r-1', ?, ?)`).run(AT, AT);

/** Every row of the three rebuilt tables and their dependents, comparable. @param {DatabaseSync} db */
const rows = (db) => ({
  runs: all(db, 'SELECT * FROM runs ORDER BY id'),
  proposals: all(db, 'SELECT * FROM proposals ORDER BY fp'),
  evidence: all(db, 'SELECT * FROM evidence ORDER BY id'),
  transitions: all(db, 'SELECT * FROM transitions ORDER BY id'),
});

test('buildDDL: a lens override reaches the proposals CHECK; no override is the DDL every fresh store gets', () => {
  const wide = buildDDL({ ...ENUMS, lenses: WIDE });
  const create = wide.slice(wide.indexOf('CREATE TABLE IF NOT EXISTS proposals'), wide.indexOf('CREATE UNIQUE INDEX'));
  assert.deepEqual(checks(create).lens, WIDE);
  assert.equal(buildDDL(), DDL);
  const a = new DatabaseSync(':memory:');
  a.exec(buildDDL());
  const b = openStore(':memory:');
  try { assert.deepEqual(shape(a), shape(b)); } finally { a.close(); b.close(); }
});

test('a fresh store: every model-backed CHECK list equals its model.mjs constant', () => {
  const db = openStore(':memory:');
  try { assertChecksMatchModel(db, LENSES); } finally { db.close(); }
});

test('an outdated 4-lens file opened with a widened lens list is rebuilt losslessly in place', () => {
  const file = join(dir, 'widen.db');
  seed(file);
  const raw = new DatabaseSync(file);
  const before = rows(raw);
  const seqBefore = one(raw, "SELECT seq FROM sqlite_sequence WHERE name = 'evidence'").seq;
  raw.close();
  const db = openStore(file, { enums: { lenses: WIDE } });
  try {
    assert.deepEqual(rows(db), before, 'every row and column preserved');
    assert.equal(one(db, "SELECT seq FROM sqlite_sequence WHERE name = 'evidence'").seq, seqBefore, 'AUTOINCREMENT high-water kept');
    insertTechDebt(db);
    assert.equal(one(db, 'SELECT count(*) AS n FROM evidence').n, 3);
    assert.equal(one(db, 'SELECT count(*) AS n FROM transitions').n, 2);
    assert.deepEqual(all(db, 'PRAGMA foreign_key_check'), []);
    assert.equal(one(db, 'PRAGMA foreign_keys').foreign_keys, 1);
    assert.equal(one(db, 'PRAGMA user_version').user_version, USER_VERSION);
    assert.equal(USER_VERSION, 8);
    assertChecksMatchModel(db, WIDE);
    // the dependents are back
    assert.throws(() => db.prepare("UPDATE evidence SET ref = 'x'").run(), /evidence is append-only/);
    const idx = all(db, "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'proposals'");
    for (const n of ['proposals_external_ref', 'proposals_lens_status', 'proposals_last_run']) assert.ok(idx.some((i) => i.name === n), n);
    assert.match(String(idx.find((i) => i.name === 'proposals_external_ref').sql), /UNIQUE INDEX.*WHERE external_ref IS NOT NULL/);
    assert.throws(() => db.prepare("UPDATE proposals SET external_ref = 'DOW-a' WHERE fp = 'bbbbbbbbbbbbbbbb'").run(), /UNIQUE/);
    assert.throws(() => db.prepare("INSERT INTO evidence (fp, run_id, type, ref, key, added_at) VALUES ('zzzzzzzzzzzzzzzz', 'r-1', 'git', 'x', 'x', 'now')").run(),
      /FOREIGN KEY/, 'foreign keys are enforced again');
  } finally { db.close(); }
});

test('a failure injected after the copy rolls the rebuild back: old CHECK and every row stay', () => {
  const file = join(dir, 'inject.db');
  seed(file);
  const raw = new DatabaseSync(file);
  const before = rows(raw);
  const sqlBefore = tableSql(raw, 'proposals');
  raw.close();
  assert.throws(() => openStore(file, { enums: { lenses: WIDE }, hooks: { afterCopy: () => { throw new Error('injected'); } } }),
    (e) => e instanceof DowserError && e.code === 3 && /injected/.test(e.message));
  const after = new DatabaseSync(file);
  try {
    assert.equal(tableSql(after, 'proposals'), sqlBefore);
    assert.deepEqual(checks(sqlBefore).lens, [...LENSES]);
    assert.deepEqual(rows(after), before);
    assert.equal(all(after, "SELECT name FROM sqlite_master WHERE name LIKE '%dowser_rebuild%'").length, 0, 'no leftover temp table');
  } finally { after.close(); }
});

test('a stored value the model no longer lists is refused with exit 3, nothing rebuilt', () => {
  const file = join(dir, 'narrow.db');
  seed(file);
  const raw = new DatabaseSync(file);
  const sqlBefore = tableSql(raw, 'proposals');
  raw.close();
  const narrow = LENSES.filter((l) => l !== 'doc-drift');
  assert.throws(() => openStore(file, { enums: { lenses: [...narrow, 'tech-debt'] } }),
    (e) => e instanceof DowserError && e.code === 3 && /lens/.test(e.message) && /doc-drift/.test(e.message));
  const after = new DatabaseSync(file);
  try { assert.equal(tableSql(after, 'proposals'), sqlBefore); } finally { after.close(); }
});

test('two opens of the same outdated file: the first rebuilds, the second does nothing', () => {
  const file = join(dir, 'twice.db');
  seed(file);
  const first = openStore(file, { enums: { lenses: WIDE } });
  const sql1 = tableSql(first, 'proposals');
  const all1 = all(first, 'SELECT type, name, sql FROM sqlite_master ORDER BY name');
  first.close();
  const second = openStore(file, { enums: { lenses: WIDE } });
  try {
    assert.equal(tableSql(second, 'proposals'), sql1);
    assert.deepEqual(all(second, 'SELECT type, name, sql FROM sqlite_master ORDER BY name'), all1);
    insertTechDebt(second);
    assert.equal(one(second, 'SELECT count(*) AS n FROM proposals').n, 3);
  } finally { second.close(); }
  assert.throws(() => openStore(file), (e) => e instanceof DowserError && e.code === 3 && /tech-debt/.test(e.message),
    'a Dowser that does not know a stored lens refuses the file rather than narrow it');
  const wideAgain = openStore(file, { enums: { lenses: WIDE } });
  try { assert.equal(tableSql(wideAgain, 'proposals'), sql1, 'the refusal changed nothing'); } finally { wideAgain.close(); }
});

/** The v1 schema, as store.test.mjs builds it. */
const DDL_V1 = DDL.split('-- v3:')[0].replace(/^\s*(issue_ref|issue_url|artifacts_json|snooze_until)\s.*\n/gm, '')
  .replace(new RegExp(`^\\s*(${V6_COLUMNS.join('|')})\\s.*\\n`, 'gm'), '').replace(`PRAGMA user_version = ${USER_VERSION};`, 'PRAGMA user_version = 1;');

test('a v1 file migrated to v8 and opened with a widened lens list: rebuilt once, every CHECK equals the model', () => {
  assert.match(MIGRATIONS[5], new RegExp(`CHECK \\(category IN \\(${CATEGORIES.map((c) => `'${c}'`).join(',')}\\)\\)`), 'the v6 migration CHECKs are generated');
  const file = join(dir, 'v1.db');
  const raw = new DatabaseSync(file);
  raw.exec(DDL_V1);
  raw.prepare("INSERT INTO runs (id, started_at, mode, status) VALUES ('r-1', ?, 'full', 'done')").run(AT);
  raw.prepare(`INSERT INTO proposals (fp, lens, kind, topic, anchors_json, title, rationale, body, effort_json, confidence, confidence_why,
    provenance_json, status, first_run_id, last_run_id, created_at, updated_at)
    VALUES ('aaaaaaaaaaaaaaaa', 'security-cra', 'k', 't', '[]', 'T', 'w', 'b', '{}', 'high', 'q', '{}', 'pushed', 'r-1', 'r-1', ?, ?)`).run(AT, AT);
  raw.prepare("INSERT INTO evidence (fp, run_id, type, ref, key, added_at) VALUES ('aaaaaaaaaaaaaaaa', 'r-1', 'ticket', 'S-1', 'S-1', ?)").run(AT);
  raw.close();
  const db = openStore(file, { enums: { lenses: WIDE } });
  const sql1 = tableSql(db, 'proposals');
  try {
    assert.equal(one(db, 'PRAGMA user_version').user_version, 8);
    assertChecksMatchModel(db, WIDE);
    insertTechDebt(db);
    assert.equal(one(db, 'SELECT count(*) AS n FROM evidence').n, 1);
    assert.deepEqual(all(db, 'PRAGMA foreign_key_check'), []);
    assert.equal(one(db, 'PRAGMA foreign_keys').foreign_keys, 1);
  } finally { db.close(); }
  const again = openStore(file, { enums: { lenses: WIDE } });
  try { assert.equal(tableSql(again, 'proposals'), sql1, 'the second open does not rebuild'); } finally { again.close(); }
});
