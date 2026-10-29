// The selected row, which is also the keyboard focus and drives the pane: the deep link, the first row on arrival,
// the next row after a decision, the focus back on a restored card, and j/k movement.
import { useEffect, useRef, useState } from 'react';
import { deepLinkRef } from '../../components/deeplink.js';

/**
 * @param {{context: any, loadStatus: string, flat: any[], byRef: Map<string, any>, removed: Set<string>, leaving: Set<string>,
 *   focusRef: string, setFocusRef: (ref: string) => void, focusReq: string, setFocusReq: (ref: string) => void,
 *   dialog: {kind: string, refs: string[]} | null, setDialog: (d: {kind: string, refs: string[]}) => void, snoozeFor: string}} page
 */
export function useInboxFocus({
  context, loadStatus, flat, byRef, removed, leaving, focusRef, setFocusRef, focusReq, setFocusReq, dialog, setDialog, snoozeFor,
}) {
  const rowEls = useRef(/** @type {Record<string, HTMLElement | null>} */ ({}));
  const paneScroll = useRef(/** @type {HTMLElement | null} */ (null));
  const [linkRef, setLinkRef] = useState(/** @type {string | undefined} */ (undefined));
  const linkDone = useRef(false);

  // Deep link (`inbox?ref=DW-n`): select and scroll to the row; a card outside the loaded page opens read-only.
  useEffect(() => {
    let live = true;
    deepLinkRef(context).then((r) => { if (live) setLinkRef(r ?? ''); });
    return () => { live = false; };
  }, [context]);
  useEffect(() => {
    if (!linkRef || linkDone.current || loadStatus !== 'ready') return;
    linkDone.current = true;
    if (byRef.has(linkRef)) {
      setFocusRef(linkRef);
      requestAnimationFrame(() => {
        const el = rowEls.current[linkRef];
        if (el) { el.focus(); el.scrollIntoView?.({ block: 'center' }); }
      });
    } else {
      setDialog({ kind: 'card', refs: [linkRef] });
    }
  }, [linkRef, loadStatus, byRef]);

  // The first row is selected on arrival (the pane is never empty while there is work); focus is not stolen.
  useEffect(() => {
    if (loadStatus === 'ready' && !focusRef && flat.length > 0 && !(linkRef && !linkDone.current)) setFocusRef(flat[0].ref);
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
