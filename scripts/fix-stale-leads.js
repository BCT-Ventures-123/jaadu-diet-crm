// Fixes stale orders stuck in fresh leads that are actually shipped/delivered.
//
// 1. Re-creates views with shipped_at/awb_number filters
// 2. Marks orders with AWB as 'shipped' if still 'new'
// 3. Checks Shopify fulfillment status for remaining stale orders
//
//   node scripts/fix-stale-leads.js            DRY RUN
//   node scripts/fix-stale-leads.js --apply    apply fixes
//
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const axios = require('axios');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

const apply = process.argv.includes('--apply');

const SHOPIFY_DOMAIN = process.env.SHOPIFY_DOMAIN || 'jaadudiet.myshopify.com';
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

async function getToken() {
  if (!SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) throw new Error('Set SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET env vars');
  const resp = await axios.post(`https://${SHOPIFY_DOMAIN}/admin/oauth/access_token`,
    `grant_type=client_credentials&client_id=${SHOPIFY_CLIENT_ID}&client_secret=${SHOPIFY_CLIENT_SECRET}`,
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  return resp.data.access_token;
}

(async () => {
  const client = await pool.connect();

  // Step 1: Update the views
  console.log('=== Step 1: Updating views ===');
  if (apply) {
    const viewsSql = fs.readFileSync(path.join(__dirname, '..', 'views.sql'), 'utf-8');
    await client.query(viewsSql);
    console.log('Views updated with shipped_at/awb_number filters.');
  } else {
    console.log('Would update views (dry run).');
  }

  // Step 2: Find orders stuck as 'new' that already have an AWB
  const awbStale = await client.query(
    `SELECT id, order_name, awb_number, order_status, confirmation_status
     FROM orders_master
     WHERE awb_number IS NOT NULL
       AND COALESCE(order_status, 'new') = 'new'`
  );
  console.log(`\n=== Step 2: Orders with AWB but status='new': ${awbStale.rows.length} ===`);
  awbStale.rows.slice(0, 10).forEach(r =>
    console.log(`  ${r.order_name} AWB=${r.awb_number} status=${r.order_status} confirm=${r.confirmation_status}`)
  );
  if (awbStale.rows.length > 10) console.log(`  ... and ${awbStale.rows.length - 10} more`);

  if (apply && awbStale.rows.length > 0) {
    const ids = awbStale.rows.map(r => r.id);
    await client.query(
      `UPDATE orders_master SET order_status = 'shipped', shipped_at = COALESCE(shipped_at, NOW()), updated_at = NOW()
       WHERE id = ANY($1) AND COALESCE(order_status, 'new') = 'new'`, [ids]);
    console.log(`  Fixed ${ids.length} orders to 'shipped'.`);
  }

  // Step 3: Find orders stuck as 'new' with shipped_at set
  const shippedStale = await client.query(
    `SELECT id, order_name, shipped_at, order_status
     FROM orders_master
     WHERE shipped_at IS NOT NULL
       AND COALESCE(order_status, 'new') = 'new'`
  );
  console.log(`\n=== Step 3: Orders with shipped_at but status='new': ${shippedStale.rows.length} ===`);
  if (apply && shippedStale.rows.length > 0) {
    const ids = shippedStale.rows.map(r => r.id);
    await client.query(
      `UPDATE orders_master SET order_status = 'shipped', updated_at = NOW()
       WHERE id = ANY($1)`, [ids]);
    console.log(`  Fixed ${ids.length} orders to 'shipped'.`);
  }

  // Step 4: Check Shopify for remaining 'new' + 'pending' orders older than 5 days
  const staleLeads = await client.query(
    `SELECT id, shopify_order_id, order_name, order_status, confirmation_status, payment_method, total_price,
            created_at
     FROM orders_master
     WHERE COALESCE(order_status, 'new') = 'new'
       AND shipped_at IS NULL
       AND awb_number IS NULL
       AND created_at < NOW() - INTERVAL '5 days'
       AND shopify_order_id IS NOT NULL
     ORDER BY created_at ASC`
  );
  console.log(`\n=== Step 4: Stale leads (>5 days, no AWB, still 'new'): ${staleLeads.rows.length} ===`);
  console.log('Checking Shopify fulfillment status...');

  let token;
  try { token = await getToken(); } catch (e) {
    console.log('Could not get Shopify token: ' + e.message);
    console.log('Skipping Shopify fulfillment check.');
    token = null;
  }

  let fulfilled = 0, cancelled = 0, paymentFixed = 0, notFound = 0;
  if (token) {
    for (let i = 0; i < staleLeads.rows.length; i++) {
      const row = staleLeads.rows[i];
      try {
        // Look up by order name (more reliable than internal ID)
        const orderNum = (row.order_name || '').replace(/^#/, '');
        let o = null;

        // Try by internal ID first
        try {
          const resp = await axios.get(
            `https://${SHOPIFY_DOMAIN}/admin/api/2026-04/orders/${row.shopify_order_id}.json?fields=id,name,fulfillment_status,cancelled_at,financial_status,gateway,payment_gateway_names,shipping_lines`,
            { headers: { 'X-Shopify-Access-Token': token } }
          );
          o = resp.data.order;
        } catch (e1) {
          if (e1.response && e1.response.status === 404 && orderNum) {
            // Fallback: search by order name
            console.log(`  ${row.order_name}: ID ${row.shopify_order_id} not found, searching by name...`);
            try {
              const resp2 = await axios.get(
                `https://${SHOPIFY_DOMAIN}/admin/api/2026-04/orders.json?name=${orderNum}&status=any&fields=id,name,fulfillment_status,cancelled_at,financial_status,gateway,payment_gateway_names,shipping_lines`,
                { headers: { 'X-Shopify-Access-Token': token } }
              );
              if (resp2.data.orders && resp2.data.orders.length > 0) {
                o = resp2.data.orders[0];
                // Fix the stored shopify_order_id
                if (apply) {
                  await client.query('UPDATE orders_master SET shopify_order_id = $1 WHERE id = $2', [o.id, row.id]);
                }
                console.log(`  ${row.order_name}: Found by name, fixed ID ${row.shopify_order_id} -> ${o.id}`);
              }
            } catch (e2) { /* ignore search errors */ }
          } else {
            throw e1;
          }
        }

        if (!o) {
          console.log(`  ${row.order_name}: NOT FOUND on Shopify (ID=${row.shopify_order_id})`);
          notFound++;
          continue;
        }

        console.log(`  ${row.order_name}: fulfillment=${o.fulfillment_status || 'unfulfilled'}, cancelled=${!!o.cancelled_at}, financial=${o.financial_status}`);

        // Check if cancelled
        if (o.cancelled_at) {
          console.log(`    -> CANCELLED on Shopify`);
          if (apply) {
            await client.query(
              `UPDATE orders_master SET order_status = 'cancelled', confirmation_status = 'cancelled', updated_at = NOW() WHERE id = $1`, [row.id]);
          }
          cancelled++;
          continue;
        }

        // Check if fulfilled/shipped
        if (o.fulfillment_status === 'fulfilled' || o.fulfillment_status === 'partial') {
          console.log(`    -> marking as shipped (fulfilled)`);
          if (apply) {
            await client.query(
              `UPDATE orders_master SET order_status = 'shipped', shipped_at = COALESCE(shipped_at, NOW()), updated_at = NOW() WHERE id = $1`, [row.id]);
          }
          fulfilled++;
        } else if (o.financial_status === 'paid' && row.payment_method === 'COD') {
          // COD orders become 'paid' only after cash is collected = delivered
          console.log(`    -> marking as delivered (COD + financial_status=paid = cash collected)`);
          if (apply) {
            await client.query(
              `UPDATE orders_master SET order_status = 'delivered', delivered_at = COALESCE(delivered_at, NOW()), updated_at = NOW() WHERE id = $1`, [row.id]);
          }
          fulfilled++;
        }

        // Also fix payment method while we're here
        const gw = ((o.gateway || '') + ' ' + (o.payment_gateway_names || []).join(' ')).toLowerCase();
        const hasCODShipping = (o.shipping_lines || []).some(s => (s.title || '').toLowerCase().includes('cod'));
        const shouldBeCOD = gw.includes('cod') || gw.includes('cash') || gw === 'manual' || hasCODShipping ||
          (o.financial_status === 'pending' && !gw.trim());
        const correctMethod = shouldBeCOD ? 'COD' : 'PREPAID';

        if (correctMethod !== row.payment_method) {
          console.log(`    -> payment ${row.payment_method} -> ${correctMethod}`);
          if (apply) {
            await client.query(`UPDATE orders_master SET payment_method = $1, updated_at = NOW() WHERE id = $2`, [correctMethod, row.id]);
          }
          paymentFixed++;
        }

      } catch (e) {
        if (e.response && e.response.status === 429) {
          console.log('  Rate limited, waiting 2s...');
          await new Promise(r => setTimeout(r, 2000));
          i--;
          continue;
        }
        console.log(`  ${row.order_name}: ERROR ${e.message}`);
      }

      if (i % 2 === 0) await new Promise(r => setTimeout(r, 600));
      if (i % 50 === 0 && i > 0) console.log(`  ... checked ${i}/${staleLeads.rows.length}`);
    }
  }

  // Summary
  const freshBefore = await client.query(`SELECT COUNT(*)::int n FROM v_cc_fresh_leads`);
  const amanBefore = await client.query(`SELECT COUNT(*)::int n FROM v_aman_fresh_leads`);

  console.log('\n=== SUMMARY ===');
  console.log(`Orders with AWB but status=new: ${awbStale.rows.length}`);
  console.log(`Orders with shipped_at but status=new: ${shippedStale.rows.length}`);
  console.log(`Stale leads checked on Shopify: ${staleLeads.rows.length}`);
  console.log(`  → fulfilled/shipped: ${fulfilled}`);
  console.log(`  → cancelled: ${cancelled}`);
  console.log(`  → not found on Shopify: ${notFound}`);
  console.log(`  → payment method fixed: ${paymentFixed}`);
  console.log(`CC fresh leads now: ${freshBefore.rows[0].n}`);
  console.log(`Aman fresh leads now: ${amanBefore.rows[0].n}`);

  if (!apply) console.log('\nDry run only. Run with --apply to fix.');
  else console.log('\nDone. All fixes applied.');

  client.release();
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
