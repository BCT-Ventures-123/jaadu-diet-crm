const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../lib/leadAudit');

const NOW = new Date('2026-11-22T12:00:00+05:30').getTime();
const o = (id, team, status, day, extra = {}) => ({ id, team, status, day, dnc: false, callback_at: null, calls: [], ...extra });
const rows = [
  o('a', 'InHouse', 'pending', '2026-11-22'),                                 // today, Aman never called
  o('b', 'CC', 'pending', '2026-11-12'),                                      // 10 days old, call centre never called
  o('c', 'CC', 'pending', '2026-11-20', { calls: ['dnp'] }),                  // attempted by a caller: not in the audit
  o('d', 'CC', 'confirmed', '2026-11-21'),                                    // closed by WhatsApp, no call
  o('e', 'CC', 'pending', '2026-11-21'),                                      // IVR called it: that is an attempt
  o('f', 'CC', 'pending', '2026-11-21'),                                      // held for the IVR right now
  o('g', 'InHouse', 'pending', '2026-11-19', { callback_at: '2026-11-22T15:00:00Z' }),
  o('h', 'CC', 'pending', '2026-11-18', { dnc: true }),
];
const info = new Map([
  ['a', { order_name: '#1001', customer_phone: '9000000001' }], ['b', { order_name: '#1002' }], ['d', { order_name: '#1004' }],
  ['f', { order_name: '#1006', lead_locked_by: 'IVR', lead_locked_at: new Date(NOW + 60 * 60000) }], ['g', { order_name: '#1007' }], ['h', { order_name: '#1008' }],
]);

test('audit: only orders with no caller call and no IVR call are listed, and the others are not', () => {
  const r = A.build(rows, new Set(['e']), info, NOW);
  assert.equal(r.orders, 8); assert.equal(r.no_attempt, 6);
  assert.deepEqual(r.list.map(l => l.id).sort(), ['a', 'b', 'd', 'f', 'g', 'h']);       // c had a call, e had an IVR call
  assert.equal(r.no_attempt_pending, 5);                                                 // d is closed
});

test('audit: every lead gets a plain reason, and the oldest come first', () => {
  const r = A.build(rows, new Set(['e']), info, NOW), why = Object.fromEntries(r.list.map(l => [l.id, l.reason]));
  assert.equal(why.a, 'Waiting for Aman (never called)'); assert.equal(why.b, 'Waiting for Call centre (never called)');
  assert.equal(why.d, 'Closed without a call (WhatsApp, sheet or system)'); assert.equal(why.f, 'Held for the IVR');
  assert.equal(why.g, 'Callback promised'); assert.equal(why.h, 'Do-not-call');
  assert.equal(r.list[0].id, 'b'); assert.equal(r.list[0].age_days, 10);                 // 10 days old first
  assert.equal(r.list.find(l => l.id === 'a').age_days, 0);
});

test('audit: the reasons add up to the total, split by team and age', () => {
  const r = A.build(rows, new Set(['e']), info, NOW);
  assert.equal(r.reasons.reduce((s, x) => s + x.total, 0), r.no_attempt);
  const waitCc = r.reasons.find(x => x.reason === 'Waiting for Call centre (never called)');
  assert.equal(waitCc.cc, 1); assert.equal(waitCc.aman, 0); assert.equal(waitCc.older_than_1_day, 1);
});

test('audit: a hold that has ended no longer hides the lead', () => {
  const expired = new Map([['f', { order_name: '#1006', lead_locked_by: 'IVR', lead_locked_at: new Date(NOW - 20 * 60000) }]]);
  const r = A.build([o('f', 'CC', 'pending', '2026-11-21')], new Set(), expired, NOW);
  assert.equal(r.list[0].reason, 'Waiting for Call centre (never called)');             // the 15-minute tail is over: it is waiting for a caller again
});

test('audit: nothing to list gives zeros', () => {
  const r = A.build([], new Set(), new Map(), NOW);
  assert.equal(r.no_attempt, 0); assert.deepEqual(r.reasons, []);
});
