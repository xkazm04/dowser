'use strict';
const { query } = require('../db');

const STATUSES = ['paid', 'packed', 'shipped', 'delivered', 'refunded'];
// What a customer sees of an order. Carrier and parcel code stay with the warehouse.
const COLUMNS = 'id, customer_id, created_at, status, items, total, currency';

/**
 * A customer's orders, newest first. `status` narrows to one of STATUSES; `limit` caps the list.
 * The finance job and the order history page both read through here.
 */
function listOrders(customerId, { status, limit = 50 } = {}) {
  if (status !== undefined && !STATUSES.includes(status)) throw new Error(`unknown status ${status}`);
  return status
    ? query(`SELECT ${COLUMNS} FROM orders WHERE customer_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?`, [customerId, status, limit])
    : query(`SELECT ${COLUMNS} FROM orders WHERE customer_id = ? ORDER BY created_at DESC LIMIT ?`, [customerId, limit]);
}

/** One order by id, or undefined. */
function getOrder(id) {
  return query(`SELECT ${COLUMNS} FROM orders WHERE id = ?`, [id])[0];
}

module.exports = { listOrders, getOrder, STATUSES };
