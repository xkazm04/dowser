// Effort vs confidence of the open proposals: a dot grid on plain SVG. x = effort size (XS..XL), y = confidence
// (low..high), one dot per proposal. Blast radius is the only colour encoding, and it is doubled by shape
// (circle low, square medium, triangle high, hollow circle not measured) so colour never carries it alone.
// Every dot is a keyboard-reachable button that opens the card; the list below is the text alternative.
import React, { useState } from 'react';
import { LENS_LABELS, LEVEL_LABELS } from '../../components/labels.js';
import { BLASTS, CONFIDENCES, SIZES, placePoints } from './model.js';

const M = { left: 92, right: 12, top: 12, bottom: 52 };
const CW = 112; // cell width
const CH = 84; // cell height
const STEP = 20; // dot spacing inside a cell
const PER_ROW = 5;
const PER_CELL = 15; // 3 rows; more become "+N"
const W = M.left + SIZES.length * CW + M.right;
const H = M.top + CONFIDENCES.length * CH + M.bottom;

/** One point as a sentence (tooltip, readout, text list). @param {{ref: string, lens: string, effort: string, confidence: string, blast?: string}} p */
export function describe(p) {
  const blast = p.blast ? `blast radius ${(LEVEL_LABELS[p.blast] ?? p.blast).toLowerCase()}` : 'blast radius not measured';
  return `${p.ref}: ${LENS_LABELS[p.lens] ?? p.lens}, effort ${p.effort}, confidence ${(LEVEL_LABELS[p.confidence] ?? p.confidence).toLowerCase()}, ${blast}`;
}

/** The mark for one blast level, centred on (0,0). Exported for the legend. */
export function BlastMark({ blast }) {
  const cls = `dw-dot__mark dw-blast--${BLASTS.includes(blast) ? blast : 'none'}`;
  if (blast === 'medium') return <rect className={cls} x={-6} y={-6} width={12} height={12} rx={2} />;
  if (blast === 'high') return <path className={cls} d="M0,-8 L7.5,6 L-7.5,6 Z" strokeLinejoin="round" />;
  return <circle className={cls} r={blast === 'low' ? 6.5 : 5.5} />;
}

/**
 * @param {{points: any[], onOpen: (ref: string) => void}} props
 */
export function EffortConfidence({ points, onOpen }) {
  const [hover, setHover] = useState(/** @type {any} */ (null));
  const { cells, unplaced } = placePoints(points);
  const yOf = (ci) => M.top + (CONFIDENCES.length - 1 - ci) * CH; // high at the top
  const xOf = (si) => M.left + si * CW;

  return (
    <div>
      <svg
        className="dw-scatter" viewBox={`0 0 ${W} ${H}`} width={W} height={H}
        role="group" aria-label="Open proposals by effort and confidence. Each dot opens its card."
      >
        {CONFIDENCES.map((c, ci) => SIZES.map((s, si) => (
          <rect key={`${c}${s}`} className="dw-scatter__grid" x={xOf(si)} y={yOf(ci)} width={CW} height={CH} />
        )))}
        {/* The cheap, sure corner: small effort and high confidence. */}
        <rect className="dw-scatter__band" x={xOf(0)} y={yOf(2)} width={CW * 2} height={CH} aria-hidden="true" />
        {SIZES.map((s, si) => (
          <text key={s} className="dw-scatter__tick" x={xOf(si) + CW / 2} y={M.top + CONFIDENCES.length * CH + 18} textAnchor="middle">{s}</text>
        ))}
        {CONFIDENCES.map((c, ci) => (
          <text key={c} className="dw-scatter__tick" x={M.left - 10} y={yOf(ci) + CH / 2 + 4} textAnchor="end">{LEVEL_LABELS[c]}</text>
        ))}
        <text className="dw-scatter__axis" x={M.left + (SIZES.length * CW) / 2} y={H - 8} textAnchor="middle">Effort (size)</text>
        <text className="dw-scatter__axis" transform={`translate(16 ${M.top + (CONFIDENCES.length * CH) / 2}) rotate(-90)`} textAnchor="middle">Confidence</text>

        {[...cells.entries()].map(([key, list]) => {
          const [si, ci] = key.split(':').map(Number);
          const shown = list.slice(0, PER_CELL);
          const rows = Math.ceil(shown.length / PER_ROW);
          const x0 = xOf(si) + CW / 2;
          const y0 = yOf(ci) + CH / 2 - ((rows - 1) * STEP) / 2;
          return (
            <g key={key}>
              {shown.map((p, i) => {
                const row = Math.floor(i / PER_ROW);
                const inRow = Math.min(PER_ROW, shown.length - row * PER_ROW);
                const cx = x0 + ((i % PER_ROW) - (inRow - 1) / 2) * STEP;
                const cy = y0 + row * STEP;
                const label = describe(p);
                return (
                  <g
                    key={p.ref} className="dw-dot" transform={`translate(${cx} ${cy})`}
                    role="button" tabIndex={0} aria-label={`${label}. Open the card.`}
                    onClick={() => onOpen(p.ref)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(p.ref); } }}
                    onMouseEnter={() => setHover(p)} onMouseLeave={() => setHover(null)}
                    onFocus={() => setHover(p)} onBlur={() => setHover(null)}
                  >
                    <title>{label}</title>
                    <circle className="dw-dot__hit" r={10} />
                    <BlastMark blast={p.blast} />
                    <circle className="dw-dot__ring" r={10} />
                  </g>
                );
              })}
              {list.length > PER_CELL && (
                <text className="dw-scatter__tick" x={xOf(si) + CW - 6} y={yOf(ci) + CH - 6} textAnchor="end">+{list.length - PER_CELL}</text>
              )}
            </g>
          );
        })}
      </svg>
      <p className="dw-readout" aria-live="polite">{hover ? describe(hover) : 'Point at or focus a dot to read it; select it to open the card.'}</p>
      <div className="dw-legend">
        <span>Blast radius:</span>
        {[...BLASTS, 'none'].map((b) => (
          <span key={b} className="dw-legend__item">
            <svg width="18" height="18" viewBox="-9 -9 18 18" aria-hidden="true"><BlastMark blast={b === 'none' ? undefined : b} /></svg>
            {b === 'none' ? 'not measured' : LEVEL_LABELS[b].toLowerCase()}
          </span>
        ))}
        <span className="dw-legend__item"><span className="dw-legend__swatch dw-scatter__band" style={{ background: 'var(--ds-background-neutral-subtle-hovered, #0515240F)' }} />small and sure</span>
      </div>

      <details className="dw-details" style={{ marginTop: 8 }}>
        <summary>As a list ({points.length})</summary>
        <ul className="dw-pointlist">
          {points.map((p) => (
            <li key={p.ref}>
              <button type="button" className="dw-linkbtn" onClick={() => onOpen(p.ref)}>{p.ref}</button>
              <span>{describe(p).slice(p.ref.length + 2)}</span>
            </li>
          ))}
        </ul>
      </details>
      {unplaced.length > 0 && (
        <p className="dw-subtlest" style={{ marginTop: 4 }}>
          Not placed (effort or confidence outside the scale): {unplaced.map((p) => p.ref).join(', ')}.
        </p>
      )}
    </div>
  );
}
