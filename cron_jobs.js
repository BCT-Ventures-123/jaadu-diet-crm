require('dotenv').config();
const cron = require('node-cron');
const { Pool } = require('pg');
const { google } = require('googleapis');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function db(text, params) {
  const res = await pool.query(text, params);
  return res.rows;
}
async function dbOne(text, params) {
  const rows = await db(text, params);
  return rows[0] || null;
}

// ============================================================
// GOOGLE SHEETS AUTH
// ============================================================
let sheetsClient = null;

async function getSheetsClient() {
  if (sheetsClient) return sheetsClient;

  let credentials;
  if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON) {
    const decoded = Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON, 'base64').toString('utf-8');
    credentials = JSON.parse(decoded);
  } else if (process.env.GOOGLE_SERVICE_ACCOUNT_FILE) {
    credentials = require(process.env.GOOGLE_SERVICE_ACCOUNT_FILE);
  } else {
    throw new Error('No Google service account credentials configured');
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

// ============================================================
// 1. SYNC CONFIRMATIONS FROM GOOGLE SHEET (WhatsApp + IVR)
// Reads the COD_Confirmations sheet for new disposition rows
// ============================================================
async function syncConfirmationsFromSheet() {
  try {
    const sheets = await getSheetsClient();
    const sheetId = process.env.GOOGLE_SHEET_ID;
    const tabName = process.env.GOOGLE_SHEET_TAB || 'COD_Confirmations';

    const tracker = await dbOne(
      'SELECT * FROM sheet_sync_tracker WHERE sheet_id = $1 AND tab_name = $2',
      [sheetId, tabName]
    );
    const startRow = tracker ? tracker.last_synced_row + 1 : 2;

    const range = `${tabName}!A${startRow}:Z`;
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range,
    });

    const rows = response.data.values;
    if (!rows || rows.length === 0) {
      console.log('[Sheet Sync] No new rows');
      return;
    }

    let processed = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      // Sheet columns: A(0)=OrderNumber, B(1)=Name, C(2)=Phone, D(3)=SKU,
      // E(4)=Address, F(5)=Amount, G(6)=PaymentType, H(7)=WA Sent, I(8)=Sent At,
      // J(9)=Option Clicked, K(10)=Clicked At, L(11)=Main Disposition,
      // M(12)=test, N(13)=calling date, O(14)=1st Disp, ...
      const orderNumber = (row[0] || '').trim();
      const optionClicked = (row[9] || '').trim().toLowerCase();
      const mainDisposition = (row[11] || '').trim().toLowerCase();
      const firstDisposition = (row[14] || '').trim().toLowerCase();

      // Determine the effective disposition
      let disposition = '';
      if (mainDisposition === 'done' || optionClicked === 'confirm order') {
        disposition = 'confirmed';
      } else if (mainDisposition === 'cancelled' || mainDisposition === 'rejected' || optionClicked === 'cancel order') {
        disposition = 'cancelled';
      } else if (firstDisposition === 'confirmed' || firstDisposition === 'done') {
        disposition = 'confirmed';
      } else if (firstDisposition === 'rejected' || firstDisposition === 'cancelled') {
        disposition = 'cancelled';
      } else if (firstDisposition === 'rnr' || firstDisposition === 'no_answer' || firstDisposition === 'dnp') {
        disposition = 'rnr';
      }

      const source = optionClicked ? 'whatsapp' : (firstDisposition ? 'ivr_call' : 'sheet'); if (require('./lib/ivrPlan').settings().mode === 'on' && source === 'ivr_call') continue; // IVR results now come straight into the CRM, never from the old sheet

      if (!orderNumber || !disposition) continue;

      // Match by order number (shopify_order_number) or order_name (#XXXXX)
      let order;
      const orderNum = parseInt(orderNumber);
      if (!isNaN(orderNum)) {
        order = await dbOne(
          'SELECT * FROM orders_master WHERE shopify_order_number = $1 OR order_name = $2',
          [orderNum, '#' + orderNumber]
        );
      } else {
        order = await dbOne('SELECT * FROM orders_master WHERE order_name = $1', [orderNumber]);
      }

      if (!order) {
        console.log(`[Sheet Sync] Order not found for: ${orderNumber}`);
        continue;
      }

      // Orders the WhatsApp bridge handles get their WhatsApp results straight from the WhatsApp service, never from the old sheet (nothing counted twice).
      // Orders messaged by the old flow before go-live still come through the sheet, so a click on an old message is not lost.
      if (source === 'whatsapp') {
        try {
          const wb = require('./lib/waBridge');
          if (wb.settings().mode === 'on') {
            await wb.ensureTables(db);
            const managed = await db('SELECT 1 FROM wa_messages WHERE order_id = $1 AND step <= 4 LIMIT 1', [order.id]);
            if (managed.length) continue;
          }
        } catch (e) { console.error('[Sheet Sync] could not check the WhatsApp bridge for', orderNumber, e.message); }
      }

      if (order.confirmation_status !== 'pending') {
        continue;
      }

      const notes = `via ${source}, option: ${row[9] || '-'}, mainDisp: ${row[11] || '-'}, 1stDisp: ${row[14] || '-'}`;

      if (disposition === 'confirmed') {
        await db(`
          UPDATE orders_master SET
            confirmation_status = 'confirmed', confirmed_at = NOW(),
            call_attempts = call_attempts + 1, last_call_at = NOW()
          WHERE id = $1
        `, [order.id]);
        await db(`SELECT log_status_change($1, 'confirmed', 'pending', 'confirmed', $2, $3)`,
          [order.id, source, notes]);
        processed++;
        console.log(`[Sheet Sync] Order ${order.order_name} → CONFIRMED (${source})`);

      } else if (disposition === 'cancelled') {
        await db(`
          UPDATE orders_master SET
            confirmation_status = 'cancelled', order_status = 'cancelled',
            cancelled_at = NOW(), cancellation_reason = $2,
            call_attempts = call_attempts + 1, last_call_at = NOW()
          WHERE id = $1
        `, [order.id, notes]);
        await db(`SELECT log_status_change($1, 'cancelled', 'pending', 'cancelled', $2, $3)`,
          [order.id, source, notes]);
        processed++;
        console.log(`[Sheet Sync] Order ${order.order_name} → CANCELLED (${source})`);

      } else if (disposition === 'rnr') {
        await db(`
          UPDATE orders_master SET call_attempts = call_attempts + 1, last_call_at = NOW()
          WHERE id = $1
        `, [order.id]);
        await db(`SELECT log_status_change($1, 'rnr', NULL, 'rnr', $2, $3)`,
          [order.id, source, notes]);
        processed++;
        console.log(`[Sheet Sync] Order ${order.order_name} → RNR (${source})`);
      }
    }

    const newLastRow = startRow + rows.length - 1;
    if (tracker) {
      await db('UPDATE sheet_sync_tracker SET last_synced_row = $1, last_synced_at = NOW(), updated_at = NOW() WHERE id = $2',
        [newLastRow, tracker.id]);
    } else {
      await db('INSERT INTO sheet_sync_tracker (sheet_id, tab_name, last_synced_row) VALUES ($1, $2, $3)',
        [sheetId, tabName, newLastRow]);
    }

    console.log(`[Sheet Sync] Processed ${processed} new dispositions from ${rows.length} rows`);

    // === SECOND PASS: Re-check pending orders for late WhatsApp/IVR clicks ===
    await recheckPendingOrders(sheets, sheetId, tabName);

  } catch (err) {
    console.error('[Sheet Sync] Error:', err.message);
  }
}

