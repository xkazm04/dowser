// @ts-check
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DowserError, MoveRefused } from '../lib/model.mjs';
import {
  DDL, USER_VERSION, V6_COLUMNS, evidenceOf, getProposal, move, openStore, propose, resurfaces, runFinish, runStart, statusSummary, transitionsOf,
} from '../lib/store.mjs';
import { KINDS, candidate, removeDir, tempDir } from './_fixture.mjs';

/** @type {string} */ let dir;
/** @type {import('../lib/store.mjs').Db} */ let db;
/** @type {string} */ let run;

before(() => {
  dir = tempDir('store');
  db = openStore(join(dir, 'dowser.db'));
  run = runStart(db, { mode: 'full', harness: 'claude', model: 'm' }).id;
});
after(() => { db.close(); removeDir(dir); });

/** @param {Record<string, unknown>} over */
const prop = (over) => propose(db, run, candidate(over), { kinds: KINDS });

test('the store opens WAL at user_version 6 and is re-openable', () => {
  assert.equal(USER_VERSION, 6);
  assert.equal(Number(/** @type {any} */ (db.prepare('PRAGMA user_version').get()).user_version), 6);
  assert.equal(String(/** @type {any} */ (db.prepare('PRAGMA journal_mode').get()).journal_mode).toLowerCase(), 'wal');
  const cols = /** @type {any[]} */ (db.prepare('PRAGMA table_info(proposals)').all()).map((c) => c.name);
  assert.ok(cols.includes('issue_ref') && cols.includes('issue_url'), 'a fresh store has the v2 columns');
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'outcomes'").get(), 'and the v3 outcomes table');
  openStore(join(dir, 'dowser.db')).close();
});

/** The v1 schema: the current one without the v3 outcomes block, the issue columns (v1 -> v2), the v4 artifacts column and the v5 snooze_until column. */
const DDL_V1 = DDL.split('-- v3:')[0].replace(/^\s*(issue_ref|issue_url|artifacts_json|snooze_until)\s.*\n/gm, '')
  .replace(new RegExp(`^\\s*(${V6_COLUMNS.join('|')})\\s.*\\n`, 'gm'), '').replace(`PRAGMA user_version = ${USER_VERSION};`, 'PRAGMA user_version = 1;');

test('a v1 store file is upgraded to the current version in place, data intact; an unknown version is refused', () => {
  assert.ok(!DDL_V1.includes('issue_ref') && DDL_V1.includes('PRAGMA user_version = 1;'));
  const file = join(dir, 'v1.db');
  const raw = new DatabaseSync(file);
  raw.exec(DDL_V1);
  const at = '2026-10-01T00:00:00.000Z';
  raw.prepare("INSERT INTO runs (id, started_at, head_sha, mode, status) VALUES ('r-1', ?, 'abc', 'full', 'done')").run(at);
  raw.prepare(`INSERT INTO proposals (fp, lens, kind, topic, anchors_json, title, rationale, body, effort_json, confidence, confidence_why,
    provenance_json, status, external_ref, external_url, decided_by, decided_at, first_run_id, last_run_id, created_at, updated_at)
    VALUES ('aaaaaaaaaaaaaaaa', 'security-cra', 'secret', 't', '["a#b"]', 'Title', 'why', 'body', '{"size":"S"}', 'high', 'q',
    '{"lens_version":"1.0.0"}', 'pushed', 'DOW-1', 'https://j/DOW-1', 'skill:dowser-sync', ?, 'r-1', 'r-1', ?, ?)`).run(at, at, at);
  raw.prepare("INSERT INTO evidence (fp, run_id, type, ref, key, added_at) VALUES ('aaaaaaaaaaaaaaaa', 'r-1', 'ticket', 'SEC-1', 'SEC-1', ?)").run(at);
  raw.prepare("INSERT INTO sync_state (key, value) VALUES ('verdicts_cursor', '7')").run();
  assert.ok(!(/** @type {any[]} */ (raw.prepare('PRAGMA table_info(proposals)').all())).some((c) => c.name === 'issue_ref'));
  assert.ok(!raw.prepare("SELECT 1 FROM sqlite_master WHERE name = 'outcomes'").get());
  raw.close();

  const up = openStore(file);
  try {
    assert.equal(Number(/** @type {any} */ (up.prepare('PRAGMA user_version').get()).user_version), 6);
    assert.ok((/** @type {any[]} */ (up.prepare('PRAGMA table_info(proposals)').all())).some((c) => c.name === 'artifacts_json'));
    assert.equal(getProposal(up, 'aaaaaaaaaaaaaaaa')?.artifacts, undefined, 'artifacts start absent');
    assert.ok(up.prepare("SELECT 1 FROM sqlite_master WHERE name = 'outcomes'").get());
    const p = getProposal(up, 'aaaaaaaaaaaaaaaa');
    assert.equal(p?.status, 'pushed');
    assert.equal(p?.external_ref, 'DOW-1');
    assert.equal(p?.title, 'Title');
    assert.deepEqual(p?.evidence, [{ type: 'ticket', ref: 'SEC-1' }]);
    assert.equal(p?.issue_ref, undefined, 'the new columns start absent, never null');
    assert.equal(/** @type {any} */ (up.prepare("SELECT value FROM sync_state WHERE key = 'verdicts_cursor'").get()).value, '7');
    up.prepare("UPDATE proposals SET issue_ref = 'SHOP-1', issue_url = 'https://j/SHOP-1' WHERE fp = 'aaaaaaaaaaaaaaaa'").run();
    assert.throws(() => up.prepare('DELETE FROM evidence').run(), /append-only/, 'the triggers survive the upgrade');
  } finally { up.close(); }
  const again = openStore(file);
  assert.equal(getProposal(again, 'aaaaaaaaaaaaaaaa')?.issue_ref, 'SHOP-1', 'an upgraded file reopens unchanged');
  again.close();

  const v9 = join(dir, 'v9.db');
  const r9 = new DatabaseSync(v9);
  r9.exec('PRAGMA user_version = 9');
  r9.close();
  assert.throws(() => openStore(v9), (e) => e instanceof DowserError && e.code === 3 && /user_version 9/.test(e.message));
});

