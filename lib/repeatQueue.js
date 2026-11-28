// Repeat-customer calling (owner 2026-11-27/28). Aman calls customers who bought before and have not bought again (the "Repeat = No" customers from the owner's analysis sheet) and asks for a repeat order.
// Pure rules here (no database): dispositions, when each lead is due next, which leads Aman sees, and the acquisition-month priority mix. The database part is lib/repeatDb.js.
//
// ORDER OF WORK (owner rule: never hand out a fresh lead while follow-ups are waiting, that is lead wastage):
//   1. Follow-ups that are due: Call Back at the promised time, then P2P, WFC, Interested; oldest overdue first within each.
//   2. Retries that are due: DNP / switched off / not reachable, after the retry wait.
//   3. Fresh leads (never called), picked by the acquisition-month mix below. Fresh leads are shown in "Ready now" only when nothing above is due.
//
// ACQUISITION-MONTH MIX for fresh leads. Of every 100 fresh calls:
//   while June still has fresh leads:      June 50, July 25, August 20, September 5
//   then, while July has fresh leads:      July 55, August 25, September 15, October 5
//   then, while August has fresh leads:    August 55, September 30, October 15
//   then:                                  September 60, October 40
// A month with no fresh leads left drops out and the others keep their relative share, so Aman never runs out of work while any month has leads.
const num = (v, d) => (v !== undefined && v !== '' && v !== null && !isNaN(Number(v)) ? Number(v) : d);

const DISPOSITIONS = [
  { key: 'interested', label: 'Interested', connected: true, followup: true },
  { key: 'p2p', label: 'Promise to pay (P2P)', connected: true, followup: true },
  { key: 'wfc', label: 'Waiting for confirmation (WFC)', connected: true, followup: true },
  { key: 'call_back', label: 'Call back', connected: true, followup: true, needsTime: true },
  { key: 'not_interested', label: 'Not interested', connected: true, closes: true },
  { key: 'sale_done', label: 'Sale done', connected: true, closes: true, needsOrder: true },
  { key: 'dnp', label: 'DNP (did not pick up)', connected: false, retry: true },
  { key: 'sw_off', label: 'Switched off', connected: false, retry: true },
  { key: 'not_reachable', label: 'Not reachable', connected: false, retry: true },
];
const BY_KEY = Object.fromEntries(DISPOSITIONS.map(d => [d.key, d]));
const FOLLOWUP_RANK = { call_back: 0, p2p: 1, wfc: 2, interested: 3 };

function settings(env = process.env) {
  return {
    followupHours: { interested: num(env.REPEAT_INTERESTED_HOURS, 24), p2p: num(env.REPEAT_P2P_HOURS, 24), wfc: num(env.REPEAT_WFC_HOURS, 24) },   // next follow-up when Aman does not pick a time
    retryHours: { dnp: num(env.REPEAT_DNP_HOURS, 3), sw_off: num(env.REPEAT_SWOFF_HOURS, 4), not_reachable: num(env.REPEAT_NOTREACH_HOURS, 4) },
    maxUnreached: num(env.REPEAT_MAX_UNREACHED, 6),          // this many tries without ever reaching the customer: rest for parkDays
    parkDays: num(env.REPEAT_PARK_DAYS, 3),
    readyLimit: num(env.REPEAT_READY_LIMIT, 60),             // most leads shown in one list
    dailyFresh: Math.max(0, num(env.REPEAT_DAILY_FRESH, 100)), // fresh (never called) customers released to Aman per day, picked by the month mix. The rest wait for later days. Follow-ups and retries are never limited.
  };
}

// "June 2026" -> "2026-06"; "2026-06" stays. Anything else: null.
const MONTHS = { january: '01', february: '02', march: '03', april: '04', may: '05', june: '06', july: '07', august: '08', september: '09', october: '10', november: '11', december: '12' };
function monthKey(v) {
  const t = String(v == null ? '' : v).trim();
  let m = t.match(/^(\d{4})-(\d{2})/); if (m) return m[1] + '-' + m[2];
  m = t.toLowerCase().match(/^([a-z]+)\s+(\d{4})$/); if (m && MONTHS[m[1]]) return m[2] + '-' + MONTHS[m[1]];
  return null;
}
const tenDigits = (v) => { const d = String(v == null ? '' : v).replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : ''; };

// ---- the mix
function mixFor(freshByMonth) {
  const has = (m) => (freshByMonth[m] || 0) > 0;
  const Y = Object.keys(freshByMonth).map(k => k.slice(0, 4))[0] || '2026';
  const k = (mm) => Y + '-' + mm;
  if (has(k('06'))) return { phase: 1, weights: { [k('06')]: 50, [k('07')]: 25, [k('08')]: 20, [k('09')]: 5 } };
  if (has(k('07'))) return { phase: 2, weights: { [k('07')]: 55, [k('08')]: 25, [k('09')]: 15, [k('10')]: 5 } };
  if (has(k('08'))) return { phase: 3, weights: { [k('08')]: 55, [k('09')]: 30, [k('10')]: 15 } };
  return { phase: 4, weights: { [k('09')]: 60, [k('10')]: 40 } };
}
// Fresh leads in calling order: a weighted interleave, so any stretch of calls follows the mix. Months not in the mix (for example October in phase 1) wait until their phase.
// Inside a month: the most recent buyers first (a customer who bought lately is warmer).
function orderFresh(fresh) {
  const byMonth = {}; fresh.forEach(l => { (byMonth[l.acq_month] = byMonth[l.acq_month] || []).push(l); });
  const counts = Object.fromEntries(Object.entries(byMonth).map(([m, a]) => [m, a.length]));
  const { phase, weights } = mixFor(counts);
  const keyed = [];
  for (const [m, list] of Object.entries(byMonth)) {
    const w = weights[m]; if (!w) continue;
    list.sort((a, b) => String(b.last_order_date || '').localeCompare(String(a.last_order_date || '')) || (b.delivered_orders || 0) - (a.delivered_orders || 0) || String(a.phone10).localeCompare(String(b.phone10)));
    list.forEach((l, i) => keyed.push({ l, k: (i + 0.5) / w, m }));
  }
  keyed.sort((a, b) => a.k - b.k || String(a.m).localeCompare(String(b.m)));
  return { phase, weights, list: keyed.map(x => x.l) };
}

