// @ts-check
// Wire types of the Dowser Forge app: the forge-mcp-2 tool payloads (docs/contracts/forge-mcp-2.md), the
// resolver contract the Custom UI calls, and the Forge SQL row shapes. Types only, plus the closed enums.
//
// Absent values: a key with no value is OMITTED, in both directions. SQL NULL becomes an omitted key; `null`
// is never sent, and `0` is never sent for something unmeasured.

/** Inbox item statuses on the Forge side. `open` covers new, evidence-grew and reopened items. */
export const INBOX_STATUSES = /** @type {const} */ (['open', 'accepted', 'rejected', 'snoozed', 'merged']);
/** Verdict statuses as forge-mcp-2 sends them to the skill. */
export const VERDICT_STATUSES = /** @type {const} */ (['accepted', 'rejected', 'merged', 'snoozed']);
export const PUSH_RESULTS = /** @type {const} */ (['created', 'updated', 'merged-existing', 'refused']);
export const ERROR_CODES = /** @type {const} */ (['bad-input', 'bad-cursor', 'unknown-project', 'unauthorized', 'unavailable']);
/** Where a verdict was made; stored on the verdict row, never sent to the skill. */
export const VIAS = /** @type {const} */ (['inbox', 'panel', 'rovo']);
/** Inbox ref format: `DW-<n>`, unique per installation. */
export const REF_RE = /^DW-[1-9][0-9]*$/;
/** Rule states as the skill keeps them (`offered` until a person decides). */
export const RULE_STATES = /** @type {const} */ (['offered', 'accepted', 'declined']);
/** How an accepted item turned out, as the person who owns the issue rates it. */
export const OUTCOME_RATINGS = /** @type {const} */ (['right', 'partly', 'wrong']);
export const RULES_MAX = 50;
export const OUTCOMES_MAX = 200;
export const PUSH_MAX = 50;
export const AREAS_MAX = 200;
/** Inbox page size (the Custom UI invoke payload cap is 500 KB). */
export const PAGE_SIZE = 50;

/**
 * @typedef {typeof INBOX_STATUSES[number]} InboxStatus
 * @typedef {typeof VERDICT_STATUSES[number]} VerdictStatus
 * @typedef {typeof PUSH_RESULTS[number]} PushResult
 * @typedef {typeof ERROR_CODES[number]} ErrorCode
 * @typedef {typeof VIAS[number]} Via
 * @typedef {Record<string, any>} ProposalRecord  a full `dowser-proposal/1` record (skill/schema/dowser-proposal-1.schema.json)
 */

/**
 * forge-mcp-2 tool inputs and outputs.
 * @typedef {{query: string, since?: string, limit: number}} TicketsInput
 * @typedef {{query: string, space?: string}} PagesInput
 * @typedef {{ref: string, title: string, url: string, body: string, created_at?: string, updated_at?: string, labels?: string[], status?: string}} SourceItem
 * @typedef {{items: SourceItem[]}} SourcesOutput
 * @typedef {{project_key: string, run_id: string, proposals_json: string, repo_url?: string, head_sha?: string}} PushInput
 * @typedef {{fp: string, result: PushResult, external_ref?: string, external_url?: string, why?: string}} PushResultRow
 * @typedef {{results: PushResultRow[]}} PushOutput
 * @typedef {{project_key: string, cursor?: string}} PullInput
 * @typedef {{fp: string, status: VerdictStatus, reason?: string, note?: string, merged_into?: string, decided_by: string,
 *   decided_at: string, external_ref: string, issue_ref?: string, issue_url?: string}} Verdict
 * @typedef {{verdicts: Verdict[], cursor: string}} PullOutput
 * @typedef {{path: string, files: number, churn_90d: number, authors_90d?: number, last_change?: string}} Area
 * @typedef {{project_key: string, run_id: string, areas_json: string}} AreasInput
 * @typedef {{stored: number}} AreasOutput
 * @typedef {{error: ErrorCode, message: string}} ToolError
 *
 * Reflection (additive to forge-mcp-2; tool 7). `dowser_reflect_sync` is one idempotent round trip: the skill
 * pushes its `offered` rules, Forge answers every rule a person decided in Forge and every outcome recorded.
 * @typedef {typeof RULE_STATES[number]} RuleState
 * @typedef {typeof OUTCOME_RATINGS[number]} OutcomeRating
 * @typedef {{id: string, lens: string, text: string, titles?: string[], offered_at: string}} RuleOffer  `titles` at most 10
 * @typedef {{project_key: string, rules_json?: string}} ReflectInput  rules_json = JSON array of RuleOffer, at most RULES_MAX
 * @typedef {{id: string, lens: string, state: 'accepted' | 'declined', text: string, decided_by: string, decided_at: string}} RuleDecision
 * @typedef {{ref: string, fp: string, rating: OutcomeRating, note?: string, issue_ref: string, decided_by: string, recorded_at: string}} Outcome
 * @typedef {{rules: RuleDecision[], outcomes: Outcome[]}} ReflectOutput  outcomes: newest OUTCOMES_MAX
 */

