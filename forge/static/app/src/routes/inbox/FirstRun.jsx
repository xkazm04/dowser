// The inbox on a site with no inbox at all: a first-run panel, not the "all decided" empty state (which is false for
// someone who never had an inbox). Three ways in: load the sample (a real Dowser scan of Dowser's own public
// repository, through `sample.load`), connect a coding agent (SetupChecklist), or scan your own repository.
// The sample is never loaded on its own: only the button loads it.
import React, { useState } from 'react';
import { call } from '../../api.js';
import { Button, SectionMessage } from '../../components/ui.jsx';
import { Mark } from '../../components/Brand.jsx';
import { SetupChecklist } from '../../components/SetupChecklist.jsx';

/**
 * @param {{onLoaded: (projectKey: string) => void}} props
 *   `onLoaded` gets the sample's project_key once `sample.load` answered; the page selects that inbox and reloads.
 */
export function FirstRun({ onLoaded }) {
  const [state, setState] = useState(/** @type {{status: 'idle'|'loading'|'error', error?: any}} */ ({ status: 'idle' }));

  async function load() {
    setState({ status: 'loading' });
    try {
      // The load runs in budgeted steps (Forge's resolver time limit): call again while it answers `more`.
      let res = await call('sample.load');
      for (let i = 0; res?.more && i < 20; i++) res = await call('sample.load');
      if (res?.more) throw new Error('The sample is still loading. Press Retry to finish it.');
      setState({ status: 'idle' });
      onLoaded(String(res?.project_key ?? 'dowser-sample'));
    } catch (error) {
      setState({ status: 'error', error });
    }
  }

  return (
    <section className="dw-first" aria-labelledby="dw-first-h">
      <header className="dw-first__head">
        <Mark size={32} />
        <div>
          <h2 className="dw-first__h" id="dw-first-h">Start with Dowser</h2>
          <p className="dw-first__lede">
            Dowser scans a repository and proposes what to build next. Every card quotes the code it rests on.
          </p>
        </div>
      </header>

      <div className="dw-first__cards">
        <section className="dw-first__card dw-first__card--sample" aria-labelledby="dw-first-sample">
          <span className="dw-first__n" aria-hidden="true">1</span>
          <div className="dw-first__body">
            <h3 className="dw-first__ch" id="dw-first-sample">Try it on a sample</h3>
            <p>
              A real scan of Dowser&rsquo;s own public repository. Accept creates real Jira issues, labelled{' '}
              <code>dowser-sample</code>. Remove the sample at any time.
            </p>
            {state.status === 'error' && (
              <SectionMessage appearance="error" title="The sample could not load.">
                <p>{String(state.error?.message ?? 'Something went wrong.')}</p>
                <p style={{ marginTop: 8 }}><Button onClick={load}>Retry</Button></p>
              </SectionMessage>
            )}
            {state.status !== 'error' && (
              <p className="dw-first__act">
                <Button appearance="primary" onClick={load} busy={state.status === 'loading'}>
                  {state.status === 'loading' ? 'Loading the sample...' : 'Load the sample'}
                </Button>
              </p>
            )}
          </div>
        </section>

        <section className="dw-first__card" aria-labelledby="dw-first-agent">
          <span className="dw-first__n" aria-hidden="true">2</span>
          <div className="dw-first__body">
            <h3 className="dw-first__ch" id="dw-first-agent">Connect your coding agent</h3>
            <SetupChecklist headingLevel={4} />
          </div>
        </section>

        <section className="dw-first__card" aria-labelledby="dw-first-scan">
          <span className="dw-first__n" aria-hidden="true">3</span>
          <div className="dw-first__body">
            <h3 className="dw-first__ch" id="dw-first-scan">Scan your own repository</h3>
            <p>Install the Dowser skill once:</p>
            <pre className="dwr-code" tabIndex={0} aria-label="Commands to install the Dowser skill">{'git clone https://github.com/xkazm04/dowser\nnode dowser/skill/install.mjs --harness claude'}</pre>
            <p style={{ marginTop: 8 }}>Then, in your repository, run <code>/dowser</code> in Claude Code. With the agent connected (step 2), the proposals you keep land in this inbox.</p>
          </div>
        </section>
      </div>
    </section>
  );
}
