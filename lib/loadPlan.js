// Daily call plan: how many calls today's open leads need, how many calls each team can make, how many tries a DNP lead gets today
// (3 at the least, up to 5 when there is bandwidth), how to move leads so neither team is overloaded, and which leads should stop
// being redialled (WhatsApp / IVR, then manual review). Pure functions, no database (the database side is lib/loadPlanDb.js).
//
// Calls are counted as EXPECTED calls: a fresh lead usually picks up on the first try, so it costs less than "tries" calls.
//   expected(tries, p) = 1 + (1-p) + (1-p)^2 ... for `tries` terms, where p is the chance that one call is picked up.
const cfg = require('./config');
const ap = require('./autopilot');
const { istHour } = require('./balance');

const num = (v, d) => (v !== undefined && v !== '' && !isNaN(Number(v)) ? Number(v) : d);
const TEAM_LABEL = { cc: 'Call centre', aman: 'Aman' };
const KEY = { CC: 'cc', InHouse: 'aman' };          // lead.team -> plan key
const DB = { cc: 'CC', aman: 'InHouse' };            // plan key -> lead.team

function settings(env = process.env) {
  const a = ap.settings(env);
  return {
    minTries: cfg.DNP_MIN_DAILY_ATTEMPTS, maxTries: cfg.DNP_MAX_DAILY_ATTEMPTS,
    startHour: a.startHour, endHour: a.endHour,
    defaultRate: num(env.LOADPLAN_AGENT_RATE, 15),          // calls one person makes in an hour, until the real rate is measured
    freshPickup: num(env.LOADPLAN_FRESH_PICKUP, 0.55),      // chance a first call is picked up, until measured
    retryPickup: num(env.LOADPLAN_RETRY_PICKUP, 0.25),      // chance a retry is picked up, until measured
    giveUpTries: num(env.LOADPLAN_GIVEUP_TRIES, 9),         // this many unanswered tries ...
    giveUpDays: num(env.LOADPLAN_GIVEUP_DAYS, 3),           // ... over at least this many days: stop redialling, WhatsApp / IVR, then manual review
    balanceMin: num(env.LOADPLAN_BALANCE_MIN, 15),          // do not move leads for a shortfall smaller than this many calls
    batch: num(env.LOADPLAN_BATCH, 60),                     // most leads moved in one go
  };
}

const expected = (tries, p) => { let t = 0, f = 1; for (let i = 0; i < tries; i++) { t += f; f *= (1 - p); } return t; };
const round1 = (n) => Math.round(n * 10) / 10;

function hoursLeft(now, s) {
  const h = istHour(now);
  if (h >= s.endHour) return 0;
  return Math.max(0, s.endHour - Math.max(h, s.startHour));
}

// Stop redialling: many unanswered tries over several days, and the customer never spoke to us.
const isReview = (l, s) => !l.spoke && l.dnp_attempts >= s.giveUpTries && l.dnp_days >= s.giveUpDays;
const callbackWaiting = (l, now) => l.callback_at && new Date(l.callback_at) > new Date(now);
const callbackDue = (l, now) => l.callback_at && new Date(l.callback_at) <= new Date(now);

// Expected calls still needed today for one lead if the goal is `level` tries today.
function leadDemand(l, level, now, s, pick) {
  if (isReview(l, s) || callbackWaiting(l, now)) return 0;
  if (callbackDue(l, now)) return 1;
  if (l.spoke) return 0;
  const left = Math.max(0, level - (l.today_attempts || 0));
  return expected(left, l.attempts === 0 ? pick.fresh : pick.retry);
}

// agents: [{ team: 'cc' | 'aman', last_seen_at, last_call_at }]. Someone who was in the CRM or made a call in the last day counts as "on the team".
function expectedAgents(agents, now) {
  const out = { cc: 0, aman: 0 };
  for (const a of agents || []) {
    if (!out.hasOwnProperty(a.team)) continue;
    const recent = (t) => t && (new Date(now) - new Date(t)) <= 24 * 3600e3;
    if (recent(a.last_seen_at) || recent(a.last_call_at)) out[a.team]++;
  }
  return out;
}

