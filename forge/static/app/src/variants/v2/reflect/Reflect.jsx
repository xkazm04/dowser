// Variant 2 Learning: an editorial report. Same data and the same write-backs as routes/reflect (rule.decide,
// outcome.record), set as a document: a lede, large numbers with small captions, sections separated by whitespace,
// thin-line charts, and rule offers as quoted statements.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { call } from '../../../api.js';
import { Button, ErrorState, useAsync } from '../../../components/ui.jsx';
import { readDupRate } from '../../../routes/reflect/index.jsx';
import {
  LENS_LABELS, RATINGS, RATING_LABELS, REASON_LABELS, STATUS_LABELS,
  deciderName, formatDate, formatDay, plural,
} from '../../../components/labels.js';
import { LensDot, Masthead, formatShort } from '../shared.jsx';
import { DecisionBar, LineTrend, Rows } from './charts.jsx';

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

export default function Reflect({ context }) {
  const inboxes = useAsync(() => call('settings.get').then((r) => r.inboxes ?? []), []);
  const [projectKey, setProjectKey] = useState('');
  useEffect(() => {
    if (inboxes.status !== 'ready' || projectKey) return;
    const list = inboxes.data;
    if (list.length > 0) setProjectKey([...list].sort((a, b) => (b.open ?? 0) - (a.open ?? 0))[0].project_key);
  }, [inboxes.status, inboxes.data, projectKey]);

  return (
    <main className="dw2-page dw2-page--report">
      <div className="dw2-col">
        <Masthead
          context={context} active="reflect" title="Learning"
          inboxes={inboxes.status === 'ready' ? inboxes.data : undefined} projectKey={projectKey} onProjectChange={setProjectKey}
        />
        <p className="dw2-lede">
          What the scans found, what you decided and why, and whether the accepted work turned out to be the right call.
          Dowser reads this back at the next scan.
        </p>
        {inboxes.status === 'loading' && <div className="dw-skel dw2-sk dw2-sk--title" role="status" aria-label="Loading the inboxes" />}
        {inboxes.status === 'error' && <ErrorState what="The inbox list" error={inboxes.error} onRetry={inboxes.reload} />}
        {inboxes.status === 'ready' && inboxes.data.length === 0 && (
          <section className="dw2-empty" role="status">
            <h2>Nothing to learn from yet.</h2>
            <p>An inbox appears when a scan first pushes proposals. Run <code>/dowser</code> in Claude Code or Codex, in the repository.</p>
          </section>
        )}
        {projectKey && <ReflectBody key={projectKey} projectKey={projectKey} />}
      </div>
    </main>
  );
}

function ReflectBody({ projectKey }) {
  const r = useReflect(projectKey);
  const d = r.data;
  return (
    <>
      <Section id="yield" title="Lens yield" hint="Proposed against accepted, per lens." r={r} empty={!d || (d.lens_yield ?? []).length === 0} emptyText="No proposals yet, so no lens has a yield.">
        {d && <YieldStrip rows={d.lens_yield ?? []} />}
      </Section>
      <Section id="retro" title="Scan retro" hint="How the latest push landed, and how pushes compare." r={r} empty={!d || (d.pushes ?? []).length === 0} emptyText="No push has reached this inbox yet. The retro appears after the first scan.">
        {d && <Retro pushes={d.pushes ?? []} />}
      </Section>
      <Section id="no" title="Why we say no" hint="Reject reasons by lens, and the latest notes." r={r} empty={!d || ((d.rejects ?? []).length === 0 && (d.notes ?? []).length === 0)} emptyText="Nothing rejected and no decision notes yet. When you reject or snooze with a reason, it shows up here.">
        {d && <WhyNo rejects={d.rejects ?? []} notes={d.notes ?? []} />}
      </Section>
      <Section id="rules" title="Rules Dowser is offering" hint="Standing rules drafted from your decisions. Accepted rules shape the next scan." r={r} empty={!d || (d.rules ?? []).length === 0} emptyText="No rules offered yet. Dowser drafts one when the same kind of proposal keeps getting the same answer.">
        {d && <Rules rules={d.rules ?? []} projectKey={projectKey} onChanged={r.refresh} />}
      </Section>
      <Section id="landed" title="Did it land?" hint="Rate accepted work once it has shipped." r={r} empty={!d || ((d.candidates ?? []).length === 0 && (d.outcomes ?? []).length === 0)} emptyText="No accepted issue to rate yet. Accepted items appear here to be rated once their Jira issue moves.">
        {d && <Landed candidates={d.candidates ?? []} outcomes={d.outcomes ?? []} projectKey={projectKey} onChanged={r.refresh} />}
      </Section>
    </>
  );
}

