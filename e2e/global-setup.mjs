// @ts-check
// Starts what the selected projects need, each on a port found free now, and hands the URLs to the specs through
// the environment (workers inherit it). The returned function is the global teardown: it stops every server,
// also when specs failed. Projects come from `--project` on the command line; none given means all of them.
//   fixture: vite --mode fixture                          -> E2E_FIXTURE_URL
//   local:   tools/local-forge.mjs --http 0 --reset --seed e2e/local/seed.json on a temp db, the e2e inbox pushed
//            over MCP, and vite --mode local-forge pointed at it -> E2E_LOCAL_URL, E2E_LOCAL_FORGE, E2E_LOCAL_DB
//   live:    nothing to start (a persistent profile, see e2e/live/live.mjs)
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO, startLocalForge, startVite } from './lib/servers.mjs';
import { seedLocal } from './local/seed.mjs';

export const RESULTS = join(REPO, 'e2e', 'results');

/**
 * The project names on the command line (`--project x`, `--project=x`, repeated), or undefined for all.
 * @param {string[]} argv
 * @returns {Set<string> | undefined}
 */
export function selectedProjects(argv) {
  const out = new Set();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project' && argv[i + 1]) out.add(argv[++i]);
    else if (a.startsWith('--project=')) out.add(a.slice('--project='.length));
  }
  return out.size ? out : undefined;
}

/** @param {import('@playwright/test').FullConfig} config */
export default async function globalSetup(config) {
  const picked = selectedProjects(process.argv);
  const wants = (/** @type {string} */ name) => config.projects.some((p) => p.name === name) && (!picked || picked.has(name));
  /** @type {{name: string, stop: () => Promise<void>, log: () => string}[]} */
  const running = [];
  /** @type {string | undefined} */
  let work;
  const teardown = async () => {
    for (const r of running.reverse()) await r.stop();
    if (work) rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  mkdirSync(RESULTS, { recursive: true });
  try {
    if (wants('fixture')) {
      const ui = await startVite({ mode: 'fixture' });
      running.push({ name: 'fixture-ui', ...ui });
      process.env.E2E_FIXTURE_URL = ui.url;
    }
    if (wants('local')) {
      work = mkdtempSync(join(tmpdir(), 'dowser-e2e-'));
      const db = join(work, 'forge.db');
      const forge = await startLocalForge({ db, seed: join(REPO, 'e2e', 'local', 'seed.json') });
      running.push({ name: 'local-forge', ...forge });
      await seedLocal({ db, forge: forge.url });
      const ui = await startVite({ mode: 'local-forge', env: { VITE_DOWSER_LOCAL_PORT: String(forge.port) } });
      running.push({ name: 'local-ui', ...ui });
      Object.assign(process.env, { E2E_LOCAL_URL: ui.url, E2E_LOCAL_FORGE: forge.url, E2E_LOCAL_DB: db });
    }
  } catch (e) {
    for (const r of running) process.stderr.write(`[e2e] ${r.name} log:\n${r.log()}\n`);
    await teardown();
    throw e;
  }
  writeFileSync(join(RESULTS, 'servers.json'), `${JSON.stringify(Object.fromEntries(
    ['E2E_FIXTURE_URL', 'E2E_LOCAL_URL', 'E2E_LOCAL_FORGE', 'E2E_LOCAL_DB'].filter((k) => process.env[k]).map((k) => [k, process.env[k]]),
  ), null, 2)}\n`);
  return teardown;
}
