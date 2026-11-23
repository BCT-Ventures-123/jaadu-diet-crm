const test = require('node:test');
const assert = require('node:assert');
const { planPrepaidSync, syncPrepaidToShopify, mergeTags } = require('../lib/shopifyPrepaid');

const codOrder = { id: 1, financial_status: 'pending', fulfillment_status: null, cancelled_at: null, total_price: '667.00', currency: 'INR', tags: 'fastrr, high', note: null };

test('full mode marks the whole COD total paid and notes the waived COD fee', () => {
  const p = planPrepaidSync(codOrder, { paid: 599, paymentId: 'pay_1', mode: 'full' });
  assert.equal(p.transaction.amount, '667.00');
  assert.equal(p.transaction.kind, 'sale');
  assert.match(p.note, /COD fee Rs 68\.00 waived/);
  assert.match(p.tags, /prepaid-razorpay/);
  assert.match(p.tags, /fastrr/);
});

test('exact mode records only what was received', () => {
  const p = planPrepaidSync(codOrder, { paid: 599, paymentId: 'pay_1', mode: 'exact' });
  assert.equal(p.transaction.amount, '599.00');
  assert.doesNotMatch(p.note, /waived/);
});

test('skips cancelled and fulfilled Shopify orders', () => {
  assert.equal(planPrepaidSync({ ...codOrder, cancelled_at: '2026-10-08' }, { paid: 599 }).skip, 'shopify_order_cancelled');
  assert.equal(planPrepaidSync({ ...codOrder, fulfillment_status: 'fulfilled' }, { paid: 599 }).skip, 'shopify_order_already_fulfilled');
  assert.equal(planPrepaidSync(null, { paid: 599 }).skip, 'shopify_order_not_found');
});

test('an already-paid order is only tagged, no second payment is recorded', () => {
  const p = planPrepaidSync({ ...codOrder, financial_status: 'paid' }, { paid: 599 });
  assert.equal(p.transaction, null);
  assert.match(p.tags, /prepaid-razorpay/);
});

test('tags are not duplicated', () => {
  assert.equal(mergeTags('a, Prepaid-Razorpay', ['prepaid-razorpay']), 'a, Prepaid-Razorpay');
});

function fakeHttp(order) {
  const calls = [];
  return {
    calls,
    get: async (url) => { calls.push(['get', url]); return { data: { order } }; },
    post: async (url, body) => { calls.push(['post', url, body]); return { data: {} }; },
    put: async (url, body) => { calls.push(['put', url, body]); return { data: {} }; },
  };
}
const base = { store: 'x.myshopify.com', token: 't', apiVersion: '2024-10', shopifyOrderId: 1, paid: 599, paymentId: 'pay_1', mode: 'full' };

test('sync posts the payment, then tags the order', async () => {
  const http = fakeHttp(codOrder);
  const r = await syncPrepaidToShopify({ ...base, http });
  assert.equal(r.status, 'synced');
  assert.deepEqual(http.calls.map(c => c[0]), ['get', 'get', 'post', 'put']);
  assert.match(http.calls[2][1], /\/orders\/1\/transactions\.json$/);
});

test('dry run never writes', async () => {
  const http = fakeHttp(codOrder);
  const r = await syncPrepaidToShopify({ ...base, http, dryRun: true });
  assert.equal(r.status, 'dry_run');
  assert.deepEqual(http.calls.map(c => c[0]), ['get']);
});

test('missing Shopify config is skipped, not an error', async () => {
  const r = await syncPrepaidToShopify({ ...base, http: fakeHttp(codOrder), token: '' });
  assert.equal(r.status, 'skipped');
});
