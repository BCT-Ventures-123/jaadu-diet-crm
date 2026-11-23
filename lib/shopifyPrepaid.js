// Pushes a Razorpay prepaid payment onto the matching Shopify order.
// Strategy: edit order to remove COD fee → if editing blocked (SR Checkout),
// fall back to refund. Either way the net = paid amount (₹599).
const PAID_TAG = 'prepaid-razorpay';

function money(n) { return (Math.round(Number(n) * 100) / 100).toFixed(2); }

function mergeTags(existing, add) {
  const have = String(existing || '').split(',').map(s => s.trim()).filter(Boolean);
  for (const t of add) if (!have.some(h => h.toLowerCase() === t.toLowerCase())) have.push(t);
  return have.join(', ');
}

function planPrepaidSync(order, { paid, paymentId, mode = 'full', today = new Date() }) {
  if (!order) return { skip: 'shopify_order_not_found' };
  if (order.cancelled_at) return { skip: 'shopify_order_cancelled' };
  if (order.fulfillment_status === 'fulfilled' || order.fulfillment_status === 'partial') {
    return { skip: 'shopify_order_already_fulfilled' };
  }
  const total = Number(order.total_price);
  const outstanding = order.total_outstanding != null ? Number(order.total_outstanding) : total;
  const alreadyPaid = order.financial_status === 'paid';
  const shippingCost = (order.shipping_lines || []).reduce((s, l) => s + Number(l.price || 0), 0);

  const stamp = today.toISOString().slice(0, 10);
  const line = `[CRM ${stamp}] COD converted to PREPAID via Razorpay ${paymentId || ''} (Rs ${money(paid)} received)` +
    (shippingCost > 0 ? `; COD fee Rs ${money(shippingCost)} adjusted` : '');
  return {
    needsPayment: !alreadyPaid && outstanding > 0,
    codFee: shippingCost,
    tags: mergeTags(order.tags, [PAID_TAG]),
    note: order.note ? `${order.note}\n${line}` : line,
    alreadyPaid,
    total,
    paid: Number(paid),
  };
}

async function gql(http, gqlUrl, headers, query) {
  const res = await http.post(gqlUrl, { query }, { headers, timeout: 20000 });
  if (res.data?.errors) {
    console.log('[Shopify GQL] errors:', JSON.stringify(res.data.errors).slice(0, 300));
  }
  return res.data;
}

// Approach 1: Edit order to discount shipping to zero
async function tryOrderEdit(http, gqlUrl, headers, shopifyOrderId) {
  const gid = `gid://shopify/Order/${shopifyOrderId}`;

  const orderData = await gql(http, gqlUrl, headers,
    `{ order(id: "${gid}") { shippingLines(first: 5) { edges { node { id originalPriceSet { shopMoney { amount } } } } } } }`
  );
  const edges = orderData?.data?.order?.shippingLines?.edges || [];
  if (edges.length === 0 || Number(edges[0].node.originalPriceSet?.shopMoney?.amount || 0) === 0) return true;

  const shippingLineGid = edges[0].node.id;

  const beginData = await gql(http, gqlUrl, headers,
    `mutation { orderEditBegin(id: "${gid}") { calculatedOrder { id } userErrors { field message } } }`
  );
  const calcId = beginData?.data?.orderEditBegin?.calculatedOrder?.id;
  if (!calcId) return false;

  await gql(http, gqlUrl, headers,
    `mutation { orderEditAddShippingLineDiscount(id: "${calcId}", shippingLineId: "${shippingLineGid}", discount: { description: "COD fee waived - prepaid", percentValue: 100 }) { calculatedOrder { id } userErrors { field message } } }`
  );

  const commitData = await gql(http, gqlUrl, headers,
    `mutation { orderEditCommit(id: "${calcId}", notifyCustomer: false, staffNote: "COD→Prepaid") { order { id totalPriceSet { shopMoney { amount } } } userErrors { field message } } }`
  );
  const errs = commitData?.data?.orderEditCommit?.userErrors || [];
  if (errs.length > 0) return false;

  const newTotal = commitData?.data?.orderEditCommit?.order?.totalPriceSet?.shopMoney?.amount;
  console.log(`[Shopify prepaid] Order edited, total: Rs ${newTotal}`);
  return true;
}

