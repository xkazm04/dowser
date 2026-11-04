// @ts-check
// Delivery truth from the code (moonshot 2026-11-04, idea 1, slice 1): each run re-checks every accepted card's
// quoted evidence at the scanned commit and looks for commits that name its Jira issue or inbox item. A card
// whose quoted problem is gone reads `resolved`; one still in the code reads `present`. Append-only, one row per
// change, so the history of a card's delivery is kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { move, openStore, propose, runStart } from '../lib/store.mjs';
import { checkDeliveries } from '../lib/delivery.mjs';
import { KINDS, candidate, gitRepo, removeDir, tempDir, writeFiles } from './_fixture.mjs';

const git = (/** @type {string} */ root, /** @type {string[]} */ ...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' }).trim();

test('accepted cards are re-checked at the scanned commit: resolved, partly, present, with the commits that name the issue', () => {
  const repo = tempDir('delivery-repo');
  const home = tempDir('delivery-home');
  const db = openStore(join(home, 'dowser.db'));
  try {
    gitRepo(repo, { 'src/auth.js': 'const a = md5(pw);\nconst b = plain(pw);\n', 'src/csv.js': 'export function noCsv() {}\n' });
    const run1 = String(runStart(db, { mode: 'full', headSha: git(repo, 'rev-parse', 'HEAD') }).id);
    const accept = (/** @type {Record<string, unknown>} */ over, /** @type {string} */ issue, /** @type {string} */ ref) => {
      const fp = String(propose(db, run1, candidate(over), { kinds: KINDS }).fp);
      move(db, fp, 'verified', { by: 'skill:dowser-verify' });
      move(db, fp, 'pushed', { by: 'skill:dowser-sync' });
      db.prepare('UPDATE proposals SET external_ref = ? WHERE fp = ?').run(ref, fp);
      move(db, fp, 'accepted', { by: 'forge:jane' });
      db.prepare('UPDATE proposals SET issue_ref = ? WHERE fp = ?').run(issue, fp);
      return fp;
    };
    const both = accept({ topic: 'weak hashes', evidence: [{ type: 'code', ref: 'src/auth.js:1', quote: 'const a = md5(pw);' }, { type: 'code', ref: 'src/auth.js:2', quote: 'const b = plain(pw);' }] }, 'SHOP-1', 'DW-1');
    const csv = accept({ topic: 'no csv', anchors: ['src/csv.js'], evidence: [{ type: 'code', ref: 'src/csv.js:1', quote: 'export function noCsv() {}' }] }, 'SHOP-2', 'DW-2');

    const first = checkDeliveries(db, repo, run1);
    assert.deepEqual(first.changes.map((c) => [c.fp, c.to]).sort(), [[both, 'present'], [csv, 'present']].sort());

    // the team fixes one hash and ships CSV export, naming the issues in the commits
    writeFiles(repo, { 'src/auth.js': 'const a = argon2(pw);\nconst b = plain(pw);\n', 'src/csv.js': 'export function toCsv() {}\n' });
    git(repo, 'commit', '-qam', 'SHOP-2: export orders as CSV');
    const run2 = String(runStart(db, { mode: 'incremental', headSha: git(repo, 'rev-parse', 'HEAD') }).id);
    const second = checkDeliveries(db, repo, run2);
    const by = Object.fromEntries(second.changes.map((c) => [c.fp, c]));
    assert.equal(by[both].to, 'partly');
    assert.equal(by[both].from, 'present');
    assert.equal(by[csv].to, 'resolved');
    assert.equal(by[csv].commits?.length, 1, 'the commit that names SHOP-2');
    assert.equal(checkDeliveries(db, repo, run2).changes.length, 0, 'nothing changed: no new row');
    assert.equal(/** @type {any} */ (db.prepare('SELECT COUNT(*) AS n FROM deliveries').get()).n, 4, 'append-only history: 2 + 2');
  } finally { db.close(); removeDir(home); removeDir(repo); }
});

test('reflect export sends the newest code re-check of each pushed accepted card as deliveries_json', async () => {
  const { exportOffers } = await import('../lib/reflect.mjs');
  const repo = tempDir('delivery-export-repo');
  const home = tempDir('delivery-export-home');
  const db = openStore(join(home, 'dowser.db'));
  try {
    gitRepo(repo, { 'src/a.js': 'const x = md5(pw);\n' });
    const run = String(runStart(db, { mode: 'full', headSha: git(repo, 'rev-parse', 'HEAD') }).id);
    const fp = String(propose(db, run, candidate({ evidence: [{ type: 'code', ref: 'src/a.js:1', quote: 'const x = md5(pw);' }] }), { kinds: KINDS }).fp);
    move(db, fp, 'verified', { by: 'skill:dowser-verify' });
    move(db, fp, 'pushed', { by: 'skill:dowser-sync' });
    db.prepare("UPDATE proposals SET external_ref = 'DW-1' WHERE fp = ?").run(fp);
    move(db, fp, 'accepted', { by: 'forge:jane' });
    assert.equal(exportOffers(db, 'pk').deliveries_json, undefined, 'no check yet: omitted');
    checkDeliveries(db, repo, run);
    const sent = JSON.parse(String(exportOffers(db, 'pk').deliveries_json));
    assert.deepEqual(sent.map((/** @type {any} */ d) => [d.fp, d.state, d.found, d.total]), [[fp, 'present', 1, 1]]);
  } finally { db.close(); removeDir(home); removeDir(repo); }
});
