// Heat grid: areas x lenses as a real <table>. The cell's number is the open proposals in that area for that
// lens (the colour only repeats it); accepted ones are the secondary count. Area annotations: commits and
// authors in the last 90 days, with a single-author flag. Absent authors read "Not measured", never 0.
// A cell with open proposals is a link: the inbox filtered to that area and lens (`cellUrl`), listing exactly the
// cards the cell counts (the backend filters with the mapping map.data counts with).
import React from 'react';
import { Lozenge } from '../../components/ui.jsx';
import { LENSES, LENS_LABELS, formatDate, plural } from '../../components/labels.js';
import { heatLevel, heatRows, singleAuthor } from './model.js';

const SHORT = { opportunity: 'Opportunity', 'ux-friction': 'UX friction', 'doc-drift': 'Doc drift', 'security-cra': 'Security' };

/**
 * @param {{areas: any[], cellUrl?: (area: string, lens: string) => string | undefined, onCell?: (url: string) => void}} props
 *   `cellUrl` builds the inbox link of a cell; `onCell` follows it in the app (a plain click), the href stays for a new tab.
 */
export function HeatGrid({ areas, cellUrl, onCell }) {
  const rows = heatRows(areas);
  const max = Math.max(0, ...rows.flatMap((r) => LENSES.map((l) => r.byLens[l].open)));
  return (
    <div>
      <div className="dw-scroll">
        <table className="dw-heat">
          <caption className="dw-subtle">
            Open proposals per area and lens; accepted ones below each count. Sorted by open proposals, then by commits.
          </caption>
          <thead>
            <tr>
              <th scope="col">Area</th>
              {LENSES.map((l) => <th scope="col" key={l} title={LENS_LABELS[l]}>{SHORT[l]}</th>)}
              <th scope="col" className="dw-heat__num">Open</th>
              <th scope="col" className="dw-heat__num">Commits 90d</th>
              <th scope="col">Authors 90d</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ area, byLens, open, accepted }) => (
              <tr key={area.path}>
                <th scope="row" title={area.last_change ? `Last change ${formatDate(area.last_change)}` : undefined}>
                  <code>{area.path === '.' ? '(repo root)' : area.path}</code>
                  <span className="dw-subtlest"> · {plural(area.files, 'file')}</span>
                </th>
                {LENSES.map((l) => {
                  const c = byLens[l];
                  const level = heatLevel(c.open, max);
                  const label = `${area.path}, ${LENS_LABELS[l]}: ${c.open} open, ${c.accepted} accepted`;
                  return (
                    <td key={l} className={`dw-heat__cell dw-heat__cell--${level}`} title={label}>
                      {c.open === 0 && c.accepted === 0
                        ? <><span aria-hidden="true">·</span><span className="dw-visually-hidden">none</span></>
                        : (
                          <>
                            <CellCount n={c.open} url={c.open > 0 ? cellUrl?.(area.path, l) : undefined} onCell={onCell}
                              label={`Open the ${c.open} open ${LENS_LABELS[l]} proposals in ${area.path === '.' ? 'the repo root' : area.path}`} />
                            {c.accepted > 0 && <span className="dw-heat__acc">{c.accepted} accepted</span>}
                          </>
                        )}
                    </td>
                  );
                })}
                <td className="dw-heat__num">
                  <span className="dw-heat__total">{open}</span>
                  {accepted > 0 && <span className="dw-subtlest"> +{accepted} acc.</span>}
                </td>
                <td className="dw-heat__num">{area.churn_90d}</td>
                <td>
                  {area.authors_90d === undefined
                    ? <span className="dw-subtle">Not measured</span>
                    : (
                      <span className="dw-row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                        <span>{area.authors_90d}</span>
                        {singleAuthor(area) && <Lozenge appearance="removed">Bus factor 1</Lozenge>}
                      </span>
                    )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="dw-legend" aria-hidden="true">
        <span>Open proposals in a cell:</span>
        <span className="dw-legend__item"><span className="dw-legend__swatch" />none</span>
        {[1, 2, 3, 4].map((lv) => [lv, legendRange(lv, max)]).filter(([, r]) => r).map(([lv, r]) => (
          <span key={lv} className="dw-legend__item">
            <span className={`dw-legend__swatch dw-heat__cell--${lv}`} />
            {r}
          </span>
        ))}
      </div>
    </div>
  );
}

/** A cell's open count: a link to the filtered inbox when there is one. */
function CellCount({ n, url, onCell, label }) {
  const inner = <>{n}<span className="dw-visually-hidden"> open</span></>;
  if (!url) return <span className="dw-heat__n">{inner}</span>;
  return (
    <a
      className="dw-heat__link" href={url} aria-label={label} title={label}
      onClick={(e) => { if (onCell && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) { e.preventDefault(); onCell(url); } }}
    >
      <span className="dw-heat__n">{inner}</span>
    </a>
  );
}

/** The open counts that map to a level, for the legend. */
function legendRange(level, max) {
  const vals = [];
  for (let n = 1; n <= max; n++) if (heatLevel(n, max) === level) vals.push(n);
  if (vals.length === 0) return '';
  return vals.length === 1 ? String(vals[0]) : `${vals[0]}-${vals[vals.length - 1]}`;
}
