'use strict';
// Nightly finance report: yesterday's orders (or every order since a date) as a CSV file for the accountant.
const fs = require('node:fs');
const path = require('node:path');
const { query } = require('../db');
const { toCsv } = require('../export/csv');

/** `since` is a YYYY-MM-DD date from `pebble report nightly --since`; without it, the last day. */
function runNightlyReport(outDir, since) {
  const from = since ? "'" + since + "'" : "date('now', '-1 day')";
  const orders = query('SELECT id, created_at, status, items, total, currency FROM orders WHERE created_at >= ' + from);
  const file = path.join(outDir, `orders-${new Date().toISOString().slice(0, 10)}.csv`);
  fs.writeFileSync(file, toCsv(orders));
  return file;
}

module.exports = { runNightlyReport };
