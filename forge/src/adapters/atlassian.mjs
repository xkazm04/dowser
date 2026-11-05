// @ts-check
// The Jira, Sources and Links ports over @forge/api 8.x (checked against node_modules/@forge/api/out/index.d.ts):
//  - `asApp()` / `asUser()` return `requestJira` / `requestConfluence` taking a `route` tagged template;
//    `requestTeamworkGraph(query, variables)` exists on `asUser()` only (AsUserFetchMethods), not on asApp.
//  - `getAppContext()` (out/api/runtime.d.ts) gives `appAri.appId`, `environmentAri.environmentId`, `moduleKey`.
//
// Who calls as whom:
//  - Accept / merge comment and the `dowser` issue property: AS APP (design F5: the issue is created by the app),
//    but only after the dispatch door has checked the person's own CREATE_ISSUES / ADD_COMMENTS through `perms`
//    (core/app.mjs).
//  - Permissions (`perms`), the project list, issue statuses, tickets / pages / goals and the Draft-the-fix footer
//    comment: AS USER, so a person only ever sees (and writes) what they may in Jira and Confluence: an issue in a
//    project the viewer cannot browse shows no status (the Teamwork Graph API is user-only anyway). A missing user
//    grant is rethrown as is from `perms` and the project list (a Custom UI surface lets Forge show its consent
//    screen) and surfaces as `unauthorized` from the scan sources (an MCP caller has no consent screen).
//  - Display names: AS APP (read-only, for deciders of items the person already opened).
//
// REST endpoints used (developer.atlassian.com/cloud/jira/platform/rest/v3, /cloud/confluence/rest/v1 and v2,
// /platform/forge/call-the-teamwork-graph-api):
//   GET  /rest/api/3/serverInfo                         -> baseUrl (site URL for browse and inbox links; asApp)
//   POST /rest/api/3/issue                              -> {key} (asApp)
//   POST /rest/api/3/issue/{key}/comment                (asApp)
//   PUT  /rest/api/3/issue/{key}/properties/{property}  -> the `dowser` issue property (asApp)
//   GET  /rest/api/3/project/search?expand=issueTypes   (asUser)
//   POST /rest/api/3/issue/bulkfetch                    -> issue statuses (asUser; a hidden or deleted key is absent)
//   POST /rest/api/3/search/jql                         -> scan tickets (asUser; the enhanced JQL search, /search is retired)
//   GET  /rest/api/3/user/bulk?accountId=&accountId=    -> display names (asApp, read:jira-user)
//   GET  /rest/api/3/mypermissions?permissions=&projectKey=|issueKey=  -> {permissions: {KEY: {havePermission}}} (asUser)
//   GET  /wiki/rest/api/content/search?cql=&expand=body.storage,version  (asUser)
//   POST /wiki/api/v2/footer-comments                   -> Draft the fix (asUser, write:comment:confluence)
//   Teamwork Graph cypherQuery (requestTeamworkGraph)   -> goals (asUser)
import * as forgeApi from '@forge/api';
import { htmlToText, trimText } from '../core/adf.mjs';
import { BODY_MAX, TICKET_FIELDS, ticketItem } from '../core/sources.mjs';
import { AppError, ISSUE_KEY_RE, errTag, omitAbsent } from '../core/util.mjs';

/**
 * @typedef {import('../core/ports.mjs').Jira} Jira
 * @typedef {import('../core/ports.mjs').Sources} Sources
 * @typedef {import('../core/ports.mjs').Links} Links
 * @typedef {import('../core/ports.mjs').Users} Users
 * @typedef {import('../core/ports.mjs').Perms} Perms
 * @typedef {import('../core/ports.mjs').SourceItem} SourceItem
 * @typedef {import('@forge/api').APIResponse} APIResponse
 */

/**
 * The @forge/api calls this adapter makes, behind one object so a test can script the product's answers
 * (test/adapters.test.mjs) without the Forge runtime. Production never swaps it.
 * @type {{asApp: typeof forgeApi.asApp, asUser: typeof forgeApi.asUser, getAppContext: typeof forgeApi.getAppContext,
 *   route: typeof forgeApi.route, NeedsAuthenticationError: typeof forgeApi.NeedsAuthenticationError}}
 */
const api = {
  asApp: forgeApi.asApp, asUser: forgeApi.asUser, getAppContext: forgeApi.getAppContext, route: forgeApi.route,
  NeedsAuthenticationError: forgeApi.NeedsAuthenticationError,
};

/**
 * Test seam: replaces some of the @forge/api calls; answers a function that restores them.
 * @param {Partial<typeof api>} over
 * @returns {() => void}
 */
