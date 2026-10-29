// @ts-check
// DW-9: `quotes=omit` keeps quoted source lines on the machine. The wire validator accepts quote OR quote_sha,
// evidenceKey keys a withheld quote on its sha, and outbox sends quote_sha in place of every code/doc quote.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { STORE_OWNED, validateCandidate } from '../lib/model.mjs';
import { evidenceKey, quoteSha, squash } from '../lib/fingerprint.mjs';
import { PREFS, getPrefs, setPrefs } from '../lib/memory.mjs';
import { evidenceOf, move, openStore, propose, runStart } from '../lib/store.mjs';
import { outbox, withheldQuotes } from '../lib/sync.mjs';
import { KINDS, candidate, removeDir, tempDir } from './_fixture.mjs';

/** @type {string} */ let dir;
/** @type {string | undefined} */ let homeBefore;
/** @type {import('../lib/store.mjs').Db} */ let db;
/** @type {string} */ let run;
const PK = 'github-com-acme-shop';
const LINE = 'return check(user.password);';

before(() => {
  dir = tempDir('quotes');
  homeBefore = process.env.DOWSER_HOME;
  process.env.DOWSER_HOME = join(dir, 'home');
  db = openStore(join(dir, 'dowser.db'));
  run = runStart(db, { mode: 'full', harness: 'claude', model: 'm' }).id;
});
after(() => {
  db.close();
  if (homeBefore === undefined) delete process.env.DOWSER_HOME; else process.env.DOWSER_HOME = homeBefore;
  removeDir(dir);
});

/** @param {ReturnType<typeof validateCandidate>} v */
const why = (v) => (v.ok ? 'ok' : v.why);

test('quoteSha: 16 lowercase hex of the squashed quote, whitespace-insensitive', () => {
  const h = quoteSha(LINE);
  assert.match(h, /^[0-9a-f]{16}$/);
  assert.equal(quoteSha(`  return   check(user.password);\n`), h);
  assert.equal(quoteSha(squash(LINE)), h);
  assert.notEqual(quoteSha('return check(user.token);'), h);
});

test('validator: strict mode needs quote and refuses quote_sha; wire mode takes quote or quote_sha', () => {
  const sha = quoteSha(LINE);
  const withSha = candidate({ evidence: [{ type: 'code', ref: 'src/auth.js:2', quote_sha: sha }] });
  const bare = candidate({ evidence: [{ type: 'code', ref: 'src/auth.js:2' }] });
  // strict (propose/verify): unchanged
  assert.equal(why(validateCandidate(candidate())), 'ok');
  assert.match(why(validateCandidate(withSha)), /evidence\[0\]:unknown field quote_sha/);
  assert.match(why(validateCandidate(bare)), /evidence\[0\]\.quote:required for code evidence$/);
  // wire (Forge push)
  assert.equal(why(validateCandidate(candidate(), { wire: true })), 'ok', 'a quoted record still passes');
  assert.equal(why(validateCandidate(withSha, { wire: true })), 'ok');
  assert.match(why(validateCandidate(bare, { wire: true })), /quote:required for code evidence \(or quote_sha\)/, 'never neither');
  const bad = candidate({ evidence: [{ type: 'doc', ref: 'README.md:3', quote_sha: 'ABCDEF0123456789' }] });
  assert.match(why(validateCandidate(bad, { wire: true })), /quote_sha:must be 16 lowercase hex/);
  const short = candidate({ evidence: [{ type: 'doc', ref: 'README.md:3', quote_sha: 'abc' }] });
  assert.match(why(validateCandidate(short, { wire: true })), /quote_sha:must be 16 lowercase hex/);
  const offType = candidate({ evidence: [{ type: 'ticket', ref: 'SEC-9', quote_sha: sha }] });
  assert.match(why(validateCandidate(offType, { wire: true })), /quote_sha:only on code\|doc/);
  // other rules are the same in wire mode
  assert.match(why(validateCandidate(candidate({ title: 'x'.repeat(81) }), { wire: true })), /title:longer/);
  assert.match(why(validateCandidate(candidate({ evidence: [{ type: 'code', ref: 'a.js', quote_sha: sha, extra: 1 }] }), { wire: true })), /unknown field extra/);
});

