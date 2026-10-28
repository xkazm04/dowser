// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assign, expectedFor, scoreLens } from '../lib/score.mjs';
import { normalizeAnchor } from '../lib/fingerprint.mjs';
import { LENSES } from '../lib/model.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/lens-fixture/', import.meta.url));
const LENS_DIR = fileURLToPath(new URL('../../lenses/', import.meta.url));
const readJson = (/** @type {string} */ p) => JSON.parse(readFileSync(join(FIXTURE, p), 'utf8'));
const expected = readJson('_expected.json');

/** A card on `anchors` (only the fields the scorer reads). @param {string} title @param {string[]} anchors @param {Record<string, unknown>} [over] */
const card = (title, anchors, over = {}) => ({ lens: 'doc-drift', kind: 'contradicted-by-code', title, anchors, ...over });

const EXP = [
  { lens: 'doc-drift', id: 'limit', kind: 'contradicted-by-code', anchor: 'docs/configuration.md', also: ['src/config.js#MAX_CART_ITEMS'], must: true, why: 'w' },
  { lens: 'doc-drift', id: 'guest', kind: 'undocumented-change', anchor: 'src/checkout/guest.js', also: ['src/config.js#PEBBLE_GUEST_CHECKOUT'], must: true, why: 'w' },
  { lens: 'doc-drift', id: 'example', kind: 'stale-example', anchor: 'docs/api.md#post-cart', must: true, why: 'w' },
  { lens: 'doc-drift', id: 'readme', anchor: 'README.md', decoy: true, why: 'w' },
  { lens: 'doc-drift', id: 'changelog', anchor: 'CHANGELOG.md', decoy: true, why: 'w' },
  { lens: 'security-cra', id: 'other-lens', anchor: 'docs/api.md', must: true, why: 'w' },
];

test('scoreLens: a perfect emission finds every seeded item and proposes no decoy', () => {
  const s = scoreLens({ expected: { items: EXP }, lens: 'doc-drift', verify_dropped: 1, emitted: [
    card('limit', ['docs/configuration.md:6', 'src/config.js#MAX_CART_ITEMS']),
    card('guest', ['src/checkout/guest.js#allowGuestCheckout', 'src/config.js#PEBBLE_GUEST_CHECKOUT'], { kind: 'undocumented-change' }),
    card('example', ['./docs/api.md#post-cart:20'], { kind: 'stale-example' }),
  ] });
  assert.deepEqual(s, {
    lens: 'doc-drift', seeded: 3, found: 3, recall: 1, found_exact: 3, kind_matched: 3,
    emitted: 3, matched: 3, precision: 1, decoy_hits: 0, artifacts_total: 0, artifacts_valid: 0, verify_dropped: 1,
  });
});

test('scoreLens: partial recall, a path-only hit, and an unmatched card listed for the hand check', () => {
  const s = scoreLens({ expected: EXP, lens: 'doc-drift', emitted: [
    card('example by path', ['docs/api.md#curl']),
    card('something else', ['src/routes/search.js#searchProducts']),
  ] });
  assert.equal(s.seeded, 3);
  assert.equal(s.found, 1);
  assert.equal(s.recall, 0.333);
  assert.equal(s.found_exact, 0);
  assert.deepEqual(s.path_only, ['example']);
  assert.equal(s.kind_matched, 0, 'kind is reported, not required');
  assert.equal(s.matched, 1);
  assert.equal(s.precision, 0.5);
  assert.deepEqual(s.missed, ['limit', 'guest']);
  assert.deepEqual(s.unmatched, ['something else']);
  assert.equal('verify_dropped' in s, false, 'unmeasured: omitted');
});

test('scoreLens: a card on a decoy is a decoy hit, not a match', () => {
  const s = scoreLens({ expected: EXP, lens: 'doc-drift', emitted: [card('readme port', ['README.md']), card('limit', ['docs/configuration.md'])] });
  assert.equal(s.decoy_hits, 1);
  assert.deepEqual(s.decoys, ['readme']);
  assert.equal(s.matched, 1);
  assert.equal(s.precision, 0.5);
});

test('assign: a card that also cites a shared file counts once, for the finding it is about', () => {
  const items = expectedFor(EXP, 'doc-drift');
  assert.equal(assign(items, ['src/checkout/guest.js', 'docs/configuration.md', 'src/config.js#PEBBLE_GUEST_CHECKOUT'])?.item.id, 'guest');
  assert.equal(assign(items, ['docs/configuration.md', 'src/config.js'])?.item.id, 'limit');
  assert.equal(assign(items, ['src/elsewhere.js']), undefined);
  const s = scoreLens({ expected: EXP, lens: 'doc-drift', emitted: [card('guest', ['src/checkout/guest.js', 'docs/configuration.md', 'src/config.js#PEBBLE_GUEST_CHECKOUT'])] });
  assert.equal(s.found, 1);
  assert.deepEqual(s.missed, ['limit', 'example']);
});

