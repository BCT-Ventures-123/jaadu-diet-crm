// End-to-end calling funnel: from every order down to the confirmation, with a count and a percentage on every line, and the same
// numbers day by day (by order date). Pure: no database here. It uses the same COD cohort rows as lib/funnel.js
// (row: { day, status, calls: ['dnp','confirmed',...] }), plus the number of prepaid orders per day.
//
// Definitions (the report prints them next to the numbers):
//  - Orders = COD orders + prepaid orders placed on the day. Prepaid orders are not called.
//  - Needed a call = COD orders that nobody closed without a call (WhatsApp, IVR, sheet or automatic).
//  - Attempted = at least one real call. Connected = the customer spoke on at least one call; address-fix, callback,
//    do-not-call and escalated calls all count as connected, the same as confirmed and cancelled.
//  - Not connected = called, but nobody ever picked up. Rejected = the customer cancelled on a call.
//  - Total confirmation = confirmed on a call + confirmed on WhatsApp, IVR, the sheet or any other way.
const cfg = require('./config');

const CONNECTED = new Set(cfg.CONNECTED_DISPOSITIONS);
const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);

function stats(rows, prepaid) {
  const s = {
    cod: rows.length, prepaid: prepaid || 0, total: rows.length + (prepaid || 0),
    calls: 0, calls_picked: 0, address_fix_calls: 0, attempted: 0, closed_without_call: 0,
    connected: 0, connected_address_fix_only: 0, not_connected: 0, rejected: 0, cancelled_without_call: 0,
    confirmed_on_call: 0, confirmed_other: 0, confirmed_all: 0, pending: 0, other_closed: 0,
  };
  for (const o of rows) {
    const calls = o.calls || [], n = calls.length;
    s.calls += n;
    s.calls_picked += calls.filter(d => CONNECTED.has(d)).length;
    s.address_fix_calls += calls.filter(d => d === 'address_fix').length;
    if (n > 0) s.attempted++;
    const connected = calls.some(d => CONNECTED.has(d));
    if (connected) {
      s.connected++;
      if (!calls.some(d => CONNECTED.has(d) && d !== 'address_fix')) s.connected_address_fix_only++;
    } else if (n > 0) s.not_connected++;
    if (o.status === 'confirmed') { s.confirmed_all++; if (connected) s.confirmed_on_call++; else s.confirmed_other++; }
    else if (o.status === 'cancelled') { if (connected) s.rejected++; else s.cancelled_without_call++; }
    else if (o.status === 'pending') s.pending++;
    else s.other_closed++;
    if (n === 0 && o.status !== 'pending') s.closed_without_call++;
  }
  s.needed_call = s.cod - s.closed_without_call;
  s.not_attempted = Math.max(0, s.needed_call - s.attempted);
  return s;
}

function withPct(s) {
  return {
    ...s,
    attempted_pct: pct(s.attempted, s.needed_call), attempted_of_cod_pct: pct(s.attempted, s.cod), not_attempted_pct: pct(s.not_attempted, s.needed_call),
    connected_pct: pct(s.connected, s.cod), connected_of_attempted_pct: pct(s.connected, s.attempted),
    not_connected_pct: pct(s.not_connected, s.cod), not_connected_of_attempted_pct: pct(s.not_connected, s.attempted),
    rejected_pct: pct(s.rejected, s.cod), confirmed_on_call_pct: pct(s.confirmed_on_call, s.cod), confirmed_other_pct: pct(s.confirmed_other, s.cod),
    confirmed_pct: pct(s.confirmed_all, s.cod), pending_pct: pct(s.pending, s.cod),
    prepaid_pct: pct(s.prepaid, s.total), cod_pct: pct(s.cod, s.total), closed_without_call_pct: pct(s.closed_without_call, s.cod), needed_call_pct: pct(s.needed_call, s.cod),
    calls_per_order_called: s.attempted ? Math.round((s.calls / s.attempted) * 100) / 100 : null, calls_picked_pct: pct(s.calls_picked, s.calls),
  };
}

