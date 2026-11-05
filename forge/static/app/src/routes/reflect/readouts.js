// Plain-language readings of the Learning numbers.

/** @param {{dup_rate?: number}} push */
export function readDupRate(push) {
  if (push.dup_rate === undefined) return 'This push carried no proposals, so there is no repeat rate to read.';
  const pct = Math.round(push.dup_rate * 100);
  if (push.dup_rate >= 0.6) return `${pct}% of this push re-found proposals you already had. The scan is mostly confirming, not discovering: a narrower lens set or a longer gap between scans would surface more that is new.`;
  if (push.dup_rate <= 0.2) return `Only ${pct}% of this push was already known. Almost everything it found was new to the inbox.`;
  return `${pct}% of this push re-found known proposals; the rest was new.`;
}

// ---- local patches from a write's own answer ------------------------------------------------------------------
// rule.decide answers the decided rule and outcome.record the outcome plus the new candidate list, so the page
// patches what it shows from that answer instead of re-reading the whole reflect.data aggregate.

/**
 * The Learning data with one rule replaced by its decided row (rule.decide's `rule`).
 * @template {{rules?: {id: string}[]}} D
 * @param {D} data
 * @param {{id: string}} rule
 * @returns {D}
 */
export function withRule(data, rule) {
  const rules = data.rules ?? [];
  return { ...data, rules: rules.some((r) => r.id === rule.id) ? rules.map((r) => (r.id === rule.id ? rule : r)) : [...rules, rule] };
}

/**
 * The Learning data after outcome.record: its candidates as the server now lists them, and the outcome first
 * among the outcomes (newest first, as reflect.data orders them).
 * @template {{candidates?: unknown[], outcomes?: {ref: string}[]}} D
 * @param {D} data
 * @param {{outcome: {ref: string}, candidates: unknown[]}} res
 * @returns {D}
 */
export function withOutcome(data, res) {
  return { ...data, candidates: res.candidates, outcomes: [res.outcome, ...(data.outcomes ?? []).filter((o) => o.ref !== res.outcome.ref)] };
}
