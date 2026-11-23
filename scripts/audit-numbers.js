// READ-ONLY audit. Prints every dashboard number with its definition, so each one can be checked by hand.
//   node scripts/audit-numbers.js                       last 7 days
//   node scripts/audit-numbers.js 2026-10-25 2026-11-01 from / to (order date, IST, inclusive)
// Writes nothing. Prints order numbers only (no phone numbers or names).
require('dotenv').config();
const { Pool } = require('pg');
const cfg = require('../lib/config');
const productsLib = require('../lib/products');
const { isShortAddress, fullAddressOf } = require('../lib/address');
const funnelLib = require('../lib/funnel');

const iso = (d) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const to = process.argv[3] || iso(new Date());
const from = process.argv[2] || iso(new Date(Date.now() - 6 * 864e5));
const TEST = `(LOWER(TRIM(COALESCE(o.customer_name,''))) IN ('test test','test','test order','dummy') OR COALESCE(o.customer_name,'') ~* '^\\s*test\\M')`;
const ITEMS = `(CASE WHEN jsonb_typeof(o.line_items) = 'array' THEN o.line_items ELSE '[]'::jsonb END)`;
const TS = `COALESCE(o.shopify_created_at, o.created_at)`;
const pc = (a, b) => (b ? (Math.round(a * 1000 / b) / 10) + '%' : '-');

