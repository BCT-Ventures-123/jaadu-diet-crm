// Database side of the daily call plan (rules are in lib/loadPlan.js). Read-only except applyBalance, which reuses the autopilot's move writer.
const cfg = require('./config');
const apDb = require('./autopilotDb');
const lp = require('./loadPlan');

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// How fast each team really calls: calls per hour, from the last 7 days (only days with at least 10 calls by that person; the hours run from their first call to their last).
async function measuredRates(db) {
  const out = { cc: null, aman: null, pickup: { cc: {}, aman: {} } };
  try {
    const rows = await db(
      `SELECT team, SUM(calls)::int AS calls, SUM(GREATEST(hrs, 1))::float AS hrs FROM (
         SELECT CASE WHEN a.role = 'agent' THEN 'cc' ELSE 'aman' END AS team, g.agent_id, (g.created_at AT TIME ZONE 'Asia/Kolkata')::date AS d, COUNT(*) AS calls,
                EXTRACT(EPOCH FROM MAX(g.created_at) - MIN(g.created_at)) / 3600.0 AS hrs
         FROM lead_call_log g JOIN agents a ON a.id = g.agent_id
         WHERE g.created_at > NOW() - INTERVAL '7 days' AND g.disposition = ANY($1) AND a.role IN ('agent', 'aman')
         GROUP BY 1, 2, 3 HAVING COUNT(*) >= 10) x GROUP BY team`, [cfg.CALL_DISPOSITIONS]);
    for (const r of rows) if (r.calls >= 30 && r.hrs > 0) out[r.team] = { perHour: clamp(r.calls / r.hrs, 5, 40), source: 'measured' };
    const pk = await db(
      `SELECT CASE WHEN a.role = 'agent' THEN 'cc' ELSE 'aman' END AS team, (x.rn = 1) AS fresh, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE x.disposition = ANY($1))::int AS connected
       FROM (SELECT g.agent_id, g.disposition, g.created_at, ROW_NUMBER() OVER (PARTITION BY g.order_id ORDER BY g.created_at) AS rn
             FROM lead_call_log g WHERE g.disposition = ANY($2)
               AND g.order_id IN (SELECT id FROM orders_master WHERE COALESCE(shopify_created_at, created_at) > NOW() - INTERVAL '14 days')) x
       JOIN agents a ON a.id = x.agent_id WHERE x.created_at > NOW() - INTERVAL '7 days' AND a.role IN ('agent', 'aman') GROUP BY 1, 2`, [cfg.CONNECTED_DISPOSITIONS, cfg.CALL_DISPOSITIONS]);
    for (const r of pk) if (r.n >= 30) out.pickup[r.team][r.fresh ? 'fresh' : 'retry'] = clamp(r.connected / r.n, 0.05, 0.95);
  } catch (err) { console.error('[LoadPlan] could not measure the calling rate, using defaults:', err.message); }
  return out;
}

async function loadPlan(db, now = new Date()) {
  const [leads, agents, rates] = await Promise.all([apDb.loadLeads(db), apDb.loadAgents(db), measuredRates(db)]);
  // The screen and its button use a bigger batch than the autopilot (which moves a few leads every 10 minutes), so the preview equals what the button does.
  const s = { ...lp.settings(), batch: Math.max(lp.settings().batch, 400) };
  return { plan: lp.buildPlan({ now, leads, agents, rates }, s), leads, agents, rates };
}

// Moves the planned leads (only those still pending and still with the team we expected), with one history line per lead.
async function applyBalance(db, now = new Date()) {
  const { plan } = await loadPlan(db, now);
  if (!plan.moves.length) return { planned: 0, moved: 0, byReason: {} };
  const r = await apDb.applyMoves(db, plan.moves);
  return { planned: plan.moves.length, ...r };
}

// Manual split of the old backlog. preview = true only counts; otherwise it moves the leads (same writer and history lines as the autopilot).
async function splitBacklog(db, { toAman = 0, toCc = 0, preview = false, now = new Date() } = {}) {
  const leads = await apDb.loadLeads(db);
  const r = lp.splitMoves({ now, leads, toAman, toCc });
  const out = { available: r.available, cc_to_aman: r.cc_to_aman, aman_to_cc: r.aman_to_cc, planned: r.moves.length, moved: 0 };
  if (preview || !r.moves.length) return out;
  const w = await apDb.applyMoves(db, r.moves);
  return { ...out, moved: w.moved };
}

// The leads to stop redialling, with what a person needs to send a WhatsApp / IVR message and then review them.
async function reviewRows(db, ids) {
  if (!ids.length) return [];
  return db(
    `SELECT o.id, o.order_name, o.customer_name, o.customer_phone, o.total_price, CASE WHEN o.assigned_to = 'InHouse' THEN 'Aman' ELSE 'Call centre' END AS team,
            COALESCE(o.shopify_created_at, o.created_at) AS placed_at,
            (SELECT COUNT(*)::int FROM lead_call_log g WHERE g.order_id = o.id AND g.disposition = 'dnp') AS dnp_tries,
            (SELECT COUNT(DISTINCT (g.created_at AT TIME ZONE 'Asia/Kolkata')::date)::int FROM lead_call_log g WHERE g.order_id = o.id AND g.disposition = 'dnp') AS days_tried,
            (SELECT MAX(g.created_at) FROM lead_call_log g WHERE g.order_id = o.id) AS last_tried
     FROM orders_master o WHERE o.id = ANY($1) ORDER BY COALESCE(o.shopify_created_at, o.created_at) ASC`, [ids]);
}

module.exports = { measuredRates, loadPlan, applyBalance, splitBacklog, reviewRows };
