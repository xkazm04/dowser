// @ts-check
// One structured log line per tool, resolver and Rovo call, written at the dispatch door (app.mjs). A line is
// JSON on one row: the surface, the key, the project key when the payload has one, ok or the error code, and
// the duration. Never a payload body, a note, a token or an account id.

/**
 * @typedef {import('./ports.mjs').Deps} Deps
 */

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
  /** @type {Record<string, unknown>} */
  const base = { dowser: 'call', surface, key: key ?? 'unknown', ...(pk ? { project_key: pk } : {}) };
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
    logLine(deps, { dowser: 'resolver-error', key: key ?? 'unknown', ...(pk ? { project_key: pk } : {}), error: err.error, message: String(err.message ?? '').slice(0, 300) });
  }
  return out;
}
