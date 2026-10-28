// Variant 1 proposal card: one outline, one signals line, everything else behind "Details". Renders only what the Card
// carries; an absent key is "not measured" and the expanded view says so (never 0). `flat` is the issue-panel form:
// no outline, all facts listed as key/value fields.
import React, { useState } from 'react';
import { Lozenge } from '../../components/ui.jsx';
import { EvidenceList, LensBadge, TriageHistory } from '../../components/ProposalCard.jsx';
import {
  CHANGE_LABELS, LEVEL_LABELS, STATUS_APPEARANCE, STATUS_LABELS, evidenceStrength, plural,
} from '../../components/labels.js';

const PIPS = { low: 1, medium: 2, high: 3 };

function effortDays(effort) {
  return effort.days_low !== undefined && effort.days_high !== undefined
    ? `${effort.days_low}-${effort.days_high} days`
    : effort.days_low !== undefined ? `from ${effort.days_low} days`
      : effort.days_high !== undefined ? `up to ${effort.days_high} days` : '';
}

/** Measured high risks only: a missing delivery_risk, or a low/medium one, earns no flag. */
function riskFlags(risk) {
  if (!risk) return [];
  const flags = [];
  if (risk.bus_factor !== undefined && risk.bus_factor <= 1) flags.push('Single owner');
  if (risk.blast === 'high') flags.push('High blast radius');
  return flags;
}

function Pips({ level }) {
  const n = PIPS[level] ?? 0;
  return <span className="dw-pips" aria-hidden="true">{[1, 2, 3].map((i) => <span key={i} className={`dw-pip${i <= n ? ' dw-pip--on' : ''}`} />)}</span>;
}

function Meter({ strength }) {
  return <span className="dw-meter__segs" aria-hidden="true">{[1, 2, 3, 4].map((n) => <span key={n} className={`dw-meter__seg${n <= strength.level ? ' dw-meter__seg--on' : ''}`} />)}</span>;
}

function strengthTitle(strength) {
  return strength.count === 0 ? 'No evidence attached' : `Derived from ${plural(strength.count, 'evidence item')} of ${plural(strength.kinds, 'kind')} and the stated confidence`;
}

function Risk({ risk }) {
  if (!risk) return <span className="dw-subtle">Not measured</span>;
  return (
    <span>
      Blast radius {(LEVEL_LABELS[risk.blast] ?? risk.blast).toLowerCase()}
      {' · '}
      {risk.bus_factor !== undefined ? `bus factor ${risk.bus_factor}` : <span className="dw-subtle">bus factor not measured</span>}
    </span>
  );
}

function Refs({ list, none }) {
  if (!list || list.length === 0) return <span className="dw-subtle">{none}</span>;
  return list.map((d, i) => <span key={d}>{i > 0 && ', '}<span className="dw-evidence__ref">{d}</span></span>);
}

/** The key/value fields. `all` adds the facts the signals line already carries (the flat panel has no signals line). */
function Fields({ card, all }) {
  const { effort } = card;
  const strength = evidenceStrength(card);
  const basis = effort?.basis ?? [];
  return (
    <dl className="dw1-fields">
      {all && (
        <>
          <dt>Effort</dt>
          <dd>{effort ? <><strong>{effort.size}</strong>{effortDays(effort) && <span className="dw-subtle"> {effortDays(effort)}</span>}</> : <span className="dw-subtle">Not estimated</span>}</dd>
          <dt>Confidence</dt>
          <dd><span className="dw1-inline"><Pips level={card.confidence} /><strong>{LEVEL_LABELS[card.confidence] ?? card.confidence}</strong></span></dd>
          <dt>Evidence</dt>
          <dd><span className="dw1-inline" title={strengthTitle(strength)}><Meter strength={strength} /><strong>{strength.label}</strong></span></dd>
        </>
      )}
      {card.confidence_why && (<><dt>Why this confidence</dt><dd>{card.confidence_why}</dd></>)}
      {!all && !effort && (<><dt>Effort</dt><dd className="dw-subtle">Not estimated</dd></>)}
      <dt>Delivery risk</dt><dd><Risk risk={card.delivery_risk} /></dd>
      <dt>Doc impact</dt><dd><Refs list={card.doc_impact} none="None named" /></dd>
      {basis.length > 0 && (<><dt>Effort rests on</dt><dd><Refs list={basis} none="" /></dd></>)}
    </dl>
  );
}

