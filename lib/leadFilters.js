const { buildReport } = require('./reportMath');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Static SQL fragments (never built from user input). `x` is the wrapped orders row with last_disposition.
const STATUS_SQL = {
  pending: `x.confirmation_status = 'pending' AND x.dnc = FALSE`,
  callback: `x.confirmation_status = 'pending' AND x.callback_at IS NOT NULL AND x.dnc = FALSE`,
  dnp: `x.confirmation_status = 'pending' AND x.last_disposition = 'dnp' AND x.dnc = FALSE`,
  confirmed: `x.confirmation_status = 'confirmed'`,
  cancelled: `x.confirmation_status = 'cancelled'`,
  wrong_number: `x.confirmation_status = 'wrong_number'`,
  unreachable: `x.confirmation_status = 'unreachable'`,
  dnc: `x.dnc = TRUE`,
  prepaid: `x.converted_to_prepaid = TRUE`,
  // Day-wise report columns (lib/funnel.js definitions: any call counts, "connected" = a customer was spoken to, ever).
  d_called: `x.call_count > 0`,
  d_not_called: `x.call_count = 0`,
  d_connected: `x.connected_count > 0`,
  d_confirmed: `x.confirmation_status = 'confirmed' AND x.connected_count > 0`,
  d_cancelled: `x.confirmation_status = 'cancelled' AND x.connected_count > 0`,
  d_not_connected: `x.call_count > 0 AND x.connected_count = 0`,
  d_nc_done2: `x.call_count >= 2 AND x.connected_count = 0`,
  d_nc_due2: `x.call_count = 1 AND x.connected_count = 0`,
  d_nc_done3: `x.call_count >= 3 AND x.connected_count = 0`,
  d_nc_due3: `x.call_count = 2 AND x.connected_count = 0`,
  d_closed_no_call: `x.confirmation_status IN ('confirmed','cancelled') AND x.connected_count = 0`,  // Lead-board buckets. Same rules as lib/funnel.js buildPipeline(); x.call_count / x.connected_count count real calls only.
  fresh: `x.confirmation_status = 'pending' AND x.dnc = FALSE AND x.callback_at IS NULL AND x.call_count = 0`,
  not_connected: `x.confirmation_status = 'pending' AND x.dnc = FALSE AND x.callback_at IS NULL AND x.call_count > 0 AND x.connected_count = 0`,
  nc_1: `x.confirmation_status = 'pending' AND x.dnc = FALSE AND x.callback_at IS NULL AND x.call_count = 1 AND x.connected_count = 0`,
  nc_2: `x.confirmation_status = 'pending' AND x.dnc = FALSE AND x.callback_at IS NULL AND x.call_count = 2 AND x.connected_count = 0`,
  nc_3_plus: `x.confirmation_status = 'pending' AND x.dnc = FALSE AND x.callback_at IS NULL AND x.call_count >= 3 AND x.connected_count = 0`,
  callback_due: `x.confirmation_status = 'pending' AND x.dnc = FALSE AND x.callback_at IS NOT NULL AND x.callback_at <= NOW()`,
  callback_later: `x.confirmation_status = 'pending' AND x.dnc = FALSE AND x.callback_at IS NOT NULL AND x.callback_at > NOW()`,
  in_progress: `x.confirmation_status = 'pending' AND x.dnc = FALSE AND x.callback_at IS NULL AND x.connected_count > 0`,
  to_call_now: `x.confirmation_status = 'pending' AND x.dnc = FALSE AND ((x.callback_at IS NULL AND x.connected_count = 0) OR (x.callback_at IS NOT NULL AND x.callback_at <= NOW()))`,
  short_open: `x.address_is_short = TRUE AND x.address_fixed = FALSE AND x.confirmation_status IN ('pending','confirmed') AND COALESCE(x.dnc,FALSE) = FALSE AND x.shipped_at IS NULL AND COALESCE(x.order_status,'new') NOT IN ('shipped','delivered','rto','cancelled') AND COALESCE(x.address_locked,FALSE) = FALSE`,
  short_open_pending: `x.address_is_short = TRUE AND x.address_fixed = FALSE AND x.confirmation_status = 'pending' AND COALESCE(x.dnc,FALSE) = FALSE AND x.shipped_at IS NULL AND COALESCE(x.order_status,'new') NOT IN ('shipped','delivered','rto','cancelled') AND COALESCE(x.address_locked,FALSE) = FALSE`,
  short_open_confirmed: `x.address_is_short = TRUE AND x.address_fixed = FALSE AND x.confirmation_status = 'confirmed' AND COALESCE(x.dnc,FALSE) = FALSE AND x.shipped_at IS NULL AND COALESCE(x.order_status,'new') NOT IN ('shipped','delivered','rto','cancelled') AND COALESCE(x.address_locked,FALSE) = FALSE`,
};

function statusCondition(status) {
  return Object.prototype.hasOwnProperty.call(STATUS_SQL, status) ? STATUS_SQL[status] : null;
}

// IST day range [start, end) from optional YYYY-MM-DD from/to; blank means "no bound" unless defaultToday.
function dayRange(q, today, defaultToday = false) {
  let from = DATE_RE.test(q.from || '') ? q.from : null;
  let to = DATE_RE.test(q.to || '') ? q.to : null;
  if (defaultToday && !from && !to) { from = today; to = today; }
  if (from && !to) to = from;
  if (to && !from) from = to;
  if (!from) return { from: null, to: null, start: null, end: null };
  const start = new Date(`${from}T00:00:00+05:30`);
  const end = new Date(new Date(`${to}T00:00:00+05:30`).getTime() + 24 * 3600 * 1000);
  if (isNaN(start) || isNaN(end) || end <= start) throw new Error('Invalid date range');
  if (end - start > 366 * 24 * 3600 * 1000) throw new Error('Date range cannot exceed one year');
  return { from, to, start, end };
}

// rows: [{ day, disposition, n }] -> one report row per day, oldest first, plus totals.
function buildDaily(rows) {
  const byDay = new Map();
  const totals = {};
  for (const r of rows) {
    if (!byDay.has(r.day)) byDay.set(r.day, {});
    const o = byDay.get(r.day);
    o[r.disposition] = (o[r.disposition] || 0) + Number(r.n);
    totals[r.disposition] = (totals[r.disposition] || 0) + Number(r.n);
  }
  return {
    days: [...byDay.keys()].sort().map(day => ({ day, ...buildReport(byDay.get(day)) })),
    totals: buildReport(totals),
  };
}

module.exports = { statusCondition, dayRange, buildDaily, STATUS_SQL };
