const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../lib/attemptsLog');

const at = (s) => new Date(s + '+05:30');

test('attempts log: callers, IVR and WhatsApp in one list, in time order, numbered per order', () => {
  const rows = A.merge({
    callers: [{ t: at('2026-11-23T10:00:00'), channel: 'Call centre', by: 'Priya', order_id: 'o1', order: '#1', phone: '+91 98765 43210', result: 'dnp', connected: false, note: 'rang out' }],
    ivr: [{ t: at('2026-11-23T19:00:00'), order_id: 'o1', order: '#1', phone: '9876543210', result: null, connected: false }, { t: at('2026-11-24T07:30:00'), order_id: 'o1', order: '#1', phone: '9876543210', result: 'confirmed', connected: true }],
    wa: [{ t: at('2026-11-23T09:00:00'), order_id: 'o1', order: '#1', phone: '9876543210', step: 0, status: 'sent', events: ['delivered', 'read'] }, { t: at('2026-11-23T13:00:00'), order_id: 'o1', order: '#1', phone: '9876543210', step: 1, status: 'sent', events: ['delivered', 'clicked_change_address'] }],
  });
  assert.deepEqual(rows.map(r => r.channel), ['WhatsApp', 'Call centre', 'WhatsApp', 'IVR', 'IVR']);
  assert.deepEqual(rows.map(r => r.n), [1, 2, 3, 4, 5]);                                                              // every attempt on the order, whichever channel
  assert.equal(rows[0].result, 'Read, no reply'); assert.equal(rows[0].reached, false); assert.equal(rows[0].by, 'WhatsApp message 1');
  assert.equal(rows[1].result, 'No answer (DNP)'); assert.equal(rows[1].phone, '9876543210'); assert.equal(rows[1].detail, 'rang out');
  assert.equal(rows[2].result, 'Tapped Change address'); assert.equal(rows[2].reached, true);
  assert.equal(rows[3].result, 'Called, no key pressed'); assert.equal(rows[4].result, 'Pressed 1: confirmed'); assert.equal(rows[4].reached, true);
  const csv = A.csvRows(rows); assert.equal(csv.length, 5); assert.equal(csv[0].length, A.HEAD.length); assert.equal(csv[1][0], '2026-11-23 10:00:00');
});

test('attempts log: WhatsApp results are told in plain words, and a failed message is not a reach', () => {
  assert.deepEqual(A.waResult({ status: 'sent', events: ['clicked_confirm'] }), { text: 'Tapped Confirm', reached: true });
  assert.deepEqual(A.waResult({ status: 'sent', events: ['delivered'] }), { text: 'Delivered, not read', reached: false });
  assert.deepEqual(A.waResult({ status: 'failed', events: [] }), { text: 'Could not be delivered', reached: false });
  assert.deepEqual(A.waResult({ status: 'sent', events: [] }), { text: 'Sent, not delivered yet', reached: false });
  assert.equal(A.merge({}).length, 0);
});
