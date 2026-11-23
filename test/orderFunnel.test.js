const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../lib/orderFunnel');

const at = (s) => new Date(s + '+05:30');
const o = (id, team, status, day) => ({ id, team, status, day });
const t = (when, team, connected) => ({ t: at(when), team, connected });

const rows = [
  o('o1', 'InHouse', 'confirmed', '2026-11-20'),   // Aman called, customer picked up, confirmed
  o('o2', 'CC', 'pending', '2026-11-20'),          // CC called three times, nobody picked up: 2nd the same day, 3rd the next day
  o('o3', 'CC', 'pending', '2026-11-20'),          // one call, nobody picked up
  o('o4', 'CC', 'pending', '2026-11-21'),          // never attempted, still waiting
  o('o5', 'CC', 'confirmed', '2026-11-21'),        // never attempted, confirmed by WhatsApp
  o('o6', 'CC', 'confirmed', '2026-11-21'),        // IVR call, key pressed, confirmed
  o('o7', 'InHouse', 'pending', '2026-11-21'),     // IVR no key, then Aman next day, connected
  o('o8', 'InHouse', 'cancelled', '2026-11-21'),   // Aman called, picked up, cancelled
];
const touches = new Map([
  ['o1', [t('2026-11-20T10:00:00', 'aman', true)]],
  ['o2', [t('2026-11-20T10:00:00', 'cc', false), t('2026-11-20T14:00:00', 'cc', false), t('2026-11-21T10:00:00', 'cc', false)]],
  ['o3', [t('2026-11-20T11:00:00', 'cc', false)]],
  ['o6', [t('2026-11-21T19:00:00', 'ivr', true)]],
  ['o7', [t('2026-11-21T19:30:00', 'ivr', false), t('2026-11-22T10:00:00', 'aman', true)]],
  ['o8', [t('2026-11-21T09:00:00', 'aman', true)]],
]);

test('funnel: every number of the standard report, with the owner\'s definitions', () => {
  const f = F.build(rows, touches, 'overall');
  assert.equal(f.orders, 8);
  assert.equal(f.attempted, 6); assert.equal(f.not_attempted, 2);
  assert.equal(f.closed_without_attempt, 1); assert.equal(f.waiting_for_first_attempt, 1);             // o5 was closed by WhatsApp, o4 still waits for its first call
  assert.equal(f.connected, 4); assert.equal(f.not_connected, 2);                                      // o1, o6, o7, o8 / o2, o3
  assert.equal(f.confirmed, 3); assert.equal(f.cancelled, 1); assert.equal(f.pending, 4);
  assert.equal(f.attempted + f.not_attempted, f.orders);                                                // the ladder adds up
  assert.ok(f.attempted >= f.connected && f.connected >= 0);
  assert.equal(f.attempted_pct, 75); assert.equal(f.connected_pct, 50); assert.equal(f.connected_of_attempted_pct, 66.7);
  assert.equal(f.confirmed_pct, 37.5);
});

test('funnel: the first attempt, and the second and third attempts on orders nobody picked up', () => {
  const f = F.build(rows, touches, 'overall');
  assert.equal(f.first_connected, 3); assert.equal(f.first_not_connected, 3);                           // o1, o6, o8 picked up first time; o2, o3, o7 did not
  assert.equal(f.nc_orders, 2);
  assert.equal(f.second_same_day, 1); assert.equal(f.second_later_day, 0); assert.equal(f.second_not_yet, 1);      // o2 had its 2nd call the same day; o3 has none yet
  assert.equal(f.third_same_day, 0); assert.equal(f.third_later_day, 1); assert.equal(f.third_not_yet, 1);        // o2's 3rd call was the next day
});

test('funnel: day by day uses the same definitions, and the days add up to the total', () => {
  const f = F.build(rows, touches, 'overall');
  assert.deepEqual(f.days.map(d => d.day), ['2026-11-20', '2026-11-21']);
  for (const k of ['orders', 'attempted', 'connected', 'not_connected', 'confirmed', 'cancelled', 'pending']) assert.equal(f.days.reduce((s, d) => s + d[k], 0), f[k], k);
  assert.equal(f.days[0].orders, 3); assert.equal(f.days[0].attempted, 3); assert.equal(f.days[0].connected, 1);
});

test('funnel: no orders gives zeros and no percentages (nothing divides by zero)', () => {
  const f = F.build([], new Map(), 'overall');
  assert.equal(f.orders, 0); assert.equal(f.attempted_pct, null); assert.deepEqual(f.days, []);
});

