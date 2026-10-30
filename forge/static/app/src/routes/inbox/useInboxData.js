// The inbox data: the filters, the list as loaded (groups by push, paged), the reload and "Load more", the views of
// it the page reads (without the cards that left), and the last push the empty view names.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { call } from '../../api.js';

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

/**
 * @param {{cw: {flush: () => void}, removed: Set<string>, leaving: Set<string>, onReset: () => void}} page
 *   `removed` and `leaving` hide decided cards from the views; `onReset` clears the page's decisions and selection
 *   when a reload starts.
 */
export function useInboxData({ cw, removed, leaving, onReset }) {
  const [projectKey, setProjectKey] = useState('');
  const [status, setStatus] = useState('open');
  const [lens, setLens] = useState('');
  const [pretriaged, setPretriaged] = useState(false);
  const [load, setLoad] = useState(/** @type {{status: 'loading'|'ready'|'error', error?: any}} */ ({ status: 'loading' }));
  const [inboxes, setInboxes] = useState(/** @type {any[]} */ ([]));
  const [groups, setGroups] = useState(/** @type {any[]} */ ([]));
  const [next, setNext] = useState(/** @type {string | undefined} */ (undefined));
  const [moreState, setMoreState] = useState(/** @type {'idle'|'loading'|string} */ ('idle'));
  const [lastPush, setLastPush] = useState(/** @type {{run_id: string, at: string, lenses: string[]} | null | undefined} */ (undefined));
  const seq = useRef(0);

  const filters = useMemo(() => {
    /** @type {{project_key?: string, status?: string, lens?: string, pretriaged?: boolean}} */
    const f = { status };
    if (projectKey) f.project_key = projectKey;
    if (lens) f.lens = lens;
    if (pretriaged) f.pretriaged = true;
    return f;
  }, [projectKey, status, lens, pretriaged]);

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
    projectKey, setProjectKey, status, setStatus, lens, setLens, pretriaged, setPretriaged, load, inboxes, next, moreState, lastPush, reload, loadMore,
    visible, shown, flat, byRef, groupOf,
  };
}
