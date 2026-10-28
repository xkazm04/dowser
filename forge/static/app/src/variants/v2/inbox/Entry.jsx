// One proposal as a list entry, not a card: meta line, title, rationale, a single spec line, and the decision on the
// right of the meta line. Detail (basis, risk, doc impact, evidence) opens under it. Interactive in the inbox.
import React, { useId, useState } from 'react';
import { Lozenge } from '../../../components/ui.jsx';
import { EvidenceList } from '../../../components/ProposalCard.jsx';
import {
  CHANGE_LABELS, LENS_LABELS, LEVEL_LABELS, STATUS_APPEARANCE, STATUS_LABELS, evidenceStrength, plural,
} from '../../../components/labels.js';
import { LensDot } from '../shared.jsx';

export function effortDays(effort) {
  return effort.days_low !== undefined && effort.days_high !== undefined
    ? `${effort.days_low}–${effort.days_high} days`
    : effort.days_low !== undefined ? `from ${effort.days_low} days`
      : effort.days_high !== undefined ? `up to ${effort.days_high} days` : '';
}

/** Measured delivery risks as short warning phrases; an unmeasured risk prints nothing here (the detail says so). */
export function riskPhrases(card) {
  const r = card.delivery_risk;
  const out = [];
  if (!r) return out;
  if (r.bus_factor !== undefined && r.bus_factor <= 1) out.push('Single owner');
  if (r.blast === 'high') out.push('High blast radius');
  return out;
}

/** The spec line: facts in small text; the evidence meter is four 2px bars. */
export function SpecLine({ card, trailing }) {
  const { effort } = card;
  const strength = evidenceStrength(card);
  const days = effort ? effortDays(effort) : '';
  const risks = riskPhrases(card);
  const docs = card.doc_impact?.length ?? 0;
  return (
    <p className="dw2-spec">
      {effort && <span className="dw2-spec__i"><span className="dw2-spec__k">Effort</span> <b>{effort.size}</b>{days && <> &middot; {days}</>}</span>}
      <span className="dw2-spec__i"><span className="dw2-spec__k">Confidence</span> <b>{LEVEL_LABELS[card.confidence] ?? card.confidence}</b></span>
      <span
        className="dw2-spec__i"
        title={strength.count === 0 ? 'No evidence attached' : `Derived from ${plural(strength.count, 'evidence item')} of ${plural(strength.kinds, 'kind')} and the stated confidence`}
      >
        <span className="dw2-spec__k">Evidence</span>{' '}
        <span className="dw2-meter" aria-hidden="true">{[1, 2, 3, 4].map((n) => <i key={n} className={n <= strength.level ? 'on' : ''} />)}</span>{' '}
        <b>{strength.label}</b>
      </span>
      {docs > 0 && <span className="dw2-spec__i">{plural(docs, 'doc')} to update</span>}
      {risks.map((t) => <span key={t} className="dw2-spec__i dw2-spec__warn">{t}</span>)}
      {trailing}
    </p>
  );
}

/** Label / value pairs of the expanded entry: everything the collapsed view leaves out, including what is not measured. */
export function Facts({ card }) {
  const basis = card.effort?.basis ?? [];
  const r = card.delivery_risk;
  const code = (s) => <span className="dw-evidence__ref">{s}</span>;
  return (
    <dl className="dw2-facts">
      <dt>Effort</dt>
      <dd>
        {card.effort ? <>{card.effort.size}{effortDays(card.effort) && <>, {effortDays(card.effort)}</>}</> : <span className="dw2-muted">Not estimated</span>}
        {basis.length > 0 && <span className="dw2-muted"> &middot; rests on {basis.map((b, i) => <span key={b}>{i > 0 && ', '}{code(b)}</span>)}</span>}
      </dd>
      <dt>Confidence</dt>
      <dd>{LEVEL_LABELS[card.confidence] ?? card.confidence}{card.confidence_why && <span className="dw2-muted"> &middot; {card.confidence_why}</span>}</dd>
      <dt>Delivery risk</dt>
      <dd>
        {r
          ? <>Blast radius {(LEVEL_LABELS[r.blast] ?? r.blast).toLowerCase()}, {r.bus_factor !== undefined ? <>bus factor {r.bus_factor}</> : <span className="dw2-muted">bus factor not measured</span>}</>
          : <span className="dw2-muted">Not measured</span>}
      </dd>
      <dt>Doc impact</dt>
      <dd>{card.doc_impact && card.doc_impact.length > 0 ? card.doc_impact.map((d, i) => <span key={d}>{i > 0 && ', '}{code(d)}</span>) : <span className="dw2-muted">None named</span>}</dd>
    </dl>
  );
}

/**
 * @param {{
 *   card: any, change?: 'new'|'grew'|'reopened', showStatus?: boolean, select?: React.ReactNode, actions?: React.ReactNode,
 *   footer?: React.ReactNode, focused?: boolean, selected?: boolean, titleId?: string,
 * } & React.HTMLAttributes<HTMLElement>} props
 */
export function Entry({ card, change, showStatus, select, actions, footer, focused, selected, titleId, ...rest }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const isOpen = card.status === 'open';
  const marker = isOpen ? (card.reopened ? 'reopened' : change) : undefined;
  const cls = ['dw2-entry', focused && 'dw2-entry--focused', selected && 'dw2-entry--selected'].filter(Boolean).join(' ');
  const evCount = card.evidence?.length ?? 0;
  return (
    <article className={cls} aria-labelledby={titleId} {...rest}>
      <div className="dw2-entry__gutter">{select}</div>
      <div className="dw2-entry__main">
        <div className="dw2-meta">
          <span className="dw2-meta__lens"><LensDot lens={card.lens} />{LENS_LABELS[card.lens] ?? card.lens}</span>
          <span className="dw2-meta__ref">{card.ref}</span>
          {marker && <span className={`dw2-marker dw2-marker--${marker}`}>{marker === 'reopened' ? 'Reopened' : CHANGE_LABELS[marker]}</span>}
          {showStatus && <Lozenge appearance={STATUS_APPEARANCE[card.status] ?? 'default'}>{STATUS_LABELS[card.status] ?? card.status}</Lozenge>}
          {card.issue_ref && (card.issue_url
            ? <a href={card.issue_url} target="_blank" rel="noreferrer noopener">{card.issue_ref}</a>
            : <span>{card.issue_ref}</span>)}
          {actions && <div className="dw2-actions">{actions}</div>}
        </div>
        <h3 className="dw2-title" id={titleId}>{card.title}</h3>
        <p className="dw2-rationale">{card.rationale}</p>
        <SpecLine
          card={card}
          trailing={(
            <button type="button" className="dw2-more" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(!open)}>
              {open ? 'Hide detail' : `Detail${evCount > 0 ? ` and ${plural(evCount, 'source')}` : ''}`}
              <span className="dw2-chev" aria-hidden="true" />
            </button>
          )}
        />
        {open && (
          <div className="dw2-detail" id={panelId}>
            <Facts card={card} />
            {evCount > 0 && <EvidenceList evidence={card.evidence} />}
          </div>
        )}
        {footer}
      </div>
    </article>
  );
}
