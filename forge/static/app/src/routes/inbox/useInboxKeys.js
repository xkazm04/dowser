// The inbox keyboard: j/k/x/a/m/r/s/u/? on the list (no dialog open, no text field focused), and inside a dialog
// Ctrl/Cmd+Enter confirms and 1-6 pick the Reject reason. The help dialog lists the same keys.
import { useEffect } from 'react';
import { checkable, checkedVisible } from './triage.js';
import { REASONS } from '../../components/labels.js';

function isTyping(target) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/**
 * @param {{tri: import('./triage.js').TriageState, dispatch: (ev: import('./triage.js').TriageEvent) => void,
 *   flat: any[], focusIndex: number, byRef: Map<string, any>, moveFocus: (delta: number) => void,
 *   cw: {undoLatest: () => boolean}}} page
 */
export function useInboxKeys({ tri, dispatch, flat, focusIndex, byRef, moveFocus, cw }) {
  const dialog = tri.dialog;
  /** @param {string} kind @param {string[]} refs */
  const open = (kind, refs) => dispatch({ type: 'openDialog', kind, refs });
  // Keyboard: only when no dialog is open and no text field has focus.
  useEffect(() => {
    function onKey(e) {
      // A dialog the page does not track (the sample strip's Remove confirm) blocks the keys as well.
      if (dialog || document.querySelector('dialog.dw-dialog[open]') || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      const focused = focusIndex >= 0 ? flat[focusIndex] : undefined;
      const actionable = focused && focused.status === 'open';
      const many = checkedVisible(tri, byRef);
      switch (e.key) {
        case 'j': moveFocus(1); break;
        case 'k': moveFocus(-1); break;
        // only an open card is checked (as only an open row has the checkbox): a checked card is bulk-decided
        case 'x':
          if (focused && (tri.checked.has(focused.ref) || checkable(tri, focused))) dispatch({ type: 'toggle', card: focused }); else return;
          break;
        case 'a': if (actionable) open('accept', [focused.ref]); else return; break;
        case 'm': if (actionable) open('merge', [focused.ref]); else return; break;
        case 'r':
          if (many.length > 0) open('reject', many); else if (actionable) open('reject', [focused.ref]); else return;
          break;
        case 's':
          if (many.length > 0) dispatch({ type: 'openSnooze', bulk: true });
          else if (actionable) dispatch({ type: 'openSnooze', ref: focused.ref }); else return;
          break;
        case 'u': if (!cw.undoLatest()) return; break;
        case '?': open('help', []); break;
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
    const kind = dialog.kind;
    function onKey(e) {
      // Reject dialog: 1 to REASONS.length pick the reason (radios and the dialog itself, not the note field).
      const n = Number(e.key);
      if (kind === 'reject' && /^[1-9]$/.test(e.key) && n <= REASONS.length && !e.ctrlKey && !e.metaKey && !e.altKey
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
