// Evidence panel (jira:issuePanel, 360px): the reading-pane content in a single column, compact and read-only.
// Jira titles the panel "Dowser evidence" with the app icon, so the panel itself starts at the card.
// An empty answer means either "not from Dowser" or "from an inbox this person cannot open" (the backend hides
// it); the message is true for both and does not say which, so it reveals no inbox.
import React from 'react';
import { call } from '../../api.js';
import { ErrorState, SectionMessage, SkeletonList, useAsync } from '../../components/ui.jsx';
import { Detail } from '../inbox/Detail.jsx';

export default function Panel({ context }) {
  const issueKey = context?.extension?.issue?.key;
  const data = useAsync(
    () => (issueKey ? call('panel.forIssue', { issue_key: issueKey }) : Promise.resolve({ history: [] })),
    [issueKey],
  );
  return (
    <main className="dwr-panel">
      {data.status === 'loading' && <SkeletonList count={1} label="Loading Dowser evidence" />}
      {data.status === 'error' && <ErrorState what="Dowser evidence" error={data.error} onRetry={data.reload} />}
      {data.status === 'ready' && !data.data.card && (
        <SectionMessage role="status" title="No Dowser evidence you can view here.">
          <p>Either Dowser did not propose this issue, or its proposal is in a Dowser inbox you cannot open. A Jira admin can tell you which.</p>
        </SectionMessage>
      )}
      {data.status === 'ready' && data.data.card && (
        <Detail card={data.data.card} history={data.data.history ?? []} compact titleId="dwr-panel-title" />
      )}
    </main>
  );
}
