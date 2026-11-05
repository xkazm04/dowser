// One Custom UI bundle serves every Forge module. The module key picks the surface; inside the global page,
// the page route (manifest `pages`) picks the tab. Each surface lives in its own routes/<name>/ folder, owned
// by one builder package (WP3: inbox, reflect, settings, panel; WP4: map, byline).
//
// Jira's sidebar only changes the page URL and keeps this iframe mounted, so the tab follows the app history
// (view.createHistory + listen), never a one-time read of the context (components/route.js).
import React, { useEffect, useState } from 'react';
import { view } from '@forge/bridge';
import Inbox from './routes/inbox/index.jsx';
import Settings from './routes/settings/index.jsx';
import Panel from './routes/panel/index.jsx';
import MapView from './routes/map/index.jsx';
import Byline from './routes/byline/index.jsx';
import Banner from './routes/byline/Banner.jsx';
import Reflect from './routes/reflect/index.jsx';
import { locationKey, pageRoute } from './components/route.js';
import { pageUrl } from './components/deeplink.js';

const MODULES = { 'dowser-evidence': Panel, 'dowser-doc-impact': Byline, 'dowser-doc-banner': Banner };
const PAGES = { inbox: Inbox, map: MapView, reflect: Reflect, settings: Settings };

/**
 * The context a tab sees: `extension.location` rewritten to the URL the history is at now, so deep links
 * (`?ref=`, the map's filters) and the links between tabs read the current page, not the one first loaded.
 * @param {any} ctx @param {{pathname?: string, search?: string} | null} loc
 */
function contextAt(ctx, loc) {
  const first = ctx.extension?.location;
  if (!loc || typeof loc.pathname !== 'string' || !first) return ctx;
  const base = pageUrl(first, pageRoute(loc.pathname));
  if (!base) return ctx;
  return { ...ctx, extension: { ...ctx.extension, location: `${base}${loc.search ?? ''}` } };
}

export function Router() {
  const [ctx, setCtx] = useState(/** @type {import('@forge/bridge').FullContext | null} */ (null));
  const [failed, setFailed] = useState(false);
  const [loc, setLoc] = useState(/** @type {{pathname?: string, search?: string} | null} */ (null));
  useEffect(() => {
    view.getContext().then(setCtx, () => setFailed(true));
  }, []);
  useEffect(() => {
    /** @type {(() => void) | undefined} */
    let unlisten;
    let live = true;
    if (typeof view.createHistory === 'function') {
      view.createHistory().then((history) => {
        if (!live || !history) return;
        setLoc({ pathname: history.location?.pathname, search: history.location?.search });
        unlisten = history.listen((/** @type {any} */ l) => setLoc({ pathname: l?.pathname, search: l?.search }));
      }, () => {});
    }
    return () => { live = false; unlisten?.(); };
  }, []);
  if (failed) return <p role="alert">Dowser could not read its Jira context. Reload the page.</p>;
  if (!ctx) return null;
  const ByModule = MODULES[ctx.moduleKey];
  if (ByModule) return <ByModule context={ctx} />;
  const route = loc?.pathname !== undefined ? pageRoute(loc.pathname) : pageRoute(ctx.extension?.location);
  const Page = PAGES[route] ?? Inbox;
  return <Page key={locationKey(loc ?? undefined, ctx.extension?.location)} context={contextAt(ctx, loc)} />;
}
