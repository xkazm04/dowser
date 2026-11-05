// @ts-check
// Display names for deciders (`forge:<accountId>`), through the Users port. Best effort by design: a missing
// port, a failed batch or an account Jira will not name just leaves the name out (absent value: omit the key).
import { logLine } from './observe.mjs';
import { errTag } from './util.mjs';
import { DELEGATE_KIND } from './types.mjs';

/**
 * @typedef {import('./ports.mjs').Deps} Deps
 */

const PREFIX = 'forge:';
const DELEGATE_PREFIX = `${DELEGATE_KIND}:`;

/** `delegate:temper` -> "Temper (delegate)". @param {string} by */
export function delegateName(by) {
  const name = by.slice(DELEGATE_PREFIX.length);
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} (delegate)`;
}

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
  // a delegate (core/delegate.mjs) is named by its decider, `delegate:temper` -> "Temper (delegate)": never a person's name
  for (const d of deciders) {
    if (typeof d === 'string' && d.startsWith(DELEGATE_PREFIX) && d.length > DELEGATE_PREFIX.length) out[d] = delegateName(d);
  }
  if (!deps.users || ids.length === 0) return out;
  try {
    const byId = await deps.users.names(ids);
    for (const id of ids) if (typeof byId[id] === 'string' && byId[id]) out[`${PREFIX}${id}`] = byId[id];
  } catch (e) {
    logLine(deps, { dowser: 'warn', what: 'user names', error: errTag(e) });
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
