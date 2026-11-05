// @ts-check
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { getProposal, openStore, propose, runFinish, runStart } from '../lib/store.mjs';
import { findQuote, parseRef, verifyRun } from '../lib/verify.mjs';
import { normalizeAnchor } from '../lib/fingerprint.mjs';
import { ingestSources, outbox } from '../lib/sync.mjs';
import { execFileSync } from 'node:child_process';
import { KINDS, candidate, gitRepo, removeDir, tempDir, writeFiles } from './_fixture.mjs';

/** @type {string} */ let home;
/** @type {string} */ let repo;
/** @type {import('../lib/store.mjs').Db} */ let db;

before(() => {
  home = tempDir('verify-home');
  repo = tempDir('verify-repo');
  db = openStore(join(home, 'dowser.db'));
});
after(() => { db.close(); removeDir(home); removeDir(repo); });

test('parseRef reads path and line hints', () => {
  assert.deepEqual(parseRef('src/a.js:12'), { path: 'src/a.js', line: 12 });
  assert.deepEqual(parseRef('src/a.js:12:4'), { path: 'src/a.js', line: 12 });
  assert.deepEqual(parseRef('src/a.js#L7-L9'), { path: 'src/a.js', line: 7 });
  assert.deepEqual(parseRef('src/a.js#login'), { path: 'src/a.js' });
  assert.deepEqual(parseRef('src\\a.js'), { path: 'src/a.js' });
  assert.deepEqual(parseRef('src/a.js#L12C3'), { path: 'src/a.js', line: 12 });
  assert.deepEqual(parseRef('src/a.js#login:5'), { path: 'src/a.js', line: 5 });
});

test('parseRef and normalizeAnchor agree: #L10nProvider is a symbol, not line 10', () => {
  assert.deepEqual(parseRef('src/i18n.js#L10nProvider'), { path: 'src/i18n.js' });
  assert.equal(normalizeAnchor('src/i18n.js#L10nProvider'), 'src/i18n.js#L10nProvider');
  assert.deepEqual(parseRef('src/cache.js#L2Cache'), { path: 'src/cache.js' });
});

test('findQuote: whitespace-normalized, near the line or anywhere in the file', () => {
  const filler = Array.from({ length: 100 }, (_, i) => `// line ${i + 1}`);
  const lines = [...filler];
  lines[79] = 'const   token =\r\n   readSecret();';
  writeFiles(repo, { 'src/b.js': lines.join('\n'), 'doc/x.md': 'hello' });
  assert.deepEqual(findQuote(repo, 'src/b.js:80', 'const token = readSecret();'), { found: 'near-line', line: 80 });
  assert.deepEqual(findQuote(repo, 'src/b.js:10', 'const token = readSecret();'), { found: 'in-file', line: 80, claimed_line: 10, drift: 70 });
  assert.deepEqual(findQuote(repo, 'src/b.js', 'const token = readSecret();'), { found: 'in-file', line: 80 });
  assert.equal(findQuote(repo, 'src/b.js:80', 'nope').why, 'quote-not-found');
  assert.equal(findQuote(repo, 'src/missing.js', 'x').why, 'file-missing');
  assert.equal(findQuote(repo, '../outside.js', 'x').why, 'path-outside-repo');
});

