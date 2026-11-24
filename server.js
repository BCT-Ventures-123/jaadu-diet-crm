require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');
const path = require('path');
const axios = require('axios');
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// DATABASE
// ============================================================
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
// CONFIG
// ============================================================
const CONFIG = {
  PREPAID_AMOUNT: Number(process.env.PREPAID_AMOUNT || 599),
  COD_SURCHARGE: Number(process.env.COD_SURCHARGE || 68),
  DISPATCH_CUTOFF_HOUR: 14,
  DISPATCH_CUTOFF_MIN: 30,
  AUTO_CANCEL_HOURS: 72,
  LEAD_LOCK_MINUTES: 15,
  SHORT_ADDRESS_MIN_CHARS: 25,
  SHORT_ADDRESS_MIN_WORDS: 4,
  SHOPIFY_WEBHOOK_SECRET: process.env.SHOPIFY_WEBHOOK_SECRET || 'cd135c010af17ecc0de2009739775d14227efcaa7031cfb636a3e773c1417c25',
};

// ============================================================
// SHOPIFY API HELPER
// ============================================================
// Pushes a corrected address line to the Shopify order. Never throws. When orderId (our order id) is given, the result is
// written to the order's history as "shopify_address_synced" or "shopify_address_failed" (with the reason), so a failure is visible.
async function updateShopifyShippingAddress(shopifyOrderId, newAddress, orderId) {
  const record = async (ok, note) => {
    if (!orderId) return;
    try { await db(`SELECT log_status_change($1, $2, NULL, $3, 'system', $4)`, [orderId, ok ? 'shopify_address_synced' : 'shopify_address_failed', ok ? 'synced' : 'failed', String(note || '').slice(0, 400)]); }
    catch (e) { console.error('[Shopify] could not record address sync result:', e.message); }
  };
  try {
    const store = process.env.SHOPIFY_STORE_DOMAIN;
    const token = process.env.SHOPIFY_ACCESS_TOKEN;
    const apiVersion = process.env.SHOPIFY_API_VERSION || '2024-10';
    if (!store || !token || !shopifyOrderId) {
      const why = !store ? 'SHOPIFY_STORE_DOMAIN is not set' : !token ? 'SHOPIFY_ACCESS_TOKEN is not set' : 'order has no Shopify id';
      console.error(`[Shopify] Address NOT sent to Shopify (${why}) for order ${shopifyOrderId || orderId}`);
      await record(false, why); return { ok: false, reason: why };
    }

    const url = `https://${store}/admin/api/${apiVersion}/orders/${shopifyOrderId}.json`;
    await axios.put(url, {
      order: {
        id: shopifyOrderId,
        shipping_address: {
          address1: newAddress
        }
      }
    }, {
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });
    console.log(`[Shopify] Address updated for order ${shopifyOrderId}`);
    await record(true, 'Address line sent to Shopify');
    return { ok: true };
  } catch (err) {
    const detail = err.response ? `HTTP ${err.response.status} ${JSON.stringify(err.response.data)}` : err.message;
    console.error(`[Shopify] Address update failed for ${shopifyOrderId}:`, detail);
    await record(false, detail); return { ok: false, reason: detail };
  }
}
async function addShopifyTag(shopifyOrderId, tag) {
  try {
    const store = process.env.SHOPIFY_STORE_DOMAIN;
    const token = process.env.SHOPIFY_ACCESS_TOKEN;
    const apiVersion = process.env.SHOPIFY_API_VERSION || '2024-10';
    if (!store || !token || !shopifyOrderId) return false;

    const getUrl = `https://${store}/admin/api/${apiVersion}/orders/${shopifyOrderId}.json?fields=id,tags`;
    const getRes = await axios.get(getUrl, { headers: { 'X-Shopify-Access-Token': token }, timeout: 10000 });
    const existing = getRes.data?.order?.tags || '';
    const have = existing.split(',').map(s => s.trim()).filter(Boolean);
    if (have.some(t => t.toLowerCase() === tag.toLowerCase())) return true;
    have.push(tag);

    const putUrl = `https://${store}/admin/api/${apiVersion}/orders/${shopifyOrderId}.json`;
    await axios.put(putUrl, { order: { id: shopifyOrderId, tags: have.join(', ') } }, {
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      timeout: 10000,
    });
    console.log(`[Shopify] Tag "${tag}" added to order ${shopifyOrderId}`);
    return true;
  } catch (err) {
    console.error(`[Shopify] Tag update failed for ${shopifyOrderId}:`, err.response?.data || err.message);
    return false;
  }
}

async function syncConfirmedTag(orderId, shopifyOrderId) {
  const ok = await addShopifyTag(shopifyOrderId, 'confirmed');
  if (ok) {
    await db('UPDATE orders_master SET shopify_tag_synced = TRUE WHERE id = $1', [orderId]);
  }
  return ok;
}

// Cancels the order on Shopify. Never throws. With orderId (our id) the result is written to the order's history as
// "shopify_cancel_synced" / "shopify_cancel_failed"; the 2-minute retry job in cron_jobs.js picks up failures.
async function cancelShopifyOrder(shopifyOrderId, reason, orderId) {
  const record = async (ok, note) => {
    if (!orderId) return;
    try { await db(`SELECT log_status_change($1, $2, NULL, $3, 'system', $4)`, [orderId, ok ? 'shopify_cancel_synced' : 'shopify_cancel_failed', ok ? 'synced' : 'failed', String(note || '').slice(0, 400)]); }
    catch (e) { console.error('[Shopify] could not record cancel result:', e.message); }
  };
  try {
    const store = process.env.SHOPIFY_STORE_DOMAIN;
    const token = process.env.SHOPIFY_ACCESS_TOKEN;
    const apiVersion = process.env.SHOPIFY_API_VERSION || '2024-10';
    if (!store || !token || !shopifyOrderId) {
      const why = !store ? 'SHOPIFY_STORE_DOMAIN is not set' : !token ? 'SHOPIFY_ACCESS_TOKEN is not set' : 'order has no Shopify id';
      console.error(`[Shopify] Cancel NOT sent to Shopify (${why}) for order ${shopifyOrderId || orderId}`);
      await record(false, why); return { ok: false, reason: why };
    }

    const url = `https://${store}/admin/api/${apiVersion}/orders/${shopifyOrderId}/cancel.json`;
    await axios.post(url, {
      reason: 'customer',
      note: reason || 'Cancelled by agent via CRM'
    }, {
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });
    console.log(`[Shopify] Order ${shopifyOrderId} cancelled`);
    await record(true, 'Order cancelled on Shopify');
    return { ok: true };
  } catch (err) {
    const detail = err.response ? `HTTP ${err.response.status} ${JSON.stringify(err.response.data)}` : err.message;
    // Shopify answers 422 when the order is already cancelled: that is the state we want.
    if (err.response && err.response.status === 422 && /cancel/i.test(JSON.stringify(err.response.data))) {
      await record(true, 'Already cancelled on Shopify'); return { ok: true, already: true };
    }
    console.error(`[Shopify] Cancel failed for ${shopifyOrderId}:`, detail);
    await record(false, detail); return { ok: false, reason: detail };
  }
}
// ============================================================
// LINK RAZORPAY PAYMENT ID TO SHOPIFY-ORIGINATED PREPAID ORDERS
// ============================================================
async function linkRazorpayPaymentId(shopifyOrderId, dbOrderId) {
  const store = process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  const apiVersion = process.env.SHOPIFY_API_VERSION || '2024-10';
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!store || !token || !shopifyOrderId || !keyId || !keySecret) return;

  // Step 1: Get Razorpay order_xxx from Shopify transaction receipt
  const url = `https://${store}/admin/api/${apiVersion}/orders/${shopifyOrderId}/transactions.json`;
  const resp = await axios.get(url, { headers: { 'X-Shopify-Access-Token': token } });
  const transactions = resp.data?.transactions || [];
  let rzpOrderId = null;

  for (const txn of transactions) {
    if (txn.kind === 'sale' || txn.kind === 'capture' || txn.kind === 'authorization') {
      const receipt = typeof txn.receipt === 'string' ? JSON.parse(txn.receipt) : txn.receipt;
      const pid = receipt?.payment_id || receipt?.id || '';
      const candidate = typeof pid === 'string' ? pid : String(pid || '');
      if (candidate.startsWith('pay_')) {
        await db('UPDATE orders_master SET razorpay_payment_id = $1 WHERE id = $2 AND razorpay_payment_id IS NULL', [candidate, dbOrderId]);
        console.log(`[Razorpay link] Direct pay_ found: ${candidate} for DB order ${dbOrderId}`);
        return;
      }
      if (candidate.startsWith('order_')) { rzpOrderId = candidate; break; }
    }
  }

  if (!rzpOrderId) {
    console.log(`[Razorpay link] No Razorpay order/pay ID in ${transactions.length} txns for Shopify #${shopifyOrderId}`);
    return;
  }

  // Step 2: Fetch payments for this Razorpay order
  const auth = { username: keyId, password: keySecret };
  const payResp = await axios.get(`https://api.razorpay.com/v1/orders/${rzpOrderId}/payments`, { auth, timeout: 10000 });
  const payments = payResp.data?.items || [];
  const captured = payments.find(p => p.status === 'captured') || payments[0];
  if (!captured?.id) {
    console.log(`[Razorpay link] No payments found for Razorpay order ${rzpOrderId}`);
    return;
  }

  await db('UPDATE orders_master SET razorpay_payment_id = $1 WHERE id = $2 AND razorpay_payment_id IS NULL', [captured.id, dbOrderId]);
  console.log(`[Razorpay link] Linked ${captured.id} (via ${rzpOrderId}) to DB order ${dbOrderId}`);
}

