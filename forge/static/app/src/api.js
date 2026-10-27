// The one door from the Custom UI to the resolvers. Keys and shapes: forge/src/core/types.mjs
// (ResolverContract). Every resolver answers `{error, message}` on failure; call() throws it as ApiError so
// each surface renders one error state.
import { invoke } from '@forge/bridge';

export class ApiError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) { super(message); this.code = code; }
}

/**
 * @param {string} key  a ResolverContract key, e.g. 'inbox.list'
 * @param {object} [payload]
 */
export async function call(key, payload = {}) {
  const res = await invoke(key, payload);
  if (res && typeof res === 'object' && 'error' in res) throw new ApiError(String(res.error), String(res.message ?? res.error));
  return res;
}
