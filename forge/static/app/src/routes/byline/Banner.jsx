// Doc-drift page banner (confluence:pageBanner, core/doc-drift.mjs): shown only when an open or accepted Doc drift
// proposal names this page; one line, and the page byline holds the detail and "Draft the fix". Dismissable
// (view.close), as the platform asks of banners. Nothing renders while loading, on an error, or with nothing to say:
// a banner that is not about this page is noise.
import React from 'react';
import { view } from '@forge/bridge';
import { call } from '../../api.js';
import { useAsync } from '../../components/ui.jsx';
import { Mark } from '../../components/Brand.jsx';
import { plural } from '../../components/labels.js';
import './byline.css';

export default function Banner({ context }) {
  const pageId = context?.extension?.content?.id ? String(context.extension.content.id) : '';
  const data = useAsync(() => (pageId ? call('byline.forPage', { page_id: pageId }) : Promise.resolve({ count: 0, cards: [] })), [pageId]);
  if (data.status !== 'ready') return null;
  const drift = (data.data.cards ?? []).filter((c) => c.lens === 'doc-drift');
  if (!drift.length) return null;
  const edited = drift.some((c) => c.page_edited_since_decision);
  return (
    <main className="dw-root dw-banner" role="region" aria-label="Dowser doc drift">
      <Mark size={16} />
      <p className="dw-banner__text">
        {plural(drift.length, 'Dowser finding')} {drift.length === 1 ? 'says' : 'say'} this page may no longer match the code.
        {edited ? ' The page was edited since: the next scan re-checks it.' : ' Open Dowser in the page byline for the evidence and a drafted fix.'}
      </p>
      <button type="button" className="dw-banner__close" onClick={() => view.close().catch(() => {})} aria-label="Dismiss the Dowser banner">Dismiss</button>
    </main>
  );
}
