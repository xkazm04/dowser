// @ts-check
// Skill core hardening from Dowser's first self-scan (run r-20261030165443-0385): the judge's predicted verdict
// survives a re-propose and a missing one is flagged; free run slots go to the best reserve cards of any lens; trust
// lists start-level slices that have cards; verify counts per lens, reports the line a quote was found on and flags
// a drift; `similar` ignores whole-file anchors across lenses and generic topic tokens; the CLI prints `abandoned`;
// and the bus factor is measured from git at verify (one 90-day window, the same as the areas map).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MACHINE_DECIDER } from '../lib/model.mjs';
import { getProposal, move, openStore, propose, runStart } from '../lib/store.mjs';
import { allocateRun } from '../lib/budget.mjs';
import { pretriageRun, trustReport } from '../lib/trust.mjs';
import { findQuote, verifyRun } from '../lib/verify.mjs';
import { similar } from '../lib/memory.mjs';
import { KINDS, candidate, gitRepo, removeDir, tempDir, writeFiles } from './_fixture.mjs';

const CLI = fileURLToPath(new URL('../dowser.mjs', import.meta.url));
/** @type {string[]} */ const dirs = [];
after(() => { for (const d of dirs) removeDir(d); });

/** A fresh store and a running run. */
function fresh(/** @type {{headSha?: string}} */ o = {}) {
  const dir = tempDir('core-hardening');
  dirs.push(dir);
  const db = openStore(join(dir, 'dowser.db'));
  const run = String(runStart(db, { mode: 'full', harness: 'claude', model: 'm', ...o }).id);
  /** @param {Record<string, unknown>} over */
  const prop = (over) => propose(db, run, candidate(over), { kinds: KINDS });
  /** @param {Record<string, unknown>} over @returns {string} */
  const verified = (over) => {
    const r = prop(over);
    assert.ok(r.fp, r.result);
    move(db, r.fp, 'verified', { by: 'skill:dowser-verify' });
    return r.fp;
  };
  return { db, run, prop, verified, done: () => db.close() };
}

// ------------------------------------------------------------------ 1. the judge's predicted verdict

test('1. a re-proposed candidate line without a verdict keeps the judge\'s earlier verdict, never defer', () => {
  const s = fresh();
  try {
    const first = s.prop({ lens: 'doc-drift', kind: 'stale', topic: 'setup guide', anchors: ['docs/setup.md'], predicted_verdict: 'accept', predicted_why: 'a broken first step' });
    assert.equal(first.result, 'created');
    // the fix-the-quote re-propose (SKILL section 6 step 2) carries no verdict
    const again = s.prop({ lens: 'doc-drift', kind: 'stale', topic: 'setup guide', anchors: ['docs/setup.md'], evidence: [{ type: 'doc', ref: 'docs/setup.md:3', quote: 'npm start' }] });
    assert.equal(again.fp, first.fp);
    const card = /** @type {any} */ (getProposal(s.db, String(first.fp)));
    assert.deepEqual([card.predicted_verdict, card.predicted_why, card.predicted_by], ['accept', 'a broken first step', 'dowser-doc-drift@1.0.0:m']);
    assert.equal(again.warning, 'no-predicted-verdict', 'the line still says the worker left the verdict out');
  } finally { s.done(); }
});

test('1. a line without predicted_verdict is flagged; one with it is not', () => {
  const s = fresh();
  try {
    assert.equal(s.prop({ topic: 'no verdict' }).warning, 'no-predicted-verdict');
    assert.equal('warning' in s.prop({ topic: 'has verdict', predicted_verdict: 'defer' }), false);
  } finally { s.done(); }
});