export function useForgeApi(over) {
  const before = { ...api };
  Object.assign(api, over);
  return () => { Object.assign(api, before); };
}

/**
 * The JSON of a product response, or a thrown Error naming the status (the core maps it to `unavailable`);
 * 401 becomes `unauthorized`. The response body stays out of the error: it can quote issue or page content,
 * and errors reach the logs and the person.
 * @param {APIResponse} res
 * @param {string} what
 * @returns {Promise<any>}
 */
async function json(res, what) {
  if (res.ok) return res.status === 204 ? {} : res.json();
  if (res.status === 401) throw new AppError('unauthorized', `${what} refused the credentials (401); sign in again`);
  throw httpError(`${what} answered ${res.status}`, res.status);
}

/**
 * An Error naming a product call and its HTTP status, with `status` set so the core can say which status it was
 * without quoting the message (core/util.mjs errTag).
 * @param {string} message @param {number} status
 */
const httpError = (message, status) => Object.assign(new Error(message), { status });

/**
 * Runs a user-context call; a missing user grant becomes `unauthorized`.
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function asPerson(fn) {
  try { return await fn(); } catch (e) {
    if (e instanceof api.NeedsAuthenticationError) throw new AppError('unauthorized', 'Dowser needs your permission to read on your behalf; allow access and retry');
    throw e;
  }
}

/** The installation this invocation runs for; a warm runtime may serve more than one. */
export function installationId() {
  try { return api.getAppContext().installationAri?.installationId ?? ''; } catch { return ''; }
}

/** @type {Map<string, string>} installation id -> site URL */
const siteCache = new Map();

/** The site URL (`https://acme.atlassian.net`), cached per installation for the life of the runtime. */
export async function siteUrl() {
  const inst = installationId();
  let url = inst ? siteCache.get(inst) : undefined;
  if (!url) {
    const info = await json(await api.asApp().requestJira(api.route`/rest/api/3/serverInfo`), 'Jira serverInfo');
    url = String(info.baseUrl).replace(/\/+$/, '');
    if (inst) siteCache.set(inst, url);
  }
  return url;
}

/** @type {Perms} */
export const perms = {
  async mine(keys, on) {
    const q = new URLSearchParams({ permissions: keys.join(',') });
    if (on?.projectKey) q.set('projectKey', on.projectKey);
    if (on?.issueKey) q.set('issueKey', on.issueKey);
    const res = await api.asUser().requestJira(api.route`/rest/api/3/mypermissions?${q}`);
    /** @type {Record<string, boolean>} */
    const out = Object.fromEntries(keys.map((k) => [k, false]));
    // A project or issue the person cannot see (or that does not exist) answers 404: no permission at all.
    if (res.status === 404) return out;
    const body = await json(res, 'Jira permissions');
    for (const k of keys) out[k] = body?.permissions?.[k]?.havePermission === true;
    return out;
  },
};

/** @type {Links} */
export const links = {
  // The Dowser global page, inbox route, focused on one item. The global-page URL shape
  // (`/jira/apps/<appId>/<envId>/<route>`) is the documented one for jira:globalPage; the `ref` query is read by
  // the inbox route.
  async inboxUrl(ref) {
    const ctx = api.getAppContext();
    return `${await siteUrl()}/jira/apps/${ctx.appAri.appId}/${ctx.environmentAri.environmentId}/inbox?ref=${encodeURIComponent(ref)}`;
  },
  // The rovo:mcp server a coding agent connects to: one URL per app (the setup checklist shows it).
  mcpUrl() {
    try {
      const appId = api.getAppContext().appAri?.appId;
      return appId ? `https://mcp.atlassian.com/forge/${appId}` : undefined;
    } catch { return undefined; }
  },
};

