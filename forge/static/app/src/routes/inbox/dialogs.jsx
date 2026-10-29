// Verdict dialogs of the inbox: Accept, Merge, Reject (single or bulk), the inline Snooze step and keyboard
// help. Accept and Merge run their resolver call themselves and report through onDone / onFailed (a failure stays
// visible in the dialog so the person can correct the input). Reject and Snooze only COLLECT the decision: the
// inbox sends them after the undo window (useCommitWindow).
import React, { useEffect, useMemo, useState } from 'react';
import { call } from '../../api.js';
import { Button, Dialog, SectionMessage, Spinner } from '../../components/ui.jsx';
import { DW_REF_RE, JIRA_KEY_RE, REASONS, issuePreview, plural } from '../../components/labels.js';
import { Markdown } from '../../components/Markdown.jsx';
import { Artifact } from '../../components/Artifact.jsx';

/**
 * Accept: target Jira project + issue type, pre-filled with the inbox default; preview of the issue.
 * @param {{card: any, onClose: () => void, onDone: (card: any) => void, onFailed: (ref: string, message: string) => void, onBeforeSubmit?: () => void}} props
 */
export function AcceptDialog({ card, onClose, onDone, onFailed, onBeforeSubmit }) {
  const [meta, setMeta] = useState(/** @type {{inbox?: any, projects?: any[], error?: string} | null} */ (null));
  const [project, setProject] = useState('');
  const [issueType, setIssueType] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    Promise.allSettled([call('settings.get'), call('jira.projects')]).then(([s, p]) => {
      if (!live) return;
      const inbox = s.status === 'fulfilled' ? (s.value.inboxes ?? []).find((i) => i.project_key === card.project_key) : undefined;
      const projects = p.status === 'fulfilled' ? (p.value.projects ?? []) : undefined;
      const failed = [s, p].find((r) => r.status === 'rejected');
      setMeta({ inbox, projects, error: failed ? String(failed.reason?.message ?? 'Jira projects could not load.') : undefined });
      if (inbox?.jira_project_key) setProject(inbox.jira_project_key);
      if (inbox?.issue_type_id) setIssueType(inbox.issue_type_id);
    });
    return () => { live = false; };
  }, [card.project_key]);

  const types = meta?.projects?.find((p) => p.key === project)?.issue_types ?? [];
  const preview = issuePreview(card);
  // With no project list (jira.projects failed) the server default is the only safe target.
  const hasDefault = Boolean(meta?.inbox?.jira_project_key && meta?.inbox?.issue_type_id);
  const canSubmit = meta && !busy && (meta.projects ? Boolean(project && issueType) : hasDefault);

  async function submit() {
    setBusy(true); setError('');
    onBeforeSubmit?.();
    /** @type {{ref: string, jira_project_key?: string, issue_type_id?: string, note?: string}} */
    const payload = { ref: card.ref };
    if (note.trim()) payload.note = note.trim();
    if (meta?.projects && project && issueType) { payload.jira_project_key = project; payload.issue_type_id = issueType; }
    try {
      const res = await call('verdict.accept', payload);
      onDone(res.card);
    } catch (e) {
      const msg = String(e?.message ?? 'The accept failed.');
      setError(msg); onFailed(card.ref, msg); setBusy(false);
    }
  }

  return (
    <Dialog
      title={`Accept ${card.ref}`}
      onClose={onClose}
      footer={<>
        <Button appearance="subtle" onClick={onClose}>Cancel</Button>
        <Button appearance="primary" onClick={submit} disabled={!canSubmit} busy={busy}>Create issue</Button>
      </>}
    >
      {!meta && <p><Spinner label="Loading Jira projects" /> Loading Jira projects…</p>}
      {meta?.error && (
        <SectionMessage appearance="warning">
          <p>{meta.error} {hasDefault ? 'Accepting uses the inbox default target.' : 'Set a default target in Settings, or retry.'}</p>
        </SectionMessage>
      )}
      {meta?.projects && (
        <>
          <div className="dw-field">
            <label htmlFor="dw-acc-project">Jira project</label>
            <select id="dw-acc-project" className="dw-select" value={project} onChange={(e) => { setProject(e.target.value); setIssueType(''); }}>
              <option value="">Choose a project</option>
              {meta.projects.map((p) => <option key={p.key} value={p.key}>{p.name} ({p.key})</option>)}
            </select>
            <span className="dw-subtlest">
              {meta.inbox?.jira_project_key
                ? `Filled in from this inbox's default (${meta.inbox.jira_project_key}). Change it for this issue here; change the default in Settings.`
                : 'This inbox has no default project yet. Set one in Settings so every accept starts there.'}
            </span>
          </div>
          <div className="dw-field">
            <label htmlFor="dw-acc-type">Issue type</label>
            <select id="dw-acc-type" className="dw-select" value={issueType} onChange={(e) => setIssueType(e.target.value)} disabled={!project}>
              <option value="">Choose an issue type</option>
              {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
        </>
      )}
      <div className="dw-field">
        <label htmlFor="dw-acc-note">What made this worth doing? (optional)</label>
        <textarea id="dw-acc-note" className="dw-textarea" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} aria-describedby="dw-acc-note-help" />
        <span id="dw-acc-note-help" className="dw-subtlest">Kept in the triage history. Dowser reads these notes to learn what you value.</span>
      </div>
      <div className="dw-field">
        <span className="dw-label">Issue preview</span>
        <div className="dw-preview" tabIndex={0} role="region" aria-label="Preview of the Jira issue">
          <div className="dw-preview__summary">{preview.summary}</div>
          <div className="dw-md"><p>{preview.rationale}</p></div>
          <Markdown source={preview.body} />
          {preview.artifacts && (
            <div className="dw-md dwr-arts--compact">
              <h4>Supporting views</h4>
              {preview.artifacts.map((a, i) => <Artifact key={i} artifact={a} />)}
            </div>
          )}
          <div className="dw-md">
            <h4>Evidence</h4>
            <ul>
              {preview.evidence.map((e, i) => (
                <li key={i}>{e.type}: <span className="dw-evidence__ref">{e.ref}</span>{e.quote && <> - &ldquo;{e.quote.replace(/\s+/g, ' ').trim().slice(0, 200)}&rdquo;</>}</li>
              ))}
            </ul>
            <p>Proposed by Dowser ({card.ref})</p>
          </div>
        </div>
      </div>
      {error && <SectionMessage appearance="error"><p>{error}</p></SectionMessage>}
    </Dialog>
  );
}