/**
 * Rovo-only actions.
 * @typedef {{project_key?: string, lens?: string, status?: InboxStatus, limit?: number}} InboxListInput
 * @typedef {{ref: string}} ExplainInput  `ref` is a DW ref or an fp
 * @typedef {{ref: string, status: VerdictStatus, reason?: string, note?: string, merged_into?: string}} VerdictRecordInput
 */

/**
 * The card the Custom UI renders: the proposal record plus inbox state.
 * @typedef {{type: string, ref: string, url?: string, quote?: string, link?: string}} CardEvidence
 * @typedef {ProposalRecord & {ref: string, status: InboxStatus, project_key: string, evidence: CardEvidence[],
 *   reopened?: boolean, change?: 'new' | 'grew' | 'reopened', issue_ref?: string, issue_url?: string, first_seen: string, last_push_at: string}} Card
 *   `change` is set on open cards inside an InboxGroup: what that push did to the item.
 * @typedef {{run_id: string, at: string, head_sha?: string, items: Card[]}} InboxGroup
 * @typedef {{run_id: string, at: string, head_sha?: string, created: number, updated: number}} LastPush
 * @typedef {{project_key: string, repo_url?: string, jira_project_key?: string, issue_type_id?: string, open: number, last_push?: LastPush}} InboxSummary
 */

/**
 * The Learning tab. All of it is derived from existing tables plus `rules` and `outcomes`. Absent = omitted.
 * `dup_rate` = updated / (created + updated) of one push, omitted when the push had neither.
 * `history` rows gain `decided_by_name` (a resolved display name; omitted when Jira will not say).
 * @typedef {{lens: string, reason: string, count: number}} RejectCount
 * @typedef {{ref: string, title: string, status: 'accepted' | 'rejected' | 'snoozed', note: string, decided_by_name?: string, decided_at: string}} DecisionNote
 * @typedef {{run_id: string, at: string, head_sha?: string, created: number, updated: number, dup_rate?: number,
 *   open: number, accepted: number, rejected: number, snoozed: number}} PushRetro  open..snoozed = today's status of that push's items
 * @typedef {{lens: string, proposed: number, accepted: number, rejected: number, snoozed: number, open: number}} LensYield
 * @typedef {{id: string, lens: string, text: string, titles?: string[], state: RuleState, offered_at: string,
 *   decided_by_name?: string, decided_at?: string}} RuleRow
 * @typedef {{ref: string, title: string, issue_ref: string, issue_url: string, issue_status: string, done: boolean}} OutcomeCandidate  accepted, no outcome yet; `done` = Jira status category done
 * @typedef {{totals: Record<InboxStatus, number>, rejects: RejectCount[], notes: DecisionNote[], pushes: PushRetro[],
 *   lens_yield: LensYield[], rules: RuleRow[], candidates: OutcomeCandidate[], outcomes: (Outcome & {title: string, decided_by_name?: string})[]}} ReflectData
 *   pushes: newest 8. notes: newest 10 that carry a note. candidates: done ones first, at most 20.
 */

/**
 * Resolver contract (invoke key -> payload -> result). Every resolver answers `{error, message}` on failure.
 * @typedef {{
 *   'inbox.list': [{project_key?: string, status?: InboxStatus, lens?: string, cursor?: string}, {inboxes: InboxSummary[], groups: InboxGroup[], next?: string}],
 *   'proposal.get': [{ref: string}, {card: Card, history: Verdict[]}],
 *   'verdict.accept': [{ref: string, jira_project_key?: string, issue_type_id?: string}, {card: Card}],
 *   'verdict.reject': [{refs: string[], reason: string, note?: string}, {cards: Card[]}],
 *   'verdict.snooze': [{refs: string[]}, {cards: Card[]}],
 *   'verdict.merge': [{ref: string, into: string}, {card: Card}],
 *   'settings.get': [{}, {inboxes: InboxSummary[]}],
 *   'settings.set': [{project_key: string, jira_project_key: string, issue_type_id: string}, {inbox: InboxSummary}],
 *   'jira.projects': [{}, {projects: {key: string, name: string, issue_types: {id: string, name: string}[]}[]}],
 *   'panel.forIssue': [{issue_key: string}, {card?: Card, history: Verdict[]}],
 *   'map.data': [{project_key: string}, {areas: (Area & {proposals: {lens: string, open: number, accepted: number}[]})[], points: {ref: string, lens: string, effort: string, confidence: string, blast?: string}[]}],
 *   'byline.forPage': [{page_id: string}, {count: number, cards: Card[]}],
 * }} ResolverContract
 */

export {};
