// @ts-check
// Dowser memory and learning (WP2): the context pack a lens gets before it gathers, the near tier of the
// fingerprint (`similar`), ask-why (`show`), compact listing (`list`), rule offers learned from repeated
// rejections, and the runner's preferences. Pattern from ai-registry explorer (passes.md: a reason seen 3+
// times is offered as a preference rule; the operator accepts it) and friend/references/learning.md.
//
// Reads go straight to the store; every write is a compare-and-set or an idempotent insert. The resurfacing
// predicate stays in model.mjs (`resurfaces`) - nothing here decides who comes back.
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DECIDER_RE, DowserError, LENSES, STATUSES, isOneOf } from './model.mjs';
import { dowserHome, isInside } from './paths.mjs';
import { outcomeCounts, outcomesOf } from './reflect.mjs';
import { clean, evidenceOf, getProposal, getRun, now, transitionsOf, tx } from './store.mjs';

/**
 * @typedef {import('./store.mjs').Db} Db
 * @typedef {import('./store.mjs').Row} Row
 * @typedef {{id: string, version: string, kinds: string[], budget: number, [k: string]: unknown}} LensPack
 */

/** Where the lens packs live: `skill/lenses/`. */
export const LENS_DIR = fileURLToPath(new URL('../../lenses/', import.meta.url));

/** Statuses `near` shows: open items plus the ones a human held back. */
const NEAR_STATUSES = ['candidate', 'verified', 'pushed', 'snoozed', 'rejected'];
/** Statuses whose fingerprints `propose` holds back (or that are folded into another item). */
const SUPPRESSED_STATUSES = ['rejected', 'snoozed', 'merged'];
export const NEAR_CAP = 40;
export const EXEMPLAR_CAP = 5;
/** Items of one (lens, reason, token) needed before a rule is offered (D5). */
export const RULE_THRESHOLD = 3;

// ------------------------------------------------------------------------------------------- lens packs

/**
 * Parses the YAML subset lens packs use in their frontmatter: `key: value` lines, where a value is an inline
 * list `[a, b]`, `true`/`false`, an integer, or a (possibly quoted) string. Unknown keys are kept, so a pack
 * may grow fields (e.g. `optional_sources`) without breaking older readers. Zero dependencies.
 * @param {string} text the whole pack
 * @returns {Record<string, unknown>}
 */
export function parseFrontmatter(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') throw new DowserError('lens pack has no frontmatter', 2);
  /** @type {Record<string, unknown>} */
  const out = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---') return out;
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!m) throw new DowserError(`lens pack frontmatter line ${i + 1} is not key: value`, 2);
    out[m[1]] = scalarOrList(m[2].trim());
  }
  throw new DowserError('lens pack frontmatter is not closed with ---', 2);
}

