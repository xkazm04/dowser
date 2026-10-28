// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assign, expectedFor, scoreLens } from '../lib/score.mjs';
import { normalizeAnchor } from '../lib/fingerprint.mjs';
import { LENSES } from '../lib/model.mjs';
import { checkDirection } from '../lib/direction.mjs';
import { npmFindings } from '../lib/deps.mjs';

/** The placeholder project key of the fixture's direction seed (tools/lens-eval.mjs FIXTURE_PROJECT). */
const FIXTURE_PROJECT = 'pebble-shop';

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
    emitted: 3, matched: 3, precision: 1, decoy_hits: 0, direction_violations: 0, artifacts_total: 0, artifacts_valid: 0, verify_dropped: 1,
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

/** A fixture with more seeded findings than the budget, one excluded and one focused by direction. */
const HARD = [
  { lens: 'ux-friction', id: 'p1-a', anchor: 'src/a.js', priority: 1, must: true, why: 'w' },
  { lens: 'ux-friction', id: 'p1-b', anchor: 'src/b.js', priority: 1, must: true, why: 'w' },
  { lens: 'ux-friction', id: 'p2-focus', anchor: 'src/c.js', priority: 2, focus_by_direction: true, must: true, why: 'w' },
  { lens: 'ux-friction', id: 'p2-d', anchor: 'src/d.js', priority: 2, must: true, why: 'w' },
  { lens: 'ux-friction', id: 'p3-e', anchor: 'src/e.js', priority: 3, must: true, why: 'w' },
  { lens: 'ux-friction', id: 'p3-f', anchor: 'src/f.js', priority: 3, must: true, why: 'w' },
  { lens: 'ux-friction', id: 'out', anchor: 'src/admin.js', priority: 2, excluded_by_direction: true, must: true, why: 'w' },
  { lens: 'ux-friction', id: 'trap', anchor: 'src/fine.js', decoy: true, why: 'w' },
];
const ux = (/** @type {string} */ title, /** @type {string[]} */ anchors) => card(title, anchors, { lens: 'ux-friction' });

test('scoreLens: recall_at_budget judges a full budget of good choices as 1 while recall stays found / seeded', () => {
  const s = scoreLens({ expected: HARD, lens: 'ux-friction', budget: 4, emitted: [
    ux('a', ['src/a.js']), ux('b', ['src/b.js']), ux('focus', ['src/c.js']), ux('d', ['src/d.js']),
  ] });
  assert.equal(s.seeded, 6, 'the excluded item is out of scope, decoys never count');
  assert.equal(s.found, 4);
  assert.equal(s.recall, 0.667);
  assert.equal(s.budget, 4);
  assert.equal(s.recall_at_budget, 1);
  assert.equal(s.priority1_found, 2);
  assert.equal(s.priority1_total, 2);
  assert.equal(s.focus_found, 1);
  assert.equal(s.focus_total, 1);
  assert.equal(s.direction_violations, 0);
  assert.deepEqual(s.missed, ['p3-e', 'p3-f']);
});

test('scoreLens: a poor choice under the budget shows in priority1 and focus, not only in recall', () => {
  const s = scoreLens({ expected: HARD, lens: 'ux-friction', budget: 4, emitted: [
    ux('e', ['src/e.js']), ux('f', ['src/f.js']), ux('a', ['src/a.js']),
  ] });
  assert.equal(s.recall_at_budget, 0.75);
  assert.equal(s.priority1_found, 1);
  assert.equal(s.focus_found, 0, 'measured: the focused item was not proposed');
  assert.equal(s.precision, 1);
});

test('scoreLens: a card on an excluded_by_direction item is a direction violation, counted against precision', () => {
  const s = scoreLens({ expected: HARD, lens: 'ux-friction', budget: 4, emitted: [
    ux('admin', ['src/admin.js#importPrices']), ux('a', ['src/a.js']), ux('trap', ['src/fine.js']),
  ] });
  assert.equal(s.direction_violations, 1);
  assert.deepEqual(s.violations, ['out']);
  assert.equal(s.decoy_hits, 1);
  assert.equal(s.matched, 1);
  assert.equal(s.found, 1);
  assert.equal(s.precision, 0.333);
  assert.equal(s.missed?.includes('out'), false, 'an excluded item is never missed');
});

