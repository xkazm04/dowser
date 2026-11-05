// Which tab of the global page to show. Jira's sidebar (manifest `pages`) only changes the page URL; the app's
// iframe stays mounted, so the tab is read from the app history (view.createHistory: `location.pathname` is the
// page route, `/settings`) and followed through `history.listen`. The context's `extension.location` (the full
// page URL) is the fallback when the history is unavailable. Pure: no bridge import, so Node tests load it.

/** The global page's tabs, by their manifest `pages` route. */
export const PAGE_ROUTES = ['inbox', 'map', 'reflect', 'settings'];

/**
 * The tab a path or a page URL names: its last non-empty path segment when that is a known route, else `inbox`.
 * A query string, a hash and trailing slashes are ignored (`…/settings/?x=1` is settings).
 * @param {string | undefined} pathOrUrl  `/settings`, `settings`, or `https://site/jira/apps/<app>/<env>/settings`
 * @returns {string}
 */
export function pageRoute(pathOrUrl) {
  if (!pathOrUrl) return 'inbox';
  let path = String(pathOrUrl);
  try { if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) path = new URL(path).pathname; } catch { return 'inbox'; }
  path = path.split(/[?#]/)[0];
  const last = path.split('/').filter(Boolean).pop() ?? '';
  return PAGE_ROUTES.includes(last) ? last : 'inbox';
}

/**
 * The key that remounts a tab when its URL changes (a map heat cell opens the inbox with a new filter while the
 * inbox is already the tab): the route plus its query string.
 * @param {{pathname?: string, search?: string} | undefined} loc
 * @param {string | undefined} fallbackUrl
 */
export function locationKey(loc, fallbackUrl) {
  if (loc && typeof loc.pathname === 'string') return `${pageRoute(loc.pathname)}${loc.search ?? ''}`;
  try { const u = new URL(String(fallbackUrl)); return `${pageRoute(u.pathname)}${u.search}`; } catch { return 'inbox'; }
}