// Re-scans sheet rows for orders still pending in DB (catches late clicks)
async function recheckPendingOrders(sheets, sheetId, tabName) {
  try {
    const pendingOrders = await db(`
      SELECT id, shopify_order_number, order_name
      FROM orders_master
      WHERE confirmation_status = 'pending'
        AND payment_method = 'COD'
        AND created_at > NOW() - INTERVAL '72 hours'
        AND shopify_order_number IS NOT NULL
    `);

    if (pendingOrders.length === 0) return;

    const orderMap = {};
    for (const o of pendingOrders) {
      orderMap[String(o.shopify_order_number)] = o;
      if (o.order_name) orderMap[o.order_name.replace('#', '')] = o;
    }

    // Read the full sheet to find these orders' rows
    // We limit to last 2000 rows to avoid reading the entire sheet
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${tabName}!A2:O`,
    });

    const rows = response.data.values;
    if (!rows || rows.length === 0) return;

    let lateUpdates = 0;
    for (const row of rows) {
      const orderNumber = (row[0] || '').trim();
      if (!orderNumber || !orderMap[orderNumber]) continue;

      const order = orderMap[orderNumber];
      const optionClicked = (row[9] || '').trim().toLowerCase();
      const mainDisposition = (row[11] || '').trim().toLowerCase();
      const firstDisposition = (row[14] || '').trim().toLowerCase();

      let disposition = '';
      if (mainDisposition === 'done' || optionClicked === 'confirm order') {
        disposition = 'confirmed';
      } else if (mainDisposition === 'cancelled' || mainDisposition === 'rejected' || optionClicked === 'cancel order') {
        disposition = 'cancelled';
      } else if (firstDisposition === 'confirmed' || firstDisposition === 'done') {
        disposition = 'confirmed';
      } else if (firstDisposition === 'rejected' || firstDisposition === 'cancelled') {
        disposition = 'cancelled';
      }

      if (!disposition) continue;

      const source = optionClicked ? 'whatsapp_late' : 'ivr_late'; if (require('./lib/ivrPlan').settings().mode === 'on' && source === 'ivr_late') continue; // same rule for late rows
      const notes = `Late click via ${source}, option: ${row[9] || '-'}, mainDisp: ${row[11] || '-'}`;

      if (disposition === 'confirmed') {
        await db(`
          UPDATE orders_master SET
            confirmation_status = 'confirmed', confirmed_at = NOW(),
            call_attempts = call_attempts + 1, last_call_at = NOW()
          WHERE id = $1 AND confirmation_status = 'pending'
        `, [order.id]);
        await db(`SELECT log_status_change($1, 'confirmed', 'pending', 'confirmed', $2, $3)`,
          [order.id, source, notes]);
        lateUpdates++;
        console.log(`[Sheet Recheck] Order ${order.order_name} → CONFIRMED (late click)`);
      } else if (disposition === 'cancelled') {
        await db(`
          UPDATE orders_master SET
            confirmation_status = 'cancelled', order_status = 'cancelled',
            cancelled_at = NOW(), cancellation_reason = $2
          WHERE id = $1 AND confirmation_status = 'pending'
        `, [order.id, notes]);
        await db(`SELECT log_status_change($1, 'cancelled', 'pending', 'cancelled', $2, $3)`,
          [order.id, source, notes]);
        lateUpdates++;
        console.log(`[Sheet Recheck] Order ${order.order_name} → CANCELLED (late click)`);
      }
    }

    if (lateUpdates > 0) {
      console.log(`[Sheet Recheck] ${lateUpdates} late WhatsApp/IVR clicks processed`);
    }
  } catch (err) {
    console.error('[Sheet Recheck] Error:', err.message);
  }
}

// ============================================================
// 2. EXPORT CONFIRMED/CANCELLED ORDERS TO GOOGLE SHEET
// ============================================================
async function exportOrdersToSheet() {
  try {
    const sheets = await getSheetsClient();
    const sheetId = process.env.GOOGLE_SHEET_ID;
    const exportTab = 'Order_Export';

    const rows = await db('SELECT * FROM v_sheet_export_pending');
    if (rows.length === 0) {
      console.log('[Sheet Export] No pending exports');
      return;
    }

    const values = rows.map(r => [
      r.order_name, r.customer_name, r.customer_phone,
      r.shipping_address1, r.shipping_address2 || '',
      r.shipping_city, r.shipping_province, r.shipping_zip,
      r.total_price, r.payment_method, r.confirmation_status,
      r.order_status, r.assigned_to, r.assigned_agent || '',
      r.awb_number || '', r.courier_name || '',
      r.created_at, r.confirmed_at || '', r.shipped_at || ''
    ]);

    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: `${exportTab}!A:S`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values }
    });

    const ids = rows.map(r => r.id);
    await db(`UPDATE orders_master SET synced_to_sheet = TRUE, synced_at = NOW() WHERE id = ANY($1)`, [ids]);

    console.log(`[Sheet Export] Exported ${rows.length} orders`);
  } catch (err) {
    console.error('[Sheet Export] Error:', err.message);
  }
}

// Call-centre leads are followed up for FOLLOWUP_DAYS (default 7) from the order date,
// then marked Unreachable. Leads with a callback still scheduled in the future are left alone.
async function markUnreachable() {
  try {
    const days = require('./lib/config').FOLLOWUP_DAYS;
    // A lead sent back to calling (requeued_at) gets a fresh follow-up window from that moment.
    const clock = (await require('./lib/balanceDb').hasRequeueColumn(db)) ? 'COALESCE(requeued_at, created_at)' : 'created_at';
    const rows = await db(`
      UPDATE orders_master SET
        confirmation_status = 'unreachable', unreachable_at = NOW(),
        lead_locked_by = NULL, lead_locked_at = NULL
      WHERE assigned_to = 'CC'
        AND confirmation_status = 'pending'
        AND payment_method = 'COD'
        AND order_status = 'new'
        AND dnc = FALSE
        AND ${clock} <= NOW() - ($1 || ' days')::interval
        AND (callback_at IS NULL OR callback_at <= NOW())
      RETURNING id
    `, [String(days)]);
    for (const row of rows) {
      await db(`SELECT log_status_change($1, 'unreachable', 'pending', 'unreachable', 'system', $2)`,
        [row.id, `No contact within ${days} days of order date`]);
    }
    if (rows.length) console.log(`[Unreachable] Marked ${rows.length} leads unreachable`);
  } catch (err) {
    console.error('[Unreachable] Error:', err.message);
  }
}

// ============================================================
// 4. EXPIRE STALE LEAD LOCKS (>15 min)
// ============================================================
async function expireLeadLocks() {
  try {
    const result = await db(`
      UPDATE orders_master SET lead_locked_by = NULL, lead_locked_at = NULL
      WHERE lead_locked_at IS NOT NULL
        AND lead_locked_at < NOW() - INTERVAL '15 minutes'
      RETURNING id
    `);
    if (result.length > 0) {
      console.log(`[Lock Expire] Released ${result.length} stale locks`);
    }
  } catch (err) {
    console.error('[Lock Expire] Error:', err.message);
  }
}

// ============================================================
// 5. STUCK IN TRANSIT ALERT (>7 days)
// ============================================================
async function checkStuckTransit() {
  try {
    const stuck = await db('SELECT * FROM v_logistics_stuck_transit');
    if (stuck.length > 0) {
      console.log(`[Stuck Transit] ${stuck.length} orders stuck >7 days`);
    }
  } catch (err) {
    console.error('[Stuck Transit] Error:', err.message);
  }
}

// ============================================================
// 6. REFRESH AD EXCLUSION PINCODES
// ============================================================
async function refreshAdExclusion() {
  try {
    await db('DELETE FROM ad_exclusion_pincodes');
    await db(`
      INSERT INTO ad_exclusion_pincodes (pincode, total_shipped, total_rto, rto_rate)
      SELECT * FROM get_excluded_pincodes()
    `);
    const count = await dbOne('SELECT COUNT(*) AS c FROM ad_exclusion_pincodes');
    console.log(`[Ad Exclusion] Refreshed: ${count?.c || 0} pincodes excluded`);
  } catch (err) {
    console.error('[Ad Exclusion] Error:', err.message);
  }
}

// ============================================================
// 7. REPLENISHMENT CHECK (25-day re-order)
// ============================================================
async function checkReplenishment() {
  try {
    const result = await db(`
      UPDATE orders_master SET
        replenish_eligible = TRUE,
        replenish_due_date = (delivered_at + INTERVAL '25 days')::DATE
      WHERE order_status = 'delivered'
        AND delivered_at IS NOT NULL
        AND delivered_at < NOW() - INTERVAL '22 days'
        AND replenish_eligible = FALSE
        AND confirmation_status = 'confirmed'
      RETURNING id, order_name, customer_phone
    `);
    if (result.length > 0) {
      console.log(`[Replenish] ${result.length} customers eligible for re-order`);
    }
  } catch (err) {
    console.error('[Replenish] Error:', err.message);
  }
}

// ============================================================
// 8. LOGISTICS TRACKING EXPORT TO GOOGLE SHEET
// Exports shipped/delivered/NDR/RTO orders to Logistics_Tracking tab
// Appends new rows, updates existing rows when status changes
// ============================================================
async function exportLogisticsTracking() {
  try {
    const sheets = await getSheetsClient();
    const sheetId = process.env.GOOGLE_SHEET_ID;
    const logTab = 'Logistics_Tracking';

    // Get all orders that have been confirmed, shipped, delivered, NDR, or RTO
    const orders = await db(`
      SELECT order_name, customer_name, customer_phone,
        shipping_address1, shipping_city, shipping_zip,
        total_price, payment_method, confirmation_status, order_status,
        assigned_to, assigned_agent,
        awb_number, courier_name,
        confirmed_at, shipped_at, delivered_at, cancelled_at,
        ndr_status, ndr_count, ndr_last_reason,
        created_at
      FROM orders_master
      WHERE confirmation_status IN ('confirmed', 'cancelled')
         OR order_status IN ('shipped', 'in_transit', 'delivered', 'ndr', 'rto')
      ORDER BY created_at DESC
    `);

    if (orders.length === 0) {
      console.log('[Logistics Export] No orders to export');
      return;
    }

    // Ensure the tab exists, create if not
    let existingOrders = {};
    let tabExists = false;
    try {
      const existing = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: `${logTab}!A:A`,
      });
      tabExists = true;
      if (existing.data.values) {
        existing.data.values.forEach((row, i) => {
          if (row[0]) existingOrders[row[0]] = i + 1;
        });
      }
    } catch (e) {
      // Tab doesn't exist — create it
      console.log('[Logistics Export] Creating Logistics_Tracking tab...');
      try {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: sheetId,
          requestBody: {
            requests: [{
              addSheet: {
                properties: { title: logTab }
              }
            }]
          }
        });
        tabExists = true;
        console.log('[Logistics Export] Tab created');
      } catch (createErr) {
        console.error('[Logistics Export] Failed to create tab:', createErr.message);
        return;
      }
    }

    const formatDate = (d) => d ? new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '';

    // Separate new rows and updates
    const newRows = [];
    const updates = [];

    for (const o of orders) {
      const rowData = [
        o.order_name, o.customer_name, o.customer_phone,
        o.shipping_address1 || '', o.shipping_city || '', o.shipping_zip || '',
        o.total_price, o.payment_method,
        o.confirmation_status, o.order_status,
        o.assigned_to || '', o.assigned_agent || '',
        o.awb_number || '', o.courier_name || '',
        formatDate(o.created_at), formatDate(o.confirmed_at),
        formatDate(o.shipped_at), formatDate(o.delivered_at),
        o.ndr_status || '', o.ndr_count || 0, o.ndr_last_reason || '',
        formatDate(o.cancelled_at)
      ];

      if (existingOrders[o.order_name]) {
        updates.push({ row: existingOrders[o.order_name], data: rowData });
      } else {
        newRows.push(rowData);
      }
    }

    // Add header if sheet is empty
    if (Object.keys(existingOrders).length === 0) {
      const header = [
        'Order', 'Customer', 'Phone', 'Address', 'City', 'PIN',
        'Amount', 'Payment', 'Confirmation', 'Order Status',
        'Assigned To', 'Agent', 'AWB', 'Courier',
        'Created', 'Confirmed', 'Shipped', 'Delivered',
        'NDR Status', 'NDR Count', 'NDR Reason', 'Cancelled'
      ];
      newRows.unshift(header);
    }

    // Append new rows
    if (newRows.length > 0) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: sheetId,
        range: `${logTab}!A:V`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: newRows }
      });
    }

    // Update existing rows (batch update for efficiency)
    if (updates.length > 0) {
      const batchData = updates.map(u => ({
        range: `${logTab}!A${u.row}:V${u.row}`,
        values: [u.data]
      }));

      // Batch in groups of 50 to avoid API limits
      for (let i = 0; i < batchData.length; i += 50) {
        const batch = batchData.slice(i, i + 50);
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: sheetId,
          requestBody: {
            valueInputOption: 'USER_ENTERED',
            data: batch
          }
        });
      }
    }

    console.log(`[Logistics Export] ${newRows.length} new, ${updates.length} updated`);
  } catch (err) {
    console.error('[Logistics Export] Error:', err.message);
  }
}

// ============================================================
// 9. SHOPIFY CONFIRMED TAG RETRY
// Retries adding "confirmed" tag for orders where it failed
// ============================================================
async function retryShopifyConfirmedTags() {
  try {
    const store = process.env.SHOPIFY_STORE_DOMAIN;
    const token = process.env.SHOPIFY_ACCESS_TOKEN;
    const apiVersion = process.env.SHOPIFY_API_VERSION || '2024-10';
    if (!store || !token) return;

    const axios = require('axios');
    const unsynced = await db(
      `SELECT id, shopify_order_id FROM orders_master
       WHERE confirmation_status = 'confirmed'
         AND shopify_tag_synced = FALSE
         AND shopify_order_id IS NOT NULL
       ORDER BY confirmed_at DESC
       LIMIT 250`
    );
    if (unsynced.length === 0) return;

    let synced = 0;
    for (const o of unsynced) {
      try {
        const getUrl = `https://${store}/admin/api/${apiVersion}/orders/${o.shopify_order_id}.json?fields=id,tags`;
        const getRes = await axios.get(getUrl, { headers: { 'X-Shopify-Access-Token': token }, timeout: 10000 });
        const existing = getRes.data?.order?.tags || '';
        const have = existing.split(',').map(s => s.trim()).filter(Boolean);
        if (!have.some(t => t.toLowerCase() === 'confirmed')) {
          have.push('confirmed');
          const putUrl = `https://${store}/admin/api/${apiVersion}/orders/${o.shopify_order_id}.json`;
          await axios.put(putUrl, { order: { id: o.shopify_order_id, tags: have.join(', ') } }, {
            headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }, timeout: 10000,
          });
        }
        await db('UPDATE orders_master SET shopify_tag_synced = TRUE WHERE id = $1', [o.id]);
        synced++;
      } catch (err) {
        console.error(`[Shopify Retry] Failed for order ${o.id}:`, err.response?.data || err.message);
      }
    }
    if (synced > 0) console.log(`[Shopify Retry] Tagged ${synced}/${unsynced.length} orders`);
  } catch (err) {
    console.error('[Shopify Retry] Error:', err.message);
  }
}

