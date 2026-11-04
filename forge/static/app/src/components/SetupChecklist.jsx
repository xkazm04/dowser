// How to connect a coding agent to Dowser, and whether one is connected (`setup.status`). Dowser cannot see the
// admin's "Enable tools" switch, so the only honest signal is a tool call that reached the app: the status line
// turns green after the first one, and says so while there is none. Shown on the inbox's first-run panel and in
// Settings ("Connect a coding agent").
import React from 'react';
import { call } from '../api.js';
import { ErrorState, Spinner, useAsync } from './ui.jsx';
import { plural, relativeTime } from './labels.js';

/** The admin path to the Dowser tools switch (docs/forge-app.md). */
const ADMIN_PATH = ['admin.atlassian.com', 'your organization', 'Apps', 'Sites', 'your site', 'Connected apps', 'Dowser',
  'View app details', 'Details', 'Tools', 'Enable tools'];

/**
 * @param {{headingLevel?: 3 | 4}} props  the level of each step's heading (3 under a page section, 4 inside a card).
 */
export function SetupChecklist({ headingLevel = 4 }) {
  const data = useAsync(() => call('setup.status'), []);
  const H = /** @type {'h3' | 'h4'} */ (`h${headingLevel}`);
  if (data.status === 'loading') return <p className="dw-setup__loading"><Spinner label="Loading the setup status" /> Checking whether an agent has reached Dowser...</p>;
  if (data.status === 'error') return <ErrorState what="The setup status" error={data.error} onRetry={data.reload} />;
  const s = data.data ?? {};
  const calls = Number(s.tools?.calls ?? 0);
  return (
    <ol className="dw-setup">
      <li className="dw-setup__step">
        <H className="dw-setup__h">A site admin enables the Dowser tools</H>
        <p className="dw-setup__path">
          {ADMIN_PATH.map((p, i) => <React.Fragment key={p}>{i > 0 && <span className="dw-setup__sep" aria-label="then"> &gt; </span>}<span>{p}</span></React.Fragment>)}
        </p>
      </li>
      <li className="dw-setup__step">
        <H className="dw-setup__h">Add the MCP server to your agent</H>
        {s.mcp_url
          ? <>
              <p>In Claude Code:</p>
              <pre className="dwr-code" tabIndex={0} aria-label="Command to add the Dowser MCP server">claude mcp add --transport http dowser {s.mcp_url}</pre>
            </>
          : <p>The MCP server address is not known here; see the app listing.</p>}
      </li>
      <li className="dw-setup__step">
        <H className="dw-setup__h">Your agent reaches Dowser</H>
        {calls > 0
          ? (
            <p className="dw-setup__status dw-setup__status--ok" role="status">
              <span className="dw-setup__icon" aria-hidden="true">✓</span>
              <span>
                {plural(calls, 'tool call')} {calls === 1 ? 'has' : 'have'} reached Dowser
                {s.tools?.last_at && <>, the last {relativeTime(s.tools.last_at)}</>}
                {s.tools?.last_tool && <> (<code>{s.tools.last_tool}</code>)</>}.
              </span>
            </p>
          )
          : (
            <p className="dw-setup__status" role="status">
              <span className="dw-setup__icon dw-setup__icon--wait" aria-hidden="true" />
              <span>
                No tool call has reached Dowser yet. Dowser cannot see the admin switch; this turns green after your
                agent&rsquo;s first call.
              </span>
            </p>
          )}
      </li>
    </ol>
  );
}