// leads: from autopilotDb.loadLeads (team 'CC'|'InHouse', attempts, today_attempts, dnp_attempts, dnp_days, spoke, callback_at, placed_at)
// rates: { cc: { perHour, source }, aman: {...}, pickup: { cc: { fresh, retry }, aman: {...} } }  (all optional)
function buildPlan({ now = new Date(), leads, agents, rates = {} }, s = settings()) {
  const left = hoursLeft(now, s);
  const onTeam = expectedAgents(agents, now);
  const active = ap.teamPresence(agents || [], now, ap.settings());
  const teams = {};
  for (const k of ['cc', 'aman']) {
    const mine = leads.filter(l => KEY[l.team] === k);
    const pick = { fresh: (rates.pickup && rates.pickup[k] && rates.pickup[k].fresh) || s.freshPickup, retry: (rates.pickup && rates.pickup[k] && rates.pickup[k].retry) || s.retryPickup };
    const perHour = (rates[k] && rates[k].perHour) || s.defaultRate;
    const demand = {}; for (let L = s.minTries; L <= s.maxTries; L++) demand[L] = Math.ceil(mine.reduce((t, l) => t + leadDemand(l, L, now, s, pick), 0));
    const capacity = Math.floor(onTeam[k] * perHour * left);
    let target = s.minTries; for (let L = s.minTries; L <= s.maxTries; L++) if (demand[L] <= capacity) target = L;
    const needed = demand[target], deficit = Math.max(0, demand[s.minTries] - capacity), spare = Math.max(0, capacity - demand[target]);
    const never = mine.filter(l => l.attempts === 0 && !l.spoke && !callbackWaiting(l, now)).length;
    const dnpOpen = mine.filter(l => l.attempts > 0 && !l.spoke && !isReview(l, s) && !callbackWaiting(l, now)).length;
    const cbDue = mine.filter(l => callbackDue(l, now)).length;
    const review = mine.filter(l => isReview(l, s)).length;
    const perCallHour = perHour * Math.max(left, 0.01);
    teams[k] = {
      team: k, label: TEAM_LABEL[k], leads: mine.length, never_called: never, dnp_open: dnpOpen, callbacks_due: cbDue, review,
      agents_on_team: onTeam[k], agents_active_now: active[k] ? active[k].active : 0, calls_per_hour: round1(perHour), rate_source: (rates[k] && rates[k].source) || 'default',
      capacity, demand, tries_today: target, calls_needed: needed, deficit, spare,
      agents_needed: left > 0 ? Math.ceil(demand[s.minTries] / perCallHour) : null,
      first_calls_covered: never <= capacity,
      status: deficit > 0 ? 'bad' : (target === s.minTries && demand[s.minTries] > capacity * 0.85 ? 'warn' : 'ok'),
    };
  }
  const moves = balanceMoves({ now, leads, teams, rates, onTeam }, s);
  for (const k of ['cc', 'aman']) teams[k].advice = adviceFor(teams[k], teams[k === 'cc' ? 'aman' : 'cc'], moves, left, s);
  return { generated_at: new Date(now).toISOString(), hours_left: round1(left), shift: { start: s.startHour, end: s.endHour }, teams, moves, backlog: backlog(leads, now, s), review: leads.filter(l => isReview(l, s)).map(l => l.id), settings: { min_tries: s.minTries, max_tries: s.maxTries, give_up_tries: s.giveUpTries, give_up_days: s.giveUpDays } };
}

function adviceFor(t, other, moves, left, s) {
  if (left <= 0) return 'The shift is over. Tomorrow the plan starts again from the morning list.';
  if (t.agents_on_team === 0) return t.leads ? `Nobody from ${t.label} has logged in today. ${t.leads} leads are waiting.` : 'No leads and nobody logged in.';
  const out = moves.filter(m => KEY[m.from] === t.team).length, inn = moves.filter(m => KEY[m.to] === t.team).length;
  if (t.deficit > 0) return `Short by about ${t.deficit} calls even at ${s.minTries} tries per lead.` + (out ? ` Moving ${out} leads to ${other.label} fixes part of it.` : ` ${other.label} has no spare time either: about ${t.agents_needed} people are needed for the rest of today, ${t.agents_on_team} on the team.`);
  if (inn) return `Has room: ${inn} leads can come over from ${other.label}.`;
  if (t.tries_today > s.minTries) return `Enough time for ${t.tries_today} tries per lead today.`;
  return `On track for ${s.minTries} tries per lead today.`;
}

