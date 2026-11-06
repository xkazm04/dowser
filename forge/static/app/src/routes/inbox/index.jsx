// The inbox: a queue list you scan and a reading pane you decide in (chosen in the forge-ui-prototypes spark,
// 2026-10-28). Filters, groups by push, paging, bulk actions, undo windows (useCommitWindow) and the deep link work as
// before the redesign. The selection IS the keyboard focus and drives the pane; after a decision the selection moves
// to the next row; below 900px the pane becomes an accordion under the selected row.
// This file is the composition: the triage reducer (triage.js: the decided cards, the checked set, the selection,
// the snooze step and the dialog), the hooks and the layout. Data and filters are in useInboxData, the decisions'
// timers and undo windows in useVerdicts, the DOM focus in useInboxFocus, the keys in useInboxKeys.
import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
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
import { FirstRun } from './FirstRun.jsx';
import { SampleStrip, sampleShown } from '../../components/SampleStrip.jsx';
import { useInboxData } from './useInboxData.js';
import { useInboxFocus } from './useInboxFocus.js';
import { useInboxKeys } from './useInboxKeys.js';
import { useVerdicts } from './useVerdicts.js';
import { checkedVisible, initialTriage, phaseSets, snoozingRef, tallyOf, triage } from './triage.js';

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
  const [tri, dispatch] = useReducer(triage, undefined, initialTriage);
  const { focus: focusRef, expanded, dialog } = tri;
  const [link, setLink] = useState(/** @type {import('../../components/deeplink.js').InboxLink | undefined} */ (undefined));
  const cw = useCommitWindow();
  const wide = useWide();
  // The deep link (`?ref=` one card, or `?project=&lens=&area=` a map cell's filters) is read before the first load.
  useEffect(() => {
    let live = true;
    deepLink(context).then((l) => { if (live) setLink(l); }, () => { if (live) setLink({}); });
    return () => { live = false; };
  }, [context]);
  // the rows listed now, read when a decision moves the selection along them
  const order = useRef(/** @type {string[]} */ ([]));
  const verdicts = useVerdicts({ cw, dispatch, order: () => order.current });
  const { leaving, removed } = useMemo(() => phaseSets(tri), [tri.decided]);
  const data = useInboxData({ cw, removed, leaving, onReset: verdicts.reset, link });
  const { load, visible, shown, flat, byRef, groupOf, next } = data;
  order.current = flat.map((c) => c.ref);
  const { rowEls, paneScroll, focusIndex, moveFocus, loadMoreFromList } = useInboxFocus({
    linkRef: link === undefined ? undefined : (link.ref ?? ''), filters: data.filters, pin: data.pin, hasMore: Boolean(next), loadMore: data.loadMore, loadStatus: load.status, flat, byRef, tri, dispatch,
  });

  /** @param {string} kind @param {string[]} refs */
  const open = (kind, refs) => dispatch({ type: 'openDialog', kind, refs });
  const snoozeFor = snoozingRef(tri);

  function cancelSnooze() {
    const ref = snoozeFor;
    dispatch({ type: 'closeSnooze' });
    requestAnimationFrame(() => rowEls.current[ref]?.focus());
  }

  /** @param {string} ref */
  const select = (ref) => dispatch({ type: 'select', ref, wide });

  useInboxKeys({ tri, dispatch, flat, focusIndex, byRef, moveFocus, cw });

  const dialogCards = (dialog?.refs ?? []).map((r) => byRef.get(r)).filter(Boolean);
  const checked = checkedVisible(tri, byRef);
  const closeDialog = () => dispatch({ type: 'closeDialog' });
  const tally = useMemo(() => tallyOf(tri), [tri.decided]);

  const current = byRef.get(focusRef);
  const currentGroup = current ? groupOf.get(current.ref) : undefined;
  const currentChange = current && currentGroup ? changeOf(current, currentGroup) : undefined;
  const needHistory = Boolean(current && (current.status !== 'open' || current.reopened || currentChange !== 'new'));
  const { history, retry: retryHistory } = useHistory(current, needHistory);

  const actions = {
    accept: (c) => open('accept', [c.ref]),
    merge: (c) => open('merge', [c.ref]),
    reject: (c) => open('reject', [c.ref]),
    snooze: (c) => dispatch({ type: 'openSnooze', ref: c.ref }),
    snoozeSubmit: (c, note, until) => verdicts.deferSnooze([c], note, until),
    snoozeCancel: cancelSnooze,
  };

  const ready = load.status === 'ready';
  const hasRows = ready && shown.length > 0;
  // No inbox at all: the first-run panel, never the "all decided" empty state.
  const firstRun = ready && data.inboxes.length === 0;
  const sample = sampleShown(data.inboxes, data.projectKey);
  /** Select the inbox (here: the sample, after it loaded or was removed) and load it; a same-key pick reloads. */
  const showInbox = (key) => { if (key === data.projectKey) data.reload(); else data.setProjectKey(key); };
  return (
    <main className={`dwr-root${wide ? ' dwr-root--wide' : ''}`}>
      <Toolbar
        inboxes={data.inboxes} decided={tri.decided} projectKey={data.projectKey} onProject={data.setProjectKey} status={data.status}
        onStatus={data.setStatus} lens={data.lens} onLens={data.setLens} area={data.area} onClearArea={() => data.setArea('')} pretriaged={data.pretriaged} onPretriaged={data.setPretriaged} onHelp={() => open('help', [])} bare={firstRun}
      />
      <h1 className="dwr-visually-hidden">Dowser inbox</h1>
      {sample && (
        <SampleStrip inbox={sample} context={context} notify={cw.notify} onBeforeRemove={cw.flush} onRemoved={() => showInbox('')} />
      )}

      {load.status === 'loading' && <LoadingBody wide={wide} />}
      {load.status === 'error' && <div className="dwr-state"><ErrorState what="The inbox" error={load.error} onRetry={data.reload} /></div>}
      {firstRun && <div className="dwr-state dwr-state--first"><FirstRun onLoaded={showInbox} /></div>}
      {ready && !firstRun && !hasRows && !next && <div className="dwr-state"><EmptyState status={data.status} lens={data.lens} lastPush={data.lastPush} tally={tally}
        area={data.projectKey ? data.area : ''} onClearArea={() => data.setArea('')} pretriaged={data.pretriaged} onClearPretriaged={() => data.setPretriaged(false)} /></div>}

      {ready && (hasRows || next) && (
        <div className="dwr-body">
          <InboxList
            visible={visible} leaving={leaving} checked={tri.checked} checkedVisible={checked} byRef={byRef}
            focusRef={focusRef} wide={wide} expanded={expanded} history={history} onHistoryRetry={retryHistory} errors={tri.errors} step={tri.step}
            dispatch={dispatch} actions={actions} open={open} deferSnooze={verdicts.deferSnooze}
            select={select} rowEls={rowEls} next={next} moreState={data.moreState} loadMore={loadMoreFromList}
          />
          {wide && (
            <ReadingPane
              current={current} currentChange={currentChange} history={history} onHistoryRetry={retryHistory} paneScroll={paneScroll} snoozeFor={snoozeFor}
              errors={tri.errors} actions={actions} pageCleared={flat.length === 0 && Boolean(next)}
            />
          )}
        </div>
      )}

      <InboxDialogs
        dialog={dialog} dialogCards={dialogCards} flat={flat} decided={new Set(tri.decided.keys())} closeDialog={closeDialog} fail={verdicts.fail} leave={verdicts.leave}
        deferReject={verdicts.deferReject} cw={cw}
      />
      <ToastRegion cw={cw} />
    </main>
  );
}