// ============================================================
// SCHEDULE CRON JOBS
// ============================================================

// Every 2 minutes: sync from Google Sheet (WhatsApp/IVR confirmations)
cron.schedule('*/2 * * * *', syncConfirmationsFromSheet);

// Every 15 minutes: export confirmed orders to sheet
cron.schedule('*/15 * * * *', exportOrdersToSheet);


// Every hour (at :10): mark CC leads Unreachable after the follow-up window
cron.schedule('10 * * * *', markUnreachable);

// Every 5 minutes: expire stale lead locks
cron.schedule('*/5 * * * *', expireLeadLocks);

// Every 10 minutes: if Aman's queue is nearly empty, move the oldest call-centre leads to him (09:00-13:30 IST).
// Switch off with AUTO_BALANCE=off. Tune with BALANCE_MIN_AMAN, BALANCE_KEEP_CC, BALANCE_BATCH, BALANCE_START_HOUR, BALANCE_END_HOUR.
async function autoBalance() {
  try {
    const balance = require('./lib/balance'), bdb = require('./lib/balanceDb');
    const s = balance.settings();
    if (!s.auto || !balance.inWindow(new Date(), s)) return;
    const c = await bdb.counts(db);
    const n = balance.planMove(c, s);
    if (n <= 0) return;
    const moved = await bdb.moveLeads(db, n, 'Auto-balance');
    if (moved.length) console.log(`[Balance] Aman had ${c.amanOpen} open, call centre ${c.ccOpen}: moved ${moved.length} lead(s) to Aman`);
  } catch (err) {
    console.error('[Balance] Error:', err.message);
  }
}
cron.schedule('*/10 * * * *', autoBalance);

