const test = require('node:test');
const assert = require('node:assert');
const { core, buildFunnel, buildDays, buildPipeline } = require('../lib/funnel');

const T0 = new Date('2026-10-25T05:00:00Z');
const at = (h) => new Date(T0.getTime() + h * 3600e3);
const o = (calls, status = 'pending', extra = {}) => ({
  team: 'CC', status, order_status: 'new', dnc: false, callback_at: null, short: false, fixed: false, locked: false, is_duplicate: false,
  day: '2026-10-25', order_at: T0, decided_at: null, calls, call_times: calls.map((_, i) => at(1 + i)), ...extra,
});

// The example from the brief: 100 orders -> 80 attempted, 60 connected, 50 confirmed, 10 cancelled, 20 not connected.
function example() {
  const rows = [];
  for (let i = 0; i < 50; i++) rows.push(o(['confirmed'], 'confirmed', { decided_at: at(2) }));
  for (let i = 0; i < 10; i++) rows.push(o(['cancelled'], 'cancelled', { decided_at: at(2) }));
  for (let i = 0; i < 10; i++) rows.push(o(['dnp', 'dnp', 'dnp']));   // not connected, 3 attempts
  for (let i = 0; i < 6; i++) rows.push(o(['dnp', 'dnp']));           // not connected, 2 attempts
  for (let i = 0; i < 4; i++) rows.push(o(['dnp']));                  // not connected, 1 attempt
  for (let i = 0; i < 20; i++) rows.push(o([]));                      // never called
  return rows;
}

test('funnel matches the worked example (100 / 80 / 60 / 50 / 10 / 20)', () => {
  const f = buildFunnel(example());
  assert.equal(f.total_orders, 100);
  assert.equal(f.attempted, 80);   assert.equal(f.attempted_pct, 80);
  assert.equal(f.connected, 60);   assert.equal(f.connected_pct, 60);
  assert.equal(f.confirmed, 50);   assert.equal(f.confirmed_pct, 50);
  assert.equal(f.cancelled, 10);   assert.equal(f.cancelled_pct, 10);
  assert.equal(f.not_connected, 20); assert.equal(f.not_connected_pct, 20);
  assert.equal(f.nc_2nd, 16);      assert.equal(f.nc_3rd, 10);
  assert.equal(f.nc_2nd_of_nc_pct, 80); assert.equal(f.nc_3rd_of_nc_pct, 50);
  assert.equal(f.not_attempted, 20);
});

test('notes and link-sent rows never count as calls (they are filtered out before the engine)', () => {
  // The engine only receives real calls; an order with zero real calls is "not attempted".
  const f = buildFunnel([o([], 'pending')]);
  assert.equal(f.attempted, 0);
  assert.equal(f.total_attempts, 0);
});

test('wrong number is an attempt but not a connection', () => {
  const f = buildFunnel([o(['wrong_number'], 'wrong_number')]);
  assert.equal(f.attempted, 1);
  assert.equal(f.connected, 0);
  assert.equal(f.not_connected, 1);
  assert.equal(f.other_closed, 1);
});

test('an order that connects on the second try is connected, not "not connected"', () => {
  const f = buildFunnel([o(['dnp', 'confirmed'], 'confirmed', { decided_at: at(3) })]);
  assert.equal(f.connected, 1);
  assert.equal(f.not_connected, 0);
  assert.equal(f.connected_on_2nd, 1);
  assert.equal(f.attempts[1].dnp, 1);
  assert.equal(f.attempts[2].connected, 1);
});

test('confirmed without any call (WhatsApp / IVR / paid online) is kept out of the call funnel and shown separately', () => {
  const f = buildFunnel([o([], 'confirmed'), o([], 'cancelled'), o(['dnp'], 'confirmed')]);
  assert.equal(f.confirmed, 0);                 // nobody was spoken to
  assert.equal(f.confirmed_without_call, 2);    // includes the one that only had a DNP call
  assert.equal(f.cancelled, 0);
  assert.equal(f.cancelled_without_call, 1);
  assert.equal(f.connected, 0);
});

test('if you dialled 100, confirmed can never be 150: confirmed + cancelled never exceed connected, which never exceeds attempted', () => {
  const rows = [];
  for (let i = 0; i < 100; i++) rows.push(o(i < 60 ? ['confirmed'] : ['dnp'], i < 60 ? 'confirmed' : 'pending'));   // 100 dialled, 60 spoke
  for (let i = 0; i < 90; i++) rows.push(o([], 'confirmed'));                                                         // 90 more confirmed by WhatsApp / payment, never called
  const f = buildFunnel(rows);
  assert.equal(f.attempted, 100);
  assert.equal(f.connected, 60);
  assert.equal(f.confirmed, 60);
  assert.equal(f.confirmed_without_call, 90);
  assert.ok(f.confirmed + f.cancelled <= f.connected);
  assert.ok(f.connected <= f.attempted);
});

test('turnaround times', () => {
  const f = buildFunnel([o(['dnp', 'callback', 'confirmed'], 'confirmed', { decided_at: at(5) })]);
  assert.equal(f.tat.order_to_1st, 120);       // first connected call is call #2 at +2h
  assert.equal(f.tat.first_to_2nd, 60);
  assert.equal(f.tat.order_to_decision, 300);
  assert.equal(f.tat_fmt.order_to_1st, '2h 0m');
});

test('daily rows split by order day and each add up', () => {
  const rows = [o(['confirmed'], 'confirmed'), o([]), o(['dnp'], 'pending', { day: '2026-10-26' })];
  const d = buildDays(rows);
  assert.deepEqual(d.map(x => x.day), ['2026-10-25', '2026-10-26']);
  assert.equal(d[0].total_orders, 2);
  assert.equal(d[1].not_connected, 1);
  assert.equal(d.reduce((s, x) => s + x.total_orders, 0), rows.length);
});