test('1. fresh store: a judge accept on a technical (L1 start) slice is stored as accept and pre-triaged', () => {
  const s = fresh();
  try {
    const fp = s.verified({ lens: 'doc-drift', kind: 'stale', topic: 'renamed start command', anchors: ['docs/setup.md'], impact: 6, impact_why: 'x', predicted_verdict: 'accept' });
    assert.equal(/** @type {any} */ (getProposal(s.db, fp)).predicted_verdict, 'accept');
    allocateRun(s.db, s.run);
    const out = pretriageRun(s.db, s.run);
    assert.deepEqual(out.pretriaged.map((/** @type {any} */ p) => [p.fp, p.level]), [[fp, 1]]);
    assert.equal(/** @type {any} */ (getProposal(s.db, fp)).pretriaged_by, MACHINE_DECIDER);
  } finally { s.done(); }
});

// ------------------------------------------------------------------ 2. free run slots filled by score

test('2. the self-scan shape (doc-drift 9, opportunity 6, ux 5, security 2; cap 4/16) ranks 16: free slots go to the best reserve of any lens', () => {
  const s = fresh();
  try {
    /** @type {[string, number, string][]} lens, score, confidence - the scores of run r-20261030165443-0385 */
    const shape = [
      ['doc-drift', 48.7, 'high'], ['doc-drift', 36.1, 'high'], ['doc-drift', 36.1, 'high'], ['doc-drift', 36.1, 'high'],
      ['doc-drift', 36.1, 'high'], ['doc-drift', 28.5, 'medium'], ['doc-drift', 27.4, 'high'], ['doc-drift', 18.1, 'high'], ['doc-drift', 14.3, 'medium'],
      ['opportunity', 8.5, 'low'], ['opportunity', 8.1, 'low'], ['opportunity', 8.1, 'low'], ['opportunity', 7.1, 'low'], ['opportunity', 5.1, 'low'], ['opportunity', 4.5, 'low'],
      ['security-cra', 22.5, 'medium'], ['security-cra', 21.6, 'medium'],
      ['ux-friction', 37.8, 'medium'], ['ux-friction', 28.5, 'medium'], ['ux-friction', 21.6, 'medium'], ['ux-friction', 21.4, 'medium'], ['ux-friction', 21.4, 'medium'],
    ];
    const kind = /** @type {Record<string, string>} */ ({ 'doc-drift': 'stale', opportunity: 'gap', 'ux-friction': 'dead-end', 'security-cra': 'secret' });
    const fps = shape.map(([lens, score, confidence], i) => {
      const fp = s.verified({ lens, kind: kind[lens], topic: `card ${i}`, anchors: [`src/c${i}.js`], title: `${lens} ${score} #${i}`, confidence });
      s.db.prepare('UPDATE proposals SET score = ? WHERE fp = ?').run(score, fp);
      return fp;
    });
    const out = allocateRun(s.db, s.run);
    assert.equal(out.ranked, 16);
    assert.deepEqual(Object.fromEntries(Object.entries(out.per_lens).map(([l, v]) => [l, [v.ranked, v.reserve]])),
      { opportunity: [4, 2], 'ux-friction': [4, 1], 'doc-drift': [6, 3], 'security-cra': [2, 0] });
    const band = (/** @type {number} */ i) => /** @type {any} */ (getProposal(s.db, fps[i])).band;
    assert.equal(band(4), 'ranked', 'the 5th doc-drift card (36.1) took a free slot');
    assert.equal(band(5), 'ranked', 'the 28.5 doc-drift card took the 16th slot over the 21.4 ux card');
    assert.equal([band(20), band(21)].filter((b) => b === 'reserve').length, 1, 'one of the two 21.4 ux cards (tie on fp) stays in reserve');
    assert.equal(band(6), 'reserve', 'the 27.4 doc-drift card is the 17th');
  } finally { s.done(); }
});

