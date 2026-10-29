// Learning: a digest first. Top: a few plain sentences written from the data. Then "Needs you": the rule
// offers and the accepted items waiting for a rating, as an action queue with inline controls. Then the charts and
// tables as supporting detail. Data: `reflect.data`; writes: `rule.decide`, `outcome.record`.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { call } from '../../api.js';
import { Button, ErrorState, Lozenge, SectionMessage, useAsync } from '../../components/ui.jsx';
import { EmptyArt } from '../../components/Brand.jsx';
import {
  LENS_LABELS, RATINGS, RATING_APPEARANCE, RATING_LABELS, REASON_LABELS, STATUS_APPEARANCE, STATUS_LABELS,
  deciderName, formatDate, formatDay, plural,
} from '../../components/labels.js';
import { BarTrend, HBars, StackedBar } from './charts.jsx';
import { readDupRate } from './readouts.js';
import './reflect.css';
import './learn.css';
import { LensDot } from '../inbox/parts.jsx';

function useReflect(projectKey) {
  const [state, setState] = useState(/** @type {{status: 'loading'|'ready'|'error', data?: any, error?: any}} */ ({ status: 'loading' }));
  const seq = useRef(0);
  const fetchData = useCallback((silent) => {
    const mine = ++seq.current;
    if (!silent) setState({ status: 'loading' });
    return call('reflect.data', { project_key: projectKey }).then(
      (data) => { if (mine === seq.current) setState({ status: 'ready', data }); },
      (error) => { if (mine === seq.current) setState((prev) => (silent && prev.status === 'ready' ? prev : { status: 'error', error })); },
    );
  }, [projectKey]);
  useEffect(() => { fetchData(false); }, [fetchData]);
  return { ...state, reload: () => fetchData(false), refresh: () => fetchData(true) };
}

export default function Reflect() {
  const inboxes = useAsync(() => call('settings.get').then((r) => r.inboxes ?? []), []);
  const [projectKey, setProjectKey] = useState('');
  useEffect(() => {
    if (inboxes.status !== 'ready' || projectKey) return;
    const list = inboxes.data;
    if (list.length > 0) setProjectKey([...list].sort((a, b) => (b.open ?? 0) - (a.open ?? 0))[0].project_key);
  }, [inboxes.status, inboxes.data, projectKey]);

  return (
    <main className="dwr-page">
      <header className="dwr-page__bar">
        <h1 className="dwr-page__h1">What Dowser learned</h1>
        <span className="dwr-spacer" />
        {inboxes.status === 'ready' && inboxes.data.length > 0 && (
          <label className="dwr-field">
            <span className="dwr-visually-hidden">Inbox</span>
            <select className="dwr-select" value={projectKey} onChange={(e) => setProjectKey(e.target.value)}>
              {inboxes.data.map((i) => <option key={i.project_key} value={i.project_key}>{i.project_key.split('/').pop()} ({i.open} open)</option>)}
            </select>
          </label>
        )}
      </header>
      {inboxes.status === 'loading' && <div className="dw-skel dw-skel-card" role="status" aria-label="Loading the inboxes" />}
      {inboxes.status === 'error' && <ErrorState what="The inbox list" error={inboxes.error} onRetry={inboxes.reload} />}
      {inboxes.status === 'ready' && inboxes.data.length === 0 && (
        <section className="dwr-empty" role="status">
          <EmptyArt />
          <h2 className="dwr-empty__h">Nothing to learn from yet.</h2>
          <p>An inbox appears when a scan first pushes proposals. Run <code>/dowser</code> in Claude Code or Codex, in the repository.</p>
        </section>
      )}
      {projectKey && <Body key={projectKey} projectKey={projectKey} />}
    </main>
  );
}

// ---- the digest ----------------------------------------------------------------------------------------------

