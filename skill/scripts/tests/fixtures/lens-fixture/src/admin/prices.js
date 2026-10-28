'use strict';
const { run } = require('../db');

/**
 * Bulk price update for the shop owner: rows of {sku, price} from a supplier sheet.
 * Admin-only on purpose - prices are never changed from the storefront.
 */
function bulkUpdatePrices(rows) {
  let changed = 0;
  for (const { sku, price } of rows) {
    if (!Number.isFinite(price) || price <= 0) throw new Error(`bad price for ${sku}`);
    changed += run('UPDATE products SET price = ? WHERE sku = ?', [price, sku]);
  }
  return changed;
}

module.exports = { bulkUpdatePrices };
