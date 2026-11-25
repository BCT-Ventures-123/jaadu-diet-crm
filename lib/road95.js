// Road to 95% (owner 2026-11-25): EVERY DAY's orders must reach 95 percent confirmed. The owner first said 85 percent for the day itself, then corrected it: the goal is 95 for every day.
// A day's orders have MATURE_DAYS days to get there (the retry ladder: day 1 three WhatsApp messages and the callers, then the IVR and one WhatsApp message each morning). STAGES keeps one goal per order age so it can be changed in one place.
// This turns the order ledger (lib/ledger.js) into one row per order date and a list of the open orders that are still not reached. Pure functions, no database.
const TARGET = 95, MATURE_DAYS = 5, IST = 19800000;
const STAGES = [95, 95, 95, 95];                       // goal by order age in days: 0 (the day itself), 1, 2, 3 and later: 95 for all (owner 2026-11-25)
const goalFor = (ageDays) => STAGES[Math.min(Math.max(0, ageDays), STAGES.length - 1)];
const istDay = (d) => new Date(new Date(d).getTime() + IST).toISOString().slice(0, 10);
const dayStartMs = (day) => Date.parse(day + 'T00:00:00+05:30');
const pct = (a, b) => (b ? Math.round(1000 * a / b) / 10 : 0);
const CH = { aman: 'Aman', cc: 'Call centre', ivr: 'IVR', wa: 'WhatsApp' };

// ledger: rows from ledger.buildLedger (status, day, attempts, tries, last_try_by, last_try_at, age_hours, order, placed_at). now: Date.
function build(ledger, now = new Date(), { target = TARGET, matureDays = MATURE_DAYS, listMax = 40 } = {}) {
  const nowMs = new Date(now).getTime();
  const byDay = new Map();
  for (const o of ledger) { if (!byDay.has(o.day)) byDay.set(o.day, []); byDay.get(o.day).push(o); }
  const days = [...byDay.keys()].sort().map(day => {
    const list = byDay.get(day), orders = list.length;
    const confirmed = list.filter(o => o.status === 'confirmed').length, cancelled = list.filter(o => o.status === 'cancelled').length, open = orders - confirmed - cancelled;
    const ageDays = Math.max(0, Math.floor((nowMs - dayStartMs(day)) / 86400e3));
    const goal = Math.min(goalFor(ageDays), target), daysLeft = Math.max(0, matureDays - ageDays);
    const need = Math.max(0, Math.ceil(goal / 100 * orders) - confirmed), need95 = Math.max(0, Math.ceil(target / 100 * orders) - confirmed);
    const confirmedPct = pct(confirmed, orders);
    // on_target: at or above the goal for its age. behind: below it, still time. missed: its days are over and it is below 95.
    const state = confirmedPct >= goal ? 'on_target' : (daysLeft > 0 ? 'behind' : 'missed');
    return { day, orders, confirmed, cancelled, open, confirmed_pct: confirmedPct, cancelled_pct: pct(cancelled, orders), open_pct: pct(open, orders), age_days: ageDays, days_left: daysLeft, goal, need, need_95: need95, state };
  });
  // The open orders, longest waiting first: who tried, how often, and when the last try was.
  const openRows = ledger.filter(o => o.status === 'not_confirmed');
  const bucket = (n) => (n === 0 ? 'none' : n === 1 ? 'one' : n <= 3 ? 'two_three' : 'four_plus');
  const buckets = { none: 0, one: 0, two_three: 0, four_plus: 0 };
  openRows.forEach(o => { buckets[bucket(o.attempts)]++; });
  const list = openRows.slice().sort((a, b) => (b.age_hours - a.age_hours) || (a.attempts - b.attempts)).slice(0, listMax).map(o => ({
    order: o.order, day: o.day, waiting_hours: Math.round(o.age_hours), attempts: o.attempts, tries: o.tries,
    last_try_by: o.last_try_by ? CH[o.last_try_by] || o.last_try_by : null, last_try_hours_ago: o.last_try_at ? Math.round(Math.max(0, (nowMs - new Date(o.last_try_at).getTime()) / 3600e3) * 10) / 10 : null,
  }));
  const open = openRows.length, orders = ledger.length, confirmed = ledger.filter(o => o.status === 'confirmed').length;
  return { target, stages: STAGES, mature_days: matureDays, orders, confirmed, confirmed_pct: pct(confirmed, orders), open, days, stuck: { total: open, buckets, list } };
}

module.exports = { build, goalFor, TARGET, MATURE_DAYS, STAGES, istDay };