/** Plain sentences generated from the data; every number comes from reflect.data. */
export function digestLines(d) {
  const lines = [];
  const latest = (d.pushes ?? [])[0];
  if (latest) {
    if (latest.created + latest.updated === 0) {
      lines.push(<>The last push, on {formatDay(latest.at)}, carried no proposals.</>);
    } else {
      const known = latest.updated === 0
        ? 'none of them repeats'
        : latest.dup_rate !== undefined ? `${latest.updated} you already had (${Math.round(latest.dup_rate * 100)}% repeat)` : `${latest.updated} you already had`;
      lines.push(<>The last push, on {formatDay(latest.at)}, brought <strong>{plural(latest.created, 'new item')}</strong>; {known}.</>);
    }
  }
  const proposed = (d.lens_yield ?? []).reduce((n, y) => n + y.proposed, 0);
  const accepted = (d.lens_yield ?? []).reduce((n, y) => n + y.accepted, 0);
  if (proposed > 0) {
    const best = [...(d.lens_yield ?? [])].filter((y) => y.proposed >= 2 && y.accepted > 0).sort((a, b) => b.accepted / b.proposed - a.accepted / a.proposed)[0];
    lines.push(<>You have accepted <strong>{accepted} of {proposed}</strong> proposals so far{best ? <>; <strong>{LENS_LABELS[best.lens]}</strong> converts best ({best.accepted} of {best.proposed}).</> : '.'}</>);
  }
  const rejects = d.rejects ?? [];
  const totalRej = rejects.reduce((n, x) => n + x.count, 0);
  if (totalRej > 0) {
    const byReason = new Map();
    for (const x of rejects) byReason.set(x.reason, (byReason.get(x.reason) ?? 0) + x.count);
    const [reason, n] = [...byReason.entries()].sort((a, b) => b[1] - a[1])[0];
    lines.push(<>The most common reason to say no is <strong>{(REASON_LABELS[reason] ?? reason).toLowerCase()}</strong> ({n} of {plural(totalRej, 'reject')}).</>);
  }
  const offered = (d.rules ?? []).filter((x) => x.state === 'offered').length;
  const toRate = (d.candidates ?? []).length;
  lines.push(offered + toRate > 0
    ? <><strong>{[offered > 0 && plural(offered, 'rule offer'), toRate > 0 && `${plural(toRate, 'accepted item')} to rate`].filter(Boolean).join(' and ')}</strong> {offered + toRate === 1 ? 'is' : 'are'} waiting for you.</>
    : <>Nothing is waiting for you.</>);
  return lines;
}

function Body({ projectKey }) {
  const r = useReflect(projectKey);
  const d = r.data;
  return (
    <>
      <section className="dwr-digest" aria-label="Summary">
        {r.status === 'loading' && (
          <div role="status" aria-label="Loading the summary" aria-busy="true">
            {[90, 70, 80].map((w) => <div key={w} className="dw-skel dwr-skel-line" style={{ width: `${w}%` }} />)}
          </div>
        )}
        {r.status === 'error' && <ErrorState what="The Learning digest" error={r.error} onRetry={r.reload} />}
        {r.status === 'ready' && (digestLines(d).length > 0 && (d.pushes ?? []).length + (d.lens_yield ?? []).length + (d.rules ?? []).length + (d.candidates ?? []).length > 0
          ? <ul className="dwr-digest__list">{digestLines(d).map((l, i) => <li key={i}>{l}</li>)}</ul>
          : <p className="dwr-muted">No push has reached this inbox yet. The digest appears after the first scan.</p>)}
      </section>

      {r.status === 'ready' && <NeedsYou d={d} projectKey={projectKey} onChanged={r.refresh} />}

      <h2 className="dwr-page__sub">Supporting detail</h2>
      <div className="dwr-learn__grid">
        <Section id="yield" title="Lens yield" hint="Proposed vs accepted, per lens." r={r} empty={!d || (d.lens_yield ?? []).length === 0} emptyText="No proposals yet, so no lens has a yield.">
          {d && <YieldRows rows={d.lens_yield ?? []} />}
        </Section>
        <Section id="no" title="Why we say no" hint="Reject reasons by lens, and the latest notes." r={r} empty={!d || ((d.rejects ?? []).length === 0 && (d.notes ?? []).length === 0)} emptyText="Nothing rejected and no decision notes yet. When you reject or snooze with a reason, it shows up here.">
          {d && <WhyNo rejects={d.rejects ?? []} notes={d.notes ?? []} />}
        </Section>
        <Section id="retro" wide title="Scan retro" hint="How the latest push landed, and how pushes compare." r={r} empty={!d || (d.pushes ?? []).length === 0} emptyText="No push has reached this inbox yet. The retro appears after the first scan.">
          {d && <Retro pushes={d.pushes ?? []} />}
        </Section>
        <Section id="decided" wide title="Decided rules and recorded outcomes" hint="What you already answered." r={r} empty={!d || ((d.rules ?? []).filter((x) => x.state !== 'offered').length === 0 && (d.outcomes ?? []).length === 0)} emptyText="No rule has been decided and no outcome recorded yet.">
          {d && <Decided rules={(d.rules ?? []).filter((x) => x.state !== 'offered')} outcomes={d.outcomes ?? []} />}
        </Section>
      </div>
    </>
  );
}

