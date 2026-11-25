const test = require('node:test');
const assert = require('node:assert/strict');
const ledger = require('../lib/ledger');
const cr = require('../lib/codReport');

const NOW = new Date('2026-11-25T12:30:00Z');
const at = (d, h = 10) => new Date(`${d}T${String(h).padStart(2, '0')}:00:00+05:30`);
// One COD order: team, status, and the attempts (touches) it had. Day = India date of order_at.
const mk = (id, day, status, team = 'CC') => ({ id, order_name: '#' + id, amount: 599, team, status, order_at: at(day), decided_at: status === 'pending' ? null : at(day, 11), actor: status === 'confirmed' ? 'Priya' : null, actor_role: 'agent' });
const T = (team, connected, h = 10) => ({ t: at('2026-11-25', h), team, connected });

function fixture() {
  // 10 COD orders placed today: 6 confirmed (2 by call, 1 by IVR key, 2 by WhatsApp tap, 1 address-fix call), 1 cancelled on a call, 2 tried but nobody answered (a call and a WhatsApp message), 1 not tried yet.
  const rows = [mk(1, '2026-11-25', 'confirmed'), mk(2, '2026-11-25', 'confirmed'), mk(3, '2026-11-25', 'confirmed'), mk(4, '2026-11-25', 'confirmed'), mk(5, '2026-11-25', 'confirmed', 'InHouse'), mk(6, '2026-11-25', 'confirmed', 'InHouse'),
    mk(7, '2026-11-25', 'cancelled'), mk(8, '2026-11-25', 'pending'), mk(9, '2026-11-25', 'pending'), mk(10, '2026-11-25', 'pending')];
  const touches = new Map([[1, [T('cc', true)]], [2, [T('cc', true)]], [3, [T('ivr', true)]], [4, [T('wa', true)]], [5, [T('wa', true)]], [6, [T('aman', true)]], [7, [T('cc', true)]], [8, [T('cc', false)]], [9, [T('wa', false)]], [10, []]]);
  return ledger.buildLedger(rows, touches, NOW);
}

test('COD is the base: prepaid never enters a percentage, it is one separate line', () => {
  const r = cr.build(fixture(), { '2026-11-25': 12 }, { today: '2026-11-25' });
  assert.equal(r.base, 'COD'); assert.equal(r.orders, 10); assert.equal(r.prepaid, 12);
  const by = Object.fromEntries(r.table.map(x => [x.label.split(' (')[0], x]));
  assert.equal(by['COD orders'].count, 10); assert.equal(by['COD orders'].pct, 100);
  assert.equal(by['Prepaid orders'].count, 12); assert.equal(by['Prepaid orders'].pct, null);          // no percentage at all
  for (const x of r.table) if (x.label !== 'COD orders' && x.pct != null) assert.ok(x.pct <= 100, x.label + ' is a share of COD orders, never above 100');
});

test('every channel counts, and the lines add up to the COD orders', () => {
  const r = cr.build(fixture(), {}, { today: '2026-11-25' });
  const n = (k) => r.table.find(x => x.label.startsWith(k));
  assert.equal(n('Attempted').count, 9); assert.equal(n('Not attempted').count, 1);
  assert.equal(n('Connected').count, 7); assert.equal(n('Connected').pct, 70);                      // calls, the IVR key and WhatsApp taps all count
  assert.equal(n('Not connected').count, 2);
  assert.equal(n('Cancelled').count, 1); assert.equal(n('TOTAL CONFIRMATION').count, 6); assert.equal(n('TOTAL CONFIRMATION').pct, 60);
  assert.equal(n('Still open').count, 3);
  assert.equal(n('Connected').count + n('Not connected').count + n('Not attempted').count, r.orders);   // connected + not connected + not tried = COD orders
  assert.equal(n('TOTAL CONFIRMATION').count + n('Cancelled').count + n('Still open').count, r.orders);  // confirmed + cancelled + open = COD orders
  assert.ok(/WhatsApp 2/.test(n('Connected').hint) && /IVR 1/.test(n('Connected').hint) && /Aman 1/.test(n('Connected').hint) && /Call centre 3/.test(n('Connected').hint));
});

