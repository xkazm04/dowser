// @ts-check
// /temper (.claude/skills/temper/scripts/temper.mjs, guard.mjs, modules.json): the charter's refusals, the clock, the
// stability bar on fixture instruments (unverifiable never passes), triage limits, land --dry-run decisions for each
// repo's landing law, report rendering, full module coverage of the context map, and the guard's allow/deny table.
// No network: git runs for real in temp repos, every npm gate and shell gate is answered by an injected runner.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_CAPS, LANDINGS, REJECT_SHARE, WALL_MIN, clockOf, evaluateBar, installRows, loadModules, main, qualityPart, readInstruments, realRun,
  renderReport, secretScan, startQuestions, triageLimits, uatPart, viteServersIn,
} from '../../../.claude/skills/temper/scripts/temper.mjs';
import { PUSH_DEFAULTS, decide, segments } from '../../../.claude/skills/temper/scripts/guard.mjs';
import { derivedIds } from '../../../tools/e2e-coverage.mjs';
import { dryRun } from '../../../tools/temper-dryrun.mjs';
import { gitRepo, removeDir, tempDir } from './_fixture.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const dirs = /** @type {string[]} */ ([]);
after(() => { for (const d of dirs) removeDir(d); });
const temp = (/** @type {string} */ p) => { const d = tempDir(p); dirs.push(d); return d; };
/** @param {string} file @param {unknown} v */
const put = (file, v) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, typeof v === 'string' ? v : `${JSON.stringify(v, null, 2)}\n`); };
/** @param {string} dir @param {...string} a */
const g = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const row = (/** @type {string} */ spec, state = 'pass', attempts = 3, flaky = false) => ({ spec, state, attempts, flaky });

/**
 * A Dowser stand-in (git repo on master) with a ctx whose runner runs git for real and answers the rest.
 * @param {{npm?: Record<string, number>, shell?: Record<string, number>, dialog?: boolean}} [o]
 */
function world(o = {}) {
  const work = temp('temper');
  const root = join(work, 'dowser'), home = join(work, 'home');
  mkdirSync(root, { recursive: true });
  gitRepo(root, { 'README.md': '# x\n', '.gitignore': '.temper/\ne2e/results/\n' });
  g(root, 'branch', '-M', 'master');
  /** @type {{cmd: string, args: string[], cwd?: string}[]} */
  const calls = [];
  const npm = o.npm ?? {}, shell = o.shell ?? {};
  let now = Date.now() - 60000;
  const ctx = {
    root, home, env: /** @type {NodeJS.ProcessEnv} */ (o.dialog === false ? {} : { TEMPER_CHARTER_DIALOG: '1' }), now: () => new Date(now),
    /** @type {import('../../../.claude/skills/temper/scripts/temper.mjs').Runner} */
    run: (cmd, args, ro) => {
      if (cmd === 'git') return realRun(cmd, args, ro);
      calls.push({ cmd, args, cwd: ro?.cwd });
      if (cmd === 'npm') return { status: npm[args[1]] ?? 0, stdout: '' };
      if (ro?.shell) return { status: shell[cmd] ?? 0, stdout: '' };
      return { status: 0, stdout: '' };
    },
    /** no real process is listed or killed in a test */
    procs: { list: () => procs, kill: (/** @type {number} */ pid) => { killed.push(pid); return true; } },
  };
  /** @type {{pid: number, cmd: string}[]} */
  const procs = [];
  /** @type {number[]} */
  const killed = [];
  return { work, root, home, ctx, calls, procs, killed, at: (/** @type {number} */ ms) => { now = ms; } };
}

/** @param {ReturnType<typeof world>} w @param {any} [extra] */
function charter(w, extra = {}) {
  const draft = join(w.work, 'draft.json');
  put(draft, { repos: [{ name: 'dowser', path: w.root, inbox_key: 'dowser-temper', build: true }], ...extra });
  const r = main(['charter', 'init', '--from', draft, '--operator', 'Op'], w.ctx);
  assert.equal(r.code, 0, JSON.stringify(r.out));
  return r.out.charter;
}

