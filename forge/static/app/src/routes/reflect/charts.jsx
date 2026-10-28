// Charts of the Learning tab: inline SVG / plain HTML only (no chart library, no inline style attributes in
// markup). Principles: one hue per chart, every value printed (colour never carries a value alone), a real
// table behind every chart, direct labels instead of a legend where there is room.
import React from 'react';

/** Segments of a stacked bar, in reading order. `kind` picks the fill class; hatch/outline double the colour. */
export const DECISION_SEGMENTS = [
  { key: 'accepted', label: 'Accepted', kind: 'accepted' },
  { key: 'rejected', label: 'Rejected', kind: 'rejected' },
  { key: 'snoozed', label: 'Snoozed', kind: 'snoozed' },
  { key: 'open', label: 'Still open', kind: 'open' },
];

/**
 * One horizontal stacked bar with printed counts and a text legend.
 * @param {{values: Record<string, number>, segments?: typeof DECISION_SEGMENTS, label: string}} props
 */
export function StackedBar({ values, segments = DECISION_SEGMENTS, label }) {
  const total = segments.reduce((n, s) => n + (values[s.key] ?? 0), 0);
  const summary = segments.map((s) => `${values[s.key] ?? 0} ${s.label.toLowerCase()}`).join(', ');
  if (total === 0) return <p className="dw-subtle">No items in this push.</p>;
  return (
    <div>
      <div className="dw-stack" role="img" aria-label={`${label}: ${summary}`}>
        {segments.filter((s) => (values[s.key] ?? 0) > 0).map((s) => (
          <span key={s.key} className={`dw-stack__seg dw-stack__seg--${s.kind}`} style={{ flexGrow: values[s.key] }}>
            <span className="dw-stack__n">{values[s.key]}</span>
          </span>
        ))}
      </div>
      <ul className="dw-stack__legend">
        {segments.map((s) => (
          <li key={s.key}><span className={`dw-swatch dw-stack__seg--${s.kind}`} aria-hidden="true" />{s.label} <strong>{values[s.key] ?? 0}</strong> <span className="dw-subtlest">({Math.round(((values[s.key] ?? 0) / total) * 100)}%)</span></li>
        ))}
      </ul>
    </div>
  );
}

const W = 360;
const H = 132;
const PAD = { l: 34, r: 6, t: 16, b: 24 };

/**
 * A small bar chart of percentages (0..1) over time, oldest to newest. A missing value draws a dash, never a bar.
 * @param {{title: string, points: {label: string, value?: number}[], variant: 'dup' | 'accepted', idPrefix: string}} props
 */
export function BarTrend({ title, points, variant, idPrefix }) {
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const slot = iw / points.length;
  const bw = Math.min(28, slot * 0.62);
  const y = (v) => PAD.t + ih * (1 - v);
  const summary = points.map((p) => `${p.label}: ${p.value === undefined ? 'not measured' : `${Math.round(p.value * 100)}%`}`).join('; ');
  return (
    <figure className="dw-fig">
      <figcaption className="dw-fig__cap">{title}</figcaption>
      <svg className="dw-trend" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}. ${summary}.`} focusable="false">
        {[0, 0.5, 1].map((t) => (
          <g key={t}>
            <line className="dw-trend__grid" x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} />
            <text className="dw-trend__tick" x={PAD.l - 6} y={y(t) + 4} textAnchor="end">{Math.round(t * 100)}%</text>
          </g>
        ))}
        {points.map((p, i) => {
          const cx = PAD.l + slot * i + slot / 2;
          return (
            <g key={`${idPrefix}-${i}`}>
              {p.value === undefined
                ? <text className="dw-trend__tick" x={cx} y={y(0) - 6} textAnchor="middle">n/a</text>
                : (
                  <>
                    <rect className={`dw-trend__bar dw-trend__bar--${variant}`} x={cx - bw / 2} y={y(p.value)} width={bw} height={Math.max(1, ih * p.value)} rx="2" />
                    <text className="dw-trend__val" x={cx} y={y(p.value) - 4} textAnchor="middle">{Math.round(p.value * 100)}%</text>
                  </>
                )}
              <text className="dw-trend__tick" x={cx} y={H - 8} textAnchor="middle">{p.label}</text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

/**
 * Horizontal bars (counts) with the number printed at the end of each bar.
 * @param {{rows: {label: string, count: number}[], max: number}} props
 */
export function HBars({ rows, max }) {
  return (
    <ul className="dw-hbars">
      {rows.map((r) => (
        <li key={r.label} className="dw-hbars__row">
          <span className="dw-hbars__label">{r.label}</span>
          <span className="dw-hbars__track" aria-hidden="true"><span className="dw-hbars__bar" style={{ width: `${Math.max(3, (r.count / max) * 100)}%` }} /></span>
          <span className="dw-hbars__n">{r.count}</span>
        </li>
      ))}
    </ul>
  );
}
