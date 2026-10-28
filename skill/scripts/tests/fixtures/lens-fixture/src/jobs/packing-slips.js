'use strict';
// Packing slips: one text file per order shipped on a day, printed and put in the parcel.
const fs = require('node:fs');
const path = require('node:path');
const { query } = require('../db');
const { trackingUrl } = require('../shipping/tracking');

function printPackingSlips(day, outDir) {
  const orders = query("SELECT id, name, address, items, carrier, tracking_code FROM orders WHERE status = 'shipped' AND date(shipped_at) = ?", [day]);
  for (const o of orders) {
    const lines = [`Pebble Shop - order #${o.id}`, `For: ${o.name}`, `Ship to: ${o.address}`, `Items: ${o.items}`];
    const link = trackingUrl(o);
    if (link) lines.push(`Track your parcel: ${link}`);
    fs.writeFileSync(path.join(outDir, `slip-${o.id}.txt`), lines.join('\n') + '\n');
  }
  return orders.length;
}

module.exports = { printPackingSlips };
