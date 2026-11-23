const test = require('node:test');
const assert = require('node:assert');
const { shippingLocked } = require('../lib/prepaidGuard');

test('unshipped orders may convert', () => {
  assert.equal(shippingLocked({ order_status: 'new' }), null);
  assert.equal(shippingLocked({ order_status: null }), null);
  assert.equal(shippingLocked({ order_status: 'new', awb_number: null, shipped_at: null }), null);
});

test('shipped or later orders are locked', () => {
  ['shipped', 'delivered', 'ndr', 'rto', 'lost', 'returned'].forEach(s =>
    assert.ok(shippingLocked({ order_status: s }), s));
});

test('an assigned AWB or shipped_at locks the order even if status is still new', () => {
  assert.ok(shippingLocked({ order_status: 'new', awb_number: 'AWB123' }));
  assert.ok(shippingLocked({ order_status: 'new', shipped_at: '2026-10-08T10:00:00Z' }));
});
