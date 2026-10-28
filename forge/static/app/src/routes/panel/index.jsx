// Evidence panel (jira:issuePanel, 360px): the reading-pane content in a single column, compact and read-only.
import React from 'react';
import { call } from '../../api.js';
import { ErrorState, SectionMessage, SkeletonList, useAsync } from '../../components/ui.jsx';
import { Mark } from '../../components/Brand.jsx';
import { Detail } from '../inbox/Detail.jsx';

export default function Panel({ context }) {
  const issueKey = context?.extension?.issue?.key;
  const data = useAsync(
    () => (issueKey ? call('panel.forIssue', { issue_key: issueKey }) : Promise.resolve({ history: [] })),
    [issueKey],
  );
  return (
    <main className="dwr-panel">
      <div className="dwr-panel__brand"><Mark size={16} /><span>Dowser evidence</span></div>
      {data.status === 'loading' && <SkeletonList count={1} label="Loading Dowser evidence" />}
      {data.status === 'error' && <ErrorState what="Dowser evidence" error={data.error} onRetry={data.reload} />}
      {data.status === 'ready' && !data.data.card && (
        <SectionMessage role="status"><p>This issue did not come from Dowser.</p></SectionMessage>
      )}
      {data.status === 'ready' && data.data.card && (
        <Detail card={data.data.card} history={data.data.history ?? []} compact titleId="dwr-panel-title" />
      )}
    </main>
  );
}
