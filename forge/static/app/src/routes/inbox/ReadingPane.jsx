// The reading pane (wide layout) and the decision bar it shares with the narrow layout's inline accordion.
import React from 'react';
import { Button, SectionMessage } from '../../components/ui.jsx';
import { SnoozeStep } from './dialogs.jsx';
import { Detail } from './Detail.jsx';
import { Kbd } from './parts.jsx';

export function ReadingPane({ current, currentChange, history, onHistoryRetry, paneScroll, snoozeFor, errors, actions }) {
  return (
    <section className="dwr-pane" aria-label="Selected proposal">
      {current ? (
        <>
          <div className="dwr-pane__scroll" ref={paneScroll}>
            <div className="dwr-pane__in">
              <Detail card={current} change={currentChange} history={history} onHistoryRetry={onHistoryRetry} titleId={`dwr-t-${current.ref}`} />
            </div>
          </div>
          <Decide card={current} snoozing={snoozeFor === current.ref} error={errors[current.ref]} actions={actions} />
        </>
      ) : <p className="dwr-pane__none">Select a proposal to read it.</p>}
    </section>
  );
}

export function Decide({ card, snoozing, error, actions, sticky = false }) {
  const isOpen = card.status === 'open';
  return (
    <div className={`dwr-decide${sticky ? ' dwr-decide--sticky' : ''}`}>
      {error && <SectionMessage appearance="error"><p>{error}</p></SectionMessage>}
      {isOpen && !snoozing && (
        <div className="dwr-decide__row" role="group" aria-label={`Decide ${card.ref}`}>
          <Button appearance="primary" onClick={() => actions.accept(card)} aria-keyshortcuts="a">Accept <Kbd>a</Kbd></Button>
          <Button onClick={() => actions.merge(card)} aria-keyshortcuts="m">Merge <Kbd>m</Kbd></Button>
          <Button onClick={() => actions.reject(card)} aria-keyshortcuts="r">Reject <Kbd>r</Kbd></Button>
          <Button onClick={() => actions.snooze(card)} aria-keyshortcuts="s">Snooze <Kbd>s</Kbd></Button>
          <span className="dwr-spacer" />
          <span className="dwr-decide__hint"><Kbd>j</Kbd><Kbd>k</Kbd> move <Kbd>x</Kbd> check</span>
        </div>
      )}
      {isOpen && snoozing && (
        <SnoozeStep cardRef={card.ref} onSubmit={(note, until) => actions.snoozeSubmit(card, note, until)} onCancel={actions.snoozeCancel} />
      )}
      {!isOpen && <p className="dwr-decide__done">Already decided.</p>}
    </div>
  );
}
