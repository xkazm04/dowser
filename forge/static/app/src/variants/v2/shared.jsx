// Variant 2 shared pieces: the masthead that replaces the app bar, the lens dot, small formatters.
import React from 'react';
import { router } from '@forge/bridge';
import { pageUrl } from '../../components/deeplink.js';
import { Mark } from '../../components/Brand.jsx';
import { formatDate, plural } from '../../components/labels.js';

/** Short date: "27 Oct, 10:14" (the year only when it is not this year). */
export function formatShort(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }), hour: '2-digit', minute: '2-digit' });
}

/** Navigate to another page of the global page; in the dev server the hash also keeps the variant and colour mode. */
export function goTo(url, route) {
  if (import.meta.env.DEV) {
    const keep = location.hash.match(/&(?:v|mode)=[^&]+/g) ?? [];
    location.hash = [route, ...keep.map((s) => s.slice(1))].join('&');
    return;
  }
  router.navigate(url).catch(() => {});
}

/** @param {{lens: string}} props */
export function LensDot({ lens }) {
  return <span className={`dw2-dot dw2-dot--${lens}`} aria-hidden="true" />;
}

/** The inbox selector styled as an inline text dropdown. */
function InboxPick({ inboxes, projectKey, onChange, allOption }) {
  const text = projectKey || (allOption ? 'All inboxes' : inboxes[0]?.project_key ?? '');
  return (
    <label className="dw2-pick">
      <span className="dw2-pick__text">{text}</span>
      <span className="dw-visually-hidden">Inbox</span>
      <select value={projectKey} onChange={(e) => onChange(e.target.value)}>
        {allOption && <option value="">All inboxes</option>}
        {inboxes.map((i) => <option key={i.project_key} value={i.project_key}>{i.project_key}</option>)}
      </select>
    </label>
  );
}

/**
 * @param {{
 *   context?: any, active: 'inbox'|'reflect', title: string, inboxes?: any[], projectKey?: string,
 *   onProjectChange?: (key: string) => void, allOption?: boolean, summary?: React.ReactNode, extra?: React.ReactNode,
 * }} props
 * Jira's sidebar already lists the four pages and prints "Dowser", so there is no wordmark and no tab bar: one line
 * with the inbox, one sentence about the state, and a text link to the sibling page.
 */
export function Masthead({ context, active, title, inboxes, projectKey = '', onProjectChange, allOption = false, summary, extra }) {
  const here = context?.extension?.location;
  const sibling = active === 'inbox' ? { route: 'reflect', label: 'What Dowser learned' } : { route: 'inbox', label: 'Back to the inbox' };
  const url = pageUrl(here, sibling.route);
  return (
    <header className="dw2-mast">
      <div className="dw2-mast__row">
        <span className="dw2-mast__mark" aria-hidden="true"><Mark size={16} /></span>
        <h1 className="dw2-mast__title">
          {onProjectChange && inboxes && inboxes.length > 0
            ? <><span className="dw-visually-hidden">{title}: </span><InboxPick inboxes={inboxes} projectKey={projectKey} onChange={onProjectChange} allOption={allOption} /></>
            : title}
        </h1>
        <span className="dw-spacer" />
        {url && (
          <a className="dw2-mast__link" href={url} onClick={(e) => { e.preventDefault(); goTo(url, sibling.route); }}>
            {active === 'reflect' && <span aria-hidden="true">&larr; </span>}{sibling.label}{active === 'inbox' && <span aria-hidden="true"> &rarr;</span>}
          </a>
        )}
        {extra}
      </div>
      {summary && <p className="dw2-mast__summary">{summary}</p>}
    </header>
  );
}

/** The most recent push across inboxes (or the selected one). */
export function summarise(inboxes, projectKey) {
  const list = (inboxes ?? []).filter((i) => !projectKey || i.project_key === projectKey);
  const open = list.reduce((n, i) => n + (i.open ?? 0), 0);
  const last = list.map((i) => i.last_push).filter(Boolean).sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
  return { open, last, count: list.length };
}

/** "Last push 27 Oct, 10:14 - 1 new, 2 grew - 8 waiting for you" as a sentence. */
export function PushSentence({ inboxes, projectKey, open: openNow }) {
  const { open: openAll, last, count } = summarise(inboxes, projectKey);
  const open = openNow ?? openAll;
  if (!inboxes || inboxes.length === 0) return null;
  return (
    <>
      {last
        ? <>Last push <strong>{formatShort(last.at)}</strong>, {last.created ?? 0} new{(last.updated ?? 0) > 0 && <>, {last.updated} grew</>}. </>
        : <>No push has reached {count > 1 ? 'these inboxes' : 'this inbox'} yet. </>}
      <strong>{open}</strong> waiting for you.
    </>
  );
}

export { formatDate, plural };
