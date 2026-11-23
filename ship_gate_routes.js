// Ship gate, phase 1: READ-ONLY lists and alerts for the person who ships. It changes no order. The only thing it writes is the
// admin's holiday list. Mounted from server.js under /api/admin/ship-gate/* (admin-only through the cc_routes login check).
const gate = require('./lib/shipGate');
const { loadSnapshot, loadHolidays } = require('./lib/shipGateDb');
const { checkFeedKey, feedRow } = require('./lib/feedAuth');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const csvCell = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

module.exports = function mountShipGate(app, { db, dbOne }) {
  const fail = (res, err) => { console.error('[ShipGate]', err.message); res.status(err.status || 500).json({ error: err.message }); };
  const snapshot = () => loadSnapshot(db, dbOne);

  const slim = (o) => ({
    order_name: o.order_name, customer_name: o.customer_name, customer_phone: o.customer_phone, address: gate.addressText(o), city: o.shipping_city, state: o.shipping_province, zip: o.shipping_zip,
    product: gate.itemsText(o.line_items), total_price: Number(o.total_price) || 0, collect: gate.collectAmount(o), payment: o.prepaid ? 'Prepaid' : 'COD', team: o.assigned_to,
    ready_at: o.ready_at, due: o.due, ship_status: o.ship_status || null, reasons: o.reasons || [], reason_text: o.reason_text || [], awb: o.awb_number || null, courier: o.courier_name || null,
  });

  app.get('/api/admin/ship-gate', async (req, res) => {
    try {
      const s = await snapshot();
      res.json({
        phase: 'shadow (read-only: nothing is blocked or changed)',
        since: s.since, today: s.today, shipping_day: s.shippingDay, next_shipping_day: s.nextShippingDay,
        holidays_available: s.hol.available, health: s.health,
        track_from: s.trackFrom,
        counts: { ready: s.r.ready.length, chase: s.r.chase.length, overdue: s.r.ready.filter(x => x.ship_status === 'overdue').length, blocked: s.r.blocked.length, wrong: s.r.wrong.length, untracked: s.r.untracked.length },
        ready: s.r.ready.map(slim), chase: s.r.chase.map(slim), blocked: s.r.blocked.map(slim), wrong: s.r.wrong.map(slim), accuracy: s.acc,
        note: 'AWB time is taken from the first courier update, so accuracy only covers orders after the courier webhook fix (2026-11-11).',
      });
    } catch (err) { fail(res, err); }
  });

  // Read-only feed for the logistics dashboard. Not behind the login: it needs the key in the x-feed-key header (env SHIP_FEED_KEY).
  app.get('/api/feed/ship', async (req, res) => {
    const k = checkFeedKey(req.get('x-feed-key'), process.env.SHIP_FEED_KEY);
    if (!k.ok) return res.status(k.status).json({ error: k.error });
    try {
      const s = await snapshot();
      res.json({
        generated_at: new Date().toISOString(), shipping_day: s.shippingDay, next_shipping_day: s.nextShippingDay,
        counts: { ready: s.r.ready.length, due_or_overdue: s.r.chase.length, held: s.r.blocked.length },
        ready: s.r.ready.map(slim).map(feedRow),
        held: s.r.blocked.map(slim).map(o => ({ ...feedRow(o), disposition: 'Held', reasons: o.reason_text })),
      });
    } catch (err) { fail(res, err); }
  });

  app.get('/api/admin/ship-gate/export', async (req, res) => {
    try {
      const list = ['ready', 'chase', 'blocked', 'wrong'].includes(req.query.list) ? req.query.list : 'ready';
      const rows = (await snapshot()).r[list].map(slim);
      const cols = [['order_name', 'Order'], ['ship_status', 'Status'], ['due', 'Ship by'], ['payment', 'Payment'], ['collect', 'Collect on delivery'], ['total_price', 'Order total'],
        ['customer_name', 'Customer'], ['customer_phone', 'Phone'], ['address', 'Address'], ['city', 'City'], ['state', 'State'], ['zip', 'Pincode'], ['product', 'Product and quantity'],
        ['reason_text', 'Reason'], ['awb', 'AWB']];
      const body = [cols.map(c => csvCell(c[1])).join(',')].concat(rows.map(r => cols.map(c => csvCell(Array.isArray(r[c[0]]) ? r[c[0]].join('; ') : r[c[0]])).join(','))).join('\r\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="ship-${list}_${gate.todayKey()}.csv"`);
      res.send('\uFEFF' + body);
    } catch (err) { fail(res, err); }
  });

  // ------------------------------------------------------------ holidays (the only thing this feature writes)
  app.get('/api/admin/ship-gate/holidays', async (req, res) => {
    try { const h = await loadHolidays(db); res.json({ available: h.available, rows: h.rows }); } catch (err) { fail(res, err); }
  });

  app.post('/api/admin/ship-gate/holidays', async (req, res) => {
    try {
      const date = String((req.body || {}).date || '');
      if (!DATE_RE.test(date) || isNaN(new Date(date + 'T00:00:00Z'))) return res.status(400).json({ error: 'Choose a valid date' });
      const note = String((req.body || {}).note || '').trim().slice(0, 200) || null;
      const h = await loadHolidays(db);
      if (!h.available) return res.status(409).json({ error: 'The holiday table is not created yet. Run "node migrate.js --apply" in the Railway Console first.' });
      await db(`INSERT INTO shipping_holidays (holiday_date, note, created_by) VALUES ($1, $2, $3) ON CONFLICT (holiday_date) DO NOTHING`,
        [date, note, (req.agent && req.agent.display_name) || 'admin']);
      res.json({ ok: true });
    } catch (err) { fail(res, err); }
  });

  app.post('/api/admin/ship-gate/holidays/remove', async (req, res) => {
    try {
      const date = String((req.body || {}).date || '');
      if (!DATE_RE.test(date)) return res.status(400).json({ error: 'Choose a valid date' });
      await db(`DELETE FROM shipping_holidays WHERE holiday_date = $1`, [date]);
      res.json({ ok: true });
    } catch (err) { fail(res, err); }
  });
};
