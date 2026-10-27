// @ts-check
// The three read tools (forge-mcp-2 "Read tools"): validate the scalar inputs, build JQL / CQL, call the
// Sources port, and return `{items}`. The port does the HTTP and maps the payloads (adapters/atlassian.mjs).
import { AppError, isIso, needStr, optStr } from './util.mjs';

/**
 * @typedef {import('./ports.mjs').Deps} Deps
 * @typedef {import('./types.mjs').SourcesOutput} SourcesOutput
 */

/** Forge's cap on `limit` for tickets (the contract recommends 50). */
export const TICKETS_MAX = 50;
/** Pages per search (the pages tool has no limit input). */
export const PAGES_MAX = 25;
/** Body text is trimmed to about this many characters. */
export const BODY_MAX = 2000;

/**
 * Free-text terms: `a OR b` means any of them; quotes are dropped.
 * @param {string} q
 * @returns {string[]}
 */
export function terms(q) {
  return q.split(/\s+OR\s+/).map((t) => t.replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/**
 * `(text ~ "a" OR text ~ "b")` - one clause per term, so `OR` works whatever the text-search engine does with
 * operators inside a quoted string. Valid in both JQL and CQL.
 * @param {string[]} ts
 * @returns {string}
 */
export const textClause = (ts) => `(${ts.map((t) => `text ~ "${t}"`).join(' OR ')})`;

/**
 * An ISO timestamp as a JQL date literal (`"2026-09-01 00:00"`, UTC wall time).
 * @param {string} iso
 * @returns {string}
 */
export function jqlDate(iso) {
  const d = new Date(iso).toISOString();
  return `"${d.slice(0, 10)} ${d.slice(11, 16)}"`;
}

/**
 * Runs a source call; a port failure that is not already an AppError becomes `unavailable`.
 * @template T
 * @param {string} what
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function guarded(what, fn) {
  try { return await fn(); } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError('unavailable', `${what} did not answer (${/** @type {Error} */ (e).message}); retry on the next run`);
  }
}

/**
 * `dowser_sources_tickets`.
 * @param {Deps} deps
 * @param {Record<string, unknown>} args
 * @returns {Promise<SourcesOutput>}
 */
export async function sourcesTickets(deps, args) {
  const query = needStr(args, 'query');
  const since = optStr(args, 'since');
  const limit = args.limit;
  if (!Number.isInteger(limit) || /** @type {number} */ (limit) < 1) throw new AppError('bad-input', 'limit must be an integer >= 1');
  if (since !== undefined && !isIso(since)) throw new AppError('bad-input', 'since must be an ISO timestamp');
  const ts = terms(query);
  if (!ts.length) throw new AppError('bad-input', 'query has no search terms');
  const jql = `${textClause(ts)}${since ? ` AND created >= ${jqlDate(since)}` : ''} ORDER BY created DESC`;
  const sources = deps.sources;
  if (!sources) throw new AppError('unavailable', 'sources are not reachable from this module');
  return { items: await guarded('Jira', () => sources.tickets({ jql, limit: Math.min(/** @type {number} */ (limit), TICKETS_MAX) })) };
}

/**
 * `dowser_sources_pages`.
 * @param {Deps} deps
 * @param {Record<string, unknown>} args
 * @returns {Promise<SourcesOutput>}
 */
export async function sourcesPages(deps, args) {
  const ts = terms(needStr(args, 'query'));
  const space = optStr(args, 'space');
  if (!ts.length) throw new AppError('bad-input', 'query has no search terms');
  if (space !== undefined && !/^[A-Za-z0-9_~-]{1,255}$/.test(space)) throw new AppError('bad-input', 'space must be a Confluence space key');
  const cql = `type = page AND ${textClause(ts)}${space ? ` AND space = "${space}"` : ''} ORDER BY lastmodified DESC`;
  const sources = deps.sources;
  if (!sources) throw new AppError('unavailable', 'sources are not reachable from this module');
  return { items: await guarded('Confluence', () => sources.pages({ cql, limit: PAGES_MAX })) };
}

/**
 * `dowser_sources_goals`.
 * @param {Deps} deps
 * @returns {Promise<SourcesOutput>}
 */
export async function sourcesGoals(deps) {
  const sources = deps.sources;
  if (!sources) throw new AppError('unavailable', 'sources are not reachable from this module');
  return { items: await guarded('Teamwork Graph', () => sources.goals()) };
}
