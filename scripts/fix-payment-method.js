// One-time fix: corrects orders wrongly marked PREPAID that are actually COD.
// The old webhook logic used financial_status === 'paid' which misclassifies COD
// orders when Fastrr/Shopify marks them as paid.
//
//   node scripts/fix-payment-method.js            DRY RUN
//   node scripts/fix-payment-method.js --apply    fix them
//
require('dotenv').config();
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

function isCOD(order) {
  const gateway = ((order.gateway || '') + ' ' + (order.payment_gateway_names || []).join(' ')).toLowerCase();
  const hasCODShipping = (order.shipping_lines || []).some(s => (s.title || '').toLowerCase().includes('cod'));
  return gateway.includes('cod') || gateway.includes('cash') || gateway === 'manual' || hasCODShipping ||
    (order.financial_status === 'pending' && !gateway.trim());
}

(async () => {
  const token = await getToken();

  // Find all PREPAID orders in the CRM
  const { rows } = await pool.query(
    `SELECT id, shopify_order_id, order_name, payment_method, total_price
     FROM orders_master
     WHERE payment_method = 'PREPAID'
     ORDER BY created_at DESC`
  );
  console.log(`Found ${rows.length} PREPAID orders in the database.`);

  let wouldFix = 0;
  const toFix = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row.shopify_order_id) continue;

    try {
      const resp = await axios.get(
        `https://${SHOPIFY_DOMAIN}/admin/api/2026-04/orders/${row.shopify_order_id}.json`,
        { headers: { 'X-Shopify-Access-Token': token } }
      );
      const order = resp.data.order;
      if (isCOD(order)) {
        wouldFix++;
        toFix.push(row);
        console.log(`  ${row.order_name} (₹${row.total_price}) is actually COD — gateway: ${order.gateway}, gateways: ${(order.payment_gateway_names || []).join(',')}, financial: ${order.financial_status}`);
      }
    } catch (e) {
      if (e.response && e.response.status === 404) continue; // order from a different store
      if (e.response && e.response.status === 429) {
        console.log('Rate limited, waiting 2s...');
        await new Promise(r => setTimeout(r, 2000));
        i--; // retry
        continue;
      }
    }

    // Rate limit: Shopify allows ~2 req/sec
    if (i % 2 === 0) await new Promise(r => setTimeout(r, 600));

    if (i % 50 === 0 && i > 0) console.log(`  checked ${i}/${rows.length}...`);
  }

  console.log(`\n${wouldFix} order(s) are actually COD but marked PREPAID.`);

  if (!apply) {
    console.log('Dry run only. Run with --apply to fix them.');
  } else if (toFix.length > 0) {
    const ids = toFix.map(r => r.id);
    await pool.query(`UPDATE orders_master SET payment_method = 'COD', updated_at = NOW() WHERE id = ANY($1)`, [ids]);
    console.log(`Fixed ${ids.length} order(s) to COD.`);
  }

  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
