// @ts-check
// The Dowser store's proposals: reading a card and its append-only evidence and transitions, propose (one
// candidate line into a running run, with the resurfacing rule), move (the compare-and-set status move), and the
// snooze date helpers (untilProblem, wakeSnoozed, withSnoozeUntil). Imports store-core.mjs, never runs.mjs.
import {
  DECIDER_RE, DowserError, MoveRefused, STATUSES,
  canMove, deciderAllowed, decisionProblem, isOneOf, resurfaces, validateCandidate,
} from './model.mjs';
import { evidenceKey, fingerprint, normalizeAnchor, normalizeTopic } from './fingerprint.mjs';
import { SYSTEM_DECIDER, clean, localDate, now, requireRunning, sql, tx } from './store-core.mjs';
import { closestPrecedent, predictionOf, scoreOf } from './predict.mjs';

/** @import { Db, Row, EvidenceSnapshot, ProposeResult } from './store-core.mjs' */

/** @param {unknown} v */
const json = (v) => (v === undefined ? null : JSON.stringify(v));

/**
 * Why `until` is not a usable snooze date (a real calendar date `YYYY-MM-DD` after `today`), else undefined.
 * @param {string} until
 * @param {string} today `YYYY-MM-DD`
 * @returns {string | undefined}
 */
export function untilProblem(until, today) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(until);
  const d = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : undefined;
  if (!m || !d || d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) {
    return `--until is a calendar date YYYY-MM-DD (got ${JSON.stringify(until)})`;
  }
  if (until <= today) return `--until must be after today (${today}); got ${until}`;
  return undefined;
}

/**
 * Wakes snoozed items whose date has passed (`snooze_until <= today`): each is a compare-and-set move
 * `snoozed -> verified` by SYSTEM_DECIDER with the note `snooze until <date> passed`, recorded in `transitions`.
 * An item with no date stays snoozed (it comes back only on new evidence).
 * @param {Db} db
 * @param {{today: string, runId?: string}} o
 * @returns {string[]} the fingerprints that woke, in fp order
 */
export function wakeSnoozed(db, { today, runId }) {
  return tx(db, () => {
    const due = /** @type {Row[]} */ (db.prepare(`SELECT fp, snooze_until FROM proposals
      WHERE status = 'snoozed' AND snooze_until IS NOT NULL AND snooze_until <= ? ORDER BY fp`).all(today));
    for (const r of due) {
      move(db, String(r.fp), 'verified', { from: 'snoozed', by: SYSTEM_DECIDER, note: `snooze until ${r.snooze_until} passed`, runId });
    }
    return due.map((r) => String(r.fp));
  });
}

/**
 * The rows with `snooze_until` added to each snoozed one that has a date (`list` rows; absent stays omitted).
 * @param {Db} db
 * @param {Row[]} rows
 * @returns {Row[]}
 */
export function withSnoozeUntil(db, rows) {
  const get = db.prepare('SELECT snooze_until FROM proposals WHERE fp = ?');
  return rows.map((r) => {
    if (r.status !== 'snoozed') return r;
    const until = /** @type {Row | undefined} */ (get.get(r.fp))?.snooze_until;
    return until ? { ...r, snooze_until: until } : r;
  });
}

// ------------------------------------------------------------------------------------------------ proposals

/**
 * A proposal row as a `dowser-proposal/1` record (JSON columns parsed, absent keys omitted), with its evidence.
 * @param {Db} db
 * @param {string} fp
 * @returns {Row | undefined}
 */
export function getProposal(db, fp) {
  const r = clean(/** @type {Row | undefined} */ (db.prepare('SELECT * FROM proposals WHERE fp = ?').get(fp)));
  if (!r) return undefined;
  /** @type {Row} */
  const out = {};
  for (const [k, v] of Object.entries(r)) {
    if (k.endsWith('_json')) out[k.slice(0, -5)] = JSON.parse(v);
    else out[k] = v;
  }
  delete out.asserted;
  if (out.mvp === 1) out.mvp = true; else delete out.mvp;
  out.evidence = evidenceOf(db, fp).map(({ type, ref, quote, url }) => clean({ type, ref, quote, url }));
  return out;
}

