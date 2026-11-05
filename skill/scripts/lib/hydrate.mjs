// @ts-check
// `hydrate`: a fresh store (a teammate, a reinstall, a CI runner) takes the team's decisions from the Dowser inbox
// (`dowser_memory_pull`, forge/src/core/memory.mjs) instead of re-proposing everything the team already decided.
// Each decided item is stored as the decided card it is: its record, its evidence, and ONE transition
// (NULL -> its status) by the person who decided it in Jira, at the time they did. Suppression, `near`, precedents
// and trust then work from the first run. Decided rules are stored as decided. An fp the store already holds is
// left alone (local memory wins); evidence and transitions stay append-only.
// The rows belong to one run per call, harness `dowser-hydrate`, which is closed `done` at once and is never an
// incremental base (store-core lastDoneRun skips it): it scanned nothing.
import { CONFIDENCES, DECIDER_RE, DowserError, LENSES, REASONS, isOneOf } from './model.mjs';
import { evidenceKey, fingerprint, normalizeAnchor, normalizeTopic } from './fingerprint.mjs';
import { evidenceSnapshot } from './proposals.mjs';
import { clean, newRunId, now, sql, tx } from './store-core.mjs';

/** @typedef {import('./store-core.mjs').Db} Db */
/** @typedef {Record<string, any>} Row */

export const HYDRATE_HARNESS = 'dowser-hydrate';
const DECIDED = ['accepted', 'rejected', 'snoozed', 'merged'];
/** The scan-finding/1 columns copied from the record when present (wire key -> column). */
const SCORED = /** @type {const} */ ([['impact', 'impact'], ['impact_why', 'impact_why'], ['risk', 'risk'], ['category', 'category'],
  ['score', 'score'], ['score_parts', 'score_parts_json'], ['band', 'band'], ['mvp', 'mvp'], ['mvp_rule', 'mvp_rule'], ['mvp_why', 'mvp_why'],
  ['predicted_verdict', 'predicted_verdict'], ['predicted_why', 'predicted_why'], ['predicted_by', 'predicted_by'], ['pretriaged_by', 'pretriaged_by']]);