/**
 * Merge into another open/accepted item (by ref or title) or into a Jira issue key.
 * @param {{card: any, openCards: any[], onClose: () => void, onDone: (card: any) => void, onFailed: (ref: string, message: string) => void, onBeforeSubmit?: () => void}} props
 */
export function MergeDialog({ card, openCards, onClose, onDone, onFailed, onBeforeSubmit }) {
  const [accepted, setAccepted] = useState(/** @type {any[] | null} */ (null));
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState('');
  const [jiraKey, setJiraKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    call('inbox.list', { project_key: card.project_key, status: 'accepted' }).then(
      (res) => { if (live) setAccepted((res.groups ?? []).flatMap((g) => g.items ?? [])); },
      () => { if (live) setAccepted([]); },
    );
    return () => { live = false; };
  }, [card.project_key]);

  const candidates = useMemo(() => {
    const all = [...openCards.filter((c) => c.project_key === card.project_key), ...(accepted ?? [])]
      .filter((c, i, arr) => c.ref !== card.ref && arr.findIndex((o) => o.ref === c.ref) === i);
    const q = query.trim().toLowerCase();
    return q ? all.filter((c) => c.ref.toLowerCase().includes(q) || c.title.toLowerCase().includes(q)) : all;
  }, [openCards, accepted, query, card]);

  const key = jiraKey.trim().toUpperCase();
  const into = key || picked;
  const keyInvalid = Boolean(key) && !JIRA_KEY_RE.test(key) && !DW_REF_RE.test(key);

  async function submit() {
    setBusy(true); setError('');
    onBeforeSubmit?.();
    try {
      const res = await call('verdict.merge', { ref: card.ref, into });
      onDone(res.card);
    } catch (e) {
      const msg = String(e?.message ?? 'The merge failed.');
      setError(msg); onFailed(card.ref, msg); setBusy(false);
    }
  }

  return (
    <Dialog
      title={`Merge ${card.ref}`}
      onClose={onClose}
      footer={<>
        <Button appearance="subtle" onClick={onClose}>Cancel</Button>
        <Button appearance="primary" onClick={submit} disabled={!into || keyInvalid || busy} busy={busy}>Merge</Button>
      </>}
    >
      <p className="dw-subtle" style={{ marginTop: 0 }}>Merge only the same work: the same capability or defect in the same place.</p>
      <div className="dw-field">
        <label htmlFor="dw-merge-q">Find an open or accepted proposal</label>
        <input id="dw-merge-q" className="dw-input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="DW-12 or words from the title" autoComplete="off" />
      </div>
      <fieldset className="dw-radio-list" aria-label="Merge into" style={{ maxHeight: 200, overflow: 'auto' }} disabled={Boolean(key)}>
        {accepted === null && <span><Spinner label="Loading accepted proposals" /> Loading…</span>}
        {accepted !== null && candidates.length === 0 && <span className="dw-subtle">No matching proposal.</span>}
        {candidates.map((c) => (
          <label key={c.ref} className="dw-radio">
            <input type="radio" name="dw-merge-into" value={c.ref} checked={picked === c.ref} onChange={() => setPicked(c.ref)} />
            <span><span className="dw-subtlest">{c.ref} · {c.status}</span> {c.title}</span>
          </label>
        ))}
      </fieldset>
      <div className="dw-field">
        <label htmlFor="dw-merge-key">Or merge into a Jira issue</label>
        <input id="dw-merge-key" className="dw-input" value={jiraKey} onChange={(e) => setJiraKey(e.target.value)} placeholder="SHOP-123" autoComplete="off" aria-invalid={keyInvalid || undefined} aria-describedby="dw-merge-key-help" />
        <span id="dw-merge-key-help" className="dw-subtlest">{keyInvalid ? 'Type a Jira key such as SHOP-123.' : 'A typed key wins over the picked proposal.'}</span>
      </div>
      {error && <SectionMessage appearance="error"><p>{error}</p></SectionMessage>}
    </Dialog>
  );
}

