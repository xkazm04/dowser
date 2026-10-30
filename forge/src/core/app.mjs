// @ts-check
// The one dispatch door (mcp-tools: "Schemas are contracts; enforcement is the server's"): every MCP tool,
// resolver and Rovo action passes through here, which checks the caller, validates, runs the core and turns a
// failure into `{error, message}`. Forge-free: index.js supplies the Deps and the caller's accountId.
import { getProposal, bylineForPage, inboxSummaries, listInbox, panelForIssue, cardOf, historyOf } from './cards.mjs';
import { mapData, pushAreas } from './areas.mjs';
import { pushProposals } from './push.mjs';
import { observed } from './observe.mjs';
import { outcomeRecord, reflectData, reflectSync, ruleDecide } from './reflect.mjs';
import { sourcesGoals, sourcesPages, sourcesTickets } from './sources.mjs';
import { directionGet, directionSet, directionTool } from './direction.mjs';
import { getInbox } from './store.mjs';
import { accept, deciderOf, merge, pullVerdicts, record, reject, snooze } from './verdicts.mjs';
import { accessFor } from './access.mjs';
import { AppError, FP_RE, ISSUE_KEY_RE, isObj, needStr, omitAbsent, optStr } from './util.mjs';
import { INBOX_STATUSES, REF_RE } from './types.mjs';
import { LENSES, isOneOf } from '../shared/model.mjs';

/**
 * @typedef {import('./ports.mjs').Deps} Deps
 * @typedef {import('./types.mjs').ToolError} ToolError
 * @typedef {import('./types.mjs').ResolverContract} ResolverContract
 * @typedef {import('./types.mjs').Via} Via
 * @typedef {import('./access.mjs').Access} Access
 * @typedef {(deps: Deps, args: Record<string, any>, accountId: string, acc: Access) => Promise<object>} Handler
 */

const SCHEMA_BEHIND_RE = /doesn't exist|no such table|Unknown table|no such column|Unknown column/i;

/**
 * A missing table or column: the schema is not migrated yet (index.js runs the migrations once and retries).
 * A minor-version deploy fires no upgrade event, so a migration that only adds a column (v016, v017) reaches
 * the site this way too. Forge SQL throws `Unknown SQL execution error` with the real cause only in
 * `context.debug` (ER_NO_SUCH_TABLE 1146, ER_BAD_FIELD_ERROR 1054), node:sqlite puts it in the message, so
 * both are read.
 * @param {unknown} e
 * @returns {boolean}
 */
export function isSchemaBehind(e) {
  const err = /** @type {any} */ (e);
  const debug = err?.context?.debug;
  if (debug?.code === 'ER_NO_SUCH_TABLE' || debug?.errno === 1146) return true;
  if (debug?.code === 'ER_BAD_FIELD_ERROR' || debug?.errno === 1054) return true;
  return SCHEMA_BEHIND_RE.test(`${String(err?.message ?? err)} ${String(debug?.message ?? '')}`);
}

/** The eight forge-mcp-2 tools (reflect_sync and direction_get are additive to the original six). */
export const TOOL_NAMES = /** @type {const} */ (['dowser_sources_tickets', 'dowser_sources_pages', 'dowser_sources_goals',
  'dowser_proposals_push', 'dowser_verdicts_pull', 'dowser_areas_push', 'dowser_reflect_sync', 'dowser_direction_get']);
/** The Rovo agent actions (dowser_sources_goals is shared with the MCP tools). */
export const ROVO_ACTIONS = /** @type {const} */ (['dowser_inbox_list', 'dowser_proposal_explain', 'dowser_verdict_record']);

// ------------------------------------------------------------------------------------------------ access
// Every handler below opens its inbox through `acc` (core/access.mjs) before it reads or writes: by project key,
// by item ref, or as the list of inboxes the caller may see. The scan-source tools read Jira and Confluence as
// the caller and touch no inbox.

/** @param {Access} acc @param {Record<string, any>} a */
const openProject = (acc, a) => acc.inbox(needStr(a, 'project_key'));

/** @param {Deps} d @param {Access} acc @param {Record<string, any>} a */
async function openIfExists(d, acc, a) {
  if (typeof a.project_key === 'string' && (await getInbox(d.db, a.project_key))) await openProject(acc, a);
}

