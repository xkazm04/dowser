// Settings: one row per inbox (project_key from the skill's repo origin) with its default Accept target,
// a Jira project + issue type. Accept uses it unless the person overrides it in the Accept dialog.
// Below it, Lens direction: per inbox, one disclosure per lens with what the lens should focus on, leave out,
// the team's notes and (Doc drift only) the Confluence spaces to search. The scan reads it when it starts
// (`dowser_direction_get`); `direction.get` / `direction.set` here.
import React, { useState } from 'react';
import { call } from '../../api.js';
import { Button, ErrorState, SectionMessage, SkeletonList, useAsync } from '../../components/ui.jsx';
import { LENSES, LENS_LABELS, plural } from '../../components/labels.js';
import { LensDot } from '../inbox/parts.jsx';
import './settings.css';

export default function Settings() {
  const data = useAsync(async () => {
    const [settings, jira] = await Promise.all([call('settings.get'), call('jira.projects')]);
    return { inboxes: settings.inboxes ?? [], projects: jira.projects ?? [] };
  }, []);

  return (
    <main className="dwr-page dwr-page--narrow">
      <header className="dwr-page__bar">
        <h1 className="dwr-page__h1">Settings</h1>
      </header>
      <p className="dwr-page__intro">
        Each inbox receives the proposals of one repository. Accept creates the Jira issue in the project and issue type
        set here; the Accept dialog can override it for one proposal.
      </p>
      {data.status === 'loading' && <SkeletonList count={2} label="Loading settings" />}
      {data.status === 'error' && <ErrorState what="Settings" error={data.error} onRetry={data.reload} />}
      {data.status === 'ready' && data.data.inboxes.length === 0 && (
        <SectionMessage title="No inbox yet." role="status">
          <p>An inbox appears when a scan first pushes proposals. Run <code>/dowser</code> in Claude Code or Codex, in the repository.</p>
        </SectionMessage>
      )}
      {data.status === 'ready' && data.data.inboxes.length > 0 && (
        <section className="dwr-secs" aria-labelledby="dw-set-h">
        <div className="dwr-sec">
        <h2 className="dwr-sec__h" id="dw-set-h">Accept target per inbox</h2>
        <div className="dw-scroll">
        <table className="dw-table dwr-settings">
          <thead>
            <tr><th scope="col">Inbox</th><th scope="col">Jira project</th><th scope="col">Issue type</th><th scope="col"><span className="dw-visually-hidden">Save</span></th></tr>
          </thead>
          <tbody>
            {data.data.inboxes.map((inbox) => (
              <InboxRow key={inbox.project_key} inbox={inbox} projects={data.data.projects} />
            ))}
          </tbody>
        </table>
        </div>
        </div>
        <div className="dwr-sec">
          <h2 className="dwr-sec__h" id="dw-dir-h">Lens direction</h2>
          <p className="dwr-sec__hint">
            Steer what each lens looks at. The next scan reads this when it starts; a runner&rsquo;s own focus applies on
            top for that one run.
          </p>
          {data.data.inboxes.map((inbox) => <DirectionInbox key={inbox.project_key} inbox={inbox} />)}
        </div>
        </section>
      )}
    </main>
  );
}

/** Lines of a textarea as a list: trimmed, empty lines dropped. */
const linesOf = (text) => text.split('\n').map((l) => l.trim()).filter(Boolean);
const textOf = (list) => (list ?? []).join('\n');

/** One line of what a lens has set, for the closed disclosure. */
function summaryOf(d) {
  if (!d) return 'Not set';
  const parts = [];
  if (d.focus) parts.push(`Focus: ${d.focus.join(', ')}`);
  if (d.exclude) parts.push(`Leave out: ${d.exclude.join(', ')}`);
  if (d.spaces) parts.push(`Spaces: ${d.spaces.join(', ')}`);
  if (d.notes) parts.push('Notes');
  return parts.join(' · ');
}

