// The decisions made on this page, as effects around the triage reducer (triage.js): the exit timers that move a
// leaving card to gone, and the undo window (useCommitWindow) that snooze and reject go through: the card leaves at
// once, Undo or a failed call brings it back (Undo with the focus).
import { useRef } from 'react';
import { call } from '../../api.js';
import { REASON_LABELS, comesBack, plural } from '../../components/labels.js';

const EXIT_MS = 200;

const reducedMotion = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * @param {{cw: ReturnType<typeof import('../../components/useCommitWindow.js').useCommitWindow>,
 *   dispatch: (ev: import('./triage.js').TriageEvent) => void, order: () => string[]}} page
 *   `dispatch` is the page's triage reducer; `order` reads the rows listed now (top to bottom), which a decision
 *   moves the selection along.
 */
export function useVerdicts({ cw, dispatch, order }) {
  const exitTimers = useRef(/** @type {Map<string, ReturnType<typeof setTimeout>>} */ (new Map()));

  /** @param {string[]} refs */
  function clearTimers(refs) {
    for (const r of refs) { clearTimeout(exitTimers.current.get(r)); exitTimers.current.delete(r); }
  }

  /** A reload starts the page over. */
  function reset() {
    clearTimers([...exitTimers.current.keys()]);
    dispatch({ type: 'reset' });
  }

  /** The cards leave the list as `to`; each decision keeps the card's inbox, so the picker counts follow. */
  function leave(cards, to) {
    const instant = reducedMotion();
    dispatch({ type: 'decide', cards, to, order: order(), instant });
    if (instant) return;
    for (const c of cards) {
      const r = c.ref;
      clearTimeout(exitTimers.current.get(r));
      exitTimers.current.set(r, setTimeout(() => {
        exitTimers.current.delete(r);
        dispatch({ type: 'exitDone', ref: r });
      }, EXIT_MS));
    }
  }

  /** Undo: the cards are back, the first one with the focus. @param {string[]} refs */
  function restore(refs) {
    clearTimers(refs);
    dispatch({ type: 'undo', refs });
  }

  /** @param {string[]} refs @param {string} message */
  function fail(refs, message) {
    dispatch({ type: 'fail', refs, message });
  }

  function failDeferred(refs, what, e) {
    const message = String(e?.message ?? `The ${what} failed.`);
    clearTimers(refs);
    dispatch({ type: 'commitFailed', refs, message });
    cw.notify(`Could not ${what} ${refs.length === 1 ? refs[0] : plural(refs.length, 'proposal')}: ${message} It is back in the list.`, 'error');
  }

  function deferSnooze(cards, note = '', until = '') {
    const refs = cards.map((c) => c.ref);
    leave(cards, 'snoozed'); // the decision closes the snooze step
    cw.schedule({
      message: `${refs.length === 1 ? `Snoozed ${refs[0]}` : `Snoozed ${plural(refs.length, 'proposal')}`}${until ? `. ${comesBack(until)}` : ''}`,
      run: () => call('verdict.snooze', { refs, ...(note ? { note } : {}), ...(until ? { until } : {}) }),
      onUndo: () => restore(refs),
      onError: (e) => failDeferred(refs, 'snooze', e),
    });
  }

  function deferReject(cards, { reason, note }) {
    const refs = cards.map((c) => c.ref);
    leave(cards, 'rejected');
    cw.schedule({
      message: `${refs.length === 1 ? `Rejected ${refs[0]}` : `Rejected ${plural(refs.length, 'proposal')}`} (${REASON_LABELS[reason] ?? reason})`,
      run: () => call('verdict.reject', note ? { refs, reason, note } : { refs, reason }),
      onUndo: () => restore(refs),
      onError: (e) => failDeferred(refs, 'reject', e),
    });
  }

  return { reset, leave, fail, deferSnooze, deferReject };
}
