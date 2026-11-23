const test = require('node:test');
const assert = require('node:assert/strict');
const sc = require('../lib/shopifyCheck');

const crm = new Map([
  ['1', { order_name: '#1', status: 'confirmed', payment_method: 'COD' }],        // confirmed in the CRM, tagged on Shopify: fine
  ['2', { order_name: '#2', status: 'confirmed', payment_method: 'COD' }],        // confirmed, no tag on Shopify
  ['3', { order_name: '#3', status: 'pending', payment_method: 'COD' }],          // cancelled on Shopify, still open here
  ['4', { order_name: '#4', status: 'cancelled', payment_method: 'COD' }],        // cancelled here, open on Shopify
  ['5', { order_name: '#5', status: 'confirmed', payment_method: 'Prepaid' }],    // prepaid: the confirmed tag is not expected
  ['6', { order_name: '#6', status: 'cancelled', payment_method: 'COD' }],        // cancelled on both: fine
]);
const shopify = [
  { id: 1, name: '#1', tags: 'confirmed, cod', cancelled_at: null }, { id: 2, name: '#2', tags: 'cod', cancelled_at: null }, { id: 3, name: '#3', tags: '', cancelled_at: '2026-11-23T01:00:00Z' },
  { id: 4, name: '#4', tags: '', cancelled_at: null }, { id: 5, name: '#5', tags: '', cancelled_at: null }, { id: 6, name: '#6', tags: '', cancelled_at: '2026-11-22T01:00:00Z' }, { id: 7, name: '#7', tags: '', cancelled_at: null },
];

test('Shopify check: finds orders the two systems disagree about, and leaves the matching ones alone', () => {
  const r = sc.compare(shopify, crm);
  assert.equal(r.shopify_orders, 7); assert.equal(r.matched, 6); assert.equal(r.problems, 4);
  assert.deepEqual(r.missing_in_crm.orders, ['#7']); assert.deepEqual(r.cancelled_on_shopify_not_in_crm.orders, ['#3 (pending in the CRM)']);
  assert.deepEqual(r.cancelled_in_crm_not_on_shopify.orders, ['#4']); assert.deepEqual(r.confirmed_not_tagged_on_shopify.orders, ['#2']);
  assert.equal(sc.compare([], new Map()).problems, 0); assert.equal(sc.hasTag('Confirmed, COD', 'confirmed'), true); assert.equal(sc.hasTag('', 'confirmed'), false);
});

test('Shopify check: long lists are capped at 30 names but the count stays exact', () => {
  const many = Array.from({ length: 45 }, (_, i) => ({ id: 1000 + i, name: '#M' + i, tags: '', cancelled_at: null }));
  const r = sc.compare(many, new Map()); assert.equal(r.missing_in_crm.n, 45); assert.equal(r.missing_in_crm.orders.length, 30);
});
