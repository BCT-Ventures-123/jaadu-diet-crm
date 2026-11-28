// Call-centre (cc-crm.html) backend: login, queues, dispositions, prepaid links,
// Razorpay webhook, reports and admin. Mounted once from server.js.
// Aman's endpoints (/api/lead/*, /api/aman/*) are NOT touched by this file.
const crypto = require('crypto');
const axios = require('axios');
const cfg = require('./lib/config');
const auth = require('./lib/auth');
const access = require('./lib/access');
const { shippingLocked } = require('./lib/prepaidGuard');
const { syncPrepaidToShopify } = require('./lib/shopifyPrepaid');
const { dnpStatus } = require('./lib/dnp');
const queueLib = require('./lib/queue');
const report2Lib = require('./lib/report2');
const shipGateDb = require('./lib/shipGateDb');
const shipSheetsLib = require('./lib/shipSheets');
const e2eLib = require('./lib/e2e');
const teamReportLib = require('./lib/teamReport');
const controlTowerLib = require('./lib/controlTower');
const loadPlanDb = require('./lib/loadPlanDb');
const opsAgent = require('./lib/opsAgent');
const autopilotLib = require('./lib/autopilot');
const autopilotDb = require('./lib/autopilotDb');
const { validateCallback, callbackBadge } = require('./lib/callback');
const { evaluateIncentive, summarizeIncentives } = require('./lib/incentive');
const { buildReport, toCsv } = require('./lib/reportMath');
const { statusCondition, dayRange, buildDaily } = require('./lib/leadFilters');
const balance = require('./lib/balance');
const balanceDb = require('./lib/balanceDb');
const funnelLib = require('./lib/funnel');
const productsLib = require('./lib/products');
const channelsLib = require('./lib/channels');
const scoreLib = require('./lib/scorecard');
const { attachRisk } = require('./lib/risk');
const riskConfig = require('./lib/riskConfig');

const COOKIE = 'jd_session';
const SESSION_HOURS = Number(process.env.SESSION_HOURS || 12);
const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FINAL_STATES = ['cancelled', 'unreachable', 'wrong_number'];
const IN_HOUSE_ROLES = ['aman', 'admin'];
const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64');

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
const num = (v) => { const n = Number(v); return v !== undefined && v !== null && v !== '' && Number.isFinite(n) ? n : null; };
const clean = (v, max = 1000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const istToday = () => new Date().toLocaleDateString('en-CA', { timeZone: cfg.TIMEZONE });

function sendError(res, err) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
  console.error('[CC]', err);
  return res.status(500).json({ error: 'Server error' });
}

