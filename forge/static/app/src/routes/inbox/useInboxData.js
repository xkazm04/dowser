// The inbox data: the filters, the list as loaded (groups by push, paged), the reload and "Load more", the views of
// it the page reads (without the cards that left), and the last push the empty view names.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { call } from '../../api.js';

/**
 * Append a page of groups; a group split across the page boundary (same run_id) is joined. A card already listed
 * (a linked card pinned before its page loaded) is not listed twice: the page's copy leaves the pinned group.
 */
function appendGroups(prev, more) {
  const incoming = new Set(more.flatMap((g) => (g.items ?? []).map((c) => c.ref)));
  const out = prev.map((g) => ({ ...g, items: g.linked ? g.items.filter((c) => !incoming.has(c.ref)) : [...g.items] }))
    .filter((g) => !g.linked || g.items.length > 0);
  for (const g of more) {
    const last = out[out.length - 1];
    if (last && !last.linked && last.run_id === g.run_id) last.items.push(...(g.items ?? []));
    else out.push({ ...g, items: [...(g.items ?? [])] });
  }
  return out;
}

/** The group a linked card outside the loaded pages is shown in, above the pages. */
export const LINKED = 'linked';

/**
 * @param {{cw: {flush: () => void}, removed: Set<string>, leaving: Set<string>, onReset: () => void,
 *   link: import('../../components/deeplink.js').InboxLink | undefined}} page
 *   `removed` and `leaving` hide decided cards from the views; `onReset` clears the page's decisions and selection
 *   when a reload starts. `link` is the deep link (undefined until it is read): its project, lens and area are the
 *   first filters, and nothing loads before it is read.
 */
export function useInboxData({ cw, removed, leaving, onReset, link }) {
  const [projectKey, setProjectKeyRaw] = useState('');
  const [status, setStatus] = useState('open');
  const [lens, setLens] = useState('');
  const [area, setArea] = useState('');
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    // once the link is read: seed the filters, then the first load runs
    if (!link || seeded) return;
    if (link.project_key) setProjectKeyRaw(link.project_key);
    if (link.lens) setLens(link.lens);
    if (link.area) setArea(link.area);
    setSeeded(true);
  }, [link, seeded]);
  // An area belongs to one inbox: picking another inbox drops it.
  const setProjectKey = useCallback((/** @type {string} */ k) => { setProjectKeyRaw(k); setArea(''); }, []);
  const [pretriaged, setPretriaged] = useState(false);
  const [load, setLoad] = useState(/** @type {{status: 'loading'|'ready'|'error', error?: any}} */ ({ status: 'loading' }));
  const [inboxes, setInboxes] = useState(/** @type {any[]} */ ([]));
  const [groups, setGroups] = useState(/** @type {any[]} */ ([]));
  const [next, setNext] = useState(/** @type {string | undefined} */ (undefined));
  const [moreState, setMoreState] = useState(/** @type {'idle'|'loading'|string} */ ('idle'));
  const [lastPush, setLastPush] = useState(/** @type {{run_id: string, at: string, lenses: string[]} | null | undefined} */ (undefined));
  const seq = useRef(0);

  const filters = useMemo(() => {
    /** @type {{project_key?: string, status?: string, lens?: string, area?: string, pretriaged?: boolean}} */
    const f = { status };
    if (projectKey) f.project_key = projectKey;
    if (lens) f.lens = lens;
    if (projectKey && area) f.area = area;
    if (pretriaged) f.pretriaged = true;
    return f;
  }, [projectKey, status, lens, area, pretriaged]);

  const reload = useCallback(() => {
    const mine = ++seq.current;
    cw.flush();
    setLoad({ status: 'loading' });
    onReset(); setLastPush(undefined);
    setMoreState('idle');
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
  useEffect(() => { if (seeded) reload(); }, [reload, seeded]);

  /**
   * Show a linked card that is not in the loaded pages above them, so it can be decided where the link lands. A
   * later page that holds it takes it back (appendGroups); a reload drops it.
   * @param {any} card
   */
  const pin = useCallback((card) => {
    setGroups((prev) => (prev.some((g) => g.items.some((c) => c.ref === card.ref))
      ? prev
      : [{ run_id: LINKED, at: card.last_push_at, linked: true, items: [card] }, ...prev]));
  }, []);

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

  return {
    projectKey, setProjectKey, status, setStatus, lens, setLens, area, setArea, pretriaged, setPretriaged, load, inboxes, next, moreState, lastPush,
    reload, loadMore, pin, filters, visible, shown, flat, byRef, groupOf,
  };
}