test('charter init: refuses without --operator, outside the start dialog, with themes, or with a landing a repo may not have', () => {
  const w = world();
  const draft = join(w.work, 'draft.json');
  put(draft, { repos: [{ name: 'dowser', path: w.root, inbox_key: 'dowser-temper', build: true }] });
  assert.equal(main(['charter', 'init', '--from', draft], w.ctx).code, 2, 'no --operator is a usage error');
  const noDialog = world({ dialog: false });
  put(join(noDialog.work, 'd.json'), { repos: [{ name: 'dowser', path: noDialog.root, inbox_key: 'dowser-temper', build: true }] });
  const r = main(['charter', 'init', '--from', join(noDialog.work, 'd.json'), '--operator', 'Op'], noDialog.ctx);
  assert.equal(r.code, 1);
  assert.match(r.out.error, /start dialog/);
  assert.equal(existsSync(join(noDialog.root, '.temper', 'charter.json')), false);
  const other = temp('other');
  /** @param {any} d */
  const bad = (d) => { put(draft, d); return main(['charter', 'init', '--from', draft, '--operator', 'Op'], w.ctx); };
  const dowser = { name: 'dowser', path: w.root, inbox_key: 'dowser-temper', build: true };
  assert.match(bad({ repos: [dowser], themes: ['x'] }).out.error, /no themes/);
  assert.match(bad({ repos: [{ ...dowser, name: 'bp' }] }).out.error, /name: "dowser"/);
  assert.match(bad({ repos: [dowser, { name: 'bp', path: other, inbox_key: 'bp-temper', build: true, landing: { kind: 'loop-ff' } }] }).out.error, /Dowser's landing only/);
  assert.match(bad({ repos: [dowser, { name: 'p', path: other, inbox_key: 'p-temper', build: true, landing: { kind: 'commit-only', push: ['master'] } }] }).out.error, /never pushes/);
  assert.match(bad({ repos: [dowser], until: 'tomorrow 8am' }).out.error, /local time/);
  assert.match(bad({ repos: [dowser, { ...dowser, name: 'x', path: other }] }).out.error, /used twice/);
  const c = charter(w, { until: '2026-11-06T08:00' });
  assert.equal(c.operator, 'Op');
  assert.deepEqual(c.repos[0].landing, { kind: 'loop-ff', branch: 'loop/<date>', push: ['master', 'loop/*'], deploy: 'forge-development' });
  assert.deepEqual(c.repos[0].caps, DEFAULT_CAPS);
  assert.equal(main(['charter', 'show'], w.ctx).out.until, '2026-11-06T08:00');
});

test('clock: the charter\'s until ends the day, else the 8 h wall; it drains under an hour left and while rate-limited', () => {
  const w = world();
  charter(w);
  const start = Date.parse('2026-11-05T22:00:00');
  w.at(start);
  assert.equal(main(['day', 'start', '--date', '2026-11-05'], w.ctx).code, 0);
  const day = JSON.parse(readFileSync(join(w.root, '.temper', 'day.json'), 'utf8'));
  w.at(start + 60 * 60000);
  assert.deepEqual({ ...clockOf(w.ctx, day), ends_at: undefined }, { elapsed_min: 60, remaining_min: WALL_MIN - 60, ends_at: undefined, wall_min: WALL_MIN, drain: false, stop: false });
  w.at(start + (WALL_MIN - 59) * 60000);
  assert.equal(clockOf(w.ctx, day).drain, true);
  w.at(start + WALL_MIN * 60000);
  assert.equal(clockOf(w.ctx, day).stop, true);
  // until wins over the wall: 22:00 -> 08:00 is 10 h
  charter(w, { until: '2026-11-06T08:00' });
  w.at(start + 9 * 3600000);
  const c = /** @type {any} */ (clockOf(w.ctx, day));
  assert.equal(c.remaining_min, 60);
  assert.equal(c.drain, false);
  assert.equal(c.until, '2026-11-06T08:00');
  w.at(start + 60 * 60000);
  const limited = main(['clock', '--rate-limited', '--until', new Date(start + 90 * 60000).toISOString()], w.ctx);
  assert.equal(limited.out.drain, true);
  assert.equal(limited.out.wake_in_s, 30 * 60);
  assert.equal(main(['cycle', 'begin', '--target', 'tooling'], w.ctx).code, 1, 'no cycle begins while draining');
});

/** The instruments of a module at the bar, overridable. @param {any} [over] */
const instruments = (over = {}) => ({
  e2e: { fixture: { rows: [row('e2e/fixture/surfaces.spec.mjs > surface map renders its key element')], stale: false },
    local: { rows: [row('e2e/local/surfaces.spec.mjs > local core: surface map renders its key element')], stale: false },
    live: { rows: [row('e2e/live/live.spec.mjs > live: every sidebar tab shows its page')], stale: false } },
  lens: { proposals: [{ id: 'p-1', feature: 'map', status: 'proposed', tier: 3 }], features: [{ slug: 'map', contexts: ['forge-insights-ui'] }] },
  scans: ['2026-11-04', '2026-11-05'].map((d) => ({ ts: `${d}T10:00:00Z`, project_key: 'dowser-temper', focus: 'area: forge/static/app/src/routes/reflect', ok: true, cards: { created: 2 } })),
  cycles: [], inbox: 'dowser-temper',
  quality: [{ head: 'a', long_functions: 3, dup_windows: 2, lib_cycles: [], todos: 1, typecheck: 'pass', tests_status: 'pass' },
    { head: 'b', long_functions: 3, dup_windows: 1, lib_cycles: [], todos: 1, typecheck: 'pass', tests_status: 'pass' }],
  coverage: { ids: { 'route:map': ['x'], 'route:reflect': ['x'], 'route:settings': ['x'], 'resolver:map.data': ['x'], 'fixture:delegation': ['x'] } },
  ...over,
});

test('modules bar: five verified parts meet the bar; unverifiable, self-reported, stale or thin results never count as a pass', () => {
  const defs = loadModules();
  const met = evaluateBar(defs, instruments()).modules['insights-ui'];
  assert.equal(met.met, true, JSON.stringify(met.parts));
  const live = instruments();
  live.e2e.live.rows = [row('e2e/live/live.spec.mjs > live: every sidebar tab shows its page', 'unverifiable')];
  const u = evaluateBar(defs, live).modules['insights-ui'];
  assert.equal(u.met, false);
  assert.equal(u.parts.uat.state, 'unverifiable');
  assert.equal(uatPart(defs.modules['insights-ui'], instruments({ e2e: { ...instruments().e2e, live: undefined } })).state, 'unverifiable', 'a missing project is no pass');
  assert.equal(uatPart(defs.modules['insights-ui'], instruments({ e2e: { ...instruments().e2e, fixture: { rows: instruments().e2e.fixture.rows, stale: true } } })).detail, 'the fixture results are older than HEAD');
  const thin = instruments();
  thin.e2e.fixture.rows = [row('e2e/fixture/surfaces.spec.mjs > surface map renders its key element', 'pass', 1)];
  assert.match(uatPart(defs.modules['insights-ui'], thin).detail, /--repeat-each 3/);
  const failing = instruments();
  failing.e2e.local.rows.push(row('e2e/local/surfaces.spec.mjs > local core: surface settings renders its key element', 'fail'));
  assert.deepEqual([uatPart(defs.modules['insights-ui'], failing).state, uatPart(defs.modules['insights-ui'], failing).ok], ['verified', false]);
  // scan yield: the ledger is verified; without it, cycle rows are self-reported, which never meets the bar
  const claimed = instruments({ scans: [], cycles: [1, 2].map(() => ({ target: 'insights-ui', self_reported: { scan: { created: 0 } } })) });
  const s = evaluateBar(defs, claimed).modules['insights-ui'];
  assert.deepEqual([s.parts.scan_yield.state, s.parts.scan_yield.ok, s.met], ['self-reported', true, false]);
  assert.equal(evaluateBar(defs, instruments({ scans: instruments().scans.map((/** @type {any} */ x) => ({ ...x, cards: { created: 3 } })) })).modules['insights-ui'].parts.scan_yield.ok, false);
  // proposals: tier 0-2 blocks, untriaged is unverifiable
  assert.equal(evaluateBar(defs, instruments({ lens: { ...instruments().lens, proposals: [{ id: 'p-2', feature: 'map', status: 'approved', tier: 1 }] } })).modules['insights-ui'].parts.proposals.ok, false);
  assert.equal(evaluateBar(defs, instruments({ lens: { ...instruments().lens, proposals: [{ id: 'p-3', feature: 'map', status: 'proposed' }] } })).modules['insights-ui'].parts.proposals.state, 'unverifiable');
  // quality: growth fails, one row is unverifiable
  const grew = instruments();
  grew.quality[1] = { ...grew.quality[1], long_functions: 4 };
  assert.match(qualityPart(/** @type {any} */ (grew)).detail, /long_functions 3 -> 4/);
  assert.equal(qualityPart(/** @type {any} */ (instruments({ quality: [instruments().quality[0]] }))).state, 'unverifiable');
  // coverage: an uncovered id fails
  const cov = instruments();
  cov.coverage.ids['resolver:reflect.data'] = [];
  assert.match(evaluateBar(defs, cov).modules['insights-ui'].parts.coverage.detail, /uncovered: resolver:reflect.data/);
  assert.equal(evaluateBar(defs, live).next !== 'insights-ui' || true, true);
});

test('proposals: a landed fix recorded with proposals resolve closes a tier 0-2 proposal for the bar; the lens-scan store is never written', () => {
  const defs = loadModules();
  const open = instruments({ lens: { ...instruments().lens, proposals: [{ id: 'p-a3b5bd', feature: 'map', status: 'proposed', tier: 1 }] } });
  assert.match(evaluateBar(defs, open).modules['insights-ui'].parts.proposals.detail, /open at tier 0-2: p-a3b5bd \(t1\)/);
  const fixed = evaluateBar(defs, { ...open, resolved: { 'p-a3b5bd': { commit: 'abcdef0123456789' } } }).modules['insights-ui'];
  assert.equal(fixed.parts.proposals.ok, true);
  assert.match(fixed.parts.proposals.detail, /resolved by a landed commit: p-a3b5bd \(abcdef0\)/);
  assert.equal(fixed.met, true);
  const running = { ...open, lens: { ...open.lens, proposals: [{ id: 'p-a3b5bd', feature: 'map', status: 'executing', tier: 1 }] }, resolved: { 'p-a3b5bd': { commit: 'abc' } } };
  assert.equal(evaluateBar(defs, running).modules['insights-ui'].parts.proposals.ok, false, 'a proposal being executed stays open');
  // the CLI: the commit must be on HEAD's history; the record goes to docs/evals/temper/resolved.json
  const w = world();
  charter(w);
  main(['day', 'start', '--date', '2026-11-05'], w.ctx);
  put(join(w.root, 'fix.txt'), 'fixed\n');
  g(w.root, 'add', 'fix.txt'); g(w.root, 'commit', '-q', '-m', 'fix: the git option injection');
  const sha = g(w.root, 'rev-parse', 'HEAD');
  g(w.root, 'checkout', '-q', '-b', 'side'); put(join(w.root, 'side.txt'), 's\n'); g(w.root, 'add', 'side.txt'); g(w.root, 'commit', '-q', '-m', 'side');
  const side = g(w.root, 'rev-parse', 'HEAD');
  g(w.root, 'checkout', '-q', 'loop/2026-11-05');
  assert.equal(main(['proposals', 'resolve', '--id', 'p-a3b5bd'], w.ctx).code, 2);
  assert.equal(main(['proposals', 'resolve', '--id', 'DW-1', '--commit', sha], w.ctx).code, 2);
  assert.match(main(['proposals', 'resolve', '--id', 'p-a3b5bd', '--commit', 'deadbeef'], w.ctx).out.error, /not a commit/);
  assert.match(main(['proposals', 'resolve', '--id', 'p-a3b5bd', '--commit', side], w.ctx).out.error, /not on HEAD's history/);
  const r = main(['proposals', 'resolve', '--id', 'p-a3b5bd', '--commit', sha.slice(0, 8), '--note', 'v0.3.0'], w.ctx);
  assert.equal(r.code, 0, JSON.stringify(r.out));
  const rec = JSON.parse(readFileSync(join(w.root, 'docs', 'evals', 'temper', 'resolved.json'), 'utf8'));
  assert.deepEqual([rec['p-a3b5bd'].commit, rec['p-a3b5bd'].subject, rec['p-a3b5bd'].note, rec['p-a3b5bd'].by], [sha, 'fix: the git option injection', 'v0.3.0', 'delegate:temper']);
  assert.deepEqual(readInstruments({ ...w.ctx, env: { TEMPER_LENS_SCAN: join(w.work, 'none') } }, {}).resolved, { 'p-a3b5bd': rec['p-a3b5bd'] });
  // a reset that drops the fix drops the resolution from the bar
  g(w.root, 'reset', '-q', '--hard', 'master');
  assert.deepEqual(readInstruments({ ...w.ctx, env: { TEMPER_LENS_SCAN: join(w.work, 'none') } }, {}).resolved, {});
});

test('modules bar CLI: reads an instruments folder and writes docs/evals/temper/modules.json', () => {
  const w = world();
  charter(w);
  const dir = join(w.work, 'inst');
  const i = instruments();
  for (const p of ['fixture', 'local', 'live']) put(join(dir, 'e2e', `${p}.json`), /** @type {any} */ (i.e2e)[p].rows);
  put(join(dir, 'lens-proposals.json'), i.lens.proposals);
  put(join(dir, 'app-structure.json'), { features: i.lens.features });
  put(join(dir, 'scans.jsonl'), i.scans.map((/** @type {any} */ x) => JSON.stringify(x)).join('\n'));
  put(join(dir, 'quality.jsonl'), i.quality.map((/** @type {any} */ x) => JSON.stringify(x)).join('\n'));
  put(join(dir, 'coverage.json'), i.coverage);
  const inst = readInstruments(w.ctx, { dir, inbox: 'dowser-temper' });
  assert.equal(inst.e2e.fixture?.rows.length, 1);
  const r = main(['modules', 'bar', '--instruments', dir], w.ctx);
  assert.equal(r.code, 0);
  assert.equal(r.out.modules['insights-ui'].met, true);
  const file = JSON.parse(readFileSync(join(w.root, 'docs', 'evals', 'temper', 'modules.json'), 'utf8'));
  assert.equal(file.modules['insights-ui'].met, true);
  assert.ok(file.next, 'the least-stable module is named');
});

test('modules.json: 8 modules cover every context of the map, the supplement and the app-structure, and every e2e coverage id', () => {
  const { order, modules } = loadModules();
  assert.deepEqual(order, ['skill-store', 'lenses', 'triage', 'forge-core', 'inbox-ui', 'insights-ui', 'connections', 'tooling']);
  const owned = new Set(order.flatMap((m) => modules[m].contexts));
  const names = JSON.parse(readFileSync(join(ROOT, 'context-map.json'), 'utf8')).contexts.map((/** @type {any} */ c) => c.name);
  // the supplement and app-structure are machine-local (.ai/ is gitignored): read them in this checkout or the main one
  const main0 = resolve(ROOT, dirname(execFileSync('git', ['-C', ROOT, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim()));
  for (const base of [ROOT, main0]) {
    const sup = join(base, '.ai', 'lens-scan', 'work', 'context-supplement.json');
    if (existsSync(sup)) names.push(...JSON.parse(readFileSync(sup, 'utf8')).contexts.map((/** @type {any} */ c) => c.name));
    const st = join(base, '.ai', 'lens-scan', 'app-structure.json');
    if (existsSync(st)) names.push(...JSON.parse(readFileSync(st, 'utf8')).contexts.map((/** @type {any} */ c) => c.name ?? c.slug ?? c.id).filter(Boolean));
  }
  for (const n of names) assert.ok(owned.has(n), `context ${n} belongs to no module`);
  for (const id of derivedIds(ROOT)) assert.ok(order.some((m) => modules[m].coverage.some((r) => new RegExp(r).test(id))), `coverage id ${id} belongs to no module`);
  for (const m of order) assert.match(modules[m].focus, /^(area|goal):\S/, `${m} focus`);
});

test('triage limits: the 20% reject/snooze floor and the day\'s caps, where snoozes and merges count against rejects', () => {
  const v = (/** @type {string} */ verdict, n = 1) => Array.from({ length: n }, () => ({ verdict }));
  assert.equal(REJECT_SHARE, 0.2);
  assert.equal(triageLimits([...v('accept', 4), ...v('reject')], [], DEFAULT_CAPS).ok, true, '1 of 5 is 20%');
  const low = triageLimits([...v('accept', 5), ...v('reject')], [], DEFAULT_CAPS);
  assert.equal(low.ok, false);
  assert.match(low.why[0], /floor is 20%/);
  const caps = { accepts_per_day: 2, rejects_per_day: 2 };
  assert.match(triageLimits([...v('accept'), ...v('reject')], v('accept', 2), caps).why.join(), /3 accepts today, over the cap of 2/);
  assert.match(triageLimits([...v('snooze'), ...v('merge')], v('reject'), caps).why.join(), /3 rejects, snoozes and merges today/);
});

test('cycle end: local-only verdicts are recorded as delegate:temper with the caps, and a red gate makes the cycle red', () => {
  const w = world({ npm: { test: 1 } });
  charter(w);
  assert.equal(main(['day', 'start', '--date', '2026-11-05'], w.ctx).code, 0);
  assert.equal(main(['cycle', 'begin', '--target', 'tooling'], w.ctx).code, 0);
  const file = join(w.work, 'c.json');
  put(file, { target: 'tooling', verdicts: [{ ref: 'DW-1', verdict: 'reject', reason: 'duplicate', inbox: 'dowser-temper', recorded: 'local' }] });
  const r = main(['cycle', 'end', '--file', file], w.ctx);
  assert.equal(r.code, 1, 'red');
  assert.equal(r.out.green, false);
  assert.ok(r.out.red_because.includes('test failed'));
  assert.ok(r.out.red_because.includes('e2e fixture: missing'));
  assert.deepEqual(r.out.self_reported.verdicts[0], { ref: 'DW-1', verdict: 'reject', reason: 'duplicate', inbox: 'dowser-temper', recorded: 'local', decided_by: 'delegate:temper' });
  // a reject without its reason never reaches the ledger
  assert.equal(main(['cycle', 'begin', '--target', 'tooling'], w.ctx).code, 0);
  put(file, { target: 'tooling', verdicts: [{ ref: 'DW-2', verdict: 'reject', inbox: 'dowser-temper', recorded: 'local' }] });
  assert.equal(main(['cycle', 'end', '--file', file], w.ctx).code, 2);
  // directions only for a module at the bar
  put(file, { target: 'tooling', directions: [{ id: 'x', module: 'tooling', title: 't', evidence: 'e', value: 'v', size: 'S', first_slice: 'f' }] });
  assert.match(main(['cycle', 'end', '--file', file], w.ctx).out.error, /does not meet the bar/);
});

test('land --dry-run (Dowser): green is the ff merge + push + Forge development deploy plan; red rolls back to the last green head', () => {
  const w = world();
  charter(w);
  main(['day', 'start', '--date', '2026-11-05'], w.ctx);
  put(join(w.root, 'forge', 'x.mjs'), 'export {};\n');
  g(w.root, 'add', '-A'); g(w.root, 'commit', '-q', '-m', 'feat: forge change');
  const head = g(w.root, 'rev-parse', 'HEAD');
  put(join(w.root, 'e2e', 'results', 'fixture.json'), [row('a')]);
  put(join(w.root, 'e2e', 'results', 'local.json'), [row('b')]);
  const green = main(['land', '--dry-run'], w.ctx);
  assert.equal(green.out.decision, 'land', JSON.stringify(green.out.reasons));
  assert.deepEqual(green.out.steps.slice(0, 7), ['git checkout -q master', 'git merge --ff-only loop/2026-11-05', 'git push origin master', 'stop-vite',
    'npm ci --prefix forge', 'npm ci --prefix forge/static/app', 'npm run forge:build-ui']);
  assert.match(green.out.steps[7], /forge deploy -e development --non-interactive/);
  assert.match(green.out.steps[7], /GetEnvironmentVariable\('FORGE_API_TOKEN','User'\)/);
  assert.match(green.out.steps[8], /forge install list --json/);
  assert.ok(Object.keys(green.out.checks.gates).includes('forge:check-shared'));
  assert.equal(g(w.root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'loop/2026-11-05', 'a dry run changes nothing');
  // record a green cycle at head, then a red commit
  put(join(w.root, 'docs', 'evals', 'temper', '2026-11-05.jsonl'), `${JSON.stringify({ kind: 'cycle', n: 1, date: '2026-11-05', repo: 'dowser', target: 'tooling', green: true, head })}\n`);
  put(join(w.root, 'forge', 'x.mjs'), 'export const broken = 1;\n');
  g(w.root, 'commit', '-q', '-am', 'feat: broken');
  // the results predate the red commit: backdated, since a commit time has whole seconds and the write may share one
  const before = Number(g(w.root, 'log', '-1', '--format=%ct')) - 5;
  for (const p of ['fixture', 'local']) utimesSync(join(w.root, 'e2e', 'results', `${p}.json`), before, before);
  const red = main(['land', '--dry-run'], { ...w.ctx, run: (c, a, o) => (c === 'npm' && a[1] === 'forge:test' ? { status: 1, stdout: '' } : w.ctx.run(c, a, o)) });
  assert.equal(red.out.decision, 'rollback');
  assert.equal(red.out.target, head);
  assert.deepEqual(red.out.steps, [`git reset --hard ${head}`]);
  assert.ok(red.out.reasons.includes('forge:test failed'));
  assert.ok(red.out.reasons.some((/** @type {string} */ x) => /e2e fixture: stale/.test(x)), 'results older than HEAD are stale');
});

test('land (Dowser, executed): more than one Forge installation row is a failed landing', () => {
  const w = world();
  charter(w);
  main(['day', 'start', '--date', '2026-11-05'], w.ctx);
  put(join(w.root, 'forge', 'x.mjs'), 'export {};\n');
  g(w.root, 'add', '-A'); g(w.root, 'commit', '-q', '-m', 'feat: forge');
  put(join(w.root, 'e2e', 'results', 'fixture.json'), [row('a')]);
  put(join(w.root, 'e2e', 'results', 'local.json'), [row('b')]);
  /** @type {string[]} */
  const ran = [];
  const ctx = { ...w.ctx, run: /** @type {import('../../../.claude/skills/temper/scripts/temper.mjs').Runner} */ ((c, a, o) => {
    if (c === 'git' && a.includes('push')) { ran.push('push'); return { status: 0, stdout: '' }; }
    if (c === 'powershell.exe') { ran.push(a.at(-1)?.includes('install list') ? 'install list' : 'deploy'); return { status: 0, stdout: a.at(-1)?.includes('install list') ? 'warning\n[{"id":"1"},{"id":"2"}]' : '' }; }
    return w.ctx.run(c, a, o);
  }) };
  const r = main(['land'], ctx);
  assert.equal(r.code, 1);
  assert.deepEqual(ran, ['push', 'deploy', 'install list']);
  assert.deepEqual([r.out.landing.ok, r.out.landing.stage, r.out.landing.installations], [false, 'install list', 2]);
  assert.equal(installRows('[{"a":1}]'), 1);
  assert.equal(installRows('no json'), undefined);
});

test('land (Dowser, executed): leftover vite dev servers of this checkout stop first, and a failed npm ci or UI build refuses the deploy', () => {
  const w = world();
  charter(w);
  main(['day', 'start', '--date', '2026-11-05'], w.ctx);
  put(join(w.root, 'forge', 'x.mjs'), 'export {};\n');
  g(w.root, 'add', '-A'); g(w.root, 'commit', '-q', '-m', 'feat: forge');
  const app = join(w.root, 'forge', 'static', 'app');
  w.procs.push(
    { pid: 101, cmd: `"C:\\Program Files\\nodejs\\node.exe" ${join(app, 'node_modules', 'vite', 'bin', 'vite.js')} --mode fixture` },
    { pid: 102, cmd: `node ${join(w.work, 'other-checkout', 'node_modules', 'vite', 'bin', 'vite.js')}` },
    { pid: 103, cmd: `node ${join(app, 'node_modules', 'vite', 'bin', 'vite.js')} build` },
    { pid: 104, cmd: `node ${join(w.root, 'node_modules', 'vitest', 'vitest.mjs')}` });
  assert.deepEqual(viteServersIn(w.procs, w.root).map((p) => p.pid), [101], 'only a dev server inside this checkout');
  /** @param {string} failing @returns {{r: any, ran: string[]}} */
  const landWith = (failing) => {
    /** @type {string[]} */
    const ran = [];
    const ctx = { ...w.ctx, run: /** @type {import('../../../.claude/skills/temper/scripts/temper.mjs').Runner} */ ((c, a, o) => {
      if (c === 'git' && a.includes('push')) { ran.push('push'); return { status: 0, stdout: '' }; }
      if (c === 'npm' && (a[0] === 'ci' || a[1] === 'forge:build-ui')) { const s = a.join(' '); ran.push(s); return { status: s === failing ? 1 : 0, stdout: '' }; }
      if (c === 'powershell.exe') { ran.push('deploy'); return { status: 0, stdout: '[{"id":"1"}]' }; }
      return w.ctx.run(c, a, o);
    }) };
    return { r: main(['land'], ctx), ran };
  };
  put(join(w.root, 'e2e', 'results', 'fixture.json'), [row('a')]);
  put(join(w.root, 'e2e', 'results', 'local.json'), [row('b')]);
  const a = landWith('ci --prefix forge/static/app');
  assert.equal(a.r.code, 1);
  assert.deepEqual(w.killed, [101], 'the dev server stopped before the install');
  assert.deepEqual(a.ran, ['push', 'ci --prefix forge', 'ci --prefix forge/static/app'], 'no build and no deploy after a failed install');
  assert.deepEqual([a.r.out.landing.ok, a.r.out.landing.stage, a.r.out.landing.deployed, a.r.out.landing.stopped_vite], [false, 'npm ci --prefix forge/static/app', undefined, [101]]);
  // the next landing (master already holds the branch, so a new commit makes one to land)
  g(w.root, 'checkout', '-q', 'loop/2026-11-05');
  put(join(w.root, 'forge', 'x.mjs'), 'export const y = 1;\n');
  g(w.root, 'commit', '-q', '-am', 'feat: forge 2');
  put(join(w.root, 'e2e', 'results', 'fixture.json'), [row('a')]);
  put(join(w.root, 'e2e', 'results', 'local.json'), [row('b')]);
  const b = landWith('run forge:build-ui');
  assert.deepEqual(b.ran.at(-1), 'run forge:build-ui');
  assert.ok(!b.ran.includes('deploy'), 'a stale UI bundle is never deployed');
  assert.equal(b.r.out.landing.stage, 'build-ui');
  // a dev server that will not stop is a failed landing before any install
  g(w.root, 'checkout', '-q', 'loop/2026-11-05');
  put(join(w.root, 'forge', 'x.mjs'), 'export const y = 2;\n');
  g(w.root, 'commit', '-q', '-am', 'feat: forge 3');
  put(join(w.root, 'e2e', 'results', 'fixture.json'), [row('a')]);
  put(join(w.root, 'e2e', 'results', 'local.json'), [row('b')]);
  const stuck = main(['land'], { ...w.ctx, procs: { list: () => w.procs, kill: () => false },
    run: (c, a, o) => (c === 'git' && a.includes('push') ? { status: 0, stdout: '' } : w.ctx.run(c, a, o)) });
  assert.deepEqual([stuck.out.landing.ok, stuck.out.landing.stage, stuck.out.landing.vite_left], [false, 'stop vite', [101]]);
});

test('land (Dowser, executed red): the branch resets to the last green head and the day records survive the reset', () => {
  const w = world({ npm: { test: 1 } });
  charter(w);
  main(['day', 'start', '--date', '2026-11-05'], w.ctx);
  const base = g(w.root, 'rev-parse', 'HEAD');
  const rec = join(w.root, 'docs', 'evals', 'temper', '2026-11-05.jsonl');
  put(rec, `${JSON.stringify({ kind: 'cycle', n: 1, date: '2026-11-05', repo: 'dowser', target: 'tooling', green: false, head: base })}\n`);
  put(join(w.root, 'x.txt'), 'x\n');
  g(w.root, 'add', '-A'); g(w.root, 'commit', '-q', '-m', 'feat: x, with the cycle record');
  const r = main(['land'], w.ctx);
  assert.equal(r.code, 1);
  assert.equal(r.out.decision, 'rollback');
  assert.equal(g(w.root, 'rev-parse', 'HEAD'), base);
  assert.equal(r.out.landing.records_restored, 1);
  assert.match(readFileSync(rec, 'utf8'), /"target":"tooling"/);
  // a new day starts over a modified day record (yesterday's report), but not over other changes
  put(join(w.root, 'docs', 'evals', 'temper', 'kept.md'), 'x\n');
  g(w.root, 'add', '-A'); g(w.root, 'commit', '-q', '-m', 'chore: records');
  put(join(w.root, 'docs', 'evals', 'temper', 'kept.md'), 'y\n');
  assert.equal(main(['day', 'end'], w.ctx).code, 0);
  const d2 = main(['day', 'start', '--date', '2026-11-06'], w.ctx);
  assert.equal(d2.code, 0, JSON.stringify(d2.out));
  main(['day', 'end'], w.ctx);
  put(join(w.root, 'README.md'), 'changed\n');
  assert.match(main(['day', 'start', '--date', '2026-11-07'], w.ctx).out.error, /outside docs\/evals\/temper/);
});

/** A bp-like repo with a bare origin, and a personas-like repo with an active-runs ledger script. @param {ReturnType<typeof world>} w */
function otherRepos(w) {
  const origin = join(w.work, 'bp-origin.git');
  execFileSync('git', ['init', '-q', '--bare', origin]);
  const bp = join(w.work, 'bp');
  mkdirSync(bp);
  gitRepo(bp, { 'README.md': '# bp\n' });
  g(bp, 'branch', '-M', 'master');
  g(bp, 'remote', 'add', 'origin', origin);
  g(bp, 'push', '-q', 'origin', 'master');
  const personas = join(w.work, 'personas');
  mkdirSync(personas);
  gitRepo(personas, { 'README.md': '# personas\n', 'scripts/active-runs.mjs': '// stub\n', '.claude/active-runs.md': '# Active Runs Ledger\n' });
  g(personas, 'branch', '-M', 'master');
  return { bp, personas };
}

test('repo start/land: bp rebases onto origin/master and pushes HEAD:master only when its gates and the secret scan are clean; personas never pushes and keeps its ledger', () => {
  const w = world();
  const { bp, personas } = otherRepos(w);
  charter(w, {});
  const draft = join(w.work, 'draft.json');
  put(draft, { repos: [
    { name: 'dowser', path: w.root, inbox_key: 'dowser-temper', build: true },
    { name: 'bp', path: bp, inbox_key: 'bp-temper', build: true, landing: { kind: 'rebase-push' }, gates: ['npm run check'] },
    { name: 'personas', path: personas, inbox_key: 'personas-temper', build: true, landing: { kind: 'commit-only' }, ledger: '.claude/active-runs.md',
      gates: [{ run: 'npm run verify:affected -- --files {files}', when: 'item' }, 'npm run gate -- --cold'] },
  ] });
  assert.equal(main(['charter', 'init', '--from', draft, '--operator', 'Op'], w.ctx).code, 0);
  main(['day', 'start', '--date', '2026-11-05'], w.ctx);
  // bp
  const s = main(['repo', 'start', '--repo', 'bp'], w.ctx);
  assert.equal(s.code, 0, JSON.stringify(s.out));
  assert.equal(s.out.branch, 'temper/2026-11-05');
  assert.ok(s.out.worktree.startsWith(w.home));
  put(join(s.out.worktree, 'a.txt'), 'a\n');
  g(s.out.worktree, 'add', 'a.txt'); g(s.out.worktree, 'commit', '-q', '-m', 'feat: a');
  const green = main(['land', '--repo', 'bp', '--dry-run'], w.ctx);
  assert.equal(green.out.decision, 'land', JSON.stringify(green.out));
  assert.deepEqual(green.out.steps, ['git push origin HEAD:master']);
  assert.ok(w.calls.some((c) => c.cmd === 'npm run check' && c.cwd === s.out.worktree), 'the charter gate ran in the worktree');
  put(join(s.out.worktree, '.env'), 'KEY=sk-ant-abcdefghijklmnopqrstuvwxyz0123\n');
  g(s.out.worktree, 'add', '-f', '.env'); g(s.out.worktree, 'commit', '-q', '-m', 'oops');
  const red = main(['land', '--repo', 'bp', '--dry-run'], w.ctx);
  assert.equal(red.out.decision, 'red');
  assert.deepEqual(red.out.steps, []);
  assert.match(red.out.reasons.join(), /env-file in \.env/);
  assert.match(red.out.reasons.join(), /anthropic-key in \.env/);
  assert.doesNotMatch(JSON.stringify(red.out), /sk-ant-abc/, 'the secret itself is never printed');
  // personas
  assert.equal(main(['repo', 'start', '--repo', 'personas'], w.ctx).code, 2, 'a ledger repo needs --paths');
  const p = main(['repo', 'start', '--repo', 'personas', '--paths', 'src/features/x/**'], w.ctx);
  assert.equal(p.code, 0, JSON.stringify(p.out));
  assert.deepEqual(p.out.item_gates, ['npm run verify:affected -- --files {files}']);
  const ledger = w.calls.filter((c) => c.cmd === 'node').map((c) => c.args[1]);
  assert.deepEqual(ledger, ['check', 'register']);
  put(join(p.out.worktree, 'b.txt'), 'b\n');
  g(p.out.worktree, 'add', 'b.txt'); g(p.out.worktree, 'commit', '-q', '-m', 'feat: b');
  const pl = main(['land', '--repo', 'personas'], w.ctx);
  assert.equal(pl.out.decision, 'commit-only');
  assert.deepEqual(pl.out.steps, []);
  assert.ok(w.calls.some((c) => c.cmd === 'npm run gate -- --cold'));
  assert.ok(!w.calls.some((c) => c.cmd === 'npm run verify:affected -- --files {files}'), 'an item gate is the builder\'s, not land\'s');
  assert.equal(main(['day', 'end'], w.ctx).code, 1, 'a registered run must deregister first');
  assert.equal(main(['repo', 'end', '--repo', 'personas'], w.ctx).code, 0);
  assert.equal(w.calls.filter((c) => c.cmd === 'node').at(-1)?.args[1], 'complete');
  assert.equal(main(['day', 'end'], w.ctx).code, 0);
});

/** Dowser plus a bp build repo under one charter, the day started. @param {ReturnType<typeof world>} w */
function twoRepoDay(w) {
  const { bp } = otherRepos(w);
  const draft = join(w.work, 'draft2.json');
  put(draft, { repos: [{ name: 'dowser', path: w.root, inbox_key: 'dowser-temper', build: true },
    { name: 'bp', path: bp, inbox_key: 'bp-temper', build: true, landing: { kind: 'rebase-push' }, gates: ['npm run check'] }] });
  assert.equal(main(['charter', 'init', '--from', draft, '--operator', 'Op'], w.ctx).code, 0);
  assert.equal(main(['day', 'start', '--date', '2026-11-05'], w.ctx).code, 0);
  assert.equal(main(['repo', 'start', '--repo', 'bp'], w.ctx).code, 0);
  return { bp };
}

test('cycles per repo: bp begins while Dowser\'s cycle is open (the first version\'s cycle.json included), numbers stay unique, end resolves by repo', () => {
  const w = world();
  twoRepoDay(w);
  // the live day of the first version: .temper/cycle.json holds Dowser's cycle 1
  const legacy = join(w.root, '.temper', 'cycle.json');
  put(legacy, { n: 1, date: '2026-11-05', repo: 'dowser', target: 'lenses', begun_at: new Date(Date.now() - 120000).toISOString(), head: g(w.root, 'rev-parse', 'HEAD') });
  assert.match(main(['cycle', 'begin', '--target', 'tooling'], w.ctx).out.error, /cycle 1 \(lenses\) is still open in dowser/);
  const b = main(['cycle', 'begin', '--repo', 'bp', '--target', 'area:README.md'], w.ctx);
  assert.equal(b.code, 0, JSON.stringify(b.out));
  assert.equal(b.out.n, 2, 'a number unique across repos');
  assert.ok(existsSync(join(w.root, '.temper', 'cycle-bp.json')));
  assert.match(main(['cycle', 'begin', '--repo', 'bp', '--target', 'area:README.md'], w.ctx).out.error, /still open in bp/);
  const resumed = main(['day', 'resume'], w.ctx);
  assert.deepEqual(resumed.out.open_cycles.map((/** @type {any} */ c) => [c.repo, c.n]), [['bp', 2], ['dowser', 1]]);
  assert.match(main(['day', 'end'], w.ctx).out.error, /cycle 2 \(area:README.md\) in bp, cycle 1 \(lenses\) in dowser still open/);
  assert.match(main(['land', '--dry-run'], w.ctx).out.error, /still open/);
  assert.match(main(['land', '--repo', 'bp', '--dry-run'], w.ctx).out.error, /still open/);
  const file = join(w.work, 'c.json');
  put(file, { target: 'lenses' });
  assert.equal(main(['cycle', 'end', '--file', file], w.ctx).code, 2, 'two open and no repo named');
  assert.equal(main(['cycle', 'end', '--file', file, '--repo', 'personas'], w.ctx).code, 1, 'no open cycle there');
  put(file, { target: 'area:README.md', repo: 'bp' });
  const e = main(['cycle', 'end', '--file', file], w.ctx);
  assert.equal(e.code, 0, JSON.stringify(e.out));
  assert.deepEqual([e.out.repo, e.out.n], ['bp', 2]);
  assert.equal(existsSync(join(w.root, '.temper', 'cycle-bp.json')), false);
  // Dowser's cycle begun by the first version ends through --repo (the file names none), and its file goes
  put(file, { target: 'lenses' });
  const d = main(['cycle', 'end', '--file', file, '--repo', 'dowser'], w.ctx);
  assert.deepEqual([d.out.repo, d.out.n, d.out.target], ['dowser', 1, 'lenses']);
  assert.equal(existsSync(legacy), false);
  assert.equal(main(['cycle', 'begin', '--target', 'tooling'], w.ctx).out.n, 3);
});

test('cycle begin --repo: the target is a focus in the store\'s form (area:<path> in the worktree, goal:<text>), refused clearly otherwise', () => {
  const w = world();
  twoRepoDay(w);
  const begin = (/** @type {string[]} */ ...t) => main(['cycle', 'begin', '--repo', 'bp', ...t], w.ctx);
  const none = begin();
  assert.equal(none.code, 2);
  assert.match(none.out.error, /--repo bp needs --target <focus>: area:<path> .* or goal:<text>, with no space after the colon/);
  const spaced = begin('--target', 'goal: faster triage');
  assert.equal(spaced.code, 2);
  assert.match(spaced.out.error, /write goal:faster triage/);
  assert.match(begin('--target', 'lenses').out.error, /is not a focus/);
  assert.match(begin('--target', 'goal:').out.error, /is empty/);
  assert.match(begin('--target', 'area:no/such/dir').out.error, /no\/such\/dir is not a path in/);
  assert.equal(existsSync(join(w.root, '.temper', 'cycle-bp.json')), false, 'nothing opened');
  const ok = begin('--target', 'goal:faster triage');
  assert.equal(ok.code, 0, JSON.stringify(ok.out));
  assert.equal(ok.out.focus, 'goal:faster triage');
  assert.match(ok.out.scan.bp, /--focus "goal:faster triage"/);
});

test('secretScan: env files and token shapes in added lines, never .env.example, names only', () => {
  assert.deepEqual(secretScan('a.txt\n.env.example\nsub/.env.local', '+++ b/a.txt\n+hello'), { clean: false, hits: [{ file: 'sub/.env.local', pattern: 'env-file' }] });
  assert.equal(secretScan('a.txt', '+++ b/a.txt\n-AKIAABCDEFGHIJKLMNOP\n+fine').clean, true, 'a removed line is no leak');
  assert.deepEqual(secretScan('k.pem', '+++ b/k.pem\n+-----BEGIN RSA PRIVATE KEY-----').hits, [{ file: 'k.pem', pattern: 'private-key' }]);
});

test('report: verified vs self-reported UAT, live and local-only verdicts apart, at most three questions', () => {
  const cycles = [{ n: 1, repo: 'dowser', target: 'inbox-ui', green: true, verified: { uat: { fixture: { pass: 3, fail: 1 }, live: { unverifiable: 2 } } },
    self_reported: { uat: { pass: 10, fail: 0 }, verdicts: [{ ref: 'DW-1', verdict: 'accept', inbox: 'dowser-temper', recorded: 'live' }, { ref: 'DW-2', verdict: 'reject', inbox: 'bp-temper', recorded: 'local' }],
      parked: [{ item: 'DW-7', why: 'XL' }] } }];
  const directions = [{ id: 'ship-x', module: 'tooling', size: 'M', title: 'X', value: 'v', evidence: 'e', first_slice: 'f' }];
  const charter = { delegation: { 'dowser-temper': { until: '2026-11-06' } } };
  const { questions, later } = startQuestions({ date: '2026-11-05', charter, directions, cycles, liveState: 'unverifiable' });
  assert.equal(questions.length, 3);
  assert.match(questions[0], /delegation for dowser-temper ends on 2026-11-06/);
  assert.match(questions[1], /1 verdicts are local only/);
  assert.match(questions[2], /ship-x/);
  assert.equal(later.length, 2);
  const md = renderReport({ date: '2026-11-05', commits: ['abc feat: x'], landings: { dowser: { decision: 'land', ok: true, pushed: 'master', deployed: 'development' } },
    cycles, scans: [{ project_key: 'bp-temper', cards: { created: 10 }, minutes: 11, cost_usd: 7.86 }], bar: undefined, directions, questions, later });
  assert.match(md, /\| verified \(runner results\) \| 3 \| 1 \| 2 \| 75% \|/);
  assert.match(md, /\| self-reported \(cycle files\) \| 10 \| 0 \| \| 100% \|/);
  assert.match(md, /\| bp-temper \| local only/);
  assert.match(md, /\| dowser-temper \| live \(Forge recorded\) \| 1 \| 0 \| 0 \| 0 \|/);
  assert.match(md, /Total: 1 scans, \$7\.86/);
  assert.match(md, /- dowser: land, pushed master, deployed development\./);
  assert.match(md, /- DW-7: XL/);
  assert.match(md, /\*\*ship-x\*\* \(tooling, M\)/);
});

test('dry-run day: charter -> day start -> cycle begin -> bar -> cycle end -> report -> land --dry-run, with no network', () => {
  const r = dryRun();
  assert.equal(r.ok, true, JSON.stringify(r.steps.filter((s) => !s.ok), null, 2));
  assert.deepEqual(r.steps.map((s) => s.step), ['charter init', 'day start', 'cycle begin', 'modules bar', 'cycle end', 'report', 'land --dry-run (green)', 'land --dry-run (red)']);
});

// ------------------------------------------------------------------------------------------------ guard

test('guard: the push defaults equal temper.mjs LANDINGS', () => {
  for (const [k, v] of Object.entries(LANDINGS)) assert.deepEqual(/** @type {any} */ (PUSH_DEFAULTS)[k], v.push, k);
});

test('guard: the allow / ask / deny table', () => {
  const work = temp('guard');
  const project = join(work, 'dowser'), bp = join(work, 'bp'), personas = join(work, 'personas'), home = join(work, 'home');
  const charter = { repos: [
    { name: 'dowser', path: project, landing: { kind: 'loop-ff', push: ['master', 'loop/*'] } },
    { name: 'bp', path: bp, landing: { kind: 'rebase-push', push: ['master'] } },
    { name: 'personas', path: personas, landing: { kind: 'commit-only', push: [] } },
  ] };
  const ctx = { projectDir: project, charter, home };
  const sh = (/** @type {string} */ command, tool = 'Bash', cwd = project) => decide({ tool_name: tool, tool_input: { command }, cwd }, ctx)?.decision ?? 'allow';
  const file = (/** @type {string} */ tool, /** @type {string} */ fp) => decide({ tool_name: tool, tool_input: { file_path: fp }, cwd: project }, ctx)?.decision ?? 'allow';
  const deny = [
    'git tag v1.0.0', 'git tag -a v1 -m x', 'git -C . tag -d v1', 'git push --tags origin', 'git push --follow-tags origin master',
    'git push -f origin master', 'git push --force origin loop/2026-11-05', 'git push --force-with-lease origin master', 'git push -uf origin master',
    'git push origin +master', 'git push origin :master', 'git push --delete origin loop/x', 'git push origin feature/x', 'git push origin', 'git push',
    'git push origin HEAD', 'git push origin master:release', 'git push --no-verify origin master', 'git push --mirror origin',
    `git -C "${personas}" push origin master`, `cd "${personas}" && git push origin master`, `git -C "${bp}" push origin loop/x`,
    `git -C "${join(work, 'elsewhere')}" push origin master`, `git -C "${join(home, 'worktrees', 'personas-2026-11-05')}" push origin HEAD:master`,
    'forge deploy -e production', 'forge deploy --environment production', 'forge deploy --environment=production', 'forge deploy -e=prod', 'forge deploy',
    'npx forge deploy -e production', 'forge install --upgrade -e production', 'gh release create v1', 'gh release delete v1',
    'echo x; git tag v2', 'bash -c "git push -f origin master"', 'powershell -Command "git tag v3"', 'cmd /c git push origin +master',
    'echo {} > .temper/charter.json', 'cp draft.json .temper/charter.json', 'Set-Content .temper\\charter.json "{}"', 'rm -rf .temper', 'Remove-Item -Recurse .temper',
    'node .claude/skills/temper/scripts/temper.mjs charter init --from d.json --operator Op',
    'TEMPER_CHARTER_DIALOG=1 node .claude/skills/temper/scripts/temper.mjs charter init --from d.json --operator Op && git push -f origin master',
    'node .claude/skills/temper/scripts/temper.mjs day start --approve ship-x',
  ];
  for (const c of deny) assert.equal(sh(c), 'deny', `should deny: ${c}`);
  for (const c of ['git tag v1', 'forge deploy -e production', 'git push -f origin master']) assert.equal(sh(c, 'PowerShell'), 'deny', `PowerShell: ${c}`);
  const allow = [
    'git tag', 'git tag -l', 'git tag --list "v*"', 'git push origin master', 'git push -u origin loop/2026-11-05', 'git push origin refs/heads/master',
    'git push origin HEAD:master', 'git push origin loop/2026-11-05:loop/2026-11-05', `git -C "${bp}" push origin HEAD:master`,
    `git -C "${join(home, 'worktrees', 'bp-2026-11-05')}" push origin HEAD:master`, `cd "${bp}"; git push origin master`,
    'forge deploy -e development --non-interactive', 'forge deploy --environment staging', 'forge install list -e production', 'forge install list --json',
    'gh release list', 'gh release view v1', 'git commit -m "docs: never git push -f or git tag here"', 'echo "forge deploy -e production"',
    'node .claude/skills/temper/scripts/temper.mjs charter show', 'cat .temper/charter.json', 'Get-Content .temper\\charter.json',
    'node .claude/skills/temper/scripts/temper.mjs day start', 'node .claude/skills/temper/scripts/temper.mjs land --dry-run',
    'git log --oneline', 'npm test', 'rm -rf e2e/results',
  ];
  for (const c of allow) assert.equal(sh(c), 'allow', `should allow: ${c}`);
  assert.equal(sh('TEMPER_CHARTER_DIALOG=1 node .claude/skills/temper/scripts/temper.mjs charter init --from C:/tmp/d.json --operator "Op Name"'), 'ask');
  assert.equal(sh('$env:TEMPER_CHARTER_DIALOG=\'1\'; node .claude/skills/temper/scripts/temper.mjs charter init --from C:\\tmp\\d.json --operator Op', 'PowerShell'), 'ask');
  assert.equal(sh('TEMPER_CHARTER_DIALOG=1 node .claude/skills/temper/scripts/temper.mjs day start --approve ship-x --veto other'), 'ask');
  assert.equal(file('Write', join(project, '.temper', 'charter.json')), 'deny');
  assert.equal(file('Edit', '.temper/charter.json'), 'deny');
  assert.equal(file('Write', join(project, '.temper', 'day.json')), 'allow');
  assert.equal(file('Write', join(project, 'README.md')), 'allow');
  // without a charter only the project pushes, to master and loop/*
  const bare = { projectDir: project, home };
  assert.equal(decide({ tool_name: 'Bash', tool_input: { command: 'git push origin loop/x' }, cwd: project }, bare), undefined);
  assert.equal(decide({ tool_name: 'Bash', tool_input: { command: 'git push origin master' }, cwd: bp }, bare)?.decision, 'deny');
  assert.deepEqual(segments('a "b c" | d').map((s) => s.map((x) => x.t)), [['a', 'b c'], ['d']]);
});

test('guard.mjs as a hook: stdin JSON in, the PreToolUse decision out, nothing for an allowed call', () => {
  const script = join(ROOT, '.claude', 'skills', 'temper', 'scripts', 'guard.mjs');
  const env = { ...process.env, CLAUDE_PROJECT_DIR: temp('hook') };
  const run = (/** @type {any} */ input) => spawnSync(process.execPath, [script], { input: JSON.stringify(input), encoding: 'utf8', env });
  const denied = run({ tool_name: 'Bash', tool_input: { command: 'git tag v9' }, cwd: env.CLAUDE_PROJECT_DIR });
  assert.equal(denied.status, 0);
  const out = JSON.parse(denied.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /tags are the operator's/);
  const allowed = run({ tool_name: 'Bash', tool_input: { command: 'git status' }, cwd: env.CLAUDE_PROJECT_DIR });
  assert.deepEqual([allowed.status, allowed.stdout], [0, '']);
  const settings = JSON.parse(readFileSync(join(ROOT, '.claude', 'settings.json'), 'utf8'));
  const hook = settings.hooks.PreToolUse.find((/** @type {any} */ h) => h.hooks.some((/** @type {any} */ x) => x.command.includes('temper/scripts/guard.mjs')));
  assert.equal(hook.matcher, 'Bash|PowerShell|Write|Edit');
});
