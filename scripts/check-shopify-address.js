// READ-ONLY. Finds out why a corrected address is not reaching Shopify.
//   node scripts/check-shopify-address.js "#30232"
// Checks: are the Shopify settings present, does the token have permission to edit orders, what address does Shopify hold vs the CRM,
// and what happened the last time the CRM tried to send it. Writes nothing. Never prints the token.
require('dotenv').config();
const axios = require('axios');
const { Pool } = require('pg');

(async () => {
  const name = process.argv[2];
  if (!name) throw new Error('Usage: node scripts/check-shopify-address.js "#30232"');
  const store = process.env.SHOPIFY_STORE_DOMAIN, token = process.env.SHOPIFY_ACCESS_TOKEN, ver = process.env.SHOPIFY_API_VERSION || '2024-10';
  console.log('Settings: SHOPIFY_STORE_DOMAIN', store ? 'set' : 'MISSING', '| SHOPIFY_ACCESS_TOKEN', token ? 'set' : 'MISSING', '| API version', ver);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
  const o = (await pool.query(`SELECT id, order_name, shopify_order_id, shipping_address1, address_fixed, order_status, confirmation_status, shipped_at FROM orders_master WHERE order_name = $1 OR order_name = $2 LIMIT 1`, [name, name.startsWith('#') ? name.slice(1) : '#' + name])).rows[0];
  if (!o) { console.log('Order', name, 'not found in the CRM.'); await pool.end(); return; }
  console.log(`CRM: ${o.order_name} | shopify_order_id ${o.shopify_order_id || 'MISSING'} | status ${o.confirmation_status}/${o.order_status} | address fixed in CRM: ${o.address_fixed}`);
  console.log('CRM address line 1:', o.shipping_address1);

  const ev = (await pool.query(`SELECT event_type, new_value, notes, created_at FROM order_status_events WHERE order_id = $1 AND event_type IN ('address_fixed','shopify_address_synced','shopify_address_failed','ndr_address_update') ORDER BY created_at DESC LIMIT 6`, [o.id]).catch(() => ({ rows: [] }))).rows;
  console.log('\nHistory (newest first):');
  if (!ev.length) console.log('  nothing recorded. Orders fixed before this check was added have no sync result.');
  ev.forEach(e => console.log('  ', new Date(e.created_at).toISOString(), e.event_type, '|', String(e.notes || e.new_value || '').slice(0, 220)));

  if (!store || !token) { console.log('\nSTOP: the Shopify settings are missing on this server, so nothing can be sent to Shopify. Add them in Railway variables.'); await pool.end(); return; }
  const H = { 'X-Shopify-Access-Token': token };
  try {
    const sc = await axios.get(`https://${store}/admin/oauth/access_scopes.json`, { headers: H, timeout: 15000 });
    const scopes = (sc.data.access_scopes || []).map(s => s.handle);
    console.log('\nToken permissions:', scopes.join(', ') || '(none)');
    console.log(scopes.includes('write_orders') ? 'OK: the token can edit orders.' : 'PROBLEM: the token has no "write_orders" permission, so Shopify refuses every address change. Add write_orders to the app in Shopify, then re-install / re-issue the token.');
  } catch (e) { console.log('\nCould not read token permissions:', e.response ? 'HTTP ' + e.response.status : e.message); }

  if (o.shopify_order_id) {
    try {
      const r = await axios.get(`https://${store}/admin/api/${ver}/orders/${o.shopify_order_id}.json?fields=id,name,fulfillment_status,cancelled_at,shipping_address`, { headers: H, timeout: 15000 });
      const so = r.data.order;
      console.log(`\nShopify: ${so.name} | fulfillment ${so.fulfillment_status || 'not fulfilled'} | cancelled ${so.cancelled_at ? 'yes' : 'no'}`);
      console.log('Shopify address line 1:', so.shipping_address && so.shipping_address.address1);
      console.log(so.shipping_address && so.shipping_address.address1 === o.shipping_address1 ? 'MATCH: Shopify already has the CRM address.' : 'DIFFERENT: Shopify still holds an older address.');
      if (so.fulfillment_status === 'fulfilled') console.log('NOTE: Shopify does not allow editing the address of an already fulfilled order.');
    } catch (e) { console.log('\nCould not read the order from Shopify:', e.response ? 'HTTP ' + e.response.status + ' ' + JSON.stringify(e.response.data).slice(0, 200) : e.message); }
  }
  console.log('\nDone. Nothing was changed.');
  await pool.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
