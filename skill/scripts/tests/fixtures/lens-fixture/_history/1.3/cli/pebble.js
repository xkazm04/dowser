#!/usr/bin/env node
'use strict';
// pebble - the shop owner's admin CLI.
//   pebble receipts resend <order-id>   send an order's receipt e-mail again
//   pebble prices import <file.json>    bulk price update from a supplier sheet
//   pebble report nightly [--out dir]   write yesterday's orders as CSV
//   pebble orders sync                  push new orders to the accounting system
//   pebble version                      print the version and the git revision
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { resendReceipt } = require('../src/receipts/email');
const { bulkUpdatePrices } = require('../src/admin/prices');
const { runNightlyReport } = require('../src/jobs/nightly-report');
const { syncOrders } = require('../src/jobs/orders-sync');
const pkg = require('../package.json');

async function main(argv) {
  const [group, cmd, ...rest] = argv;
  if (group === 'receipts' && cmd === 'resend') {
    const id = Number(rest[0]);
    if (!Number.isInteger(id)) return fail('usage: pebble receipts resend <order-id>');
    console.log(JSON.stringify(await resendReceipt(id)));
  } else if (group === 'prices' && cmd === 'import') {
    if (!rest[0]) return fail('usage: pebble prices import <file.json>');
    const rows = JSON.parse(fs.readFileSync(rest[0], 'utf8'));
    console.log(`${bulkUpdatePrices(rows)} prices updated`);
  } else if (group === 'report' && cmd === 'nightly') {
    const i = rest.indexOf('--out');
    console.log(runNightlyReport(i >= 0 ? rest[i + 1] : process.cwd()));
  } else if (group === 'orders' && cmd === 'sync') {
    console.log(`${await syncOrders()} orders synced`);
  } else if (group === 'version') {
    const rev = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    console.log(`pebble ${pkg.version} (${rev})`);
  } else {
    fail('usage: pebble receipts resend <order-id> | prices import <file.json> | report nightly [--out dir] | orders sync | version');
  }
}

function fail(msg) {
  console.error(msg);
  process.exitCode = 2;
}

main(process.argv.slice(2));
