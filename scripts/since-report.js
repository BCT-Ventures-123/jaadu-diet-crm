// READ-ONLY. One-screen status of the official calling period (default: from CALLING_STARTED_ON, 26 Oct).
//   node scripts/since-report.js                 from CALLING_STARTED_ON to today
//   node scripts/since-report.js 2026-10-26      from a date to today
// Same cohort as the dashboard: COD tea orders >= MIN_PRICE, no test orders, not converted to prepaid.
// Prints counts only (no phone numbers or names). Writes nothing.
require('dotenv').config();
const { Pool } = require('pg');
const cfg = require('../lib/config');
const productsLib = require('../lib/products');

const iso = (d) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const from = process.argv[2] || cfg.CALLING_STARTED_ON;
const to = process.argv[3] || iso(new Date());
const TEST = `(LOWER(TRIM(COALESCE(o.customer_name,''))) IN ('test test','test','test order','dummy') OR COALESCE(o.customer_name,'') ~* '^\\s*test\\M')`;
const ITEMS = `(CASE WHEN jsonb_typeof(o.line_items) = 'array' THEN o.line_items ELSE '[]'::jsonb END)`;
const TS = `COALESCE(o.shopify_created_at, o.created_at)`;
const pc = (a, b) => (b ? (Math.round(a * 1000 / b) / 10) + '%' : '-');

(async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
  const window = `${TS} >= ($1::date)::timestamp AT TIME ZONE 'Asia/Kolkata' AND ${TS} < (($2::date) + 1)::timestamp AT TIME ZONE 'Asia/Kolkata'`;
  const { rows } = await pool.query(`SELECT o.assigned_to team, o.confirmation_status status, COALESCE(o.order_status,'') order_status,
        COALESCE(o.dnc,FALSE) dnc, o.callback_at, COALESCE(o.is_duplicate,FALSE) dup, COALESCE(o.is_repeat_customer,FALSE) repeat,
        (o.shipped_at IS NOT NULL OR o.awb_number IS NOT NULL OR COALESCE(o.order_status,'') IN ('shipped','delivered','rto')) shipped,
        (SELECT COUNT(*) FROM lead_call_log g WHERE g.order_id = o.id AND g.disposition = ANY($3))::int calls
      FROM orders_master o
      WHERE ${window} AND UPPER(COALESCE(o.payment_method,''))='COD' AND COALESCE(o.converted_to_prepaid,FALSE)=FALSE AND NOT ${TEST}
        AND o.total_price >= $4
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(${ITEMS}) li, unnest($5::text[]) p WHERE starts_with(COALESCE(li->>'title',''), p))`,
    [from, to, cfg.CALL_DISPOSITIONS, productsLib.MIN_PRICE, productsLib.ALLOWED_PREFIXES]);
  await pool.end();

  const now = Date.now();
  const N = rows.length;
  const by = (f) => rows.filter(f).length;
  const team = (t) => (r) => r.team === t;
  const live = (r) => r.status !== 'cancelled' && !r.dnc;
  const freshRow = (r) => r.status === 'pending' && r.calls === 0 && !r.dup && !r.repeat && !r.dnc && (!r.order_status || r.order_status === 'new') && !r.shipped && !r.callback_at;
  const cbRow = (r) => r.status === 'pending' && r.callback_at && !r.shipped;
  const line = (label, n, of) => console.log('  ' + label.padEnd(44, '.') + ' ' + String(n).padStart(5) + (of ? '   ' + pc(n, of) : ''));

  console.log(`\n=== STATUS ${from} to ${to} (order date, IST). Cohort = COD tea orders >= Rs ${productsLib.MIN_PRICE}, no test ===`);
  line('Orders in cohort', N);
  line('  Call centre (CC)', by(team('CC')));
  line('  Aman (InHouse)', by(team('InHouse')));
  console.log('\nWhere they stand');
  line('Confirmed', by(r => r.status === 'confirmed'), N);
  line('Cancelled', by(r => r.status === 'cancelled'), N);
  line('Still pending (not confirmed, not cancelled)', by(r => r.status === 'pending'), N);
  console.log('\nFresh and callbacks (still to work)');
  line('Fresh: pending, never called', by(freshRow));
  line('  of which Call centre', by(r => freshRow(r) && r.team === 'CC'));
  line('  of which Aman', by(r => freshRow(r) && r.team === 'InHouse'));
  line('Callbacks set (pending)', by(cbRow));
  line('  of which due now or overdue', by(r => cbRow(r) && new Date(r.callback_at).getTime() <= now));
  line('  of which later', by(r => cbRow(r) && new Date(r.callback_at).getTime() > now));
  line('Pending and called, no answer yet', by(r => r.status === 'pending' && r.calls > 0 && !r.callback_at && !r.shipped));
  console.log('\nShipping and delivery are not counted here: that data is added later.\n');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
