const test = require('node:test');
const assert = require('node:assert');
const { buildTeamReport } = require('../lib/teamReport');
const { summarise } = require('../lib/ivrReport');

const at = (s) => new Date(s + '+05:30');
const NOW = at('2026-11-12T12:00:00');
const order = (id, team, status, extra = {}) => ({ id, team, status, day: '2026-11-11', order_at: at('2026-11-11T09:00:00'), actor: null, actor_role: null, shipped: false, rto: false, ...extra });

const rows = [
  order('A1', 'InHouse', 'confirmed', { actor: 'Aman', actor_role: 'aman', shipped: true }),
  order('A2', 'InHouse', 'confirmed', { actor: 'whatsapp', shipped: true, rto: true }),
  order('A3', 'InHouse', 'cancelled', { actor: 'Aman', actor_role: 'aman' }),
  order('A4', 'InHouse', 'pending'),
  order('C1', 'CC', 'confirmed', { actor: 'ivr_call' }),
  order('C2', 'CC', 'pending'),
];
const calls = new Map([['A1', [{ d: 'confirmed', t: at('2026-11-11T10:00:00'), team: 'aman', agent: 'Aman' }]], ['A3', [{ d: 'cancelled', t: at('2026-11-11T10:30:00'), team: 'aman', agent: 'Aman' }]], ['A4', [{ d: 'dnp', t: at('2026-11-11T11:00:00'), team: 'aman', agent: 'Aman' }]]]);

test('a team card counts confirmed, cancelled, shipped and RTO the same way for every channel that confirmed', () => {
  const m = buildTeamReport(rows, calls, {}, { now: NOW }).aman.metrics;
  assert.equal(m.leads, 4);
  assert.equal(m.confirmed_any, 2); assert.equal(m.confirmed_any_pct, 50);          // A1 by Aman and A2 on WhatsApp: both are confirmed orders of this team
  assert.equal(m.cancelled_any, 1); assert.equal(m.cancelled_any_pct, 25);
  assert.equal(m.shipped, 2); assert.equal(m.shipped_pct_of_confirmed, 100);
  assert.equal(m.rto, 1); assert.equal(m.rto_pct_of_shipped, 50);
  assert.equal(m.not_connected, 1); assert.equal(m.not_reached_pct, 25);             // A4 was called and nobody picked up
});

test('the all-channels card has shipped, RTO, cancelled and their percentages', () => {
  const C = buildTeamReport(rows, calls, {}, { now: NOW }).channels;
  assert.equal(C.totals.cod, 6); assert.equal(C.totals.shipped, 2); assert.equal(C.totals.rto, 1);
  assert.equal(C.totals.confirmed_total, 3); assert.equal(C.confirmed_pct, 50);
  assert.equal(C.cancelled_total, 1); assert.equal(C.cancelled_pct, 16.7);
  assert.equal(C.shipped_pct_of_confirmed, 66.7); assert.equal(C.rto_pct_of_shipped, 50);
  assert.equal(C.channels.find(x => x.key === 'ivr').confirmed, 1);                  // the IVR confirmation is counted once, under IVR
});

test('a team with no orders shows empty percentages, not zeros or errors', () => {
  const m = buildTeamReport([], new Map(), {}, { now: NOW }).cc.metrics;
  assert.equal(m.leads, 0); assert.equal(m.confirmed_any_pct, null); assert.equal(m.shipped_pct_of_confirmed, null); assert.equal(m.rto_pct_of_shipped, null);
});

test('IVR report: answered means a key was pressed, no key is the rest, and cancel requests are only counted', () => {
  const r = summarise([{ day: '2026-11-19', orders_called: 18, placed: 20, k1: 7, k2: 1, k3: 2, confirmed_applied: 6, left_to_person: 3, failed: 1 },
    { day: '2026-11-20', orders_called: 10, placed: 10, k1: 2, k2: 0, k3: 0, confirmed_applied: 2, left_to_person: 0, failed: 0 }]);
  assert.equal(r.totals.placed, 30); assert.equal(r.totals.pressed, 12); assert.equal(r.totals.pressed_pct, 40);
  assert.equal(r.totals.k1, 9); assert.equal(r.totals.k3, 2); assert.equal(r.totals.no_key, 18);
  assert.equal(r.totals.confirm_pct_of_placed, 30); assert.equal(r.totals.confirmed_applied, 8);
  assert.equal(r.days[0].pressed_pct, 50); assert.equal(r.days[0].no_key, 10);
  assert.equal(summarise([]).totals.pressed_pct, null);
});
