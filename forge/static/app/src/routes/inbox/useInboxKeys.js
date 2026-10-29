// The inbox keyboard: j/k/x/a/m/r/s/u/? on the list (no dialog open, no text field focused), and inside a dialog
// Ctrl/Cmd+Enter confirms and 1-6 pick the Reject reason. The help dialog lists the same keys.
import { useEffect } from 'react';
import { BULK } from './InboxList.jsx';

function isTyping(target) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/**
 * @param {{dialog: {kind: string, refs: string[]} | null, setDialog: (d: {kind: string, refs: string[]}) => void,
 *   flat: any[], focusIndex: number, selected: Set<string>, byRef: Map<string, any>, moveFocus: (delta: number) => void,
 *   setExpanded: (v: boolean) => void, toggle: (ref: string) => void, open: (kind: string, refs: string[]) => void,
 *   setSnoozeFor: (ref: string) => void, cw: {undoLatest: () => boolean}}} page
 */
export function useInboxKeys({ dialog, setDialog, flat, focusIndex, selected, byRef, moveFocus, setExpanded, toggle, open, setSnoozeFor, cw }) {
  // Keyboard: only when no dialog is open and no text field has focus.
  useEffect(() => {
    function onKey(e) {
      if (dialog || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      const focused = focusIndex >= 0 ? flat[focusIndex] : undefined;
      const actionable = focused && focused.status === 'open';
      const many = [...selected].filter((r) => byRef.has(r));
      switch (e.key) {
        case 'j': moveFocus(1); setExpanded(true); break;
        case 'k': moveFocus(-1); setExpanded(true); break;
        case 'x': if (focused) toggle(focused.ref); else return; break;
        case 'a': if (actionable) open('accept', [focused.ref]); else return; break;
        case 'm': if (actionable) open('merge', [focused.ref]); else return; break;
        case 'r':
          if (many.length > 0) open('reject', many); else if (actionable) open('reject', [focused.ref]); else return;
          break;
        case 's':
          if (many.length > 0) setSnoozeFor(BULK);
          else if (actionable) { setExpanded(true); setSnoozeFor(focused.ref); } else return;
          break;
        case 'u': if (!cw.undoLatest()) return; break;
        case '?': setDialog({ kind: 'help', refs: [] }); break;
        default: return;
      }
      e.preventDefault();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  // Ctrl/Cmd+Enter confirms the open dialog (Accept: "Create issue", Reject: "Reject", Merge): `a` then Ctrl+Enter.
  useEffect(() => {
    if (!dialog) return undefined;
    function onKey(e) {
      // Reject dialog: 1-6 pick the reason (radios and the dialog itself, not the note field).
      if (dialog.kind === 'reject' && /^[1-6]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey
        && !(isTyping(e.target) && !(e.target instanceof HTMLInputElement && e.target.type === 'radio'))) {
        const radio = document.querySelectorAll('dialog.dw-dialog[open] input[name="dw-reason"]')[Number(e.key) - 1];
        if (radio instanceof HTMLElement) { e.preventDefault(); radio.click(); radio.focus(); }
        return;
      }
      if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return;
      const btn = document.querySelector('dialog.dw-dialog[open] .dw-dialog__foot .dw-btn--primary:not(:disabled), dialog.dw-dialog[open] .dw-dialog__foot .dw-btn--danger:not(:disabled)');
      if (btn instanceof HTMLElement) { e.preventDefault(); btn.click(); }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [dialog]);
}