// Every minute: autopilot (who is working, hand-overs, the 2 PM first-call target). AUTOPILOT=off|dry|on, default dry (plans and records, moves nothing).
let autopilotReady = false;
async function autopilotTick() {
  try {
    const apDb = require('./lib/autopilotDb');
    if (!autopilotReady) { await apDb.ensureTables(db); autopilotReady = true; }
    const r = await apDb.tick(db);
    if (r.planned) console.log(`[Autopilot] ${r.mode}: planned ${r.planned}, moved ${r.moved}`, JSON.stringify(r.reasons));
  } catch (err) {
    console.error('[Autopilot] Error:', err.message);
  }
}
cron.schedule('* * * * *', autopilotTick);

// Every minute: IVR calls (only when IVR_MODE=on, inside the 6-9 AM and 6-11 PM windows, up to IVR_DAILY_CAP calls a day). Runs on the worker only.
async function ivrTick() {
  try {
    if (require('./lib/ivrPlan').settings().mode !== 'on') return;
    const r = await require('./lib/ivrDb').runAndRecord(db);
    if (r.placed || r.failed || r.stopped) console.log('[IVR]', JSON.stringify(r));
  } catch (err) {
    console.error('[IVR] Error:', err.message);
  }
}
cron.schedule('* * * * *', ivrTick);

