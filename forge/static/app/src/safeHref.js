// A link target from server data, or undefined. Only an absolute `https:` or `http:` URL passes: a pushed
// `javascript:`, `data:` or relative value never reaches an `href` or `router.open`. `http:` stays because real
// data carries it: the skill keeps the scheme of an `http://` git remote (repo links and the code links built
// from them), and the local Forge serves its Jira issues over http. A guarded-out link renders as plain text.

const SCHEMES = ['https:', 'http:'];

/**
 * @param {unknown} url
 * @returns {string | undefined}
 */
export function safeHref(url) {
  if (typeof url !== 'string' || !url) return undefined;
  try { return SCHEMES.includes(new URL(url).protocol) ? url : undefined; } catch { return undefined; }
}