/**
 * The append-only evidence rows of a fingerprint, oldest first.
 * @param {Db} db
 * @param {string} fp
 * @returns {Row[]}
 */
export function evidenceOf(db, fp) {
  return /** @type {Row[]} */ (db.prepare('SELECT * FROM evidence WHERE fp = ? ORDER BY id').all(fp)).map((r) => /** @type {Row} */ (clean(r)));
}

/**
 * The append-only transition history of a fingerprint, oldest first.
 * @param {Db} db
 * @param {string} fp
 * @returns {Row[]}
 */
export function transitionsOf(db, fp) {
  return /** @type {Row[]} */ (db.prepare('SELECT * FROM transitions WHERE fp = ? ORDER BY id').all(fp)).map((r) => /** @type {Row} */ (clean(r)));
}

/**
 * The evidence the fingerprint's NEWEST propose line carried (`proposals.asserted_json`), each joined to its
 * evidence row, with the ref and line hint as that line gave them. This is what `verify` checks: a quote an
 * earlier line carried and the newest one no longer does is stale and never re-checked.
 * @param {Db} db
 * @param {string} fp
 * @returns {Row[]}
 */
export function assertedEvidence(db, fp) {
  const p = /** @type {Row | undefined} */ (db.prepare('SELECT asserted_json FROM proposals WHERE fp = ?').get(fp));
  if (!p) return [];
  const get = db.prepare('SELECT * FROM evidence WHERE fp = ? AND type = ? AND key = ?');
  /** @type {Row[]} */
  const out = [];
  for (const a of /** @type {Row[]} */ (JSON.parse(p.asserted_json))) {
    const row = /** @type {Row | undefined} */ (get.get(fp, a.type, a.key));
    if (row) out.push(/** @type {Row} */ (clean({ ...row, ref: a.ref, line: a.line ?? null })));
  }
  return out;
}

/**
 * The evidence snapshot of a fingerprint (all of it, or up to evidence id `seq`): `refs` counts distinct
 * evidence keys, so a re-assertion or a line shift never counts as new evidence.
 * @param {Db} db
 * @param {string} fp
 * @param {number} [seq]
 * @returns {EvidenceSnapshot & {seq: number}}
 */
export function evidenceSnapshot(db, fp, seq) {
  const rows = /** @type {Row[]} */ (db.prepare('SELECT id, type, key FROM evidence WHERE fp = ? AND id <= ? ORDER BY id').all(fp, seq ?? Number.MAX_SAFE_INTEGER));
  const keys = new Set(rows.map((r) => `${r.type}\u0000${r.key}`));
  return { refs: keys.size, types: [...new Set(rows.map((r) => String(r.type)))].sort(), seq: rows.length ? Number(rows[rows.length - 1].id) : 0 };
}

/** The resurfacing predicate lives in model.mjs (pure, shared with the Forge app); re-exported here. */
export { resurfaces } from './model.mjs';

/**
 * Proposes one candidate line into a running run.
 *  - new fp -> inserted as `candidate` (`created`);
 *  - existing fp -> evidence appended (one row per evidence key per run). A `snoozed`/`rejected` item that
 *    meets the resurfacing rule moves to `candidate` (`evidence-grew`, with `resurfaced`); one that does not
 *    is `suppressed`. A `dropped` item with a NEW evidence key moves to `candidate` (a retry); with only known
 *    keys it stays dropped. Any other status: `evidence-grew` when a new key landed, else `duplicate`.
 *  - `provenance.run_id` is stamped from `runId`; a different one on the line is overwritten and noted.
 *  - an invalid candidate: `invalid:<why>`; nothing is written.
 * Card text is refreshed only while the item is a `candidate` (a verified/pushed card is what a person saw).
 * @param {Db} db
 * @param {string} runId
 * @param {unknown} input
 * @param {{kinds: Record<string, readonly string[]>}} opts
 * @returns {ProposeResult}
 */
