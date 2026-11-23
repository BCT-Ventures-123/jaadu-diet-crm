// Loads everything the ship gate needs in one place, so the Ship gate tab and the Daily report Excel show the same orders.
// Read-only. Orders from the calling start date (at most 30 days back), test orders left out.
const cfg = require('./config');
const gate = require('./shipGate');

const TEST = `(LOWER(TRIM(COALESCE(o.customer_name,''))) IN ('test test','test','test order','dummy') OR COALESCE(o.customer_name,'') ~* '^\\s*test\\M')`;

async function loadHolidays(db) {
  try {
    const rows = await db(`SELECT to_char(holiday_date, 'YYYY-MM-DD') AS date, note, created_by FROM shipping_holidays ORDER BY holiday_date`);
    return { available: true, rows, set: new Set(rows.map(r => r.date)) };
  } catch (e) {
    return { available: false, rows: [], set: new Set() };   // table not created yet: behave as "no holidays"
  }
}

// When courier updates began reaching the CRM (the webhook fix went live on 11 Nov 2026 around 12:15 India time). Orders that became ready before
// this and show no AWB are "untracked": they may have shipped without the CRM hearing. Set SHIP_GATE_TRACK_FROM (a date or a date and time) once
// the courier history has been filled in from the Shiprocket / NimbusPost exports.
function trackFromDate() {
  const raw = String(process.env.SHIP_GATE_TRACK_FROM || '').trim();
  const d = raw ? new Date(raw.length === 10 ? raw + 'T00:00:00+05:30' : raw) : null;
  return d && !isNaN(d) ? d : new Date('2026-11-11T12:30:00+05:30');
}

async function loadSnapshot(db, dbOne) {
  const hol = await loadHolidays(db);
  const now = new Date();
  const trackFrom = trackFromDate();
  const calling = new Date(cfg.CALLING_STARTED_ON + 'T00:00:00+05:30');
  const since = new Date(Math.max(calling.getTime(), now.getTime() - 30 * 86400000));
  const orders = await db(
    `SELECT o.id, o.order_name, o.customer_name, o.customer_phone, o.shipping_address1, o.shipping_address2, o.shipping_city, o.shipping_province, o.shipping_zip,
            o.total_price, o.prepaid_amount, o.payment_method, o.converted_to_prepaid, o.confirmation_status, o.order_status, o.confirmed_at, o.shopify_created_at, o.created_at,
            o.awb_number, o.courier_name, o.shipped_at, o.is_duplicate, o.address_fixed, o.assigned_to, o.assigned_agent, o.call_attempts, o.last_call_at, o.line_items,
            (SELECT MIN(e.created_at) FROM order_status_events e WHERE e.order_id = o.id AND e.event_type = 'courier_status') AS first_courier_at
       FROM orders_master o
      WHERE COALESCE(o.shopify_created_at, o.created_at) >= $1::timestamptz AND NOT ${TEST}
      ORDER BY COALESCE(o.shopify_created_at, o.created_at) DESC LIMIT 6000`, [since.toISOString()]);
  const opt = { now, holidays: hol.set, minChars: 25, minWords: 4, cutoffHour: 14, trackFrom };
  const r = gate.evaluate(orders, opt);
  const lastCourier = await dbOne(`SELECT MAX(created_at) AS t FROM order_status_events WHERE event_type = 'courier_status'`);
  const lastOrder = await dbOne(`SELECT MAX(COALESCE(shopify_created_at, created_at)) AS t FROM orders_master`);
  const today = gate.todayKey(now);
  const shippingDay = gate.isShippingDay(today, hol.set);
  return {
    r, hol, today, now, since, shippingDay, trackFrom,
    nextShippingDay: shippingDay ? today : gate.nextShippingDay(today, hol.set),
    acc: gate.accuracy(orders, opt),
    health: gate.health({ lastCourierAt: lastCourier && lastCourier.t, lastOrderAt: lastOrder && lastOrder.t, now }),
  };
}

module.exports = { loadSnapshot, loadHolidays };