// ============================================================
// MIDDLEWARE
// ============================================================
app.use('/webhook/shopify', express.raw({ type: 'application/json' }));
app.use(express.json({
  // Keep the exact bytes for Razorpay signature verification
  verify: (req, res, buf) => { if (req.originalUrl.startsWith('/webhook/razorpay')) req.rawBody = buf; }
}));

// Call-centre login, cc-crm APIs, reports and admin (see cc_routes.js).
// Registered before the older /api routes so the login check runs first.
require('./cc_routes')(app, { db, dbOne, pool, CONFIG, writeDispositionToSheet, writeDispositionToNewSheet, cancelShopifyOrder, updateShopifyShippingAddress, syncConfirmedTag });

// Admin money & risk desk (refunds, courier COD/weight, blacklist, pincodes); /api/admin is admin-only via cc_routes.
require('./admin_desk')(app, { db, dbOne });

// Callyzer call tracking (BPO phone call data); /api/admin/callyzer/* is admin-only via cc_routes.
require('./callyzer_routes')(app, { db, dbOne });

// Ship gate phase 1 (read-only lists, alerts, holiday list); /api/admin/ship-gate/* is admin-only via cc_routes.
require('./ship_gate_routes')(app, { db, dbOne });

// Static files come after cc_routes so its page guard protects the CRM pages.
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// UTILITY FUNCTIONS
// ============================================================

function normalizePhone(phone) {
  if (!phone) return '';
  let p = phone.replace(/[\s\-\(\)]/g, '');
  if (p.startsWith('+91')) p = p.slice(3);
  if (p.startsWith('91') && p.length === 12) p = p.slice(2);
  if (p.startsWith('0')) p = p.slice(1);
  return p;
}

// Connectivity-aware routing: caches today's connectivity stats per team
const connectivityCache = { cc: null, inhouse: null, updatedAt: 0 };
const CONNECTIVITY_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const TARGET_CONNECTIVITY = 95;

async function refreshConnectivityCache() {
  try {
    const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const start = new Date(`${todayIST}T00:00:00+05:30`);
    const end = new Date(start.getTime() + 24 * 3600 * 1000);
    const cfg = require('./lib/config');
    const connDisps = cfg.CONNECTED_DISPOSITIONS;
    const allDisps = cfg.CALL_DISPOSITIONS;

    const rows = await db(
      `SELECT
         CASE WHEN o.assigned_to = 'InHouse' THEN 'inhouse' ELSE 'cc' END AS team,
         COUNT(*)::int AS total_attempts,
         COUNT(*) FILTER (WHERE g.disposition = ANY($3))::int AS connected
       FROM lead_call_log g
       JOIN orders_master o ON o.id = g.order_id
       WHERE g.created_at >= $1 AND g.created_at < $2 AND g.disposition = ANY($4)
       GROUP BY 1`,
      [start, end, connDisps, allDisps]
    );

    connectivityCache.cc = { total: 0, connected: 0, pct: 100 };
    connectivityCache.inhouse = { total: 0, connected: 0, pct: 100 };
    for (const r of rows) {
      const entry = { total: r.total_attempts, connected: r.connected, pct: r.total_attempts > 0 ? Math.round((r.connected / r.total_attempts) * 1000) / 10 : 100 };
      if (r.team === 'cc') connectivityCache.cc = entry;
      else connectivityCache.inhouse = entry;
    }

    // Also get pending lead counts per team
    const pending = await db(
      `SELECT assigned_to, COUNT(*)::int AS n
       FROM orders_master
       WHERE confirmation_status = 'pending' AND order_status = 'new' AND dnc = FALSE
       GROUP BY assigned_to`
    );
    connectivityCache.cc.pending = 0;
    connectivityCache.inhouse.pending = 0;
    for (const p of pending) {
      if (p.assigned_to === 'CC') connectivityCache.cc.pending = p.n;
      else if (p.assigned_to === 'InHouse') connectivityCache.inhouse.pending = p.n;
    }

    connectivityCache.updatedAt = Date.now();
    console.log(`[Route] Connectivity cache refreshed: CC=${connectivityCache.cc.pct}% (${connectivityCache.cc.total} calls, ${connectivityCache.cc.pending} pending), InHouse=${connectivityCache.inhouse.pct}% (${connectivityCache.inhouse.total} calls, ${connectivityCache.inhouse.pending} pending)`);
  } catch (err) {
    console.error('[Route] Failed to refresh connectivity cache:', err.message);
  }
}

