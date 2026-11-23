// Lead audit: every order with no attempt, and why. Pure (no database); cc_routes.js loads the rows.
// "No attempt" = no call in the call log (any disposition) and no real IVR call on the order.
//   rows:   cohort rows { id, team: 'InHouse'|'CC', status, day, dnc, callback_at, calls: [dispositions] }   (same rows as the Home report)
//   ivrSet: Set of order ids that had a real IVR call
//   info:   Map(order id -> { order_name, customer_phone, lead_locked_by, lead_locked_at, assigned_agent })
const HOLD_MINUTES = 15;   // the same 15-minute tail the lead-lock expiry uses

function classify(o, x, now) {
  const team = o.team === 'InHouse' ? 'Aman' : 'Call centre';
  const held = ['IVR', 'WHATSAPP'].includes(x.lead_locked_by) && x.lead_locked_at && new Date(x.lead_locked_at).getTime() > now - HOLD_MINUTES * 60000;
  if (o.status !== 'pending') return 'Closed without a call (WhatsApp, sheet or system)';
  if (o.dnc) return 'Do-not-call';
  if (held) return x.lead_locked_by === 'IVR' ? 'Held for the IVR' : 'Waiting for WhatsApp';
  if (o.callback_at) return 'Callback promised';
  return 'Waiting for ' + team + ' (never called)';
}

function build(rows, ivrSet, info, now = Date.now()) {
  const today = new Date(now + 19800000).toISOString().slice(0, 10);
  const dayDiff = (d) => Math.max(0, Math.round((new Date(today) - new Date(d)) / 86400000));
  const none = rows.filter(o => !(o.calls || []).length && !ivrSet.has(o.id));
  const list = none.map(o => {
    const x = (info && info.get(o.id)) || {}, team = o.team === 'InHouse' ? 'Aman' : 'Call centre';
    return { id: o.id, order: x.order_name || '', phone: x.customer_phone || '', day: o.day, age_days: dayDiff(o.day), team, status: o.status, reason: classify(o, x, now), agent: x.assigned_agent || '' };
  }).sort((a, b) => b.age_days - a.age_days || (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const tally = {};
  list.forEach(l => { const t = tally[l.reason] = tally[l.reason] || { reason: l.reason, aman: 0, cc: 0, older_than_1_day: 0, total: 0 }; t[l.team === 'Aman' ? 'aman' : 'cc']++; t.total++; if (l.age_days >= 1) t.older_than_1_day++; });
  return { orders: rows.length, no_attempt: list.length, no_attempt_pending: list.filter(l => l.status === 'pending').length, reasons: Object.values(tally).sort((a, b) => b.total - a.total), list };
}

module.exports = { build, classify };
