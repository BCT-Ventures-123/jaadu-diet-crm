// Autopilot: who is working, who should get new leads, when to hand leads to the other team, and the 2 PM first-call target.
// Pure functions, no database (the database part is lib/autopilotDb.js, the scheduled job is in cron_jobs.js).
//   AUTOPILOT = off | dry | on   (default dry: it plans and records what it WOULD do, but moves nothing)
// The 2 PM target: every order placed before the cut-off hour (default 13:00) has had a first call by the deadline hour (default 14:00),
// which is the same-day dispatch cut-off.
const { istHour } = require('./balance');

const num = (v, d) => (v !== undefined && v !== '' && !isNaN(Number(v)) ? Number(v) : d);

function settings(env = process.env) {
  const raw = String(env.AUTOPILOT || 'dry').toLowerCase();
  return {
    mode: ['off', 'dry', 'on'].includes(raw) ? raw : 'dry',
    startHour: num(env.AUTOPILOT_START_HOUR, 9),             // shift opens (IST, decimal hours)
    endHour: num(env.AUTOPILOT_END_HOUR, 20),                // shift closes
    graceMinutes: num(env.AUTOPILOT_GRACE_MINUTES, 30),      // a team is only called absent this long after the shift opens
    presenceMinutes: num(env.AUTOPILOT_PRESENCE_MINUTES, 5), // "I'm here" signal counts for this long
    callMinutes: num(env.AUTOPILOT_CALL_MINUTES, 15),        // a call logged this recently also counts as present
    failAttempts: num(env.AUTOPILOT_FAIL_ATTEMPTS, 4),       // call centre failed: this many unanswered attempts ...
    failDays: num(env.AUTOPILOT_FAIL_DAYS, 2),               // ... on at least this many different days
    failHours: num(env.AUTOPILOT_FAIL_HOURS, 48),            // or still not reached this long after the order (with at least one try)
    overflowHours: num(env.AUTOPILOT_OVERFLOW_HOURS, 24),    // never called for this long: hand over
    deadlineHour: num(env.AUTOPILOT_DEADLINE_HOUR, 14),
    cutoffHour: num(env.AUTOPILOT_CUTOFF_HOUR, 13),
    paceStartHour: num(env.AUTOPILOT_PACE_START_HOUR, 11),   // start pushing from here
    firstCallsPerAgentHour: num(env.AUTOPILOT_AGENT_RATE, 12),
    batch: num(env.AUTOPILOT_BATCH, 30),                     // most leads moved per run
    amanNewShare: num(env.AMAN_NEW_COD_SHARE, 30),           // % of new COD orders that go straight to Aman. 30 matches his measured speed (about 14 calls an hour against 36 for the call centre), so both finish together. Set it in Railway to change it.
    targetConnectivity: 95,
  };
}

const IST_OFFSET = '+05:30';
const dateKey = (now) => new Date(now).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const atHour = (now, hour) => new Date(new Date(`${dateKey(now)}T00:00:00${IST_OFFSET}`).getTime() + hour * 3600e3);
const shiftOpen = (now, s) => { const h = istHour(now); return h >= s.startHour && h < s.endHour; };
const pastGrace = (now, s) => istHour(now) >= s.startHour + s.graceMinutes / 60;
const hoursSince = (t, now) => (new Date(now) - new Date(t)) / 3600e3;

// agents: [{ team: 'cc' | 'aman', last_seen_at, last_call_at }]
function teamPresence(agents, now, s) {
  const out = { cc: { active: 0, total: 0 }, aman: { active: 0, total: 0 } };
  for (const a of agents) {
    const t = out[a.team]; if (!t) continue;
    t.total++;
    const seen = a.last_seen_at && (new Date(now) - new Date(a.last_seen_at)) <= s.presenceMinutes * 60000;
    const called = a.last_call_at && (new Date(now) - new Date(a.last_call_at)) <= s.callMinutes * 60000;
    if (seen || called) t.active++;
  }
  return out;
}

