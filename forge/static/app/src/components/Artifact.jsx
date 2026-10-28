// Supporting views of a card (`artifacts[]`, contract in skill/references/cards.md "Artifacts"): a table, a flow, a
// before/after or a matrix, each a re-arrangement of the card's own evidence. Every view reads message (bold, one
// line), then the figure, then "From <refs>". Plain HTML only, no chart library and no inline style attributes:
// shades and marks are classes (reading.css "Supporting views"). A view whose kind is unknown or whose data fails the
// light shape check below renders its `alt` as a paragraph, never a broken figure. The push already validated the
// record with the skill's validateCandidate; this check only guards the renderer against an older or hand-made row.
//
// The flow is a semantic ordered list, not SVG: labels run to 40 characters and up to 8 steps, which SVG text cannot
// wrap at the 360px panel width, and a list is read as a sequence by screen readers without an aria-label stand-in.
import React from 'react';
import { Lozenge } from './ui.jsx';

/** Flow marks: a word and a glyph each, so a marked step never relies on colour. */
const MARKS = {
  friction: { label: 'Friction', glyph: '!', appearance: 'moved' },
  failure: { label: 'Failure', glyph: '✕', appearance: 'removed' },
  missing: { label: 'Missing', glyph: '?', appearance: 'default' },
  new: { label: 'New', glyph: '+', appearance: 'new' },
};

const isStr = (v) => typeof v === 'string';
const strList = (v) => Array.isArray(v) && v.length > 0 && v.every(isStr);

/**
 * Whether an artifact has a shape this renderer can draw. Light by design: kinds and array shapes, not the caps.
 * @param {any} a
 */
export function drawable(a) {
  const d = a?.data;
  if (!d || typeof d !== 'object') return false;
  if (a.kind === 'table') {
    return strList(d.columns) && Array.isArray(d.rows) && d.rows.length > 0
      && d.rows.every((r) => Array.isArray(r) && r.length === d.columns.length && r.every(isStr))
      && (d.highlight === undefined || (Array.isArray(d.highlight) && d.highlight.every(Number.isInteger)));
  }
  if (a.kind === 'flow') {
    return Array.isArray(d.steps) && d.steps.length > 0
      && d.steps.every((s) => s && isStr(s.label) && (s.mark === undefined || s.mark in MARKS));
  }
  if (a.kind === 'before-after') return isStr(d.measure) && strList(d.before) && strList(d.after);
  if (a.kind === 'matrix') {
    return strList(d.rows) && strList(d.columns) && Array.isArray(d.cells) && d.cells.length === d.rows.length
      && d.cells.every((row) => Array.isArray(row) && row.length === d.columns.length
        && row.every((c) => c && isStr(c.v) && (c.level === undefined || [0, 1, 2, 3].includes(c.level))));
  }
  return false;
}

/** A number with an optional sign, currency and short unit: "41", "2.5 s", "-12%", "~3 days". Versions are not. */
const NUMERIC = /^[<>~≈±+−-]?\s?[$€£]?\d+(?:[.,]\d+)?\s?(?:%|[a-zA-Zµ]{1,5})?$/;

function TableView({ data }) {
  // A column is right-aligned when every filled cell in it reads as a number, so the column aligns as a whole.
  const numeric = data.columns.map((_, c) => {
    const cells = data.rows.map((r) => r[c].trim()).filter(Boolean);
    return cells.length > 0 && cells.every((v) => NUMERIC.test(v));
  });
  const hl = new Set(data.highlight ?? []);
  const cls = (c) => (numeric[c] ? 'dwr-art__num' : undefined);
  return (
    <div className="dwr-art__scroll" tabIndex={0} role="region" aria-label="Table, scrolls sideways">
      <table className="dwr-art__table">
        <thead>
          <tr>{data.columns.map((h, c) => <th key={c} scope="col" className={cls(c)}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {data.rows.map((row, r) => (
            <tr key={r} className={hl.has(r) ? 'dwr-art__hl' : undefined}>
              {row.map((v, c) => (c === 0
                ? <th key={c} scope="row" className={cls(c)}>{v}</th>
                : <td key={c} className={cls(c)}>{v}</td>))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FlowView({ data }) {
  return (
    <ol className="dwr-art__flow">
      {data.steps.map((s, i) => {
        const m = s.mark ? MARKS[s.mark] : undefined;
        return (
          <li key={i} className={`dwr-art__step${s.mark ? ` dwr-art__step--${s.mark}` : ''}`}>
            <span className="dwr-art__node" aria-hidden="true">{m ? m.glyph : i + 1}</span>
            <span className="dwr-art__label">
              {s.label}
              {m && <> <Lozenge appearance={m.appearance}>{m.label}</Lozenge></>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function BeforeAfterView({ data }) {
  const n = Math.max(data.before.length, data.after.length);
  return (
    <table className="dwr-art__ba">
      <caption className="dwr-art__measure">{data.measure}</caption>
      <thead>
        <tr>
          <th scope="col">Today <span className="dwr-count">{data.before.length}</span></th>
          <th scope="col">After <span className="dwr-count">{data.after.length}</span></th>
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: n }, (_, i) => (
          <tr key={i}>
            <td>{data.before[i] ?? ''}</td>
            <td>{data.after[i] ?? ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function MatrixView({ data }) {
  return (
    <div className="dwr-art__scroll" tabIndex={0} role="region" aria-label="Matrix, scrolls sideways">
      <table className="dwr-art__matrix">
        <thead>
          <tr><td />{data.columns.map((h, c) => <th key={c} scope="col">{h}</th>)}</tr>
        </thead>
        <tbody>
          {data.rows.map((label, r) => (
            <tr key={r}>
              <th scope="row">{label}</th>
              {data.cells[r].map((cell, c) => (
                <td key={c} className={`dwr-art__lv${cell.level ?? 0}`}>{cell.v}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const VIEWS = { table: TableView, flow: FlowView, 'before-after': BeforeAfterView, matrix: MatrixView };

/**
 * One supporting view: message, figure, source refs. Falls back to the alt text when it cannot be drawn.
 * @param {{artifact: any}} props
 */
export function Artifact({ artifact }) {
  const refs = Array.isArray(artifact?.refs) ? artifact.refs.filter(isStr) : [];
  const View = drawable(artifact) ? VIEWS[artifact.kind] : undefined;
  return (
    <figure className="dwr-art">
      {isStr(artifact?.message) && <p className="dwr-art__msg">{artifact.message}</p>}
      {View
        ? <View data={artifact.data} />
        : <p className="dwr-art__alt">{isStr(artifact?.alt) && artifact.alt ? artifact.alt : 'This view could not be shown.'}</p>}
      {refs.length > 0 && (
        <figcaption className="dwr-art__from">
          From {refs.map((r, i) => <span key={`${r}:${i}`}>{i > 0 && ', '}<span className="dwr-ref">{r}</span></span>)}
        </figcaption>
      )}
    </figure>
  );
}

/**
 * The "Supporting views" section of a card; nothing when the card has none.
 * @param {{artifacts?: any[], compact?: boolean}} props
 */
export function Artifacts({ artifacts, compact = false }) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) return null;
  return (
    <section className={`dwr-section dwr-arts${compact ? ' dwr-arts--compact' : ''}`} aria-label="Supporting views">
      <h3 className="dwr-h3">Supporting views <span className="dwr-count">{artifacts.length}</span></h3>
      <div className="dwr-arts__list">
        {artifacts.map((a, i) => <Artifact key={i} artifact={a} />)}
      </div>
    </section>
  );
}
