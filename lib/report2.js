// Detailed analysis for the Daily report: by hour, timing, attempts and final outcomes, confirmation journey, daily, date x hour.
// Pure functions over the same cohort rows as lib/funnel.js (COD tea orders placed in the dates), so every number agrees with the rest of the report.
// row: { day, order_at, decided_at, status, calls: [dispositions], call_times: [Date], actor, actor_role }
const cfg = require('./config');
const { deciderChannel } = require('./scorecard');

const CONNECTED = new Set(cfg.CONNECTED_DISPOSITIONS);
const H = 36e5;
const hourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: cfg.TIMEZONE, hour: '2-digit', hourCycle: 'h23' });
const istHour = (d) => Number(hourFmt.format(new Date(d))) % 24;
const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
const median = (list) => { if (!list.length) return null; const s = list.slice().sort((a, b) => a - b), m = Math.floor(s.length / 2); return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2); };
const mins = (a, b) => Math.max(0, Math.round((new Date(b) - new Date(a)) / 60000));

// One place that decides what happened to an order. Every order lands in exactly one outcome, so the outcome table always adds up.
function enrich(o) {
  const calls = o.calls || [], times = (o.call_times || []).map(t => new Date(t));
  const firstConn = calls.findIndex(d => CONNECTED.has(d));
  const spoke = firstConn >= 0;
  const ch = deciderChannel(o.actor, o.actor_role);
  const byCall = (ch === 'aman' || ch === 'cc') && spoke;
  let outcome;
  if (o.status === 'confirmed') outcome = ch === 'whatsapp' ? 'wa_confirmed' : ch === 'ivr' ? 'ivr_confirmed' : byCall ? 'call_confirmed' : 'other_confirmed';
  else if (o.status === 'cancelled') outcome = ch === 'whatsapp' ? 'wa_cancelled' : ch === 'ivr' ? 'ivr_cancelled' : byCall ? 'call_cancelled' : 'other_cancelled';
  else if (o.status === 'wrong_number' || o.status === 'unreachable' || o.dnc) outcome = 'ops_issue';
  else if (!calls.length) outcome = 'awaiting_call';
  else if (spoke) outcome = 'in_progress';
  else outcome = 'call_no_response';
  const channel = outcome.startsWith('wa_') ? 'wa' : outcome.startsWith('ivr_') ? 'ivr' : outcome.startsWith('call_') ? 'call' : 'other';
  const decided = o.decided_at ? new Date(o.decided_at) : null;
  const decidedByCustomer = (o.status === 'confirmed' || o.status === 'cancelled') && (channel === 'wa' || channel === 'ivr' || channel === 'call');
  const reachCands = [];
  if (spoke && times[firstConn]) reachCands.push(times[firstConn]);
  if (decidedByCustomer && decided) reachCands.push(decided);
  const reached = spoke || decidedByCustomer;
  const reachedAt = reachCands.length ? new Date(Math.min(...reachCands.map(d => d.getTime()))) : null;
  return { o, calls, times, firstConn, spoke, outcome, channel, decided, reached, reachedAt,
    firstCallGap: times.length ? mins(o.order_at, times[0]) : null, firstConnGap: spoke && times[firstConn] ? mins(o.order_at, times[firstConn]) : null };
}

const OUTCOMES = [['wa_confirmed', 'WhatsApp confirmed'], ['wa_cancelled', 'WhatsApp cancelled'], ['ivr_confirmed', 'IVR confirmed'], ['ivr_cancelled', 'IVR cancelled'],
  ['call_confirmed', 'Call confirmed'], ['call_cancelled', 'Call cancelled'], ['other_confirmed', 'Confirmed without a call (sheet / payment / auto)'], ['other_cancelled', 'Cancelled without a call (sheet / auto)'],
  ['call_no_response', 'Called, nobody answered'], ['in_progress', 'Spoke, not decided yet'], ['ops_issue', 'Wrong number / do not call / unreachable'], ['awaiting_call', 'Awaiting first call']];
