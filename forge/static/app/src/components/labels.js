// UI copy and closed vocabularies the Custom UI renders. English only. Reason codes and their labels mirror
// skill/references/triage.md; lens names mirror the lens packs' `name` (skill/lenses/*.md).

export const LENSES = ['opportunity', 'ux-friction', 'doc-drift', 'security-cra'];
export const LENS_LABELS = {
  opportunity: 'Opportunity',
  'ux-friction': 'UX friction and wellbeing',
  'doc-drift': 'Doc drift',
  'security-cra': 'Security and CRA',
};

export const STATUSES = ['open', 'accepted', 'rejected', 'snoozed', 'merged'];
export const STATUS_LABELS = { open: 'Open', accepted: 'Accepted', rejected: 'Rejected', snoozed: 'Snoozed', merged: 'Merged' };
export const STATUS_APPEARANCE = { open: 'inprogress', accepted: 'success', rejected: 'removed', snoozed: 'moved', merged: 'default' };

/** The six reject reason codes, exactly as the store and forge-mcp-2 know them. */
export const REASONS = [
  { code: 'false-positive', label: 'False positive', help: 'The evidence does not show what the card claims.' },
  { code: 'already-known', label: 'Already known', help: 'The team already tracks it or already decided it.' },
  { code: 'not-our-direction', label: 'Not our direction', help: 'True, but not where the product is going.' },
  { code: 'not-worth-it', label: 'Not worth it', help: 'True and in direction, but the gain does not pay for the cost.' },
  { code: 'wrong-size', label: 'Wrong size', help: 'The idea is right but it is scoped too big or too small to act on.' },
  { code: 'other', label: 'Other', help: 'None of the above. A note is required.' },
];
export const REASON_LABELS = Object.fromEntries(REASONS.map((r) => [r.code, r.label]));

export const EVIDENCE_LABELS = {
  code: 'Code', doc: 'Doc', git: 'Git', ticket: 'Ticket', page: 'Page', goal: 'Goal', dep: 'Dep', sarif: 'SARIF',
};

export const LEVEL_LABELS = { low: 'Low', medium: 'Medium', high: 'High' };

/** A Jira issue key such as SHOP-123. */
export const JIRA_KEY_RE = /^[A-Z][A-Z0-9_]+-[1-9][0-9]*$/;
export const DW_REF_RE = /^DW-[1-9][0-9]*$/;

/** @param {string | undefined} iso */
export function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** @param {number} n @param {string} one @param {string} [many] */
export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * How a card changed in the push that grouped it (F8). The server sets `card.change` on open cards inside a
 * group; when it is absent the marker is derived: `reopened` wins; a card first seen at the group's push time
 * is new; otherwise its evidence grew.
 * @param {{change?: 'new' | 'grew' | 'reopened', reopened?: boolean, first_seen?: string}} card @param {{at: string}} group
 * @returns {'new' | 'grew' | 'reopened'}
 */
export function changeOf(card, group) {
  if (card.change === 'new' || card.change === 'grew' || card.change === 'reopened') return card.change;
  if (card.reopened) return 'reopened';
  if (!card.first_seen || !group.at) return 'new';
  return Date.parse(card.first_seen) >= Date.parse(group.at) ? 'new' : 'grew';
}
export const CHANGE_LABELS = { new: 'New', grew: 'Evidence grew', reopened: 'Reopened' };

/** The predicted verdict as the inbox says it. */
export const VERDICT_LABELS = { accept: 'Accept', reject: 'Reject', defer: 'Defer' };
export const MACHINE_DECIDER = 'machine:dowser';

const FACT_MAX = 300;
const scale10 = (v) => Number.isInteger(v) && v >= 1 && v <= 10;
const posNum = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const clipText = (s, n) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/**
 * The facts table the issue opens with: a line-for-line mirror of `factsOf` in skill/scripts/lib/model.mjs (the
 * server's forge/src/core/adf.mjs builds the real table from that one; this copy only feeds the accept preview).
 * @param {Record<string, any>} card
 * @returns {{label: string, value: string}[]}
 */
