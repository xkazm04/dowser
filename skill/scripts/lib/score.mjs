// @ts-check
// Lens quality scoring (lens-quality-plan WP5): compares the candidates one lens emitted on the seeded fixture
// (`tests/fixtures/lens-fixture/`) with that fixture's `_expected.json`. Seeded items are findings a correct pack
// should propose; decoys look like findings but are not, and must not be proposed. Pure: no I/O.
//
// Matching. Anchors on both sides are normalised by fingerprint.normalizeAnchor (line suffixes stripped). An
// emitted anchor lands on an expected anchor `exact` when the paths are equal and the symbols agree (or the
// expected anchor names no symbol), and `path` when only the paths are equal - a model names symbols its own
// way. Each expected item has one primary `anchor` and optional `also` alternatives (the other files a correct
// card may anchor on). Each emission is assigned to the ONE expected item (seeded or decoy) it lands on most
// strongly - exact over path, then primary over `also`, then the sum over its anchors, then file order - so a card
// that also cites a shared file (a config module) still counts once, for the finding it is about. Kind is
// reported, not required.
//
// Direction. A seeded item marked `excluded_by_direction` is a real finding the team's direction (the fixture's
// `_sources.json` `directions` seed) rules out: proposing it is a direction violation, counted against precision
// like a decoy hit. It is out of scope, so it is not counted in `seeded`. One marked `focus_by_direction` is the
// one the direction's focus should pull into the budget.
//
// Numbers. recall = found / seeded; recall_at_budget = found / min(seeded, budget), so a lens that proposes at most
// `budget` cards can reach 1 on a fixture that seeds more findings than that - it is judged on choosing well;
// priority1_found / priority1_total counts the seeded items of `priority: 1` (the ones a good choice never leaves
// out). precision = matched / emitted, where an emission assigned to no expected item counts against precision as
// unverified and is listed under `unmatched` for the hand check; one assigned to a decoy is a decoy hit, one
// assigned to an excluded item a direction violation. Absent, never 0: `recall` when nothing is seeded,
// `recall_at_budget` also when no budget was given, `priority1_*` and `focus_*` when the fixture has none,
// `precision` when nothing was emitted.
import { artifactsProblem } from './model.mjs';
import { normalizeAnchor } from './fingerprint.mjs';

/**
 * @typedef {{lens: string, id: string, anchor: string, also?: string[], kind?: string, hypothesis?: string,
 *   must?: true, decoy?: true, priority?: 1 | 2 | 3, excluded_by_direction?: true, focus_by_direction?: true,
 *   why: string}} Expected
 * @typedef {{lens: string, kind?: string, title?: string, anchors?: string[], evidence?: {ref: string}[],
 *   artifacts?: unknown}} Emitted
 * @typedef {{
 *   lens: string, seeded: number, found: number, recall?: number, budget?: number, recall_at_budget?: number,
 *   priority1_found?: number, priority1_total?: number, focus_found?: number, focus_total?: number,
 *   found_exact: number, kind_matched: number,
 *   emitted: number, matched: number, precision?: number, decoy_hits: number, direction_violations: number,
 *   artifacts_total: number, artifacts_valid: number, verify_dropped?: number,
 *   missed?: string[], path_only?: string[], decoys?: string[], violations?: string[], unmatched?: string[],
 *   artifact_problems?: string[]
 * }} Score
 */

/** Rounded to 3 decimals, so a score line diffs cleanly between runs. @param {number} n @param {number} d */
const ratio = (n, d) => Math.round((n / d) * 1000) / 1000;

/** @param {string} a @returns {{path: string, symbol: string}} */
function split(a) {
  const n = normalizeAnchor(a);
  const h = n.indexOf('#');
  return h >= 0 ? { path: n.slice(0, h), symbol: n.slice(h + 1).toLowerCase() } : { path: n, symbol: '' };
}

/**
 * How one emitted anchor lands on one expected anchor: 2 exact, 1 same path only, 0 elsewhere.
 * @param {{path: string, symbol: string}} want
 * @param {{path: string, symbol: string}} got
 */
const level = (want, got) => (got.path !== want.path ? 0 : !want.symbol || want.symbol === got.symbol ? 2 : 1);

/**
 * How strongly `anchors` land on `item`, as a sortable tuple [primary level, best also level, total], or
 * undefined when no anchor lands on it at all.
 * @param {Expected} item
 * @param {string[]} anchors
 * @returns {{primary: number, also: number, total: number} | undefined}
 */
export function anchorStrength(item, anchors) {
  const got = anchors.map(split);
  const primary = split(item.anchor);
  const alts = (item.also ?? []).map(split);
  const best = (/** @type {{path: string, symbol: string}} */ w) => Math.max(0, ...got.map((g) => level(w, g)));
  const p = best(primary);
  const a = Math.max(0, ...alts.map(best));
  const total = p * 2 + alts.reduce((s, w) => s + best(w), 0);
  return p || a ? { primary: p, also: a, total } : undefined;
}

/**
 * The expected items of one lens, from `_expected.json` (its `items` array, or the array itself).
 * @param {unknown} expected
 * @param {string} lens
 * @returns {Expected[]}
 */
export function expectedFor(expected, lens) {
  const list = Array.isArray(expected) ? expected
    : expected && typeof expected === 'object' && Array.isArray(/** @type {any} */ (expected).items) ? /** @type {any} */ (expected).items : [];
  return /** @type {Expected[]} */ (list).filter((e) => e && e.lens === lens);
}

