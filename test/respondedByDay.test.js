const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../lib/ledger');

const T = (h, team, connected) => ({ t: new Date(Date.UTC(2026, 10, 26, h)), team, connected });
const row = (id, day) => ({ id, order_name: '#' + id, day, order_at: day + 'T04:00:00Z', amount: 500, status: 'pending', team: 'CC' });

test('responded: once per order per channel, any attempt, even when another channel reached the order first', () => {
  const rows = [row(1, '2026-11-26'), row(2, '2026-11-26'), row(3, '2026-11-26'), row(4, '2026-11-25')];
  const touches = new Map([
    [1, [T(5, 'cc', true), T(6, 'ivr', true), T(7, 'ivr', true), T(8, 'wa', true)]],        // CC reached first, IVR key pressed twice, WhatsApp tapped: responded on ivr and wa, once each
    [2, [T(5, 'ivr', false), T(6, 'wa', false)]],                                              // tried, nobody answered: responded nowhere
    [3, [T(5, 'wa', true)]],
    [4, [T(5, 'ivr', true)]]]);
  const led = L.buildLedger(rows, touches, new Date('2026-11-27T00:00:00Z'));
  assert.deepEqual(led[0].responded, { aman: false, cc: true, ivr: true, wa: true });
  assert.deepEqual(led[1].responded, { aman: false, cc: false, ivr: false, wa: false });
  const d = L.respondedByDay(led);
  assert.deepEqual(d['2026-11-26'], { orders: 3, aman: 0, cc: 1, ivr: 1, wa: 2 });
  assert.deepEqual(d['2026-11-25'], { orders: 1, aman: 0, cc: 0, ivr: 1, wa: 0 });
  for (const day of Object.values(d)) for (const c of ['aman', 'cc', 'ivr', 'wa']) assert.ok(day[c] <= day.orders);      // never more than the day's orders
});

test('responded does not change the credited ("reached first") numbers', () => {
  const rows = [row(1, '2026-11-26')], touches = new Map([[1, [T(5, 'cc', true), T(6, 'ivr', true)]]]);
  const led = L.buildLedger(rows, touches, new Date('2026-11-27T00:00:00Z')), s = L.summarize(led);
  assert.equal(s.total.reached.cc, 1); assert.equal(s.total.reached.ivr, 0);                 // credited to the first channel only
});