function Section({ id, title, hint, r, empty, emptyText, wide = false, children }) {
  return (
    <section className={`dwr-sec${wide ? ' dwr-sec--wide' : ''}`} aria-labelledby={`dwr-rf-${id}`}>
      <h3 className="dwr-sec__h" id={`dwr-rf-${id}`}>{title}</h3>
      <p className="dwr-sec__hint">{hint}</p>
      {r.status === 'loading' && (
        <div role="status" aria-label={`Loading ${title}`} aria-busy="true">
          <div className="dw-skel" style={{ height: 14, width: '40%', marginBottom: 8 }} />
          <div className="dw-skel" style={{ height: 72 }} />
        </div>
      )}
      {r.status === 'error' && <ErrorState what={title} error={r.error} onRetry={r.reload} />}
      {r.status === 'ready' && (empty ? <p className="dwr-muted" role="status">{emptyText}</p> : children)}
    </section>
  );
}

// ---- needs you -----------------------------------------------------------------------------------------------

function NeedsYou({ d, projectKey, onChanged }) {
  const offers = (d.rules ?? []).filter((x) => x.state === 'offered');
  const cands = d.candidates ?? [];
  const n = offers.length + cands.length;
  return (
    <section className="dwr-needs" aria-labelledby="dwr-needs-h">
      <h2 className="dwr-page__sub" id="dwr-needs-h">Needs you <span className="dwr-count">{n}</span></h2>
      {n === 0
        ? <p className="dwr-muted" role="status">Nothing to decide. Dowser drafts a rule when the same kind of proposal keeps getting the same answer, and lists an accepted item here once its Jira issue moves.</p>
        : (
          <ul className="dwr-needs__list">
            {offers.map((x) => <li key={x.id}><RuleOffer rule={x} projectKey={projectKey} onChanged={onChanged} /></li>)}
            {cands.map((c) => <li key={c.ref}><Candidate cand={c} onChanged={onChanged} /></li>)}
          </ul>
        )}
    </section>
  );
}

