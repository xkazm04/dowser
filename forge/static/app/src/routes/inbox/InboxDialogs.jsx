// Which dialog the inbox shows (help, a read-only card, Accept, Merge, Reject) and what each one's outcome does to
// the list. Accept and Merge commit at once; Reject goes through the undo window (deferReject).
import React from 'react';
import { Button, Dialog } from '../../components/ui.jsx';
import { CardDialog } from '../../components/CardDialog.jsx';
import { AcceptDialog, MergeDialog, RejectDialog } from './dialogs.jsx';
import { safeHref } from '../../safeHref.js';

/**
 * @param {{dialog: {kind: string, refs: string[]} | null, dialogCards: any[], flat: any[], closeDialog: () => void,
 *   fail: (refs: string[], message: string) => void, leave: (cards: any[], to: string) => void,
 *   deferReject: (cards: any[], decision: any) => void, cw: any}} props
 */
export function InboxDialogs({ dialog, dialogCards, flat, closeDialog, fail, leave, deferReject, cw }) {
  return (
    <>
      {dialog?.kind === 'help' && <HelpDialog onClose={closeDialog} />}
      {dialog?.kind === 'card' && <CardDialog cardRef={dialog.refs[0]} onClose={closeDialog} />}
      {dialog?.kind === 'accept' && dialogCards[0] && (
        <AcceptDialog
          card={dialogCards[0]} onClose={closeDialog} onFailed={(ref, m) => fail([ref], m)} onBeforeSubmit={cw.flush}
          onDone={(card) => {
            const c = card ?? dialogCards[0];
            closeDialog(); leave([c], 'accepted');
            cw.notify(<>{c.ref} accepted{c.issue_ref && <> as {safeHref(c.issue_url) ? <a href={safeHref(c.issue_url)} target="_blank" rel="noreferrer noopener">{c.issue_ref}</a> : c.issue_ref}</>}.</>);
          }}
        />
      )}
      {dialog?.kind === 'merge' && dialogCards[0] && (
        <MergeDialog
          card={dialogCards[0]} openCards={flat.filter((c) => c.status === 'open')} onClose={closeDialog} onFailed={(ref, m) => fail([ref], m)} onBeforeSubmit={cw.flush}
          onDone={(card) => {
            const c = card ?? dialogCards[0];
            closeDialog(); leave([c], 'merged');
            cw.notify(`${c.ref} merged${c.merged_into ? ` into ${c.merged_into}` : ''}.`);
          }}
        />
      )}
      {dialog?.kind === 'reject' && dialogCards.length > 0 && (
        <RejectDialog
          cards={dialogCards} onClose={closeDialog}
          onSubmit={(decision) => { closeDialog(); deferReject(dialogCards, decision); }}
        />
      )}
    </>
  );
}

const KEYS = [
  ['j / k', 'Move to the next / previous proposal; the pane follows'],
  ['x', 'Check or uncheck the proposal for a bulk action'],
  ['a', 'Accept; then Ctrl+Enter creates the issue'],
  ['r', 'Reject (all checked, when some are checked); 1 to 6 picks the reason, Ctrl+Enter confirms'],
  ['s', 'Snooze, with an optional note and Until date, Enter to confirm (all checked, when some are checked: one date, no note)'],
  ['m', 'Merge'],
  ['u', 'Undo the last snooze or reject while its notice is showing'],
  ['?', 'Show this help'],
];

function HelpDialog({ onClose }) {
  return (
    <Dialog title="Keyboard shortcuts" onClose={onClose} footer={<Button appearance="primary" onClick={onClose} autoFocus>Close</Button>}>
      <table className="dw-table">
        <tbody>
          {KEYS.map(([k, what]) => <tr key={k}><td><span className="dw-kbd">{k}</span></td><td>{what}</td></tr>)}
        </tbody>
      </table>
      <p className="dw-subtlest">Shortcuts work when no dialog or text field has focus. After a decision the next proposal is selected.</p>
    </Dialog>
  );
}