/**
 * Reject one or many with one reason code; `other` needs a note.
 * The inbox sends the verdict after the undo window; this dialog only collects it.
 * @param {{cards: any[], onClose: () => void, onSubmit: (decision: {reason: string, note?: string}) => void}} props
 */
export function RejectDialog({ cards, onClose, onSubmit }) {
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const noteMissing = reason === 'other' && !note.trim();

  function submit() {
    /** @type {{reason: string, note?: string}} */
    const decision = { reason };
    if (note.trim()) decision.note = note.trim();
    onSubmit(decision);
  }

  return (
    <Dialog
      title={cards.length === 1 ? `Reject ${cards[0].ref}` : `Reject ${plural(cards.length, 'proposal')}`}
      onClose={onClose}
      footer={<>
        <Button appearance="subtle" onClick={onClose}>Cancel</Button>
        <Button appearance="danger" onClick={submit} disabled={!reason || noteMissing}>Reject</Button>
      </>}
    >
      <fieldset className="dw-radio-list">
        <legend className="dw-label" style={{ marginBottom: 6, fontSize: 12, fontWeight: 653 }}>Reason</legend>
        {REASONS.map((r) => (
          <label key={r.code} className="dw-radio">
            <input type="radio" name="dw-reason" value={r.code} checked={reason === r.code} onChange={() => setReason(r.code)} />
            <span><strong>{r.label}</strong> <span className="dw-subtle">{r.help}</span></span>
          </label>
        ))}
      </fieldset>
      <div className="dw-field">
        <label htmlFor="dw-reject-note">{reason === 'other' ? 'Note (required)' : 'Note (optional)'}</label>
        <textarea id="dw-reject-note" className="dw-textarea" value={note} onChange={(e) => setNote(e.target.value)} aria-invalid={noteMissing || undefined} required={reason === 'other'} />
        {noteMissing && <span className="dw-subtlest">A note is required for Other.</span>}
      </div>
      <p className="dw-subtlest">The reason teaches the next scan what to leave out. You get 6 seconds to undo.</p>
    </Dialog>
  );
}