test('propose: created, duplicate, evidence-grew, invalid', () => {
  const a = prop({ topic: 'p1' });
  assert.equal(a.result, 'created');
  assert.equal(prop({ topic: 'p1', title: 'Reworded title' }).result, 'duplicate');
  const grew = prop({ topic: 'p1', evidence: [{ type: 'ticket', ref: 'SEC-1' }] });
  assert.equal(grew.result, 'evidence-grew');
  assert.equal(grew.added, 1);
  assert.match(prop({ topic: 'p1', kind: 'gap' }).result, /^invalid:kind "gap" is not one of/);
  assert.match(propose(db, run, { nope: 1 }, { kinds: KINDS }).result, /^invalid:/);
  assert.equal(evidenceOf(db, /** @type {string} */ (a.fp)).length, 2);
  assert.deepEqual(transitionsOf(db, /** @type {string} */ (a.fp)).map((t) => t.to_status), ['candidate']);
});

test('propose keeps a card\'s artifacts on the record; a re-propose replaces them', () => {
  const view = { kind: 'table', message: 'Doc and code disagree', alt: 'Table: the doc flag vs the code flags.',
    refs: ['src/auth.js:2'], data: { columns: ['Doc says', 'Code does'], rows: [['--legacy', '--force']] } };
  const a = prop({ topic: 'with-view', artifacts: [view] });
  assert.equal(a.result, 'created');
  assert.deepEqual(getProposal(db, /** @type {string} */ (a.fp))?.artifacts, [view]);
  prop({ topic: 'with-view', artifacts: [{ ...view, message: 'Reworded' }] });
  assert.equal(getProposal(db, /** @type {string} */ (a.fp))?.artifacts[0].message, 'Reworded');
  assert.match(prop({ topic: 'bad-view', artifacts: [{ ...view, refs: ['NOPE-1'] }] }).result, /^invalid:artifacts\[0\]\.refs:NOPE-1/);
});

