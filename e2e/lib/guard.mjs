// @ts-check
// The `test` every spec imports: Playwright's, with an automatic guard that fails a spec on any console error or
// uncaught page error, plus the helpers the specs share (primary-viewport screenshots, the unverifiable state).
import { test as base, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export { expect };
export const SCREENS = join(dirname(fileURLToPath(import.meta.url)), '..', 'results', 'screens');

/**
 * Console lines that are not the app's: the design-token library's feature-gate notice outside Jira is a warning
 * today; listed here in case it is raised to an error. Keep this list short and specific.
 */
const IGNORED = [/checking the feature gate/];

/**
 * @typedef {import('@playwright/test').PlaywrightTestArgs & import('@playwright/test').PlaywrightTestOptions} TestArgs
 * @typedef {import('@playwright/test').PlaywrightWorkerArgs & import('@playwright/test').PlaywrightWorkerOptions} WorkerArgs
 * @type {import('@playwright/test').Fixtures<{consoleGuard: string[]}, {}, TestArgs, WorkerArgs>}
 */
const guard = {
  consoleGuard: [async ({ page }, use) => {
    /** @type {string[]} */
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error' && !IGNORED.some((r) => r.test(m.text()))) errors.push(`console: ${m.text()}`); });
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    await use(errors);
    expect(errors, 'console and page errors').toEqual([]);
  }, { auto: true }],
};

export const test = base.extend(guard);

/**
 * Saves the primary viewport (not the full page) to e2e/results/screens/<project>/<name>.png.
 * @param {import('@playwright/test').Page} page @param {string} name
 */
export async function screen(page, name) {
  const dir = join(SCREENS, test.info().project.name);
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name.replace(/[^a-z0-9._-]+/gi, '_')}.png`) });
}

/**
 * Ends the running spec as unverifiable: it could not reach what it checks, so it is neither a pass nor a fail
 * (e2e/lib/reporter.mjs). Throws (a Playwright skip), so nothing after it runs.
 * @param {string} why
 * @returns {never}
 */
export function unverifiable(why) {
  test.info().annotations.push({ type: 'unverifiable', description: why });
  test.skip(true, `unverifiable: ${why}`);
  throw new Error('unreachable');
}

/** The env a project's global setup exported, or a clear failure. @param {string} name */
export function needEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set: run through the e2e config (npx playwright test --project <name>), which starts the servers`);
  return v;
}
