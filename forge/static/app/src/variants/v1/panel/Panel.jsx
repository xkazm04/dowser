// Variant 1 evidence panel (jira:issuePanel, 360px): the flat card as a key/value field list, like Jira's own fields.
import React from 'react';
import { call } from '../../../api.js';
import { ErrorState, SectionMessage, SkeletonList, useAsync } from '../../../components/ui.jsx';
import { Card } from '../Card.jsx';
import { Mark } from '../../../components/Brand.jsx';

export default function Panel({ context }) {
  const issueKey = context?.extension?.issue?.key;
  const data = useAsync(
    () => (issueKey ? call('panel.forIssue', { issue_key: issueKey }) : Promise.resolve({ history: [] })),
    [issueKey],
  );
  return (
    <main className="dw-root dw-root--panel dw1-panel">
      <div className="dw1-panel__brand"><Mark size={16} /><span>Dowser evidence</span></div>
      {data.status === 'loading' && <SkeletonList count={1} label="Loading Dowser evidence" />}
      {data.status === 'error' && <ErrorState what="Dowser evidence" error={data.error} onRetry={data.reload} />}
      {data.status === 'ready' && !data.data.card && (
        <SectionMessage role="status"><p>This issue did not come from Dowser.</p></SectionMessage>
      )}
      {data.status === 'ready' && data.data.card && (
        <Card card={data.data.card} history={data.data.history ?? []} showStatus flat titleId="dw1-panel-title" />
      )}
    </main>
  );
}