test('move is a CAS over the transition table; illegal and stale moves are refused with the current status', () => {
  const fp = /** @type {string} */ (prop({ topic: 'p2' }).fp);
  assert.throws(() => move(db, fp, 'pushed', { by: 'human:jane' }), (e) => e instanceof MoveRefused && e.current === 'candidate' && e.code === 2);
  assert.throws(() => move(db, fp, 'verified', { from: 'snoozed', by: 'human:jane' }), (e) => e instanceof MoveRefused && e.current === 'candidate');
  assert.throws(() => move(db, 'ffffffffffffffff', 'verified', { by: 'human:jane' }), (e) => e instanceof MoveRefused && e.current === 'not-found');
  assert.throws(() => move(db, fp, 'verified', { by: 'jane' }), /kind>:<name/);
  assert.equal(move(db, fp, 'verified', { from: 'candidate', by: 'skill:dowser-verify' }).status, 'verified');
  assert.throws(() => move(db, fp, 'rejected', { by: 'human:jane' }), /needs --reason/);
  assert.throws(() => move(db, fp, 'rejected', { by: 'human:jane', reason: 'other' }), /needs --note/);
  const r = move(db, fp, 'rejected', { by: 'human:jane', reason: 'already-known', note: 'JIRA-9' });
  assert.equal(r.status, 'rejected');
  assert.equal(r.reason, 'already-known');
  assert.equal(r.decided_by, 'human:jane');
  assert.deepEqual(transitionsOf(db, fp).map((t) => `${t.from_status ?? ''}>${t.to_status}`), ['>candidate', 'candidate>verified', 'verified>rejected']);
});

test('merge needs an existing --into', () => {
  const a = /** @type {string} */ (prop({ topic: 'm1' }).fp);
  const b = /** @type {string} */ (prop({ topic: 'm2' }).fp);
  move(db, b, 'verified', { by: 'skill:dowser-verify' });
  assert.throws(() => move(db, b, 'merged', { by: 'agent:claude' }), /--into/);
  assert.throws(() => move(db, b, 'merged', { by: 'agent:claude', into: 'ffffffffffffffff' }), /not a known proposal/);
  assert.equal(move(db, b, 'merged', { by: 'agent:claude', into: a }).merged_into, a);
});

test('resurfaces (pure): snoozed on any new ref; rejected only with a new type AND >= 2x refs', () => {
  const then = { refs: 2, types: ['code'] };
  assert.equal(resurfaces('snoozed', then, { refs: 2, types: ['code'] }).resurface, false);
  assert.equal(resurfaces('snoozed', then, { refs: 3, types: ['code'] }).resurface, true);
  assert.equal(resurfaces('rejected', then, { refs: 4, types: ['code'] }).resurface, false, '2x refs but no new type');
  assert.equal(resurfaces('rejected', then, { refs: 3, types: ['code', 'ticket'] }).resurface, false, 'new type but < 2x');
  assert.equal(resurfaces('rejected', then, { refs: 4, types: ['code', 'ticket'] }).resurface, true, 'new type and 2x');
  assert.equal(resurfaces('verified', then, { refs: 9, types: ['code', 'ticket'] }).resurface, false);
});

test('propose applies the resurfacing thresholds through the store', () => {
  // snoozed: any new ref moves it back to candidate
  const s = /** @type {string} */ (prop({ topic: 'snz' }).fp);
  move(db, s, 'verified', { by: 'skill:dowser-verify' });
  move(db, s, 'snoozed', { by: 'human:jane' });
  assert.equal(prop({ topic: 'snz' }).result, 'suppressed', 'no new ref: stays snoozed');
  const back = prop({ topic: 'snz', evidence: [{ type: 'code', ref: 'src/auth.js:9', quote: 'x' }] });
  assert.equal(back.result, 'evidence-grew');
  assert.equal(back.resurfaced?.from, 'snoozed');
  assert.equal(back.status, 'candidate');

  // rejected with 1 ref (code): needs a new type AND >= 2 refs
  const r = /** @type {string} */ (prop({ topic: 'rej' }).fp);
  move(db, r, 'verified', { by: 'skill:dowser-verify' });
  move(db, r, 'rejected', { by: 'human:jane', reason: 'not-worth-it' });
  const sameType = prop({ topic: 'rej', evidence: [{ type: 'code', ref: 'src/other.js:1', quote: 'y' }] });
  assert.equal(sameType.result, 'suppressed', '2 refs but no new type');
  assert.equal(sameType.added, 1, 'evidence still accrues while suppressed');
  const r2 = /** @type {string} */ (prop({ topic: 'rej2' }).fp);
  move(db, r2, 'verified', { by: 'skill:dowser-verify' });
  move(db, r2, 'rejected', { by: 'human:jane', reason: 'other', note: 'later' });
  const pr = prop({ topic: 'rej2', evidence: [{ type: 'ticket', ref: 'SEC-2' }] });
  assert.equal(pr.result, 'evidence-grew', 'new type (ticket) and refs 1 -> 2 (2x)');
  assert.equal(pr.resurfaced?.from, 'rejected');

  // rejected with 2 refs: a new type with only 3 refs (< 4) stays suppressed; a 4th ref resurfaces it
  const r3 = /** @type {string} */ (prop({ topic: 'rej3', evidence: [
    { type: 'code', ref: 'a.js:1', quote: 'a' }, { type: 'code', ref: 'b.js:1', quote: 'b' }] }).fp);
  move(db, r3, 'verified', { by: 'skill:dowser-verify' });
  move(db, r3, 'rejected', { by: 'human:jane', reason: 'wrong-size' });
  assert.equal(prop({ topic: 'rej3', evidence: [{ type: 'ticket', ref: 'T-1' }] }).result, 'suppressed');
  const r3b = prop({ topic: 'rej3', evidence: [{ type: 'page', ref: 'P-1' }] });
  assert.equal(r3b.result, 'evidence-grew');
  assert.equal(r3b.resurfaced?.from, 'rejected');
});

