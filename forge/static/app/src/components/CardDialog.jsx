// One proposal in a modal, read-only: the card, its evidence and its triage history (`proposal.get`), drawn by
// the reading pane's Detail in its compact one-column form (as the issue panel does). The map opens it from a
// dot (with a way on to the inbox, focused on the card); the inbox opens it for a deep link (`?ref=`) to a card
// that is not in its loaded page.
import React from 'react';
import { call } from '../api.js';
import { Detail } from '../routes/inbox/Detail.jsx';
import { Button, Dialog, ErrorState, SectionMessage, SkeletonList, useAsync } from './ui.jsx';

/** What proposal.get answers for a ref that is not there, or that this person may not open (the core does not tell them apart). */
const NOT_THERE = new Set(['forbidden', 'bad-input']);

/**
 * @param {{cardRef: string, onClose: () => void, onOpenInbox?: () => void}} props
 */
export function CardDialog({ cardRef, onClose, onOpenInbox }) {
  const data = useAsync(() => call('proposal.get', { ref: cardRef }), [cardRef]);
  return (
    <Dialog
      title={`Proposal ${cardRef}`}
      onClose={onClose}
      footer={(
        <>
          {onOpenInbox && <Button onClick={onOpenInbox}>Open in the inbox</Button>}
          <Button appearance="primary" onClick={onClose}>Close</Button>
        </>
      )}
    >
      {data.status === 'loading' && <SkeletonList count={1} label={`Loading ${cardRef}`} />}
      {data.status === 'error' && NOT_THERE.has(data.error?.code) && (
        <SectionMessage appearance="information" title={`${cardRef} is not here.`} role="status"><p>{String(data.error.message)}</p></SectionMessage>
      )}
      {data.status === 'error' && !NOT_THERE.has(data.error?.code) && <ErrorState what={cardRef} error={data.error} onRetry={data.reload} />}
      {data.status === 'ready' && (
        <Detail card={data.data.card} history={data.data.history ?? []} compact titleId={`dw-dlg-card-${cardRef}`} />
      )}
    </Dialog>
  );
}
