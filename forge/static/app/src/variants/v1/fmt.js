// Variant 1 date helpers: a push reads "27 Oct, 10:14" (the year only when it is not this year).

/** @param {string | undefined} iso */
export function shortDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  /** @type {Intl.DateTimeFormatOptions} */
  const o = { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' };
  if (d.getFullYear() !== new Date().getFullYear()) o.year = 'numeric';
  return d.toLocaleString('en-GB', o);
}