// Approach 2: Refund shipping after marking paid
async function refundShipping(http, base, headers, shopifyOrderId) {
  try {
    const calcRes = await http.post(`${base}/orders/${shopifyOrderId}/refunds/calculate.json`, {
      refund: { shipping: { full_refund: true } }
    }, { headers, timeout: 15000 });

    const transactions = (calcRes.data?.refund?.transactions || []).map(t => ({
      parent_id: t.parent_id, amount: t.amount, kind: 'refund', gateway: t.gateway,
    }));

    await http.post(`${base}/orders/${shopifyOrderId}/refunds.json`, {
      refund: {
        shipping: { full_refund: true },
        note: 'COD fee removed - prepaid conversion',
        notify: false,
        transactions,
      }
    }, { headers, timeout: 15000 });
    return true;
  } catch (e) {
    console.log('[Shopify prepaid] Refund failed:', JSON.stringify(e.response?.data || e.message).slice(0, 300));
    return false;
  }
}

async function syncPrepaidToShopify({ http, store, token, apiVersion, shopifyOrderId, paid, paymentId, mode, dryRun = false }) {
  if (!store || !token) return { status: 'skipped', detail: 'shopify_not_configured' };
  if (!shopifyOrderId) return { status: 'skipped', detail: 'no_shopify_order_id' };
  const base = `https://${store}/admin/api/${apiVersion || '2024-10'}`;
  const gqlUrl = `${base}/graphql.json`;
  const headers = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };
  const fields = 'id,name,financial_status,fulfillment_status,cancelled_at,total_price,total_outstanding,currency,tags,note,shipping_lines';

  let order = null;
  try {
    order = (await http.get(`${base}/orders/${shopifyOrderId}.json`, { headers, params: { fields }, timeout: 15000 })).data.order;
  } catch (e) {
    if (e.response && e.response.status === 404) return { status: 'skipped', detail: 'shopify_order_not_found' };
    throw e;
  }
  const plan = planPrepaidSync(order, { paid, paymentId, mode });
  if (plan.skip) return { status: 'skipped', detail: plan.skip };
  if (dryRun) return { status: 'dry_run', detail: 'planned', plan };

  const gid = `gid://shopify/Order/${shopifyOrderId}`;
  let method = 'none';

  // Step 1: Try to remove COD fee (edit first, refund as fallback — done BEFORE marking paid)
  // Order edit changes total before payment; refund needs payment first — so order matters.
  if (plan.codFee > 0) {
    try {
      const edited = await tryOrderEdit(http, gqlUrl, headers, shopifyOrderId);
      if (edited) {
        method = 'edited';
        console.log(`[Shopify prepaid] COD fee removed via order edit`);
      }
    } catch (e) {
      console.log('[Shopify prepaid] Order edit failed:', e.message);
    }
  }

  // Step 2: Mark as paid
  if (plan.needsPayment) {
    const res = await gql(http, gqlUrl, headers,
      `mutation { orderMarkAsPaid(input: { id: "${gid}" }) { order { id totalPriceSet { shopMoney { amount } } } userErrors { field message } } }`
    );
    const errs = res?.data?.orderMarkAsPaid?.userErrors || [];
    const paidTotal = res?.data?.orderMarkAsPaid?.order?.totalPriceSet?.shopMoney?.amount;
    if (errs.length > 0) {
      console.log('[Shopify prepaid] markAsPaid errors:', JSON.stringify(errs));
      await http.put(`${base}/orders/${shopifyOrderId}.json`, { order: { id: shopifyOrderId, tags: plan.tags, note: plan.note } }, { headers, timeout: 15000 });
      return { status: 'failed', detail: 'mark_as_paid_failed' };
    }
    console.log(`[Shopify prepaid] Marked as paid, total: Rs ${paidTotal}`);
  }

  // Step 3: If order edit didn't work, refund shipping (needs paid order)
  if (plan.codFee > 0 && method === 'none') {
    const refunded = await refundShipping(http, base, headers, shopifyOrderId);
    if (refunded) {
      method = 'refunded';
      console.log(`[Shopify prepaid] COD fee removed via shipping refund`);
    }
  }

  // Step 4: Tag + note
  await http.put(`${base}/orders/${shopifyOrderId}.json`, { order: { id: shopifyOrderId, tags: plan.tags, note: plan.note } }, { headers, timeout: 15000 });

  const net = money(plan.paid);
  return { status: 'synced', detail: `paid_${net}_${method}` };
}

module.exports = { planPrepaidSync, syncPrepaidToShopify, mergeTags, PAID_TAG };