test('verifyRun drops a candidate whose quote is absent and verifies one whose quote moved lines', () => {
  // the quote was emitted at line 2, but the file now has it at line 60 (moved > 30 lines): still verified
  const moved = [...Array.from({ length: 59 }, () => '// pad'), 'function login(user) { return check(user.password); }'].join('\n');
  writeFiles(repo, { 'src/auth.js': moved, 'README.md': '# App\nRun `npm start`.\n' });
  const run = runStart(db, { mode: 'full' }).id;
  ingestSources(db, { runId: run, type: 'ticket', doc: { items: [{ ref: 'SEC-1', title: 't', url: 'u', body: 'b' }] } });
  const ok = propose(db, run, candidate({
    topic: 'moved',
    evidence: [
      { type: 'code', ref: 'src/auth.js:2', quote: 'return check(user.password);' },
      { type: 'doc', ref: 'README.md:2', quote: 'Run `npm start`.' },
      { type: 'ticket', ref: 'SEC-1' },
      { type: 'git', ref: 'abc1234' },
    ],
  }), { kinds: KINDS });
  const gone = propose(db, run, candidate({
    topic: 'gone',
    evidence: [{ type: 'code', ref: 'src/auth.js:2', quote: 'md5(user.password)' }],
  }), { kinds: KINDS });
  assert.equal(ok.result, 'created');
  assert.equal(gone.result, 'created');

  const out = verifyRun(db, repo, run);
  assert.equal(out.verified, 1);
  assert.equal(out.dropped, 1);
  const okRes = out.results.find((r) => r.fp === ok.fp);
  const goneRes = out.results.find((r) => r.fp === gone.fp);
  assert.equal(okRes?.result, 'verified');
  assert.deepEqual(okRes?.checks.map((c) => c.found), ['in-file', 'near-line']);
  assert.deepEqual(okRes?.sources, [{ type: 'ticket', ref: 'SEC-1', ingested: true }]);
  assert.deepEqual(okRes?.unchecked, [{ type: 'git', ref: 'abc1234', checked: false }], 'git passes through, reported');
  assert.equal(goneRes?.result, 'dropped');
  assert.equal(goneRes?.note, 'verify-failed:src/auth.js:2');

  assert.equal(getProposal(db, /** @type {string} */ (ok.fp))?.status, 'verified');
  const dropped = getProposal(db, /** @type {string} */ (gone.fp));
  assert.equal(dropped?.status, 'dropped');
  assert.equal(dropped?.note, 'verify-failed:src/auth.js:2');
  assert.equal(verifyRun(db, repo, run).results.length, 0, 'a second verify finds no candidates left');
});

test('verifyRun drops a card citing a ticket/page/goal/dep ref this run did not ingest, keeps one whose refs are cached', () => {
  writeFiles(repo, { 'src/auth.js': 'function login(user) { return check(user.password); }\n' });
  const run = runStart(db, { mode: 'full' }).id;
  const other = runStart(db, { mode: 'full' }).id;
  const code = { type: 'code', ref: 'src/auth.js:1', quote: 'return check(user.password);' };
  const cited = {
    ticket: { type: 'ticket', ref: 'SUP-1' }, page: { type: 'page', ref: '98765' }, goal: { type: 'goal', ref: 'G-7' },
    dep: { type: 'dep', ref: 'package-lock.json#lodash@4.17.20' },
  };
  // the refs exist, but in ANOTHER run's cache (and as another type): not ingested by this run
  ingestSources(db, { runId: other, type: 'ticket', doc: { items: [{ ref: 'SUP-1' }, { ref: 'G-7' }] } });
  /** @type {Record<string, string>} */
  const fps = {};
  for (const [type, e] of Object.entries(cited)) {
    fps[type] = /** @type {string} */ (propose(db, run, candidate({ topic: `uncached ${type}`, evidence: [code, e] }), { kinds: KINDS }).fp);
  }
  const out = verifyRun(db, repo, run);
  assert.equal(out.dropped, 4);
  for (const [type, e] of Object.entries(cited)) {
    const r = out.results.find((x) => x.fp === fps[type]);
    assert.equal(r?.result, 'dropped', type);
    assert.equal(r?.note, `ref-not-ingested:${type}:${e.ref}`);
    assert.deepEqual(r?.sources, [{ type, ref: e.ref, ingested: false }]);
    assert.equal(getProposal(db, fps[type])?.note, `ref-not-ingested:${type}:${e.ref}`);
  }

  // the same cards in a run that ingested every ref (tickets/pages/goals via ingest-sources, dep as deps writes it)
  const good = runStart(db, { mode: 'full' }).id;
  ingestSources(db, { runId: good, type: 'ticket', doc: { items: [{ ref: 'SUP-1' }] } });
  ingestSources(db, { runId: good, type: 'page', doc: { items: [{ ref: '98765' }] } });
  ingestSources(db, { runId: good, type: 'goal', doc: { items: [{ ref: 'G-7' }] } });
  db.prepare("INSERT INTO sources_cache (run_id, type, ref, title, body, fetched_at) VALUES (?, 'dep', ?, 'GHSA-x high', '{}', ?)")
    .run(good, cited.dep.ref, new Date().toISOString());
  const kept = propose(db, good, candidate({ topic: 'all cached', evidence: [code, ...Object.values(cited)] }), { kinds: KINDS });
  const res = verifyRun(db, repo, good).results.find((x) => x.fp === kept.fp);
  assert.equal(res?.result, 'verified');
  assert.equal(res?.sources.every((s) => s.ingested), true);
  assert.deepEqual(res?.checks.map((c) => c.found), ['near-line'], 'the quote check is unchanged');
});

