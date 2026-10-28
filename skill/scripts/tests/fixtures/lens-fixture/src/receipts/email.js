'use strict';
const _ = require('lodash');
const { query } = require('../db');

const RECEIPT = _.template(
  'Hello <%= name %>,\n\nThank you for your order #<%= id %> of <%= total %> <%= currency %>.\n' +
  'It ships to: <%= address %>\n\nPebble Shop',
);

/** Renders and sends the receipt e-mail for one order. */
async function sendReceipt(orderId) {
  const [order] = query('SELECT id, name, email, total, currency, address FROM orders WHERE id = ?', [orderId]);
  if (!order) throw new Error(`order ${orderId} not found`);
  const text = RECEIPT(order);
  await mailer(order.email, `Your Pebble Shop order #${order.id}`, text);
}

/**
 * Sends the receipt for an existing order again. Support staff run it from the admin CLI
 * (`pebble receipts resend <order-id>`) when a customer writes in that the e-mail never arrived.
 */
async function resendReceipt(orderId) {
  await sendReceipt(orderId);
  return { resent: true, orderId };
}

/** The outgoing mail hook; replaced in production by the SMTP relay. */
async function mailer(to, subject, text) {
  console.log(`mail to=${to} subject=${subject} bytes=${text.length}`);
}

module.exports = { sendReceipt, resendReceipt };
