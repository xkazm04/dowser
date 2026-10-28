// A `@forge/bridge` stand-in for local-server mode (`npm run dev:local`, i.e. vite --mode local). Every invoke is
// POSTed as `{key, payload}` to `http://127.0.0.1:${VITE_DOWSER_LOCAL_PORT || 4710}/invoke`, and the JSON body
// (the resolver result, or `{error, message}`) is returned as the resolver's answer. The server is not part of
// this bundle. vite.config.js aliases `@forge/bridge` to this file only in that mode, so a Forge build never has it.
//
// URL hash picks the surface, as in the fixture bridge: #inbox (default) | #map | #reflect | #settings |
// #panel&issue=SHOP-101 | #byline&page=<id>; &ref=DW-n deep-links the inbox.
import { setGlobalTheme } from '@atlaskit/tokens/set-global-theme';

const PORT = import.meta.env.VITE_DOWSER_LOCAL_PORT || '4710';
const ENDPOINT = `http://127.0.0.1:${PORT}/invoke`;
const params = () => new URLSearchParams(location.hash.slice(1).replace(/^[a-z-]+&?/, ''));
const surface = () => (location.hash.slice(1).match(/^[a-z-]+/) ?? ['inbox'])[0];

export async function invoke(key, payload = {}) {
  let res;
  try {
    res = await fetch(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, payload, ...(surface() === 'panel' ? { module: 'dowser-evidence' } : {}) }) });
  } catch {
    return { error: 'unavailable', message: `The local Dowser server at ${ENDPOINT} did not answer. Is it running?` };
  }
  try {
    return await res.json();
  } catch {
    return { error: 'unavailable', message: `The local Dowser server answered ${res.status} without JSON.` };
  }
}

export const view = {
  async getContext() {
    const s = surface();
    if (s === 'panel') {
      return { moduleKey: 'dowser-evidence', extension: { type: 'jira:issuePanel', issue: { key: params().get('issue') ?? 'SHOP-101', id: '10000' } } };
    }
    const base = { siteUrl: 'http://127.0.0.1', environmentId: 'local-env', localId: 'ari:cloud:ecosystem::extension/local-app/local-env/static/' };
    if (s === 'byline') {
      return {
        ...base, localId: `${base.localId}dowser-doc-impact`, moduleKey: 'dowser-doc-impact',
        extension: { type: 'confluence:contentBylineItem', content: { id: params().get('page') ?? '1', type: 'page' }, space: { key: 'LOCAL' } },
      };
    }
    return { ...base, localId: `${base.localId}dowser-inbox`, moduleKey: 'dowser-inbox', extension: { type: 'jira:globalPage', location: `http://127.0.0.1/jira/apps/local/dowser/${s}${params().has('ref') ? `?ref=${params().get('ref')}` : ''}` } };
  },
  theme: { enable: async () => { await setGlobalTheme({ colorMode: 'auto' }); } },
};

/** In-app navigation: the last path segment of the target is the route; the hash carries it here. */
export const router = {
  navigate: async (to) => {
    const u = new URL(to);
    const route = u.pathname.split('/').filter(Boolean).pop() ?? 'inbox';
    const ref = u.searchParams.get('ref');
    location.hash = ref ? `${route}&ref=${ref}` : route;
  },
  open: async (to) => { window.open(to, '_blank', 'noopener'); },
  reload: async () => location.reload(),
};

window.addEventListener('hashchange', () => location.reload());