function DirectionInbox({ inbox }) {
  const data = useAsync(() => call('direction.get', { project_key: inbox.project_key }), [inbox.project_key]);
  const hid = `dw-dir-${inbox.project_key.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  return (
    <section className="dw-dir" aria-labelledby={hid}>
      <h3 className="dw-dir__inbox" id={hid}>{inbox.project_key}</h3>
      {data.status === 'loading' && <div className="dw-skel" style={{ height: 160 }} role="status" aria-label={`Loading direction for ${inbox.project_key}`} />}
      {data.status === 'error' && <ErrorState what="Lens direction" error={data.error} onRetry={data.reload} />}
      {data.status === 'ready' && (
        <div className="dw-dir__list">
          {LENSES.map((lens) => <LensEditor key={lens} inbox={inbox.project_key} lens={lens} initial={data.data.lenses?.[lens]} idBase={`${hid}-${lens}`} />)}
        </div>
      )}
    </section>
  );
}

function LensEditor({ inbox, lens, initial, idBase }) {
  const [saved, setSaved] = useState(initial);
  const [focus, setFocus] = useState(textOf(initial?.focus));
  const [exclude, setExclude] = useState(textOf(initial?.exclude));
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [spaces, setSpaces] = useState(textOf(initial?.spaces));
  const [state, setState] = useState(/** @type {'idle'|'saving'|'clearing'|'saved'|'cleared'|string} */ ('idle'));
  const withSpaces = lens === 'doc-drift';
  const draft = { focus: linesOf(focus), exclude: linesOf(exclude), notes: notes.trim(), spaces: withSpaces ? linesOf(spaces) : [] };
  const dirty = textOf(draft.focus) !== textOf(saved?.focus) || textOf(draft.exclude) !== textOf(saved?.exclude)
    || draft.notes !== (saved?.notes ?? '') || textOf(draft.spaces) !== textOf(saved?.spaces);
  const edit = (set) => (e) => { set(e.target.value); if (state !== 'saving' && state !== 'clearing') setState('idle'); };

  /** @param {boolean} clear */
  async function send(clear) {
    setState(clear ? 'clearing' : 'saving');
    try {
      const payload = clear ? {} : { focus: draft.focus, exclude: draft.exclude, notes: draft.notes, ...(withSpaces ? { spaces: draft.spaces } : {}) };
      const res = await call('direction.set', { project_key: inbox, lens, ...payload });
      const d = res.direction;
      setSaved(d);
      setFocus(textOf(d?.focus)); setExclude(textOf(d?.exclude)); setNotes(d?.notes ?? ''); setSpaces(textOf(d?.spaces));
      setState(d ? 'saved' : 'cleared');
    } catch (e) {
      setState(String(e?.message ?? 'The direction could not be saved.'));
    }
  }

  const busy = state === 'saving' || state === 'clearing';
  const failed = !busy && !['idle', 'saved', 'cleared'].includes(state);
  return (
    <details className="dw-dir__lens">
      <summary className="dw-dir__sum">
        <LensDot lens={lens} />
        <span className="dw-dir__name">{LENS_LABELS[lens]}</span>
        <span className={`dw-dir__set${saved ? '' : ' dw-dir__set--none'}`}>{summaryOf(saved)}</span>
      </summary>
      <div className="dw-dir__body">
        <div className="dw-dir__grid">
          <div className="dw-field">
            <label htmlFor={`${idBase}-f`}>Focus on</label>
            <textarea id={`${idBase}-f`} className="dw-textarea" rows={3} value={focus} onChange={edit(setFocus)} aria-describedby={`${idBase}-lh`} />
          </div>
          <div className="dw-field">
            <label htmlFor={`${idBase}-x`}>Leave out</label>
            <textarea id={`${idBase}-x`} className="dw-textarea" rows={3} value={exclude} onChange={edit(setExclude)} aria-describedby={`${idBase}-lh`} />
          </div>
        </div>
        <p className="dw-dir__hint" id={`${idBase}-lh`}>One topic per line, up to 10, each up to 120 characters.</p>
        <div className="dw-field">
          <label htmlFor={`${idBase}-n`}>Notes for the scan</label>
          <textarea id={`${idBase}-n`} className="dw-textarea" rows={2} maxLength={2000} value={notes} onChange={edit(setNotes)}
            placeholder="What the team is after with this lens, in a sentence or two" />
        </div>
        {withSpaces && (
          <div className="dw-field">
            <label htmlFor={`${idBase}-s`}>Confluence spaces to search</label>
            <textarea id={`${idBase}-s`} className="dw-textarea dw-dir__spaces" rows={2} value={spaces} onChange={edit(setSpaces)} aria-describedby={`${idBase}-sh`} />
            <span className="dw-dir__hint" id={`${idBase}-sh`}>One space key per line, up to 10. Leave empty to search every space.</span>
          </div>
        )}
        <div className="dw-dir__act">
          <Button appearance="primary" onClick={() => send(false)} disabled={!dirty || busy} busy={state === 'saving'}>Save</Button>
          {saved && <Button appearance="subtle" onClick={() => send(true)} disabled={busy} busy={state === 'clearing'}>Clear</Button>}
          <span aria-live="polite" className="dw-subtlest">
            {state === 'saved' && 'Saved.'}
            {state === 'cleared' && 'Cleared.'}
            {failed && <span role="alert" style={{ color: 'var(--ds-text-danger, #AE2E24)' }}>{state}</span>}
          </span>
        </div>
      </div>
    </details>
  );
}

function InboxRow({ inbox, projects }) {
  const [saved, setSaved] = useState(inbox);
  const [project, setProject] = useState(inbox.jira_project_key ?? '');
  const [issueType, setIssueType] = useState(inbox.issue_type_id ?? '');
  const [state, setState] = useState(/** @type {'idle'|'saving'|'saved'|string} */ ('idle'));
  const types = projects.find((p) => p.key === project)?.issue_types ?? [];
  const dirty = project !== (saved.jira_project_key ?? '') || issueType !== (saved.issue_type_id ?? '');
  const id = `dw-set-${inbox.project_key.replace(/[^A-Za-z0-9_-]/g, '_')}`;

  async function save() {
    setState('saving');
    try {
      const res = await call('settings.set', { project_key: inbox.project_key, jira_project_key: project, issue_type_id: issueType });
      setSaved(res.inbox ?? { ...saved, jira_project_key: project, issue_type_id: issueType });
      setState('saved');
    } catch (e) {
      setState(String(e?.message ?? 'The settings could not be saved.'));
    }
  }

  const failed = state !== 'idle' && state !== 'saving' && state !== 'saved';
  return (
    <tr>
      <td>
        <strong>{inbox.project_key}</strong>
        {saved.repo_url && <div className="dw-subtlest"><a href={saved.repo_url} target="_blank" rel="noreferrer noopener">{saved.repo_url}</a></div>}
        <div className="dw-subtlest">{plural(inbox.open ?? 0, 'open proposal')}</div>
      </td>
      <td>
        <label className="dw-visually-hidden" htmlFor={`${id}-p`}>Jira project for {inbox.project_key}</label>
        <select id={`${id}-p`} className="dw-select" value={project} onChange={(e) => { setProject(e.target.value); setIssueType(''); setState('idle'); }}>
          <option value="">Choose a project</option>
          {projects.map((p) => <option key={p.key} value={p.key}>{p.name} ({p.key})</option>)}
        </select>
      </td>
      <td>
        <label className="dw-visually-hidden" htmlFor={`${id}-t`}>Issue type for {inbox.project_key}</label>
        <select id={`${id}-t`} className="dw-select" value={issueType} onChange={(e) => { setIssueType(e.target.value); setState('idle'); }} disabled={!project}>
          <option value="">Choose an issue type</option>
          {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </td>
      <td>
        <Button appearance="primary" onClick={save} disabled={!dirty || !project || !issueType} busy={state === 'saving'}>Save</Button>
        <div aria-live="polite" className="dw-subtlest">
          {state === 'saved' && 'Saved.'}
          {failed && <span role="alert" style={{ color: 'var(--ds-text-danger, #AE2E24)' }}>{state}</span>}
        </div>
      </td>
    </tr>
  );
}
