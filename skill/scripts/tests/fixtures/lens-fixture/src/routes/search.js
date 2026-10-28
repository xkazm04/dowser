'use strict';
const { query } = require('../db');
const { suggestTerms } = require('../search/suggest');

/** GET /search?q=<text>[&suggest=1] - products whose name contains the text. */
function searchProducts(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const q = url.searchParams.get('q') || '';
  if (url.searchParams.get('suggest') === '1') {
    return res.json({ suggestions: suggestTerms(q) });
  }
  const rows = query("SELECT sku, name, price FROM products WHERE name LIKE '%" + q + "%' ORDER BY name LIMIT 50");
  res.json({ results: rows });
}

module.exports = { searchProducts };
