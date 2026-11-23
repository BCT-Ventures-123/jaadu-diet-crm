// One-time clean-up: clears the "short address" flag on open orders whose address is actually fine under the current rule.
//   node scripts/recheck-short-address.js            DRY RUN: shows what would change, changes nothing
//   node scripts/recheck-short-address.js --apply    clears the flags (each one is logged on the order, so it can be undone)
//   node scripts/recheck-short-address.js --undo     puts back the flag on every order this script cleared
// Only open orders (pending or confirmed, not shipped, address not locked, not already fixed) are looked at.
require('dotenv').config();
const { Pool } = require('pg');
const { isShortAddress, fullAddressOf } = require('../lib/address');

const apply = process.argv.includes('--apply');
const undo = process.argv.includes('--undo');
const opt = {
  minChars: Number(process.env.SHORT_ADDRESS_MIN_CHARS) || 25,
  minWords: Number(process.env.SHORT_ADDRESS_MIN_WORDS) || 4,
  requirePremise: process.env.SHORT_ADDRESS_REQUIRE_PREMISE === '1',
};

(async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });

  if (undo) {
    const r = await pool.query(
      `UPDATE orders_master o SET address_is_short = TRUE, updated_at = NOW()
       WHERE o.address_is_short = FALSE AND COALESCE(o.address_fixed, FALSE) = FALSE
         AND EXISTS (SELECT 1 FROM order_status_events e WHERE e.order_id = o.id AND e.event_type = 'short_flag_cleared')
       RETURNING o.id`);
    console.log(`Put the short-address flag back on ${r.rowCount} order(s).`);
    await pool.end(); return;
  }

  // Part 1: Clear flags on orders that are actually fine
  const { rows } = await pool.query(
    `SELECT id, order_name, shipping_address1, shipping_address2, shipping_city, shipping_province FROM orders_master
     WHERE address_is_short = TRUE AND COALESCE(address_fixed, FALSE) = FALSE AND COALESCE(address_locked, FALSE) = FALSE
       AND confirmation_status IN ('pending', 'confirmed') AND COALESCE(order_status, 'new') NOT IN ('shipped', 'delivered', 'rto', 'cancelled')
       AND shipped_at IS NULL AND awb_number IS NULL`);
  const clear = rows.filter(o => !isShortAddress(fullAddressOf(o), opt));
  console.log(`Rule in use: at least ${opt.minChars} characters and ${opt.minWords} words${opt.requirePremise ? ', and a house/flat/near word' : ''}.`);
  console.log(`${rows.length} open order(s) are flagged short. ${clear.length} of them are fine under the rule and would be cleared; ${rows.length - clear.length} really are short and stay.`);
  clear.slice(0, 8).forEach(o => console.log('  would clear', o.order_name, '|', fullAddressOf(o)));

  // Part 2: Flag orders that SHOULD be short but aren't flagged
  const { rows: unflagged } = await pool.query(
    `SELECT id, order_name, shipping_address1, shipping_address2, shipping_city, shipping_province FROM orders_master
     WHERE (address_is_short = FALSE OR address_is_short IS NULL) AND COALESCE(address_fixed, FALSE) = FALSE
       AND confirmation_status IN ('pending', 'confirmed') AND COALESCE(order_status, 'new') NOT IN ('shipped', 'delivered', 'rto', 'cancelled')
       AND shipped_at IS NULL AND awb_number IS NULL AND payment_method = 'COD'`);
  const needFlag = unflagged.filter(o => isShortAddress(fullAddressOf(o), opt));
  console.log(`\n${unflagged.length} open COD order(s) are NOT flagged short. ${needFlag.length} of them actually have short addresses and need flagging.`);
  needFlag.slice(0, 8).forEach(o => console.log('  would flag', o.order_name, '|', fullAddressOf(o)));

  if (!apply) { console.log('\nDry run only. Nothing was changed. Run again with --apply to fix them.'); await pool.end(); return; }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const clearIds = clear.map(o => o.id);
    if (clearIds.length) {
      await client.query(`UPDATE orders_master SET address_is_short = FALSE, updated_at = NOW() WHERE id = ANY($1)`, [clearIds]);
      await client.query(`INSERT INTO order_status_events (order_id, event_type, old_value, new_value, actor, notes)
                          SELECT unnest($1::uuid[]), 'short_flag_cleared', 'short', 'ok', 'system', 'Address re-checked with the corrected short-address rule'`, [clearIds]);
    }
    const flagIds = needFlag.map(o => o.id);
    if (flagIds.length) {
      await client.query(`UPDATE orders_master SET address_is_short = TRUE, updated_at = NOW() WHERE id = ANY($1)`, [flagIds]);
      await client.query(`INSERT INTO order_status_events (order_id, event_type, old_value, new_value, actor, notes)
                          SELECT unnest($1::uuid[]), 'short_flag_set', 'ok', 'short', 'system', 'Address flagged short with corrected threshold (25 chars / 4 words)'`, [flagIds]);
    }
    await client.query('COMMIT');
    console.log(`\nCleared ${clearIds.length} flag(s), set ${flagIds.length} new flag(s).`);
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