(async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
  const q = async (sql, p) => (await pool.query(sql, p)).rows;
  const window = `${TS} >= ($1::date)::timestamp AT TIME ZONE 'Asia/Kolkata' AND ${TS} < (($2::date) + 1)::timestamp AT TIME ZONE 'Asia/Kolkata'`;
  console.log(`\n=== AUDIT  ${from} to ${to} (order date, IST) ===`);

  // 1. What is in the orders table for the window, and what we leave out.
  const all = await q(`SELECT COUNT(*)::int n,
      COUNT(*) FILTER (WHERE UPPER(COALESCE(o.payment_method,''))='COD')::int cod,
      COUNT(*) FILTER (WHERE UPPER(COALESCE(o.payment_method,''))<>'COD')::int prepaid,
      COUNT(*) FILTER (WHERE COALESCE(o.converted_to_prepaid,FALSE))::int converted,
      COUNT(*) FILTER (WHERE ${TEST})::int test,
      COUNT(*) FILTER (WHERE o.total_price < $3)::int under_min
    FROM orders_master o WHERE ${window}`, [from, to, productsLib.MIN_PRICE]);
  console.log('\n1) ALL orders in window:', JSON.stringify(all[0]));

  // 2. The funnel cohort (same filters as the dashboard) with calls.
  const rows = await q(`SELECT o.id, o.order_name, o.assigned_to team, o.confirmation_status status, COALESCE(o.order_status,'') order_status,
        COALESCE(o.dnc,FALSE) dnc, o.callback_at, COALESCE(o.is_duplicate,FALSE) dup, COALESCE(o.is_repeat_customer,FALSE) repeat,
        (o.shipped_at IS NOT NULL OR COALESCE(o.order_status,'') IN ('shipped','delivered','rto')) shipped,
        COALESCE(o.address_is_short,FALSE) short, COALESCE(o.address_fixed,FALSE) fixed, COALESCE(o.address_locked,FALSE) locked,
        o.shipping_address1, o.shipping_address2, o.shipping_city, o.shipping_province,
        COALESCE(c.d,'{}') calls
      FROM orders_master o
      LEFT JOIN LATERAL (SELECT array_agg(g.disposition ORDER BY g.created_at) d FROM lead_call_log g WHERE g.order_id=o.id AND g.disposition = ANY($3)) c ON TRUE
      WHERE ${window} AND UPPER(COALESCE(o.payment_method,''))='COD' AND COALESCE(o.converted_to_prepaid,FALSE)=FALSE AND NOT ${TEST}
        AND o.total_price >= $4
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(${ITEMS}) li, unnest($5::text[]) p WHERE starts_with(COALESCE(li->>'title',''), p))`,
    [from, to, cfg.CALL_DISPOSITIONS, productsLib.MIN_PRICE, productsLib.ALLOWED_PREFIXES]);
  const CONN = new Set(cfg.CONNECTED_DISPOSITIONS);
  const total = rows.length;
  const called = rows.filter(r => r.calls.length > 0);
  const conn = rows.filter(r => r.calls.some(d => CONN.has(d)));
  const callRows = rows.reduce((s, r) => s + r.calls.length, 0);
  const connCalls = rows.reduce((s, r) => s + r.calls.filter(d => CONN.has(d)).length, 0);
  const confNoCall = rows.filter(r => r.status === 'confirmed' && !r.calls.some(d => CONN.has(d)));
  const first = called.filter(r => CONN.has(r.calls[0]));
  console.log(`\n2) COD tea orders >= Rs ${productsLib.MIN_PRICE}, no test (the dashboard cohort): ${total}`);
  console.log(`   orders with at least 1 call ........ ${called.length}  (${pc(called.length, total)} of orders)`);
  console.log(`   total call rows .................... ${callRows}`);
  console.log(`   orders connected (any call picked) . ${conn.length}  (${pc(conn.length, total)} of orders, ${pc(conn.length, called.length)} of CALLED orders)`);
  console.log(`   calls picked / calls made .......... ${connCalls}/${callRows} = ${pc(connCalls, callRows)}`);
  console.log(`   1st call picked / orders called .... ${first.length}/${called.length} = ${pc(first.length, called.length)}`);
  console.log(`   confirmed WITHOUT a spoken call .... ${confNoCall.length}  (WhatsApp / IVR / sheet)`);
  console.log(`   (connected + confirmed w/o call) ... ${conn.length + confNoCall.length}  = ${pc(conn.length + confNoCall.length, total)} of orders`);
  const byDisp = {}; rows.forEach(r => r.calls.forEach(d => { byDisp[d] = (byDisp[d] || 0) + 1; }));
  console.log('   call rows by result ................', JSON.stringify(byDisp));
  const byTeam = {}; rows.forEach(r => { byTeam[r.team] = (byTeam[r.team] || 0) + 1; });
  console.log('   orders by team .....................', JSON.stringify(byTeam));
  const byStatus = {}; rows.forEach(r => { byStatus[r.status] = (byStatus[r.status] || 0) + 1; });
  console.log('   orders by status ...................', JSON.stringify(byStatus));

  // 3. FRESH: what the "Fresh" card should count, one reason at a time.
  const open = rows.filter(r => r.status === 'pending');
  const fresh = open.filter(r => r.calls.length === 0);
  console.log(`\n3) FRESH (pending, never called) in this window: ${fresh.length}`);
  const why = (name, f) => console.log(`     of which ${name}: ${fresh.filter(f).length}`);
  why('team CC', r => r.team === 'CC'); why('team InHouse (Aman)', r => r.team === 'InHouse');
  why('order_status not "new"', r => r.order_status && r.order_status !== 'new');
  why('duplicate', r => r.dup); why('repeat customer', r => r.repeat); why('do-not-call', r => r.dnc);
  why('callback set', r => !!r.callback_at); why('already shipped', r => r.shipped);
  const view = await q(`SELECT COUNT(*)::int n FROM v_cc_fresh_leads WHERE ${TS.replace(/o\./g, '')} >= ($1::date)::timestamp AT TIME ZONE 'Asia/Kolkata' AND ${TS.replace(/o\./g, '')} < (($2::date)+1)::timestamp AT TIME ZONE 'Asia/Kolkata'`, [from, to]);
  console.log(`   call-centre Fresh list (v_cc_fresh_leads) for the same dates: ${view[0].n}   <- the number agents see`);
  const freshOld = await q(`SELECT COUNT(*)::int n FROM v_cc_fresh_leads`);
  console.log(`   call-centre Fresh list, all dates: ${freshOld[0].n}`);

  // 4. SHORT ADDRESS
  const opt = { minChars: Number(process.env.SHORT_ADDRESS_MIN_CHARS) || 15, minWords: Number(process.env.SHORT_ADDRESS_MIN_WORDS) || 3, requirePremise: process.env.SHORT_ADDRESS_REQUIRE_PREMISE === '1' };
  const flagged = await q(`SELECT o.order_name, o.confirmation_status status, COALESCE(o.order_status,'') os, COALESCE(o.address_fixed,FALSE) fixed, COALESCE(o.address_locked,FALSE) locked,
        (o.shipped_at IS NOT NULL OR o.awb_number IS NOT NULL) shipped, COALESCE(o.dnc,FALSE) dnc, o.shipping_address1, o.shipping_address2, o.shipping_city, o.shipping_province
      FROM orders_master o WHERE o.address_is_short = TRUE`);
  const openShort = flagged.filter(o => ['pending', 'confirmed'].includes(o.status) && !['shipped', 'delivered', 'rto', 'cancelled'].includes(o.os) && !o.fixed && !o.locked && !o.shipped && !o.dnc);
  const stale = openShort.filter(o => !isShortAddress(fullAddressOf(o), opt));
  console.log(`\n4) SHORT ADDRESS (all dates): flag set on ${flagged.length} orders`);
  console.log(`   of those, still OPEN (pending/confirmed, not shipped, not fixed, not locked): ${openShort.length}`);
  console.log(`   of the open ones, address is actually fine under the rule (${opt.minChars} chars, ${opt.minWords} words): ${stale.length}  <- wrongly showing`);
  console.log(`   really short: ${openShort.length - stale.length}`);
  console.log('   flag set but NOT open (hidden from the card now): fixed ' + flagged.filter(o => o.fixed).length + ', shipped ' + flagged.filter(o => o.shipped).length + ', cancelled ' + flagged.filter(o => o.status === 'cancelled').length);
  console.log('   examples that look fine but are flagged (order, length, words):');
  stale.slice(0, 8).forEach(o => { const a = fullAddressOf(o); console.log(`     ${o.order_name}  ${a.length} chars, ${a.split(/\s+/).length} words`); });

  // 5. ADDRESS FIX card and the other open lists, counted from the raw tables.
  const lists = await q(`SELECT
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM lead_call_log g WHERE g.order_id=o.id AND g.disposition='address_fix') AND COALESCE(o.address_fixed,FALSE)=FALSE AND o.confirmation_status='pending')::int address_fix_open,
      COUNT(*) FILTER (WHERE o.callback_at IS NOT NULL AND o.confirmation_status='pending')::int callbacks_open,
      COUNT(*) FILTER (WHERE o.callback_at IS NOT NULL AND o.callback_at <= NOW() AND o.confirmation_status='pending')::int callbacks_due
    FROM orders_master o WHERE UPPER(COALESCE(o.payment_method,''))='COD'`);
  console.log('\n5) Open lists (all dates, COD):', JSON.stringify(lists[0]));

  // 6. Dashboard engine output for the same window, to compare line by line with the above.
  const f = funnelLib.buildFunnel(rows.map(r => ({ team: r.team, status: r.status, order_status: r.order_status, dnc: r.dnc, callback_at: r.callback_at, short: r.short, fixed: r.fixed, locked: r.locked, is_duplicate: r.dup, shipped: r.shipped, day: from, order_at: new Date(), decided_at: null, calls: r.calls, call_times: r.calls.map(() => new Date()) })));
  console.log('\n6) Dashboard funnel for the same cohort:', JSON.stringify({ total_orders: f.total_orders, attempted: f.attempted, connected: f.connected, confirmed: f.confirmed, cancelled: f.cancelled, not_connected: f.not_connected, nc_2nd: f.nc_2nd, nc_3rd: f.nc_3rd, total_attempts: f.total_attempts, confirmed_without_call: f.confirmed_without_call }));
  console.log('\nDone. Nothing was changed.\n');
  await pool.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