test('scoreLens: artifacts are counted and judged against the card\'s own evidence', () => {
  const evidence = [{ ref: 'docs/configuration.md:6' }, { ref: 'src/config.js:19' }];
  const table = { kind: 'table', message: 'Doc and code disagree on the cart limit', alt: 'Doc says 50, code says 20.',
    refs: ['docs/configuration.md:6', 'src/config.js:19'], data: { columns: ['Source', 'Limit'], rows: [['doc', '50'], ['code', '20']] } };
  const stray = { ...table, refs: ['src/other.js:1'] };
  const s = scoreLens({ expected: EXP, lens: 'doc-drift', emitted: [
    card('limit', ['docs/configuration.md'], { evidence, artifacts: [table, stray] }),
    card('too many', ['docs/api.md#post-cart'], { evidence, artifacts: [table, table, table, table] }),
  ] });
  assert.equal(s.artifacts_total, 6);
  assert.equal(s.artifacts_valid, 1);
  assert.equal(s.artifact_problems?.length, 2);
  assert.match(String(s.artifact_problems?.[0]), /artifacts\[1\]\.refs:src\/other\.js:1 is not in this card's evidence/);
  assert.match(String(s.artifact_problems?.[1]), /at most 3 per card/);
});

test('scoreLens: an empty emission omits precision and never reports 0 for it', () => {
  const s = scoreLens({ expected: EXP, lens: 'doc-drift', emitted: [] });
  assert.equal(s.emitted, 0);
  assert.equal('precision' in s, false);
  assert.equal(s.recall, 0, 'measured: nothing seeded was found');
  const none = scoreLens({ expected: EXP, lens: 'opportunity', emitted: [] });
  assert.equal('recall' in none, false, 'nothing seeded for the lens: recall omitted');
  assert.equal(none.seeded, 0);
});

// ------------------------------------------------------------------------------------------- the fixture

/** The `kinds` list of a lens pack's frontmatter. @param {string} lens */
function packKinds(lens) {
  const text = readFileSync(join(LENS_DIR, `${lens}.md`), 'utf8');
  const m = text.match(/^kinds:\s*\[([^\]]*)\]/m);
  return { kinds: m ? m[1].split(',').map((k) => k.trim()) : [], text };
}

test('fixture: _expected.json covers every lens with 3-4 seeded findings and at least 2 decoys', () => {
  const ids = new Set();
  for (const lens of LENSES) {
    const items = expectedFor(expected, lens);
    const seeded = items.filter((e) => !e.decoy);
    const decoys = items.filter((e) => e.decoy);
    assert.ok(seeded.length >= 3 && seeded.length <= 4, `${lens}: ${seeded.length} seeded (3-4, the pack budget is 4)`);
    assert.ok(decoys.length >= 2, `${lens}: ${decoys.length} decoys`);
    const { kinds, text } = packKinds(lens);
    const primaries = new Set();
    for (const e of items) {
      assert.ok(!ids.has(e.id), `duplicate id ${e.id}`);
      ids.add(e.id);
      assert.ok(typeof e.why === 'string' && e.why.length > 20, `${e.id}: why`);
      assert.ok(e.must === true || e.decoy === true, `${e.id}: must or decoy`);
      const primary = normalizeAnchor(e.anchor).split('#')[0];
      assert.ok(!primaries.has(primary), `${lens}: primary anchor path ${primary} is used twice`);
      primaries.add(primary);
      assert.ok(existsSync(join(FIXTURE, primary)), `${e.id}: ${primary} exists in the fixture`);
      assert.ok(!primary.startsWith('_'), `${e.id}: anchors never point at the fixture's own _ files`);
      if (!e.decoy) {
        assert.ok(kinds.includes(String(e.kind)), `${e.id}: kind ${e.kind} is one of ${lens}'s kinds`);
        assert.ok(text.includes(`**${e.hypothesis} `), `${e.id}: hypothesis ${e.hypothesis} exists in the ${lens} pack`);
      }
    }
  }
});

test('fixture: every ticket, page and goal a why cites is in _sources.json', () => {
  const sources = readJson('_sources.json');
  const refs = new Set([...sources.tickets, ...sources.pages, ...sources.goals].map((/** @type {{ref: string}} */ i) => i.ref));
  for (const k of ['tickets', 'pages', 'goals']) {
    for (const it of sources[k]) for (const f of ['ref', 'title', 'url', 'body']) assert.equal(typeof it[f], 'string', `${k} ${it.ref}: ${f}`);
  }
  for (const e of expected.items) {
    for (const ref of String(e.why).match(/\b(?:SHOP-\d+|PAGE-\d+|G-\d+)\b/g) ?? []) assert.ok(refs.has(ref), `${e.id} cites ${ref}`);
  }
});

test('fixture: the git history overlays exist and the captured audit matches the lockfile', () => {
  const { commits } = readJson('_history/commits.json');
  assert.ok(commits.length >= 2);
  assert.deepEqual(commits.at(-1).files, {}, 'the last commit is the final tree');
  for (const c of commits) {
    assert.ok(Number.isInteger(c.days_ago) && typeof c.message === 'string');
    for (const src of Object.values(c.files)) if (src !== null) assert.ok(existsSync(join(FIXTURE, String(src))), `${src} exists`);
  }
  const lock = readJson('package-lock.json');
  const audit = readJson('_auditor/npm-audit.json');
  assert.equal(audit.auditReportVersion, 2);
  assert.equal(lock.packages['node_modules/lodash'].version, readJson('package.json').dependencies.lodash);
  assert.ok(audit.vulnerabilities.lodash.via.some((/** @type {{severity: string}} */ v) => v.severity === 'high'));
});