/** A section shell: heading always, then this section's own loading / error / empty / content state. */
function Section({ id, title, hint, r, empty, emptyText, children }) {
  return (
    <section className="dw2-sec" aria-labelledby={`dw-rf-${id}`}>
      <h2 className="dw2-sec__h" id={`dw-rf-${id}`}>{title}</h2>
      <p className="dw2-sec__hint">{hint}</p>
      {r.status === 'loading' && (
        <div role="status" aria-label={`Loading ${title}`} aria-busy="true">
          <div className="dw-skel dw2-sk dw2-sk--line" />
          <div className="dw-skel dw2-sk dw2-sk--line dw2-sk--short" />
        </div>
      )}
      {r.status === 'error' && <ErrorState what={title} error={r.error} onRetry={r.reload} />}
      {r.status === 'ready' && (empty ? <p className="dw2-muted" role="status">{emptyText}</p> : children)}
    </section>
  );
}

// ---- lens yield ----------------------------------------------------------------------------------------------

function YieldStrip({ rows }) {
  return (
    <ul className="dw2-yield">
      {rows.map((y) => {
        const share = y.proposed > 0 ? y.accepted / y.proposed : 0;
        return (
          <li key={y.lens}>
            <span className="dw2-yield__n">{Math.round(share * 100)}<small>%</small></span>
            <span className="dw2-yield__lens"><LensDot lens={y.lens} />{LENS_LABELS[y.lens] ?? y.lens}</span>
            <span className="dw2-yield__cap">{y.accepted} of {y.proposed} accepted</span>
            <span className="dw2-yield__track" aria-hidden="true"><span className="dw2-yield__fill" style={{ width: `${Math.round(share * 100)}%` }} /></span>
          </li>
        );
      })}
    </ul>
  );
}

// ---- scan retro ----------------------------------------------------------------------------------------------

const acceptedShare = (p) => {
  const total = p.open + p.accepted + p.rejected + p.snoozed;
  return total > 0 ? p.accepted / total : undefined;
};

