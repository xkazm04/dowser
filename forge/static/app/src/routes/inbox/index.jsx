// The Dowser inbox (F8): a queue grouped by push, like a pull request for the backlog. Not a sortable table:
// the server order inside a group is kept, and a decided card leaves the view without reordering the rest
// (a removal from a set, not a position change).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { call } from '../../api.js';
import { Button, ErrorState, SectionMessage, SkeletonList } from '../../components/ui.jsx';
import { ProposalCard } from '../../components/ProposalCard.jsx';
import {
  CHANGE_LABELS, LENSES, LENS_LABELS, STATUSES, STATUS_LABELS, changeOf, formatDate, plural,
} from '../../components/labels.js';
import { AcceptDialog, HelpDialog, MergeDialog, RejectDialog } from './dialogs.jsx';

/** Append a page of groups; a group split across the page boundary (same run_id) is joined. */
function appendGroups(prev, more) {
  const out = prev.map((g) => ({ ...g, items: [...g.items] }));
  for (const g of more) {
    const last = out[out.length - 1];
    if (last && last.run_id === g.run_id) last.items.push(...(g.items ?? []));
    else out.push({ ...g, items: [...(g.items ?? [])] });
  }
  return out;
}

function isTyping(target) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

export default function Inbox() {
  const [projectKey, setProjectKey] = useState('');
  const [status, setStatus] = useState('open');
  const [lens, setLens] = useState('');
  const [load, setLoad] = useState(/** @type {{status: 'loading'|'ready'|'error', error?: any}} */ ({ status: 'loading' }));
  const [inboxes, setInboxes] = useState(/** @type {any[]} */ ([]));
  const [groups, setGroups] = useState(/** @type {any[]} */ ([]));
  const [next, setNext] = useState(/** @type {string | undefined} */ (undefined));
  const [moreState, setMoreState] = useState(/** @type {'idle'|'loading'|string} */ ('idle'));
  const [lastPush, setLastPush] = useState(/** @type {{run_id: string, at: string, lenses: string[]} | null | undefined} */ (undefined));
  const [removed, setRemoved] = useState(() => new Set());
  const [selected, setSelected] = useState(() => new Set());
  const [errors, setErrors] = useState(/** @type {Record<string, string>} */ ({}));
  const [busy, setBusy] = useState(/** @type {Record<string, boolean>} */ ({}));
  const [focusRef, setFocusRef] = useState('');
  const [dialog, setDialog] = useState(/** @type {{kind: string, refs: string[]} | null} */ (null));
  const [notice, setNotice] = useState(/** @type {React.ReactNode} */ (null));
  const [bulkError, setBulkError] = useState('');
  const seq = useRef(0);
  const cardEls = useRef(/** @type {Record<string, HTMLElement | null>} */ ({}));

  const filters = useMemo(() => {
    /** @type {{project_key?: string, status?: string, lens?: string}} */
    const f = { status };
    if (projectKey) f.project_key = projectKey;
    if (lens) f.lens = lens;
    return f;
  }, [projectKey, status, lens]);

  const reload = useCallback(() => {
    const mine = ++seq.current;
    setLoad({ status: 'loading' });
    setRemoved(new Set()); setSelected(new Set()); setErrors({}); setLastPush(undefined); setMoreState('idle'); setBulkError('');
    call('inbox.list', filters).then(
      (res) => {
        if (mine !== seq.current) return;
        setInboxes(res.inboxes ?? []);
        setGroups(appendGroups([], res.groups ?? []));
        setNext(res.next);
        setLoad({ status: 'ready' });
      },
      (error) => { if (mine === seq.current) setLoad({ status: 'error', error }); },
    );
  }, [filters]);
  useEffect(() => { reload(); }, [reload]);

  // Visible groups: decided cards removed, empty groups dropped. Server order is untouched.
  const visible = useMemo(() => groups
    .map((g) => ({ ...g, items: g.items.filter((c) => !removed.has(c.ref)) }))
    .filter((g) => g.items.length > 0), [groups, removed]);
  const flat = useMemo(() => visible.flatMap((g) => g.items), [visible]);
  const byRef = useMemo(() => new Map(flat.map((c) => [c.ref, c])), [flat]);

  // Empty view: name the last push (from an unfiltered page of this inbox) instead of saying "all clear".
  useEffect(() => {
    if (load.status !== 'ready' || flat.length > 0 || next || lastPush !== undefined) return;
    let live = true;
    call('inbox.list', projectKey ? { project_key: projectKey } : {}).then(
      (res) => {
        if (!live) return;
        const g = (res.groups ?? [])[0];
        setLastPush(g ? { run_id: g.run_id, at: g.at, lenses: [...new Set((g.items ?? []).map((c) => c.lens))] } : null);
      },
      () => { if (live) setLastPush(null); },
    );
    return () => { live = false; };
  }, [load.status, flat.length, next, lastPush, projectKey]);

  // Keep the focused card valid after removals: move to the card now at the same position.
  const focusIndex = flat.findIndex((c) => c.ref === focusRef);
  const lastIndex = useRef(0);
  useEffect(() => {
    if (focusIndex >= 0) { lastIndex.current = focusIndex; return; }
    if (!focusRef || flat.length === 0) return;
    const ref = flat[Math.min(lastIndex.current, flat.length - 1)].ref;
    setFocusRef(ref);
    if (!dialog) cardEls.current[ref]?.focus();
  }, [focusIndex, focusRef, flat, dialog]);

  function moveFocus(delta) {
    if (flat.length === 0) return;
    const i = focusIndex < 0 ? 0 : Math.max(0, Math.min(flat.length - 1, focusIndex + delta));
    const ref = flat[i].ref;
    setFocusRef(ref);
    const el = cardEls.current[ref];
    if (el) { el.focus(); el.scrollIntoView?.({ block: 'nearest' }); }
  }

  function toggle(ref) {
    setSelected((prev) => { const s = new Set(prev); if (s.has(ref)) s.delete(ref); else s.add(ref); return s; });
  }

  function leave(cards) {
    const refs = cards.map((c) => c.ref);
    setRemoved((prev) => new Set([...prev, ...refs]));
    setSelected((prev) => { const s = new Set(prev); refs.forEach((r) => s.delete(r)); return s; });
    setErrors((prev) => { const e = { ...prev }; refs.forEach((r) => delete e[r]); return e; });
  }

  function fail(refs, message) {
    setErrors((prev) => ({ ...prev, ...Object.fromEntries(refs.map((r) => [r, message])) }));
  }

  async function snooze(refs, bulk = false) {
    setBusy((b) => ({ ...b, ...Object.fromEntries(refs.map((r) => [r, true])) }));
    setBulkError('');
    try {
      const res = await call('verdict.snooze', { refs });
      leave(res.cards ?? []);
      setNotice(<>{refs.length === 1 ? `${refs[0]} snoozed.` : `${plural(refs.length, 'proposal')} snoozed.`} It comes back when its evidence grows.</>);
    } catch (e) {
      const msg = String(e?.message ?? 'The snooze failed.');
      fail(refs, msg);
      if (bulk) setBulkError(msg);
    } finally {
      setBusy((b) => { const n = { ...b }; refs.forEach((r) => delete n[r]); return n; });
    }
  }

  function open(kind, refs) {
    if (refs.length === 0) return;
    setBulkError('');
    setDialog({ kind, refs });
  }

  // Keyboard: only when no dialog is open and no text field has focus.
  useEffect(() => {
    function onKey(e) {
      if (dialog || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      const focused = focusIndex >= 0 ? flat[focusIndex] : undefined;
      const actionable = focused && focused.status === 'open' && !busy[focused.ref];
      const many = [...selected].filter((r) => byRef.has(r));
      switch (e.key) {
        case 'j': moveFocus(1); break;
        case 'k': moveFocus(-1); break;
        case 'x': if (focused) toggle(focused.ref); else return; break;
        case 'a': if (actionable) open('accept', [focused.ref]); else return; break;
        case 'm': if (actionable) open('merge', [focused.ref]); else return; break;
        case 'r':
          if (many.length > 0) open('reject', many); else if (actionable) open('reject', [focused.ref]); else return;
          break;
        case 's':
          if (many.length > 0) snooze(many, true); else if (actionable) snooze([focused.ref]); else return;
          break;
        case '?': setDialog({ kind: 'help', refs: [] }); break;
        default: return;
      }
      e.preventDefault();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  async function loadMore() {
    if (!next) return;
    setMoreState('loading');
    const mine = seq.current;
    try {
      const res = await call('inbox.list', { ...filters, cursor: next });
      if (mine !== seq.current) return;
      setGroups((prev) => appendGroups(prev, res.groups ?? []));
      setNext(res.next);
      setMoreState('idle');
    } catch (e) {
      if (mine === seq.current) setMoreState(String(e?.message ?? 'More proposals could not load.'));
    }
  }

  const dialogCards = (dialog?.refs ?? []).map((r) => byRef.get(r)).filter(Boolean);
  const selectedVisible = [...selected].filter((r) => byRef.has(r));
  const closeDialog = () => setDialog(null);

  return (
    <main className="dw-root">
      <div className="dw-row" style={{ marginBottom: 8 }}>
        <h1 className="dw-h1" style={{ margin: 0 }}>Dowser inbox</h1>
        <span className="dw-spacer" />
        {inboxes.length > 1 && (
          <label className="dw-row">
            <span className="dw-subtlest">Inbox</span>
            <select className="dw-select" value={projectKey} onChange={(e) => setProjectKey(e.target.value)}>
              <option value="">All inboxes</option>
              {inboxes.map((i) => <option key={i.project_key} value={i.project_key}>{i.project_key} ({i.open} open)</option>)}
            </select>
          </label>
        )}
        <Button appearance="subtle" compact onClick={() => setDialog({ kind: 'help', refs: [] })} aria-label="Keyboard shortcuts">?</Button>
      </div>

      <div className="dw-chips" role="group" aria-label="Filter by status">
        <span className="dw-chips__label">Status</span>
        {STATUSES.map((s) => (
          <button key={s} type="button" className="dw-chip" aria-pressed={status === s} onClick={() => setStatus(s)}>{STATUS_LABELS[s]}</button>
        ))}
      </div>
      <div className="dw-chips" role="group" aria-label="Filter by lens">
        <span className="dw-chips__label">Lens</span>
        <button type="button" className="dw-chip" aria-pressed={lens === ''} onClick={() => setLens('')}>All</button>
        {LENSES.map((l) => (
          <button key={l} type="button" className="dw-chip" aria-pressed={lens === l} onClick={() => setLens(l)}>{LENS_LABELS[l]}</button>
        ))}
      </div>

      <div aria-live="polite">
        {notice && <SectionMessage appearance="success" role="status"><p>{notice} <Button appearance="subtle" compact onClick={() => setNotice(null)}>Dismiss</Button></p></SectionMessage>}
      </div>

      {selectedVisible.length > 0 && (
        <div className="dw-bulk" role="region" aria-label="Bulk actions">
          <strong>{plural(selectedVisible.length, 'selected', 'selected')}</strong>
          <Button appearance="danger" compact onClick={() => open('reject', selectedVisible)}>Reject…</Button>
          <Button compact onClick={() => snooze(selectedVisible, true)} busy={selectedVisible.some((r) => busy[r])}>Snooze</Button>
          <Button appearance="subtle" compact onClick={() => setSelected(new Set())}>Clear selection</Button>
          {bulkError && <span role="alert" className="dw-subtle" style={{ color: 'var(--ds-text-danger, #AE2E24)' }}>{bulkError}</span>}
        </div>
      )}

      {load.status === 'loading' && <SkeletonList label="Loading the inbox" />}
      {load.status === 'error' && <ErrorState what="The inbox" error={load.error} onRetry={reload} />}
      {load.status === 'ready' && flat.length === 0 && !next && <EmptyState status={status} lens={lens} lastPush={lastPush} />}

      {load.status === 'ready' && visible.map((g) => (
        <section key={g.run_id} className="dw-group" aria-labelledby={`dw-g-${g.run_id}`}>
          <GroupHead group={g} />
          <ul className="dw-list">
            {g.items.map((card) => {
              const isOpen = card.status === 'open';
              const cardBusy = Boolean(busy[card.ref]);
              const titleId = `dw-t-${card.ref}`;
              return (
                <li key={card.ref}>
                  <ProposalCard
                    card={card}
                    change={changeOf(card, g)}
                    showStatus={!isOpen}
                    titleId={titleId}
                    tabIndex={-1}
                    ref={(el) => { cardEls.current[card.ref] = el; }}
                    focused={card.ref === focusRef}
                    selected={selected.has(card.ref)}
                    onFocus={(e) => { if (e.target === e.currentTarget) setFocusRef(card.ref); }}
                    select={isOpen && (
                      <input
                        type="checkbox" className="dw-checkbox" checked={selected.has(card.ref)} onChange={() => toggle(card.ref)}
                        aria-label={`Select ${card.ref}`} onFocus={() => setFocusRef(card.ref)}
                      />
                    )}
                    actions={isOpen && (
                      <>
                        <Button appearance="primary" compact disabled={cardBusy} onClick={() => open('accept', [card.ref])} onFocus={() => setFocusRef(card.ref)}>Accept</Button>
                        <Button compact disabled={cardBusy} onClick={() => open('merge', [card.ref])} onFocus={() => setFocusRef(card.ref)}>Merge</Button>
                        <Button compact disabled={cardBusy} onClick={() => open('reject', [card.ref])} onFocus={() => setFocusRef(card.ref)}>Reject</Button>
                        <Button compact busy={cardBusy} onClick={() => snooze([card.ref])} onFocus={() => setFocusRef(card.ref)}>Snooze</Button>
                      </>
                    )}
                    footer={errors[card.ref] && (
                      <SectionMessage appearance="error"><p>{errors[card.ref]}</p></SectionMessage>
                    )}
                  />
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      {load.status === 'ready' && next && (
        <div style={{ margin: '16px 0' }}>
          <Button onClick={loadMore} busy={moreState === 'loading'}>Load more</Button>
          {moreState !== 'idle' && moreState !== 'loading' && (
            <SectionMessage appearance="error"><p>{moreState} <Button compact onClick={loadMore}>Retry</Button></p></SectionMessage>
          )}
        </div>
      )}

      {dialog?.kind === 'help' && <HelpDialog onClose={closeDialog} />}
      {dialog?.kind === 'accept' && dialogCards[0] && (
        <AcceptDialog
          card={dialogCards[0]} onClose={closeDialog} onFailed={(ref, m) => fail([ref], m)}
          onDone={(card) => {
            const c = card ?? dialogCards[0];
            closeDialog(); leave([c]);
            setNotice(<>{c.ref} accepted{c.issue_ref && <> as {c.issue_url ? <a href={c.issue_url} target="_blank" rel="noreferrer noopener">{c.issue_ref}</a> : c.issue_ref}</>}.</>);
          }}
        />
      )}
      {dialog?.kind === 'merge' && dialogCards[0] && (
        <MergeDialog
          card={dialogCards[0]} openCards={flat.filter((c) => c.status === 'open')} onClose={closeDialog} onFailed={(ref, m) => fail([ref], m)}
          onDone={(card) => {
            const c = card ?? dialogCards[0];
            closeDialog(); leave([c]);
            setNotice(<>{c.ref} merged{c.merged_into ? ` into ${c.merged_into}` : ''}.</>);
          }}
        />
      )}
      {dialog?.kind === 'reject' && dialogCards.length > 0 && (
        <RejectDialog
          cards={dialogCards} onClose={closeDialog} onFailed={(refs, m) => fail(refs, m)}
          onDone={(cards) => {
            const done = cards.length ? cards : dialogCards;
            closeDialog(); leave(done);
            setNotice(<>{done.length === 1 ? `${done[0].ref} rejected.` : `${plural(done.length, 'proposal')} rejected.`}</>);
          }}
        />
      )}
    </main>
  );
}

function GroupHead({ group }) {
  const counts = { new: 0, grew: 0, reopened: 0 };
  for (const c of group.items) counts[changeOf(c, group)] += 1;
  return (
    <div className="dw-group__head">
      <h2 className="dw-h2" id={`dw-g-${group.run_id}`}>Push of {formatDate(group.at)}</h2>
      {group.head_sha && <span className="dw-subtlest" title={group.head_sha}>at <code>{group.head_sha.slice(0, 7)}</code></span>}
      <span className="dw-subtlest">run {group.run_id}</span>
      <span className="dw-spacer" />
      <span className="dw-group__counts">
        {Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => (
          <span key={k} className="dw-subtle">{CHANGE_LABELS[k]} {n}</span>
        )).reduce((acc, el, i) => (i ? [...acc, <span key={`s${i}`} className="dw-subtlest">·</span>, el] : [el]), [])}
      </span>
    </div>
  );
}

function EmptyState({ status, lens, lastPush }) {
  const what = `${STATUS_LABELS[status].toLowerCase()} proposals${lens ? ` for ${LENS_LABELS[lens]}` : ''}`;
  return (
    <SectionMessage appearance="information" title={`No ${what} here.`} role="status">
      {lastPush === undefined && <p className="dw-subtle">Checking the last push…</p>}
      {lastPush && (
        <p>
          The last push was run {lastPush.run_id} on {formatDate(lastPush.at)}
          {lastPush.lenses.length > 0 && <> ({lastPush.lenses.map((l) => LENS_LABELS[l] ?? l).join(', ')})</>}.
        </p>
      )}
      {lastPush === null && <p>No push has reached this inbox yet.</p>}
      <p style={{ marginTop: 8 }}>
        To file new proposals, run a scan: <code>/dowser</code> in Claude Code or Codex, in the repository. Verified proposals
        are pushed here.
      </p>
    </SectionMessage>
  );
}
