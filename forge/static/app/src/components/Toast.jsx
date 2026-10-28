// Toasts: a live region that slides notices in at the bottom left. An `undo` toast shows a timer bar for its
// commit window and an Undo button; it pauses while hovered or focused. Errors stay until dismissed.
import React, { useEffect } from 'react';

/** @param {{toast: any, onUndo: (id: number) => void, onDismiss: (id: number) => void, onPause: (id: number) => void, onResume: (id: number) => void, noticeMs: number}} props */
function Toast({ toast, onUndo, onDismiss, onPause, onResume, noticeMs }) {
  useEffect(() => {
    if (toast.kind !== 'info') return undefined;
    const t = setTimeout(() => onDismiss(toast.id), noticeMs);
    return () => clearTimeout(t);
  }, [toast.id, toast.kind, noticeMs, onDismiss]);
  const undoable = toast.kind === 'undo';
  return (
    <div
      className={`dw-toast${toast.kind === 'error' ? ' dw-toast--error' : ''}`}
      role={toast.kind === 'error' ? 'alert' : undefined}
      onMouseEnter={undoable ? () => onPause(toast.id) : undefined} onMouseLeave={undoable ? () => onResume(toast.id) : undefined}
      onFocus={undoable ? () => onPause(toast.id) : undefined} onBlur={undoable ? () => onResume(toast.id) : undefined}
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
