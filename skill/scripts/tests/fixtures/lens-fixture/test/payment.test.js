'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { onPaymentError } = require('../src/checkout/payment');

// A stand-in credential for the fake StonePay server below; it opens nothing.
const api_key = 'test_key_fake_0000000000';

function fakeRes() {
  const res = { statusCode: 200 };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; };
  return res;
}

test('a declined payment answers 402 with a message', () => {
  const req = { session: { checkoutForm: { card: '4242' } }, headers: { authorization: `Bearer ${api_key}` } };
  const res = fakeRes();
  onPaymentError(req, res, { code: 'card_declined' });
  assert.equal(res.statusCode, 402);
  assert.equal(res.body.error, 'payment-failed');
});