test('funnel: a call just after midnight India time counts as the next day', () => {
  const r = [o('x', 'CC', 'pending', '2026-11-20')];
  const tm = new Map([['x', [t('2026-11-20T23:50:00', 'cc', false), t('2026-11-21T00:10:00', 'cc', false)]]]);
  const f = F.build(r, tm, 'cc');
  assert.equal(f.second_same_day, 0); assert.equal(f.second_later_day, 1);
});


test('same-day shipping: orders placed before 1 PM and confirmed before the 2 PM lock', () => {
  const r = [
    { id: 's1', team: 'CC', status: 'confirmed', day: '2026-11-20', order_at: at('2026-11-20T09:00:00'), decided_at: at('2026-11-20T11:30:00') },   // confirmed in time: ships today
    { id: 's2', team: 'CC', status: 'confirmed', day: '2026-11-20', order_at: at('2026-11-20T10:00:00'), decided_at: at('2026-11-20T14:10:00') },   // confirmed 10 minutes after the lock
    { id: 's3', team: 'CC', status: 'confirmed', day: '2026-11-20', order_at: at('2026-11-20T12:00:00'), decided_at: at('2026-11-21T10:00:00') },   // confirmed the next day
    { id: 's4', team: 'CC', status: 'pending', day: '2026-11-20', order_at: at('2026-11-20T08:00:00'), decided_at: null },                          // still pending
    { id: 's5', team: 'CC', status: 'confirmed', day: '2026-11-20', order_at: at('2026-11-20T15:00:00'), decided_at: at('2026-11-20T15:30:00') },   // placed after 1 PM: cannot ship today, not in the pool
  ];
  const f = F.build(r, new Map(), 'overall');
  assert.equal(f.ship_pool, 4); assert.equal(f.same_day_confirmed, 1); assert.equal(f.pool_confirmed_late, 2); assert.equal(f.pool_not_confirmed, 1);
  assert.equal(f.same_day_confirmed_pct, 25);
  assert.equal(f.days[0].ship_pool, 4);                                                    // the same numbers day by day
  assert.equal(F.build([{ id: 'x', team: 'CC', status: 'confirmed', day: '2026-11-20' }], new Map(), 'overall').ship_pool, 0);   // a row without times is simply not counted
});

test('breakdown: the owner split and the "who reached the customer" split both add up exactly to the Overall report', () => {
  const r = [
    { id: 'a', team: 'InHouse', status: 'confirmed', day: '2026-11-22' }, { id: 'b', team: 'InHouse', status: 'pending', day: '2026-11-22' }, { id: 'c', team: 'CC', status: 'confirmed', day: '2026-11-22' },
    { id: 'd', team: 'CC', status: 'pending', day: '2026-11-22' }, { id: 'e', team: 'CC', status: 'pending', day: '2026-11-22' }, { id: 'f', team: 'CC', status: 'confirmed', day: '2026-11-22' },
  ];
  const tm = new Map([
    ['a', [{ t: at('2026-11-22T10:00:00'), team: 'aman', connected: true }]],
    ['b', [{ t: at('2026-11-22T10:00:00'), team: 'ivr', connected: false }, { t: at('2026-11-22T11:00:00'), team: 'aman', connected: false }]],       // attempted twice, nobody answered
    ['c', [{ t: at('2026-11-22T10:00:00'), team: 'cc', connected: false }, { t: at('2026-11-22T12:00:00'), team: 'ivr', connected: true }]],           // the IVR reached the customer
    ['d', []],                                                                                                                                       // nobody has tried
    ['f', [{ t: at('2026-11-22T09:00:00'), team: 'wa', connected: true }]],
  ]);
  const B = F.breakdown(r, tm), O = F.build(r, tm, 'overall');
  assert.equal(B.total.orders, O.orders); assert.equal(B.total.attempted, O.attempted); assert.equal(B.total.connected, O.connected); assert.equal(B.total.not_connected, O.not_connected); assert.equal(B.total.not_attempted, O.not_attempted);
  assert.equal(B.by_owner.aman.orders + B.by_owner.cc.orders + B.by_owner.other.orders, 6);
  assert.deepEqual([B.by_owner.aman.orders, B.by_owner.aman.connected, B.by_owner.aman.not_connected, B.by_owner.aman.not_attempted], [2, 1, 1, 0]);
  assert.deepEqual([B.by_owner.cc.orders, B.by_owner.cc.connected, B.by_owner.cc.not_connected, B.by_owner.cc.not_attempted], [4, 2, 0, 2]);
  assert.deepEqual([B.reach.aman, B.reach.cc, B.reach.ivr, B.reach.wa, B.reach.not_connected, B.reach.not_attempted], [1, 0, 1, 1, 1, 2]);
  assert.equal(B.reach.connected, O.connected);
  assert.equal(B.reach.aman + B.reach.cc + B.reach.ivr + B.reach.wa + B.reach.not_connected + B.reach.not_attempted, O.orders);                         // every order lands in exactly one row
  assert.equal(F.buildAll(r, tm).breakdown.total.orders, 6);
});


