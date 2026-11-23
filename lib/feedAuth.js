// Key check for the read-only ship feed used by the logistics dashboard. The key is read from the environment (SHIP_FEED_KEY) and is
// never created or stored by the code. With no key set the feed is switched off.
const crypto = require('crypto');

function checkFeedKey(provided, expected) {
  if (!expected) return { ok: false, status: 503, error: 'The ship feed is switched off (SHIP_FEED_KEY is not set).' };
  if (!provided) return { ok: false, status: 401, error: 'Missing key' };
  const a = crypto.createHash('sha256').update(String(provided)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  if (!crypto.timingSafeEqual(a, b)) return { ok: false, status: 401, error: 'Wrong key' };
  return { ok: true };
}

// One order as the dashboard needs it. "disposition" mirrors the word the Google Sheet used, so the dashboard can swap sources easily.
function feedRow(o) {
  return {
    order: o.order_name, disposition: 'Confirmed', payment: o.payment, collect: o.collect, total: o.total_price,
    customer: o.customer_name, phone: o.customer_phone ? String(o.customer_phone).replace(/\D/g, '').slice(-10) : '',
    address: o.address, city: o.city, state: o.state, pincode: o.zip, product: o.product,
    ready_at: o.ready_at, ship_by: o.due, ship_status: o.ship_status, awb: o.awb, courier: o.courier,
  };
}

module.exports = { checkFeedKey, feedRow };
