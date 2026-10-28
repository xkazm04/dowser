// A small overflow ("...") menu: button + role=menu popover. Escape or an outside click closes it, arrows move.
import React, { useEffect, useRef, useState } from 'react';

/** @param {{label: string, items: {label: string, onClick: () => void}[], onFocus?: () => void}} props */
export function MoreMenu({ label, items, onFocus }) {
  const [open, setOpen] = useState(false);
  const root = useRef(/** @type {HTMLSpanElement | null} */ (null));
  const btn = useRef(/** @type {HTMLButtonElement | null} */ (null));
  useEffect(() => {
    if (!open) return undefined;
    const menuItems = () => /** @type {HTMLElement[]} */ ([...(root.current?.querySelectorAll('[role="menuitem"]') ?? [])]);
    menuItems()[0]?.focus();
    const onDown = (e) => { if (root.current && !root.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); btn.current?.focus(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const els = menuItems();
        const i = els.indexOf(/** @type {HTMLElement} */ (document.activeElement));
        els[(i + (e.key === 'ArrowDown' ? 1 : els.length - 1)) % els.length]?.focus();
      } else if (e.key === 'Tab') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey, true); };
  }, [open]);
  return (
    <span className="dw1-more" ref={root}>
      <button
        ref={btn} type="button" className="dw-btn dw-btn--subtle dw-btn--compact dw1-more__btn" aria-label={label} aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen((o) => !o)} onFocus={onFocus}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="3" cy="8" r="1.4" fill="currentColor" /><circle cx="8" cy="8" r="1.4" fill="currentColor" /><circle cx="13" cy="8" r="1.4" fill="currentColor" /></svg>
      </button>
      {open && (
        <div className="dw1-more__menu" role="menu" aria-label={label}>
          {items.map((it) => (
            <button key={it.label} type="button" role="menuitem" className="dw1-more__item" onClick={() => { setOpen(false); it.onClick(); }}>{it.label}</button>
          ))}
        </div>
      )}
    </span>
  );
}
