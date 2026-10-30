// Small shared pieces of the reading-pane inbox (also used by Learning): lens naming, the compact signals and the keyboard hint.
import React from 'react';
import { LEVEL_LABELS, evidenceStrength, plural } from '../../components/labels.js';

/** Short lens names for rows; the full name stays in the pane. */
export const LENS_SHORT = { opportunity: 'Opportunity', 'ux-friction': 'UX friction', 'doc-drift': 'Doc drift', 'security-cra': 'Security' };

export const PIPS = { low: 1, medium: 2, high: 3 };

export function LensDot({ lens }) {
  return <span className={`dwr-dot dwr-dot--${lens}`} aria-hidden="true" />;
}

export function Pips({ level }) {
  const n = PIPS[level] ?? 0;
  return (
    <span className="dwr-pips" aria-hidden="true">
      {[1, 2, 3].map((i) => <span key={i} className={`dwr-pip${i <= n ? ' dwr-pip--on' : ''}`} />)}
    </span>
  );
}

export function Meter({ strength }) {
  return (
    <span className="dwr-meter" aria-hidden="true">
      {[1, 2, 3, 4].map((i) => <span key={i} className={`dwr-meter__seg${i <= strength.level ? ' dwr-meter__seg--on' : ''}`} />)}
    </span>
  );
}

export function effortDays(effort) {
  if (effort.days_low !== undefined && effort.days_high !== undefined) return `${effort.days_low}-${effort.days_high} days`;
  if (effort.days_low !== undefined) return `from ${effort.days_low} days`;
  if (effort.days_high !== undefined) return `up to ${effort.days_high} days`;
  return '';
}

/**
 * The compact row signals, aligned in fixed columns: the stored score (or "unscored", never 0), effort, confidence,
 * evidence. An unmeasured effort leaves its column empty.
 */
export function RowSignals({ card }) {
  const strength = evidenceStrength(card);
  const days = card.effort ? effortDays(card.effort) : '';
  const scored = typeof card.score === 'number';
  const said = [
    scored ? `score ${card.score}` : 'unscored',
    card.effort ? `effort ${card.effort.size}` : 'effort not estimated',
    `confidence ${(LEVEL_LABELS[card.confidence] ?? card.confidence ?? 'not stated').toLowerCase()}`,
    `evidence ${strength.label.toLowerCase()}, ${plural(strength.count, 'item')}`,
  ].join(', ');
  return (
    <span className="dwr-sig">
      <span className="dwr-visually-hidden">{said}</span>
      <span className={`dwr-sig__score${scored ? '' : ' dwr-sig__score--none'}`} aria-hidden="true" title={scored ? `Score ${card.score} (scan-score/1)` : 'Unscored: no impact was judged'}>{scored ? card.score : 'unscored'}</span>
      <span className="dwr-sig__effort" aria-hidden="true" title={card.effort ? `Effort ${card.effort.size}${days ? `, ${days}` : ''}` : 'Effort not estimated'}>{card.effort?.size ?? ''}</span>
      <span aria-hidden="true" title={`Confidence ${(LEVEL_LABELS[card.confidence] ?? '').toLowerCase()}`}><Pips level={card.confidence} /></span>
      <span aria-hidden="true" title={`Evidence: ${strength.label}`}><Meter strength={strength} /></span>
    </span>
  );
}

export function Kbd({ children }) {
  return <kbd className="dwr-kbd" aria-hidden="true">{children}</kbd>;
}