export function propose(db, runId, input, { kinds }) {
  const run = requireRunning(db, runId);
  const v = validateCandidate(input);
  if (!v.ok) return { result: `invalid:${v.why}` };
  const c = v.value;
  /** @type {string} */
  let fp;
  try { fp = fingerprint(c, kinds[c.lens] ?? []); } catch (e) {
    if (e instanceof DowserError) return { result: `invalid:${e.message}` };
    throw e;
  }
  if (c.fp !== undefined && c.fp !== fp) return { result: `invalid:fp-mismatch (computed ${fp})` };
  const note = c.provenance.run_id !== undefined && c.provenance.run_id !== runId
    ? `provenance.run_id ${c.provenance.run_id} replaced by ${runId}` : undefined;
  const provenance = clean({ ...c.provenance, run_id: runId, model: c.provenance.model ?? run.model, harness: c.provenance.harness ?? run.harness, focus: c.provenance.focus ?? run.focus });
  const anchors = [...new Set(c.anchors.map(normalizeAnchor).filter(Boolean))].sort();
  const s = scoreOf(c);
  const card = {
    title: c.title, rationale: c.rationale, body: c.body, effort_json: json(s.effort), confidence: c.confidence,
    confidence_why: c.confidence_why, doc_impact_json: json(c.doc_impact), delivery_risk_json: json(c.delivery_risk),
    provenance_json: json(provenance), artifacts_json: json(c.artifacts),
    impact: sql(c.impact), impact_why: sql(c.impact_why), risk: sql(s.risk), category: s.category,
    score: sql(s.score), score_parts_json: json(s.score_parts),
    // shadow mode: the prediction is recorded now, before any person sees the card
    ...predictionOf(c, closestPrecedent(db, { fp, lens: c.lens, topic: normalizeTopic(c.topic), anchors }), provenance?.model),
  };
  const SCORED = ['impact', 'impact_why', 'risk', 'category', 'score', 'score_parts_json', 'predicted_verdict', 'predicted_why', 'predicted_by'];
  /** @type {(import('node:sqlite').SQLInputValue)[]} */
  const scored = SCORED.map((k) => /** @type {any} */ (card)[k]);

  return tx(db, () => {
    const at = now();
    const existing = /** @type {Row | undefined} */ (db.prepare('SELECT status FROM proposals WHERE fp = ?').get(fp));
    const addEvidence = () => {
      const known = new Set(/** @type {Row[]} */ (db.prepare('SELECT DISTINCT type, key FROM evidence WHERE fp = ?').all(fp)).map((r) => `${r.type}\u0000${r.key}`));
      const ins = db.prepare('INSERT INTO evidence (fp, run_id, type, ref, key, path, line, quote, url, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      let added = 0;
      /** @type {Map<string, Row>} */
      const asserted = new Map();
      for (const e of c.evidence) {
        const k = evidenceKey(e);
        const id = `${e.type}\u0000${k.key}`;
        asserted.set(id, clean({ type: e.type, key: k.key, ref: e.ref.trim(), line: k.line }) ?? {});
        if (known.has(id)) continue;
        ins.run(fp, runId, e.type, e.ref.trim(), k.key, sql(k.path), sql(k.line), sql(e.quote), sql(e.url), at);
        known.add(id);
        added++;
      }
      db.prepare('UPDATE proposals SET asserted_json = ? WHERE fp = ?').run(JSON.stringify([...asserted.values()]), fp);
      return added;
    };
    const refreshCard = () => db.prepare(`UPDATE proposals SET title = ?, rationale = ?, body = ?, effort_json = ?, confidence = ?,
        confidence_why = ?, doc_impact_json = ?, delivery_risk_json = ?, provenance_json = ?, artifacts_json = ?,
        ${SCORED.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE fp = ?`)
      .run(card.title, card.rationale, card.body, card.effort_json, card.confidence, card.confidence_why,
        card.doc_impact_json, card.delivery_risk_json, card.provenance_json, card.artifacts_json, ...scored, at, fp);

    if (!existing) {
      db.prepare(`INSERT INTO proposals (fp, lens, kind, topic, anchors_json, title, rationale, body, effort_json, confidence,
          confidence_why, doc_impact_json, delivery_risk_json, provenance_json, artifacts_json, ${SCORED.join(', ')}, status, first_run_id, last_run_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${SCORED.map(() => '?').join(', ')}, 'candidate', ?, ?, ?, ?)`)
        .run(fp, c.lens, c.kind, normalizeTopic(c.topic), JSON.stringify(anchors), card.title, card.rationale, card.body,
          card.effort_json, card.confidence, card.confidence_why, card.doc_impact_json, card.delivery_risk_json,
          card.provenance_json, card.artifacts_json, ...scored, runId, runId, at, at);
      const added = addEvidence();
      appendTransition(db, { fp, from: undefined, to: 'candidate', by: SYSTEM_DECIDER, at, runId });
      return /** @type {ProposeResult} */ (clean({ result: 'created', fp, added, status: 'candidate', note }));
    }

    const status = String(existing.status);
    const added = addEvidence();
    db.prepare('UPDATE proposals SET last_run_id = ?, updated_at = ? WHERE fp = ?').run(runId, at, fp);

    if (status === 'snoozed' || status === 'rejected' || status === 'dropped') {
      const then = enteredSnapshot(db, fp, status);
      const nowSnap = evidenceSnapshot(db, fp);
      const r = resurfaces(status, then, nowSnap);
      if (!r.resurface) {
        const stays = status === 'dropped' ? (added > 0 ? 'evidence-grew' : 'duplicate') : 'suppressed';
        return /** @type {ProposeResult} */ (clean({ result: stays, fp, added, status, note }));
      }
      move(db, fp, 'candidate', { from: status, by: SYSTEM_DECIDER, note: `resurfaced:${r.rule}`, runId });
      refreshCard();
      return /** @type {ProposeResult} */ (clean({ result: 'evidence-grew', fp, added, status: 'candidate', resurfaced: { from: status, rule: r.rule }, note }));
    }
    if (status === 'candidate') refreshCard();
    return /** @type {ProposeResult} */ (clean({ result: added > 0 ? 'evidence-grew' : 'duplicate', fp, added, status, note }));
  });
}

/**
 * The evidence snapshot recorded when the fp last entered `status` (from its transition's evidence_seq).
 * @param {Db} db
 * @param {string} fp
 * @param {string} status
 * @returns {EvidenceSnapshot}
 */
function enteredSnapshot(db, fp, status) {
  const t = /** @type {Row | undefined} */ (db.prepare('SELECT evidence_seq FROM transitions WHERE fp = ? AND to_status = ? ORDER BY id DESC LIMIT 1').get(fp, status));
  return evidenceSnapshot(db, fp, t ? Number(t.evidence_seq) : 0);
}

/**
 * @param {Db} db
 * @param {{fp: string, from: string | undefined, to: string, by: string, at: string, reason?: string, note?: string, runId?: string}} t
 */
function appendTransition(db, { fp, from, to, by, at, reason, note, runId }) {
  const seq = evidenceSnapshot(db, fp).seq;
  db.prepare('INSERT INTO transitions (fp, from_status, to_status, by, at, reason, note, run_id, evidence_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(fp, sql(from), to, by, at, sql(reason), sql(note), sql(runId), seq);
}

/**
 * Moves a proposal's status: a compare-and-set against model.TRANSITIONS. `from` (when given) is the status
 * the caller expects; a different current status is a stale refusal. An illegal or stale move throws
 * MoveRefused (exit 2) carrying the current status. Every move appends one `transitions` row and sets
 * reason / note / merged_into / decided_by / decided_at on the card. `until` (a date after `today`, only with
 * `to` = snoozed) sets `snooze_until`; every other move, and a snooze without a date, clears it. `untilMayBePast`
 * is for sync only: a snooze decided in the Jira inbox with a date that has passed by the time the skill pulls it
 * is still that person's decision, so it is recorded with its date and the next run start wakes it
 * (wakeSnoozed). A person's `move --until` never sets it and keeps refusing past dates.
 * @param {Db} db
 * @param {string} fp
 * @param {string} to
 * @param {{from?: string, by: string, reason?: string, note?: string, into?: string, runId?: string, until?: string, today?: string, untilMayBePast?: boolean}} opts
 * @returns {Row} the updated proposal row (absent columns omitted)
 */
export function move(db, fp, to, { from, by, reason, note, into, runId, until, today, untilMayBePast }) {
  if (!isOneOf(STATUSES, to)) throw new DowserError(`--to must be one of ${STATUSES.join('|')}`, 2);
  if (from !== undefined && !isOneOf(STATUSES, from)) throw new DowserError(`--from must be one of ${STATUSES.join('|')}`, 2);
  if (!by || !DECIDER_RE.test(by)) throw new DowserError(`--by names the decider as <kind>:<name>, e.g. operator:jane (got ${JSON.stringify(by)})`, 2);
  const problem = decisionProblem({ to, reason, note });
  if (problem) throw new DowserError(problem, 2);
  if (to === 'merged' && !into) throw new DowserError('a merge needs --into <fp>', 2);
  if (to !== 'merged' && into !== undefined) throw new DowserError('--into goes only with --to merged', 2);
  if (into !== undefined && into === fp) throw new DowserError('a proposal cannot merge into itself', 2);
  if (until !== undefined && to !== 'snoozed') throw new DowserError('--until goes only with --to snoozed', 2);
  // '' sorts before every date, so a past date passes while the calendar-date check still applies
  const badUntil = until === undefined ? undefined : untilProblem(until, untilMayBePast ? '' : today ?? localDate());
  if (badUntil) throw new DowserError(badUntil, 2);

  return tx(db, () => {
    const cur = /** @type {Row | undefined} */ (db.prepare('SELECT status FROM proposals WHERE fp = ?').get(fp));
    if (!cur) throw new MoveRefused(`proposal ${fp} does not exist`, { fp, current: 'not-found', to });
    const current = String(cur.status);
    if (from !== undefined && from !== current) {
      throw new MoveRefused(`stale move: ${fp} is ${current}, not ${from}`, { fp, current, to, from });
    }
    if (!canMove(current, to)) throw new MoveRefused(`illegal move: ${fp} is ${current}; ${current} -> ${to} is not allowed`, { fp, current, to });
    if (!deciderAllowed(current, to, by)) {
      throw new MoveRefused(`refused: ${current} -> ${to} needs a human decider (--by human:<name>), got ${by}`, { fp, current, to });
    }
    if (into !== undefined && !db.prepare('SELECT 1 FROM proposals WHERE fp = ?').get(into)) {
      throw new DowserError(`--into ${into} is not a known proposal`, 2);
    }
    const at = now();
    const row = /** @type {Row | undefined} */ (db.prepare(`UPDATE proposals SET status = ?, reason = ?, note = ?, merged_into = ?,
        snooze_until = ?, decided_by = ?, decided_at = ?, updated_at = ? WHERE fp = ? AND status = ? RETURNING *`)
      .get(to, sql(reason), sql(note), sql(into), sql(until), by, at, at, fp, current));
    if (!row) {
      const again = /** @type {Row | undefined} */ (db.prepare('SELECT status FROM proposals WHERE fp = ?').get(fp));
      throw new MoveRefused(`stale move: ${fp} changed under us`, { fp, current: again ? String(again.status) : 'not-found', to, from: current });
    }
    appendTransition(db, { fp, from: current, to, by, at, reason, note, runId });
    return /** @type {Row} */ (clean(row));
  });
}

/**
 * Fingerprints of `candidate` proposals the run touched (proposed or re-proposed in it).
 * @param {Db} db
 * @param {string} runId
 * @returns {string[]}
 */
export function candidatesOfRun(db, runId) {
  return /** @type {Row[]} */ (db.prepare("SELECT fp FROM proposals WHERE last_run_id = ? AND status = 'candidate' ORDER BY fp").all(runId)).map((r) => String(r.fp));
}
