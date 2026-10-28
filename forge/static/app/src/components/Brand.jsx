// The Dowser identity: the mark (a divining rod over rippling water) and the empty-state illustration. Colours come from
// brand.css (the gradient) and ADS tokens; nothing here is a literal colour.
import React from 'react';

/** @param {{size?: number, title?: string}} props */
export function Mark({ size = 28, title }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : 'true'} focusable="false">
      <defs>
        <linearGradient id="dw-brand-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" className="dw-stop-a" />
          <stop offset="1" className="dw-stop-b" />
        </linearGradient>
      </defs>
      <circle cx="16" cy="16" r="15" fill="none" stroke="url(#dw-brand-grad)" strokeWidth="2" />
      {/* the rod: a forked stick, tips up */}
      <path d="M16 22 V14 M16 14 L10.5 6.5 M16 14 L21.5 6.5" fill="none" stroke="url(#dw-brand-grad)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      {/* the ripple: water found below */}
      <path d="M9 25.5 Q16 21.5 23 25.5" fill="none" stroke="url(#dw-brand-grad)" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** The ripple illustration for earned-empty states. */
export function EmptyArt({ size = 96 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 96 96" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="dw-empty-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" className="dw-stop-a" />
          <stop offset="1" className="dw-stop-b" />
        </linearGradient>
      </defs>
      <ellipse className="dw-ripple dw-ripple--2" cx="48" cy="74" rx="38" ry="10" fill="none" stroke="url(#dw-empty-grad)" strokeWidth="2" />
      <ellipse className="dw-ripple" cx="48" cy="74" rx="38" ry="10" fill="none" stroke="url(#dw-empty-grad)" strokeWidth="2" />
      <ellipse cx="48" cy="74" rx="18" ry="5" fill="none" stroke="url(#dw-empty-grad)" strokeWidth="2.5" />
      <path d="M48 66 V38 M48 38 L32 14 M48 38 L64 14" fill="none" stroke="url(#dw-empty-grad)" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
