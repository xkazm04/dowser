// Deep links into the inbox: `<site>/jira/apps/<appId>/<envId>/inbox?ref=DW-n` (the backend's external_url), or
// `inbox?project=<key>&lens=<lens>&area=<path>` (a map heat cell: the inbox opens filtered).
// The global page's Forge context carries the page URL as `extension.location`; when it has no `ref`, the app
// history (view.createHistory, the global page's in-app router) is asked as well.
import { view } from '@forge/bridge';
import { DW_REF_RE, LENSES } from './labels.js';

/**
 * What an inbox link asks for: one card (`ref`), or a filtered list (`project`, `lens`, `area`; the map's heat
 * cells). Only well-formed values are kept; absent keys are omitted.
 * @typedef {{ref?: string, project_key?: string, lens?: string, area?: string}} InboxLink
 */

/** @param {string | undefined} search  a URL or a `?a=b` query string @returns {InboxLink} */
function linkIn(search) {
  if (!search) return {};
  try {
    const q = search.startsWith('?') ? new URLSearchParams(search) : new URL(search).searchParams;
    /** @type {InboxLink} */
    const out = {};
    const ref = q.get('ref');
    if (ref && DW_REF_RE.test(ref)) out.ref = ref;
    const project = q.get('project');
    if (project && project.length <= 200) out.project_key = project;
    const lens = q.get('lens');
    if (lens && LENSES.includes(lens)) out.lens = lens;
    const area = q.get('area');
    if (area && out.project_key && area.length <= 300) out.area = area;
    return out;
  } catch {
    return {};
  }
}

/**
 * What a deep link asks for (possibly nothing): the page URL in the Forge context first, else the app history.
 * @param {any} context  the Forge context (view.getContext())
 * @returns {Promise<InboxLink>}
 */
export async function deepLink(context) {
  const fromContext = linkIn(context?.extension?.location);
  if (Object.keys(fromContext).length) return fromContext;
  try {
    if (typeof view.createHistory !== 'function') return {};
    const history = await view.createHistory();
    return linkIn(history?.location?.search);
  } catch {
    return {};
  }
}

/**
 * The `ref` a deep link asks for, or undefined.
 * @param {any} context  the Forge context (view.getContext())
 * @returns {Promise<string | undefined>}
 */
export async function deepLinkRef(context) {
  return (await deepLink(context)).ref;
}

/**
 * The inbox route URL of the global page, from another page's location (…/map -> …/inbox), optionally
 * focused on one card with `?ref=`, or filtered with `?project=&lens=&area=` (a map cell).
 * @param {string | undefined} location @param {string} [ref] @param {InboxLink} [filters]
 */
export function inboxUrl(location, ref, filters) {
  if (!location) return undefined;
  try {
    const u = new URL(location);
    const parts = u.pathname.replace(/\/+$/, '').split('/');
    parts[parts.length - 1] = 'inbox';
    u.pathname = parts.join('/');
    const q = new URLSearchParams();
    if (ref) q.set('ref', ref);
    if (filters?.project_key) q.set('project', filters.project_key);
    if (filters?.lens) q.set('lens', filters.lens);
    if (filters?.area) q.set('area', filters.area);
    u.search = q.toString() ? `?${q}` : '';
    u.hash = '';
    return u.toString();
  } catch {
    return undefined;
  }
}