const KEYS = [
  ['j / k', 'Move to the next / previous proposal'],
  ['x', 'Select or unselect the proposal'],
  ['a', 'Accept'],
  ['r', 'Reject (all selected, when some are selected)'],
  ['s', 'Snooze, with an optional note and Until date (all selected, when some are selected: one date, no note)'],
  ['m', 'Merge'],
  ['u', 'Undo the last snooze or reject while its notice is showing'],
  ['?', 'Show this help'],
];

export function HelpDialog({ onClose }) {
  return (
    <Dialog title="Keyboard shortcuts" onClose={onClose} footer={<Button appearance="primary" onClick={onClose} autoFocus>Close</Button>}>
      <table className="dw-table">
        <tbody>
          {KEYS.map(([k, what]) => <tr key={k}><td><span className="dw-kbd">{k}</span></td><td>{what}</td></tr>)}
        </tbody>
      </table>
      <p className="dw-subtlest">Shortcuts work when no dialog or text field has focus.</p>
    </Dialog>
  );
}

/**
 * A local calendar day as `YYYY-MM-DD`, `days` after today (the person's own date, as a date input shows it).
 * @param {number} [days]
 */
function localDay(days = 0) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * The inline step before a snooze: an optional "revisit when / why not now" note and an optional "Until" date
 * (after today). Enter or the Snooze button snoozes; Escape or Cancel closes it. The bulk bar uses it with
 * `withNote={false}` (one date for every checked item, no note) and `label` naming the count.
 * @param {{cardRef: string, label?: string, withNote?: boolean, onSubmit: (note: string, until: string) => void, onCancel: () => void}} props
 */
export function SnoozeStep({ cardRef, label = cardRef, withNote = true, onSubmit, onCancel }) {
  const [note, setNote] = useState('');
  const [until, setUntil] = useState('');
  const [error, setError] = useState('');
  const id = `dw-snz-${cardRef}`;
  const tomorrow = localDay(1);
  function submit() {
    if (until && !(/^\d{4}-\d{2}-\d{2}$/.test(until) && until >= tomorrow)) {
      setError('Choose a date after today, or clear it.');
      return;
    }
    onSubmit(note.trim(), until);
  }
  return (
    <form
      className="dw-step" aria-label={`Snooze ${label}`}
      onSubmit={(e) => { e.preventDefault(); submit(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }}
    >
      {withNote && <label htmlFor={id}>Revisit when / why not now? (optional)</label>}
      {withNote && <input id={id} className="dw-input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} autoComplete="off" autoFocus placeholder="e.g. after the checkout rewrite" />}
      <label htmlFor={`${id}-until`}>Until (optional)</label>
      <input
        id={`${id}-until`} className="dw-input" type="date" value={until} min={tomorrow} autoFocus={!withNote}
        onChange={(e) => { setUntil(e.target.value); setError(''); }}
        aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-err` : undefined}
      />
      {error && <span id={`${id}-err`} role="alert" style={{ color: 'var(--ds-text-danger, #AE2E24)' }}>{error}</span>}
      <div className="dw-row">
        <Button type="submit" appearance="primary" compact>Snooze</Button>
        <Button appearance="subtle" compact onClick={onCancel}>Cancel</Button>
        <span className="dw-subtlest">{until ? 'It comes back at the first scan on or after that day, or earlier when its evidence grows.' : 'It comes back when its evidence grows.'}</span>
      </div>
    </form>
  );
}