function buildE2E(rows, prepaidByDay = {}, { today = null } = {}) {
  const by = new Map();
  for (const o of rows) { if (!by.has(o.day)) by.set(o.day, []); by.get(o.day).push(o); }
  Object.keys(prepaidByDay).forEach(d => { if (!by.has(d)) by.set(d, []); });
  const days = [...by.keys()].sort().map(day => ({ day, is_today: day === today, ...withPct(stats(by.get(day), prepaidByDay[day] || 0)) }));
  const totalPrepaid = Object.values(prepaidByDay).reduce((a, b) => a + b, 0);
  const t = withPct(stats(rows, totalPrepaid));

  // The overall table, in the order the owner asked for. base = what the percentage is a percentage of.
  const line = (key, label, count, p, base, hint, tone) => ({ key, label, count, pct: p, base, hint: hint || '', tone: tone || '' });
  const table = [
    line('total', 'Total orders', t.total, t.total ? 100 : null, 'of total orders', 'COD + prepaid placed in these dates'),
    line('prepaid', 'Prepaid orders', t.prepaid, t.prepaid_pct, 'of total orders', 'ship directly, only the address is checked'),
    line('cod', 'COD orders', t.cod, t.cod_pct, 'of total orders', 'every one of these needs a confirmation'),
    line('closed_without_call', 'Closed without a call', t.closed_without_call, t.closed_without_call_pct, 'of COD orders', 'WhatsApp, IVR, sheet or automatic: nobody had to call'),
    line('needed_call', 'COD orders that needed a call', t.needed_call, t.needed_call_pct, 'of COD orders', 'the orders your callers must reach'),
    line('calls', 'Total calls made on these orders', t.calls, null, '', t.calls_per_order_called == null ? '' : t.calls_per_order_called + ' calls per order called · ' + t.calls_picked + ' picked up (' + (t.calls_picked_pct == null ? '-' : t.calls_picked_pct + '%') + ' of calls)'),
    line('attempted', 'Total attempted (called at least once)', t.attempted, t.attempted_pct, 'of orders that needed a call', 'target 100%', t.not_attempted ? 'warn' : 'ok'),
    line('not_attempted', 'Not attempted yet', t.not_attempted, t.not_attempted_pct, 'of orders that needed a call', 'nobody has called these yet', t.not_attempted ? 'bad' : ''),
    line('connected', 'Total connected (customer spoke)', t.connected, t.connected_pct, 'of COD orders', (t.connected_of_attempted_pct == null ? '' : t.connected_of_attempted_pct + '% of attempted · ') + 'address-fix calls count as connected (' + t.address_fix_calls + ' such calls, only ' + t.connected_address_fix_only + ' orders owe their "connected" to one)', 'ok'),
    line('not_connected', 'Not connected (called, never picked up)', t.not_connected, t.not_connected_pct, 'of COD orders', (t.not_connected_of_attempted_pct == null ? '' : t.not_connected_of_attempted_pct + '% of attempted'), t.not_connected ? 'warn' : ''),
    line('rejected', 'Rejected (customer cancelled on a call)', t.rejected, t.rejected_pct, 'of COD orders', t.cancelled_without_call ? t.cancelled_without_call + ' more cancelled without a call (not counted here)' : '', t.rejected ? 'bad' : ''),
    line('confirmed_on_call', 'Confirmed on a call', t.confirmed_on_call, t.confirmed_on_call_pct, 'of COD orders', '', 'ok'),
    line('confirmed_other', 'Confirmed without a call (WhatsApp, IVR, sheet)', t.confirmed_other, t.confirmed_other_pct, 'of COD orders', '', ''),
    line('confirmed_all', 'TOTAL CONFIRMATION (all ways)', t.confirmed_all, t.confirmed_pct, 'of COD orders', 'the number to compare with the 95% target', 'ok'),
    line('pending', 'Still pending', t.pending, t.pending_pct, 'of COD orders', 'no final answer yet', t.pending ? 'warn' : ''),
  ];
  return { totals: t, days, table };
}

// The same two tables as an Excel sheet, placed in the workbook the report downloads.
function addE2ESheet(wb, e2e, headerStyle, title) {
  const w = wb.addWorksheet('End to end');
  const p = (v) => (v == null ? '' : v + '%');
  w.columns = [{ width: 52 }, { width: 12 }, { width: 12 }, { width: 30 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 18 }, { width: 14 }, { width: 14 }, { width: 14 }];
  w.addRow([title || 'End to end: from every order to the confirmation']);
  w.getRow(1).font = { bold: true, size: 12 };
  w.addRow(['Every line has a count and a percentage. The percentage is of the base in column D. Orders are those placed in the chosen dates (by order date).']);
  const head = w.addRow(['Measure', 'Count', '%', 'Percentage of', 'Note']);
  head.eachCell(c => Object.assign(c, headerStyle));
  e2e.table.forEach(x => {
    const r = w.addRow([x.label, x.count, p(x.pct), x.base, x.hint]);
    if (x.key === 'confirmed_all') r.font = { bold: true };
  });
  w.addRow([]);
  const dh = w.addRow(['Order date', 'Total orders', 'Prepaid', 'COD', 'Needed a call', 'Attempted', 'Attempted %', 'Calls made', 'Connected', 'Connected %', 'Not connected', 'Rejected', 'Confirmed (all ways)', 'Confirmed %', 'Pending', 'Not attempted']);
  dh.eachCell(c => Object.assign(c, headerStyle));
  const line = (x, label) => [label, x.total, x.prepaid, x.cod, x.needed_call, x.attempted, p(x.attempted_pct), x.calls, x.connected, p(x.connected_pct), x.not_connected, x.rejected, x.confirmed_all, p(x.confirmed_pct), x.pending, x.not_attempted];
  e2e.days.forEach(x => w.addRow(line(x, x.day + (x.is_today ? ' (today)' : ''))));
  const tot = w.addRow(line(e2e.totals, 'TOTAL'));
  tot.font = { bold: true };
  w.addRow([]);
  w.addRow(['Needed a call = COD orders that nobody closed without a call (WhatsApp, IVR, sheet or automatic). Attempted % is of these.']);
  w.addRow(['Connected = the customer spoke on at least one call. Address-fix, callback, do-not-call and escalated calls count as connected, like confirmed and cancelled.']);
  w.addRow(['Not connected = called but nobody ever picked up. Rejected = the customer cancelled on a call. Total confirmation = confirmed on a call plus confirmed any other way.']);
  w.addRow(['Percentages other than Attempted % are of COD orders. Call pick-up (picked up / calls made) is a different number and is shown only in the Calls line.']);
  return w;
}

module.exports = { buildE2E, stats, withPct, addE2ESheet };
