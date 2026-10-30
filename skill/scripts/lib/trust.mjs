// @ts-check
// Per-slice trust (scan-finding/1 "Autonomy ladder"), computed in the local store from its own decision history:
// the gate lives here, not in the prompt, and the agent's claim of a level is never read.
//
// Dowser's ladder. A slice is `<category>|<lens>|-|<size>` (model.mjs sliceKey). Dowser never writes into the
// scanned repo and a Jira issue leaves the system, so the ceiling is L1 for every slice. A `technical` slice starts
// at the contract's start capped by that ceiling (L1: technical items default to automation - here, skipping the
// runner's pre-triage while a person still decides every card in the inbox); a `product` slice starts at L0.
//  - Earn: a slice moves L0 -> L1 when its predicted verdicts agree with the person's verdicts on >= 90 % of its
//    last 20 decided items (minimum 20) since its window opened.
//  - Lose: a slice drops one level, and its window resets, when a person rejects a card the machine pre-triaged
//    (pretriaged_by = machine:dowser): a reversal of a machine decision.
//  - L1 lets `pretriage` skip the person's pre-triage for the slice's ranked cards predicted `accept`: they are
//    pushed marked `pretriaged_by: machine:dowser`. Nothing else changes: acceptance in Jira stays a person's
//    click (model.mjs DECIDER_GUARDS is untouched), and the inbox keeps every machine pre-triage open to reject.
// A person's decision is a transition to accepted / rejected / snoozed by a `human:` or `forge:` decider; it agrees
// when DECIDED[status] equals the card's predicted_verdict. Cards without a prediction (dowser-proposal/1) do not
// count. Every level change appends one trust_events row (append-only, triggers refuse UPDATE and DELETE).
// sync_state `trust_through` is the last transition id replayed, so a replay adds nothing.
import { MACHINE_DECIDER, sliceKey } from './model.mjs';
import { DECIDED } from './predict.mjs';
import { clean, now, tx } from './store-core.mjs';

/** @import { Db, Row } from './store-core.mjs' */

export const CEILING = 1;
/** The contract's start levels, before the ceiling. */
export const START = { technical: 2, product: 0 };
/**
 * A slice's level before it has any history: its category's start, capped at CEILING.
 * @param {string} slice
 */
export function startOf(slice) {
  const category = String(slice).split('|')[0];
  return Math.min(CEILING, Object.hasOwn(START, category) ? START[/** @type {'technical'|'product'} */ (category)] : 0);
}
export const WINDOW = 20;
export const AGREEMENT_MIN = 0.9;

/**
 * Every person's decision on a predicted card, oldest first, with its slice and whether it agreed.
 * @param {Db} db
 * @returns {{id: number, fp: string, slice: string, agree: boolean, reversal: boolean, by: string, to: string}[]}
 */
function decisions(db) {
  return /** @type {Row[]} */ (db.prepare(
    `SELECT t.id, t.fp, t.to_status, t.by, p.lens, p.category, p.effort_json, p.predicted_verdict, p.pretriaged_by
     FROM transitions t JOIN proposals p ON p.fp = t.fp
     WHERE t.to_status IN ('accepted', 'rejected', 'snoozed') AND (t.by LIKE 'human:%' OR t.by LIKE 'forge:%')
       AND p.predicted_verdict IS NOT NULL ORDER BY t.id`,
  ).all()).map((r) => ({
    id: Number(r.id), fp: String(r.fp), by: String(r.by), to: String(r.to_status),
    slice: sliceKey({ category: r.category ?? undefined, lens: String(r.lens), effort: JSON.parse(String(r.effort_json)) }),
    agree: /** @type {Record<string, string>} */ (DECIDED)[String(r.to_status)] === r.predicted_verdict,
    reversal: r.pretriaged_by === MACHINE_DECIDER && r.to_status === 'rejected',
  }));
}

/**
 * Agreement over the last WINDOW decisions of `list` with an id in (after, upTo].
 * @param {{id: number, agree: boolean}[]} list
 * @param {number} after
 * @param {number} upTo
 * @returns {{n: number, agreement?: number}}
 */
