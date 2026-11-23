const test = require('node:test');
const assert = require('node:assert');
const g = require('../lib/shipGate');

// 2026-11-07 is a Saturday, 11-08 a Sunday, 11-09 a Monday.
const at = (s) => new Date(s + '+05:30');
const FULL = 'Flat 12, Shanti Apartments, Near City Mall, Sector 5';
const order = (o = {}) => ({
  id: 'x', order_name: '#1', payment_method: 'COD', confirmation_status: 'confirmed', order_status: 'new',
  confirmed_at: at('2026-11-09T10:00:00'), shopify_created_at: at('2026-11-09T09:00:00'),
  shipping_address1: FULL, shipping_city: 'Pune', shipping_province: 'Maharashtra',
  awb_number: null, shipped_at: null, is_duplicate: false, address_fixed: false, ...o,
});

test('same-day rule: up to 2 PM ships today, after 2 PM next shipping day', () => {
  assert.strictEqual(g.dueDay(at('2026-11-09T13:59:00')), '2026-11-09');
  assert.strictEqual(g.dueDay(at('2026-11-09T14:00:00')), '2026-11-09');
  assert.strictEqual(g.dueDay(at('2026-11-09T14:01:00')), '2026-11-10');
});

test('no shipping on Sundays: Saturday afternoon and all of Sunday ship Monday', () => {
  assert.strictEqual(g.dueDay(at('2026-11-07T10:00:00')), '2026-11-07');
  assert.strictEqual(g.dueDay(at('2026-11-07T15:00:00')), '2026-11-09');
  assert.strictEqual(g.dueDay(at('2026-11-08T10:00:00')), '2026-11-09');
});

test('bank holidays are skipped like Sundays', () => {
  const hol = new Set(['2026-11-10']);
  assert.strictEqual(g.dueDay(at('2026-11-09T15:00:00'), hol), '2026-11-11');
  assert.strictEqual(g.dueDay(at('2026-11-10T09:00:00'), hol), '2026-11-11');
  assert.strictEqual(g.isShippingDay('2026-11-10', hol), false);
});

test('ready: confirmed COD with a full address', () => {
  assert.deepStrictEqual(g.blockReasons(order()), []);
});

test('ready: prepaid ships without a confirmation', () => {
  assert.deepStrictEqual(g.blockReasons(order({ payment_method: 'Prepaid', confirmation_status: 'pending' })), []);
  assert.deepStrictEqual(g.blockReasons(order({ converted_to_prepaid: true, confirmation_status: 'pending' })), []);
});

test('blocked reasons, one by one', () => {
  assert.deepStrictEqual(g.blockReasons(order({ confirmation_status: 'pending' })), ['unconfirmed']);
  assert.deepStrictEqual(g.blockReasons(order({ confirmation_status: 'cancelled', order_status: 'cancelled' })), ['cancelled']);
  assert.deepStrictEqual(g.blockReasons(order({ is_duplicate: true })), ['duplicate']);
  assert.deepStrictEqual(g.blockReasons(order({ awb_number: 'A1' })), ['already_shipped']);
  assert.deepStrictEqual(g.blockReasons(order({ order_status: 'ndr' })), ['already_shipped']);
});

test('short address blocks unless it was fixed; prepaid short address is also held', () => {
  const short = { shipping_address1: 'Rampur', shipping_city: '', shipping_province: '' };
  assert.deepStrictEqual(g.blockReasons(order(short)), ['short_address']);
  assert.deepStrictEqual(g.blockReasons(order({ ...short, address_fixed: true })), []);
  assert.deepStrictEqual(g.blockReasons(order({ ...short, payment_method: 'Prepaid' })), ['short_address']);
});

