// Ship gate, phase 1 (read-only). Pure rules: which orders are safe to ship, why others are held, when each must ship, and what looks wrong.
// Rules come from docs/current-business-process.md (owner-stated, 2026-11-11):
//  - prepaid ships directly; COD ships only once confirmed (caller, IVR or WhatsApp)
//  - a short address (under 25 characters) must be fixed first; cancelled, duplicate and already-shipped orders never ship
//  - "shipped" means the AWB is generated
//  - confirmed by 2 PM on a shipping day ships that day, otherwise the next shipping day; no Sundays, no bank holidays
const { isShortAddress, fullAddressOf } = require('./address');

const SHIPPED_STATES = ['shipped', 'delivered', 'ndr', 'rto', 'lost', 'returned'];
const REASON_TEXT = {
  unconfirmed: 'COD order not confirmed yet',
  cancelled: 'Cancelled',
  duplicate: 'Duplicate waiting for review',
  short_address: 'Address too short, needs fixing',
  already_shipped: 'AWB already generated',
};
const DAY = 86400000;

const isPrepaid = (o) => String(o.payment_method || '').toUpperCase() !== 'COD' || !!o.converted_to_prepaid;

// India time without any timezone library.
function istParts(d) {
  const t = new Date(new Date(d).getTime() + 19800000);
  return { key: t.toISOString().slice(0, 10), h: t.getUTCHours(), m: t.getUTCMinutes() };
}
const todayKey = (now = new Date()) => istParts(now).key;
const addDays = (key, n) => new Date(new Date(key + 'T00:00:00Z').getTime() + n * DAY).toISOString().slice(0, 10);
const isShippingDay = (key, holidays = new Set()) => new Date(key + 'T00:00:00Z').getUTCDay() !== 0 && !holidays.has(key);
function nextShippingDay(key, holidays = new Set()) {
  let k = key;
  for (let i = 0; i < 60; i++) { k = addDays(k, 1); if (isShippingDay(k, holidays)) return k; }
  return k;
}

// The day an order must have its AWB by. "2 PM tak": up to and including 14:00 counts for the same day.
function dueDay(readyAt, holidays = new Set(), cutoffHour = 14) {
  const t = istParts(readyAt);
  const inTime = t.h < cutoffHour || (t.h === cutoffHour && t.m === 0);
  return isShippingDay(t.key, holidays) && inTime ? t.key : nextShippingDay(t.key, holidays);
}

// When the order became ready: prepaid from payment/order time, COD from the confirmation.
function readyAtOf(o) {
  const placed = o.shopify_created_at || o.created_at;
  return o.confirmed_at || placed;
}

function hasAwb(o) {
  return !!(o.awb_number || SHIPPED_STATES.includes(o.order_status) || o.shipped_at);
}

// Every reason an order is not safe to ship. Empty list = ready.
function blockReasons(o, opt = {}) {
  const r = [];
  if (o.confirmation_status === 'cancelled' || o.order_status === 'cancelled') r.push('cancelled');
  if (hasAwb(o)) r.push('already_shipped');
  if (o.is_duplicate) r.push('duplicate');
  if (!isPrepaid(o) && o.confirmation_status !== 'confirmed' && !r.includes('cancelled')) r.push('unconfirmed');
  if (!o.address_fixed && isShortAddress(fullAddressOf(o), { minChars: opt.minChars || 25, minWords: opt.minWords || 4 })) r.push('short_address');
  return r;
}

