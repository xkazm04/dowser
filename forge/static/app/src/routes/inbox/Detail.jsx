// The reading content of one proposal: header, rationale, a facts grid (effort, confidence and its reason, evidence
// strength, delivery risk, doc impact), the evidence EXPANDED (this is where people decide), the write-up behind a
// disclosure and the triage history. Used by the reading pane, the narrow accordion and the 360px issue panel.
// Every fact is printed, "not measured" included: the pane is the expanded view.
import React from 'react';
import { Lozenge } from '../../components/ui.jsx';
import { Markdown } from '../../components/Markdown.jsx';
import { TriageHistory } from '../../components/ProposalCard.jsx';
import {
  CHANGE_LABELS, EVIDENCE_LABELS, LENS_LABELS, LEVEL_LABELS, STATUS_APPEARANCE, STATUS_LABELS, evidenceStrength, plural,
} from '../../components/labels.js';
import { LensDot, Meter, Pips, effortDays } from './parts.jsx';

function Risk({ risk }) {
  if (!risk) return <span className="dwr-muted">Not measured</span>;
  return (
    <span>
      Blast radius {(LEVEL_LABELS[risk.blast] ?? risk.blast).toLowerCase()}
      <span className="dwr-muted"> · </span>
      {risk.bus_factor !== undefined
        ? <>bus factor {risk.bus_factor}{risk.bus_factor <= 1 && <> <Lozenge appearance="removed">single owner</Lozenge></>}</>
        : <span className="dwr-muted">bus factor not measured</span>}
    </span>
  );
}

export function Evidence({ evidence }) {
  if (evidence.length === 0) return <p className="dwr-muted">No evidence attached.</p>;
  return (
    <ul className="dwr-ev">
      {evidence.map((ev, i) => {
        const href = ev.link ?? ev.url;
        const isCode = ev.type === 'code' || ev.type === 'doc';
        return (
          <li key={`${ev.type}:${ev.ref}:${i}`} className="dwr-ev__item">
            <span className="dwr-ev__type">{EVIDENCE_LABELS[ev.type] ?? ev.type}</span>
            <div className="dwr-ev__body">
              <span className="dwr-ev__ref">{href ? <a href={href} target="_blank" rel="noreferrer noopener">{ev.ref}</a> : ev.ref}</span>
              {ev.quote && (isCode
                ? <pre className="dwr-code"><code>{ev.quote}</code></pre>
                : <blockquote className="dwr-quote">{ev.quote}</blockquote>)}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * @param {{
 *   card: any, change?: 'new'|'grew'|'reopened', history?: any[] | 'loading', compact?: boolean, titleId?: string,
 * }} props
 */
export function Detail({ card, change, history, compact = false, titleId }) {
  const isOpen = card.status === 'open';
  const marker = isOpen ? (card.reopened ? 'reopened' : change) : undefined;
  const strength = evidenceStrength(card);
  const basis = card.effort?.basis ?? [];
  const days = card.effort ? effortDays(card.effort) : '';
  const hasHistory = Array.isArray(history) && history.length > 0;
  return (
    <article className={`dwr-detail${compact ? ' dwr-detail--compact' : ''}`} aria-labelledby={titleId}>
      <header className="dwr-detail__head">
        <span className="dwr-detail__meta">
          <LensDot lens={card.lens} />
          <span>{LENS_LABELS[card.lens] ?? card.lens}</span>
          <span className="dwr-ref">{card.ref}</span>
          {marker && (marker === 'reopened'
            ? <Lozenge appearance="moved">Reopened</Lozenge>
            : <Lozenge appearance={marker === 'new' ? 'new' : 'inprogress'}>{CHANGE_LABELS[marker]}</Lozenge>)}
          {!isOpen && <Lozenge appearance={STATUS_APPEARANCE[card.status] ?? 'default'}>{STATUS_LABELS[card.status] ?? card.status}</Lozenge>}
          {card.issue_ref && (card.issue_url
            ? <a href={card.issue_url} target="_blank" rel="noreferrer noopener">{card.issue_ref}</a>
            : <span>{card.issue_ref}</span>)}
        </span>
        <h2 className="dwr-detail__title" id={titleId}>{card.title}</h2>
      </header>

      <p className="dwr-rationale">{card.rationale}</p>

      <dl className="dwr-facts">
        <dt>Effort</dt>
        <dd>
          {card.effort
            ? <><strong>{card.effort.size}</strong>{days && <span className="dwr-muted"> · {days}</span>}</>
            : <span className="dwr-muted">Not estimated</span>}
          {basis.length > 0 && <div className="dwr-why">Rests on {basis.map((b, i) => <span key={b}>{i > 0 && ', '}<span className="dwr-ref">{b}</span></span>)}</div>}
        </dd>
        <dt>Confidence</dt>
        <dd>
          <Pips level={card.confidence} /> <strong>{LEVEL_LABELS[card.confidence] ?? card.confidence}</strong>
          {card.confidence_why && <div className="dwr-why">{card.confidence_why}</div>}
        </dd>
        <dt>Evidence</dt>
        <dd>
          <Meter strength={strength} /> <strong>{strength.label}</strong>
          <span className="dwr-muted"> · {strength.count === 0 ? 'none attached' : `${plural(strength.count, 'item')} of ${plural(strength.kinds, 'kind')}`}</span>
        </dd>
        <dt>Delivery risk</dt>
        <dd><Risk risk={card.delivery_risk} /></dd>
        <dt>Doc impact</dt>
        <dd>
          {card.doc_impact && card.doc_impact.length > 0
            ? card.doc_impact.map((d, i) => <span key={d}>{i > 0 && ', '}<span className="dwr-ref">{d}</span></span>)
            : <span className="dwr-muted">None named</span>}
        </dd>
      </dl>

      <section className="dwr-section" aria-label="Evidence">
        <h3 className="dwr-h3">Evidence <span className="dwr-count">{card.evidence?.length ?? 0}</span></h3>
        <Evidence evidence={card.evidence ?? []} />
      </section>

      {card.body && (
        <details className="dwr-more">
          <summary>Full write-up</summary>
          <Markdown source={card.body} />
        </details>
      )}

      {(history === 'loading' || history === 'error' || hasHistory || (!isOpen && Array.isArray(history))) && (
        <section className="dwr-section" aria-label="Triage history">
          <h3 className="dwr-h3">Triage history</h3>
          {history === 'loading' ? <p className="dwr-muted">Loading...</p> : history === 'error' ? <p className="dwr-muted" role="alert">The history could not load.</p> : <TriageHistory history={history} />}
        </section>
      )}
    </article>
  );
}
