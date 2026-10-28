'use strict';
const { query } = require('../db');

/** Up to 5 product names starting with the typed prefix, for the search box's suggestion list. */
function suggestTerms(prefix) {
  if (!prefix || prefix.length < 2) return [];
  return query('SELECT name FROM products WHERE name LIKE ? ORDER BY sold DESC LIMIT 5', [`${prefix}%`]).map((r) => r.name);
}

module.exports = { suggestTerms };
