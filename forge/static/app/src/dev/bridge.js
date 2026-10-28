// A fake `@forge/bridge` for the dev server. vite.config.js aliases `@forge/bridge` to this file only when
// VITE_DOWSER_FIXTURE=1, so the production bundle never contains it. It serves the ResolverContract keys from
// forge/src/core/types.mjs over in-memory fixture data, and mutates it on verdicts.
//
// URL hash picks the surface and test conditions:
//   #inbox (default) | #settings | #map | #panel (accepted issue SHOP-101) | #panel-none (not from Dowser)
//   &ref=DW-n             deep link: the inbox focuses that card (or opens it when it is not on the page)
//   #byline (Confluence page 90211, two proposals)   &page=<id> another page (48213: one; 1: none)
//   &fail=<resolver key>  that key answers {error, message}     &empty  no proposals at all
//   &slow                 every call takes 1.5 s (to see skeletons)
//   #reflect              the Learning tab (`reflect.data`; github.com/acme/shop has data, billing is empty)
//   &fail=reflect.data | rule.decide | outcome.record | verdict.snooze | verdict.reject   that call fails
import { setGlobalTheme } from '@atlaskit/tokens/set-global-theme';
import { AREAS, CARDS, GROUP_OF, HISTORY, INBOXES, PROJECTS, PUSHES, REFLECT } from './fixture.js';

const PAGE = 4; // small on purpose, so "Load more" and a group split across pages are exercised
const params = () => new URLSearchParams(location.hash.slice(1).replace(/^[a-z-]+&?/, ''));
const surface = () => (location.hash.slice(1).match(/^[a-z-]+/) ?? ['inbox'])[0];
let nextIssue = 102;

const cards = structuredClone(CARDS);
const history = structuredClone(HISTORY);
const reflect = structuredClone(REFLECT);
const EMPTY_REFLECT = { totals: { open: 0, accepted: 0, rejected: 0, snoozed: 0, merged: 0 }, rejects: [], notes: [], pushes: [], lens_yield: [], rules: [], candidates: [], outcomes: [] };

function err(error, message) { return { error, message }; }
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
  'inbox.list'({ project_key, status, lens, cursor }) {
    if (params().has('empty')) return { inboxes: [], groups: [] };
    const pick = cards.filter((c) => (!project_key || c.project_key === project_key) && (!status || c.status === status) && (!lens || c.lens === lens));
    const ordered = [...PUSHES].sort((a, b) => b.at.localeCompare(a.at))
      .flatMap((p) => pick.filter((c) => GROUP_OF[c.ref] === p.run_id).map((c) => [p, c]));
    const start = cursor ? Number(cursor) : 0;
    if (!Number.isInteger(start) || start < 0 || start > ordered.length) throw err('bad-cursor', 'The cursor is not valid.');
    const page = ordered.slice(start, start + PAGE);
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
      inboxes: INBOXES.map((i) => ({ ...i, open: cards.filter((c) => c.project_key === i.project_key && c.status === 'open').length })),
      groups,
    };
    if (start + PAGE < ordered.length) out.next = String(start + PAGE);
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
  'verdict.snooze'({ refs, note }) { return { cards: refs.map((r) => decide(r, 'snoozed', note ? { note } : {})) }; },
  'verdict.merge'({ ref, into }) {
    if (into === 'NOPE-1') throw err('bad-input', 'NOPE-1 does not exist or you cannot see it.');
    return { card: decide(ref, 'merged', { merged_into: into }) };
  },
  'settings.get'() {
    return { inboxes: INBOXES.map((i) => ({ ...i, open: cards.filter((c) => c.project_key === i.project_key && c.status === 'open').length })) };
  },
  'settings.set'({ project_key, jira_project_key, issue_type_id }) {
    const i = INBOXES.find((x) => x.project_key === project_key);
    if (!i) throw err('unknown-project', `No inbox ${project_key}.`);
    Object.assign(i, { jira_project_key, issue_type_id });
    return { inbox: { ...i, open: cards.filter((c) => c.project_key === project_key && c.status === 'open').length } };
  },
  'jira.projects'() { return { projects: PROJECTS }; },
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
    return { areas: AREAS[project_key] ?? [], points };
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

export async function invoke(key, payload = {}) {
  await new Promise((r) => setTimeout(r, params().has('slow') ? 1500 : 150));
  if (params().get('fail') === key) return err('unavailable', `The ${key} resolver is unavailable (fixture).`);
  const h = handlers[key];
  if (!h) return err('bad-input', `Unknown resolver ${key}.`);
  try {
    return structuredClone(h(payload));
  } catch (e) {
    if (e && typeof e === 'object' && 'error' in e) return e;
    throw e;
  }
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
    return { ...base, localId: `${base.localId}dowser-inbox`, moduleKey: 'dowser-inbox', extension: { type: 'jira:globalPage', location: `https://acme.atlassian.net/jira/apps/dev/dowser/${s}${params().has('ref') ? `?ref=${params().get('ref')}` : ''}` } };
  },
  theme: { enable: async () => { await setGlobalTheme({ colorMode: 'auto' }); } },
};

export const router = {
  navigate: async (to) => {
    // In-app navigation: the last path segment is the route, which the fixture carries in the hash.
    const u = new URL(to);
    const route = u.pathname.split('/').filter(Boolean).pop() ?? 'inbox';
    const ref = u.searchParams.get('ref');
    location.hash = ref ? `${route}&ref=${ref}` : route;
  },
  open: async (to) => { console.info('[fixture] router.open', to); },
  reload: async () => location.reload(),
};

// Reload the surface when the hash changes, so one dev tab can visit all of them.
window.addEventListener('hashchange', () => location.reload());
