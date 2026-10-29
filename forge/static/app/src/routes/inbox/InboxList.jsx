// The queue list: the bulk bar over the checked rows, the rows grouped by push (with the narrow layout's inline
// accordion under the selected row), and "Load more".
import React from 'react';
import { Button, Lozenge, SectionMessage } from '../../components/ui.jsx';
import { CHANGE_LABELS, STATUS_APPEARANCE, STATUS_LABELS, changeOf, plural } from '../../components/labels.js';
import { SnoozeStep } from './dialogs.jsx';
import { Detail } from './Detail.jsx';
import { Kbd, LENS_SHORT, LensDot, RowSignals } from './parts.jsx';
import { Decide } from './ReadingPane.jsx';
import { shortWhen } from './Toolbar.jsx';

/** The `snoozeFor` value while the bulk bar's snooze step is open (no card ref looks like it). */
export const BULK = ' bulk';

const CHANGE_SHORT = { new: 'New', grew: 'Grew', reopened: 'Reopened' };

export function InboxList({
  visible, leaving, selected, selectedVisible, byRef, focusRef, wide, expanded, history, errors, snoozeFor, setSnoozeFor,
  setSelected, actions, open, deferSnooze, toggle, select, rowEls, next, moreState, loadMore,
}) {
  return (
    <section className="dwr-list" aria-label="Proposals">
      {selectedVisible.length > 0 && (
        <BulkBar
          selectedVisible={selectedVisible} byRef={byRef} snoozeFor={snoozeFor} setSnoozeFor={setSnoozeFor}
          setSelected={setSelected} open={open} deferSnooze={deferSnooze}
        />
      )}
      {visible.map((g) => (
        <section key={g.run_id} className="dwr-group" aria-labelledby={`dwr-g-${g.run_id}`}>
          <GroupHead group={g} leaving={leaving} />
          <ul className="dwr-rows">
            {g.items.map((card) => (
              <Row
                key={card.ref} card={card} group={g} leaving={leaving.has(card.ref)} current={card.ref === focusRef}
                checked={selected.has(card.ref)} onToggle={() => toggle(card.ref)} onSelect={() => select(card.ref)}
                rowRef={(el) => { rowEls.current[card.ref] = el; }}
              >
                {!wide && card.ref === focusRef && expanded && !leaving.has(card.ref) && (
                  <div className="dwr-inline">
                    <Detail card={card} change={changeOf(card, g)} history={history} titleId={`dwr-t-${card.ref}`} />
                    <Decide card={card} snoozing={snoozeFor === card.ref} error={errors[card.ref]} actions={actions} sticky />
                  </div>
                )}
              </Row>
            ))}
          </ul>
        </section>
      ))}
      {next && (
        <div className="dwr-more-rows">
          <Button onClick={loadMore} busy={moreState === 'loading'}>Load more</Button>
          {moreState !== 'idle' && moreState !== 'loading' && (
            <SectionMessage appearance="error"><p>{moreState} <Button compact onClick={loadMore}>Retry</Button></p></SectionMessage>
          )}
        </div>
      )}
    </section>
  );
}

function BulkBar({ selectedVisible, byRef, snoozeFor, setSnoozeFor, setSelected, open, deferSnooze }) {
  return (
    <div className="dwr-bulk" role="region" aria-label="Bulk actions">
      <strong>{selectedVisible.length} checked</strong>
      <Button appearance="danger" compact onClick={() => open('reject', selectedVisible)}>Reject <Kbd>r</Kbd></Button>
      <Button compact onClick={() => setSnoozeFor(BULK)}>Snooze <Kbd>s</Kbd></Button>
      <span className="dwr-spacer" />
      <Button appearance="subtle" compact onClick={() => { setSelected(new Set()); setSnoozeFor(''); }}>Clear</Button>
      {snoozeFor === BULK && (
        <SnoozeStep
          cardRef="bulk" label={plural(selectedVisible.length, 'proposal')} withNote={false}
          onSubmit={(_, until) => deferSnooze(selectedVisible.map((r) => byRef.get(r)), '', until)} onCancel={() => setSnoozeFor('')}
        />
      )}
    </div>
  );
}

function GroupHead({ group, leaving }) {
  const counts = { new: 0, grew: 0, reopened: 0 };
  for (const c of group.items) if (c.status === 'open' && !leaving.has(c.ref)) counts[changeOf(c, group)] += 1;
  const bits = Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${CHANGE_LABELS[k].toLowerCase()}`);
  return (
    <h2 className="dwr-group__head" id={`dwr-g-${group.run_id}`} title={group.head_sha ? `Scanned at ${group.head_sha.slice(0, 7)}, run ${group.run_id}` : `Run ${group.run_id}`}>
      <span>Push of {shortWhen(group.at)}</span>
      {bits.length > 0 && <span className="dwr-group__counts">{bits.join(' · ')}</span>}
    </h2>
  );
}

function Row({ card, group, leaving, current, checked, onToggle, onSelect, rowRef, children }) {
  const isOpen = card.status === 'open';
  const change = isOpen ? (card.reopened ? 'reopened' : changeOf(card, group)) : undefined;
  return (
    <li className={`dwr-item${leaving ? ' dwr-item--leaving' : ''}`} aria-hidden={leaving || undefined}>
      <div className="dwr-item__inner">
        <div className={`dwr-row${current ? ' dwr-row--current' : ''}${checked ? ' dwr-row--checked' : ''}`}>
          <span className="dwr-row__check">
            {isOpen && (
              <input type="checkbox" className="dwr-checkbox" checked={checked} onChange={onToggle} aria-label={`Check ${card.ref}`} />
            )}
          </span>
          <button type="button" className="dwr-row__main" ref={rowRef} onClick={onSelect} aria-current={current ? 'true' : undefined} tabIndex={current ? 0 : -1}>
            <span className="dwr-row__title">{card.title}</span>
            <span className="dwr-row__meta">
              <span className="dwr-row__id">
                <LensDot lens={card.lens} />
                <span className="dwr-ref">{card.ref}</span>
                <span className="dwr-row__lens">{LENS_SHORT[card.lens] ?? card.lens}</span>
                {change && <span className={`dwr-mark dwr-mark--${change}`}>{CHANGE_SHORT[change]}</span>}
                {!isOpen && <Lozenge appearance={STATUS_APPEARANCE[card.status] ?? 'default'}>{STATUS_LABELS[card.status] ?? card.status}</Lozenge>}
                {card.issue_ref && <span className="dwr-ref">{card.issue_ref}</span>}
              </span>
              <RowSignals card={card} />
            </span>
          </button>
        </div>
        {children}
      </div>
    </li>
  );
}
