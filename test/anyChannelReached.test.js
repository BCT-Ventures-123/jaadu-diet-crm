const test = require('node:test');
const assert = require('node:assert/strict');
const r2 = require('../lib/report2');
const sc = require('../lib/scorecard');
const cr = require('../lib/codReport');
const ledger = require('../lib/ledger');
const ct = require('../lib/controlTower');

// Owner 2026-11-25: connected = the customer answered on ANY channel (a call, an IVR key, a WhatsApp reply). Every page must use that one rule.
const at = (h) => new Date(`2026-11-25T${String(h).padStart(2, '0')}:00:00+05:30`);
const row = (id, status, calls = [], extra = {}) => ({ id, order_name: '#' + id, day: '2026-11-25', order_at: at(8), decided_at: status === 'pending' ? null : at(11), status, calls, call_times: calls.map((_, i) => at(9 + i)), actor: null, actor_role: null, amount: 599, team: 'CC', ...extra });
const rows = [row(1, 'pending', ['dnp']), row(2, 'pending'), row(3, 'pending'), row(4, 'confirmed', ['confirmed'], { actor: 'Priya', actor_role: 'agent' })];
// order 2: answered on WhatsApp (a reply, not decided); order 3: pressed a key on the IVR (not decided); order 1: only a no-answer call
const touches = new Map([[1, [{ t: at(9), team: 'cc', connected: false }]], [2, [{ t: at(10), team: 'wa', connected: true }]], [3, [{ t: at(10), team: 'ivr', connected: true }]], [4, [{ t: at(9), team: 'cc', connected: true }]]]);

test('connectedAtOf: the first time the customer answered, on any channel', () => {
  const m = cr.connectedAtOf(touches);
  assert.deepEqual([...m.keys()].sort(), [2, 3, 4]); assert.equal(m.get(2).getTime(), at(10).getTime());
});

test('Overview: a customer who answered on WhatsApp or IVR but has not decided is reached, the same as the ledger says', () => {
  const led = ledger.buildLedger(rows, touches, new Date('2026-11-25T12:00:00Z'));
  const connected = ledger.summarize(led).total.connected;
  assert.equal(connected, 3);
  assert.equal(r2.buildReport2(rows, [], 1).overview.reached, 1);                                     // old rule: calls and decisions only (the two orders that answered but did not decide were missing)
  const o = r2.buildReport2(rows, [], 1, cr.connectedAtOf(touches)).overview;
  assert.equal(o.reached, connected); assert.equal(o.connectivity_pct, 75);                            // 3 of 4, the same as the ledger
  assert.equal(r2.buildReport2(rows, [], 1, cr.connectedAtOf(touches)).daily[0].reached, 3);
});

test('Scoreboard goal: reached counts the same customers', () => {
  const g = sc.buildGoal(rows, cr.connectedAtOf(touches));
  assert.equal(g.reached, 3); assert.equal(g.not_reached, 1); assert.equal(g.spoke_pending, 2);
  assert.equal(sc.buildGoal(rows).reached, 1);                                                          // without the ledger the old rule
});

test('Control Tower: called, reached and the "never tried" action use the ledger numbers on the COD base', () => {
  const led = ledger.buildLedger([row(1, 'pending', [], { day: '2026-11-24', order_at: at(8) }), row(2, 'pending', [], { day: '2026-11-25' }), row(3, 'confirmed', ['confirmed'], { day: '2026-11-25', actor: 'Priya', actor_role: 'agent' })],
    new Map([[2, [{ t: at(10), team: 'wa', connected: true }]], [3, [{ t: at(9), team: 'cc', connected: true }]]]), new Date('2026-11-25T12:00:00Z'));
  const days = cr.asTowerDays(cr.build(led, { '2026-11-24': 4, '2026-11-25': 6 }, { today: '2026-11-25' }));
  assert.deepEqual(days.map(d => [d.day, d.cod, d.prepaid, d.total, d.needed_call]), [['2026-11-24', 1, 4, 5, 1], ['2026-11-25', 2, 6, 8, 2]]);
  const t = ct.buildControlTower({ e2e: { days }, team: null, ship: null, today: '2026-11-25' });
  const st = Object.fromEntries(t.stages.map(s => [s.key, s]));
  assert.equal(st.called.count, 2); assert.equal(st.called.pct, 66.7);                                  // 2 of 3 COD orders were tried (a WhatsApp reply and a call), one was never tried
  assert.equal(st.reached.count, 2); assert.equal(st.reached.pct, 66.7);
  assert.equal(st.confirmed.count, 1); assert.equal(st.confirmed.pct, 33.3);
  assert.ok(t.actions.some(a => /1 COD orders from earlier days were never tried/.test(a.text)));
});

