// @ts-check
// Lens-pack wording that the code contradicts (DW-56, DW-57, DW-58). Each test keys on intent, not on exact copy:
// the security pack's `dep` ref names a manifest or a lockfile, as `deps` writes it and cards.md says; doc drift's
// git step reads the whole 120-day window H3 states; and an auditor skipped for "nothing of its kind here" is not a
// gap, while one that leaves a manifest unaudited still is, with the skip reason as the contract both docs key on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SKILL = fileURLToPath(new URL('../../', import.meta.url));
/** @param {string} rel */
const read = (rel) => readFileSync(SKILL + rel, 'utf8').replace(/\r\n/g, '\n');

/**
 * The text of numbered step `n` of a pack's `## Gather` section, up to the next numbered step or heading.
 * @param {string} pack
 * @param {number} n
 */
function gatherStep(pack, n) {
  const gather = pack.split(/^## Gather\s*$/m)[1];
  assert.ok(gather, 'the pack has a ## Gather section');
  const body = gather.split(/^## /m)[0];
  const m = body.match(new RegExp(`^${n}\\. [\\s\\S]*?(?=^\\d+\\. |(?![\\s\\S]))`, 'm'));
  assert.ok(m, `gather step ${n} exists`);
  return m[0];
}

/** Phrases that mark an auditor skipped because the repo has nothing of its ecosystem (DW-56). */
const NOTHING_TO_AUDIT = /`no `|`no \.\.\.`|`no …`|starts? with `?no\b|begins? with `?no\b|nothing (?:to audit|of its (?:kind|ecosystem)|(?:is )?left unaudited)|leaves? nothing unaudited|no (?:files|manifests?|lockfiles?) (?:of|for) (?:its|that|the) (?:ecosystem|kind|tool)/i;

// ------------------------------------------------------------------------------------------------ DW-57

test('DW-57: security-cra gather step 2 says a dep ref names a manifest or a lockfile, as cards.md does', () => {
  const step = gatherStep(read('lenses/security-cra.md'), 2);
  assert.doesNotMatch(step, /`<lockfile path>#/, 'the ref is not described as a lockfile path only (pip-audit refs name requirements files or pyproject.toml)');
  const refSentence = step.split(/(?<=\.)\s+(?=[A-Z])/).find((s) => /#<package>/.test(s));
  assert.ok(refSentence, 'step 2 still documents the ref shape `...#<package>@<version>`');
  assert.match(refSentence, /manifest/i, 'the ref shape names the manifest case');
  assert.match(read('references/cards.md'), /<manifest or lockfile>#<package>@<version>/, 'cards.md is the shape the pack should agree with');
});

test('DW-57: security-cra gather step 3 does not assume the path before `#` is always a lockfile', () => {
  const step = gatherStep(read('lenses/security-cra.md'), 3);
  assert.doesNotMatch(step, /in the lockfile the ref names|`<lockfile>`, the path before `#`/, 'the path before `#` is not labelled a lockfile only');
  assert.match(step, /pyproject|requirements\*\.txt|requirements file|manifest (?:the ref|before)|ref names (?:a|the) manifest|ref['’]s (?:path|file)/i,
    'step 3 covers a ref whose path is a Python manifest (requirements file or pyproject.toml)');
});

// ------------------------------------------------------------------------------------------------ DW-58

test('DW-58: doc-drift gather step 4 reads the whole 120-day window, or states its cap', () => {
  const step = gatherStep(read('lenses/doc-drift.md'), 4);
  assert.match(step, /--since=120\.days/, 'step 4 still reads the 120-day window H3 names');
  const capped = /git log --since=120\.days[^\n`]*\|\s*head\s+-n?\s*\d+/.test(step);
  if (capped) {
    assert.match(step, /\b(?:newest|latest|most recent|first) \d+\b|\bcap(?:ped|s)?\b|leaves? out|older commits|not the whole window/i,
      'a head cut on the 120-day log is stated as part of the window (what it keeps and leaves out)');
  }
  assert.doesNotMatch(step, /--since=120\.days[^\n`]*\| head -60`/, 'no bare `| head -60` on the 120-day commit log');
});

// ------------------------------------------------------------------------------------------------ DW-56

test('DW-56 (a): security-cra step 2 no longer makes every skipped auditor a partial lens', () => {
  const step = gatherStep(read('lenses/security-cra.md'), 2);
  assert.doesNotMatch(step, /every `?skipped`? auditor makes the lens/i, 'not every skip is a gap');
  assert.match(step, /partial/, 'a skip that leaves a manifest unaudited still makes the lens partial');
  assert.match(step, NOTHING_TO_AUDIT, 'step 2 names the nothing-to-audit skip (no files of its ecosystem) as not a gap');
});

test('DW-56 (b): SKILL.md dependencies paragraph makes the same distinction', () => {
  const skill = read('SKILL.md');
  const start = skill.indexOf('**Dependencies (security-cra).**');
  assert.ok(start >= 0, 'SKILL.md has the dependencies paragraph');
  const rest = skill.slice(start);
  const end = rest.search(/\n\d+\. \*\*/);
  const para = end > 0 ? rest.slice(0, end) : rest;
  assert.doesNotMatch(para, /A skipped or\s+partial auditor is a gap/, 'not every skipped auditor is a gap');
  assert.match(para, /partial/, 'a skip that leaves a manifest unaudited still makes the lens partial');
  assert.match(para, NOTHING_TO_AUDIT, 'the paragraph names the nothing-to-audit skip as not a gap');
});

test('DW-56 (c): deps.mjs skip reasons: "nothing of its kind" starts with "no ", a gap never does', () => {
  const src = read('scripts/lib/deps.mjs');
  /** @type {string[]} */
  const literals = [];
  // reason: '<literal>' inside a skipped report, and the literal arms of `const reason = cond ? '<a>' : '<b>'`
  for (const m of src.matchAll(/state: 'skipped', reason: '([^']*)'/g)) literals.push(m[1]);
  for (const m of src.matchAll(/const reason = [^\n]*/g)) for (const s of m[0].matchAll(/[?:]\s*'([^']*)'/g)) literals.push(s[1]);
  const nothing = ['no requirements*.txt or pyproject.toml', 'no lockfile osv-scanner reads', 'no package.json or package-lock.json'];
  for (const r of nothing) {
    assert.ok(literals.includes(r) || literals.some((l) => l.startsWith('no ') && l.includes(r.split(' ')[1])), `a nothing-to-audit reason like "${r}" exists`);
  }
  const gaps = literals.filter((l) => !l.startsWith('no '));
  for (const g of ['not installed', 'package.json without package-lock.json']) {
    assert.ok(gaps.some((l) => l.startsWith(g)), `the gap reason "${g}..." exists and does not start with "no "`);
  }
  for (const l of literals) {
    const isNothing = /^no /.test(l);
    const leavesManifest = /without|not installed|failed|not JSON|timed out/i.test(l);
    assert.ok(!(isNothing && leavesManifest), `"${l}" starts with "no " but names a manifest left unaudited`);
  }
});
