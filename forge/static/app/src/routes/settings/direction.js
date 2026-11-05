// @ts-check
// The Lens direction limits, checked as the person types, in the screen's own words. The server holds the same
// limits (forge/src/core/types.mjs DIRECTION_ITEMS_MAX, DIRECTION_LINE_MAX, DIRECTION_SPACES_MAX; core/direction.mjs lines()) and still
// refuses past them; forge/test checks the two agree. Plain JS, no React: forge/test imports it.

export const ITEMS_MAX = 10;
export const LINE_MAX = 120;
export const SPACES_MAX = 10;

/** The label each list field carries on screen. */
export const FIELD_LABELS = /** @type {const} */ ({ focus: 'Focus on', exclude: 'Leave out', spaces: 'Confluence spaces' });

/**
 * What is over the limit in one list field (its lines trimmed, empty and repeated lines dropped, as the server
 * counts them), or '' when it fits.
 * @param {string[]} lines
 * @param {string} noun  'topic' or 'space'
 * @param {number} [max]
 */
export function listProblem(lines, noun, max = ITEMS_MAX) {
  const n = new Set(lines).size;
  if (n > max) return `${n} ${noun}s, at most ${max}: remove ${n - max}.`;
  const long = lines.filter((l) => l.length > LINE_MAX).length;
  if (long) return `${long === 1 ? 'One line is' : `${long} lines are`} longer than ${LINE_MAX} characters.`;
  return '';
}

/**
 * A server refusal of direction.set with its field keys replaced by the labels on screen
 * ('exclude holds 12 items' -> 'Leave out holds 12 items').
 * @param {string} message
 */
export function labelled(message) {
  return message.replace(/\b(focus|exclude|spaces)\b/g, (k) => FIELD_LABELS[/** @type {keyof typeof FIELD_LABELS} */ (k)]);
}
