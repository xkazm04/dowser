// The inbox: a queue list you scan and a reading pane you decide in (chosen in the forge-ui-prototypes spark,
// 2026-10-28). Filters, groups by push, paging, bulk actions, undo windows (useCommitWindow) and the deep link work as
// before the redesign. The selection IS the keyboard focus and drives the pane; after a decision the selection moves
// to the next row; below 900px the pane becomes an accordion under the selected row.
// This file is the composition: the page's selection state, the hooks and the layout. Data and filters are in
// useInboxData, the decisions and undo windows in useVerdicts, the focus in useInboxFocus, the keys in useInboxKeys.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { call } from '../../api.js';
import { ErrorState } from '../../components/ui.jsx';
import { ToastRegion } from '../../components/Toast.jsx';
import { useCommitWindow } from '../../components/useCommitWindow.js';
import { changeOf } from '../../components/labels.js';
import { deepLink } from '../../components/deeplink.js';
import { InboxDialogs } from './InboxDialogs.jsx';
import { InboxList } from './InboxList.jsx';
import { ReadingPane } from './ReadingPane.jsx';
import { Toolbar } from './Toolbar.jsx';
import { EmptyState, LoadingBody } from './states.jsx';
import { useInboxData } from './useInboxData.js';
import { useInboxFocus } from './useInboxFocus.js';
import { useInboxKeys } from './useInboxKeys.js';
import { useVerdicts } from './useVerdicts.js';