test('2. a free slot between equal scores: confidence, then evidence count, then fp', () => {
  const s = fresh();
  try {
    const mvp = s.verified({ topic: 'mvp', anchors: ['src/m.js'] });
    const low = s.verified({ topic: 'low', anchors: ['src/l.js'], confidence: 'low' });
    const high1 = s.verified({ topic: 'high one', anchors: ['src/h1.js'] });
    const high2 = s.verified({ topic: 'high two', anchors: ['src/h2.js'], evidence: [
      { type: 'code', ref: 'src/auth.js:2', quote: 'return check(user.password);' }, { type: 'code', ref: 'src/auth.js:1', quote: 'export function login(user) {' }] });
    for (const [fp, sc] of [[mvp, 50], [low, 10], [high1, 10], [high2, 10]]) s.db.prepare('UPDATE proposals SET score = ? WHERE fp = ?').run(sc, fp);
    allocateRun(s.db, s.run, { perLens: 1, perRun: 3 });
    const band = (/** @type {string} */ fp) => /** @type {any} */ (getProposal(s.db, fp)).band;
    assert.deepEqual([band(mvp), band(high2), band(high1), band(low)], ['ranked', 'ranked', 'ranked', 'reserve']);
  } finally { s.done(); }
});

// ------------------------------------------------------------------ 3. trust lists start-level slices with cards

test('3. trust lists a slice that has cards but no history, at its start level - the same level pretriage uses', () => {
  const s = fresh();
  try {
    s.verified({ lens: 'doc-drift', kind: 'stale', topic: 'one doc', anchors: ['README.md'] });
    s.verified({ lens: 'opportunity', kind: 'gap', topic: 'one idea', anchors: ['src/i.js'], effort: { size: 'M', days_low: 2, days_high: 4, basis: ['x'] } });
    const r = trustReport(s.db);
    assert.deepEqual(r.slices.map((x) => [x.slice, x.level, x.start, x.n]),
      [['product|opportunity|-|M', 0, 0, 0], ['technical|doc-drift|-|S', 1, 1, 0]]);
    allocateRun(s.db, s.run);
    const pre = pretriageRun(s.db, s.run);
    for (const p of [...pre.pretriaged, ...pre.for_person]) {
      assert.equal(r.slices.find((x) => x.slice === p.slice)?.level, p.level, `trust and pretriage agree on ${p.slice}`);
    }
  } finally { s.done(); }
});

// ------------------------------------------------------------------ 4-5. verify per lens, found line, drift

test('4. verify prints per-lens counts {emitted, verified, dropped}', () => {
  const repo = tempDir('ch-verify');
  dirs.push(repo);
  writeFiles(repo, { 'src/auth.js': 'export function login(user) {\n  return check(user.password);\n}\n' });
  const s = fresh();
  try {
    s.prop({ topic: 'ok' });
    s.prop({ topic: 'gone', evidence: [{ type: 'code', ref: 'src/auth.js:2', quote: 'md5(x)' }] });
    s.prop({ lens: 'doc-drift', kind: 'stale', topic: 'doc ok', anchors: ['src/auth.js'] });
    const out = verifyRun(s.db, repo, s.run);
    assert.deepEqual(out.per_lens, { 'security-cra': { emitted: 2, verified: 1, dropped: 1 }, 'doc-drift': { emitted: 1, verified: 1, dropped: 0 } });
  } finally { s.done(); }
});

test('5. findQuote reports the line the quote was found on, the claimed line, and a drift over 3 lines', () => {
  const repo = tempDir('ch-quote');
  dirs.push(repo);
  const lines = Array.from({ length: 100 }, (_, i) => `// line ${i + 1}`);
  lines[79] = 'const   token =';
  lines[80] = '   readSecret();';
  writeFiles(repo, { 'src/b.js': lines.join('\n') });
  const q = 'const token = readSecret();';
  assert.deepEqual(findQuote(repo, 'src/b.js:80', q), { found: 'near-line', line: 80 });
  assert.deepEqual(findQuote(repo, 'src/b.js:82', q), { found: 'near-line', line: 80, claimed_line: 82 }, 'a 2-line drift is reported, not flagged');
  assert.deepEqual(findQuote(repo, 'src/b.js:90', q), { found: 'near-line', line: 80, claimed_line: 90, drift: 10 });
  assert.deepEqual(findQuote(repo, 'src/b.js:10', q), { found: 'in-file', line: 80, claimed_line: 10, drift: 70 });
  assert.deepEqual(findQuote(repo, 'src/b.js', q), { found: 'in-file', line: 80 }, 'no hint: the found line, nothing claimed');
  assert.deepEqual(findQuote(repo, 'src/b.js:7', '// line 7'), { found: 'near-line', line: 7 }, 'the occurrence nearest the hint wins (not // line 70)');
});

