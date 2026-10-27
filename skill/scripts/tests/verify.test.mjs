// @ts-check
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { getProposal, openStore, propose, runStart } from '../lib/store.mjs';
import { findQuote, parseRef, verifyRun } from '../lib/verify.mjs';
import { KINDS, candidate, removeDir, tempDir, writeFiles } from './_fixture.mjs';

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
});

test('findQuote: whitespace-normalized, near the line or anywhere in the file', () => {
  const filler = Array.from({ length: 100 }, (_, i) => `// line ${i + 1}`);
  const lines = [...filler];
  lines[79] = 'const   token =\r\n   readSecret();';
  writeFiles(repo, { 'src/b.js': lines.join('\n'), 'doc/x.md': 'hello' });
  assert.deepEqual(findQuote(repo, 'src/b.js:80', 'const token = readSecret();'), { found: 'near-line', line: 80 });
  assert.deepEqual(findQuote(repo, 'src/b.js:10', 'const token = readSecret();'), { found: 'in-file', line: 10 });
  assert.deepEqual(findQuote(repo, 'src/b.js', 'const token = readSecret();'), { found: 'in-file' });
  assert.equal(findQuote(repo, 'src/b.js:80', 'nope').why, 'quote-not-found');
  assert.equal(findQuote(repo, 'src/missing.js', 'x').why, 'file-missing');
  assert.equal(findQuote(repo, '../outside.js', 'x').why, 'path-outside-repo');
});

test('verifyRun drops a candidate whose quote is absent and verifies one whose quote moved lines', () => {
  // the quote was emitted at line 2, but the file now has it at line 60 (moved > 30 lines): still verified
  const moved = [...Array.from({ length: 59 }, () => '// pad'), 'function login(user) { return check(user.password); }'].join('\n');
  writeFiles(repo, { 'src/auth.js': moved, 'README.md': '# App\nRun `npm start`.\n' });
  const run = runStart(db, { mode: 'full' }).id;
  const ok = propose(db, run, candidate({
    topic: 'moved',
    evidence: [
      { type: 'code', ref: 'src/auth.js:2', quote: 'return check(user.password);' },
      { type: 'doc', ref: 'README.md:2', quote: 'Run `npm start`.' },
      { type: 'ticket', ref: 'SEC-1' },
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
  assert.deepEqual(okRes?.unchecked, [{ type: 'ticket', ref: 'SEC-1', checked: false }], 'other types pass through, reported');
  assert.equal(goneRes?.result, 'dropped');
  assert.equal(goneRes?.note, 'verify-failed:src/auth.js:2');

  assert.equal(getProposal(db, /** @type {string} */ (ok.fp))?.status, 'verified');
  const dropped = getProposal(db, /** @type {string} */ (gone.fp));
  assert.equal(dropped?.status, 'dropped');
  assert.equal(dropped?.note, 'verify-failed:src/auth.js:2');
  assert.equal(verifyRun(db, repo, run).results.length, 0, 'a second verify finds no candidates left');
});