// Every 5 minutes: copy this month's results (Aman, call centre, IVR, WhatsApp) into the "Updated Caller sheet" as a backup + Report. Read-only on the database; a failure here never touches orders or calls.
let backupBusy = false;
async function sheetBackupTick() {
  if (backupBusy) return;
  backupBusy = true;
  try {
    const sb = require('./lib/sheetBackup'), s = sb.settings();
    if (!s.on) return;
    const r = await sb.run({ db, sheets: await getSheetsClient(), sheetId: s.sheetId });
    console.log('[Backup sheet] wrote', r.rows, 'rows' + (r.report_created ? ' (Report tab created)' : ''));
  } catch (err) {
    console.error('[Backup sheet] Error:', err.message);
  } finally { backupBusy = false; }
}
cron.schedule('*/5 * * * *', sheetBackupTick);

// Every 6 hours: check stuck in transit
cron.schedule('0 */6 * * *', checkStuckTransit);

// Daily at 3 AM IST (21:30 UTC): refresh ad exclusion pincodes
cron.schedule('30 21 * * *', refreshAdExclusion);

// Daily at 8 AM IST (2:30 UTC): check replenishment eligibility
cron.schedule('30 2 * * *', checkReplenishment);

// Every 30 minutes: export logistics tracking to sheet
cron.schedule('*/30 * * * *', exportLogisticsTracking);

