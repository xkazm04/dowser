// Deep links into the inbox: `<site>/jira/apps/<appId>/<envId>/inbox?ref=DW-n` (the backend's external_url).
// The global page's Forge context carries the page URL as `extension.location`; when it has no `ref`, the app
// history (view.createHistory, the global page's in-app router) is asked as well.
import { view } from '@forge/bridge';
import { DW_REF_RE } from './labels.js';

/** @param {string | undefined} search  a URL or a `?a=b` query string */
function refIn(search) {
  if (!search) return undefined;
  try {
    const q = search.startsWith('?') ? new URLSearchParams(search) : new URL(search).searchParams;
    const ref = q.get('ref') ?? undefined;
    return ref && DW_REF_RE.test(ref) ? ref : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The `ref` a deep link asks for, or undefined.
 * @param {any} context  the Forge context (view.getContext())
 * @returns {Promise<string | undefined>}
 */
export async function deepLinkRef(context) {
  const fromContext = refIn(context?.extension?.location);
  if (fromContext) return fromContext;
  try {
    if (typeof view.createHistory !== 'function') return undefined;
    const history = await view.createHistory();
    return refIn(history?.location?.search);
  } catch {
    return undefined;
  }
}

/**
 * The inbox route URL of the global page, from another page's location (…/map -> …/inbox), optionally
 * focused on one card with `?ref=`.
 * @param {string | undefined} location @param {string} [ref]
 */
export function inboxUrl(location, ref) {
  if (!location) return undefined;
  try {
    const u = new URL(location);
    const parts = u.pathname.replace(/\/+$/, '').split('/');
    parts[parts.length - 1] = 'inbox';
    u.pathname = parts.join('/');
    u.search = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    u.hash = '';
    return u.toString();
  } catch {
    return undefined;
  }
}
