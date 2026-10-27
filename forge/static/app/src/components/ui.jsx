// Small Atlassian-styled primitives on plain elements + design tokens (see theme.css for why not Atlaskit
// components). Buttons are <button>, dialogs are native <dialog> opened modally (focus trapped, Escape
// closes, focus returns to the opener).
import React, { useCallback, useEffect, useRef, useState } from 'react';

/** @param {{appearance?: 'default'|'primary'|'danger'|'subtle', compact?: boolean, busy?: boolean} & React.ButtonHTMLAttributes<HTMLButtonElement>} props */
export function Button({ appearance = 'default', compact = false, busy = false, className = '', children, type = 'button', disabled, ...rest }) {
  const cls = ['dw-btn', appearance !== 'default' && `dw-btn--${appearance}`, compact && 'dw-btn--compact', className].filter(Boolean).join(' ');
  return (
    <button type={type} className={cls} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
      {busy && <span className="dw-spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}

export function Lozenge({ appearance = 'default', children }) {
  return <span className={`dw-lozenge dw-lozenge--${appearance}`}>{children}</span>;
}

/** @param {{appearance?: 'information'|'error'|'success'|'warning', title?: string, children?: React.ReactNode, role?: string}} props */
export function SectionMessage({ appearance = 'information', title, children, role }) {
  return (
    <div className={`dw-msg dw-msg--${appearance}`} role={role ?? (appearance === 'error' ? 'alert' : undefined)}>
      <div>
        {title && <h3 className="dw-h3">{title}</h3>}
        {children}
      </div>
    </div>
  );
}

export function Spinner({ label = 'Loading' }) {
  return <span className="dw-spinner" role="status" aria-label={label} />;
}

/** Card-shaped placeholders while a surface loads. */
export function SkeletonList({ count = 3, label = 'Loading' }) {
  return (
    <div role="status" aria-label={label} aria-busy="true">
      <div className="dw-skel" style={{ height: 20, width: 240, margin: '20px 0 12px' }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {Array.from({ length: count }, (_, i) => <div key={i} className="dw-skel dw-skel-card" />)}
      </div>
    </div>
  );
}

/** One plain sentence and a Retry button. */
export function ErrorState({ error, onRetry, what = 'Dowser' }) {
  const message = error?.message ? String(error.message) : 'Something went wrong.';
  return (
    <SectionMessage appearance="error" title={`${what} could not load.`}>
      <p>{message}</p>
      {onRetry && <p style={{ marginTop: 8 }}><Button onClick={onRetry}>Retry</Button></p>}
    </SectionMessage>
  );
}

/**
 * Modal dialog on the native <dialog> element.
 * @param {{title: string, onClose: () => void, children: React.ReactNode, footer: React.ReactNode, labelId?: string}} props
 */
export function Dialog({ title, onClose, children, footer }) {
  const ref = useRef(/** @type {HTMLDialogElement | null} */ (null));
  const titleId = useRef(`dw-dlg-${Math.random().toString(36).slice(2)}`).current;
  useEffect(() => {
    const opener = /** @type {HTMLElement | null} */ (document.activeElement);
    const el = ref.current;
    if (el && !el.open) {
      if (typeof el.showModal === 'function') el.showModal();
      else el.setAttribute('open', '');
    }
    return () => { if (opener && typeof opener.focus === 'function') opener.focus(); };
  }, []);
  return (
    <dialog
      ref={ref}
      className="dw-dialog"
      aria-labelledby={titleId}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
    >
      <div className="dw-dialog__inner">
        <div className="dw-dialog__head"><h2 className="dw-h2" id={titleId}>{title}</h2></div>
        <div className="dw-dialog__body">{children}</div>
        <div className="dw-dialog__foot">{footer}</div>
      </div>
    </dialog>
  );
}

/**
 * Runs an async loader, with reload. `state` is {status: 'loading'|'ready'|'error', data?, error?}.
 * @template T
 * @param {() => Promise<T>} load
 * @param {any[]} deps
 */
export function useAsync(load, deps) {
  const [state, setState] = useState(/** @type {{status: string, data?: T, error?: any}} */ ({ status: 'loading' }));
  const seq = useRef(0);
  const run = useCallback(() => {
    const mine = ++seq.current;
    setState({ status: 'loading' });
    load().then(
      (data) => { if (mine === seq.current) setState({ status: 'ready', data }); },
      (error) => { if (mine === seq.current) setState({ status: 'error', error }); },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { run(); }, [run]);
  return { ...state, reload: run, setData: (/** @type {T} */ data) => setState({ status: 'ready', data }) };
}
