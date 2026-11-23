// One calculation engine for every funnel / lead-board number in the CRM (CC page, Aman page, admin, Excel).
// Input is one row per COD order:
//   { team, status, order_status, dnc, callback_at, short, fixed, locked, is_duplicate, day, order_at, decided_at,
//     calls: ['dnp','confirmed',...]   // real calls only, oldest first (no notes / link-sent rows)
//     call_times: [Date,...] }         // same order as calls
const cfg = require('./config');

const CONNECTED = new Set(cfg.CONNECTED_DISPOSITIONS);
const CALL_TYPES = cfg.CALL_DISPOSITIONS;
const SHIPPED = new Set(['shipped', 'delivered', 'rto']);
const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
const mins = (a, b) => (a && b ? (new Date(b) - new Date(a)) / 60000 : null);
const avg = (list) => {
  const v = list.filter(x => x !== null && x >= 0);
  return v.length ? Math.round(v.reduce((s, x) => s + x, 0) / v.length) : null;
};
function fmtTat(m) {
  if (m == null) return '—';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const callsOf = (o) => o.calls || [];
const firstConnectedIdx = (o) => callsOf(o).findIndex(d => CONNECTED.has(d));

// Core counts for any set of orders (used for the total and for each day).
function core(rows) {
  const c = { total_orders: 0, attempted: 0, not_attempted: 0, connected: 0, confirmed: 0, cancelled: 0, pending: 0,
    not_connected: 0, nc_2nd: 0, nc_3rd: 0, total_attempts: 0, confirmed_without_call: 0, cancelled_without_call: 0, other_closed: 0 };
  for (const o of rows) {
    const n = callsOf(o).length;
    c.total_orders++;
    c.total_attempts += n;
    if (n > 0) c.attempted++;
    const connected = firstConnectedIdx(o) >= 0;
    if (connected) c.connected++;
    // Confirmed / cancelled count only when a customer was actually spoken to, so confirmed + cancelled can never exceed connected.
    // Orders closed some other way (WhatsApp, IVR, sheet, auto-cancel, customer paid online) are counted separately.
    if (o.status === 'confirmed') { if (connected) c.confirmed++; else c.confirmed_without_call++; }
    else if (o.status === 'cancelled') { if (connected) c.cancelled++; else c.cancelled_without_call++; }
    else if (o.status === 'pending') c.pending++;
    else c.other_closed++; // wrong_number, unreachable
    if (n > 0 && !connected) { c.not_connected++; if (n >= 2) c.nc_2nd++; if (n >= 3) c.nc_3rd++; }
  }
  c.not_attempted = c.total_orders - c.attempted;
  // Not-connected orders: how many still need their 2nd attempt (only 1 call so far) and their 3rd (only 2 calls so far).
  c.nc_2nd_pending = c.not_connected - c.nc_2nd;
  c.nc_3rd_pending = c.nc_2nd - c.nc_3rd;
  return c;
}

function withPct(c) {
  const t = c.total_orders;
  return {
    ...c,
    attempted_pct: pct(c.attempted, t), not_attempted_pct: pct(c.not_attempted, t), connected_pct: pct(c.connected, t),
    confirmed_pct: pct(c.confirmed, t), cancelled_pct: pct(c.cancelled, t), pending_pct: pct(c.pending, t),
    confirmed_without_call_pct: pct(c.confirmed_without_call, t), cancelled_without_call_pct: pct(c.cancelled_without_call, t),
    not_connected_pct: pct(c.not_connected, t),
    nc_2nd_pct: pct(c.nc_2nd, t), nc_3rd_pct: pct(c.nc_3rd, t),
    nc_2nd_of_nc_pct: pct(c.nc_2nd, c.not_connected), nc_3rd_of_nc_pct: pct(c.nc_3rd, c.not_connected),
  };
}

function buildFunnel(rows) {
  const base = core(rows);
  // Per-attempt view (kept for the older report cards and the Excel sheet).
  const att = { 1: { total: 0, connected: 0, dnp: 0 }, 2: { total: 0, connected: 0, dnp: 0 }, 3: { total: 0, connected: 0, dnp: 0 } };
  const t1 = [], t12 = [], t23 = [], tDec = [];
  let reattempted = 0, c1 = 0, c2 = 0, c3p = 0;
  for (const o of rows) {
    const calls = callsOf(o);
    for (let k = 1; k <= 3; k++) {
      if (calls.length >= k) { att[k].total++; if (CONNECTED.has(calls[k - 1])) att[k].connected++; else att[k].dnp++; }
    }
    if (calls.length >= 2) reattempted++;
    const idx = firstConnectedIdx(o);
    if (idx === 0) c1++; else if (idx === 1) c2++; else if (idx >= 2) c3p++;
    const ct = (o.call_times || []).filter((_, i) => CONNECTED.has(calls[i]));
    if (ct[0]) t1.push(mins(o.order_at, ct[0]));
    if (ct[1]) t12.push(mins(ct[0], ct[1]));
    if (ct[2]) t23.push(mins(ct[1], ct[2]));
    if (o.decided_at && idx >= 0 && (o.status === 'confirmed' || o.status === 'cancelled')) tDec.push(mins(o.order_at, o.decided_at));
  }
  const tat = { order_to_1st: avg(t1), first_to_2nd: avg(t12), second_to_3rd: avg(t23), order_to_decision: avg(tDec) };
  const t = base.total_orders;
  return {
    ...withPct(base),
    connected_on_1st: c1, connected_on_2nd: c2, connected_on_3rd_plus: c3p,
    reattempted_leads: reattempted, reattempt_pct: pct(reattempted, base.attempted),
    attempts: att,
    tat, tat_fmt: { order_to_1st: fmtTat(tat.order_to_1st), first_to_2nd: fmtTat(tat.first_to_2nd), second_to_3rd: fmtTat(tat.second_to_3rd), order_to_decision: fmtTat(tat.order_to_decision) },
    address_issues: rows.filter(o => o.short).length, address_fixed: rows.filter(o => o.short && o.fixed).length,
    total_for_pct: t,
  };
}

function buildDays(rows) {
  const by = new Map();
  for (const o of rows) { if (!by.has(o.day)) by.set(o.day, []); by.get(o.day).push(o); }
  return [...by.keys()].sort().map(day => ({ day, ...withPct(core(by.get(day))) }));
}

// Where every order is RIGHT NOW. Buckets are mutually exclusive and add up to total_orders.
function buildPipeline(rows, now = new Date()) {
  const p = {
    total_orders: rows.length,
    fresh: 0, fresh_age: { under_1d: 0, d1_to_3: 0, over_3d: 0 }, not_connected: 0, nc_1: 0, nc_2: 0, nc_3_plus: 0,
    callback_due: 0, callback_later: 0, in_progress: 0,
    confirmed: 0, cancelled: 0, wrong_number: 0, unreachable: 0, dnc: 0,
    short_open: 0, short_open_pending: 0, short_open_confirmed: 0, short_fixed: 0, duplicates_open: 0,
  };
  for (const o of rows) {
    const calls = callsOf(o);
    const n = calls.length;
    if (o.status === 'confirmed') p.confirmed++;
    else if (o.status === 'cancelled') p.cancelled++;
    else if (o.status === 'wrong_number') p.wrong_number++;
    else if (o.status === 'unreachable') p.unreachable++;
    else if (o.dnc) p.dnc++;
    else if (o.callback_at) { if (new Date(o.callback_at) <= now) p.callback_due++; else p.callback_later++; }
    else if (n === 0) {
      p.fresh++;
      const hrs = (now - new Date(o.order_at)) / 36e5;   // age of the order; the three buckets always add up to fresh
      if (hrs < 24) p.fresh_age.under_1d++; else if (hrs < 72) p.fresh_age.d1_to_3++; else p.fresh_age.over_3d++;
    }
    else if (firstConnectedIdx(o) < 0) { p.not_connected++; if (n === 1) p.nc_1++; else if (n === 2) p.nc_2++; else p.nc_3_plus++; }
    else p.in_progress++;

    // Only addresses that still need fixing: order is open (pending or confirmed), not a do-not-call lead, not shipped, address not locked.
    const open = (o.status === 'pending' || o.status === 'confirmed') && !o.dnc && !o.shipped && !SHIPPED.has(o.order_status) && o.order_status !== 'cancelled' && !o.locked;
    if (o.short && o.fixed) p.short_fixed++;
    if (o.short && !o.fixed && open) {
      p.short_open++;
      if (o.status === 'confirmed') p.short_open_confirmed++; else p.short_open_pending++;
    }
    if (o.is_duplicate && o.status === 'pending') p.duplicates_open++;
  }
  p.to_call_now = p.fresh + p.not_connected + p.callback_due;
  const t = p.total_orders;
  const pcts = {};
  for (const k of ['fresh', 'not_connected', 'nc_1', 'nc_2', 'nc_3_plus', 'callback_due', 'callback_later', 'in_progress', 'confirmed', 'cancelled', 'wrong_number', 'unreachable', 'dnc', 'to_call_now', 'short_open']) {
    pcts[k] = pct(p[k], t);
  }
  return { ...p, pct: pcts };
}

// Orders per product (SKU) with the quantity split. An order that contains two of our products counts under both.
// rows carry skus: [{ key, qty }] (see lib/products.js skusOf).
function buildBySku(rows) {
  const { productByKey } = require('./products');
  const by = new Map();
  let totalUnits = 0;
  for (const o of rows) {
    for (const s of o.skus || []) {
      if (!by.has(s.key)) by.set(s.key, { key: s.key, name: productByKey(s.key).name, list: [], units: 0, qty1: 0, qty2: 0, qty3_plus: 0 });
      const e = by.get(s.key);
      e.list.push(o); e.units += s.qty; totalUnits += s.qty;
      if (s.qty === 1) e.qty1++; else if (s.qty === 2) e.qty2++; else e.qty3_plus++;
    }
  }
  const out = [...by.values()].map(e => {
    const c = withPct(core(e.list));
    return { key: e.key, name: e.name, orders: c.total_orders, units: e.units, qty1: e.qty1, qty2: e.qty2, qty3_plus: e.qty3_plus,
      attempted: c.attempted, connected: c.connected, confirmed: c.confirmed, cancelled: c.cancelled, pending: c.pending, not_connected: c.not_connected,
      attempted_pct: c.attempted_pct, connected_pct: c.connected_pct, confirmed_pct: c.confirmed_pct, cancelled_pct: c.cancelled_pct, not_connected_pct: c.not_connected_pct };
  }).sort((a, b) => b.orders - a.orders);
  return { rows: out, total_units: totalUnits };
}

module.exports = { core, withPct, buildFunnel, buildDays, buildPipeline, buildBySku, fmtTat, pct, CALL_TYPES, CONNECTED };
