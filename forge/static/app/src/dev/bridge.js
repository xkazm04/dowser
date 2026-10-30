// A fake `@forge/bridge` for the dev server. vite.config.js aliases `@forge/bridge` to this file only when
// VITE_DOWSER_FIXTURE=1, so the production bundle never contains it. It serves the ResolverContract keys from
// forge/src/core/types.mjs over in-memory fixture data, and mutates it on verdicts.
//
// URL hash picks the surface and test conditions:
//   #inbox (default) | #settings | #map | #panel (accepted issue SHOP-101) | #panel-none (not from Dowser)
//   &ref=DW-n             deep link: the inbox focuses that card (or opens it when it is not on the page)
//   #byline (Confluence page 90211, two proposals)   &page=<id> another page (48213: one; 1: none)
//   &project=&lens=&area=  deep link: the inbox opens filtered (the map's heat cells link this way)
//   &fail=<resolver key>  that key answers {error, message}     &empty  no proposals at all
//   &failonce=<key>       that key fails only while the page loads (its first second; React's dev StrictMode calls
//                         twice), so a later Retry succeeds
//   <key>:<status>        in fail / failonce: only calls with that status (inbox.list:accepted = the Merge dialog's list)
//   &slow                 every call takes 1.5 s (to see skeletons)
//   #reflect              the Learning tab (`reflect.data`; github.com/acme/shop has data and trust, billing is empty)
//   The latest push of the shop inbox shows the scan-finding/1 order: three MVPs pinned, a ranked card, two in reserve;
//   DW-9 is machine pre-triaged (the toolbar's "Machine pre-triaged" filter keeps it alone).
//   &fail=reflect.data | rule.decide | outcome.record | verdict.snooze | verdict.reject   that call fails
//   #settings             accept targets and Lens direction (shop has Opportunity set)   &fail=direction.set
//   &page=<n>             inbox page size (default 4)     &mode=dark|light   colour mode (default: the OS)
import { setGlobalTheme } from '@atlaskit/tokens/set-global-theme';
import { AREAS, CARDS, GROUP_OF, HISTORY, INBOXES, PROJECTS, PUSHES, REFLECT } from './fixture.js';
import { STATUSES } from '../components/labels.js';

const PAGE = 4; // small on purpose, so "Load more" and a group split across pages are exercised
const params = () => new URLSearchParams(location.hash.slice(1).replace(/^[a-z-]+&?/, ''));
const surface = () => (location.hash.slice(1).match(/^[a-z-]+/) ?? ['inbox'])[0];
let nextIssue = 102;

const cards = structuredClone(CARDS);
const history = structuredClone(HISTORY);
const reflect = structuredClone(REFLECT);
// Lens direction per inbox (direction.get / direction.set); the first inbox has one lens set.
const directions = {
  [INBOXES[0].project_key]: {
    opportunity: { focus: ['checkout', 'CSV and PDF exports'], exclude: ['admin console'], notes: 'This quarter is about retention: fewer drop-offs after the first order.' },
  },
};
const LENS_IDS = ['opportunity', 'ux-friction', 'doc-drift', 'security-cra'];
const EMPTY_REFLECT = { totals: { open: 0, accepted: 0, rejected: 0, snoozed: 0, merged: 0 }, rejects: [], notes: [], pushes: [], lens_yield: [], rules: [], candidates: [], outcomes: [] };

