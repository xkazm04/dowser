// The inbox: a queue list you scan and a reading pane you decide in (chosen in the forge-ui-prototypes spark,
// 2026-10-28). Filters, groups by push, paging, bulk actions, undo windows (useCommitWindow) and the deep link work as
// before the redesign. The selection IS the keyboard focus and drives the pane; after a decision the selection moves
// to the next row; below 900px the pane becomes an accordion under the selected row.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { call } from '../../api.js';
import { Button, Dialog, ErrorState, Lozenge, SectionMessage } from '../../components/ui.jsx';
import { Mark, EmptyArt } from '../../components/Brand.jsx';
import { ToastRegion } from '../../components/Toast.jsx';
import { useCommitWindow } from '../../components/useCommitWindow.js';
import { CardDialog } from '../../components/CardDialog.jsx';
import { deepLinkRef } from '../../components/deeplink.js';
import {
  CHANGE_LABELS, LENSES, LENS_LABELS, REASON_LABELS, STATUSES, STATUS_APPEARANCE, STATUS_LABELS, changeOf, formatDate, plural,
} from '../../components/labels.js';
import { AcceptDialog, MergeDialog, RejectDialog, SnoozeStep } from './dialogs.jsx';
import { Detail } from './Detail.jsx';
import { Kbd, LENS_SHORT, LensDot, RowSignals } from './parts.jsx';

const EXIT_MS = 200;
const CHANGE_SHORT = { new: 'New', grew: 'Grew', reopened: 'Reopened' };
const WIDE = '(min-width: 900px)';

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

