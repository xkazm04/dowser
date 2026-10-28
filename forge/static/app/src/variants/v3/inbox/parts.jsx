// Small shared pieces of the reading-pane variant: lens naming, the compact signals and the keyboard hint.
import React from 'react';
import { LEVEL_LABELS, evidenceStrength, plural } from '../../../components/labels.js';

/** Short lens names for rows; the full name stays in the pane. */
export const LENS_SHORT = { opportunity: 'Opportunity', 'ux-friction': 'UX friction', 'doc-drift': 'Doc drift', 'security-cra': 'Security' };

export const PIPS = { low: 1, medium: 2, high: 3 };

export function LensDot({ lens }) {
  return <span className={`dw3-dot dw3-dot--${lens}`} aria-hidden="true" />;
}

export function Pips({ level }) {
  const n = PIPS[level] ?? 0;
  return (
    <span className="dw3-pips" aria-hidden="true">
      {[1, 2, 3].map((i) => <span key={i} className={`dw3-pip${i <= n ? ' dw3-pip--on' : ''}`} />)}
    </span>
  );
}

export function Meter({ strength }) {
  return (
    <span className="dw3-meter" aria-hidden="true">
      {[1, 2, 3, 4].map((i) => <span key={i} className={`dw3-meter__seg${i <= strength.level ? ' dw3-meter__seg--on' : ''}`} />)}
    </span>
  );
}

export function effortDays(effort) {
  if (effort.days_low !== undefined && effort.days_high !== undefined) return `${effort.days_low}-${effort.days_high} days`;
  if (effort.days_low !== undefined) return `from ${effort.days_low} days`;
  if (effort.days_high !== undefined) return `up to ${effort.days_high} days`;
  return '';
}

/** The three compact row signals, aligned in fixed columns. An unmeasured signal leaves its column empty. */
export function RowSignals({ card }) {
  const strength = evidenceStrength(card);
  const days = card.effort ? effortDays(card.effort) : '';
  const said = [
    card.effort ? `effort ${card.effort.size}` : 'effort not estimated',
    `confidence ${(LEVEL_LABELS[card.confidence] ?? card.confidence ?? 'not stated').toLowerCase()}`,
    `evidence ${strength.label.toLowerCase()}, ${plural(strength.count, 'item')}`,
  ].join(', ');
  return (
    <span className="dw3-sig">
      <span className="dw3-visually-hidden">{said}</span>
      <span className="dw3-sig__effort" aria-hidden="true" title={card.effort ? `Effort ${card.effort.size}${days ? `, ${days}` : ''}` : 'Effort not estimated'}>{card.effort?.size ?? ''}</span>
      <span aria-hidden="true" title={`Confidence ${(LEVEL_LABELS[card.confidence] ?? '').toLowerCase()}`}><Pips level={card.confidence} /></span>
      <span aria-hidden="true" title={`Evidence: ${strength.label}`}><Meter strength={strength} /></span>
    </span>
  );
}

export function Kbd({ children }) {
  return <kbd className="dw3-kbd" aria-hidden="true">{children}</kbd>;
}
