// The selected row, which is also the keyboard focus and drives the pane: the deep link, the first row on arrival,
// the next row after a decision, the focus back on a restored card, and j/k movement. The selection itself is in the
// triage reducer (triage.js, which also moves it after a decision); this hook holds the DOM side.
import { useEffect, useLayoutEffect, useRef } from 'react';
import { call } from '../../api.js';

/**
 * Bring a row into view below the toolbar. The narrow toolbar is sticky and as tall as its wrapped controls, so the
 * row's scroll margin is measured, not a constant.
 * @param {HTMLElement} el
 */
function revealRow(el) {
  const bar = document.querySelector('.dwr-toolbar');
  const sticky = bar && getComputedStyle(bar).position === 'sticky';
  el.style.scrollMarginTop = sticky ? `${Math.ceil(bar.getBoundingClientRect().height) + 8}px` : '';
  el.scrollIntoView?.({ block: 'nearest' });
}

/**
 * @param {{linkRef: string | undefined, filters: {project_key?: string, status?: string}, pin: (card: any) => void,
 *   loadStatus: string, flat: any[], byRef: Map<string, any>, tri: import('./triage.js').TriageState,
 *   dispatch: (ev: import('./triage.js').TriageEvent) => void}} page
 *   `linkRef` is the deep link's card ('' for none, undefined until the link is read).
 */
export function useInboxFocus({ linkRef, filters, pin, loadStatus, flat, byRef, tri, dispatch }) {
  const { focus: focusRef, focusRequest: focusReq, dialog, step, decided } = tri;
  /** @param {string} ref */
  const setFocusRef = (ref) => dispatch({ type: 'focus', ref });
  const rowEls = useRef(/** @type {Record<string, HTMLElement | null>} */ ({}));
  const paneScroll = useRef(/** @type {HTMLElement | null} */ (null));
  const linkDone = useRef(false);
  const revealNext = useRef('');

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
        if (fits) { pin(card); land(card.ref); } else dispatch({ type: 'openDialog', kind: 'card', refs: [linkRef] });
      },
      () => dispatch({ type: 'openDialog', kind: 'card', refs: [linkRef] }),
    );
  }, [linkRef, loadStatus, byRef]);

  // The first row is selected on arrival (the pane is never empty while there is work); focus is not stolen. A
  // reducer event that only fills an empty selection, so a deep link landed in the same commit is not overwritten.
  useEffect(() => {
    if (loadStatus === 'ready' && !focusRef && flat.length > 0 && !(linkRef && !linkDone.current)) dispatch({ type: 'focusFirst', ref: flat[0].ref });
  }, [loadStatus, focusRef, flat, linkRef]);

  // Keep the selection valid: a decision moves it in the reducer; this catches a selected row that left the list
  // any other way, and moves it to the row now at the same position (the next one).
  const focusIndex = flat.findIndex((c) => c.ref === focusRef);
  const lastIndex = useRef(0);
  useEffect(() => {
    if (focusIndex >= 0) { lastIndex.current = focusIndex; return; }
    if (!focusRef || flat.length === 0) return;
    const ref = flat[Math.min(lastIndex.current, flat.length - 1)].ref;
    setFocusRef(ref);
    if (!dialog && !step) rowEls.current[ref]?.focus();
  }, [focusIndex, focusRef, flat, dialog, step]);

  // A row the reducer asked to focus (the next row after a decision, the card back after an Undo): give it the focus
  // once it is in the DOM.
  useEffect(() => {
    if (!focusReq) return;
    const el = rowEls.current[focusReq];
    if (el) { el.focus(); el.scrollIntoView?.({ block: 'nearest' }); dispatch({ type: 'focusDone' }); }
  }, [focusReq, decided]);

  // After j/k's commit, not before it: the narrow accordion has closed one card and opened the next, and that moves the row.
  useLayoutEffect(() => {
    if (!revealNext.current || revealNext.current !== focusRef) return;
    revealNext.current = '';
    const el = rowEls.current[focusRef];
    if (el) revealRow(el);
  }, [focusRef, tri.expanded]);

  // A new selection reads from the top.
  useEffect(() => { if (paneScroll.current) paneScroll.current.scrollTop = 0; }, [focusRef]);

  /** j/k: the selection moves and the narrow layout's accordion opens under it. @param {number} delta */
  function moveFocus(delta) {
    if (flat.length === 0) { dispatch({ type: 'focus', ref: focusRef, expand: true }); return; }
    const i = focusIndex < 0 ? 0 : Math.max(0, Math.min(flat.length - 1, focusIndex + delta));
    const ref = flat[i].ref;
    revealNext.current = ref;
    dispatch({ type: 'focus', ref, expand: true });
    rowEls.current[ref]?.focus({ preventScroll: true });
  }

  return { rowEls, paneScroll, focusIndex, moveFocus };
}
