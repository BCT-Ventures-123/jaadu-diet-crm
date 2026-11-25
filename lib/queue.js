// Smart work queue: decides which lead an agent should call next, and why. Pure functions, no database.
// Order of work (highest first):
//   1. callback_due    a customer was promised a call and it is due now (most overdue first)
//      handed_over     the other team failed or was absent and the autopilot gave this lead to you (right after due callbacks)
//   2. fresh_overdue   placed over 24 h ago and never called (oldest first)
//   3. fresh_new       placed under 1 h ago and never called (newest first: the customer is still expecting it)
//   4. fresh           placed 1 to 24 h ago and never called (oldest first)
//   FRESH FIRST (owner, 2026-11-22): every lead with zero attempts, in every age band, ranks above every retry, for both Aman and the call centre, so the fresh leads are finished first.
//   5. retry_due       then the not-connected leads: called before, nobody picked up, last try 3 h or more ago and fewer than the minimum tries today (second tries first)
//   6. retry           other retries: called before, nobody picked up, the 90-minute gap has passed (extra tries up to the daily maximum)
//   not ready: wait    called a little while ago, next attempt is not due yet
//              capped  daily limit of attempts reached, try tomorrow
//              to_ivr  the callers have used all their tries (CALLER_MAX_TRIES, default 4) on this lead: the IVR takes it (one call a day in the best hours, up to 5 days)
// Inside a tier a higher order value breaks ties (small bonus, never enough to jump a tier).
const cfg = require('./config');
const { callbackBadge } = require('./callback');

const IST = 19800000, istHourOf = (d) => new Date(new Date(d).getTime() + IST).getUTCHours(), istDayOf = (d) => new Date(new Date(d).getTime() + IST).toISOString().slice(0, 10);
// Owner rule: an order confirmed before 2 PM ships the same day. So before 2 PM, once the fresh leads are done, a not-connected lead placed TODAY (before 1 PM) comes ahead of an older one:
// confirming it now ships it today. Small enough never to lift a retry above a fresh lead.
const sameDayBonus = (placed, now) => (istDayOf(placed) === istDayOf(now) && istHourOf(placed) < 13 && istHourOf(now) < 14 ? 35 : 0);
const mins = (a, b) => Math.max(0, Math.floor((b - a) / 60000));
const span = (m) => (m < 120 ? `${Math.round(m)} min` : `${Math.round(m / 60)} h`);
const TIER_ORDER = ['callback_due', 'handed_over', 'fresh_overdue', 'fresh_new', 'fresh', 'retry_due', 'retry', 'wait', 'capped', 'to_ivr'];

