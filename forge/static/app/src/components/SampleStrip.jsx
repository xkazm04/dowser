// The sample inbox's marker. The sample is a real Dowser scan of Dowser's own public repository, stored next to real
// inboxes, so every surface that shows it says so (registry demo-data-plane: a persistent marker that survives a
// cropped screenshot, never auto-entered, counts are its own). The server owns the predicate: an inbox summary and a
// card carry `sample: true`; nothing here derives it from the key.
// The strip sits under the toolbar on the inbox, the Opportunity map and Learning whenever the sample is the selected
// inbox. It names the scanned commit, says Accept creates real issues, points to Settings while the sample has no
// Jira project, and removes the sample (confirm -> `sample.remove` -> a toast -> the page reloads).
import React, { useState } from 'react';
import { router } from '@forge/bridge';
import { call } from '../api.js';
import { Button, Dialog, Lozenge, SectionMessage } from './ui.jsx';
import { formatDay, plural } from './labels.js';
import { pageUrl } from './deeplink.js';
import { safeHref } from '../safeHref.js';

/** The sample's name in an inbox picker. */
export const SAMPLE_NAME = 'Sample - Dowser self-scan';

/**
 * An inbox's option text in a picker: the repository's last path segment, or the sample's name.
 * @param {{project_key: string, sample?: boolean}} inbox @param {number} open
 */
export function inboxOption(inbox, open) {
  return `${inbox.sample ? SAMPLE_NAME : inbox.project_key.split('/').pop()} (${open} open)`;
}

/**
 * The sample inbox the page shows, if it shows only the sample: the selected inbox, or (no inbox selected) the only
 * inbox there is. Undefined otherwise.
 * @param {any[]} inboxes @param {string} projectKey
 */
export function sampleShown(inboxes, projectKey) {
  const list = inboxes ?? [];
  if (projectKey) { const i = list.find((x) => x.project_key === projectKey); return i?.sample ? i : undefined; }
  return list.length > 0 && list.every((x) => x.sample) ? list[0] : undefined;
}

/**
 * The inbox a page opens on by itself: the one with the most open proposals, a real inbox before the sample (the
 * sample is never entered on its own while a real inbox exists).
 * @param {any[]} list @returns {string}
 */
export function defaultInbox(list) {
  const pick = [...(list ?? [])].sort((a, b) => (a.sample ? 1 : 0) - (b.sample ? 1 : 0) || (b.open ?? 0) - (a.open ?? 0))[0];
  return pick ? pick.project_key : '';
}

/** The card chip: a card from the sample inbox. */
export function SampleChip() {
  return <span title="Sample data: from a real Dowser scan of its own public repository"><Lozenge appearance="sample">Sample</Lozenge></span>;
}

/**
 * @param {{
 *   inbox: {project_key: string, sample?: boolean, jira_project_key?: string, source?: {repo_url?: string, head_sha?: string, scanned_at?: string}},
 *   context: any,
 *   notify: (message: string, kind?: 'info' | 'error') => void,
 *   onRemoved: () => void,
 *   onBeforeRemove?: () => void,
 * }} props
 *   `context` is the Forge context (the Settings link is built from its location); `notify` shows the toast after the
 *   removal; `onRemoved` reloads the page; `onBeforeRemove` commits pending undo windows first (the inbox).
 */
export function SampleStrip({ inbox, context, notify, onRemoved, onBeforeRemove }) {
  const [confirm, setConfirm] = useState(false);
  const [state, setState] = useState(/** @type {'idle'|'removing'|string} */ ('idle'));
  const src = inbox.source ?? {};
  const sha = src.head_sha ? src.head_sha.slice(0, 7) : '';
  const commitHref = sha && src.repo_url ? safeHref(`${src.repo_url.replace(/\/+$/, '')}/commit/${src.head_sha}`) : undefined;
  const settings = pageUrl(context?.extension?.location, 'settings');

  async function remove() {
    setState('removing');
    try {
      onBeforeRemove?.();
      const res = await call('sample.remove');
      const kept = Number(res?.issues_kept ?? 0);
      setConfirm(false);
      setState('idle');
      notify(`Sample removed.${kept > 0 ? ` ${plural(kept, 'Jira issue')} ${kept === 1 ? 'was' : 'were'} kept.` : ''}`);
      onRemoved();
    } catch (e) {
      setState(String(e?.message ?? 'The sample could not be removed.'));
    }
  }

  const removing = state === 'removing';
  const failed = state !== 'idle' && !removing;
  const bits = [sha && (commitHref ? <a key="c" href={commitHref} target="_blank" rel="noreferrer noopener">commit {sha}</a> : `commit ${sha}`), src.scanned_at && formatDay(src.scanned_at)].filter(Boolean);
  return (
    <aside className="dw-sample" aria-label="Sample data">
      <span className="dw-sample__tag">Sample data</span>
      <p className="dw-sample__text">
        A real Dowser scan of its own public repository
        {bits.length > 0 && <> ({bits.map((b, i) => <React.Fragment key={i}>{i > 0 && ', '}{b}</React.Fragment>)})</>}.
        {' '}Accept creates real Jira issues labelled <code>dowser-sample</code>.
      </p>
      <span className="dw-sample__act">
        {!inbox.jira_project_key && settings && (
          <a href={settings} className="dw-sample__link" onClick={(e) => { e.preventDefault(); router.navigate(settings).catch(() => {}); }}>Choose a Jira project</a>
        )}
        <Button compact appearance="subtle" className="dw-sample__remove" onClick={() => { setState('idle'); setConfirm(true); }}>Remove sample data</Button>
      </span>
      {confirm && (
        <Dialog
          title="Remove the sample?"
          onClose={() => { if (!removing) setConfirm(false); }}
          footer={(
            <>
              <Button onClick={() => setConfirm(false)} disabled={removing} autoFocus>Cancel</Button>
              <Button appearance="danger" onClick={remove} busy={removing}>Remove sample data</Button>
            </>
          )}
        >
          <p>Remove the sample inbox and all its decisions? Jira issues you created from it stay in Jira.</p>
          {failed && <SectionMessage appearance="error" title="The sample was not removed."><p>{state}</p></SectionMessage>}
        </Dialog>
      )}
    </aside>
  );
}