test('Funnel & leads: the order counts come from the ledger (same as Home), and add up', () => {
  const led = ledger.buildLedger([row(1, 'pending', ['dnp']), row(2, 'pending'), row(3, 'pending'), row(4, 'confirmed', ['confirmed'], { actor: 'Priya', actor_role: 'agent' }), row(5, 'confirmed', [], { actor: 'whatsapp' }), row(6, 'pending')],
    new Map([[1, [{ t: at(9), team: 'cc', connected: false }, { t: at(12), team: 'wa', connected: false }]], [2, [{ t: at(10), team: 'wa', connected: true }]], [3, [{ t: at(10), team: 'ivr', connected: true }]], [4, [{ t: at(9), team: 'cc', connected: true }]], [5, [{ t: at(9), team: 'wa', connected: true }]]]), new Date('2026-11-25T12:00:00Z'));
  const f = cr.funnelFromLedger(led), S = ledger.summarize(led).total;
  assert.deepEqual([f.total_orders, f.attempted, f.not_attempted, f.connected, f.not_connected, f.confirmed, f.cancelled, f.pending], [6, 5, 1, 4, 1, 2, 0, 4]);
  assert.deepEqual([f.attempted, f.connected, f.not_connected, f.confirmed], [S.attempted, S.connected, S.tried_not_reached, S.confirmed]);          // the same numbers as the ledger the Home pages use
  assert.equal(f.connected + f.not_connected + f.not_attempted, f.total_orders); assert.equal(f.confirmed + f.cancelled + f.pending, f.total_orders);
  assert.equal(f.connected_pct, 66.7); assert.equal(f.confirmed_pct, 33.3); assert.equal(f.total_attempts, 6);                                       // calls, IVR and WhatsApp messages
  assert.equal(f.confirmed_without_call, 1);                                                                                                         // the one confirmed on WhatsApp
  assert.deepEqual([f.nc_2nd, f.nc_2nd_pending, f.nc_3rd], [1, 0, 0]); assert.equal(f.nc_2nd_of_nc_pct, 100);
  const empty = cr.funnelFromLedger([]); assert.equal(empty.total_orders, 0); assert.equal(empty.connected_pct, 0);
});

test('the Daily report rows: the retry lines sit on the not-connected orders (any channel) and add up', () => {
  const led = ledger.buildLedger([row(1, 'pending'), row(2, 'pending'), row(3, 'pending'), row(4, 'pending'), row(5, 'confirmed', ['confirmed'], { actor: 'P', actor_role: 'agent' })],
    new Map([[1, [{ t: at(9), team: 'cc', connected: false }]], [2, [{ t: at(9), team: 'cc', connected: false }, { t: at(12), team: 'wa', connected: false }]],
      [3, [{ t: at(9), team: 'cc', connected: false }, { t: at(12), team: 'ivr', connected: false }, { t: at(15), team: 'cc', connected: false }]], [5, [{ t: at(9), team: 'cc', connected: true }]]]), new Date('2026-11-25T12:00:00Z'));
  const r = cr.build(led, {}, { today: '2026-11-25' }), by = Object.fromEntries(r.table.map(x => [x.label.split(' (')[0], x]));
  assert.equal(by['Not connected'].count, 3);
  assert.deepEqual([by['Tried only once so far'].count, by['Tried 2 times'].count, by['Tried 3 or more times'].count], [1, 1, 1]);
  assert.equal(by['Tried 2 times'].pct, 33.3); assert.equal(by['Tried 2 times'].base, 'of not connected'); assert.equal(by['Tried 2 times'].sub, true);
  assert.equal(by['Tried only once so far'].count + by['Tried 2 times'].count + by['Tried 3 or more times'].count, by['Not connected'].count);
});