/** Every ref of a bulk decision must be openable; a non-string is left to the handler's own validation. */
/** @param {Access} acc @param {unknown} refs */
async function openRefs(acc, refs) {
  if (Array.isArray(refs)) for (const r of refs) if (typeof r === 'string') await acc.proposal(r);
}

/**
 * Jira writes run as the app (accept creates the issue, merge comments on one), so the caller's own Jira
 * permission is checked first: a person may only make the app do what they could do themselves.
 * @param {Access} acc
 * @param {string} perm  CREATE_ISSUES | ADD_COMMENTS
 * @param {{projectKey?: string, issueKey?: string}} on
 */
async function needJira(acc, perm, on) {
  if (await acc.may(perm, on)) return;
  const what = perm === 'CREATE_ISSUES' ? `create issues in Jira project ${on.projectKey}` : `comment on ${on.issueKey}`;
  throw new AppError('forbidden', `You do not have permission to ${what}, so Dowser will not do it for you`);
}

/**
 * Accept: the item must be openable and the caller must be allowed to create an issue in the target project
 * (the one passed with the accept, else the inbox setting; with neither, `accept` explains what is missing).
 * @param {Deps} d @param {Access} acc @param {string} ref @param {string | undefined} jiraProjectKey
 */
async function openAccept(d, acc, ref, jiraProjectKey) {
  const p = await acc.proposal(ref);
  const target = jiraProjectKey ?? (await getInbox(d.db, p.project_key))?.jira_project_key;
  if (target) await needJira(acc, 'CREATE_ISSUES', { projectKey: target });
}

/**
 * Merge: the item must be openable; the target is either another item (which must be openable too; `merge`
 * keeps it in the same inbox) or a Jira issue the caller may comment on.
 * @param {Access} acc @param {unknown} ref @param {unknown} into
 */
async function openMerge(acc, ref, into) {
  if (typeof ref !== 'string') return;
  await acc.proposal(ref);
  if (typeof into !== 'string') return;
  if (!REF_RE.test(into) && !FP_RE.test(into) && ISSUE_KEY_RE.test(into)) await needJira(acc, 'ADD_COMMENTS', { issueKey: into });
  else if (REF_RE.test(into) || FP_RE.test(into)) await acc.proposal(into);
}

/** @type {Record<typeof TOOL_NAMES[number], Handler>} */
const TOOLS = {
  dowser_sources_tickets: (d, a) => sourcesTickets(d, a),
  dowser_sources_pages: (d, a) => sourcesPages(d, a),
  dowser_sources_goals: (d) => sourcesGoals(d),
  // A first push (of proposals or areas) creates the inbox, stamped with the caller as its creator; a push to an
  // inbox that exists needs access to it.
  dowser_proposals_push: async (d, a, id, acc) => { await openIfExists(d, acc, a); return pushProposals(d, a, id); },
  dowser_verdicts_pull: async (d, a, _, acc) => { await openProject(acc, a); return pullVerdicts(d, a); },
  dowser_areas_push: async (d, a, id, acc) => { await openIfExists(d, acc, a); return pushAreas(d, a, id); },
  dowser_reflect_sync: async (d, a, _, acc) => { await openProject(acc, a); return reflectSync(d, a); },
  dowser_direction_get: async (d, a, _, acc) => { await openProject(acc, a); return directionTool(d, a); },
};

/** @param {string} accountId @param {Via} via */
const who = (accountId, via) => ({ by: deciderOf(accountId), via });

/**
 * A missing user grant for an as-user call: @forge/api `NeedsAuthenticationError`, whose `name` is
 * `NEEDS_AUTHENTICATION_ERR` (out/api/errors.js), matched by name so the core stays Forge-free. It escapes
 * `answer` so a Custom UI resolver can let Forge show its consent screen.
 * @param {unknown} e
 */
export const isConsent = (e) => /** @type {any} */ (e)?.name === 'NEEDS_AUTHENTICATION_ERR';

