// @ts-check
// The Jira, Sources and Links ports over @forge/api 8.x (checked against node_modules/@forge/api/out/index.d.ts):
//  - `asApp()` / `asUser()` return `requestJira` / `requestConfluence` taking a `route` tagged template;
//    `requestTeamworkGraph(query, variables)` exists on `asUser()` only (AsUserFetchMethods), not on asApp.
//  - `getAppContext()` (out/api/runtime.d.ts) gives `appAri.appId`, `environmentAri.environmentId`, `moduleKey`.
//
// Who calls as whom:
//  - Accept / merge comment / project list: AS APP (design F5 - the issue is created even when the person
//    lacks create permission in the target project, and the inbox setting is the app's choice).
//  - Tickets / pages / goals (scan sources): AS USER, so a scan only ever sees what the signed-in person may
//    see, and because the Teamwork Graph API is user-only. A missing user grant surfaces as `unauthorized`.
//
// REST endpoints used (developer.atlassian.com/cloud/jira/platform/rest/v3, /cloud/confluence/rest/v1):
//   GET  /rest/api/3/serverInfo                         -> baseUrl (site URL for browse and inbox links)
//   POST /rest/api/3/issue                              -> {key}
//   POST /rest/api/3/issue/{key}/comment
//   GET  /rest/api/3/project/search?expand=issueTypes
//   POST /rest/api/3/search/jql                         (the enhanced JQL search; /search is retired)
//   GET  /rest/api/3/user/bulk?accountId=&accountId=    -> display names (asApp, read:jira-user)
//   GET  /wiki/rest/api/content/search?cql=&expand=body.storage,version
import { NeedsAuthenticationError, asApp, asUser, getAppContext, route } from '@forge/api';
import { htmlToText, trimText } from '../core/adf.mjs';
import { BODY_MAX, TICKET_FIELDS, ticketItem } from '../core/sources.mjs';
import { AppError, ISSUE_KEY_RE, omitAbsent } from '../core/util.mjs';

/**
 * @typedef {import('../core/ports.mjs').Jira} Jira
 * @typedef {import('../core/ports.mjs').Sources} Sources
 * @typedef {import('../core/ports.mjs').Links} Links
 * @typedef {import('../core/ports.mjs').Users} Users
 * @typedef {import('../core/ports.mjs').SourceItem} SourceItem
 * @typedef {import('@forge/api').APIResponse} APIResponse
 */

/**
 * The JSON of a product response, or a thrown Error naming the status (the core maps it to `unavailable`);
 * 401 becomes `unauthorized`.
 * @param {APIResponse} res
 * @param {string} what
 * @returns {Promise<any>}
 */
async function json(res, what) {
  if (res.ok) return res.status === 204 ? {} : res.json();
  let detail = '';
  try { detail = (await res.text()).slice(0, 300); } catch { /* no body */ }
  if (res.status === 401) throw new AppError('unauthorized', `${what} refused the credentials (401); sign in again`);
  throw new Error(`${what} answered ${res.status}${detail ? `: ${detail}` : ''}`);
}

/**
 * Runs a user-context call; a missing user grant becomes `unauthorized`.
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function asPerson(fn) {
  try { return await fn(); } catch (e) {
    if (e instanceof NeedsAuthenticationError) throw new AppError('unauthorized', 'Dowser needs your permission to read on your behalf; allow access and retry');
    throw e;
  }
}

/** @type {string | undefined} */
let siteCache;

/** The site URL (`https://acme.atlassian.net`), cached for the life of the runtime. */
export async function siteUrl() {
  if (!siteCache) {
    const info = await json(await asApp().requestJira(route`/rest/api/3/serverInfo`), 'Jira serverInfo');
    siteCache = String(info.baseUrl).replace(/\/+$/, '');
  }
  return siteCache;
}

/** @type {Links} */
export const links = {
  // The Dowser global page, inbox route, focused on one item. The global-page URL shape
  // (`/jira/apps/<appId>/<envId>/<route>`) is the documented one for jira:globalPage; the `ref` query is read by
  // the inbox route.
  async inboxUrl(ref) {
    const ctx = getAppContext();
    return `${await siteUrl()}/jira/apps/${ctx.appAri.appId}/${ctx.environmentAri.environmentId}/inbox?ref=${encodeURIComponent(ref)}`;
  },
};

/** @type {Jira} */
export const jira = {
  async createIssue({ projectKey, issueTypeId, summary, description }) {
    const res = await asApp().requestJira(route`/rest/api/3/issue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ fields: { project: { key: projectKey }, issuetype: { id: issueTypeId }, summary, description } }),
    });
    const out = await json(res, 'Jira create issue');
    const key = String(out.key);
    return { key, url: `${await siteUrl()}/browse/${key}` };
  },
  async addComment(issueKey, body) {
    const res = await asApp().requestJira(route`/rest/api/3/issue/${issueKey}/comment`, {
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
      const page = await json(await asApp().requestJira(route`/rest/api/3/project/search?${q}`), 'Jira project search');
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
  async issueStatuses(keys) {
    /** @type {Record<string, {name: string, category: 'new' | 'indeterminate' | 'done'}>} */
    const out = {};
    const valid = [...new Set(keys)].filter((k) => ISSUE_KEY_RE.test(k));
    for (let i = 0; i < valid.length; i += 50) {
      const chunk = valid.slice(i, i + 50);
      const res = await asApp().requestJira(route`/rest/api/3/search/jql`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ jql: `key in (${chunk.join(',')})`, maxResults: chunk.length, fields: ['status'] }),
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

/** @type {Users} */
export const users = {
  // Names are a nicety: a failed batch is skipped, so a Jira hiccup never costs a decision or a page.
  async names(accountIds) {
    /** @type {Record<string, string>} */
    const out = {};
    const ids = [...new Set(accountIds)].filter((a) => /^[A-Za-z0-9:_-]{1,128}$/.test(a));
    for (let i = 0; i < ids.length; i += 50) {
      try {
        const q = new URLSearchParams({ maxResults: '50' });
        for (const id of ids.slice(i, i + 50)) q.append('accountId', id);
        const page = await json(await asApp().requestJira(route`/rest/api/3/user/bulk?${q}`), 'Jira user bulk');
        for (const u of /** @type {any[]} */ (page.values ?? [])) if (u.accountId && u.displayName) out[String(u.accountId)] = String(u.displayName);
      } catch { /* omit this batch's names */ }
    }
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
      const res = await asUser().requestJira(route`/rest/api/3/search/jql`, {
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
      const out = await json(await asUser().requestConfluence(route`/wiki/rest/api/content/search?${q}`), 'Confluence search');
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
      const res = await asUser().requestTeamworkGraph(GOALS_QUERY, { cypherQuery: 'MATCH (goal:AtlassianGoal) RETURN collect(distinct goal) as goals' });
      if (res.status === 403 || res.status === 401) {
        throw new AppError('unavailable', 'Teamwork Graph refused the goals query: the app must be allowlisted for the Teamwork Graph API (request it from Atlassian support with the app id)');
      }
      const out = await json(res, 'Teamwork Graph');
      if (Array.isArray(out.errors) && out.errors.length) {
        const msg = String(out.errors[0]?.message ?? 'error');
        throw new AppError('unavailable', `Teamwork Graph did not answer the goals query (${msg}); if the app is not allowlisted for the Teamwork Graph API, request it from Atlassian support`);
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
