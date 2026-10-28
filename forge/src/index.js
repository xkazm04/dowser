// @ts-check
// Forge entry points (manifest `function` handlers). Thin: pick the caller and the action key from the
// invocation, build the ports (src/adapters) and hand over to the one dispatch door (src/core/app.mjs).
// The keys and shapes are the contract in src/core/types.mjs and docs/contracts/forge-mcp-2.md.
import ResolverPkg from '@forge/resolver';
import { getAppContext } from '@forge/api';
import { actionName, isNoTable, runResolver, runRovo, runTool } from './core/app.mjs';
import { forgeDb, runMigrations } from './adapters/forge-sql.mjs';
import { jira, links, sources, users } from './adapters/atlassian.mjs';

// @forge/resolver is CommonJS: tsc (nodenext) sees module.exports, the Forge bundler sees the class.
/** @type {typeof import('@forge/resolver').default} */
const Resolver = /** @type {any} */ (ResolverPkg).default ?? ResolverPkg;

/** @typedef {import('./core/types.mjs').ResolverContract} ResolverContract */
/** @typedef {import('./core/ports.mjs').Deps} Deps */

/** @returns {Deps} */
const deps = () => ({ db: forgeDb, jira, sources, links, users, now: () => new Date() });

let migrated = false;

/**
 * Runs `fn`; when its answer reports a missing table, runs the migrations once and retries. The install trigger
 * normally migrates; `avi:forge:upgraded:app` fires only on a major version (Forge SQL docs), so this covers a
 * minor upgrade that ships a new migration.
 * @param {() => Promise<object>} fn
 * @returns {Promise<object>}
 */
async function withSchema(fn) {
  try {
    return await fn();
  } catch (e) {
    if (migrated || !isNoTable(e)) throw e;
    migrated = true;
    await runMigrations();
    return fn();
  }
}

/** @param {unknown} context @returns {string | undefined} the caller's Atlassian account id */
function accountOf(context) {
  const c = /** @type {any} */ (context);
  return c?.principal?.accountId ?? c?.accountId ?? undefined;
}

/** @returns {string | undefined} */
function runtimeModuleKey() {
  try { return getAppContext().moduleKey; } catch { return undefined; }
}

/**
 * Runs the core; a thrown error (only a missing table escapes `answer`) still answers `{error, message}`.
 * @param {() => Promise<object>} fn
 */
const safe = async (fn) => {
  try { return await withSchema(fn); } catch (e) {
    console.error('dowser: unexpected failure', e);
    return { error: 'unavailable', message: 'Dowser storage is not ready; try again in a minute' };
  }
};

const resolver = new Resolver();
/** @type {(keyof ResolverContract)[]} */
const KEYS = ['inbox.list', 'proposal.get', 'verdict.accept', 'verdict.reject', 'verdict.snooze', 'verdict.merge',
  'settings.get', 'settings.set', 'jira.projects', 'panel.forIssue', 'map.data', 'byline.forPage', 'reflect.data', 'rule.decide', 'outcome.record',
  'direction.get', 'direction.set'];
for (const key of KEYS) {
  resolver.define(key, async ({ payload, context }) => {
    // The issue panel is the only surface that decides from inside an issue; everything else is the inbox.
    const via = context?.extension?.type === 'jira:issuePanel' || context?.moduleKey === 'dowser-evidence' ? 'panel' : 'inbox';
    /** @type {Record<string, unknown>} */
    const p = { ...(payload ?? {}) };
    // The panel and byline may omit their subject; the module context names it.
    if (key === 'panel.forIssue' && p.issue_key === undefined) p.issue_key = context?.extension?.issue?.key;
    if (key === 'byline.forPage' && p.page_id === undefined) p.page_id = context?.extension?.content?.id;
    return safe(() => runResolver(deps(), key, p, context?.accountId, via));
  });
}

/** Custom UI resolver (jira:globalPage, jira:issuePanel, confluence:contentBylineItem). */
export const handler = resolver.getDefinitions();
export { handler as resolver };

/**
 * rovo:mcp tools (forge-mcp-2). Every tool is an `action` routed to this one function. The action key is
 * `getAppContext().moduleKey` (@forge/api runtime typings), else a `moduleKey` on the context or payload,
 * else inferred from the argument shape (core/app.mjs `actionName`). The caller is the invocation principal
 * (`context.principal.accountId`, Forge function-arguments docs), never an argument. The answer is the tool's
 * JSON object, or `{error, message}`.
 * @param {Record<string, unknown>} payload  the tool inputs (scalars only)
 * @param {{accountId?: string, moduleKey?: string, cloudId?: string, principal?: {accountId?: string}}} context
 * @returns {Promise<object>}
 */
export async function mcp(payload, context) {
  const name = actionName('mcp', [runtimeModuleKey(), context?.moduleKey, /** @type {any} */ (payload)?.context?.moduleKey], payload);
  return safe(() => runTool(deps(), name, payload, accountOf(context)));
}

/**
 * Rovo agent actions: dowser_inbox_list, dowser_proposal_explain, dowser_verdict_record (and
 * dowser_sources_goals, which runs as the MCP tool). The decider is the person chatting with the agent.
 * @param {Record<string, unknown>} payload
 * @param {{accountId?: string, moduleKey?: string, principal?: {accountId?: string}}} context
 * @returns {Promise<object>}
 */
export async function rovo(payload, context) {
  const name = actionName('rovo', [runtimeModuleKey(), context?.moduleKey, /** @type {any} */ (payload)?.context?.moduleKey], payload);
  return safe(() => runRovo(deps(), name, payload, accountOf(context)));
}

/**
 * Forge SQL migrations, run on install and upgrade (trigger dowser-migrate).
 * @param {unknown} _event
 * @returns {Promise<void>}
 */
export async function migrate(_event) {
  const ran = await runMigrations();
  migrated = true;
  console.log(`dowser: migrations ran: ${ran.length ? ran.join(', ') : 'none (up to date)'}`);
}
