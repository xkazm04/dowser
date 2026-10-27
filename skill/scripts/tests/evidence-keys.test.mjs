// @ts-check
// WP1b: evidence keys (path + normalized quote), verify on the newest line only, dropped -> candidate retry,
// the human-only verified -> accepted move, and provenance.run_id stamping.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { evidenceKey } from '../lib/fingerprint.mjs';
import { MoveRefused, canMove, deciderAllowed } from '../lib/model.mjs';
import { evidenceOf, evidenceSnapshot, getProposal, move, openStore, propose, runStart } from '../lib/store.mjs';
import { verifyRun } from '../lib/verify.mjs';
import { KINDS, candidate, removeDir, tempDir, writeFiles } from './_fixture.mjs';

/** @type {string} */ let home;
/** @type {string} */ let repo;
/** @type {import('../lib/store.mjs').Db} */ let db;
/** @type {string} */ let run;

const pad = (/** @type {number} */ n) => Array.from({ length: n }, () => '// pad');

before(() => {
  home = tempDir('keys-home');
  repo = tempDir('keys-repo');
  db = openStore(join(home, 'dowser.db'));
  run = runStart(db, { mode: 'full', harness: 'claude', model: 'm' }).id;
  writeFiles(repo, {
    'src/auth.js': [...pad(59), 'function login(user) { return check(user.password); }', 'const fixed = hash(user.password);'].join('\n'),
  });
});
after(() => { db.close(); removeDir(home); removeDir(repo); });

/** @param {Record<string, unknown>} over */
const prop = (over) => propose(db, run, candidate(over), { kinds: KINDS });
/** @param {string} ref @param {string} quote */
const code = (ref, quote) => ({ type: 'code', ref, quote });

test('1. evidenceKey: code/doc keyed on path + normalized quote; other types on the ref', () => {
  assert.deepEqual(evidenceKey(code('./src\\a.js:12:3', '  return   x; ')), { key: 'src/a.js\nreturn x;', path: 'src/a.js', line: 12 });
  assert.equal(evidenceKey(code('src/a.js:99', 'return x;')).key, evidenceKey(code('src/a.js:12', 'return  x;')).key);
  assert.notEqual(evidenceKey(code('src/a.js:12', 'return y;')).key, evidenceKey(code('src/a.js:12', 'return x;')).key);
  assert.deepEqual(evidenceKey({ type: 'ticket', ref: ' SEC-1 ' }), { key: 'SEC-1' });
});

test('1. a line shift is not new evidence; a new quote in the same file is', () => {
  const a = prop({ topic: 'k1', evidence: [code('src/auth.js:2', 'return check(user.password);')] });
  assert.equal(a.result, 'created');
  const fp = /** @type {string} */ (a.fp);
  const shifted = prop({ topic: 'k1', evidence: [code('src/auth.js:60', 'return   check(user.password);')] });
  assert.equal(shifted.result, 'duplicate');
  assert.equal(shifted.added, 0);
  assert.equal(evidenceOf(db, fp).length, 1, 'one row per key');
  assert.equal(evidenceSnapshot(db, fp).refs, 1);
  const other = prop({ topic: 'k1', evidence: [code('src/auth.js:61', 'const fixed = hash(user.password);')] });
  assert.equal(other.result, 'evidence-grew');
  assert.equal(evidenceSnapshot(db, fp).refs, 2);

  // a snoozed item does not resurface on a line shift
  move(db, fp, 'verified', { by: 'skill:dowser-verify' });
  move(db, fp, 'snoozed', { by: 'human:jane' });
  const again = prop({ topic: 'k1', evidence: [code('src/auth.js:7', 'return check(user.password);')] });
  assert.equal(again.result, 'suppressed');
  assert.equal(getProposal(db, fp)?.status, 'snoozed');
});

