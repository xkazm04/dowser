'use strict';
// Nightly finance report: yesterday's orders as a CSV file for the accountant.
const fs = require('node:fs');
const path = require('node:path');
const { query } = require('../db');
const { toCsv } = require('../export/csv');

function runNightlyReport(outDir) {
  const orders = query("SELECT id, created_at, status, items, total, currency FROM orders WHERE created_at >= date('now', '-1 day')");
  const file = path.join(outDir, `orders-${new Date().toISOString().slice(0, 10)}.csv`);
  fs.writeFileSync(file, toCsv(orders));
  return file;
}

module.exports = { runNightlyReport };