function RuleOffer({ rule, projectKey, onChanged }) {
  const [text, setText] = useState(rule.text);
  const [busy, setBusy] = useState(/** @type {'' | 'accepted' | 'declined'} */ (''));
  const [error, setError] = useState('');
  const id = `dwr-rule-${rule.id}`;
  async function decide(state) {
    setBusy(state); setError('');
    /** @type {{project_key: string, id: string, state: string, text?: string}} */
    const payload = { project_key: projectKey, id: rule.id, state };
    if (state === 'accepted' && text.trim() && text.trim() !== rule.text) payload.text = text.trim();
    try {
      await call('rule.decide', payload);
      await onChanged();
      setBusy('');
    } catch (e) {
      setError(String(e?.message ?? 'The rule could not be saved.'));
      setBusy('');
    }
  }
  return (
    <article className="dwr-need" aria-label={`Offered rule for ${LENS_LABELS[rule.lens] ?? rule.lens}`}>
      <div className="dwr-need__meta">
        <Lozenge appearance="new">Rule offer</Lozenge>
        <LensDot lens={rule.lens} /><span>{LENS_LABELS[rule.lens] ?? rule.lens}</span>
        <span className="dwr-need__when">offered {formatDay(rule.offered_at)}</span>
      </div>
      <label className="dwr-visually-hidden" htmlFor={id}>Rule (edit before accepting)</label>
      <textarea id={id} className="dwr-need__text" rows={2} value={text} onChange={(e) => setText(e.target.value)} maxLength={500} />
      {rule.titles && rule.titles.length > 0 && (
        <details className="dwr-more dwr-more--tight">
          <summary>Triggered by {plural(rule.titles.length, 'item')}</summary>
          <ul className="dwr-triggers">{rule.titles.map((t) => <li key={t}>{t}</li>)}</ul>
        </details>
      )}
      <div className="dwr-need__act">
        <Button appearance="primary" onClick={() => decide('accepted')} busy={busy === 'accepted'} disabled={!text.trim() || Boolean(busy)}>Accept rule</Button>
        <Button onClick={() => decide('declined')} busy={busy === 'declined'} disabled={Boolean(busy)}>Decline</Button>
        <span className="dwr-muted dwr-need__hint">Accepted rules shape the next scan. Edit the wording first if needed.</span>
      </div>
      {error && <SectionMessage appearance="error"><p>{error}</p></SectionMessage>}
    </article>
  );
}

function Candidate({ cand, onChanged }) {
  const [rating, setRating] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const name = `dwr-rate-${cand.ref}`;
  async function record() {
    setBusy(true); setError('');
    /** @type {{ref: string, rating: string, note?: string}} */
    const payload = { ref: cand.ref, rating };
    if (note.trim()) payload.note = note.trim();
    try {
      await call('outcome.record', payload);
      await onChanged();
      setBusy(false);
    } catch (e) {
      setError(String(e?.message ?? 'The outcome could not be saved.'));
      setBusy(false);
    }
  }
  return (
    <article className="dwr-need" aria-label={`Rate ${cand.ref}`}>
      <div className="dwr-need__meta">
        <Lozenge appearance="inprogress">Rate outcome</Lozenge>
        <span className="dwr-ref">{cand.ref}</span>
        <a href={cand.issue_url} target="_blank" rel="noreferrer noopener">{cand.issue_ref}</a>
        <Lozenge appearance={cand.done ? 'success' : 'default'}>{cand.issue_status}</Lozenge>
        {cand.done && <span className="dwr-need__when">Jira says Done: ready to rate</span>}
      </div>
      <h3 className="dwr-need__title">{cand.title}</h3>
      <div className="dwr-need__act">
        <fieldset className="dwr-rate">
          <legend className="dwr-visually-hidden">How did {cand.ref} turn out?</legend>
          {RATINGS.map((r) => (
            <label key={r.code} className={`dwr-rate__opt dwr-rate__opt--${r.code}`}>
              <input type="radio" name={name} value={r.code} checked={rating === r.code} onChange={() => setRating(r.code)} />
              <span><span aria-hidden="true">{r.mark} </span>{r.label}</span>
            </label>
          ))}
        </fieldset>
        <label className="dwr-visually-hidden" htmlFor={`${name}-note`}>Note on {cand.ref} (optional)</label>
        <input id={`${name}-note`} className="dw-input dwr-need__note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What happened? (optional)" maxLength={500} autoComplete="off" />
        <Button appearance="primary" onClick={record} disabled={!rating} busy={busy}>Record</Button>
      </div>
      {error && <SectionMessage appearance="error"><p>{error}</p></SectionMessage>}
    </article>
  );
}

// ---- supporting detail ---------------------------------------------------------------------------------------

function YieldRows({ rows }) {
  return (
    <ul className="dwr-yield">
      {rows.map((y) => {
        const share = y.proposed > 0 ? y.accepted / y.proposed : 0;
        return (
          <li key={y.lens} className="dwr-yield__row">
            <span className="dwr-yield__name"><LensDot lens={y.lens} />{LENS_LABELS[y.lens] ?? y.lens}</span>
            <span className="dwr-yield__track" aria-hidden="true"><span className={`dwr-yield__fill dwr-yield__fill--${y.lens}`} style={{ width: `${Math.round(share * 100)}%` }} /></span>
            <span className="dwr-yield__n"><strong>{y.accepted}</strong> of {y.proposed}{y.proposed > 0 && <span className="dwr-muted"> · {Math.round(share * 100)}%</span>}</span>
          </li>
        );
      })}
    </ul>
  );
}