test('2. verify checks only the newest propose line, with its line hint', () => {
  // first line: a quote the code no longer has; second line: only the current quote -> verified
  const a = prop({ topic: 'k2', evidence: [code('src/auth.js:3', 'md5(user.password)')] });
  const b = prop({ topic: 'k2', evidence: [code('src/auth.js:60', 'return check(user.password);')] });
  assert.equal(b.fp, a.fp);
  assert.equal(b.result, 'evidence-grew');
  // a re-assertion of an old key with a new line hint: the newest hint is the one checked
  const c = prop({ topic: 'k3', evidence: [code('src/auth.js:2', 'const fixed = hash(user.password);')] });
  prop({ topic: 'k3', evidence: [code('src/auth.js:61', 'const fixed = hash(user.password);')] });

  const out = verifyRun(db, repo, run);
  const ra = out.results.find((r) => r.fp === a.fp);
  assert.equal(ra?.result, 'verified', 'the stale md5 quote from the earlier line is not re-checked');
  assert.deepEqual(ra?.checks.map((x) => x.ref), ['src/auth.js:60']);
  const rc = out.results.find((r) => r.fp === c.fp);
  assert.deepEqual(rc?.checks.map((x) => [x.ref, x.found, x.line]), [['src/auth.js:61', 'near-line', 61]]);
});

test('3. dropped -> candidate when propose adds a new evidence key; same key stays dropped', () => {
  const r = runStart(db, { mode: 'full' }).id;
  const p = (/** @type {Record<string, unknown>} */ over) => propose(db, r, candidate(over), { kinds: KINDS });
  const bad = p({ topic: 'k4', evidence: [code('src/auth.js:60', 'md5(user.password)')] });
  const fp = /** @type {string} */ (bad.fp);
  assert.equal(verifyRun(db, repo, r).results.find((x) => x.fp === fp)?.result, 'dropped');

  const same = p({ topic: 'k4', evidence: [code('src/auth.js:12', 'md5(user.password)')] });
  assert.equal(same.result, 'duplicate', 'same key (line shift only): no move');
  assert.equal(same.status, 'dropped');
  assert.equal(getProposal(db, fp)?.status, 'dropped');

  const retry = p({ topic: 'k4', evidence: [code('src/auth.js:60', 'return check(user.password);')] });
  assert.equal(retry.result, 'evidence-grew');
  assert.equal(retry.resurfaced?.from, 'dropped');
  assert.equal(retry.status, 'candidate');
  const v = verifyRun(db, repo, r).results.find((x) => x.fp === fp);
  assert.equal(v?.result, 'verified', 'only the corrected quote (newest line) is checked');
  assert.ok(canMove('dropped', 'candidate'));
});

test('4. verified -> accepted only for a human decider; pushed -> accepted for forge', () => {
  const fp = /** @type {string} */ (prop({ topic: 'k5' }).fp);
  move(db, fp, 'verified', { by: 'skill:dowser-verify' });
  for (const by of ['agent:claude', 'forge:jira-user', 'skill:dowser']) {
    assert.throws(() => move(db, fp, 'accepted', { by }), (e) => e instanceof MoveRefused && e.current === 'verified' && e.code === 2, by);
  }
  assert.equal(move(db, fp, 'accepted', { from: 'verified', by: 'human:jane' }).status, 'accepted');

  const fp2 = /** @type {string} */ (prop({ topic: 'k6' }).fp);
  move(db, fp2, 'verified', { by: 'skill:dowser-verify' });
  move(db, fp2, 'pushed', { by: 'skill:dowser' });
  assert.equal(move(db, fp2, 'accepted', { by: 'forge:jane.doe' }).status, 'accepted');
  assert.ok(deciderAllowed('pushed', 'accepted', 'forge:x') && !deciderAllowed('verified', 'accepted', 'agent:x'));
});

test('5. propose stamps provenance.run_id; a different one is overwritten with a note, not invalid', () => {
  const omitted = prop({ topic: 'k7', provenance: { lens_version: '1.0.0' } });
  assert.equal(omitted.result, 'created');
  assert.equal(omitted.note, undefined);
  assert.equal(getProposal(db, /** @type {string} */ (omitted.fp))?.provenance.run_id, run);

  const wrong = prop({ topic: 'k8', provenance: { lens_version: '1.0.0', run_id: 'r-19990101000000-abcd' } });
  assert.equal(wrong.result, 'created');
  assert.equal(wrong.note, `provenance.run_id r-19990101000000-abcd replaced by ${run}`);
  const stored = getProposal(db, /** @type {string} */ (wrong.fp));
  assert.equal(stored?.provenance.run_id, run);
  assert.equal(stored?.provenance.model, 'm', 'model defaults from the run');
  assert.equal(stored?.asserted, undefined, 'internal asserted set is not part of the record');
});
