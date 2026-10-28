'use strict';

const cell = (v) => {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * Orders as CSV: a header line plus one line per order (id, date, status, items, total, currency).
 * Used by the nightly finance report.
 */
function toCsv(orders) {
  const head = ['id', 'date', 'status', 'items', 'total', 'currency'];
  const lines = orders.map((o) => [o.id, o.created_at, o.status, o.items, o.total, o.currency].map(cell).join(','));
  return [head.join(','), ...lines].join('\n') + '\n';
}

module.exports = { toCsv };
