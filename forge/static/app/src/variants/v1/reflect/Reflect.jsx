// The Learning tab (page route `reflect`): what the scans and the decisions teach. One resolver, `reflect.data`,
// feeds five sections; each shows its own loading / empty / error state. (a) scan retro, (b) why we say no,
// (c) rules Dowser is offering, (d) did it land, and a lens yield strip on top. Rule decisions and outcome
// ratings are written back through `rule.decide` and `outcome.record`, then the data is refreshed in place.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { call } from '../../../api.js';
import { Button, ErrorState, Lozenge, SectionMessage, useAsync } from '../../../components/ui.jsx';
import { LensBadge } from '../../../components/ProposalCard.jsx';
import { EmptyArt } from '../../../components/Brand.jsx';
import { Header } from '../Header.jsx';
import { shortDate } from '../fmt.js';
import {
  LENS_LABELS, RATINGS, RATING_APPEARANCE, RATING_LABELS, REASON_LABELS, STATUS_APPEARANCE, STATUS_LABELS,
  deciderName, formatDate, formatDay, plural,
} from '../../../components/labels.js';
import { BarTrend, HBars, StackedBar } from '../../../routes/reflect/charts.jsx';

/** Load `reflect.data` for one inbox; `refresh` re-reads without blanking what is on screen. */
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
    <main className="dw-root dw-root--wide dw1-root">
      <Header
        context={context} active="reflect" title="Learning" inboxes={inboxes.status === 'ready' ? inboxes.data : undefined}
        projectKey={projectKey} onProjectChange={setProjectKey}
      />
      <p className="dw1-intro">
        What the scans found, what you decided and why, and whether the accepted work turned out to be the right call.
        Dowser reads this back at the next scan.
      </p>
      {inboxes.status === 'loading' && <div className="dw-skel dw-skel-card" role="status" aria-label="Loading the inboxes" />}
      {inboxes.status === 'error' && <ErrorState what="The inbox list" error={inboxes.error} onRetry={inboxes.reload} />}
      {inboxes.status === 'ready' && inboxes.data.length === 0 && (
        <section className="dw-empty" role="status">
          <EmptyArt />
          <h2 className="dw-h2">Nothing to learn from yet.</h2>
          <p>An inbox appears when a scan first pushes proposals. Run <code>/dowser</code> in Claude Code or Codex, in the repository.</p>
        </section>
      )}
      {projectKey && <ReflectBody key={projectKey} projectKey={projectKey} />}
    </main>
  );
}

function ReflectBody({ projectKey }) {
  const r = useReflect(projectKey);
  const d = r.data;
  return (
    <>
      <Section id="yield" title="Lens yield" hint="Proposed vs accepted, per lens." r={r} empty={!d || (d.lens_yield ?? []).length === 0} emptyText="No proposals yet, so no lens has a yield.">
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
    <section className="dw1-sec" aria-labelledby={`dw-rf-${id}`}>
      <div className="dw1-sec__head">
        <h2 className="dw1-sec__title" id={`dw-rf-${id}`}>{title}</h2>
        <p className="dw1-sec__hint">{hint}</p>
      </div>
      {r.status === 'loading' && (
        <div role="status" aria-label={`Loading ${title}`} aria-busy="true">
          <div className="dw-skel" style={{ height: 14, width: '40%', marginBottom: 8 }} />
          <div className="dw-skel dw-skel-card" />
        </div>
      )}
      {r.status === 'error' && <ErrorState what={title} error={r.error} onRetry={r.reload} />}
      {r.status === 'ready' && (empty
        ? <SectionMessage role="status"><p>{emptyText}</p></SectionMessage>
        : children)}
    </section>
  );
}

// ---- (e) lens yield ------------------------------------------------------------------------------------------