test('channel views: every order is counted under ONE channel, so Aman + Call centre + IVR + WhatsApp add up to Overall', () => {
  const O = F.build(rows, touches, 'overall'), V = ['aman', 'cc', 'ivr', 'wa'].map(k => F.build(rows, touches, k));
  const sum = (k) => V.reduce((s, v) => s + v[k], 0);
  assert.deepEqual(V.map(v => v.orders), [8, 8, 8, 8]);                                                              // every view is about the same orders
  assert.deepEqual(V.map(v => v.attempted), [3, 2, 1, 0]);                                                           // Aman o1, o7 (answered after an IVR no-key), o8; call centre o2, o3; IVR o6
  assert.deepEqual(V.map(v => v.connected), [3, 0, 1, 0]); assert.deepEqual(V.map(v => v.not_connected), [0, 2, 0, 0]);
  assert.equal(sum('attempted'), O.attempted); assert.equal(sum('connected'), O.connected); assert.equal(sum('not_connected'), O.not_connected);   // the four views add up to Overall
  for (const v of V) assert.equal(v.confirmed + v.cancelled + v.closed_by_others + v.pending, v.orders);              // each view adds up on its own too
  assert.equal(V[0].not_attempted, O.not_attempted);                                                                 // nobody tried these: the same orders in every view and in Overall
});

test('channel views: the credit goes to the channel that reached the customer, else the one that tried last', () => {
  const r = [{ id: 'x', team: 'CC', status: 'pending', day: '2026-11-22' }, { id: 'y', team: 'CC', status: 'pending', day: '2026-11-22' }];
  const tm = new Map([
    ['x', [{ t: at('2026-11-22T10:00:00'), team: 'ivr', connected: false }, { t: at('2026-11-22T11:00:00'), team: 'aman', connected: true }]],   // the IVR got no key, Aman then reached the customer
    ['y', [{ t: at('2026-11-22T10:00:00'), team: 'aman', connected: false }, { t: at('2026-11-22T11:00:00'), team: 'ivr', connected: false }]],  // nobody answered: the IVR tried last
  ]);
  assert.deepEqual(F.attribution(tm.get('x')), { channel: 'aman', connected: true }); assert.deepEqual(F.attribution(tm.get('y')), { channel: 'ivr', connected: false }); assert.equal(F.attribution([]), null);
  const a = F.build(r, tm, 'aman'), i = F.build(r, tm, 'ivr');
  assert.equal(a.attempted, 1); assert.equal(a.connected, 1); assert.equal(a.not_connected, 0);
  assert.equal(i.attempted, 1); assert.equal(i.connected, 0); assert.equal(i.not_connected, 1); assert.equal(i.nc_orders, 1); assert.equal(i.second_not_yet, 1);      // the IVR itself tried once
});