module.exports = function mountCcRoutes(app, deps) {
  const { db, dbOne, pool, CONFIG, writeDispositionToSheet, writeDispositionToNewSheet, cancelShopifyOrder, updateShopifyShippingAddress, syncConfirmedTag } = deps;
  const secret = () => process.env.SESSION_SECRET || '';

  async function tx(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
      throw e;
    } finally {
      client.release();
    }
  }

  // ---------------------------------------------------------------- AUTH
  async function loadAgent(req) {
    if (!secret()) return null;
    const token = auth.parseCookies(req.headers.cookie)[COOKIE];
    const payload = auth.verifyToken(token, secret());
    if (!payload || !UUID_RE.test(String(payload.id))) return null;
    const agent = await dbOne(
      'SELECT id, username, display_name, role, is_backup, is_active, token_version FROM agents WHERE id = $1',
      [payload.id]
    );
    if (!agent || !agent.is_active || agent.token_version !== payload.v) return null;
    return agent;
  }

  async function requireAuth(req, res, next) {
    try {
      if (!secret()) return res.status(503).json({ error: 'Login is not configured (SESSION_SECRET missing)' });
      const agent = await loadAgent(req);
      if (!agent) return res.status(401).json({ error: 'Please log in', login: true });
      req.agent = agent;
      next();
    } catch (err) { sendError(res, err); }
  }
  function requireAdmin(req, res, next) {
    requireAuth(req, res, () => {
      if (req.agent.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
      next();
    });
  }

  function setSessionCookie(req, res, agent) {
    const exp = Date.now() + SESSION_HOURS * 3600 * 1000;
    const token = auth.signToken({ id: agent.id, v: agent.token_version, exp }, secret());
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('Set-Cookie',
      `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_HOURS * 3600}${secure ? '; Secure' : ''}`);
  }

  app.post('/api/auth/login', async (req, res) => {
    try {
      if (!secret()) throw new HttpError(503, 'Login is not configured (SESSION_SECRET missing)');
      const username = clean(req.body?.username, 60).toLowerCase();
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      const agent = username ? await dbOne('SELECT * FROM agents WHERE username = $1', [username]) : null;

      if (agent && agent.locked_until && new Date(agent.locked_until) > new Date()) {
        throw new HttpError(429, 'Too many failed attempts. Try again in a few minutes.');
      }
      const ok = await auth.verifyPassword(password, agent ? agent.password_hash : DUMMY_HASH);
      if (!agent || !ok || !agent.is_active) {
        if (agent) {
          await db(
            `UPDATE agents SET failed_logins = failed_logins + 1,
               locked_until = CASE WHEN failed_logins + 1 >= $2 THEN NOW() + ($3 || ' minutes')::interval ELSE locked_until END
             WHERE id = $1`, [agent.id, MAX_FAILED_LOGINS, String(LOCK_MINUTES)]);
        }
        throw new HttpError(401, 'Wrong username or password');
      }
      await db('UPDATE agents SET failed_logins = 0, locked_until = NULL, last_login_at = NOW() WHERE id = $1', [agent.id]);
      setSessionCookie(req, res, agent);
      res.json({ success: true, agent: { display_name: agent.display_name, role: agent.role } });
    } catch (err) { sendError(res, err); }
  });

  app.post('/api/auth/logout', (req, res) => {
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    res.json({ success: true });
  });

  app.get('/api/auth/me', requireAuth, (req, res) => {
    const a = req.agent;
    res.json({ id: a.id, username: a.username, display_name: a.display_name, role: a.role, is_backup: a.is_backup });
  });

  const requireRoles = (...roles) => (req, res, next) => requireAuth(req, res, () => {
    if (!roles.includes(req.agent.role)) return res.status(403).json({ error: 'Not allowed for your account' });
    next();
  });

  // Page guard: runs before express.static (see server.js), so the HTML itself needs the right login.
  app.get(['/', '/index.html', '/admin.html', '/aman-crm.html', '/cc-crm.html'], async (req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      const agent = secret() ? await loadAgent(req) : null;
      if (!agent) return res.redirect('/login.html?next=' + encodeURIComponent(req.path === '/' ? '/index.html' : req.path));
      if (!access.canOpen(agent.role, req.path)) return res.redirect(access.homeFor(agent.role));
      next();
    } catch (err) { next(err); }
  });

  // Everything under these prefixes needs a login (existing handlers registered later still run after this).
  app.use('/api/cc', requireAuth);
  app.use('/api/reports', requireAdmin);
  app.use('/api/admin', requireAdmin);
  // Aman's endpoints: Aman or admin only. Call-centre agents cannot use them.
  app.use(['/api/aman', '/api/lead', '/api/ndr', '/api/refund', '/api/order', '/api/kpi'], requireRoles('admin', 'aman'));
  // Manager data with no page in the CRM: admin only.
  app.use(['/api/logistics', '/api/inventory', '/api/refunds'], requireAdmin);

  // ---------------------------------------------------------------- QUEUES
  async function dnpMap(ids) {
    if (!ids.length) return new Map();
    const rows = await db(
      `SELECT order_id, created_at FROM lead_call_log WHERE order_id = ANY($1) AND disposition = 'dnp'`, [ids]);
    const m = new Map();
    rows.forEach(r => { if (!m.has(r.order_id)) m.set(r.order_id, []); m.get(r.order_id).push(r.created_at); });
    return m;
  }

  app.get('/api/cc/meta', async (req, res) => {
    const agents = IN_HOUSE_ROLES.includes(req.agent.role)
      ? await db(`SELECT display_name, role FROM agents WHERE is_active = TRUE ORDER BY display_name`).catch(() => []) : [];
    res.json({
      agent: { display_name: req.agent.display_name, role: req.agent.role }, agents,
      cancel_reasons: cfg.CANCEL_REASONS,
      products: productsLib.PRODUCTS.map(p => ({ key: p.key, name: p.name })),
      risk_legend: riskConfig.legend,
      prepaid_amount: cfg.PREPAID_AMOUNT,
      dnp_rules: {
        min_daily: cfg.DNP_MIN_DAILY_ATTEMPTS, max_daily: cfg.DNP_MAX_DAILY_ATTEMPTS,
        min_gap_minutes: cfg.DNP_MIN_GAP_MINUTES, followup_days: cfg.FOLLOWUP_DAYS,
      },
    });
  });

  // Today's COD orders with every attempt on every channel (the order ledger): the base of the KPI ribbons on the Aman and call-centre pages (owner 2026-11-25: COD orders only, all channels count).
  async function todayCodLedger(team) {
    const day = todayIst(), r = parseRange({ from: day, to: day }), rows = await fetchCohortRows(r, team, null), touches = await loadTouches(rows.map(o => o.id));
    const ledgerLib = require('./lib/ledger'), led = ledgerLib.buildLedger(rows, touches, new Date());
    return { led, touches, b: ledgerLib.block(led) };
  }
  // The ribbon: the pending / NDR / duplicate counts stay from the database view; Today Orders / Confirmed / Cancelled / Confirm Rate / Confirmed value are now COD orders placed today (prepaid is auto-confirmed and was inflating them).
  const kpiRibbon = async (req, res) => {
    try {
      const base = (await dbOne('SELECT * FROM v_kpi_ribbon')) || {};
      try {
        const { led, b } = await todayCodLedger(null);
        Object.assign(base, { today_orders: String(b.leads), today_confirmed: String(b.confirmed), today_cancelled: String(b.cancelled), today_confirm_rate: String(b.leads ? Math.round(b.confirmed * 1000 / b.leads) / 10 : 0),
          today_confirmed_value: String(led.filter(o => o.status === 'confirmed').reduce((s, o) => s + (o.amount || 0), 0)) });
      } catch (e) { console.error('[KPI] ledger numbers skipped, showing the database view:', e.message); }
      res.json(base);
    } catch (err) { sendError(res, err); }
  };
  app.get('/api/cc/kpi', kpiRibbon);
  app.get('/api/kpi', kpiRibbon);        // Aman and admin (registered after the role guard above, so it answers before the older copy in server.js)

  // Today's order-based connectivity KPI (team filter: CC, InHouse, or all)
  // Registered on both /api/cc/ (for CC agents) and /api/kpi/ (for Aman/admin)
  app.get(['/api/cc/kpi/connectivity', '/api/kpi/connectivity'], async (req, res) => {
    try {
      const team = req.query.team === 'CC' ? 'CC' : req.query.team === 'InHouse' ? 'InHouse' : null;       // 'CC', 'InHouse', or omit for all
      const { led, touches, b } = await todayCodLedger(team);
      const total = b.leads, pctVal = (n, d2) => (d2 > 0 ? Math.round(n / d2 * 1000) / 10 : 0);
      // Same rules as Home and the Daily report: today's COD orders of the team; an attempt is a call, an IVR call or a WhatsApp message; connected = the customer answered on any channel.
      const first = led.filter(o => { const ts = (touches.get(o.id) || []).slice().sort((x, y) => new Date(x.t) - new Date(y.t)); return ts.length && ts[0].connected; }).length;
      res.json({ total_orders: total, leads_attempted: b.attempted, not_called: b.not_attempted, attempt_1_total: b.attempted, attempt_1_connected: first, attempt_1_coverage_pct: pctVal(b.attempted, total), attempt_1_connectivity_pct: pctVal(first, total),
        total_connected: b.connected, overall_connectivity_pct: pctVal(b.connected, total) });
    } catch (err) { sendError(res, err); }
  });

  app.get('/api/cc/fresh-leads', async (req, res) => {
    try {
      // Only orders placed on or after the official calling start date (earlier ones were testing / the old sheet).
      // One owner per lead: a lead the IVR (or the WhatsApp wait) is holding is not shown to the call centre, so nobody calls what the IVR has. A person can still open one by order number: that takes it over.
      const rows = await db(`SELECT v.* FROM v_cc_fresh_leads v JOIN orders_master o ON o.id = v.id WHERE COALESCE(o.shopify_created_at, o.created_at) >= $1::timestamptz
        AND NOT (COALESCE(o.lead_locked_by, '') IN ('IVR', 'WHATSAPP') AND COALESCE(o.lead_locked_at > NOW() - INTERVAL '15 minutes', FALSE))`, [cfg.CALLING_STARTED_ON + 'T00:00:00+05:30']);
      const withRisk = await attachRisk(db, rows);
      const dnp = await dnpMap(rows.map(r => r.id));
      const extra = new Map((await db('SELECT id, address_fixed, shopify_created_at FROM orders_master WHERE id = ANY($1)', [rows.map(r => r.id)])).map(e => [e.id, e]));
      const now = new Date();
      // Smart queue: best lead to call next first, with the reason (lib/queue.js).
      const ho = new Map((rows.length ? await db(`SELECT DISTINCT ON (order_id) order_id, notes FROM order_status_events WHERE event_type = 'autopilot_move' AND new_value = 'CC' AND created_at > NOW() - INTERVAL '3 days' AND order_id = ANY($1) ORDER BY order_id, created_at DESC`, [rows.map(r => r.id)]) : []).map(e => [e.order_id, e.notes]));
      const warm = await require('./lib/warmLeads').warmIds(db, rows.map(r => r.id));      // read the WhatsApp message, tapped nothing: called first inside their tier
      const queue = withRisk.map(l => {
        const d = dnpStatus(dnp.get(l.id) || [], now), lead = { ...l, handover_reason: ho.get(l.id) || null, wa_warm: warm.has(l.id) };
        return { ...lead, ...(extra.get(l.id) || {}), assigned_to: 'CC', callback_badge: callbackBadge(l, now), dnp: d, priority: queueLib.prioritise(lead, d, now) };
      });
      res.json(queueLib.sortQueue(queue));
    } catch (err) { sendError(res, err); }
  });

  app.get('/api/cc/address-fix', async (req, res) => {
    try { res.json(await db('SELECT * FROM v_cc_address_fix_queue')); } catch (err) { sendError(res, err); }
  });

  app.get('/api/cc/callbacks', async (req, res) => {
    try { res.json(await db('SELECT * FROM v_cc_scheduled_callbacks')); } catch (err) { sendError(res, err); }
  });

  // ---------------------------------------------------------------- LOCKS
  app.post('/api/cc/lead/lock', async (req, res) => {
    try {
      const id = req.body?.order_id;
      if (!UUID_RE.test(String(id))) throw new HttpError(400, 'Invalid order_id');
      const r = await dbOne('SELECT acquire_lead_lock($1, $2, $3)', [id, req.agent.display_name, CONFIG.LEAD_LOCK_MINUTES]);
      let lockedBy = null;
      if (!r?.acquire_lead_lock) {
        const o = await dbOne('SELECT lead_locked_by FROM orders_master WHERE id = $1', [id]);
        lockedBy = o?.lead_locked_by || null;
        // Re-opening a lead you already hold is fine.
        if (lockedBy === req.agent.display_name) return res.json({ locked: true });
        // The IVR and WhatsApp hold a lead only so that nobody calls it twice. A person who has the customer on the phone always wins: take the lead over.
        if (lockedBy === 'IVR' || lockedBy === 'WHATSAPP') {
          // Never take a lead over while the IVR call is still in progress (ringing or being answered): two parties on one customer is exactly what must not happen.
          if (lockedBy === 'IVR') {
            let midCall = null;
            try { midCall = await dbOne(`SELECT 1 AS x FROM ivr_calls WHERE order_id = $1 AND NOT is_test AND status = 'placed' AND result IS NULL AND placed_at > NOW() - INTERVAL '3 minutes' LIMIT 1`, [id]); } catch (e) { midCall = null; }
            if (midCall) return res.json({ locked: false, locked_by: 'IVR', message: 'The IVR is calling this customer right now. Please wait 3 minutes.' });
          }
          const took = await dbOne(`UPDATE orders_master SET lead_locked_by = $2, lead_locked_at = NOW() WHERE id = $1 AND lead_locked_by IN ('IVR', 'WHATSAPP') AND confirmation_status = 'pending' RETURNING id`, [id, req.agent.display_name]);
          if (took) return res.json({ locked: true, took_over_from: lockedBy });
        }
      }
      res.json({ locked: !!r?.acquire_lead_lock, locked_by: lockedBy });
    } catch (err) { sendError(res, err); }
  });

  app.post('/api/cc/lead/unlock', async (req, res) => {
    try {
      const id = req.body?.order_id;
      if (!UUID_RE.test(String(id))) throw new HttpError(400, 'Invalid order_id');
      await db('SELECT release_lead_lock($1, $2)', [id, req.agent.display_name]);
      res.json({ released: true });
    } catch (err) { sendError(res, err); }
  });

  // ---------------------------------------------------------------- NOTES
  app.post('/api/cc/lead/note', async (req, res) => {
    try {
      const { order_id } = req.body || {};
      const note = clean(req.body?.note);
      if (!UUID_RE.test(String(order_id))) throw new HttpError(400, 'Invalid order_id');
      if (!note) throw new HttpError(400, 'Note is empty');
      const order = await dbOne('SELECT id, assigned_to FROM orders_master WHERE id = $1', [order_id]);
      if (!order) throw new HttpError(404, 'Lead not found');
      if (order.assigned_to !== 'CC' && !IN_HOUSE_ROLES.includes(req.agent.role)) throw new HttpError(403, 'This lead belongs to the in-house team');
      await db(`INSERT INTO lead_call_log (order_id, agent_id, agent_name, disposition, note) VALUES ($1,$2,$3,'note',$4)`,
        [order_id, req.agent.id, req.agent.display_name, note]);
      await db(`SELECT log_status_change($1, 'note', NULL, NULL, $2, $3)`, [order_id, req.agent.display_name, note]);
      res.json({ success: true });
    } catch (err) { sendError(res, err); }
  });

  // ---------------------------------------------------------------- DISPOSITIONS
  const SHEET_LABEL = {
    confirmed: 'done', cancelled: 'rejected', dnp: 'dnp', callback: 'callback',
    address_fix: 'address_fixed', wrong_number: 'wrong_number', dnc: 'do_not_call', escalated: 'escalated',
  };

  app.post('/api/cc/lead/disposition', async (req, res) => {
    try {
      const { order_id, disposition, reason_code, callback_at, new_address } = req.body || {};
      const note = clean(req.body?.notes);
      const agent = req.agent;
      if (!UUID_RE.test(String(order_id))) throw new HttpError(400, 'Invalid order_id');
      if (!cfg.CALL_DISPOSITIONS.includes(disposition)) throw new HttpError(400, `Invalid disposition: ${disposition}`);

      // Input checks that need no database
      let cancelReasonText = null;
      let callbackWhen = null;
      let confirmedByFix = false;      // owner 2026-11-24: fixing the address on a pending order IS a confirmation (the customer gave the right address and the order ships)
      if (disposition === 'cancelled') {
        if (!cfg.CANCEL_REASONS[reason_code]) throw new HttpError(400, 'Select a cancel reason');
        if (reason_code === 'other' && !note) throw new HttpError(400, 'Please add a note for reason "Other"');
        cancelReasonText = cfg.CANCEL_REASONS[reason_code] + (note ? `: ${note}` : '');
      }
      if (disposition === 'callback') {
        const v = validateCallback(callback_at);
        if (!v.ok) throw new HttpError(400, v.error);
        callbackWhen = v.when;
      }
      if (disposition === 'address_fix' && !clean(new_address, 500)) throw new HttpError(400, 'New address is required');
      if (disposition === 'escalated' && !note) throw new HttpError(400, 'Please add a note explaining the escalation');

      const result = await tx(async (c) => {
        const q = async (text, params) => (await c.query(text, params)).rows;
        const [order] = await q('SELECT * FROM orders_master WHERE id = $1 FOR UPDATE', [order_id]);
        if (!order) throw new HttpError(404, 'Order not found');
        if (order.assigned_to !== 'CC' && !IN_HOUSE_ROLES.includes(agent.role)) throw new HttpError(403, 'This lead belongs to the in-house team');
        if (disposition === 'escalated' && order.assigned_to !== 'CC') throw new HttpError(400, 'In-house leads cannot be escalated');
        if (order.dnc) throw new HttpError(409, 'This lead is flagged Do Not Call');
        if (FINAL_STATES.includes(order.confirmation_status) || order.order_status === 'cancelled') {
          throw new HttpError(409, `Lead is already closed (${order.confirmation_status})`);
        }
        if (disposition !== 'address_fix' && order.confirmation_status !== 'pending') {
          throw new HttpError(409, `Lead is already ${order.confirmation_status}`);
        }
        if (disposition === 'address_fix' && order.address_locked) {
          throw new HttpError(400, 'Order address is locked (AWB generated)');
        }
        // Only another PERSON blocks a disposition. A hold by the IVR or WhatsApp never does: the person talking to the customer must be able to save the result.
        if (order.lead_locked_by && order.lead_locked_by !== agent.display_name && order.lead_locked_by !== 'IVR' && order.lead_locked_by !== 'WHATSAPP'
            && order.lead_locked_at && Date.now() - new Date(order.lead_locked_at).getTime() < CONFIG.LEAD_LOCK_MINUTES * 60000) {
          throw new HttpError(409, `Lead is being handled by ${order.lead_locked_by}`);
        }

        // DNP rule: record the attempt; hard stop at the daily maximum.
        let dnpInfo = null;
        if (disposition === 'dnp') {
          const times = (await q(`SELECT created_at FROM lead_call_log WHERE order_id = $1 AND disposition = 'dnp'`, [order_id]))
            .map(r => r.created_at);
          const before = dnpStatus(times, new Date());
          if (before.atMax) throw new HttpError(409, before.hint, { dnp: before });
        }

        const base = `assigned_agent = $2, call_attempts = call_attempts + 1, last_call_at = NOW(),
                      lead_locked_by = NULL, lead_locked_at = NULL`;
        const clearCb = disposition === 'callback' ? '' : ', callback_at = NULL, callback_note = NULL';

        switch (disposition) {
          case 'confirmed':
            await q(`UPDATE orders_master SET confirmation_status = 'confirmed', confirmed_at = NOW(), ${base}${clearCb} WHERE id = $1`,
              [order_id, agent.display_name]);
            break;
          case 'cancelled':
            await q(`UPDATE orders_master SET confirmation_status = 'cancelled', order_status = 'cancelled', cancelled_at = NOW(),
                       cancellation_reason = $3, cancel_reason_code = $4, ${base}${clearCb} WHERE id = $1`,
              [order_id, agent.display_name, cancelReasonText, reason_code]);
            break;
          case 'dnp':
            await q(`UPDATE orders_master SET ${base}${clearCb} WHERE id = $1`, [order_id, agent.display_name]);
            break;
          case 'callback':
            await q(`UPDATE orders_master SET callback_at = $3, callback_note = $4, ${base} WHERE id = $1`,
              [order_id, agent.display_name, callbackWhen, note || null]);
            break;
          case 'address_fix':
            confirmedByFix = order.confirmation_status === 'pending';
            await q(`UPDATE orders_master SET shipping_address1 = $3, address_fixed = TRUE, address_is_short = FALSE,
                       confirmed_at = CASE WHEN confirmation_status = 'pending' THEN NOW() ELSE confirmed_at END,
                       confirmation_status = CASE WHEN confirmation_status = 'pending' THEN 'confirmed' ELSE confirmation_status END,
                       ${base}${clearCb} WHERE id = $1`,
              [order_id, agent.display_name, clean(new_address, 500)]);
            break;
          case 'wrong_number':
            await q(`UPDATE orders_master SET confirmation_status = 'wrong_number', wrong_number_at = NOW(), ${base}${clearCb} WHERE id = $1`,
              [order_id, agent.display_name]);
            break;
          case 'dnc':
            await q(`UPDATE orders_master SET dnc = TRUE, dnc_by = $2, dnc_at = NOW(), dnc_note = $3, ${base}${clearCb} WHERE id = $1`,
              [order_id, agent.display_name, note || null]);
            break;
          case 'escalated':
            await q(`UPDATE orders_master SET assigned_to = 'InHouse', ${base}${clearCb} WHERE id = $1`,
              [order_id, agent.display_name]);
            break;
        }

        const meta = {};
        if (disposition === 'address_fix') { meta.old_address = order.shipping_address1; meta.new_address = clean(new_address, 500); }
        await q(`INSERT INTO lead_call_log (order_id, agent_id, agent_name, disposition, reason_code, note, callback_at, meta)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [order_id, agent.id, agent.display_name, disposition, reason_code || null, note || null, callbackWhen, JSON.stringify(meta)]);

        await q(`SELECT log_status_change($1, $2, $3, $4, $5, $6)`,
          [order_id, disposition, order.confirmation_status, disposition === 'confirmed' ? 'confirmed' : disposition,
            agent.display_name, cancelReasonText || note || null]);
        if (confirmedByFix) await q(`SELECT log_status_change($1, 'confirmed', 'pending', 'confirmed', $2, $3)`, [order_id, agent.display_name, 'Address fixed and order confirmed']);

        if (disposition === 'dnp') {
          const times = (await q(`SELECT created_at FROM lead_call_log WHERE order_id = $1 AND disposition = 'dnp'`, [order_id]))
            .map(r => r.created_at);
          dnpInfo = dnpStatus(times, new Date());
        }
        return { order, dnpInfo };
      });

      // Side effects after commit (same behaviour as the in-house flow)
      const { order, dnpInfo } = result;
      if (disposition === 'confirmed' || confirmedByFix) {
        db('SELECT maybe_promote_to_repeat_queue($1)', [order.customer_phone]).catch(e => console.error(e.message));
      }
      // A confirmation from the call-centre screen must reach Shopify at once (the "confirmed" tag); the 2-minute retry job in cron_jobs.js covers any failure.
      if ((disposition === 'confirmed' || confirmedByFix) && typeof syncConfirmedTag === 'function') Promise.resolve(syncConfirmedTag(order_id, order.shopify_order_id)).catch(e => console.error('[Shopify] syncConfirmedTag error:', e.message));
      if (disposition === 'cancelled') cancelShopifyOrder(order.shopify_order_id, cancelReasonText, order_id);
      if (disposition === 'address_fix') updateShopifyShippingAddress(order.shopify_order_id, clean(new_address, 500), order_id);
      writeDispositionToSheet(order.shopify_order_number, SHEET_LABEL[confirmedByFix ? 'confirmed' : disposition], agent.display_name, (order.call_attempts || 0) + 1)
        .catch(err => console.error('[Sheet Write] background error:', err.message));
      writeDispositionToNewSheet(order.shopify_order_number, SHEET_LABEL[confirmedByFix ? 'confirmed' : disposition], agent.display_name, (order.call_attempts || 0) + 1)
        .catch(err => console.error('[New Sheet Write] background error:', err.message));

      res.json({ success: true, disposition, dnp: dnpInfo, callback_at: callbackWhen });
    } catch (err) { sendError(res, err); }
  });

  // ---------------------------------------------------------------- PREPAID LINK
  app.post('/api/cc/lead/prepaid-link', async (req, res) => {
    try {
      const { order_id } = req.body || {};
      const agent = req.agent;
      if (!UUID_RE.test(String(order_id))) throw new HttpError(400, 'Invalid order_id');
      const keyId = process.env.RAZORPAY_KEY_ID;
      const keySecret = process.env.RAZORPAY_KEY_SECRET;
      if (!keyId || !keySecret) throw new HttpError(503, 'Payment links are not configured (Razorpay keys missing)');

      const order = await dbOne(`SELECT * FROM orders_master WHERE id = $1`, [order_id]);
      if (!order) throw new HttpError(404, 'Order not found');
      if (order.assigned_to !== 'CC' && !['aman', 'admin'].includes(agent.role)) throw new HttpError(403, 'This lead belongs to the in-house team');
      if (order.payment_method !== 'COD' || order.converted_to_prepaid) throw new HttpError(409, 'Order is already prepaid');
      if (order.dnc || FINAL_STATES.includes(order.confirmation_status) || order.order_status === 'cancelled') {
        throw new HttpError(409, 'Order is closed; cannot send a payment link');
      }
      const lockedReason = shippingLocked(order);
      if (lockedReason) throw new HttpError(409, `Too late for a payment link: ${lockedReason}. Prepaid is only possible before shipping.`);

      // Re-use a still-open link instead of creating several for the same order.
      const open = await dbOne(
        `SELECT * FROM prepaid_links WHERE order_id = $1 AND status = 'created' AND sent_at > NOW() - INTERVAL '24 hours'
         ORDER BY sent_at DESC LIMIT 1`, [order_id]);
      if (open && !req.body?.force) {
        return res.json({ success: true, reused: true, short_url: open.short_url, amount: Number(open.amount), sent_at: open.sent_at, sent_by: open.agent_name });
      }

      const expireHours = Number(process.env.PREPAID_LINK_EXPIRY_HOURS || 72);
      const body = {
        amount: Math.round(cfg.PREPAID_AMOUNT * 100),
        currency: 'INR',
        accept_partial: false,
        reference_id: `${order.order_name || order.shopify_order_number}-${Date.now()}`.replace(/[^A-Za-z0-9_\-#.]/g, '').slice(0, 40),
        description: `Prepaid payment for order ${order.order_name || ''}`.trim(),
        customer: { name: order.customer_name || undefined, contact: `+91${order.customer_phone}` },
        notify: { sms: process.env.PREPAID_LINK_SMS === '1', email: false },
        reminder_enable: false,
        expire_by: Math.floor(Date.now() / 1000) + expireHours * 3600,
        notes: { order_id: order.id, order_name: order.order_name || '', agent: agent.display_name },
      };
      let link;
      try {
        link = (await axios.post('https://api.razorpay.com/v1/payment_links', body, { auth: { username: keyId, password: keySecret }, timeout: 15000 })).data;
      } catch (e) {
        const msg = e.response?.data?.error?.description || e.message;
        console.error('[Razorpay] link create failed:', msg);
        throw new HttpError(502, `Could not create payment link: ${msg}`);
      }

      await db(`INSERT INTO prepaid_links (order_id, agent_id, agent_name, razorpay_link_id, short_url, amount) VALUES ($1,$2,$3,$4,$5,$6)`,
        [order.id, agent.id, agent.display_name, link.id, link.short_url, cfg.PREPAID_AMOUNT]);
      await db(`INSERT INTO lead_call_log (order_id, agent_id, agent_name, disposition, meta) VALUES ($1,$2,$3,'prepaid_link_sent',$4)`,
        [order.id, agent.id, agent.display_name, JSON.stringify({ link_id: link.id, amount: cfg.PREPAID_AMOUNT })]);
      await db(`SELECT log_status_change($1, 'prepaid_link_sent', NULL, $2, $3, $4)`,
        [order.id, link.short_url, agent.display_name, `Prepaid link Rs ${cfg.PREPAID_AMOUNT}`]);

      res.json({ success: true, reused: false, short_url: link.short_url, amount: cfg.PREPAID_AMOUNT, sent_at: new Date().toISOString(), sent_by: agent.display_name });
    } catch (err) { sendError(res, err); }
  });

  // ---------------------------------------------------------------- RAZORPAY WEBHOOK
  // Idempotent: payment_link.paid and payment.captured can both arrive for the same payment.
  async function markPrepaidPaid({ razorpayLinkId, orderIdFromNotes, payment }) {
    return tx(async (c) => {
      const q = async (text, params) => (await c.query(text, params)).rows;
      let link = null;
      if (razorpayLinkId) [link] = await q('SELECT * FROM prepaid_links WHERE razorpay_link_id = $1 FOR UPDATE', [razorpayLinkId]);
      const orderId = link ? link.order_id : orderIdFromNotes;
      if (!orderId || !UUID_RE.test(String(orderId))) return { skipped: 'no_order' };

      const [order] = await q('SELECT * FROM orders_master WHERE id = $1 FOR UPDATE', [orderId]);
      if (!order) return { skipped: 'order_not_found' };
      if (!link) {
        [link] = await q(`SELECT * FROM prepaid_links WHERE order_id = $1 ORDER BY sent_at DESC LIMIT 1`, [orderId]);
      }
      if (order.converted_to_prepaid) return { skipped: 'already_converted' };
      if (order.payment_method !== 'COD') return { skipped: 'not_cod' };
      if (Number(payment.amount) < cfg.PREPAID_AMOUNT) return { skipped: 'amount_too_low' };

      if (link) {
        await q(`UPDATE prepaid_links SET status = 'paid', paid_at = NOW(), payment_id = $2 WHERE id = $1`, [link.id, payment.id]);
      }
      if (order.order_status === 'cancelled') {
        await q(`SELECT log_status_change($1, 'prepaid_payment_on_cancelled_order', NULL, $2, 'razorpay', 'Payment received for a cancelled order - needs manual review')`,
          [orderId, payment.id]);
        return { skipped: 'order_cancelled' };
      }
      const shipLock = shippingLocked(order);
      if (shipLock) {
        await q(`SELECT log_status_change($1, 'prepaid_payment_after_shipping', NULL, $2, 'razorpay', $3)`,
          [orderId, payment.id, `Payment received but ${shipLock}; not converted, no incentive. Needs manual review/refund`]);
        return { skipped: 'already_shipped' };
      }

      await q(`UPDATE orders_master SET payment_method = 'PREPAID', converted_to_prepaid = TRUE, razorpay_payment_id = $2,
                 prepaid_amount = $3, cod_surcharge = 0, confirmation_status = 'confirmed',
                 confirmed_at = COALESCE(confirmed_at, NOW()), lead_locked_by = NULL, lead_locked_at = NULL
               WHERE id = $1`, [orderId, payment.id, payment.amount]);
      await q(`SELECT log_status_change($1, 'prepaid_conversion', 'COD', 'PREPAID', 'razorpay', $2)`,
        [orderId, `Paid Rs ${payment.amount} (payment ${payment.id})`]);

      const [credited] = await q('SELECT id FROM agent_incentives WHERE order_id = $1', [orderId]);
      // The Rs incentive is for call-centre agents only; Aman/admin links convert the order without one.
      const [sender] = link ? await q('SELECT role FROM agents WHERE id = $1', [link.agent_id]) : [];
      const decision = evaluateIncentive({
        link, payment: { status: 'paid', amount: payment.amount },
        expectedAmount: cfg.PREPAID_AMOUNT, perConversion: cfg.INCENTIVE_PER_CONVERSION,
        alreadyCredited: !!credited || (!!sender && sender.role !== 'agent'),
      });
      if (decision.credit) {
        await q(`INSERT INTO agent_incentives (order_id, link_id, agent_id, agent_name, amount, payment_id)
                 VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (order_id) DO NOTHING`,
          [orderId, link.id, link.agent_id, link.agent_name, decision.amount, payment.id]);
      }
      return { converted: true, orderId, incentive: decision.credit ? decision.amount : 0, reason: decision.reason };
    });
  }

  // Shopify + Google Sheet follow-up. Never throws: the CRM conversion is already committed,
  // and a failure here is recorded on the order so it can be retried (scripts/shopify-sync.js).
  async function syncOrderToShopify(orderId, { dryRun = false } = {}) {
    const order = await dbOne('SELECT * FROM orders_master WHERE id = $1', [orderId]);
    if (!order) return { status: 'skipped', detail: 'order_not_found' };
    let result;
    try {
      result = await syncPrepaidToShopify({
        http: axios,
        store: process.env.SHOPIFY_STORE_DOMAIN,
        token: process.env.SHOPIFY_ACCESS_TOKEN,
        apiVersion: process.env.SHOPIFY_API_VERSION,
        shopifyOrderId: order.shopify_order_id,
        paid: order.prepaid_amount || cfg.PREPAID_AMOUNT,
        paymentId: order.razorpay_payment_id,
        mode: process.env.SHOPIFY_PREPAID_MODE === 'exact' ? 'exact' : 'full',
        dryRun,
      });
    } catch (e) {
      const detail = JSON.stringify(e.response?.data || e.message).slice(0, 500);
      result = { status: 'failed', detail };
      console.error('[Shopify prepaid sync] failed for', order.order_name, detail);
    }
    if (!dryRun) {
      await db(`UPDATE orders_master SET shopify_prepaid_sync = $2, shopify_prepaid_sync_detail = $3, shopify_prepaid_synced_at = NOW() WHERE id = $1`,
        [orderId, result.status, result.detail]).catch(e => console.error(e.message));
      await db(`SELECT log_status_change($1, 'shopify_prepaid_sync', NULL, $2, 'system', $3)`,
        [orderId, result.status, result.detail]).catch(e => console.error(e.message));
    }
    return result;
  }

  async function afterPrepaidPaid(out) {
    if (!out || !out.converted) return;
    await syncOrderToShopify(out.orderId);
    const order = await dbOne('SELECT shopify_order_number, call_attempts FROM orders_master WHERE id = $1', [out.orderId]);
    if (order && typeof writeDispositionToSheet === 'function') {
      writeDispositionToSheet(order.shopify_order_number, 'done', 'Razorpay (prepaid)', (order.call_attempts || 0) + 1)
        .catch(err => console.error('[Sheet Write] background error:', err.message));
      writeDispositionToNewSheet(order.shopify_order_number, 'done', 'Razorpay (prepaid)', (order.call_attempts || 0) + 1)
        .catch(err => console.error('[New Sheet Write] background error:', err.message));
    }
  }

  app.post('/webhook/razorpay', async (req, res) => {
    try {
      const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
      if (!webhookSecret) {
        console.error('[Razorpay] RAZORPAY_WEBHOOK_SECRET not set - webhook rejected');
        return res.status(503).json({ error: 'Webhook secret not configured' });
      }
      const sig = String(req.headers['x-razorpay-signature'] || '');
      const raw = req.rawBody;
      if (!raw || !sig) return res.status(401).json({ error: 'Invalid signature' });
      const expected = crypto.createHmac('sha256', webhookSecret).update(raw).digest('hex');
      const a = Buffer.from(sig), b = Buffer.from(expected);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Invalid signature' });

      const event = req.body?.event;
      const payEntity = req.body?.payload?.payment?.entity;
      const linkEntity = req.body?.payload?.payment_link?.entity;

      let input = null;
      if (event === 'payment_link.paid' && linkEntity && payEntity) {
        input = {
          razorpayLinkId: linkEntity.id,
          orderIdFromNotes: linkEntity.notes?.order_id,
          payment: { id: payEntity.id, amount: Number(payEntity.amount) / 100 },
        };
      } else if (event === 'payment.captured' && payEntity?.notes?.order_id) {
        input = {
          razorpayLinkId: null,
          orderIdFromNotes: payEntity.notes.order_id,
          payment: { id: payEntity.id, amount: Number(payEntity.amount) / 100 },
        };
      }
      if (!input) return res.status(200).json({ received: true, ignored: true });

      const out = await markPrepaidPaid(input);
      console.log('[Razorpay]', event, JSON.stringify(out));
      await afterPrepaidPaid(out).catch(e => console.error('[Razorpay] follow-up failed:', e.message));
      res.status(200).json({ received: true });
    } catch (err) {
      console.error('Razorpay webhook error:', err);
      // 500 makes Razorpay retry; the handler is idempotent.
      res.status(500).json({ error: 'processing failed' });
    }
  });

  // ---------------------------------------------------------------- FILTERED LISTS, STATS, DOWNLOADS (all roles)
  const ist = (d) => (d ? new Date(d).toLocaleString('en-IN', { timeZone: cfg.TIMEZONE, hour12: false }) : '');
  const rangeOrFail = (q, defaultToday) => {
    try { return dayRange(q, istToday(), defaultToday); } catch (e) { throw new HttpError(400, e.message); }
  };
  // Agents see only their own calls; admin sees everyone's.
  const mineOnly = (agent) => agent.role !== 'admin';

  function scopeOf(req) {
    if (req.agent.role === 'agent') return 'cc';
    return ['cc', 'inhouse', 'all'].includes(req.query.scope) ? req.query.scope : 'all';
  }

  async function filteredOrders(req, limit) {
    const q = req.query;
    const r = rangeOrFail(q, false);
    const params = [];
    const where = [];
    const scope = scopeOf(req);
    if (scope === 'cc') where.push(`x.assigned_to = 'CC'`);
    if (scope === 'inhouse') where.push(`x.assigned_to = 'InHouse'`);
    if (r.start) { params.push(r.start, r.end); where.push(`x.order_date >= $${params.length - 1} AND x.order_date < $${params.length}`); }
    // cohort=1 applies the same rules as the funnel: COD only, no test orders, call-centre / in-house teams only.
    const itemsOfX = `(CASE WHEN jsonb_typeof(x.line_items) = 'array' THEN x.line_items ELSE '[]'::jsonb END)`;
    if (q.cohort === '1') {
      params.push(productsLib.MIN_PRICE, productsLib.ALLOWED_PREFIXES);
      where.push(`x.assigned_to IN ('CC','InHouse') AND UPPER(COALESCE(x.payment_method,'')) = 'COD' AND COALESCE(x.converted_to_prepaid,FALSE) = FALSE
        AND NOT (LOWER(TRIM(COALESCE(x.customer_name,''))) IN ('test test','test','test order','dummy') OR COALESCE(x.customer_name,'') ~* '^\\s*test\\M')
        AND x.total_price >= $${params.length - 1}
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(${itemsOfX}) li, unnest($${params.length}::text[]) p WHERE starts_with(COALESCE(li->>'title',''), p))`);
    }
    const callList = cfg.CALL_DISPOSITIONS.map(d => `'${d}'`).join(',');          // fixed constants from config, not user input
    const connList = cfg.CONNECTED_DISPOSITIONS.map(d => `'${d}'`).join(',');
    const attemptsSql = { '0': '= 0', '1': '= 1', '2': '= 2', '3p': '>= 3' }[q.attempts];
    if (attemptsSql) where.push(`x.call_count ${attemptsSql}`);
    if (cfg.CALL_DISPOSITIONS.includes(q.last)) { params.push(q.last); where.push(`x.last_disposition = $${params.length}`); }
    const agentName = clean(q.agent, 80);
    if (agentName) { params.push(agentName); where.push(`EXISTS (SELECT 1 FROM lead_call_log g WHERE g.order_id = x.id AND g.agent_name = $${params.length} AND g.disposition IN (${callList}))`); }
    if (q.followup === 'due') where.push(`x.callback_at IS NOT NULL AND x.callback_at <= NOW()`);
    else if (q.followup === 'later') where.push(`x.callback_at IS NOT NULL AND x.callback_at > NOW()`);
    else if (q.followup === 'none') where.push(`x.callback_at IS NULL`);
    else if (q.followup === 'today') { const t = rangeOrFail({ from: istToday(), to: istToday() }, false); params.push(t.start, t.end); where.push(`x.callback_at >= $${params.length - 1} AND x.callback_at < $${params.length}`); }
    const place = clean(q.city, 60);
    if (place) { params.push(`%${place}%`); where.push(`(x.shipping_city ILIKE $${params.length} OR x.shipping_province ILIKE $${params.length} OR x.shipping_zip ILIKE $${params.length})`); }
    if (q.called_from || q.called_to) {
      const cr = rangeOrFail({ from: q.called_from, to: q.called_to }, false);
      if (cr.start) { params.push(cr.start, cr.end); where.push(`EXISTS (SELECT 1 FROM lead_call_log g WHERE g.order_id = x.id AND g.created_at >= $${params.length - 1} AND g.created_at < $${params.length} AND g.disposition IN (${callList}))`); }
    }
    const prod = productsLib.productByKey(q.product);
    if (prod) {
      params.push(prod.prefix);
      where.push(`EXISTS (SELECT 1 FROM jsonb_array_elements(${itemsOfX}) li WHERE starts_with(COALESCE(li->>'title',''), $${params.length}))`);
    }
    const cond = statusCondition(q.status);
    if (q.status && !cond) throw new HttpError(400, 'Unknown status filter');
    if (cond) where.push(cond);
    const search = clean(q.search, 60);
    if (search) {
      params.push(`%${search}%`);
      where.push(`(x.order_name ILIKE $${params.length} OR x.customer_phone ILIKE $${params.length} OR x.customer_name ILIKE $${params.length})`);
    }
    params.push(limit);
    return db(
      `SELECT x.* FROM (
         SELECT o.*, COALESCE(o.shopify_created_at, o.created_at) AS order_date,
           (SELECT g.disposition FROM lead_call_log g WHERE g.order_id = o.id AND g.disposition IN (${callList})
            ORDER BY g.created_at DESC LIMIT 1) AS last_disposition,
           (SELECT COUNT(*)::int FROM lead_call_log g WHERE g.order_id = o.id AND g.disposition IN (${callList})) AS call_count,
           (SELECT COUNT(*)::int FROM lead_call_log g WHERE g.order_id = o.id AND g.disposition IN (${connList})) AS connected_count
         FROM orders_master o) x
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY x.order_date DESC LIMIT $${params.length}`, params);
  }

  app.get('/api/cc/orders', async (req, res) => {
    try {
      const rows = await filteredOrders(req, 500);
      const withRisk = await attachRisk(db, rows);
      const now = new Date();
      res.json(withRisk.map(l => {
        const items = (Array.isArray(l.line_items) ? l.line_items : []).map(li => ({ t: li.title, q: li.quantity }));
        const skus = productsLib.skusOf(items);
        return { ...l, callback_badge: callbackBadge(l, now), skus, sku_names: skus.map(s => s.name).join(', '), qty_total: skus.reduce((s, x) => s + x.qty, 0) };
      }));
    } catch (err) { sendError(res, err); }
  });

  // Everything that happened on one order: every call attempt (numbered), notes, payment links, and the WhatsApp / IVR results.
  app.get('/api/cc/lead/history', async (req, res) => {
    try {
      const id = req.query.order_id;
      if (!UUID_RE.test(String(id))) throw new HttpError(400, 'Invalid order_id');
      const o = await dbOne(
        `SELECT id, order_name, shopify_order_id, customer_name, customer_phone, total_price, payment_method, assigned_to, assigned_agent,
                confirmation_status, order_status, callback_at, callback_note, dnc, shipping_address1, shipping_address2, shipping_city,
                shipping_province, shipping_zip, address_is_short, address_fixed, line_items, COALESCE(shopify_created_at, created_at) AS order_date
         FROM orders_master WHERE id = $1`, [id]);
      if (!o) throw new HttpError(404, 'Order not found');
      if (o.assigned_to !== 'CC' && !IN_HOUSE_ROLES.includes(req.agent.role)) throw new HttpError(403, 'This lead belongs to the in-house team');
      const calls = await db(
        `SELECT created_at AS at, agent_name AS who, disposition, reason_code, note, callback_at FROM lead_call_log WHERE order_id = $1 ORDER BY created_at ASC`, [id]);
      const events = await db(
        `SELECT created_at AS at, actor AS who, event_type, notes FROM order_status_events
         WHERE order_id = $1 AND (actor = ANY($2) OR event_type IN ('reassigned','requeued','callback_scheduled'))
         ORDER BY created_at ASC`, [id, channelsLib.SHEET_SOURCES]);
      const timeline = [
        ...calls.map(c => ({ at: c.at, who: c.who, kind: cfg.CALL_DISPOSITIONS.includes(c.disposition) ? 'call' : c.disposition === 'note' ? 'note' : 'link',
          disposition: c.disposition, reason: c.reason_code, note: c.note, callback_at: c.callback_at })),
        ...events.map(e => ({ at: e.at, who: e.who, kind: 'event', disposition: e.event_type, note: e.notes })),
      ].sort((a, b) => new Date(a.at) - new Date(b.at));
      let attempt = 0;
      timeline.forEach(t => { if (t.kind === 'call') t.attempt = ++attempt; });
      const items = (Array.isArray(o.line_items) ? o.line_items : []).map(li => ({ t: li.title, q: li.quantity }));
      res.json({ order: { ...o, skus: productsLib.skusOf(items) }, timeline, attempts: attempt,
        spoke: timeline.some(t => t.kind === 'call' && cfg.CONNECTED_DISPOSITIONS.includes(t.disposition)) });
    } catch (err) { sendError(res, err); }
  });

  async function activityRows(req, r) {
    const params = [r.start, r.end, cfg.CALL_DISPOSITIONS];
    let who = '';
    if (mineOnly(req.agent)) { params.push(req.agent.id); who = ` AND agent_id = $${params.length}`; }
    return db(
      `SELECT (created_at AT TIME ZONE 'Asia/Kolkata')::date::text AS day, disposition, COUNT(*)::int AS n
       FROM lead_call_log WHERE created_at >= $1 AND created_at < $2 AND disposition = ANY($3)${who}
       GROUP BY 1,2`, params);
  }

  app.get('/api/cc/stats', async (req, res) => {
    try {
      const r = rangeOrFail(req.query, true);
      const { totals } = buildDaily(await activityRows(req, r));
      const scope = scopeOf(req);
      const scopeSql = scope === 'cc' ? `AND assigned_to = 'CC'` : scope === 'inhouse' ? `AND assigned_to = 'InHouse'` : '';
      const placed = await dbOne(
        `SELECT COUNT(*)::int AS placed,
                COUNT(*) FILTER (WHERE confirmation_status = 'confirmed')::int AS confirmed,
                COUNT(*) FILTER (WHERE confirmation_status = 'cancelled')::int AS cancelled,
                COUNT(*) FILTER (WHERE confirmation_status = 'pending')::int AS pending,
                COUNT(*) FILTER (WHERE converted_to_prepaid = TRUE)::int AS prepaid
         FROM orders_master
         WHERE COALESCE(shopify_created_at, created_at) >= $1 AND COALESCE(shopify_created_at, created_at) < $2 ${scopeSql}`,
        [r.start, r.end]);
      const pend = await dbOne(
        `SELECT COUNT(*)::int AS n FROM orders_master WHERE confirmation_status = 'pending' AND order_status = 'new' AND dnc = FALSE ${scopeSql}`);
      res.json({ from: r.from, to: r.to, activity: totals, orders: placed, pending_now: pend?.n || 0 });
    } catch (err) { sendError(res, err); }
  });

  app.get('/api/cc/export', async (req, res) => {
    try {
      const type = String(req.query.type || 'daily');
      const who = (req.agent.display_name || 'agent').replace(/[^A-Za-z0-9_-]+/g, '_');
      if (type === 'orders') {
        const rows = (await filteredOrders(req, 20000)).map(o => ({
          ...o, order_date: ist(o.order_date), last_call_at: ist(o.last_call_at), callback_at: ist(o.callback_at),
        }));
        return sendCsv(res, `orders_${who}_${istToday()}.csv`,
          ['order_date', 'order_name', 'customer_name', 'customer_phone', 'shipping_city', 'shipping_zip', 'total_price', 'payment_method',
            'confirmation_status', 'last_disposition', 'call_attempts', 'last_call_at', 'callback_at', 'assigned_agent', 'cancellation_reason'], rows);
      }
      const r = rangeOrFail(req.query, true);
      if (type === 'calls') {
        const params = [r.start, r.end];
        let whoSql = '';
        if (mineOnly(req.agent)) { params.push(req.agent.id); whoSql = ' AND g.agent_id = $3'; }
        const rows = (await db(
          `SELECT g.created_at, g.agent_name, o.order_name, o.customer_phone, g.disposition, g.reason_code, g.note, g.callback_at
           FROM lead_call_log g JOIN orders_master o ON o.id = g.order_id
           WHERE g.created_at >= $1 AND g.created_at < $2${whoSql}
           ORDER BY g.created_at DESC LIMIT 20000`, params))
          .map(x => ({ ...x, created_at: ist(x.created_at), callback_at: ist(x.callback_at) }));
        return sendCsv(res, `calls_${who}_${r.from}_${r.to}.csv`,
          ['created_at', 'agent_name', 'order_name', 'customer_phone', 'disposition', 'reason_code', 'note', 'callback_at'], rows);
      }
      if (type !== 'daily') throw new HttpError(400, 'Unknown export type');
      const { days, totals } = buildDaily(await activityRows(req, r));
      const label = mineOnly(req.agent) ? req.agent.display_name : 'ALL';
      const rows = [...days.map(d => ({ agent: label, ...d })), { agent: label, day: 'TOTAL', ...totals }];
      return sendCsv(res, `daily-report_${who}_${r.from}_${r.to}.csv`,
        ['agent', 'day', 'total_attempts', 'connected_calls', 'connectivity_pct', 'confirmed', 'cancelled', 'cancelled_pct', 'dnp', 'callbacks',
          'address_fixes', 'wrong_numbers', 'escalations'], rows);
    } catch (err) { sendError(res, err); }
  });

  // ---------------------------------------------------------------- WORKLOAD BALANCE & RE-QUEUE (Aman / admin)
  const inHouseOnly = (req, res, next) => (IN_HOUSE_ROLES.includes(req.agent.role) ? next() : res.status(403).json({ error: 'Not allowed for your account' }));
  const balanceCfg = () => balance.settings();

  app.get('/api/cc/balance/status', inHouseOnly, async (req, res) => {
    try {
      const s = balanceCfg();
      const c = await balanceDb.counts(db);
      res.json({ aman_open: c.amanOpen, cc_open: c.ccOpen, cc_movable: c.ccMovable,
        auto: s.auto, in_window: balance.inWindow(new Date(), s),
        settings: { min_aman: s.minAman, keep_cc: s.keepCc, batch: s.batch, start_hour: s.startHour, end_hour: s.endHour } });
    } catch (err) { sendError(res, err); }
  });

  app.post('/api/cc/balance/pull', inHouseOnly, async (req, res) => {
    try {
      const want = Math.min(50, Math.max(1, Math.floor(num(req.body?.count) ?? 15)));
      const c = await balanceDb.counts(db);
      const n = balance.planMove(c, balanceCfg(), want);
      const moved = await balanceDb.moveLeads(db, n, req.agent.display_name);
      console.log(`[Balance] ${req.agent.display_name} pulled ${moved.length} lead(s) from the call centre`);
      res.json({ moved: moved.length, requested: want, cc_movable_before: c.ccMovable });
    } catch (err) { sendError(res, err); }
  });

  // Bulk actions from the Lead Workbench (Aman / admin). Only open (pending) leads move; leads someone is working on right now are skipped.
  const idList = (v) => {
    const ids = Array.isArray(v) ? [...new Set(v.map(String))] : [];
    if (!ids.length) throw new HttpError(400, 'Select at least one order');
    if (ids.length > 500) throw new HttpError(400, 'Select at most 500 orders at a time');
    if (ids.some(i => !UUID_RE.test(i))) throw new HttpError(400, 'Invalid order selection');
    return ids;
  };

  // ===================== TEAM ON LEAVE (owner 2026-11-28; rules in lib/teamLeave.js) =====================
  // When the call centre (Saturday by default) or Aman (Sunday by default) is not working, 100 percent of the day's NEW leads go to the other team. Aman or the admin can change any day here.
  // Leads nobody has called yet that are already with the absent team can be moved over with one extra button (never automatic: the receiving team's capacity is a person's call).
  const waitingFor = (team) => db(
    `SELECT o.id FROM orders_master o
     WHERE o.assigned_to = $1 AND o.confirmation_status = 'pending' AND o.order_status = 'new' AND COALESCE(o.dnc,FALSE) = FALSE AND o.callback_at IS NULL
       AND COALESCE(o.shopify_created_at, o.created_at) >= NOW() - INTERVAL '10 days'
       AND UPPER(COALESCE(o.payment_method,'')) = 'COD' AND NOT ${TEST_NAME_SQL} AND o.total_price >= $2
       AND NOT EXISTS (SELECT 1 FROM lead_call_log g WHERE g.order_id = o.id)
       AND (o.lead_locked_by IS NULL OR o.lead_locked_at < NOW() - ($3 || ' minutes')::interval)`, [team, productsLib.MIN_PRICE, String(CONFIG.LEAD_LOCK_MINUTES)]);
  async function teamLeaveState() {
    const tl = require('./lib/teamLeave'), t = await tl.today(db);
    const absent = t.off === 'cc' ? 'CC' : t.off === 'aman' ? 'InHouse' : null;
    return { ...t, name: t.off === 'none' ? '' : tl.TEAM_NAME[t.off], message: tl.label(t.off), waiting_with_absent_team: absent ? (await waitingFor(absent)).length : 0, enabled: tl.settings().on };
  }
  app.get('/api/cc/team-leave', inHouseOnly, async (req, res) => {
    try { res.json(await teamLeaveState()); } catch (err) { sendError(res, err); }
  });
  // off: 'cc' | 'aman' | 'none' (nobody off today) | 'default' (back to the weekly default). Only today can be changed.
  app.post('/api/cc/team-leave', inHouseOnly, async (req, res) => {
    try {
      const tl = require('./lib/teamLeave'), off = String(req.body && req.body.off || '');
      if (!['cc', 'aman', 'none', 'default'].includes(off)) throw new HttpError(400, 'Choose the call centre, Aman, nobody, or the weekly default');
      await tl.ensureTables(db);
      await tl.setOverride(db, tl.istDateKey(), off, req.agent.display_name);
      console.log(`[TeamLeave] ${req.agent.display_name} set today to: ${off}`);
      res.json(await teamLeaveState());
    } catch (err) { sendError(res, err); }
  });
  // Move the not-yet-called leads of the team that is off to the team that is working. Needs confirm: true. Leads someone has open right now, callbacks and anything already called stay where they are.
  app.post('/api/cc/team-leave/move-waiting', inHouseOnly, async (req, res) => {
    try {
      const st = await teamLeaveState();
      if (st.off === 'none') throw new HttpError(400, 'Nobody is marked off today');
      const from = st.off === 'cc' ? 'CC' : 'InHouse', to = st.off === 'cc' ? 'InHouse' : 'CC';
      const ids = (await waitingFor(from)).map(r => r.id);
      if (!(req.body && req.body.confirm === true)) return res.json({ preview: true, would_move: ids.length, from, to });
      let moved = [];
      for (let i = 0; i < ids.length; i += 500) {
        moved = moved.concat(await db(
          `UPDATE orders_master SET assigned_to = $2, assigned_agent = NULL, lead_locked_by = NULL, lead_locked_at = NULL, updated_at = NOW()
           WHERE id = ANY($1) AND confirmation_status = 'pending' AND assigned_to = $3 RETURNING id`, [ids.slice(i, i + 500), to, from]));
      }
      if (moved.length) await db(`INSERT INTO order_status_events (order_id, event_type, old_value, new_value, actor, notes)
                                  SELECT unnest($1::uuid[]), 'reassigned', $2, $3, $4, 'Team on leave: not-yet-called lead moved'`, [moved.map(m => m.id), from, to, req.agent.display_name]);
      console.log(`[TeamLeave] ${req.agent.display_name} moved ${moved.length} waiting lead(s) from ${from} to ${to}`);
      res.json({ moved: moved.length, from, to, state: await teamLeaveState() });
    } catch (err) { sendError(res, err); }
  });

  // ===================== REPEAT-CUSTOMER CALLING (owner 2026-11-27; rules lib/repeatQueue.js, tables lib/repeatDb.js) =====================
  // Aman and the admin call customers who bought before and have not bought again. Its own tables: nothing here touches orders or the COD confirmation numbers.
  const repeatDb = require('./lib/repeatDb'), repeatRules = require('./lib/repeatQueue');
  app.post('/api/cc/repeat/import', inHouseOnly, async (req, res) => {
    try {
      if (req.agent.role !== 'admin') throw new HttpError(403, 'Only the admin can import customers');
      const rows = req.body && req.body.rows;
      if (!Array.isArray(rows) || !rows.length) throw new HttpError(400, 'No rows');
      if (rows.length > 1000) throw new HttpError(400, 'Send at most 1000 customers at a time');
      res.json(await repeatDb.importRows(db, rows));
    } catch (err) { sendError(res, err); }
  });
  app.get('/api/cc/repeat/queue', inHouseOnly, async (req, res) => {
    try { res.json({ dispositions: repeatRules.DISPOSITIONS, ...(await repeatDb.queue(db, String(req.query.filter || 'ready'))) }); } catch (err) { sendError(res, err); }
  });
  app.post('/api/cc/repeat/:id/call', inHouseOnly, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10); if (!id) throw new HttpError(400, 'Invalid customer');
      res.json(await repeatDb.logCall(db, id, req.body || {}, req.agent.display_name));
    } catch (err) { sendError(res, err.status && !(err instanceof HttpError) ? new HttpError(err.status, err.message) : err); }       // the library's own messages (for example "Enter the order number for the sale") reach the screen
  });
  // The WhatsApp button: opens the customer's chat on the company number with the text below, and records that it was sent so the same customer is not messaged twice by mistake.
  app.post('/api/cc/repeat/:id/whatsapp', inHouseOnly, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10); if (!id) throw new HttpError(400, 'Invalid customer');
      const c = await repeatDb.markWhatsApp(db, id); if (!c) throw new HttpError(404, 'Customer not found');
      res.json({ ok: true, phone: c.phone10 });
    } catch (err) { sendError(res, err); }
  });
  app.get('/api/cc/repeat/report', inHouseOnly, async (req, res) => {
    try { const r = parseRange(req.query); res.json(await repeatDb.report(db, r.from, r.to)); } catch (err) { sendError(res, err); }
  });

  app.post('/api/cc/leads/reassign', inHouseOnly, async (req, res) => {
    try {
      const ids = idList(req.body?.ids);
      const to = req.body?.to === 'CC' ? 'CC' : req.body?.to === 'InHouse' ? 'InHouse' : null;
      if (!to) throw new HttpError(400, 'Choose Aman or the call centre');
      const moved = await db(
        `UPDATE orders_master SET assigned_to = $2, assigned_agent = NULL, lead_locked_by = NULL, lead_locked_at = NULL, updated_at = NOW()
         WHERE id = ANY($1) AND confirmation_status = 'pending' AND COALESCE(dnc, FALSE) = FALSE AND assigned_to <> $2
           AND (lead_locked_by IS NULL OR lead_locked_at < NOW() - ($3 || ' minutes')::interval) RETURNING id`,
        [ids, to, String(CONFIG.LEAD_LOCK_MINUTES)]);
      if (moved.length) {
        await db(`INSERT INTO order_status_events (order_id, event_type, old_value, new_value, actor, notes)
                  SELECT unnest($1::uuid[]), 'reassigned', $2, $3, $4, 'Moved from the Lead Workbench'`,
          [moved.map(m => m.id), to === 'CC' ? 'InHouse' : 'CC', to, req.agent.display_name]);
      }
      console.log(`[Workbench] ${req.agent.display_name} moved ${moved.length} of ${ids.length} order(s) to ${to}`);
      res.json({ moved: moved.length, skipped: ids.length - moved.length });
    } catch (err) { sendError(res, err); }
  });

  app.post('/api/cc/leads/callback', inHouseOnly, async (req, res) => {
    try {
      const ids = idList(req.body?.ids);
      const v = validateCallback(req.body?.callback_at);
      if (!v.ok) throw new HttpError(400, v.error);
      const note = clean(req.body?.note, 300) || null;
      const done = await db(
        `UPDATE orders_master SET callback_at = $2, callback_note = $3, updated_at = NOW()
         WHERE id = ANY($1) AND confirmation_status = 'pending' AND COALESCE(dnc, FALSE) = FALSE RETURNING id`, [ids, v.when, note]);
      if (done.length) {
        await db(`INSERT INTO order_status_events (order_id, event_type, old_value, new_value, actor, notes)
                  SELECT unnest($1::uuid[]), 'callback_scheduled', NULL, $2, $3, $4`,
          [done.map(d => d.id), v.when.toISOString(), req.agent.display_name, note || 'Scheduled from the Lead Workbench']);
      }
      res.json({ updated: done.length, skipped: ids.length - done.length });
    } catch (err) { sendError(res, err); }
  });

  // Sends DNP / unreachable leads (by order date) back into the calling queue. Body: { status, from, to, assign, dry_run }.
  app.post('/api/cc/requeue', inHouseOnly, async (req, res) => {
    try {
      const status = req.body?.status;
      if (!['dnp', 'unreachable'].includes(status)) throw new HttpError(400, 'Only DNP or unreachable leads can be sent back');
      const assign = ['inhouse', 'cc', 'keep'].includes(req.body?.assign) ? req.body.assign : 'inhouse';
      const r = rangeOrFail(req.body || {}, false);
      if (!r.start) throw new HttpError(400, 'Choose a From and To date first');
      if (!(await balanceDb.hasRequeueColumn(db))) {
        throw new HttpError(409, 'One-time setup needed: run "node migrate.js --apply" in the Railway Console, then try again.');
      }
      const base = `FROM (SELECT o.*, COALESCE(o.shopify_created_at, o.created_at) AS order_date,
                          (SELECT g.disposition FROM lead_call_log g WHERE g.order_id = o.id AND g.disposition <> 'note' ORDER BY g.created_at DESC LIMIT 1) AS last_disposition
                        FROM orders_master o) x
                    WHERE ${statusCondition(status)} AND x.order_date >= $1 AND x.order_date < $2
                      AND x.order_status = 'new' AND x.payment_method = 'COD' AND x.dnc = FALSE`;
      const params = [r.start, r.end];
      const total = (await dbOne(`SELECT COUNT(*)::int AS n ${base}`, params)).n;
      if (req.body?.dry_run) return res.json({ count: total, from: r.from, to: r.to });
      const assignSql = assign === 'inhouse' ? `, assigned_to = 'InHouse'` : assign === 'cc' ? `, assigned_to = 'CC'` : '';
      const moved = await db(
        `UPDATE orders_master SET confirmation_status = 'pending', unreachable_at = NULL, requeued_at = NOW(), callback_at = NULL, callback_note = NULL,
                lead_locked_by = NULL, lead_locked_at = NULL, updated_at = NOW()${assignSql}
         WHERE id IN (SELECT x.id ${base} ORDER BY x.order_date ASC LIMIT 3000) RETURNING id`, params);
      if (moved.length) {
        await db(`INSERT INTO order_status_events (order_id, event_type, old_value, new_value, actor, notes)
                  SELECT unnest($1::uuid[]), 'requeued', $2, 'pending', $3, $4`,
          [moved.map(m => m.id), status, req.agent.display_name, `Sent back to calling (${assign === 'keep' ? 'same team' : assign === 'inhouse' ? 'in-house team' : 'call centre'})`]);
      }
      console.log(`[Requeue] ${req.agent.display_name} sent ${moved.length} ${status} lead(s) back to calling (${assign})`);
      res.json({ moved: moved.length, matched: total });
    } catch (err) { sendError(res, err); }
  });

  // ---------------------------------------------------------------- REPORTS (admin only)
  function parseRange(q) {
    const re = /^\d{4}-\d{2}-\d{2}$/;
    const from = re.test(q.from || '') ? q.from : istToday();
    const to = re.test(q.to || '') ? q.to : from;
    const start = new Date(`${from}T00:00:00+05:30`);
    const end = new Date(new Date(`${to}T00:00:00+05:30`).getTime() + 24 * 3600 * 1000);
    if (isNaN(start) || isNaN(end) || end <= start) throw new HttpError(400, 'Invalid date range');
    if (end - start > 366 * 24 * 3600 * 1000) throw new HttpError(400, 'Date range cannot exceed one year');
    return { from, to, start, end, agent: clean(q.agent, 80) || null };
  }
  const wantsCsv = (req) => String(req.query.format || '').toLowerCase() === 'csv';
  function sendCsv(res, name, columns, rows) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(toCsv(columns, rows));
  }

  app.get('/api/reports/agent-daily', async (req, res) => {
    try {
      const r = parseRange(req.query);
      const params = [r.start, r.end, cfg.CALL_DISPOSITIONS];
      let agentSql = '';
      if (r.agent) { params.push(r.agent); agentSql = ` AND agent_name = $${params.length}`; }

      const rows = await db(
        `SELECT agent_name, (created_at AT TIME ZONE 'Asia/Kolkata')::date::text AS day, disposition, COUNT(*)::int AS n
         FROM lead_call_log WHERE created_at >= $1 AND created_at < $2 AND disposition = ANY($3)${agentSql}
         GROUP BY 1,2,3`, params);

      const iParams = [r.start, r.end];
      let iAgent = '';
      if (r.agent) { iParams.push(r.agent); iAgent = ` AND agent_name = $3`; }
      const inc = await db(
        `SELECT agent_name, (credited_at AT TIME ZONE 'Asia/Kolkata')::date::text AS day, COUNT(*)::int AS n
         FROM agent_incentives WHERE credited_at >= $1 AND credited_at < $2${iAgent} GROUP BY 1,2`, iParams);

      const byAgent = new Map(), byDay = new Map(), totals = {};
      const add = (map, key, disp, n) => { if (!map.has(key)) map.set(key, {}); const o = map.get(key); o[disp] = (o[disp] || 0) + n; };
      const incAgent = new Map(), incDay = new Map();
      let incTotal = 0;
      rows.forEach(x => { add(byAgent, x.agent_name, x.disposition, x.n); add(byDay, x.day, x.disposition, x.n); totals[x.disposition] = (totals[x.disposition] || 0) + x.n; });
      inc.forEach(x => {
        incAgent.set(x.agent_name, (incAgent.get(x.agent_name) || 0) + x.n);
        incDay.set(x.day, (incDay.get(x.day) || 0) + x.n);
        incTotal += x.n;
      });
      const agentNames = new Set([...byAgent.keys(), ...incAgent.keys()]);
      const dayKeys = new Set([...byDay.keys(), ...incDay.keys()]);

      const out = {
        from: r.from, to: r.to, agent: r.agent,
        totals: buildReport(totals, incTotal),
        by_agent: [...agentNames].sort().map(n => ({ agent_name: n, ...buildReport(byAgent.get(n) || {}, incAgent.get(n) || 0) })),
        by_day: [...dayKeys].sort().map(d => ({ day: d, ...buildReport(byDay.get(d) || {}, incDay.get(d) || 0) })),
      };

      if (wantsCsv(req)) {
        const cols = ['group', 'total_attempts', 'connected_calls', 'confirmed', 'cancelled', 'dnp', 'callbacks', 'address_fixes',
          'wrong_numbers', 'escalations', 'prepaid_conversions', 'connectivity_pct', 'cancelled_pct'];
        const csvRows = [
          { group: 'ALL', ...out.totals },
          ...out.by_agent.map(a => ({ group: `agent:${a.agent_name}`, ...a })),
          ...out.by_day.map(d => ({ group: `day:${d.day}`, ...d })),
        ];
        return sendCsv(res, `daily-report_${r.from}_${r.to}.csv`, cols, csvRows);
      }
      res.json(out);
    } catch (err) { sendError(res, err); }
  });

  // ===================== LEAD FUNNEL (ORDER-CENTRIC) =====================
  // One engine (lib/funnel.js) feeds the CC page, Aman page, admin page and the Excel report, so they always match.
  // Counts COD orders only (prepaid orders are never called), no test orders, and real calls only (no notes / link-sent rows).
  const TEST_NAME_SQL = `(LOWER(TRIM(COALESCE(o.customer_name,''))) IN ('test test','test','test order','dummy') OR COALESCE(o.customer_name,'') ~* '^\\s*test\\M')`;
  const teamList = (team) => (team === 'CC' ? ['CC'] : team === 'InHouse' ? ['InHouse'] : ['CC', 'InHouse']);

  // Real tea orders only: contains one of our products (or the selected one) and is at least MIN_PRICE.
  const ITEMS_SQL = `(CASE WHEN jsonb_typeof(o.line_items) = 'array' THEN o.line_items ELSE '[]'::jsonb END)`;
  const productPrefixes = (key) => { const p = key ? productsLib.productByKey(key) : null; return p ? [p.prefix] : productsLib.ALLOWED_PREFIXES; };

  async function fetchCohort(r, team, productKey) {
    const rows = await fetchCohortRows(r, team, productKey);
    rows.forEach(o => { o.skus = productsLib.skusOf(o.items); });
    return rows;
  }
  // The decider of an order. Owner 2026-11-26: a customer who taps Change address on WhatsApp, and whose address is then fixed, is a WhatsApp confirmation (confirmed + change address): the order is credited to WhatsApp, not to the caller who typed the address.
  let cohortWaAddr = true;
  async function fetchCohortRows(r, team, productKey) {
    const run = (withWa) => db(
      `SELECT o.id, o.order_name, o.total_price AS amount, o.assigned_to AS team,
              COALESCE((SELECT jsonb_agg(jsonb_build_object('t', li->>'title', 'q', COALESCE(NULLIF(li->>'quantity','')::int, 1))) FROM jsonb_array_elements(${ITEMS_SQL}) li), '[]'::jsonb) AS items, o.confirmation_status AS status, o.order_status, COALESCE(o.dnc,FALSE) AS dnc, o.callback_at,
              COALESCE(o.address_is_short,FALSE) AS short, COALESCE(o.address_fixed,FALSE) AS fixed, COALESCE(o.address_locked,FALSE) AS locked,
              COALESCE(o.is_duplicate,FALSE) AS is_duplicate,
              (COALESCE(o.shopify_created_at, o.created_at) AT TIME ZONE 'Asia/Kolkata')::date::text AS day,
              COALESCE(o.shopify_created_at, o.created_at) AS order_at,
              COALESCE(o.confirmed_at, o.cancelled_at) AS decided_at,
              COALESCE(c.d, '{}') AS calls, COALESCE(c.t, '{}') AS call_times,
              (o.shipped_at IS NOT NULL OR COALESCE(o.order_status,'') IN ('shipped','delivered','rto')) AS shipped,
              (COALESCE(o.order_status,'') = 'rto' OR o.rto_status IS NOT NULL) AS rto,
              ${withWa ? `CASE WHEN (o.confirmation_status = 'confirmed' AND EXISTS (SELECT 1 FROM wa_events w WHERE w.order_id = o.id AND w.event = 'clicked_change_address')) THEN 'whatsapp' ELSE dec.actor END AS actor, CASE WHEN (o.confirmation_status = 'confirmed' AND EXISTS (SELECT 1 FROM wa_events w WHERE w.order_id = o.id AND w.event = 'clicked_change_address')) THEN NULL ELSE dec.role END AS actor_role` : 'dec.actor AS actor, dec.role AS actor_role'}
       FROM orders_master o
       LEFT JOIN LATERAL (
         SELECT array_agg(g.disposition ORDER BY g.created_at) AS d, array_agg(g.created_at ORDER BY g.created_at) AS t
         FROM lead_call_log g WHERE g.order_id = o.id AND g.disposition = ANY($3)) c ON TRUE
       LEFT JOIN LATERAL (
         SELECT e.actor, (SELECT ag.role FROM agents ag WHERE ag.display_name = e.actor ORDER BY ag.is_active DESC, ag.role LIMIT 1) AS role FROM order_status_events e
         WHERE e.order_id = o.id AND e.event_type IN ('confirmed','cancelled') ORDER BY e.created_at DESC LIMIT 1) dec ON TRUE
       WHERE COALESCE(o.shopify_created_at, o.created_at) >= $1 AND COALESCE(o.shopify_created_at, o.created_at) < $2
         AND o.assigned_to = ANY($4) AND UPPER(COALESCE(o.payment_method,'')) = 'COD' AND COALESCE(o.converted_to_prepaid,FALSE) = FALSE AND NOT ${TEST_NAME_SQL}
         AND o.total_price >= $5
         AND EXISTS (SELECT 1 FROM jsonb_array_elements(${ITEMS_SQL}) li, unnest($6::text[]) p WHERE starts_with(COALESCE(li->>'title',''), p))`,
      [r.start, r.end, cfg.CALL_DISPOSITIONS, teamList(team), productsLib.MIN_PRICE, productPrefixes(productKey)]);
    if (cohortWaAddr) { try { return await run(true); } catch (e) { if (!/wa_events/.test(String(e && e.message))) throw e; cohortWaAddr = false; } }      // an older database without the WhatsApp tables
    return run(false);
  }

  // Prepaid orders placed on each order date, with the same real-tea, minimum-price and no-test rules as the COD cohort. They are never called,
  // so they are not in the COD cohort; the end-to-end table needs them to show total orders = prepaid + COD. Any team when no team is chosen.
  async function fetchPrepaidByDay(r, team, productKey) {
    const ots = `COALESCE(o.shopify_created_at, o.created_at)`;
    const params = [r.start, r.end, productsLib.MIN_PRICE, productPrefixes(productKey)];
    if (team) params.push(teamList(team));
    const rows = await db(
      `SELECT (${ots} AT TIME ZONE 'Asia/Kolkata')::date::text AS day, COUNT(*)::int AS n FROM orders_master o
       WHERE ${ots} >= $1 AND ${ots} < $2 AND (UPPER(COALESCE(o.payment_method,'')) <> 'COD' OR COALESCE(o.converted_to_prepaid,FALSE)) AND NOT ${TEST_NAME_SQL}
         AND o.total_price >= $3 AND EXISTS (SELECT 1 FROM jsonb_array_elements(${ITEMS_SQL}) li, unnest($4::text[]) p WHERE starts_with(COALESCE(li->>'title',''), p))${team ? ' AND o.assigned_to = ANY($5)' : ''}
       GROUP BY 1`, params);
    return Object.fromEntries(rows.map(x => [x.day, x.n]));
  }
  const todayIst = () => new Date().toLocaleDateString('en-CA', { timeZone: cfg.TIMEZONE });

  async function buildLeadFunnel(r, team) {
    const safeTeam = team === 'CC' ? 'CC' : team === 'InHouse' ? 'InHouse' : null;
    const f = funnelLib.buildFunnel(await fetchCohort(r, safeTeam));
    const a = f.attempts;
    return {
      from: r.from, to: r.to, team: safeTeam || 'all',
      ...f,
      leads_attempted: f.attempted, not_called: f.not_attempted, total_connected: f.connected,
      overall_connectivity_pct: f.connected_pct,
      attempt_1_total: a[1].total, attempt_1_connected: a[1].connected, attempt_1_dnp: a[1].dnp,
      attempt_1_connectivity_pct: funnelLib.pct(a[1].connected, f.total_orders), attempt_1_coverage_pct: funnelLib.pct(a[1].total, f.total_orders),
      attempt_2_total: a[2].total, attempt_2_connected: a[2].connected, attempt_2_dnp: a[2].dnp,
      attempt_3_total: a[3].total, attempt_3_connected: a[3].connected, attempt_3_dnp: a[3].dnp,
      tat_order_to_1st_connect: f.tat.order_to_1st, tat_1st_to_2nd_connect: f.tat.first_to_2nd,
      tat_2nd_to_3rd_connect: f.tat.second_to_3rd, tat_order_to_decision: f.tat.order_to_decision,
      tat_order_to_1st_connect_fmt: f.tat_fmt.order_to_1st, tat_1st_to_2nd_connect_fmt: f.tat_fmt.first_to_2nd,
      tat_2nd_to_3rd_connect_fmt: f.tat_fmt.second_to_3rd, tat_order_to_decision_fmt: f.tat_fmt.order_to_decision,
    };
  }

  // Funnel + lead board + per-day table for one date range. Team follows the login:
  // call-centre agents always see CC; Aman and admin pick cc / inhouse / all.
  app.get('/api/cc/funnel', async (req, res) => {
    try {
      const r = parseRange(req.query);
      let team = req.agent.role === 'agent' ? 'CC' : ({ cc: 'CC', inhouse: 'InHouse' }[req.query.team] || null);
      const product = productsLib.productByKey(req.query.product) ? req.query.product : null;
      const rows = await fetchCohort(r, team, product);
      const [since, skipped] = await Promise.all([
        db(`SELECT CASE WHEN a.role = 'agent' THEN 'CC' ELSE 'InHouse' END AS team, MIN(g.created_at) AS first_call
            FROM lead_call_log g JOIN agents a ON a.id = g.agent_id WHERE g.disposition = ANY($1) GROUP BY 1`, [cfg.CALL_DISPOSITIONS]),
        dbOne(`SELECT COUNT(*) FILTER (WHERE (UPPER(COALESCE(o.payment_method,'')) <> 'COD' OR COALESCE(o.converted_to_prepaid,FALSE)) AND NOT ${TEST_NAME_SQL})::int AS prepaid,
                      COUNT(*) FILTER (WHERE ${TEST_NAME_SQL})::int AS test,
                      COUNT(*) FILTER (WHERE UPPER(COALESCE(o.payment_method,'')) = 'COD' AND COALESCE(o.converted_to_prepaid,FALSE) = FALSE AND NOT ${TEST_NAME_SQL} AND (o.total_price < $4
                        OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(${ITEMS_SQL}) li, unnest($5::text[]) p WHERE starts_with(COALESCE(li->>'title',''), p))))::int AS other_products
               FROM orders_master o
               WHERE COALESCE(o.shopify_created_at, o.created_at) >= $1 AND COALESCE(o.shopify_created_at, o.created_at) < $2 AND o.assigned_to = ANY($3)`,
          [r.start, r.end, teamList(team), productsLib.MIN_PRICE, productsLib.ALLOWED_PREFIXES]),
      ]);
      const calling_since = {};
      since.forEach(s => { calling_since[s.team] = new Date(s.first_call).toLocaleDateString('en-CA', { timeZone: cfg.TIMEZONE }); });
      // Prepaid orders are never called, so they are not in the COD funnel; shown on their own.
      const prepaid = await dbOne(
        `SELECT COUNT(*)::int AS orders, COALESCE(SUM(o.total_price), 0)::float AS amount, COUNT(*) FILTER (WHERE COALESCE(o.converted_to_prepaid,FALSE))::int AS converted
         FROM orders_master o
         WHERE COALESCE(o.shopify_created_at, o.created_at) >= $1 AND COALESCE(o.shopify_created_at, o.created_at) < $2
           AND o.assigned_to = ANY($3) AND (UPPER(COALESCE(o.payment_method,'')) <> 'COD' OR COALESCE(o.converted_to_prepaid,FALSE)) AND NOT ${TEST_NAME_SQL}
           AND o.total_price >= $4
           AND EXISTS (SELECT 1 FROM jsonb_array_elements(${ITEMS_SQL}) li, unnest($5::text[]) p WHERE starts_with(COALESCE(li->>'title',''), p))`,
        [r.start, r.end, teamList(team), productsLib.MIN_PRICE, productPrefixes(product)]);
      // The order counts (attempted, connected, not connected, confirmed, cancelled, pending) come from the order ledger: COD base, every channel counted, so this page agrees with Home and the Daily report.
      // The older call-only engine still supplies the call facts (call timing, the attempt-by-attempt call results) and the open-lead board.
      let funnel = funnelLib.buildFunnel(rows), fdays = funnelLib.buildDays(rows), bySku = funnelLib.buildBySku(rows);
      try {
        const cr = require('./lib/codReport'), led = require('./lib/ledger').buildLedger(rows, await loadTouches(rows.map(o => o.id)), new Date());
        funnel = { ...funnel, ...cr.funnelFromLedger(led) };
        fdays = fdays.map(d => ({ ...d, ...cr.funnelFromLedger(led.filter(o => o.day === d.day)) }));
        const skuIds = new Map(); rows.forEach(o => (o.skus || []).forEach(s => { if (!skuIds.has(s.key)) skuIds.set(s.key, new Set()); skuIds.get(s.key).add(o.id); }));
        bySku = { ...bySku, rows: bySku.rows.map(x => { const ids = skuIds.get(x.key); if (!ids) return x; const f = cr.funnelFromLedger(led.filter(o => ids.has(o.id))); return { ...x, attempted: f.attempted, connected: f.connected, confirmed: f.confirmed, cancelled: f.cancelled, pending: f.pending, not_connected: f.not_connected,
          attempted_pct: f.attempted_pct, connected_pct: f.connected_pct, confirmed_pct: f.confirmed_pct, cancelled_pct: f.cancelled_pct, not_connected_pct: f.not_connected_pct }; }) };
      } catch (e) { console.error('[Funnel] ledger numbers skipped, showing the older call-only counts:', e.message); }
      res.json({
        from: r.from, to: r.to, team: team || 'all', product, calling_since, prepaid,
        funnel, days: fdays, pipeline: funnelLib.buildPipeline(rows),
        by_sku: bySku,
        products: productsLib.PRODUCTS.map(p => ({ key: p.key, name: p.name })),
        excluded: { prepaid_orders: skipped.prepaid, test_orders: skipped.test, other_products: skipped.other_products, min_price: productsLib.MIN_PRICE },
      });
    } catch (err) { sendError(res, err); }
  });
  // ===================== AUTOPILOT: presence signal and live status =====================
  let apTables = false;
  const apEnsure = async () => { if (!apTables) { await autopilotDb.ensureTables(db); apTables = true; } };
  // Sent by the pages every minute while a person has the CRM open: this is how the system knows who is working.
  app.post('/api/cc/heartbeat', async (req, res) => {
    try { await apEnsure(); await autopilotDb.heartbeat(db, req.agent.id); res.json({ ok: true }); } catch (err) { sendError(res, err); }
  });
  app.get('/api/cc/autopilot/status', async (req, res) => {
    try {
      await apEnsure();
      const s = autopilotLib.settings(), now = new Date();
      const todayKey = now.toLocaleDateString('en-CA', { timeZone: cfg.TIMEZONE });
      const { presence, agents } = await autopilotDb.presenceNow(db, now, s);
      const r = parseRange({ from: todayKey, to: todayKey });
      const [leads, rates, lastRun, moves, cohort] = await Promise.all([
        autopilotDb.loadLeads(db), autopilotDb.firstCallRates(db),
        dbOne(`SELECT ran_at, mode, planned, moved, reasons FROM autopilot_runs ORDER BY ran_at DESC LIMIT 1`),
        db(`SELECT notes AS reason, COUNT(*)::int AS n FROM order_status_events WHERE event_type = 'autopilot_move' AND created_at >= $1 GROUP BY 1`, [r.start]),
        fetchCohortRows(r, req.agent.role === 'agent' ? 'CC' : null, null),
      ]);
      let apConn = null; try { apConn = require('./lib/codReport').connectedAtOf(await loadTouches(cohort.map(o => o.id))); } catch (e) { console.error('[Autopilot] any-channel connectivity skipped:', e.message); }
      const ov = report2Lib.buildReport2(cohort, [], 1, apConn).overview;
      const out = {
        mode: s.mode, in_shift: autopilotLib.shiftOpen(now, s), presence,
        pace: { cc: autopilotLib.pace('CC', leads, presence, rates.cc, now, s), aman: autopilotLib.pace('InHouse', leads, presence, rates.aman, now, s) },
        connectivity: { pct: ov.connectivity_pct, orders: ov.orders, reached: ov.reached, target: s.targetConnectivity },
        moves_today: Object.fromEntries(moves.map(m => [m.reason, m.n])), last_run: lastRun || null,
        rules: { shift: `${s.startHour}:00 to ${s.endHour}:00`, deadline_hour: s.deadlineHour, cutoff_hour: s.cutoffHour, fail_attempts: s.failAttempts, fail_days: s.failDays, fail_hours: s.failHours, overflow_hours: s.overflowHours, aman_new_share: s.amanNewShare },
      };
      if (req.agent.role !== 'agent') out.people = agents.map(a => ({ name: a.display_name, team: a.team, active: !!((a.last_seen_at && now - new Date(a.last_seen_at) <= s.presenceMinutes * 60000) || (a.last_call_at && now - new Date(a.last_call_at) <= s.callMinutes * 60000)), last_seen: a.last_seen_at }));
      res.json(out);
    } catch (err) { sendError(res, err); }
  });
  // ONE report, three blocks that are never mixed:
  //   cohort   = orders PLACED in the dates (by order date): how many were called, picked up, confirmed, cancelled
  //   activity = calls MADE in the dates (by call date): dials, picked up, confirmed on a call, split into calls on this period's orders vs older orders
  //   backlog  = what is open RIGHT NOW (all dates): uncalled by age, not connected, callbacks due
  // Every other screen is a view of the same engine (lib/funnel.js) so the numbers always agree.
  app.get('/api/cc/report', async (req, res) => {
    try {
      const r = parseRange(req.query);
      const team = req.agent.role === 'agent' ? 'CC' : ({ cc: 'CC', inhouse: 'InHouse' }[req.query.team] || null);
      const teamNames = team ? [team] : ['CC', 'InHouse'];
      const teamExpr = `(CASE WHEN a.role = 'agent' THEN 'CC' ELSE 'InHouse' END)`;
      const ots = `COALESCE(o.shopify_created_at, o.created_at)`;
      const rules = `UPPER(COALESCE(o.payment_method,'')) = 'COD' AND NOT ${TEST_NAME_SQL} AND o.total_price >= $3
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(${ITEMS_SQL}) li, unnest($4::text[]) p WHERE starts_with(COALESCE(li->>'title',''), p))`;
      const params = [r.start, r.end, productsLib.MIN_PRICE, productsLib.ALLOWED_PREFIXES, cfg.CONNECTED_DISPOSITIONS, cfg.CALL_DISPOSITIONS, teamNames];
      const measures = `COUNT(*)::int AS calls, COUNT(DISTINCT g.order_id)::int AS orders_dialled,
          COUNT(*) FILTER (WHERE g.disposition = ANY($5))::int AS picked,
          COUNT(*) FILTER (WHERE g.disposition = 'dnp')::int AS no_answer,
          COUNT(DISTINCT g.order_id) FILTER (WHERE g.disposition = 'confirmed')::int AS confirmed,
          COUNT(DISTINCT g.order_id) FILTER (WHERE g.disposition = 'cancelled')::int AS cancelled,
          COUNT(*) FILTER (WHERE g.disposition = 'callback')::int AS callbacks,
          COUNT(*) FILTER (WHERE g.disposition = 'address_fix')::int AS address_fix,
          COUNT(DISTINCT g.order_id) FILTER (WHERE g.disposition = 'wrong_number')::int AS wrong_number,
          COUNT(*) FILTER (WHERE ${ots} >= $1 AND ${ots} < $2)::int AS calls_on_period_orders`;
      const from = `FROM lead_call_log g JOIN agents a ON a.id = g.agent_id JOIN orders_master o ON o.id = g.order_id
         WHERE g.created_at >= $1 AND g.created_at < $2 AND g.disposition = ANY($6) AND ${teamExpr} = ANY($7) AND ${rules}`;

      const now = new Date();
      // Calling began on cfg.CALLING_STARTED_ON (or later for a team whose first logged call is later). Earlier orders have no call history here.
      const dayStart = (d) => new Date(d.toLocaleDateString('en-CA', { timeZone: cfg.TIMEZONE }) + 'T00:00:00+05:30');
      const startCfg = new Date(cfg.CALLING_STARTED_ON + 'T00:00:00+05:30');
      const firstCalls = await db(`SELECT ${teamExpr} AS team, MIN(g.created_at) AS first_call FROM lead_call_log g JOIN agents a ON a.id = g.agent_id WHERE g.disposition = ANY($1) GROUP BY 1`, [cfg.CALL_DISPOSITIONS]);
      const since = {};
      for (const t of ['CC', 'InHouse']) { const f = firstCalls.find(x => x.team === t); since[t] = f ? new Date(Math.max(startCfg.getTime(), dayStart(new Date(f.first_call)).getTime())) : startCfg; }
      const sinceOf = (t) => since[t] || startCfg;
      const earliest = new Date(Math.min(...teamNames.map(t => sinceOf(t).getTime())));
      const backlogRange = { start: new Date(Math.max(now.getTime() - 45 * 864e5, earliest.getTime())), end: new Date(now.getTime() + 864e5) };
      // Why are orders not called yet? Same filters as the cohort; groups follow the agents' Fresh list rules (views.sql).
      const whyQuery = (start, end) => db(`SELECT CASE
              WHEN o.confirmation_status <> 'pending' THEN 'closed_without_call'
              WHEN COALESCE(o.dnc, FALSE) THEN 'dnc'
              WHEN o.callback_at IS NOT NULL THEN 'callback_set'
              WHEN COALESCE(o.is_duplicate, FALSE) THEN 'duplicate'
              WHEN COALESCE(o.is_repeat_customer, FALSE) THEN 'repeat_customer'
              WHEN COALESCE(o.order_status, 'new') <> 'new' OR o.shipped_at IS NOT NULL OR o.awb_number IS NOT NULL THEN 'not_new_or_shipped'
              WHEN EXISTS (SELECT 1 FROM orders_master p WHERE p.customer_phone = o.customer_phone AND p.id <> o.id AND p.created_at < o.created_at AND COALESCE(p.order_status, 'new') <> 'cancelled') THEN 'earlier_order_same_phone'
              ELSE 'ready_in_fresh_list' END AS k, COUNT(*)::int AS n
            FROM orders_master o
            WHERE ${ots} >= $1 AND ${ots} < $2 AND o.assigned_to = ANY($4) AND UPPER(COALESCE(o.payment_method,'')) = 'COD' AND COALESCE(o.converted_to_prepaid, FALSE) = FALSE AND NOT ${TEST_NAME_SQL}
              AND o.total_price >= $5 AND EXISTS (SELECT 1 FROM jsonb_array_elements(${ITEMS_SQL}) li, unnest($6::text[]) p WHERE starts_with(COALESCE(li->>'title',''), p))
              AND NOT EXISTS (SELECT 1 FROM lead_call_log g WHERE g.order_id = o.id AND g.disposition = ANY($3))
            GROUP BY 1`, [start, end, cfg.CALL_DISPOSITIONS, teamNames, productsLib.MIN_PRICE, productsLib.ALLOWED_PREFIXES]);      const [rows, byAgent, total, byCallDay, backlogRows, notCalledWhy, fresh, deciders, hourCalls] = await Promise.all([
        fetchCohortRows(r, team, null),
        db(`SELECT g.agent_name AS name, ${teamExpr} AS team, ${measures} ${from} GROUP BY 1, 2 ORDER BY calls DESC`, params),
        dbOne(`SELECT ${measures} ${from}`, params),
        db(`SELECT (g.created_at AT TIME ZONE 'Asia/Kolkata')::date::text AS day, ${measures} ${from} GROUP BY 1 ORDER BY 1`, params),
        fetchCohortRows(backlogRange, team, null),
        whyQuery(r.start, r.end),
        // How fresh is the data itself?
        req.agent.role === 'agent' ? Promise.resolve(null) : dbOne(
          `SELECT (SELECT MAX(COALESCE(shopify_created_at, created_at)) FROM orders_master) AS last_order,
                  (SELECT MAX(g.created_at) FROM lead_call_log g JOIN agents a ON a.id = g.agent_id WHERE a.role = 'agent' AND g.disposition = ANY($1)) AS last_cc_call,
                  (SELECT MAX(g.created_at) FROM lead_call_log g JOIN agents a ON a.id = g.agent_id WHERE a.role <> 'agent' AND g.disposition = ANY($1)) AS last_aman_call,
                  (SELECT MAX(created_at) FROM order_status_events WHERE actor IN ('whatsapp','whatsapp_late','ivr_call','ivr_late','sheet')) AS last_sheet_event`, [cfg.CALL_DISPOSITIONS]),
        // Who actually confirmed / cancelled on these dates, by name, with the account type(s) that name belongs to.
        req.agent.role === 'agent' ? Promise.resolve([]) : db(
          `SELECT COALESCE(e.actor, '(none)') AS actor, COUNT(DISTINCT e.order_id) FILTER (WHERE e.event_type = 'confirmed')::int AS confirmed,
                  COUNT(DISTINCT e.order_id) FILTER (WHERE e.event_type = 'cancelled')::int AS cancelled,
                  (SELECT array_agg(DISTINCT ag.role) FROM agents ag WHERE ag.display_name = e.actor) AS roles
           FROM order_status_events e JOIN orders_master o ON o.id = e.order_id
           WHERE e.event_type IN ('confirmed','cancelled') AND e.created_at >= $1 AND e.created_at < $2
             AND UPPER(COALESCE(o.payment_method,'')) = 'COD' AND NOT ${TEST_NAME_SQL}
           GROUP BY e.actor ORDER BY COUNT(DISTINCT e.order_id) DESC LIMIT 30`, [r.start, r.end]),
        // Calls made in each India-time hour (any order), for the by-hour analysis.
        db(`SELECT EXTRACT(HOUR FROM g.created_at AT TIME ZONE 'Asia/Kolkata')::int AS hour, COUNT(*)::int AS calls, COUNT(*) FILTER (WHERE g.disposition = ANY($5))::int AS connected,
                   COUNT(*) FILTER (WHERE g.disposition = 'confirmed')::int AS confirmed, COUNT(*) FILTER (WHERE g.disposition = 'dnp')::int AS no_response ${from} GROUP BY 1`, params),
      ]);
      const cohort = funnelLib.buildFunnel(rows);
      // End to end: every order down to the confirmation, with counts and percentages, and the same day by day. A failure here never breaks the rest of the report.
      let e2e = null;
      try { e2e = e2eLib.buildE2E(rows, await fetchPrepaidByDay(r, team, null), { today: todayIst() }); } catch (e) { console.error('[Report] end-to-end table skipped:', e.message); }
      // The end-to-end block the page shows (owner 2026-11-25): COD orders are the base, all four channels count, prepaid is one separate line. The older `e2e` above stays for the control tower and the Excel file.
      let codAll = null, connectedAt = null;
      try {
        const touches = await loadTouches(rows.map(o => o.id));
        const led = require('./lib/ledger').buildLedger(rows, touches, now);
        connectedAt = require('./lib/codReport').connectedAtOf(touches);       // the same "customer answered on any channel" rule for the Overview and the by-day tables below
        codAll = require('./lib/codReport').build(led, await fetchPrepaidByDay(r, team, null), { today: todayIst() });
        // Per order, per channel: did the customer respond on that channel at any time (a key pressed, a tap or reply, an answered call)? One order counts once per channel, even if another channel reached it first. Same COD orders as the ledger (owner 2026-11-27: the IVR and WhatsApp tables).
        const chByDay = require('./lib/ledger').respondedByDay(led), chAny = { total: { orders: 0, aman: 0, cc: 0, ivr: 0, wa: 0 }, by_day: chByDay };
        Object.values(chByDay).forEach(d => Object.keys(chAny.total).forEach(k => { chAny.total[k] += d[k]; }));
        if (codAll) codAll.channel_any = chAny;
      } catch (e) { console.error('[Report] COD end-to-end block skipped:', e.message); }
      const openRows = backlogRows.filter(o => new Date(o.order_at) >= sinceOf(o.team));
      const pipeline = funnelLib.buildPipeline(openRows, now);
      const age = pipeline.fresh_age;
      const freshWhy = Object.fromEntries((await whyQuery(backlogRange.start, backlogRange.end)).map(x => [x.k, x.n]));
      const activity = { ...total, picked_pct: funnelLib.pct(total.picked, total.calls), calls_on_older_orders: total.calls - total.calls_on_period_orders };
      res.json({
        from: r.from, to: r.to, team: team || 'all', generated_at: now.toISOString(),
        calling_since: { call_centre: since.CC.toISOString(), aman: since.InHouse.toISOString(), configured: cfg.CALLING_STARTED_ON },
        cohort, e2e, cod_all: codAll, by_order_day: funnelLib.buildDays(rows),
        analysis: report2Lib.buildReport2(rows, hourCalls, Math.max(1, Math.round((new Date(r.to + 'T00:00:00Z') - new Date(r.from + 'T00:00:00Z')) / 864e5) + 1), connectedAt),
        activity, by_agent: byAgent, by_call_day: byCallDay,
        backlog: { pipeline, uncalled_age: age, fresh_why: freshWhy, window_days: 45 },
        not_called_why: Object.fromEntries(notCalledWhy.map(x => [x.k, x.n])), freshness: fresh, deciders,
        definitions: [
          'Orders placed = real COD tea orders (at least Rs ' + productsLib.MIN_PRICE + ', no test orders, prepaid left out) placed on the chosen dates, by the team they were given to.',
          'Called = the order has at least one real call logged. Connected = the customer spoke on at least one call. Percentages in this block are of orders placed.',
          'Total attempts in block A = every call ever made on those orders up to now, so it can be higher than the calls shown in block B for the same dates (B counts only calls made inside the dates).',
          'Confirmed and cancelled here count only orders decided ON A CALL. Orders confirmed by WhatsApp, IVR or the sheet are listed separately as closed without a call.',
          'Calls made = every real call logged on the chosen dates, on ANY order, new or old. Picked % is of calls made. Calls are never counted as orders.',
          'Calls on this period\'s orders + calls on older orders = calls made. This is why calls made can be far more than orders placed.',
          'Call centre = agents with the agent role. Aman team = Aman and admin logins. Dates are India time.',
          'Open now looks at the last ' + 45 + ' days of orders (never before calling began on ' + cfg.CALLING_STARTED_ON + ') and ignores the dates chosen above.',
        ],
      });
    } catch (err) { sendError(res, err); }
  });
  // ===================== TEAM PERFORMANCE (Aman, call centre, both callers, all channels) =====================
  // Admin and Aman only. The rules live in lib/teamReport.js; this only loads the rows.
  // Every attempt on every channel for these orders, as Map(order id -> [{ t, team: 'aman'|'cc'|'ivr'|'wa', connected }]): caller calls, real IVR calls, WhatsApp and older IVR results from the order history.
  // Used by the Home report (lib/orderFunnel.js) and the 2 PM scorecard (lib/twoPm.js). callRows may be passed when the caller already loaded them.
  async function loadTouches(ids, callRowsIn) {
    const callRows = callRowsIn || (ids.length ? await db(`SELECT g.order_id, g.disposition AS d, g.created_at AS t, CASE WHEN a.role = 'agent' THEN 'cc' ELSE 'aman' END AS team
       FROM lead_call_log g JOIN agents a ON a.id = g.agent_id WHERE g.order_id = ANY($1) AND g.disposition = ANY($2) ORDER BY g.created_at`, [ids, cfg.CALL_DISPOSITIONS]) : []);
    // The standard funnel (lib/orderFunnel.js) counts every attempt on an order: a call by Aman or the call centre, or a real IVR call. A key press on the IVR is a connection.
    const touches = new Map(), CONN = new Set(cfg.CONNECTED_DISPOSITIONS);
    const addTouch = (id, x) => { if (!touches.has(id)) touches.set(id, []); touches.get(id).push(x); };
    callRows.forEach(c => addTouch(c.order_id, { t: new Date(c.t), team: c.team, connected: CONN.has(c.d) }));
    try {
      const hasIvr = ids.length ? (await dbOne(`SELECT to_regclass('ivr_calls') AS t`)).t : null;
      if (hasIvr) (await db(`SELECT order_id, placed_at, (result IS NOT NULL) AS pressed FROM ivr_calls WHERE order_id = ANY($1) AND NOT is_test AND status IN ('placed', 'answered') ORDER BY placed_at`, [ids]))
        .forEach(i => addTouch(i.order_id, { t: new Date(i.placed_at), team: 'ivr', connected: !!i.pressed }));
    } catch (e) { console.error('[Report] could not read the IVR calls, the funnel counts caller calls only:', e.message); }
    // WhatsApp and the older IVR results are attempts too (owner rule 2026-11-22: attempts on ALL channels). They come from the order history written by the sheet sync (actor whatsapp / ivr_call) and,
    // once the WhatsApp bridge is live, from the messages it sent. An order is counted once per channel: a bridge message wins over a history line, and an IVR call record wins over an IVR history line.
    try {
      if (ids.length) {
        const hist = await db(`SELECT e.order_id, e.created_at AS t, e.event_type, e.actor FROM order_status_events e
                               WHERE e.order_id = ANY($1) AND e.actor = ANY($2) AND e.event_type IN ('confirmed', 'cancelled', 'rnr') ORDER BY e.created_at`, [ids, ['whatsapp', 'whatsapp_late', 'ivr_call', 'ivr_late']]);
        const hasIvrCall = new Set([...touches.entries()].filter(([, v]) => v.some(x => x.team === 'ivr')).map(([k]) => k));
        const waMsgs = new Map();
        if ((await dbOne(`SELECT to_regclass('wa_messages') AS t`)).t) {
          (await db(`SELECT order_id, sent_at FROM wa_messages WHERE order_id = ANY($1) AND step <= 4 AND NOT is_test AND sent_at IS NOT NULL ORDER BY sent_at`, [ids]))
            .forEach(m => { if (!waMsgs.has(m.order_id)) waMsgs.set(m.order_id, []); waMsgs.get(m.order_id).push({ t: new Date(m.sent_at), team: 'wa', connected: false }); });
        }
        const waReplied = new Set();
        hist.forEach(h => {
          const wa = h.actor === 'whatsapp' || h.actor === 'whatsapp_late';
          if (wa) {
            if (h.event_type === 'rnr') return;
            if (waMsgs.has(h.order_id)) waReplied.add(h.order_id);
            else if (!touches.has(h.order_id) || !touches.get(h.order_id).some(x => x.team === 'wa')) addTouch(h.order_id, { t: new Date(h.t), team: 'wa', connected: true });
          } else if (!hasIvrCall.has(h.order_id)) {
            if (!touches.get(h.order_id) || !touches.get(h.order_id).some(x => x.team === 'ivr' && x.hist)) addTouch(h.order_id, { t: new Date(h.t), team: 'ivr', connected: h.event_type !== 'rnr', hist: true });
          }
        });
        // Owner rule 2026-11-27: a customer who TAPPED a button or REPLIED on WhatsApp is connected, whether or not the tap changed the order (a Cancel tap that only sets a follow-up, a Confirm tap after a call already confirmed it).
        // Same events and same messages as the WhatsApp report (steps 0 to 4, no test messages), so both pages count the same orders.
        if (waMsgs.size) {
          try {
            (await db(`SELECT DISTINCT m.order_id FROM wa_events e JOIN wa_messages m ON m.send_id = e.send_id
                       WHERE m.order_id = ANY($1) AND m.step <= 4 AND NOT m.is_test AND e.event IN ('clicked_confirm', 'clicked_cancel', 'clicked_change_address', 'replied_text')`, [ids])).forEach(x => waReplied.add(x.order_id));
          } catch (e) { console.error('[Report] WhatsApp taps not read, only status changes count as WhatsApp answers:', e.message); }
        }
        waMsgs.forEach((list, id) => { if (waReplied.has(id)) list[list.length - 1].connected = true; list.forEach(x => addTouch(id, x)); });
      }
    } catch (e) { console.error('[Report] could not read the WhatsApp and IVR history, the funnel counts calls only:', e.message); }
    return touches;
  }
  async function loadTeamReport(r) {
    const rows = await fetchCohortRows(r, null, null);
    const ids = rows.map(o => o.id);
    const callRows = ids.length ? await db(
      `SELECT g.order_id, g.disposition AS d, g.created_at AS t, g.agent_name AS agent, CASE WHEN a.role = 'agent' THEN 'cc' ELSE 'aman' END AS team
       FROM lead_call_log g JOIN agents a ON a.id = g.agent_id WHERE g.order_id = ANY($1) AND g.disposition = ANY($2) ORDER BY g.created_at`, [ids, cfg.CALL_DISPOSITIONS]) : [];
    const callsMap = new Map();
    callRows.forEach(c => { if (!callsMap.has(c.order_id)) callsMap.set(c.order_id, []); callsMap.get(c.order_id).push({ d: c.d, t: new Date(c.t), team: c.team, agent: c.agent }); });
    const touches = await loadTouches(ids, callRows);
    const params = [r.start, r.end, productsLib.MIN_PRICE, productsLib.ALLOWED_PREFIXES, cfg.CONNECTED_DISPOSITIONS, cfg.CALL_DISPOSITIONS];
    const day = `(g.created_at AT TIME ZONE 'Asia/Kolkata')::date`;
    const teamExpr = `(CASE WHEN a.role = 'agent' THEN 'cc' ELSE 'aman' END)`;
    const measures = `COUNT(*)::int AS calls, COUNT(DISTINCT g.order_id)::int AS orders_dialled, COUNT(*) FILTER (WHERE g.disposition = ANY($5))::int AS picked, COUNT(*) FILTER (WHERE g.disposition = 'dnp')::int AS dnp,
        COUNT(DISTINCT g.order_id) FILTER (WHERE g.disposition = 'confirmed')::int AS confirmed, COUNT(DISTINCT g.order_id) FILTER (WHERE g.disposition = 'cancelled')::int AS cancelled,
        COUNT(*) FILTER (WHERE g.disposition = 'callback')::int AS callbacks, COUNT(*) FILTER (WHERE g.disposition = 'address_fix')::int AS address_fix,
        COUNT(DISTINCT g.order_id) FILTER (WHERE g.disposition = 'wrong_number')::int AS wrong, COUNT(DISTINCT ${day})::int AS active_days`;
    const from = `FROM lead_call_log g JOIN agents a ON a.id = g.agent_id JOIN orders_master o ON o.id = g.order_id
       WHERE g.created_at >= $1 AND g.created_at < $2 AND g.disposition = ANY($6) AND UPPER(COALESCE(o.payment_method,'')) = 'COD' AND NOT ${TEST_NAME_SQL} AND o.total_price >= $3
         AND EXISTS (SELECT 1 FROM jsonb_array_elements(${ITEMS_SQL}) li, unnest($4::text[]) p WHERE starts_with(COALESCE(li->>'title',''), p))`;
    const [agents, teams, all, days] = await Promise.all([
      db(`SELECT g.agent_name AS agent, ${teamExpr} AS team, ${measures} ${from} GROUP BY 1, 2`, params),
      db(`SELECT ${teamExpr} AS team, ${measures} ${from} GROUP BY 1`, params),
      dbOne(`SELECT ${measures} ${from}`, params),
      db(`SELECT ${teamExpr} AS team, ${day}::text AS day, COUNT(*)::int AS calls, COUNT(DISTINCT g.order_id)::int AS orders_dialled, COUNT(*) FILTER (WHERE g.disposition = ANY($5))::int AS picked ${from} GROUP BY 1, 2`, params),
    ]);
    const rep = teamReportLib.buildTeamReport(rows, callsMap, { agents, teams, all: all || {}, days }, { now: new Date() });
    rep.funnel = require('./lib/orderFunnel').buildAll(rows, touches);
    return rep;
  }
  // ===================== LEAD AUDIT: every order with no attempt, and why, plus orders the report does not count =====================
  // "No attempt" = no call in the call log (any disposition) and no real IVR call. Same orders as the Home report (same dates, same real-COD-tea rules).
  async function loadLeadAudit(r) {
    const rows = await fetchCohortRows(r, null, null);
    const ids = rows.map(o => o.id);
    const ivrSet = new Set();
    try {
      const has = ids.length ? (await dbOne(`SELECT to_regclass('ivr_calls') AS t`)).t : null;
      if (has) (await db(`SELECT DISTINCT order_id FROM ivr_calls WHERE order_id = ANY($1) AND NOT is_test AND status IN ('placed', 'answered')`, [ids])).forEach(x => ivrSet.add(x.order_id));
    } catch (e) { console.error('[Audit] could not read the IVR calls:', e.message); }
    // Same rule as the Home report: a WhatsApp message or reply, or an IVR result from the sheet, is an attempt too (ivrSet holds every order that had a non-caller attempt).
    try {
      if (ids.length) {
        (await db(`SELECT DISTINCT order_id FROM order_status_events WHERE order_id = ANY($1) AND actor = ANY($2) AND event_type IN ('confirmed', 'cancelled', 'rnr')`, [ids, ['whatsapp', 'whatsapp_late', 'ivr_call', 'ivr_late']])).forEach(x => ivrSet.add(x.order_id));
        if ((await dbOne(`SELECT to_regclass('wa_messages') AS t`)).t) (await db(`SELECT DISTINCT order_id FROM wa_messages WHERE order_id = ANY($1) AND step <= 4 AND NOT is_test AND sent_at IS NOT NULL`, [ids])).forEach(x => ivrSet.add(x.order_id));
      }
    } catch (e) { console.error('[Audit] could not read the WhatsApp history:', e.message); }
    const none =rows.filter(o => !(o.calls || []).length && !ivrSet.has(o.id));
    const info = new Map((none.length ? await db(`SELECT id, order_name, customer_phone, lead_locked_by, lead_locked_at, assigned_agent FROM orders_master WHERE id = ANY($1)`, [none.map(o => o.id)]) : []).map(x => [x.id, x]));
    const audit = require('./lib/leadAudit').build(rows, ivrSet, info);    // Orders that look like real COD tea orders in these dates but belong to nobody the report counts (not Aman, not the call centre): they would never show up in any queue.
    const outside = await db(
      `SELECT COALESCE(o.assigned_to, 'none') AS team, o.confirmation_status AS status, COUNT(*)::int AS n FROM orders_master o
       WHERE COALESCE(o.shopify_created_at, o.created_at) >= $1 AND COALESCE(o.shopify_created_at, o.created_at) < $2
         AND NOT (COALESCE(o.assigned_to, '') = ANY($4)) AND UPPER(COALESCE(o.payment_method,'')) = 'COD' AND COALESCE(o.converted_to_prepaid,FALSE) = FALSE AND NOT ${TEST_NAME_SQL}
         AND o.total_price >= $3 AND EXISTS (SELECT 1 FROM jsonb_array_elements(${ITEMS_SQL}) li, unnest($5::text[]) p WHERE starts_with(COALESCE(li->>'title',''), p))
       GROUP BY 1, 2 ORDER BY 3 DESC`, [r.start, r.end, productsLib.MIN_PRICE, teamList(null), productPrefixes(null)]);
    return { from: r.from, to: r.to, orders: audit.orders, no_attempt: audit.no_attempt, no_attempt_pending: audit.no_attempt_pending,
      reasons: audit.reasons, outside_report: outside, outside_total: outside.reduce((s, x) => s + x.n, 0), list: audit.list };
  }
  // ===================== THE ORDER LEDGER: one row per real COD tea order, and every number of the Home pages added up from it (lib/ledger.js) =====================
  // Admin and Aman. Also returns the automatic checks (do the pages agree?), the prepaid count, and confirmation by order age. as_of = when these numbers were read.
  async function loadLedger(r, withSheetCheck) {
    const ledgerLib = require('./lib/ledger'), funnelLib = require('./lib/orderFunnel');
    const rows = await fetchCohortRows(r, null, null);
    const touches = await loadTouches(rows.map(o => o.id));
    const now = new Date(), led = ledgerLib.buildLedger(rows, touches, now), summary = ledgerLib.summarize(led);
    const prepaidByDay = await fetchPrepaidByDay(r, null, null), prepaid = Object.values(prepaidByDay).reduce((s, n) => s + n, 0);
    let sheetRows = null;
    if (withSheetCheck && r.from === String(r.to).slice(0, 8) + '01' && String(r.to).slice(0, 7) === todayIst().slice(0, 7)) {
      try { const sb = require('./lib/sheetBackup'); if (sb.settings().on) sheetRows = (await sb.readRows(db, now)).filter(x => x[1] >= r.from && x[1] <= r.to).length; } catch (e) { console.error('[Ledger] sheet check skipped:', e.message); }
    }
    const legacy = funnelLib.build(rows, touches, 'overall');
    return { led, rows, touches, summary, prepaid, now, checks: ledgerLib.checks(summary, { legacy, sheet_rows: sheetRows }), age: ledgerLib.byAge(led, now) };
  }
  app.get('/api/cc/ledger', async (req, res) => {
    try {
      if (!['admin', 'aman'].includes(req.agent.role)) throw new HttpError(403, 'Not allowed for your account');
      const r = parseRange(req.query), L = await loadLedger(r, true);
      res.json({ from: r.from, to: r.to, as_of: L.now.toISOString(), orders_total: L.summary.total.leads + L.prepaid, prepaid: L.prepaid, cod: L.summary.total.leads, summary: L.summary, checks: L.checks, age: L.age, definitions: require('./lib/ledger').definitions(cfg.CONNECTED_DISPOSITIONS, cfg.CALL_DISPOSITIONS),
        days: { total: require('./lib/ledger').byDay(L.led), aman: require('./lib/ledger').byDay(L.led, 'aman'), cc: require('./lib/ledger').byDay(L.led, 'cc') },
        responded_by_day: require('./lib/ledger').respondedByDay(L.led) });
    } catch (err) { sendError(res, err); }
  });
  // Road to 95% (owner 2026-11-25): each of the last 7 days' orders, confirmed against the 95 percent goal, with the days each has left and the open orders still not reached (lib/road95.js).
  async function loadRoad() {
    const to = todayIst(), from = new Date(Date.parse(to + 'T00:00:00+05:30') - 6 * 86400e3).toLocaleDateString('en-CA', { timeZone: cfg.TIMEZONE });
    const L = await loadLedger(parseRange({ from, to }), false);
    return { ...require('./lib/road95').build(L.led, L.now), from, to, as_of: L.now.toISOString() };
  }
  app.get('/api/cc/road-to-95', async (req, res) => {
    try {
      if (!['admin', 'aman'].includes(req.agent.role)) throw new HttpError(403, 'Not allowed for your account');
      res.json(await loadRoad());
    } catch (err) { sendError(res, err); }
  });
  // The order-wise sheet: one row per COD order with every attempt, who reached the customer and the result. Filter it to check any number on the Home pages.
  app.get('/api/cc/orders-ledger.csv', async (req, res) => {
    try {
      if (!['admin', 'aman'].includes(req.agent.role)) throw new HttpError(403, 'Not allowed for your account');
      const ledgerLib = require('./lib/ledger'), r = parseRange(req.query), L = await loadLedger(r, false);
      const cell = (v) => { const t = v === null || v === undefined ? '' : String(v); return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
      const csv = [ledgerLib.CSV_HEAD].concat(ledgerLib.csvRows(L.led)).map(row => row.map(cell).join(',')).join('\r\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="Order_wise_${r.from}_to_${r.to}.csv"`);
      res.send('\ufeff' + csv);
    } catch (err) { sendError(res, err); }
  });
  // CRM against Shopify, read only, last 3 days: orders missing in the CRM, cancelled on one side only, confirmed but not tagged. Cached for 10 minutes (Shopify allows few calls).
  let shopifyCheckCache = { at: 0, v: null };
  app.get('/api/cc/shopify-check', async (req, res) => {
    try {
      if (!['admin', 'aman'].includes(req.agent.role)) throw new HttpError(403, 'Not allowed for your account');
      if (shopifyCheckCache.v && Date.now() - shopifyCheckCache.at < 600000 && !req.query.fresh) return res.json(shopifyCheckCache.v);
      const store = process.env.SHOPIFY_STORE_DOMAIN, token = process.env.SHOPIFY_ACCESS_TOKEN, ver = process.env.SHOPIFY_API_VERSION || '2024-10';
      if (!store || !token) return res.json({ configured: false, message: 'SHOPIFY_STORE_DOMAIN or SHOPIFY_ACCESS_TOKEN is not set in the web service.' });
      const axios = require('axios'), since = new Date(Date.now() - 3 * 86400e3).toISOString();
      let url = `https://${store}/admin/api/${ver}/orders.json?status=any&limit=250&fields=id,name,cancelled_at,tags,created_at&created_at_min=${encodeURIComponent(since)}`;
      const shop = [];
      for (let page = 0; page < 6 && url; page++) {
        const resp = await axios.get(url, { headers: { 'X-Shopify-Access-Token': token }, timeout: 20000 });
        shop.push(...((resp.data && resp.data.orders) || []));
        const next = /<([^>]+)>;\s*rel="next"/.exec(String(resp.headers.link || '')); url = next ? next[1] : null;
      }
      const crmRows = shop.length ? await db(`SELECT shopify_order_id::text AS sid, id, order_name, confirmation_status AS status, payment_method FROM orders_master WHERE shopify_order_id::text = ANY($1::text[])`, [shop.map(s => String(s.id))]) : [];
      const out = { configured: true, checked_at: new Date().toISOString(), window_days: 3, ...require('./lib/shopifyCheck').compare(shop, new Map(crmRows.map(x => [x.sid, x]))) };
      shopifyCheckCache = { at: Date.now(), v: out };
      res.json(out);
    } catch (err) { sendError(res, err); }
  });  // ===================== ALL-ATTEMPTS LOG: every attempt on every channel (callers, IVR, WhatsApp), one row each =====================
  // The call log download only has the callers' calls. This one has everything that was tried. Admin and Aman. From/to are the dates of the attempts (India time).
  app.get('/api/cc/attempts-log.csv', async (req, res) => {
    try {
      if (!['admin', 'aman'].includes(req.agent.role)) throw new HttpError(403, 'Not allowed for your account');
      const logLib = require('./lib/attemptsLog'), r = parseRange(req.query), has = async (n) => !!(await dbOne(`SELECT to_regclass('${n}') AS t`)).t;
      const callers = (await db(`SELECT g.created_at AS t, CASE WHEN a.role = 'agent' THEN 'Call centre' ELSE 'Aman' END AS channel, g.agent_name AS "by", g.order_id, o.order_name AS "order", o.customer_phone AS phone,
                                    g.disposition AS result, (g.disposition = ANY($4)) AS connected, g.reason_code AS reason, g.note
                                 FROM lead_call_log g JOIN orders_master o ON o.id = g.order_id LEFT JOIN agents a ON a.id = g.agent_id
                                 WHERE g.created_at >= $1 AND g.created_at < $2 AND g.disposition = ANY($3) ORDER BY g.created_at LIMIT 60000`, [r.start, r.end, cfg.CALL_DISPOSITIONS, cfg.CONNECTED_DISPOSITIONS]));
      const ivr = (await has('ivr_calls')) ? await db(`SELECT i.placed_at AS t, i.order_id, o.order_name AS "order", i.phone, i.result, i.status, (i.result IS NOT NULL) AS connected, i.note
                                 FROM ivr_calls i LEFT JOIN orders_master o ON o.id = i.order_id
                                 WHERE NOT i.is_test AND i.status IN ('placed', 'answered') AND i.placed_at >= $1 AND i.placed_at < $2 ORDER BY i.placed_at LIMIT 60000`, [r.start, r.end]) : [];
      const wa = (await has('wa_messages')) ? await db(`SELECT m.sent_at AS t, m.order_id, o.order_name AS "order", o.customer_phone AS phone, m.step, m.status,
                                    COALESCE((SELECT array_agg(DISTINCT e.event) FROM wa_events e WHERE e.send_id = m.send_id), '{}') AS events
                                 FROM wa_messages m JOIN orders_master o ON o.id = m.order_id
                                 WHERE NOT m.is_test AND m.step <= 4 AND m.sent_at IS NOT NULL AND m.sent_at >= $1 AND m.sent_at < $2 ORDER BY m.sent_at LIMIT 60000`, [r.start, r.end]) : [];
      const rows = logLib.merge({ callers, ivr, wa });
      const cell = (v) => { const t = v === null || v === undefined ? '' : String(v); return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="All_attempts_${r.from}_to_${r.to}.csv"`);
      res.send('\ufeff' + [logLib.HEAD].concat(logLib.csvRows(rows)).map(row => row.map(cell).join(',')).join('\r\n'));
    } catch (err) { sendError(res, err); }
  });
  // ===================== END-TO-END CHECK: orders confirmed in the last 36 hours, a few per channel, followed all the way (lib/pipeline.js) =====================
  let pipelineCache = { at: 0, v: null };
  app.get('/api/cc/pipeline-check', async (req, res) => {
    try {
      if (!['admin', 'aman'].includes(req.agent.role)) throw new HttpError(403, 'Not allowed for your account');
      if (pipelineCache.v && Date.now() - pipelineCache.at < 300000 && !req.query.fresh) return res.json(pipelineCache.v);
      const pipe = require('./lib/pipeline'), now = new Date(), PER = 8;
      const recent = await db(`SELECT o.id, o.order_name, o.shopify_order_id, COALESCE(o.shopify_tag_synced, FALSE) AS tag_synced, fin.actor, fin.role
          FROM orders_master o
          LEFT JOIN LATERAL (SELECT e.actor, ag.role FROM order_status_events e LEFT JOIN agents ag ON ag.display_name = e.actor
                             WHERE e.order_id = o.id AND e.event_type = 'confirmed' ORDER BY e.created_at DESC LIMIT 1) fin ON TRUE
          WHERE o.confirmation_status = 'confirmed' AND o.confirmed_at > NOW() - INTERVAL '36 hours' AND UPPER(COALESCE(o.payment_method, '')) = 'COD' AND NOT ${TEST_NAME_SQL}
          ORDER BY o.confirmed_at DESC LIMIT 600`);
      const picked = {}, samples = [];
      for (const o of recent) { const ch = pipe.channelOf(o.actor, o.role); picked[ch] = (picked[ch] || 0) + 1; if (picked[ch] <= PER) samples.push({ id: o.id, name: o.order_name, channel: ch, tag_synced: !!o.tag_synced, shopify_id: o.shopify_order_id }); }
      const L = await loadLedger({ start: new Date(now.getTime() - 5 * 86400e3), end: new Date(now.getTime() + 3600e3), from: '', to: '' }, false);
      const reportChannel = new Map(L.led.map(x => [x.id, x.decided_by])), attemptTeams = new Map();
      L.touches.forEach((list, id) => attemptTeams.set(id, new Set(list.map(x => x.team))));
      const snap = await require('./lib/shipGateDb').loadSnapshot(db, dbOne), gate = new Map();
      [['ready', snap.r.ready], ['blocked', snap.r.blocked], ['untracked', snap.r.untracked], ['wrong', snap.r.wrong]].forEach(([k, list]) => (list || []).forEach(x => gate.set(x.id, k)));
      let tags = null;
      const store = process.env.SHOPIFY_STORE_DOMAIN, token = process.env.SHOPIFY_ACCESS_TOKEN;
      const ids = samples.filter(s => s.shopify_id && !s.tag_synced).map(s => String(s.shopify_id)).slice(0, 200);
      if (store && token && ids.length) {
        try { const resp = await require('axios').get(`https://${store}/admin/api/${process.env.SHOPIFY_API_VERSION || '2024-10'}/orders.json?ids=${ids.join(',')}&status=any&fields=id,tags&limit=250`, { headers: { 'X-Shopify-Access-Token': token }, timeout: 20000 }); tags = new Map(((resp.data && resp.data.orders) || []).map(x => [String(x.id), x.tags])); }
        catch (e) { console.error('[Pipeline] Shopify tags could not be read:', e.message); }
      }
      const out = { checked_at: now.toISOString(), window_hours: 36, sample_per_channel: PER, shopify_read: !!tags || !ids.length, confirmed_in_window: recent.length, ...pipe.check(samples, { reportIds: new Set(L.led.map(x => x.id)), reportChannel, attemptTeams, gate, tags }) };
      pipelineCache = { at: Date.now(), v: out };
      res.json(out);
    } catch (err) { sendError(res, err); }
  });  // Customers who asked to cancel on the IVR (key 3) or WhatsApp (Cancel): a callback is waiting for a caller (lib/cancelAsks.js). Admin and Aman.
  app.get('/api/cc/cancel-requests', async (req, res) => {
    try {
      if (!['admin', 'aman'].includes(req.agent.role)) throw new HttpError(403, 'Not allowed for your account');
      const rows = await db(`SELECT o.order_name AS "order", o.assigned_to AS team, o.callback_at, o.callback_note,
                                    (SELECT COUNT(*)::int FROM lead_call_log g WHERE g.order_id = o.id AND g.created_at > o.callback_at AND g.disposition = ANY($1)) AS tries_since
                             FROM orders_master o
                             WHERE o.confirmation_status = 'pending' AND o.callback_at IS NOT NULL AND o.callback_at > NOW() - INTERVAL '7 days'
                               AND (o.callback_note ILIKE '%pressed 3%' OR o.callback_note ILIKE '%tapped "Cancel"%') ORDER BY o.callback_at LIMIT 500`, [cfg.CALL_DISPOSITIONS]);
      res.json({ as_of: new Date().toISOString(), ...require('./lib/cancelAsks').summarize(rows, new Date()) });
    } catch (err) { sendError(res, err); }
  });  // ===================== 2 PM SCORECARD: fresh orders confirmed before the 2 PM lock, and the old no-answer leads reached (lib/twoPm.js) =====================
  // Admin and Aman. date = the day to score (India time, default today); also returns the last 7 days up to that day. All numbers count orders (leads), not calls.
  app.get('/api/cc/two-pm', async (req, res) => {
    try {
      if (!['admin', 'aman'].includes(req.agent.role)) throw new HttpError(403, 'Not allowed for your account');
      const twoPm = require('./lib/twoPm');
      const day = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? String(req.query.date) : todayIst();
      const dayMs = new Date(day + 'T00:00:00+05:30').getTime();
      const from = new Date(Math.max(new Date(cfg.CALLING_STARTED_ON + 'T00:00:00+05:30').getTime(), dayMs - 38 * 86400e3));
      const rows = await fetchCohortRows({ start: from, end: new Date(dayMs + 86400e3) }, null, null);
      const touches = await loadTouches(rows.map(o => o.id));
      const days = []; for (let i = 6; i >= 0; i--) { const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - i); days.push(d.toISOString().slice(0, 10)); }
      const now = new Date();
      res.json({ today: twoPm.build(rows, touches, day, now), days: twoPm.buildDays(rows, touches, days, now), orders_considered: rows.length });
    } catch (err) { sendError(res, err); }
  });  // ===================== WHATSAPP REPORT: per message (1st at once, 2nd after 4 hours, 3rd after 8 hours): messaged, delivered, read, confirm / cancel / change address / reply =====================
  // Orders placed in the chosen dates (the same real COD tea orders as the Home report). Counts ORDERS, not messages. Empty until the WhatsApp bridge is live (it records every message).
  // How fast do customers answer the first WhatsApp message? For the IVR wait decision (owner 2026-11-27). Read-only. Per COD order: minutes from the first message to the first tap or reply (any message step), by the hour the message went out.
  app.get('/api/cc/wa-latency', async (req, res) => {
    try {
      if (!['admin', 'aman'].includes(req.agent.role)) throw new HttpError(403, 'Not allowed for your account');
      const r = parseRange(req.query);
      const ids = (await fetchCohortRows(r, null, null)).map(o => o.id);
      if (!ids.length || !(await dbOne(`SELECT to_regclass('wa_messages') AS t`)).t) return res.json({ from: r.from, to: r.to, groups: {} });
      const rows = await db(`WITH fm AS (SELECT order_id, MIN(sent_at) AS s FROM wa_messages WHERE order_id = ANY($1) AND step = 0 AND NOT is_test AND sent_at IS NOT NULL GROUP BY order_id),
                                  fr AS (SELECT e.order_id, MIN(COALESCE(e.at, e.received_at)) AS r FROM wa_events e JOIN wa_messages m ON m.send_id = e.send_id
                                         WHERE e.order_id = ANY($1) AND m.step <= 4 AND NOT m.is_test AND e.event IN ('clicked_confirm', 'clicked_cancel', 'clicked_change_address', 'replied_text') GROUP BY e.order_id)
                             SELECT EXTRACT(HOUR FROM fm.s AT TIME ZONE 'Asia/Kolkata')::int AS hr, CASE WHEN fr.r IS NULL THEN NULL ELSE GREATEST(0, EXTRACT(EPOCH FROM (fr.r - fm.s)) / 60) END AS mins
                             FROM fm LEFT JOIN fr ON fr.order_id = fm.order_id`, [ids]);
      const CUT = [2, 5, 10, 15, 30, 60, 120, 240], pctl = (a, p) => (a.length ? Math.round(a[Math.min(a.length - 1, Math.floor(p * a.length))] * 10) / 10 : null);
      const grp = (list) => { const resp = list.filter(x => x.mins !== null).map(x => Number(x.mins)).sort((a, b) => a - b), n = list.length;
        return { orders_messaged: n, responded: resp.length, responded_pct: n ? Math.round(resp.length * 1000 / n) / 10 : null,
          within_min: Object.fromEntries(CUT.map(c => [c, n ? Math.round(resp.filter(m => m <= c).length * 1000 / n) / 10 : null])),   // % of ALL messaged orders that answered within c minutes
          median_min: pctl(resp, 0.5), p75_min: pctl(resp, 0.75), p90_min: pctl(resp, 0.9) }; };
      const inH = (a, b) => (x) => (a < b ? x.hr >= a && x.hr < b : x.hr >= a || x.hr < b);
      res.json({ from: r.from, to: r.to, groups: { all: grp(rows), morning_7_9: grp(rows.filter(inH(7, 9))), day_9_18: grp(rows.filter(inH(9, 18))), evening_18_22: grp(rows.filter(inH(18, 22))), night_22_7: grp(rows.filter(inH(22, 7))) } });
    } catch (err) { sendError(res, err); }
  });
  app.get('/api/cc/wa-report', async (req, res) => {
    try {
      if (!['admin', 'aman'].includes(req.agent.role)) throw new HttpError(403, 'Not allowed for your account');
      const r = parseRange(req.query);
      const rows = await fetchCohortRows(r, null, null), ids = rows.map(o => o.id);
      const has = ids.length ? (await dbOne(`SELECT to_regclass('wa_messages') AS t`)).t : null;
      const LABEL = ['Message 1: sent at once', 'Message 2: 4 hours later', 'Message 3: 8 hours after the first', 'Message 4: the next morning', 'Message 5: the morning after'];
      let steps = [], messaged = 0, confirmedByWa = 0, responses = null, respByStep = {}, answeredOfMessaged = {};
      if (has) {
        steps = await db(`SELECT m.step,
            COUNT(DISTINCT m.order_id) FILTER (WHERE m.sent_at IS NOT NULL)::int AS sent,
            COUNT(DISTINCT m.order_id) FILTER (WHERE m.delivered_at IS NOT NULL)::int AS delivered,
            COUNT(DISTINCT m.order_id) FILTER (WHERE m.read_at IS NOT NULL)::int AS read,
            COUNT(DISTINCT m.order_id) FILTER (WHERE m.status = 'failed')::int AS failed,
            COUNT(DISTINCT m.order_id) FILTER (WHERE e.event = 'clicked_confirm')::int AS confirm,
            COUNT(DISTINCT m.order_id) FILTER (WHERE (e.event = 'clicked_confirm' AND e.applied = 'confirmed_order')
              OR (e.event = 'clicked_change_address' AND o.confirmation_status = 'confirmed' AND e.id = (SELECT MIN(y.id) FROM wa_events y WHERE y.order_id = m.order_id AND y.event = 'clicked_change_address')
                  AND NOT EXISTS (SELECT 1 FROM wa_events x WHERE x.order_id = m.order_id AND x.event = 'clicked_confirm' AND x.applied = 'confirmed_order')))::int AS confirmed_here,
            COUNT(DISTINCT m.order_id) FILTER (WHERE e.event = 'clicked_cancel')::int AS cancel,
            COUNT(DISTINCT m.order_id) FILTER (WHERE e.event = 'clicked_change_address')::int AS change_address,
            COUNT(DISTINCT m.order_id) FILTER (WHERE e.event = 'replied_text')::int AS replied
          FROM wa_messages m JOIN orders_master o ON o.id = m.order_id LEFT JOIN wa_events e ON e.send_id = m.send_id
          WHERE m.order_id = ANY($1) AND m.step <= 4 AND NOT m.is_test GROUP BY m.step ORDER BY m.step`, [ids]);
        messaged = (await dbOne(`SELECT COUNT(DISTINCT order_id)::int AS n FROM wa_messages WHERE order_id = ANY($1) AND step <= 4 AND NOT is_test AND sent_at IS NOT NULL`, [ids])).n || 0;
        // Confirmed on WhatsApp = the customer tapped Confirm (and the order was confirmed by it) + the customer tapped Change address and the order is confirmed now (owner 2026-11-26). An order counts once.
        confirmedByWa = (await dbOne(`SELECT COUNT(DISTINCT e.order_id)::int AS n FROM wa_events e JOIN orders_master o ON o.id = e.order_id WHERE e.order_id = ANY($1)
          AND ((e.event = 'clicked_confirm' AND e.applied = 'confirmed_order') OR (e.event = 'clicked_change_address' AND o.confirmation_status = 'confirmed'))`, [ids])).n || 0;
        // Responses (owner 2026-11-26): how many ORDERS answered, whichever message they answered. Every figure is a share of all the COD orders placed on these dates, never of the messages sent.
        // Each ORDER that answered is counted ONCE, in the first of these that applies: Cancel, Change address, Confirm, reply only. So the four lines add up to the total (cat_*). The tap counts (confirm_tap ...) are overlapping: one order can do several things.
        responses = await dbOne(`SELECT COUNT(*) FILTER (WHERE c)::int AS cat_cancel, COUNT(*) FILTER (WHERE a AND NOT c)::int AS cat_change, COUNT(*) FILTER (WHERE k AND NOT c AND NOT a)::int AS cat_confirm,
            COUNT(*) FILTER (WHERE r AND NOT c AND NOT a AND NOT k)::int AS cat_reply_only, COUNT(*)::int AS any_response,
            COUNT(*) FILTER (WHERE k)::int AS confirm_tap, COUNT(*) FILTER (WHERE c)::int AS cancel_tap, COUNT(*) FILTER (WHERE a)::int AS change_tap, COUNT(*) FILTER (WHERE r)::int AS replied,
            COUNT(*) FILTER (WHERE a AND st = 'confirmed')::int AS change_now_confirmed, COUNT(*) FILTER (WHERE c AND st = 'cancelled')::int AS cancel_now_cancelled,
            COUNT(*) FILTER (WHERE k AND ok)::int AS confirm_by_tap, COUNT(*) FILTER (WHERE k AND NOT ok AND st = 'confirmed')::int AS confirm_already, COUNT(*) FILTER (WHERE k AND NOT ok AND st <> 'confirmed')::int AS confirm_not_confirmed
          FROM (SELECT e.order_id, o.confirmation_status AS st, BOOL_OR(e.event = 'clicked_confirm') AS k, BOOL_OR(e.event = 'clicked_cancel') AS c, BOOL_OR(e.event = 'clicked_change_address') AS a, BOOL_OR(e.event = 'replied_text') AS r,
                       BOOL_OR(e.event = 'clicked_confirm' AND e.applied = 'confirmed_order') AS ok
                FROM wa_events e JOIN wa_messages m ON m.send_id = e.send_id JOIN orders_master o ON o.id = e.order_id
                WHERE e.order_id = ANY($1) AND m.step <= 4 AND NOT m.is_test AND e.event IN ('clicked_confirm', 'clicked_cancel', 'clicked_change_address', 'replied_text')
                GROUP BY e.order_id, o.confirmation_status) p`, [ids]);
        // The same classification, message by message: an order is counted ONCE, on the message of its FIRST answer, in the first of Cancel / Change address / Confirm / only a message that applies. So the columns of the message table add up to the lines of the responses table.
        const RESP = "('clicked_confirm', 'clicked_cancel', 'clicked_change_address', 'replied_text')";
        respByStep = Object.fromEntries((await db(`SELECT first_step AS step, COUNT(*)::int AS new_resp, COUNT(*) FILTER (WHERE c)::int AS r_cancel, COUNT(*) FILTER (WHERE a AND NOT c)::int AS r_change, COUNT(*) FILTER (WHERE k AND NOT c AND NOT a)::int AS r_confirm, COUNT(*) FILTER (WHERE r AND NOT c AND NOT a AND NOT k)::int AS r_only
            FROM (SELECT e.order_id, MIN(m.step) AS first_step, BOOL_OR(e.event = 'clicked_confirm') AS k, BOOL_OR(e.event = 'clicked_cancel') AS c, BOOL_OR(e.event = 'clicked_change_address') AS a, BOOL_OR(e.event = 'replied_text') AS r
                  FROM wa_events e JOIN wa_messages m ON m.send_id = e.send_id WHERE e.order_id = ANY($1) AND m.step <= 4 AND NOT m.is_test AND e.event IN ${RESP} GROUP BY e.order_id) p GROUP BY first_step`, [ids])).map(x => [x.step, x]));
        // Orders messaged at each step that have not answered ANY message yet.
        answeredOfMessaged = Object.fromEntries((await db(`SELECT m.step, COUNT(DISTINCT m.order_id)::int AS n FROM wa_messages m WHERE m.order_id = ANY($1) AND m.step <= 4 AND NOT m.is_test AND m.sent_at IS NOT NULL
            AND EXISTS (SELECT 1 FROM wa_events e JOIN wa_messages m2 ON m2.send_id = e.send_id WHERE e.order_id = m.order_id AND m2.step <= 4 AND NOT m2.is_test AND e.event IN ${RESP}) GROUP BY m.step`, [ids])).map(x => [x.step, x.n]));
      }
      let shipping = [], shipReplies = []; try { const nfy = require('./lib/waNotify'); shipping = await nfy.report(db, r.from, r.to); shipReplies = await nfy.replies(db, r.from, r.to); } catch (e) { console.error('[WA] shipping report failed:', e.message); }
      res.json({ from: r.from, to: r.to, orders: rows.length, orders_messaged: messaged, orders_messaged_pct: rows.length ? Math.round(messaged * 1000 / rows.length) / 10 : null, confirmed_by_whatsapp: confirmedByWa, responses, shipping, ship_replies: shipReplies,
        bridge_has_data: steps.length > 0, steps: steps.map((s, i) => { const z = respByStep[s.step] || { new_resp: 0, r_cancel: 0, r_change: 0, r_confirm: 0, r_only: 0 }; return { ...s, ...z, confirmed_so_far: steps.slice(0, i + 1).reduce((a, x) => a + (x.confirmed_here || 0), 0), responded_so_far: steps.slice(0, i + 1).reduce((a, x) => a + ((respByStep[x.step] || {}).new_resp || 0), 0),
          label: LABEL[s.step] || ('Message ' + (s.step + 1)), no_response: Math.max(0, s.sent - (answeredOfMessaged[s.step] || 0)) }; }) });
    } catch (err) { sendError(res, err); }
  });  app.get('/api/cc/lead-audit', async (req, res) => {
    try {
      if (!['admin', 'aman'].includes(req.agent.role)) throw new HttpError(403, 'Not allowed for your account');
      const a = await loadLeadAudit(parseRange(req.query));
      res.json({ ...a, list: a.list.slice(0, 200), list_cut: Math.max(0, a.list.length - 200) });
    } catch (err) { sendError(res, err); }
  });
  // Is every change made in the CRM reaching Shopify? Last 3 days: confirmed orders without the "confirmed" tag, cancels not yet cancelled on Shopify, address pushes that failed, and the latest error text of each.
  app.get('/api/cc/shopify-sync', async (req, res) => {
    try {
      if (!['admin', 'aman'].includes(req.agent.role)) throw new HttpError(403, 'Not allowed for your account');
      const env = { store_set: !!process.env.SHOPIFY_STORE_DOMAIN, token_set: !!process.env.SHOPIFY_ACCESS_TOKEN };
      const untagged = await db(`SELECT order_name, confirmed_at FROM orders_master
        WHERE confirmation_status = 'confirmed' AND shopify_order_id IS NOT NULL AND shopify_tag_synced = FALSE AND confirmed_at > NOW() - INTERVAL '3 days'
        ORDER BY confirmed_at DESC LIMIT 100`);
      const cancels = await db(`SELECT o.order_name, COALESCE(o.cancelled_at, o.updated_at) AS at,
          (SELECT e.notes FROM order_status_events e WHERE e.order_id = o.id AND e.event_type = 'shopify_cancel_failed' ORDER BY e.created_at DESC LIMIT 1) AS last_error
        FROM orders_master o
        WHERE o.confirmation_status = 'cancelled' AND o.shopify_order_id IS NOT NULL AND UPPER(COALESCE(o.payment_method,'')) = 'COD'
          AND COALESCE(o.cancelled_at, o.updated_at) > NOW() - INTERVAL '3 days'
          AND NOT EXISTS (SELECT 1 FROM order_status_events e WHERE e.order_id = o.id AND e.event_type = 'shopify_cancel_synced')
        ORDER BY 2 DESC LIMIT 100`).catch(() => []);
      const addrs = await db(`SELECT o.order_name, f.created_at AS at, f.notes AS last_error
        FROM order_status_events f JOIN orders_master o ON o.id = f.order_id
        WHERE f.event_type = 'shopify_address_failed' AND f.created_at > NOW() - INTERVAL '3 days'
          AND NOT EXISTS (SELECT 1 FROM order_status_events s WHERE s.order_id = f.order_id AND s.event_type = 'shopify_address_synced' AND s.created_at > f.created_at)
        ORDER BY f.created_at DESC LIMIT 100`).catch(() => []);
      const problems = untagged.length + cancels.length + addrs.length;
      res.json({ env, problems, untagged_confirmed: untagged, cancel_not_synced: cancels, address_not_synced: addrs,
        hint: !env.token_set ? 'The web service has no SHOPIFY_ACCESS_TOKEN. Check the worker service too: the retry job runs there.' : (problems ? 'Open the list: the last_error text says why Shopify refused (for example a missing write_orders permission on the Shopify app).' : 'All recent changes reached Shopify.') });
    } catch (err) { sendError(res, err); }
  });
  app.get('/api/cc/lead-audit.csv', async (req, res) => {
    try {
      if (!['admin', 'aman'].includes(req.agent.role)) throw new HttpError(403, 'Not allowed for your account');
      const a = await loadLeadAudit(parseRange(req.query));
      const cell = (v) => { const t = v === null || v === undefined ? '' : String(v); return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
      const csv = ['Order,Order date,Days old,Team,Status,Why no attempt,Phone,Assigned agent'].concat(a.list.map(l => [l.order, l.day, l.age_days, l.team, l.status, l.reason, l.phone, l.agent].map(cell).join(','))).join('\r\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="Leads_with_no_attempt_${a.from}_to_${a.to}.csv"`);
      res.send('﻿' + csv);
    } catch (err) { sendError(res, err); }
  });
  app.get('/api/cc/team-report', async (req, res) => {
    try {
      if (!['admin', 'aman'].includes(req.agent.role)) throw new HttpError(403, 'Not allowed for your account');
      const r = parseRange(req.query);
      res.json({ from: r.from, to: r.to, generated_at: new Date().toISOString(), ...(await loadTeamReport(r)), definitions: teamReportLib.DEFINITIONS });
    } catch (err) { sendError(res, err); }
  });
  // IVR performance for the admin Home (same dates as the team report). A failure here never breaks the Home page: it just shows no IVR numbers.
  app.get('/api/cc/ivr-report', async (req, res) => {
    try {
      if (!['admin', 'aman'].includes(req.agent.role)) throw new HttpError(403, 'Not allowed for your account');
      const r = parseRange(req.query);
      res.json({ from: r.from, to: r.to, ...(await require('./lib/ivrDb').report(db, r.start, r.end)) });
    } catch (err) { sendError(res, err); }
  });
  // When do customers pick up? Hour by hour for the last 30 days, and the hours the IVR would choose. Preview only: nothing in the calling uses it yet.
  app.get('/api/cc/hour-curve', async (req, res) => {
    try {
      if (!['admin', 'aman'].includes(req.agent.role)) throw new HttpError(403, 'Not allowed for your account');
      res.json({ days: 30, ...(await require('./lib/ivrDb').hourData(db)) });
    } catch (err) { sendError(res, err); }
  });
  app.get('/api/cc/team-report/download', async (req, res) => {
    try {
      if (!['admin', 'aman'].includes(req.agent.role)) throw new HttpError(403, 'Not allowed for your account');
      const r = parseRange(req.query);
      const ExcelJS = require('exceljs');
      const wb = new ExcelJS.Workbook();
      wb.creator = 'Jaadu Diet CRM';
      teamReportLib.addTeamSheets(wb, await loadTeamReport(r), { font: { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2D5F8A' } }, alignment: { horizontal: 'center' } });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="Team_Performance_${r.from}_to_${r.to}.xlsx"`);
      await wb.xlsx.write(res);
      res.end();
    } catch (err) { console.error('[Report] Team performance download error:', err.message); if (!res.headersSent) sendError(res, err); }
  });
  // ===================== CONTROL TOWER (one screen: is the chain healthy, what to fix next) =====================
  // Admin and Aman only. Reuses the cohort, team and ship-gate engines, so its numbers equal the reports.
  async function loadControlTower() {
      const today = todayIst();
      const shift = (iso, n) => new Date(new Date(iso + 'T12:00:00+05:30').getTime() + n * 86400000).toLocaleDateString('en-CA', { timeZone: cfg.TIMEZONE });
      const r14 = parseRange({ from: shift(today, -13), to: today });
      const r7 = parseRange({ from: shift(today, -6), to: today });
      const rows = await fetchCohortRows(r14, null, null);
      // The tower uses the same numbers as the Daily report: COD orders are the base and every channel counts (lib/codReport.js, from the order ledger). If that fails it falls back to the older call-only engine.
      let e2e;
      try {
        const cr = require('./lib/codReport'), touches14 = await loadTouches(rows.map(o => o.id));
        e2e = { days: cr.asTowerDays(cr.build(require('./lib/ledger').buildLedger(rows, touches14, new Date()), await fetchPrepaidByDay(r14, null, null), { today })) };
      } catch (e) { console.error('[ControlTower] ledger numbers skipped, using the older engine:', e.message); e2e = e2eLib.buildE2E(rows, await fetchPrepaidByDay(r14, null, null), { today }); }
      const from7 = shift(today, -6);
      const shippedConfirmed = rows.filter(o => o.day >= from7 && o.status === 'confirmed' && o.shipped).length;
      let team = null, ship = null, shipNote = null, plan = null;
      try { team = await loadTeamReport(r7); } catch (e) { console.error('[ControlTower] team part skipped:', e.message); }
      try { const p = (await loadPlanDb.loadPlan(db)).plan; plan = { teams: p.teams, review_count: p.review.length, hours_left: p.hours_left }; } catch (e) { console.error('[ControlTower] call plan part skipped:', e.message); }
      try {
        const s = await shipGateDb.loadSnapshot(db, dbOne);
        ship = { ready: s.r.ready.length, overdue: s.r.ready.filter(x => x.ship_status === 'overdue').length, due_today: s.r.ready.filter(x => x.ship_status === 'due_today').length, blocked: s.r.blocked.length, wrong: s.r.wrong.length, untracked: s.r.untracked.length };
      } catch (e) { shipNote = 'Shipping data not available'; console.error('[ControlTower] ship part skipped:', e.message); }
      return { plan, tower: { generated_at: new Date().toISOString(), today, ...controlTowerLib.buildControlTower({ e2e, team, ship, plan, shippedConfirmed, today, windowDays: 7 }), ship_note: shipNote } };
  }
  app.get('/api/cc/control-tower', async (req, res) => {
    try {
      if (!['admin', 'aman'].includes(req.agent.role)) throw new HttpError(403, 'Not allowed for your account');
      res.json((await loadControlTower()).tower);
    } catch (err) { sendError(res, err); }
  });

  // ===================== OPS MANAGER BRIEF (step 1 of the AI agent: reads the numbers, writes a short brief, changes nothing) =====================
  // Admin and Aman can read it. It is written at most once an hour during the shift (when someone opens the screen and the last one is old),
  // or when the admin presses Refresh (at most once every 5 minutes). Numbers come from the code; the AI only words them (lib/opsBrief.js).
  let briefRun = null;
  async function freshBrief() {
    if (!briefRun) briefRun = (async () => { const { tower, plan } = await loadControlTower(); let road = null; try { road = await loadRoad(); } catch (e) { console.error('[OpsAgent] road to 95 unavailable:', e.message); } return opsAgent.generate(db, { tower, plan, road }); })().finally(() => { briefRun = null; });
    return briefRun;
  }
  app.get('/api/cc/ops-brief', async (req, res) => {
    try {
      if (!['admin', 'aman'].includes(req.agent.role)) throw new HttpError(403, 'Not allowed for your account');
      const s = opsAgent.settings(), now = new Date();
      let latest = await opsAgent.latest(db);
      if (req.query.peek !== '1' && opsAgent.inShift(now, s) && opsAgent.isStale(latest, now, s)) latest = await freshBrief();
      res.json({ brief: latest, ai_on: !!s.key, model: s.key ? s.model : null, history: await opsAgent.recent(db, 8) });
    } catch (err) { sendError(res, err); }
  });
  app.post('/api/cc/ops-brief/refresh', async (req, res) => {
    try {
      if (req.agent.role !== 'admin') throw new HttpError(403, 'Only the admin can refresh the brief');
      const latest = await opsAgent.latest(db);
      if (latest && (Date.now() - new Date(latest.created_at)) < 5 * 60000) throw new HttpError(429, 'The brief was written less than 5 minutes ago. Please wait a little.');
      res.json({ brief: await freshBrief() });
    } catch (err) { sendError(res, err); }
  });

  // ===================== CALL PLAN (calls needed vs calls possible, tries per DNP lead, balancing, the "stop redialling" list) =====================
  // Reading is for admin and Aman. Moving leads between the teams is admin only, and only when the admin presses the button
  // (the autopilot does the same on its own only when AUTOPILOT=on).
  app.get('/api/cc/load-plan', async (req, res) => {
    try {
      if (!['admin', 'aman'].includes(req.agent.role)) throw new HttpError(403, 'Not allowed for your account');
      const { plan, leads } = await loadPlanDb.loadPlan(db);
      const mode = require('./lib/autopilot').settings().mode;
      const dir = { cc_to_aman: plan.moves.filter(m => m.from === 'CC').length, aman_to_cc: plan.moves.filter(m => m.from === 'InHouse').length };
      const pool = require('./lib/loadPlan').splitPool(leads, new Date());
      res.json({ ...plan, review_count: plan.review.length, review: undefined, move_count: plan.moves.length, move_direction: dir, moves: undefined, autopilot_mode: mode,
        split: { cc: pool.cc.length, aman: pool.aman.length, is_admin: req.agent.role === 'admin' } });
    } catch (err) { sendError(res, err); }
  });
  app.post('/api/cc/load-plan/apply', async (req, res) => {
    try {
      if (req.agent.role !== 'admin') throw new HttpError(403, 'Only the admin can move leads between the teams');
      res.json(await loadPlanDb.applyBalance(db));
    } catch (err) { sendError(res, err); }
  });
  // ===================== IVR PLAN (stage 1: preview only, no calls are placed) =====================
  app.get('/api/cc/ivr-plan', async (req, res) => {
    try {
      if (!['admin', 'aman'].includes(req.agent.role)) throw new HttpError(403, 'Not allowed for your account');
      const ivrDb = require('./lib/ivrDb');
      const { plan, openLeads, usedToday, dailyCap, cover } = await ivrDb.plan(db);
      const stats = await ivrDb.todayStats(db);
      res.json({ ...plan, cover: !!cover, daily_cap: dailyCap, used_today: usedToday, stats, last_tick: await ivrDb.lastTick(db), held: await ivrDb.heldCount(db), force_until: await ivrDb.forceUntil(db), mode_raw: process.env.IVR_MODE == null ? '(not set)' : String(process.env.IVR_MODE), all_ids: undefined, all_kind: undefined, ids: undefined, groupById: undefined, open_leads: openLeads, is_admin: req.agent.role === 'admin' });
    } catch (err) { sendError(res, err); }
  });
  // ----- IVR stage 2: set-up check, test calls to the owner's own numbers, recent calls, and the address the IVR flow calls when a key is pressed -----
  const ivrAdmin = (req) => { if (req.agent.role !== 'admin') throw new HttpError(403, 'Only the admin can use the IVR tools'); };
  app.get('/api/cc/ivr/status', async (req, res) => {
    try {
      ivrAdmin(req); const ivrDb = require('./lib/ivrDb');
      const rows = await ivrDb.recentCalls(db, 15);
      res.json({ setup: ivrDb.setup(), presses: await ivrDb.recentKeypresses(db, 10), forward_set: !!process.env.IVR_FORWARD_URL, recent: rows.map(r => ({ id: r.id, phone: ivrDb.mask(r.phone), order_name: r.order_name || null, kind: r.kind || null, attempt: r.attempt, is_test: r.is_test, status: r.status, key: r.dtmf, result: r.result, applied: r.applied, note: r.note, placed_at: r.placed_at, result_at: r.result_at })) });
    } catch (err) { sendError(res, err); }
  });
  // The provider's own record of our calls (lib/ivrProvider.js). Sample = read-only look at the first records of the provider's call log, phone numbers masked, to check the real field names. Check = our calls of the dates against theirs.
  app.get('/api/cc/ivr/provider-sample', async (req, res) => {
    try {
      ivrAdmin(req); const ip = require('./lib/ivrProvider'), r = await ip.fetchPage({ apiKey: ip.settings().apiKey, cursors: { dialer: '0' } });
      const mask = (v) => JSON.parse(JSON.stringify(v).replace(/\d{10,12}/g, x => '*'.repeat(x.length - 3) + x.slice(-3)));
      res.json({ ok: r.ok, message: r.message || null, sync_on: ip.settings().on, key_set: !!ip.settings().apiKey, field_names: r.keys || [], records_in_page: r.total_raw, read_ok: (r.records || []).length, next_cursor: r.next, has_more: r.more, sample: mask(r.raw || []), normalized_sample: mask((r.records || []).slice(0, 3)) });
    } catch (err) { sendError(res, err); }
  });
  app.get('/api/cc/ivr/provider-check', async (req, res) => {
    try {
      if (!['admin', 'aman'].includes(req.agent.role)) throw new HttpError(403, 'Not allowed for your account');
      const r = parseRange(req.query); res.json(await require('./lib/ivrProvider').check(db, r.from, r.to));
    } catch (err) { sendError(res, err); }
  });
  // Emergency stop and restart of all real IVR calls (test calls are not affected).
  app.post('/api/cc/ivr/pause', async (req, res) => {
    try { ivrAdmin(req); res.json({ paused: await require('./lib/ivrDb').setPaused(db, !!(req.body || {}).paused) }); } catch (err) { sendError(res, err); }
  });
  // Hold old no-answer leads for the IVR so the callers do not see them (lock as 'IVR' for some hours; it clears by itself), and give them all back at once.
  app.post('/api/cc/ivr/hold-backlog', async (req, res) => {
    try {
      ivrAdmin(req); const b = req.body || {};
      if (!(Number(b.count) > 0)) throw new HttpError(400, 'Enter how many leads to hold');
      res.json(await require('./lib/ivrDb').holdBacklog(db, { count: b.count, hours: b.hours }));
    } catch (err) { sendError(res, err); }
  });
  // Start now / Stop now: run the no-answer calls at once for a while (inside 9 AM to 9 PM), or end that at once.
  app.post('/api/cc/ivr/run-now', async (req, res) => {
    try { ivrAdmin(req); const m = Number((req.body || {}).minutes) || 120; res.json({ until: await require('./lib/ivrDb').setForce(db, m) }); } catch (err) { sendError(res, err); }
  });
  app.post('/api/cc/ivr/stop-now', async (req, res) => {
    try { ivrAdmin(req); await require('./lib/ivrDb').setForce(db, 0); res.json({ until: null }); } catch (err) { sendError(res, err); }
  });
  app.post('/api/cc/ivr/release-held', async (req, res) => {
    try { ivrAdmin(req); res.json({ released: await require('./lib/ivrDb').releaseAll(db) }); } catch (err) { sendError(res, err); }
  });
  app.post('/api/cc/ivr/test-call', async (req, res) => {
    try {
      ivrAdmin(req);
      const slot = Number((req.body || {}).slot);
      if (!Number.isInteger(slot) || slot < 0) throw new HttpError(400, 'Choose a test number');
      const r = await require('./lib/ivrDb').placeTestCall(db, slot);
      if (!r.ok) throw new HttpError(400, r.message);
      res.json(r);
    } catch (err) { sendError(res, err); }
  });
  // Public on purpose (the IVR service calls it): protected by the secret IVR_WEBHOOK_KEY in the address. Always answers quickly; the secret is never stored.
  app.all('/ivr/keypress', async (req, res) => {
    try {
      const calls = require('./lib/ivrCalls'), want = calls.settings().webhookKey;
      const params = { ...(req.query || {}), ...((req.body && typeof req.body === 'object') ? req.body : {}) };
      if (!want) return res.status(503).json({ ok: false, error: 'IVR key press address is not set up' });
      if (!calls.safeEqual(params.key, want)) return res.status(401).json({ ok: false, error: 'Wrong key' });
      const r = await require('./lib/ivrDb').recordKeypress(db, params);
      // A confirm from the IVR puts the "confirmed" tag on the Shopify order at once (the 2-minute retry job in cron_jobs.js stays as the safety net), the same as a caller's confirm.
      if (r.outcome === 'confirmed_order' && r.order_id && typeof syncConfirmedTag === 'function') {
        dbOne('SELECT shopify_order_id FROM orders_master WHERE id = $1', [r.order_id]).then(o => o && o.shopify_order_id ? syncConfirmedTag(r.order_id, o.shopify_order_id) : null).catch(e => console.error('[Shopify] IVR syncConfirmedTag error:', e.message));
      }
      // A press for a call the CRM did not place (for example the old IVR campaign that shares this flow) is passed on to the old receiver, so nothing is lost
      // while both run. Set IVR_FORWARD_URL in Railway to the old address, without the key (the same key is sent along).
      let forwarded = false;
      if (r.outcome === 'unmatched' && process.env.IVR_FORWARD_URL && !params.test) {
        try { await require('axios').get(process.env.IVR_FORWARD_URL, { params: { ...params }, timeout: 8000 }); forwarded = true; }
        catch (e) { console.error('[IVR] could not forward an unmatched key press:', e.message); }
      }
      res.json({ ok: true, outcome: r.outcome, forwarded });
    } catch (err) { console.error('[IVR] key press failed:', err.message); res.status(500).json({ ok: false }); }
  });
  // ---- WhatsApp bridge (see lib/waBridge.js). Public on purpose: the WhatsApp service calls these with the secret WA_SHARED_KEY in the header X-WA-Key. ----
  const waAuth = (req, res, next) => {
    const wa = require('./lib/waBridge'), want = wa.settings().key;
    if (!want) return res.status(503).json({ ok: false, error: 'wa_key_not_set' });
    if (!wa.safeEqual(req.get('x-wa-key'), want)) return res.status(401).json({ ok: false, error: 'bad_key' });
    next();
  };
  app.get('/api/wa/queue', waAuth, async (req, res) => {
    try { res.json(await require('./lib/waBridge').queue(db, new Date(), process.env, req.query.limit)); }
    catch (err) { console.error('[WA] queue failed:', err.message); res.status(500).json({ ok: false, error: 'server_error' }); }
  });
  app.get('/api/wa/check', waAuth, async (req, res) => {
    try { res.json(await require('./lib/waBridge').check(db, req.query.send_id)); }
    catch (err) { console.error('[WA] check failed:', err.message); res.status(500).json({ send: false, error: 'server_error' }); }
  });
  app.post('/api/wa/result', waAuth, async (req, res) => {
    try {
      const r = await require('./lib/waBridge').result(db, req.body);
      // A Confirm tap puts the "confirmed" tag on the Shopify order at once (the 2-minute retry job in cron_jobs.js stays as the safety net), the same as a caller's confirm.
      if (r.body && r.body.applied === 'confirmed_order' && typeof syncConfirmedTag === 'function') {
        dbOne('SELECT id, shopify_order_id FROM orders_master WHERE id = $1', [r.order_id])
          .then(o => o && o.shopify_order_id ? syncConfirmedTag(o.id, o.shopify_order_id) : null).catch(e => console.error('[Shopify] WhatsApp syncConfirmedTag error:', e.message));
      }
      res.status(r.status).json(r.body);
    }
    catch (err) { console.error('[WA] result failed:', err.message); res.status(500).json({ ok: false, error: 'server_error' }); }
  });
  app.post('/api/wa/health', waAuth, async (req, res) => {
    try { res.json(await require('./lib/waBridge').health(db, req.body)); }
    catch (err) { console.error('[WA] health failed:', err.message); res.status(500).json({ ok: false }); }
  });
  app.get('/api/cc/wa/status', async (req, res) => {
    try {
      if (req.agent.role !== 'admin') throw new HttpError(403, 'Only the admin can see the WhatsApp status');
      res.json(await require('./lib/waBridge').status(db));
    } catch (err) { sendError(res, err); }
  });
  app.post('/api/cc/wa/test-message', async (req, res) => {
    try {
      if (req.agent.role !== 'admin') throw new HttpError(403, 'Only the admin can send a WhatsApp test');
      const b = req.body || {}, slot = Number(b.slot);
      if (!Number.isInteger(slot) || slot < 0) throw new HttpError(400, 'Choose a test number');
      const r = await require('./lib/waBridge').testMessage(db, slot, String(b.key || 'confirm'));
      if (!r.ok) throw new HttpError(400, r.message);
      res.json(r);
    } catch (err) { sendError(res, err); }
  });
  app.get('/api/cc/ivr-plan/list.csv', async (req, res) => {
    try {
      if (req.agent.role !== 'admin') throw new HttpError(403, 'Only the admin can download the IVR list');
      const ivrDb = require('./lib/ivrDb'), want = String(req.query.group || 'all');
      const { plan } = await ivrDb.plan(db);
      const ids = plan.ids.filter(id => want === 'all' || String(plan.groupById[id]).startsWith(want + '/'));
      const rows = await ivrDb.listRows(db, ids, plan.groupById);
      const cell = (v) => { const t = v === null || v === undefined ? '' : String(v); return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
      const ist = (v) => v ? new Date(v).toLocaleString('en-IN', { timeZone: cfg.TIMEZONE, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
      const label = { 'fresh/never': 'Fresh order, never called', 'fresh/dnp': 'Fresh order, no answer', 'today/never': 'Placed today, never called', 'today/dnp': 'Placed today, no answer', 'recent/never': 'Recent, never called', 'recent/dnp': 'Recent, no answer', 'backlog/never': 'Backlog, never called', 'backlog/dnp': 'Backlog, no answer' };
      const head = ['Order', 'Customer', 'Phone', 'Order total', 'Placed', 'Where it stands', 'No-answer tries so far', 'With', 'Same phone as order'];
      const body = rows.map(r => [r.order_name, r.customer_name, r.phone, r.total_price, ist(r.placed_at), label[r.group] || r.group, r.dnp_tries, r.team, r.same_phone_as].map(cell).join(','));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="IVR_list_${want}_${todayIst()}.csv"`);
      res.send('﻿' + [head.join(',')].concat(body).join('\r\n'));
    } catch (err) { sendError(res, err); }
  });

  // Manual split of the old backlog: GET counts what would move, POST moves it. Admin only. Body / query: aman = leads to take from the call centre, cc = leads to take from Aman.
  const splitArgs = (src) => ({ toAman: Number(src.aman) || 0, toCc: Number(src.cc) || 0 });
  app.get('/api/cc/load-plan/split', async (req, res) => {
    try {
      if (req.agent.role !== 'admin') throw new HttpError(403, 'Only the admin can split the backlog');
      res.json(await loadPlanDb.splitBacklog(db, { ...splitArgs(req.query), preview: true }));
    } catch (err) { sendError(res, err); }
  });
  app.post('/api/cc/load-plan/split', async (req, res) => {
    try {
      if (req.agent.role !== 'admin') throw new HttpError(403, 'Only the admin can split the backlog');
      const a = splitArgs(req.body || {});
      if (!a.toAman && !a.toCc) throw new HttpError(400, 'Enter how many leads to move');
      res.json(await loadPlanDb.splitBacklog(db, a));
    } catch (err) { sendError(res, err); }
  });
  app.get('/api/cc/load-plan/review.csv', async (req, res) => {
    try {
      if (!['admin', 'aman'].includes(req.agent.role)) throw new HttpError(403, 'Not allowed for your account');
      const { plan } = await loadPlanDb.loadPlan(db);
      const rows = await loadPlanDb.reviewRows(db, plan.review);
      const cell = (v) => { const t = v === null || v === undefined ? '' : String(v); return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
      const ist = (v) => v ? new Date(v).toLocaleString('en-IN', { timeZone: cfg.TIMEZONE, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
      const head = ['Order', 'Customer', 'Phone', 'Team', 'Order total', 'Placed', 'Unanswered tries', 'Days tried', 'Last tried'];
      const body = rows.map(r => [r.order_name, r.customer_name, r.customer_phone ? String(r.customer_phone).replace(/\D/g, '').slice(-10) : '', r.team, r.total_price, ist(r.placed_at), r.dnp_tries, r.days_tried, ist(r.last_tried)].map(cell).join(','));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="Cannot_reach_${todayIst()}.csv"`);
      res.send('﻿' + [head.join(',')].concat(body).join('\r\n'));
    } catch (err) { sendError(res, err); }
  });

  // Owner scoreboard. Admin: goal tracking + both teams. Aman: his team (or the call centre). Call-centre agent: own team, own row.
  app.get('/api/cc/scoreboard', async (req, res) => {
    try {
      const r = parseRange(req.query);
      const role = req.agent.role;
      let view = role === 'agent' ? 'cc' : (['aman', 'cc', 'all'].includes(req.query.view) ? req.query.view : (role === 'aman' ? 'aman' : 'all'));
      if (view === 'all' && role !== 'admin') view = role === 'aman' ? 'aman' : 'cc';
      const rules = `UPPER(COALESCE(o.payment_method,'')) = 'COD' AND NOT ${TEST_NAME_SQL} AND o.total_price >= $3
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(${ITEMS_SQL}) li, unnest($4::text[]) p WHERE starts_with(COALESCE(li->>'title',''), p))`;
      const params = [r.start, r.end, productsLib.MIN_PRICE, productsLib.ALLOWED_PREFIXES, cfg.CONNECTED_DISPOSITIONS, cfg.CALL_DISPOSITIONS];

      const out = { from: r.from, to: r.to, view, targets: scoreLib.TARGETS };
      if (view === 'all') {
        const goalRows = await fetchCohortRows(r, null, null);
        let goalConn = null; try { goalConn = require('./lib/codReport').connectedAtOf(await loadTouches(goalRows.map(o => o.id))); } catch (e) { console.error('[Scoreboard] any-channel reached skipped:', e.message); }
        out.goal = scoreLib.buildGoal(goalRows, goalConn);
        // Plain "how many orders came in" per day: COD + prepaid, real tea orders only (same rules as everywhere else).
        const days = await db(
          `SELECT (COALESCE(o.shopify_created_at, o.created_at) AT TIME ZONE 'Asia/Kolkata')::date::text AS day,
                  COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE UPPER(COALESCE(o.payment_method,'')) = 'COD')::int AS cod,
                  COUNT(*) FILTER (WHERE UPPER(COALESCE(o.payment_method,'')) <> 'COD')::int AS prepaid,
                  COUNT(*) FILTER (WHERE UPPER(COALESCE(o.payment_method,'')) = 'COD' AND COALESCE(o.converted_to_prepaid, FALSE))::int AS converted
           FROM orders_master o
           WHERE COALESCE(o.shopify_created_at, o.created_at) >= $1 AND COALESCE(o.shopify_created_at, o.created_at) < $2
             AND NOT ${TEST_NAME_SQL} AND o.total_price >= $3
             AND EXISTS (SELECT 1 FROM jsonb_array_elements(${ITEMS_SQL}) li, unnest($4::text[]) p WHERE starts_with(COALESCE(li->>'title',''), p))
           GROUP BY 1 ORDER BY 1`, params.slice(0, 4));
        const left = await dbOne(
          `SELECT COUNT(*) FILTER (WHERE ${TEST_NAME_SQL})::int AS test,
                  COUNT(*) FILTER (WHERE NOT ${TEST_NAME_SQL} AND NOT (o.total_price >= $3
                    AND EXISTS (SELECT 1 FROM jsonb_array_elements(${ITEMS_SQL}) li, unnest($4::text[]) p WHERE starts_with(COALESCE(li->>'title',''), p))))::int AS other
           FROM orders_master o WHERE COALESCE(o.shopify_created_at, o.created_at) >= $1 AND COALESCE(o.shopify_created_at, o.created_at) < $2`, params.slice(0, 4));
        const sum = (k) => days.reduce((s, d) => s + d[k], 0);
        out.orders_received = { days, total: sum('total'), cod: sum('cod'), prepaid: sum('prepaid'), converted: sum('converted'), left_out: { test: left.test, other: left.other, min_price: productsLib.MIN_PRICE } };
      }

      const raw = await db(
        `SELECT g.agent_name AS name, a.role, COUNT(*)::int AS calls, COUNT(DISTINCT g.order_id)::int AS orders_called,
                COUNT(*) FILTER (WHERE g.disposition = ANY($5))::int AS connected,
                COUNT(DISTINCT g.order_id) FILTER (WHERE g.disposition = 'confirmed')::int AS confirmed,
                COUNT(DISTINCT g.order_id) FILTER (WHERE g.disposition = 'cancelled')::int AS cancelled,
                COUNT(*) FILTER (WHERE g.disposition = 'dnp')::int AS dnp,
                COUNT(DISTINCT g.order_id) FILTER (WHERE g.disposition = 'wrong_number')::int AS wrong,
                COUNT(*) FILTER (WHERE g.disposition = 'callback')::int AS callbacks,
                COUNT(*) FILTER (WHERE g.disposition = 'address_fix')::int AS address_fix
         FROM lead_call_log g JOIN agents a ON a.id = g.agent_id JOIN orders_master o ON o.id = g.order_id
         WHERE g.created_at >= $1 AND g.created_at < $2 AND g.disposition = ANY($6) AND ${rules} GROUP BY g.agent_name, a.role`, params);
      const redial = await db(
        `WITH d AS (
           SELECT g.agent_name, a.role,
             EXISTS (SELECT 1 FROM lead_call_log n WHERE n.order_id = g.order_id AND n.created_at > g.created_at
                       AND n.created_at <= g.created_at + INTERVAL '24 hours' AND n.disposition = ANY($5)) AS followed,
             (o.confirmation_status IN ('confirmed','cancelled') AND COALESCE(o.confirmed_at, o.cancelled_at) <= g.created_at + INTERVAL '24 hours') AS resolved
           FROM lead_call_log g JOIN agents a ON a.id = g.agent_id JOIN orders_master o ON o.id = g.order_id
           WHERE g.disposition = 'dnp' AND g.created_at >= $1 AND g.created_at < $2 AND g.created_at < NOW() - INTERVAL '24 hours' AND ${rules})
         SELECT agent_name AS name, role, COUNT(*) FILTER (WHERE followed)::int AS followed,
                COUNT(*) FILTER (WHERE NOT followed AND NOT resolved)::int AS missed,
                COUNT(*) FILTER (WHERE NOT followed AND resolved)::int AS resolved_other FROM d GROUP BY agent_name, role`,
        [params[0], params[1], params[2], params[3], cfg.CALL_DISPOSITIONS]);
      const backlogRows = await db(
        `SELECT o.assigned_to AS team,
                COUNT(*) FILTER (WHERE o.callback_at IS NULL AND COALESCE(o.shopify_created_at, o.created_at) < NOW() - INTERVAL '24 hours'
                                  AND NOT EXISTS (SELECT 1 FROM lead_call_log g WHERE g.order_id = o.id AND g.disposition = ANY($1)))::int AS fresh_waiting,
                COUNT(*) FILTER (WHERE o.callback_at IS NOT NULL AND o.callback_at < NOW() - INTERVAL '2 hours')::int AS callbacks_overdue
         FROM orders_master o
         WHERE o.assigned_to IN ('CC','InHouse') AND o.confirmation_status = 'pending' AND o.order_status = 'new' AND COALESCE(o.dnc,FALSE) = FALSE
           AND COALESCE(o.shopify_created_at, o.created_at) >= NOW() - INTERVAL '10 days'
           AND UPPER(COALESCE(o.payment_method,'')) = 'COD' AND NOT ${TEST_NAME_SQL} AND o.total_price >= $2
           AND EXISTS (SELECT 1 FROM jsonb_array_elements(${ITEMS_SQL}) li, unnest($3::text[]) p WHERE starts_with(COALESCE(li->>'title',''), p))
         GROUP BY o.assigned_to`, [cfg.CALL_DISPOSITIONS, productsLib.MIN_PRICE, productsLib.ALLOWED_PREFIXES]);

      const teamOf = (ro) => (ro === 'aman' ? 'aman' : ro === 'agent' ? 'cc' : 'admin');
      const key = (x) => x.name + '|' + x.role;
      const redialBy = new Map(redial.map(x => [key(x), x]));
      const sumRaw = (list) => list.reduce((s, x) => { for (const f of ['calls', 'orders_called', 'connected', 'confirmed', 'cancelled', 'dnp', 'wrong', 'callbacks', 'address_fix']) s[f] = (s[f] || 0) + x[f]; return s; }, {});
      const sumRedial = (list) => list.reduce((s, x) => ({ followed: s.followed + x.followed, missed: s.missed + x.missed, resolved_other: s.resolved_other + x.resolved_other }), { followed: 0, missed: 0, resolved_other: 0 });
      const wanted = view === 'all' ? ['aman', 'cc'] : [view];
      const backlogOf = (t) => backlogRows.find(b => b.team === (t === 'aman' ? 'InHouse' : 'CC')) || { fresh_waiting: 0, callbacks_overdue: 0 };

      out.teams = {}; out.people = []; out.attention = [];
      for (const t of wanted) {
        const mine = raw.filter(x => teamOf(x.role) === t);
        const people = mine.map(x => ({ name: x.name, team: t, ...scoreLib.shapeStats(x, redialBy.get(key(x))) })).sort((a, b) => b.calls - a.calls);
        const team = scoreLib.shapeStats(sumRaw(mine), sumRedial(redial.filter(x => teamOf(x.role) === t)));
        const backlog = backlogOf(t);
        const label = t === 'aman' ? 'Aman' : 'Call centre';
        const lines = scoreLib.attention(label, team, people, backlog);
        out.teams[t] = { label, ...team, backlog };
        out.people.push(...people);
        out.attention.push(...lines);
      }
      // Distribution: of the COD orders that came in, how many went to each team, and how many of those have been reached.
      // "Dials" are the calls made in the period on any order (by call date), shown next to it so the two are never mixed up.
      const cohortAll = await fetchCohortRows(r, null, null);
      out.distribution = wanted.map(t => {
        const f = funnelLib.buildFunnel(cohortAll.filter(x => x.team === (t === 'aman' ? 'InHouse' : 'CC')));
        const mine = sumRaw(raw.filter(x => teamOf(x.role) === t));
        return { team: t, label: t === 'aman' ? 'Aman' : 'Call centre',
          orders: f.total_orders, called: f.attempted, not_called: f.not_attempted, connected: f.connected, confirmed: f.confirmed, cancelled: f.cancelled, not_connected: f.not_connected,
          dials: mine.calls || 0, dials_orders: mine.orders_called || 0, dials_picked: mine.connected || 0 };
      });
      if (role === 'agent') {
        // A call-centre agent sees the team's numbers and only their own row and lines.
        out.people = out.people.filter(p => p.name === req.agent.display_name);
        out.attention = out.attention.filter(a => a.text.startsWith('Call centre:') || a.text.startsWith(req.agent.display_name + ':'));
      }
      res.json(out);
    } catch (err) { sendError(res, err); }
  });

  // Confirmations by channel: Aman, call centre, IVR, WhatsApp. Same order rules as the funnel.
  // Aman's view returns only Aman, the call-centre view only the call centre; admin can see all four.
  app.get('/api/cc/channels', async (req, res) => {
    try {
      const r = parseRange(req.query);
      const role = req.agent.role;
      let view = role === 'agent' ? 'cc' : (['aman', 'cc', 'all'].includes(req.query.view) ? req.query.view : (role === 'aman' ? 'aman' : 'all'));
      if (view === 'all' && role !== 'admin') view = role === 'aman' ? 'aman' : 'cc';
      const rules = `UPPER(COALESCE(o.payment_method,'')) = 'COD' AND NOT ${TEST_NAME_SQL} AND o.total_price >= $3
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(${ITEMS_SQL}) li, unnest($4::text[]) p WHERE starts_with(COALESCE(li->>'title',''), p))`;
      const base = [r.start, r.end, productsLib.MIN_PRICE, productsLib.ALLOWED_PREFIXES];
      const roleOk = view === 'aman' ? ` AND a.role = 'aman'` : view === 'cc' ? ` AND a.role = 'agent'` : '';
      const own = role === 'agent' ? ` AND g.agent_id = $7` : '';
      const ownParam = role === 'agent' ? [req.agent.id] : [];

      let callRows = await db(
        `SELECT a.role, COUNT(*)::int AS calls, COUNT(DISTINCT g.order_id)::int AS orders_called,
                COUNT(*) FILTER (WHERE g.disposition = ANY($5))::int AS connected,
                COUNT(DISTINCT g.order_id) FILTER (WHERE g.disposition = 'confirmed')::int AS confirmed,
                COUNT(DISTINCT g.order_id) FILTER (WHERE g.disposition = 'cancelled')::int AS cancelled,
                COUNT(*) FILTER (WHERE g.disposition = 'address_fix')::int AS address_fix,
                COUNT(*) FILTER (WHERE g.disposition = 'dnp')::int AS dnp,
                COUNT(*) FILTER (WHERE g.disposition = 'callback')::int AS callbacks
         FROM lead_call_log g JOIN agents a ON a.id = g.agent_id JOIN orders_master o ON o.id = g.order_id
         WHERE g.created_at >= $1 AND g.created_at < $2 AND g.disposition = ANY($6) AND ${rules}${roleOk}${own} GROUP BY a.role`,
        [...base, cfg.CONNECTED_DISPOSITIONS, cfg.CALL_DISPOSITIONS, ...ownParam]);
      const people = await db(
        `SELECT g.agent_name AS name, a.role, COUNT(*)::int AS calls,
                COUNT(*) FILTER (WHERE g.disposition = ANY($5))::int AS connected,
                COUNT(DISTINCT g.order_id) FILTER (WHERE g.disposition = 'confirmed')::int AS confirmed,
                COUNT(DISTINCT g.order_id) FILTER (WHERE g.disposition = 'cancelled')::int AS cancelled,
                COUNT(*) FILTER (WHERE g.disposition = 'address_fix')::int AS address_fix
         FROM lead_call_log g JOIN agents a ON a.id = g.agent_id JOIN orders_master o ON o.id = g.order_id
         WHERE g.created_at >= $1 AND g.created_at < $2 AND g.disposition = ANY($6) AND ${rules}${roleOk}${own}
         GROUP BY g.agent_name, a.role ORDER BY calls DESC`,
        [...base, cfg.CONNECTED_DISPOSITIONS, cfg.CALL_DISPOSITIONS, ...ownParam]);

      let eventRows = [];
      if (view === 'all') {
        eventRows = await db(
          `SELECT e.actor, e.event_type, COUNT(DISTINCT e.order_id)::int AS n
           FROM order_status_events e JOIN orders_master o ON o.id = e.order_id
           WHERE e.created_at >= $1 AND e.created_at < $2 AND e.event_type IN ('confirmed','cancelled','rnr') AND ${rules}
             AND (e.actor = ANY($5) OR e.actor IS NULL OR e.actor NOT IN (SELECT display_name FROM agents))
           GROUP BY 1, 2`, [...base, channelsLib.SHEET_SOURCES]);
      }
      res.json({ from: r.from, to: r.to, view, channels: channelsLib.shapeChannels(callRows, eventRows), people });
    } catch (err) { sendError(res, err); }
  });

  app.get('/api/reports/lead-funnel', async (req, res) => {
    try {
      const r = parseRange(req.query);
      res.json(await buildLeadFunnel(r, req.query.team));
    } catch (err) { sendError(res, err); }
  });

  // Team-specific funnel endpoints (CC agents can access /api/cc/, Aman uses /api/kpi/)
  app.get('/api/cc/lead-funnel', async (req, res) => {
    try {
      const r = parseRange(req.query);
      res.json(await buildLeadFunnel(r, 'CC'));
    } catch (err) { sendError(res, err); }
  });
  app.get('/api/kpi/lead-funnel', async (req, res) => {
    try {
      const r = parseRange(req.query);
      res.json(await buildLeadFunnel(r, req.query.team || 'InHouse'));
    } catch (err) { sendError(res, err); }
  });

  // ===================== DAILY REPORT EXCEL DOWNLOAD =====================
  // Same numbers as the screens (lib/funnel.js): summary in the requested order, lead board, turnaround, and a day-by-day sheet.
  async function sendFunnelExcel(res, r, team, productKey, withShip) {
    const ExcelJS = require('exceljs');
    const safeTeam = team === 'CC' ? 'CC' : team === 'InHouse' ? 'InHouse' : null;
    const product = productsLib.productByKey(productKey) ? productKey : null;
    const rows = await fetchCohort(r, safeTeam, product);
    const f = funnelLib.buildFunnel(rows), p = funnelLib.buildPipeline(rows), days = funnelLib.buildDays(rows), sku = funnelLib.buildBySku(rows);
    const pc = (n) => `${n}%`;
    const teamLabel = (safeTeam === 'CC' ? 'Call centre' : safeTeam === 'InHouse' ? 'Aman (in-house)' : 'All teams') + (product ? ` - ${productsLib.productByKey(product).name}` : '');
    const headerStyle = { font: { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2D5F8A' } }, alignment: { horizontal: 'center' } };
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Jaadu Diet CRM';

    // First sheet for everyone: every order down to the confirmation, with counts and percentages, and the same day by day.
    try { e2eLib.addE2ESheet(wb, e2eLib.buildE2E(rows, await fetchPrepaidByDay(r, safeTeam, product), { today: todayIst() }), headerStyle, 'End to end: ' + teamLabel + ', orders placed ' + r.from + ' to ' + r.to); }
    catch (e) { console.error('[Report] end-to-end sheet skipped:', e.message); }

    // Admin and Aman downloads then continue with the earlier report format (every order on its own row), then the shipping sheets
    // (orders to ship with full details, confirmation pending, held back, wrong ships), then the sheets below. Each block is
    // isolated: if one fails it is logged and the rest of the report still downloads.
    if (withShip) {
      try { await addClassicSheets(wb, r.from, r.to); } catch (e) { console.error('[Report] earlier-format sheets skipped:', e.message); }
      try { shipSheetsLib.addShipSheets(wb, await shipGateDb.loadSnapshot(db, dbOne), headerStyle); } catch (e) { console.error('[Report] shipping sheets skipped:', e.message); }
    }

    const s = wb.addWorksheet('Funnel');
    s.columns = [{ header: 'Metric', key: 'metric', width: 44 }, { header: 'Orders', key: 'value', width: 12 }, { header: '% of total orders', key: 'pct', width: 18 }, { header: 'Note', key: 'note', width: 34 }];
    s.getRow(1).eachCell(c => Object.assign(c, headerStyle));
    s.addRow({ metric: `${teamLabel} - COD orders placed ${r.from} to ${r.to}` });
    s.addRow({});
    s.addRow({ metric: 'Total orders', value: f.total_orders, pct: '100%' });
    s.addRow({ metric: 'Attempted (called at least once)', value: f.attempted, pct: pc(f.attempted_pct) });
    s.addRow({ metric: 'Connected (customer spoke)', value: f.connected, pct: pc(f.connected_pct) });
    s.addRow({ metric: 'Confirmed on a call', value: f.confirmed, pct: pc(f.confirmed_pct) });
    s.addRow({ metric: 'Cancelled on a call', value: f.cancelled, pct: pc(f.cancelled_pct) });
    s.addRow({ metric: 'Not connected (called, never picked up)', value: f.not_connected, pct: pc(f.not_connected_pct) });
    s.addRow({ metric: '   Second attempt done', value: f.nc_2nd, pct: pc(f.nc_2nd_pct), note: `${f.nc_2nd_of_nc_pct}% of not connected` });
    s.addRow({ metric: '   Third attempt done', value: f.nc_3rd, pct: pc(f.nc_3rd_pct), note: `${f.nc_3rd_of_nc_pct}% of not connected` });
    s.addRow({ metric: 'Not attempted yet', value: f.not_attempted, pct: pc(f.not_attempted_pct) });
    s.addRow({ metric: 'Still pending (no final decision)', value: f.pending, pct: pc(f.pending_pct) });
    s.addRow({ metric: 'Total call attempts', value: f.total_attempts });
    s.addRow({});
    s.addRow({ metric: 'CLOSED WITHOUT A CALL (not in the funnel above)' });
    s.addRow({ metric: '   Confirmed by WhatsApp / IVR / sheet', value: f.confirmed_without_call, pct: pc(f.confirmed_without_call_pct) });
    s.addRow({ metric: '   Cancelled (auto-cancel / customer / other)', value: f.cancelled_without_call, pct: pc(f.cancelled_without_call_pct) });
    s.addRow({});
    s.addRow({ metric: 'WHERE THE LEADS ARE RIGHT NOW' });
    [['To call right now', p.to_call_now, p.pct.to_call_now], ['Fresh (never called)', p.fresh, p.pct.fresh], ['Not connected', p.not_connected, p.pct.not_connected],
      ['   1 attempt', p.nc_1, p.pct.nc_1], ['   2 attempts', p.nc_2, p.pct.nc_2], ['   3+ attempts', p.nc_3_plus, p.pct.nc_3_plus],
      ['Callbacks due now', p.callback_due, p.pct.callback_due], ['Callbacks scheduled later', p.callback_later, p.pct.callback_later],
      ['Spoke, not decided', p.in_progress, p.pct.in_progress], ['Confirmed', p.confirmed, p.pct.confirmed], ['Cancelled', p.cancelled, p.pct.cancelled],
      ['Wrong number', p.wrong_number, p.pct.wrong_number], ['Unreachable (7 days)', p.unreachable, p.pct.unreachable], ['Do not call', p.dnc, p.pct.dnc]]
      .forEach(([metric, value, pp]) => s.addRow({ metric, value, pct: pc(pp) }));
    s.addRow({ metric: 'Short address still to fix (not shipped)', value: p.short_open, pct: pc(p.pct.short_open), note: `${p.short_open_confirmed} already confirmed` });
    s.addRow({});
    s.addRow({ metric: 'TURNAROUND TIME (average)' });
    s.addRow({ metric: '   Order to 1st connect', value: f.tat_fmt.order_to_1st });
    s.addRow({ metric: '   1st to 2nd connect', value: f.tat_fmt.first_to_2nd });
    s.addRow({ metric: '   2nd to 3rd connect', value: f.tat_fmt.second_to_3rd });
    s.addRow({ metric: '   Order to confirmed / cancelled', value: f.tat_fmt.order_to_decision });

    const d = wb.addWorksheet('By day');
    d.columns = [['Order date', 'day', 14], ['Orders', 'total_orders', 10], ['Attempted', 'attempted', 11], ['Attempted %', 'attempted_pct', 12], ['Connected', 'connected', 11], ['Connected %', 'connected_pct', 12],
      ['Confirmed', 'confirmed', 11], ['Confirmed %', 'confirmed_pct', 12], ['Cancelled', 'cancelled', 11], ['Cancelled %', 'cancelled_pct', 12], ['Not connected', 'not_connected', 14], ['Not connected %', 'not_connected_pct', 15],
      ['2nd attempt', 'nc_2nd', 12], ['2nd attempt %', 'nc_2nd_pct', 13], ['3rd attempt', 'nc_3rd', 12], ['3rd attempt %', 'nc_3rd_pct', 13]].map(([header, key, width]) => ({ header, key, width }));
    d.getRow(1).eachCell(c => Object.assign(c, headerStyle));
    days.forEach(x => d.addRow(x));
    d.addRow({ day: 'TOTAL', ...f });
    d.lastRow.font = { bold: true };

    const k = wb.addWorksheet('By product');
    k.columns = [['Product', 'name', 30], ['Orders', 'orders', 10], ['Units (qty)', 'units', 12], ['Orders with qty 1', 'qty1', 17], ['Orders with qty 2', 'qty2', 17], ['Orders with qty 3+', 'qty3_plus', 18],
      ['Attempted %', 'attempted_pct', 13], ['Connected %', 'connected_pct', 13], ['Confirmed', 'confirmed', 11], ['Confirmed %', 'confirmed_pct', 13], ['Cancelled', 'cancelled', 11], ['Cancelled %', 'cancelled_pct', 13],
      ['Not connected', 'not_connected', 14], ['Not connected %', 'not_connected_pct', 16]].map(([header, key, width]) => ({ header, key, width }));
    k.getRow(1).eachCell(c => Object.assign(c, headerStyle));
    sku.rows.forEach(x => k.addRow(x));
    k.addRow({ name: 'Total units', units: sku.total_units });

    // Detailed analysis sheets (same numbers as the report page: lib/report2.js).
    const hourCalls = await db(`SELECT EXTRACT(HOUR FROM g.created_at AT TIME ZONE 'Asia/Kolkata')::int AS hour, COUNT(*)::int AS calls, COUNT(*) FILTER (WHERE g.disposition = ANY($5))::int AS connected,
        COUNT(*) FILTER (WHERE g.disposition = 'confirmed')::int AS confirmed, COUNT(*) FILTER (WHERE g.disposition = 'dnp')::int AS no_response
      FROM lead_call_log g JOIN agents a ON a.id = g.agent_id JOIN orders_master o ON o.id = g.order_id
      WHERE g.created_at >= $1 AND g.created_at < $2 AND g.disposition = ANY($6) AND (CASE WHEN a.role = 'agent' THEN 'CC' ELSE 'InHouse' END) = ANY($7)
        AND UPPER(COALESCE(o.payment_method,'')) = 'COD' AND NOT ${TEST_NAME_SQL} AND o.total_price >= $3
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(${ITEMS_SQL}) li, unnest($4::text[]) p WHERE starts_with(COALESCE(li->>'title',''), p)) GROUP BY 1`,
      [r.start, r.end, productsLib.MIN_PRICE, productsLib.ALLOWED_PREFIXES, cfg.CONNECTED_DISPOSITIONS, cfg.CALL_DISPOSITIONS, safeTeam ? [safeTeam] : ['CC', 'InHouse']]);
    const nDays = Math.max(1, Math.round((new Date(r.to + 'T00:00:00Z') - new Date(r.from + 'T00:00:00Z')) / 864e5) + 1);
    let dlConn = null; try { dlConn = require('./lib/codReport').connectedAtOf(await loadTouches(rows.map(o => o.id))); } catch (e) { console.error('[Download] any-channel reached skipped:', e.message); }
    const an = report2Lib.buildReport2(rows, hourCalls, nDays, dlConn);
    const sheet = (name, head, body) => { const w = wb.addWorksheet(name); w.columns = head.map(h => ({ header: h, width: Math.max(12, h.length + 3) })); w.getRow(1).eachCell(cell => Object.assign(cell, headerStyle)); body.forEach(b => w.addRow(b)); return w; };
    const o = an.overview, hr = (x) => `${String(x).padStart(2, '0')}:00 - ${String((x + 1) % 24).padStart(2, '0')}:00`;
    sheet('Overview', ['Block', 'Metric', 'Value'], [
      ['Overall', 'COD orders', o.orders], ['Overall', 'Confirmed % (all channels)', o.confirmed_pct], ['Overall', 'Cancelled %', o.cancelled_pct], ['Overall', 'Connectivity % (reached on WhatsApp, IVR or call)', o.connectivity_pct], ['Overall', 'Still unconfirmed', o.unconfirmed],
      ['WhatsApp', 'Confirmed on WhatsApp', o.whatsapp.confirmed], ['WhatsApp', 'Cancelled on WhatsApp', o.whatsapp.cancelled],
      ['Manual calling', 'Orders called', o.calling.orders_called], ['Manual calling', 'Calls made', o.calling.calls_made], ['Manual calling', 'Connect rate % (of calls made)', o.calling.connect_pct], ['Manual calling', 'Call confirm % (of orders called)', o.calling.confirm_pct_of_called],
      ['Manual calling', 'Confirmed on call', o.calling.confirmed], ['Manual calling', 'Median minutes, order to 1st call', o.calling.median_to_first_call_min], ['Manual calling', 'Median minutes, order to 1st connected call', o.calling.median_to_first_connected_min],
      ['IVR', 'Confirmed on IVR', o.ivr.confirmed], ['IVR', 'Cancelled on IVR', o.ivr.cancelled]]);
    sheet('By hour', ['Hour', 'COD orders', 'Avg orders / day', 'WA confirm %', 'Confirmed %', 'Cancelled %', 'Calls made', 'Connected', 'Connect %', 'Confirmed on call', 'Confirm % of calls', 'No response'],
      an.by_hour.map(x => [hr(x.hour), x.orders, x.avg_orders_per_day, x.wa_confirm_pct, x.confirmed_pct, x.cancelled_pct, x.calls, x.connected, x.connect_pct, x.call_confirmed, x.call_confirm_pct, x.no_response]));
    sheet('Timing', ['Table', 'Gap', 'Orders', 'Confirmed on call', 'Confirm %'],
      [...an.timing.first_call.map(x => ['Order to 1st call', x.label, x.orders, x.confirmed, x.confirm_pct]), ...an.timing.first_connected.map(x => ['Order to 1st connected call', x.label, x.orders, x.confirmed, x.confirm_pct])]);
    sheet('Attempts and outcomes', ['Table', 'Item', 'Count A', 'Count B', 'Percent'],
      [...an.attempts.map(x => ['Calling by attempt', `Call ${x.attempt}`, x.calls_made, x.connected, x.connect_pct]), ...an.outcomes.map(x => ['Where every order ended up', x.label, x.orders, '', x.pct])]);
    sheet('Journey', ['Window', 'WhatsApp', 'IVR', 'Call', 'Other', 'Total confirmed', '% of orders', 'Cumulative %', 'Cancelled'], an.journey.map(x => [x.label, x.wa, x.ivr, x.call, x.other, x.confirmed, x.confirmed_pct, x.cumulative_pct, x.cancelled]));
    sheet('Daily (order date)', ['Order date', 'COD orders', 'Confirmed D0', 'Confirmed D1', 'Confirmed D2+', 'Confirmed (day unknown)', 'Total confirmed', 'Confirmed %', 'D0 confirmed %', 'Cancelled', 'Still pending', 'Reached', 'Connectivity D0 %', 'Connectivity till D1 %', 'Connectivity all %'],
      an.daily.map(x => [x.day, x.orders, x.confirmed_d0, x.confirmed_d1, x.confirmed_d2, x.confirmed_unknown, x.confirmed, x.confirmed_pct, x.confirmed_d0_pct, x.cancelled, x.pending, x.reached, x.connectivity_d0_pct, x.connectivity_till_d1_pct, x.connectivity_all_pct]));
    sheet('Date x hour', ['Order date', ...Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'))], an.grid.map(g => [g.day, ...g.hours]));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Daily_Report_${teamLabel.replace(/[^A-Za-z0-9]+/g, '_')}_${r.from}_to_${r.to}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  }

  app.get('/api/reports/lead-funnel/download', async (req, res) => {
    try { await sendFunnelExcel(res, parseRange(req.query), req.query.team, req.query.product, !!req.agent && ['admin', 'aman'].includes(req.agent.role)); }
    catch (err) { console.error('[Report] Daily download error:', err.message); if (!res.headersSent) sendError(res, err); }
  });
  // Same report for call-centre agents (always CC) and Aman (cc / inhouse / all).
  app.get('/api/cc/funnel/download', async (req, res) => {
    try {
      const team = req.agent.role === 'agent' ? 'CC' : ({ cc: 'CC', inhouse: 'InHouse' }[req.query.team] || null);
      await sendFunnelExcel(res, parseRange(req.query), team, req.query.product, ['admin', 'aman'].includes(req.agent.role));
    } catch (err) { console.error('[Report] Daily download error:', err.message); if (!res.headersSent) sendError(res, err); }
  });
  app.get('/api/reports/incentives', async (req, res) => {
    try {
      const r = parseRange(req.query);
      const params = [r.start, r.end];
      let agentSql = '';
      if (r.agent) { params.push(r.agent); agentSql = ' AND i.agent_name = $3'; }
      const rows = await db(
        `SELECT i.agent_name, i.amount, i.credited_at, i.payment_id, o.order_name, o.customer_name, l.sent_at AS link_sent_at
         FROM agent_incentives i
         JOIN orders_master o ON o.id = i.order_id
         LEFT JOIN prepaid_links l ON l.id = i.link_id
         WHERE i.credited_at >= $1 AND i.credited_at < $2${agentSql}
         ORDER BY i.credited_at DESC`, params);
      const summary = summarizeIncentives(rows);
      if (wantsCsv(req)) {
        return sendCsv(res, `incentives_${r.from}_${r.to}.csv`,
          ['agent_name', 'order_name', 'customer_name', 'amount', 'link_sent_at', 'credited_at', 'payment_id'], rows);
      }
      res.json({ from: r.from, to: r.to, agent: r.agent, summary, total_amount: summary.reduce((s, x) => s + x.amount, 0), rows });
    } catch (err) { sendError(res, err); }
  });

  app.get('/api/reports/call-log', async (req, res) => {
    try {
      const r = parseRange(req.query);
      const params = [r.start, r.end];
      let agentSql = '';
      if (r.agent) { params.push(r.agent); agentSql = ' AND g.agent_name = $3'; }
      const rows = await db(
        `SELECT g.created_at, g.agent_name, o.order_name, o.customer_phone, g.disposition, g.reason_code, g.note, g.callback_at
         FROM lead_call_log g JOIN orders_master o ON o.id = g.order_id
         WHERE g.created_at >= $1 AND g.created_at < $2${agentSql}
         ORDER BY g.created_at DESC LIMIT 20000`, params);
      if (wantsCsv(req)) {
        return sendCsv(res, `call-log_${r.from}_${r.to}.csv`,
          ['created_at', 'agent_name', 'order_name', 'customer_phone', 'disposition', 'reason_code', 'note', 'callback_at'], rows);
      }
      res.json(rows);
    } catch (err) { sendError(res, err); }
  });

  // ---------------------------------------------------------------- ADMIN
  app.get('/api/admin/dnc', async (req, res) => {
    try {
      res.json(await db(
        `SELECT id, order_name, customer_name, customer_phone, dnc_by, dnc_at, dnc_note
         FROM orders_master WHERE dnc = TRUE ORDER BY dnc_at DESC`));
    } catch (err) { sendError(res, err); }
  });

  app.post('/api/admin/dnc/:id/clear', async (req, res) => {
    try {
      if (!UUID_RE.test(req.params.id)) throw new HttpError(400, 'Invalid id');
      const o = await dbOne(`UPDATE orders_master SET dnc = FALSE WHERE id = $1 AND dnc = TRUE RETURNING id`, [req.params.id]);
      if (!o) throw new HttpError(404, 'Lead is not flagged');
      await db(`SELECT log_status_change($1, 'dnc_cleared', 'dnc', NULL, $2)`, [req.params.id, req.agent.display_name]);
      res.json({ success: true });
    } catch (err) { sendError(res, err); }
  });

  app.get('/api/admin/agents', async (req, res) => {
    try {
      res.json(await db(
        `SELECT id, username, display_name, role, is_backup, is_active, last_login_at, created_at FROM agents ORDER BY role, display_name`));
    } catch (err) { sendError(res, err); }
  });

  app.post('/api/admin/agents', async (req, res) => {
    try {
      const username = clean(req.body?.username, 40).toLowerCase();
      const displayName = clean(req.body?.display_name, 60);
      const role = ['admin', 'aman'].includes(req.body?.role) ? req.body.role : 'agent';
      if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw new HttpError(400, 'Username: 3-40 letters, digits, dot, dash or underscore');
      if (!displayName) throw new HttpError(400, 'Display name required');
      let password = typeof req.body?.password === 'string' ? req.body.password : '';
      const generated = !password;
      if (generated) password = auth.generatePassword();
      const weak = auth.checkPasswordStrength(password);
      if (weak) throw new HttpError(400, weak);
      const hash = await auth.hashPassword(password);
      try {
        await db(`INSERT INTO agents (username, display_name, password_hash, role, is_backup) VALUES ($1,$2,$3,$4,$5)`,
          [username, displayName, hash, role, !!req.body?.is_backup]);
      } catch (e) {
        if (e.code === '23505') throw new HttpError(409, 'Username already exists');
        throw e;
      }
      res.json({ success: true, username, ...(generated ? { password } : {}) });
    } catch (err) { sendError(res, err); }
  });

  async function setActive(req, res, active) {
    try {
      if (!UUID_RE.test(req.params.id)) throw new HttpError(400, 'Invalid id');
      if (!active && req.params.id === req.agent.id) throw new HttpError(400, 'You cannot disable your own account');
      const a = await dbOne(
        `UPDATE agents SET is_active = $2, token_version = token_version + 1, updated_at = NOW() WHERE id = $1 RETURNING id`,
        [req.params.id, active]);
      if (!a) throw new HttpError(404, 'Agent not found');
      res.json({ success: true });
    } catch (err) { sendError(res, err); }
  }
  app.post('/api/admin/agents/:id/disable', (req, res) => setActive(req, res, false));
  app.post('/api/admin/agents/:id/enable', (req, res) => setActive(req, res, true));

  app.post('/api/admin/agents/:id/reset-password', async (req, res) => {
    try {
      if (!UUID_RE.test(req.params.id)) throw new HttpError(400, 'Invalid id');
      let password = typeof req.body?.password === 'string' ? req.body.password : '';
      const generated = !password;
      if (generated) password = auth.generatePassword();
      const weak = auth.checkPasswordStrength(password);
      if (weak) throw new HttpError(400, weak);
      const hash = await auth.hashPassword(password);
      const a = await dbOne(
        `UPDATE agents SET password_hash = $2, token_version = token_version + 1, failed_logins = 0, locked_until = NULL, updated_at = NOW()
         WHERE id = $1 RETURNING id`, [req.params.id, hash]);
      if (!a) throw new HttpError(404, 'Agent not found');
      res.json({ success: true, ...(generated ? { password } : {}) });
    } catch (err) { sendError(res, err); }
  });

  // ===================== MONTHLY COSTS CRUD =====================
  app.get('/api/admin/monthly-costs', async (req, res) => {
    try {
      const rows = await db('SELECT * FROM monthly_costs ORDER BY month_year DESC');
      res.json(rows);
    } catch (err) { sendError(res, err); }
  });

  app.post('/api/admin/monthly-costs', async (req, res) => {
    try {
      const { month_year, cc_cost, aman_salary } = req.body || {};
      if (!month_year || !/^\d{4}-\d{2}$/.test(month_year)) throw new HttpError(400, 'month_year must be YYYY-MM');
      const cc = Number(cc_cost) || 0;
      const salary = Number(aman_salary) || 0;
      await db(
        `INSERT INTO monthly_costs (month_year, cc_cost, aman_salary, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (month_year) DO UPDATE SET cc_cost = $2, aman_salary = $3, updated_at = NOW()`,
        [month_year, cc, salary]
      );
      res.json({ success: true });
    } catch (err) { sendError(res, err); }
  });

  // ===================== EARLIER REPORT FORMAT =====================
  // Summary, Date-wise, Order-wise (All), Call Centre, Aman (InHouse) and CC vs Aman Summary: every order on its own row.
  // Used by the ROI report download and, for admin and Aman, at the front of the Daily report download.
  async function addClassicSheets(wb, fromDate, toDate) {
      const fromDt = new Date(fromDate + 'T00:00:00+05:30');
      const toDt = new Date(toDate + 'T23:59:59+05:30');
      // Fetch orders
      const { rows: orders } = await pool.query(`
        SELECT o.id, o.order_name, o.customer_name, o.customer_phone, o.shipping_city,
               o.total_price, o.payment_method, o.confirmation_status, o.assigned_to,
               o.call_attempts, o.shopify_created_at, o.confirmed_at, o.cancelled_at,
               o.line_items, o.converted_to_prepaid
        FROM orders_master o
        WHERE o.shopify_created_at >= $1 AND o.shopify_created_at <= $2
        ORDER BY o.shopify_created_at
      `, [fromDt.toISOString(), toDt.toISOString()]);

      // DNP orders
      const { rows: dnpRows } = await pool.query(`
        SELECT DISTINCT l.order_id FROM lead_call_log l
        JOIN orders_master o ON o.id = l.order_id
        WHERE l.disposition = 'dnp'
          AND o.shopify_created_at >= $1 AND o.shopify_created_at <= $2
      `, [fromDt.toISOString(), toDt.toISOString()]);
      const dnpSet = new Set(dnpRows.map(r => r.order_id));
      for (const o of orders) o.had_dnp = dnpSet.has(o.id);

      // Monthly costs for the months in range
      const fromMonth = fromDate.slice(0, 7);
      const toMonth = toDate.slice(0, 7);
      const { rows: costRows } = await pool.query(
        'SELECT * FROM monthly_costs WHERE month_year >= $1 AND month_year <= $2',
        [fromMonth, toMonth]
      );
      const costMap = {};
      for (const c of costRows) costMap[c.month_year] = c;

      // Calculate selected days and pro-rated costs
      const selectedDays = Math.round((toDt - fromDt) / 86400000) + 1;
      let totalCcCost = 0, totalAmanSalary = 0;

      const startMonth = new Date(fromDt);
      startMonth.setDate(1);
      while (startMonth <= toDt) {
        const ym = startMonth.toISOString().slice(0, 7);
        const daysInMonth = new Date(startMonth.getFullYear(), startMonth.getMonth() + 1, 0).getDate();
        const monthStart = new Date(startMonth.getFullYear(), startMonth.getMonth(), 1);
        const monthEnd = new Date(startMonth.getFullYear(), startMonth.getMonth() + 1, 0);
        const overlapStart = fromDt > monthStart ? fromDt : monthStart;
        const overlapEnd = toDt < monthEnd ? toDt : monthEnd;
        const overlapDays = Math.round((overlapEnd - overlapStart) / 86400000) + 1;

        if (costMap[ym] && overlapDays > 0) {
          totalCcCost += (Number(costMap[ym].cc_cost) || 0) * overlapDays / daysInMonth;
          totalAmanSalary += (Number(costMap[ym].aman_salary) || 0) * overlapDays / daysInMonth;
        }
        startMonth.setMonth(startMonth.getMonth() + 1);
      }

      // Helper functions
      const pct = (n, d) => d ? (n / d * 100).toFixed(1) + '%' : '—';
      const fmtDate = (dt) => dt ? new Date(dt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }) : '—';
      const productName = (li) => { try { const items = typeof li === 'string' ? JSON.parse(li) : (li || []); return items[0]?.title || '—'; } catch { return '—'; } };
      const headerStyle = { font: { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2D5F8A' } }, alignment: { horizontal: 'center' } };

      function styleHeaders(sheet) {
        sheet.getRow(1).eachCell(c => { Object.assign(c, headerStyle); c.border = { bottom: { style: 'thin' } }; });
        sheet.columns.forEach(col => { col.width = Math.max(col.width || 10, 12); });
      }

      const ccOrders = orders.filter(o => o.assigned_to === 'CC');
      const amanOrders = orders.filter(o => o.assigned_to === 'InHouse');

      // Connected calls = confirmed + cancelled (orders where agent actually talked)
      const ccConnected = ccOrders.filter(o => ['confirmed', 'cancelled'].includes(o.confirmation_status)).length;
      const amanConnected = amanOrders.filter(o => ['confirmed', 'cancelled'].includes(o.confirmation_status)).length;

      // ====== SUMMARY SHEET (CC vs Aman) ======
      const sumSheet = wb.addWorksheet('Summary');
      sumSheet.columns = [
        { header: 'Metric', key: 'metric', width: 28 },
        { header: 'Call Centre (CC)', key: 'cc', width: 18 },
        { header: 'Aman (InHouse)', key: 'aman', width: 18 },
        { header: 'Total', key: 'total', width: 14 },
      ];
      styleHeaders(sumSheet);

      function teamCount(filter) {
        const cc = ccOrders.filter(filter).length;
        const aman = amanOrders.filter(filter).length;
        return { cc, aman, total: cc + aman };
      }

      const summaryMetrics = [
        ['Total Orders', () => true],
        ['Confirmed', o => o.confirmation_status === 'confirmed'],
        ['Cancelled', o => o.confirmation_status === 'cancelled'],
        ['DNP (at least 1 attempt)', o => o.had_dnp],
        ['Pending', o => o.confirmation_status === 'pending'],
      ];
      for (const [label, fn] of summaryMetrics) {
        const c = teamCount(fn);
        sumSheet.addRow({ metric: label, cc: c.cc, aman: c.aman, total: c.total });
      }

      sumSheet.addRow({});
      const tcConf = teamCount(o => o.confirmation_status === 'confirmed');
      const tcCan = teamCount(o => o.confirmation_status === 'cancelled');
      const tcDnp = teamCount(o => o.had_dnp);
      sumSheet.addRow({ metric: 'Confirmation %', cc: pct(tcConf.cc, ccOrders.length), aman: pct(tcConf.aman, amanOrders.length), total: pct(tcConf.total, orders.length) });
      sumSheet.addRow({ metric: 'Cancellation %', cc: pct(tcCan.cc, ccOrders.length), aman: pct(tcCan.aman, amanOrders.length), total: pct(tcCan.total, orders.length) });
      sumSheet.addRow({ metric: 'Connected %', cc: pct(ccConnected, ccOrders.length), aman: pct(amanConnected, amanOrders.length), total: pct(ccConnected + amanConnected, orders.length) });
      sumSheet.addRow({ metric: 'Not Connected %', cc: pct(ccOrders.length - ccConnected, ccOrders.length), aman: pct(amanOrders.length - amanConnected, amanOrders.length), total: pct(orders.length - ccConnected - amanConnected, orders.length) });

      // Cost section
      sumSheet.addRow({});
      const totalAllCosts = totalCcCost + totalAmanSalary;
      sumSheet.addRow({ metric: `Period: ${fromDate} to ${toDate}` });
      sumSheet.addRow({ metric: `Selected Days: ${selectedDays}` });
      sumSheet.addRow({ metric: 'CC Cost for Period (₹)', cc: Math.round(totalCcCost), aman: '—', total: Math.round(totalCcCost) });
      sumSheet.addRow({ metric: 'Aman Salary for Period (₹)', cc: '—', aman: Math.round(totalAmanSalary), total: Math.round(totalAmanSalary) });
      sumSheet.addRow({ metric: 'Total Cost (₹)', cc: Math.round(totalCcCost), aman: Math.round(totalAmanSalary), total: Math.round(totalAllCosts) });
      sumSheet.addRow({ metric: 'Cost per Connected Call (₹)', cc: ccConnected ? Math.round(totalCcCost / ccConnected) : '—', aman: amanConnected ? Math.round(totalAmanSalary / amanConnected) : '—', total: (ccConnected + amanConnected) ? Math.round(totalAllCosts / (ccConnected + amanConnected)) : '—' });

      // ====== DATE-WISE SHEET ======
      const dateSheet = wb.addWorksheet('Date-wise');
      dateSheet.columns = [
        { header: 'Date', key: 'date', width: 14 },
        { header: 'Total', key: 'total', width: 10 },
        { header: 'Confirmed', key: 'confirmed', width: 12 },
        { header: 'Cancelled', key: 'cancelled', width: 12 },
        { header: 'DNP', key: 'dnp', width: 10 },
        { header: 'Pending', key: 'pending', width: 10 },
        { header: 'Confirm %', key: 'confPct', width: 12 },
      ];
      styleHeaders(dateSheet);

      const byDate = {};
      for (const o of orders) {
        const d = new Date(o.shopify_created_at).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
        if (!byDate[d]) byDate[d] = { total: 0, confirmed: 0, cancelled: 0, dnp: 0, pending: 0 };
        byDate[d].total++;
        if (o.confirmation_status === 'confirmed') byDate[d].confirmed++;
        else if (o.confirmation_status === 'cancelled') byDate[d].cancelled++;
        if (o.confirmation_status === 'pending') byDate[d].pending++;
        if (o.had_dnp) byDate[d].dnp++;
      }
      for (const d of Object.keys(byDate).sort()) {
        const r = byDate[d];
        dateSheet.addRow({ date: d, total: r.total, confirmed: r.confirmed, cancelled: r.cancelled, dnp: r.dnp, pending: r.pending, confPct: pct(r.confirmed, r.total) });
      }

      // ====== ORDER-WISE SHEET ======
      const orderCols = [
        { header: 'Order Date', key: 'date', width: 14 },
        { header: 'Order', key: 'order', width: 12 },
        { header: 'Product', key: 'product', width: 30 },
        { header: 'Customer', key: 'customer', width: 20 },
        { header: 'Phone', key: 'phone', width: 14 },
        { header: 'City', key: 'city', width: 16 },
        { header: 'Amount', key: 'amount', width: 10 },
        { header: 'Payment', key: 'payment', width: 10 },
        { header: 'Status', key: 'status', width: 12 },
        { header: 'Assigned To', key: 'assigned', width: 14 },
        { header: 'Call Attempts', key: 'attempts', width: 14 },
        { header: 'DNP', key: 'dnp', width: 8 },
      ];

      function addOrderRows(sheet, list) {
        for (const o of list) {
          const row = sheet.addRow({
            date: fmtDate(o.shopify_created_at), order: o.order_name,
            product: productName(o.line_items), customer: o.customer_name,
            phone: o.customer_phone, city: o.shipping_city,
            amount: Number(o.total_price), payment: o.payment_method,
            status: o.confirmation_status,
            assigned: o.assigned_to === 'InHouse' ? 'Aman' : o.assigned_to,
            attempts: o.call_attempts, dnp: o.had_dnp ? 'Yes' : '',
          });
          if (o.confirmation_status === 'confirmed') row.getCell('status').font = { color: { argb: 'FF10B981' }, bold: true };
          else if (o.confirmation_status === 'cancelled') row.getCell('status').font = { color: { argb: 'FFEF4444' }, bold: true };
        }
      }

      const allSheet = wb.addWorksheet('Order-wise (All)');
      allSheet.columns = orderCols.map(c => ({ ...c }));
      styleHeaders(allSheet);
      addOrderRows(allSheet, orders);

      const ccSheet = wb.addWorksheet('Call Centre');
      ccSheet.columns = orderCols.map(c => ({ ...c }));
      styleHeaders(ccSheet);
      addOrderRows(ccSheet, ccOrders);

      const amanSheet = wb.addWorksheet('Aman (InHouse)');
      amanSheet.columns = orderCols.map(c => ({ ...c }));
      styleHeaders(amanSheet);
      addOrderRows(amanSheet, amanOrders);

      // ====== CC vs AMAN SUMMARY SHEET ======
      const teamSheet = wb.addWorksheet('CC vs Aman Summary');
      teamSheet.columns = [
        { header: 'Metric', key: 'metric', width: 28 },
        { header: 'Call Centre', key: 'cc', width: 16 },
        { header: 'Aman (InHouse)', key: 'aman', width: 18 },
        { header: 'Total', key: 'total', width: 14 },
      ];
      styleHeaders(teamSheet);

      for (const [label, fn] of summaryMetrics) {
        const c = teamCount(fn);
        teamSheet.addRow({ metric: label, cc: c.cc, aman: c.aman, total: c.total });
      }
      teamSheet.addRow({});
      teamSheet.addRow({ metric: 'Confirmation %', cc: pct(tcConf.cc, ccOrders.length), aman: pct(tcConf.aman, amanOrders.length), total: pct(tcConf.total, orders.length) });
      teamSheet.addRow({ metric: 'Cancellation %', cc: pct(tcCan.cc, ccOrders.length), aman: pct(tcCan.aman, amanOrders.length), total: pct(tcCan.total, orders.length) });
      teamSheet.addRow({ metric: 'Connected %', cc: pct(ccConnected, ccOrders.length), aman: pct(amanConnected, amanOrders.length), total: pct(ccConnected + amanConnected, orders.length) });
      teamSheet.addRow({ metric: 'Not Connected %', cc: pct(ccOrders.length - ccConnected, ccOrders.length), aman: pct(amanOrders.length - amanConnected, amanOrders.length), total: pct(orders.length - ccConnected - amanConnected, orders.length) });
      teamSheet.addRow({});
      teamSheet.addRow({ metric: 'CC Cost for Period (₹)', cc: Math.round(totalCcCost), aman: '—', total: Math.round(totalCcCost) });
      teamSheet.addRow({ metric: 'Aman Salary for Period (₹)', cc: '—', aman: Math.round(totalAmanSalary), total: Math.round(totalAmanSalary) });
      teamSheet.addRow({ metric: 'Total Cost (₹)', cc: Math.round(totalCcCost), aman: Math.round(totalAmanSalary), total: Math.round(totalAllCosts) });
      teamSheet.addRow({ metric: 'Cost per Connected Call (₹)', cc: ccConnected ? Math.round(totalCcCost / ccConnected) : '—', aman: amanConnected ? Math.round(totalAmanSalary / amanConnected) : '—', total: (ccConnected + amanConnected) ? Math.round(totalAllCosts / (ccConnected + amanConnected)) : '—' });
  }

  // ===================== EXCEL REPORT DOWNLOAD =====================
  app.get('/api/admin/report/download', async (req, res) => {
    try {
      const ExcelJS = require('exceljs');
      const fromDate = req.query.from;
      const toDate = req.query.to;
      console.log('[Report] Download requested:', fromDate, 'to', toDate);
      if (!fromDate || !toDate) throw new HttpError(400, 'from and to are required (YYYY-MM-DD)');

      const fromDt = new Date(fromDate + 'T00:00:00+05:30');
      const toDt = new Date(toDate + 'T23:59:59+05:30');
      if (isNaN(fromDt) || isNaN(toDt)) throw new HttpError(400, 'Invalid dates');

      const wb = new ExcelJS.Workbook();
      wb.creator = 'Jaadu Diet CRM';
      await addClassicSheets(wb, fromDate, toDate);

      // Send Excel
      const filename = `CRM_Report_${fromDate}_to_${toDate}.xlsx`;
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      await wb.xlsx.write(res);
      res.end();
    } catch (err) {
      console.error('[Report] Download error:', err.message, err.stack);
      if (!res.headersSent) sendError(res, err);
    }
  });

  return { markPrepaidPaid, syncOrderToShopify };
};
