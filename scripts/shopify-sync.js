// Re-push prepaid payments to Shopify (for orders whose automatic sync failed or was skipped).
//   node scripts/shopify-sync.js --failed            sync every converted order not yet marked 'synced'
//   node scripts/shopify-sync.js "#22974"            sync one order by its Shopify name
//   add --dry-run to only show what would be written (no change in Shopify or the database)
require('dotenv').config();
const axios = require('axios');
const { Pool } = require('pg');
const { syncPrepaidToShopify } = require('../lib/shopifyPrepaid');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const failed = args.includes('--failed');
const name = args.find(a => !a.startsWith('--'));

(async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  if (!failed && !name) throw new Error('Pass --failed or an order name such as "#22974"');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
  const { rows } = failed
    ? await pool.query(`SELECT * FROM orders_master WHERE converted_to_prepaid AND COALESCE(shopify_prepaid_sync,'') <> 'synced' ORDER BY id`)
    : await pool.query(`SELECT * FROM orders_master WHERE order_name = $1 OR shopify_order_number::text = $1`, [name.replace(/^#/, '#')]);
  console.log(`${rows.length} order(s)${dryRun ? ' (dry run)' : ''}`);
  for (const o of rows) {
    let r;
    try {
      r = await syncPrepaidToShopify({
        http: axios, store: process.env.SHOPIFY_STORE_DOMAIN, token: process.env.SHOPIFY_ACCESS_TOKEN,
        apiVersion: process.env.SHOPIFY_API_VERSION, shopifyOrderId: o.shopify_order_id,
        paid: o.prepaid_amount || 599, paymentId: o.razorpay_payment_id,
        mode: process.env.SHOPIFY_PREPAID_MODE === 'exact' ? 'exact' : 'full', dryRun,
      });
    } catch (e) { r = { status: 'failed', detail: JSON.stringify(e.response?.data || e.message).slice(0, 500) }; }
    console.log(o.order_name, '->', r.status, r.detail, r.plan ? JSON.stringify({ transaction: r.plan.transaction, tags: r.plan.tags }) : '');
    if (!dryRun) {
      await pool.query(`UPDATE orders_master SET shopify_prepaid_sync=$2, shopify_prepaid_sync_detail=$3, shopify_prepaid_synced_at=NOW() WHERE id=$1`, [o.id, r.status, r.detail]);
    }
  }
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