/**
 * Runs `fn` and maps a failure to `{error, message}`: an AppError keeps its code; anything else is logged by its
 * name and code only (an error's message can carry Jira response text or SQL detail) and answered as
 * `unavailable` (no internals leak to the caller).
 * @param {() => Promise<object>} fn
 * @returns {Promise<object>}
 */
export async function answer(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AppError) return { error: e.code, message: e.message };
    if (isSchemaBehind(e) || isConsent(e)) throw e; // the entry point migrates and retries / asks for consent
    const err = /** @type {any} */ (e);
    console.error(`dowser: unexpected failure (${String(err?.name ?? typeof e)}${err?.code ? ` ${String(err.code)}` : ''})`);
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
  return observed(deps, 'tool', name, payload, () => answer(async () => {
    const id = needAccount(accountId);
    if (!name || !Object.hasOwn(TOOLS, name)) throw new AppError('bad-input', `unknown tool ${JSON.stringify(name)}`);
    return TOOLS[/** @type {typeof TOOL_NAMES[number]} */ (name)](deps, argsOf(payload), id, accessFor(deps, id));
  }));
}

/**
 * The resolver handlers (Custom UI). `via` is `panel` for the issue panel module, else `inbox`.
 * @type {{[K in keyof ResolverContract]: (deps: Deps, p: Record<string, any>, accountId: string, via: Via, acc: Access) => Promise<object>}}
 */
export const RESOLVERS = {
  'inbox.list': async (d, p, _, __, acc) => {
    const project = optStr(p, 'project_key');
    if (project) await acc.inbox(project);
    if (p.pretriaged !== undefined && typeof p.pretriaged !== 'boolean') throw new AppError('bad-input', 'pretriaged must be true or false');
    return listInbox(d.db, { project_key: project, status: optStr(p, 'status'), lens: optStr(p, 'lens'), cursor: optStr(p, 'cursor'), pretriaged: p.pretriaged === true || undefined, visible: await acc.visibleKeys() });
  },
  'proposal.get': async (d, p, _, __, acc) => { await acc.proposal(needStr(p, 'ref')); return getProposal(d, needStr(p, 'ref')); },
  'verdict.accept': async (d, p, id, via, acc) => {
    await openAccept(d, acc, needStr(p, 'ref'), optStr(p, 'jira_project_key'));
    return accept(d, { ref: needStr(p, 'ref'), jira_project_key: optStr(p, 'jira_project_key'), issue_type_id: optStr(p, 'issue_type_id'), note: p.note }, who(id, via));
  },
  'verdict.reject': async (d, p, id, via, acc) => { await openRefs(acc, p.refs); return reject(d, { refs: p.refs, reason: p.reason, note: p.note }, who(id, via)); },
  'verdict.snooze': async (d, p, id, via, acc) => { await openRefs(acc, p.refs); return snooze(d, { refs: p.refs, note: p.note, until: p.until }, who(id, via)); },
  'verdict.merge': async (d, p, id, via, acc) => { await openMerge(acc, p.ref, p.into); return merge(d, { ref: p.ref, into: p.into }, who(id, via)); },
  'settings.get': async (d, _, __, ___, acc) => ({ inboxes: await inboxSummaries(d.db, await acc.visibleKeys()) }),
  'settings.set': (d, p, _, __, acc) => setSettings(d, p, acc),
  'jira.projects': async (d) => {
    if (!d.jira) throw new AppError('unavailable', 'Jira is not reachable from this module');
    try { return { projects: await d.jira.listProjects() }; } catch (e) {
      if (isConsent(e)) throw e;
      throw new AppError('unavailable', `Jira did not list projects (${/** @type {Error} */ (e).message})`);
    }
  },
  // The panel shows an item only to someone who may open its inbox; anyone else sees the empty panel.
  'panel.forIssue': async (d, p, _, __, acc) => {
    const key = needStr(p, 'issue_key');
    if (!ISSUE_KEY_RE.test(key)) throw new AppError('bad-input', `${key} is not a Jira issue key`);
    const out = await panelForIssue(d, key);
    if (out.card && !(await acc.visibleKeys()).includes(out.card.project_key)) return { history: [] };
    return out;
  },
  'map.data': async (d, p, _, __, acc) => { await openProject(acc, p); return mapData(d.db, needStr(p, 'project_key')); },
  'byline.forPage': async (d, p, _, __, acc) => bylineForPage(d.db, needStr(p, 'page_id'), await acc.visibleKeys()),
  'reflect.data': async (d, p, _, __, acc) => { await openProject(acc, p); return reflectData(d, p); },
  'rule.decide': async (d, p, id, _, acc) => { await openProject(acc, p); return ruleDecide(d, p, id); },
  'outcome.record': async (d, p, id, _, acc) => { await acc.proposal(needStr(p, 'ref')); return outcomeRecord(d, p, id); },
  'direction.get': async (d, p, _, __, acc) => { await openProject(acc, p); return directionGet(d, p); },
  'direction.set': async (d, p, id, _, acc) => { await openProject(acc, p); return directionSet(d, p, id); },
};