/** @type {Jira} */
export const jira = {
  async createIssue({ projectKey, issueTypeId, summary, description, labels }) {
    /** @param {boolean} withLabels */
    const post = (withLabels) => api.asApp().requestJira(api.route`/rest/api/3/issue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ fields: { project: { key: projectKey }, issuetype: { id: issueTypeId }, summary, description, ...(withLabels ? { labels } : {}) } }),
    });
    let res = await post(Boolean(labels?.length));
    // A project whose create screen has no Labels field answers 400 to a label; the sample issue is then created
    // without it (its description still opens with the sample line), rather than failing the accept.
    if (res.status === 400 && labels?.length) res = await post(false);
    const out = await json(res, 'Jira create issue');
    const key = String(out.key);
    return { key, url: `${await siteUrl()}/browse/${key}` };
  },
  async addComment(issueKey, body) {
    const res = await api.asApp().requestJira(api.route`/rest/api/3/issue/${issueKey}/comment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ body }),
    });
    await json(res, `Jira comment on ${issueKey}`);
  },
  async listProjects() {
    /** @type {{key: string, name: string, issue_types: {id: string, name: string}[]}[]} */
    const out = [];
    for (let startAt = 0; startAt < 1000;) {
      const q = new URLSearchParams({ expand: 'issueTypes', maxResults: '50', startAt: String(startAt) });
      const page = await json(await api.asUser().requestJira(api.route`/rest/api/3/project/search?${q}`), 'Jira project search');
      for (const p of /** @type {any[]} */ (page.values ?? [])) {
        out.push({
          key: String(p.key), name: String(p.name),
          issue_types: (p.issueTypes ?? []).filter((/** @type {any} */ t) => !t.subtask).map((/** @type {any} */ t) => ({ id: String(t.id), name: String(t.name) })),
        });
      }
      if (page.isLast !== false || !(page.values ?? []).length) break;
      startAt += page.values.length;
    }
    return out;
  },
  async setIssueProperty(issueKey, key, value) {
    if (!ISSUE_KEY_RE.test(issueKey)) throw new Error(`not an issue key: ${issueKey}`);
    const res = await api.asApp().requestJira(api.route`/rest/api/3/issue/${issueKey}/properties/${key}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(value),
    });
    // the status rides on the error: a 404 (issue deleted or moved) is final for core/issue-property.mjs
    if (!res.ok) throw httpError(`Jira set issue property on ${issueKey} answered ${res.status}`, res.status);
  },
  // Read AS THE USER: the Learning tab must not show the status of an issue in a project the viewer cannot browse
  // (an accept may target any project the accepter could create in). A key the user cannot see is simply absent.
  async issueStatuses(keys) {
    /** @type {Record<string, {name: string, category: 'new' | 'indeterminate' | 'done'}>} */
    const out = {};
    const valid = [...new Set(keys)].filter((k) => ISSUE_KEY_RE.test(k));
    // Bulk fetch, not `key in (...)` JQL: JQL answers 400 for the whole query when one listed key is deleted or not
    // visible, while bulkfetch simply leaves such an issue out, so one unreadable key costs only its own status.
    for (let i = 0; i < valid.length; i += 100) {
      const chunk = valid.slice(i, i + 100);
      const res = await api.asUser().requestJira(api.route`/rest/api/3/issue/bulkfetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ issueIdsOrKeys: chunk, fields: ['status'] }),
      });
      const page = await json(res, 'Jira issue statuses');
      for (const issue of /** @type {any[]} */ (page.issues ?? [])) {
        const cat = issue.fields?.status?.statusCategory?.key;
        if (cat === 'new' || cat === 'indeterminate' || cat === 'done') out[String(issue.key)] = { name: String(issue.fields.status.name ?? cat), category: cat };
      }
    }
    return out;
  },
};

