// @ts-check
// The inbox's triage state as one pure reducer: each decided card's lifecycle (open -> leaving -> gone, back to open
// on Undo or a failed commit), the cards checked for a bulk action, the per-card errors, the selection (which is the
// keyboard focus), the snooze step and the open dialog. The hooks around it keep only the effects: the exit timers,
// the undo window (useCommitWindow), the resolver calls and the DOM focus. Plain JS, no React: forge/test imports it.

/**
 * @typedef {{phase: 'leaving' | 'gone', from: string, to: string, project_key: string}} Decided
 *   a card decided on this page: the status it left, the status it moved to and its inbox (the counts follow it, also
 *   while a changed filter's list is on its way). A card with no entry is open.
 * @typedef {{kind: 'card', ref: string} | {kind: 'bulk'}} Step the snooze step: one card's, or the bulk bar's
 * @typedef {{kind: string, refs: string[]}} Dialog
 * @typedef {{
 *   decided: Map<string, Decided>, checked: Set<string>, errors: Record<string, string>,
 *   focus: string, focusRequest: string, expanded: boolean, step: Step | null, dialog: Dialog | null,
 * }} TriageState
 *   `focus` is the selected row ('' for none); `focusRequest` a row that should take the DOM focus once it is
 *   rendered ('' for none); `expanded` the narrow layout's accordion under the selected row.
 * @typedef {{ref: string, status?: string, project_key?: string}} CardLike
 * @typedef {(
 *   {type: 'reset'} |
 *   {type: 'decide', cards: CardLike[], to: string, order: string[], instant?: boolean} |
 *   {type: 'exitDone', ref: string} |
 *   {type: 'undo', refs: string[]} |
 *   {type: 'commitFailed', refs: string[], message: string} |
 *   {type: 'fail', refs: string[], message: string} |
 *   {type: 'toggle', card: CardLike} |
 *   {type: 'clearChecked'} |
 *   {type: 'openSnooze', ref?: string, bulk?: boolean} |
 *   {type: 'closeSnooze'} |
 *   {type: 'openDialog', kind: string, refs: string[]} |
 *   {type: 'closeDialog'} |
 *   {type: 'focus', ref: string, expand?: boolean, request?: boolean} |
 *   {type: 'focusFirst', ref: string} |
 *   {type: 'focusDone'} |
 *   {type: 'select', ref: string, wide: boolean}
 * )} TriageEvent
 */

/** Dialogs that decide cards: they need cards, and opening one closes the snooze step. */
const DECIDING = new Set(['accept', 'merge', 'reject']);

/** @returns {TriageState} */
export function initialTriage() {
  return { decided: new Map(), checked: new Set(), errors: {}, focus: '', focusRequest: '', expanded: true, step: null, dialog: null };
}

/** @param {TriageState} state @param {string} ref @returns {'open' | 'leaving' | 'gone'} */
export function phaseOf(state, ref) {
  return state.decided.get(ref)?.phase ?? 'open';
}

/**
 * Whether a card can be checked: only an open card still listed as open here. The bulk actions reject or snooze every
 * checked card, and the server refuses a verdict on a card that is not open.
 * @param {TriageState} state @param {CardLike} card
 */
export function checkable(state, card) {
  return (card.status ?? 'open') === 'open' && phaseOf(state, card.ref) === 'open';
}

/** @template T @param {Set<T>} set @param {T[]} keys */
const without = (set, keys) => { const s = new Set(set); keys.forEach((k) => s.delete(k)); return s; };
/** @param {Record<string, string>} rec @param {string[]} keys */
const withoutErrors = (rec, keys) => { const e = { ...rec }; keys.forEach((k) => delete e[k]); return e; };

/** The cards back to open (Undo, or a failed commit). @param {TriageState} state @param {string[]} refs */
function restore(state, refs) {
  const decided = new Map(state.decided);
  refs.forEach((r) => decided.delete(r));
  return { ...state, decided };
}

/**
 * The row the selection moves to when the cards in `refs` leave `order` (the listed rows, top to bottom): the row now
 * at the selected row's position, the last one when it was the last; the selection stays when nothing is left.
 * @param {string} focus @param {string[]} order @param {string[]} refs
 */
export function nextFocus(focus, order, refs) {
  if (!refs.includes(focus)) return focus;
  const at = order.indexOf(focus);
  const rest = order.filter((r) => !refs.includes(r));
  if (at < 0 || rest.length === 0) return focus;
  return rest[Math.min(at, rest.length - 1)];
}