test('scoreLens: recall_at_budget uses the seeded count when it is below the budget, and is absent without a budget', () => {
  const small = scoreLens({ expected: EXP, lens: 'doc-drift', budget: 4, emitted: [card('limit', ['docs/configuration.md'])] });
  assert.equal(small.recall_at_budget, 0.333, 'found / min(3 seeded, budget 4)');
  assert.equal('priority1_found' in small, false, 'no priority-1 item: omitted');
  assert.equal('priority1_total' in small, false);
  assert.equal('focus_found' in small, false);
  const none = scoreLens({ expected: EXP, lens: 'doc-drift', emitted: [] });
  assert.equal('recall_at_budget' in none, false);
  assert.equal('budget' in none, false);
  assert.equal(none.direction_violations, 0);
  const empty = scoreLens({ expected: EXP, lens: 'opportunity', budget: 4, emitted: [] });
  assert.equal('recall_at_budget' in empty, false, 'nothing seeded: absent, never 0');
  const p1 = scoreLens({ expected: HARD, lens: 'ux-friction', budget: 4, emitted: [] });
  assert.equal(p1.priority1_found, 0, 'measured: none of the 2 priority-1 items found');
  assert.equal(p1.recall_at_budget, 0);
});

// ------------------------------------------------------------------------------------------- the fixture

/** The `kinds` list of a lens pack's frontmatter. @param {string} lens */
function packKinds(lens) {
  const text = readFileSync(join(LENS_DIR, `${lens}.md`), 'utf8');
  const m = text.match(/^kinds:\s*\[([^\]]*)\]/m);
  const b = text.match(/^budget:\s*(\d+)/m);
  return { kinds: m ? m[1].split(',').map((k) => k.trim()) : [], budget: b ? Number(b[1]) : undefined, text };
}

test('fixture: every lens seeds more findings than its budget, with priorities, hard decoys and one direction case each', () => {
  const ids = new Set();
  for (const lens of LENSES) {
    const items = expectedFor(expected, lens);
    const real = items.filter((e) => !e.decoy);
    const decoys = items.filter((e) => e.decoy);
    const { kinds, budget, text } = packKinds(lens);
    assert.ok(real.length >= 6 && real.length <= 8, `${lens}: ${real.length} seeded (6-8)`);
    assert.ok(budget !== undefined && real.filter((e) => !e.excluded_by_direction).length > budget, `${lens}: more in-scope findings than the budget of ${budget}`);
    assert.ok(real.filter((e) => e.priority === 1).length >= 2, `${lens}: at least 2 priority-1 findings`);
    assert.ok(decoys.length >= 3 && decoys.length <= 5, `${lens}: ${decoys.length} decoys (3-5)`);
    assert.equal(real.filter((e) => e.excluded_by_direction).length, 1, `${lens}: one excluded_by_direction item`);
    const focus = real.filter((e) => e.focus_by_direction);
    assert.equal(focus.length, 1, `${lens}: one focus_by_direction item`);
    assert.equal(focus[0].priority, 2, `${lens}: the focus pulls a priority-2 finding up`);
    const p1 = real.filter((e) => e.priority === 1 && !e.excluded_by_direction).length;
    assert.ok(budget !== undefined && p1 + 1 <= budget, `${lens}: the priority-1 findings and the focused one fit the budget`);
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
      if (e.decoy) {
        assert.equal(e.priority, undefined, `${e.id}: a decoy has no priority`);
        assert.ok(!e.excluded_by_direction && !e.focus_by_direction, `${e.id}: direction marks are for real findings`);
      } else {
        assert.ok([1, 2, 3].includes(Number(e.priority)), `${e.id}: priority 1, 2 or 3`);
        assert.ok(kinds.includes(String(e.kind)), `${e.id}: kind ${e.kind} is one of ${lens}'s kinds`);
        assert.ok(text.includes(`**${e.hypothesis} `), `${e.id}: hypothesis ${e.hypothesis} exists in the ${lens} pack`);
      }
    }
  }
});

test('fixture: a card on an item\'s own anchors lands on that item, and the ideal top 4 scores 1', () => {
  for (const lens of LENSES) {
    const items = expectedFor(expected, lens);
    for (const e of items) {
      assert.equal(assign(items, [e.anchor, ...(e.also ?? [])])?.item.id, e.id, `${e.id}: its anchors land on it`);
      assert.equal(assign(items, [e.anchor])?.item.id, e.id, `${e.id}: its primary anchor alone lands on it`);
    }
    // priority 1 and the focused item first, then priority 2, up to the budget
    const { budget } = packKinds(lens);
    const inScope = items.filter((e) => !e.decoy && !e.excluded_by_direction);
    const must = inScope.filter((e) => e.priority === 1 || e.focus_by_direction);
    const ideal = [...must, ...inScope.filter((e) => e.priority === 2 && !must.includes(e))].slice(0, budget);
    const s = scoreLens({ expected, lens, budget, emitted: ideal.map((e) => ({ lens, title: e.id, anchors: [e.anchor, ...(e.also ?? [])] })) });
    assert.equal(s.recall_at_budget, 1, `${lens}: recall_at_budget`);
    assert.equal(s.priority1_found, s.priority1_total);
    assert.equal(s.focus_found, 1);
    assert.equal(s.precision, 1);
  }
});

