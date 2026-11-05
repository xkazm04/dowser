#!/usr/bin/env node
// @ts-check
// temper-dryrun - one /temper day against fixtures, end to end, with no network and no model call: a throwaway git
// repo stands in for Dowser, a temp folder for the Temper home, and an injected runner answers the npm gates.
// It proves the chain charter init -> day start -> cycle begin -> modules bar -> cycle end -> report -> land --dry-run
// (green: the merge plan), then a red gate (land --dry-run: the rollback target is the last green cycle's head).
//
//   node tools/temper-dryrun.mjs [--keep]
//
// Prints one JSON summary; exit 0 when every step answered as expected, 1 otherwise.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, realRun } from '../.claude/skills/temper/scripts/temper.mjs';
import { isMain } from './temper-lib.mjs';

/** @param {string} file @param {unknown} v */
const put = (file, v) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, typeof v === 'string' ? v : `${JSON.stringify(v, null, 2)}\n`); };

/** A fixture e2e result row. @param {string} spec @param {string} [state] */
const row = (spec, state = 'pass') => ({ spec, state, attempts: 3, flaky: false });

/**
 * Builds the fixture day and runs it. @param {{keep?: boolean}} [o]
 * @returns {{ok: boolean, steps: {step: string, code: number, ok: boolean, out: any}[], work: string}}
 */
