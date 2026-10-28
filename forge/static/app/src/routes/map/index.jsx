// Opportunity map (global page tab "Opportunity map"): where proposals, churn and bus factor concentrate in one
// inbox. (a) a heat grid of areas x lenses; (b) effort vs confidence of the open proposals. A dot opens its
// card in a modal (`proposal.get`); "Open in the inbox" goes to the inbox tab focused on it (`inbox?ref=DW-n`).
import React, { useEffect, useState } from 'react';
import { router } from '@forge/bridge';
import { call } from '../../api.js';
import { ErrorState, SectionMessage, SkeletonList, useAsync } from '../../components/ui.jsx';
import { CardDialog } from '../../components/CardDialog.jsx';
import { plural } from '../../components/labels.js';
import { HeatGrid } from './HeatGrid.jsx';
import { EffortConfidence } from './EffortConfidence.jsx';
import { inboxUrl } from '../../components/deeplink.js';
import '../../components/viz.css';

const EMPTY = 'No areas yet - the map fills after the next scan from Claude Code or Codex.';

export default function MapView({ context }) {
  const inboxes = useAsync(() => call('settings.get').then((r) => r.inboxes ?? []), []);
  const [projectKey, setProjectKey] = useState('');
  const [openRef, setOpenRef] = useState('');

  // Default to the inbox with the most open proposals once the list is in.
  useEffect(() => {
    if (inboxes.status !== 'ready' || projectKey) return;
    const list = inboxes.data;
    if (list.length > 0) setProjectKey([...list].sort((a, b) => (b.open ?? 0) - (a.open ?? 0))[0].project_key);
  }, [inboxes.status, inboxes.data, projectKey]);


  return (
    <main className="dwr-page">
      <header className="dwr-page__bar">
        <h1 className="dwr-page__h1">Opportunity map</h1>
        <span className="dwr-spacer" />
        {inboxes.status === 'ready' && inboxes.data.length > 0 && (
          <label className="dwr-field">
            <span className="dwr-visually-hidden">Inbox</span>
            <select className="dwr-select" value={projectKey} onChange={(e) => setProjectKey(e.target.value)}>
              {inboxes.data.map((i) => <option key={i.project_key} value={i.project_key}>{i.project_key.split('/').pop()} ({i.open} open)</option>)}
            </select>
          </label>
        )}
      </header>
      <p className="dwr-page__intro">
        Where the proposals of one repository concentrate, next to how often that code changes and how many people
        change it.
      </p>

      {inboxes.status === 'loading' && <SkeletonList count={2} label="Loading the inboxes" />}
      {inboxes.status === 'error' && <ErrorState what="The inbox list" error={inboxes.error} onRetry={inboxes.reload} />}
      {inboxes.status === 'ready' && inboxes.data.length === 0 && (
        <SectionMessage role="status" title="No inbox yet.">
          <p>{EMPTY}</p>
        </SectionMessage>
      )}
      {projectKey && <MapBody key={projectKey} projectKey={projectKey} onOpen={setOpenRef} />}

      {openRef && (
        <CardDialog
          cardRef={openRef}
          onClose={() => setOpenRef('')}
          onOpenInbox={inboxUrl(context?.extension?.location, openRef)
            ? () => { const to = inboxUrl(context?.extension?.location, openRef); setOpenRef(''); router.navigate(to).catch(() => {}); }
            : undefined}
        />
      )}
    </main>
  );
}

function MapBody({ projectKey, onOpen }) {
  const data = useAsync(() => call('map.data', { project_key: projectKey }), [projectKey]);
  if (data.status === 'loading') return <SkeletonList count={3} label="Loading the map" />;
  if (data.status === 'error') return <ErrorState what="The map" error={data.error} onRetry={data.reload} />;
  const areas = data.data.areas ?? [];
  const points = data.data.points ?? [];
  if (areas.length === 0 && points.length === 0) {
    return <SectionMessage role="status" title="Nothing to map yet."><p>{EMPTY}</p></SectionMessage>;
  }
  return (
    <div className="dwr-secs">
      <section className="dwr-sec" aria-labelledby="dw-map-heat">
        <h2 className="dwr-sec__h" id="dw-map-heat">Proposals by area and lens</h2>
        <p className="dwr-sec__hint">{plural(areas.length, 'area')}</p>
        {areas.length === 0
          ? <SectionMessage role="status"><p>{EMPTY}</p></SectionMessage>
          : <HeatGrid areas={areas} />}
      </section>
      <section className="dwr-sec" aria-labelledby="dw-map-ec">
        <h2 className="dwr-sec__h" id="dw-map-ec">Effort vs confidence</h2>
        <p className="dwr-sec__hint">{plural(points.length, 'open proposal')}</p>
        {points.length === 0
          ? <SectionMessage role="status"><p>No open proposals in this inbox.</p></SectionMessage>
          : <EffortConfidence points={points} onOpen={onOpen} />}
      </section>
    </div>
  );
}
