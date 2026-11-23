// Test Shopify prepaid sync WITHOUT Razorpay payment.
// Usage (run in Railway Console):
//   node scripts/test-shopify-sync.js "#23150" --dry-run   (preview only)
//   node scripts/test-shopify-sync.js "#23150"              (actually mark paid on Shopify)
require('dotenv').config();
const axios = require('axios');
const { syncPrepaidToShopify } = require('../lib/shopifyPrepaid');
const { Pool } = require('pg');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const name = args.find(a => !a.startsWith('--'));

if (!name) {
  console.log('Usage: node scripts/test-shopify-sync.js "#ORDER_NUMBER" [--dry-run]');
  console.log('  --dry-run   Show what would happen without changing Shopify');
  process.exit(1);
}

(async () => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
  });

  const cleanName = name.startsWith('#') ? name : '#' + name;
  const { rows } = await pool.query(
    `SELECT id, order_name, shopify_order_id, shopify_order_number, payment_method,
            total_price, confirmation_status, order_status, converted_to_prepaid
     FROM orders_master WHERE order_name = $1 OR shopify_order_number::text = $2`,
    [cleanName, name.replace('#', '')]
  );

  if (rows.length === 0) {
    console.log('No order found for', cleanName);
    await pool.end();
    process.exit(1);
  }

  const order = rows[0];
  console.log('Order:', order.order_name);
  console.log('  Shopify ID:', order.shopify_order_id);
  console.log('  Payment:', order.payment_method);
  console.log('  Status:', order.confirmation_status, '/', order.order_status);
  console.log('  Already prepaid:', order.converted_to_prepaid ? 'YES' : 'no');
  console.log('  Amount:', order.total_price);
  console.log('');

  if (!order.shopify_order_id) {
    console.log('ERROR: No Shopify order ID linked. Cannot sync.');
    await pool.end();
    process.exit(1);
  }

  console.log(dryRun ? '=== DRY RUN (no changes) ===' : '=== LIVE SYNC ===');

  let result;
  try {
    result = await syncPrepaidToShopify({
      http: axios,
      store: process.env.SHOPIFY_STORE_DOMAIN,
      token: process.env.SHOPIFY_ACCESS_TOKEN,
      apiVersion: process.env.SHOPIFY_API_VERSION || '2024-10',
      shopifyOrderId: order.shopify_order_id,
      paid: 599,
      paymentId: 'TEST-SYNC-' + Date.now(),
      mode: process.env.SHOPIFY_PREPAID_MODE === 'exact' ? 'exact' : 'full',
      dryRun,
    });
  } catch (e) {
    result = { status: 'failed', detail: JSON.stringify(e.response?.data || e.message).slice(0, 500) };
  }

  console.log('Result:', result.status, '-', result.detail);
  if (result.plan) console.log('Plan:', JSON.stringify(result.plan, null, 2));

  if (!dryRun && result.status === 'synced') {
    await pool.query(
      `UPDATE orders_master SET shopify_prepaid_sync = 'synced', shopify_prepaid_sync_detail = $2, shopify_prepaid_synced_at = NOW() WHERE id = $1`,
      [order.id, result.detail]
    );
    console.log('\nDone! Order marked as paid on Shopify and synced in DB.');
  }

  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