export function dryRun(o = {}) {
  const work = mkdtempSync(join(tmpdir(), 'temper-dryrun-'));
  const root = join(work, 'dowser'), home = join(work, 'home'), inst = join(work, 'instruments');
  mkdirSync(root, { recursive: true });
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(work, 'gitconfig') };
  writeFileSync(env.GIT_CONFIG_GLOBAL, '');
  const g = (/** @type {string[]} */ ...a) => execFileSync('git', ['-C', root, ...a], { env, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim();
  g('init', '-q'); g('config', 'user.email', 'dry@example.com'); g('config', 'user.name', 'dry'); g('config', 'core.autocrlf', 'false');
  put(join(root, 'README.md'), '# fixture\n');
  put(join(root, '.gitignore'), '.temper/\ne2e/results/\n');
  g('add', '-A'); g('commit', '-q', '-m', 'init'); g('branch', '-M', 'master');

  /** @type {Record<string, number>} the npm scripts' exit codes */
  const npm = {};
  /** @type {import('../.claude/skills/temper/scripts/temper.mjs').Runner} */
  const run = (cmd, args, ro) => {
    if (cmd === 'git') return realRun(cmd, args, ro);
    if (cmd === 'npm') return { status: npm[args[1]] ?? 0, stdout: '' };
    return { status: 0, stdout: '' };
  };
  // real time: the e2e result files this run writes must be newer than the cycle's start
  let clock = Date.now() - 60000;
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  const later = new Date(clock + 10 * 3600000);
  const until = `${later.getFullYear()}-${pad(later.getMonth() + 1)}-${pad(later.getDate())}T${pad(later.getHours())}:${pad(later.getMinutes())}`;
  const ctx = { root, home, env: { ...env, TEMPER_CHARTER_DIALOG: '1' }, now: () => new Date(clock), run };
  /** @type {{step: string, code: number, ok: boolean, out: any}[]} */
  const steps = [];
  /** @param {string} step @param {string[]} argv @param {(r: {code: number, out: any}) => boolean} expect */
  const step = (step, argv, expect) => { const r = main(argv, ctx); steps.push({ step, code: r.code, ok: expect(r), out: r.out }); return r; };

  put(join(work, 'draft.json'), { repos: [{ name: 'dowser', path: root, inbox_key: 'dowser-temper', build: true }], until });
  step('charter init', ['charter', 'init', '--from', join(work, 'draft.json'), '--operator', 'Dry Run'], (r) => r.code === 0);
  step('day start', ['day', 'start', '--date', '2026-11-05'], (r) => r.code === 0 && r.out.branch === 'loop/2026-11-05');
  step('cycle begin', ['cycle', 'begin', '--target', 'inbox-ui'], (r) => r.code === 0 && r.out.focus === 'area:forge/static/app/src/routes/inbox');

  // instruments: inbox-ui's surfaces green over 3 runs but live unverifiable (nobody signed in), two quiet scans
  const specs = ['e2e/fixture/surfaces.spec.mjs > surface inbox renders its key element', 'e2e/local/triage.spec.mjs > accept in the inbox creates the local Jira issue, and the pull carries it'];
  put(join(inst, 'e2e', 'fixture.json'), [row(specs[0])]);
  put(join(inst, 'e2e', 'local.json'), [row(specs[1]), row('e2e/local/surfaces.spec.mjs > local core: surface inbox renders its key element')]);
  put(join(inst, 'e2e', 'live.json'), [row('e2e/live/live.spec.mjs > live: the inbox opens at a deep link', 'unverifiable')]);
  put(join(inst, 'scans.jsonl'), ['2026-11-04T10:00:00Z', '2026-11-05T10:00:00Z'].map((ts) => JSON.stringify({ ts, project_key: 'dowser-temper', focus: 'area:skill/scripts/lib', ok: true, cards: { created: 1 } })).join('\n'));
  put(join(inst, 'quality.jsonl'), [{ head: 'a', long_functions: 5, dup_windows: 3, lib_cycles: [], todos: 0, typecheck: 'pass', tests_status: 'pass' },
    { head: 'b', long_functions: 5, dup_windows: 2, lib_cycles: [], todos: 0, typecheck: 'pass', tests_status: 'pass' }].map((x) => JSON.stringify(x)).join('\n'));
  put(join(inst, 'lens-proposals.json'), [{ id: 'p-1', feature: 'store', status: 'proposed', tier: 3 }]);
  put(join(inst, 'app-structure.json'), { features: [{ slug: 'store', contexts: ['proposal-model'] }] });
  put(join(inst, 'coverage.json'), { ids: { 'route:inbox': ['e2e/fixture/surfaces.spec.mjs:10'] } });
  step('modules bar', ['modules', 'bar', '--instruments', inst], (r) => r.code === 0 && r.out.modules['skill-store'].met === true
    && r.out.modules['inbox-ui'].met === false && r.out.modules['inbox-ui'].parts.uat.state === 'unverifiable');

  // the cycle's build: one commit, then fixture + local results written by "the runner"
  put(join(root, 'feature.txt'), 'a slice\n');
  g('add', 'feature.txt'); g('commit', '-q', '-m', 'feat: a slice');
  put(join(root, 'e2e', 'results', 'fixture.json'), [row(specs[0])]);
  put(join(root, 'e2e', 'results', 'local.json'), [row(specs[1])]);
  put(join(root, 'e2e', 'results', 'live.json'), [row('e2e/live/live.spec.mjs > live: the inbox opens at a deep link', 'unverifiable')]);
  put(join(work, 'cycle.json'), { target: 'inbox-ui', scan: { project_key: 'dowser-temper', created: 4 },
    verdicts: [{ ref: 'DW-1', verdict: 'accept', inbox: 'dowser-temper', recorded: 'local' }, { ref: 'DW-2', verdict: 'reject', reason: 'duplicate', inbox: 'dowser-temper', recorded: 'local' }],
    built: [{ ref: 'DW-1', size: 'S' }], parked: [{ item: 'DW-9', why: 'needs the operator\'s call on scope' }] });
  const end = step('cycle end', ['cycle', 'end', '--file', join(work, 'cycle.json')], (r) => r.code === 0 && r.out.green === true && r.out.quota.ok);
  step('report', ['report'], (r) => r.code === 0 && r.out.questions.length <= 3);
  step('land --dry-run (green)', ['land', '--dry-run'], (r) => r.code === 0 && r.out.decision === 'land'
    && r.out.steps.join('|') === 'git checkout -q master|git merge --ff-only loop/2026-11-05|git push origin master');

  // a red gate after a second commit: the plan rolls back to the green cycle's head
  put(join(root, 'feature.txt'), 'a slice\na broken slice\n');
  g('commit', '-q', '-am', 'feat: a broken slice');
  npm.test = 1;
  step('land --dry-run (red)', ['land', '--dry-run'], (r) => r.code === 0 && r.out.decision === 'rollback' && r.out.target === end.out.head
    && r.out.reasons.includes('test failed'));

  const ok = steps.every((s) => s.ok);
  if (!o.keep) rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  return { ok, steps, work };
}

if (isMain(import.meta.url)) {
  const r = dryRun({ keep: process.argv.includes('--keep') });
  console.log(JSON.stringify({ ok: r.ok, steps: r.steps.map((s) => ({ step: s.step, code: s.code, ok: s.ok, ...(s.ok ? {} : { out: s.out }) })), ...(process.argv.includes('--keep') ? { work: r.work } : {}) }, null, 2));
  process.exitCode = r.ok ? 0 : 1;
}
