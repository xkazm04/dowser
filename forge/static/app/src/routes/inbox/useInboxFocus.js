// The selected row, which is also the keyboard focus and drives the pane: the deep link, the first row on arrival,
// the next row after a decision, the focus back on a restored card, and j/k movement.
import { useEffect, useRef } from 'react';
import { call } from '../../api.js';

/**
 * @param {{linkRef: string | undefined, filters: {project_key?: string, status?: string}, pin: (card: any) => void,
 *   loadStatus: string, flat: any[], byRef: Map<string, any>, removed: Set<string>, leaving: Set<string>,
 *   focusRef: string, setFocusRef: (ref: string | ((cur: string) => string)) => void, focusReq: string, setFocusReq: (ref: string) => void,
 *   dialog: {kind: string, refs: string[]} | null, setDialog: (d: {kind: string, refs: string[]}) => void, snoozeFor: string}} page
 *   `linkRef` is the deep link's card ('' for none, undefined until the link is read).
 */
export function useInboxFocus({
  linkRef, filters, pin, loadStatus, flat, byRef, removed, leaving, focusRef, setFocusRef, focusReq, setFocusReq, dialog, setDialog, snoozeFor,
}) {
  const rowEls = useRef(/** @type {Record<string, HTMLElement | null>} */ ({}));
  const paneScroll = useRef(/** @type {HTMLElement | null} */ (null));
  const linkDone = useRef(false);

  /** Select a row and bring it into view (once it is in the DOM). @param {string} ref */
  function land(ref) {
    setFocusRef(ref);
    requestAnimationFrame(() => {
      const el = rowEls.current[ref];
      if (el) { el.focus(); el.scrollIntoView?.({ block: 'center' }); }
    });
  }

  // Deep link (`inbox?ref=DW-n`): select and scroll to the row. A card outside the loaded pages that the list's
  // filters would show (an open card, in the filtered inbox) is pinned above them, so it can be decided where the
  // link lands; any other card (decided, or another inbox) opens read-only.
  useEffect(() => {
    if (!linkRef || linkDone.current || loadStatus !== 'ready') return;
    linkDone.current = true;
    if (byRef.has(linkRef)) { land(linkRef); return; }
    call('proposal.get', { ref: linkRef }).then(
      (res) => {
        const card = res?.card;
        const fits = card && card.status === (filters.status ?? 'open') && card.status === 'open'
          && (!filters.project_key || card.project_key === filters.project_key);
        if (fits) { pin(card); land(card.ref); } else setDialog({ kind: 'card', refs: [linkRef] });
      },
      () => setDialog({ kind: 'card', refs: [linkRef] }),
    );
  }, [linkRef, loadStatus, byRef]);

  // The first row is selected on arrival (the pane is never empty while there is work); focus is not stolen. A
  // functional update, so a deep link landed in the same commit is not overwritten.
  useEffect(() => {
    if (loadStatus === 'ready' && !focusRef && flat.length > 0 && !(linkRef && !linkDone.current)) setFocusRef((cur) => cur || flat[0].ref);
  }, [loadStatus, focusRef, flat, linkRef]);

  // Keep the selection valid after removals: it moves to the row now at the same position (the next one).
  const focusIndex = flat.findIndex((c) => c.ref === focusRef);
  const lastIndex = useRef(0);
  useEffect(() => {
    if (focusIndex >= 0) { lastIndex.current = focusIndex; return; }
    if (!focusRef || flat.length === 0) return;
    const ref = flat[Math.min(lastIndex.current, flat.length - 1)].ref;
    setFocusRef(ref);
    if (!dialog && !snoozeFor) rowEls.current[ref]?.focus();
  }, [focusIndex, focusRef, flat, dialog, snoozeFor]);

  // After an Undo (or a failed commit) the card is back; give it the focus once it is in the DOM.
  useEffect(() => {
    if (!focusReq) return;
    const el = rowEls.current[focusReq];
    if (el) { el.focus(); el.scrollIntoView?.({ block: 'nearest' }); setFocusReq(''); }
  }, [focusReq, removed, leaving]);

  // A new selection reads from the top.
  useEffect(() => { if (paneScroll.current) paneScroll.current.scrollTop = 0; }, [focusRef]);

  function moveFocus(delta) {
    if (flat.length === 0) return;
    const i = focusIndex < 0 ? 0 : Math.max(0, Math.min(flat.length - 1, focusIndex + delta));
    const ref = flat[i].ref;
    setFocusRef(ref);
    const el = rowEls.current[ref];
    if (el) { el.focus(); el.scrollIntoView?.({ block: 'nearest' }); }
  }

  return { rowEls, paneScroll, focusIndex, moveFocus };
}
