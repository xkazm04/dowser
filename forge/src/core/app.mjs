// @ts-check
// The one dispatch door (mcp-tools: "Schemas are contracts; enforcement is the server's"): every MCP tool,
// resolver and Rovo action passes through here, which checks the caller, validates, runs the core and turns a
// failure into `{error, message}`. Forge-free: index.js supplies the Deps and the caller's accountId.
import { getProposal, bylineForPage, inboxSummaries, listInbox, panelForIssue, cardOf, historyOf } from './cards.mjs';
import { mapData, pushAreas } from './areas.mjs';
import { pushProposals } from './push.mjs';
import { sourcesGoals, sourcesPages, sourcesTickets } from './sources.mjs';
import { findProposal, needInbox } from './store.mjs';
import { accept, deciderOf, merge, pullVerdicts, record, reject, snooze } from './verdicts.mjs';
import { AppError, ISSUE_KEY_RE, isObj, needStr, omitAbsent, optStr } from './util.mjs';
import { INBOX_STATUSES } from './types.mjs';
import { LENSES, isOneOf } from '../shared/model.mjs';

/**
 * @typedef {import('./ports.mjs').Deps} Deps
 * @typedef {import('./types.mjs').ToolError} ToolError
 * @typedef {import('./types.mjs').ResolverContract} ResolverContract
 * @typedef {import('./types.mjs').Via} Via
 * @typedef {(deps: Deps, args: Record<string, any>, accountId: string) => Promise<object>} Handler
 */

/** A missing table: the schema is not migrated yet (index.js runs the migrations once and retries). */
export const NO_TABLE_RE = /doesn't exist|no such table|Unknown table/i;

/** The six forge-mcp-2 tools. */
export const TOOL_NAMES = /** @type {const} */ (['dowser_sources_tickets', 'dowser_sources_pages', 'dowser_sources_goals',
  'dowser_proposals_push', 'dowser_verdicts_pull', 'dowser_areas_push']);
/** The Rovo agent actions (dowser_sources_goals is shared with the MCP tools). */
export const ROVO_ACTIONS = /** @type {const} */ (['dowser_inbox_list', 'dowser_proposal_explain', 'dowser_verdict_record']);

/** @type {Record<typeof TOOL_NAMES[number], Handler>} */
const TOOLS = {
  dowser_sources_tickets: (d, a) => sourcesTickets(d, a),
  dowser_sources_pages: (d, a) => sourcesPages(d, a),
  dowser_sources_goals: (d) => sourcesGoals(d),
  dowser_proposals_push: (d, a) => pushProposals(d, a),
  dowser_verdicts_pull: (d, a) => pullVerdicts(d, a),
  dowser_areas_push: (d, a) => pushAreas(d, a),
};

/** @param {string} accountId @param {Via} via */
const who = (accountId, via) => ({ by: deciderOf(accountId), via });

/**
 * Runs `fn` and maps a failure to `{error, message}`: an AppError keeps its code; anything else is logged and
 * answered as `unavailable` (no internals leak to the caller).
 * @param {() => Promise<object>} fn
 * @returns {Promise<object>}
 */
export async function answer(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AppError) return { error: e.code, message: e.message };
    if (NO_TABLE_RE.test(String(/** @type {Error} */ (e)?.message ?? e))) throw e; // the entry point migrates and retries
    console.error('dowser: unexpected failure', e);
    return { error: 'unavailable', message: 'Dowser hit an unexpected error; try again, and report it if it repeats' };
  }
}

/** @param {unknown} accountId @returns {string} */
function needAccount(accountId) {
  if (typeof accountId !== 'string' || !accountId.trim()) {
    throw new AppError('unauthorized', 'no signed-in Atlassian account on this call; sign in again');
  }
  return accountId;
}

/** @param {unknown} payload @returns {Record<string, any>} */
const argsOf = (payload) => (isObj(payload) ? payload : {});

/**
 * A forge-mcp-2 tool call.
 * @param {Deps} deps
 * @param {string | undefined} name
 * @param {unknown} payload
 * @param {unknown} accountId
 * @returns {Promise<object>} the tool's JSON, or `{error, message}`
 */
export function runTool(deps, name, payload, accountId) {
  return answer(async () => {
    const id = needAccount(accountId);
    if (!name || !Object.hasOwn(TOOLS, name)) throw new AppError('bad-input', `unknown tool ${JSON.stringify(name)}`);
    return TOOLS[/** @type {typeof TOOL_NAMES[number]} */ (name)](deps, argsOf(payload), id);
  });
}