export function factsOf(card) {
  const rows = [];
  const lens = LENS_LABELS[card.lens] ?? String(card.lens);
  if (scale10(card.impact)) rows.push({ label: 'Impact', value: clipText(`${card.impact}/10${card.impact_why ? ` - ${card.impact_why}` : ''}`, FACT_MAX) });
  const sp = card.score_parts;
  if (typeof card.score === 'number') {
    const parts = sp && typeof sp === 'object' ? ` = 10 x impact ${sp.impact} x confidence ${sp.confidence_w} / effort ${sp.effort_div} x risk ${sp.risk_factor} (${sp.formula})` : '';
    rows.push({ label: 'Score', value: clipText(`${card.score}${parts}`, FACT_MAX) });
  } else {
    rows.push({ label: 'Score', value: 'unscored (no impact or effort judged)' });
  }
  if (['low', 'medium', 'high'].includes(card.confidence)) {
    const c = String(card.confidence);
    rows.push({ label: 'Confidence', value: clipText(`${c[0].toUpperCase()}${c.slice(1)}${card.confidence_why ? ` - ${card.confidence_why}` : ''}`, FACT_MAX) });
  }
  const ef = card.effort && typeof card.effort === 'object' ? card.effort : undefined;
  if (ef) {
    const days = posNum(ef.days_low) && posNum(ef.days_high) ? `, ${ef.days_low}-${ef.days_high} days` : posNum(ef.days_high) ? `, up to ${ef.days_high} days` : '';
    rows.push({ label: 'Effort', value: clipText(scale10(ef.score) ? `${ef.score}/10 (${ef.size}${days})` : `${ef.size}${days}`, FACT_MAX) });
  }
  const blast = card.delivery_risk && typeof card.delivery_risk === 'object' ? card.delivery_risk.blast : undefined;
  if (scale10(card.risk)) rows.push({ label: 'Risk', value: `${card.risk}/10${blast ? ` (blast ${blast})` : ''}` });
  else if (blast) rows.push({ label: 'Risk', value: `blast ${blast}` });
  rows.push({ label: 'Lens / kind', value: clipText(`${lens} / ${card.kind}`, FACT_MAX) });
  if (card.mvp === true) rows.push({ label: 'MVP', value: clipText(`MVP of the ${lens} lens`, FACT_MAX) });
  return rows;
}

/** "56.9 = 10 x impact 7 x confidence 0.95 / effort 1.111 x risk 0.95": the stored breakdown, never recomputed. */
export function scoreBreakdown(parts) {
  if (!parts || typeof parts !== 'object') return '';
  return `10 x impact ${parts.impact} x confidence ${parts.confidence_w} / effort ${parts.effort_div} x risk ${parts.risk_factor}`;
}

/**
 * The issue the accept will create, as a preview of what forge/src/core/adf.mjs `issueDescription` builds, in the
 * same order: the facts table, the rationale, the card body (rendered by the markdown subset in markdown.js), the
 * supporting views when there are any, an Evidence list, then "Proposed by Dowser (DW-n)". The server builds the
 * real issue (verdict.accept); this preview only mirrors it. `artifacts` is omitted when the card has none.
 * @param {{title: string, rationale?: string, body?: string, ref: string, evidence?: {type: string, ref: string, quote?: string}[], artifacts?: any[]}} card
 */
export function issuePreview(card) {
  const preview = { summary: card.title, facts: factsOf(card), rationale: String(card.rationale ?? ''), body: String(card.body ?? '').replace(/^(\s*#{1,6}\s+)Description\s*#*\s*$/m, '$1Details'), evidence: card.evidence ?? [] };
  return Array.isArray(card.artifacts) && card.artifacts.length > 0 ? { ...preview, artifacts: card.artifacts } : preview;
}

/**
 * How well an item's evidence stands, derived only from what the card carries: the number of distinct evidence
 * kinds (code, ticket, doc, ...), moved one step by the confidence the scan stated. 0 = no evidence at all.
 * @param {{evidence?: {type: string}[], confidence?: string}} card
 * @returns {{level: 0|1|2|3|4, label: string, count: number, kinds: number}}
 */
export function evidenceStrength(card) {
  const ev = card.evidence ?? [];
  const kinds = new Set(ev.map((e) => e.type)).size;
  if (ev.length === 0) return { level: 0, label: 'None', count: 0, kinds: 0 };
  const shift = card.confidence === 'high' ? 1 : card.confidence === 'low' ? -1 : 0;
  const level = /** @type {1|2|3|4} */ (Math.max(1, Math.min(4, kinds + shift)));
  return { level, label: STRENGTH_LABELS[level], count: ev.length, kinds };
}
export const STRENGTH_LABELS = ['None', 'Thin', 'Fair', 'Solid', 'Strong'];

/** The three ways to rate an accepted item once it has shipped (`outcome.record`). */
export const RATINGS = [
  { code: 'right', label: 'Right call', mark: '✓' },
  { code: 'partly', label: 'Partly', mark: '∼' },
  { code: 'wrong', label: 'Wrong call', mark: '✕' },
];
export const RATING_LABELS = Object.fromEntries(RATINGS.map((r) => [r.code, r.label]));
export const RATING_APPEARANCE = { right: 'success', partly: 'moved', wrong: 'removed' };

/** `forge:<accountId>` / `human:<name>` -> a short label (a resolved display name wins when there is one). */
export function deciderName(by, name) {
  if (name) return name;
  if (!by) return 'unknown';
  const [kind, ...rest] = String(by).split(':');
  const who = rest.join(':');
  return kind === 'forge' ? `Jira user ${who}` : who || kind;
}

/** @param {string | undefined} iso */
export function formatDay(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * When a dated snooze returns (DW-55, DW-57): the skill wakes it at the first scan on or after that day. `until` is
 * a calendar day `YYYY-MM-DD`, read as the person's local day (a bare date would parse as UTC midnight).
 * @param {string} until
 */
export const comesBack = (until) => `Comes back at the first scan on or after ${formatDay(`${until}T00:00`)}`;