test('a failing quote and an uncached ref: the first in evidence order names the note', () => {
  writeFiles(repo, { 'src/auth.js': 'function login(user) { return check(user.password); }\n' });
  const run = runStart(db, { mode: 'full' }).id;
  const p = propose(db, run, candidate({
    topic: 'both fail',
    evidence: [{ type: 'ticket', ref: 'SUP-404' }, { type: 'code', ref: 'src/auth.js:1', quote: 'md5(user.password)' }],
  }), { kinds: KINDS });
  const r = verifyRun(db, repo, run).results.find((x) => x.fp === p.fp);
  assert.equal(r?.note, 'ref-not-ingested:ticket:SUP-404');
  assert.equal(r?.checks[0].found, false, 'the quote is still checked and reported');
});

test('ingestSources returns the ticket fields a demand table needs, omitting the absent ones', () => {
  const run = runStart(db, { mode: 'full' }).id;
  const out = ingestSources(db, { runId: run, type: 'ticket', doc: { items: [
    { ref: 'SUP-1', title: 'a', url: 'u1', body: 'b', created_at: '2026-10-01T00:00:00.000Z', labels: ['export'], components: ['Reports', ''] },
    { ref: 'SUP-2', title: 'b', url: 'u2', body: 'b', labels: [], components: 'not-a-list' },
  ] } }).out;
  assert.deepEqual(out.refs, [
    { type: 'ticket', ref: 'SUP-1', url: 'u1', title: 'a', components: ['Reports'], labels: ['export'], created_at: '2026-10-01T00:00:00.000Z' },
    { type: 'ticket', ref: 'SUP-2', url: 'u2', title: 'b' },
  ]);
  const cachedRow = db.prepare("SELECT * FROM sources_cache WHERE run_id = ? AND ref = 'SUP-1'").get(run);
  assert.deepEqual(Object.keys(/** @type {object} */ (cachedRow)).sort(), ['body', 'fetched_at', 'ref', 'run_id', 'title', 'type', 'url'], 'the cache schema is unchanged');
});

test('verifyRun drops a card whose only evidence is git/sarif: nothing was checkable', () => {
  const run = runStart(db, { mode: 'full' }).id;
  const only = propose(db, run, candidate({
    topic: 'unverifiable', evidence: [{ type: 'git', ref: 'abc1234' }, { type: 'sarif', ref: 'scan.sarif#R1@src/a.js:1' }],
  }), { kinds: KINDS });
  const r = verifyRun(db, repo, run).results.find((x) => x.fp === only.fp);
  assert.equal(r?.result, 'dropped');
  assert.equal(r?.note, 'no-checkable-evidence');
  assert.equal(r?.unchecked.length, 2, 'the passed-through refs are still reported');
});