/** An inbox summary as inbox.list / settings.* return it: the open count and the count per status. */
function summary(i) {
  const by_status = Object.fromEntries(STATUSES.map((s) => [s, cards.filter((c) => c.project_key === i.project_key && c.status === s).length]));
  return { ...i, open: by_status.open, by_status };
}
function err(error, message) { return { error, message }; }
/** The areas a card counts in: the longest area prefix of each anchor path and code/doc evidence path. */
function areasOf(c, paths) {
  const touched = [...(c.anchors ?? []).map((a) => String(a).split('#')[0]),
    ...(c.evidence ?? []).filter((e) => e.type === 'code' || e.type === 'doc').map((e) => String(e.ref).replace(/#.*$/, '').replace(/:\d+(?:[-:]\d+)?$/, ''))];
  const out = new Set();
  for (const p of touched) {
    let best;
    for (const a of paths) if ((p === a || p.startsWith(`${a}/`)) && (!best || a.length > best.length)) best = a;
    if (best) out.add(best);
  }
  return out;
}
/**
 * The order inside a push group, as forge/src/core/cards.mjs ORDER: MVPs first, ranked before reserve, the stored
 * score desc with unscored cards after every scored one, then confidence desc (the fixture's array order breaks ties).
 */
const CONF = { high: 0, medium: 1, low: 2 };
function policy(a, b) {
  const key = (c) => [c.mvp ? 0 : 1, c.band === 'reserve' ? 1 : 0, typeof c.score === 'number' ? 0 : 1, -(c.score ?? 0), CONF[c.confidence] ?? 2];
  const ka = key(a);
  const kb = key(b);
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
  return 0;
}
function decide(ref, status, extra = {}) {
  const c = cards.find((x) => x.ref === ref);
  if (!c) throw err('bad-input', `No proposal ${ref}.`);
  if (c.status !== 'open') throw err('bad-input', `${ref} is already ${c.status}.`);
  Object.assign(c, { status }, extra);
  delete c.reopened;
  delete c.change;
  (history[ref] ??= []).push({ fp: c.fp, status, decided_by: 'forge:dev-user', decided_by_name: 'Dev User', decided_at: new Date().toISOString(), external_ref: ref, ...extra });
  return c;
}

const handlers = {
  'inbox.list'({ project_key, status, lens, area, cursor, pretriaged }) {
    if (params().has('empty')) return { inboxes: [], groups: [] };
    if (pretriaged !== undefined && typeof pretriaged !== 'boolean') throw err('bad-input', 'pretriaged must be true or false');
    if (area !== undefined && !project_key) throw err('bad-input', 'area needs project_key: areas belong to one inbox');
    const paths = area !== undefined ? (AREAS[project_key] ?? []).map((a) => a.path) : [];
    const pick = cards.filter((c) => (!project_key || c.project_key === project_key) && (!status || c.status === status) && (!lens || c.lens === lens)
      && (!pretriaged || c.pretriaged_by) && (area === undefined || (paths.includes(area) && areasOf(c, paths).has(area))));
    const ordered = [...PUSHES].sort((a, b) => b.at.localeCompare(a.at))
      .flatMap((p) => pick.filter((c) => GROUP_OF[c.ref] === p.run_id).sort(policy).map((c) => [p, c]));
    const start = cursor ? Number(cursor) : 0;
    if (!Number.isInteger(start) || start < 0 || start > ordered.length) throw err('bad-cursor', 'The cursor is not valid.');
    const size = Number(params().get('page')) || PAGE;
    const page = ordered.slice(start, start + size);
    const groups = [];
    for (const [p, c] of page) {
      let g = groups[groups.length - 1];
      if (!g || g.run_id !== p.run_id) {
        g = { run_id: p.run_id, at: p.at, items: [] };
        if (p.head_sha) g.head_sha = p.head_sha;
        groups.push(g);
      }
      g.items.push(c);
    }
    const out = {
      inboxes: INBOXES.map(summary),
      groups,
    };
    if (start + size < ordered.length) out.next = String(start + size);
    return out;
  },
  'proposal.get'({ ref }) {
    const card = cards.find((c) => c.ref === ref);
    if (!card) throw err('bad-input', `No proposal ${ref}.`);
    return { card, history: history[ref] ?? [] };
  },
  'verdict.accept'({ ref, jira_project_key, issue_type_id, note }) {
    const c = cards.find((x) => x.ref === ref);
    const inbox = INBOXES.find((i) => i.project_key === c?.project_key);
    const project = jira_project_key ?? inbox?.jira_project_key;
    if (!project || !(issue_type_id ?? inbox?.issue_type_id)) throw err('bad-input', 'This inbox has no Jira target. Set one in Settings.');
    if (project === 'BILL') throw err('unavailable', 'Jira refused to create the issue: the Billing project is archived.');
    const key = `${project}-${nextIssue++}`;
    return { card: decide(ref, 'accepted', { issue_ref: key, issue_url: `https://acme.atlassian.net/browse/${key}`, ...(note ? { note } : {}) }) };
  },
  'verdict.reject'({ refs, reason, note }) {
    if (reason === 'other' && !note) throw err('bad-input', 'A note is required when the reason is other.');
    return { cards: refs.map((r) => decide(r, 'rejected', note ? { reason, note } : { reason })) };
  },
  'verdict.snooze'({ refs, note, until }) { return { cards: refs.map((r) => decide(r, 'snoozed', { ...(note ? { note } : {}), ...(until ? { snooze_until: until } : {}) })) }; },
  'verdict.merge'({ ref, into }) {
    if (into === 'NOPE-1') throw err('bad-input', 'NOPE-1 does not exist or you cannot see it.');
    return { card: decide(ref, 'merged', { merged_into: into }) };
  },
  'settings.get'() {
    return { inboxes: INBOXES.map(summary) };
  },
  'settings.set'({ project_key, jira_project_key, issue_type_id }) {
    const i = INBOXES.find((x) => x.project_key === project_key);
    if (!i) throw err('unknown-project', `No inbox ${project_key}.`);
    Object.assign(i, { jira_project_key, issue_type_id });
    return { inbox: summary(i) };
  },
  'jira.projects'() { return { projects: PROJECTS }; },
  'direction.get'({ project_key }) {
    if (!INBOXES.some((i) => i.project_key === project_key)) throw err('unknown-project', `No inbox ${project_key}.`);
    return { lenses: directions[project_key] ?? {} };
  },
  'direction.set'({ project_key, lens, focus, exclude, notes, spaces }) {
    if (!INBOXES.some((i) => i.project_key === project_key)) throw err('unknown-project', `No inbox ${project_key}.`);
    if (!LENS_IDS.includes(lens)) throw err('bad-input', `lens must be one of ${LENS_IDS.join(', ')}.`);
    const list = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
    const d = {};
    for (const [k, v] of [['focus', list(focus)], ['exclude', list(exclude)], ['spaces', list(spaces)]]) {
      if (v.length > 10) throw err('bad-input', `${k} holds ${v.length} items; at most 10.`);
      if (v.some((x) => x.length > 120)) throw err('bad-input', `Each ${k} item is at most 120 characters.`);
      if (v.length) d[k] = v;
    }
    if (d.spaces && lens !== 'doc-drift') throw err('bad-input', 'spaces go only with the doc-drift lens.');
    if (d.spaces?.some((s) => !/^[A-Za-z0-9_~-]+$/.test(s))) throw err('bad-input', 'A space key is letters, digits, _ ~ or -.');
    if (typeof notes === 'string' && notes.trim()) d.notes = notes.trim();
    const all = (directions[project_key] ??= {});
    if (Object.keys(d).length === 0) { delete all[lens]; return { lens }; }
    all[lens] = d;
    return { lens, direction: d };
  },
  'panel.forIssue'({ issue_key }) {
    const card = cards.find((c) => c.issue_ref === issue_key);
    return card ? { card, history: history[card.ref] ?? [] } : { history: [] };
  },
  'map.data'({ project_key }) {
    if (!project_key) throw err('bad-input', 'project_key is required.');
    if (!INBOXES.some((i) => i.project_key === project_key)) throw err('unknown-project', `No inbox ${project_key}.`);
    if (params().has('empty')) return { areas: [], points: [] };
    const points = cards.filter((c) => c.project_key === project_key && c.status === 'open' && c.effort?.size)
      .map((c) => {
        const p = { ref: c.ref, lens: c.lens, effort: c.effort.size, confidence: c.confidence };
        if (c.delivery_risk?.blast) p.blast = c.delivery_risk.blast;
        return p;
      });
    // The counts come from the cards, by the same mapping the area filter uses (as forge/src/core/areas.mjs), so a
    // cell's number is what its inbox link lists.
    const list = AREAS[project_key] ?? [];
    const paths = list.map((a) => a.path);
    const areas = list.map((a) => {
      const by = {};
      for (const c of cards) {
        if (c.project_key !== project_key || (c.status !== 'open' && c.status !== 'accepted') || !areasOf(c, paths).has(a.path)) continue;
        const n = (by[c.lens] ??= { lens: c.lens, open: 0, accepted: 0 });
        n[c.status] += 1;
      }
      return { ...a, proposals: Object.values(by).sort((x, y) => x.lens.localeCompare(y.lens)) };
    });
    return { areas, points };
  },
  'reflect.data'({ project_key }) {
    if (!project_key) throw err('bad-input', 'project_key is required.');
    if (!INBOXES.some((i) => i.project_key === project_key)) throw err('unknown-project', `No inbox ${project_key}.`);
    if (params().has('empty')) return EMPTY_REFLECT;
    return reflect[project_key] ?? EMPTY_REFLECT;
  },
  'rule.decide'({ project_key, id, state, text }) {
    const rule = reflect[project_key]?.rules.find((r) => r.id === id);
    if (!rule) throw err('bad-input', `No rule ${id}.`);
    if (rule.state !== 'offered') throw err('bad-input', `That rule is already ${rule.state}.`);
    if (state !== 'accepted' && state !== 'declined') throw err('bad-input', 'state must be accepted or declined.');
    Object.assign(rule, { state, decided_by_name: 'Dev User', decided_at: new Date().toISOString() }, text ? { text } : {});
    return { rule };
  },
  'outcome.record'({ ref, rating, note }) {
    if (!['right', 'partly', 'wrong'].includes(rating)) throw err('bad-input', 'rating must be right, partly or wrong.');
    const data = Object.values(reflect).find((d) => d.candidates.some((c) => c.ref === ref));
    if (!data) throw err('bad-input', `${ref} is not an accepted item waiting for an outcome.`);
    const cand = data.candidates.find((c) => c.ref === ref);
    data.candidates = data.candidates.filter((c) => c.ref !== ref);
    const outcome = { ref, fp: '0000', rating, issue_ref: cand.issue_ref, decided_by: 'forge:dev-user', decided_by_name: 'Dev User', recorded_at: new Date().toISOString(), title: cand.title, ...(note ? { note } : {}) };
    data.outcomes.unshift(outcome);
    return { outcome, candidates: data.candidates };
  },
  'byline.forPage'({ page_id }) {
    if (!/^[0-9]+$/.test(String(page_id ?? ''))) throw err('bad-input', 'page_id must be a Confluence page id.');
    // As the server does: a `page` evidence ref or a doc_impact entry that is the page id (forge-mcp-2: a page ref is its id).
    const hit = cards.filter((c) => (c.status === 'open' || c.status === 'accepted')
      && ((c.doc_impact ?? []).includes(page_id) || c.evidence.some((e) => e.type === 'page' && e.ref === page_id)));
    return { count: hit.length, cards: hit };
  },
};

/** `&fail=` fails every matching call, `&failonce=` those of the page's first second; `key:status` matches one status. */
const LOADED_AT = Date.now();
function fails(key, payload) {
  const match = (spec) => spec === key || (payload?.status && spec === `${key}:${payload.status}`);
  if (match(params().get('fail'))) return true;
  const once = params().get('failonce');
  return Boolean(once && match(once) && Date.now() - LOADED_AT < 1000);
}

export async function invoke(key, payload = {}) {
  await new Promise((r) => setTimeout(r, params().has('slow') ? 1500 : 150));
  if (fails(key, payload)) return err('unavailable', `The ${key} resolver is unavailable (fixture).`);
  const h = handlers[key];
  if (!h) return err('bad-input', `Unknown resolver ${key}.`);
  try {
    return structuredClone(h(payload));
  } catch (e) {
    if (e && typeof e === 'object' && 'error' in e) return e;
    throw e;
  }
}

/** The deep-link part of a query (`?ref=&project=&lens=&area=`, as components/deeplink.js reads it), or ''. */
const LINK_KEYS = ['ref', 'project', 'lens', 'area'];
function linkQuery(q) {
  const out = new URLSearchParams();
  for (const k of LINK_KEYS) if (q.has(k)) out.set(k, q.get(k));
  const s = out.toString();
  return s ? `?${s}` : '';
}

export const view = {
  async getContext() {
    const s = surface();
    if (s === 'panel' || s === 'panel-none') {
      return { moduleKey: 'dowser-evidence', extension: { type: 'jira:issuePanel', issue: { key: s === 'panel' ? 'SHOP-101' : 'SHOP-1', id: '10000' } } };
    }
    const base = { siteUrl: 'https://acme.atlassian.net', environmentId: 'dev-env', localId: 'ari:cloud:ecosystem::extension/dev-app/dev-env/static/' };
    if (s === 'byline') {
      return {
        ...base, localId: `${base.localId}dowser-doc-impact`, moduleKey: 'dowser-doc-impact',
        extension: { type: 'confluence:contentBylineItem', content: { id: params().get('page') ?? '90211', type: 'page' }, space: { key: 'OPS' } },
      };
    }
    return { ...base, localId: `${base.localId}dowser-inbox`, moduleKey: 'dowser-inbox', extension: { type: 'jira:globalPage', location: `https://acme.atlassian.net/jira/apps/dev/dowser/${s}${linkQuery(params())}` } };
  },
  theme: { enable: async () => { await setGlobalTheme({ colorMode: /** @type {any} */ (params().get('mode') ?? 'auto') }); } },
};

export const router = {
  navigate: async (to) => {
    // In-app navigation: the last path segment is the route, which the fixture carries in the hash.
    const u = new URL(to);
    const route = u.pathname.split('/').filter(Boolean).pop() ?? 'inbox';
    location.hash = `${route}${linkQuery(u.searchParams).replace(/^\?/, '&')}`;
  },
  open: async (to) => { console.info('[fixture] router.open', to); },
  reload: async () => location.reload(),
};

// Reload the surface when the hash changes, so one dev tab can visit all of them.
window.addEventListener('hashchange', () => location.reload());