const str = (/** @type {unknown} */ v) => typeof v === 'string' && v.trim() !== '';
const obj = (/** @type {unknown} */ v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Why one pulled item cannot be stored, or undefined.
 * @param {Row} it
 * @returns {string | undefined}
 */
function problem(it) {
  for (const k of ['fp', 'kind', 'topic', 'title', 'rationale', 'body', 'confidence_why', 'decided_by', 'decided_at']) if (!str(it[k])) return `${k} is required`;
  if (!isOneOf(LENSES, it.lens)) return `lens must be one of ${LENSES.join('|')}`;
  if (!isOneOf(CONFIDENCES, it.confidence)) return 'confidence must be low|medium|high';
  if (!DECIDED.includes(it.status)) return `status must be one of ${DECIDED.join('|')}`;
  if (it.reason !== undefined && !isOneOf(REASONS, it.reason)) return `reason must be one of ${REASONS.join('|')}`;
  if (!DECIDER_RE.test(String(it.decided_by))) return 'decided_by is a decider <kind>:<name>';
  if (!Array.isArray(it.anchors) || !it.anchors.every(str)) return 'anchors is a list of strings';
  if (!obj(it.effort) || !obj(it.provenance)) return 'effort and provenance are objects';
  if (!Array.isArray(it.evidence) || it.evidence.some((/** @type {unknown} */ e) => !obj(e) || !str(/** @type {Row} */ (e).type) || !str(/** @type {Row} */ (e).ref))) return 'evidence is a list of {type, ref}';
  let fp;
  try { fp = fingerprint({ lens: it.lens, kind: it.kind, topic: it.topic, anchors: it.anchors }, [it.kind]); } catch (e) { return /** @type {Error} */ (e).message; }
  if (fp !== it.fp) return `fp does not match the record (computed ${fp})`;
  return undefined;
}

/**
 * Stores a `dowser_memory_pull` page. Output `{run, added, present, rules_added, cursor, more?, invalid?}`; exit 1
 * when an item or rule was malformed (listed; the rest is stored). `more: true` = pull again with `after: cursor`.
 * @param {Db} db
 * @param {unknown} doc
 * @returns {{code: number, out: Row}}
 */
export function hydrate(db, doc) {
  if (!obj(doc) || !Array.isArray(/** @type {Row} */ (doc).items) || typeof /** @type {Row} */ (doc).cursor !== 'string') {
    throw new DowserError('not a dowser_memory_pull response: expected {"items": [...], "cursor": "..."}', 2);
  }
  const d = /** @type {Row} */ (doc);
  return tx(db, () => {
    const at = now();
    const run = newRunId();
    db.prepare(`INSERT INTO runs (id, started_at, finished_at, mode, harness, status) VALUES (?, ?, ?, 'full', ?, 'done')`).run(run, at, at, HYDRATE_HARNESS);
    const has = db.prepare('SELECT 1 FROM proposals WHERE fp = ?');
    const refTaken = db.prepare('SELECT 1 FROM proposals WHERE external_ref = ?');
    const insEv = db.prepare('INSERT OR IGNORE INTO evidence (fp, run_id, type, ref, key, path, line, quote, url, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    let added = 0;
    let present = 0;
    /** @type {Row[]} */
    const invalid = [];
    /** @type {[string, string][]} */
    const merges = [];
    for (const [i, raw] of /** @type {unknown[]} */ (d.items).entries()) {
      const it = /** @type {Row} */ (obj(raw) ? raw : {});
      const why = problem(it);
      if (why) { invalid.push({ kind: 'item', index: i, ...clean({ fp: str(it.fp) ? it.fp : undefined }), why }); continue; }
      const fp = String(it.fp);
      if (has.get(fp)) { present++; continue; }
      const anchors = [...new Set(/** @type {string[]} */ (it.anchors).map(normalizeAnchor).filter(Boolean))].sort();
      /** @type {Record<string, import('node:sqlite').SQLInputValue>} */
      const scored = {};
      for (const [k, col] of SCORED) {
        const v = it[k];
        if (v === undefined || v === null) continue;
        scored[col] = col === 'score_parts_json' ? JSON.stringify(v) : col === 'mvp' ? (v === true ? 1 : null) : v;
      }
      const ext = str(it.external_ref) && !refTaken.get(String(it.external_ref)) ? String(it.external_ref) : null;
      const cols = {
        fp, lens: it.lens, kind: it.kind, topic: normalizeTopic(it.topic), anchors_json: JSON.stringify(anchors), title: it.title,
        rationale: it.rationale, body: it.body, effort_json: JSON.stringify(it.effort), confidence: it.confidence,
        confidence_why: it.confidence_why, doc_impact_json: it.doc_impact ? JSON.stringify(it.doc_impact) : null,
        delivery_risk_json: it.delivery_risk ? JSON.stringify(it.delivery_risk) : null,
        // the record's provenance as pulled: a marker in it would make the card unpushable (provenance has no
        // unknown keys); the hydrate run (first_run_id, harness HYDRATE_HARNESS) already says where it came from
        provenance_json: JSON.stringify(it.provenance),
        artifacts_json: it.artifacts ? JSON.stringify(it.artifacts) : null,
        status: it.status, reason: sql(it.reason), note: sql(str(it.note) ? it.note : undefined),
        external_ref: ext, external_url: ext && str(it.external_url) ? it.external_url : null,
        issue_ref: sql(str(it.issue_ref) ? it.issue_ref : undefined), issue_url: sql(str(it.issue_url) ? it.issue_url : undefined),
        snooze_until: it.status === 'snoozed' && str(it.snooze_until) ? it.snooze_until : null,
        decided_by: it.decided_by, decided_at: it.decided_at, first_run_id: run, last_run_id: run, created_at: at, updated_at: at,
        ...scored,
      };
      const names = Object.keys(cols);
      try {
        db.prepare(`INSERT INTO proposals (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).run(.../** @type {any[]} */ (Object.values(cols)));
      } catch (e) {
        invalid.push({ kind: 'item', index: i, fp, why: `not stored (${/** @type {Error} */ (e).message})` });
        continue;
      }
      for (const e of /** @type {Row[]} */ (it.evidence)) {
        const k = evidenceKey(/** @type {any} */ (e));
        insEv.run(fp, run, e.type, String(e.ref).trim(), k.key, sql(k.path), sql(k.line), sql(str(e.quote) ? e.quote : undefined), sql(str(e.url) ? e.url : undefined), at);
      }
      // one transition: the person's decision, at its time, with the evidence it was decided on
      db.prepare('INSERT INTO transitions (fp, from_status, to_status, by, at, reason, note, run_id, evidence_seq) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)')
        .run(fp, it.status, it.decided_by, it.decided_at, sql(it.reason), sql(str(it.note) ? it.note : undefined), run, evidenceSnapshot(db, fp).seq);
      if (it.status === 'merged' && str(it.merged_into)) merges.push([fp, String(it.merged_into)]);
      added++;
    }
    // a merge target is linked once both sides are stored (it may come later in the page, or be a Jira key: left unlinked)
    for (const [fp, into] of merges) if (has.get(into)) db.prepare('UPDATE proposals SET merged_into = ? WHERE fp = ?').run(into, fp);

    let rulesAdded = 0;
    for (const [i, r] of (Array.isArray(d.rules) ? /** @type {unknown[]} */ (d.rules) : []).entries()) {
      const rr = /** @type {Row} */ (obj(r) ? r : {});
      if (!str(rr.id) || !str(rr.lens) || !str(rr.text) || !['accepted', 'declined'].includes(rr.state) || !str(rr.offered_at)) {
        invalid.push({ kind: 'rule', index: i, why: 'a rule needs id, lens, text, offered_at and state accepted|declined' });
        continue;
      }
      const cluster = clean({ decided_by: str(rr.decided_by) ? rr.decided_by : undefined, hydrated_from: 'dowser_memory_pull' });
      const res = db.prepare('INSERT OR IGNORE INTO rules (id, lens, text, cluster_json, state, offered_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(rr.id, rr.lens, rr.text, JSON.stringify(cluster), rr.state, rr.offered_at, sql(str(rr.decided_at) ? rr.decided_at : undefined));
      rulesAdded += Number(res.changes);
    }
    return {
      code: invalid.length ? 1 : 0,
      out: /** @type {Row} */ (clean({ run, added, present, rules_added: rulesAdded, cursor: d.cursor, more: d.more === true ? true : undefined,
        invalid: invalid.length ? invalid : undefined })),
    };
  });
}