// Routing of a new order. AUTOPILOT=off keeps the old rules. Otherwise: the call centre is the main team, Aman gets AMAN_NEW_COD_SHARE percent
// (step it down over time), and with AUTOPILOT=on a team that is not logged in is covered by the other (lib/autopilot.js).
function legacyRouteOrder(shopifyOrderId) {
  const last4 = shopifyOrderId % 10000;
  const pct = (last4 % 100) + 1;
  const now = new Date();
  const istDay = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })).getDay();

  // Saturday = all InHouse, Sunday = all CC
  if (istDay === 6) return { assigned_to: 'InHouse', route_percent: pct };
  if (istDay === 0) return { assigned_to: 'CC', route_percent: pct };

  // Smart routing based on connectivity
  const fresh = (Date.now() - connectivityCache.updatedAt) < CONNECTIVITY_CACHE_TTL;
  if (fresh && connectivityCache.cc && connectivityCache.inhouse) {
    const ccConn = connectivityCache.cc.pct;
    const ihConn = connectivityCache.inhouse.pct;
    const ccPending = connectivityCache.cc.pending || 0;
    const ihPending = connectivityCache.inhouse.pending || 0;
    if (ccConn < TARGET_CONNECTIVITY && ccPending > ihPending) {
      return { assigned_to: 'InHouse', route_percent: pct, reason: `CC connectivity ${ccConn}% < ${TARGET_CONNECTIVITY}%, shifting load to InHouse` };
    }
    if (ihConn < TARGET_CONNECTIVITY && ihPending > ccPending) {
      return { assigned_to: 'CC', route_percent: pct, reason: `InHouse connectivity ${ihConn}% < ${TARGET_CONNECTIVITY}%, shifting load to CC` };
    }
    if (ccConn < TARGET_CONNECTIVITY && ihConn < TARGET_CONNECTIVITY) {
      const target = ccPending <= ihPending ? 'CC' : 'InHouse';
      return { assigned_to: target, route_percent: pct, reason: `Both below target, routing to ${target} (fewer pending)` };
    }
  }
  return { assigned_to: pct <= 10 ? 'InHouse' : 'CC', route_percent: pct };
}

let presenceCache = { at: 0, value: null };
async function routeOrder(shopifyOrderId) {
  const apLib = require('./lib/autopilot');
  const s = apLib.settings();
  if (s.mode === 'off') return legacyRouteOrder(shopifyOrderId);
  const pct = ((shopifyOrderId % 10000) % 100) + 1;
  if (s.mode === 'on') {
    try {
      if (Date.now() - presenceCache.at > 60000) {
        const apDb = require('./lib/autopilotDb');
        await apDb.ensureTables(db);
        presenceCache = { at: Date.now(), value: (await apDb.presenceNow(db, new Date(), s)).presence };
      }
      return { ...apLib.ownerFor(presenceCache.value, new Date(), s, pct), route_percent: pct };
    } catch (err) { console.error('[Route] presence check failed, using the default split:', err.message); }
  }
  return { assigned_to: pct <= s.amanNewShare ? 'InHouse' : 'CC', route_percent: pct };
}

// Refresh connectivity cache on startup and every 5 minutes
setTimeout(refreshConnectivityCache, 5000);
setInterval(refreshConnectivityCache, CONNECTIVITY_CACHE_TTL);

// One rule (lib/address.js): under the minimum length / words is short. Set SHORT_ADDRESS_REQUIRE_PREMISE=1 to also require a house / flat / near word.
function isShortAddress(addr) {
  return require('./lib/address').isShortAddress(addr, {
    minChars: CONFIG.SHORT_ADDRESS_MIN_CHARS, minWords: CONFIG.SHORT_ADDRESS_MIN_WORDS, requirePremise: process.env.SHORT_ADDRESS_REQUIRE_PREMISE === '1',
  });
}

function getDispatchSlot() {
  const now = new Date();
  const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const h = ist.getHours();
  const m = ist.getMinutes();
  if (h < CONFIG.DISPATCH_CUTOFF_HOUR || (h === CONFIG.DISPATCH_CUTOFF_HOUR && m <= CONFIG.DISPATCH_CUTOFF_MIN)) {
    return { date: ist.toISOString().split('T')[0], slot: 'same_day' };
  }
  const next = new Date(ist);
  next.setDate(next.getDate() + 1);
  return { date: next.toISOString().split('T')[0], slot: 'next_day' };
}

function verifyShopifyWebhook(req) {
  const hmac = req.headers['x-shopify-hmac-sha256'];
  if (!hmac) return false;
  const hash = crypto.createHmac('sha256', CONFIG.SHOPIFY_WEBHOOK_SECRET)
    .update(req.body)
    .digest('base64');
  return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(hash));
}

// ============================================================
// GOOGLE SHEETS — WRITE BACK TO COD_CONFIRMATIONS
// ============================================================
let sheetsClient = null;
async function getSheetsClient() {
  if (sheetsClient) return sheetsClient;
  let credentials;
  if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON) {
    credentials = JSON.parse(Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON, 'base64').toString('utf-8'));
  } else if (process.env.GOOGLE_SERVICE_ACCOUNT_FILE) {
    credentials = require(process.env.GOOGLE_SERVICE_ACCOUNT_FILE);
  }
  if (!credentials) return null;
  const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

