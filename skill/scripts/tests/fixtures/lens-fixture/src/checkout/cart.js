'use strict';
const { MAX_CART_ITEMS } = require('../config');
const { run, query } = require('../db');

/**
 * POST /cart {sku, quantity} - adds a product to the session's cart.
 * A full cart keeps its contents and tells the shopper how to make room.
 */
function addToCart(req, res) {
  const { sku, quantity = 1 } = req.body;
  const [{ count }] = query('SELECT COALESCE(SUM(quantity), 0) AS count FROM cart_items WHERE session = ?', [req.session.id]);
  if (count + quantity > MAX_CART_ITEMS) {
    return res.status(409).json({
      error: 'cart-full',
      message: `Your cart holds up to ${MAX_CART_ITEMS} items. Remove an item or check out first, then add this one.`,
      actions: [{ label: 'View cart', href: '/cart' }],
    });
  }
  run('INSERT INTO cart_items (session, sku, quantity) VALUES (?, ?, ?)', [req.session.id, sku, quantity]);
  res.status(201).json({ ok: true, count: count + quantity });
}

module.exports = { addToCart };