/**
 * @param {{
 *   card: any, change?: 'new'|'grew'|'reopened', history?: any[], showStatus?: boolean,
 *   select?: React.ReactNode, actions?: React.ReactNode, footer?: React.ReactNode,
 *   focused?: boolean, selected?: boolean, flat?: boolean, titleId?: string,
 * } & React.HTMLAttributes<HTMLElement>} props
 */
export function Card({ card, change, history, showStatus, select, actions, footer, focused, selected, flat, titleId, ...rest }) {
  const [open, setOpen] = useState(false);
  const cls = ['dw1-card', flat && 'dw1-card--flat', focused && 'dw1-card--focused', selected && 'dw1-card--selected'].filter(Boolean).join(' ');
  const isOpen = card.status === 'open';
  const marker = isOpen ? (card.reopened ? 'reopened' : change) : undefined;
  const { effort } = card;
  const strength = evidenceStrength(card);
  const flags = riskFlags(card.delivery_risk);
  const bodyId = `dw1-d-${String(card.ref).replace(/\W/g, '')}${flat ? '-flat' : ''}`;
  const evidenceCount = card.evidence?.length ?? 0;
  return (
    <article className={cls} data-lens={card.lens} aria-labelledby={titleId} {...rest}>
      {!flat && <div className="dw1-card__check">{select}</div>}
      <div className="dw1-card__main">
        <div className="dw1-card__head">
          <span className="dw-card__ref">{card.ref}</span>
          <LensBadge lens={card.lens} />
          {marker && (marker === 'reopened'
            ? <Lozenge appearance="moved">Reopened</Lozenge>
            : <Lozenge appearance={marker === 'new' ? 'new' : 'inprogress'}>{CHANGE_LABELS[marker]}</Lozenge>)}
          {showStatus && <Lozenge appearance={STATUS_APPEARANCE[card.status] ?? 'default'}>{STATUS_LABELS[card.status] ?? card.status}</Lozenge>}
          {card.issue_ref && (card.issue_url
            ? <a href={card.issue_url} target="_blank" rel="noreferrer noopener" className="dw1-card__issue">{card.issue_ref}</a>
            : <span className="dw1-card__issue">{card.issue_ref}</span>)}
          {actions && <div className="dw1-card__actions">{actions}</div>}
        </div>
        <h3 className="dw1-card__title" id={titleId}>{card.title}</h3>
        <p className="dw1-card__rationale">{card.rationale}</p>

        {flat ? (
          <>
            <Fields card={card} all />
            <h4 className="dw1-subhead">Evidence ({evidenceCount})</h4>
            <EvidenceList evidence={card.evidence ?? []} />
          </>
        ) : (
          <>
            <div className="dw1-signals">
              {effort && <span className="dw1-chip"><span className="dw1-chip__k">Effort</span><strong>{effort.size}</strong>{effortDays(effort) && <span className="dw1-chip__v">{effortDays(effort)}</span>}</span>}
              <span className="dw1-chip"><span className="dw1-chip__k">Confidence</span><Pips level={card.confidence} /><strong>{LEVEL_LABELS[card.confidence] ?? card.confidence}</strong></span>
              <span className="dw1-chip" title={strengthTitle(strength)}><span className="dw1-chip__k">Evidence</span><Meter strength={strength} /><strong>{strength.label}</strong></span>
              {flags.map((f) => <span key={f} className="dw1-chip dw1-chip--warn"><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M6 1 11.5 10.5H.5z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /><path d="M6 4.6v2.7M6 8.6v.1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>{f}</span>)}
              <span className="dw1-spacer" />
              <button type="button" className="dw1-toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((o) => !o)}>
                Details
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false" className="dw1-toggle__chev"><path d="M3 4.5 6 7.5l3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </button>
            </div>
            {open && (
              <div className="dw1-details" id={bodyId}>
                <div>
                  <h4 className="dw1-subhead">Facts</h4>
                  <Fields card={card} />
                </div>
                <div>
                  <h4 className="dw1-subhead">Evidence ({evidenceCount})</h4>
                  <EvidenceList evidence={card.evidence ?? []} />
                </div>
              </div>
            )}
          </>
        )}
        {history && (
          <section className="dw1-history">
            <h4 className="dw1-subhead">Triage history</h4>
            <TriageHistory history={history} />
          </section>
        )}
        {footer}
      </div>
    </article>
  );
}