/**
 * `settings.set`: the accept target of one inbox. Setting it also decides who may open the inbox from now on
 * (core/access.mjs), so the caller must be able to open the inbox now AND to browse and create issues in the new
 * project: nobody can move an inbox into a project they could not use themselves.
 * @param {Deps} d
 * @param {Record<string, any>} p
 * @param {Access} acc
 * @returns {Promise<{inbox: import('./types.mjs').InboxSummary}>}
 */
async function setSettings(d, p, acc) {
  const projectKey = needStr(p, 'project_key');
  const jiraKey = needStr(p, 'jira_project_key');
  const typeId = needStr(p, 'issue_type_id');
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(jiraKey)) throw new AppError('bad-input', `${jiraKey} is not a Jira project key`);
  if (!/^[0-9]{1,32}$/.test(typeId)) throw new AppError('bad-input', 'issue_type_id must be a Jira issue type id');
  await acc.inbox(projectKey);
  if (!(await acc.may('BROWSE_PROJECTS', { projectKey: jiraKey }))) throw new AppError('forbidden', `You cannot browse Jira project ${jiraKey}, so it cannot be this inbox's project`);
  await needJira(acc, 'CREATE_ISSUES', { projectKey: jiraKey });
  await d.db.exec('UPDATE inboxes SET jira_project_key = ?, issue_type_id = ? WHERE project_key = ?', [jiraKey, typeId, projectKey]);
  const inbox = (await inboxSummaries(d.db, [projectKey]))[0];
  return { inbox: /** @type {import('./types.mjs').InboxSummary} */ (inbox) };
}

/**
 * The resolver keys each Custom UI module may call: the ones its own screen uses (static/app/src/routes). The
 * issue panel and the Confluence byline are read-only views of one issue or page; the inbox global page holds
 * every other screen. An unknown module may call nothing.
 * @type {Record<string, readonly string[]>}
 */
export const MODULE_KEYS = Object.freeze({
  'dowser-evidence': ['panel.forIssue'],
  'dowser-doc-impact': ['byline.forPage'],
  'dowser-inbox': Object.keys(RESOLVERS).filter((k) => k !== 'panel.forIssue' && k !== 'byline.forPage'),
});

/** @param {string | undefined} moduleKey @param {string} key */
export const resolverAllowed = (moduleKey, key) => Boolean(moduleKey && Object.hasOwn(MODULE_KEYS, moduleKey) && MODULE_KEYS[moduleKey].includes(key));

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
  return observed(deps, 'resolver', key, payload, () => answer(async () => {
    const id = needAccount(accountId);
    if (!Object.hasOwn(RESOLVERS, key)) throw new AppError('bad-input', `unknown resolver ${key}`);
    return RESOLVERS[/** @type {keyof ResolverContract} */ (key)](deps, argsOf(payload), id, via, accessFor(deps, id));
  }));
}

// ------------------------------------------------------------------------------------------------- rovo

/**
 * One compact line of a card for the agent: no body, no evidence.
 * @param {import('./types.mjs').Card} c
 */
const brief = (c) => omitAbsent({
  ref: c.ref, fp: c.fp, project_key: c.project_key, status: c.status, lens: c.lens, title: c.title, rationale: c.rationale,
  confidence: c.confidence, effort: c.effort?.size, score: c.score, band: c.band, mvp: c.mvp, evidence_count: c.evidence.length,
  evidence_types: [...new Set(c.evidence.map((e) => e.type))].sort(), reopened: c.reopened, issue_ref: c.issue_ref,
});

