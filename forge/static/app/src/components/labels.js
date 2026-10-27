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
 * The issue the accept will create, as a preview: summary is the card title, the description is the card's
 * five body sections. The server builds the real issue (verdict.accept); this preview only mirrors it.
 * @param {{title: string, body?: string, ref: string}} card
 */
export function issuePreview(card) {
  return { summary: card.title, description: `${(card.body ?? '').trim()}\n\nProposed by Dowser (${card.ref}).` };
}
