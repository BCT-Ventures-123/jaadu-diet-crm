const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const BASE = 'https://apiv2.shiprocket.in/v1/external';
let cachedToken = null;
let tokenExpiresAt = 0;

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;
  const email = process.env.SHIPROCKET_EMAIL;
  const password = process.env.SHIPROCKET_PASSWORD;
  if (!email || !password) throw new Error('SHIPROCKET_EMAIL or SHIPROCKET_PASSWORD not set');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`Shiprocket login failed: ${res.status}`);
    const data = await res.json();
    cachedToken = data.token;
    tokenExpiresAt = Date.now() + 9 * 24 * 3600 * 1000;
    return cachedToken;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

async function apiGet(path, timeoutMs = 30000) {
  const token = await getToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      if (res.status === 401) { cachedToken = null; tokenExpiresAt = 0; }
      throw new Error(`Shiprocket API ${path} failed: ${res.status}`);
    }
    return res.json();
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

async function getNdrShipments() {
  return apiGet('/ndr/all');
}

// ---- Cached order scan for OFD and Undelivered ----
const CACHE_TTL = 10 * 60 * 1000;
let orderCache = { ofd: [], undelivered: [], allRisk: [], updatedAt: 0 };
let refreshPromise = null;

async function refreshOrderCache() {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const t0 = Date.now();
    console.log('[Shiprocket] Refreshing order cache...');
    try {
      const ofd = [];
      const undelivered = [];
      const allRisk = [];
      let total = 0;
      let failedPages = 0;
      const maxPages = 100;

      for (let page = 1; page <= maxPages; page++) {
        let data;
        try {
          const r = await apiGet(`/orders?per_page=200&page=${page}`, 20000);
          data = r.data || [];
        } catch (e) {
          console.error(`[Shiprocket] Page ${page} error: ${e.message}`);
          failedPages++;
          if (failedPages >= 3) { console.error('[Shiprocket] Too many page failures, stopping'); break; }
          continue;
        }
        if (!data.length) { console.log(`[Shiprocket] Page ${page}: empty, done`); break; }
        total += data.length;
        if (page % 10 === 0) console.log(`[Shiprocket] Page ${page}: ${total} orders so far...`);

        for (const o of data) {
          const st = (o.status || '').toUpperCase();
          const item = {
            sr_order_id: o.id,
            channel_order_id: o.channel_order_id,
            customer_name: o.customer_name || '',
            customer_phone: o.customer_phone || '',
            customer_email: o.customer_email || '',
            customer_address: o.customer_address || '',
            customer_city: o.customer_city || '',
            customer_state: o.customer_state || '',
            customer_pincode: o.customer_pincode || '',
            total: o.total,
            payment_method: o.payment_method || '',
            rto_risk: o.rto_risk || '',
            status: o.status || '',
            awb: o.shipments?.[0]?.awb || '',
            courier: o.shipments?.[0]?.courier || '',
            product_name: o.products?.[0]?.name || '',
            etd_date: o.etd_date || null,
            out_for_delivery_date: o.out_for_delivery_date || null,
            delivered_date: o.delivered_date || null,
            created_at: o.channel_created_at || o.created_at || '',
          };

          if (st.includes('OUT FOR DELIVERY')) ofd.push(item);
          if (st.includes('UNDELIVERED') || st.includes('NDR') || st.includes('FAILED DELIVERY')) undelivered.push(item);
          if (item.rto_risk === 'high' && (st.includes('SHIPPED') || st.includes('IN TRANSIT') || st.includes('OUT FOR') || st.includes('PICKED UP'))) allRisk.push(item);
        }

        if (data.length < 200) break;
      }

      orderCache.ofd = ofd;
      orderCache.undelivered = undelivered;
      orderCache.allRisk = allRisk;
      orderCache.updatedAt = Date.now();
      console.log(`[Shiprocket] Cache refreshed in ${Math.round((Date.now() - t0) / 1000)}s: ${total} orders, ${ofd.length} OFD, ${undelivered.length} undelivered, ${allRisk.length} high-risk`);
    } catch (e) {
      console.error('[Shiprocket] Cache refresh CRASHED:', e.message, e.stack);
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

function ensureCache() {
  if (Date.now() - orderCache.updatedAt > CACHE_TTL && !refreshPromise) {
    refreshOrderCache().catch(() => {});
  }
}

async function getPreDeliveryData() {
  ensureCache();
  const loading = !!refreshPromise && !orderCache.updatedAt;
  return { ofd: orderCache.ofd, high_risk: orderCache.allRisk, loading, cache_age_seconds: orderCache.updatedAt ? Math.round((Date.now() - orderCache.updatedAt) / 1000) : -1 };
}

async function getPostDeliveryData() {
  ensureCache();

  let ndrData = [];
  try {
    const r = await getNdrShipments();
    ndrData = r.data || [];
  } catch (e) {
    console.error('[Shiprocket] NDR fetch error:', e.message);
  }

  const loading = !!refreshPromise && !orderCache.updatedAt;
  return { undelivered: orderCache.undelivered, ndr_api: ndrData, loading, cache_age_seconds: orderCache.updatedAt ? Math.round((Date.now() - orderCache.updatedAt) / 1000) : -1 };
}

module.exports = { getToken, apiGet, getNdrShipments, refreshOrderCache, getPreDeliveryData, getPostDeliveryData };
