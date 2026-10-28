'use strict';
const { stonepay, CURRENCY } = require('../config');
const messages = require('./messages');
const { run } = require('../db');
const { sendReceipt } = require('../receipts/email');

/** Charges the card through StonePay. Resolves to {ok, code}. */
async function charge(card, amount) {
  const res = await fetch(stonepay.endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${stonepay.api_key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ card, amount, currency: CURRENCY }),
  });
  const body = await res.json();
  return { ok: res.ok, code: body.code };
}

/** A declined or failed charge: the checkout form is reset and one message is shown. */
function onPaymentError(req, res, result) {
  req.session.checkoutForm = {};
  console.error('payment failed', result.code);
  res.status(402).json({ error: 'payment-failed', message: messages.PAYMENT_FAILED });
}

/** POST /checkout/payment {card, address} - the last checkout step. */
async function submitPayment(req, res) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'sign-in-required', message: 'Sign in to pay.', actions: [{ label: 'Sign in', href: '/login' }] });
  }
  const total = req.session.cartTotal;
  if (!total) {
    return res.status(440).json({ error: 'session-expired', message: messages.SESSION_EXPIRED, actions: [{ label: 'Sign in', href: '/login' }] });
  }
  const { card, address } = req.body;
  req.session.checkoutForm = { card, address };
  const result = await charge(card, total);
  if (!result.ok) return onPaymentError(req, res, result);
  const orderId = run('INSERT INTO orders (session, total, address, status) VALUES (?, ?, ?, ?)', [req.session.id, total, JSON.stringify(address), 'paid']);
  await sendReceipt(orderId);
  res.json({ ok: true, orderId, message: messages.PAYMENT_OK });
}

module.exports = { submitPayment, onPaymentError };
