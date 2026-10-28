'use strict';
// Pushes orders placed since the last sync to the accounting system's import endpoint.
const { query, run } = require('../db');

async function syncOrders() {
  const orders = query("SELECT id, created_at, total, currency FROM orders WHERE synced_at IS NULL");
  if (orders.length === 0) return 0;
  const res = await fetch(process.env.ACCOUNTING_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(orders) });
  if (!res.ok) throw new Error(`accounting import failed: ${res.status}`);
  for (const o of orders) run("UPDATE orders SET synced_at = datetime('now') WHERE id = ?", [o.id]);
  return orders.length;
}

module.exports = { syncOrders };
