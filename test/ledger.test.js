const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../lib/ledger');

const at = (s) => new Date(s + '+05:30');
const NOW = at('2026-11-23T12:00:00');
const o = (id, team, status, placed, extra = {}) => ({ id, order_name: '#' + id, amount: 599, team, status, order_at: at(placed), decided_at: extra.decided ? at(extra.decided) : null, actor: extra.actor || null, actor_role: extra.role || null });
const t = (when, team, connected = false) => ({ t: at(when), team, connected });

// Aman's leads: a1 reached by Aman and confirmed by him; a2 no answer from Aman, then WhatsApp confirmed it; a3 tried by Aman, nobody answered; a4 never tried and waiting 30 minutes
// Call centre's leads: c1 reached by the IVR (key press) and confirmed by it; c2 cancelled by the call centre; c3 never tried, waiting 30 hours; c4 closed by the sheet, never tried
const rows = [
  o('a1', 'InHouse', 'confirmed', '2026-11-23T09:00:00', { decided: '2026-11-23T09:30:00', actor: 'Aman', role: 'aman' }),
  o('a2', 'InHouse', 'confirmed', '2026-11-23T08:00:00', { decided: '2026-11-23T11:00:00', actor: 'whatsapp' }),
  o('a3', 'InHouse', 'pending', '2026-11-23T08:30:00'),
  o('a4', 'InHouse', 'pending', '2026-11-23T11:30:00'),
  o('c1', 'CC', 'confirmed', '2026-11-22T20:00:00', { decided: '2026-11-23T08:00:00', actor: 'ivr_call' }),
  o('c2', 'CC', 'cancelled', '2026-11-22T10:00:00', { decided: '2026-11-22T12:00:00', actor: 'Priya', role: 'agent' }),
  o('c3', 'CC', 'pending', '2026-11-22T06:00:00'),
  o('c4', 'CC', 'confirmed', '2026-11-22T09:00:00', { decided: '2026-11-22T10:00:00', actor: 'sheet' }),
];
const touches = new Map([
  ['a1', [t('2026-11-23T09:10:00', 'aman', true)]],
  ['a2', [t('2026-11-23T08:30:00', 'aman'), t('2026-11-23T10:30:00', 'wa', true)]],
  ['a3', [t('2026-11-23T09:00:00', 'aman'), t('2026-11-23T10:00:00', 'ivr')]],
  ['c1', [t('2026-11-23T07:30:00', 'ivr', true)]],
  ['c2', [t('2026-11-22T11:00:00', 'cc', true)]],
]);

test('ledger: every order gets one team, one result and one credited channel', () => {
  const led = L.buildLedger(rows, touches, NOW), by = Object.fromEntries(led.map(x => [x.id, x]));
  assert.equal(led.length, 8);
  assert.deepEqual([by.a1.team, by.a1.status, by.a1.reached_by, by.a1.credit, by.a1.decided_by], ['aman', 'confirmed', 'aman', 'aman', 'aman']);
  assert.deepEqual([by.a2.reached_by, by.a2.credit, by.a2.decided_by, by.a2.tries.aman, by.a2.tries.wa], ['wa', 'wa', 'wa', 1, 1]);   // Aman got no answer, WhatsApp reached and confirmed: WhatsApp's credit
  assert.deepEqual([by.a3.connected, by.a3.credit, by.a3.last_try_by, by.a3.status], [false, 'ivr', 'ivr', 'not_confirmed']);          // nobody answered: the channel that tried last holds it
  assert.deepEqual([by.a4.attempted, by.a4.credit, by.a4.wait_bucket], [false, null, 'lt1h']);                                          // 30 minutes old: not late yet
  assert.equal(by.c3.age_hours, 30); assert.equal(by.c3.wait_bucket, 'gt24');                                                          // placed 30 hours ago and nobody has tried it: late
  assert.deepEqual([by.c4.attempted, by.c4.decided_by, by.c4.wait_bucket], [false, 'sheet', null]);                                      // closed by the sheet with no attempt
  assert.equal(L.waitBucket(0.5), 'lt1h'); assert.equal(L.waitBucket(3), 'h1_6'); assert.equal(L.waitBucket(12), 'h6_24'); assert.equal(L.waitBucket(30), 'gt24');
});

test('ledger: the numbers add up, for everyone together and for each team', () => {
  const S = L.summarize(L.buildLedger(rows, touches, NOW)), T = S.total, A = S.teams.aman, C = S.teams.cc;
  assert.equal(T.leads, 8); assert.equal(A.leads, 4); assert.equal(C.leads, 4);
  assert.deepEqual([T.attempted, T.connected, T.tried_not_reached, T.not_attempted], [5, 4, 1, 3]);
  assert.deepEqual(T.reached, { aman: 1, cc: 1, ivr: 1, wa: 1 }); assert.deepEqual(T.tried_by, { aman: 0, cc: 0, ivr: 1, wa: 0 });
  assert.deepEqual([A.reached.aman, A.reached.wa, A.tried_not_reached, A.not_attempted, A.waiting], [1, 1, 1, 1, 1]);                 // Aman's 4 leads: his own 1, WhatsApp's 1, the IVR holds 1, one waiting
  assert.deepEqual([C.reached.ivr, C.reached.cc, C.not_attempted, C.waiting, C.closed_without_attempt], [1, 1, 2, 1, 1]);
  assert.deepEqual([T.confirmed, T.cancelled, T.not_confirmed], [4, 1, 3]);
  assert.deepEqual([T.confirmed_by.aman, T.confirmed_by.wa, T.confirmed_by.ivr, T.confirmed_by.sheet, T.cancelled_by.cc], [1, 1, 1, 1, 1]);
  assert.deepEqual(T.wait_age, { lt1h: 1, h1_6: 0, h6_24: 0, gt24: 1 });
  assert.deepEqual(A.own.aman, { tried: 3, reached: 1, confirmed: 1, cancelled: 0 });                                                   // Aman's own work: he tried a1, a2, a3, reached a1 only
  const c = L.checks(S); assert.equal(c.ok, true); assert.equal(c.failed, 0); assert.ok(c.list.length >= 9);
});

