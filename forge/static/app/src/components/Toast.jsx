// Toasts: a live region that slides notices in at the bottom left. An `undo` toast shows a timer bar for its
// commit window and an Undo button; it pauses while hovered or focused. An info notice dismisses itself after
// noticeMs, but never while it is hovered or holds focus (its link may be the only one to a new Jira issue, WCAG
// 2.2.1): the timer starts again when the pointer and focus leave. Errors stay until dismissed.
import React, { useEffect, useState } from 'react';

/** @param {{toast: any, onUndo: (id: number) => void, onDismiss: (id: number) => void, onPause: (id: number) => void, onResume: (id: number) => void, noticeMs: number}} props */
function Toast({ toast, onUndo, onDismiss, onPause, onResume, noticeMs }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const held = hovered || focused;
  useEffect(() => {
    if (toast.kind !== 'info' || held) return undefined;
    const t = setTimeout(() => onDismiss(toast.id), noticeMs);
    return () => clearTimeout(t);
  }, [toast.id, toast.kind, noticeMs, onDismiss, held]);
  const undoable = toast.kind === 'undo';
  const hold = (/** @type {(v: boolean) => void} */ set) => () => { set(true); if (undoable) onPause(toast.id); };
  /** @param {(v: boolean) => void} set @param {boolean} other the other hold (hover or focus) */
  const release = (set, other) => () => { set(false); if (undoable && !other) onResume(toast.id); };
  return (
    <div
      className={`dw-toast${toast.kind === 'error' ? ' dw-toast--error' : ''}`}
      role={toast.kind === 'error' ? 'alert' : undefined}
      onMouseEnter={hold(setHovered)} onMouseLeave={release(setHovered, focused)}
      onFocus={hold(setFocused)}
      onBlur={(e) => { if (!e.currentTarget.contains(/** @type {Node | null} */ (e.relatedTarget))) release(setFocused, hovered)(); }}
    >
      <span className="dw-toast__msg">{toast.message}</span>
      {undoable && (
        <button type="button" className="dw-btn dw-btn--subtle dw-btn--compact" onClick={() => onUndo(toast.id)} aria-label={`Undo: ${toast.message}`} aria-keyshortcuts="u">
          Undo <span className="dw-kbd" aria-hidden="true">u</span>
        </button>
      )}
      {!undoable && (
        <button type="button" className="dw-btn dw-btn--subtle dw-btn--compact" onClick={() => onDismiss(toast.id)} aria-label="Dismiss notification">&times;</button>
      )}
      {undoable && <span className="dw-toast__timer" aria-hidden="true" style={{ animationDuration: `${toast.ms}ms` }} />}
    </div>
  );
}

/** @param {{cw: ReturnType<typeof import('./useCommitWindow.js').useCommitWindow>}} props */
export function ToastRegion({ cw }) {
  return (
    <div className="dw-toasts" role="region" aria-label="Notifications">
      <div aria-live="polite" aria-atomic="false" style={{ display: 'contents' }}>
        {cw.toasts.map((t) => (
          <Toast key={t.id} toast={t} onUndo={cw.undo} onDismiss={cw.dismiss} onPause={cw.pause} onResume={cw.resume} noticeMs={cw.NOTICE_MS} />
        ))}
      </div>
    </div>
  );
}