// Splits orders into ready, blocked, chase (ready but due today or late), and wrong-ship alerts (AWB exists but should not have shipped).
// trackFrom: the moment courier updates began reaching the CRM. An order that became ready earlier and shows no AWB may well have shipped
// (the CRM never heard), so it is listed as "untracked" instead of ready or overdue.
function evaluate(orders, { now = new Date(), holidays = new Set(), minChars, minWords, cutoffHour = 14, trackFrom = null } = {}) {
  const today = todayKey(now);
  const ready = [], blocked = [], wrong = [], untracked = [];
  for (const o of orders) {
    const reasons = blockReasons(o, { minChars, minWords });
    const due = dueDay(readyAtOf(o), holidays, cutoffHour);
    const base = { ...o, prepaid: isPrepaid(o), due, ready_at: readyAtOf(o) };
    if (!reasons.length) {
      if (trackFrom && new Date(readyAtOf(o)) < trackFrom) { untracked.push(base); continue; }
      const status = due < today ? 'overdue' : due === today ? 'due_today' : 'scheduled';
      ready.push({ ...base, ship_status: status });
    } else if (reasons.length === 1 && reasons[0] === 'already_shipped') {
      // fine: shipped and was eligible
    } else if (reasons.includes('already_shipped')) {
      wrong.push({ ...base, reasons: reasons.filter(x => x !== 'already_shipped'), reason_text: reasons.filter(x => x !== 'already_shipped').map(x => REASON_TEXT[x]) });
    } else {
      blocked.push({ ...base, reasons, reason_text: reasons.map(x => REASON_TEXT[x]) });
    }
  }
  const order = { overdue: 0, due_today: 1, scheduled: 2 };
  ready.sort((a, b) => order[a.ship_status] - order[b.ship_status] || new Date(a.ready_at) - new Date(b.ready_at));
  return { ready, blocked, wrong, untracked, chase: ready.filter(x => x.ship_status !== 'scheduled') };
}

// Per-day accuracy: of the orders due on each day, how many had an AWB in time. firstAwbAt is the first courier event (a proxy for AWB time).
function accuracy(orders, { now = new Date(), holidays = new Set(), days = 7, cutoffHour = 14, trackFrom = null } = {}) {
  const today = todayKey(now);
  const from = addDays(today, -(days - 1));
  const rows = new Map();
  const row = (k) => { if (!rows.has(k)) rows.set(k, { day: k, due: 0, on_time: 0, late: 0, waiting: 0, missed: 0, time_unknown: 0 }); return rows.get(k); };
  for (const o of orders) {
    if (blockReasons(o).some(r => r !== 'already_shipped')) continue;   // not an eligible order
    if (trackFrom && new Date(readyAtOf(o)) < trackFrom) continue;      // courier data did not exist yet
    const due = dueDay(readyAtOf(o), holidays, cutoffHour);
    if (due < from || due > today) continue;
    const r = row(due); r.due++;
    const endOfDue = new Date(new Date(due + 'T00:00:00Z').getTime() + DAY - 19800000);   // 24:00 IST of the due day
    if (hasAwb(o)) {
      const t = o.first_courier_at || o.shipped_at;
      if (!t) r.time_unknown++; else if (new Date(t) <= endOfDue) r.on_time++; else r.late++;
    } else if (due < today) r.missed++; else r.waiting++;
  }
  return [...rows.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
}

// Are the data feeds alive? A silent feed was the reason delivery data was empty for weeks.
function health({ lastCourierAt, lastOrderAt, now = new Date(), staleHours = 24 } = {}) {
  const hrs = (t) => (t ? Math.round(((now - new Date(t)) / 3600000) * 10) / 10 : null);
  const c = hrs(lastCourierAt), o = hrs(lastOrderAt);
  const issues = [];
  if (c === null) issues.push('No courier update has been received yet. Shiprocket / NimbusPost webhooks may not be reaching the CRM.');
  else if (c > staleHours) issues.push(`No courier update for ${c} hours. Check the Shiprocket / NimbusPost webhook.`);
  if (o === null) issues.push('No orders found.');
  else if (o > staleHours) issues.push(`No new Shopify order for ${o} hours. Check the Shopify webhook.`);
  return { ok: !issues.length, hours_since_courier_update: c, hours_since_order: o, issues };
}

// Order details the person who ships needs on one line each.
const addressText = (o) => [o.shipping_address1, o.shipping_address2].filter(Boolean).join(', ');
function itemsText(lineItems) {
  let a = lineItems;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch (e) { a = []; } }
  if (!Array.isArray(a)) return '';
  return a.map(i => (i.title || i.name || 'Item') + ' x' + (i.quantity || 1)).join(', ');
}
// Money to collect from the customer on delivery: nothing for prepaid, the order total for COD.
const collectAmount = (o) => (isPrepaid(o) ? 0 : Number(o.total_price) || 0);

module.exports = { evaluate, accuracy, health, blockReasons, dueDay, nextShippingDay, isShippingDay, readyAtOf, isPrepaid, hasAwb, todayKey, addDays, REASON_TEXT, addressText, itemsText, collectAmount };
