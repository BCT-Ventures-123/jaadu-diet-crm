// Callyzer call-tracking integration.
// Mounted from server.js under /api/admin/callyzer/* (admin-only via cc_routes auth).
const axios = require('axios');
const cfg = require('./lib/config');

const normPhone = (p) => String(p || '').replace(/\D/g, '').slice(-10);

function fail(res, err) {
  const apiMsg = err.response?.data?.message;
  const msg = apiMsg || err.message || 'Server error';
  console.error('[Callyzer]', msg);
  return res.status(err.response?.status || err.status || 500).json({ error: msg });
}

module.exports = function mountCallyzerRoutes(app, { db, dbOne }) {
  const apiKey = () => process.env.CALLYZER_API_KEY || '';
  const baseUrl = () => (process.env.CALLYZER_BASE_URL || 'https://sandbox.api.callyzer.co/api/v2.1').replace(/\/$/, '');

  function callyzerHeaders() {
    return { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' };
  }

  // ---- sync endpoint (admin triggers manually) ----
  app.post('/api/admin/callyzer/sync', async (req, res) => {
    if (!apiKey()) return res.status(400).json({ error: 'CALLYZER_API_KEY not configured' });
    try {
      const days = Math.min(Number(req.body.days) || 1, 30);
      const toStr = new Date().toISOString().split('T')[0];
      const fromDate = new Date(toStr + 'T00:00:00Z');
      fromDate.setUTCDate(fromDate.getUTCDate() - (days - 1));
      const fromStr = fromDate.toISOString().split('T')[0];
      const callFrom = Math.floor(fromDate.getTime() / 1000);
      const callTo = Math.floor(new Date(toStr + 'T23:59:59Z').getTime() / 1000);

      let allCalls = [];
      let page = 1;
      const perPage = 99;
      let hasMore = true;

      while (hasMore) {
        const payload = {
          call_from: callFrom,
          call_to: callTo,
          call_method: 'PhoneCall',
          call_mode: 'Voice',
          page_no: page,
          page_size: perPage
        };

        const resp = await axios.post(`${baseUrl()}/call-log/history`, payload, {
          headers: callyzerHeaders(),
          timeout: 15000
        });

        const calls = resp.data?.result || [];
        if (!Array.isArray(calls) || calls.length === 0) {
          hasMore = false;
        } else {
          allCalls = allCalls.concat(calls);
          const totalRecords = resp.data?.total_records || 0;
          hasMore = (page * perPage) < totalRecords;
          page++;
          // Rate limit: 1 req / 2 sec
          if (hasMore) await new Promise(r => setTimeout(r, 2100));
        }
      }

      // Upsert calls
      let newCount = 0;
      let matchCount = 0;
      const newIds = [];

      for (const c of allCalls) {
        const callId = String(c.id || `${c.emp_number}_${c.client_number}_${c.call_date}_${c.call_time}`);
        const rawClient = String(c.client_number || '');
        const clientNorm = normPhone(rawClient);
        if (!clientNorm || clientNorm.length < 10) continue;

        const result = await db(`
          INSERT INTO callyzer_calls (callyzer_call_id, emp_name, emp_number, client_number, client_number_norm,
            call_type, call_method, call_mode, call_duration, call_date, call_time, call_recording_url, raw_data)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
          ON CONFLICT (callyzer_call_id) DO NOTHING
          RETURNING id
        `, [
          callId,
          c.emp_name || null,
          c.emp_number || null,
          rawClient,
          clientNorm,
          (c.call_type || '').toLowerCase() || null,
          c.call_method || 'PhoneCall',
          c.call_mode || 'Voice',
          Number(c.duration || 0),
          c.call_date || null,
          c.call_time || null,
          (c.call_recording_url && c.call_recording_url.trim()) ? c.call_recording_url.trim() : null,
          JSON.stringify(c)
        ]);

        if (result.length > 0) {
          newCount++;
          newIds.push(result[0].id);
        }
      }

      // Match new calls to orders by phone (most recent pending order wins)
      if (newIds.length > 0) {
        const matched = await db(`
          UPDATE callyzer_calls c
          SET order_id = sub.oid
          FROM (
            SELECT DISTINCT ON (c2.id) c2.id AS cid, o.id AS oid
            FROM callyzer_calls c2
            JOIN orders_master o ON RIGHT(REGEXP_REPLACE(COALESCE(o.customer_phone,''), '[^0-9]', '', 'g'), 10) = c2.client_number_norm
            WHERE c2.id = ANY($1) AND c2.order_id IS NULL
            ORDER BY c2.id, o.created_at DESC
          ) sub
          WHERE c.id = sub.cid
        `, [newIds]);
        matchCount = matched.length;
      }

      // Log sync
      await db(`INSERT INTO callyzer_sync_log (from_date, to_date, calls_fetched, calls_new, calls_matched)
                VALUES ($1,$2,$3,$4,$5)`, [fromStr, toStr, allCalls.length, newCount, matchCount]);

      res.json({
        success: true,
        fetched: allCalls.length,
        new_calls: newCount,
        matched_to_orders: matchCount,
        date_range: `${fromStr} to ${toStr}`
      });
    } catch (err) { fail(res, err); }
  });

  // ---- list calls with filters ----
  app.get('/api/admin/callyzer/calls', async (req, res) => {
    try {
      const where = [];
      const params = [];
      if (req.query.phone) {
        params.push(normPhone(req.query.phone));
        where.push(`client_number_norm = $${params.length}`);
      }
      if (req.query.agent) {
        params.push(req.query.agent);
        where.push(`emp_name = $${params.length}`);
      }
      if (req.query.type) {
        params.push(req.query.type);
        where.push(`call_type = $${params.length}`);
      }
      if (req.query.from) {
        params.push(req.query.from);
        where.push(`call_date >= $${params.length}::date`);
      }
      if (req.query.to) {
        params.push(req.query.to);
        where.push(`call_date <= $${params.length}::date`);
      }

      const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const rows = await db(`
        SELECT c.*, o.order_name, o.customer_name
        FROM callyzer_calls c
        LEFT JOIN orders_master o ON o.id = c.order_id
        ${w}
        ORDER BY c.call_date DESC, c.call_time DESC
        LIMIT 500
      `, params);
      res.json(rows);
    } catch (err) { fail(res, err); }
  });

  // ---- calls for a specific order ----
  app.get('/api/admin/callyzer/calls/order/:id', async (req, res) => {
    try {
      const order = await dbOne('SELECT id, customer_phone FROM orders_master WHERE id = $1', [req.params.id]);
      if (!order) return res.status(404).json({ error: 'Order not found' });
      const phone = normPhone(order.customer_phone);
      const rows = await db(`
        SELECT * FROM callyzer_calls
        WHERE client_number_norm = $1
        ORDER BY call_date DESC, call_time DESC
        LIMIT 100
      `, [phone]);
      res.json(rows);
    } catch (err) { fail(res, err); }
  });

  // ---- stats summary ----
  app.get('/api/admin/callyzer/stats', async (req, res) => {
    try {
      const from = req.query.from || new Date().toISOString().split('T')[0];
      const to = req.query.to || from;

      const summary = await dbOne(`
        SELECT
          COUNT(*)::int AS total_calls,
          COUNT(*) FILTER (WHERE call_type = 'incoming')::int AS incoming,
          COUNT(*) FILTER (WHERE call_type = 'outgoing')::int AS outgoing,
          COUNT(*) FILTER (WHERE call_type = 'missed')::int AS missed,
          ROUND(AVG(call_duration))::int AS avg_duration_sec,
          ROUND(AVG(call_duration) FILTER (WHERE call_duration > 0))::int AS avg_connected_duration,
          COUNT(DISTINCT emp_name)::int AS active_agents,
          COUNT(DISTINCT client_number_norm)::int AS unique_customers
        FROM callyzer_calls
        WHERE call_date >= $1::date AND call_date <= $2::date
      `, [from, to]);

      const byAgent = await db(`
        SELECT emp_name,
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE call_type = 'outgoing')::int AS outgoing,
          COUNT(*) FILTER (WHERE call_type = 'incoming')::int AS incoming,
          COUNT(*) FILTER (WHERE call_type = 'missed')::int AS missed,
          ROUND(AVG(call_duration))::int AS avg_dur,
          SUM(call_duration)::int AS total_dur
        FROM callyzer_calls
        WHERE call_date >= $1::date AND call_date <= $2::date AND emp_name IS NOT NULL
        GROUP BY emp_name ORDER BY total DESC
      `, [from, to]);

      res.json({ summary, by_agent: byAgent });
    } catch (err) { fail(res, err); }
  });

  // ---- sync status ----
  app.get('/api/admin/callyzer/sync-status', async (req, res) => {
    try {
      const last = await dbOne('SELECT * FROM callyzer_sync_log ORDER BY synced_at DESC LIMIT 1');
      const total = await dbOne('SELECT COUNT(*)::int AS n FROM callyzer_calls');
      res.json({ last_sync: last, total_calls: total?.n || 0 });
    } catch (err) { fail(res, err); }
  });

  // ---- test API connectivity ----
  app.get('/api/admin/callyzer/test', async (req, res) => {
    if (!apiKey()) return res.status(400).json({ error: 'CALLYZER_API_KEY not configured' });
    try {
      const todayStr = new Date().toISOString().split('T')[0];
      const resp = await axios.post(`${baseUrl()}/call-log/history`, {
        call_from: Math.floor(new Date(todayStr + 'T00:00:00Z').getTime() / 1000),
        call_to: Math.floor(new Date(todayStr + 'T23:59:59Z').getTime() / 1000),
        call_method: 'PhoneCall',
        call_mode: 'Voice',
        page_no: 1,
        page_size: 1
      }, { headers: callyzerHeaders(), timeout: 10000 });
      res.json({ success: true, status: resp.status, sample: resp.data });
    } catch (err) {
      res.json({ success: false, status: err.response?.status, error: err.response?.data || err.message });
    }
  });
};