const acceptedShare = (p) => {
  const total = p.open + p.accepted + p.rejected + p.snoozed;
  return total > 0 ? p.accepted / total : undefined;
};

/** Time to triage one push: minutes once every item is decided, "Still open" while any is open, else nothing. */
const triageText = (p) => (p.triage_minutes !== undefined ? `Triaged in ${p.triage_minutes} min` : p.open > 0 ? 'Still open' : '');

function Retro({ pushes }) {
  const [latest, ...older] = pushes;
  const chrono = [...pushes].reverse();
  const trendDup = chrono.map((p) => ({ label: formatDay(p.at).replace(/ \d{4}$/, ''), value: p.dup_rate }));
  const trendAcc = chrono.map((p) => ({ label: formatDay(p.at).replace(/ \d{4}$/, ''), value: acceptedShare(p) }));
  return (
    <>
      <p className="dwr-retro__head">
        <strong>Latest push, {formatDate(latest.at)}</strong>
        {latest.head_sha && <span className="dwr-muted"> at <code>{latest.head_sha.slice(0, 7)}</code></span>}
        {triageText(latest) && <span className="dwr-muted"> · {triageText(latest)}</span>}
      </p>
      <dl className="dwr-bigstats">
        <div><dd>{latest.created}</dd><dt>created</dt></div>
        <div><dd>{latest.updated}</dd><dt>updated (already known)</dt></div>
        <div><dd>{latest.dup_rate === undefined ? 'n/a' : `${Math.round(latest.dup_rate * 100)}%`}</dd><dt>repeat rate</dt></div>
      </dl>
      <p className="dwr-reading">{readDupRate(latest)}</p>
      <h4 className="dwr-h4">Decisions so far on this push</h4>
      <StackedBar label="Decisions on the items of the latest push" values={latest} />
      <h4 className="dwr-h4">Trend{older.length > 0 ? ` over the last ${plural(pushes.length, 'push', 'pushes')}` : ''}</h4>
      {older.length === 0
        ? <p className="dwr-muted">The trend appears after a second push.</p>
        : (
          <>
            <div className="dw-trends">
              <BarTrend title="Repeat rate (lower means more that is new)" points={trendDup} variant="dup" idPrefix="dup" />
              <BarTrend title="Accepted share of the push's items" points={trendAcc} variant="accepted" idPrefix="acc" />
            </div>
            <details className="dwr-more">
              <summary>View the push data as a table</summary>
              <div className="dw-scroll">
                <table className="dw-table">
                  <thead><tr><th scope="col">Push</th><th scope="col">Created</th><th scope="col">Updated</th><th scope="col">Repeat rate</th><th scope="col">Accepted</th><th scope="col">Rejected</th><th scope="col">Snoozed</th><th scope="col">Open</th><th scope="col">Triage</th></tr></thead>
                  <tbody>
                    {pushes.map((p) => (
                      <tr key={p.run_id}>
                        <th scope="row">{formatDate(p.at)}</th><td>{p.created}</td><td>{p.updated}</td>
                        <td>{p.dup_rate === undefined ? 'n/a' : `${Math.round(p.dup_rate * 100)}%`}</td>
                        <td>{p.accepted}</td><td>{p.rejected}</td><td>{p.snoozed}</td><td>{p.open}</td><td>{triageText(p)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </>
        )}
    </>
  );
}

function WhyNo({ rejects, notes }) {
  const byLens = new Map();
  for (const x of rejects) {
    const e = byLens.get(x.lens) ?? { lens: x.lens, total: 0, rows: [] };
    e.total += x.count; e.rows.push({ label: REASON_LABELS[x.reason] ?? x.reason, count: x.count });
    byLens.set(x.lens, e);
  }
  const lenses = [...byLens.values()].sort((a, b) => b.total - a.total);
  for (const l of lenses) l.rows.sort((a, b) => b.count - a.count);
  const max = Math.max(1, ...rejects.map((x) => x.count));
  return (
    <>
      {lenses.length === 0
        ? <p className="dwr-muted">No rejects yet.</p>
        : (
          <>
            {lenses.map((l) => (
              <div key={l.lens} className="dwr-no">
                <div className="dwr-no__head"><LensDot lens={l.lens} /><strong>{LENS_LABELS[l.lens] ?? l.lens}</strong><span className="dwr-muted">{plural(l.total, 'reject')}</span></div>
                <HBars rows={l.rows} max={max} />
              </div>
            ))}
            <details className="dwr-more">
              <summary>View the rejects as a table</summary>
              <table className="dw-table">
                <thead><tr><th scope="col">Lens</th><th scope="col">Reason</th><th scope="col">Rejects</th></tr></thead>
                <tbody>{rejects.map((x) => <tr key={`${x.lens}:${x.reason}`}><td>{LENS_LABELS[x.lens] ?? x.lens}</td><td>{REASON_LABELS[x.reason] ?? x.reason}</td><td>{x.count}</td></tr>)}</tbody>
              </table>
            </details>
          </>
        )}
      <h4 className="dwr-h4">Latest decision notes</h4>
      {notes.length === 0
        ? <p className="dwr-muted">No decision has a note yet. Notes on accept, snooze and reject show here.</p>
        : (
          <ul className="dwr-notes">
            {notes.map((n) => (
              <li key={`${n.ref}:${n.decided_at}`}>
                <div className="dwr-notes__head">
                  <span className="dwr-ref">{n.ref}</span>
                  <Lozenge appearance={STATUS_APPEARANCE[n.status] ?? 'default'}>{STATUS_LABELS[n.status] ?? n.status}</Lozenge>
                  <strong>{n.title}</strong>
                </div>
                <div className="dw-note">{n.note}</div>
                <div className="dwr-need__when">{n.decided_by_name ?? 'A Jira user'} · {formatDate(n.decided_at)}</div>
              </li>
            ))}
          </ul>
        )}
    </>
  );
}

function Decided({ rules, outcomes }) {
  return (
    <div className="dwr-decided">
      {rules.length > 0 && (
        <div>
          <h4 className="dwr-h4 dwr-h4--first">Decided rules</h4>
          <ul className="dwr-notes">
            {rules.map((x) => (
              <li key={x.id}>
                <div className="dwr-notes__head">
                  <Lozenge appearance={x.state === 'accepted' ? 'success' : 'default'}>{x.state === 'accepted' ? 'Accepted' : 'Declined'}</Lozenge>
                  <LensDot lens={x.lens} /><span>{LENS_LABELS[x.lens] ?? x.lens}</span>
                </div>
                <p className="dwr-notes__text">{x.text}</p>
                <div className="dwr-need__when">{x.decided_by_name ?? 'A Jira user'}{x.decided_at && <> · {formatDate(x.decided_at)}</>}</div>
              </li>
            ))}
          </ul>
        </div>
      )}
      {outcomes.length > 0 && (
        <div>
          <h4 className="dwr-h4 dwr-h4--first">Recorded outcomes</h4>
          <ul className="dwr-notes">
            {outcomes.map((o) => (
              <li key={o.ref}>
                <div className="dwr-notes__head">
                  <Lozenge appearance={RATING_APPEARANCE[o.rating] ?? 'default'}>{RATINGS.find((x) => x.code === o.rating)?.mark} {RATING_LABELS[o.rating] ?? o.rating}</Lozenge>
                  <span className="dwr-ref">{o.ref}</span>
                  <strong>{o.title}</strong>
                  <span className="dwr-need__when">{o.issue_ref}</span>
                </div>
                {o.note && <div className="dw-note">{o.note}</div>}
                <div className="dwr-need__when">{deciderName(o.decided_by, o.decided_by_name)} · {formatDate(o.recorded_at)}</div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
