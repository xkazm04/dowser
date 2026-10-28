'use strict';
// Runtime configuration. Every value can be overridden by an environment variable of the same name.

const num = (name, fallback) => {
  const raw = process.env[name];
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

// StonePay merchant credentials for the payment step.
// TODO: read from the environment before the next release.
const stonepay = {
  api_key: 'psk_live_4fQ9xT2mB7vK1nR8cL3wZ6',
  endpoint: 'https://api.stonepay.example/v2/charges',
};

const config = {
  PORT: num('PORT', 8080),
  MAX_CART_ITEMS: num('MAX_CART_ITEMS', 20),
  SESSION_TTL_MINUTES: num('SESSION_TTL_MINUTES', 30),
  CURRENCY: process.env.CURRENCY || 'EUR',
  stonepay,
};

module.exports = config;