test('evaluate: ready, blocked, chase and wrong-ship', () => {
  const now = at('2026-11-11T11:00:00');   // Wednesday
  const orders = [
    order({ id: 'ok-today', confirmed_at: at('2026-11-11T09:00:00') }),
    order({ id: 'ok-late', confirmed_at: at('2026-11-09T10:00:00') }),
    order({ id: 'ok-after2', confirmed_at: at('2026-11-10T15:00:00') }),
    order({ id: 'cod-unconf', confirmation_status: 'pending' }),
    order({ id: 'wrong-unconf', confirmation_status: 'pending', awb_number: 'A9' }),
    order({ id: 'wrong-cancel', confirmation_status: 'cancelled', order_status: 'cancelled', awb_number: 'A8' }),
    order({ id: 'fine-shipped', awb_number: 'A7' }),
  ];
  const r = g.evaluate(orders, { now });
  assert.deepStrictEqual(r.ready.map(x => x.id), ['ok-late', 'ok-after2', 'ok-today']);
  assert.deepStrictEqual(r.ready.map(x => x.ship_status), ['overdue', 'due_today', 'due_today']);
  assert.deepStrictEqual(r.chase.map(x => x.id), ['ok-late', 'ok-after2', 'ok-today']);
  assert.deepStrictEqual(r.blocked.map(x => x.id), ['cod-unconf']);
  assert.deepStrictEqual(r.wrong.map(x => x.id).sort(), ['wrong-cancel', 'wrong-unconf']);
  assert.ok(r.wrong.every(x => !x.reasons.includes('already_shipped')));
});

test('orders ready before courier tracking began are untracked, not overdue', () => {
  const now = at('2026-11-11T16:00:00');
  const trackFrom = at('2026-11-11T12:30:00');
  const orders = [
    order({ id: 'old', confirmed_at: at('2026-11-09T10:00:00') }),
    order({ id: 'morning', confirmed_at: at('2026-11-11T09:00:00') }),
    order({ id: 'new', confirmed_at: at('2026-11-11T13:00:00') }),
    order({ id: 'old-pending', confirmation_status: 'pending', confirmed_at: null, shopify_created_at: at('2026-11-05T10:00:00') }),
  ];
  const r = g.evaluate(orders, { now, trackFrom });
  assert.deepStrictEqual(r.untracked.map(x => x.id), ['old', 'morning']);
  assert.deepStrictEqual(r.ready.map(x => x.id), ['new']);
  assert.deepStrictEqual(r.chase.map(x => x.id), ['new']);
  assert.deepStrictEqual(r.blocked.map(x => x.id), ['old-pending']);   // unconfirmed orders are still shown
  assert.deepStrictEqual(g.evaluate(orders, { now }).untracked, []);    // no cut-off: nothing is untracked
  const acc = g.accuracy(orders, { now, days: 7, trackFrom });
  assert.deepStrictEqual(acc.reduce((s, x) => s + x.due, 0), 1);
});

test('accuracy: on time, late, missed and waiting by due day', () => {
  const now = at('2026-11-11T11:00:00');
  const orders = [
    order({ id: 'a', confirmed_at: at('2026-11-09T10:00:00'), awb_number: 'A', first_courier_at: at('2026-11-09T18:00:00') }),
    order({ id: 'b', confirmed_at: at('2026-11-09T10:00:00'), awb_number: 'B', first_courier_at: at('2026-11-10T09:00:00') }),
    order({ id: 'c', confirmed_at: at('2026-11-09T10:00:00') }),
    order({ id: 'd', confirmed_at: at('2026-11-11T09:00:00') }),
    order({ id: 'e', confirmed_at: at('2026-11-09T10:00:00'), awb_number: 'E' }),
  ];
  const rows = g.accuracy(orders, { now, days: 7 });
  const mon = rows.find(r => r.day === '2026-11-09'), wed = rows.find(r => r.day === '2026-11-11');
  assert.deepStrictEqual([mon.due, mon.on_time, mon.late, mon.missed, mon.time_unknown], [4, 1, 1, 1, 1]);
  assert.deepStrictEqual([wed.due, wed.waiting], [1, 1]);
});

test('health: a silent courier feed is flagged', () => {
  const now = new Date('2026-11-11T06:00:00Z');
  assert.strictEqual(g.health({ lastCourierAt: null, lastOrderAt: now, now }).ok, false);
  assert.strictEqual(g.health({ lastCourierAt: new Date('2026-11-09T06:00:00Z'), lastOrderAt: now, now }).ok, false);
  assert.strictEqual(g.health({ lastCourierAt: new Date('2026-11-11T04:00:00Z'), lastOrderAt: new Date('2026-11-11T05:00:00Z'), now }).ok, true);
});
