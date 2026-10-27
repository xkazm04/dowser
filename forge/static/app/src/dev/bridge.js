// A fake `@forge/bridge` for the dev server. vite.config.js aliases `@forge/bridge` to this file only when
// VITE_DOWSER_FIXTURE=1, so the production bundle never contains it. It serves the ResolverContract keys from
// forge/src/core/types.mjs over in-memory fixture data, and mutates it on verdicts.
//
// URL hash picks the surface and test conditions:
//   #inbox (default) | #settings | #map | #panel (accepted issue SHOP-101) | #panel-none (not from Dowser)
//   &fail=<resolver key>  that key answers {error, message}     &empty  no proposals at all
//   &slow                 every call takes 1.5 s (to see skeletons)
import { setGlobalTheme } from '@atlaskit/tokens/set-global-theme';
import { CARDS, GROUP_OF, HISTORY, INBOXES, PROJECTS, PUSHES } from './fixture.js';

const PAGE = 4; // small on purpose, so "Load more" and a group split across pages are exercised
const params = () => new URLSearchParams(location.hash.slice(1).replace(/^[a-z-]+&?/, ''));
const surface = () => (location.hash.slice(1).match(/^[a-z-]+/) ?? ['inbox'])[0];
let nextIssue = 102;

const cards = structuredClone(CARDS);
const history = structuredClone(HISTORY);

function err(error, message) { return { error, message }; }
function decide(ref, status, extra = {}) {
  const c = cards.find((x) => x.ref === ref);
  if (!c) throw err('bad-input', `No proposal ${ref}.`);
  if (c.status !== 'open') throw err('bad-input', `${ref} is already ${c.status}.`);
  Object.assign(c, { status }, extra);
  delete c.reopened;
  (history[ref] ??= []).push({ fp: c.fp, status, decided_by: 'forge:dev-user', decided_at: new Date().toISOString(), external_ref: ref, ...extra });
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
  'verdict.accept'({ ref, jira_project_key, issue_type_id }) {
    const c = cards.find((x) => x.ref === ref);
    const inbox = INBOXES.find((i) => i.project_key === c?.project_key);
    const project = jira_project_key ?? inbox?.jira_project_key;
    if (!project || !(issue_type_id ?? inbox?.issue_type_id)) throw err('bad-input', 'This inbox has no Jira target. Set one in Settings.');
    if (project === 'BILL') throw err('unavailable', 'Jira refused to create the issue: the Billing project is archived.');
    const key = `${project}-${nextIssue++}`;
    return { card: decide(ref, 'accepted', { issue_ref: key, issue_url: `https://acme.atlassian.net/browse/${key}` }) };
  },
  'verdict.reject'({ refs, reason, note }) {
    if (reason === 'other' && !note) throw err('bad-input', 'A note is required when the reason is other.');
    return { cards: refs.map((r) => decide(r, 'rejected', note ? { reason, note } : { reason })) };
  },
  'verdict.snooze'({ refs }) { return { cards: refs.map((r) => decide(r, 'snoozed')) }; },
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
  'map.data'() { return { areas: [], points: [] }; },
  'byline.forPage'() { return { count: 0, cards: [] }; },
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
    return { moduleKey: 'dowser-inbox', extension: { type: 'jira:globalPage', location: `https://acme.atlassian.net/jira/apps/dev/dowser/${s}` } };
  },
  theme: { enable: async () => { await setGlobalTheme({ colorMode: 'auto' }); } },
};

export const router = { navigate: async () => {}, open: async () => {}, reload: async () => location.reload() };

// Reload the surface when the hash changes, so one dev tab can visit all of them.
window.addEventListener('hashchange', () => location.reload());
