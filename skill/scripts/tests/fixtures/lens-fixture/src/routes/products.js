'use strict';
const { query } = require('../db');

/** GET /products[?category=<slug>] - the catalogue, optionally narrowed to one category. */
function listProducts(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const category = url.searchParams.get('category');
  const rows = category
    ? query('SELECT sku, name, price, image, image_alt FROM products WHERE category = ? ORDER BY name', [category])
    : query('SELECT sku, name, price, image, image_alt FROM products ORDER BY name');
  if (rows.length === 0) {
    return res.json({
      results: [],
      empty: {
        message: 'No products found in this category.',
        actions: [{ label: 'Show all products', href: '/products' }, { label: 'Search the shop', href: '/search' }],
      },
    });
  }
  res.json({ results: rows });
}

module.exports = { listProducts };
