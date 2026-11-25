// IVR plan (stage 1: the rules and the list, no calls are placed). Decides which leads the IVR may call tonight / tomorrow morning.
// One owner per lead: the call centre, Aman, or the IVR. The IVR only takes a lead that no person is working on.
// Pure functions, no database (the database side is lib/ivrDb.js).
const { istHour } = require('./balance');

const num = (v, d) => { const x = String(v == null ? '' : v).trim().replace(/^["']+|["']+$/g, '').trim(); return x !== '' && !isNaN(Number(x)) ? Number(x) : d; };

// Fixed IVR windows (India time), for NEW orders: 7 AM to 9 AM (orders placed overnight, called as soon as the window opens) and 6 PM to 10 PM (orders the callers did not reach in the day, and new ones).
// Owner rule 2026-11-23. From 9 AM to 6 PM Aman and the call centre work the new orders, so the IVR does not. In the day the IVR works only no-answer (DNP) leads in the hours when customers pick up best:
// one call per lead per day, up to 5 days (IVR_MAX_TRIES). Change a window in Railway with IVR_MORNING_START / IVR_MORNING_END / IVR_EVENING_START / IVR_EVENING_END (a window whose end is not after its start is off).
// A value typed into Railway may carry spaces, quotes or capital letters (" on ", "On"): all of those are read as on.
const plain = (v) => String(v == null ? '' : v).trim().replace(/^["']+|["']+$/g, '').trim();
function settings(env = process.env) {
  const raw = plain(env.IVR_MODE || 'off').toLowerCase(), mode = ['true', '1', 'yes', 'enabled', 'enable'].includes(raw) ? 'on' : raw;
  return {
    mode: ['off', 'dry', 'on'].includes(mode) ? mode : 'off',
    windows: [{ start: num(env.IVR_MORNING_START, 7), end: num(env.IVR_MORNING_END, 9) }, { start: num(env.IVR_EVENING_START, 18), end: num(env.IVR_EVENING_END, 22) }].filter(w => w.end > w.start),   // a window whose end is not after its start is off
    maxTries: num(env.IVR_MAX_TRIES, 5),                 // IVR attempts per lead in total: one a day for up to 5 days
    smart: plain(env.IVR_SMART || 'on').toLowerCase() !== 'off',   // in the day (outside the fixed windows) the IVR works only no-answer leads, in the hours when customers pick up best
    triesPerDay: num(env.IVR_TRIES_PER_DAY, 1),          // IVR attempts per lead per day: one by default, so the budget is not spent calling the same customer again and again
    gapMinutes: num(env.IVR_GAP_MINUTES, 90),            // least time between two IVR attempts on one lead
    // Owner 2026-11-25 (goal: every day's orders 95 percent confirmed): an order placed in the last IVR_NEW_DAYS days that is still unconfirmed may get TWO IVR calls a day, at least IVR_NEW_GAP_MINUTES apart
    // (the best morning hour and the evening), because each try reaches about a third of the customers not yet reached. Older leads stay at IVR_TRIES_PER_DAY a day.
    triesPerDayNew: num(env.IVR_TRIES_PER_DAY_NEW, 2), newDays: num(env.IVR_NEW_DAYS, 3), newGapMinutes: num(env.IVR_NEW_GAP_MINUTES, 240),
    dailyCap: num(env.IVR_DAILY_CAP, 20),                // most IVR calls in one day (start small, raise it in Railway), so a bug cannot spend the whole balance
    perRun: num(env.IVR_MAX_PER_RUN, 10),                // most calls started in one minute
    lockMinutes: num(env.IVR_LOCK_MINUTES, 105),         // a called lead stays hidden from the people's queues this long (or until the customer presses a key)
    humanQuietMinutes: num(env.IVR_HUMAN_QUIET_MINUTES, 180), // a lead a person called in the last 3 hours is left to the person
    recentDays: num(env.IVR_RECENT_DAYS, 2),             // placed within this many days = "recent", older = "backlog"
    freshHours: num(env.IVR_FRESH_HOURS, 18),            // an order nobody has called, placed within this many hours, is "fresh" and is called first
    firstShare: num(env.IVR_FIRST_SHARE, 0),             // OFF by default: from 9 AM to 6 PM Aman and the call centre work every fresh lead, the IVR does not. Set it above 0 to let the IVR make first calls on older untouched leads in the day hours
    freshShare: num(env.IVR_FRESH_SHARE, 0.3),           // new orders may use at most this share of the daily cap, so they can never eat the budget meant for the best hours
    nonFreshShare: num(env.IVR_NON_FRESH_SHARE, 0.7),    // retries and old backlog may use at most this share of the daily cap, so new orders arriving later in the window always find room
    maxRisk: ['low', 'medium'].includes(String(env.IVR_MAX_RISK || 'low').toLowerCase()) ? String(env.IVR_MAX_RISK || 'low').toLowerCase() : 'low',   // the IVR only calls orders up to this risk level; riskier ones go to a person
  };
}

// Is the IVR allowed to call right now, and when does the next window open?
function windowStatus(now, s = settings()) {
  const h = istHour(now);
  const open = s.windows.find(w => h >= w.start && h < w.end);
  if (open) return { open: true, window: open, hoursLeft: open.end - h };
  const next = s.windows.map(w => w.start).sort((a, b) => a - b).find(st => st > h);
  return { open: false, window: null, nextStartHour: next !== undefined ? next : s.windows.map(w => w.start).sort((a, b) => a - b)[0], tomorrow: next === undefined };
}

const istDayStart = (now) => { const d = new Date(new Date(now).getTime() + 5.5 * 3600e3); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - 5.5 * 3600e3); };

// Why a lead is not for the IVR right now, or null when it can go. ivr = { tries, last_at } from the IVR log (none yet in stage 1).
function blockedReason(l, now, s, ivr) {
  if (l.spoke) return 'spoken_to';
  if (l.callback_at) return 'callback';
  if (l.last_call_at && (new Date(now) - new Date(l.last_call_at)) < s.humanQuietMinutes * 60000) return 'person_called_recently';
  if (ivr && ivr.skipped_recently) return 'left_to_person';             // looked risky, address or phone not good enough: a person calls it
  if (ivr && ivr.fails_recent >= 2) return 'left_to_person';            // the IVR service refused this order twice (usually its number): a person calls it
  if (ivr && ivr.answered) return 'ivr_answered';                       // the customer already pressed a key: a person follows up
  if (ivr && ivr.tries >= s.maxTries) return 'ivr_done';
  const isNew = !!l.placed_at && (new Date(now) - new Date(l.placed_at)) < s.newDays * 86400e3;                 // a recent order that is still not confirmed: it may get a second call a day
  const perDay = isNew ? Math.max(s.triesPerDay, s.triesPerDayNew) : s.triesPerDay, gap = isNew ? Math.max(s.gapMinutes, s.newGapMinutes) : s.gapMinutes;
  if (ivr && (ivr.tries_today || 0) >= perDay) return 'ivr_done_today';
  if (ivr && ivr.last_at && (new Date(now) - new Date(ivr.last_at)) < gap * 60000) return 'ivr_too_soon';
  if ((l.dnp_attempts || 0) >= 9 && (l.dnp_days || 0) >= 3) return 'over_the_limit';   // already on the stop-redialling list: a person decides
  return null;
}

// leads: from autopilotDb.loadLeads. ivrByLead: Map or object id -> { tries, last_at }.
// Groups: today (placed today), recent (1 to recentDays days ago), backlog (older). Kind: never (nobody called yet) or dnp (people tried, no answer).
function buildList({ now = new Date(), leads, ivrByLead = {} }, s = settings()) {
  const get = (id) => (ivrByLead instanceof Map ? ivrByLead.get(id) : ivrByLead[id]);
  const start = istDayStart(now).getTime(), day = 86400e3;
  const freshFrom = new Date(now).getTime() - s.freshHours * 3600e3;
  const groupOf = (l) => { const t = new Date(l.placed_at).getTime(); if (l.attempts === 0 && t >= freshFrom) return 'fresh'; return t >= start ? 'today' : (t >= start - s.recentDays * day ? 'recent' : 'backlog'); };
  const order = { fresh: 0, today: 1, recent: 2, backlog: 3 };
  const blocked = {}, counts = {};
  const ready = [];
  for (const l of leads) {
    const why = blockedReason(l, now, s, get(l.id));
    if (why) { blocked[why] = (blocked[why] || 0) + 1; continue; }
    const g = groupOf(l), kind = l.attempts === 0 ? 'never' : 'dnp';
    counts[g] = counts[g] || { never: 0, dnp: 0 }; counts[g][kind]++;
    ready.push({ id: l.id, group: g, kind, tries: (get(l.id) || {}).tries || 0, dnp: l.dnp_attempts || 0, placed_at: l.placed_at });
  }
  // Order of calling: FRESH orders first (not yet tried by the IVR first, then the one that has waited longest, so every new order is called in turn within minutes),
  // then orders placed today, recent ones, and the old backlog last. Inside the other groups: never called first, then the fewest unanswered tries, newest first.
  ready.sort((a, b) => (order[a.group] - order[b.group])
    || (a.group === 'fresh' ? ((a.tries - b.tries) || (new Date(a.placed_at) - new Date(b.placed_at)))
      : (((a.kind === 'never' ? 0 : 1) - (b.kind === 'never' ? 0 : 1)) || (a.tries - b.tries) || (a.dnp - b.dnp) || (new Date(b.placed_at) - new Date(a.placed_at)))));
  const list = ready.slice(0, s.dailyCap);
  const kindOf = (x) => (x.tries > 0 ? 'retry' : (x.group === 'fresh' ? 'fresh' : 'backlog'));
  const rows = ['fresh', 'today', 'recent', 'backlog'].filter(g => counts[g]).map(g => ({ group: g, never: counts[g].never, dnp: counts[g].dnp, total: counts[g].never + counts[g].dnp }));
  return { mode: s.mode, window: windowStatus(now, s), windows: s.windows, max_tries: s.maxTries, tries_per_day: s.triesPerDay, smart: s.smart, smart_from: s.smart ? 9 : null, smart_to: s.smart ? 21 : null, gap_minutes: s.gapMinutes, daily_cap: s.dailyCap,
    ready_total: ready.length, in_list: list.length, cut_by_cap: Math.max(0, ready.length - list.length), groups: rows, blocked, ids: list.map(x => x.id), groupById: Object.fromEntries(list.map(x => [x.id, x.group + '/' + x.kind])), kindById: Object.fromEntries(list.map(x => [x.id, kindOf(x)])),
    all_ids: ready.map(x => x.id), all_kind: Object.fromEntries(ready.map(x => [x.id, kindOf(x)])) };
}

// An address the IVR reads and the customer confirms must be one a courier can deliver to: a 6-digit pincode and a long enough address. Otherwise a person calls.
const { isShortAddress, fullAddressOf } = require('./address');
function addressProblem(o) {
  if (!/^\d{6}$/.test(String(o.shipping_zip || '').replace(/\s/g, ''))) return 'no_pincode';
  if (isShortAddress(fullAddressOf(o))) return 'short_address';
  return null;
}

module.exports = { plain, settings, windowStatus, blockedReason, buildList, istDayStart, addressProblem };