/**
 * The resolver handlers (Custom UI). `via` is `panel` for the issue panel module, else `inbox`.
 * @type {{[K in keyof ResolverContract]: (deps: Deps, p: Record<string, any>, accountId: string, via: Via) => Promise<object>}}
 */
export const RESOLVERS = {
  'inbox.list': (d, p) => listInbox(d.db, { project_key: optStr(p, 'project_key'), status: optStr(p, 'status'), lens: optStr(p, 'lens'), cursor: optStr(p, 'cursor') }),
  'proposal.get': (d, p) => getProposal(d.db, needStr(p, 'ref')),
  'verdict.accept': (d, p, id, via) => accept(d, { ref: needStr(p, 'ref'), jira_project_key: optStr(p, 'jira_project_key'), issue_type_id: optStr(p, 'issue_type_id') }, who(id, via)),
  'verdict.reject': (d, p, id, via) => reject(d, { refs: p.refs, reason: p.reason, note: p.note }, who(id, via)),
  'verdict.snooze': (d, p, id, via) => snooze(d, { refs: p.refs }, who(id, via)),
  'verdict.merge': (d, p, id, via) => merge(d, { ref: p.ref, into: p.into }, who(id, via)),
  'settings.get': async (d) => ({ inboxes: await inboxSummaries(d.db) }),
  'settings.set': (d, p) => setSettings(d, p),
  'jira.projects': async (d) => {
    if (!d.jira) throw new AppError('unavailable', 'Jira is not reachable from this module');
    try { return { projects: await d.jira.listProjects() }; } catch (e) {
      throw new AppError('unavailable', `Jira did not list projects (${/** @type {Error} */ (e).message})`);
    }
  },
  'panel.forIssue': (d, p) => {
    const key = needStr(p, 'issue_key');
    if (!ISSUE_KEY_RE.test(key)) throw new AppError('bad-input', `${key} is not a Jira issue key`);
    return panelForIssue(d.db, key);
  },
  'map.data': (d, p) => mapData(d.db, needStr(p, 'project_key')),
  'byline.forPage': (d, p) => bylineForPage(d.db, needStr(p, 'page_id')),
};

/**
 * `settings.set`: the accept target of one inbox.
 * @param {Deps} d
 * @param {Record<string, any>} p
 * @returns {Promise<{inbox: import('./types.mjs').InboxSummary}>}
 */
async function setSettings(d, p) {
  const projectKey = needStr(p, 'project_key');
  const jiraKey = needStr(p, 'jira_project_key');
  const typeId = needStr(p, 'issue_type_id');
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(jiraKey)) throw new AppError('bad-input', `${jiraKey} is not a Jira project key`);
  if (!/^[0-9]{1,32}$/.test(typeId)) throw new AppError('bad-input', 'issue_type_id must be a Jira issue type id');
  await needInbox(d.db, projectKey);
  await d.db.exec('UPDATE inboxes SET jira_project_key = ?, issue_type_id = ? WHERE project_key = ?', [jiraKey, typeId, projectKey]);
  const inbox = (await inboxSummaries(d.db)).find((i) => i.project_key === projectKey);
  return { inbox: /** @type {import('./types.mjs').InboxSummary} */ (inbox) };
}

/**
 * A resolver call. The caller is `context.accountId`; never an argument.
 * @param {Deps} deps
 * @param {string} key
 * @param {unknown} payload
 * @param {unknown} accountId
 * @param {Via} via
 * @returns {Promise<object>}
 */
export function runResolver(deps, key, payload, accountId, via) {
  return answer(async () => {
    const id = needAccount(accountId);
    if (!Object.hasOwn(RESOLVERS, key)) throw new AppError('bad-input', `unknown resolver ${key}`);
    return RESOLVERS[/** @type {keyof ResolverContract} */ (key)](deps, argsOf(payload), id, via);
  });
}

// ------------------------------------------------------------------------------------------------- rovo

/**
 * One compact line of a card for the agent: no body, no evidence.
 * @param {import('./types.mjs').Card} c
 */
const brief = (c) => omitAbsent({
  ref: c.ref, fp: c.fp, project_key: c.project_key, status: c.status, lens: c.lens, title: c.title, rationale: c.rationale,
  confidence: c.confidence, effort: c.effort?.size, evidence_count: c.evidence.length,
  evidence_types: [...new Set(c.evidence.map((e) => e.type))].sort(), reopened: c.reopened, issue_ref: c.issue_ref,
});

