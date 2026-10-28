// Variant 1 header: one 48px row (mark, tabs, quiet run summary, help, inbox select). The brand gradient lives only in
// the selected tab's underline and the mark.
import React from 'react';
import { router } from '@forge/bridge';
import { pageUrl } from '../../components/deeplink.js';
import { Mark, TABS } from '../../components/Brand.jsx';
import { shortDate } from './fmt.js';

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
 */
export function Header({ context, active, title, inboxes, projectKey = '', onProjectChange, allOption = false, extra }) {
  const here = context?.extension?.location;
  const { open, last, count } = summarise(inboxes, projectKey);
  return (
    <header className="dw1-bar">
      <div className="dw1-bar__row">
        <span className="dw1-bar__mark" title="Dowser"><Mark size={20} /></span>
        <nav aria-label="Dowser sections" className="dw1-tabs">
          {TABS.map((t) => {
            const current = t.route === active;
            const url = current ? undefined : pageUrl(here, t.route);
            if (!url) return <span key={t.route} className="dw1-tab" aria-current={current ? 'page' : undefined} aria-disabled={current ? undefined : 'true'}>{t.label}</span>;
            return <a key={t.route} className="dw1-tab" href={url} onClick={(e) => { e.preventDefault(); router.navigate(url).catch(() => {}); }}>{t.label}</a>;
          })}
        </nav>
        <span className="dw1-spacer" />
        {inboxes && (
          <p className="dw1-bar__summary" aria-label="Run summary">
            {last
              ? <>Last push {shortDate(last.at)} <span aria-hidden="true">·</span> <strong>{open}</strong> open</>
              : <>No push has reached {count > 1 ? 'these inboxes' : 'this inbox'} yet</>}
          </p>
        )}
        {extra}
        {onProjectChange && inboxes && inboxes.length > 0 && (
          <select className="dw-select dw1-select" aria-label="Inbox" value={projectKey} onChange={(e) => onProjectChange(e.target.value)}>
            {allOption && <option value="">All inboxes</option>}
            {inboxes.map((i) => <option key={i.project_key} value={i.project_key}>{i.project_key} ({i.open} open)</option>)}
          </select>
        )}
      </div>
      <h1 className="dw-visually-hidden">{title}</h1>
    </header>
  );
}
