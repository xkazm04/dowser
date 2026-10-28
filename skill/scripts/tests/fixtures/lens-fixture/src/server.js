'use strict';
const http = require('node:http');
const { PORT } = require('./config');
const { listProducts } = require('./routes/products');
const { searchProducts } = require('./routes/search');
const { orderHistory, orderDetail } = require('./routes/orders');
const { addToCart } = require('./checkout/cart');
const { submitPayment } = require('./checkout/payment');
const { saveAddress } = require('./checkout/address');
const { subscribe, cancelSubscription } = require('./account/subscription');
const { saveForLater, listSaved } = require('./account/wishlist');
const { session, jsonBody, withJson, serveStatic } = require('./http');

const routes = [
  ['GET', /^\/products$/, listProducts],
  ['GET', /^\/search$/, searchProducts],
  ['GET', /^\/orders$/, orderHistory],
  ['GET', /^\/orders\/(\d+)$/, orderDetail],
  ['POST', /^\/cart$/, addToCart],
  ['POST', /^\/checkout\/address$/, saveAddress],
  ['POST', /^\/checkout\/payment$/, submitPayment],
  ['POST', /^\/box\/subscribe$/, subscribe],
  ['POST', /^\/box\/cancel$/, cancelSubscription],
  ['GET', /^\/wishlist$/, listSaved],
  ['POST', /^\/wishlist$/, saveForLater],
];

const server = http.createServer(async (req, res) => {
  withJson(res);
  session(req, res);
  const path = new URL(req.url, 'http://localhost').pathname;
  for (const [method, re, handler] of routes) {
    const m = req.method === method && path.match(re);
    if (m) {
      if (method === 'POST') req.body = await jsonBody(req);
      return handler(req, res, ...m.slice(1));
    }
  }
  if (req.method === 'GET' && serveStatic(req, res)) return;
  res.status(404).json({ error: 'not-found', message: 'This page does not exist.', actions: [{ label: 'Go to the shop', href: '/' }] });
});

if (require.main === module) server.listen(PORT, () => console.log(`Pebble Shop on http://localhost:${PORT}`));

module.exports = { server };