function prioritise(lead, dnp, now = new Date(), rules = cfg) {
  const d = dnp || {};
  const attempts = d.totalAttempts || 0;
  const placed = new Date(lead.shopify_created_at || lead.created_at);
  const age = lead.age_minutes != null && !isNaN(Number(lead.age_minutes)) ? Number(lead.age_minutes) : (isNaN(placed) ? 0 : mins(placed, now));
  const bonus = Math.min((Number(lead.total_price) || 0) / 100, 15);
  const out = (tier, ready, score, label, reason, wait = null) => ({ tier, ready, score: Math.round(score * 10) / 10, label, reason, wait_minutes: wait });
  // Warm lead (owner 2026-11-25): the customer READ our WhatsApp message and tapped nothing. Someone who looked at the order is the most likely to confirm on a call, so inside the same tier these come first.
  // The bonus is small: it orders leads inside a tier and never lifts a lead into a higher tier.
  const warm = lead.wa_warm === true, warmNote = warm ? ' Warm: the customer read the WhatsApp message.' : '';

  if (d.atMax) return out('capped', false, 0, 'Done for today', `Daily limit of ${rules.DNP_MAX_DAILY_ATTEMPTS} attempts reached. Try tomorrow.`);

  const HANDOVER = { cc_failed: 'Handed over: the call centre could not reach this customer.', overflow_uncalled: 'Handed over: nobody called this order for over 24 hours.',
    deadline_overflow: 'Handed over to protect the 2 PM target.', cover_absent: 'Covering: the other team is not logged in.', load_balance: 'Moved to even out the workload between the teams.' };
  const isCallback = callbackBadge(lead, now) === 'due';
  // A manual backlog split must not push today's new orders down the queue, so those leads rank like any other lead.
  if (!isCallback && lead.handover_reason && lead.handover_reason !== 'split_backlog' && !d.tooSoon) {
    return out('handed_over', true, 1200 + bonus, 'Handed over', HANDOVER[lead.handover_reason] || 'Handed over from the other team.');
  }
  if (isCallback) {
    const over = lead.callback_at ? mins(new Date(lead.callback_at), now) : 0;
    return out('callback_due', true, 1300 + Math.min(over / 10, 60) + bonus, 'Callback due', over ? `Customer was promised a call ${span(over)} ago.` : 'Customer was promised a call now.');
  }
  // The callers have tried enough: the IVR works this lead now. A promised callback or a hand-over above still comes first.
  if (attempts >= (rules.CALLER_MAX_TRIES || 4)) return out('to_ivr', false, 0, 'Left to the IVR', `Callers have made ${attempts} tries. The IVR calls this lead now: one call a day in the best hours.`);
  if (attempts === 0) {
    if (age >= 1440) return out('fresh_overdue', true, 1100 + Math.min((age - 1440) / 60, 60) + bonus, 'Fresh, overdue', `Placed ${span(age)} ago and never called (over 24 h).`);
    if (age < 60) return out('fresh_new', true, 1000 + (60 - age) / 2 + bonus, 'Fresh, new', `Placed ${Math.round(age)} min ago. Call while the customer is expecting it.`);
    return out('fresh', true, 900 + Math.min(age / 60, 23) + bonus + (warm ? 20 : 0), 'Fresh', `Placed ${span(age)} ago, not called yet.${warmNote}`);
  }
  if (d.tooSoon) {
    const wait = Math.max(1, rules.DNP_MIN_GAP_MINUTES - (d.minutesSinceLast || 0));
    return out('wait', false, 100 - Math.min(wait, 90) / 10, 'Not yet due', `Attempt ${attempts + 1} in about ${wait} min (last try ${d.minutesSinceLast} min ago).`, wait);
  }
  // The second and third tries: without this, every retry ranks below every fresh lead and starves whenever many new orders come in.
  const waitedFor = d.minutesSinceLast || 0, priorityAfter = rules.DNP_RETRY_PRIORITY_MINUTES || 180;
  const sd = sameDayBonus(placed, now), sdNote = sd ? ' Placed today: confirm before 2 PM and it ships today.' : '';
  if (d.belowTarget && waitedFor >= priorityAfter) {
    return out('retry_due', true, 740 + (attempts === 1 ? 25 : attempts === 2 ? 15 : 5) + Math.min((waitedFor - priorityAfter) / 60, 10) + bonus + sd + (warm ? 40 : 0), 'Retry due',
      `Attempt ${attempts + 1}: last try was ${span(waitedFor)} ago, ${d.todayCount || 0} of ${rules.DNP_MIN_DAILY_ATTEMPTS} tries today.${sdNote}${warmNote}`);
  }
  const more = d.belowTarget ? `, needs ${d.neededToday} more` : '';
  return out('retry', true, 500 + (d.belowTarget ? 40 : 0) + (attempts === 1 ? 30 : attempts === 2 ? 20 : 10) + bonus + sd + (warm ? 40 : 0), 'Retry due',
    `Attempt ${attempts + 1}: ${d.todayCount || 0} of ${rules.DNP_MIN_DAILY_ATTEMPTS}–${rules.DNP_MAX_DAILY_ATTEMPTS} tries today${more}.${sdNote}${warmNote}`);
}

// Ready leads first, best score first, then the older order.
function sortQueue(leads) {
  return leads.slice().sort((a, b) => (b.priority.ready - a.priority.ready) || (b.priority.score - a.priority.score)
    || (new Date(a.shopify_created_at || a.created_at) - new Date(b.shopify_created_at || b.created_at)));
}

function summarise(leads) {
  const c = { total: leads.length, ready: 0 };
  TIER_ORDER.forEach(t => { c[t] = 0; });
  leads.forEach(l => { c[l.priority.tier]++; if (l.priority.ready) c.ready++; });
  return c;
}

module.exports = { prioritise, sortQueue, summarise, TIER_ORDER };
