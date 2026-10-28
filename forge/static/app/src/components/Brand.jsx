// The Dowser identity: the mark (a divining rod over rippling water), the app bar every global-page tab shares
// (wordmark, tabs as navigation, inbox selector, run summary) and the empty-state illustration. Colours come from
// brand.css (the gradient) and ADS tokens; nothing here is a literal colour.
import React from 'react';
import { router } from '@forge/bridge';
import { pageUrl } from './deeplink.js';
import { formatDate, plural } from './labels.js';

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

export const TABS = [
  { route: 'inbox', label: 'Inbox' },
  { route: 'map', label: 'Opportunity map' },
  { route: 'reflect', label: 'Learning' },
  { route: 'settings', label: 'Settings' },
];

/** The most recent push across inboxes (or the selected one). */
function summarise(inboxes, projectKey) {
  const list = (inboxes ?? []).filter((i) => !projectKey || i.project_key === projectKey);
  const open = list.reduce((n, i) => n + (i.open ?? 0), 0);
  const last = list.map((i) => i.last_push).filter(Boolean).sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
  return { open, last, count: list.length };
}

/**
 * @param {{
 *   context?: any, active: string, title: string, inboxes?: any[], projectKey?: string,
 *   onProjectChange?: (key: string) => void, allOption?: boolean, extra?: React.ReactNode,
 * }} props
 * `title` is the page's h1 (visually hidden: the active tab already says it).
 */
export function AppHeader({ context, active, title, inboxes, projectKey = '', onProjectChange, allOption = false, extra }) {
  const here = context?.extension?.location;
  const { open, last, count } = summarise(inboxes, projectKey);
  return (
    <header className="dw-appbar">
      <div className="dw-appbar__strip" aria-hidden="true" />
      <div className="dw-appbar__row">
        <span className="dw-brand"><Mark /><span className="dw-brand__word">Dowser</span></span>
        <nav aria-label="Dowser sections" className="dw-nav">
          {TABS.map((t) => {
            const current = t.route === active;
            const url = current ? undefined : pageUrl(here, t.route);
            if (!url) {
              return <span key={t.route} className="dw-nav__link" aria-current={current ? 'page' : undefined} aria-disabled={current ? undefined : 'true'}>{t.label}</span>;
            }
            return (
              <a key={t.route} className="dw-nav__link" href={url} onClick={(e) => { e.preventDefault(); router.navigate(url).catch(() => {}); }}>{t.label}</a>
            );
          })}
        </nav>
        <span className="dw-spacer" />
        {extra}
        {onProjectChange && inboxes && inboxes.length > 0 && (
          <label className="dw-appbar__select">
            <span className="dw-subtlest">Inbox</span>
            <select className="dw-select" value={projectKey} onChange={(e) => onProjectChange(e.target.value)}>
              {allOption && <option value="">All inboxes</option>}
              {inboxes.map((i) => <option key={i.project_key} value={i.project_key}>{i.project_key} ({i.open} open)</option>)}
            </select>
          </label>
        )}
      </div>
      <h1 className="dw-visually-hidden">{title}</h1>
      {inboxes && (
        <p className="dw-appbar__summary" aria-label="Run summary">
          {last ? (
            <>
              <span>Last push <strong>{formatDate(last.at)}</strong></span>
              <span>{plural(last.created ?? 0, 'new item')} · {last.updated ?? 0} updated</span>
            </>
          ) : <span>No push has reached {count > 1 ? 'these inboxes' : 'this inbox'} yet</span>}
          <span><strong>{open}</strong> open now</span>
        </p>
      )}
    </header>
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
