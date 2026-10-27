// Evidence panel (jira:issuePanel): on an issue Dowser created at Accept, the card read-only with its
// evidence trail, doc impact, delivery risk and triage history.
import React from 'react';
import { call } from '../../api.js';
import { ErrorState, SectionMessage, SkeletonList, useAsync } from '../../components/ui.jsx';
import { ProposalCard } from '../../components/ProposalCard.jsx';

export default function Panel({ context }) {
  const issueKey = context?.extension?.issue?.key;
  const data = useAsync(
    () => (issueKey ? call('panel.forIssue', { issue_key: issueKey }) : Promise.resolve({ history: [] })),
    [issueKey],
  );
  return (
    <main className="dw-root dw-root--panel">
      {data.status === 'loading' && <SkeletonList count={1} label="Loading Dowser evidence" />}
      {data.status === 'error' && <ErrorState what="Dowser evidence" error={data.error} onRetry={data.reload} />}
      {data.status === 'ready' && !data.data.card && (
        <SectionMessage role="status"><p>This issue did not come from Dowser.</p></SectionMessage>
      )}
      {data.status === 'ready' && data.data.card && (
        <ProposalCard card={data.data.card} history={data.data.history ?? []} showStatus flat titleId="dw-panel-title" />
      )}
    </main>
  );
}
