// Database side of the autopilot (rules are in lib/autopilot.js). Everything here is idempotent and safe to run on every start.
const cfg = require('./config');
const ap = require('./autopilot');

const TEST_NAME = `(LOWER(TRIM(COALESCE(o.customer_name,''))) IN ('test test','test','test order','dummy') OR COALESCE(o.customer_name,'') ~* '^\\s*test\\M')`;

async function ensureTables(db) {
  await db(`CREATE TABLE IF NOT EXISTS agent_presence (agent_id UUID PRIMARY KEY, last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db(`CREATE TABLE IF NOT EXISTS autopilot_runs (
    id BIGSERIAL PRIMARY KEY, ran_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), mode TEXT NOT NULL, presence JSONB, pace JSONB,
    planned INT NOT NULL DEFAULT 0, moved INT NOT NULL DEFAULT 0, reasons JSONB)`);
  await db(`CREATE INDEX IF NOT EXISTS idx_autopilot_runs_at ON autopilot_runs (ran_at DESC)`);
}

// The page sends this every minute while an agent has the CRM open.
async function heartbeat(db, agentId) {
  await db(`INSERT INTO agent_presence (agent_id, last_seen_at) VALUES ($1, NOW()) ON CONFLICT (agent_id) DO UPDATE SET last_seen_at = NOW()`, [agentId]);
}

async function loadAgents(db) {
  return db(
    `SELECT a.id, a.display_name, CASE WHEN a.role = 'agent' THEN 'cc' WHEN a.role = 'aman' THEN 'aman' END AS team, p.last_seen_at,
            (SELECT MAX(g.created_at) FROM lead_call_log g WHERE g.agent_id = a.id AND g.created_at > NOW() - INTERVAL '1 day') AS last_call_at
     FROM agents a LEFT JOIN agent_presence p ON p.agent_id = a.id
     WHERE a.is_active = TRUE AND a.role IN ('agent', 'aman')`);
}

async function presenceNow(db, now = new Date(), s = ap.settings()) {
  const agents = await loadAgents(db);
  return { presence: ap.teamPresence(agents, now, s), agents };
}

// Open COD leads either team could work: pending, new, not a duplicate, not do-not-call, not being worked on right now, placed since calling began.
async function loadLeads(db, { days = 10, limit = 3000, includeIvrLocked = false } = {}) {
  const since = new Date(Math.max(new Date(cfg.CALLING_STARTED_ON + 'T00:00:00+05:30').getTime(), Date.now() - days * 864e5));
  return db(
    `SELECT o.id, o.assigned_to AS team, COALESCE(o.shopify_created_at, o.created_at) AS placed_at, o.callback_at,
            COALESCE(c.n, 0) AS attempts, COALESCE(c.dnp, 0) AS dnp_attempts, COALESCE(c.days, 0) AS dnp_days, COALESCE(c.spoke, FALSE) AS spoke,
            COALESCE(c.today, 0) AS today_attempts, c.last_at AS last_call_at
     FROM orders_master o
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE g.disposition = 'dnp')::int AS dnp,
              COUNT(*) FILTER (WHERE (g.created_at AT TIME ZONE 'Asia/Kolkata')::date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date)::int AS today, MAX(g.created_at) AS last_at,
              COUNT(DISTINCT (g.created_at AT TIME ZONE 'Asia/Kolkata')::date) FILTER (WHERE g.disposition = 'dnp')::int AS days,
              BOOL_OR(g.disposition = ANY($1)) AS spoke
       FROM lead_call_log g WHERE g.order_id = o.id AND g.disposition = ANY($2)) c ON TRUE
     WHERE o.assigned_to IN ('CC', 'InHouse') AND o.confirmation_status = 'pending' AND UPPER(COALESCE(o.payment_method, '')) = 'COD'
       AND COALESCE(o.converted_to_prepaid, FALSE) = FALSE AND COALESCE(o.order_status, 'new') = 'new' AND o.shipped_at IS NULL AND o.awb_number IS NULL
       AND COALESCE(o.is_duplicate, FALSE) = FALSE AND COALESCE(o.dnc, FALSE) = FALSE AND NOT ${TEST_NAME}
       AND COALESCE(o.shopify_created_at, o.created_at) >= $3
       AND (o.lead_locked_at IS NULL OR o.lead_locked_at < NOW() - INTERVAL '15 minutes'${includeIvrLocked ? " OR o.lead_locked_by = 'IVR'" : ''})
     ORDER BY COALESCE(o.shopify_created_at, o.created_at) ASC LIMIT ${Math.max(1, Math.min(10000, Number(limit) || 3000))}`,
    [cfg.CONNECTED_DISPOSITIONS, cfg.CALL_DISPOSITIONS, since]);
}

// First calls made in the last hour, per team (how fast each team is really working).
async function firstCallRates(db) {
  const rows = await db(
    `SELECT CASE WHEN a.role = 'agent' THEN 'cc' ELSE 'aman' END AS team, COUNT(*)::int AS n
     FROM (SELECT DISTINCT ON (g.order_id) g.order_id, g.agent_id, g.created_at FROM lead_call_log g
           WHERE g.disposition = ANY($1) AND g.order_id IN (SELECT id FROM orders_master WHERE COALESCE(shopify_created_at, created_at) > NOW() - INTERVAL '10 days')
           ORDER BY g.order_id, g.created_at) f
     JOIN agents a ON a.id = f.agent_id WHERE f.created_at > NOW() - INTERVAL '60 minutes' GROUP BY 1`, [cfg.CALL_DISPOSITIONS]);
  const out = { cc: 0, aman: 0 }; rows.forEach(r => { out[r.team] = r.n; }); return out;
}

// Moves the leads (only those still pending and still with the team we expected) and writes one history line per lead.
async function applyMoves(db, moves) {
  const groups = new Map();
  moves.forEach(m => { const k = `${m.from}|${m.to}|${m.reason}`; if (!groups.has(k)) groups.set(k, { from: m.from, to: m.to, reason: m.reason, ids: [] }); groups.get(k).ids.push(m.id); });
  let moved = 0; const byReason = {};
  for (const g of groups.values()) {
    const done = await db(
      `UPDATE orders_master SET assigned_to = $2, assigned_agent = NULL, lead_locked_by = NULL, lead_locked_at = NULL, updated_at = NOW()
       WHERE id = ANY($1) AND confirmation_status = 'pending' AND assigned_to = $3
         AND (lead_locked_by IS NULL OR lead_locked_at < NOW() - INTERVAL '15 minutes') RETURNING id`, [g.ids, g.to, g.from]);   // never take a lead from a person who has it open, or from the IVR (a held lead is the IVR's)
    if (!done.length) continue;
    await db(`INSERT INTO order_status_events (order_id, event_type, old_value, new_value, actor, notes)
              SELECT unnest($1::uuid[]), 'autopilot_move', $2, $3, 'autopilot', $4`, [done.map(d => d.id), g.from, g.to, g.reason]);
    moved += done.length; byReason[g.reason] = (byReason[g.reason] || 0) + done.length;
  }
  return { moved, byReason };
}

// One autopilot cycle. Returns what it saw and did; in dry mode nothing is moved.
async function tick(db, now = new Date(), s = ap.settings()) {
  if (s.mode === 'off') return { mode: 'off' };
  const { presence, agents } = await presenceNow(db, now, s);
  const [leads, rates] = await Promise.all([loadLeads(db), firstCallRates(db)]);
  const paceCc = ap.pace('CC', leads, presence, rates.cc, now, s), paceAm = ap.pace('InHouse', leads, presence, rates.aman, now, s);
  const plan = ap.planMoves({ now, presence, leads, rates }, s);
  // Every 10 minutes: even out the total load between the teams (lib/loadPlan.js). Leads the rules above already move are left alone.
  if (now.getMinutes() % 10 === 0 && ap.shiftOpen(now, s)) {
    try {
      const lp = require('./loadPlan'), lpDb = require('./loadPlanDb');
      const bal = lp.buildPlan({ now, leads, agents, rates: await lpDb.measuredRates(db) }).moves;
      const taken = new Set(plan.map(m => m.id));
      bal.filter(m => !taken.has(m.id)).forEach(m => plan.push(m));
    } catch (err) { console.error('[Autopilot] load balance skipped:', err.message); }
  }
  const reasons = {}; plan.forEach(m => { reasons[m.reason] = (reasons[m.reason] || 0) + 1; });
  let moved = 0;
  if (s.mode === 'on' && plan.length) { const r = await applyMoves(db, plan); moved = r.moved; }
  if (plan.length || moved || now.getMinutes() % 10 === 0) {
    await db(`INSERT INTO autopilot_runs (mode, presence, pace, planned, moved, reasons) VALUES ($1, $2, $3, $4, $5, $6)`,
      [s.mode, JSON.stringify(presence), JSON.stringify({ cc: paceCc, aman: paceAm }), plan.length, moved, JSON.stringify(reasons)]);
  }
  return { mode: s.mode, presence, pace: { cc: paceCc, aman: paceAm }, planned: plan.length, moved, reasons };
}

// How busy each team is right now (the same first-call pace the autopilot uses): { cc: pace, aman: pace }. Cached for a minute: the WhatsApp bridge asks for it on every first message.
let bwCache = { at: 0, v: null };
async function bandwidth(db, now = new Date(), s = ap.settings()) {
  if (bwCache.v && new Date(now).getTime() - bwCache.at < 60000) return bwCache.v;
  const { presence } = await presenceNow(db, now, s);
  const [leads, rates] = await Promise.all([loadLeads(db), firstCallRates(db)]);
  const v = { cc: ap.pace('CC', leads, presence, rates.cc, now, s), aman: ap.pace('InHouse', leads, presence, rates.aman, now, s) };
  bwCache = { at: new Date(now).getTime(), v };
  return v;
}

module.exports = { ensureTables, heartbeat, loadAgents, presenceNow, loadLeads, firstCallRates, applyMoves, tick, bandwidth, _resetBandwidth: () => { bwCache = { at: 0, v: null }; } };