function useWide() {
  const [wide, setWide] = useState(() => (typeof window.matchMedia === 'function' ? window.matchMedia(WIDE).matches : true));
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const m = window.matchMedia(WIDE);
    const on = () => setWide(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return wide;
}

// Triage history is not on inbox.list. It is fetched for the selected proposal only when it can have one (it was
// decided, reopened, or is not new), once per card+status, after a short pause so holding j/k does not call.
const histCache = new Map();
function useHistory(card, need) {
  const key = card ? `${card.ref}:${card.status}` : '';
  const [, bump] = useState(0);
  useEffect(() => {
    if (!card || !need || histCache.has(key)) return undefined;
    let live = true;
    const t = setTimeout(() => {
      call('proposal.get', { ref: card.ref }).then(
        (r) => { histCache.set(key, r.history ?? []); if (live) bump((n) => n + 1); },
        () => { histCache.set(key, 'error'); if (live) bump((n) => n + 1); },
      );
    }, 180);
    return () => { live = false; clearTimeout(t); };
  }, [key, need, card]);
  if (!card || !need) return undefined;
  return histCache.get(key) ?? 'loading';
}

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
  const [expanded, setExpanded] = useState(true);
  const [dialog, setDialog] = useState(/** @type {{kind: string, refs: string[]} | null} */ (null));
  const seq = useRef(0);
  const rowEls = useRef(/** @type {Record<string, HTMLElement | null>} */ ({}));
  const paneScroll = useRef(/** @type {HTMLElement | null} */ (null));
  const exitTimers = useRef(/** @type {Map<string, ReturnType<typeof setTimeout>>} */ (new Map()));
  const [linkRef, setLinkRef] = useState(/** @type {string | undefined} */ (undefined));
  const linkDone = useRef(false);
  const cw = useCommitWindow();
  const wide = useWide();

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
    setMoreState('idle'); setSnoozeFor(''); setFocusRef('');
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

  const visible = useMemo(() => groups
    .map((g) => ({ ...g, items: g.items.filter((c) => !removed.has(c.ref)) }))
    .filter((g) => g.items.length > 0), [groups, removed]);
  const shown = useMemo(() => visible.flatMap((g) => g.items), [visible]);
  const flat = useMemo(() => shown.filter((c) => !leaving.has(c.ref)), [shown, leaving]);
  const byRef = useMemo(() => new Map(shown.map((c) => [c.ref, c])), [shown]);
  const groupOf = useMemo(() => new Map(visible.flatMap((g) => g.items.map((c) => [c.ref, g]))), [visible]);

  // Empty view: name the last push instead of saying "all clear".
  useEffect(() => {
    if (load.status !== 'ready' || shown.length > 0 || next || lastPush !== undefined) return undefined;
    const known = inboxes.filter((i) => (!projectKey || i.project_key === projectKey) && i.last_push)
      .map((i) => i.last_push).sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
    if (known) { setLastPush({ run_id: known.run_id, at: known.at, lenses: [] }); return undefined; }
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

  // Deep link (`inbox?ref=DW-n`): select and scroll to the row; a card outside the loaded page opens read-only.
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
        const el = rowEls.current[linkRef];
        if (el) { el.focus(); el.scrollIntoView?.({ block: 'center' }); }
      });
    } else {
      setDialog({ kind: 'card', refs: [linkRef] });
    }
  }, [linkRef, load.status, byRef]);

  // The first row is selected on arrival (the pane is never empty while there is work); focus is not stolen.
  useEffect(() => {
    if (load.status === 'ready' && !focusRef && flat.length > 0 && !(linkRef && !linkDone.current)) setFocusRef(flat[0].ref);
  }, [load.status, focusRef, flat, linkRef]);

  // Keep the selection valid after removals: it moves to the row now at the same position (the next one).
  const focusIndex = flat.findIndex((c) => c.ref === focusRef);
  const lastIndex = useRef(0);
  useEffect(() => {
    if (focusIndex >= 0) { lastIndex.current = focusIndex; return; }
    if (!focusRef || flat.length === 0) return;
    const ref = flat[Math.min(lastIndex.current, flat.length - 1)].ref;
    setFocusRef(ref);
    if (!dialog && !snoozeFor) rowEls.current[ref]?.focus();
  }, [focusIndex, focusRef, flat, dialog, snoozeFor]);

  // After an Undo (or a failed commit) the card is back; give it the focus once it is in the DOM.
  useEffect(() => {
    if (!focusReq) return;
    const el = rowEls.current[focusReq];
    if (el) { el.focus(); el.scrollIntoView?.({ block: 'nearest' }); setFocusReq(''); }
  }, [focusReq, removed, leaving]);

  // A new selection reads from the top.
  useEffect(() => { if (paneScroll.current) paneScroll.current.scrollTop = 0; }, [focusRef]);

  function moveFocus(delta) {
    if (flat.length === 0) return;
    const i = focusIndex < 0 ? 0 : Math.max(0, Math.min(flat.length - 1, focusIndex + delta));
    const ref = flat[i].ref;
    setFocusRef(ref);
    const el = rowEls.current[ref];
    if (el) { el.focus(); el.scrollIntoView?.({ block: 'nearest' }); }
  }

  function toggle(ref) {
    setSelected((prev) => { const s = new Set(prev); if (s.has(ref)) s.delete(ref); else s.add(ref); return s; });
  }

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
    requestAnimationFrame(() => rowEls.current[ref]?.focus());
  }

  function select(ref) {
    if (ref === focusRef && !wide) setExpanded((v) => !v);
    else { setFocusRef(ref); setExpanded(true); }
    setSnoozeFor('');
  }

  // Keyboard: only when no dialog is open and no text field has focus.
  useEffect(() => {
    function onKey(e) {
      if (dialog || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      const focused = focusIndex >= 0 ? flat[focusIndex] : undefined;
      const actionable = focused && focused.status === 'open';
      const many = [...selected].filter((r) => byRef.has(r));
      switch (e.key) {
        case 'j': moveFocus(1); setExpanded(true); break;
        case 'k': moveFocus(-1); setExpanded(true); break;
        case 'x': if (focused) toggle(focused.ref); else return; break;
        case 'a': if (actionable) open('accept', [focused.ref]); else return; break;
        case 'm': if (actionable) open('merge', [focused.ref]); else return; break;
        case 'r':
          if (many.length > 0) open('reject', many); else if (actionable) open('reject', [focused.ref]); else return;
          break;
        case 's':
          if (many.length > 0) deferSnooze(many.map((r) => byRef.get(r)));
          else if (actionable) { setExpanded(true); setSnoozeFor(focused.ref); } else return;
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

  // Ctrl/Cmd+Enter confirms the open dialog (Accept: "Create issue", Reject: "Reject", Merge): `a` then Ctrl+Enter.
  useEffect(() => {
    if (!dialog) return undefined;
    function onKey(e) {
      // Reject dialog: 1-6 pick the reason (radios and the dialog itself, not the note field).
      if (dialog.kind === 'reject' && /^[1-6]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey
        && !(isTyping(e.target) && !(e.target instanceof HTMLInputElement && e.target.type === 'radio'))) {
        const radio = document.querySelectorAll('dialog.dw-dialog[open] input[name="dw-reason"]')[Number(e.key) - 1];
        if (radio instanceof HTMLElement) { e.preventDefault(); radio.click(); radio.focus(); }
        return;
      }
      if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return;
      const btn = document.querySelector('dialog.dw-dialog[open] .dw-dialog__foot .dw-btn--primary:not(:disabled), dialog.dw-dialog[open] .dw-dialog__foot .dw-btn--danger:not(:disabled)');
      if (btn instanceof HTMLElement) { e.preventDefault(); btn.click(); }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [dialog]);

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

  const current = byRef.get(focusRef);
  const currentGroup = current ? groupOf.get(current.ref) : undefined;
  const currentChange = current && currentGroup ? changeOf(current, currentGroup) : undefined;
  const needHistory = Boolean(current && (current.status !== 'open' || current.reopened || currentChange !== 'new'));
  const history = useHistory(current, needHistory);

  const actions = {
    accept: (c) => open('accept', [c.ref]),
    merge: (c) => open('merge', [c.ref]),
    reject: (c) => open('reject', [c.ref]),
    snooze: (c) => { setFocusRef(c.ref); setSnoozeFor(c.ref); },
    snoozeSubmit: (c, note) => deferSnooze([c], note),
    snoozeCancel: cancelSnooze,
  };

  const ready = load.status === 'ready';
  const hasRows = ready && shown.length > 0;
  return (
    <main className={`dwr-root${wide ? ' dwr-root--wide' : ''}`}>
      <Toolbar
        inboxes={inboxes} decided={decided} projectKey={projectKey} onProject={setProjectKey} status={status} onStatus={setStatus}
        lens={lens} onLens={setLens} onHelp={() => setDialog({ kind: 'help', refs: [] })}
      />
      <h1 className="dwr-visually-hidden">Dowser inbox</h1>

      {load.status === 'loading' && <LoadingBody wide={wide} />}
      {load.status === 'error' && <div className="dwr-state"><ErrorState what="The inbox" error={load.error} onRetry={reload} /></div>}
      {ready && !hasRows && !next && <div className="dwr-state"><EmptyState status={status} lens={lens} lastPush={lastPush} tally={tally} /></div>}

      {ready && (hasRows || next) && (
        <div className="dwr-body">
          <section className="dwr-list" aria-label="Proposals">
            {selectedVisible.length > 0 && (
              <div className="dwr-bulk" role="region" aria-label="Bulk actions">
                <strong>{selectedVisible.length} checked</strong>
                <Button appearance="danger" compact onClick={() => open('reject', selectedVisible)}>Reject <Kbd>r</Kbd></Button>
                <Button compact onClick={() => deferSnooze(selectedVisible.map((r) => byRef.get(r)))}>Snooze <Kbd>s</Kbd></Button>
                <span className="dwr-spacer" />
                <Button appearance="subtle" compact onClick={() => setSelected(new Set())}>Clear</Button>
              </div>
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

          {wide && (
            <section className="dwr-pane" aria-label="Selected proposal">
              {current ? (
                <>
                  <div className="dwr-pane__scroll" ref={paneScroll}>
                    <div className="dwr-pane__in">
                      <Detail card={current} change={currentChange} history={history} titleId={`dwr-t-${current.ref}`} />
                    </div>
                  </div>
                  <Decide card={current} snoozing={snoozeFor === current.ref} error={errors[current.ref]} actions={actions} />
                </>
              ) : <p className="dwr-pane__none">Select a proposal to read it.</p>}
            </section>
          )}
        </div>
      )}

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

// ---- toolbar -------------------------------------------------------------------------------------------------

/** The counts as loaded, moved by the decisions made since: every listed card had the filtered status. */
function summarise(inboxes, projectKey, status, decided) {
  const list = (inboxes ?? []).filter((i) => !projectKey || i.project_key === projectKey);
  // by_status is newer than open: an older backend sends only open, and the other segments then show no count.
  const by = Object.fromEntries(STATUSES.map((s) => [s, list.some((i) => i.by_status) ? list.reduce((n, i) => n + (i.by_status?.[s] ?? 0), 0) : undefined]));
  by.open = list.reduce((n, i) => n + (i.open ?? 0), 0);
  for (const to of decided?.values() ?? []) {
    if (by[status] !== undefined) by[status] -= 1;
    if (by[to] !== undefined) by[to] += 1;
  }
  const last = list.map((i) => i.last_push).filter(Boolean).sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
  return { by, last, count: list.length };
}

function Toolbar({ inboxes, decided, projectKey, onProject, status, onStatus, lens, onLens, onHelp }) {
  const { by, last, count } = summarise(inboxes, projectKey, status, decided);
  return (
    <header className="dwr-toolbar">
      <span className="dwr-toolbar__mark"><Mark size={16} /></span>
      {inboxes.length > 0 && (
        <label className="dwr-field">
          <span className="dwr-visually-hidden">Inbox</span>
          <select className="dwr-select" value={projectKey} onChange={(e) => onProject(e.target.value)}>
            <option value="">All inboxes</option>
            {inboxes.map((i) => <option key={i.project_key} value={i.project_key}>{i.project_key.split('/').pop()} ({i.open} open)</option>)}
          </select>
        </label>
      )}
      <div className="dwr-seg" role="group" aria-label="Filter by status">
        {STATUSES.map((s) => (
          <button key={s} type="button" className="dwr-seg__btn" aria-pressed={status === s} onClick={() => onStatus(s)}>
            {STATUS_LABELS[s]}{inboxes.length > 0 && by[s] !== undefined && <span className="dwr-seg__n">{by[s]}</span>}
          </button>
        ))}
      </div>
      <label className="dwr-field">
        <span className="dwr-visually-hidden">Lens</span>
        <select className="dwr-select" value={lens} onChange={(e) => onLens(e.target.value)} aria-label="Filter by lens">
          <option value="">All lenses</option>
          {LENSES.map((l) => <option key={l} value={l}>{LENS_LABELS[l]}</option>)}
        </select>
      </label>
      <span className="dwr-spacer" />
      <p className="dwr-runline" aria-label="Run summary">
        {last
          ? <>Last push {shortWhen(last.at)} · {last.created ?? 0} new, {last.updated ?? 0} updated</>
          : <>No push has reached {count > 1 ? 'these inboxes' : 'this inbox'} yet</>}
      </p>
      <button type="button" className="dwr-iconbtn" onClick={onHelp} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">?</button>
    </header>
  );
}

// ---- list ----------------------------------------------------------------------------------------------------

/** "28 Oct, 19:21": several pushes a day are common, so the time is what tells them apart; the year is noise. */
const shortWhen = (iso) => formatDate(iso).replace(/ \d{4}/, '');

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

// ---- decision bar --------------------------------------------------------------------------------------------

function Decide({ card, snoozing, error, actions, sticky = false }) {
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
        <SnoozeStep cardRef={card.ref} onSubmit={(note) => actions.snoozeSubmit(card, note)} onCancel={actions.snoozeCancel} />
      )}
      {!isOpen && <p className="dwr-decide__done">Already decided.</p>}
    </div>
  );
}

// ---- states --------------------------------------------------------------------------------------------------

function LoadingBody({ wide }) {
  return (
    <div className="dwr-body" role="status" aria-label="Loading the inbox" aria-busy="true">
      <div className="dwr-list">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="dwr-skelrow"><div className="dw-skel dwr-skel-a" /><div className="dw-skel dwr-skel-b" /></div>
        ))}
      </div>
      {wide && (
        <div className="dwr-pane">
          <div className="dwr-pane__scroll"><div className="dwr-pane__in">
            <div className="dw-skel" style={{ height: 12, width: 180, marginBottom: 12 }} />
            <div className="dw-skel" style={{ height: 24, width: '70%', marginBottom: 16 }} />
            <div className="dw-skel" style={{ height: 56, marginBottom: 16 }} />
            <div className="dw-skel" style={{ height: 160 }} />
          </div></div>
        </div>
      )}
    </div>
  );
}

/** The healthiest state is empty, and when the person got it there it says so. */
function EmptyState({ status, lens, lastPush, tally }) {
  const what = `${STATUS_LABELS[status].toLowerCase()} proposals${lens ? ` for ${LENS_LABELS[lens]}` : ''}`;
  const lastLine = (
    <>
      {lastPush === undefined && <p className="dwr-muted">Checking the last push...</p>}
      {lastPush && (
        <p className="dwr-muted">
          The last push was run {lastPush.run_id} on {formatDate(lastPush.at)}
          {lastPush.lenses.length > 0 && <> ({lastPush.lenses.map((l) => LENS_LABELS[l] ?? l).join(', ')})</>}.
        </p>
      )}
      {lastPush === null && <p className="dwr-muted">No push has reached this inbox yet.</p>}
    </>
  );
  if (status === 'open' && !lens) {
    const parts = [['accepted', 'accepted'], ['rejected', 'rejected'], ['snoozed', 'snoozed'], ['merged', 'merged']].filter(([k]) => tally[k] > 0).map(([k, w]) => `${tally[k]} ${w}`);
    return (
      <section className="dwr-empty" role="status" aria-label="Queue is empty">
        <EmptyArt />
        {tally.total > 0 ? (
          <>
            <h2 className="dwr-empty__h">Queue cleared.</h2>
            <p>You decided {plural(tally.total, 'proposal')} this session: {parts.join(', ')}. Nothing is waiting on you.</p>
          </>
        ) : (
          <>
            <h2 className="dwr-empty__h">Nothing waiting on you.</h2>
            <p>Every proposal in this inbox has been decided.</p>
          </>
        )}
        {lastLine}
        <p className="dwr-muted">To file new proposals, run a scan: <code>/dowser</code> in Claude Code or Codex, in the repository.</p>
      </section>
    );
  }
  return (
    <SectionMessage appearance="information" title={`No ${what} here.`} role="status">
      {lastLine}
      <p style={{ marginTop: 8 }}>To file new proposals, run a scan: <code>/dowser</code> in Claude Code or Codex, in the repository. Verified proposals are pushed here.</p>
    </SectionMessage>
  );
}

const KEYS = [
  ['j / k', 'Move to the next / previous proposal; the pane follows'],
  ['x', 'Check or uncheck the proposal for a bulk action'],
  ['a', 'Accept; then Ctrl+Enter creates the issue'],
  ['r', 'Reject (all checked, when some are checked); 1 to 6 picks the reason, Ctrl+Enter confirms'],
  ['s', 'Snooze, with an optional note, Enter to confirm (all checked, when some are checked: no note)'],
  ['m', 'Merge'],
  ['u', 'Undo the last snooze or reject while its notice is showing'],
  ['?', 'Show this help'],
];

function HelpDialog({ onClose }) {
  return (
    <Dialog title="Keyboard shortcuts" onClose={onClose} footer={<Button appearance="primary" onClick={onClose} autoFocus>Close</Button>}>
      <table className="dw-table">
        <tbody>
          {KEYS.map(([k, what]) => <tr key={k}><td><span className="dw-kbd">{k}</span></td><td>{what}</td></tr>)}
        </tbody>
      </table>
      <p className="dw-subtlest">Shortcuts work when no dialog or text field has focus. After a decision the next proposal is selected.</p>
    </Dialog>
  );
}
