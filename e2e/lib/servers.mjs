// @ts-check
// The servers the e2e projects run against, each on a port found free at run time (never a fixed 4710/5173), and
// stopped with their whole process tree. Used by e2e/global-setup.mjs; the specs read the URLs from the env.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const APP_DIR = join(REPO, 'forge', 'static', 'app');
const VITE = join(APP_DIR, 'node_modules', 'vite', 'bin', 'vite.js');
export const LOCAL_FORGE = join(REPO, 'tools', 'local-forge.mjs');

/**
 * @typedef {{url: string, port: number, pid: number | undefined, stop: () => Promise<void>, log: () => string}} Running
 */

/** A TCP port free on 127.0.0.1 right now. @returns {Promise<number>} */
export function freePort() {
  return new Promise((done, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const port = /** @type {import('node:net').AddressInfo} */ (s.address()).port;
      s.close(() => done(port));
    });
  });
}

/**
 * Stops a child and everything it started. On Windows `taskkill /T` takes the tree (a plain kill leaves grandchildren).
 * @param {import('node:child_process').ChildProcess} child
 * @returns {Promise<void>}
 */
export function stopTree(child) {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return Promise.resolve();
  const gone = new Promise((done) => child.once('exit', () => done(undefined)));
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGTERM');
  return Promise.race([gone, new Promise((done) => setTimeout(done, 5000))]).then(() => undefined);
}

/**
 * Waits until `url` answers any HTTP status.
 * @param {string} url @param {number} [ms]
 */
export async function waitHttp(url, ms = 60_000) {
  const until = Date.now() + ms;
  for (;;) {
    try { await fetch(url); return; } catch { /* not up yet */ }
    if (Date.now() > until) throw new Error(`${url} did not answer within ${ms} ms`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * The Custom UI dev server: `vite --mode <mode>` on a free port, bound to 127.0.0.1.
 * @param {{mode: 'fixture' | 'local-forge', env?: Record<string, string>}} o
 * @returns {Promise<Running>}
 */
export async function startVite({ mode, env = {} }) {
  if (!existsSync(VITE)) throw new Error(`${VITE} is missing: run npm ci --prefix forge/static/app first`);
  const port = await freePort();
  const child = spawn(process.execPath, [VITE, '--mode', mode, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: APP_DIR, env: { ...process.env, ...env, BROWSER: 'none' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let out = '';
  child.stdout?.on('data', (c) => { out += c; });
  child.stderr?.on('data', (c) => { out += c; });
  const url = `http://127.0.0.1:${port}/`;
  const exited = new Promise((_, fail) => child.once('exit', (code) => fail(new Error(`vite --mode ${mode} exited ${code}:\n${out}`))));
  await Promise.race([waitHttp(url), exited]);
  return { url, port, pid: child.pid, stop: () => stopTree(child), log: () => out };
}

/**
 * tools/local-forge.mjs over HTTP on a free port (`--http 0`; the port is read from its log), with a fresh db.
 * @param {{db: string, seed?: string}} o
 * @returns {Promise<Running>}
 */
export async function startLocalForge({ db, seed }) {
  const args = [LOCAL_FORGE, '--http', '0', '--reset', '--db', db, ...(seed ? ['--seed', seed] : [])];
  const child = spawn(process.execPath, args, { cwd: REPO, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let err = '';
  const url = await new Promise((done, fail) => {
    const t = setTimeout(() => fail(new Error(`local-forge did not listen:\n${err}`)), 20_000);
    child.stderr?.on('data', (c) => {
      err += c;
      const m = /http listening on (http:\/\/127\.0\.0\.1:(\d+))/.exec(err);
      if (m) { clearTimeout(t); done(m[1]); }
    });
    child.once('exit', (code) => { clearTimeout(t); fail(new Error(`local-forge exited ${code}:\n${err}`)); });
  });
  return { url: `${url}/`, port: Number(new URL(url).port), pid: child.pid, stop: () => stopTree(child), log: () => err };
}
