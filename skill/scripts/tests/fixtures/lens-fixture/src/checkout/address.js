'use strict';
const messages = require('./messages');

/** POST /checkout/address {name, street, city} - keeps the delivery address on the session. */
function saveAddress(req, res) {
  const { name, street, city } = req.body;
  if (!name || !street || !city) return res.status(400).json({ error: 'address-incomplete', message: 'Fill in name, street and city.' });
  req.session.address = { name, street, city };
  res.json({ ok: true, message: messages.ADDRESS_SAVED });
}

module.exports = { saveAddress };
