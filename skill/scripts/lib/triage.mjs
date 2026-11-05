// @ts-check
// The pre-triage sheet and its one-line decisions (`triage sheet`, `triage apply`). Reads the store and moves cards
// through store.move only: the same compare-and-set, transition table, decider guard and append-only transitions as
// `move`. Data only; the wording the runner sees lives in SKILL.md and references/.
//
// Numbering: every card the run's verify allocated (band set, last_run_id = the run), in pretriage's for_person
// order (lens, score desc, fp): ranked cards for the person first, then the reserve, then the machine pre-triaged.
// It does not depend on a card's current status, so a sheet's numbers still name the same cards after moves.
//
// apply's guarantee: (1) every line is validated (row number, verb, and the move path's own input rules, via
// moveProblem) before the first move - one bad line refuses the whole sheet (exit 2) and nothing moves; (2) the moves
// run inside ONE BEGIN IMMEDIATE transaction, so no other writer interleaves with the batch and an unexpected error
// rolls every move back; (3) a card whose status is no longer `verified` (decided elsewhere after the sheet was
// read) is refused by the CAS and reported with its current status, and the other lines still apply (exit 1).
import { DowserError, MoveRefused } from './model.mjs';
import { clean, move, moveProblem, tx } from './store.mjs';
import { similar } from './memory.mjs';
import { syncTrust } from './trust.mjs';

/** @import { Db, Row } from './store-core.mjs' */

const MACHINE = 'machine:dowser';
const FP_RE = /^[0-9a-f]{16}$/;

/**
 * The run's numbered cards, without lookalikes: `{n, row}` in sheet order, split into its three sections.
 * @param {Db} db
 * @param {string} runId
 */
function numbered(db, runId) {
  if (!db.prepare('SELECT 1 FROM runs WHERE id = ?').get(runId)) throw new DowserError(`run ${runId} does not exist`, 2, { error: 'not-found', run_id: runId });
  const all = /** @type {Row[]} */ (db.prepare(`SELECT fp, lens, title, score, effort_json, confidence, mvp, band, predicted_verdict,
      predicted_why, pretriaged_by, status FROM proposals WHERE last_run_id = ? AND band IS NOT NULL ORDER BY lens, score DESC, fp`).all(runId));
  const person = all.filter((r) => r.pretriaged_by !== MACHINE);
  const sections = {
    rows: person.filter((r) => r.band === 'ranked'),
    reserve: person.filter((r) => r.band !== 'ranked'),
    pretriaged: all.filter((r) => r.pretriaged_by === MACHINE),
  };
  let n = 0;
  /** @type {Map<number, Row>} */
  const byN = new Map();
  const out = /** @type {Record<keyof typeof sections, {n: number, row: Row}[]>} */ ({});
  for (const [k, list] of /** @type {[keyof typeof sections, Row[]][]} */ (Object.entries(sections))) {
    out[k] = list.map((row) => { n++; byN.set(n, row); return { n, row }; });
  }
  return { sections: out, byN };
}

/**
 * The nearest rejected or snoozed `similar` hit: the "looks like" fact of SKILL.md section 6, for the agent to judge.
 * @param {Db} db
 * @param {string} fp
 */
function lookalike(db, fp) {
  const hit = /** @type {Row[]} */ (similar(db, fp).similar).find((h) => h.status === 'rejected' || h.status === 'snoozed');
  return hit ? clean({ fp: hit.fp, title: hit.title, status: hit.status, decided_at: hit.decided_at, reason: hit.reason, lens: hit.lens }) : undefined;
}

/**
 * `triage sheet --run <id>` (read-only): `{run_id, rows, reserve, pretriaged}`, each row
 * `{n, fp, lens, mvp?, title, score?, size, confidence, predicted_verdict?, predicted_why?, status, lookalike?}`.
 * @param {Db} db
 * @param {string} runId
 * @returns {Row}
 */