test('evidence and transitions refuse UPDATE and DELETE at the database level', () => {
  for (const t of ['evidence', 'transitions']) {
    assert.throws(() => db.exec(`UPDATE ${t} SET fp = fp`), /append-only/);
    assert.throws(() => db.exec(`DELETE FROM ${t}`), /append-only/);
  }
});

test('no code path UPDATEs or DELETEs evidence or transitions (source grep)', () => {
  const libDir = new URL('../lib/', import.meta.url);
  const files = readdirSync(libDir).filter((f) => f.endsWith('.mjs')).map((f) => new URL(f, libDir));
  files.push(new URL('../dowser.mjs', import.meta.url));
  assert.ok(files.length >= 7);
  const bad = /\b(?:UPDATE\s+(?:OR\s+\w+\s+)?(?:evidence|transitions)\b|DELETE\s+FROM\s+(?:evidence|transitions)\b|(?:INSERT\s+OR\s+REPLACE|REPLACE)\s+INTO\s+(?:evidence|transitions)\b|DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:evidence|transitions)\b)/i;
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    assert.equal(bad.exec(src)?.[0], undefined, `${f.pathname} writes an append-only table`);
  }
});

test('an incremental run whose base left the history starts full, without a base, and says why', () => {
  const d = tempDir('store-fallback');
  const s = openStore(join(d, 'dowser.db'));
  try {
    const first = runStart(s, { mode: 'full', headSha: 'aaa111' });
    runFinish(s, { runId: first.id, lenses: { opportunity: { state: 'ran', emitted: 0 } } });
    const kept = runStart(s, { mode: 'incremental', headSha: 'bbb222', hasCommit: () => true });
    assert.equal(kept.mode, 'incremental');
    assert.equal(kept.base_sha, 'aaa111');
    assert.equal(kept.fallback, undefined);
    const lost = runStart(s, { mode: 'incremental', headSha: 'bbb222', hasCommit: (sha) => sha !== 'aaa111' });
    assert.equal(lost.mode, 'full');
    assert.equal(lost.base_sha, undefined, 'no base: a diff against a missing commit cannot be taken');
    assert.match(String(lost.fallback), /aaa111 is not in this history/);
    assert.equal(runStart(s, { mode: 'focused', focus: 'area:src', hasCommit: () => false }).fallback, undefined, 'only incremental falls back');
  } finally {
    s.close();
    removeDir(d);
  }
});

test('run finish validates per-lens state; status shows "top N of M"', () => {
  const r = runStart(db, { mode: 'full' });
  assert.throws(() => runFinish(db, { runId: r.id, lenses: { opportunity: { state: 'skipped' } } }), /needs a reason/);
  assert.throws(() => runFinish(db, { runId: r.id, lenses: { 'tech-debt': { state: 'ran' } } }), /unknown lens/);
  const done = runFinish(db, { runId: r.id, lenses: {
    'security-cra': { state: 'ran', emitted: 4, verified: 3, dropped: 1, truncated: 5 },
    opportunity: { state: 'skipped', reason: 'tickets source not connected' },
  } });
  assert.equal(done.status, 'done');
  assert.throws(() => runFinish(db, { runId: r.id, lenses: {} }), /not running/);
  const s = statusSummary(db);
  assert.ok(s.truncation.some((/** @type {string} */ t) => t.endsWith('security-cra: top 4 of 9')));
  const next = runStart(db, { mode: 'incremental' });
  assert.equal(next.base_sha, undefined, 'no head sha recorded -> base absent, never a placeholder');
  assert.throws(() => runStart(db, { mode: 'focused' }), /needs --focus/);
});
