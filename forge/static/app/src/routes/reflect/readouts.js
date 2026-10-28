// Plain-language readings of the Learning numbers.

/** @param {{dup_rate?: number}} push */
export function readDupRate(push) {
  if (push.dup_rate === undefined) return 'This push carried no proposals, so there is no repeat rate to read.';
  const pct = Math.round(push.dup_rate * 100);
  if (push.dup_rate >= 0.6) return `${pct}% of this push re-found proposals you already had. The scan is mostly confirming, not discovering: a narrower lens set or a longer gap between scans would surface more that is new.`;
  if (push.dup_rate <= 0.2) return `Only ${pct}% of this push was already known. Almost everything it found was new to the inbox.`;
  return `${pct}% of this push re-found known proposals; the rest was new.`;
}
