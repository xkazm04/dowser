// One proposal in a modal, read-only: the card, its evidence and its triage history (`proposal.get`). The map
// opens it from a dot (with a way on to the inbox, focused on the card); the inbox opens it for a deep link
// (`?ref=`) to a card that is not in its loaded page.
import React from 'react';
import { call } from '../api.js';
import { ProposalCard } from './ProposalCard.jsx';
import { Button, Dialog, ErrorState, SkeletonList, useAsync } from './ui.jsx';

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
      {data.status === 'error' && <ErrorState what={cardRef} error={data.error} onRetry={data.reload} />}
      {data.status === 'ready' && (
        <ProposalCard card={data.data.card} history={data.data.history ?? []} showStatus flat titleId={`dw-dlg-card-${cardRef}`} />
      )}
    </Dialog>
  );
}