/** @type {import('../core/ports.mjs').Confluence} */
export const confluence = {
  // As the user: a person without comment permission on the page gets Confluence's refusal, not the app's reach.
  async addFooterComment(pageId, body) {
    if (!/^[0-9]{1,32}$/.test(pageId)) throw new Error(`not a page id: ${pageId}`);
    const res = await api.asUser().requestConfluence(api.route`/wiki/api/v2/footer-comments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ pageId, body: { representation: 'atlas_doc_format', value: JSON.stringify(body) } }),
    });
    const out = await json(res, 'Confluence footer comment');
    return { id: String(out.id) };
  },
};

/** @type {Users} */
export const users = {
  // Names are a nicety: a failed batch is skipped, so a Jira hiccup never costs a decision or a page.
  async names(accountIds) {
    /** @type {Record<string, string>} */
    const out = {};
    const ids = [...new Set(accountIds)].filter((a) => /^[A-Za-z0-9:_-]{1,128}$/.test(a));
    /** @type {string[]} */
    const failed = [];
    for (let i = 0; i < ids.length; i += 50) {
      try {
        const q = new URLSearchParams({ maxResults: '50' });
        for (const id of ids.slice(i, i + 50)) q.append('accountId', id);
        const page = await json(await api.asApp().requestJira(api.route`/rest/api/3/user/bulk?${q}`), 'Jira user bulk');
        for (const u of /** @type {any[]} */ (page.values ?? [])) if (u.accountId && u.displayName) out[String(u.accountId)] = String(u.displayName);
      } catch (e) {
        failed.push(errTag(e)); // omit this batch's names
      }
    }
    // One line per call, so a lasting failure (a revoked read:jira-user scope, a 403) shows in the logs: the status of
    // each failed batch and how many there were, never the ids.
    if (failed.length) console.warn(JSON.stringify({ dowser: 'warn', what: 'user names', failed_batches: failed.length, batches: Math.ceil(ids.length / 50), errors: [...new Set(failed)] }));
    return out;
  },
};

/**
 * A Teamwork Graph goal node as a source item. Field names are read defensively (TWG's `AtlassianGoal` object
 * shape is not in the public docs yet): name|displayName, url|link, status|state.
 * @param {any} g
 * @returns {SourceItem | undefined}
 */
function goalItem(g) {
  const d = g?.data ?? g;
  const ref = d?.id ?? g?.id;
  if (!ref) return undefined;
  const title = d.name ?? d.displayName ?? String(ref);
  const status = d.status ?? d.state ?? d.phase;
  return /** @type {SourceItem} */ (omitAbsent({
    ref: String(ref), title: String(title), url: String(d.url ?? d.link ?? ''),
    body: trimText(String(d.description ?? d.summary ?? title), BODY_MAX),
    status: status ? String(status).toLowerCase().replace(/[_\s]+/g, '-') : undefined,
  }));
}

/** The goals query (Cypher over TWG, shape per developer.atlassian.com/platform/forge/call-the-teamwork-graph-api/). */
const GOALS_QUERY = `query dowser_goals($cypherQuery: String!) {
  cypherQuery(query: $cypherQuery) {
    edges { node { columns { key value { __typename
      ... on CypherQueryResultListNode { nodes { id data { __typename
        ... on AtlassianGoal { id name url description status } } } } } } } }
  }
}`;

/** @type {Sources} */
export const sources = {
  async tickets({ jql, limit }) {
    return asPerson(async () => {
      const res = await api.asUser().requestJira(api.route`/rest/api/3/search/jql`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ jql, maxResults: limit, fields: TICKET_FIELDS }),
      });
      const out = await json(res, 'Jira search');
      const site = await siteUrl();
      return (out.issues ?? []).map((/** @type {any} */ i) => ticketItem(i, site));
    });
  },
  async pages({ cql, limit }) {
    return asPerson(async () => {
      const q = new URLSearchParams({ cql, limit: String(limit), expand: 'body.storage,version' });
      const out = await json(await api.asUser().requestConfluence(api.route`/wiki/rest/api/content/search?${q}`), 'Confluence search');
      const base = String(out._links?.base ?? `${await siteUrl()}/wiki`);
      return (out.results ?? []).map((/** @type {any} */ p) => /** @type {SourceItem} */ (omitAbsent({
        ref: String(p.id), title: String(p.title ?? ''), url: `${base}${p._links?.webui ?? `/pages/viewpage.action?pageId=${p.id}`}`,
        body: trimText(htmlToText(p.body?.storage?.value ?? ''), BODY_MAX),
        updated_at: p.version?.when ? new Date(p.version.when).toISOString() : undefined,
      })));
    });
  },
  async goals() {
    return asPerson(async () => {
      const res = await api.asUser().requestTeamworkGraph(GOALS_QUERY, { cypherQuery: 'MATCH (goal:AtlassianGoal) RETURN collect(distinct goal) as goals' });
      if (res.status === 403 || res.status === 401) {
        throw new AppError('unavailable', 'Teamwork Graph refused the goals query: the app must be allowlisted for the Teamwork Graph API (request it from Atlassian support with the app id)');
      }
      const out = await json(res, 'Teamwork Graph');
      if (Array.isArray(out.errors) && out.errors.length) {
        // the error's own text stays out (core/util.mjs errTag): only its classification, when it is a plain token
        const kind = [out.errors[0]?.extensions?.errorType, out.errors[0]?.extensions?.classification].find((k) => typeof k === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(k));
        throw new AppError('unavailable', `Teamwork Graph did not answer the goals query (${kind ?? 'an error'}); if the app is not allowlisted for the Teamwork Graph API, request it from Atlassian support`);
      }
      /** @type {SourceItem[]} */
      const items = [];
      let seen = 0;
      for (const edge of out.data?.cypherQuery?.edges ?? []) {
        for (const col of edge?.node?.columns ?? []) {
          for (const n of col?.value?.nodes ?? []) {
            seen++;
            const it = goalItem(n);
            if (it && it.url) items.push(it); // the contract requires a link; a goal without one is not citable
          }
        }
      }
      if (seen > 0 && items.length === 0) throw new AppError('unavailable', `Teamwork Graph returned ${seen} goals without links; the goal fields Dowser reads need updating`);
      return items;
    });
  },
};