function YieldStrip({ rows }) {
  return (
    <table className="dw1-yield">
      <thead>
        <tr><th scope="col">Lens</th><th scope="col"><span className="dw-visually-hidden">Share accepted</span></th><th scope="col" className="dw1-num">Accepted</th><th scope="col" className="dw1-num">Proposed</th><th scope="col" className="dw1-num">Rate</th></tr>
      </thead>
      <tbody>
        {rows.map((y) => {
          const share = y.proposed > 0 ? y.accepted / y.proposed : 0;
          return (
            <tr key={y.lens}>
              <th scope="row"><LensBadge lens={y.lens} /></th>
              <td className="dw1-yield__bar"><span className="dw1-track" aria-hidden="true"><span className="dw1-fill" style={{ width: `${Math.round(share * 100)}%` }} /></span></td>
              <td className="dw1-num">{y.accepted}</td>
              <td className="dw1-num">{y.proposed}</td>
              <td className="dw1-num">{y.proposed > 0 ? `${Math.round(share * 100)}%` : 'n/a'}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ---- (a) scan retro ------------------------------------------------------------------------------------------

/** The duplicate rate in plain words. dup_rate = updated / (created + updated). */
export function readDupRate(push) {
  if (push.dup_rate === undefined) return 'This push carried no proposals, so there is no repeat rate to read.';
  const pct = Math.round(push.dup_rate * 100);
  if (push.dup_rate >= 0.6) return `${pct}% of this push re-found proposals you already had. The scan is mostly confirming, not discovering: a narrower lens set or a longer gap between scans would surface more that is new.`;
  if (push.dup_rate <= 0.2) return `Only ${pct}% of this push was already known. Almost everything it found was new to the inbox.`;
  return `${pct}% of this push re-found known proposals; the rest was new.`;
}

const acceptedShare = (p) => {
  const total = p.open + p.accepted + p.rejected + p.snoozed;
  return total > 0 ? p.accepted / total : undefined;
};

function Retro({ pushes }) {
  const [latest, ...older] = pushes;
  const chrono = [...pushes].reverse();
  const trendDup = chrono.map((p) => ({ label: formatDay(p.at).replace(/ \d{4}$/, ''), value: p.dup_rate }));
  const trendAcc = chrono.map((p) => ({ label: formatDay(p.at).replace(/ \d{4}$/, ''), value: acceptedShare(p) }));
  return (
    <>
      <article aria-label="Latest push">
        <h3 className="dw1-h3" title={[latest.head_sha && `commit ${latest.head_sha.slice(0, 7)}`, `run ${latest.run_id}`].filter(Boolean).join(', ')}>Latest push, {shortDate(latest.at)}</h3>
        <dl className="dw1-metrics">
          <div><dd>{latest.created}</dd><dt>created</dt></div>
          <div><dd>{latest.updated}</dd><dt>updated (already known)</dt></div>
          <div><dd>{latest.dup_rate === undefined ? 'n/a' : `${Math.round(latest.dup_rate * 100)}%`}</dd><dt>repeat rate</dt></div>
        </dl>
        <p className="dw1-reading">{readDupRate(latest)}</p>
        <h4 className="dw1-h4">Decisions so far</h4>
        <StackedBar label="Decisions on the items of the latest push" values={latest} />
      </article>

      <h3 className="dw1-h3 dw1-h3--gap">Trend{older.length > 0 ? ` over the last ${plural(pushes.length, 'push', 'pushes')}` : ''}</h3>
      {older.length === 0
        ? <p className="dw-subtle">The trend appears after a second push.</p>
        : (
          <>
            <div className="dw-trends">
              <BarTrend title="Repeat rate (lower means more that is new)" points={trendDup} variant="dup" idPrefix="dup" />
              <BarTrend title="Accepted share of the push's items" points={trendAcc} variant="accepted" idPrefix="acc" />
            </div>
            <details className="dw-details">
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

// ---- (b) why we say no ---------------------------------------------------------------------------------------

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
        ? <p className="dw-subtle">No rejects yet.</p>
        : (
          <>
            <div className="dw-nogrid">
              {lenses.map((l) => (
                <div key={l.lens} className="dw-nocard">
                  <div className="dw-row"><LensBadge lens={l.lens} /><span className="dw-subtlest">{plural(l.total, 'reject')}</span></div>
                  <HBars rows={l.rows} max={max} />
                </div>
              ))}
            </div>
            <details className="dw-details">
              <summary>View the rejects as a table</summary>
              <table className="dw-table">
                <thead><tr><th scope="col">Lens</th><th scope="col">Reason</th><th scope="col">Rejects</th></tr></thead>
                <tbody>{rejects.map((x) => <tr key={`${x.lens}:${x.reason}`}><td>{LENS_LABELS[x.lens] ?? x.lens}</td><td>{REASON_LABELS[x.reason] ?? x.reason}</td><td>{x.count}</td></tr>)}</tbody>
              </table>
            </details>
          </>
        )}
      <h3 className="dw1-h3 dw1-h3--gap">Latest decision notes</h3>
      {notes.length === 0
        ? <p className="dw-subtle">No decision has a note yet. Notes on accept, snooze and reject show here.</p>
        : (
          <ul className="dw-notes">
            {notes.map((n) => (
              <li key={`${n.ref}:${n.decided_at}`}>
                <div className="dw-row" style={{ gap: 6 }}>
                  <span className="dw-card__ref">{n.ref}</span>
                  <Lozenge appearance={STATUS_APPEARANCE[n.status] ?? 'default'}>{STATUS_LABELS[n.status] ?? n.status}</Lozenge>
                  <strong>{n.title}</strong>
                </div>
                <div className="dw-note">{n.note}</div>
                <div className="dw-subtlest">{n.decided_by_name ?? 'A Jira user'} · {formatDate(n.decided_at)}</div>
              </li>
            ))}
          </ul>
        )}
    </>
  );
}

// ---- (c) rules ----------------------------------------------------------------------------------------------

function Rules({ rules, projectKey, onChanged }) {
  const offered = rules.filter((x) => x.state === 'offered');
  const decided = rules.filter((x) => x.state !== 'offered');
  return (
    <>
      {offered.length === 0
        ? <p className="dw-subtle">No rule is waiting for your answer.</p>
        : <ul className="dw-rules">{offered.map((x) => <li key={x.id}><RuleOffer rule={x} projectKey={projectKey} onChanged={onChanged} /></li>)}</ul>}
      {decided.length > 0 && (
        <>
          <h3 className="dw1-h3 dw1-h3--gap">Decided rules</h3>
          <ul className="dw-notes">
            {decided.map((x) => (
              <li key={x.id}>
                <div className="dw-row" style={{ gap: 6 }}>
                  <Lozenge appearance={x.state === 'accepted' ? 'success' : 'default'}>{x.state === 'accepted' ? 'Accepted' : 'Declined'}</Lozenge>
                  <LensBadge lens={x.lens} />
                </div>
                <p style={{ margin: '4px 0 2px' }}>{x.text}</p>
                <div className="dw-subtlest">{x.decided_by_name ?? 'A Jira user'}{x.decided_at && <> · {formatDate(x.decided_at)}</>}</div>
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
    <article className="dw-rulecard" aria-label={`Offered rule for ${LENS_LABELS[rule.lens] ?? rule.lens}`}>
      <div className="dw-row"><LensBadge lens={rule.lens} /><span className="dw-subtlest">offered {formatDay(rule.offered_at)}</span></div>
      <div className="dw-field" style={{ margin: '8px 0' }}>
        <label htmlFor={id}>Rule (edit before accepting)</label>
        <textarea id={id} className="dw-textarea" value={text} onChange={(e) => setText(e.target.value)} maxLength={500} />
      </div>
      {rule.titles && rule.titles.length > 0 && (
        <details className="dw-details">
          <summary>Triggered by {plural(rule.titles.length, 'item')}</summary>
          <ul className="dw-triggers">{rule.titles.map((t) => <li key={t}>{t}</li>)}</ul>
        </details>
      )}
      <div className="dw-card__actions">
        <Button appearance="primary" compact onClick={() => decide('accepted')} busy={busy === 'accepted'} disabled={!text.trim() || Boolean(busy)}>Accept rule</Button>
        <Button compact onClick={() => decide('declined')} busy={busy === 'declined'} disabled={Boolean(busy)}>Decline</Button>
      </div>
      {error && <SectionMessage appearance="error"><p>{error}</p></SectionMessage>}
    </article>
  );
}

// ---- (d) did it land ----------------------------------------------------------------------------------------

function Landed({ candidates, outcomes, projectKey, onChanged }) {
  return (
    <>
      {candidates.length === 0
        ? <p className="dw-subtle">Every accepted issue has been rated.</p>
        : <ul className="dw-rules">{candidates.map((c) => <li key={c.ref}><Candidate cand={c} projectKey={projectKey} onChanged={onChanged} /></li>)}</ul>}
      {outcomes.length > 0 && (
        <>
          <h3 className="dw1-h3 dw1-h3--gap">Recorded outcomes</h3>
          <ul className="dw-notes">
            {outcomes.map((o) => (
              <li key={o.ref}>
                <div className="dw-row" style={{ gap: 6 }}>
                  <Lozenge appearance={RATING_APPEARANCE[o.rating] ?? 'default'}>{RATINGS.find((x) => x.code === o.rating)?.mark} {RATING_LABELS[o.rating] ?? o.rating}</Lozenge>
                  <span className="dw-card__ref">{o.ref}</span>
                  <strong>{o.title}</strong>
                  <span className="dw-subtlest">{o.issue_ref}</span>
                </div>
                {o.note && <div className="dw-note">{o.note}</div>}
                <div className="dw-subtlest">{deciderName(o.decided_by, o.decided_by_name)} · {formatDate(o.recorded_at)}</div>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function Candidate({ cand, projectKey, onChanged }) {
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
    <article className={`dw-rulecard${cand.done ? ' dw-rulecard--done' : ''}`} aria-label={`Rate ${cand.ref}`}>
      <div className="dw-row" style={{ gap: 6 }}>
        <span className="dw-card__ref">{cand.ref}</span>
        <a href={cand.issue_url} target="_blank" rel="noreferrer noopener">{cand.issue_ref}</a>
        <Lozenge appearance={cand.done ? 'success' : 'inprogress'}>{cand.issue_status}</Lozenge>
        {cand.done && <span className="dw-doneCue"><span aria-hidden="true">&#10003; </span>Jira says Done</span>}
      </div>
      <h3 className="dw-card__title" style={{ margin: '4px 0 8px' }}>{cand.title}</h3>
      <fieldset className="dw-rate">
        <legend className="dw-visually-hidden">How did {cand.ref} turn out?</legend>
        {RATINGS.map((r) => (
          <label key={r.code} className={`dw-rate__opt dw-rate__opt--${r.code}`}>
            <input type="radio" name={name} value={r.code} checked={rating === r.code} onChange={() => setRating(r.code)} />
            <span><span aria-hidden="true">{r.mark} </span>{r.label}</span>
          </label>
        ))}
      </fieldset>
      <div className="dw-row" style={{ marginTop: 8 }}>
        <label className="dw-visually-hidden" htmlFor={`${name}-note`}>Note on {cand.ref} (optional)</label>
        <input id={`${name}-note`} className="dw-input dw-rate__note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What happened? (optional)" maxLength={500} autoComplete="off" />
        <Button appearance="primary" compact onClick={record} disabled={!rating} busy={busy}>Record</Button>
      </div>
      {error && <SectionMessage appearance="error"><p>{error}</p></SectionMessage>}
    </article>
  );
}
