// @ts-check
// Forge entry points (manifest `function` handlers). Thin: pick the caller and the action key from the
// invocation, build the ports (src/adapters) and hand over to the one dispatch door (src/core/app.mjs).
// The keys and shapes are the contract in src/core/types.mjs and docs/contracts/forge-mcp-2.md.
import ResolverPkg from '@forge/resolver';
import { getAppContext } from '@forge/api';
import { RESOLVERS, actionName, isConsent, isSchemaBehind, resolverAllowed, runResolver, runRovo, runTool } from './core/app.mjs';
import { forgeDb, runMigrations } from './adapters/forge-sql.mjs';
import { schemaGuard, storageFailure } from './sql/schema.mjs';
import { backfillIssueProperties } from './core/issue-property.mjs';
import { onIssueEvent } from './core/delivery.mjs';
import { backfillPageLinks, onPageEvent } from './core/doc-drift.mjs';
import { confluence, installationId, jira, links, perms, sources, users } from './adapters/atlassian.mjs';

// @forge/resolver is CommonJS: tsc (nodenext) sees module.exports, the Forge bundler sees the class.
/** @type {typeof import('@forge/resolver').default} */
const Resolver = /** @type {any} */ (ResolverPkg).default ?? ResolverPkg;

/** @typedef {import('./core/types.mjs').ResolverContract} ResolverContract */
/** @typedef {import('./core/ports.mjs').Deps} Deps */

// The in-request migrate-and-retry rule (sql/schema.mjs schemaGuard): once per installation in this runtime.
const { ensureSchema, withSchema, markMigrated } = schemaGuard({ runMigrations, installationId, isSchemaBehind });

/** @returns {Deps} */
const deps = () => ({ db: forgeDb, jira, confluence, sources, links, users, perms, now: () => new Date(), ensureSchema });

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
 * Runs the core; a thrown error (only a schema that is behind, or a missing user grant, escapes `answer`) still
 * answers `{error, message}`. A Custom UI resolver (`consent`) rethrows a missing grant so Forge shows its
 * consent screen; an MCP or Rovo caller, which has none, gets `unauthorized`.
 * @param {() => Promise<object>} fn
 * @param {boolean} [consent]
 */
const safe = async (fn, consent = false) => {
  try { return await withSchema(fn); } catch (e) {
    if (isConsent(e)) {
      if (consent) throw e;
      return { error: 'unauthorized', message: 'Dowser needs your permission to read Jira on your behalf; open Dowser in Jira once and allow access' };
    }
    console.error(JSON.stringify(storageFailure(e)));
    return { error: 'unavailable', message: 'Dowser storage is not ready; try again in a minute' };
  }
};

const resolver = new Resolver();
// Every core resolver is defined, so a key added to RESOLVERS cannot be left off a hand-kept list here
// (MODULE_KEYS still decides which module may call it).
const KEYS = /** @type {(keyof ResolverContract)[]} */ (Object.keys(RESOLVERS));
for (const key of KEYS) {
  resolver.define(key, async ({ payload, context }) => {
    // The issue panel is the only surface that decides from inside an issue; everything else is the inbox.
    const via = context?.extension?.type === 'jira:issuePanel' || context?.moduleKey === 'dowser-evidence' ? 'panel' : 'inbox';
    /** @type {Record<string, unknown>} */
    const p = { ...(payload ?? {}) };
    // Each module may call only the keys its own screen uses (core/app.mjs MODULE_KEYS).
    const type = context?.extension?.type;
    const module = context?.moduleKey
      ?? (type === 'jira:issuePanel' ? 'dowser-evidence' : type === 'confluence:contentBylineItem' ? 'dowser-doc-impact'
        : type === 'confluence:pageBanner' ? 'dowser-doc-banner' : type === 'jira:globalPage' ? 'dowser-inbox' : runtimeModuleKey());
    if (!resolverAllowed(module, key)) {
      console.log(JSON.stringify({ dowser: 'module-denied', module: module ?? 'unknown', key }));
      return { error: 'bad-input', message: `${key} is not available from this Dowser view` };
    }
    // The panel and byline may omit their subject; the module context names it.
    if (key === 'panel.forIssue' && p.issue_key === undefined) p.issue_key = context?.extension?.issue?.key;
    if ((key === 'byline.forPage' || key === 'byline.draftFix') && p.page_id === undefined) p.page_id = context?.extension?.content?.id;
    return safe(() => runResolver(deps(), key, p, context?.accountId, via), true);
  });
}

/** Custom UI resolver (jira:globalPage, jira:issuePanel, confluence:contentBylineItem). */
export const handler = resolver.getDefinitions();
export { handler as resolver };

/**
 * rovo:mcp tools (forge-mcp-2). Every tool is an `action` routed to this one function. The action key is
 * `getAppContext().moduleKey` (@forge/api runtime typings), else a `moduleKey` on the context or on
 * `payload.context`, else inferred from the argument shape (core/app.mjs `actionName`). `payload.context` is set by
 * the platform, not the model (Forge rovo-action docs: "done deterministically"); the model fills only the declared
 * inputs, and no action declares one named `context`. The caller is the invocation principal
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
 * Confluence page edits for doc-drift closure (trigger dowser-page-events; core/doc-drift.mjs). Every page update on
 * the site arrives (Confluence triggers cannot filter on app data); an unlinked page costs one indexed read.
 * @param {Record<string, any>} event
 * @returns {Promise<void>}
 */
export async function pageEvent(event) {
  try {
    await withSchema(async () => onPageEvent(deps(), event));
  } catch (e) {
    console.error(`dowser: page event failed (${String(/** @type {any} */ (e)?.message ?? e).slice(0, 200)})`);
  }
}

/**
 * Jira issue events for delivery truth (triggers dowser-issue-events, dowser-issue-deleted; core/delivery.mjs). The
 * manifest filter already limits them to Dowser's issues. Never throws: a failure is logged.
 * @param {Record<string, any>} event
 * @returns {Promise<void>}
 */
export async function issueEvent(event) {
  try {
    await withSchema(async () => onIssueEvent(deps(), event));
  } catch (e) {
    console.error(`dowser: issue event failed (${String(/** @type {any} */ (e)?.message ?? e).slice(0, 200)})`);
  }
}

/**
 * Forge SQL migrations, run on install and upgrade (trigger dowser-migrate) and daily (dowser-migrate-daily),
 * then the Jira issue-property backfill (core/issue-property.mjs) and the page-link backfill (core/doc-drift.mjs):
 * each best effort and logged on its own, never failing the trigger.
 * @param {unknown} _event
 * @returns {Promise<void>}
 */
export async function migrate(_event) {
  const ran = await runMigrations();
  markMigrated();
  console.log(`dowser: migrations ran: ${ran.length ? ran.join(', ') : 'none (up to date)'}`);
  // independent jobs: each runs and reports on its own, whatever the other did
  try {
    const b = await backfillIssueProperties(deps());
    if (b.written || b.failed) console.log(JSON.stringify({ dowser: 'issue-property-backfill', ...b }));
  } catch (e) {
    console.error(`dowser: issue-property backfill failed (${String(/** @type {any} */ (e)?.message ?? e).slice(0, 200)})`);
  }
  try {
    const l = await backfillPageLinks(deps());
    if (l.linked) console.log(JSON.stringify({ dowser: 'page-links-backfill', ...l }));
  } catch (e) {
    console.error(`dowser: page-links backfill failed (${String(/** @type {any} */ (e)?.message ?? e).slice(0, 200)})`);
  }
}
