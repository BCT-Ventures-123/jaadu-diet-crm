const test = require('node:test');
const assert = require('node:assert');
const { buildE2E } = require('../lib/e2e');

const o = (day, status, calls) => ({ day, status, calls });

test('one day: every line has the right count and percentage', () => {
  const rows = [
    o('2026-11-10', 'confirmed', ['dnp', 'confirmed']),   // attempted, connected, confirmed on a call
    o('2026-11-10', 'pending', ['dnp']),                   // attempted, not connected
    o('2026-11-10', 'confirmed', []),                      // confirmed on WhatsApp: nobody had to call
    o('2026-11-10', 'pending', ['address_fix']),           // address fix counts as connected
    o('2026-11-10', 'cancelled', ['cancelled']),           // rejected
    o('2026-11-10', 'pending', []),                        // nobody has called yet
  ];
  const r = buildE2E(rows, { '2026-11-10': 4 });
  const d = r.days[0], t = r.totals;
  assert.strictEqual(d.total, 10);
  assert.strictEqual(d.prepaid, 4);
  assert.strictEqual(d.cod, 6);
  assert.strictEqual(d.closed_without_call, 1);
  assert.strictEqual(d.needed_call, 5);
  assert.strictEqual(d.calls, 5);
  assert.strictEqual(d.attempted, 4);
  assert.strictEqual(d.attempted_pct, 80);            // 4 of the 5 orders that needed a call
  assert.strictEqual(d.not_attempted, 1);
  assert.strictEqual(d.connected, 3);                  // confirmed, address fix, cancelled
  assert.strictEqual(d.connected_address_fix_only, 1);
  assert.strictEqual(d.connected_pct, 50);             // 3 of 6 COD
  assert.strictEqual(d.not_connected, 1);
  assert.strictEqual(d.rejected, 1);
  assert.strictEqual(d.confirmed_on_call, 1);
  assert.strictEqual(d.confirmed_other, 1);
  assert.strictEqual(d.confirmed_all, 2);
  assert.strictEqual(d.confirmed_pct, 33.3);
  assert.strictEqual(d.pending, 3);
  assert.deepStrictEqual([t.total, t.cod, t.confirmed_all], [10, 6, 2]);
});

test('the overall table is in the order asked for, and every line has a count', () => {
  const r = buildE2E([o('2026-11-10', 'confirmed', ['confirmed'])], { '2026-11-10': 1 });
  assert.deepStrictEqual(r.table.map(x => x.key), ['total', 'prepaid', 'cod', 'closed_without_call', 'needed_call', 'calls', 'attempted', 'not_attempted',
    'connected', 'not_connected', 'rejected', 'confirmed_on_call', 'confirmed_other', 'confirmed_all', 'pending']);
  assert.ok(r.table.every(x => typeof x.count === 'number'));
  assert.strictEqual(r.table.find(x => x.key === 'confirmed_all').pct, 100);
});

test('days are listed by order date, a day with only prepaid orders still appears, empty input is safe', () => {
  const r = buildE2E([o('2026-11-11', 'pending', []), o('2026-11-09', 'pending', ['dnp'])], { '2026-11-10': 3 }, { today: '2026-11-11' });
  assert.deepStrictEqual(r.days.map(x => x.day), ['2026-11-09', '2026-11-10', '2026-11-11']);
  assert.strictEqual(r.days[1].cod, 0);
  assert.strictEqual(r.days[1].prepaid, 3);
  assert.strictEqual(r.days[1].attempted_pct, null);   // nothing to divide by
  assert.strictEqual(r.days[2].is_today, true);
  const e = buildE2E([], {});
  assert.strictEqual(e.totals.total, 0);
  assert.strictEqual(e.days.length, 0);
  assert.strictEqual(e.table.find(x => x.key === 'total').pct, null);
});

test('calls per order and call pick-up are reported next to the orders so the two are never mixed up', () => {
  const rows = [o('2026-11-10', 'confirmed', ['dnp', 'dnp', 'confirmed']), o('2026-11-10', 'pending', ['dnp'])];
  const t = buildE2E(rows, {}).totals;
  assert.strictEqual(t.calls, 4);
  assert.strictEqual(t.calls_picked, 1);
  assert.strictEqual(t.calls_picked_pct, 25);          // 1 of 4 calls picked up
  assert.strictEqual(t.connected_pct, 50);             // but 1 of 2 orders reached
  assert.strictEqual(t.calls_per_order_called, 2);
});
