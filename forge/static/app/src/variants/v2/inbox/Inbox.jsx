// The Dowser inbox (F8): a queue grouped by push, like a pull request for the backlog. Not a sortable table:
// the server order inside a group is kept (the order is policy), and a decided card leaves the view without
// reordering the rest (a removal from a set, not a position change).
//
// Snooze and Reject are reversible by design: the card leaves at once, a toast offers Undo for 6 s and the
// resolver call fires when that window ends (see useCommitWindow). Accept creates a Jira issue, so it is not
// deferred; Merge writes into another item, same.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { call } from '../../../api.js';
import { Button, ErrorState, SectionMessage, SkeletonList } from '../../../components/ui.jsx';
import { LazyHistory } from '../../../components/ProposalCard.jsx';
import { Entry } from './Entry.jsx';
import { LensDot, Masthead, PushSentence, formatShort, summarise } from '../shared.jsx';
import { ToastRegion } from '../../../components/Toast.jsx';
import { useCommitWindow } from '../../../components/useCommitWindow.js';
import {
  CHANGE_LABELS, LENSES, LENS_LABELS, REASON_LABELS, STATUSES, STATUS_LABELS, changeOf, formatDate, plural,
} from '../../../components/labels.js';
import { AcceptDialog, HelpDialog, MergeDialog, RejectDialog, SnoozeStep } from '../../../routes/inbox/dialogs.jsx';
import { CardDialog } from '../../../components/CardDialog.jsx';
import { deepLinkRef } from '../../../components/deeplink.js';

const EXIT_MS = 240;

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

const reducedMotion = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const withoutKeys = (set, refs) => { const s = new Set(set); refs.forEach((r) => s.delete(r)); return s; };

