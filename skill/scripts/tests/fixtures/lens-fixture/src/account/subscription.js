'use strict';
// "Pebble Box": a monthly box of seasonal goods.
const { run, query } = require('../db');

/** POST /box/subscribe {plan} - one click from the product page, billed monthly from today. */
function subscribe(req, res) {
  run('INSERT INTO subscriptions (user_id, plan, status) VALUES (?, ?, ?)', [req.session.userId, req.body.plan, 'active']);
  res.json({ ok: true, message: 'Welcome to Pebble Box! Your first box ships this week.' });
}

/**
 * POST /box/cancel {step, ...} - cancelling walks through the steps of public/cancel.html:
 * 1 reason survey, 2 discount offer, 3 "pause instead" (pre-selected), 4 final confirmation.
 */
function cancelSubscription(req, res) {
  const step = Number(req.body.step || 1);
  if (step < 4) return res.json({ next: step + 1 });
  if (req.body.pause === 'on') {
    run("UPDATE subscriptions SET status = 'paused' WHERE user_id = ?", [req.session.userId]);
    return res.json({ ok: true, message: 'Your box is paused for 3 months.' });
  }
  run("UPDATE subscriptions SET status = 'cancelled' WHERE user_id = ?", [req.session.userId]);
  const [sub] = query('SELECT renews_at FROM subscriptions WHERE user_id = ?', [req.session.userId]);
  res.json({ ok: true, message: `Cancelled. Your last box ships before ${sub.renews_at}.` });
}

module.exports = { subscribe, cancelSubscription };