// ------------------------------------------------------------------ 6. similar ignores noise

test('6. similar: whole-file anchors and generic topic tokens are not cross-lens or same-lens matches on their own (self-scan noise pairs)', () => {
  const s = fresh();
  try {
    // 1663ff559cd03772 / 0b3072ca91f64fcc: a doc-drift and an opportunity card sharing only skill/scripts/dowser.mjs
    const help = s.verified({ lens: 'doc-drift', kind: 'stale', topic: 'cli-help-run-start-abandoned-docs', anchors: ['skill/scripts/dowser.mjs', 'skill/SKILL.md'] });
    const forks = s.verified({ lens: 'opportunity', kind: 'gap', topic: 'custom-lens-forks', anchors: ['skill/scripts/dowser.mjs'] });
    // 163f1a7658426de9 / e84f30ffe051afde: same lens, sharing only `lens` and the `-docs` suffix
    const ex = s.verified({ lens: 'doc-drift', kind: 'stale', topic: 'lens-pack-examples-impact-docs', anchors: ['skill/lenses/opportunity.md'] });
    const ev = s.verified({ lens: 'doc-drift', kind: 'stale', topic: 'lens-eval-recall-at-budget-docs', anchors: ['docs/evals/x.md'] });
    // a real cross-lens pair: the same symbol
    const sym1 = s.verified({ lens: 'security-cra', topic: 'login plaintext', anchors: ['src/auth.js#login'] });
    const sym2 = s.verified({ lens: 'ux-friction', kind: 'dead-end', topic: 'login error copy', anchors: ['src/auth.js#login'] });
    const fps = (/** @type {string} */ fp) => similar(s.db, fp).similar.map((/** @type {any} */ h) => h.fp);
    assert.equal(fps(help).includes(forks), false, 'a shared whole-file anchor across lenses is noise');
    assert.equal(fps(ex).includes(ev), false, 'lens + docs are generic tokens');
    assert.deepEqual(fps(sym1), [sym2], 'a shared symbol anchor across lenses is a hit');
    // same lens: a whole-file anchor still counts, ranked below a symbol anchor
    const a = s.verified({ lens: 'doc-drift', kind: 'stale', topic: 'alpha', anchors: ['docs/data-model.md', 'docs/x.md#verify'] });
    const fileOnly = s.verified({ lens: 'doc-drift', kind: 'stale', topic: 'beta', anchors: ['docs/data-model.md'] });
    const symbol = s.verified({ lens: 'doc-drift', kind: 'stale', topic: 'gamma', anchors: ['docs/x.md#verify'] });
    assert.deepEqual(fps(a), [symbol, fileOnly]);
  } finally { s.done(); }
});

// ------------------------------------------------------------------ 7. CLI help and run start's abandoned

