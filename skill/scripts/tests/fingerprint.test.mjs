// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprint, normalizeAnchor, normalizeTopic } from '../lib/fingerprint.mjs';
import { DowserError } from '../lib/model.mjs';

const KINDS = ['secret', 'vuln'];
const base = { lens: 'security-cra', kind: 'secret', topic: 'Plaintext password check', anchors: ['src/auth.js#login', 'src/db.js'] };

test('normalizeTopic: lowercase kebab, dashes collapsed, stop punctuation stripped', () => {
  assert.equal(normalizeTopic('  Plaintext   Password -- Check! '), 'plaintext-password-check');
  assert.equal(normalizeTopic("User's “Login” flow"), 'users-login-flow');
  assert.equal(normalizeTopic('Café_Menu/Settings'), 'cafe-menu-settings');
  assert.equal(normalizeTopic('---'), '');
});

test('normalizeAnchor: forward slashes, line suffixes stripped, #symbol kept', () => {
  assert.equal(normalizeAnchor('src\\auth.js:12'), 'src/auth.js');
  assert.equal(normalizeAnchor('./src/auth.js:12:5'), 'src/auth.js');
  assert.equal(normalizeAnchor('src/auth.js#login'), 'src/auth.js#login');
  assert.equal(normalizeAnchor('src/auth.js:40#login'), 'src/auth.js#login');
  assert.equal(normalizeAnchor('src/auth.js#login:40'), 'src/auth.js#login');
  assert.equal(normalizeAnchor('src/auth.js#L12-L20'), 'src/auth.js');
  assert.equal(normalizeAnchor('docs//guide.md'), 'docs/guide.md');
});

test('fingerprint is 16 hex and stable across line suffixes, anchor order, duplicates and title wording', () => {
  const fp = fingerprint(base, KINDS);
  assert.match(fp, /^[0-9a-f]{16}$/);
  const sameWithLines = fingerprint({ ...base, anchors: ['src\\db.js:88', 'src/auth.js:12#login', 'src/db.js:3'] }, KINDS);
  assert.equal(sameWithLines, fp, 'line numbers, order, slashes and duplicates do not move the fp');
  const sameTopicWording = fingerprint({ ...base, topic: 'plaintext  PASSWORD check.' }, KINDS);
  assert.equal(sameTopicWording, fp, 'topic case and punctuation do not move the fp');
  // title/body wording is not an fp input at all: the same identity in a candidate with another title
  const withTitle = /** @type {any} */ ({ ...base, title: 'A completely different title' });
  assert.equal(fingerprint(withTitle, KINDS), fp);
});

test('fingerprint changes when an anchor, the kind, the topic or the lens changes', () => {
  const fp = fingerprint(base, KINDS);
  assert.notEqual(fingerprint({ ...base, anchors: ['src/auth.js#logout', 'src/db.js'] }, KINDS), fp, 'other symbol');
  assert.notEqual(fingerprint({ ...base, anchors: ['src/auth.js#login'] }, KINDS), fp, 'anchor removed');
  assert.notEqual(fingerprint({ ...base, kind: 'vuln' }, KINDS), fp, 'other kind');
  assert.notEqual(fingerprint({ ...base, topic: 'weak password hash' }, KINDS), fp, 'other topic');
  assert.notEqual(fingerprint({ ...base, lens: 'doc-drift', kind: 'secret' }, ['secret']), fp, 'other lens');
});

test('fingerprint refuses a kind outside the lens kinds, an unknown lens and an empty topic', () => {
  assert.throws(() => fingerprint({ ...base, kind: 'gap' }, KINDS), DowserError);
  assert.throws(() => fingerprint(base, []), DowserError);
  assert.throws(() => fingerprint({ ...base, lens: 'tech-debt' }, KINDS), DowserError);
  assert.throws(() => fingerprint({ ...base, topic: '!!!' }, KINDS), DowserError);
});