export default function Inbox({ context }) {
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
  const [leaving, setLeaving] = useState(() => new Set());
  const [decided, setDecided] = useState(() => new Map());
  const [selected, setSelected] = useState(() => new Set());
  const [errors, setErrors] = useState(/** @type {Record<string, string>} */ ({}));
  const [focusRef, setFocusRef] = useState('');
  const [focusReq, setFocusReq] = useState('');
  const [snoozeFor, setSnoozeFor] = useState('');
  const [dialog, setDialog] = useState(/** @type {{kind: string, refs: string[]} | null} */ (null));
  const seq = useRef(0);
  const cardEls = useRef(/** @type {Record<string, HTMLElement | null>} */ ({}));
  const exitTimers = useRef(/** @type {Map<string, ReturnType<typeof setTimeout>>} */ (new Map()));
  const [linkRef, setLinkRef] = useState(/** @type {string | undefined} */ (undefined));
  const linkDone = useRef(false);
  const cw = useCommitWindow();

  const filters = useMemo(() => {
    /** @type {{project_key?: string, status?: string, lens?: string}} */
    const f = { status };
    if (projectKey) f.project_key = projectKey;
    if (lens) f.lens = lens;
    return f;
  }, [projectKey, status, lens]);

  const reload = useCallback(() => {
    const mine = ++seq.current;
    cw.flush();
    setLoad({ status: 'loading' });
    setRemoved(new Set()); setLeaving(new Set()); setDecided(new Map()); setSelected(new Set()); setErrors({}); setLastPush(undefined);
    setMoreState('idle'); setSnoozeFor('');
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);
  useEffect(() => { reload(); }, [reload]);

  // Visible groups: decided cards removed, empty groups dropped. Server order is untouched. A card that is
  // animating out is still rendered (collapsing) but no longer part of keyboard navigation.
  const visible = useMemo(() => groups
    .map((g) => ({ ...g, items: g.items.filter((c) => !removed.has(c.ref)) }))
    .filter((g) => g.items.length > 0), [groups, removed]);
  const shown = useMemo(() => visible.flatMap((g) => g.items), [visible]);
  const flat = useMemo(() => shown.filter((c) => !leaving.has(c.ref)), [shown, leaving]);
  const byRef = useMemo(() => new Map(shown.map((c) => [c.ref, c])), [shown]);

  // Empty view: name the last push instead of saying "all clear". Prefer the inbox summary's `last_push`; fall
  // back to an unfiltered page of this inbox when the server does not send it.
  useEffect(() => {
    if (load.status !== 'ready' || shown.length > 0 || next || lastPush !== undefined) return;
    const known = inboxes.filter((i) => (!projectKey || i.project_key === projectKey) && i.last_push)
      .map((i) => i.last_push).sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
    if (known) { setLastPush({ run_id: known.run_id, at: known.at, lenses: [] }); return; }
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
  }, [load.status, shown.length, next, lastPush, projectKey, inboxes]);

  // Deep link (`inbox?ref=DW-n`, the backend's external_url): once the first page is in, focus and scroll to the
  // card; a card outside the loaded page (another status, a later page) opens read-only via proposal.get.
  useEffect(() => {
    let live = true;
    deepLinkRef(context).then((r) => { if (live) setLinkRef(r ?? ''); });
    return () => { live = false; };
  }, [context]);
  useEffect(() => {
    if (!linkRef || linkDone.current || load.status !== 'ready') return;
    linkDone.current = true;
    if (byRef.has(linkRef)) {
      setFocusRef(linkRef);
      requestAnimationFrame(() => {
        const el = cardEls.current[linkRef];
        if (el) { el.focus(); el.scrollIntoView?.({ block: 'center' }); }
      });
    } else {
      setDialog({ kind: 'card', refs: [linkRef] });
    }
  }, [linkRef, load.status, byRef]);

  // Keep the focused card valid after removals: move to the card now at the same position.
  const focusIndex = flat.findIndex((c) => c.ref === focusRef);
  const lastIndex = useRef(0);
  useEffect(() => {
    if (focusIndex >= 0) { lastIndex.current = focusIndex; return; }
    if (!focusRef || flat.length === 0) return;
    const ref = flat[Math.min(lastIndex.current, flat.length - 1)].ref;
    setFocusRef(ref);
    if (!dialog && !snoozeFor) cardEls.current[ref]?.focus();
  }, [focusIndex, focusRef, flat, dialog, snoozeFor]);

  // After an Undo (or a failed commit) the card is back; give it the focus once it is in the DOM.
  useEffect(() => {
    if (!focusReq) return;
    const el = cardEls.current[focusReq];
    if (el) { el.focus(); el.scrollIntoView?.({ block: 'nearest' }); setFocusReq(''); }
  }, [focusReq, removed, leaving]);

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

  /** A decided card collapses out of the list (at once under reduced motion). */
  function leave(cards, to) {
    const refs = cards.map((c) => c.ref);
    setDecided((prev) => { const m = new Map(prev); refs.forEach((r) => m.set(r, to)); return m; });
    setSelected((prev) => withoutKeys(prev, refs));
    setErrors((prev) => { const e = { ...prev }; refs.forEach((r) => delete e[r]); return e; });
    if (reducedMotion()) { setRemoved((prev) => new Set([...prev, ...refs])); return; }
    setLeaving((prev) => new Set([...prev, ...refs]));
    for (const r of refs) {
      exitTimers.current.set(r, setTimeout(() => {
        exitTimers.current.delete(r);
        setRemoved((prev) => new Set([...prev, r]));
        setLeaving((prev) => withoutKeys(prev, [r]));
      }, EXIT_MS));
    }
  }

  /** Put cards back in place (Undo, or a deferred call that failed). */
  function restore(refs, focus = true) {
    for (const r of refs) { clearTimeout(exitTimers.current.get(r)); exitTimers.current.delete(r); }
    setRemoved((prev) => withoutKeys(prev, refs));
    setLeaving((prev) => withoutKeys(prev, refs));
    setDecided((prev) => { const m = new Map(prev); refs.forEach((r) => m.delete(r)); return m; });
    if (focus) { setFocusRef(refs[0]); setFocusReq(refs[0]); }
  }

  function fail(refs, message) {
    setErrors((prev) => ({ ...prev, ...Object.fromEntries(refs.map((r) => [r, message])) }));
  }

  function failDeferred(refs, what, e) {
    const message = String(e?.message ?? `The ${what} failed.`);
    restore(refs, false);
    fail(refs, message);
    cw.notify(`Could not ${what} ${refs.length === 1 ? refs[0] : plural(refs.length, 'proposal')}: ${message} It is back in the list.`, 'error');
  }

  /** Snooze: leaves now, the call fires after the undo window. A note is only sent when the person wrote one. */
  function deferSnooze(cards, note = '') {
    const refs = cards.map((c) => c.ref);
    setSnoozeFor('');
    leave(cards, 'snoozed');
    cw.schedule({
      message: refs.length === 1 ? `Snoozed ${refs[0]}` : `Snoozed ${plural(refs.length, 'proposal')}`,
      run: () => call('verdict.snooze', note ? { refs, note } : { refs }),
      onUndo: () => restore(refs),
      onError: (e) => failDeferred(refs, 'snooze', e),
    });
  }

  function deferReject(cards, { reason, note }) {
    const refs = cards.map((c) => c.ref);
    leave(cards, 'rejected');
    cw.schedule({
      message: `${refs.length === 1 ? `Rejected ${refs[0]}` : `Rejected ${plural(refs.length, 'proposal')}`} (${REASON_LABELS[reason] ?? reason})`,
      run: () => call('verdict.reject', note ? { refs, reason, note } : { refs, reason }),
      onUndo: () => restore(refs),
      onError: (e) => failDeferred(refs, 'reject', e),
    });
  }

  function open(kind, refs) {
    if (refs.length === 0) return;
    setSnoozeFor('');
    setDialog({ kind, refs });
  }

  function cancelSnooze() {
    const ref = snoozeFor;
    setSnoozeFor('');
    requestAnimationFrame(() => cardEls.current[ref]?.focus());
  }

  // Keyboard: only when no dialog is open and no text field has focus.
  useEffect(() => {
    function onKey(e) {
      if (dialog || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      const focused = focusIndex >= 0 ? flat[focusIndex] : undefined;
      const actionable = focused && focused.status === 'open';
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
          if (many.length > 0) deferSnooze(many.map((r) => byRef.get(r)));
          else if (actionable) setSnoozeFor(focused.ref);
          else return;
          break;
        case 'u': if (!cw.undoLatest()) return; break;
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
  const tally = useMemo(() => {
    const t = { accepted: 0, rejected: 0, snoozed: 0, merged: 0, total: 0 };
    for (const v of decided.values()) { t[v] += 1; t.total += 1; }
    return t;
  }, [decided]);

  const { open: openTotal, last } = summarise(inboxes, projectKey);
  const openNow = Math.max(0, openTotal - tally.total);

  // Lens counts for the filter list: exact only once every item of the status is loaded (no further page).
  const lensKey = `${projectKey}|${status}`;
  const [lensBase, setLensBase] = useState(/** @type {{key: string, counts: Record<string, number>} | null} */ (null));
  useEffect(() => {
    if (load.status !== 'ready' || lens || next) return;
    const counts = {};
    for (const c of shown) counts[c.lens] = (counts[c.lens] ?? 0) + 1;
    setLensBase({ key: lensKey, counts });
  }, [load.status, lens, next, shown, lensKey]);
  const lensCount = (l) => {
    if (lens === l) return next ? undefined : shown.length;
    return lensBase?.key === lensKey ? lensBase.counts[l] ?? 0 : undefined;
  };
  const statusCount = (s) => (s === 'open' && inboxes.length > 0 ? openNow : undefined);

  const filterRow = (
    <div className="dw2-filters">
      <div className="dw2-tabs" role="group" aria-label="Filter by status">
        {STATUSES.map((s) => (
          <button key={s} type="button" className="dw2-tab" aria-pressed={status === s} onClick={() => setStatus(s)}>
            {STATUS_LABELS[s]}{statusCount(s) !== undefined && <span className="dw2-tab__n">{statusCount(s)}</span>}
          </button>
        ))}
      </div>
      <label className="dw2-pick dw2-pick--small">
        <span className="dw2-pick__text">{lens ? LENS_LABELS[lens] : 'All lenses'}</span>
        <span className="dw-visually-hidden">Filter by lens</span>
        <select value={lens} onChange={(e) => setLens(e.target.value)}>
          <option value="">All lenses</option>
          {LENSES.map((l) => <option key={l} value={l}>{LENS_LABELS[l]}</option>)}
        </select>
      </label>
    </div>
  );

  const rail = (
    <aside className="dw2-rail" aria-label="Summary and filters">
      <section className="dw2-rail__sec" aria-label="Push summary">
        <p className="dw2-rail__big"><span>{openNow}</span> waiting for you</p>
        {last
          ? <p className="dw2-rail__small">Last push {formatShort(last.at)}<br />{last.created ?? 0} new{(last.updated ?? 0) > 0 && <>, {last.updated} grew</>}</p>
          : <p className="dw2-rail__small">No push has reached this inbox yet.</p>}
      </section>
      <section className="dw2-rail__sec" role="group" aria-labelledby="dw2-rail-status">
        <h2 className="dw2-eyebrow" id="dw2-rail-status">Status</h2>
        <ul className="dw2-flist">
          {STATUSES.map((s) => (
            <li key={s}>
              <button type="button" aria-pressed={status === s} onClick={() => setStatus(s)}>
                <span>{STATUS_LABELS[s]}</span><span className="dw2-flist__n">{statusCount(s)}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section className="dw2-rail__sec" role="group" aria-labelledby="dw2-rail-lens">
        <h2 className="dw2-eyebrow" id="dw2-rail-lens">Lens</h2>
        <ul className="dw2-flist">
          <li><button type="button" aria-pressed={lens === ''} onClick={() => setLens('')}><span>All lenses</span></button></li>
          {LENSES.map((l) => (
            <li key={l}>
              <button type="button" aria-pressed={lens === l} onClick={() => setLens(l)}>
                <span><LensDot lens={l} />{LENS_LABELS[l]}</span><span className="dw2-flist__n">{lensCount(l)}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section className="dw2-rail__sec" aria-labelledby="dw2-rail-keys">
        <h2 className="dw2-eyebrow" id="dw2-rail-keys">Keyboard</h2>
        <dl className="dw2-keys">
          {[['j k', 'next, previous'], ['x', 'select'], ['a', 'accept'], ['r', 'reject'], ['s', 'snooze'], ['m', 'merge'], ['u', 'undo'], ['?', 'all shortcuts']].map(([k, w]) => (
            <React.Fragment key={k}><dt><kbd className="dw2-key">{k}</kbd></dt><dd>{w}</dd></React.Fragment>
          ))}
        </dl>
      </section>
    </aside>
  );

  return (
    <main className="dw2-page">
      <div className="dw2-col">
        <Masthead
          context={context} active="inbox" title="Dowser inbox" inboxes={inboxes}
          projectKey={projectKey} onProjectChange={setProjectKey} allOption
          summary={<PushSentence inboxes={inboxes} projectKey={projectKey} open={openNow} />}
          extra={<button type="button" className="dw2-iconbtn" onClick={() => setDialog({ kind: 'help', refs: [] })} aria-label="Keyboard shortcuts" aria-keyshortcuts="?">?</button>}
        />
        {filterRow}

        {selectedVisible.length > 0 && (
          <div className="dw2-bulk" role="region" aria-label="Bulk actions">
            <strong>{selectedVisible.length} selected</strong>
            <Button appearance="danger" compact onClick={() => open('reject', selectedVisible)}>Reject&hellip;</Button>
            <Button compact onClick={() => deferSnooze(selectedVisible.map((r) => byRef.get(r)))}>Snooze</Button>
            <Button appearance="subtle" compact onClick={() => setSelected(new Set())}>Clear selection</Button>
          </div>
        )}

        {load.status === 'loading' && <Skeleton />}
        {load.status === 'error' && <ErrorState what="The inbox" error={load.error} onRetry={reload} />}
        {load.status === 'ready' && shown.length === 0 && !next && <EmptyState status={status} lens={lens} lastPush={lastPush} tally={tally} />}

        {load.status === 'ready' && visible.map((g) => (
          <section key={g.run_id} className="dw2-group" aria-labelledby={`dw-g-${g.run_id}`}>
            <GroupHead group={g} leaving={leaving} />
            <ul className="dw2-list">
              {g.items.map((card) => {
                const isOpen = card.status === 'open';
                const titleId = `dw-t-${card.ref}`;
                const isLeaving = leaving.has(card.ref);
                const focus = () => setFocusRef(card.ref);
                return (
                  <li key={card.ref} className={`dw-item${isLeaving ? ' dw-item--leaving' : ''}`} aria-hidden={isLeaving || undefined}>
                    <div className="dw-item__inner">
                      <Entry
                        card={card}
                        change={isOpen ? changeOf(card, g) : undefined}
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
                            aria-label={`Select ${card.ref}`} onFocus={focus}
                          />
                        )}
                        actions={isOpen && (
                          <>
                            <span className="dw2-actions__more">
                              <Button appearance="subtle" compact onClick={() => open('merge', [card.ref])} onFocus={focus}>Merge <kbd className="dw2-key" aria-hidden="true">m</kbd></Button>
                              <Button appearance="subtle" compact onClick={() => open('reject', [card.ref])} onFocus={focus}>Reject <kbd className="dw2-key" aria-hidden="true">r</kbd></Button>
                              <Button appearance="subtle" compact onClick={() => setSnoozeFor(card.ref)} onFocus={focus} aria-expanded={snoozeFor === card.ref}>Snooze <kbd className="dw2-key" aria-hidden="true">s</kbd></Button>
                            </span>
                            <Button appearance="primary" compact onClick={() => open('accept', [card.ref])} onFocus={focus}>Accept <kbd className="dw2-key" aria-hidden="true">a</kbd></Button>
                          </>
                        )}
                        footer={(
                          <>
                            {snoozeFor === card.ref && isOpen && <SnoozeStep cardRef={card.ref} onSubmit={(note) => deferSnooze([card], note)} onCancel={cancelSnooze} />}
                            {!isOpen && <LazyHistory cardRef={card.ref} />}
                            {errors[card.ref] && <SectionMessage appearance="error"><p>{errors[card.ref]}</p></SectionMessage>}
                          </>
                        )}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}

        {load.status === 'ready' && next && (
          <div className="dw2-more-row">
            <Button onClick={loadMore} busy={moreState === 'loading'}>Load more</Button>
            {moreState !== 'idle' && moreState !== 'loading' && (
              <SectionMessage appearance="error"><p>{moreState} <Button compact onClick={loadMore}>Retry</Button></p></SectionMessage>
            )}
          </div>
        )}
      </div>
      {rail}

      {dialog?.kind === 'help' && <HelpDialog onClose={closeDialog} />}
      {dialog?.kind === 'card' && <CardDialog cardRef={dialog.refs[0]} onClose={closeDialog} />}
      {dialog?.kind === 'accept' && dialogCards[0] && (
        <AcceptDialog
          card={dialogCards[0]} onClose={closeDialog} onFailed={(ref, m) => fail([ref], m)} onBeforeSubmit={cw.flush}
          onDone={(card) => {
            const c = card ?? dialogCards[0];
            closeDialog(); leave([c], 'accepted');
            cw.notify(<>{c.ref} accepted{c.issue_ref && <> as {c.issue_url ? <a href={c.issue_url} target="_blank" rel="noreferrer noopener">{c.issue_ref}</a> : c.issue_ref}</>}.</>);
          }}
        />
      )}
      {dialog?.kind === 'merge' && dialogCards[0] && (
        <MergeDialog
          card={dialogCards[0]} openCards={flat.filter((c) => c.status === 'open')} onClose={closeDialog} onFailed={(ref, m) => fail([ref], m)} onBeforeSubmit={cw.flush}
          onDone={(card) => {
            const c = card ?? dialogCards[0];
            closeDialog(); leave([c], 'merged');
            cw.notify(`${c.ref} merged${c.merged_into ? ` into ${c.merged_into}` : ''}.`);
          }}
        />
      )}
      {dialog?.kind === 'reject' && dialogCards.length > 0 && (
        <RejectDialog
          cards={dialogCards} onClose={closeDialog}
          onSubmit={(decision) => { closeDialog(); deferReject(dialogCards, decision); }}
        />
      )}
      <ToastRegion cw={cw} />
    </main>
  );
}

function Skeleton() {
  return (
    <div className="dw2-skeleton" role="status" aria-label="Loading the inbox" aria-busy="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="dw2-skeleton__row">
          <div className="dw-skel dw2-sk dw2-sk--meta" />
          <div className="dw-skel dw2-sk dw2-sk--title" />
          <div className="dw-skel dw2-sk dw2-sk--line" />
          <div className="dw-skel dw2-sk dw2-sk--line dw2-sk--short" />
        </div>
      ))}
    </div>
  );
}

function GroupHead({ group, leaving }) {
  const counts = { new: 0, grew: 0, reopened: 0 };
  // Only items still waiting for a decision carry a change marker.
  for (const c of group.items) if (c.status === 'open' && !leaving.has(c.ref)) counts[changeOf(c, group)] += 1;
  const parts = Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${CHANGE_LABELS[k].toLowerCase()}`);
  return (
    <div className="dw2-ghead">
      <h2 className="dw2-eyebrow" id={`dw-g-${group.run_id}`} title={group.head_sha ? `Push at ${group.head_sha.slice(0, 7)}, run ${group.run_id}` : `Run ${group.run_id}`}>
        Push of {formatShort(group.at)}
      </h2>
      {parts.length > 0 && <span className="dw2-ghead__counts">{parts.join(' · ')}</span>}
    </div>
  );
}

/** The healthiest state is empty, and when the person got it there it says so. */
function EmptyState({ status, lens, lastPush, tally }) {
  const what = `${STATUS_LABELS[status].toLowerCase()} proposals${lens ? ` for ${LENS_LABELS[lens]}` : ''}`;
  const lastLine = (
    <>
      {lastPush === undefined && <p className="dw2-empty__sub">Checking the last push&hellip;</p>}
      {lastPush && (
        <p className="dw2-empty__sub">
          The last push was run {lastPush.run_id} on {formatDate(lastPush.at)}
          {lastPush.lenses.length > 0 && <> ({lastPush.lenses.map((l) => LENS_LABELS[l] ?? l).join(', ')})</>}.
        </p>
      )}
      {lastPush === null && <p className="dw2-empty__sub">No push has reached this inbox yet.</p>}
    </>
  );
  const scan = <p className="dw2-empty__sub">To file new proposals, run a scan: <code>/dowser</code> in Claude Code or Codex, in the repository.</p>;
  if (status === 'open' && !lens) {
    const parts = [['accepted', 'accepted'], ['rejected', 'rejected'], ['snoozed', 'snoozed'], ['merged', 'merged']].filter(([k]) => tally[k] > 0).map(([k, w]) => `${tally[k]} ${w}`);
    return (
      <section className="dw2-empty" role="status" aria-label="Queue is empty">
        {tally.total > 0 ? (
          <>
            <h2>Queue cleared.</h2>
            <p>You decided {plural(tally.total, 'proposal')} this session: {parts.join(', ')}. Nothing is waiting on you.</p>
          </>
        ) : (
          <>
            <h2>Nothing waiting on you.</h2>
            <p>Every proposal in this inbox has been decided.</p>
          </>
        )}
        {lastLine}
        {scan}
      </section>
    );
  }
  return (
    <section className="dw2-empty" role="status">
      <h2>No {what} here.</h2>
      {lastLine}
      {scan}
    </section>
  );
}