export function triageSheet(db, runId) {
  const { sections } = numbered(db, runId);
  /** @param {{n: number, row: Row}} x */
  const row = ({ n, row: r }) => clean({
    n, fp: r.fp, lens: r.lens, mvp: r.mvp ? true : undefined, title: r.title, score: r.score ?? undefined,
    size: JSON.parse(String(r.effort_json)).size, confidence: r.confidence, predicted_verdict: r.predicted_verdict ?? undefined,
    predicted_why: r.predicted_why ?? undefined, status: r.status, lookalike: lookalike(db, String(r.fp)),
  });
  return { run_id: runId, rows: sections.rows.map(row), reserve: sections.reserve.map(row), pretriaged: sections.pretriaged.map(row) };
}

/**
 * @typedef {{line: number, text: string, ns: number[], to?: 'rejected' | 'snoozed' | 'merged', reason?: string, note?: string,
 *   until?: string, into?: string, rest?: true}} Decision
 */

/** @param {string} s */
const unquote = (s) => s.replace(/^(["'])(.*)\1$/s, '$2');

/**
 * The entries of a decision line: split on `;` and newlines outside double quotes, so a quoted note keeps its `;`.
 * @param {string} text
 * @returns {string[]}
 */
export function splitEntries(text) {
  /** @type {string[]} */
  const out = [];
  let cur = '';
  let quoted = false;
  for (const ch of String(text)) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && (ch === ';' || ch === '\n')) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map((e) => e.trim()).filter(Boolean);
}

/**
 * Parses a decision line: `;`- or newline-separated entries (a `;` inside a double-quoted note stays in it) `<n>[,<n>...] keep | reject <code> [note] | snooze
 * [YYYY-MM-DD] | merge <n | fp>`, and `rest keep`. Returns the entries and the problems (line, text, problem).
 * @param {string} text
 */
export function parseDecisions(text) {
  /** @type {Decision[]} */
  const out = [];
  /** @type {{line: number, text: string, problem: string}[]} */
  const problems = [];
  splitEntries(text).forEach((entry, i) => {
    const line = i + 1;
    const bad = (/** @type {string} */ problem) => problems.push({ line, text: entry, problem });
    const m = /^(\S+)\s*(\S*)\s*(.*)$/s.exec(entry);
    const [head, verb, args] = m ? [m[1], m[2], m[3].trim()] : ['', '', ''];
    if (head === 'rest') {
      if (verb !== 'keep' || args) return bad('rest only takes keep (rest keep)');
      out.push({ line, text: entry, ns: [], rest: true });
      return;
    }
    if (!/^\d+(,\d+)*$/.test(head)) return bad('starts with a card number (or rest)');
    const ns = head.split(',').map(Number);
    if (verb === 'keep') {
      if (args) return bad('keep takes nothing after it');
      out.push({ line, text: entry, ns });
    } else if (verb === 'reject') {
      const [code, ...note] = args.split(/\s+/);
      out.push({ line, text: entry, ns, to: 'rejected', reason: code || undefined, note: note.length ? unquote(note.join(' ')) : undefined });
    } else if (verb === 'snooze') {
      if (args.includes(' ')) return bad('snooze takes one date YYYY-MM-DD, or none');
      out.push({ line, text: entry, ns, to: 'snoozed', until: args || undefined });
    } else if (verb === 'merge') {
      if (args.includes(' ')) return bad('merge takes one card number or fp');
      out.push({ line, text: entry, ns, to: 'merged', into: args || undefined });
    } else bad(`${verb ? JSON.stringify(verb) : 'nothing'} after the number: each card is keep, reject, snooze or merge`);
  });
  return { decisions: out, problems };
}

/**
 * `triage apply --run <id> --by human:<name> --decisions '<line>' [--dry-run]` (guarantee in the header).
 * @param {Db} db
 * @param {string} runId
 * @param {{by: string, decisions: string, dryRun?: boolean, today?: string}} o
 * @returns {{code: number, out: Row}}
 */
export function applyDecisions(db, runId, { by, decisions, dryRun = false, today }) {
  if (!/^human:/.test(by)) throw new DowserError(`--by is the person who made these decisions, human:<name> (got ${JSON.stringify(by)})`, 2);
  const { byN } = numbered(db, runId);
  const parsed = parseDecisions(decisions);
  const problems = [...parsed.problems];
  /** @type {Map<number, number>} card number -> the line that decided it */
  const seen = new Map();
  /** @type {{n: number, fp: string, to: string, reason?: string, note?: string, until?: string, into?: string}[]} */
  const moves = [];
  const exists = db.prepare('SELECT 1 FROM proposals WHERE fp = ?');
  for (const d of parsed.decisions) {
    const bad = (/** @type {string} */ problem) => problems.push({ line: d.line, text: d.text, problem });
    for (const n of d.ns) {
      const row = byN.get(n);
      if (!row) { bad(`no card numbered ${n} on this run's sheet (1-${byN.size})`); continue; }
      if (seen.has(n)) { bad(`card ${n} is decided twice (line ${seen.get(n)} and line ${d.line})`); continue; }
      seen.set(n, d.line);
      if (!d.to) continue;
      const fp = String(row.fp);
      /** @type {string | undefined} */
      let into = d.into;
      if (into !== undefined && /^\d+$/.test(into)) {
        const target = byN.get(Number(into));
        if (!target) { bad(`merge target ${into} is not a card on this run's sheet`); continue; }
        into = String(target.fp);
      } else if (into !== undefined && (!FP_RE.test(into) || !exists.get(into))) { bad(`--into ${into} is not a known proposal`); continue; }
      const problem = moveProblem(fp, d.to, { by, reason: d.reason, note: d.note, into, until: d.until, today });
      if (problem) { bad(problem); continue; }
      moves.push(/** @type {any} */ (clean({ n, fp, to: d.to, reason: d.reason, note: d.note, until: d.until, into })));
    }
  }
  for (const m of moves) {
    const target = m.into && moves.find((x) => x.fp === m.into && x.to === 'merged');
    if (target) problems.push({ line: /** @type {number} */ (seen.get(m.n)), text: `${m.n} merge`, problem: `card ${target.n} is merged by this sheet too; merge into the card it goes to` });
  }
  if (problems.length) {
    problems.sort((a, b) => a.line - b.line);
    throw new DowserError(`nothing moved; ${problems.map((p) => `line ${p.line} (${p.text}): ${p.problem}`).join('; ')}`, 2, { error: 'bad-input', problems });
  }
  const kept = [...byN.keys()].filter((n) => !moves.some((m) => m.n === n));
  const status = db.prepare('SELECT status FROM proposals WHERE fp = ?');
  if (dryRun) {
    const current = (/** @type {string} */ fp) => String(/** @type {Row} */ (status.get(fp)).status);
    const wouldRefuse = moves.filter((m) => current(m.fp) !== 'verified').map((m) => ({ n: m.n, fp: m.fp, to: m.to, current: current(m.fp) }));
    const wouldApply = moves.filter((m) => current(m.fp) === 'verified');
    return { code: wouldRefuse.length ? 1 : 0, out: { run_id: runId, by, dry_run: true, would_apply: wouldApply, would_refuse: wouldRefuse, kept } };
  }
  /** @type {Row[]} */
  const applied = [];
  /** @type {Row[]} */
  const refused = [];
  tx(db, () => {
    for (const m of moves) {
      try {
        const row = move(db, m.fp, m.to, { from: 'verified', by, reason: m.reason, note: m.note, into: m.into, until: m.until, runId, today });
        applied.push(/** @type {Row} */ (clean({ n: m.n, fp: m.fp, to: row.status, reason: row.reason, note: row.note, merged_into: row.merged_into, snooze_until: row.snooze_until })));
      } catch (e) {
        if (!(e instanceof MoveRefused)) throw e;
        refused.push({ n: m.n, fp: m.fp, to: m.to, current: e.current, message: e.message });
      }
    }
  });
  const events = syncTrust(db);
  return { code: refused.length ? 1 : 0, out: { run_id: runId, by, applied, refused, kept, ...(events.length ? { trust_events: events } : {}) } };
}
