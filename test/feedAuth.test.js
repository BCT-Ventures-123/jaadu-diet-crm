const test = require('node:test');
const assert = require('node:assert');
const { checkFeedKey, feedRow } = require('../lib/feedAuth');

test('feed is off without a key, and rejects missing or wrong keys', () => {
  assert.strictEqual(checkFeedKey('x', '').status, 503);
  assert.strictEqual(checkFeedKey('x', undefined).status, 503);
  assert.strictEqual(checkFeedKey('', 'secret').status, 401);
  assert.strictEqual(checkFeedKey('nope', 'secret').status, 401);
  assert.strictEqual(checkFeedKey('secret', 'secret').ok, true);
});

test('feed row has what the shipper needs and a 10-digit phone', () => {
  const r = feedRow({ order_name: '#1', payment: 'COD', collect: 599, total_price: 599, customer_name: 'A', customer_phone: '+91 98765-43210', address: 'x', city: 'Pune', state: 'MH', zip: '411001', product: 'Tea x1', ship_status: 'due_today' });
  assert.strictEqual(r.phone, '9876543210');
  assert.strictEqual(r.disposition, 'Confirmed');
  assert.strictEqual(r.pincode, '411001');
});
