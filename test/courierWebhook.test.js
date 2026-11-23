const test = require('node:test');
const assert = require('node:assert');
const w = require('../lib/courierWebhook');

test('classify: undelivered and RTO delivered are not "delivered"', () => {
  assert.strictEqual(w.classify('UNDELIVERED'), 'ndr');
  assert.strictEqual(w.classify('Undelivered - customer not available'), 'ndr');
  assert.strictEqual(w.classify('RTO Delivered'), 'rto_delivered');
  assert.strictEqual(w.classify('RTO_DELIVERED'), 'rto_delivered');
  assert.strictEqual(w.classify('DELIVERED'), 'delivered');
  assert.strictEqual(w.classify('Delivered'), 'delivered');
});

test('classify: the other courier states', () => {
  assert.strictEqual(w.classify('RTO INITIATED'), 'rto_initiated');
  assert.strictEqual(w.classify('RTO IN TRANSIT'), 'rto_in_transit');
  assert.strictEqual(w.classify('RTO NDR'), 'rto_in_transit');
  assert.strictEqual(w.classify('OUT FOR DELIVERY'), 'out_for_delivery');
  assert.strictEqual(w.classify('IN TRANSIT'), 'shipped');
  assert.strictEqual(w.classify('PICKED UP'), 'shipped');
  assert.strictEqual(w.classify('LOST'), 'lost');
  assert.strictEqual(w.classify('NDR'), 'ndr');
});

test('classify: pre-pickup states change nothing', () => {
  assert.strictEqual(w.classify('PICKUP SCHEDULED'), null);
  assert.strictEqual(w.classify('Out For Pickup'), null);
  assert.strictEqual(w.classify('AWB ASSIGNED'), null);
  assert.strictEqual(w.classify(''), null);
});

test('parseEventTime reads Shiprocket day-month-year as India time', () => {
  assert.strictEqual(w.parseEventTime('11 11 2026 11:22:17').toISOString(), '2026-11-11T05:52:17.000Z');
  assert.strictEqual(w.parseEventTime('2026-11-11 11:22:17').toISOString(), '2026-11-11T05:52:17.000Z');
  assert.strictEqual(w.parseEventTime('nonsense'), null);
  assert.strictEqual(w.parseEventTime(''), null);
});

test('parsePayload: the real Shiprocket payload now has an order reference and a status', () => {
  const p = w.parsePayload({
    awb: '1091408327856', courier_name: 'Delhivery Air', current_status: 'UNDELIVERED', current_status_id: 36,
    shipment_status: 'UNDELIVERED', shipment_status_id: 21, current_timestamp: '11 11 2026 11:22:17', order_id: '33621', sr_order_id: 1705276012,
  });
  assert.strictEqual(p.awb, '1091408327856');
  assert.deepStrictEqual(p.refs, ['33621']);
  assert.strictEqual(p.srOrderId, '1705276012');
  assert.strictEqual(p.status, 'ndr');
  assert.strictEqual(p.eventAt.toISOString(), '2026-11-11T05:52:17.000Z');
});

test('parsePayload: NimbusPost style and a scan reason', () => {
  const p = w.parsePayload({ awb_number: 'N1', status: 'Delivered', order_number: '#55', scans: [{ status_remark: 'Handed to customer' }] });
  assert.strictEqual(p.awb, 'N1');
  assert.deepStrictEqual(p.refs, ['55']);
  assert.strictEqual(p.status, 'delivered');
  assert.strictEqual(p.reason, 'Handed to customer');
});

test('nameVariants tries the plain number and the #number', () => {
  assert.deepStrictEqual(w.nameVariants(['33621']), ['33621', '#33621']);
});

test('eventKey: the same courier event gives the same key, a later one does not', () => {
  const a = w.eventKey('ndr', 'UNDELIVERED', new Date('2026-11-11T05:52:17Z'));
  assert.strictEqual(a, w.eventKey('ndr', 'undelivered', new Date('2026-11-11T05:52:17Z')));
  assert.notStrictEqual(a, w.eventKey('ndr', 'UNDELIVERED', new Date('2026-11-12T05:52:17Z')));
});

test('shouldApply: a late scan never moves a finished order back', () => {
  assert.strictEqual(w.shouldApply('delivered', 'shipped'), false);
  assert.strictEqual(w.shouldApply('delivered', 'ndr'), false);
  assert.strictEqual(w.shouldApply('rto', 'shipped'), false);
  assert.strictEqual(w.shouldApply('shipped', 'delivered'), true);
  assert.strictEqual(w.shouldApply('ndr', 'delivered'), true);
  assert.strictEqual(w.shouldApply('shipped', 'rto_initiated'), true);
});
