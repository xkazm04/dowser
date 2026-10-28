// The undo window of a reversible verdict (snooze, reject). The caller removes the card from the list at once and
// hands the actual resolver call to schedule(); the call fires when the window ends (6 s), or earlier when the
// page is hidden or unloaded (best effort), when another decision is scheduled, or when flush() is called.
// undo() cancels the call and gives control back through onUndo. A failed call goes to onError, which restores
// the cards and says why. Nothing here knows about verdicts: it holds toasts and timers.
import { useCallback, useEffect, useRef, useState } from 'react';

export const COMMIT_MS = 6000;
const MAX_TOASTS = 3;
const NOTICE_MS = 5000;

/**
 * @typedef {{id: number, message: string, kind: 'undo' | 'info' | 'error', ms?: number}} ToastItem
 * @typedef {{id: number, message: string, run: () => Promise<unknown>, onUndo: () => void, onError: (e: unknown) => void,
 *   remaining: number, startedAt: number, timer: ReturnType<typeof setTimeout> | undefined}} Entry
 */

export function useCommitWindow({ ms = COMMIT_MS } = {}) {
  const entries = useRef(/** @type {Map<number, Entry>} */ (new Map()));
  const seq = useRef(0);
  const [toasts, setToasts] = useState(/** @type {ToastItem[]} */ ([]));

  const dismiss = useCallback((/** @type {number} */ id) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const show = useCallback((/** @type {Omit<ToastItem, 'id'>} */ toast) => {
    const id = ++seq.current;
    setToasts((t) => [...t, { id, ...toast }].slice(-MAX_TOASTS));
    return id;
  }, []);

  const commit = useCallback((/** @type {number} */ id) => {
    const e = entries.current.get(id);
    if (!e) return;
    clearTimeout(e.timer);
    entries.current.delete(id);
    dismiss(id);
    (async () => { await e.run(); })().catch((err) => e.onError(err));
  }, [dismiss]);

  const flush = useCallback(() => { for (const id of [...entries.current.keys()]) commit(id); }, [commit]);

  const arm = useCallback((/** @type {Entry} */ e) => {
    e.startedAt = Date.now();
    e.timer = setTimeout(() => commit(e.id), e.remaining);
  }, [commit]);

  /** Start a window. Any window still open is committed first ("another decision happens"). */
  const schedule = useCallback((/** @type {{message: string, run: () => Promise<unknown>, onUndo: () => void, onError: (e: unknown) => void}} */ spec) => {
    flush();
    const id = ++seq.current;
    /** @type {Entry} */
    const e = { id, ...spec, remaining: ms, startedAt: 0, timer: undefined };
    entries.current.set(id, e);
    arm(e);
    setToasts((t) => [...t, { id, message: spec.message, kind: 'undo', ms }].slice(-MAX_TOASTS));
    return id;
  }, [arm, flush, ms]);

  const undo = useCallback((/** @type {number} */ id) => {
    const e = entries.current.get(id);
    if (!e) return false;
    clearTimeout(e.timer);
    entries.current.delete(id);
    dismiss(id);
    e.onUndo();
    return true;
  }, [dismiss]);

  /** Undo the newest open window; false when there is none. */
  const undoLatest = useCallback(() => {
    const ids = [...entries.current.keys()];
    return ids.length > 0 ? undo(ids[ids.length - 1]) : false;
  }, [undo]);

  const pause = useCallback((/** @type {number} */ id) => {
    const e = entries.current.get(id);
    if (!e || e.timer === undefined) return;
    clearTimeout(e.timer);
    e.timer = undefined;
    e.remaining = Math.max(500, e.remaining - (Date.now() - e.startedAt));
  }, []);
  const resume = useCallback((/** @type {number} */ id) => {
    const e = entries.current.get(id);
    if (e && e.timer === undefined) arm(e);
  }, [arm]);

  const notify = useCallback((/** @type {string} */ message, kind = /** @type {'info' | 'error'} */ ('info')) => show({ message, kind }), [show]);

  // Page hidden or leaving: commit what is pending so a decision is not lost with the tab.
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === 'hidden') flush(); };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', flush);
    };
  }, [flush]);
  // Unmount (route change inside the app): same.
  useEffect(() => flush, [flush]);

  return { toasts, schedule, undo, undoLatest, flush, pause, resume, notify, dismiss, NOTICE_MS };
}