// Every 2 minutes: retry Shopify confirmed tag for unsynced orders
cron.schedule('*/2 * * * *', retryShopifyConfirmedTags);
// ============================================================
// 10. SHOPIFY SYNC RETRY (cancel + address)
// Cancels made anywhere in the CRM (call centre, Aman, WhatsApp, IVR, sheet) must also be cancelled on Shopify, and a corrected
// address must reach Shopify. Failed pushes are recorded on the order ("shopify_*_failed") and retried here, at most 6 times,
// for orders from the last 3 days that have not shipped. "Already cancelled" on Shopify counts as done.
// ============================================================
async function retryShopifySync() {
  try {
    const store = process.env.SHOPIFY_STORE_DOMAIN, token = process.env.SHOPIFY_ACCESS_TOKEN;
    const apiVersion = process.env.SHOPIFY_API_VERSION || '2024-10';
    if (!store || !token) return;
    const axios = require('axios');
    const H = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };
    const record = (id, type, ok, note) => db(`SELECT log_status_change($1, $2, NULL, $3, 'system', $4)`, [id, type, ok ? 'synced' : 'failed', String(note || '').slice(0, 400)]).catch(() => {});
    const failMsg = (err) => err.response ? `HTTP ${err.response.status} ${JSON.stringify(err.response.data)}` : err.message;

    const cancels = await db(
      `SELECT o.id, o.shopify_order_id, o.cancellation_reason FROM orders_master o
       WHERE o.confirmation_status = 'cancelled' AND o.shopify_order_id IS NOT NULL AND UPPER(COALESCE(o.payment_method,'')) = 'COD'
         AND COALESCE(o.cancelled_at, o.updated_at) > NOW() - INTERVAL '3 days'
         AND o.shipped_at IS NULL AND COALESCE(o.order_status,'') NOT IN ('shipped','delivered','rto')
         AND NOT EXISTS (SELECT 1 FROM order_status_events e WHERE e.order_id = o.id AND e.event_type = 'shopify_cancel_synced')
         AND (SELECT COUNT(*) FROM order_status_events e WHERE e.order_id = o.id AND e.event_type = 'shopify_cancel_failed') < 6
       ORDER BY COALESCE(o.cancelled_at, o.updated_at) DESC LIMIT 40`);
    for (const o of cancels) {
      try {
        await axios.post(`https://${store}/admin/api/${apiVersion}/orders/${o.shopify_order_id}/cancel.json`, { reason: 'customer', note: o.cancellation_reason || 'Cancelled via CRM' }, { headers: H, timeout: 15000 });
        await record(o.id, 'shopify_cancel_synced', true, 'Order cancelled on Shopify (retry)');
      } catch (err) {
        if (err.response && err.response.status === 422 && /cancel/i.test(JSON.stringify(err.response.data))) await record(o.id, 'shopify_cancel_synced', true, 'Already cancelled on Shopify');
        else { console.error(`[Shopify Sync] cancel failed for ${o.id}:`, failMsg(err)); await record(o.id, 'shopify_cancel_failed', false, failMsg(err)); }
      }
    }

    const addrs = await db(
      `SELECT o.id, o.shopify_order_id, o.shipping_address1 FROM orders_master o
       WHERE o.shopify_order_id IS NOT NULL AND o.shipped_at IS NULL AND o.confirmation_status <> 'cancelled'
         AND EXISTS (SELECT 1 FROM order_status_events f WHERE f.order_id = o.id AND f.event_type = 'shopify_address_failed' AND f.created_at > NOW() - INTERVAL '3 days'
                       AND NOT EXISTS (SELECT 1 FROM order_status_events s WHERE s.order_id = o.id AND s.event_type = 'shopify_address_synced' AND s.created_at > f.created_at))
         AND (SELECT COUNT(*) FROM order_status_events e WHERE e.order_id = o.id AND e.event_type = 'shopify_address_failed') < 6
       LIMIT 40`);
    for (const o of addrs) {
      try {
        await axios.put(`https://${store}/admin/api/${apiVersion}/orders/${o.shopify_order_id}.json`, { order: { id: o.shopify_order_id, shipping_address: { address1: o.shipping_address1 } } }, { headers: H, timeout: 15000 });
        await record(o.id, 'shopify_address_synced', true, 'Address line sent to Shopify (retry)');
      } catch (err) { console.error(`[Shopify Sync] address failed for ${o.id}:`, failMsg(err)); await record(o.id, 'shopify_address_failed', false, failMsg(err)); }
    }
    if (cancels.length || addrs.length) console.log(`[Shopify Sync] retried ${cancels.length} cancel(s), ${addrs.length} address(es)`);
  } catch (err) { console.error('[Shopify Sync] error:', err.message); }
}
cron.schedule('*/2 * * * *', retryShopifySync);

console.log('Jaadu Diet CRM Cron Jobs started');
console.log('Active jobs: sheet-sync(2m), sheet-export(15m), unreachable(1h), lock-expire(5m), stuck-transit(6h), ad-exclusion(daily), replenish(daily), logistics(30m), shopify-tag-retry(2m)');

// Run initial sync on startup
setTimeout(async () => {
  console.log('[Startup] Running initial sync...');
  await syncConfirmationsFromSheet();
  await expireLeadLocks();
  await exportLogisticsTracking();
  await retryShopifyConfirmedTags();
}, 5000);