test('7. CLI: run start prints abandoned; help names abandoned and ref-not-ingested', () => {
  const home = tempDir('ch-home');
  const repo = tempDir('ch-repo');
  dirs.push(home, repo);
  gitRepo(repo, { 'a.txt': 'a\n' });
  const cli = (/** @type {string[]} */ ...args) => spawnSync(process.execPath, [CLI, ...args, '--repo', repo], { encoding: 'utf8', env: { ...process.env, DOWSER_HOME: home } });
  const first = JSON.parse(cli('run', 'start', '--mode', 'full').stdout);
  const db = openStore(JSON.parse(cli('init').stdout).db);
  db.prepare('UPDATE runs SET started_at = ? WHERE id = ?').run(new Date(Date.now() - 25 * 3_600_000).toISOString(), first.run_id);
  db.close();
  const next = JSON.parse(cli('run', 'start', '--mode', 'full').stdout);
  assert.deepEqual(next.abandoned, [first.run_id]);
  const help = cli('--help').stdout;
  assert.match(help, /run start[\s\S]*abandoned[\s\S]*run finish/);
  assert.match(help, /verify[\s\S]*ref-not-ingested[\s\S]*pretriage/);
});

// ------------------------------------------------------------------ card 0abc6bdd204b318b: bus factor from git

test('0abc6bdd204b318b: verify measures the bus factor over the anchor paths in the 90 days before head; it wins over the card\'s', () => {
  const repo = tempDir('ch-bus');
  dirs.push(repo);
  const old = new Date(Date.now() - 200 * 86400000).toISOString();
  gitRepo(repo, { 'src/auth.js': 'export function login(user) {\n  return check(user.password);\n}\n', 'src/other.js': 'x\n' });
  const git = (/** @type {Record<string, string>} */ env, /** @type {string[]} */ ...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore', env: { ...process.env, ...env } });
  // rewrite the first commit as 200 days old, by a third author: outside the window
  git({ GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old }, '-c', 'user.email=old@example.com', 'commit', '-q', '--amend', '--reset-author', '--no-edit');
  writeFiles(repo, { 'src/auth.js': 'export function login(user) {\n  return check(user.password);\n}\n// a\n' });
  git({}, '-c', 'user.email=ann@example.com', 'commit', '-q', '-am', 'a');
  writeFiles(repo, { 'src/auth.js': 'export function login(user) {\n  return check(user.password);\n}\n// a\n// b\n' });
  git({}, '-c', 'user.email=bob@example.com', 'commit', '-q', '-am', 'b');
  writeFiles(repo, { 'src/other.js': 'y\n' });
  git({}, '-c', 'user.email=cy@example.com', 'commit', '-q', '-am', 'c');
  const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const s = fresh({ headSha: head });
  try {
    const claimed = s.prop({ topic: 'claimed one', anchors: ['src/auth.js#login'], delivery_risk: { blast: 'medium', bus_factor: 1 } }).fp;
    const none = s.prop({ topic: 'no claim', anchors: ['src/auth.js'], delivery_risk: { blast: 'low' } }).fp;
    const quiet = s.prop({ topic: 'quiet path', anchors: ['src/never.js'], delivery_risk: { blast: 'low', bus_factor: 3 } }).fp;
    const noRisk = s.prop({ topic: 'no risk', anchors: ['src/auth.js'] }).fp;
    const out = verifyRun(s.db, repo, s.run);
    const card = (/** @type {any} */ fp) => /** @type {any} */ (getProposal(s.db, fp));
    assert.deepEqual(card(claimed).delivery_risk, { blast: 'medium', bus_factor: 2 }, 'ann and bob in the window; old@ is outside it');
    assert.deepEqual(card(none).delivery_risk, { blast: 'low', bus_factor: 2 });
    assert.deepEqual(card(quiet).delivery_risk, { blast: 'low', bus_factor: 3 }, 'nothing measured: the card\'s value stays');
    assert.equal(card(noRisk).delivery_risk, undefined, 'no delivery_risk: no blast is invented');
    const res = (/** @type {any} */ fp) => out.results.find((r) => r.fp === fp)?.bus_factor;
    assert.deepEqual(res(claimed), { value: 2, source: 'git-90d', claimed: 1 });
    assert.deepEqual(res(none), { value: 2, source: 'git-90d' });
    assert.deepEqual(res(quiet), { value: 3, source: 'card' });
    assert.equal(res(noRisk), undefined);
  } finally { s.done(); }
});
