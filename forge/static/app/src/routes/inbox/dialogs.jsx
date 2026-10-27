// Verdict dialogs of the inbox: Accept, Merge, Reject (single or bulk) and keyboard help. Each dialog runs
// its resolver call itself and reports the result through onDone / onFailed; a failure stays visible in the
// dialog so the person can correct the input.
import React, { useEffect, useMemo, useState } from 'react';
import { call } from '../../api.js';
import { Button, Dialog, SectionMessage, Spinner } from '../../components/ui.jsx';
import { DW_REF_RE, JIRA_KEY_RE, REASONS, issuePreview, plural } from '../../components/labels.js';

/**
 * Accept: target Jira project + issue type, pre-filled with the inbox default; preview of the issue.
 * @param {{card: any, onClose: () => void, onDone: (card: any) => void, onFailed: (ref: string, message: string) => void}} props
 */
export function AcceptDialog({ card, onClose, onDone, onFailed }) {
  const [meta, setMeta] = useState(/** @type {{inbox?: any, projects?: any[], error?: string} | null} */ (null));
  const [project, setProject] = useState('');
  const [issueType, setIssueType] = useState('');
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
    /** @type {{ref: string, jira_project_key?: string, issue_type_id?: string}} */
    const payload = { ref: card.ref };
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
        <span className="dw-label">Summary</span>
        <span>{preview.summary}</span>
      </div>
      <div className="dw-field">
        <span className="dw-label">Description (preview)</span>
        <pre className="dw-code" style={{ maxHeight: 220, overflow: 'auto' }}>{preview.description}</pre>
      </div>
      {error && <SectionMessage appearance="error"><p>{error}</p></SectionMessage>}
    </Dialog>
  );
}

/**
 * Merge into another open/accepted item (by ref or title) or into a Jira issue key.
 * @param {{card: any, openCards: any[], onClose: () => void, onDone: (card: any) => void, onFailed: (ref: string, message: string) => void}} props
 */
export function MergeDialog({ card, openCards, onClose, onDone, onFailed }) {
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
 * @param {{cards: any[], onClose: () => void, onDone: (cards: any[]) => void, onFailed: (refs: string[], message: string) => void}} props
 */
export function RejectDialog({ cards, onClose, onDone, onFailed }) {
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const noteMissing = reason === 'other' && !note.trim();
  const refs = cards.map((c) => c.ref);

  async function submit() {
    setBusy(true); setError('');
    /** @type {{refs: string[], reason: string, note?: string}} */
    const payload = { refs, reason };
    if (note.trim()) payload.note = note.trim();
    try {
      const res = await call('verdict.reject', payload);
      onDone(res.cards ?? []);
    } catch (e) {
      const msg = String(e?.message ?? 'The reject failed.');
      setError(msg); onFailed(refs, msg); setBusy(false);
    }
  }

  return (
    <Dialog
      title={cards.length === 1 ? `Reject ${cards[0].ref}` : `Reject ${plural(cards.length, 'proposal')}`}
      onClose={onClose}
      footer={<>
        <Button appearance="subtle" onClick={onClose}>Cancel</Button>
        <Button appearance="danger" onClick={submit} disabled={!reason || noteMissing || busy} busy={busy}>Reject</Button>
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
      <p className="dw-subtlest">The reason teaches the next scan what to leave out.</p>
      {error && <SectionMessage appearance="error"><p>{error}</p></SectionMessage>}
    </Dialog>
  );
}

const KEYS = [
  ['j / k', 'Move to the next / previous proposal'],
  ['x', 'Select or unselect the proposal'],
  ['a', 'Accept'],
  ['r', 'Reject (all selected, when some are selected)'],
  ['s', 'Snooze (all selected, when some are selected)'],
  ['m', 'Merge'],
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
