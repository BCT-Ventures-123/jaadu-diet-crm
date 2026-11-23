// Admin-only desk: refunds (Razorpay gateway + manual), courier money & weight evidence,
// blacklist, ad-exclusion pincodes. All routes live under /api/admin (login + admin role enforced in cc_routes.js).
const axios = require('axios');
const cfg = require('./lib/config');
const { parseCsv } = require('./lib/csv');
const { mapColumns, remittanceRows, weightRows } = require('./lib/courierImport');
const { dayRange } = require('./lib/leadFilters');
const { toCsv } = require('./lib/reportMath');
const { buildRepeat } = require('./lib/repeatMath');

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clean = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const istToday = () => new Date().toLocaleDateString('en-CA', { timeZone: cfg.TIMEZONE });
const IS_COD = `(UPPER(COALESCE(payment_method,'')) = 'COD' AND converted_to_prepaid IS NOT TRUE)`;
const wantsCsv = (req) => String(req.query.format || '').toLowerCase() === 'csv';

function fail(res, err) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  console.error('[Desk]', err);
  return res.status(500).json({ error: 'Server error' });
}
function sendCsv(res, name, columns, rows) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send(toCsv(columns, rows));
}
const normPhone = (p) => String(p || '').replace(/\D/g, '').slice(-10);

