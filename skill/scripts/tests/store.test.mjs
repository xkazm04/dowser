// @ts-check
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MoveRefused } from '../lib/model.mjs';
import {
  evidenceOf, move, openStore, propose, resurfaces, runFinish, runStart, statusSummary, transitionsOf,
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

test('the store opens WAL at user_version 1 and is re-openable', () => {
  assert.equal(Number(/** @type {any} */ (db.prepare('PRAGMA user_version').get()).user_version), 1);
  assert.equal(String(/** @type {any} */ (db.prepare('PRAGMA journal_mode').get()).journal_mode).toLowerCase(), 'wal');
  openStore(join(dir, 'dowser.db')).close();
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
