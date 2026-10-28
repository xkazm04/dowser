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

/**
 * The issue the accept will create, as a preview of what forge/src/core/adf.mjs `issueDescription` builds, in the
 * same order: the rationale, the card body (rendered by the markdown subset in markdown.js), an Evidence list, then
 * "Proposed by Dowser (DW-n)". The server builds the real issue (verdict.accept); this preview only mirrors it.
 * @param {{title: string, rationale?: string, body?: string, ref: string, evidence?: {type: string, ref: string, quote?: string}[]}} card
 */
export function issuePreview(card) {
  return { summary: card.title, rationale: String(card.rationale ?? ''), body: String(card.body ?? '').replace(/^(\s*#{1,6}\s+)Description\s*#*\s*$/m, '$1Details'), evidence: card.evidence ?? [] };
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
