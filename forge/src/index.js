// @ts-check
// Forge entry points (manifest `function` handlers). STUBS with final signatures, committed before the
// builder fan-out (spark forge-app, WP0). WP2 replaces the bodies; the keys and shapes are the contract in
// src/core/types.mjs and docs/contracts/forge-mcp-2.md. Logic belongs in src/core (pure, tested); adapters
// over @forge/* belong in src/adapters.
import ResolverPkg from '@forge/resolver';

// @forge/resolver is CommonJS: tsc (nodenext) sees module.exports, the Forge bundler sees the class.
/** @type {typeof import('@forge/resolver').default} */
const Resolver = /** @type {any} */ (ResolverPkg).default ?? ResolverPkg;

/** @typedef {import('./core/types.mjs').ResolverContract} ResolverContract */

const notImplemented = (/** @type {string} */ what) => ({ error: 'unavailable', message: `${what} is not implemented yet` });

const resolver = new Resolver();
/** @type {(keyof ResolverContract)[]} */
const KEYS = ['inbox.list', 'proposal.get', 'verdict.accept', 'verdict.reject', 'verdict.snooze', 'verdict.merge',
  'settings.get', 'settings.set', 'jira.projects', 'panel.forIssue', 'map.data', 'byline.forPage'];
for (const key of KEYS) resolver.define(key, async () => notImplemented(key));

/** Custom UI resolver (jira:globalPage, jira:issuePanel, confluence:contentBylineItem). */
export const handler = resolver.getDefinitions();
export { handler as resolver };

/**
 * rovo:mcp tools (forge-mcp-2). Forge routes every tool to this one function; the action key is in
 * `context.moduleKey`.
 * @param {Record<string, unknown>} payload  the tool inputs (scalars only)
 * @param {{accountId?: string, moduleKey?: string, cloudId?: string}} context
 * @returns {Promise<object>}
 */
export async function mcp(payload, context) {
  return notImplemented(`tool ${context?.moduleKey ?? payload?.moduleKey ?? '?'}`);
}

/**
 * Rovo agent actions: dowser_inbox_list, dowser_proposal_explain, dowser_verdict_record.
 * @param {Record<string, unknown>} payload
 * @param {{accountId?: string, moduleKey?: string}} context
 * @returns {Promise<object>}
 */
export async function rovo(payload, context) {
  return notImplemented(`action ${context?.moduleKey ?? '?'}`);
}

/**
 * Forge SQL migrations, run on install and upgrade (trigger dowser-migrate).
 * @param {unknown} _event
 * @returns {Promise<void>}
 */
export async function migrate(_event) {}
