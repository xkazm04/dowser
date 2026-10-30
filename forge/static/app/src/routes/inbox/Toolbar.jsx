// The inbox toolbar: inbox picker, status segments with counts, lens filter, the area filter a map cell set (shown
// with a way to clear it), the machine pre-triaged filter, the last-push line and the help button.
import React from 'react';
import { Mark } from '../../components/Brand.jsx';
import { LENSES, LENS_LABELS, STATUSES, STATUS_LABELS, formatDate } from '../../components/labels.js';

/** "28 Oct, 19:21": several pushes a day are common, so the time is what tells them apart; the year is noise. */
export const shortWhen = (iso) => formatDate(iso).replace(/ \d{4}/, '');

/** The counts as loaded, moved by the decisions made since: every listed card had the filtered status. */
function summarise(inboxes, projectKey, status, decided) {
  const list = (inboxes ?? []).filter((i) => !projectKey || i.project_key === projectKey);
  // by_status is newer than open: an older backend sends only open, and the other segments then show no count.
  const by = Object.fromEntries(STATUSES.map((s) => [s, list.some((i) => i.by_status) ? list.reduce((n, i) => n + (i.by_status?.[s] ?? 0), 0) : undefined]));
  by.open = list.reduce((n, i) => n + (i.open ?? 0), 0);
  for (const to of decided?.values() ?? []) {
    if (by[status] !== undefined) by[status] -= 1;
    if (by[to] !== undefined) by[to] += 1;
  }
  const last = list.map((i) => i.last_push).filter(Boolean).sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
  return { by, last, count: list.length };
}

export function Toolbar({ inboxes, decided, projectKey, onProject, status, onStatus, lens, onLens, area = '', onClearArea, pretriaged = false, onPretriaged, onHelp }) {
  const { by, last, count } = summarise(inboxes, projectKey, status, decided);
  return (
    <header className="dwr-toolbar">
      <span className="dwr-toolbar__mark"><Mark size={16} /></span>
      {inboxes.length > 0 && (
        <label className="dwr-field">
          <span className="dwr-visually-hidden">Inbox</span>
          <select className="dwr-select" value={projectKey} onChange={(e) => onProject(e.target.value)}>
            <option value="">All inboxes</option>
            {inboxes.map((i) => <option key={i.project_key} value={i.project_key}>{i.project_key.split('/').pop()} ({i.open} open)</option>)}
          </select>
        </label>
      )}
      <div className="dwr-seg" role="group" aria-label="Filter by status">
        {STATUSES.map((s) => (
          <button key={s} type="button" className="dwr-seg__btn" aria-pressed={status === s} onClick={() => onStatus(s)}>
            {STATUS_LABELS[s]}{inboxes.length > 0 && by[s] !== undefined && <span className="dwr-seg__n">{by[s]}</span>}
          </button>
        ))}
      </div>
      <label className="dwr-field">
        <span className="dwr-visually-hidden">Lens</span>
        <select className="dwr-select" value={lens} onChange={(e) => onLens(e.target.value)} aria-label="Filter by lens">
          <option value="">All lenses</option>
          {LENSES.map((l) => <option key={l} value={l}>{LENS_LABELS[l]}</option>)}
        </select>
      </label>
      {area && projectKey && (
        <span className="dwr-chip" role="status">
          <span>Area: <code>{area === '.' ? '(repo root)' : area}</code></span>
          {onClearArea && (
            <button type="button" className="dwr-chip__x" onClick={onClearArea} aria-label={`Clear the area filter ${area}`} title="Show every area">×</button>
          )}
        </span>
      )}
      {onPretriaged && (
        <button type="button" className="dwr-seg__btn dwr-filter" aria-pressed={pretriaged} onClick={() => onPretriaged(!pretriaged)}
          aria-label="Only machine pre-triaged proposals"
          title="Only the proposals the scan pre-triaged on its own (a kind of proposal where its predictions matched yours)">
          Pre-triaged
        </button>
      )}
      <span className="dwr-spacer" />
      <p className="dwr-runline" aria-label="Run summary">
        {last
          ? <>Last push {shortWhen(last.at)} · {last.created ?? 0} new, {last.updated ?? 0} updated</>
          : <>No push has reached {count > 1 ? 'these inboxes' : 'this inbox'} yet</>}
      </p>
      <button type="button" className="dwr-iconbtn" onClick={onHelp} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">?</button>
    </header>
  );
}
