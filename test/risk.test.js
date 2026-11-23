const test = require('node:test');
const assert = require('node:assert');
const { scoreRisk, validPhone } = require('../lib/risk');

const good = { shipping_zip: '110001', shipping_address1: 'Flat 12, Near City Mall, Main Road', shipping_address2: 'Sector 4', total_price: 599, customer_phone: '9876543210' };

test('clean order is Low', () => {
  const r = scoreRisk(good, {});
  assert.equal(r.level, 'Low');
  assert.deepEqual(r.reasons, ['No warning signs found']);
});

test('phone validation', () => {
  assert.equal(validPhone('9876543210'), true);
  assert.equal(validPhone('1234567890'), false);
  assert.equal(validPhone('9999999999'), false);
  assert.equal(validPhone(''), false);
});

test('many bad signals escalate to High with reasons', () => {
  const bad = { ...good, shipping_zip: '12', shipping_address1: 'abc', shipping_address2: '', customer_phone: '123' };
  const r = scoreRisk(bad, { pincode: { shipped: 50, rto: 40 }, customer: { priorRtos: 3 }, recentOrders: 2 });
  assert.equal(r.level, 'High');
  assert.ok(r.reasons.length >= 4);
});

test('pincode history ignored below minimum sample', () => {
  const r = scoreRisk(good, { pincode: { shipped: 1, rto: 1 } });
  assert.equal(r.points, 0);
});
