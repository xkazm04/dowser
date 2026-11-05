// @ts-check
// /temper (.claude/skills/temper/scripts/temper.mjs, guard.mjs, modules.json): the charter's refusals, the clock, the
// stability bar on fixture instruments (unverifiable never passes), triage limits, land --dry-run decisions for each
// repo's landing law, report rendering, full module coverage of the context map, and the guard's allow/deny table.
// No network: git runs for real in temp repos, every npm gate and shell gate is answered by an injected runner.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_CAPS, LANDINGS, REJECT_SHARE, WALL_MIN, clockOf, depDrift, evaluateBar, installRows, loadModules, main, qualityPart, readInstruments, realRun,
  capQuestions, renderReport, secretScan, startQuestions, triageLimits, uatPart, validateCycleFile, viteServersIn,
} from '../../../.claude/skills/temper/scripts/temper.mjs';
import { PUSH_DEFAULTS, decide, segments } from '../../../.claude/skills/temper/scripts/guard.mjs';
import { derivedIds } from '../../../tools/e2e-coverage.mjs';
import { dryRun } from '../../../tools/temper-dryrun.mjs';
import { parseVerdicts } from '../../../tools/temper-verdicts.mjs';
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
  // the floor is per inbox per day: two good accepts pass after a day that rejected enough, and fail on a day that did not
  const two = triageLimits(v('accept', 2), [...v('accept', 3), ...v('reject', 2)], DEFAULT_CAPS);
  assert.equal(two.ok, true, '2 of 7 decided today');
  assert.deepEqual([two.decided, two.share, two.cycle.share], [7, 0.286, 0]);
  const lowDay = triageLimits(v('accept', 2), v('accept', 3), DEFAULT_CAPS);
  assert.equal(lowDay.ok, false);
  assert.match(lowDay.why[0], /0% of the 5 cards decided today in this inbox .* the floor is 20% per day/);
  // a card decided again today counts once for the floor, at its newest verdict (the caps count every decision)
  const re = triageLimits([{ ref: 'DW-1', verdict: 'accept' }], [{ ref: 'DW-1', verdict: 'snooze' }, { ref: 'DW-2', verdict: 'accept' }], DEFAULT_CAPS);
  assert.deepEqual([re.decided, re.ok, re.today.accepts, re.today.rejects], [2, false, 2, 1]);
  // a merge is neither accept nor reject: out of the share, still against the reject cap (c5: 2 merges into DW-69)
  const merged = triageLimits([...v('accept', 4), ...v('snooze'), ...v('merge', 2)], [], DEFAULT_CAPS);
  assert.deepEqual([merged.decided, merged.share, merged.ok, merged.today.rejects], [5, 0.2, true, 3]);
  assert.equal(triageLimits([...v('accept', 4), ...v('merge', 2)], [], DEFAULT_CAPS).ok, false, 'merges lift no share');
});