/**
 * `dowser_inbox_list`: compact items in inbox policy order (newest push first).
 * @param {Deps} d
 * @param {Record<string, any>} a
 * @param {string} _
 * @param {Access} acc
 */
async function rovoList(d, a, _, acc) {
  const status = optStr(a, 'status') ?? 'open';
  const lens = optStr(a, 'lens');
  if (!isOneOf(INBOX_STATUSES, status)) throw new AppError('bad-input', `status must be one of ${INBOX_STATUSES.join(', ')}`);
  if (lens !== undefined && !isOneOf(LENSES, lens)) throw new AppError('bad-input', `lens must be one of ${LENSES.join(', ')}`);
  const limit = a.limit === undefined ? 20 : a.limit;
  if (!Number.isInteger(limit) || limit < 1) throw new AppError('bad-input', 'limit must be an integer >= 1');
  const project = optStr(a, 'project_key');
  if (project) await acc.inbox(project);
  const page = await listInbox(d.db, { project_key: project, status, lens, visible: await acc.visibleKeys() });
  const items = page.groups.flatMap((g) => g.items).slice(0, Math.min(limit, 50)).map(brief);
  return { items, inboxes: page.inboxes.map((i) => ({ project_key: i.project_key, open: i.open })) };
}

/**
 * `dowser_proposal_explain`: the full card (body, evidence with links, effort basis, risk) and its history.
 * @param {Deps} d
 * @param {Record<string, any>} a
 * @param {string} _
 * @param {Access} acc
 */
async function rovoExplain(d, a, _, acc) {
  const p = await acc.proposal(needStr(a, 'ref'));
  const card = await cardOf(d.db, p);
  return { card, history: await historyOf(d.db, p) };
}

/** @type {Record<typeof ROVO_ACTIONS[number], Handler>} */
const ROVO = {
  dowser_inbox_list: rovoList,
  dowser_proposal_explain: rovoExplain,
  dowser_verdict_record: async (d, a, id, acc) => {
    if (a.status === 'merged') await openMerge(acc, a.ref, a.merged_into);
    else if (a.status === 'accepted' && typeof a.ref === 'string') await openAccept(d, acc, a.ref, undefined);
    else await openRefs(acc, [a.ref]);
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
  return observed(deps, 'rovo', name, payload, () => answer(async () => {
    const id = needAccount(accountId);
    if (!name || !Object.hasOwn(ROVO, name)) throw new AppError('bad-input', `unknown action ${JSON.stringify(name)}`);
    return ROVO[/** @type {typeof ROVO_ACTIONS[number]} */ (name)](deps, argsOf(payload), id, accessFor(deps, id));
  }));
}


/** @param {unknown} v @param {string} k */
const has = (v, k) => isObj(v) && v[k] !== undefined && v[k] !== null;

/**
 * Which tool or action a call is for. The action key comes from the invocation (`getAppContext().moduleKey`,
 * else a `moduleKey` the platform put on the context or payload). When none of those is a known name (the
 * rovo:mcp docs do not say which key a tool call carries), it is inferred from the argument shape, which is
 * unambiguous across the eight tools: proposals_json -> push, areas_json -> areas, rules_json -> reflect,
 * lens -> direction, query+limit -> tickets, query -> pages, project_key -> pull, nothing -> goals. A reflect
 * call without rules_json, or a direction call without lens, looks like a pull by shape alone, so callers send
 * `rules_json: "[]"` and `lens: "all"` (the skill does). Rovo: ref+status -> record, ref -> explain, else list.
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
    if (has(payload, 'rules_json')) return 'dowser_reflect_sync';
    if (has(payload, 'lens')) return 'dowser_direction_get';
    if (has(payload, 'query')) return has(payload, 'limit') ? 'dowser_sources_tickets' : 'dowser_sources_pages';
    if (has(payload, 'project_key')) return 'dowser_verdicts_pull';
    return 'dowser_sources_goals';
  }
  if (has(payload, 'ref')) return has(payload, 'status') ? 'dowser_verdict_record' : 'dowser_proposal_explain';
  return 'dowser_inbox_list';
}