function Retro({ pushes }) {
  const [latest, ...older] = pushes;
  const chrono = [...pushes].reverse();
  const short = (iso) => formatDay(iso).replace(/ \d{4}$/, '');
  const trendDup = chrono.map((p) => ({ label: short(p.at), value: p.dup_rate }));
  const trendAcc = chrono.map((p) => ({ label: short(p.at), value: acceptedShare(p) }));
  return (
    <>
      <h3 className="dw2-h3">Latest push <span className="dw2-muted">{formatShort(latest.at)}{latest.head_sha && <> &middot; <code>{latest.head_sha.slice(0, 7)}</code></>}</span></h3>
      <dl className="dw2-nums">
        <div><dd>{latest.created}</dd><dt>created</dt></div>
        <div><dd>{latest.updated}</dd><dt>updated, already known</dt></div>
        <div><dd>{latest.dup_rate === undefined ? 'n/a' : <>{Math.round(latest.dup_rate * 100)}<small>%</small></>}</dd><dt>repeat rate</dt></div>
      </dl>
      <p className="dw2-reading">{readDupRate(latest)}</p>
      <h3 className="dw2-h3">Decisions so far</h3>
      <DecisionBar label="Decisions on the items of the latest push" values={latest} />

      <h3 className="dw2-h3 dw2-h3--gap">Trend{older.length > 0 ? <span className="dw2-muted"> over the last {plural(pushes.length, 'push', 'pushes')}</span> : ''}</h3>
      {older.length === 0
        ? <p className="dw2-muted">The trend appears after a second push.</p>
        : (
          <>
            <div className="dw2-trends">
              <LineTrend title="Repeat rate" caption="lower means more that is new" points={trendDup} tone="plain" />
              <LineTrend title="Accepted share of the push's items" points={trendAcc} tone="ink" />
            </div>
            <details className="dw2-fold">
              <summary>View the push data as a table</summary>
              <div className="dw-scroll">
                <table className="dw-table">
                  <thead><tr><th scope="col">Push</th><th scope="col">Created</th><th scope="col">Updated</th><th scope="col">Repeat rate</th><th scope="col">Accepted</th><th scope="col">Rejected</th><th scope="col">Snoozed</th><th scope="col">Open</th></tr></thead>
                  <tbody>
                    {pushes.map((p) => (
                      <tr key={p.run_id}>
                        <th scope="row">{formatDate(p.at)}</th><td>{p.created}</td><td>{p.updated}</td>
                        <td>{p.dup_rate === undefined ? 'n/a' : `${Math.round(p.dup_rate * 100)}%`}</td>
                        <td>{p.accepted}</td><td>{p.rejected}</td><td>{p.snoozed}</td><td>{p.open}</td>
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

// ---- why we say no -------------------------------------------------------------------------------------------

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
        ? <p className="dw2-muted">No rejects yet.</p>
        : (
          <>
            <div className="dw2-nogrid">
              {lenses.map((l) => (
                <div key={l.lens}>
                  <h3 className="dw2-h3"><LensDot lens={l.lens} />{LENS_LABELS[l.lens] ?? l.lens} <span className="dw2-muted">{plural(l.total, 'reject')}</span></h3>
                  <Rows rows={l.rows} max={max} />
                </div>
              ))}
            </div>
            <details className="dw2-fold">
              <summary>View the rejects as a table</summary>
              <table className="dw-table">
                <thead><tr><th scope="col">Lens</th><th scope="col">Reason</th><th scope="col">Rejects</th></tr></thead>
                <tbody>{rejects.map((x) => <tr key={`${x.lens}:${x.reason}`}><td>{LENS_LABELS[x.lens] ?? x.lens}</td><td>{REASON_LABELS[x.reason] ?? x.reason}</td><td>{x.count}</td></tr>)}</tbody>
              </table>
            </details>
          </>
        )}
      <h3 className="dw2-h3 dw2-h3--gap">Latest decision notes</h3>
      {notes.length === 0
        ? <p className="dw2-muted">No decision has a note yet. Notes on accept, snooze and reject show here.</p>
        : (
          <ul className="dw2-quotes">
            {notes.map((n) => (
              <li key={`${n.ref}:${n.decided_at}`}>
                <blockquote>{n.note}</blockquote>
                <p className="dw2-cite">
                  {n.decided_by_name ?? 'A Jira user'} &middot; {formatShort(n.decided_at)} &middot; {STATUS_LABELS[n.status] ?? n.status} <span className="dw2-mono">{n.ref}</span> {n.title}
                </p>
              </li>
            ))}
          </ul>
        )}
    </>
  );
}

// ---- rules ---------------------------------------------------------------------------------------------------

function Rules({ rules, projectKey, onChanged }) {
  const offered = rules.filter((x) => x.state === 'offered');
  const decided = rules.filter((x) => x.state !== 'offered');
  return (
    <>
      {offered.length === 0
        ? <p className="dw2-muted">No rule is waiting for your answer.</p>
        : <ul className="dw2-rules">{offered.map((x) => <li key={x.id}><RuleOffer rule={x} projectKey={projectKey} onChanged={onChanged} /></li>)}</ul>}
      {decided.length > 0 && (
        <>
          <h3 className="dw2-h3 dw2-h3--gap">Decided rules</h3>
          <ul className="dw2-quotes">
            {decided.map((x) => (
              <li key={x.id}>
                <blockquote>{x.text}</blockquote>
                <p className="dw2-cite">
                  <b className={x.state === 'accepted' ? 'dw2-ok' : ''}>{x.state === 'accepted' ? 'Accepted' : 'Declined'}</b> &middot; {LENS_LABELS[x.lens] ?? x.lens} &middot; {x.decided_by_name ?? 'A Jira user'}{x.decided_at && <> &middot; {formatDay(x.decided_at)}</>}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function RuleOffer({ rule, projectKey, onChanged }) {
  const [text, setText] = useState(rule.text);
  const [busy, setBusy] = useState(/** @type {'' | 'accepted' | 'declined'} */ (''));
  const [error, setError] = useState('');
  const id = `dw-rule-${rule.id}`;
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
    <article className="dw2-offer" aria-label={`Offered rule for ${LENS_LABELS[rule.lens] ?? rule.lens}`}>
      <p className="dw2-meta"><span className="dw2-meta__lens"><LensDot lens={rule.lens} />{LENS_LABELS[rule.lens] ?? rule.lens}</span><span className="dw2-muted">offered {formatDay(rule.offered_at)}</span></p>
      <label className="dw-visually-hidden" htmlFor={id}>Rule (edit before accepting)</label>
      <textarea id={id} className="dw2-statement" value={text} onChange={(e) => setText(e.target.value)} maxLength={500} rows={2} />
      {rule.titles && rule.titles.length > 0 && (
        <details className="dw2-fold">
          <summary>Triggered by {plural(rule.titles.length, 'item')}</summary>
          <ul className="dw2-plain">{rule.titles.map((t) => <li key={t}>{t}</li>)}</ul>
        </details>
      )}
      <div className="dw2-offer__actions">
        <Button appearance="primary" compact onClick={() => decide('accepted')} busy={busy === 'accepted'} disabled={!text.trim() || Boolean(busy)}>Accept rule</Button>
        <Button appearance="subtle" compact onClick={() => decide('declined')} busy={busy === 'declined'} disabled={Boolean(busy)}>Decline</Button>
        <span className="dw2-muted">You can edit the wording before accepting.</span>
      </div>
      {error && <p className="dw2-error" role="alert">{error}</p>}
    </article>
  );
}

// ---- did it land ---------------------------------------------------------------------------------------------

function Landed({ candidates, outcomes, projectKey, onChanged }) {
  return (
    <>
      {candidates.length === 0
        ? <p className="dw2-muted">Every accepted issue has been rated.</p>
        : <ul className="dw2-rules">{candidates.map((c) => <li key={c.ref}><Candidate cand={c} projectKey={projectKey} onChanged={onChanged} /></li>)}</ul>}
      {outcomes.length > 0 && (
        <>
          <h3 className="dw2-h3 dw2-h3--gap">Recorded outcomes</h3>
          <ul className="dw2-quotes">
            {outcomes.map((o) => (
              <li key={o.ref}>
                <p className="dw2-outcome"><span className={`dw2-rating dw2-rating--${o.rating}`}>{RATINGS.find((x) => x.code === o.rating)?.mark} {RATING_LABELS[o.rating] ?? o.rating}</span> <span className="dw2-mono">{o.ref}</span> {o.title} <span className="dw2-muted">{o.issue_ref}</span></p>
                {o.note && <blockquote>{o.note}</blockquote>}
                <p className="dw2-cite">{deciderName(o.decided_by, o.decided_by_name)} &middot; {formatShort(o.recorded_at)}</p>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function Candidate({ cand, projectKey, onChanged }) {
  void projectKey;
  const [rating, setRating] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const name = `dw-rate-${cand.ref}`;
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
    <article className="dw2-offer" aria-label={`Rate ${cand.ref}`}>
      <p className="dw2-meta">
        <span className="dw2-meta__ref">{cand.ref}</span>
        <a href={cand.issue_url} target="_blank" rel="noreferrer noopener">{cand.issue_ref}</a>
        <span className={cand.done ? 'dw2-ok' : 'dw2-muted'}>{cand.done && <span aria-hidden="true">&#10003; </span>}{cand.done ? 'Jira says Done' : cand.issue_status}</span>
      </p>
      <h3 className="dw2-title">{cand.title}</h3>
      <fieldset className="dw2-rate">
        <legend className="dw-visually-hidden">How did {cand.ref} turn out?</legend>
        {RATINGS.map((r) => (
          <label key={r.code} className={`dw2-rate__opt dw2-rate__opt--${r.code}`}>
            <input type="radio" name={name} value={r.code} checked={rating === r.code} onChange={() => setRating(r.code)} />
            <span><span aria-hidden="true">{r.mark} </span>{r.label}</span>
          </label>
        ))}
      </fieldset>
      <div className="dw2-offer__actions">
        <label className="dw-visually-hidden" htmlFor={`${name}-note`}>Note on {cand.ref} (optional)</label>
        <input id={`${name}-note`} className="dw-input dw2-rate__note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What happened? (optional)" maxLength={500} autoComplete="off" />
        <Button appearance="primary" compact onClick={record} disabled={!rating} busy={busy}>Record</Button>
      </div>
      {error && <p className="dw2-error" role="alert">{error}</p>}
    </article>
  );
}
