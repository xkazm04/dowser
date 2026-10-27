// One Custom UI bundle serves every Forge module. The module key picks the surface; inside the global page,
// the page route (manifest `pages`) picks the tab. Each surface lives in its own routes/<name>/ folder, owned
// by one builder package (WP3: inbox, settings, panel; WP4: map, byline).
import React, { useEffect, useState } from 'react';
import { view } from '@forge/bridge';
import Inbox from './routes/inbox/index.jsx';
import Settings from './routes/settings/index.jsx';
import Panel from './routes/panel/index.jsx';
import MapView from './routes/map/index.jsx';
import Byline from './routes/byline/index.jsx';

const MODULES = { 'dowser-evidence': Panel, 'dowser-doc-impact': Byline };
const PAGES = { inbox: Inbox, map: MapView, settings: Settings };

export function Router() {
  const [ctx, setCtx] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    view.getContext().then(setCtx, () => setFailed(true));
  }, []);
  if (failed) return <p role="alert">Dowser could not read its Jira context. Reload the page.</p>;
  if (!ctx) return null;
  const ByModule = MODULES[ctx.moduleKey];
  if (ByModule) return <ByModule context={ctx} />;
  const route = String(ctx.extension?.location ?? '').split('/').pop();
  const Page = PAGES[route] ?? Inbox;
  return <Page context={ctx} />;
}