const GAPS = [[0, 30, '0–30 min'], [30, 60, '30–60 min'], [60, 120, '1–2 hr'], [120, 240, '2–4 hr'], [240, 480, '4–8 hr'], [480, 1440, '8–24 hr'], [1440, Infinity, '24 hr +']];
const bucketOf = (m) => GAPS.findIndex(g => m >= g[0] && m < g[1]);

// rows: cohort rows. hourCalls: [{hour, calls, connected, confirmed, no_response}] from the call log (calls made in that hour, any order). days: number of days in the range.
function buildReport2(rows, hourCalls = [], days = 1) {
  const E = rows.map(enrich), T = E.length;
  const count = (f) => E.filter(f).length;
  const out = {};

  // ---- overview (the four blocks of the owner's sheet)
  const called = E.filter(e => e.calls.length);
  const callsMade = E.reduce((s, e) => s + e.calls.length, 0);
  const connCalls = E.reduce((s, e) => s + e.calls.filter(d => CONNECTED.has(d)).length, 0);
  const n = (k) => count(e => e.outcome === k);
  out.overview = {
    orders: T, confirmed: count(e => e.o.status === 'confirmed'), cancelled: count(e => e.o.status === 'cancelled'), reached: count(e => e.reached), unconfirmed: count(e => e.o.status === 'pending'),
    confirmed_pct: pct(count(e => e.o.status === 'confirmed'), T), cancelled_pct: pct(count(e => e.o.status === 'cancelled'), T), connectivity_pct: pct(count(e => e.reached), T),
    whatsapp: { confirmed: n('wa_confirmed'), cancelled: n('wa_cancelled'), confirmed_pct: pct(n('wa_confirmed'), T) },
    calling: { orders_called: called.length, calls_made: callsMade, connected_calls: connCalls, connect_pct: pct(connCalls, callsMade), confirm_pct_of_called: pct(n('call_confirmed'), called.length), confirmed: n('call_confirmed'),
      cancelled: n('call_cancelled'), median_to_first_call_min: median(E.filter(e => e.firstCallGap != null).map(e => e.firstCallGap)), median_to_first_connected_min: median(E.filter(e => e.firstConnGap != null).map(e => e.firstConnGap)) },
    ivr: { confirmed: n('ivr_confirmed'), cancelled: n('ivr_cancelled') },
  };

  // ---- 1. by hour of day: when orders come in, and when calls work
  const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, orders: 0, confirmed: 0, cancelled: 0, wa_confirmed: 0 }));
  E.forEach(e => { const h = hours[istHour(e.o.order_at)]; h.orders++; if (e.o.status === 'confirmed') h.confirmed++; if (e.o.status === 'cancelled') h.cancelled++; if (e.outcome === 'wa_confirmed') h.wa_confirmed++; });
  const hc = new Map(hourCalls.map(x => [Number(x.hour), x]));
  out.by_hour = hours.map(h => { const c = hc.get(h.hour) || {}; const calls = c.calls || 0;
    return { hour: h.hour, orders: h.orders, avg_orders_per_day: Math.round((h.orders / Math.max(1, days)) * 10) / 10, wa_confirm_pct: pct(h.wa_confirmed, h.orders), confirmed_pct: pct(h.confirmed, h.orders), cancelled_pct: pct(h.cancelled, h.orders),
      calls, connected: c.connected || 0, connect_pct: pct(c.connected || 0, calls), call_confirmed: c.confirmed || 0, call_confirm_pct: pct(c.confirmed || 0, calls), no_response: c.no_response || 0 }; });

  // ---- 2. timing: does calling sooner help?
  const gapTable = (list, key) => GAPS.map(g => { const inB = list.filter(e => e[key] != null && e[key] >= g[0] && e[key] < g[1]); const conf = inB.filter(e => e.outcome === 'call_confirmed').length;
    return { label: g[2], orders: inB.length, confirmed: conf, confirm_pct: pct(conf, inB.length) }; });
  out.timing = { first_call: gapTable(E, 'firstCallGap'), first_connected: gapTable(E, 'firstConnGap') };

  // ---- 3. attempts and where every order ended up
  const maxK = Math.min(6, Math.max(1, ...E.map(e => e.calls.length)));
  let cum = 0;
  out.attempts = Array.from({ length: maxK }, (_, i) => { const k = i + 1; const made = E.filter(e => e.calls.length >= k);
    const conn = made.filter(e => CONNECTED.has(e.calls[i])).length, conf = made.filter(e => e.calls[i] === 'confirmed').length; cum += conf;
    return { attempt: k, calls_made: made.length, connected: conn, connect_pct: pct(conn, made.length), confirmed_on_call: conf, cumulative_confirmed_pct: pct(cum, T) }; });
  out.outcomes = OUTCOMES.map(([k, label]) => ({ key: k, label, orders: n(k), pct: pct(n(k), T) }));

  // ---- 4. confirmation journey: when (D0 within 24 h, D1 24-48 h, D2+ after) and through which channel
  const win = (e) => { if (!e.decided) return 'unknown'; const h = (e.decided - new Date(e.o.order_at)) / H; return h < 24 ? 'd0' : h < 48 ? 'd1' : 'd2'; };
  const WINS = [['d0', 'D0 (within 24 h)'], ['d1', 'D1 (24–48 h)'], ['d2', 'D2+ (after 48 h)'], ['unknown', 'Day unknown']];
  let cumJ = 0;
  out.journey = WINS.map(([k, label]) => { const conf = E.filter(e => e.o.status === 'confirmed' && win(e) === k), canc = E.filter(e => e.o.status === 'cancelled' && win(e) === k);
    const ch = (c) => conf.filter(e => e.channel === c).length; cumJ += conf.length;
    return { window: k, label, wa: ch('wa'), ivr: ch('ivr'), call: ch('call'), other: ch('other'), confirmed: conf.length, confirmed_pct: pct(conf.length, T), cumulative_pct: pct(cumJ, T), cancelled: canc.length }; });

  // ---- 5. daily by order date, and 6. date x hour grid
  const byDay = new Map();
  E.forEach(e => { const d = e.o.day; if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(e); });
  const dayKeys = [...byDay.keys()].sort().reverse();
  out.daily = dayKeys.map(d => { const L = byDay.get(d), t = L.length; const conf = (k) => L.filter(e => e.o.status === 'confirmed' && win(e) === k).length;
    const reachedWithin = (hrs) => L.filter(e => e.reached && e.reachedAt && (e.reachedAt - new Date(e.o.order_at)) / H < hrs).length;
    const c0 = conf('d0'), c1 = conf('d1'), c2 = conf('d2'), cu = conf('unknown'), tot = c0 + c1 + c2 + cu;
    return { day: d, orders: t, confirmed_d0: c0, confirmed_d1: c1, confirmed_d2: c2, confirmed_unknown: cu, confirmed: tot, confirmed_pct: pct(tot, t), confirmed_d0_pct: pct(c0, t),
      cancelled: L.filter(e => e.o.status === 'cancelled').length, pending: L.filter(e => e.o.status === 'pending').length,
      reached: L.filter(e => e.reached).length, connectivity_d0_pct: pct(reachedWithin(24), t), connectivity_till_d1_pct: pct(reachedWithin(48), t), connectivity_all_pct: pct(L.filter(e => e.reached).length, t) }; });
  out.grid = dayKeys.map(d => { const row = Array(24).fill(0); byDay.get(d).forEach(e => { row[istHour(e.o.order_at)]++; }); return { day: d, hours: row }; });
  return out;
}

module.exports = { buildReport2, enrich, istHour, GAPS, OUTCOMES };