/** Lexicographic comparison of two equal-length number tuples. @param {number[]} a @param {number[]} b */
const cmp = (a, b) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
};

/**
 * The expected item an emission is about, or undefined. Exact beats path: an emission that only path-matches a
 * finding's primary anchor is still about that finding unless another item matches it exactly.
 * @param {Expected[]} items
 * @param {string[]} anchors
 * @returns {{item: Expected, exact: boolean} | undefined}
 */
export function assign(items, anchors) {
  /** @type {{item: Expected, exact: boolean, key: number[]} | undefined} */
  let best;
  for (const item of items) {
    const s = anchorStrength(item, anchors);
    if (!s) continue;
    const exact = s.primary === 2 || s.also === 2;
    const key = [exact ? 1 : 0, s.primary, s.also, s.total];
    if (!best || cmp(key, best.key) > 0) best = { item, exact, key };
  }
  return best && { item: best.item, exact: best.exact };
}

/**
 * Scores one lens's emission against the fixture's expectations.
 * @param {{expected: unknown, emitted: Emitted[], lens: string, verify_dropped?: number, budget?: number}} o
 *   `emitted` is what reached the person (verify survivors); `verify_dropped` the count verify removed, when
 *   measured; `budget` the pack's card budget, when known.
 * @returns {Score}
 */
export function scoreLens({ expected, emitted, lens, verify_dropped, budget }) {
  const items = expectedFor(expected, lens);
  const seeded = items.filter((e) => !e.decoy && !e.excluded_by_direction);
  const mine = emitted.filter((c) => c.lens === lens);

  /** @type {Map<string, {exact: boolean, kind: boolean}>} */
  const hits = new Map();
  /** @type {Set<string>} */
  const decoyHit = new Set();
  /** @type {Set<string>} */
  const violated = new Set();
  /** @type {string[]} */
  const unmatched = [];
  let matched = 0;
  let decoyHits = 0;
  let violations = 0;
  let artifactsTotal = 0;
  let artifactsValid = 0;
  /** @type {string[]} */
  const artifactProblems = [];

  for (const c of mine) {
    const anchors = Array.isArray(c.anchors) ? c.anchors : [];
    const a = assign(items, anchors);
    if (!a) unmatched.push(c.title ?? anchors.join(', '));
    else if (a.item.decoy) { decoyHits++; decoyHit.add(a.item.id); } else if (a.item.excluded_by_direction) { violations++; violated.add(a.item.id); } else {
      matched++;
      const prev = hits.get(a.item.id) ?? { exact: false, kind: false };
      hits.set(a.item.id, { exact: prev.exact || a.exact, kind: prev.kind || (a.item.kind !== undefined && c.kind === a.item.kind) });
    }
    // Artifacts: a list-level problem (not an array, over the per-card cap) voids every artifact on the card;
    // otherwise each artifact is judged alone against the card's own evidence refs.
    if (c.artifacts !== undefined) {
      const list = Array.isArray(c.artifacts) ? c.artifacts : [c.artifacts];
      const refs = (c.evidence ?? []).map((e) => e.ref);
      artifactsTotal += list.length;
      const whole = artifactsProblem(list, refs);
      if (whole && !whole.startsWith('artifacts[')) { artifactProblems.push(`${c.title ?? '?'}: ${whole}`); continue; }
      list.forEach((art, i) => {
        const p = artifactsProblem([art], refs);
        if (p) artifactProblems.push(`${c.title ?? '?'}: ${p.replace(/^artifacts\[0\]/, `artifacts[${i}]`)}`);
        else artifactsValid++;
      });
    }
  }

  /** @type {Score} */
  const out = {
    lens,
    seeded: seeded.length,
    found: hits.size,
    found_exact: [...hits.values()].filter((h) => h.exact).length,
    kind_matched: [...hits.values()].filter((h) => h.kind).length,
    emitted: mine.length,
    matched,
    decoy_hits: decoyHits,
    direction_violations: violations,
    artifacts_total: artifactsTotal,
    artifacts_valid: artifactsValid,
  };
  if (seeded.length) out.recall = ratio(hits.size, seeded.length);
  if (budget !== undefined) out.budget = budget;
  if (budget !== undefined && budget > 0 && seeded.length) out.recall_at_budget = ratio(hits.size, Math.min(seeded.length, budget));
  const p1 = seeded.filter((s) => s.priority === 1);
  if (p1.length) { out.priority1_found = p1.filter((s) => hits.has(s.id)).length; out.priority1_total = p1.length; }
  const focus = seeded.filter((s) => s.focus_by_direction);
  if (focus.length) { out.focus_found = focus.filter((s) => hits.has(s.id)).length; out.focus_total = focus.length; }
  if (mine.length) out.precision = ratio(matched, mine.length);
  if (verify_dropped !== undefined) out.verify_dropped = verify_dropped;
  const missed = seeded.filter((s) => !hits.has(s.id)).map((s) => s.id);
  const pathOnly = [...hits.entries()].filter(([, h]) => !h.exact).map(([id]) => id);
  if (missed.length) out.missed = missed;
  if (pathOnly.length) out.path_only = pathOnly;
  if (decoyHit.size) out.decoys = [...decoyHit];
  if (violated.size) out.violations = [...violated];
  if (unmatched.length) out.unmatched = unmatched;
  if (artifactProblems.length) out.artifact_problems = artifactProblems;
  return out;
}
