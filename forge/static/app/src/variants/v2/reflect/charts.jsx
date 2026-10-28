// Variant 2 charts: thin lines, printed values, a real table behind every one (the Learning page keeps those).
// One hue per chart (ink for the thing you control, neutral for the thing you observe); no fills heavier than 6px.
import React from 'react';
import { plural } from '../../../components/labels.js';

const SEGMENTS = [
  { key: 'accepted', label: 'Accepted' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'snoozed', label: 'Snoozed' },
  { key: 'open', label: 'Still open' },
];

/** A 6px segmented bar; each segment is separated by a gap, counts are printed in the legend below. */
export function DecisionBar({ values, label }) {
  const total = SEGMENTS.reduce((n, s) => n + (values[s.key] ?? 0), 0);
  const summary = SEGMENTS.map((s) => `${values[s.key] ?? 0} ${s.label.toLowerCase()}`).join(', ');
  if (total === 0) return <p className="dw2-muted">No items in this push.</p>;
  return (
    <div>
      <div className="dw2-dbar" role="img" aria-label={`${label}: ${summary}`}>
        {SEGMENTS.filter((s) => (values[s.key] ?? 0) > 0).map((s) => (
          <span key={s.key} className={`dw2-dbar__seg dw2-dbar__seg--${s.key}`} style={{ flexGrow: values[s.key] }} />
        ))}
      </div>
      <ul className="dw2-dbar__legend">
        {SEGMENTS.map((s) => (
          <li key={s.key}><span className={`dw2-dbar__sw dw2-dbar__seg--${s.key}`} aria-hidden="true" />{s.label} <b>{values[s.key] ?? 0}</b></li>
        ))}
      </ul>
    </div>
  );
}

const W = 420;
const H = 120;
const PAD = { l: 34, r: 14, t: 18, b: 24 };

/**
 * A thin line over time (oldest to newest), values 0..1 printed above the dots. A missing value breaks the line and
 * prints n/a, never a point at zero.
 * @param {{title: string, points: {label: string, value?: number}[], tone: 'ink' | 'plain', caption?: string}} props
 */
export function LineTrend({ title, points, tone, caption }) {
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const step = points.length > 1 ? iw / (points.length - 1) : 0;
  const x = (i) => PAD.l + (points.length > 1 ? step * i : iw / 2);
  const y = (v) => PAD.t + ih * (1 - v);
  const summary = points.map((p) => `${p.label}: ${p.value === undefined ? 'not measured' : `${Math.round(p.value * 100)}%`}`).join('; ');
  // Segments of consecutive measured points
  const runs = [];
  let cur = [];
  points.forEach((p, i) => {
    if (p.value === undefined) { if (cur.length) runs.push(cur); cur = []; } else cur.push([x(i), y(p.value)]);
  });
  if (cur.length) runs.push(cur);
  return (
    <figure className="dw2-fig">
      <figcaption className="dw2-fig__cap">{title}{caption && <span className="dw2-muted"> {caption}</span>}</figcaption>
      <svg className={`dw2-line dw2-line--${tone}`} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}. ${summary}.`} focusable="false">
        {[0, 0.5, 1].map((t) => (
          <g key={t}>
            <line className="dw2-line__grid" x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} />
            <text className="dw2-line__tick" x={PAD.l - 8} y={y(t) + 4} textAnchor="end">{Math.round(t * 100)}%</text>
          </g>
        ))}
        {runs.map((r, i) => r.length > 1 && <polyline key={i} className="dw2-line__path" points={r.map((p) => p.join(',')).join(' ')} />)}
        {points.map((p, i) => (
          <g key={`${p.label}-${i}`}>
            {p.value === undefined
              ? <text className="dw2-line__tick" x={x(i)} y={y(0) - 6} textAnchor="middle">n/a</text>
              : (
                <>
                  <circle className="dw2-line__dot" cx={x(i)} cy={y(p.value)} r="3" />
                  <text className="dw2-line__val" x={x(i)} y={y(p.value) - 8} textAnchor="middle">{Math.round(p.value * 100)}%</text>
                </>
              )}
            <text className="dw2-line__tick" x={x(i)} y={H - 6} textAnchor="middle">{p.label}</text>
          </g>
        ))}
      </svg>
    </figure>
  );
}

/** Rows of label, a 2px line proportional to the count, and the count. */
export function Rows({ rows, max }) {
  return (
    <ul className="dw2-rows">
      {rows.map((r) => (
        <li key={r.label} className="dw2-rows__row">
          <span>{r.label}</span>
          <span className="dw2-rows__track" aria-hidden="true"><span className="dw2-rows__bar" style={{ width: `${Math.max(4, (r.count / max) * 100)}%` }} /></span>
          <b>{r.count}</b>
        </li>
      ))}
    </ul>
  );
}

export { plural };