// ---- what happens after a call. Returns the fields to store on the lead.
function afterCall(lead, disposition, now = new Date(), opts = {}, s = settings()) {
  const d = BY_KEY[disposition]; if (!d) throw new Error('Unknown disposition');
  const t = new Date(now), addH = (h) => new Date(t.getTime() + h * 3600e3);
  const attempts = (lead.attempts || 0) + 1, unreached = d.connected ? 0 : (lead.unreached || 0) + 1;
  const out = { status: disposition, attempts, unreached, last_call_at: t, closed: false, next_due_at: null };
  if (d.closes) { out.closed = true; return out; }
  if (d.followup) {
    if (d.needsTime) { const c = opts.callback_at ? new Date(opts.callback_at) : null; if (!c || isNaN(c)) throw new Error('Choose when to call back'); out.next_due_at = c; }
    else out.next_due_at = opts.callback_at && !isNaN(new Date(opts.callback_at)) ? new Date(opts.callback_at) : addH(s.followupHours[disposition]);
    return out;
  }
  // not reached: retry after the wait; too many tries without ever speaking: rest for a few days
  out.next_due_at = unreached >= s.maxUnreached ? new Date(t.getTime() + s.parkDays * 86400e3) : addH(s.retryHours[disposition]);
  return out;
}

// ---- what Aman sees. leads: every open (not closed) lead { id, status, next_due_at, attempts, acq_month, last_order_date, delivered_orders, phone10 }.
// filter: ready | callbacks | fresh | retry | notdue | all
function classify(l, now) {
  const due = l.next_due_at ? new Date(l.next_due_at) <= new Date(now) : false;
  if ((l.attempts || 0) === 0 && !l.next_due_at) return 'fresh';
  const d = BY_KEY[l.status] || {};
  if (d.followup) return due ? 'followup_due' : 'followup_later';
  return due ? 'retry_due' : 'retry_later';
}
// ctx.freshUsedToday = fresh customers Aman has already made a first call to today (India date). Only s.dailyFresh minus that many fresh leads are shown today: they are the top of the month mix, so the mix holds day after day.
function buildQueue(leads, now = new Date(), s = settings(), ctx = {}) {
  const groups = { followup_due: [], followup_later: [], retry_due: [], retry_later: [], fresh: [] };
  for (const l of leads) groups[classify(l, now)].push(l);
  const freshAll = groups.fresh.length;
  groups.followup_due.sort((a, b) => ((FOLLOWUP_RANK[a.status] ?? 9) - (FOLLOWUP_RANK[b.status] ?? 9)) || new Date(a.next_due_at) - new Date(b.next_due_at));
  groups.retry_due.sort((a, b) => new Date(a.next_due_at) - new Date(b.next_due_at));
  const later = (a, b) => new Date(a.next_due_at) - new Date(b.next_due_at);
  groups.followup_later.sort(later); groups.retry_later.sort(later);
  const ordered = orderFresh(groups.fresh), released = Math.max(0, s.dailyFresh - (ctx.freshUsedToday || 0));
  const fresh = { ...ordered, list: ordered.list.slice(0, released) };      // today's share only; the rest wait for tomorrow
  const dueFirst = groups.followup_due.concat(groups.retry_due);
  const ready = dueFirst.length ? dueFirst : fresh.list;            // fresh leads only when nothing is due: no lead wastage
  const tag = (arr, why) => arr.map(l => ({ ...l, why }));
  const views = {
    ready: dueFirst.length ? tag(groups.followup_due, 'followup').concat(tag(groups.retry_due, 'retry')) : tag(fresh.list, 'fresh'),
    callbacks: tag(groups.followup_due, 'followup'),
    fresh: tag(fresh.list, 'fresh'),
    retry: tag(groups.retry_due, 'retry'),
    notdue: tag(groups.followup_later, 'followup_later').concat(tag(groups.retry_later, 'retry_later')),
  };
  views.all = views.callbacks.concat(views.retry, views.notdue, views.fresh);
  const counts = { ready: ready.length, callbacks: groups.followup_due.length, fresh: fresh.list.length, retry: groups.retry_due.length, notdue: groups.followup_later.length + groups.retry_later.length, all: views.all.length };
  return { views, counts, mix: { phase: fresh.phase, weights: fresh.weights }, blocked_fresh: dueFirst.length > 0 ? fresh.list.length : 0,
    daily: { limit: s.dailyFresh, used_today: ctx.freshUsedToday || 0, released_now: fresh.list.length, waiting_for_later_days: Math.max(0, freshAll - fresh.list.length), fresh_total: freshAll } };
}

module.exports = { DISPOSITIONS, BY_KEY, settings, monthKey, tenDigits, mixFor, orderFresh, afterCall, classify, buildQueue };