// ---- NEW SHEET: append order row when created via webhook ----
async function appendOrderToNewSheet(orderData) {
  try {
    const sheets = await getSheetsClient();
    if (!sheets) return;
    const newSheetId = process.env.GOOGLE_SHEET_ID_NEW;
    if (!newSheetId) return;
    const tabName = process.env.GOOGLE_SHEET_TAB_NEW || 'COD_Confirmations';

    // Check if header exists, if not add it
    const headerCheck = await sheets.spreadsheets.values.get({
      spreadsheetId: newSheetId,
      range: `${tabName}!A1:AG1`,
    });
    if (!headerCheck.data.values || !headerCheck.data.values[0] || !headerCheck.data.values[0][0]) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: newSheetId,
        range: `${tabName}!A1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [['Order Number', 'Customer Name', 'Phone', 'SKU name', 'Address',
            'Order Amount', 'Payment Type', 'WhatsApp Message Sent', 'Message Sent At',
            'Option Clicked', 'Clicked At', 'Main Disposition', 'test col2',
            'calling date & time', '1st Disposition', 'calling date & time',
            '2nd Disposition', 'calling date & time', '3rd Disposition', 'calling date & time',
            '4th Disposition', 'Reminder Sent', 'OFD Sent', 'Alternate Number',
            'IVR Call 1 Time', 'IVR Call 1 Result', 'IVR Call 2 Time', 'IVR Call 2 Result',
            'IVR Call 3 Time', 'IVR Call 3 Result', 'IVR Agent Flag', 'Reminder Sent 2', 'Called By']]
        }
      });
    }

    const now = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    const skuName = (orderData.lineItems || []).map(li => li.title).join(', ');

    await sheets.spreadsheets.values.append({
      spreadsheetId: newSheetId,
      range: `${tabName}!A:A`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          orderData.orderNumber,
          orderData.customerName,
          orderData.phone,
          skuName,
          orderData.address,
          orderData.totalPrice,
          orderData.paymentMethod === 'PREPAID' ? 'Prepaid' : 'COD',
          '', // WhatsApp Message Sent
          now, // Message Sent At (using order ingestion time)
        ]]
      }
    });
    console.log(`[New Sheet] Order ${orderData.orderNumber} appended`);
  } catch (err) {
    console.error(`[New Sheet] Error appending order ${orderData.orderNumber}:`, err.message);
  }
}

// ---- Write disposition to BOTH sheets ----
async function writeDispositionToNewSheet(orderNumber, disposition, agent, attemptNumber) {
  try {
    const sheets = await getSheetsClient();
    if (!sheets) return;
    const newSheetId = process.env.GOOGLE_SHEET_ID_NEW;
    if (!newSheetId) return;
    const tabName = process.env.GOOGLE_SHEET_TAB_NEW || 'COD_Confirmations';

    const searchRes = await sheets.spreadsheets.values.get({
      spreadsheetId: newSheetId,
      range: `${tabName}!A:A`,
    });
    const allValues = searchRes.data.values || [];
    let rowIndex = -1;
    for (let i = allValues.length - 1; i >= 1; i--) {
      if ((allValues[i][0] || '').trim() === String(orderNumber)) {
        rowIndex = i + 1;
        break;
      }
    }
    if (rowIndex === -1) {
      console.log(`[New Sheet Write] Order ${orderNumber} not found`);
      return;
    }

    const now = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    const attempt = Math.min(attemptNumber, 4);
    const cols = CALL_COLUMNS[attempt - 1];

    const updates = [
      { range: `${tabName}!${cols.timeCol}${rowIndex}`, values: [[now]] },
      { range: `${tabName}!${cols.dispCol}${rowIndex}`, values: [[disposition]] },
      { range: `${tabName}!AG${rowIndex}`, values: [[agent]] }
    ];

    // Always update Main Disposition (column L) with the latest disposition
    updates.push({ range: `${tabName}!L${rowIndex}`, values: [[disposition]] });

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: newSheetId,
      requestBody: { valueInputOption: 'USER_ENTERED', data: updates }
    });
    console.log(`[New Sheet Write] Order ${orderNumber} → row ${rowIndex}, attempt ${attempt}: ${disposition}`);
  } catch (err) {
    console.error(`[New Sheet Write] Error for order ${orderNumber}:`, err.message);
  }
}

// Column map for call attempts:
// Attempt 1: N(13)=datetime, O(14)=disposition
// Attempt 2: P(15)=datetime, Q(16)=disposition
// Attempt 3: R(17)=datetime, S(18)=disposition
// Attempt 4: T(19)=datetime, U(20)=disposition
// AG(32) = Called By (agent name)
const CALL_COLUMNS = [
  { timeCol: 'N', dispCol: 'O' },  // attempt 1
  { timeCol: 'P', dispCol: 'Q' },  // attempt 2
  { timeCol: 'R', dispCol: 'S' },  // attempt 3
  { timeCol: 'T', dispCol: 'U' },  // attempt 4
];

async function writeDispositionToSheet(orderNumber, disposition, agent, attemptNumber) {
  try {
    const sheets = await getSheetsClient();
    if (!sheets) return;
    const sheetId = process.env.GOOGLE_SHEET_ID;
    const tabName = process.env.GOOGLE_SHEET_TAB || 'COD_Confirmations';

    // Find the row by order number in column A
    const searchRes = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${tabName}!A:A`,
    });
    const allValues = searchRes.data.values || [];
    let rowIndex = -1;
    for (let i = allValues.length - 1; i >= 1; i--) {
      if ((allValues[i][0] || '').trim() === String(orderNumber)) {
        rowIndex = i + 1;
        break;
      }
    }
    if (rowIndex === -1) {
      console.log(`[Sheet Write] Order ${orderNumber} not found in sheet`);
      return;
    }

    const now = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    const attempt = Math.min(attemptNumber, 4);
    const cols = CALL_COLUMNS[attempt - 1];

    // Write calling time + disposition for this attempt
    const updates = [
      {
        range: `${tabName}!${cols.timeCol}${rowIndex}`,
        values: [[now]]
      },
      {
        range: `${tabName}!${cols.dispCol}${rowIndex}`,
        values: [[disposition]]
      },
      {
        range: `${tabName}!AG${rowIndex}`,
        values: [[agent]]
      }
    ];

    // Always update Main Disposition (column L) with the latest disposition
    updates.push({ range: `${tabName}!L${rowIndex}`, values: [[disposition]] });

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: updates
      }
    });

    console.log(`[Sheet Write] Order ${orderNumber} → row ${rowIndex}, attempt ${attempt}: ${disposition} by ${agent}`);
  } catch (err) {
    console.error(`[Sheet Write] Error for order ${orderNumber}:`, err.message);
  }
}

