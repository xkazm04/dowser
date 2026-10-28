'use strict';
const { PEBBLE_GUEST_CHECKOUT } = require('../config');

/**
 * Guest checkout: when PEBBLE_GUEST_CHECKOUT=1, a shopper may pay with an email address instead of an account.
 * The order is linked to the email, and the receipt link lets the guest see the order later.
 */
function allowGuestCheckout(req) {
  return PEBBLE_GUEST_CHECKOUT && !req.session.userId && typeof req.body.email === 'string';
}

module.exports = { allowGuestCheckout };
