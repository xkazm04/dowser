'use strict';
// "Save for later": products a signed-in customer keeps aside for another visit.
const { run, query } = require('../db');

/** POST /wishlist {sku} - keeps a product for later. */
function saveForLater(req, res) {
  if (!req.session.userId) return res.status(401).json({ error: 'sign-in-required', message: 'Sign in to save products for later.', actions: [{ label: 'Sign in', href: '/login' }] });
  if (typeof req.body.sku !== 'string') return res.status(400).json({ error: 'sku-required', message: 'Choose a product to save.' });
  run('INSERT OR IGNORE INTO saved_items (user_id, sku) VALUES (?, ?)', [req.session.userId, req.body.sku]);
  res.json({ ok: true, message: 'Saved for later. Find it under Saved items in your account.' });
}

/** GET /wishlist - the products this customer saved, newest first. */
function listSaved(req, res) {
  if (!req.session.userId) return res.status(401).json({ error: 'sign-in-required', message: 'Sign in to see your saved items.', actions: [{ label: 'Sign in', href: '/login' }] });
  res.json({ items: query('SELECT sku, saved_at FROM saved_items WHERE user_id = ? ORDER BY saved_at DESC', [req.session.userId]) });
}

module.exports = { saveForLater, listSaved };