const WIDE = '(min-width: 900px)';

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
// decided, reopened, or is not new), once per card+status, after a short pause so holding j/k does not call. Only
// a loaded history is cached: a failure shows 'error' until the card is selected again or Retry is pressed.
const histCache = new Map();
function useHistory(card, need) {
  const key = card ? `${card.ref}:${card.status}` : '';
  const [failed, setFailed] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [, bump] = useState(0);
  useEffect(() => {
    setFailed('');
    if (!card || !need || histCache.has(key)) return undefined;
    let live = true;
    const t = setTimeout(() => {
      call('proposal.get', { ref: card.ref }).then(
        (r) => { histCache.set(key, r.history ?? []); if (live) bump((n) => n + 1); },
        () => { if (live) setFailed(key); },
      );
    }, 180);
    return () => { live = false; clearTimeout(t); };
  }, [key, need, card, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  if (!card || !need) return { history: undefined, retry };
  return { history: histCache.get(key) ?? (failed === key ? 'error' : 'loading'), retry };
}

export default function Inbox({ context }) {
  const [focusRef, setFocusRef] = useState('');
  const [focusReq, setFocusReq] = useState('');
  const [snoozeFor, setSnoozeFor] = useState(''); // a card ref, or BULK for the bulk bar's step
  const [expanded, setExpanded] = useState(true);
  const [dialog, setDialog] = useState(/** @type {{kind: string, refs: string[]} | null} */ (null));
  const [link, setLink] = useState(/** @type {import('../../components/deeplink.js').InboxLink | undefined} */ (undefined));
  const cw = useCommitWindow();
  const wide = useWide();
  // The deep link (`?ref=` one card, or `?project=&lens=&area=` a map cell's filters) is read before the first load.
  useEffect(() => {
    let live = true;
    deepLink(context).then((l) => { if (live) setLink(l); }, () => { if (live) setLink({}); });
    return () => { live = false; };
  }, [context]);
  const verdicts = useVerdicts({ cw, setFocusRef, setFocusReq, setSnoozeFor });
  const data = useInboxData({
    cw, removed: verdicts.removed, leaving: verdicts.leaving, onReset: () => { verdicts.reset(); setSnoozeFor(''); setFocusRef(''); }, link,
  });
  const { load, visible, shown, flat, byRef, groupOf, next } = data;
  const { rowEls, paneScroll, focusIndex, moveFocus } = useInboxFocus({
    linkRef: link === undefined ? undefined : (link.ref ?? ''), filters: data.filters, pin: data.pin, loadStatus: load.status, flat, byRef,
    removed: verdicts.removed, leaving: verdicts.leaving, focusRef, setFocusRef, focusReq, setFocusReq, dialog, setDialog, snoozeFor,
  });

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

  useInboxKeys({
    dialog, setDialog, flat, focusIndex, selected: verdicts.selected, byRef, moveFocus, setExpanded, toggle: verdicts.toggle, open, setSnoozeFor, cw,
  });

  const dialogCards = (dialog?.refs ?? []).map((r) => byRef.get(r)).filter(Boolean);
  const selectedVisible = [...verdicts.selected].filter((r) => byRef.has(r));
  const closeDialog = () => setDialog(null);
  const tally = useMemo(() => {
    const t = { accepted: 0, rejected: 0, snoozed: 0, merged: 0, total: 0 };
    for (const v of verdicts.decided.values()) { t[v] += 1; t.total += 1; }
    return t;
  }, [verdicts.decided]);

  const current = byRef.get(focusRef);
  const currentGroup = current ? groupOf.get(current.ref) : undefined;
  const currentChange = current && currentGroup ? changeOf(current, currentGroup) : undefined;
  const needHistory = Boolean(current && (current.status !== 'open' || current.reopened || currentChange !== 'new'));
  const { history, retry: retryHistory } = useHistory(current, needHistory);

  const actions = {
    accept: (c) => open('accept', [c.ref]),
    merge: (c) => open('merge', [c.ref]),
    reject: (c) => open('reject', [c.ref]),
    snooze: (c) => { setFocusRef(c.ref); setSnoozeFor(c.ref); },
    snoozeSubmit: (c, note, until) => verdicts.deferSnooze([c], note, until),
    snoozeCancel: cancelSnooze,
  };

  const ready = load.status === 'ready';
  const hasRows = ready && shown.length > 0;
  return (
    <main className={`dwr-root${wide ? ' dwr-root--wide' : ''}`}>
      <Toolbar
        inboxes={data.inboxes} decided={verdicts.decided} projectKey={data.projectKey} onProject={data.setProjectKey} status={data.status}
        onStatus={data.setStatus} lens={data.lens} onLens={data.setLens} area={data.area} onClearArea={() => data.setArea('')} pretriaged={data.pretriaged} onPretriaged={data.setPretriaged} onHelp={() => setDialog({ kind: 'help', refs: [] })}
      />
      <h1 className="dwr-visually-hidden">Dowser inbox</h1>

      {load.status === 'loading' && <LoadingBody wide={wide} />}
      {load.status === 'error' && <div className="dwr-state"><ErrorState what="The inbox" error={load.error} onRetry={data.reload} /></div>}
      {ready && !hasRows && !next && <div className="dwr-state"><EmptyState status={data.status} lens={data.lens} lastPush={data.lastPush} tally={tally}
        area={data.projectKey ? data.area : ''} onClearArea={() => data.setArea('')} pretriaged={data.pretriaged} onClearPretriaged={() => data.setPretriaged(false)} /></div>}

      {ready && (hasRows || next) && (
        <div className="dwr-body">
          <InboxList
            visible={visible} leaving={verdicts.leaving} selected={verdicts.selected} selectedVisible={selectedVisible} byRef={byRef}
            focusRef={focusRef} wide={wide} expanded={expanded} history={history} onHistoryRetry={retryHistory} errors={verdicts.errors} snoozeFor={snoozeFor}
            setSnoozeFor={setSnoozeFor} setSelected={verdicts.setSelected} actions={actions} open={open} deferSnooze={verdicts.deferSnooze}
            toggle={verdicts.toggle} select={select} rowEls={rowEls} next={next} moreState={data.moreState} loadMore={data.loadMore}
          />
          {wide && (
            <ReadingPane
              current={current} currentChange={currentChange} history={history} onHistoryRetry={retryHistory} paneScroll={paneScroll} snoozeFor={snoozeFor}
              errors={verdicts.errors} actions={actions}
            />
          )}
        </div>
      )}

      <InboxDialogs
        dialog={dialog} dialogCards={dialogCards} flat={flat} closeDialog={closeDialog} fail={verdicts.fail} leave={verdicts.leave}
        deferReject={verdicts.deferReject} cw={cw}
      />
      <ToastRegion cw={cw} />
    </main>
  );
}
