// The proposal card, shared by the inbox (interactive) and the evidence panel (read-only). Renders only what
// the Card carries: an absent key is "not measured" and is said so, never shown as 0. React 19 passes `ref` as
// a plain prop, so it reaches the <article> through `...rest` (the inbox focuses cards with j/k).
import React from 'react';
import { Lozenge } from './ui.jsx';
import {
  CHANGE_LABELS, EVIDENCE_LABELS, LENS_LABELS, LEVEL_LABELS, REASON_LABELS, STATUS_APPEARANCE, STATUS_LABELS, formatDate,
} from './labels.js';

/** @param {{lens: string}} props */
export function LensBadge({ lens }) {
  return <span className={`dw-lens dw-lens--${lens}`}>{LENS_LABELS[lens] ?? lens}</span>;
}

/** @param {{effort?: {size: string, days_low?: number, days_high?: number, basis?: string[]}}} props */
function Effort({ effort }) {
  if (!effort) return <span className="dw-subtle">Not estimated</span>;
  const days = effort.days_low !== undefined && effort.days_high !== undefined
    ? `${effort.days_low}-${effort.days_high} days`
    : effort.days_low !== undefined ? `from ${effort.days_low} days`
      : effort.days_high !== undefined ? `up to ${effort.days_high} days` : '';
  return (
    <span>
      <strong>{effort.size}</strong>{days && <span className="dw-subtle"> · {days}</span>}
      {effort.basis && effort.basis.length > 0 && (
        <details className="dw-details">
          <summary>Basis ({effort.basis.length})</summary>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {effort.basis.map((b) => <li key={b} className="dw-evidence__ref">{b}</li>)}
          </ul>
        </details>
      )}
    </span>
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
          <span className="dw-subtlest"> · {decider(v.decided_by)} · {formatDate(v.decided_at)}</span>
          {v.note && <div className="dw-subtle">{v.note}</div>}
        </li>
      ))}
    </ol>
  );
}

/** `forge:<accountId>` / `human:<name>` -> a short label. */
function decider(by) {
  if (!by) return 'unknown';
  const [kind, ...rest] = String(by).split(':');
  const who = rest.join(':');
  return kind === 'forge' ? `Jira user ${who}` : who || kind;
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
  return (
    <article className={cls} aria-labelledby={titleId} {...rest}>
      {!flat && <div className="dw-card__check">{select}</div>}
      <div>
        <div className="dw-card__head">
          <span className="dw-subtlest">{card.ref}</span>
          <LensBadge lens={card.lens} />
          {change === 'reopened' || (!change && card.reopened)
            ? <Lozenge appearance="moved">Reopened</Lozenge>
            : change && <Lozenge appearance={change === 'new' ? 'new' : 'inprogress'}>{CHANGE_LABELS[change]}</Lozenge>}
          {showStatus && <Lozenge appearance={STATUS_APPEARANCE[card.status] ?? 'default'}>{STATUS_LABELS[card.status] ?? card.status}</Lozenge>}
          {card.issue_ref && (card.issue_url
            ? <a href={card.issue_url} target="_blank" rel="noreferrer noopener">{card.issue_ref}</a>
            : <span>{card.issue_ref}</span>)}
        </div>
        <h3 className="dw-card__title" id={titleId}>{card.title}</h3>
        <p className="dw-card__rationale">{card.rationale}</p>
        <dl className="dw-facts">
          <dt>Effort</dt><dd><Effort effort={card.effort} /></dd>
          <dt>Confidence</dt>
          <dd>
            <strong>{LEVEL_LABELS[card.confidence] ?? card.confidence}</strong>
            {card.confidence_why && <span className="dw-subtle"> · {card.confidence_why}</span>}
          </dd>
          <dt>Delivery risk</dt><dd><Risk risk={card.delivery_risk} /></dd>
          <dt>Doc impact</dt>
          <dd>
            {card.doc_impact && card.doc_impact.length > 0
              ? card.doc_impact.map((d, i) => <span key={d}>{i > 0 && ', '}<span className="dw-evidence__ref">{d}</span></span>)
              : <span className="dw-subtle">None named</span>}
          </dd>
        </dl>
        <details className="dw-details" open={flat || undefined}>
          <summary>Evidence ({card.evidence?.length ?? 0})</summary>
          <EvidenceList evidence={card.evidence ?? []} />
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