// Who gets a brand-new order. base = the configured split; if that team is absent (after the grace period) and the other is working, the other team gets it.
function ownerFor(presence, now, s, pct) {
  const base = pct <= s.amanNewShare ? 'InHouse' : 'CC';
  if (shiftOpen(now, s) && pastGrace(now, s)) {
    if (base === 'CC' && presence.cc.active === 0 && presence.aman.active > 0) return { assigned_to: 'InHouse', reason: 'Call centre not logged in, Aman covers' };
    if (base === 'InHouse' && presence.aman.active === 0 && presence.cc.active > 0) return { assigned_to: 'CC', reason: 'Aman not logged in, call centre covers' };
  }
  return { assigned_to: base };
}

// First-call pace towards the deadline for one team. leads: open leads of that team; rate: first calls made by that team in the last hour.
function pace(team, leads, presence, rate, now, s) {
  const h = istHour(now), cutoff = atHour(now, s.cutoffHour);
  const mine = leads.filter(l => l.team === team && l.attempts === 0 && new Date(l.placed_at) < cutoff);
  const active = presence[team === 'CC' ? 'cc' : 'aman'].active;
  const phase = h < s.paceStartHour ? 'before' : h >= s.deadlineHour ? 'after' : 'active';
  const hoursLeft = Math.max(0, s.deadlineHour - h);
  const perHour = rate > 0 ? Math.max(rate, active * s.firstCallsPerAgentHour * 0.5) : active * s.firstCallsPerAgentHour;
  const capacity = Math.floor(perHour * hoursLeft);
  const uncalled = mine.length;
  const deficit = phase === 'active' ? Math.max(0, uncalled - capacity) : 0;
  return { team, phase, uncalled, hours_left: Math.round(hoursLeft * 10) / 10, needed_per_hour: hoursLeft > 0 ? Math.ceil(uncalled / hoursLeft) : uncalled, rate_per_hour: rate || 0, capacity, deficit, behind: deficit > 0, active_agents: active };
}

// leads: [{ id, team: 'CC'|'InHouse', placed_at, attempts, dnp_attempts, dnp_days, spoke, callback_at }]
function planMoves({ now, presence, leads, rates = {} }, s) {
  if (!shiftOpen(now, s) || !pastGrace(now, s)) return [];
  const ccOn = presence.cc.active > 0, amOn = presence.aman.active > 0;
  const moves = [], taken = new Set();
  const add = (l, to, reason) => { if (taken.has(l.id) || moves.length >= s.batch) return; taken.add(l.id); moves.push({ id: l.id, from: l.team, to, reason }); };
  const oldest = leads.slice().sort((a, b) => new Date(a.placed_at) - new Date(b.placed_at));

  // 1. A team that is absent: the working team covers its open leads.
  for (const l of oldest) {
    if (l.team === 'CC' && !ccOn && amOn) add(l, 'InHouse', 'cover_absent');
    else if (l.team === 'InHouse' && !amOn && ccOn) add(l, 'CC', 'cover_absent');
  }
  if (ccOn && amOn) {
    const customerWaiting = (l) => l.callback_at && new Date(l.callback_at) > now;
    // 2. The call centre tried and failed: hand over to Aman.
    for (const l of oldest) {
      if (l.team !== 'CC' || l.spoke || customerWaiting(l)) continue;
      const failedTries = l.dnp_attempts >= s.failAttempts && l.dnp_days >= s.failDays;
      const failedLong = l.attempts >= 1 && hoursSince(l.placed_at, now) >= s.failHours;
      if (failedTries || failedLong) add(l, 'InHouse', 'cc_failed');
    }
    // 3. Never called for too long: hand over.
    for (const l of oldest) if (l.team === 'CC' && l.attempts === 0 && hoursSince(l.placed_at, now) >= s.overflowHours) add(l, 'InHouse', 'overflow_uncalled');
    // 4. The 2 PM target is out of reach for the call centre: hand over the oldest uncalled leads.
    const p = pace('CC', leads, presence, rates.cc || 0, now, s);
    if (p.behind) {
      const cutoff = atHour(now, s.cutoffHour);
      let need = p.deficit;
      for (const l of oldest) { if (need <= 0) break; if (l.team === 'CC' && l.attempts === 0 && new Date(l.placed_at) < cutoff && !taken.has(l.id)) { add(l, 'InHouse', 'deadline_overflow'); need--; } }
    }
  }
  return moves;
}

module.exports = { settings, teamPresence, ownerFor, pace, planMoves, shiftOpen, pastGrace, atHour };
