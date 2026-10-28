// @ts-check
// Display names for deciders (`forge:<accountId>`), through the Users port. Best effort by design: a missing
// port, a failed batch or an account Jira will not name just leaves the name out (absent value: omit the key).
import { logLine } from './observe.mjs';

/**
 * @typedef {import('./ports.mjs').Deps} Deps
 */

const PREFIX = 'forge:';

/**
 * The display names of the `forge:` deciders among `deciders`, keyed by the decider string.
 * @param {Deps} deps
 * @param {(string | undefined)[]} deciders
 * @returns {Promise<Record<string, string>>}
 */
export async function namesOf(deps, deciders) {
  const ids = [...new Set(deciders.filter((d) => typeof d === 'string' && d.startsWith(PREFIX)).map((d) => /** @type {string} */ (d).slice(PREFIX.length)))];
  /** @type {Record<string, string>} */
  const out = {};
  if (!deps.users || ids.length === 0) return out;
  try {
    const byId = await deps.users.names(ids);
    for (const id of ids) if (typeof byId[id] === 'string' && byId[id]) out[`${PREFIX}${id}`] = byId[id];
  } catch (e) {
    logLine(deps, { dowser: 'warn', what: 'user names', message: String(/** @type {Error} */ (e)?.message ?? e).slice(0, 200) });
  }
  return out;
}

/**
 * `rows` with `decided_by_name` added where the name is known.
 * @template {{decided_by?: string}} T
 * @param {Deps} deps
 * @param {T[]} rows
 * @returns {Promise<(T & {decided_by_name?: string})[]>}
 */
export async function withNames(deps, rows) {
  const names = await namesOf(deps, rows.map((r) => r.decided_by));
  return rows.map((r) => (r.decided_by && names[r.decided_by] ? { ...r, decided_by_name: names[r.decided_by] } : r));
}
