// The inbox states other than the list: the loading skeleton and the empty view (which names the last push).
import React from 'react';
import { Button, SectionMessage } from '../../components/ui.jsx';
import { EmptyArt } from '../../components/Brand.jsx';
import { LENS_LABELS, STATUS_LABELS, formatDate, plural } from '../../components/labels.js';

export function LoadingBody({ wide }) {
  return (
    <div className="dwr-body" role="status" aria-label="Loading the inbox" aria-busy="true">
      <div className="dwr-list">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="dwr-skelrow"><div className="dw-skel dwr-skel-a" /><div className="dw-skel dwr-skel-b" /></div>
        ))}
      </div>
      {wide && (
        <div className="dwr-pane">
          <div className="dwr-pane__scroll"><div className="dwr-pane__in">
            <div className="dw-skel" style={{ height: 12, width: 180, marginBottom: 12 }} />
            <div className="dw-skel" style={{ height: 24, width: '70%', marginBottom: 16 }} />
            <div className="dw-skel" style={{ height: 56, marginBottom: 16 }} />
            <div className="dw-skel" style={{ height: 160 }} />
          </div></div>
        </div>
      )}
    </div>
  );
}

/**
 * The filters that narrow the list but not the inbox (a map cell's area, the machine pre-triaged switch), as the
 * words the empty view uses. Empty when neither is on.
 */
export function narrowingFilters({ area = '', pretriaged = false }) {
  const out = [];
  if (area) out.push({ key: 'area', words: <>in <code>{area === '.' ? '(repo root)' : area}</code></>, clear: 'Show every area' });
  if (pretriaged) out.push({ key: 'pretriaged', words: <>pre-triaged by the scan</>, clear: 'Show all, not only pre-triaged' });
  return out;
}

/**
 * The healthiest state is empty, and when the person got it there it says so. Under an area or pre-triaged
 * filter an empty list says nothing about the inbox: the view names the filter and offers to clear it, and never
 * says every proposal is decided.
 */
export function EmptyState({ status, lens, lastPush, tally, area = '', pretriaged = false, onClearArea, onClearPretriaged }) {
  const what = `${STATUS_LABELS[status].toLowerCase()} proposals${lens ? ` for ${LENS_LABELS[lens]}` : ''}`;
  const filters = narrowingFilters({ area, pretriaged });
  if (filters.length > 0) {
    const clear = { area: onClearArea, pretriaged: onClearPretriaged };
    return (
      <SectionMessage appearance="information" title={`No ${what} in this filtered view.`} role="status">
        <p>
          The list shows only proposals {filters.map((f, i) => <React.Fragment key={f.key}>{i > 0 && ' and '}{f.words}</React.Fragment>)}.
          {' '}Other {STATUS_LABELS[status].toLowerCase()} proposals may still wait outside this filter.
        </p>
        <p style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {filters.filter((f) => clear[f.key]).map((f) => (
            <Button key={f.key} compact onClick={clear[f.key]}>{f.clear}</Button>
          ))}
        </p>
      </SectionMessage>
    );
  }
  const lastLine = (
    <>
      {lastPush === undefined && <p className="dwr-muted">Checking the last push...</p>}
      {lastPush && (
        <p className="dwr-muted">
          The last push was run {lastPush.run_id} on {formatDate(lastPush.at)}
          {lastPush.lenses.length > 0 && <> ({lastPush.lenses.map((l) => LENS_LABELS[l] ?? l).join(', ')})</>}.
        </p>
      )}
      {lastPush === null && <p className="dwr-muted">No push has reached this inbox yet.</p>}
    </>
  );
  if (status === 'open' && !lens) {
    const parts = [['accepted', 'accepted'], ['rejected', 'rejected'], ['snoozed', 'snoozed'], ['merged', 'merged']].filter(([k]) => tally[k] > 0).map(([k, w]) => `${tally[k]} ${w}`);
    return (
      <section className="dwr-empty" role="status" aria-label="Queue is empty">
        <EmptyArt />
        {tally.total > 0 ? (
          <>
            <h2 className="dwr-empty__h">Queue cleared.</h2>
            <p>You decided {plural(tally.total, 'proposal')} this session: {parts.join(', ')}. Nothing is waiting on you.</p>
          </>
        ) : (
          <>
            <h2 className="dwr-empty__h">Nothing waiting on you.</h2>
            <p>Every proposal in this inbox has been decided.</p>
          </>
        )}
        {lastLine}
        <p className="dwr-muted">To file new proposals, run a scan: <code>/dowser</code> in Claude Code or Codex, in the repository.</p>
      </section>
    );
  }
  return (
    <SectionMessage appearance="information" title={`No ${what} here.`} role="status">
      {lastLine}
      <p style={{ marginTop: 8 }}>To file new proposals, run a scan: <code>/dowser</code> in Claude Code or Codex, in the repository. Verified proposals are pushed here.</p>
    </SectionMessage>
  );
}