// Moves from the team that cannot finish today to the team that has time to spare. Fresh leads first (oldest first), then the leads with the fewest tries today.
function balanceMoves({ now, leads, teams, rates = {}, onTeam }, s) {
  if (hoursLeft(now, s) <= 0) return [];
  const moves = [];
  for (const from of ['cc', 'aman']) {
    const to = from === 'cc' ? 'aman' : 'cc', A = teams[from], B = teams[to];
    if (!B.agents_on_team || A.deficit < s.balanceMin) continue;
    let room = B.capacity - B.demand[s.minTries];
    if (room < s.balanceMin) continue;
    let gap = Math.min(A.deficit, room);
    const pick = { fresh: (rates.pickup && rates.pickup[from] && rates.pickup[from].fresh) || s.freshPickup, retry: (rates.pickup && rates.pickup[from] && rates.pickup[from].retry) || s.retryPickup };
    const movable = leads.filter(l => KEY[l.team] === from && !callbackWaiting(l, now) && !isReview(l, s) && !l.spoke && !(l.today_attempts > 0))   // a lead a person has already worked today stays with that person's team
      .sort((a, b) => ((a.attempts === 0 ? 0 : 1) - (b.attempts === 0 ? 0 : 1)) || ((a.today_attempts || 0) - (b.today_attempts || 0)) || (new Date(a.placed_at) - new Date(b.placed_at)));
    for (const l of movable) {
      if (gap <= 0 || moves.length >= s.batch) break;
      const c = leadDemand(l, s.minTries, now, s, pick); if (c <= 0) continue;
      moves.push({ id: l.id, from: DB[from], to: DB[to], reason: 'load_balance' }); gap -= c;
    }
  }
  return moves;
}

// ---- Split the old backlog by hand: the admin says how many leads go to each team. ----
const istDayStart = (now) => { const d = new Date(new Date(now).getTime() + 5.5 * 3600e3); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - 5.5 * 3600e3); };
const SPLIT_MAX = 500;

// Old leads (placed before today) that can still be called and moved: not spoken to, no callback promised, not over the stop-redialling limit.
function splitPool(leads, now, s = settings()) {
  const start = istDayStart(now).getTime();
  const pool = leads.filter(l => !l.spoke && !l.callback_at && !isReview(l, s) && !(l.today_attempts > 0) && new Date(l.placed_at).getTime() < start);   // not a lead a person has worked today
  return { cc: pool.filter(l => KEY[l.team] === 'cc'), aman: pool.filter(l => KEY[l.team] === 'aman') };
}

// toAman = leads to take from the call centre, toCc = leads to take from Aman. Never called first, then the fewest unanswered tries, then the longest waiting.
function splitMoves({ now = new Date(), leads, toAman = 0, toCc = 0 }, s = settings()) {
  const pool = splitPool(leads, now, s), cut = (v) => Math.max(0, Math.min(SPLIT_MAX, Math.floor(Number(v) || 0)));
  const order = (a, b) => ((a.attempts === 0 ? 0 : 1) - (b.attempts === 0 ? 0 : 1)) || (a.dnp_attempts - b.dnp_attempts) || (new Date(a.placed_at) - new Date(b.placed_at));
  const take = (from, n) => pool[from].slice().sort(order).slice(0, cut(n)).map(l => ({ id: l.id, from: DB[from], to: DB[from === 'cc' ? 'aman' : 'cc'], reason: 'split_backlog' }));
  const moves = take('cc', toAman).concat(take('aman', toCc));
  return { moves, available: { cc: pool.cc.length, aman: pool.aman.length }, cc_to_aman: moves.filter(m => m.from === 'CC').length, aman_to_cc: moves.filter(m => m.from === 'InHouse').length };
}

// Where the open leads stand: how many tries they have had so far.
function backlog(leads, now, s) {
  const bucket = (l) => l.attempts === 0 ? 'never' : (isReview(l, s) ? 'review' : l.dnp_attempts <= 2 ? 'b12' : l.dnp_attempts <= 5 ? 'b35' : l.dnp_attempts <= 8 ? 'b68' : 'b9');
  const rows = [['never', 'Never called'], ['b12', '1–2 unanswered tries'], ['b35', '3–5 unanswered tries'], ['b68', '6–8 unanswered tries'], ['b9', '9 or more tries, not yet over the limit'], ['review', 'Over the limit: WhatsApp / IVR, then manual review']];
  const out = rows.map(([key, label]) => ({ key, label, cc: 0, aman: 0 }));
  for (const l of leads) { if (l.spoke) continue; const r = out.find(x => x.key === bucket(l)); const k = KEY[l.team]; if (r && k) r[k]++; }
  return out.filter(r => r.cc || r.aman);
}

module.exports = { settings, expected, hoursLeft, leadDemand, expectedAgents, buildPlan, balanceMoves, backlog, isReview, splitPool, splitMoves, SPLIT_MAX };
