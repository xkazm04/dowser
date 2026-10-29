// The proposal card, shared by the inbox (interactive) and the evidence panel (read-only). Renders only what
// the Card carries: an absent key is "not measured" and is said so, never shown as 0. React 19 passes `ref` as
// a plain prop, so it reaches the <article> through `...rest` (the inbox focuses cards with j/k).
import React from 'react';
import { Lozenge, useAsync } from './ui.jsx';
import { call } from '../api.js';
import {
  CHANGE_LABELS, EVIDENCE_LABELS, LENS_LABELS, LEVEL_LABELS, REASON_LABELS, STATUS_APPEARANCE, STATUS_LABELS, comesBack, deciderName, evidenceStrength, formatDate, plural,
} from './labels.js';

/** @param {{lens: string}} props */
export function LensBadge({ lens }) {
  return <span className={`dw-lens dw-lens--${lens}`}>{LENS_LABELS[lens] ?? lens}</span>;
}

/** Effort as a chip; the basis (what the estimate rests on) sits with the evidence below. */
function effortDays(effort) {
  return effort.days_low !== undefined && effort.days_high !== undefined
    ? `${effort.days_low}-${effort.days_high} days`
    : effort.days_low !== undefined ? `from ${effort.days_low} days`
      : effort.days_high !== undefined ? `up to ${effort.days_high} days` : '';
}

const PIPS = { low: 1, medium: 2, high: 3 };

/** @param {{card: any}} props */
function Signals({ card }) {
  const { effort } = card;
  const days = effort ? effortDays(effort) : '';
  const strength = evidenceStrength(card);
  const pips = PIPS[card.confidence] ?? 0;
  return (
    <div className="dw-signals">
      {effort
        ? <span className="dw-stat"><span className="dw-stat__k">Effort</span><strong>{effort.size}</strong>{days && <span className="dw-subtle">{days}</span>}</span>
        : <span className="dw-stat dw-stat--none">Effort not estimated</span>}
      <span className="dw-stat">
        <span className="dw-stat__k">Confidence</span>
        <span className="dw-pips" aria-hidden="true">{[1, 2, 3].map((n) => <span key={n} className={`dw-pip${n <= pips ? ' dw-pip--on' : ''}`} />)}</span>
        <strong>{LEVEL_LABELS[card.confidence] ?? card.confidence}</strong>
      </span>
      <span
        className="dw-meter"
        title={strength.count === 0 ? 'No evidence attached' : `Derived from ${plural(strength.count, 'evidence item')} of ${plural(strength.kinds, 'kind')} and the stated confidence`}
      >
        <span className="dw-meter__k">Evidence</span>
        <span className="dw-meter__segs" aria-hidden="true">{[1, 2, 3, 4].map((n) => <span key={n} className={`dw-meter__seg${n <= strength.level ? ' dw-meter__seg--on' : ''}`} />)}</span>
        <strong>{strength.label}</strong>
      </span>
    </div>
  );
}

/** @param {{risk?: {blast: string, bus_factor?: number}}} props */
function Risk({ risk }) {
  if (!risk) return <span className="dw-subtle">Not measured</span>;
  return (
    <span>
      Blast radius {(LEVEL_LABELS[risk.blast] ?? risk.blast).toLowerCase()}
      {' · '}
      {risk.bus_factor !== undefined
        ? <>bus factor {risk.bus_factor}{risk.bus_factor <= 1 && <> <Lozenge appearance="removed">single owner</Lozenge></>}</>
        : <span className="dw-subtle">bus factor not measured</span>}
    </span>
  );
}

/** @param {{evidence: {type: string, ref: string, url?: string, quote?: string, link?: string}[]}} props */
export function EvidenceList({ evidence }) {
  return (
    <ul className="dw-evidence">
      {evidence.map((ev, i) => {
        const href = ev.link ?? ev.url;
        const isCode = ev.type === 'code' || ev.type === 'doc';
        return (
          <li key={`${ev.type}:${ev.ref}:${i}`}>
            <span className="dw-evidence__type">{EVIDENCE_LABELS[ev.type] ?? ev.type}</span>
            <span className="dw-evidence__ref">
              {href ? <a href={href} target="_blank" rel="noreferrer noopener">{ev.ref}</a> : ev.ref}
            </span>
            {ev.quote && (isCode
              ? <pre className="dw-code"><code>{ev.quote}</code></pre>
              : <blockquote className="dw-quote">{ev.quote}</blockquote>)}
          </li>
        );
      })}
    </ul>
  );
}

/** @param {{history: any[]}} props */
export function TriageHistory({ history }) {
  if (!history || history.length === 0) return <p className="dw-subtle" style={{ margin: '4px 0 0' }}>No triage decisions yet.</p>;
  return (
    <ol className="dw-history">
      {history.map((v, i) => (
        <li key={`${v.decided_at}:${i}`}>
          <Lozenge appearance={STATUS_APPEARANCE[v.status] ?? 'default'}>{STATUS_LABELS[v.status] ?? v.status}</Lozenge>{' '}
          {v.reason && <>{REASON_LABELS[v.reason] ?? v.reason} </>}
          {v.merged_into && <>into {v.merged_into} </>}
          {v.issue_ref && (v.issue_url ? <a href={v.issue_url} target="_blank" rel="noreferrer noopener">{v.issue_ref}</a> : v.issue_ref)}
          <span className="dw-subtlest"> · {deciderName(v.decided_by, v.decided_by_name)} · {formatDate(v.decided_at)}</span>
          {v.status === 'snoozed' && v.snooze_until && <div className="dw-subtle">{comesBack(v.snooze_until)}.</div>}
          {v.note && <div className="dw-note"><span className="dw-note__k">Note</span>{v.note}</div>}
        </li>
      ))}
    </ol>
  );
}

