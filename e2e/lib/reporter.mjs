// @ts-check
// The three-state result file per project: e2e/results/<project>.json = [{spec, state, attempts, flaky}].
//   state  pass | fail | unverifiable. A spec that could not reach what it checks (the live site signed out) marks
//          itself with the `unverifiable` annotation and skips (e2e/lib/guard.mjs unverifiable()); that is never
//          a pass and never a fail. A plain skip is not a result and is left out.
//   attempts  runs summed over retries and --repeat-each copies.
//   flaky     passed only on a retry, or passed and failed across repeats.
// The verdict a caller acts on is the runner's exit code plus this file; nothing here re-grades a spec.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const RESULTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'results');

/** @typedef {import('@playwright/test/reporter').Reporter} Reporter */
/** @typedef {{spec: string, state: 'pass' | 'fail' | 'unverifiable', attempts: number, flaky: boolean}} Row */

/**
 * Folds the runs of one spec (its repeat copies) into one row.
 * @param {string} spec
 * @param {{outcome: string, unverifiable: boolean, attempts: number}[]} runs
 * @returns {Row | undefined}
 */
export function foldRuns(spec, runs) {
  const counted = runs.filter((r) => r.unverifiable || r.outcome !== 'skipped');
  if (!counted.length) return undefined;
  const failed = counted.some((r) => !r.unverifiable && r.outcome === 'unexpected');
  const passed = counted.some((r) => !r.unverifiable && (r.outcome === 'expected' || r.outcome === 'flaky'));
  const state = failed ? 'fail' : counted.some((r) => r.unverifiable) ? 'unverifiable' : 'pass';
  const flaky = counted.some((r) => r.outcome === 'flaky') || (failed && passed);
  return { spec, state, attempts: counted.reduce((n, r) => n + r.attempts, 0), flaky };
}

/** @implements {Reporter} */
export default class ThreeStateReporter {
  /** @param {{outputDir?: string}} [o] */
  constructor(o = {}) {
    this.outputDir = o.outputDir ?? RESULTS;
    /** @type {import('@playwright/test/reporter').Suite | undefined} */
    this.suite = undefined;
    /** @type {string} */
    this.rootDir = process.cwd();
  }

  /** @param {import('@playwright/test/reporter').FullConfig} config @param {import('@playwright/test/reporter').Suite} suite */
  onBegin(config, suite) {
    this.suite = suite;
    // spec paths from the repo root (where the config lives): e2e/fixture/x.spec.mjs
    this.rootDir = config.configFile ? dirname(config.configFile) : config.rootDir;
  }

  printsToStdio() { return false; }

  onEnd() {
    if (!this.suite) return;
    /** @type {Map<string, Map<string, {outcome: string, unverifiable: boolean, attempts: number}[]>>} */
    const byProject = new Map();
    for (const t of this.suite.allTests()) {
      if (!t.results.length) continue;
      const project = t.parent.project()?.name ?? 'default';
      const spec = `${relative(this.rootDir, t.location.file).replaceAll('\\', '/')} > ${t.titlePath().slice(3).join(' > ')}`;
      const unverifiable = [...t.annotations, ...t.results.flatMap((r) => r.annotations ?? [])].some((a) => a.type === 'unverifiable');
      const runs = byProject.get(project) ?? new Map();
      byProject.set(project, runs);
      const list = runs.get(spec) ?? [];
      runs.set(spec, list);
      list.push({ outcome: t.outcome(), unverifiable, attempts: t.results.length });
    }
    mkdirSync(this.outputDir, { recursive: true });
    for (const [project, runs] of byProject) {
      const rows = [...runs].map(([spec, r]) => foldRuns(spec, r)).filter((r) => r !== undefined);
      writeFileSync(join(this.outputDir, `${project}.json`), `${JSON.stringify(rows, null, 2)}\n`);
    }
  }
}