test('lead board: mutually exclusive buckets that add up to the total', () => {
  const now = new Date('2026-10-25T12:00:00Z');
  const rows = [
    o([]),                                                         // fresh
    o(['dnp']), o(['dnp', 'dnp']), o(['dnp', 'dnp', 'dnp', 'dnp']), // not connected 1 / 2 / 3+
    o(['callback'], 'pending', { callback_at: new Date('2026-10-25T10:00:00Z') }), // callback due
    o(['callback'], 'pending', { callback_at: new Date('2026-10-26T10:00:00Z') }), // callback later
    o(['address_fix'], 'pending'),                                  // connected, still open
    o(['confirmed'], 'confirmed'), o(['cancelled'], 'cancelled'), o(['wrong_number'], 'wrong_number'),
    o(['dnp'], 'unreachable'), o(['dnc'], 'pending', { dnc: true }),
  ];
  const p = buildPipeline(rows, now);
  assert.equal(p.fresh, 1);
  assert.equal(p.not_connected, 3);
  assert.deepEqual([p.nc_1, p.nc_2, p.nc_3_plus], [1, 1, 1]);
  assert.equal(p.callback_due, 1); assert.equal(p.callback_later, 1);
  assert.equal(p.in_progress, 1);
  assert.equal(p.confirmed, 1); assert.equal(p.cancelled, 1); assert.equal(p.wrong_number, 1); assert.equal(p.unreachable, 1); assert.equal(p.dnc, 1);
  assert.equal(p.to_call_now, 1 + 3 + 1);
  const sum = p.fresh + p.not_connected + p.callback_due + p.callback_later + p.in_progress + p.confirmed + p.cancelled + p.wrong_number + p.unreachable + p.dnc;
  assert.equal(sum, p.total_orders);
});

test('short addresses: only unfixed, unshipped, unlocked orders need fixing; confirmed ones are urgent', () => {
  const rows = [
    o([], 'pending', { short: true }),                                 // open, pending
    o(['confirmed'], 'confirmed', { short: true }),                    // open, confirmed -> urgent
    o(['confirmed'], 'confirmed', { short: true, fixed: true }),       // fixed
    o(['confirmed'], 'confirmed', { short: true, order_status: 'shipped' }), // already shipped
    o(['confirmed'], 'confirmed', { short: true, locked: true }),      // AWB made, address locked
    o(['cancelled'], 'cancelled', { short: true }),                    // cancelled
    o(['dnp'], 'unreachable', { short: true }),                        // dead lead: nobody can fix it
    o(['wrong_number'], 'wrong_number', { short: true }),              // dead lead
    o([], 'pending', { short: true, dnc: true }),                      // do not call
    o(['confirmed'], 'confirmed', { short: true, shipped: true }),     // shipped (flag), order_status still "new"
  ];
  const p = buildPipeline(rows);
  assert.equal(p.short_open, 2);
  assert.equal(p.short_open_pending, 1);
  assert.equal(p.short_open_confirmed, 1);
  assert.equal(p.short_fixed, 1);
});

test('fresh orders are split by age and the age buckets always add up to fresh', () => {
  const now = new Date('2026-10-28T12:00:00Z');
  const ago = (h) => new Date(now.getTime() - h * 3600e3);
  const p = buildPipeline([
    o([], 'pending', { order_at: ago(2) }), o([], 'pending', { order_at: ago(30) }), o([], 'pending', { order_at: ago(50) }), o([], 'pending', { order_at: ago(100) }),
    o(['dnp'], 'pending', { order_at: ago(5) }),                       // called: not fresh
    o([], 'pending', { order_at: ago(6), callback_at: ago(-1) }),      // callback booked: not fresh
  ], now);
  assert.equal(p.fresh, 4);
  assert.deepEqual(p.fresh_age, { under_1d: 1, d1_to_3: 2, over_3d: 1 });
  assert.equal(p.fresh_age.under_1d + p.fresh_age.d1_to_3 + p.fresh_age.over_3d, p.fresh);
});

test('second / third attempt: how many are done and how many are still due', () => {
  const f = buildFunnel([
    o(['dnp']), o(['dnp']), o(['dnp']),                    // 3 orders with only 1 call: 2nd attempt still due
    o(['dnp', 'dnp']), o(['dnp', 'dnp']),                  // 2 orders with 2 calls: 2nd done, 3rd still due
    o(['dnp', 'dnp', 'dnp']),                              // 1 order with 3 calls: 3rd done
    o(['dnp', 'confirmed'], 'confirmed'),                  // connected on the 2nd try: not a "not connected" order
  ]);
  assert.equal(f.not_connected, 6);
  assert.equal(f.nc_2nd, 3);                 // 2nd attempt done
  assert.equal(f.nc_2nd_pending, 3);         // 2nd attempt still due
  assert.equal(f.nc_3rd, 1);                 // 3rd attempt done
  assert.equal(f.nc_3rd_pending, 2);         // 3rd attempt still due
  const day = buildDays([{ ...o(['dnp']) }, { ...o(['dnp', 'dnp']) }])[0];
  assert.equal(day.nc_2nd_pending, 1);
  assert.equal(day.nc_3rd_pending, 1);
});

test('empty input never divides by zero', () => {
  const f = buildFunnel([]);
  assert.equal(f.total_orders, 0);
  assert.equal(f.connected_pct, 0);
  assert.equal(buildPipeline([]).pct.fresh, 0);
});