// ============================================================
// SHOPIFY WEBHOOK — ORDER CREATED
// ============================================================
app.post('/webhook/shopify/order-created', async (req, res) => {
  try {
    if (!verifyShopifyWebhook(req)) {
      console.log('Invalid Shopify webhook signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const order = JSON.parse(req.body.toString());
    res.status(200).json({ received: true });

    const phone = normalizePhone(
      order.shipping_address?.phone || order.customer?.phone || order.phone || ''
    );
    if (!phone) {
      console.log(`Order ${order.id}: No phone number, skipping`);
      return;
    }

    const custName = (order.customer?.first_name || '') + ' ' + (order.customer?.last_name || '');
    if (/^test\b/i.test(custName.trim()) || /\bdummy\b/i.test(custName) || order.test) {
      console.log(`Order ${order.id}: Test order (${custName.trim()}), skipping`);
      return;
    }

    const existing = await dbOne('SELECT id FROM orders_master WHERE shopify_order_id = $1', [order.id]);
    if (existing) {
      console.log(`Order ${order.id}: Already exists, skipping`);
      return;
    }

    const fullAddress = [
      order.shipping_address?.address1,
      order.shipping_address?.address2,
      order.shipping_address?.city,
      order.shipping_address?.province
    ].filter(Boolean).join(' ');

    const addressShort = isShortAddress(fullAddress);
    const routing = await routeOrder(order.id);
    const dispatch = getDispatchSlot();

    const lineItems = (order.line_items || []).map(li => ({
      title: li.title,
      sku: li.sku,
      quantity: li.quantity,
      price: li.price,
      variant_id: li.variant_id
    }));

    const ALLOWED_PREFIXES = require('./lib/products').ALLOWED_PREFIXES;
    const hasAllowedProduct = lineItems.some(li =>
      ALLOWED_PREFIXES.some(prefix => (li.title || '').startsWith(prefix))
    );
    if (!hasAllowedProduct) {
      console.log(`Order ${order.name}: No matching product, skipping`);
      return;
    }
    if (Number(order.total_price) < require('./lib/products').MIN_PRICE) {
      console.log(`Order ${order.name}: Price ₹${order.total_price} below minimum, skipping`);
      return;
    }

    const gateway = ((order.gateway || '') + ' ' + (order.payment_gateway_names || []).join(' ')).toLowerCase();
    const hasCODShipping = (order.shipping_lines || []).some(s => (s.title || '').toLowerCase().includes('cod'));
    const isCOD = gateway.includes('cod') || gateway.includes('cash') || gateway === 'manual' || hasCODShipping ||
      (order.financial_status === 'pending' && !gateway.trim());
    const paymentMethod = isCOD ? 'COD' : 'PREPAID';

    const riskResult = await dbOne(
      'SELECT * FROM evaluate_risk($1, $2, $3, $4)',
      [phone, order.shipping_address?.zip, fullAddress, Number(order.total_price)]
    );

    const dupResult = await dbOne(
      'SELECT * FROM check_duplicate_order($1, $2)',
      [phone, JSON.stringify(lineItems)]
    );

    // Repeat customers (same phone, earlier non-cancelled order) are handled by Aman only
    const priorOrder = await dbOne(
      `SELECT 1 AS found FROM orders_master WHERE customer_phone = $1 AND COALESCE(order_status, 'new') <> 'cancelled' LIMIT 1`,
      [phone]
    );
    const forceInHouse = (riskResult?.score || 0) >= 40 || !!priorOrder || !!dupResult?.is_duplicate;

    const inserted = await dbOne(`
      INSERT INTO orders_master (
        shopify_order_id, shopify_order_number, order_name,
        customer_name, customer_email, customer_phone,
        shipping_address1, shipping_address2, shipping_city, shipping_province, shipping_zip, shipping_country,
        address_is_short,
        line_items, subtotal, cod_surcharge, total_price, payment_method,
        route_percent, assigned_to,
        risk_score, risk_flags, is_blacklisted,
        is_duplicate, duplicate_of_order,
        order_status, confirmation_status,
        dispatch_batch_date, dispatch_batch_slot,
        utm_source, utm_medium, utm_campaign, landing_page, referring_site,
        shopify_created_at
      ) VALUES (
        $1, $2, $3,
        $4, $5, $6,
        $7, $8, $9, $10, $11, $12,
        $13,
        $14, $15, $16, $17, $18,
        $19, $20,
        $21, $22, $23,
        $24, $25,
        'new', $26,
        $27, $28,
        $29, $30, $31, $32, $33,
        $34
      ) RETURNING id
    `, [
      order.id, order.order_number, order.name,
      `${order.shipping_address?.first_name || ''} ${order.shipping_address?.last_name || ''}`.trim(),
      order.email || order.customer?.email,
      phone,
      order.shipping_address?.address1, order.shipping_address?.address2,
      order.shipping_address?.city, order.shipping_address?.province,
      order.shipping_address?.zip, order.shipping_address?.country_code || 'IN',
      addressShort,
      JSON.stringify(lineItems), Number(order.subtotal_price),
      paymentMethod === 'COD' ? CONFIG.COD_SURCHARGE : 0,
      Number(order.total_price),
      paymentMethod,
      routing.route_percent,
      forceInHouse ? 'InHouse' : routing.assigned_to,
      riskResult?.score || 0, JSON.stringify(riskResult?.flags || []),
      (riskResult?.score || 0) >= 50,
      dupResult?.is_duplicate || false, dupResult?.duplicate_order_id,
      paymentMethod === 'PREPAID' ? 'confirmed' : 'pending',
      dispatch.date, dispatch.slot,
      order.note_attributes?.find(a => a.name === 'utm_source')?.value,
      order.note_attributes?.find(a => a.name === 'utm_medium')?.value,
      order.note_attributes?.find(a => a.name === 'utm_campaign')?.value,
      order.landing_site, order.referring_site,
      order.created_at
    ]);

    await db(
      `SELECT log_status_change($1, 'order_created', NULL, 'new', 'shopify', $2)`,
      [inserted.id, `Shopify order ${order.name} ingested. Route: ${forceInHouse ? 'InHouse(forced)' : routing.assigned_to}`]
    );

    console.log(`Order ${order.name} ingested → ${forceInHouse ? 'InHouse(forced)' : routing.assigned_to}, risk=${riskResult?.score || 0}`);

    // Append order to new Google Sheet (non-blocking)
    appendOrderToNewSheet({
      orderNumber: order.order_number,
      customerName: `${order.shipping_address?.first_name || ''} ${order.shipping_address?.last_name || ''}`.trim(),
      phone: phone,
      lineItems: lineItems,
      address: [order.shipping_address?.address1, order.shipping_address?.address2, order.shipping_address?.city, order.shipping_address?.province, order.shipping_address?.zip].filter(Boolean).join(', '),
      totalPrice: Number(order.total_price),
      paymentMethod: paymentMethod
    }).catch(e => console.error(`[New Sheet] background error: ${e.message}`));

    // For prepaid orders, fetch the Razorpay payment ID from Shopify transactions (non-blocking)
    if (paymentMethod === 'PREPAID') {
      linkRazorpayPaymentId(order.id, inserted.id).catch(e =>
        console.error(`[Razorpay link] ${order.name}: ${e.message}`)
      );
    }

  } catch (err) {
    console.error('Shopify webhook error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ============================================================
// COURIER WEBHOOK — Status updates from Shiprocket
// Shiprocket payload: { awb, current_status, current_status_id,
//   courier_name, etd, scans[].reason, order_id, ... }
// ============================================================
app.post('/webhook/courier/status', async (req, res) => {
  try {
    const token = req.headers['x-api-key'];
    if (process.env.SHIPROCKET_WEBHOOK_TOKEN && token !== process.env.SHIPROCKET_WEBHOOK_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const cw = require('./lib/courierWebhook');
    const p = cw.parsePayload(req.body);
    console.log(`[Courier Webhook] Raw payload:`, JSON.stringify(req.body).substring(0, 500));
    console.log(`[Courier Webhook] AWB=${p.awb} status=${p.status} text="${p.statusText}" courier=${p.courier} refs=${p.refs.join(',')} sr=${p.srOrderId}`);
    res.status(200).json({ received: true });

    if (!p.awb) return;

    // Find the order: by AWB, then by the courier's own order ids, then by our order number (the courier sends it as order_id / channel_order_id).
    const COLS = 'id, order_status, ndr_count, awb_number';
    let order = await dbOne(`SELECT ${COLS} FROM orders_master WHERE awb_number = $1`, [p.awb]);
    if (!order && p.srOrderId) order = await dbOne(`SELECT ${COLS} FROM orders_master WHERE shiprocket_order_id = $1`, [p.srOrderId]);
    if (!order && p.nimbusOrderId) order = await dbOne(`SELECT ${COLS} FROM orders_master WHERE nimbus_order_id = $1`, [p.nimbusOrderId]);
    if (!order && p.refs.length) {
      order = await dbOne(`SELECT ${COLS} FROM orders_master WHERE order_name = ANY($1) OR shopify_order_number = ANY($2) ORDER BY created_at DESC LIMIT 1`, [cw.nameVariants(p.refs), p.refs]);
    }
    if (!order) {
      console.log(`[Courier Webhook] No order found for AWB ${p.awb} (refs ${p.refs.join(',') || 'none'}, sr ${p.srOrderId || 'none'})`);
      return;
    }
    if (order.awb_number !== p.awb) {
      await db(`UPDATE orders_master SET awb_number = $1, courier_name = COALESCE(NULLIF($2, ''), courier_name), shiprocket_order_id = COALESCE(shiprocket_order_id, NULLIF($4, '')) WHERE id = $3`, [p.awb, p.courier, order.id, p.srOrderId]);
      console.log(`[Courier Webhook] Linked AWB ${p.awb} to order id=${order.id}`);
    }

    const status = p.status;
    if (!status) return;

    // The same courier event arriving twice is recorded once, so attempt counts stay true.
    const key = cw.eventKey(status, p.statusText, p.eventAt);
    const seen = await dbOne(`SELECT 1 AS x FROM order_status_events WHERE order_id = $1 AND event_type = 'courier_status' AND metadata->>'key' = $2 LIMIT 1`, [order.id, key]);
    if (seen) return;
    await db(`INSERT INTO order_status_events (order_id, event_type, old_value, new_value, actor, notes, metadata) VALUES ($1, 'courier_status', $2, $3, 'courier', $4, $5)`,
      [order.id, order.order_status, status, p.reason || p.statusText, JSON.stringify({ key, awb: p.awb, courier: p.courier, text: p.statusText, status_id: p.statusId, shipment_status_id: p.shipmentStatusId, event_at: p.eventAt ? p.eventAt.toISOString() : null })]);

    if (!cw.shouldApply(order.order_status, status)) return;
    const at = p.eventAt || new Date();

    if (status === 'shipped') {
      await db(`UPDATE orders_master SET order_status = 'shipped', shipped_at = COALESCE(shipped_at, $2), courier_name = COALESCE(NULLIF($3, ''), courier_name) WHERE id = $1`, [order.id, at, p.courier]);
    } else if (status === 'delivered') {
      await db(`UPDATE orders_master SET order_status = 'delivered', delivered_at = $2, shipped_at = COALESCE(shipped_at, $2), ndr_status = CASE WHEN ndr_status = 'active' THEN 'resolved' ELSE ndr_status END WHERE id = $1`, [order.id, at]);
    } else if (status === 'ndr') {
      await db(`UPDATE orders_master SET order_status = 'ndr', ndr_status = 'active', ndr_count = COALESCE(ndr_count, 0) + 1, ndr_last_reason = $2, ndr_last_at = $3, shipped_at = COALESCE(shipped_at, $3) WHERE id = $1`, [order.id, p.reason || p.statusText, at]);
    } else if (status.startsWith('rto')) {
      await db(`UPDATE orders_master SET order_status = 'rto', rto_status = CASE WHEN rto_status = 'rto_delivered' THEN rto_status ELSE $2 END,
                  rto_initiated_at = CASE WHEN $2 = 'rto_initiated' THEN COALESCE(rto_initiated_at, $3::timestamptz) ELSE rto_initiated_at END,
                  rto_delivered_at = CASE WHEN $2 = 'rto_delivered' THEN $3::timestamptz ELSE rto_delivered_at END
                WHERE id = $1`, [order.id, status, at]);
    } else if (status === 'lost') {
      await db(`UPDATE orders_master SET order_status = 'lost' WHERE id = $1`, [order.id]);
    }
    // out_for_delivery, damaged and courier_cancelled are only recorded in the history above.

    console.log(`[Courier Webhook] Order ${order.id} ${order.order_status} -> ${status}`);
  } catch (err) {
    console.error('Courier webhook error:', err);
  }
});

// ============================================================
// RAZORPAY WEBHOOK — moved to cc_routes.js (signed, idempotent, credits agent incentive)
// ============================================================

// ============================================================
// CRM API — DASHBOARD DATA ENDPOINTS
// ============================================================

// Routing status (admin visibility into smart routing)
app.get('/api/routing-status', async (req, res) => {
  try {
    if (Date.now() - connectivityCache.updatedAt > CONNECTIVITY_CACHE_TTL) await refreshConnectivityCache();
    res.json({
      cc: connectivityCache.cc,
      inhouse: connectivityCache.inhouse,
      target_connectivity: TARGET_CONNECTIVITY,
      cache_age_seconds: Math.round((Date.now() - connectivityCache.updatedAt) / 1000)
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// KPI Ribbon
app.get('/api/kpi', async (req, res) => {
  try {
    const data = await dbOne('SELECT * FROM v_kpi_ribbon');
    res.json(data || {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Aman Fresh Leads
app.get('/api/aman/fresh-leads', async (req, res) => {
  try {
    const rows = await db(
      `SELECT v.*, o.shipping_address1, o.shipping_address2, o.address_fixed, o.shopify_created_at, o.callback_at, o.callback_note, 'InHouse' AS assigned_to,
              (SELECT e.notes FROM order_status_events e WHERE e.order_id = o.id AND e.event_type = 'autopilot_move' AND e.new_value = 'InHouse' AND e.created_at > NOW() - INTERVAL '3 days' ORDER BY e.created_at DESC LIMIT 1) AS handover_reason
       FROM v_aman_fresh_leads v JOIN orders_master o ON o.id = v.id
       WHERE COALESCE(o.dnc, FALSE) = FALSE
         AND COALESCE(o.shopify_created_at, o.created_at) >= $1::timestamptz
         AND NOT (COALESCE(o.lead_locked_by, '') IN ('IVR', 'WHATSAPP') AND COALESCE(o.lead_locked_at > NOW() - INTERVAL '15 minutes', FALSE))`, [require('./lib/config').CALLING_STARTED_ON + 'T00:00:00+05:30']);   // one owner per lead: what the IVR holds is not shown to Aman
    // Smart queue: best lead to call next first, with the reason (lib/queue.js).
    const { dnpStatus } = require('./lib/dnp'), { callbackBadge } = require('./lib/callback'), queueLib = require('./lib/queue');
    const tries = rows.length ? await db(`SELECT order_id, created_at FROM lead_call_log WHERE order_id = ANY($1) AND disposition = 'dnp'`, [rows.map(r => r.id)]) : [];
    const byOrder = new Map(); tries.forEach(t => { if (!byOrder.has(t.order_id)) byOrder.set(t.order_id, []); byOrder.get(t.order_id).push(t.created_at); });
    const now = new Date();
    res.json(queueLib.sortQueue(rows.map(l => { const d = dnpStatus(byOrder.get(l.id) || [], now); return { ...l, callback_badge: callbackBadge(l, now), dnp: d, priority: queueLib.prioritise(l, d, now) }; })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// CC Fresh Leads
app.get('/api/cc/fresh-leads', async (req, res) => {
  try {
    const rows = await db(`SELECT v.* FROM v_cc_fresh_leads v JOIN orders_master o ON o.id = v.id WHERE COALESCE(o.shopify_created_at, o.created_at) >= $1::timestamptz
      AND NOT (COALESCE(o.lead_locked_by, '') IN ('IVR', 'WHATSAPP') AND COALESCE(o.lead_locked_at > NOW() - INTERVAL '15 minutes', FALSE))`, [require('./lib/config').CALLING_STARTED_ON + 'T00:00:00+05:30']);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Aman Repeat Queue
app.get('/api/aman/repeat-queue', async (req, res) => {
  try {
    const rows = await db(
      `SELECT v.*, o.shipping_address1, o.shipping_address2, o.shipping_province, o.shipping_zip, o.address_is_short, o.address_fixed, o.shopify_created_at, o.line_items,
              'InHouse' AS assigned_to
       FROM v_aman_repeat_queue v JOIN orders_master o ON o.id = v.id
       ORDER BY v.repeat_order_number DESC, v.created_at ASC`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Aman NDR Recovery
app.get('/api/aman/ndr-recovery', async (req, res) => {
  try {
    const rows = await db('SELECT * FROM v_aman_ndr_recovery');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Shiprocket Pre-Delivery & Post-Delivery ----
const shiprocket = require('./lib/shiprocket');
// Pre-warm the Shiprocket cache on startup (takes ~60s to scan all orders)
if (process.env.SHIPROCKET_EMAIL) {
  setTimeout(() => shiprocket.refreshOrderCache().catch(e => console.error('[Shiprocket] Startup cache error:', e.message)), 5000);
}

// Enrich Shiprocket orders with DB phone numbers (Shiprocket masks them)
async function enrichWithDbPhones(srOrders) {
  if (!srOrders.length) return srOrders;
  const orderIds = srOrders.map(o => o.channel_order_id).filter(Boolean);
  if (!orderIds.length) return srOrders;
  const names = orderIds.map(id => id.startsWith('#') ? id : '#' + id);
  const rows = await db(
    `SELECT order_name, customer_phone, customer_name, shipping_city, shipping_zip,
            total_price, line_items
     FROM orders_master WHERE order_name = ANY($1)`, [names]
  );
  const phoneMap = new Map();
  for (const r of rows) phoneMap.set(r.order_name, r);
  return srOrders.map(o => {
    const key = o.channel_order_id?.startsWith('#') ? o.channel_order_id : '#' + o.channel_order_id;
    const dbRow = phoneMap.get(key);
    if (dbRow) {
      o.customer_phone = dbRow.customer_phone || o.customer_phone;
      if (!o.customer_city) o.customer_city = dbRow.shipping_city || '';
      if (!o.total) o.total = dbRow.total_price || '';
      if (!o.product_name || o.product_name === '—') {
        try {
          const items = typeof dbRow.line_items === 'string' ? JSON.parse(dbRow.line_items) : (dbRow.line_items || []);
          if (items.length) o.product_name = items[0].title || '';
        } catch {}
      }
    }
    return o;
  });
}

// Pre-Delivery: OFD + high-risk orders from Shiprocket (paginated cache)
app.get('/api/aman/pre-delivery', async (req, res) => {
  try {
    const data = await shiprocket.getPreDeliveryData();
    data.ofd = await enrichWithDbPhones(data.ofd);
    data.high_risk = await enrichWithDbPhones(data.high_risk);
    res.json(data);
  } catch (err) {
    console.error('[Pre-Delivery] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Post-Delivery: Undelivered/NDR orders from Shiprocket (paginated cache + NDR API)
app.get('/api/aman/post-delivery', async (req, res) => {
  try {
    const data = await shiprocket.getPostDeliveryData();
    data.undelivered = await enrichWithDbPhones(data.undelivered);
    res.json(data);
  } catch (err) {
    console.error('[Post-Delivery] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Address Fix Queue — filtered by assignment
app.get('/api/aman/address-fix', async (req, res) => {
  try {
    const rows = await db("SELECT * FROM v_address_fix_queue WHERE id IN (SELECT id FROM orders_master WHERE assigned_to = 'InHouse')");
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/cc/address-fix', async (req, res) => {
  try {
    const rows = await db("SELECT * FROM v_address_fix_queue WHERE id IN (SELECT id FROM orders_master WHERE assigned_to = 'CC')");
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Duplicate Review
app.get('/api/aman/duplicates', async (req, res) => {
  try {
    const rows = await db('SELECT * FROM v_duplicate_review');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// CC Queue — Aman can see pending CC orders for load balancing
app.get('/api/aman/cc-queue', async (req, res) => {
  try {
    const rows = await db(`
      SELECT id, shopify_order_id, order_name, customer_name, customer_phone,
        shipping_address1, shipping_city, shipping_zip,
        total_price, payment_method, line_items, risk_score, address_is_short,
        call_attempts, shopify_created_at, created_at,
        EXTRACT(EPOCH FROM (NOW() - created_at))/60 AS age_minutes
      FROM orders_master
      WHERE assigned_to = 'CC'
        AND confirmation_status = 'pending'
        AND order_status = 'new'
        AND is_duplicate = FALSE
      ORDER BY created_at ASC
      LIMIT 50
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Pull CC orders to InHouse (Aman)
app.post('/api/aman/pull-cc', async (req, res) => {
  try {
    const { count, order_id } = req.body || {};
    if (order_id) {
      const r = await db(
        "UPDATE orders_master SET assigned_to = 'InHouse' WHERE id = $1 AND assigned_to = 'CC' AND confirmation_status = 'pending' RETURNING id",
        [order_id]
      );
      return res.json({ pulled: r.length });
    }
    const n = Math.min(Math.max(parseInt(count) || 5, 1), 50);
    const r = await db(`
      UPDATE orders_master SET assigned_to = 'InHouse'
      WHERE id IN (
        SELECT id FROM orders_master
        WHERE assigned_to = 'CC'
          AND confirmation_status = 'pending'
          AND order_status = 'new'
          AND is_duplicate = FALSE
        ORDER BY created_at ASC
        LIMIT $1
      ) RETURNING id
    `, [n]);
    res.json({ pulled: r.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Daily Summary
app.get('/api/reports/daily-summary', async (req, res) => {
  try {
    const rows = await db('SELECT * FROM v_daily_order_summary');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Hourly Tracker
app.get('/api/reports/hourly-tracker', async (req, res) => {
  try {
    const rows = await db('SELECT * FROM v_hourly_calling_tracker');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Channel Attribution
app.get('/api/reports/channel-attribution', async (req, res) => {
  try {
    const rows = await db('SELECT * FROM v_channel_attribution');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Speed to Call
app.get('/api/reports/speed-to-call', async (req, res) => {
  try {
    const rows = await db('SELECT * FROM v_speed_to_call_matrix');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// NDR / RTO
app.get('/api/logistics/ndr-rto', async (req, res) => {
  try {
    const rows = await db('SELECT * FROM v_ndr_rto_tracking');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Logistics Summary
app.get('/api/logistics/summary', async (req, res) => {
  try {
    const rows = await db('SELECT * FROM v_logistics_summary');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stuck in Transit
app.get('/api/logistics/stuck', async (req, res) => {
  try {
    const rows = await db('SELECT * FROM v_logistics_stuck_transit');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Inventory
app.get('/api/inventory', async (req, res) => {
  try {
    const rows = await db('SELECT * FROM v_inventory_dashboard');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Refund Desk
app.get('/api/refunds', async (req, res) => {
  try {
    const rows = await db('SELECT * FROM v_refund_desk');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ad Exclusion Pincodes
app.get('/api/ad-exclusion-pincodes', async (req, res) => {
  try {
    const rows = await db('SELECT * FROM get_excluded_pincodes()');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// CRM API — ACTION ENDPOINTS
// ============================================================

// Lock a lead
app.post('/api/lead/lock', async (req, res) => {
  try {
    const { order_id, agent } = req.body;
    const result = await dbOne('SELECT acquire_lead_lock($1, $2, $3)', [order_id, agent, CONFIG.LEAD_LOCK_MINUTES]);
    let locked = result?.acquire_lead_lock || false;
    // The IVR and WhatsApp hold a lead only so that nobody calls it twice. A person who has the customer on the phone always wins: take the lead over.
    if (!locked) {
      let midCall = null;   // never take a lead over while the IVR call is still in progress
      try { midCall = await dbOne(`SELECT 1 AS x FROM ivr_calls WHERE order_id = $1 AND NOT is_test AND status = 'placed' AND result IS NULL AND placed_at > NOW() - INTERVAL '3 minutes' LIMIT 1`, [order_id]); } catch (e) { midCall = null; }
      const took = midCall ? null : await dbOne(`UPDATE orders_master SET lead_locked_by = $2, lead_locked_at = NOW() WHERE id = $1 AND lead_locked_by IN ('IVR', 'WHATSAPP') AND confirmation_status = 'pending' RETURNING id`, [order_id, agent]);
      locked = !!took;
    }
    res.json({ locked });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Release lead lock
app.post('/api/lead/unlock', async (req, res) => {
  try {
    const { order_id, agent } = req.body;
    await db('SELECT release_lead_lock($1, $2)', [order_id, agent]);
    res.json({ released: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Submit disposition (confirm/cancel/rnr/address_fix)
app.post('/api/lead/disposition', async (req, res) => {
  try {
    const { order_id, disposition, agent, notes, new_address } = req.body;

    const order = await dbOne('SELECT * FROM orders_master WHERE id = $1', [order_id]);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    if (order.address_locked) {
      return res.status(400).json({ error: 'Order address is locked (AWB generated)' });
    }

    switch (disposition) {
      case 'confirmed':
        await db(`
          UPDATE orders_master SET
            confirmation_status = 'confirmed', confirmed_at = NOW(),
            assigned_agent = $2, call_attempts = call_attempts + 1, last_call_at = NOW(),
            lead_locked_by = NULL, lead_locked_at = NULL
          WHERE id = $1
        `, [order_id, agent]);
        await db(`SELECT log_status_change($1, 'confirmed', 'pending', 'confirmed', $2, $3)`,
          [order_id, agent, notes]);
        await db('SELECT maybe_promote_to_repeat_queue($1)', [order.customer_phone]);
        syncConfirmedTag(order_id, order.shopify_order_id).catch(e =>
          console.error('[Shopify] syncConfirmedTag error:', e.message));
        break;

      case 'cancelled':
        await db(`
          UPDATE orders_master SET
            confirmation_status = 'cancelled', order_status = 'cancelled',
            cancelled_at = NOW(), cancellation_reason = $3,
            assigned_agent = $2, call_attempts = call_attempts + 1, last_call_at = NOW(),
            lead_locked_by = NULL, lead_locked_at = NULL
          WHERE id = $1
        `, [order_id, agent, notes || 'Customer cancelled']);
        await db(`SELECT log_status_change($1, 'cancelled', 'pending', 'cancelled', $2, $3)`,
          [order_id, agent, notes]);
        cancelShopifyOrder(order.shopify_order_id, notes || 'Customer cancelled', order_id);
        break;

      case 'rnr':
        await db(`
          UPDATE orders_master SET
            call_attempts = call_attempts + 1, last_call_at = NOW(),
            assigned_agent = $2,
            lead_locked_by = NULL, lead_locked_at = NULL
          WHERE id = $1
        `, [order_id, agent]);
        await db(`SELECT log_status_change($1, 'rnr', NULL, 'rnr', $2, $3)`,
          [order_id, agent, notes || `RNR attempt ${order.call_attempts + 1}`]);
        break;

      case 'address_fix':
        if (!new_address) return res.status(400).json({ error: 'new_address required' });
        const fixConfirms = order.confirmation_status === 'pending';      // owner 2026-11-24: fixing the address on a pending order IS a confirmation
        await db(`
          UPDATE orders_master SET
            shipping_address1 = $2, address_fixed = TRUE,
            address_is_short = FALSE,
            confirmed_at = CASE WHEN confirmation_status = 'pending' THEN NOW() ELSE confirmed_at END,
            confirmation_status = CASE WHEN confirmation_status = 'pending' THEN 'confirmed' ELSE confirmation_status END,
            assigned_agent = $3, call_attempts = call_attempts + 1, last_call_at = NOW(),
            lead_locked_by = NULL, lead_locked_at = NULL
          WHERE id = $1
        `, [order_id, new_address, agent]);
        await db(`SELECT log_status_change($1, 'address_fixed', $2, $3, $4, 'Address corrected by agent')`,
          [order_id, order.shipping_address1, new_address, agent]);
        if (fixConfirms) {
          await db(`SELECT log_status_change($1, 'confirmed', 'pending', 'confirmed', $2, $3)`, [order_id, agent, 'Address fixed and order confirmed']);
          syncConfirmedTag(order_id, order.shopify_order_id).catch(e => console.error('[Shopify] syncConfirmedTag error:', e.message));
        }
        updateShopifyShippingAddress(order.shopify_order_id, new_address, order_id);
        break;

      case 'duplicate_keep':
        await db(`UPDATE orders_master SET is_duplicate = FALSE, lead_locked_by = NULL, lead_locked_at = NULL WHERE id = $1`, [order_id]);
        await db(`SELECT log_status_change($1, 'duplicate_resolved', 'duplicate', 'kept', $2, $3)`,
          [order_id, agent, notes]);
        break;

      case 'duplicate_cancel':
        await db(`
          UPDATE orders_master SET
            order_status = 'cancelled', confirmation_status = 'cancelled',
            cancelled_at = NOW(), cancellation_reason = 'Duplicate order',
            lead_locked_by = NULL, lead_locked_at = NULL
          WHERE id = $1
        `, [order_id]);
        await db(`SELECT log_status_change($1, 'duplicate_cancelled', 'duplicate', 'cancelled', $2)`,
          [order_id, agent]);
        break;

      default:
        return res.status(400).json({ error: `Invalid disposition: ${disposition}` });
    }

    // Write back to COD_Confirmations sheet (non-blocking)
    const attemptNum = (order.call_attempts || 0) + 1;
    const sheetDisp = disposition === 'confirmed' ? 'done'
      : disposition === 'cancelled' ? 'rejected'
      : disposition === 'rnr' ? 'dnp'
      : disposition === 'address_fix' ? 'address_fixed'
      : disposition === 'duplicate_cancel' ? 'rejected'
      : disposition;
    writeDispositionToSheet(order.shopify_order_number, sheetDisp, agent, attemptNum)
      .catch(err => console.error('[Sheet Write] background error:', err.message));
    writeDispositionToNewSheet(order.shopify_order_number, sheetDisp, agent, attemptNum)
      .catch(err => console.error('[New Sheet Write] background error:', err.message));

    res.json({ success: true, disposition });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// NDR action
app.post('/api/ndr/action', async (req, res) => {
  try {
    const { order_id, action, agent, notes, new_address } = req.body;

    if (action === 'reattempt') {
      await db(`UPDATE orders_master SET ndr_status = 'reattempt_requested' WHERE id = $1`, [order_id]);
      await db(`SELECT log_status_change($1, 'ndr_reattempt', 'ndr', 'reattempt', $2, $3)`,
        [order_id, agent, notes]);
    } else if (action === 'rto') {
      await db(`UPDATE orders_master SET ndr_status = 'rto_initiated', rto_status = 'initiated', rto_initiated_at = NOW() WHERE id = $1`, [order_id]);
      await db(`SELECT log_status_change($1, 'ndr_rto', 'ndr', 'rto_initiated', $2, $3)`,
        [order_id, agent, notes]);
    } else if (action === 'address_update' && new_address) {
      await db(`UPDATE orders_master SET shipping_address1 = $2, ndr_status = 'address_updated' WHERE id = $1`, [order_id, new_address]);
      const ndrOrder = await dbOne('SELECT shopify_order_id FROM orders_master WHERE id = $1', [order_id]);
      if (ndrOrder) updateShopifyShippingAddress(ndrOrder.shopify_order_id, new_address, order_id);
      await db(`SELECT log_status_change($1, 'ndr_address_update', 'ndr', 'address_updated', $2, $3)`,
        [order_id, agent, notes]);
    }

    res.json({ success: true, action });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Refund request
app.post('/api/refund/request', async (req, res) => {
  try {
    const { order_id, amount, reason, method, bank_details, requested_by } = req.body;
    await db(`
      INSERT INTO manual_refunds_queue (order_id, refund_amount, refund_reason, refund_method, bank_details, requested_by)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [order_id, amount, reason, method, JSON.stringify(bank_details || {}), requested_by]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Order search
app.get('/api/order/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.json([]);
    const rows = await db(`
      SELECT id, shopify_order_id, order_name, customer_name, customer_phone,
        order_status, confirmation_status, total_price, created_at
      FROM orders_master
      WHERE customer_phone LIKE $1
        OR order_name ILIKE $2
        OR customer_name ILIKE $2
        OR CAST(shopify_order_id AS TEXT) LIKE $1
        OR awb_number LIKE $1
      ORDER BY created_at DESC LIMIT 20
    `, [`%${q}%`, `%${q}%`]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Order detail
app.get('/api/order/:id', async (req, res) => {
  try {
    const order = await dbOne('SELECT * FROM orders_master WHERE id = $1', [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Not found' });
    const events = await db('SELECT * FROM order_status_events WHERE order_id = $1 ORDER BY created_at DESC', [req.params.id]);
    res.json({ order, events });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Order timeline
app.get('/api/order/:id/timeline', async (req, res) => {
  try {
    const events = await db(
      'SELECT * FROM order_status_events WHERE order_id = $1 ORDER BY created_at DESC',
      [req.params.id]
    );
    res.json(events);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// HEALTH & ROOT
// ============================================================
app.get('/health', async (req, res) => {
  try {
    await db('SELECT 1');
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================
// START
// ============================================================
app.listen(PORT, () => {
  console.log(`Jaadu Diet CRM Server running on port ${PORT}`);
});