function windowStats(list, after, upTo) {
  const w = list.filter((d) => d.id > after && d.id <= upTo).slice(-WINDOW);
  return w.length ? { n: w.length, agreement: Math.round((w.filter((d) => d.agree).length / w.length) * 1000) / 1000 } : { n: 0 };
}

/**
 * Replays the decisions recorded since the last sync and applies the ladder: each promotion or demotion updates
 * trust_state and appends one trust_events row. Idempotent. Returns the events it appended.
 * @param {Db} db
 * @returns {Row[]}
 */
export function syncTrust(db) {
  return tx(db, () => {
    const through = Number(/** @type {Row | undefined} */ (db.prepare("SELECT value FROM sync_state WHERE key = 'trust_through'").get())?.value ?? 0);
    const all = decisions(db);
    /** @type {Map<string, typeof all>} */
    const bySlice = new Map();
    /** @type {Row[]} */
    const events = [];
    const getState = db.prepare('SELECT * FROM trust_state WHERE slice = ?');
    const putState = db.prepare(`INSERT INTO trust_state (slice, level, window_after, changed_at, reason) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (slice) DO UPDATE SET level = excluded.level, window_after = excluded.window_after, changed_at = excluded.changed_at, reason = excluded.reason`);
    const putEvent = db.prepare('INSERT INTO trust_events (at, slice, from_level, to_level, reason, agreement, n, item_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    let last = through;
    for (const d of all) {
      const list = bySlice.get(d.slice) ?? [];
      bySlice.set(d.slice, list);
      list.push(d);
      if (d.id <= through) continue;
      last = d.id;
      const st = /** @type {Row | undefined} */ (getState.get(d.slice)) ?? { level: startOf(d.slice), window_after: 0 };
      const level = Number(st.level);
      const at = now();
      /** @param {number} to @param {string} reason @param {number} windowAfter @param {{n: number, agreement?: number}} s */
      const change = (to, reason, windowAfter, s) => {
        putState.run(d.slice, to, windowAfter, at, reason);
        putEvent.run(at, d.slice, level, to, reason, s.agreement ?? null, s.n, d.fp);
        events.push(/** @type {Row} */ (clean({ slice: d.slice, from: level, to, reason, agreement: s.agreement, n: s.n, item_id: d.fp, at })));
      };
      const s = windowStats(list, Number(st.window_after), d.id);
      if (d.reversal && level > 0) {
        change(level - 1, `reversal: ${d.by} rejected ${d.fp}, which ${MACHINE_DECIDER} pre-triaged`, d.id, s);
      } else if (level < CEILING && s.n >= WINDOW && (s.agreement ?? 0) >= AGREEMENT_MIN) {
        change(level + 1, `earned: predicted verdicts agreed on ${Math.round((s.agreement ?? 0) * 100)} % of the last ${s.n} decisions`, Number(st.window_after), s);
      } else if (!getState.get(d.slice)) {
        putState.run(d.slice, level, Number(st.window_after), null, null);
      }
    }
    if (last !== through) {
      db.prepare("INSERT INTO sync_state (key, value) VALUES ('trust_through', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(String(last));
    }
    return events;
  });
}

/**
 * The current level of a slice (START when it has no history).
 * @param {Db} db
 * @param {string} slice
 * @returns {number}
 */
export function levelOf(db, slice) {
  const r = /** @type {Row | undefined} */ (db.prepare('SELECT level FROM trust_state WHERE slice = ?').get(slice));
  return r ? Number(r.level) : startOf(slice);
}

/**
 * The slices of every proposal that is not dropped (the slices `pretriage` can meet), sorted.
 * @param {Db} db
 * @returns {string[]}
 */
function cardSlices(db) {
  return [...new Set(/** @type {Row[]} */ (db.prepare("SELECT lens, category, effort_json FROM proposals WHERE status <> 'dropped'").all())
    .map((r) => sliceKey({ category: r.category ?? undefined, lens: String(r.lens), effort: JSON.parse(String(r.effort_json)) })))].sort();
}

/**
 * `trust [--slice <key>]`: syncs, then reports every slice with history or with a card (a card-only slice at its
 * start level, as `pretriage` sees it) - `{slice, level, ceiling, start, n, agreement?, changed_at?, reason?}` (n
 * and agreement over the slice's current window) - and every trust event, oldest first. `slice` limits both to one
 * slice, reported at its start level even with no history. `sync: false`
 * reads without replaying (reflect export stays read-only; ingest-verdicts and move have synced already).
 * `events` keeps the newest `maxEvents` when given. `cards: false` lists only slices with history (reflect export:
 * `trust_json` on the Forge seam keeps its shape and content).
 * @param {Db} db
 * @param {{slice?: string, sync?: boolean, maxEvents?: number, cards?: boolean}} [o]
 * @returns {{slices: Row[], events: Row[]}}
 */
export function trustReport(db, { slice, sync = true, maxEvents, cards = true } = {}) {
  if (sync) syncTrust(db);
  const all = decisions(db);
  const states = /** @type {Row[]} */ (db.prepare('SELECT * FROM trust_state ORDER BY slice').all());
  const keys = slice !== undefined ? [slice] : [...new Set([...states.map((s) => String(s.slice)), ...(cards ? cardSlices(db) : [])])].sort();
  const slices = keys.map((k) => {
    const st = states.find((s) => s.slice === k);
    const s = windowStats(all.filter((d) => d.slice === k), Number(st?.window_after ?? 0), Number.MAX_SAFE_INTEGER);
    return /** @type {Row} */ (clean({
      slice: k, level: st ? Number(st.level) : startOf(k), ceiling: CEILING, start: startOf(k), n: s.n, agreement: s.agreement,
      changed_at: st?.changed_at, reason: st?.reason,
    }));
  });
  const events = /** @type {Row[]} */ (slice !== undefined
    ? db.prepare('SELECT * FROM trust_events WHERE slice = ? ORDER BY id').all(slice)
    : db.prepare('SELECT * FROM trust_events ORDER BY id').all())
    .map((e) => /** @type {Row} */ (clean({ slice: e.slice, from: e.from_level, to: e.to_level, reason: e.reason, agreement: e.agreement, n: e.n, item_id: e.item_id, at: e.at })));
  return { slices, events: maxEvents !== undefined ? events.slice(-maxEvents) : events };
}

/**
 * `pretriage --run <id>`: the store's L1 gate. Syncs trust, then marks `pretriaged_by: machine:dowser` on every
 * verified, ranked card of the run, predicted `accept`, not marked yet, whose slice is at level >= 1. No status
 * moves: the card stays verified and is pushed as usual; a person decides it in the inbox. Returns the cards it
 * marked and the cards left for the person (with their slice and its level).
 * @param {Db} db
 * @param {string} runId
 * @returns {Row}
 */
export function pretriageRun(db, runId) {
  syncTrust(db);
  return tx(db, () => {
    const rows = /** @type {Row[]} */ (db.prepare(
      "SELECT fp, title, lens, category, effort_json, band, predicted_verdict, pretriaged_by FROM proposals WHERE last_run_id = ? AND status = 'verified' ORDER BY lens, score DESC, fp",
    ).all(runId));
    const mark = db.prepare("UPDATE proposals SET pretriaged_by = ? WHERE fp = ? AND status = 'verified' AND pretriaged_by IS NULL");
    /** @type {Row[]} */
    const pretriaged = [];
    /** @type {Row[]} */
    const forPerson = [];
    for (const r of rows) {
      const slice = sliceKey({ category: r.category ?? undefined, lens: String(r.lens), effort: JSON.parse(String(r.effort_json)) });
      const level = levelOf(db, slice);
      const item = { fp: r.fp, title: r.title, slice, level };
      if (r.pretriaged_by === MACHINE_DECIDER) { pretriaged.push(item); continue; }
      if (level >= 1 && r.band === 'ranked' && r.predicted_verdict === 'accept') {
        mark.run(MACHINE_DECIDER, r.fp);
        pretriaged.push(item);
      } else forPerson.push(item);
    }
    return { run_id: runId, pretriaged, for_person: forPerson };
  });
}