/** @param {TriageState} state @param {TriageEvent} ev @returns {TriageState} */
export function triage(state, ev) {
  switch (ev.type) {
    case 'reset':
      return { ...initialTriage(), expanded: state.expanded };
    case 'decide': {
      const refs = ev.cards.map((c) => c.ref);
      if (refs.length === 0) return state;
      const decided = new Map(state.decided);
      for (const c of ev.cards) decided.set(c.ref, { phase: ev.instant ? 'gone' : 'leaving', from: c.status ?? 'open', to: ev.to, project_key: c.project_key ?? '' });
      const focus = nextFocus(state.focus, ev.order, refs);
      const moved = focus !== state.focus;
      return {
        ...state, decided, checked: without(state.checked, refs), errors: withoutErrors(state.errors, refs), step: null, focus,
        focusRequest: moved && !state.dialog ? focus : state.focusRequest,
      };
    }
    case 'exitDone': {
      const d = state.decided.get(ev.ref);
      if (!d || d.phase !== 'leaving') return state;
      return { ...state, decided: new Map(state.decided).set(ev.ref, { ...d, phase: 'gone' }) };
    }
    case 'undo': {
      if (ev.refs.length === 0) return state;
      return { ...restore(state, ev.refs), focus: ev.refs[0], focusRequest: ev.refs[0] };
    }
    case 'commitFailed':
      return { ...restore(state, ev.refs), errors: { ...state.errors, ...Object.fromEntries(ev.refs.map((r) => [r, ev.message])) } };
    case 'fail':
      return { ...state, errors: { ...state.errors, ...Object.fromEntries(ev.refs.map((r) => [r, ev.message])) } };
    case 'toggle': {
      const ref = ev.card.ref;
      if (state.checked.has(ref)) return { ...state, checked: without(state.checked, [ref]) };
      if (!checkable(state, ev.card)) return state;
      return { ...state, checked: new Set(state.checked).add(ref) };
    }
    case 'clearChecked':
      return { ...state, checked: new Set(), step: null };
    case 'openSnooze':
      if (ev.bulk) return { ...state, step: { kind: 'bulk' } };
      if (!ev.ref) return state;
      return { ...state, step: { kind: 'card', ref: ev.ref }, focus: ev.ref, expanded: true };
    case 'closeSnooze':
      return state.step ? { ...state, step: null } : state;
    case 'openDialog': {
      const deciding = DECIDING.has(ev.kind);
      if (deciding && ev.refs.length === 0) return state;
      return { ...state, dialog: { kind: ev.kind, refs: ev.refs }, step: deciding ? null : state.step };
    }
    case 'closeDialog':
      return state.dialog ? { ...state, dialog: null } : state;
    case 'focus': {
      const expanded = ev.expand ? true : state.expanded;
      const focusRequest = ev.request ? ev.ref : state.focusRequest;
      return ev.ref === state.focus && expanded === state.expanded && focusRequest === state.focusRequest ? state : { ...state, focus: ev.ref, expanded, focusRequest };
    }
    case 'focusFirst':
      return state.focus || !ev.ref ? state : { ...state, focus: ev.ref };
    case 'focusDone':
      return state.focusRequest ? { ...state, focusRequest: '' } : state;
    case 'select':
      if (ev.ref === state.focus && !ev.wide) return { ...state, expanded: !state.expanded, step: null };
      return { ...state, focus: ev.ref, expanded: true, step: null };
    default:
      return state;
  }
}

// Selectors.

/** The refs leaving (the exit animation) and gone, for the list views. @param {TriageState} state */
export function phaseSets(state) {
  /** @type {Set<string>} */ const leaving = new Set();
  /** @type {Set<string>} */ const removed = new Set();
  for (const [ref, d] of state.decided) (d.phase === 'leaving' ? leaving : removed).add(ref);
  return { leaving, removed };
}

/** The rows j/k walk: the listed cards still open on this page. @template {CardLike} C @param {TriageState} state @param {C[]} cards */
export function flatOf(state, cards) {
  return cards.filter((c) => phaseOf(state, c.ref) === 'open');
}

/** What this page decided, by status. @param {TriageState} state */
export function tallyOf(state) {
  /** @type {Record<string, number>} */
  const t = { accepted: 0, rejected: 0, snoozed: 0, merged: 0, total: 0 };
  for (const d of state.decided.values()) { t[d.to] = (t[d.to] ?? 0) + 1; t.total += 1; }
  return t;
}

/** The checked cards that are listed. @param {TriageState} state @param {Map<string, unknown>} byRef */
export function checkedVisible(state, byRef) {
  return [...state.checked].filter((r) => byRef.has(r));
}

/** The ref whose snooze step is open ('' for none or the bulk bar's). @param {TriageState} state */
export function snoozingRef(state) {
  return state.step?.kind === 'card' ? state.step.ref : '';
}

/** At most this many inbox.list pages are followed for one list (50 items each). */
export const PAGES_MAX = 20;

/**
 * Every item of a paged `inbox.list` answer: follows `next` until it is absent, or until PAGES_MAX pages (then
 * `more: true`, so the caller can say the list is cut short instead of claiming an item does not exist).
 * @param {(cursor: string | undefined) => Promise<{groups?: {items?: any[]}[], next?: string}>} page
 * @param {number} [max]
 * @returns {Promise<{items: any[], more: boolean}>}
 */
export async function allPages(page, max = PAGES_MAX) {
  /** @type {any[]} */
  const items = [];
  /** @type {string | undefined} */
  let cursor;
  for (let n = 0; n < max; n++) {
    const res = await page(cursor);
    items.push(...(res.groups ?? []).flatMap((g) => g.items ?? []));
    if (res.next === undefined) return { items, more: false };
    cursor = res.next;
  }
  return { items, more: true };
}