test('verifyRun reads quotes at the run head commit: an uncommitted quote fails, a committed one passes after a local edit', () => {
  const g = tempDir('verify-git');
  try {
    gitRepo(g, { 'src/a.js': 'export const committed = 1;\n' });
    const head = execFileSync('git', ['-C', g, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    // the working tree now differs from the commit: one line added, the committed line removed
    writeFiles(g, { 'src/a.js': 'export const uncommitted = 2;\n' });
    const run = runStart(db, { mode: 'full', headSha: head }).id;
    const fresh = propose(db, run, candidate({ topic: 'fresh', evidence: [{ type: 'code', ref: 'src/a.js:1', quote: 'export const uncommitted = 2;' }] }), { kinds: KINDS });
    const old = propose(db, run, candidate({ topic: 'old', evidence: [{ type: 'code', ref: 'src/a.js:1', quote: 'export const committed = 1;' }] }), { kinds: KINDS });
    const out = verifyRun(db, g, run);
    const f = out.results.find((x) => x.fp === fresh.fp);
    assert.equal(f?.result, 'dropped');
    assert.equal(f?.checks[0].why, 'uncommitted');
    assert.equal(out.results.find((x) => x.fp === old.fp)?.result, 'verified', 'the pushed links show the committed line');
    assert.deepEqual(findQuote(g, 'src/a.js:1', 'export const uncommitted = 2;'), { found: 'near-line', line: 1 }, 'without a rev: the working tree');
  } finally { removeDir(g); }
});

test('evidence a re-propose adds to a verified or pushed card is checked by the next verify; a failed quote never reaches the outbox', () => {
  writeFiles(repo, { 'src/grow.js': 'export function grow() {\n  return real();\n}\n// second real line\n' });
  const real = { type: 'code', ref: 'src/grow.js:2', quote: 'return real();' };
  const fake = { type: 'code', ref: 'src/grow.js:9', quote: 'THIS LINE DOES NOT EXIST' };
  const second = { type: 'code', ref: 'src/grow.js:4', quote: '// second real line' };
  const quotesSent = (/** @type {string} */ run, /** @type {string} */ fp) => {
    const sent = JSON.parse(String(outbox(db, { projectKey: 'p', runId: run }).proposals_json));
    return sent.find((/** @type {any} */ r) => r.fp === fp)?.evidence.map((/** @type {any} */ e) => e.quote);
  };
  const r1 = runStart(db, { mode: 'full' }).id;
  const fp = String(propose(db, r1, candidate({ topic: 'grown after verify', evidence: [real] }), { kinds: KINDS }).fp);
  assert.equal(verifyRun(db, repo, r1).results.find((r) => r.fp === fp)?.result, 'verified');
  runFinish(db, { runId: r1, lenses: {} });

  const r2 = runStart(db, { mode: 'full' }).id;
  assert.equal(propose(db, r2, candidate({ topic: 'grown after verify', evidence: [real, fake] }), { kinds: KINDS }).result, 'evidence-grew');
  assert.deepEqual(quotesSent(r2, fp), ['return real();'], 'before verify: the new quote is held back');
  const v2 = verifyRun(db, repo, r2);
  assert.deepEqual(v2.rechecked, [{ fp, result: 'held', note: 'verify-failed:src/grow.js:9', checks: [{ type: 'code', ref: fake.ref, found: false, why: 'quote-not-found' }], sources: [], unchecked: [] }]);
  assert.equal(getProposal(db, fp)?.status, 'verified', 'the status stays: a person may have seen the card');
  assert.deepEqual(quotesSent(r2, fp), ['return real();'], 'a quote verify did not find never goes out');
  runFinish(db, { runId: r2, lenses: {} });

  const r3 = runStart(db, { mode: 'full' }).id;
  propose(db, r3, candidate({ topic: 'grown after verify', evidence: [real, second] }), { kinds: KINDS });
  assert.deepEqual(verifyRun(db, repo, r3).rechecked?.map((x) => x.result), ['checked']);
  assert.deepEqual(quotesSent(r3, fp), ['return real();', '// second real line']);
  assert.equal(verifyRun(db, repo, r3).rechecked, undefined, 'checked once: nothing new to re-check');
  runFinish(db, { runId: r3, lenses: {} });
});