/**
 * `dowser_inbox_list`: compact items in inbox policy order (newest push first).
 * @param {Deps} d
 * @param {Record<string, any>} a
 */
async function rovoList(d, a) {
  const status = optStr(a, 'status') ?? 'open';
  const lens = optStr(a, 'lens');
  if (!isOneOf(INBOX_STATUSES, status)) throw new AppError('bad-input', `status must be one of ${INBOX_STATUSES.join(', ')}`);
  if (lens !== undefined && !isOneOf(LENSES, lens)) throw new AppError('bad-input', `lens must be one of ${LENSES.join(', ')}`);
  const limit = a.limit === undefined ? 20 : a.limit;
  if (!Number.isInteger(limit) || limit < 1) throw new AppError('bad-input', 'limit must be an integer >= 1');
  const page = await listInbox(d.db, { project_key: optStr(a, 'project_key'), status, lens });
  const items = page.groups.flatMap((g) => g.items).slice(0, Math.min(limit, 50)).map(brief);
  return { items, inboxes: page.inboxes.map((i) => ({ project_key: i.project_key, open: i.open })) };
}

/**
 * `dowser_proposal_explain`: the full card (body, evidence with links, effort basis, risk) and its history.
 * @param {Deps} d
 * @param {Record<string, any>} a
 */
async function rovoExplain(d, a) {
  const p = await findProposal(d.db, needStr(a, 'ref'));
  const card = await cardOf(d.db, p);
  return { card, history: await historyOf(d.db, p) };
}

/** @type {Record<typeof ROVO_ACTIONS[number], Handler>} */
const ROVO = {
  dowser_inbox_list: rovoList,
  dowser_proposal_explain: rovoExplain,
  dowser_verdict_record: async (d, a, id) => {
    const { card } = await record(d, { ref: a.ref, status: a.status, reason: a.reason, note: a.note, merged_into: a.merged_into }, who(id, 'rovo'));
    return { recorded: card.status, card: brief(card) };
  },
};

/**
 * A Rovo agent action. `dowser_sources_goals` is also an agent action and runs as the tool.
 * @param {Deps} deps
 * @param {string | undefined} name
 * @param {unknown} payload
 * @param {unknown} accountId  the person chatting with the agent
 * @returns {Promise<object>}
 */
export function runRovo(deps, name, payload, accountId) {
  if (name && /** @type {readonly string[]} */ (TOOL_NAMES).includes(name)) return runTool(deps, name, payload, accountId);
  return answer(async () => {
    const id = needAccount(accountId);
    if (!name || !Object.hasOwn(ROVO, name)) throw new AppError('bad-input', `unknown action ${JSON.stringify(name)}`);
    return ROVO[/** @type {typeof ROVO_ACTIONS[number]} */ (name)](deps, argsOf(payload), id);
  });
}


/** @param {unknown} v @param {string} k */
const has = (v, k) => isObj(v) && v[k] !== undefined && v[k] !== null;

/**
 * Which tool or action a call is for. The action key comes from the invocation (`getAppContext().moduleKey`,
 * else a `moduleKey` the platform put on the context or payload). When none of those is a known name (the
 * rovo:mcp docs do not say which key a tool call carries), it is inferred from the argument shape, which is
 * unambiguous across the six tools: proposals_json -> push, areas_json -> areas, query+limit -> tickets,
 * query -> pages, project_key -> pull, nothing -> goals. Rovo: ref+status -> record, ref -> explain, else list.
 * @param {'mcp' | 'rovo'} surface
 * @param {(string | undefined)[]} candidates  moduleKey values in order of trust
 * @param {unknown} payload
 * @returns {string}
 */
export function actionName(surface, candidates, payload) {
  /** @type {readonly string[]} */
  const known = surface === 'mcp' ? TOOL_NAMES : [...ROVO_ACTIONS, 'dowser_sources_goals'];
  for (const c of candidates) if (c && known.includes(c)) return c;
  if (surface === 'mcp') {
    if (has(payload, 'proposals_json')) return 'dowser_proposals_push';
    if (has(payload, 'areas_json')) return 'dowser_areas_push';
    if (has(payload, 'query')) return has(payload, 'limit') ? 'dowser_sources_tickets' : 'dowser_sources_pages';
    if (has(payload, 'project_key')) return 'dowser_verdicts_pull';
    return 'dowser_sources_goals';
  }
  if (has(payload, 'ref')) return has(payload, 'status') ? 'dowser_verdict_record' : 'dowser_proposal_explain';
  return 'dowser_inbox_list';
}
