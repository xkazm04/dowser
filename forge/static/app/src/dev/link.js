// The deep-link part of a query, shared by the two @forge/bridge stand-ins (bridge.js, http-bridge.js) so both
// carry the same keys components/deeplink.js reads: ?ref=&project=&lens=&area=.

export const LINK_KEYS = ['ref', 'project', 'lens', 'area'];

/**
 * `?ref=..&project=..` with only the link keys of `q`, in LINK_KEYS order, or ''.
 * @param {URLSearchParams} q
 */
export function linkQuery(q) {
  const out = new URLSearchParams();
  for (const k of LINK_KEYS) { const v = q.get(k); if (v !== null) out.set(k, v); }
  const s = out.toString();
  return s ? `?${s}` : '';
}

/** The module key a dev surface stands for, as Forge sets context.moduleKey. @param {string} surface */
export const moduleOf = (surface) => (surface === 'panel' || surface === 'panel-none' ? 'dowser-evidence'
  : surface === 'byline' ? 'dowser-doc-impact' : surface === 'banner' ? 'dowser-doc-banner' : 'dowser-inbox');
