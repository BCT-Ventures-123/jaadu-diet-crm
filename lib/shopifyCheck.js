// CRM against Shopify (read only): do the two stores agree about the last few days of orders? Pure comparison, the route fetches the data (cc_routes.js /api/cc/shopify-check).
//   shopify: [{ id, name, cancelled_at, tags, created_at }]                         the store's orders
//   crm:     Map(shopify order id -> { id, order_name, status, payment_method, tag_synced })     the CRM's orders for the same Shopify ids
// Every list is capped at 30 names so the page stays small; the counts are exact.
const hasTag = (tags, t) => String(tags || '').split(',').map(s => s.trim().toLowerCase()).includes(t);
const cap = (a) => a.slice(0, 30);

function compare(shopify, crm) {
  const missing = [], cancelledShopifyOpenCrm = [], cancelledCrmOpenShopify = [], confirmedNotTagged = [];
  let both = 0;
  for (const s of shopify) {
    const c = crm.get(String(s.id));
    if (!c) { missing.push(s.name || String(s.id)); continue; }
    both++;
    const cod = String(c.payment_method || 'COD').toUpperCase() === 'COD';
    if (s.cancelled_at && (c.status === 'pending' || c.status === 'confirmed')) cancelledShopifyOpenCrm.push(c.order_name + ' (' + c.status + ' in the CRM)');
    if (!s.cancelled_at && cod && c.status === 'cancelled') cancelledCrmOpenShopify.push(c.order_name);
    if (!s.cancelled_at && cod && c.status === 'confirmed' && !hasTag(s.tags, 'confirmed')) confirmedNotTagged.push(c.order_name);
  }
  const problems = missing.length + cancelledShopifyOpenCrm.length + cancelledCrmOpenShopify.length + confirmedNotTagged.length;
  return { shopify_orders: shopify.length, matched: both, problems,
    missing_in_crm: { n: missing.length, orders: cap(missing) },
    cancelled_on_shopify_not_in_crm: { n: cancelledShopifyOpenCrm.length, orders: cap(cancelledShopifyOpenCrm) },
    cancelled_in_crm_not_on_shopify: { n: cancelledCrmOpenShopify.length, orders: cap(cancelledCrmOpenShopify) },
    confirmed_not_tagged_on_shopify: { n: confirmedNotTagged.length, orders: cap(confirmedNotTagged) } };
}

module.exports = { compare, hasTag };
