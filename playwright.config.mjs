// @ts-check
// The e2e harness (e2e/README.md): three projects over the same Custom UI.
//   fixture  the in-memory fixture bridge (vite --mode fixture): every surface and every forced condition
//   local    the real Forge core on node:sqlite (tools/local-forge.mjs) behind vite --mode local-forge
//   live     the deployed app on the Jira development site, in the operator's persistent profile
// Servers start on free ports in e2e/global-setup.mjs and stop in its teardown. Results: e2e/results/<project>.json.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.mjs',
  outputDir: 'e2e/results/artifacts',
  globalSetup: './e2e/global-setup.mjs',
  reporter: [['list'], ['./e2e/lib/reporter.mjs']],
  forbidOnly: true,
  retries: 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, headless: true, trace: 'retain-on-failure' },
  projects: [
    { name: 'fixture', testDir: 'e2e/fixture' },
    { name: 'local', testDir: 'e2e/local' },
    // One spec file, so one worker drives the one profile; each flow opens its own persistent context.
    { name: 'live', testDir: 'e2e/live', retries: 0, timeout: 120_000 },
  ],
});