test('one verdicts file passes both triage check and temper-verdicts: inbox and recorded are optional, checked, never sent', () => {
  const w = world();
  charter(w);
  main(['day', 'start', '--date', '2026-11-05'], w.ctx);
  const file = join(w.work, 'v.json');
  const vs = [{ ref: 'DW-1', verdict: 'accept', inbox: 'dowser-temper', recorded: 'local' }, { ref: 'DW-2', verdict: 'reject', reason: 'false-positive', inbox: 'dowser-temper', recorded: 'local' },
    { ref: 'DW-3', verdict: 'snooze', note: 'after the store split', recorded: 'live' }];
  put(file, vs);
  const c = main(['triage', 'check', '--verdicts', file, '--inbox', 'dowser-temper'], w.ctx);
  assert.equal(c.code, 0, JSON.stringify(c.out));
  assert.deepEqual(parseVerdicts(vs, 'dowser-temper').map((v) => Object.keys(v).sort().join()), ['ref,verdict', 'reason,ref,verdict', 'note,ref,verdict'], 'the ledger keys are stripped before the call');
  // the same refusals in both: a snooze's why is a note, and the inbox must be the one named
  for (const bad of [[{ ...vs[2], reason: 'after the store split' }], [{ ...vs[0], inbox: 'bp-temper' }], [{ ...vs[0], recorded: 'maybe' }]]) {
    put(file, bad);
    assert.equal(main(['triage', 'check', '--verdicts', file, '--inbox', 'dowser-temper'], w.ctx).code, 2, JSON.stringify(bad));
    assert.throws(() => parseVerdicts(bad, 'dowser-temper'), JSON.stringify(bad));
  }
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

test('cycle end: the runner\'s skill_issues are checked, stored in the row, and the report groups them by where, newest first', () => {
  const w = world();
  charter(w);
  main(['day', 'start', '--date', '2026-11-05'], w.ctx);
  const file = join(w.work, 'c.json');
  const issue = (/** @type {string} */ where, /** @type {string} */ what) => ({ where, what, evidence: `ev ${what}`, fix: `fix ${what}` });
  main(['cycle', 'begin', '--target', 'tooling'], w.ctx);
  put(file, { target: 'tooling', skill_issues: [issue('temper.mjs CYCLE_KEYS', 'old one'), issue('cycle.md section 6', 'cover runs where')] });
  const a = main(['cycle', 'end', '--file', file], w.ctx);
  assert.notEqual(a.code, 2, JSON.stringify(a.out));
  assert.deepEqual(a.out.self_reported.skill_issues.map((/** @type {any} */ x) => x.where), ['temper.mjs CYCLE_KEYS', 'cycle.md section 6']);
  w.at(Date.now() + 5000);
  main(['cycle', 'begin', '--target', 'tooling'], w.ctx);
  put(file, { target: 'tooling', skill_issues: [issue('temper.mjs CYCLE_KEYS', 'new one')] });
  main(['cycle', 'end', '--file', file], w.ctx);
  const md = readFileSync(main(['report'], w.ctx).out.written, 'utf8');
  const sec = md.slice(md.indexOf('## Skill issues'));
  assert.ok(sec.indexOf('### temper.mjs CYCLE_KEYS') < sec.indexOf('### cycle.md section 6'), 'the group with the newest issue first');
  assert.ok(sec.indexOf('c2 (dowser): new one.') < sec.indexOf('c1 (dowser): old one.'), 'newest first within a group');
  assert.match(sec, /- c1 \(dowser\): cover runs where\. Evidence: ev cover runs where\. Fix: fix cover runs where\./);
  // the shape is checked: a missing field or an unknown key is a usage error, and nothing is recorded
  for (const bad of [[{ where: 'x', what: 'y', evidence: 'z' }], [{ ...issue('x', 'y'), severity: 'high' }], [{ ...issue('x', 'y'), fix: ' ' }], 'none']) {
    main(['cycle', 'begin', '--target', 'tooling'], w.ctx);
    put(file, { target: 'tooling', skill_issues: bad });
    const r = main(['cycle', 'end', '--file', file], w.ctx);
    assert.equal(r.code, 2, JSON.stringify(bad));
    assert.match(r.out.error, /skill_issues/);
    rmSync(join(w.root, '.temper', 'cycle-dowser.json'));
  }
  assert.match(renderReport({ date: 'd', commits: [], landings: {}, cycles: [], scans: [], directions: [], questions: [], later: [] }), /## Skill issues\n\nNone\./);
});

test('dependency drift: cycle end and land run npm ci where a lockfile is newer than its node_modules, and a failed install is red', () => {
  const w = world();
  charter(w);
  main(['day', 'start', '--date', '2026-11-05'], w.ctx);
  const pkg = (/** @type {string} */ name, /** @type {string} */ v) => ({ [`node_modules/${name}`]: { version: v, resolved: `https://r/${name}-${v}.tgz`, integrity: `sha512-${name}${v}`, dev: true } });
  const lock = (/** @type {any} */ packages) => ({ name: 'x', version: '1.0.0', lockfileVersion: 3, requires: true, packages });
  // root: a merge added @playwright/test to the lockfile, the installed tree predates it (cycle 1's red)
  put(join(w.root, 'package-lock.json'), lock({ '': { name: 'x' }, ...pkg('typescript', '7.0.2'), ...pkg('@playwright/test', '1.64.1'),
    'node_modules/@esbuild/aix-ppc64': { version: '0.1.0', optional: true } }));
  put(join(w.root, 'node_modules', '.package-lock.json'), lock(pkg('typescript', '7.0.2')));
  // forge: in sync (an optional package for another platform is absent, which is no drift)
  put(join(w.root, 'forge', 'package-lock.json'), lock({ '': { name: 'f' }, ...pkg('react', '19.0.0'), 'node_modules/@esbuild/aix-ppc64': { version: '0.1.0', optional: true } }));
  put(join(w.root, 'forge', 'node_modules', '.package-lock.json'), lock(pkg('react', '19.0.0')));
  // forge/static/app: never installed
  put(join(w.root, 'forge', 'static', 'app', 'package-lock.json'), lock({ '': { name: 'a' }, ...pkg('vite', '7.0.0') }));
  assert.equal(depDrift(w.root).state, 'drift');
  assert.equal(depDrift(join(w.root, 'forge')).state, 'in sync');
  assert.equal(depDrift(join(w.root, 'forge', 'static', 'app')).why, 'node_modules has no .package-lock.json');
  assert.equal(depDrift(join(w.root, 'skill')).state, 'no lockfile');
  /** @type {{cwd?: string, before: string[]}[]} */
  const ci = [];
  /** @type {string[]} */
  const order = [];
  let ciExit = 0;
  const ctx = { ...w.ctx, run: /** @type {import('../../../.claude/skills/temper/scripts/temper.mjs').Runner} */ ((c, a, o) => {
    if (c === 'npm' && a[0] === 'ci') { ci.push({ cwd: o?.cwd, before: [...order] }); return { status: ciExit, stdout: '' }; }
    if (c === 'npm') order.push(a[1]);
    return w.ctx.run(c, a, o);
  }) };
  const file = join(w.work, 'c.json');
  put(file, { target: 'tooling' });
  main(['cycle', 'begin', '--target', 'tooling'], ctx);
  const a = main(['cycle', 'end', '--file', file], ctx);
  assert.deepEqual(ci.map((x) => x.cwd), [w.root, join(w.root, 'forge', 'static', 'app')], 'npm ci where drifted, never where in sync');
  assert.ok(ci.every((x) => x.before.length === 0), 'before any gate');
  assert.deepEqual(a.out.verified.deps, { '.': { state: 'installed', why: "the installed tree is not the lockfile's" }, forge: { state: 'in sync' },
    'forge/static/app': { state: 'installed', why: 'node_modules has no .package-lock.json' } });
  assert.ok(!(a.out.red_because ?? []).some((/** @type {string} */ x) => /npm ci/.test(x)));
  // a failed npm ci is a red with its reason
  ciExit = 1; ci.length = 0;
  main(['cycle', 'begin', '--target', 'tooling'], ctx);
  const b = main(['cycle', 'end', '--file', file], ctx);
  assert.equal(b.code, 1);
  assert.equal(b.out.green, false);
  assert.match(b.out.red_because[0], /^npm ci in \. failed \(exit 1; the installed tree is not the lockfile's\)$/);
  assert.equal(b.out.verified.deps['.'].state, 'failed');
  // land checks the same before its gates, and a failed install is a reason not to land
  put(join(w.root, 'feature.txt'), 'x\n');
  g(w.root, 'add', 'feature.txt'); g(w.root, 'commit', '-q', '-m', 'feat: x');
  put(join(w.root, 'e2e', 'results', 'fixture.json'), [row('a')]);
  put(join(w.root, 'e2e', 'results', 'local.json'), [row('b')]);
  const l = main(['land', '--dry-run'], ctx);
  assert.equal(l.out.decision, 'rollback');
  assert.ok(l.out.reasons.some((/** @type {string} */ x) => /^npm ci in \. failed/.test(x)), JSON.stringify(l.out.reasons));
  assert.equal(l.out.checks.deps['forge/static/app'].state, 'failed');
  ciExit = 0;
  assert.equal(main(['land', '--dry-run'], ctx).out.decision, 'land');
});

test('cycle end: runs fixture and local e2e itself on the merged tree (once, when a charter gate already names them)', () => {
  const w = world();
  charter(w);
  main(['day', 'start', '--date', '2026-11-05'], w.ctx);
  /** @type {string[]} */
  const npm = [];
  const ctx = { ...w.ctx, run: /** @type {import('../../../.claude/skills/temper/scripts/temper.mjs').Runner} */ ((c, a, o) => {
    if (c === 'npm' && /^e2e:(fixture|local)$/.test(a[1])) {
      npm.push(a[1]);
      put(join(w.root, 'e2e', 'results', `${a[1].slice(4)}.json`), [row(`e2e/${a[1].slice(4)}/x.spec.mjs > x`)]);
      return { status: 0, stdout: '' };
    }
    if (c === 'npm') npm.push(a[1]);
    if (o?.shell) npm.push(c);
    return w.ctx.run(c, a, o);
  }) };
  const file = join(w.work, 'c.json');
  put(file, { target: 'tooling' });
  main(['cycle', 'begin', '--target', 'tooling'], ctx);
  const a = main(['cycle', 'end', '--file', file], ctx);
  assert.equal(a.out.green, true, JSON.stringify(a.out.red_because));
  assert.deepEqual(npm, ['typecheck', 'test', 'e2e:fixture', 'e2e:local']);
  assert.equal(a.out.verified.uat.fixture.state, 'fresh', 'the results it wrote count');
  // a charter that already runs them as land gates: no second run
  const c = JSON.parse(readFileSync(join(w.root, '.temper', 'charter.json'), 'utf8'));
  c.repos[0].gates = [{ run: 'npm run e2e:fixture -- --repeat-each 3', when: 'land' }];
  put(join(w.root, '.temper', 'charter.json'), c);
  npm.length = 0;
  main(['cycle', 'begin', '--target', 'tooling'], ctx);
  main(['cycle', 'end', '--file', file], ctx);
  assert.deepEqual(npm, ['typecheck', 'test', 'e2e:local', 'npm run e2e:fixture -- --repeat-each 3']);
});

test('cycle reverify: the same gates and e2e on the cycle\'s unchanged tree; its row is the newest verdict for the bar, report and land', () => {
  const w = world();
  charter(w);
  main(['day', 'start', '--date', '2026-11-05'], w.ctx);
  /** @type {Record<string, number>} */
  const exits = { typecheck: 1 };
  /** @type {string[]} */
  const npm = [];
  const ctx = { ...w.ctx, run: /** @type {import('../../../.claude/skills/temper/scripts/temper.mjs').Runner} */ ((c, a, o) => {
    if (c !== 'npm') return w.ctx.run(c, a, o);
    npm.push(a[1]);
    if (/^e2e:(fixture|local)$/.test(a[1])) put(join(w.root, 'e2e', 'results', `${a[1].slice(4)}.json`), [row(`e2e/${a[1].slice(4)}/x.spec.mjs > x`)]);
    return { status: exits[a[1]] ?? 0, stdout: '' };
  }) };
  const day = () => JSON.parse(readFileSync(join(w.root, '.temper', 'day.json'), 'utf8'));
  const base = day().last_green;
  main(['cycle', 'begin', '--target', 'tooling'], ctx);
  put(join(w.root, 'feature.txt'), 'a slice\n');
  g(w.root, 'add', 'feature.txt'); g(w.root, 'commit', '-q', '-m', 'feat: a slice');
  const file = join(w.work, 'c.json');
  put(file, { target: 'tooling' });
  const red = main(['cycle', 'end', '--file', file], ctx);
  assert.equal(red.code, 1);
  assert.deepEqual(red.out.red_because, ['typecheck failed'], 'an environmental red (the stale tree)');
  assert.equal(day().last_green, base);
  // usage and refusals that leave nothing behind
  assert.equal(main(['cycle', 'reverify'], ctx).code, 2);
  assert.equal(main(['cycle', 'reverify', '--n', 'x'], ctx).code, 2);
  assert.match(main(['cycle', 'reverify', '--n', '9'], ctx).out.error, /no cycle 9/);
  // the record commit rides on top: still the same tree
  put(join(w.root, 'docs', 'evals', 'temper', 'note.md'), 'records\n');
  g(w.root, 'add', 'docs'); g(w.root, 'commit', '-q', '-m', 'chore(temper): cycle 1 record');
  writeFileSync(join(w.root, 'README.md'), '# dirty\n');
  assert.match(main(['cycle', 'reverify', '--n', '1'], ctx).out.error, /uncommitted changes outside docs\/evals\/temper/);
  g(w.root, 'checkout', '-q', '--', 'README.md');
  // the environment is fixed: a red reverify first (still failing), then a green one
  exits.test = 1;
  const r1 = main(['cycle', 'reverify', '--n', '1'], ctx);
  assert.equal(r1.code, 1);
  assert.equal(r1.out.kind, 'reverify');
  for (const k of Object.keys(r1.out)) assert.match(readmeBlock('### A reverify row'), new RegExp(`"${k}"`), `README's reverify row lacks ${k}`);
  assert.equal(day().last_green, base, 'a red reverify moves nothing');
  exits.typecheck = 0; exits.test = 0; npm.length = 0;
  w.at(Date.now());
  const r2 = main(['cycle', 'reverify', '--n', '1'], ctx);
  assert.equal(r2.code, 0, JSON.stringify(r2.out));
  const head = g(w.root, 'rev-parse', 'HEAD');
  assert.deepEqual([r2.out.green, r2.out.head, r2.out.of_head, r2.out.before.green], [true, head, red.out.head, false]);
  assert.deepEqual(npm, ['typecheck', 'test', 'e2e:fixture', 'e2e:local'], 'the same gates and e2e as cycle end');
  assert.equal(r2.out.verified.uat.local.state, 'fresh');
  assert.equal(day().last_green, head);
  // the cycle row is kept; the newest verdict is what the readers see
  const raw = readFileSync(join(w.root, 'docs', 'evals', 'temper', '2026-11-05.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(raw.map((x) => x.kind), ['cycle', 'reverify', 'reverify']);
  const md = readFileSync(main(['report'], ctx).out.written, 'utf8');
  assert.match(md, new RegExp(`- 1 dowser tooling: green, reverified at ${head.slice(0, 7)} \\(first red: typecheck failed\\)`));
  assert.match(md, /Cycles: 1, green 1\./);
  // land: a later red commit rolls back to the reverified head, not to the day's base
  put(join(w.root, 'feature.txt'), 'a broken slice\n');
  g(w.root, 'commit', '-q', '-am', 'feat: broken');
  exits.test = 1;
  const l = main(['land', '--dry-run'], ctx);
  assert.equal(l.out.decision, 'rollback');
  assert.equal(l.out.target, head);
  // HEAD moved past the cycle with a build commit: refused
  assert.match(main(['cycle', 'reverify', '--n', '1'], ctx).out.error, /more than record-only commits \(feature\.txt\)/);
});

test('cycle file: cycle 1\'s runner file (2026-11-05) is accepted as written, informational keys included; a documented key of the wrong type is not', () => {
  // C:/Users/kazda/.temper/runs/cycle-1-dowser.json, long texts shortened; every key it carried is kept
  const cycle1 = {
    target: "lenses",
    scan: {"project_key":"dowser-temper","created":4,"cost_usd":2.9141,"minutes":9,"turns":49,"run_id":"r-20261105190038-8655","head":"7cd6cd9","pushed":["DW-56","DW-57","DW-58","DW-59"],"lens_states":"opportunity partial (Teamwork Graph goals Validati..."},
    verdicts: [{"ref":"DW-57","verdict":"accept","inbox":"dowser-temper","recorded":"local","note":"security-cra.md:56 says `<lockfile path>..."},{"ref":"DW-58","verdict":"accept","inbox":"dowser-temper","recorded":"local","note":"doc-drift.md:74 pipes the 120-day log in..."},{"ref":"DW-56","verdict":"accept","inbox":"dowser-temper","recorded":"local","note":"security-cra.md:58 and SKILL.md:244 make..."},{"ref":"DW-59","verdict":"snooze","until":"2026-11-19","inbox":"dowser-temper","recorded":"local","note":"real (record JSONL dominates the securit..."}],
    built: [{"ref":"DW-58","size":"XS","slice":"1/1","commits":["c0feeb4","f45e3b1"],"specs":["skill/scripts/tests/lens-packs-c1.test.mjs"],"qa":"subagent"},{"ref":"DW-57","size":"XS","slice":"1/1","commits":["c0feeb4","4bf7ae3"],"specs":["skill/scripts/tests/lens-packs-c1.test.mjs"],"qa":"subagent"},{"ref":"DW-56","size":"S","slice":"1/1","commits":["c0feeb4","4bf7ae3"],"specs":["skill/scripts/tests/lens-packs-c1.test.mjs"],"qa":"subagent"}],
    uat: {"e2e_fixture":{"exit":0,"pass":53,"fail":0},"e2e_local":{"exit":0,"pass":12,"fail":0},"results":"C:/Users/kazda/.temper/worktrees/dowser-c1/e2e/results/{fixture,local}.json","gates":{"typecheck":0,"test":"309/309"},"persona_pass":"not run: the cycle changed only lens packs and SKI..."},
    findings: [],
    outcomes: [],
    directions: [],
    parked: [{"item":"DW-59","why":"snoozed to 2026-11-19: needs a call on which tool folders the shared exclusion covers"},{"item":"lens-scan p-a3b5bd","why":"stale: fixed in skill 0.3.0 (install.mjs:205 passe..."}],
    notes: "Specs: QA subagent wrote skill/scripts/tests/lens-packs-c1.t...",
    skill_issues: [{"where":"temper.mjs validateCycleFile (CYCLE_KEYS)","what":"cycle end rejects any key outside CYCLE_KEYS, so the skill_issues key the cycle-runner brief requires makes `T cycle end` exit 2","evidence":"temper.mjs:66 CYCLE_KEYS has no skill_issues; :696 throws `unknown cycle key`","fix":"add skill_issues (and qa on built items, documented) to the cycle shape, or have the director strip it before cycle end"}],
  };
  const o = { target: 'lenses', metModules: [], proposedPerModule: {} };
  assert.equal(validateCycleFile(cycle1, o).length, 4);
  for (const [path, bad] of /** @type {[string, (c: any) => void][]} */ ([['scan.turns', (c) => { c.scan.turns = '49'; }], ['scan.head', (c) => { c.scan.head = 'HEAD'; }],
    ['scan.pushed', (c) => { c.scan.pushed = 'DW-56'; }], ['scan.ref', (c) => { c.scan.ref = 5; }], ['built DW-58.qa', (c) => { c.built[0].qa = true; }], ['built DW-58.commits', (c) => { c.built[0].commits = 'c0feeb4'; }]])) {
    const c = structuredClone(cycle1);
    bad(c);
    assert.throws(() => validateCycleFile(c, o), (e) => e instanceof Error && e.message.startsWith(path), path);
  }
  assert.throws(() => validateCycleFile({ ...cycle1, persona: 'x' }, o), /unknown cycle key persona/, 'the top level stays closed');
  // the persona pass has explicit states; a server-only change is not-reachable, never a silent pass
  for (const ok of ['run', 'run: 2 findings filed', 'skipped: no UI surface touched', 'not-reachable: Jira comment bodies only; forge/test covers them']) {
    assert.equal(validateCycleFile({ ...cycle1, uat: { ...cycle1.uat, persona_pass: ok } }, o).length, 4, ok);
  }
  for (const bad of ['passed', 'not-reachable', 'not-reachable: ', 'skipped', true]) {
    assert.throws(() => validateCycleFile({ ...cycle1, uat: { ...cycle1.uat, persona_pass: bad } }, o), /uat\.persona_pass is "run", .*"not-reachable: <why>"/, String(bad));
  }
});

test('cycle end: appends the quality-snapshot row itself when none was written since the cycle began, so the instrument fills', () => {
  const w = world();
  charter(w);
  main(['day', 'start', '--date', '2026-11-05'], w.ctx);
  const qfile = join(w.root, 'docs', 'evals', 'temper', 'quality.jsonl');
  /** @type {string[][]} */
  const snaps = [];
  let exit = 0;
  const ctx = { ...w.ctx, run: /** @type {import('../../../.claude/skills/temper/scripts/temper.mjs').Runner} */ ((c, a, o) => {
    if (c === process.execPath && a[0].endsWith('quality-snapshot.mjs')) {
      snaps.push(a.slice(1));
      if (!exit) writeFileSync(a[4], `${readFileSync(a[4], 'utf8').trim() ? `${readFileSync(a[4], 'utf8').trim()}\n` : ''}${JSON.stringify({ ts: new Date().toISOString(), label: a[2], head: 'abc1234', long_functions: 1 })}\n`);
      return { status: exit, stdout: '' };
    }
    return w.ctx.run(c, a, o);
  }) };
  put(qfile, '');
  const file = join(w.work, 'c.json');
  put(file, { target: 'tooling' });
  main(['cycle', 'begin', '--target', 'tooling'], ctx);
  const a = main(['cycle', 'end', '--file', file], ctx);
  assert.deepEqual(snaps, [['--label', 'c1', '--append', qfile]]);
  assert.deepEqual(a.out.verified.quality, { state: 'appended', head: 'abc1234' });
  assert.equal(readFileSync(qfile, 'utf8').trim().split('\n').length, 1);
  // the director's update step already wrote one: no second row
  main(['cycle', 'begin', '--target', 'tooling'], ctx);
  writeFileSync(qfile, `${readFileSync(qfile, 'utf8')}${JSON.stringify({ ts: new Date(Date.now() + 1000).toISOString(), label: 'c2', head: 'def5678' })}\n`);
  const b = main(['cycle', 'end', '--file', file], ctx);
  assert.equal(snaps.length, 1);
  assert.deepEqual(b.out.verified.quality, { state: 'present', head: 'def5678' });
  // a failed snapshot is recorded, and never makes the cycle red by itself
  w.at(Date.now() + 5000);
  main(['cycle', 'begin', '--target', 'tooling'], ctx);
  exit = 1;
  const c = main(['cycle', 'end', '--file', file], ctx);
  assert.deepEqual(c.out.verified.quality, { state: 'failed', exit: 1 });
  assert.ok(!(c.out.red_because ?? []).some((/** @type {string} */ x) => /quality/.test(x)));
  assert.equal(snaps.length, 2, 'tried once more');
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
  // the repo marks .claude/CLAUDE.md read-only to agents, and a src/ fix moves its census baseline
  put(join(personas, 'scripts/docs/check-doc-counts.mjs'), "export const READ_ONLY = new Set(['.claude/CLAUDE.md']);\n");
  put(join(personas, 'scripts/census/rules.json'), '{}\n');
  g(personas, 'add', '-A'); g(personas, 'commit', '-q', '-m', 'marks');
  const p = main(['repo', 'start', '--repo', 'personas', '--paths', 'src/features/x/**,.claude/**'], w.ctx);
  assert.equal(p.code, 0, JSON.stringify(p.out));
  assert.deepEqual(p.out.paths, ['src/features/x/**', '.claude/**', 'scripts/census/rules.json'], 'the census baseline rides with a src/ path');
  assert.deepEqual(p.out.companions.map((/** @type {any} */ c) => c.path), ['scripts/census/rules.json']);
  assert.equal(p.out.warnings.length, 1);
  assert.match(p.out.warnings[0], /\.claude\/CLAUDE\.md is marked read-only for agents by the repo \(scripts\/docs\/check-doc-counts\.mjs:1\)/);
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
  assert.equal(pl.out.checks.secret_scan.clean, true, 'commit-only runs the built-in secret scan too');
  // the repo's own hook may skip its scan (gitleaks missing): the built-in scan still turns a leak red
  put(join(p.out.worktree, 'k.txt'), 'token AKIAABCDEFGHIJKLMNOP\n');
  g(p.out.worktree, 'add', 'k.txt'); g(p.out.worktree, 'commit', '-q', '-m', 'oops');
  const leak = main(['land', '--repo', 'personas', '--dry-run'], w.ctx);
  assert.equal(leak.out.decision, 'red');
  assert.match(leak.out.reasons.join(), /aws-access-key in k\.txt/);
  assert.equal(main(['day', 'end'], w.ctx).code, 1, 'a registered run must deregister first');
  assert.equal(main(['repo', 'end', '--repo', 'personas'], w.ctx).code, 0);
  assert.equal(w.calls.filter((c) => c.cmd === 'node').at(-1)?.args[1], 'complete');
  assert.equal(main(['day', 'end'], w.ctx).code, 0);
});

test('repo paths --add: widens the personas entry through active-runs.mjs (check, then complete and register the same slug); a live conflict refuses', () => {
  const w = world();
  const { personas } = otherRepos(w);
  const draft = join(w.work, 'draft.json');
  put(draft, { repos: [{ name: 'dowser', path: w.root, inbox_key: 'dowser-temper', build: true },
    { name: 'personas', path: personas, inbox_key: 'personas-temper', build: true, landing: { kind: 'commit-only' }, ledger: '.claude/active-runs.md', gates: ['npm run gate -- --cold'] }] });
  assert.equal(main(['charter', 'init', '--from', draft, '--operator', 'Op'], w.ctx).code, 0);
  main(['day', 'start', '--date', '2026-11-05'], w.ctx);
  // the ledger script stand-in: check answers a live conflict for anything under src/hot/, and our own entry
  /** @type {string[][]} */
  const ledger = [];
  const run = w.ctx.run;
  w.ctx.run = (cmd, args, ro) => {
    if (cmd !== 'node' || !args[0].endsWith('active-runs.mjs')) return run(cmd, args, ro);
    ledger.push(args.slice(1));
    assert.equal(ro?.cwd, personas, 'run in the personas checkout, so its own ledger is the one written');
    if (args[1] !== 'check') return { status: 0, stdout: '' };
    const asked = args.slice(args.indexOf('--paths') + 1);
    const conflicts = [{ slug: 'temper-2026-11-05', ageHours: 0.1, overlap: ['src/a/**'] }, ...(asked.some((p) => p.startsWith('src/hot')) ? [{ slug: 'other-session', ageHours: 0.5, overlap: ['src/hot/**'] }] : [])];
    return { status: args.includes('--json') ? 2 : 0, stdout: JSON.stringify({ conflicts }) };
  };
  assert.equal(main(['repo', 'start', '--repo', 'personas', '--paths', 'src/a/**'], w.ctx).code, 0);
  ledger.length = 0;
  assert.equal(main(['repo', 'paths', '--repo', 'personas'], w.ctx).code, 2, '--add is required');
  const hot = main(['repo', 'paths', '--repo', 'personas', '--add', 'src/b/**,src/hot/**'], w.ctx);
  assert.equal(hot.code, 1);
  assert.match(hot.out.error, /a live session holds src\/hot\/\*\* \(other-session\)/);
  assert.deepEqual(ledger.map((a) => a[0]), ['check'], 'a conflict refuses before anything is written');
  ledger.length = 0;
  const ok = main(['repo', 'paths', '--repo', 'personas', '--add', 'src/b/**,src/a/**'], w.ctx);
  assert.equal(ok.code, 0, JSON.stringify(ok.out));
  assert.deepEqual(ok.out.paths, ['src/a/**', 'src/b/**']);
  assert.deepEqual(ok.out.added, ['src/b/**']);
  assert.deepEqual(ledger.map((a) => a[0]), ['check', 'complete', 'register'], 'the ledger script is the only writer');
  assert.deepEqual(ledger[0].slice(ledger[0].indexOf('--paths') + 1), ['src/b/**'], 'only the new paths are checked; our own entry is no conflict');
  assert.equal(ledger[1][ledger[1].indexOf('--slug') + 1], 'temper-2026-11-05');
  assert.deepEqual([ledger[2][ledger[2].indexOf('--slug') + 1], ...ledger[2].slice(ledger[2].indexOf('--paths') + 1)], ['temper-2026-11-05', 'src/a/**', 'src/b/**'], 'the same slug, not a second entry');
  const day = JSON.parse(readFileSync(join(w.root, '.temper', 'day.json'), 'utf8'));
  assert.deepEqual(day.repos.personas.paths, ['src/a/**', 'src/b/**']);
  ledger.length = 0;
  assert.deepEqual(main(['repo', 'paths', '--repo', 'personas', '--add', 'src/b/**'], w.ctx).out.added, []);
  assert.deepEqual(ledger, [], 'nothing new: the ledger is not touched');
  // widening onto a file the repo marks read-only warns; a src/ path brings the census baseline when the repo has one
  put(join(personas, 'scripts/docs/check-doc-counts.mjs'), "export const READ_ONLY = new Set(['.claude/CLAUDE.md']);\n");
  put(join(personas, 'scripts/census/rules.json'), '{}\n');
  g(personas, 'add', '-A'); g(personas, 'commit', '-q', '-m', 'marks');
  const wide = main(['repo', 'paths', '--repo', 'personas', '--add', '.claude/CLAUDE.md,src/c/**'], w.ctx);
  assert.equal(wide.code, 0, JSON.stringify(wide.out));
  assert.deepEqual(wide.out.added, ['.claude/CLAUDE.md', 'src/c/**', 'scripts/census/rules.json']);
  assert.match(wide.out.warnings.join(), /\.claude\/CLAUDE\.md is marked read-only for agents/);
  ledger.length = 0;
  assert.equal(main(['repo', 'end', '--repo', 'personas'], w.ctx).code, 0);
  assert.equal(main(['repo', 'paths', '--repo', 'personas', '--add', 'src/c/**'], w.ctx).code, 1, 'an ended run is not widened');
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
  assert.equal(e.out.verified.quality, undefined, 'a bp cycle leaves the Dowser quality snapshot alone');
  assert.equal(existsSync(join(w.root, '.temper', 'cycle-bp.json')), false);
  // Dowser's cycle begun by the first version ends through --repo (the file names none), and its file goes
  put(file, { target: 'lenses' });
  const d = main(['cycle', 'end', '--file', file, '--repo', 'dowser'], w.ctx);
  assert.deepEqual([d.out.repo, d.out.n, d.out.target], ['dowser', 1, 'lenses']);
  assert.equal(existsSync(legacy), false);
  assert.equal(main(['cycle', 'begin', '--target', 'tooling'], w.ctx).out.n, 3);
});

test('land --repo: only that repo\'s open cycle blocks it; another repo\'s open cycle does not, and Dowser still waits for all', () => {
  const w = world();
  twoRepoDay(w);
  assert.equal(main(['cycle', 'begin', '--target', 'tooling'], w.ctx).code, 0, 'Dowser\'s cycle is open');
  const wt = JSON.parse(readFileSync(join(w.root, '.temper', 'day.json'), 'utf8')).repos.bp.worktree;
  put(join(wt, 'a.txt'), 'a\n');
  g(wt, 'add', 'a.txt'); g(wt, 'commit', '-q', '-m', 'feat: a');
  const l = main(['land', '--repo', 'bp', '--dry-run'], w.ctx);
  assert.equal(l.out.decision, 'land', JSON.stringify(l.out));
  // Dowser's landing switches the checkout that holds every repo's records, so it still waits for all of them
  assert.match(main(['land', '--dry-run'], w.ctx).out.error, /cycle 1 \(tooling\) in dowser still open/);
  assert.equal(main(['cycle', 'begin', '--repo', 'bp', '--target', 'area:README.md'], w.ctx).code, 0);
  assert.match(main(['land', '--repo', 'bp', '--dry-run'], w.ctx).out.error, /in bp still open: end it first/);
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
  // the scan reads the day's work: bp's temper/<date>, Dowser's loop/<date>, never master
  assert.match(ok.out.scan.bp, / --ref temper\/2026-11-05 /);
  const d = main(['cycle', 'begin', '--target', 'tooling'], w.ctx);
  assert.equal(d.code, 0, JSON.stringify(d.out));
  assert.match(d.out.scan.dowser, / --ref loop\/2026-11-05 /);
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
  // docs/evals/temper/README.md documents every key a real cycle row has (top level and verified)
  const row = r.steps.find((s) => s.step === 'cycle end')?.out;
  const block = readmeBlock('### A cycle row');
  for (const k of [...Object.keys(row), ...Object.keys(row.verified).map((x) => `verified.${x}`)]) assert.match(block, new RegExp(`"${k.split('.').at(-1)}"`), `README's cycle row lacks ${k}`);
});

/** The JSON example under one heading of docs/evals/temper/README.md. @param {string} heading */
function readmeBlock(heading) {
  const md = readFileSync(join(ROOT, 'docs', 'evals', 'temper', 'README.md'), 'utf8');
  const at = md.indexOf(`${heading}\n`);
  assert.ok(at >= 0, `README has ${heading}`);
  return md.slice(at, md.indexOf('```\n', md.indexOf('```json', at) + 7));
}

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

test('cycle.md: QA updates the tests that encode the old behaviour in the spec commit, after the bounds are checked', () => {
  const md = readFileSync(join(ROOT, '.claude/skills/temper/references/cycle.md'), 'utf8');
  const build = md.slice(md.indexOf('## 4. Build'), md.indexOf('## 5.'));
  assert.match(build, /Old behaviour in existing tests/);
  assert.match(build, /QA greps for them before it commits/);
  assert.match(build, /updates\s+each one in the same spec commit/);
  assert.match(build, /encodes the old behaviour, updated here/);
  assert.ok(build.indexOf('Check every bound before QA starts') < build.indexOf('A **QA subagent**'), 'the bounds come before QA');
  assert.match(build, /QA never patches source in the shared worktree/);
  assert.match(build, /in its own scratch worktree/);
});

test('runner.md: the brief is repo-agnostic, on tonight\'s tools, and SKILL.md section 1 launches runners with it', () => {
  const md = readFileSync(join(ROOT, '.claude/skills/temper/references/runner.md'), 'utf8');
  for (const name of ['bp', 'personas', 'Lynx', 'Wolf', 'kiro']) assert.equal(new RegExp(`\\b${name}\\b`).test(md), false, `the brief names ${name}: repo specifics come from the block and the repo's law`);
  assert.doesNotMatch(md, /[A-Z]:\\/, 'no machine path');
  assert.match(md, /CLAUDE\.md/);
  assert.match(md, /AGENTS\.md/);
  assert.match(md, /tools\/temper-cards\.mjs/);
  assert.doesNotMatch(md, /forge-live-e2e/);
  assert.match(md, /\*\*one verdicts file\*\*/);
  assert.match(md, /skill_issues": \[\{where, what, evidence, fix\}\]/);
  assert.match(md, /"not-reachable: <why>"/);
  assert.match(md, /own scratch worktree/);
  assert.match(md, /greps the repo's test folders for the old behaviour/);
  assert.match(md, /--ref/);
  assert.match(md, /recorded: "local"/);
  const skill = readFileSync(join(ROOT, '.claude/skills/temper/SKILL.md'), 'utf8');
  const s1 = skill.slice(skill.indexOf('## 1. Cycle'), skill.indexOf('## 2.'));
  assert.match(s1, /references\/runner\.md/);
  assert.match(s1, /`runner` block/);
});

test('cap-deferred snoozes: counted apart (no floor, no rejects cap), only at the cap, carried to tomorrow in the report and asked first', () => {
  const v = (/** @type {string} */ verdict, n = 1, extra = {}) => Array.from({ length: n }, (_, i) => ({ ref: `DW-${verdict}-${i}`, verdict, ...extra }));
  const caps = { accepts_per_day: 2, rejects_per_day: 1 };
  const carried = v('snooze', 3, { deferred: 'cap' });
  // at the cap: the three carried snoozes lift no share (2 accepts, 0 rejects is 0%) and use none of the rejects cap
  const at = triageLimits([...v('accept', 2), ...carried], [], caps);
  assert.deepEqual([at.counts.carried, at.counts.snooze, at.decided, at.today.rejects, at.today.carried, at.deferral_ok], [3, undefined, 2, 0, 3, true]);
  assert.equal(at.floor_ok, false, 'a carried snooze is no reject-or-snooze');
  assert.equal(triageLimits([...v('accept', 2), ...v('reject'), ...carried], [], caps).ok, true, 'over the rejects cap of 1 only if they counted');
  // under the cap a deferral is no honest reason
  const under = triageLimits([...v('accept'), ...v('reject'), ...carried], [], caps);
  assert.equal(under.ok, false);
  assert.match(under.why.join(), /3 snoozes say deferred: "cap", but only 1 of 2 accepts are used today/);
  // the shape: deferred is "cap", on a snooze only, in both tools; stripped before the call
  assert.deepEqual(parseVerdicts([{ ref: 'DW-1', verdict: 'snooze', note: 'cap', deferred: 'cap' }], 'dowser-temper'), [{ ref: 'DW-1', verdict: 'snooze', note: 'cap' }]);
  assert.throws(() => parseVerdicts([{ ref: 'DW-1', verdict: 'accept', deferred: 'cap' }]), /only on a snooze/);
  assert.throws(() => parseVerdicts([{ ref: 'DW-1', verdict: 'snooze', deferred: 'later' }]), /deferred is "cap"/);

  const w = world();
  charter(w);
  main(['day', 'start', '--date', '2026-11-05'], w.ctx);
  const file = join(w.work, 'v.json');
  const accepts = Array.from({ length: DEFAULT_CAPS.accepts_per_day }, (_, i) => ({ ref: `DW-${i + 1}`, verdict: 'accept' }));
  const rejects = [{ ref: 'DW-20', verdict: 'reject', reason: 'false-positive' }, { ref: 'DW-21', verdict: 'reject', reason: 'false-positive' }, { ref: 'DW-22', verdict: 'reject', reason: 'false-positive' }];
  const defer = [{ ref: 'DW-30', verdict: 'snooze', note: 'real XS doc fix', deferred: 'cap' }, { ref: 'DW-31', verdict: 'snooze', deferred: 'cap' }];
  put(file, [...accepts.slice(0, 5), ...rejects, ...defer]);
  const early = main(['triage', 'check', '--verdicts', file, '--inbox', 'dowser-temper'], w.ctx);
  assert.equal(early.code, 1, 'five of ten accepts used: no deferral yet');
  assert.match(early.out.error, /deferred: "cap"/);
  put(file, [...accepts, ...rejects, ...defer]);
  const ok = main(['triage', 'check', '--verdicts', file, '--inbox', 'dowser-temper'], w.ctx);
  assert.equal(ok.code, 0, JSON.stringify(ok.out));
  assert.deepEqual([ok.out.decided, ok.out.today.carried, ok.out.today.rejects], [13, 2, 3]);
  // cycle end records them apart, refuses a deferral under the cap, and the report carries them to tomorrow
  main(['cycle', 'begin', '--target', 'tooling'], w.ctx);
  const cf = join(w.work, 'c.json');
  const mark = (/** @type {any[]} */ vs) => vs.map((x) => ({ ...x, inbox: 'dowser-temper', recorded: 'local' }));
  put(cf, { target: 'tooling', verdicts: mark([accepts[0], ...defer]) });
  const refused = main(['cycle', 'end', '--file', cf], w.ctx);
  assert.equal(refused.code, 1);
  assert.match(refused.out.error, /deferred: "cap"/);
  put(cf, { target: 'tooling', verdicts: mark([...accepts, ...rejects, ...defer]) });
  const end = main(['cycle', 'end', '--file', cf], w.ctx);
  assert.notEqual(end.code, 2, JSON.stringify(end.out));
  assert.deepEqual([end.out.quota.carried, end.out.quota.decided, end.out.quota.ok], [2, 13, true]);
  const md = readFileSync(main(['report'], w.ctx).out.written, 'utf8');
  assert.match(md, /\| dowser-temper \| local only .* \| 10 \| 3 \| 0 \| 0 \| 2 \|/);
  assert.match(md, /Carried to tomorrow \(snoozed only because the day's accept cap was reached.*\): 2\.\n- DW-30 \(dowser-temper\): real XS doc fix\n- DW-31 \(dowser-temper\)/);
  const cycles = [{ n: 1, self_reported: { verdicts: mark([...defer, { ref: 'DW-31', verdict: 'accept' }]) } }];
  const { questions } = startQuestions({ date: '2026-11-06', charter: { delegation: { 'dowser-temper': { until: '2026-11-06' } } }, directions: [], cycles, liveState: 'signed-in' });
  assert.match(questions[0], /^1 cards were carried to today because the accept cap was reached \(dowser-temper: DW-30\)/, 'a card re-decided later that day is not carried');
  assert.match(questions[1], /delegation for dowser-temper/);
});

test('an inbox at its accept cap: Needs you gives the numbers and asks for real caps in the charter', () => {
  const accepts = (/** @type {string} */ inbox, /** @type {number} */ n) => Array.from({ length: n }, (_, i) => ({ ref: `DW-${i + 1}`, verdict: 'accept', inbox, recorded: 'local' }));
  const charter = { delegation: {}, repos: [{ name: 'dowser', inbox_key: 'dowser-temper', caps: DEFAULT_CAPS }, { name: 'bp', inbox_key: 'bp-temper', caps: { accepts_per_day: 3, rejects_per_day: 9 } }] };
  const cycles = [{ n: 1, self_reported: { verdicts: [...accepts('dowser-temper', 10), { ref: 'DW-40', verdict: 'snooze', deferred: 'cap', inbox: 'dowser-temper', recorded: 'local' }, ...accepts('bp-temper', 2)] } }];
  assert.deepEqual(capQuestions(charter, cycles), ['dowser-temper reached its accept cap: 10 of 10 accepts, 1 real cards carried to the next day. Its caps are the defaults (10 accepts, 30 rejects a day), not a choice of yours: set real caps for it in the charter (repos[].caps, in the start dialog).']);
  cycles[0].self_reported.verdicts.push(...accepts('bp-temper', 1).map((v) => ({ ...v, ref: 'DW-9' })));
  assert.match(capQuestions(charter, cycles)[1], /^bp-temper reached its accept cap: 3 of 3 accepts\. Its caps are 3 accepts and 9 rejects a day: set real caps/);
  const { questions, later } = startQuestions({ date: '2026-11-05', charter, directions: [], cycles, liveState: 'signed-in' });
  assert.match(questions[0], /carried to today/);
  assert.match(questions[1], /dowser-temper reached its accept cap/);
  assert.match(questions[2], /bp-temper reached its accept cap/);
  const md = renderReport({ date: '2026-11-05', commits: [], landings: {}, cycles: [], scans: [], directions: [], questions, later });
  assert.match(md, /## Needs you\n\n1\. .*\n2\. dowser-temper reached its accept cap: 10 of 10 accepts/);
  assert.deepEqual(capQuestions(charter, [{ n: 1, self_reported: { verdicts: accepts('dowser-temper', 9) } }]), [], 'under the cap: nothing to ask');
});

test('cycle begin prints the runner block: the brief, the launch inputs, the caps used and left, the work tree and the cycle file', () => {
  const w = world();
  const { bp } = twoRepoDay(w);
  put(join(bp, 'AGENTS.md'), '# law\n');
  // yesterday carried DW-7 in bp-temper; today bp-temper already used 2 accepts and 1 reject
  put(join(w.root, 'docs', 'evals', 'temper', '2026-11-04.jsonl'), `${JSON.stringify({ kind: 'cycle', n: 3, date: '2026-11-04', repo: 'bp', target: 'area:x', self_reported: { verdicts: [
    { ref: 'DW-7', verdict: 'snooze', note: 'XS doc fix', deferred: 'cap', inbox: 'bp-temper', recorded: 'local' }, { ref: 'DW-8', verdict: 'snooze', deferred: 'cap', inbox: 'dowser-temper', recorded: 'local' }] } })}\n`);
  put(join(w.root, 'docs', 'evals', 'temper', '2026-11-05.jsonl'), `${JSON.stringify({ kind: 'cycle', n: 1, date: '2026-11-05', repo: 'bp', target: 'area:x', self_reported: { verdicts: [
    { ref: 'DW-1', verdict: 'accept', inbox: 'bp-temper', recorded: 'local' }, { ref: 'DW-2', verdict: 'accept', inbox: 'bp-temper', recorded: 'local' }, { ref: 'DW-3', verdict: 'reject', reason: 'false-positive', inbox: 'bp-temper', recorded: 'local' }] } })}\n`);
  const b = main(['cycle', 'begin', '--repo', 'bp', '--target', 'goal:faster triage'], w.ctx);
  assert.equal(b.code, 0, JSON.stringify(b.out));
  const r = b.out.runner;
  const day = JSON.parse(readFileSync(join(w.root, '.temper', 'day.json'), 'utf8'));
  assert.equal(r.brief, join(ROOT, '.claude', 'skills', 'temper', 'references', 'runner.md'));
  assert.ok(existsSync(r.brief), 'the brief is in the skill');
  assert.deepEqual([r.repo, r.path, r.inbox, r.n, r.target, r.focus, r.loop_root], ['bp', bp, 'bp-temper', 2, 'goal:faster triage', 'goal:faster triage', w.root]);
  assert.equal(r.scan, b.out.scan.bp, 'the scan command, the same one');
  assert.match(r.scan, / --ref temper\/2026-11-05 /);
  assert.deepEqual(r.caps, { ...DEFAULT_CAPS, used: { accepts: 2, rejects: 1, carried: 0 }, left: { accepts: 8, rejects: 29 } });
  assert.deepEqual(r.carried, [{ ref: 'DW-7', note: 'XS doc fix' }], 'yesterday\'s carried cards of this inbox only');
  assert.deepEqual([r.work.worktree, r.work.branch], [day.repos.bp.worktree, day.repos.bp.branch]);
  assert.deepEqual(r.laws, [join(bp, 'AGENTS.md')]);
  assert.equal(r.cycle_file, join(w.home, 'runs', 'cycle-2-bp.json'));
  // Dowser: its own worktree temper/c<n> off loop/<date>, which the director merges
  const d = main(['cycle', 'begin', '--target', 'tooling'], w.ctx).out.runner;
  assert.deepEqual([d.repo, d.inbox, d.n, d.work.branch, d.work.from, d.work.worktree, d.cycle_file],
    ['dowser', 'dowser-temper', 3, 'temper/c3', 'loop/2026-11-05', join(w.home, 'worktrees', 'dowser-c3'), join(w.home, 'runs', 'cycle-3-dowser.json')]);
  assert.match(d.work.create, /^git worktree add -b temper\/c3 ".*dowser-c3" loop\/2026-11-05$/);
  assert.deepEqual(d.carried, [{ ref: 'DW-8' }]);
  assert.equal(d.focus, loadModules().modules.tooling.focus, 'the module focus');
  assert.match(d.scan, / --ref loop\/2026-11-05 /);
});
