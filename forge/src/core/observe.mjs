// @ts-check
// One structured log line per tool, resolver and Rovo call, written at the dispatch door (app.mjs). A line is
// JSON on one row: the surface, the key, `project` (the first 12 hex of sha256 of the project key, when the
// payload has one: the key names the repo, so it is never logged as is), ok or the error code, and the
// duration. A failed resolver call adds a `resolver-error` line with the key, the error code and the hashed
// project, never the error message. Never a payload body, a note, a message, a token or an account id.
import { sha256 } from './util.mjs';

/**
 * @typedef {import('./ports.mjs').Deps} Deps
 */

/**
 * The log form of a project key: the first 12 hex of its sha256. Lines of one project still correlate.
 * @param {string} projectKey
 * @returns {string}
 */
export const projectTag = (projectKey) => sha256(projectKey).slice(0, 12);

/**
 * Writes one JSON line through the injected logger (default console.log).
 * @param {Pick<Deps, 'log'>} deps
 * @param {Record<string, unknown>} line
 */
export function logLine(deps, line) {
  const text = JSON.stringify(line);
  try { (deps.log ?? console.log)(text); } catch { /* logging never fails a call */ }
}

/**
 * Runs `run` and logs how it went. `run` answers a tool result; `{error, message}` is a failed call. A throw
 * (a missing table the entry point retries) is logged as `storage-not-ready` and rethrown.
 * @param {Deps} deps
 * @param {'tool' | 'resolver' | 'rovo'} surface
 * @param {string | undefined} key
 * @param {unknown} payload
 * @param {() => Promise<object>} run
 * @returns {Promise<object>}
 */
export async function observed(deps, surface, key, payload, run) {
  const t0 = Date.now();
  const pk = payload && typeof payload === 'object' && typeof (/** @type {any} */ (payload)).project_key === 'string' ? /** @type {any} */ (payload).project_key : undefined;
  const project = pk ? { project: projectTag(pk) } : {};
  /** @type {Record<string, unknown>} */
  const base = { dowser: 'call', surface, key: key ?? 'unknown', ...project };
  /** @type {object} */
  let out;
  try {
    out = await run();
  } catch (e) {
    logLine(deps, { ...base, ok: false, error: 'storage-not-ready', ms: Date.now() - t0 });
    throw e;
  }
  const err = typeof (/** @type {any} */ (out)).error === 'string' ? /** @type {any} */ (out) : undefined;
  logLine(deps, { ...base, ok: !err, ...(err ? { error: err.error } : {}), ms: Date.now() - t0 });
  if (err && surface === 'resolver') {
    logLine(deps, { dowser: 'resolver-error', key: key ?? 'unknown', ...project, error: err.error });
  }
  return out;
}