test('evidenceKey: a quote keys as before; a withheld quote keys on path + sha, stable across line shifts', () => {
  const sha = quoteSha(LINE);
  assert.equal(evidenceKey({ type: 'code', ref: 'src/auth.js:2', quote: LINE }).key, `src/auth.js\n${LINE}`);
  const a = evidenceKey({ type: 'code', ref: 'src/auth.js:2', quote_sha: sha });
  const b = evidenceKey({ type: 'code', ref: 'src/auth.js:40', quote_sha: sha });
  assert.equal(a.key, `src/auth.js\n#sha:${sha}`);
  assert.equal(a.key, b.key, 'a line shift is not new evidence');
  assert.equal(b.line, 40);
  const other = evidenceKey({ type: 'code', ref: 'src/auth.js:2', quote_sha: quoteSha('return check(user.token);') });
  assert.notEqual(other.key, a.key, 'two withheld lines in one file are two keys');
  assert.equal(evidenceKey({ type: 'code', ref: 'src/auth.js:2', quote: LINE, quote_sha: sha }).key, `src/auth.js\n${LINE}`, 'a quote wins');
});

test('prefs: quotes=send|omit is a known preference', () => {
  assert.deepEqual([...PREFS.quotes], ['send', 'omit']);
  assert.throws(() => setPrefs(['quotes=maybe']), /quotes must be one of send\|omit/);
  setPrefs(['quotes=omit']);
  assert.deepEqual(getPrefs(['quotes']), { quotes: 'omit' });
  setPrefs(['quotes=send']);
  assert.deepEqual(getPrefs(['quotes']), { quotes: 'send' });
});

test('outbox: quotes=omit sends quote_sha and no quote; send (and the default) is unchanged; the store keeps quotes', () => {
  const ev = [
    { type: 'code', ref: 'src/auth.js:2', quote: LINE },
    { type: 'doc', ref: 'README.md:3', quote: 'Passwords are hashed.', url: 'https://example.test/readme' },
    { type: 'ticket', ref: 'SEC-9', url: 'https://j/SEC-9' },
  ];
  const r = propose(db, run, candidate({ topic: 'quotes omit', evidence: ev }), { kinds: KINDS });
  const fp = /** @type {string} */ (r.fp);
  move(db, fp, 'verified', { from: 'candidate', by: 'skill:dowser-verify' });
  /** @param {'send' | 'omit'} [quotes] @returns {Record<string, any>} */
  const rec = (quotes) => JSON.parse(outbox(db, { projectKey: PK, runId: run, ...(quotes ? { quotes } : {}) }).proposals_json).find((/** @type {any} */ p) => p.fp === fp);

  const sent = rec('send');
  assert.deepEqual(sent.evidence.map((/** @type {any} */ e) => e.quote), [LINE, 'Passwords are hashed.', undefined]);
  assert.ok(sent.evidence.every((/** @type {any} */ e) => !('quote_sha' in e)));

  const omitted = rec('omit');
  for (const e of omitted.evidence) assert.ok(!('quote' in e), JSON.stringify(e));
  assert.deepEqual(omitted.evidence, [
    { type: 'code', ref: 'src/auth.js:2', quote_sha: quoteSha(LINE) },
    { type: 'doc', ref: 'README.md:3', quote_sha: quoteSha('Passwords are hashed.'), url: 'https://example.test/readme' },
    { type: 'ticket', ref: 'SEC-9', url: 'https://j/SEC-9' },
  ]);
  assert.equal(why(validateCandidate(Object.fromEntries(Object.entries(omitted).filter(([k]) => !STORE_OWNED.includes(k))), { wire: true })), 'ok', 'the pushed record passes the wire validator');

  // the stored evidence is untouched (verify and ask-why still read the quotes)
  assert.deepEqual(evidenceOf(db, fp).filter((e) => e.quote !== undefined).map((e) => e.quote), [LINE, 'Passwords are hashed.']);

  // outbox is pure: without `quotes` it sends the quotes, whatever ~/.dowser/user.json says (the CLI reads the
  // preference and passes it)
  setPrefs(['quotes=omit']);
  assert.equal(rec().evidence[0].quote, LINE);
  setPrefs(['quotes=send']);
});

test('withheldQuotes masks a quoted line the card text repeats, and leaves short or unrelated text alone', () => {
  const rec = {
    fp: 'f', title: 'Login compares the raw password', rationale: `It calls \`${LINE}\` directly.`,
    body: `## Summary\nHash first.\n\n## Description\nAt src/auth.js:2: \`${LINE}\`. Twice: ${LINE}`,
    evidence: [{ type: 'code', ref: 'src/auth.js:2', quote: LINE }, { type: 'code', ref: 'src/x.js:1', quote: 'a = 1' }],
  };
  const out = withheldQuotes(rec);
  assert.equal(out.title, rec.title);
  assert.equal(out.rationale, 'It calls `[line withheld: src/auth.js:2]` directly.');
  assert.ok(!out.body.includes(LINE));
  assert.equal(out.body.split('[line withheld: src/auth.js:2]').length - 1, 2);
  assert.ok(out.body.includes('Hash first.'));
  assert.equal(rec.body.includes(LINE), true, 'the input record is not changed');
});
