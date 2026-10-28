#!/usr/bin/env node
'use strict';
// pebble - the shop owner's admin CLI.
//   pebble receipts resend <order-id>                  send an order's receipt e-mail again
//   pebble prices import <file.json>                   bulk price update from a supplier sheet
//   pebble report nightly [--out dir] [--since date]   write yesterday's orders (or every order since a date) as CSV
//   pebble slips print <YYYY-MM-DD> [--out dir]        write the packing slips of the orders shipped that day
//   pebble version                                     print the version and the git revision
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { resendReceipt } = require('../src/receipts/email');
const { bulkUpdatePrices } = require('../src/admin/prices');
const { runNightlyReport } = require('../src/jobs/nightly-report');
const { printPackingSlips } = require('../src/jobs/packing-slips');
const pkg = require('../package.json');

/** The value after `--<name>`, or undefined. */
const flag = (args, name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

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
    console.log(runNightlyReport(flag(rest, 'out') ?? process.cwd(), flag(rest, 'since')));
  } else if (group === 'slips' && cmd === 'print') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rest[0] ?? '')) return fail('usage: pebble slips print <YYYY-MM-DD> [--out dir]');
    console.log(`${printPackingSlips(rest[0], flag(rest, 'out') ?? process.cwd())} packing slips written`);
  } else if (group === 'version') {
    const rev = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    console.log(`pebble ${pkg.version} (${rev})`);
  } else {
    fail('usage: pebble receipts resend <order-id> | prices import <file.json> | report nightly [--out dir] [--since date] | slips print <date> [--out dir] | version');
  }
}

function fail(msg) {
  console.error(msg);
  process.exitCode = 2;
}

main(process.argv.slice(2));
