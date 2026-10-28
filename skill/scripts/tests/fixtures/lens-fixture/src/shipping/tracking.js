'use strict';
// Carrier tracking links. Each shipped order carries the carrier it went with and that carrier's parcel code.

const CARRIERS = {
  postnl: 'https://jouw.postnl.example/track-and-trace/',
  dhl: 'https://www.dhl.example/track?tracking-id=',
  ups: 'https://www.ups.example/track?tracknum=',
};

/**
 * The carrier's tracking page for a shipped order, or undefined while it has not shipped.
 * Printed on the packing slip (src/jobs/packing-slips.js).
 */
function trackingUrl(order) {
  const base = CARRIERS[order.carrier];
  if (!base || !order.tracking_code) return undefined;
  return base + encodeURIComponent(order.tracking_code);
}

module.exports = { trackingUrl, CARRIERS };