test('the 95 percent goal: tone and what is still needed', () => {
  const r = cr.build(fixture(), {}, { today: '2026-11-25' });
  assert.equal(r.goal, 95); assert.equal(r.need_for_goal, 4);                                        // 10 orders need 10 confirmed (ceil of 9.5): 6 done, 4 more
  assert.equal(r.table.find(x => x.label.startsWith('TOTAL CONFIRMATION')).tone, 'warn');
  const nc = r.table.find(x => x.label.startsWith('Not confirmed in all')); assert.equal(nc.count, 4); assert.equal(nc.tone, 'bad'); assert.ok(/4 more orders/.test(nc.hint));
  const good = cr.build(ledger.buildLedger(Array.from({ length: 20 }, (_, i) => mk(100 + i, '2026-11-25', i < 19 ? 'confirmed' : 'pending')), new Map(), NOW), {}, {});
  assert.equal(good.table.find(x => x.label.startsWith('TOTAL CONFIRMATION')).tone, 'ok'); assert.equal(good.need_for_goal, 0);
  assert.equal(good.table.find(x => x.label.startsWith('Not confirmed in all')).tone, 'ok');          // 1 of 20 = 5 percent: inside the limit
});

test('day by day: each day is its own COD base, the days add up to the total row, prepaid sits in its own column', () => {
  const rows = [mk(1, '2026-11-24', 'confirmed'), mk(2, '2026-11-24', 'pending'), mk(3, '2026-11-25', 'confirmed'), mk(4, '2026-11-25', 'cancelled')];
  const led = ledger.buildLedger(rows, new Map([[1, [T('cc', true)]], [2, [T('cc', false)]], [3, [T('wa', true)]], [4, [T('cc', true)]]]), NOW);
  const r = cr.build(led, { '2026-11-24': 5, '2026-11-25': 7, '2026-11-23': 3 }, { today: '2026-11-25' });
  assert.deepEqual(r.days.map(d => d.day), ['2026-11-23', '2026-11-24', '2026-11-25']);               // a day with only prepaid still shows
  const d23 = r.days[0]; assert.equal(d23.cod, 0); assert.equal(d23.confirmed_pct, null); assert.equal(d23.prepaid, 3);
  const d24 = r.days[1]; assert.equal(d24.cod, 2); assert.equal(d24.confirmed, 1); assert.equal(d24.confirmed_pct, 50); assert.equal(d24.attempted_pct, 100); assert.equal(d24.not_connected, 1);
  const d25 = r.days[2]; assert.equal(d25.is_today, true); assert.equal(d25.cancelled, 1);
  for (const d of r.days) if (d.cod) { for (const k of ['attempted_pct', 'connected_pct', 'confirmed_pct', 'open_pct']) assert.ok(d[k] <= 100, k + ' never above 100 on ' + d.day); }
  for (const k of ['cod', 'attempted', 'connected', 'not_connected', 'cancelled', 'confirmed', 'open', 'prepaid']) assert.equal(r.days.reduce((s, d) => s + d[k], 0), r.totals[k], 'days add up: ' + k);
  assert.equal(r.totals.cod, 4); assert.equal(r.totals.prepaid, 15);
});

test('an empty period is shown as dashes, not zeros or errors', () => {
  const r = cr.build([], {}, {});
  assert.equal(r.orders, 0); assert.equal(r.table[0].pct, null); assert.equal(r.need_for_goal, 0); assert.deepEqual(r.days, []); assert.equal(r.totals.confirmed_pct, null);
});

test('the real numbers of 25 Nov, rebuilt: 273 COD orders, 268 attempted, 206 connected, 62 not connected, 5 not tried, 202 confirmed, 4 cancelled, 67 open', () => {
  // the ledger blocks of that day, as read from the live CRM
  const rows = [], touches = new Map(); let id = 1;
  const add = (n, status, team, tries) => { for (let i = 0; i < n; i++, id++) { rows.push(mk(id, '2026-11-25', status, team)); touches.set(id, tries.map(([c, k]) => T(c, k))); } };
  add(202, 'confirmed', 'CC', [['cc', true]]); add(4, 'cancelled', 'CC', [['cc', true]]); add(62, 'pending', 'CC', [['cc', false]]); add(5, 'pending', 'CC', []);
  const r = cr.build(ledger.buildLedger(rows, touches, NOW), { '2026-11-25': 212 }, { today: '2026-11-25' });
  const n = (k) => r.table.find(x => x.label.startsWith(k));
  assert.deepEqual([r.orders, n('Attempted').count, n('Connected').count, n('Not connected').count, n('Not attempted').count, n('TOTAL').count, n('Cancelled').count, n('Still open').count], [273, 268, 206, 62, 5, 202, 4, 67]);
  assert.deepEqual([n('Attempted').pct, n('Connected').pct, n('Not connected').pct, n('Not attempted').pct, n('TOTAL').pct, n('Cancelled').pct], [98.2, 75.5, 22.7, 1.8, 74, 1.5]);
  assert.equal(r.prepaid, 212);
});