test('fixture: every ticket, page and goal a why cites is in _sources.json, in the contract shapes', () => {
  const sources = readJson('_sources.json');
  const refs = new Set([...sources.tickets, ...sources.pages, ...sources.goals].map((/** @type {{ref: string}} */ i) => i.ref));
  assert.equal(refs.size, sources.tickets.length + sources.pages.length + sources.goals.length, 'refs are unique');
  for (const k of ['tickets', 'pages', 'goals']) {
    for (const it of sources[k]) for (const f of ['ref', 'title', 'url', 'body']) assert.equal(typeof it[f], 'string', `${k} ${it.ref}: ${f}`);
  }
  const strings = (/** @type {unknown} */ v) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x.length > 0);
  for (const t of sources.tickets) {
    assert.ok(!Number.isNaN(Date.parse(t.created_at)), `${t.ref}: created_at`);
    for (const f of ['labels', 'components']) if (t[f] !== undefined) assert.ok(strings(t[f]), `${t.ref}: ${f} is a non-empty string list`);
  }
  for (const p of sources.pages) {
    assert.ok(!Number.isNaN(Date.parse(p.updated_at)), `${p.ref}: updated_at`);
    assert.equal(typeof p.space, 'string', `${p.ref}: space`);
  }
  for (const e of expected.items) {
    for (const ref of String(e.why).match(/\b(?:SHOP-\d+|PAGE-\d+|G-\d+)\b/g) ?? []) assert.ok(refs.has(ref), `${e.id} cites ${ref}`);
  }
});

test('fixture: the direction seed is one project with a valid focus and exclude for every lens', () => {
  const { directions } = readJson('_sources.json');
  assert.deepEqual(Object.keys(directions), [FIXTURE_PROJECT], 'keyed by the placeholder lens-eval re-keys');
  const { lenses } = directions[FIXTURE_PROJECT];
  assert.deepEqual(Object.keys(lenses).sort(), [...LENSES].sort());
  for (const lens of LENSES) {
    const d = checkDirection(lens, lenses[lens]);
    assert.deepEqual(d, lenses[lens], `${lens}: already normalised, within Forge's caps`);
    assert.ok(d?.focus?.length && d?.exclude?.length, `${lens}: focus and exclude both set`);
  }
  // doc-drift's direction names the Confluence spaces its connected priority-1 finding lives in.
  const sources = readJson('_sources.json');
  for (const e of expectedFor(expected, 'doc-drift').filter((i) => i.priority === 1)) {
    for (const ref of String(e.why).match(/\bPAGE-\d+\b/g) ?? []) {
      const page = sources.pages.find((/** @type {{ref: string}} */ p) => p.ref === ref);
      assert.ok(lenses['doc-drift'].spaces.includes(page.space), `${e.id}: ${ref}'s space ${page.space} is a direction space`);
    }
  }
});

test('fixture: the scanned files read like one product (no evaluation words outside the _ files)', () => {
  /** @param {string} dir @returns {string[]} */
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (dir === FIXTURE && e.name.startsWith('_')) return [];
    const abs = join(dir, e.name);
    return e.isDirectory() ? walk(abs) : [abs];
  });
  for (const f of walk(FIXTURE)) {
    const hit = readFileSync(f, 'utf8').match(/\b(decoy|seeded|fixture|expected\.json|lens)\b/i);
    assert.equal(hit, null, `${f} says "${hit?.[0]}"`);
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
  const pkg = readJson('package.json');
  const audit = readJson('_auditor/npm-audit.json');
  assert.equal(audit.auditReportVersion, 2);
  assert.equal(lock.packages['node_modules/lodash'].version, pkg.dependencies.lodash);
  assert.ok(audit.vulnerabilities.lodash.via.some((/** @type {{severity: string}} */ v) => v.severity === 'high'));
  // the dev-only advisory: a devDependency the lockfile marks dev and the published files leave out
  assert.equal(lock.packages['node_modules/minimist'].version, pkg.devDependencies.minimist);
  assert.equal(lock.packages['node_modules/minimist'].dev, true);
  assert.equal(pkg.dependencies.minimist, undefined);
  assert.ok(!pkg.files.some((/** @type {string} */ f) => f.startsWith('scripts')), 'the seed script is not published');
  for (const [name, v] of Object.entries(audit.vulnerabilities)) {
    for (const node of /** @type {{nodes: string[]}} */ (v).nodes) assert.ok(lock.packages[node], `${name}: ${node} is in the lockfile`);
  }
  // what `dowser deps` caches from this audit: one dep ref per package version
  const refs = npmFindings(audit, lock).map((f) => `${f.manifest}#${f.package}@${f.version}`);
  assert.deepEqual([...new Set(refs)].sort(), ['package-lock.json#lodash@4.17.15', 'package-lock.json#minimist@1.2.5']);
});