test('all channels: a WhatsApp reply is an attempt and a connection; confirmed and cancelled in a channel view are what THAT channel decided', () => {
  const r = [
    { id: 'a', team: 'CC', status: 'confirmed', day: '2026-11-22', actor: 'whatsapp', actor_role: null },       // confirmed by WhatsApp, nobody called
    { id: 'b', team: 'CC', status: 'confirmed', day: '2026-11-22', actor: 'Priya', actor_role: 'agent' },        // a caller connected and confirmed
    { id: 'c', team: 'InHouse', status: 'confirmed', day: '2026-11-22', actor: 'ivr_call', actor_role: null },  // IVR key press confirmed it
    { id: 'd', team: 'CC', status: 'pending', day: '2026-11-22' },                                               // nobody has tried
    { id: 'e', team: 'InHouse', status: 'confirmed', day: '2026-11-22', actor: 'sheet', actor_role: null },     // closed by the sheet, no attempt on any channel
  ];
  const tm = new Map([
    ['a', [{ t: at('2026-11-22T10:00:00'), team: 'wa', connected: true }]],
    ['b', [{ t: at('2026-11-22T10:00:00'), team: 'cc', connected: true }]],
    ['c', [{ t: at('2026-11-22T10:00:00'), team: 'ivr', connected: true }]],
  ]);
  const O = F.build(r, tm, 'overall');
  assert.equal(O.orders, 5); assert.equal(O.attempted, 3); assert.equal(O.not_attempted, 2); assert.equal(O.connected, 3); assert.equal(O.not_connected, 0);
  assert.equal(O.waiting_for_first_attempt, 1); assert.equal(O.closed_without_attempt, 1); assert.equal(O.confirmed, 4); assert.equal(O.pending, 1);
  const V = Object.fromEntries(['aman', 'cc', 'ivr', 'wa'].map(k => [k, F.build(r, tm, k)]));
  assert.deepEqual(['aman', 'cc', 'ivr', 'wa'].map(k => V[k].attempted), [0, 1, 1, 1]);
  assert.deepEqual(['aman', 'cc', 'ivr', 'wa'].map(k => V[k].confirmed), [0, 1, 1, 1]);                              // b, c, a: each decided by exactly one channel
  assert.deepEqual(['aman', 'cc', 'ivr', 'wa'].map(k => V[k].closed_by_others), [4, 3, 3, 3]);
  const sheet = O.confirmed - ['aman', 'cc', 'ivr', 'wa'].reduce((s, k) => s + V[k].confirmed, 0);
  assert.equal(sheet, 1);                                                                                             // order e: confirmed by the sheet, not by any channel row
  for (const k of Object.keys(V)) assert.equal(V[k].confirmed + V[k].cancelled + V[k].closed_by_others + V[k].pending, 5);
  assert.equal(F.decidedBy({ actor: 'whatsapp_late' }), 'wa'); assert.equal(F.decidedBy({ actor: 'Aman', actor_role: 'aman' }), 'aman'); assert.equal(F.decidedBy({ actor: 'Admin', actor_role: 'admin' }), 'aman'); assert.equal(F.decidedBy({}), 'other');
});

test('lead ladder: leads by attempt number, and on which attempt the customer was first reached', () => {
  const r = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, team: 'CC', status: 'pending', day: '2026-11-22' }));
  const tm = new Map([
    ['a', [{ t: at('2026-11-22T10:00:00'), team: 'ivr', connected: true }]],                                                                                  // reached on the 1st IVR call
    ['b', [{ t: at('2026-11-20T10:00:00'), team: 'ivr', connected: false }, { t: at('2026-11-21T10:00:00'), team: 'ivr', connected: true }]],                  // reached on the 2nd
    ['c', [{ t: at('2026-11-19T10:00:00'), team: 'ivr', connected: false }, { t: at('2026-11-20T10:00:00'), team: 'ivr', connected: false }, { t: at('2026-11-21T10:00:00'), team: 'ivr', connected: false }]],   // 3 tries, never reached
    ['d', [{ t: at('2026-11-22T11:00:00'), team: 'cc', connected: true }]],                                                                                   // a caller, not the IVR
  ]);
  const L = F.build(r, tm, 'ivr').ladder;
  assert.equal(L.orders, 5); assert.equal(L.tried, 3); assert.equal(L.connected, 2);
  assert.deepEqual(L.rows.map(x => x.leads), [3, 2, 1, 0, 0]);                                                      // 3 leads had a 1st IVR call, 2 a 2nd, 1 a 3rd
  assert.deepEqual(L.rows.map(x => x.connected_here), [1, 1, 0, 0, 0]); assert.deepEqual(L.rows.map(x => x.connected_so_far), [1, 2, 2, 2, 2]);
  assert.deepEqual(L.rows.map(x => x.not_connected_after), [2, 1, 1, 1, 1]);
  assert.equal(L.rows[0].leads_pct, 60); assert.equal(L.rows[1].connected_so_far_pct, 66.7);
  const all = F.build(r, tm, 'overall').ladder; assert.equal(all.tried, 4); assert.equal(all.rows[0].leads, 4);        // Overall counts every channel
  assert.equal(F.ladder([], new Map(), ['ivr']).tried_pct, null);
});