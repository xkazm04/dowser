'use strict';
const { listOrders, getOrder } = require('../orders/store');

/** GET /orders - the signed-in customer's order history (the 50 newest). */
function orderHistory(req, res) {
  if (!req.session.userId) return res.status(401).json({ error: 'sign-in-required', message: 'Sign in to see your orders.', actions: [{ label: 'Sign in', href: '/login' }] });
  res.json({ orders: listOrders(req.session.userId) });
}

/** GET /orders/:id - one order with its items and status. */
function orderDetail(req, res, id) {
  const order = getOrder(id);
  if (!order || order.customer_id !== req.session.userId) {
    return res.status(404).json({ error: 'not-found', message: 'We could not find that order.', actions: [{ label: 'Back to your orders', href: '/orders' }] });
  }
  res.json({ order });
}

module.exports = { orderHistory, orderDetail };
