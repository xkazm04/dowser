// Settings: one row per inbox (project_key from the skill's repo origin) with its default Accept target,
// a Jira project + issue type. Accept uses it unless the person overrides it in the Accept dialog.
import React, { useState } from 'react';
import { call } from '../../api.js';
import { Button, ErrorState, SectionMessage, SkeletonList, useAsync } from '../../components/ui.jsx';
import { plural } from '../../components/labels.js';

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
        </section>
      )}
    </main>
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