test('checks: a broken total turns the check red and says which one', () => {
  const S = L.summarize(L.buildLedger(rows, touches, NOW)); S.total.attempted += 1;
  const c = L.checks(S, { legacy: { attempted: 5, connected: 4, confirmed: 4 }, sheet_rows: 7 });
  assert.equal(c.ok, false); const bad = c.list.filter(x => !x.ok).map(x => x.name);
  assert.ok(bad.includes('Attempted + not attempted = all COD orders')); assert.ok(bad.includes('Home funnel agrees with the ledger: attempted')); assert.ok(bad.includes('Backup sheet would hold the same orders'));
  const good = L.checks(L.summarize(L.buildLedger(rows, touches, NOW)), { legacy: { attempted: 5, connected: 4, confirmed: 4 }, sheet_rows: 8 }); assert.equal(good.ok, true);
});

test('by age: each day is judged at the same age, and an order too young for a window is left out of it', () => {
  const led = L.buildLedger([
    o('x1', 'CC', 'confirmed', '2026-11-20T09:00:00', { decided: '2026-11-20T10:00:00' }),      // confirmed in 1 hour
    o('x2', 'CC', 'confirmed', '2026-11-20T09:00:00', { decided: '2026-11-21T09:00:00' }),      // confirmed in 24 hours
    o('x3', 'CC', 'pending', '2026-11-20T09:00:00'),                                           // still open after 3 days
    o('y1', 'CC', 'pending', '2026-11-23T11:00:00'),                                           // placed an hour ago
  ], new Map(), NOW);
  const d = L.byAge(led, NOW), d20 = d.find(x => x.day === '2026-11-20'), d23 = d.find(x => x.day === '2026-11-23');
  assert.deepEqual([d20.orders, d20.h2, d20.h2_of, d20.h24, d20.h48, d20.h48_of], [3, 1, 3, 2, 2, 3]);
  assert.equal(d20.h2_pct, 33.3); assert.equal(d20.h48_pct, 66.7);
  assert.deepEqual([d23.orders, d23.h2_of, d23.h24_of], [1, 0, 0]); assert.equal(d23.h2_pct, null);                                   // too young: not counted as a failure
});

test('order-wise sheet: one row per order with every attempt, who reached the customer and the result', () => {
  const led = L.buildLedger(rows, touches, NOW), rowsOut = L.csvRows(led), head = L.CSV_HEAD;
  assert.equal(rowsOut.length, 8); assert.equal(rowsOut[0].length, head.length);
  const a2 = rowsOut.find(r => r[0] === '#a2'); assert.deepEqual(a2.slice(3, 6), ['Aman', 'Confirmed', 'WhatsApp']); assert.deepEqual(a2.slice(7, 11), [1, 0, 0, 1]); assert.deepEqual(a2.slice(11, 16), ['Yes', 'Yes', 'WhatsApp', 'WhatsApp', 'WhatsApp']);
  const c3 = rowsOut.find(r => r[0] === '#c3'); assert.equal(c3[4], 'Not confirmed'); assert.equal(c3[11], 'No'); assert.equal(c3[17], 'over 24 hours');
  assert.equal(L.decidedBy({ actor: 'whatsapp_late' }), 'wa'); assert.equal(L.decidedBy({ actor: 'Admin', actor_role: 'admin' }), 'aman'); assert.equal(L.decidedBy({}), 'other');
});


test('by day: the same numbers for each order date, for everyone or for one team', () => {
  const led = L.buildLedger(rows, touches, NOW), all = L.byDay(led), aman = L.byDay(led, 'aman');
  assert.deepEqual(all.map(d => d.day), ['2026-11-22', '2026-11-23']); assert.deepEqual(all.map(d => d.leads), [4, 4]);
  assert.equal(all.reduce((s, d) => s + d.confirmed, 0), 4);                                  // the days add up to the total
  assert.deepEqual(aman.map(d => [d.day, d.leads]), [['2026-11-23', 4]]);
});

test('definitions: the plain-words text names exactly the caller results that count as connected', () => {
  const cfg = require('../lib/config'), d = Object.fromEntries(L.definitions(cfg.CONNECTED_DISPOSITIONS, cfg.CALL_DISPOSITIONS));
  assert.ok(d['Attempt'] && d['Connected (reached)'] && d['Not connected'] && d['Not attempted'] && d['Reached by / credited to'] && d['Confirmed / Cancelled'] && d['Not confirmed']);
  for (const x of ['confirmed', 'cancelled', 'asked for a callback', 'address fixed', 'asked not to be called', 'escalated']) assert.match(d['Connected (reached)'], new RegExp(x));
  assert.doesNotMatch(d['Connected (reached)'], /no answer|wrong number/);                       // no answer and a wrong number never count as reaching the customer
  assert.match(d['Not connected'], /no answer \(DNP\)/); assert.match(d['Not connected'], /wrong number/);
  assert.deepEqual(cfg.CONNECTED_DISPOSITIONS.sort(), ['address_fix', 'callback', 'cancelled', 'confirmed', 'dnc', 'escalated']);   // changing this list changes the meaning of "connected": it must be a decision, so this test fails first
});