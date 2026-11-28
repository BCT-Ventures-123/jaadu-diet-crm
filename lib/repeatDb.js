// Database side of repeat-customer calling (rules are in lib/repeatQueue.js). Own tables: repeat_customers (one row per customer) and repeat_calls (every call Aman logs). Nothing here touches orders or the COD confirmation numbers.
const rq = require('./repeatQueue');

async function ensureTables(db) {
  await db(`CREATE TABLE IF NOT EXISTS repeat_customers (
    id BIGSERIAL PRIMARY KEY, phone10 TEXT NOT NULL UNIQUE, name TEXT, acq_month TEXT NOT NULL, delivered_orders INT NOT NULL DEFAULT 1, last_order_date DATE,
    status TEXT NOT NULL DEFAULT 'new', attempts INT NOT NULL DEFAULT 0, unreached INT NOT NULL DEFAULT 0, last_call_at TIMESTAMPTZ, next_due_at TIMESTAMPTZ,
    closed BOOLEAN NOT NULL DEFAULT FALSE, sale_order_no TEXT, notes TEXT, wa_sent_at TIMESTAMPTZ, imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db(`CREATE INDEX IF NOT EXISTS repeat_customers_open ON repeat_customers (closed, next_due_at)`);
  await db(`CREATE TABLE IF NOT EXISTS repeat_calls (
    id BIGSERIAL PRIMARY KEY, customer_id BIGINT NOT NULL REFERENCES repeat_customers(id), phone10 TEXT NOT NULL, agent TEXT, disposition TEXT NOT NULL, notes TEXT, order_no TEXT, callback_at TIMESTAMPTZ, called_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db(`CREATE INDEX IF NOT EXISTS repeat_calls_day ON repeat_calls (called_at)`);
  await db(`ALTER TABLE repeat_calls ADD COLUMN IF NOT EXISTS was_fresh BOOLEAN NOT NULL DEFAULT FALSE`);      // true when this was the customer's first call: counts against the day's fresh-lead limit
}
// Fresh customers Aman has made a first call to on this India date.
async function freshUsedToday(db, now = new Date()) {
  const r = await db(`SELECT COUNT(*)::int AS n FROM repeat_calls WHERE was_fresh AND (called_at AT TIME ZONE 'Asia/Kolkata')::date = ($1::timestamptz AT TIME ZONE 'Asia/Kolkata')::date`, [now]);
  return r[0] ? r[0].n : 0;
}

// rows: [{ phone, name, acq_month, delivered_orders, last_order_date }]. Adds new customers; a customer already there is left exactly as it is (calls and notes are never overwritten).
async function importRows(db, rows) {
  await ensureTables(db);
  let added = 0, skippedBad = 0, existing = 0;
  const good = [];
  for (const r of rows || []) {
    const phone = rq.tenDigits(r.phone), month = rq.monthKey(r.acq_month);
    if (!phone || !month) { skippedBad++; continue; }
    good.push([phone, String(r.name || '').trim().slice(0, 120), month, Math.max(1, parseInt(r.delivered_orders, 10) || 1), /^\d{4}-\d{2}-\d{2}/.test(String(r.last_order_date || '')) ? String(r.last_order_date).slice(0, 10) : null]);
  }
  for (let i = 0; i < good.length; i += 500) {
    const part = good.slice(i, i + 500), p = [], vals = [];
    part.forEach((g, j) => { p.push(...g); vals.push(`($${j * 5 + 1}, $${j * 5 + 2}, $${j * 5 + 3}, $${j * 5 + 4}, $${j * 5 + 5})`); });
    const ins = await db(`INSERT INTO repeat_customers (phone10, name, acq_month, delivered_orders, last_order_date) VALUES ${vals.join(', ')} ON CONFLICT (phone10) DO NOTHING RETURNING id`, p);
    added += ins.length; existing += part.length - ins.length;
  }
  return { received: (rows || []).length, added, already_there: existing, skipped_bad: skippedBad };
}

const OPEN = `closed = FALSE`;
async function openLeads(db) {
  return db(`SELECT id, phone10, name, acq_month, delivered_orders, last_order_date::text AS last_order_date, status, attempts, unreached, last_call_at, next_due_at, notes FROM repeat_customers WHERE ${OPEN}`);
}
// A lead's phone is also dropped when the customer has already placed a new order (they repeated by themselves): they are no longer a repeat target.
async function queue(db, filter = 'ready', now = new Date(), s = rq.settings()) {
  await ensureTables(db);
  const q = rq.buildQueue(await openLeads(db), now, s, { freshUsedToday: await freshUsedToday(db, now) });
  const f = ['ready', 'callbacks', 'fresh', 'retry', 'notdue', 'all'].includes(filter) ? filter : 'ready';
  return { filter: f, counts: q.counts, mix: q.mix, daily: q.daily, blocked_fresh: q.blocked_fresh, rows: q.views[f].slice(0, s.readyLimit), shown: Math.min(q.views[f].length, s.readyLimit), total_in_view: q.views[f].length };
}

async function logCall(db, id, body, agent, now = new Date(), s = rq.settings()) {
  await ensureTables(db);
  const disp = String(body.disposition || ''), d = rq.BY_KEY[disp];
  if (!d) { const e = new Error('Choose a disposition'); e.status = 400; throw e; }
  const lead = (await db(`SELECT * FROM repeat_customers WHERE id = $1`, [id]))[0];
  if (!lead) { const e = new Error('Customer not found'); e.status = 404; throw e; }
  const orderNo = String(body.order_no || '').trim().slice(0, 40), notes = String(body.notes || '').trim().slice(0, 1000);
  if (d.needsOrder && !orderNo) { const e = new Error('Enter the order number for the sale'); e.status = 400; throw e; }
  let out;
  try { out = rq.afterCall(lead, disp, now, { callback_at: body.callback_at }, s); } catch (err) { err.status = 400; throw err; }
  const stamp = now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  const line = `${stamp} ${d.label}${orderNo ? ' (order ' + orderNo + ')' : ''}${notes ? ': ' + notes : ''}`;
  const newNotes = (line + (lead.notes ? '\n' + lead.notes : '')).slice(0, 4000);
  await db(`UPDATE repeat_customers SET status = $2, attempts = $3, unreached = $4, last_call_at = $5, next_due_at = $6, closed = $7, sale_order_no = COALESCE(NULLIF($8, ''), sale_order_no), notes = $9, updated_at = NOW() WHERE id = $1`,
    [id, out.status, out.attempts, out.unreached, out.last_call_at, out.next_due_at, out.closed, orderNo, newNotes]);
  await db(`INSERT INTO repeat_calls (customer_id, phone10, agent, disposition, notes, order_no, callback_at, called_at, was_fresh) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, lead.phone10, String(agent || '').slice(0, 80), disp, notes, orderNo || null, out.next_due_at, now, (lead.attempts || 0) === 0]);
  return { ok: true, status: out.status, closed: out.closed, next_due_at: out.next_due_at };
}

async function markWhatsApp(db, id, now = new Date()) {
  await ensureTables(db);
  const r = await db(`UPDATE repeat_customers SET wa_sent_at = $2, updated_at = NOW() WHERE id = $1 RETURNING phone10, name`, [id, now]);
  return r[0] || null;
}

// Numbers for the report page: per day (India date), then totals and where the pool stands.
async function report(db, fromDay, toDay, now = new Date(), s = rq.settings()) {
  await ensureTables(db);
  const days = await db(`SELECT (c.called_at AT TIME ZONE 'Asia/Kolkata')::date::text AS day, COUNT(*)::int AS calls, COUNT(DISTINCT c.customer_id)::int AS customers,
                                COUNT(*) FILTER (WHERE c.disposition IN ('interested','p2p','wfc','call_back','not_interested','sale_done'))::int AS connected,
                                COUNT(*) FILTER (WHERE c.disposition = 'interested')::int AS interested, COUNT(*) FILTER (WHERE c.disposition = 'p2p')::int AS p2p, COUNT(*) FILTER (WHERE c.disposition = 'wfc')::int AS wfc,
                                COUNT(*) FILTER (WHERE c.disposition = 'call_back')::int AS call_back, COUNT(*) FILTER (WHERE c.disposition = 'not_interested')::int AS not_interested,
                                COUNT(*) FILTER (WHERE c.disposition = 'dnp')::int AS dnp, COUNT(*) FILTER (WHERE c.disposition = 'sw_off')::int AS sw_off, COUNT(*) FILTER (WHERE c.disposition = 'not_reachable')::int AS not_reachable,
                                COUNT(*) FILTER (WHERE c.disposition = 'sale_done')::int AS sales_claimed
                         FROM repeat_calls c WHERE (c.called_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1::date AND $2::date GROUP BY 1 ORDER BY 1`, [fromDay, toDay]);
  // A claimed sale is verified when the customer's phone has a real order in the CRM placed after the sale call. Orders are read only.
  let verified = {};
  try {
    const v = await db(`SELECT (c.called_at AT TIME ZONE 'Asia/Kolkata')::date::text AS day, COUNT(DISTINCT c.id)::int AS n
                        FROM repeat_calls c WHERE c.disposition = 'sale_done' AND (c.called_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1::date AND $2::date
                          AND EXISTS (SELECT 1 FROM orders_master o WHERE RIGHT(regexp_replace(COALESCE(o.customer_phone, ''), '\\D', '', 'g'), 10) = c.phone10 AND COALESCE(o.shopify_created_at, o.created_at) >= c.called_at - INTERVAL '10 minutes')
                        GROUP BY 1`, [fromDay, toDay]);
    verified = Object.fromEntries(v.map(x => [x.day, x.n]));
  } catch (e) { console.error('[Repeat] sale check skipped:', e.message); verified = null; }
  const rows = days.map(d => ({ ...d, connectivity_pct: d.calls ? Math.round(d.connected * 1000 / d.calls) / 10 : null, sales_verified: verified ? (verified[d.day] || 0) : null }));
  const tot = rows.reduce((a, r) => { for (const k of Object.keys(r)) if (typeof r[k] === 'number' && k !== 'connectivity_pct') a[k] = (a[k] || 0) + r[k]; return a; }, {});
  if (tot.calls !== undefined) tot.connectivity_pct = tot.calls ? Math.round(tot.connected * 1000 / tot.calls) / 10 : null;
  const pool = await db(`SELECT acq_month, COUNT(*)::int AS customers, COUNT(*) FILTER (WHERE attempts = 0 AND closed = FALSE)::int AS never_called, COUNT(*) FILTER (WHERE closed)::int AS closed,
                                COUNT(*) FILTER (WHERE closed AND status = 'sale_done')::int AS sales FROM repeat_customers GROUP BY 1 ORDER BY 1`);
  const q = rq.buildQueue(await openLeads(db), now, s, { freshUsedToday: await freshUsedToday(db, now) });
  const overdue = await db(`SELECT COUNT(*)::int AS n FROM repeat_customers WHERE closed = FALSE AND status IN ('interested','p2p','wfc','call_back') AND next_due_at < $1::timestamptz - INTERVAL '24 hours'`, [now]);
  return { from: fromDay, to: toDay, days: rows, totals: tot, pool, queue: q.counts, mix: q.mix, daily: q.daily, followups_overdue_24h: overdue[0] ? overdue[0].n : 0, sale_check: verified === null ? 'unavailable' : 'orders_in_crm' };
}

module.exports = { ensureTables, importRows, queue, logCall, markWhatsApp, report, openLeads };