/** @param {string} v @returns {unknown} */
function scalarOrList(v) {
  if (v.startsWith('[')) {
    if (!v.endsWith(']')) throw new DowserError(`unterminated list ${v}`, 2);
    const inner = v.slice(1, -1).trim();
    return inner ? inner.split(',').map((s) => unquote(s.trim())).filter((s) => s !== '') : [];
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  return unquote(v);
}

/** @param {string} s */
const unquote = (s) => (/^(['"]).*\1$/.test(s) ? s.slice(1, -1) : s);

/**
 * The lens pack's frontmatter, checked: `id` matches the lens, `version` is a string, `kinds` is a non-empty
 * list, `budget` a positive integer. An unknown lens or a missing pack exits 2.
 * @param {string} lens
 * @param {string} [dir]
 * @returns {LensPack}
 */
export function loadLensPack(lens, dir = LENS_DIR) {
  if (!isOneOf(LENSES, lens)) throw new DowserError(`unknown lens ${JSON.stringify(lens)} (one of ${LENSES.join(', ')})`, 2);
  /** @type {string} */
  let text;
  try { text = readFileSync(join(dir, `${lens}.md`), 'utf8'); } catch (e) {
    throw new DowserError(`lens pack ${lens}.md is not readable (${/** @type {Error} */ (e).message})`, 2);
  }
  const fm = parseFrontmatter(text);
  if (fm.id !== lens) throw new DowserError(`lens pack ${lens}.md declares id ${JSON.stringify(fm.id)}`, 2);
  if (typeof fm.version !== 'string' || !fm.version) throw new DowserError(`lens pack ${lens}.md has no version`, 2);
  if (!Array.isArray(fm.kinds) || fm.kinds.length === 0) throw new DowserError(`lens pack ${lens}.md declares no kinds`, 2);
  if (!Number.isInteger(fm.budget) || /** @type {number} */ (fm.budget) < 1) throw new DowserError(`lens pack ${lens}.md has no positive budget`, 2);
  return /** @type {LensPack} */ (fm);
}

// ------------------------------------------------------------------------------------------- shared

/** Short words that carry no topic on their own. */
const STOP = new Set(['and', 'the', 'for', 'with', 'from', 'into', 'not', 'are', 'was', 'its', 'via', 'per', 'out', 'all', 'any', 'has', 'can', 'use', 'when', 'that', 'this', 'than', 'then', 'onto', 'over', 'non']);

/**
 * The tokens of a normalized (kebab) topic that can carry meaning: 3+ characters, not a stop word, de-duplicated.
 * @param {string} topic
 * @returns {string[]}
 */
export function topicTokens(topic) {
  return [...new Set(String(topic).split('-').filter((t) => t.length >= 3 && !STOP.has(t)))];
}

/** @param {Row} r @param {string} k */
const parsed = (r, k) => (r[k] === null || r[k] === undefined ? undefined : JSON.parse(r[k]));

// ------------------------------------------------------------------------------------------- context

/**
 * The context pack for one lens in one run: what the lens must not re-propose, what it already knows, the
 * runner's accepted rules and the accepted exemplars, plus the pack's version, kinds and budget. `outcomes`
 * counts how the lens's accepted items fared once built ({right, partly, wrong}, latest rating per item); omitted
 * when none was recorded.
 * `since_sha` is the run's base_sha on an incremental run (omitted otherwise). Absent values are omitted.
 * @param {Db} db
 * @param {{runId: string, lens: string, focus?: string, lensDir?: string}} o
 * @returns {Row}
 */
export function contextPack(db, { runId, lens, focus, lensDir }) {
  const pack = loadLensPack(lens, lensDir);
  const run = getRun(db, runId);
  if (!run) throw new DowserError(`run ${runId} does not exist`, 2);

  const suppressed = /** @type {Row[]} */ (db.prepare(
    `SELECT fp FROM proposals WHERE lens = ? AND status IN (${SUPPRESSED_STATUSES.map(() => '?').join(',')}) ORDER BY fp`,
  ).all(lens, ...SUPPRESSED_STATUSES)).map((r) => String(r.fp));

  const near = /** @type {Row[]} */ (db.prepare(
    `SELECT fp, title, topic, anchors_json, status FROM proposals WHERE lens = ? AND status IN (${NEAR_STATUSES.map(() => '?').join(',')})
     ORDER BY updated_at DESC, fp LIMIT ?`,
  ).all(lens, ...NEAR_STATUSES, NEAR_CAP)).map((r) => ({ fp: r.fp, title: r.title, topic: r.topic, anchors: parsed(r, 'anchors_json'), status: r.status }));

  const rules = /** @type {Row[]} */ (db.prepare("SELECT id, text FROM rules WHERE lens = ? AND state = 'accepted' ORDER BY decided_at, id").all(lens))
    .map((r) => ({ id: String(r.id), text: String(r.text) }));

  const exemplars = /** @type {Row[]} */ (db.prepare(
    `SELECT p.fp, p.title, p.rationale, p.effort_json FROM proposals p WHERE p.lens = ? AND p.status = 'accepted'
     ORDER BY p.decided_at DESC, (SELECT MAX(t.id) FROM transitions t WHERE t.fp = p.fp) DESC LIMIT ?`,
  ).all(lens, EXEMPLAR_CAP)).map((r) => ({
    title: r.title, rationale: r.rationale, effort: parsed(r, 'effort_json'),
    evidence_types: /** @type {Row[]} */ (db.prepare('SELECT DISTINCT type FROM evidence WHERE fp = ? ORDER BY type').all(r.fp)).map((e) => String(e.type)),
  }));

  return /** @type {Row} */ (clean({
    lens, lens_version: pack.version, kinds: pack.kinds, budget: pack.budget, suppressed, near, rules, exemplars,
    outcomes: outcomeCounts(db, lens),
    since_sha: run.mode === 'incremental' ? run.base_sha : undefined,
    focus: focus ?? run.focus,
  }));
}

// ------------------------------------------------------------------------------------------- similar

/**
 * The near tier of the fingerprint (D3): items of the same lens that share at least one normalized anchor or
 * at least two topic tokens with `fp`, any status except `dropped`. Each hit states its overlap. The agent
 * judges whether a hit is the same work; nothing is merged here.
 * @param {Db} db
 * @param {string} fp
 * @returns {Row}
 */
export function similar(db, fp) {
  const self = /** @type {Row | undefined} */ (db.prepare('SELECT fp, lens, topic, anchors_json, title, status FROM proposals WHERE fp = ?').get(fp));
  if (!self) throw new DowserError(`proposal ${fp} does not exist`, 2, { error: 'not-found', fp });
  const anchors = new Set(/** @type {string[]} */ (parsed(self, 'anchors_json')));
  const tokens = new Set(topicTokens(String(self.topic)));
  /** @type {Row[]} */
  const hits = [];
  for (const r of /** @type {Row[]} */ (db.prepare(
    "SELECT fp, title, topic, anchors_json, status, reason, merged_into, decided_by, decided_at FROM proposals WHERE lens = ? AND fp <> ? AND status <> 'dropped' ORDER BY updated_at DESC, fp",
  ).all(self.lens, fp))) {
    const theirAnchors = /** @type {string[]} */ (parsed(r, 'anchors_json'));
    const sharedAnchors = theirAnchors.filter((a) => anchors.has(a));
    const sharedTokens = topicTokens(String(r.topic)).filter((t) => tokens.has(t));
    if (sharedAnchors.length < 1 && sharedTokens.length < 2) continue;
    hits.push(/** @type {Row} */ (clean({
      fp: r.fp, title: r.title, topic: r.topic, anchors: theirAnchors, status: r.status, reason: r.reason,
      merged_into: r.merged_into, decided_by: r.decided_by, decided_at: r.decided_at,
      overlap: clean({ anchors: sharedAnchors.length ? sharedAnchors : undefined, topic_tokens: sharedTokens.length ? sharedTokens : undefined }),
    })));
  }
  hits.sort((a, b) => score(b) - score(a));
  return { fp, lens: self.lens, title: self.title, topic: self.topic, similar: hits };
}

/** Anchors weigh more than wording. @param {Row} h */
const score = (h) => (h.overlap.anchors?.length ?? 0) * 10 + (h.overlap.topic_tokens?.length ?? 0);

// ------------------------------------------------------------------------------------------- show / list

/**
 * Ask-why: the card, every evidence row (oldest first) and every transition (in order). Reads the store only;
 * never rescans.
 * @param {Db} db
 * @param {string} fp
 * @returns {Row}
 */
export function show(db, fp) {
  const card = getProposal(db, fp);
  if (!card) throw new DowserError(`proposal ${fp} does not exist`, 2, { error: 'not-found', fp });
  delete card.evidence;
  const evidence = evidenceOf(db, fp).map(({ id: _id, fp: _fp, key: _key, ...rest }) => rest);
  const transitions = transitionsOf(db, fp).map(({ id: _id, fp: _fp, evidence_seq: _seq, ...rest }) => rest);
  const outcomes = outcomesOf(db, fp);
  return /** @type {Row} */ (clean({ fp, external_ref: card.external_ref, external_url: card.external_url, issue_ref: card.issue_ref, issue_url: card.issue_url, card, evidence, transitions, outcomes: outcomes.length ? outcomes : undefined }));
}

/**
 * Compact rows `{fp, lens, status, title, decided_at?}`, most recently updated first, filtered by lens, status
 * and a case-insensitive title substring.
 * @param {Db} db
 * @param {{lens?: string, status?: string, title?: string}} [o]
 * @returns {Row}
 */
export function list(db, { lens, status, title } = {}) {
  if (lens !== undefined && !isOneOf(LENSES, lens)) throw new DowserError(`--lens must be one of ${LENSES.join('|')}`, 2);
  if (status !== undefined && !isOneOf(STATUSES, status)) throw new DowserError(`--status must be one of ${STATUSES.join('|')}`, 2);
  /** @type {string[]} */
  const where = [];
  /** @type {string[]} */
  const args = [];
  if (lens !== undefined) { where.push('lens = ?'); args.push(lens); }
  if (status !== undefined) { where.push('status = ?'); args.push(status); }
  if (title !== undefined) { where.push("instr(lower(title), lower(?)) > 0"); args.push(title); }
  const rows = /** @type {Row[]} */ (db.prepare(
    `SELECT fp, lens, status, title, decided_at FROM proposals ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC, fp`,
  ).all(...args)).map((r) => /** @type {Row} */ (clean(r)));
  return { proposals: rows };
}

// ------------------------------------------------------------------------------------------- rules

/**
 * A rule id, deterministic per cluster key (lens, reason, token): the same cluster can never be inserted
 * twice, whatever became of the first offer.
 * @param {string} lens @param {string} reason @param {string} token
 */
export const ruleId = (lens, reason, token) => `rule-${createHash('sha256').update(`${lens}|${reason}|${token}`).digest('hex').slice(0, 12)}`;

/**
 * The rule as JSON (cluster parsed, absent keys omitted).
 * @param {Row} r
 * @returns {Row}
 */
function ruleOut(r) {
  const { cluster_json, ...rest } = r;
  return /** @type {Row} */ (clean({ ...rest, cluster: cluster_json ? JSON.parse(cluster_json) : undefined }));
}

/**
 * Computes rejection clusters over the transition history (local moves and ingested Forge verdicts alike):
 * a (lens, reason, topic token) shared by at least RULE_THRESHOLD distinct rejected items. Each new cluster is
 * inserted once as an `offered` rule with a draft text; a cluster whose id exists (offered, accepted or
 * declined) is never offered again. Clusters of one (lens, reason) that cover the very same items are one
 * offer, named by its longest token. Returns only the offers inserted now.
 * @param {Db} db
 * @returns {{offers: Row[]}}
 */
export function offerRules(db) {
  return tx(db, () => {
    const rejected = /** @type {Row[]} */ (db.prepare(
      `SELECT DISTINCT p.fp, p.lens, p.topic, p.title, t.reason FROM transitions t JOIN proposals p ON p.fp = t.fp
       WHERE t.to_status = 'rejected' AND t.reason IS NOT NULL ORDER BY p.fp`,
    ).all());
    /** @type {Map<string, {lens: string, reason: string, token: string, fps: Set<string>}>} */
    const clusters = new Map();
    /** @type {Map<string, string>} */
    const titles = new Map();
    for (const r of rejected) {
      titles.set(String(r.fp), String(r.title));
      for (const token of topicTokens(String(r.topic))) {
        const k = `${r.lens}|${r.reason}|${token}`;
        let c = clusters.get(k);
        if (!c) clusters.set(k, (c = { lens: String(r.lens), reason: String(r.reason), token, fps: new Set() }));
        c.fps.add(String(r.fp));
      }
    }
    /** @type {Map<string, {lens: string, reason: string, tokens: string[], fps: string[]}>} */
    const groups = new Map();
    for (const c of clusters.values()) {
      if (c.fps.size < RULE_THRESHOLD) continue;
      const fps = [...c.fps].sort();
      const k = `${c.lens}|${c.reason}|${fps.join(',')}`;
      const g = groups.get(k);
      if (g) g.tokens.push(c.token); else groups.set(k, { lens: c.lens, reason: c.reason, tokens: [c.token], fps });
    }
    const exists = db.prepare('SELECT 1 FROM rules WHERE id = ?');
    const ins = db.prepare("INSERT INTO rules (id, lens, text, cluster_json, state, offered_at) VALUES (?, ?, ?, ?, 'offered', ?)");
    /** @type {Row[]} */
    const offers = [];
    const at = now();
    for (const g of [...groups.values()].sort((a, b) => `${a.lens}|${a.reason}`.localeCompare(`${b.lens}|${b.reason}`))) {
      if (g.tokens.some((t) => exists.get(ruleId(g.lens, g.reason, t)))) continue;
      const [token, ...also] = g.tokens.sort((a, b) => b.length - a.length || a.localeCompare(b));
      const id = ruleId(g.lens, g.reason, token);
      const text = `Do not propose ${g.lens} items about ${token} (rejected ${g.fps.length}x as ${g.reason})`;
      const cluster = clean({ reason: g.reason, token, also_tokens: also.length ? also : undefined, fps: g.fps });
      ins.run(id, g.lens, text, JSON.stringify(cluster), at);
      offers.push({ id, lens: g.lens, state: 'offered', text, cluster, titles: g.fps.map((fp) => titles.get(fp)), offered_at: at });
    }
    return { offers };
  });
}

/**
 * Accepts or declines an offered rule: a compare-and-set offered -> accepted|declined, by a human. `text`
 * (accept only) replaces the draft wording. The decider is recorded in the cluster record.
 * @param {Db} db
 * @param {string} id
 * @param {'accepted' | 'declined'} to
 * @param {{by: string, text?: string}} o
 * @returns {Row}
 */
export function decideRule(db, id, to, { by, text }) {
  if (!by || !DECIDER_RE.test(by)) throw new DowserError(`--by names the decider as <kind>:<name> (got ${JSON.stringify(by)})`, 2);
  if (!by.startsWith('human:')) throw new DowserError(`a rule is accepted or declined by a human (--by human:<name>), got ${by}`, 2);
  if (text !== undefined && to !== 'accepted') throw new DowserError('--text goes only with rules accept', 2);
  if (text !== undefined && !text.trim()) throw new DowserError('--text is empty', 2);
  return tx(db, () => {
    const cur = /** @type {Row | undefined} */ (db.prepare('SELECT * FROM rules WHERE id = ?').get(id));
    if (!cur) throw new DowserError(`rule ${id} does not exist`, 2, { error: 'refused', id, current: 'not-found', to });
    if (cur.state !== 'offered') throw new DowserError(`rule ${id} is ${cur.state}, not offered`, 2, { error: 'refused', id, current: cur.state, to });
    const cluster = cur.cluster_json ? JSON.parse(cur.cluster_json) : {};
    cluster.decided_by = by;
    if (text !== undefined) cluster.draft_text = cur.text;
    const row = /** @type {Row | undefined} */ (db.prepare("UPDATE rules SET state = ?, text = ?, cluster_json = ?, decided_at = ? WHERE id = ? AND state = 'offered' RETURNING *")
      .get(to, text !== undefined ? text.trim() : cur.text, JSON.stringify(cluster), now(), id));
    if (!row) throw new DowserError(`rule ${id} changed under us`, 2, { error: 'refused', id, to });
    return ruleOut(row);
  });
}

/**
 * Every rule, optionally of one lens, oldest offer first.
 * @param {Db} db
 * @param {{lens?: string}} [o]
 * @returns {{rules: Row[]}}
 */
export function listRules(db, { lens } = {}) {
  if (lens !== undefined && !isOneOf(LENSES, lens)) throw new DowserError(`--lens must be one of ${LENSES.join('|')}`, 2);
  const rows = /** @type {Row[]} */ (lens === undefined
    ? db.prepare('SELECT * FROM rules ORDER BY offered_at, id').all()
    : db.prepare('SELECT * FROM rules WHERE lens = ? ORDER BY offered_at, id').all(lens));
  return { rules: rows.map(ruleOut) };
}

// ------------------------------------------------------------------------------------------- prefs

/** The preferences Dowser knows, with their allowed values. */
export const PREFS = Object.freeze({ mode: ['dev', 'guided'], verbosity: ['short', 'full'] });

/** `~/.dowser/user.json` (`DOWSER_HOME` overrides the home). */
export const prefsPath = () => join(dowserHome(), 'user.json');

/**
 * The runner's preferences; `{}` when none were stored. Refuses (exit 3) a prefs file inside `repoRoot`.
 * @param {string} [repoRoot]
 * @returns {Record<string, unknown>}
 */
export function readPrefs(repoRoot) {
  const file = prefsPath();
  if (repoRoot !== undefined && isInside(repoRoot, file)) {
    throw new DowserError(`the prefs file ${file} lies inside the scanned repo ${repoRoot}; set DOWSER_HOME outside it`, 3);
  }
  /** @type {string} */
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return {};
    throw new DowserError(`prefs unavailable: ${/** @type {Error} */ (e).message}`, 3);
  }
  try {
    const v = JSON.parse(text);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  } catch { /* fall through */ }
  throw new DowserError(`${file} is not a JSON object`, 3);
}

/**
 * Sets preferences from `key=value` pairs (only known keys and values) and writes them atomically
 * (tmp file + rename) under the Dowser home. Returns the full preferences.
 * @param {string[]} pairs
 * @param {string} [repoRoot]
 * @returns {Record<string, unknown>}
 */
export function setPrefs(pairs, repoRoot) {
  if (pairs.length === 0) throw new DowserError('prefs set key=value [key=value ...]', 2);
  const prefs = readPrefs(repoRoot);
  for (const p of pairs) {
    const m = p.match(/^([a-z_]+)=(.+)$/);
    if (!m) throw new DowserError(`${JSON.stringify(p)} is not key=value`, 2);
    const allowed = /** @type {Record<string, readonly string[]>} */ (PREFS)[m[1]];
    if (!allowed) throw new DowserError(`unknown preference ${m[1]} (one of ${Object.keys(PREFS).join(', ')})`, 2);
    if (!allowed.includes(m[2])) throw new DowserError(`${m[1]} must be one of ${allowed.join('|')}`, 2);
    prefs[m[1]] = m[2];
  }
  const file = prefsPath();
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    mkdirSync(dowserHome(), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(prefs, null, 2)}\n`);
    renameSync(tmp, file);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
    throw new DowserError(`prefs unavailable: ${/** @type {Error} */ (e).message}`, 3);
  }
  return prefs;
}

/**
 * `prefs get [key ...]`: the named preferences (absent ones omitted), or all of them.
 * @param {string[]} keys
 * @param {string} [repoRoot]
 * @returns {Record<string, unknown>}
 */
export function getPrefs(keys, repoRoot) {
  const prefs = readPrefs(repoRoot);
  if (keys.length === 0) return prefs;
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const k of keys) {
    if (!Object.hasOwn(PREFS, k)) throw new DowserError(`unknown preference ${k} (one of ${Object.keys(PREFS).join(', ')})`, 2);
    if (prefs[k] !== undefined) out[k] = prefs[k];
  }
  return out;
}