/** The triage history of a decided card, fetched when the person opens it (inbox.list carries none). */
export function LazyHistory({ cardRef }) {
  const [open, setOpen] = React.useState(false);
  return (
    <details className="dw-details" style={{ marginTop: 6 }} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Triage history</summary>
      {open && <LazyHistoryBody cardRef={cardRef} />}
    </details>
  );
}
function LazyHistoryBody({ cardRef }) {
  const data = useAsync(() => call('proposal.get', { ref: cardRef }), [cardRef]);
  if (data.status === 'loading') return <p className="dw-subtle" style={{ margin: '4px 0 0' }}>Loading…</p>;
  if (data.status === 'error') return <p className="dw-subtle" role="alert" style={{ margin: '4px 0 0' }}>The history could not load.</p>;
  return <TriageHistory history={data.data.history ?? []} />;
}

/**
 * @param {{
 *   card: any, change?: 'new'|'grew'|'reopened', history?: any[], showStatus?: boolean,
 *   select?: React.ReactNode, actions?: React.ReactNode, footer?: React.ReactNode,
 *   focused?: boolean, selected?: boolean, flat?: boolean, titleId?: string,
 * } & React.HTMLAttributes<HTMLElement>} props
 */
export function ProposalCard({ card, change, history, showStatus, select, actions, footer, focused, selected, flat, titleId, ...rest }) {
  const cls = ['dw-card', flat && 'dw-card--flat', focused && 'dw-card--focused', selected && 'dw-card--selected'].filter(Boolean).join(' ');
  // The change marker (new / grew / reopened) describes an item still waiting for a decision; a decided card never wears it.
  const isOpen = card.status === 'open';
  const marker = isOpen ? (card.reopened ? 'reopened' : change) : undefined;
  const basis = card.effort?.basis ?? [];
  return (
    <article className={cls} data-lens={card.lens} aria-labelledby={titleId} {...rest}>
      {!flat && <div className="dw-card__check">{select}</div>}
      <div className="dw-card__main">
        <div className="dw-card__head">
          <span className="dw-card__ref">{card.ref}</span>
          <LensBadge lens={card.lens} />
          {marker && (marker === 'reopened'
            ? <Lozenge appearance="moved">Reopened</Lozenge>
            : <Lozenge appearance={marker === 'new' ? 'new' : 'inprogress'}>{CHANGE_LABELS[marker]}</Lozenge>)}
          {showStatus && <Lozenge appearance={STATUS_APPEARANCE[card.status] ?? 'default'}>{STATUS_LABELS[card.status] ?? card.status}</Lozenge>}
          {card.issue_ref && (card.issue_url
            ? <a href={card.issue_url} target="_blank" rel="noreferrer noopener">{card.issue_ref}</a>
            : <span>{card.issue_ref}</span>)}
        </div>
        <h3 className="dw-card__title" id={titleId}>{card.title}</h3>
        {card.status === 'snoozed' && card.snooze_until && <p className="dw-subtle" style={{ margin: '2px 0 6px' }}>{comesBack(card.snooze_until)}.</p>}
        <p className="dw-card__rationale">{card.rationale}</p>
        <Signals card={card} />
        {card.confidence_why && <p className="dw-card__why">{card.confidence_why}</p>}
        <dl className="dw-facts" style={{ marginTop: 10 }}>
          <dt>Delivery risk</dt><dd><Risk risk={card.delivery_risk} /></dd>
          <dt>Doc impact</dt>
          <dd>
            {card.doc_impact && card.doc_impact.length > 0
              ? card.doc_impact.map((d, i) => <span key={d}>{i > 0 && ', '}<span className="dw-evidence__ref">{d}</span></span>)
              : <span className="dw-subtle">None named</span>}
          </dd>
        </dl>
        <details className="dw-details" open={flat || undefined}>
          <summary>Evidence ({card.evidence?.length ?? 0}){basis.length > 0 && `, effort basis (${basis.length})`}</summary>
          <EvidenceList evidence={card.evidence ?? []} />
          {basis.length > 0 && (
            <p className="dw-card__why">Effort rests on: {basis.map((b, i) => <span key={b}>{i > 0 && ', '}<span className="dw-evidence__ref">{b}</span></span>)}</p>
          )}
        </details>
        {history && (
          <section style={{ marginTop: 12 }}>
            <h3 className="dw-h3">Triage history</h3>
            <TriageHistory history={history} />
          </section>
        )}
        {actions && <div className="dw-card__actions">{actions}</div>}
        {footer}
      </div>
    </article>
  );
}
