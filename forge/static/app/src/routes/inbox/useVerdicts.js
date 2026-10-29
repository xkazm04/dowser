// The decisions made on this page: which cards are leaving (the exit animation) or gone, what each was decided as,
// which are checked for a bulk action, and the per-card errors. Snooze and reject go through the undo window
// (useCommitWindow): the card leaves at once, Undo or a failed call brings it back with the focus.
import { useRef, useState } from 'react';
import { call } from '../../api.js';
import { REASON_LABELS, comesBack, plural } from '../../components/labels.js';

const EXIT_MS = 200;

const reducedMotion = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const withoutKeys = (set, refs) => { const s = new Set(set); refs.forEach((r) => s.delete(r)); return s; };

/**
 * @param {{cw: ReturnType<typeof import('../../components/useCommitWindow.js').useCommitWindow>,
 *   setFocusRef: (ref: string) => void, setFocusReq: (ref: string) => void, setSnoozeFor: (ref: string) => void}} page
 *   the page's selection setters: a restored card takes the focus, a deferred snooze closes the snooze step.
 */
export function useVerdicts({ cw, setFocusRef, setFocusReq, setSnoozeFor }) {
  const [removed, setRemoved] = useState(() => new Set());
  const [leaving, setLeaving] = useState(() => new Set());
  const [decided, setDecided] = useState(() => new Map());
  const [selected, setSelected] = useState(() => new Set());
  const [errors, setErrors] = useState(/** @type {Record<string, string>} */ ({}));
  const exitTimers = useRef(/** @type {Map<string, ReturnType<typeof setTimeout>>} */ (new Map()));

  /** A reload starts the page over. */
  function reset() {
    setRemoved(new Set()); setLeaving(new Set()); setDecided(new Map()); setSelected(new Set()); setErrors({});
  }

  function toggle(ref) {
    setSelected((prev) => { const s = new Set(prev); if (s.has(ref)) s.delete(ref); else s.add(ref); return s; });
  }

  function leave(cards, to) {
    const refs = cards.map((c) => c.ref);
    setDecided((prev) => { const m = new Map(prev); refs.forEach((r) => m.set(r, to)); return m; });
    setSelected((prev) => withoutKeys(prev, refs));
    setErrors((prev) => { const e = { ...prev }; refs.forEach((r) => delete e[r]); return e; });
    if (reducedMotion()) { setRemoved((prev) => new Set([...prev, ...refs])); return; }
    setLeaving((prev) => new Set([...prev, ...refs]));
    for (const r of refs) {
      exitTimers.current.set(r, setTimeout(() => {
        exitTimers.current.delete(r);
        setRemoved((prev) => new Set([...prev, r]));
        setLeaving((prev) => withoutKeys(prev, [r]));
      }, EXIT_MS));
    }
  }

  function restore(refs, focus = true) {
    for (const r of refs) { clearTimeout(exitTimers.current.get(r)); exitTimers.current.delete(r); }
    setRemoved((prev) => withoutKeys(prev, refs));
    setLeaving((prev) => withoutKeys(prev, refs));
    setDecided((prev) => { const m = new Map(prev); refs.forEach((r) => m.delete(r)); return m; });
    if (focus) { setFocusRef(refs[0]); setFocusReq(refs[0]); }
  }

  function fail(refs, message) {
    setErrors((prev) => ({ ...prev, ...Object.fromEntries(refs.map((r) => [r, message])) }));
  }

  function failDeferred(refs, what, e) {
    const message = String(e?.message ?? `The ${what} failed.`);
    restore(refs, false);
    fail(refs, message);
    cw.notify(`Could not ${what} ${refs.length === 1 ? refs[0] : plural(refs.length, 'proposal')}: ${message} It is back in the list.`, 'error');
  }

  function deferSnooze(cards, note = '', until = '') {
    const refs = cards.map((c) => c.ref);
    setSnoozeFor('');
    leave(cards, 'snoozed');
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

  return { removed, leaving, decided, selected, setSelected, errors, reset, toggle, leave, fail, deferSnooze, deferReject };
}