module.exports = function (app, { db, dbOne }) {
  const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { fail(res, e); } };

  // ================================================================ REFUNDS
  const REFUND_SELECT = `
    SELECT r.id, r.order_id, r.refund_amount, r.refund_reason, r.refund_method, r.status, r.requested_by, r.approved_by,
           r.processed_at, r.utr_number, r.notes, r.created_at,
           ROUND(EXTRACT(EPOCH FROM (COALESCE(r.processed_at, NOW()) - r.created_at)) / 3600)::int AS age_hours, r.updated_at,
           o.order_name, o.shopify_order_id, o.customer_name, o.customer_phone, o.total_price, o.payment_method, o.razorpay_payment_id,
           COALESCE(o.shopify_created_at, o.created_at) AS order_date
    FROM manual_refunds_queue r JOIN orders_master o ON o.id = r.order_id`;

  app.get('/api/admin/refunds', wrap(async (req, res) => {
    const status = ['pending', 'approved', 'processed', 'rejected'].includes(req.query.status) ? req.query.status : null;
    const max = req.query.max_amount ? num(req.query.max_amount) : null;
    const q = clean(req.query.q, 60);
    const re = /^\d{4}-\d{2}-\d{2}$/;
    const from = re.test(req.query.from || '') ? req.query.from : null;
    const to = re.test(req.query.to || '') ? req.query.to : null;
    const reason = clean(req.query.reason, 60);
    const method = ['razorpay', 'manual_upi'].includes(req.query.method) ? req.query.method : null;
    const by = clean(req.query.by, 60);
    const oldestFirst = req.query.sort === 'age';
    const rows = await db(
      `${REFUND_SELECT}
       WHERE ($1::text IS NULL OR r.status = $1) AND ($2::numeric IS NULL OR r.refund_amount <= $2)
         AND ($3::text IS NULL OR o.order_name ILIKE $3 OR o.customer_phone ILIKE $3 OR o.customer_name ILIKE $3)
         AND ($4::date IS NULL OR r.created_at >= ($4::date)::timestamp AT TIME ZONE 'Asia/Kolkata')
         AND ($5::date IS NULL OR r.created_at < (($5::date) + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')
         AND ($6::text IS NULL OR r.refund_reason ILIKE $6) AND ($7::text IS NULL OR r.refund_method = $7) AND ($8::text IS NULL OR r.requested_by ILIKE $8)
       ORDER BY CASE r.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, ${oldestFirst ? 'r.created_at ASC' : 'r.created_at DESC'} LIMIT 500`,
      [status, max, q ? `%${q}%` : null, from, to, reason ? `%${reason}%` : null, method, by ? `%${by}%` : null]);
    if (wantsCsv(req)) {
      return sendCsv(res, `refunds_${istToday()}.csv`,
        ['created_at', 'order_name', 'customer_name', 'customer_phone', 'refund_amount', 'refund_reason', 'refund_method', 'status', 'age_hours', 'requested_by', 'approved_by', 'processed_at', 'utr_number', 'notes'], rows);
    }
    res.json(rows);
  }));

  // Control view for the Refunds tab: what is waiting and how old, what was paid out, why, who handled it, and prepaid orders cancelled with no refund raised.
  app.get('/api/admin/refund-summary', wrap(async (req, res) => {
    const re = /^\d{4}-\d{2}-\d{2}$/;
    const to = re.test(req.query.to || '') ? req.query.to : istToday();
    const from = re.test(req.query.from || '') ? req.query.from : new Date(Date.now() - 29 * 864e5).toLocaleDateString('en-CA', { timeZone: cfg.TIMEZONE });
    const start = new Date(from + 'T00:00:00+05:30'), end = new Date(new Date(to + 'T00:00:00+05:30').getTime() + 864e5);
    const sla = Number(process.env.REFUND_SLA_HOURS) || 48;
    const P = [start, end];
    const inRange = (col) => `${col} >= $1 AND ${col} < $2`;
    const SUBREFUNDED = `COALESCE((SELECT SUM(r.refund_amount) FROM manual_refunds_queue r WHERE r.order_id = o.id AND r.status IN ('pending','approved','processed')), 0)`;
    const [kpi, ageing, stuck, byReason, byMethod, byRequested, byProcessed, reqDay, paidDay, owed] = await Promise.all([
      dbOne(`SELECT COUNT(*) FILTER (WHERE status = 'pending')::int AS waiting_n, COALESCE(SUM(refund_amount) FILTER (WHERE status = 'pending'), 0)::float AS waiting_amt,
                    MIN(created_at) FILTER (WHERE status IN ('pending','approved')) AS oldest_open,
                    COUNT(*) FILTER (WHERE status = 'approved')::int AS progress_n, COALESCE(SUM(refund_amount) FILTER (WHERE status = 'approved'), 0)::float AS progress_amt,
                    COUNT(*) FILTER (WHERE status = 'processed' AND ${inRange('processed_at')})::int AS done_n,
                    COALESCE(SUM(refund_amount) FILTER (WHERE status = 'processed' AND ${inRange('processed_at')}), 0)::float AS done_amt,
                    COUNT(*) FILTER (WHERE status = 'rejected' AND ${inRange('updated_at')})::int AS rejected_n,
                    COUNT(*) FILTER (WHERE ${inRange('created_at')})::int AS requested_n, COALESCE(SUM(refund_amount) FILTER (WHERE ${inRange('created_at')}), 0)::float AS requested_amt,
                    (AVG(EXTRACT(EPOCH FROM (processed_at - created_at)) / 3600) FILTER (WHERE status = 'processed' AND ${inRange('processed_at')}))::float AS avg_hours
             FROM manual_refunds_queue`, P),
      dbOne(`SELECT COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 day')::int AS d0, COUNT(*) FILTER (WHERE created_at <= NOW() - INTERVAL '1 day' AND created_at > NOW() - INTERVAL '3 days')::int AS d1,
                    COUNT(*) FILTER (WHERE created_at <= NOW() - INTERVAL '3 days' AND created_at > NOW() - INTERVAL '7 days')::int AS d3, COUNT(*) FILTER (WHERE created_at <= NOW() - INTERVAL '7 days')::int AS d7,
                    COALESCE(SUM(refund_amount) FILTER (WHERE created_at > NOW() - INTERVAL '1 day'), 0)::float AS a0, COALESCE(SUM(refund_amount) FILTER (WHERE created_at <= NOW() - INTERVAL '1 day' AND created_at > NOW() - INTERVAL '3 days'), 0)::float AS a1,
                    COALESCE(SUM(refund_amount) FILTER (WHERE created_at <= NOW() - INTERVAL '3 days' AND created_at > NOW() - INTERVAL '7 days'), 0)::float AS a3, COALESCE(SUM(refund_amount) FILTER (WHERE created_at <= NOW() - INTERVAL '7 days'), 0)::float AS a7,
                    COUNT(*) FILTER (WHERE created_at < NOW() - make_interval(hours => $1::int))::int AS overdue_n, COALESCE(SUM(refund_amount) FILTER (WHERE created_at < NOW() - make_interval(hours => $1::int)), 0)::float AS overdue_amt
             FROM manual_refunds_queue WHERE status IN ('pending','approved')`, [sla]),
      dbOne(`SELECT COUNT(*)::int AS n, COALESCE(SUM(refund_amount), 0)::float AS amt FROM manual_refunds_queue WHERE status = 'approved' AND updated_at < NOW() - INTERVAL '1 hour'`),
      db(`SELECT LOWER(TRIM(COALESCE(NULLIF(refund_reason, ''), '(no reason)'))) AS reason, COUNT(*)::int AS n, COALESCE(SUM(refund_amount), 0)::float AS amt
          FROM manual_refunds_queue WHERE ${inRange('created_at')} GROUP BY 1 ORDER BY 3 DESC LIMIT 10`, P),
      db(`SELECT COALESCE(refund_method, 'unknown') AS method, COUNT(*)::int AS n, COALESCE(SUM(refund_amount), 0)::float AS amt
          FROM manual_refunds_queue WHERE status = 'processed' AND ${inRange('processed_at')} GROUP BY 1 ORDER BY 3 DESC`, P),
      db(`SELECT COALESCE(requested_by, '(unknown)') AS who, COUNT(*)::int AS n, COALESCE(SUM(refund_amount), 0)::float AS amt
          FROM manual_refunds_queue WHERE ${inRange('created_at')} GROUP BY 1 ORDER BY 2 DESC LIMIT 15`, P),
      db(`SELECT COALESCE(approved_by, '(unknown)') AS who, COUNT(*)::int AS n, COALESCE(SUM(refund_amount), 0)::float AS amt
          FROM manual_refunds_queue WHERE status = 'processed' AND ${inRange('processed_at')} GROUP BY 1 ORDER BY 2 DESC LIMIT 15`, P),
      db(`SELECT (created_at AT TIME ZONE 'Asia/Kolkata')::date::text AS day, COUNT(*)::int AS n, COALESCE(SUM(refund_amount), 0)::float AS amt FROM manual_refunds_queue WHERE ${inRange('created_at')} GROUP BY 1`, P),
      db(`SELECT (processed_at AT TIME ZONE 'Asia/Kolkata')::date::text AS day, COUNT(*)::int AS n, COALESCE(SUM(refund_amount), 0)::float AS amt FROM manual_refunds_queue WHERE status = 'processed' AND ${inRange('processed_at')} GROUP BY 1`, P),
      // Prepaid orders cancelled in the last 90 days that still have money to return and no refund request raised for it.
      db(`SELECT o.id, o.order_name, o.customer_name, o.customer_phone, COALESCE(o.cancelled_at, o.updated_at) AS cancelled_at,
                 (COALESCE(NULLIF(o.prepaid_amount, 0), o.total_price) - ${SUBREFUNDED})::float AS owed
          FROM orders_master o
          WHERE (UPPER(COALESCE(o.payment_method, '')) <> 'COD' OR COALESCE(o.converted_to_prepaid, FALSE))
            AND (o.razorpay_payment_id IS NOT NULL OR COALESCE(o.prepaid_amount, 0) > 0)
            AND o.confirmation_status = 'cancelled'
            AND NOT (LOWER(TRIM(COALESCE(o.customer_name, ''))) IN ('test test','test','test order','dummy') OR COALESCE(o.customer_name, '') ~* '^\\s*test\\M')
            AND COALESCE(o.cancelled_at, o.updated_at) > NOW() - INTERVAL '90 days'
            AND COALESCE(NULLIF(o.prepaid_amount, 0), o.total_price) > ${SUBREFUNDED}
          ORDER BY COALESCE(o.cancelled_at, o.updated_at) ASC LIMIT 200`),
    ]);
    const byDay = new Map();
    reqDay.forEach(x => byDay.set(x.day, { day: x.day, requested: x.n, requested_amt: x.amt, paid: 0, paid_amt: 0 }));
    paidDay.forEach(x => { const d = byDay.get(x.day) || { day: x.day, requested: 0, requested_amt: 0, paid: 0, paid_amt: 0 }; d.paid = x.n; d.paid_amt = x.amt; byDay.set(x.day, d); });
    res.json({
      from, to, sla_hours: sla, kpi, ageing, stuck, by_reason: byReason, by_method: byMethod, by_requested: byRequested, by_processed: byProcessed,
      trend: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
      owed: { n: owed.length, total: owed.reduce((s, x) => s + x.owed, 0), rows: owed.slice(0, 25) },
    });
  }));
  // Orders that were paid online (so a refund is possible), newest first. `max_amount` = e.g. 500 to see small orders.
  app.get('/api/admin/refund-orders', wrap(async (req, res) => {
    const max = req.query.max_amount ? num(req.query.max_amount) : null;
    const q = clean(req.query.q, 60);
    const re = /^\d{4}-\d{2}-\d{2}$/;
    const from = re.test(req.query.from || '') ? req.query.from : null;
    const to = re.test(req.query.to || '') ? req.query.to : null;
    const status = ['confirmed', 'cancelled', 'pending', 'wrong_number'].includes(req.query.status) ? req.query.status : null;
    const payMethod = ['COD', 'Prepaid', 'prepaid'].includes(req.query.pay_method) ? req.query.pay_method.toUpperCase() : null;
    const rows = await db(
      `SELECT o.id, o.order_name, o.shopify_order_id, o.customer_name, o.customer_phone, o.total_price, o.prepaid_amount,
              o.payment_method, o.razorpay_payment_id, o.order_status, o.confirmation_status,
              COALESCE(o.shopify_created_at, o.created_at) AS order_date,
              COALESCE((SELECT SUM(r.refund_amount) FROM manual_refunds_queue r WHERE r.order_id = o.id AND r.status = 'processed'), 0) AS refunded,
              COALESCE((SELECT SUM(r.refund_amount) FROM manual_refunds_queue r WHERE r.order_id = o.id AND r.status IN ('pending','approved')), 0) AS requested_open
       FROM orders_master o
       WHERE (UPPER(COALESCE(o.payment_method,'')) <> 'COD' OR o.converted_to_prepaid OR o.razorpay_payment_id IS NOT NULL)
         AND ($1::numeric IS NULL OR o.total_price <= $1)
         AND ($2::text IS NULL OR o.order_name ILIKE $2 OR o.customer_phone ILIKE $2 OR o.customer_name ILIKE $2 OR CAST(o.shopify_order_id AS TEXT) ILIKE $2)
         AND ($3::date IS NULL OR COALESCE(o.shopify_created_at, o.created_at) >= $3::date)
         AND ($4::date IS NULL OR COALESCE(o.shopify_created_at, o.created_at) < ($4::date + 1))
         AND ($5::text IS NULL OR o.confirmation_status = $5)
         AND ($6::text IS NULL OR UPPER(o.payment_method) = $6)
       ORDER BY COALESCE(o.shopify_created_at, o.created_at) DESC LIMIT 500`,
      [max, q ? `%${q}%` : null, from, to, status, payMethod]);
    res.json(rows);
  }));

  app.post('/api/admin/refunds', wrap(async (req, res) => {
    const { order_id } = req.body || {};
    if (!UUID_RE.test(String(order_id))) throw new HttpError(400, 'Invalid order');
    const amount = num(req.body.amount);
    const reason = clean(req.body.reason, 300);
    if (!amount || amount <= 0) throw new HttpError(400, 'Enter a refund amount');
    if (!reason) throw new HttpError(400, 'Enter a reason');
    const o = await dbOne('SELECT id, total_price, prepaid_amount FROM orders_master WHERE id = $1', [order_id]);
    if (!o) throw new HttpError(404, 'Order not found');
    const used = await dbOne(
      `SELECT COALESCE(SUM(refund_amount),0) AS n FROM manual_refunds_queue WHERE order_id = $1 AND status IN ('pending','approved','processed')`, [order_id]);
    const paid = Number(o.prepaid_amount) > 0 ? Number(o.prepaid_amount) : Number(o.total_price);
    const left = Math.round((paid - Number(used.n)) * 100) / 100;
    if (amount > left) throw new HttpError(400, `Only Rs ${left} is left to refund on this order`);
    const row = await dbOne(
      `INSERT INTO manual_refunds_queue (order_id, refund_amount, refund_reason, refund_method, status, requested_by)
       VALUES ($1,$2,$3,$4,'pending',$5) RETURNING id`,
      [order_id, amount, reason, req.body.method === 'manual' ? 'manual_upi' : 'razorpay', req.agent.display_name]);
    res.json({ id: row.id });
  }));

  app.post('/api/admin/refunds/:id/gateway', wrap(async (req, res) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) throw new HttpError(400, 'Invalid refund');
    const keyId = process.env.RAZORPAY_KEY_ID, keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) throw new HttpError(503, 'Razorpay keys are not set on the server');
    const auth = { username: keyId, password: keySecret };

    // Claim first, so a double click can never send two refunds.
    const claimed = await dbOne(
      `UPDATE manual_refunds_queue SET status = 'approved', approved_by = $2, updated_at = NOW()
       WHERE id = $1 AND status = 'pending' RETURNING *`, [id, req.agent.display_name]);
    if (!claimed) throw new HttpError(409, 'This refund is not waiting (already processed or in progress)');
    const revert = (note) => db(`UPDATE manual_refunds_queue SET status = 'pending', notes = $2, updated_at = NOW() WHERE id = $1`, [id, note]);

    const o = await dbOne('SELECT order_name, razorpay_payment_id, shopify_order_id FROM orders_master WHERE id = $1', [claimed.order_id]);

    // Auto-fetch Razorpay payment ID if missing
    if (!o?.razorpay_payment_id && o?.shopify_order_id) {
      const store = process.env.SHOPIFY_STORE_DOMAIN, shopToken = process.env.SHOPIFY_ACCESS_TOKEN;
      const apiVer = process.env.SHOPIFY_API_VERSION || '2024-10';
      if (store && shopToken) {
        try {
          const txnResp = await axios.get(`https://${store}/admin/api/${apiVer}/orders/${o.shopify_order_id}/transactions.json`,
            { headers: { 'X-Shopify-Access-Token': shopToken }, timeout: 10000 });
          let rzpOrderId = null;
          for (const txn of (txnResp.data?.transactions || [])) {
            if (txn.kind === 'sale' || txn.kind === 'capture' || txn.kind === 'authorization') {
              const receipt = typeof txn.receipt === 'string' ? JSON.parse(txn.receipt) : txn.receipt;
              const pid = receipt?.payment_id || receipt?.id || '';
              const c = typeof pid === 'string' ? pid : String(pid || '');
              if (c.startsWith('pay_')) { o.razorpay_payment_id = c; break; }
              if (c.startsWith('order_')) { rzpOrderId = c; break; }
            }
          }
          if (!o.razorpay_payment_id && rzpOrderId) {
            const payResp = await axios.get(`https://api.razorpay.com/v1/orders/${rzpOrderId}/payments`, { auth, timeout: 10000 });
            const captured = (payResp.data?.items || []).find(p => p.status === 'captured') || payResp.data?.items?.[0];
            if (captured?.id) o.razorpay_payment_id = captured.id;
          }
          if (o.razorpay_payment_id) {
            await db('UPDATE orders_master SET razorpay_payment_id = $1 WHERE id = $2', [o.razorpay_payment_id, claimed.order_id]);
          }
        } catch (e) {
          console.error('[Refund] Auto-fetch payment ID failed:', e.message);
        }
      }
    }

    if (!o?.razorpay_payment_id) {
      await revert('No Razorpay payment found for this order. Use "Mark refunded manually".');
      throw new HttpError(400, 'Could not find a Razorpay payment for this order. Use "Mark refunded manually" instead.');
    }
    try {
      const pay = (await axios.get(`https://api.razorpay.com/v1/payments/${encodeURIComponent(o.razorpay_payment_id)}`, { auth, timeout: 15000 })).data;
      const refundable = (Number(pay.amount) - Number(pay.amount_refunded || 0)) / 100;
      if (refundable < 0.01) {
        await db(
          `UPDATE manual_refunds_queue SET status = 'processed', processed_at = NOW(), refund_method = 'razorpay',
             notes = 'Already fully refunded on Razorpay', updated_at = NOW() WHERE id = $1`, [id]);
        return res.json({ success: true, already_refunded: true, message: 'Already refunded on Razorpay' });
      }
      if (Number(claimed.refund_amount) > refundable + 0.001) {
        await revert(`Razorpay says only Rs ${refundable} can still be refunded on this payment.`);
        throw new HttpError(400, `Razorpay says only Rs ${refundable} can still be refunded on this payment`);
      }
      const rf = (await axios.post(`https://api.razorpay.com/v1/payments/${encodeURIComponent(o.razorpay_payment_id)}/refund`, {
        amount: Math.round(Number(claimed.refund_amount) * 100), speed: 'normal', receipt: id,
        notes: { order: o.order_name || '', reason: String(claimed.refund_reason || '').slice(0, 200), by: req.agent.display_name },
      }, { auth, timeout: 20000 })).data;
      await db(
        `UPDATE manual_refunds_queue SET status = 'processed', processed_at = NOW(), utr_number = $2, refund_method = 'razorpay',
           notes = $3, updated_at = NOW() WHERE id = $1`,
        [id, rf.id, `Razorpay refund ${rf.id} (${rf.status || 'created'})`]);
      res.json({ success: true, refund_id: rf.id, status: rf.status });
    } catch (e) {
      if (e instanceof HttpError) throw e;
      const msg = e.response?.data?.error?.description || e.message;
      console.error('[Refund] gateway failed:', msg);
      await revert(`Gateway error: ${String(msg).slice(0, 200)}`);
      throw new HttpError(502, `Razorpay refused the refund: ${msg}`);
    }
  }));

  app.post('/api/admin/refunds/:id/manual', wrap(async (req, res) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) throw new HttpError(400, 'Invalid refund');
    const utr = clean(req.body?.utr, 60);
    if (utr.length < 4) throw new HttpError(400, 'Enter the UTR / transaction number of the refund you sent');
    const r = await dbOne(
      `UPDATE manual_refunds_queue SET status = 'processed', processed_at = NOW(), utr_number = $2, refund_method = 'manual_upi',
         approved_by = $3, notes = $4, updated_at = NOW()
       WHERE id = $1 AND status IN ('pending','approved') RETURNING id`,
      [id, utr, req.agent.display_name, clean(req.body?.notes, 300) || 'Refunded manually']);
    if (!r) throw new HttpError(409, 'This refund is already closed');
    res.json({ success: true });
  }));

  app.post('/api/admin/refunds/:id/reject', wrap(async (req, res) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) throw new HttpError(400, 'Invalid refund');
    const r = await dbOne(
      `UPDATE manual_refunds_queue SET status = 'rejected', approved_by = $2, notes = $3, updated_at = NOW()
       WHERE id = $1 AND status = 'pending' RETURNING id`,
      [id, req.agent.display_name, clean(req.body?.notes, 300) || 'Rejected']);
    if (!r) throw new HttpError(409, 'Only waiting refunds can be rejected');
    res.json({ success: true });
  }));

  // ================================================================ RAZORPAY PAYMENTS DASHBOARD
  // Reads every payment / refund straight from Razorpay (short cache) and refunds through the same API.
  const RZP = process.env.RAZORPAY_API_BASE || 'https://api.razorpay.com/v1';
  const rzpAuth = () => {
    const u = process.env.RAZORPAY_KEY_ID, p = process.env.RAZORPAY_KEY_SECRET;
    if (!u || !p) throw new HttpError(503, 'Razorpay keys are not set on the server');
    return { username: u, password: p };
  };
  const rzpCache = new Map();
  const CACHE_MS = 60 * 1000, MAX_ITEMS = 5000;
  const dayStart = (d) => Math.floor(new Date(`${d}T00:00:00+05:30`).getTime() / 1000);

  async function rzpAll(kind, from, to, force) {
    const key = `${kind}|${from}|${to}`;
    const hit = rzpCache.get(key);
    if (!force && hit && Date.now() - hit.at < CACHE_MS) return hit;
    const auth = rzpAuth();
    const items = [];
    let truncated = false;
    for (let skip = 0; ; skip += 100) {
      let page;
      try {
        page = (await axios.get(`${RZP}/${kind}`, { auth, params: { from, to, count: 100, skip }, timeout: 20000 })).data.items || [];
      } catch (e) {
        throw new HttpError(502, `Razorpay error: ${e.response?.data?.error?.description || e.message}`);
      }
      items.push(...page);
      if (page.length < 100) break;
      if (items.length >= MAX_ITEMS) { truncated = true; break; }
    }
    const out = { at: Date.now(), items, truncated };
    rzpCache.set(key, out);
    return out;
  }

  function rzpRange(q) {
    const re = /^\d{4}-\d{2}-\d{2}$/;
    const t = istToday();
    const to = re.test(q.to || '') ? q.to : t;
    const from = re.test(q.from || '') ? q.from : new Date(new Date(`${to}T12:00:00+05:30`).getTime() - 29 * 86400000).toLocaleDateString('en-CA', { timeZone: cfg.TIMEZONE });
    const f = dayStart(from), e = dayStart(to) + 86400;
    if (!(e > f) || e - f > 400 * 86400) throw new HttpError(400, 'Choose a date range of up to 400 days');
    return { from: f, to: e - 1, fromDate: from, toDate: to };
  }
  const phoneOf = (c) => String(c || '').replace(/\D/g, '').slice(-10);

  app.get('/api/admin/rzp/payments', wrap(async (req, res) => {
    const r = rzpRange(req.query);
    const { items, truncated } = await rzpAll('payments', r.from, r.to, req.query.refresh === '1');
    const all = items.map(p => {
      const refunded = Number(p.amount_refunded || 0) / 100;
      const amount = Number(p.amount) / 100;
      const status = p.status === 'refunded' ? 'refunded' : (p.status === 'captured' && refunded > 0 ? 'partial' : p.status);
      return {
        id: p.id, created_at: new Date(p.created_at * 1000).toISOString(), email: p.email || '', phone: phoneOf(p.contact), method: p.method || '',
        amount, refunded, refundable: p.status === 'captured' ? Math.round((amount - refunded) * 100) / 100 : 0, status,
        note_order: p.notes && typeof p.notes === 'object' ? (p.notes.order_id || p.notes.order_number || '') : '', description: p.description || '',
        error: p.error_description || '',
      };
    });
    const stats = {
      total: all.length,
      captured: all.filter(p => p.status === 'captured' || p.status === 'partial').length,
      refunded: all.filter(p => p.status === 'refunded' || p.status === 'partial').length,
      captured_amount: Math.round(all.filter(p => p.status === 'captured' || p.status === 'partial' || p.status === 'refunded').reduce((s, p) => s + p.amount, 0) * 100) / 100,
      refunded_amount: Math.round(all.reduce((s, p) => s + p.refunded, 0) * 100) / 100,
    };
    const q = clean(req.query.q, 60).toLowerCase();
    const min = req.query.min !== undefined && req.query.min !== '' ? num(req.query.min) : null;
    const max = req.query.max !== undefined && req.query.max !== '' ? num(req.query.max) : null;
    const st = clean(req.query.status, 20), me = clean(req.query.method, 20);
    let rows = all.filter(p =>
      (!st || p.status === st || (st === 'refundable' && p.refundable > 0)) && (!me || p.method === me) && (min === null || p.amount >= min) && (max === null || p.amount <= max) &&
      (!q || p.id.toLowerCase().includes(q) || p.email.toLowerCase().includes(q) || p.phone.includes(q) || String(p.note_order).toLowerCase().includes(q)));
    const matched = rows.length;
    rows = rows.slice(0, 500);

    // Link payments back to CRM orders.
    const ids = rows.map(p => p.id);
    const noteIds = [...new Set(rows.map(p => p.note_order).filter(v => UUID_RE.test(String(v))))];
    const orders = ids.length ? await db(
      `SELECT id, order_name, razorpay_payment_id FROM orders_master WHERE razorpay_payment_id = ANY($1) OR id = ANY($2::uuid[])`, [ids, noteIds]) : [];
    const byPay = new Map(orders.filter(o => o.razorpay_payment_id).map(o => [o.razorpay_payment_id, o.order_name]));
    const byId = new Map(orders.map(o => [o.id, o.order_name]));
    rows.forEach(p => { p.crm_order = byPay.get(p.id) || byId.get(p.note_order) || ''; });
    res.json({ from: r.fromDate, to: r.toDate, stats, rows, matched, truncated, fetched_at: new Date().toISOString() });
  }));

  app.get('/api/admin/rzp/refunds', wrap(async (req, res) => {
    const r = rzpRange(req.query);
    const { items, truncated } = await rzpAll('refunds', r.from, r.to, req.query.refresh === '1');
    const rows = items.map(x => ({
      id: x.id, payment_id: x.payment_id, created_at: new Date(x.created_at * 1000).toISOString(), amount: Number(x.amount) / 100,
      status: x.status, speed: x.speed_processed || x.speed_requested || '',
      note: x.notes && typeof x.notes === 'object' ? [x.notes.reason, x.notes.by && `by ${x.notes.by}`].filter(Boolean).join(' ') : '',
    })).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 1000);
    res.json({ from: r.fromDate, to: r.toDate, rows, total: items.length,
      total_amount: Math.round(items.reduce((s, x) => s + Number(x.amount), 0)) / 100, truncated });
  }));

  const refunding = new Set();
  app.post('/api/admin/rzp/refund', wrap(async (req, res) => {
    const payId = clean(req.body?.payment_id, 40);
    if (!/^pay_[A-Za-z0-9]+$/.test(payId)) throw new HttpError(400, 'Invalid payment id');
    const reason = clean(req.body?.reason, 200) || 'Refund from CRM';
    const auth = rzpAuth();
    if (refunding.has(payId)) throw new HttpError(409, 'A refund for this payment is already being processed');
    refunding.add(payId);
    try {
      let pay;
      try { pay = (await axios.get(`${RZP}/payments/${payId}`, { auth, timeout: 15000 })).data; }
      catch (e) { throw new HttpError(502, `Razorpay error: ${e.response?.data?.error?.description || e.message}`); }
      if (pay.status !== 'captured') throw new HttpError(400, `This payment is "${pay.status}", only captured payments can be refunded`);
      const refundable = (Number(pay.amount) - Number(pay.amount_refunded || 0)) / 100;
      const amount = req.body?.amount === undefined || req.body.amount === '' || req.body.amount === null ? refundable : num(req.body.amount);
      if (!amount || amount <= 0) throw new HttpError(400, 'Invalid refund amount');
      if (amount > refundable + 0.001) throw new HttpError(400, `Only Rs ${refundable} can still be refunded on this payment`);
      let rf;
      try {
        rf = (await axios.post(`${RZP}/payments/${payId}/refund`, {
          amount: Math.round(amount * 100), speed: 'normal',
          notes: { reason, by: req.agent.display_name, source: 'crm-dashboard' },
        }, { auth, timeout: 20000 })).data;
      } catch (e) { throw new HttpError(502, `Razorpay refused: ${e.response?.data?.error?.description || e.message}`); }
      rzpCache.clear();
      console.log(`[Refund] ${req.agent.display_name} refunded Rs ${amount} on ${payId} -> ${rf.id}`);
      const o = await dbOne('SELECT id FROM orders_master WHERE razorpay_payment_id = $1', [payId]);
      if (o) {
        await db(`INSERT INTO manual_refunds_queue (order_id, refund_amount, refund_reason, refund_method, status, requested_by, approved_by, processed_at, utr_number, notes)
                  VALUES ($1,$2,$3,'razorpay','processed',$4,$4,NOW(),$5,'Refunded from Razorpay dashboard')`, [o.id, amount, reason, req.agent.display_name, rf.id]).catch(() => {});
      }
      res.json({ success: true, refund_id: rf.id, status: rf.status, amount });
    } finally { refunding.delete(payId); }
  }));

  // ================================================================ BLACKLIST
  app.get('/api/admin/blacklist', wrap(async (req, res) => {
    const [pincodes, phones, suggestions] = await Promise.all([
      db('SELECT pincode, reason, added_by, created_at FROM risk_pincodes_blacklist ORDER BY created_at DESC'),
      db('SELECT phone, reason, added_by, created_at FROM risk_customers_blacklist ORDER BY created_at DESC'),
      db(`SELECT customer_phone AS phone, MAX(customer_name) AS name, COUNT(*)::int AS orders,
                 COUNT(*) FILTER (WHERE rto_status IS NOT NULL)::int AS rto
          FROM orders_master GROUP BY customer_phone
          HAVING COUNT(*) FILTER (WHERE rto_status IS NOT NULL) >= 2
             AND NOT EXISTS (SELECT 1 FROM risk_customers_blacklist b WHERE b.phone = customer_phone)
          ORDER BY rto DESC LIMIT 50`),
    ]);
    res.json({ pincodes, phones, suggestions });
  }));

  app.post('/api/admin/blacklist/add', wrap(async (req, res) => {
    const type = req.body?.type;
    const reason = clean(req.body?.reason, 200) || 'Added by admin';
    if (type === 'pincode') {
      const v = clean(req.body?.value, 10);
      if (!/^\d{6}$/.test(v)) throw new HttpError(400, 'Pincode must be 6 digits');
      await db(`INSERT INTO risk_pincodes_blacklist (pincode, reason, added_by) VALUES ($1,$2,$3)
                ON CONFLICT (pincode) DO UPDATE SET reason = EXCLUDED.reason`, [v, reason, req.agent.display_name]);
    } else if (type === 'phone') {
      const v = normPhone(req.body?.value);
      if (v.length !== 10) throw new HttpError(400, 'Phone must be a 10 digit number');
      await db(`INSERT INTO risk_customers_blacklist (phone, reason, added_by) VALUES ($1,$2,$3)
                ON CONFLICT (phone) DO UPDATE SET reason = EXCLUDED.reason`, [v, reason, req.agent.display_name]);
    } else throw new HttpError(400, 'type must be pincode or phone');
    res.json({ success: true });
  }));

  app.post('/api/admin/blacklist/remove', wrap(async (req, res) => {
    const type = req.body?.type;
    if (type === 'pincode') await db('DELETE FROM risk_pincodes_blacklist WHERE pincode = $1', [clean(req.body?.value, 10)]);
    else if (type === 'phone') await db('DELETE FROM risk_customers_blacklist WHERE phone = $1', [normPhone(req.body?.value)]);
    else throw new HttpError(400, 'type must be pincode or phone');
    res.json({ success: true });
  }));

  // ================================================================ AD-EXCLUSION PINCODES
  app.get('/api/admin/pincodes', wrap(async (req, res) => {
    const minShipped = Math.max(1, Math.floor(num(req.query.min_shipped) ?? 10));
    const minPct = Math.min(100, Math.max(0, num(req.query.min_rto_pct) ?? 30));
    const rows = await db(
      `SELECT shipping_zip AS pincode, COUNT(*)::int AS shipped,
              COUNT(*) FILTER (WHERE rto_status IS NOT NULL)::int AS rto,
              ROUND(COUNT(*) FILTER (WHERE rto_status IS NOT NULL)::numeric / NULLIF(COUNT(*),0) * 100, 1) AS rto_pct,
              EXISTS (SELECT 1 FROM risk_pincodes_blacklist b WHERE b.pincode = shipping_zip) AS blacklisted
       FROM orders_master
       WHERE shipping_zip IS NOT NULL AND order_status IN ('shipped','delivered','rto')
       GROUP BY shipping_zip
       HAVING COUNT(*) >= $1 AND COUNT(*) FILTER (WHERE rto_status IS NOT NULL)::numeric / NULLIF(COUNT(*),0) * 100 >= $2
       ORDER BY rto_pct DESC, shipped DESC`, [minShipped, minPct]);
    if (wantsCsv(req)) return sendCsv(res, `excluded_pincodes_${istToday()}.csv`, ['pincode', 'shipped', 'rto', 'rto_pct', 'blacklisted'], rows);
    const health = await dbOne(
      `SELECT COUNT(*) FILTER (WHERE order_status IN ('shipped','delivered','rto'))::int AS shipped_orders,
              COUNT(*) FILTER (WHERE rto_status IS NOT NULL)::int AS rto_orders FROM orders_master`);
    res.json({ rows, min_shipped: minShipped, min_rto_pct: minPct, health });
  }));

  // ================================================================ REPEAT CUSTOMERS
  // Counts full-price, non-test, non-cancelled orders. A customer = a phone number.
  app.get('/api/admin/repeat', wrap(async (req, res) => {
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : '2026-06-03';
    const minAmount = req.query.min_amount === undefined || req.query.min_amount === '' ? 500 : (num(req.query.min_amount) ?? 500);
    const excludeTest = req.query.exclude_test !== '0';
    const onlyDelivered = req.query.only_delivered === '1';
    const testPhones = new Set(
      `${process.env.TEST_PHONES || ''},${req.query.test_phones || ''}`.split(/[\s,;]+/).map(normPhone).filter(p => p.length === 10));
    const rows = await db(
      `SELECT RIGHT(regexp_replace(COALESCE(customer_phone,''), '\\D', '', 'g'), 10) AS phone, customer_name AS name,
              COALESCE(shopify_created_at, created_at) AS date, total_price AS price
       FROM orders_master
       WHERE COALESCE(shopify_created_at, created_at) >= $1::timestamptz AND total_price >= $2
         AND COALESCE(confirmation_status,'') <> 'cancelled' AND COALESCE(order_status,'') <> 'cancelled'
         AND ($3::boolean = FALSE OR delivered_at IS NOT NULL)`,
      [`${from}T00:00:00+05:30`, minAmount, onlyDelivered]);
    let testExcluded = 0;
    const counted = rows.filter(r => {
      if (r.phone.length !== 10) return false;
      if (excludeTest && (/test/i.test(r.name || '') || testPhones.has(r.phone))) { testExcluded++; return false; }
      return true;
    });
    const out = buildRepeat(counted);
    out.filters = { from, min_amount: minAmount, exclude_test: excludeTest, only_delivered: onlyDelivered, test_orders_excluded: testExcluded };
    if (wantsCsv(req)) {
      const type = req.query.type;
      if (type === 'customers') {
        return sendCsv(res, `repeat_customers_${istToday()}.csv`, ['phone', 'name', 'orders', 'first_order', 'last_order', 'days_to_second', 'total_spent'],
          out.customers.filter(c => c.orders >= 2).sort((a, b) => b.orders - a.orders));
      }
      if (type === 'months') {
        return sendCsv(res, `repeat_by_order_month_${istToday()}.csv`, ['month', 'orders', 'new_customer_orders', 'returning_orders', 'returning_pct', 'revenue', 'returning_revenue'], out.months);
      }
      return sendCsv(res, `repeat_cohorts_${istToday()}.csv`,
        ['month', 'customers', 'repeaters', 'repeat_pct', 'avg_days_to_second', 'within_15d_pct', 'within_30d_pct', 'within_60d_pct', 'within_90d_pct', 'repeat_orders', 'first_revenue', 'repeat_revenue'],
        out.cohorts.map(c => ({ ...c, within_15d_pct: c.within[15].pct, within_30d_pct: c.within[30].pct, within_60d_pct: c.within[60].pct, within_90d_pct: c.within[90].pct })));
    }
    out.customers = out.customers.filter(c => c.orders >= 2).sort((a, b) => b.orders - a.orders).slice(0, 300);
    res.json(out);
  }));

  // ================================================================ COURIER MONEY & WEIGHT
  function courierRange(q) {
    let r = dayRange(q, istToday());
    if (!r.start) {
      const t = istToday();
      const from = new Date(new Date(`${t}T12:00:00+05:30`).getTime() - 29 * 86400000).toLocaleDateString('en-CA', { timeZone: cfg.TIMEZONE });
      r = dayRange({ from, to: t }, t);
    }
    return r;
  }
  const rangeOr400 = (q) => { try { return courierRange(q); } catch (e) { throw new HttpError(400, e.message); } };

  app.get('/api/admin/courier/summary', wrap(async (req, res) => {
    const r = rangeOr400(req.query);
    const inDel = `delivered_at >= $1 AND delivered_at < $2`;
    const rows = await db(
      `SELECT COALESCE(NULLIF(courier_name,''),'Unknown') AS courier,
        COUNT(*) FILTER (WHERE shipped_at >= $1 AND shipped_at < $2)::int AS shipped,
        COUNT(*) FILTER (WHERE ${inDel})::int AS delivered,
        COUNT(*) FILTER (WHERE rto_initiated_at >= $1 AND rto_initiated_at < $2)::int AS rto,
        COUNT(*) FILTER (WHERE ${IS_COD} AND ${inDel})::int AS cod_delivered,
        COALESCE(SUM(total_price) FILTER (WHERE ${IS_COD} AND ${inDel}), 0)::float AS cod_expected,
        COALESCE(SUM(cod_remittance_amount) FILTER (WHERE ${IS_COD} AND ${inDel} AND cod_remitted), 0)::float AS cod_received,
        COUNT(*) FILTER (WHERE ${IS_COD} AND ${inDel} AND NOT COALESCE(cod_remitted,FALSE))::int AS pending_orders,
        COALESCE(SUM(total_price) FILTER (WHERE ${IS_COD} AND ${inDel} AND NOT COALESCE(cod_remitted,FALSE)), 0)::float AS pending_amount,
        COUNT(*) FILTER (WHERE ${IS_COD} AND ${inDel} AND cod_remitted AND cod_remittance_amount < total_price - 1)::int AS short_orders,
        COALESCE(SUM(total_price - cod_remittance_amount) FILTER (WHERE ${IS_COD} AND ${inDel} AND cod_remitted AND cod_remittance_amount < total_price - 1), 0)::float AS short_amount,
        COUNT(*) FILTER (WHERE ${IS_COD} AND NOT COALESCE(cod_remitted,FALSE) AND delivered_at < NOW() - INTERVAL '7 days')::int AS pending_over_7d
       FROM orders_master GROUP BY 1 ORDER BY cod_expected DESC`, [r.start, r.end]);
    const weight = await db(
      `SELECT COALESCE(NULLIF(courier_name,''),'Unknown') AS courier, COUNT(*)::int AS disputes,
              COUNT(*) FILTER (WHERE dispute_status = 'open')::int AS open,
              COALESCE(SUM(excess_charge),0)::float AS excess_total,
              COALESCE(SUM(excess_charge) FILTER (WHERE dispute_status = 'open'),0)::float AS excess_open,
              COALESCE(SUM(weight_diff_gm),0)::int AS extra_gm
       FROM weight_disputes_ledger WHERE created_at >= $1 AND created_at < $2 GROUP BY 1`, [r.start, r.end]);
    const sum = (k) => rows.reduce((a, x) => a + Number(x[k] || 0), 0);
    const totals = {};
    ['shipped', 'delivered', 'rto', 'cod_delivered', 'cod_expected', 'cod_received', 'pending_orders', 'pending_amount', 'short_orders', 'short_amount', 'pending_over_7d']
      .forEach(k => { totals[k] = Math.round(sum(k) * 100) / 100; });
    res.json({ from: r.from, to: r.to, couriers: rows, weight, totals });
  }));

  app.get('/api/admin/courier/pending-cod', wrap(async (req, res) => {
    const days = Math.max(0, Math.floor(num(req.query.older_than_days) ?? 0));
    const courier = clean(req.query.courier, 60);
    const rows = await db(
      `SELECT order_name, shopify_order_id, customer_name, awb_number, COALESCE(NULLIF(courier_name,''),'Unknown') AS courier,
              delivered_at, total_price, EXTRACT(DAY FROM NOW() - delivered_at)::int AS days_pending
       FROM orders_master
       WHERE ${IS_COD} AND delivered_at IS NOT NULL AND NOT COALESCE(cod_remitted,FALSE)
         AND delivered_at < NOW() - ($1 || ' days')::interval
         AND ($2::text IS NULL OR COALESCE(NULLIF(courier_name,''),'Unknown') = $2)
       ORDER BY delivered_at ASC LIMIT 5000`, [String(days), courier || null]);
    if (wantsCsv(req)) return sendCsv(res, `cod_not_received_${istToday()}.csv`, ['order_name', 'awb_number', 'courier', 'customer_name', 'delivered_at', 'days_pending', 'total_price'], rows);
    res.json(rows);
  }));

  app.get('/api/admin/courier/weight', wrap(async (req, res) => {
    const status = ['open', 'escalated', 'resolved_favour', 'resolved_against'].includes(req.query.status) ? req.query.status : null;
    const rows = await db(
      `SELECT w.id, w.awb_number, w.courier_name, w.weight_charged_gm, w.weight_actual_gm, w.weight_diff_gm, w.excess_charge,
              w.dispute_status, w.resolution_notes, w.created_at, o.order_name
       FROM weight_disputes_ledger w LEFT JOIN orders_master o ON o.id = w.order_id
       WHERE ($1::text IS NULL OR w.dispute_status = $1)
       ORDER BY CASE w.dispute_status WHEN 'open' THEN 0 WHEN 'escalated' THEN 1 ELSE 2 END, w.created_at DESC LIMIT 2000`, [status]);
    if (wantsCsv(req)) return sendCsv(res, `weight_disputes_${istToday()}.csv`, ['created_at', 'order_name', 'awb_number', 'courier_name', 'weight_charged_gm', 'weight_actual_gm', 'weight_diff_gm', 'excess_charge', 'dispute_status', 'resolution_notes'], rows);
    res.json(rows);
  }));

  app.post('/api/admin/courier/weight/resolve', wrap(async (req, res) => {
    const id = req.body?.id;
    if (!UUID_RE.test(String(id))) throw new HttpError(400, 'Invalid dispute');
    const status = ['escalated', 'resolved_favour', 'resolved_against'].includes(req.body?.status) ? req.body.status : null;
    if (!status) throw new HttpError(400, 'Invalid status');
    const r = await dbOne(
      `UPDATE weight_disputes_ledger SET dispute_status = $2, resolution_notes = $3,
         resolved_at = CASE WHEN $2 = 'escalated' THEN NULL ELSE NOW() END WHERE id = $1 RETURNING id, order_id`,
      [id, status, clean(req.body?.notes, 300) || null]);
    if (!r) throw new HttpError(404, 'Dispute not found');
    if (r.order_id) await db('UPDATE orders_master SET weight_dispute_status = $2, updated_at = NOW() WHERE id = $1', [r.order_id, status]);
    res.json({ success: true });
  }));

  // Upload a Shiprocket / NimbusPost report (CSV text in the request body).
  // POST /api/admin/courier/import?type=remittance|weight&unit=kg|gm&courier=Shiprocket
  app.post('/api/admin/courier/import', require('express').text({ type: '*/*', limit: '10mb' }), wrap(async (req, res) => {
    const type = req.query.type;
    if (!['remittance', 'weight'].includes(type)) throw new HttpError(400, 'type must be remittance or weight');
    const table = parseCsv(typeof req.body === 'string' ? req.body : '');
    if (table.length < 2) throw new HttpError(400, 'The file is empty or not a CSV');
    const { map, unrecognised } = mapColumns(table[0]);
    const need = type === 'remittance' ? ['awb', 'amount'] : ['awb', 'charged', 'actual'];
    const missing = need.filter(f => map[f] === undefined);
    if (missing.length) {
      throw new HttpError(400, `Could not find these columns: ${missing.join(', ')}. Columns in your file: ${table[0].map(h => h.trim()).join(' | ')}`);
    }
    const label = clean(req.query.courier, 40) || null;
    const data = table.slice(1);

    if (type === 'remittance') {
      const { rows, skipped } = remittanceRows(data, map);
      const awbs = [...new Set(rows.map(r => r.awb))];
      const orders = awbs.length ? await db(
        `SELECT id, awb_number, total_price, courier_name, payment_method, converted_to_prepaid FROM orders_master WHERE awb_number = ANY($1)`, [awbs]) : [];
      const byAwb = new Map(orders.map(o => [o.awb_number, o]));
      const unmatched = [], notCod = [], groups = new Map();
      let matched = 0, received = 0, short = 0;
      for (const r of rows) {
        const o = byAwb.get(r.awb);
        if (!o) { unmatched.push(r.awb); continue; }
        if (String(o.payment_method || '').toUpperCase() !== 'COD' || o.converted_to_prepaid) { notCod.push(r.awb); continue; }
        await db(
          `UPDATE orders_master SET cod_remitted = TRUE, cod_remittance_amount = $2, cod_remittance_date = $3, cod_remittance_utr = $4, updated_at = NOW() WHERE id = $1`,
          [o.id, r.amount, r.date, r.utr]);
        matched++; received += r.amount;
        if (r.amount < Number(o.total_price) - 1) short++;
        const key = `${r.utr || ''}|${r.date || ''}`;
        if (!groups.has(key)) groups.set(key, { utr: r.utr, date: r.date, courier: r.courier || label || o.courier_name || 'Unknown', expected: 0, received: 0, awbs: [] });
        const g = groups.get(key);
        g.expected += Number(o.total_price); g.received += r.amount; g.awbs.push(r.awb);
      }
      for (const g of groups.values()) {
        if (g.utr && await dbOne('SELECT 1 AS x FROM cod_remittances_ledger WHERE utr_number = $1 AND courier_name = $2', [g.utr, g.courier])) continue;
        const diff = Math.round((g.expected - g.received) * 100) / 100;
        await db(
          `INSERT INTO cod_remittances_ledger (courier_name, remittance_date, utr_number, expected_amount, received_amount, discrepancy, order_count, awb_list, status)
           VALUES ($1, COALESCE($2::date, CURRENT_DATE), $3, $4, $5, $6, $7, $8, $9)`,
          [g.courier, g.date, g.utr, g.expected, g.received, diff, g.awbs.length, JSON.stringify(g.awbs), Math.abs(diff) > 1 ? 'discrepancy' : 'received']);
      }
      return res.json({ type, rows_in_file: data.length, matched, short_settled: short, total_received: Math.round(received * 100) / 100,
        unmatched_awbs: unmatched.slice(0, 20), unmatched_count: unmatched.length, not_cod_count: notCod.length, skipped_rows: skipped, unrecognised_columns: unrecognised });
    }

    const unit = req.query.unit === 'gm' ? 'gm' : 'kg';
    const { rows, skipped } = weightRows(data, map, unit);
    const awbs = [...new Set(rows.map(r => r.awb))];
    const orders = awbs.length ? await db('SELECT id, awb_number, courier_name FROM orders_master WHERE awb_number = ANY($1)', [awbs]) : [];
    const byAwb = new Map(orders.map(o => [o.awb_number, o]));
    const unmatched = [];
    let created = 0, updated = 0, excess = 0;
    for (const r of rows) {
      const o = byAwb.get(r.awb);
      if (!o) { unmatched.push(r.awb); continue; }
      const courier = r.courier || label || o.courier_name || null;
      const hit = await dbOne('SELECT id FROM weight_disputes_ledger WHERE awb_number = $1', [r.awb]);
      if (hit) {
        await db('UPDATE weight_disputes_ledger SET weight_charged_gm=$2, weight_actual_gm=$3, weight_diff_gm=$4, excess_charge=$5 WHERE id=$1',
          [hit.id, r.chargedGm, r.actualGm, r.diffGm, r.excess]);
        updated++;
      } else {
        await db(
          `INSERT INTO weight_disputes_ledger (order_id, awb_number, courier_name, weight_charged_gm, weight_actual_gm, weight_diff_gm, excess_charge, dispute_status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'open')`, [o.id, r.awb, courier, r.chargedGm, r.actualGm, r.diffGm, r.excess]);
        created++;
      }
      excess += r.excess;
      await db(
        `UPDATE orders_master SET weight_dispute = TRUE, weight_billed_gm = $2, weight_actual_gm = $3,
           weight_dispute_status = COALESCE(weight_dispute_status, 'open'), updated_at = NOW() WHERE id = $1`, [o.id, r.chargedGm, r.actualGm]);
    }
    res.json({ type, rows_in_file: data.length, disputes_created: created, disputes_updated: updated, total_excess_charge: Math.round(excess * 100) / 100,
      unmatched_awbs: unmatched.slice(0, 20), unmatched_count: unmatched.length, skipped_rows: skipped, unrecognised_columns: unrecognised });
  }));

  // ================================================================ RAZORPAY PAYMENT ID TOOLS
  // One-time cleanup: clear bad auth codes saved by old backfill (anything not starting with pay_)
  app.post('/api/admin/cleanup-bad-payids', wrap(async (req, res) => {
    const result = await db(
      `UPDATE orders_master SET razorpay_payment_id = NULL
       WHERE razorpay_payment_id IS NOT NULL AND razorpay_payment_id NOT LIKE 'pay_%'
       RETURNING order_name`);
    res.json({ cleared: result.length, orders: result.slice(0, 20).map(r => r.order_name) });
  }));

  // Process in small batches (10 at a time) to avoid Railway HTTP timeout
  // 2-step: Shopify txn → Razorpay order_xxx → Razorpay pay_xxx
  app.post('/api/admin/backfill-razorpay', wrap(async (req, res) => {
    const store = process.env.SHOPIFY_STORE_DOMAIN;
    const token = process.env.SHOPIFY_ACCESS_TOKEN;
    const apiVersion = process.env.SHOPIFY_API_VERSION || '2024-10';
    const keyId = process.env.RAZORPAY_KEY_ID, keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!store || !token) throw new HttpError(503, 'Shopify credentials are not configured');
    if (!keyId || !keySecret) throw new HttpError(503, 'Razorpay keys are not configured');
    const auth = { username: keyId, password: keySecret };

    const BATCH = 10;
    const orders = await db(
      `SELECT id, shopify_order_id, order_name FROM orders_master
       WHERE payment_method = 'PREPAID' AND razorpay_payment_id IS NULL AND shopify_order_id IS NOT NULL
       ORDER BY created_at DESC LIMIT $1`, [BATCH]
    );

    const remaining = orders.length >= BATCH
      ? (await dbOne(`SELECT COUNT(*)::int AS n FROM orders_master WHERE payment_method = 'PREPAID' AND razorpay_payment_id IS NULL AND shopify_order_id IS NOT NULL`)).n
      : orders.length;

    let linked = 0, failed = 0, noTxn = 0;
    const errors = [];

    for (const o of orders) {
      try {
        // Step 1: Get Razorpay order_xxx from Shopify transaction receipt
        const url = `https://${store}/admin/api/${apiVersion}/orders/${o.shopify_order_id}/transactions.json`;
        const resp = await axios.get(url, { headers: { 'X-Shopify-Access-Token': token }, timeout: 10000 });
        const transactions = resp.data?.transactions || [];
        let rzpOrderId = null, directPayId = null;

        for (const txn of transactions) {
          if (txn.kind === 'sale' || txn.kind === 'capture' || txn.kind === 'authorization') {
            const receipt = typeof txn.receipt === 'string' ? JSON.parse(txn.receipt) : txn.receipt;
            const pid = receipt?.payment_id || receipt?.id || '';
            const candidate = typeof pid === 'string' ? pid : String(pid || '');
            if (candidate.startsWith('pay_')) { directPayId = candidate; break; }
            if (candidate.startsWith('order_')) { rzpOrderId = candidate; break; }
          }
        }

        if (directPayId) {
          await db('UPDATE orders_master SET razorpay_payment_id = $1 WHERE id = $2', [directPayId, o.id]);
          linked++;
          continue;
        }

        if (!rzpOrderId) { noTxn++; continue; }

        // Step 2: Fetch pay_xxx from Razorpay using order_xxx
        const payResp = await axios.get(`https://api.razorpay.com/v1/orders/${rzpOrderId}/payments`, { auth, timeout: 10000 });
        const payments = payResp.data?.items || [];
        const captured = payments.find(p => p.status === 'captured') || payments[0];

        if (captured?.id) {
          await db('UPDATE orders_master SET razorpay_payment_id = $1 WHERE id = $2', [captured.id, o.id]);
          linked++;
        } else {
          noTxn++;
        }
      } catch (e) {
        failed++;
        if (errors.length < 5) errors.push({ order: o.order_name, error: e.message });
      }
      await new Promise(r => setTimeout(r, 600));
    }

    res.json({ total_remaining: remaining, batch: orders.length, linked, no_payment_found: noTxn, failed, errors: errors.slice(0, 5) });
  }));
};
