const test = require('node:test');
const assert = require('node:assert');
const ExcelJS = require('exceljs');
const { buildTeamReport, addTeamSheets, chanOf } = require('../lib/teamReport');

const at = (s) => new Date(s + '+05:30');
const NOW = at('2026-11-12T12:00:00');
const order = (id, team, status, placed, extra = {}) => ({ id, team, status, day: placed.slice(0, 10), order_at: at(placed), actor: null, actor_role: null, ...extra });
const call = (d, t, team, agent) => ({ d, t: at(t), team, agent });

const rows = [
  order('A1', 'InHouse', 'confirmed', '2026-11-11T09:00:00', { actor: 'Aman', actor_role: 'aman' }),
  order('A2', 'InHouse', 'pending', '2026-11-11T10:00:00'),
  order('A3', 'InHouse', 'pending', '2026-11-10T15:00:00'),
  order('A4', 'InHouse', 'confirmed', '2026-11-11T09:30:00', { actor: 'whatsapp' }),
  order('A5', 'InHouse', 'pending', '2026-11-11T11:00:00'),
  order('C1', 'CC', 'confirmed', '2026-11-11T08:00:00', { actor: 'Priya', actor_role: 'agent' }),
  order('C2', 'CC', 'confirmed', '2026-11-11T08:00:00', { actor: 'ivr_call' }),
];
const callsMap = new Map([
  ['A1', [call('dnp', '2026-11-11T09:20:00', 'aman', 'Aman'), call('confirmed', '2026-11-11T10:00:00', 'aman', 'Aman')]],
  ['A3', [call('dnp', '2026-11-10T15:30:00', 'aman', 'Aman')]],
  ['A5', [call('dnp', '2026-11-11T11:30:00', 'cc', 'Priya')]],
  ['C1', [call('confirmed', '2026-11-11T08:30:00', 'cc', 'Priya')]],
]);
const activity = {
  agents: [
    { agent: 'Aman', team: 'aman', calls: 10, orders_dialled: 8, picked: 7, dnp: 3, confirmed: 5, cancelled: 1, callbacks: 0, address_fix: 1, wrong: 0, active_days: 2 },
    { agent: 'Priya', team: 'cc', calls: 20, orders_dialled: 15, picked: 12, dnp: 8, confirmed: 9, cancelled: 2, callbacks: 1, address_fix: 0, wrong: 0, active_days: 2 },
  ],
  teams: [
    { team: 'aman', calls: 10, orders_dialled: 8, picked: 7, dnp: 3, confirmed: 5, cancelled: 1, callbacks: 0, address_fix: 1, wrong: 0, active_days: 2 },
    { team: 'cc', calls: 20, orders_dialled: 15, picked: 12, dnp: 8, confirmed: 9, cancelled: 2, callbacks: 1, address_fix: 0, wrong: 0, active_days: 2 },
  ],
  all: { calls: 30, orders_dialled: 22, picked: 19, dnp: 11, confirmed: 14, cancelled: 3, callbacks: 1, address_fix: 1, wrong: 0, active_days: 2 },
  days: [{ team: 'aman', day: '2026-11-11', calls: 6, picked: 4, orders_dialled: 5 }, { team: 'cc', day: '2026-11-11', calls: 12, picked: 7, orders_dialled: 9 }],
};

test('Aman: leads, coverage, reach, redial, on-time and confirmations', () => {
  const m = buildTeamReport(rows, callsMap, activity, { now: NOW }).aman.metrics;
  assert.deepStrictEqual([m.leads, m.closed_without_call, m.needed], [5, 1, 4]);
  assert.deepStrictEqual([m.attempted, m.called_by_other_team_only, m.not_called], [2, 1, 1]);
  assert.strictEqual(m.attempted_pct, 50);
  assert.deepStrictEqual([m.connected, m.not_connected], [1, 1]);
  assert.deepStrictEqual([m.nc_old, m.nc_old_redialed, m.redial_pct], [1, 0, 0]);
  assert.deepStrictEqual([m.on_time_base, m.on_time, m.on_time_pct], [4, 2, 50]);   // new rule: placed before 5 PM, first call within 1 hour. A1 (9:00, called 9:20) and A3 (15:00, called 15:30) are on time; A2 and A5 got no call from Aman
  assert.deepStrictEqual([m.confirmed_by, m.confirmed_by_pct], [1, 20]);
  assert.strictEqual(m.median_first_call_min, 20);
});

test('Aman: activity, people and the scorecard tones', () => {
  const T = buildTeamReport(rows, callsMap, activity, { now: NOW }).aman;
  assert.strictEqual(T.activity.picked_pct, 70);
  assert.strictEqual(T.activity.calls_per_active_day, 5);
  assert.strictEqual(T.people.length, 1);
  assert.strictEqual(T.people[0].calls_per_day, 5);
  const k = Object.fromEntries(T.kpis.map(x => [x.key, x]));
  assert.strictEqual(k.coverage.tone, 'bad');
  assert.strictEqual(k.on_time.tone, 'bad');
  assert.strictEqual(k.redial.tone, 'bad');
  assert.ok(T.flags.some(f => /never called by anyone/.test(f.text)));
  assert.ok(T.flags.some(f => /called only by the other team/.test(f.text)));
});

test('call centre and both callers together', () => {
  const r = buildTeamReport(rows, callsMap, activity, { now: NOW });
  assert.deepStrictEqual([r.cc.metrics.leads, r.cc.metrics.closed_without_call, r.cc.metrics.needed, r.cc.metrics.attempted, r.cc.metrics.confirmed_by], [2, 1, 1, 1, 1]);
  assert.strictEqual(r.cc.metrics.attempted_pct, 100);
  const c = r.callers.metrics;
  assert.deepStrictEqual([c.leads, c.closed_without_call, c.needed, c.attempted, c.called_by_other_team_only, c.not_called], [7, 2, 5, 4, 0, 1]);
  assert.strictEqual(r.callers.activity.calls, 30);
});

test('all channels: who confirmed, reach, and the 6 PM window', () => {
  const C = buildTeamReport(rows, callsMap, activity, { now: NOW }).channels;
  assert.deepStrictEqual([C.totals.cod, C.totals.confirmed_total, C.totals.pending], [7, 4, 3]);
  assert.deepStrictEqual(C.channels.map(x => [x.key, x.confirmed]), [['whatsapp', 1], ['ivr', 1], ['aman', 1], ['cc', 1], ['other', 0]]);
  assert.strictEqual(C.confirmed_pct, 57.1);
  assert.strictEqual(C.reached_pct, 57.1);
  assert.strictEqual(C.windows[0].orders, 7);
  assert.strictEqual(C.windows[1].orders, 0);
  assert.strictEqual(C.days.find(d => d.day === '2026-11-11').cod, 6);
});

test('orders placed from 6 PM are counted in the IVR window', () => {
  const late = [order('L1', 'CC', 'confirmed', '2026-11-11T20:00:00', { actor: 'ivr_call' }), order('L2', 'CC', 'pending', '2026-11-11T19:00:00')];
  const w = buildTeamReport(late, new Map(), {}, { now: NOW }).channels.windows;
  assert.deepStrictEqual([w[0].orders, w[1].orders, w[1].confirmed, w[1].ivr], [0, 2, 1, 1]);
});

test('empty input and missing activity are safe', () => {
  const r = buildTeamReport([], new Map(), null, { now: NOW });
  assert.strictEqual(r.aman.metrics.leads, 0);
  assert.strictEqual(r.aman.metrics.attempted_pct, null);
  assert.strictEqual(r.channels.confirmed_pct, null);
  assert.ok(r.callers.kpis.length > 0);
});

test('a person who cancels far more than the team is flagged', () => {
  const act = { agents: [
    { agent: 'Rita', team: 'cc', calls: 200, orders_dialled: 150, picked: 120, dnp: 80, confirmed: 40, cancelled: 40, active_days: 5 },
    { agent: 'Sam', team: 'cc', calls: 200, orders_dialled: 150, picked: 120, dnp: 80, confirmed: 110, cancelled: 5, active_days: 5 },
    { agent: 'Joe', team: 'cc', calls: 200, orders_dialled: 150, picked: 120, dnp: 80, confirmed: 110, cancelled: 5, active_days: 5 }],
  teams: [{ team: 'cc', calls: 600, orders_dialled: 450, picked: 360, dnp: 240, confirmed: 260, cancelled: 50, active_days: 5 }], all: {}, days: [] };
  const f = buildTeamReport([], new Map(), act, { now: NOW }).cc.flags;
  assert.ok(f.some(x => /Rita cancels/.test(x.text)));
  assert.ok(!f.some(x => /Sam cancels/.test(x.text)));
});

test('channel mapping of who decided', () => {
  assert.strictEqual(chanOf('whatsapp', null), 'whatsapp');
  assert.strictEqual(chanOf('ivr_late', null), 'ivr');
  assert.strictEqual(chanOf('X', 'aman'), 'aman');
  assert.strictEqual(chanOf('X', 'admin'), 'aman');
  assert.strictEqual(chanOf('X', 'agent'), 'cc');
  assert.strictEqual(chanOf('sheet', null), 'other');
});

test('Excel: one sheet per measure plus the definitions', () => {
  const wb = new ExcelJS.Workbook();
  addTeamSheets(wb, buildTeamReport(rows, callsMap, activity, { now: NOW }), { font: { bold: true } });
  assert.deepStrictEqual(wb.worksheets.map(w => w.name), ['Aman (in-house caller)', 'Call centre', 'All callers', 'All channels', 'How to read']);
  const w = wb.getWorksheet('Aman (in-house caller)');
  assert.strictEqual(w.getRow(4).getCell(1).value, 'Leads called at least once');
  assert.strictEqual(w.getRow(4).getCell(2).value, '50%');
  assert.strictEqual(w.getRow(4).getCell(4).value, 'Below target');
});


test('report ladder: Called, Picked up, Confirmed and Not called are all shares of the leads that needed a call (one base)', () => {
  const T = buildTeamReport(rows, callsMap, activity, { now: NOW }).aman, m = T.metrics;
  assert.equal(m.needed, m.leads - m.closed_without_call);
  assert.equal(m.connected_pct_of_needed, Math.round(m.connected / m.needed * 1000) / 10);
  assert.equal(m.confirmed_by_pct_of_needed, Math.round(m.confirmed_by / m.needed * 1000) / 10);
  assert.equal(m.not_connected_pct_of_needed, Math.round(m.not_connected / m.needed * 1000) / 10);
  // the ladder never goes up as it goes down: called >= picked up >= confirmed
  assert.ok(m.attempted_pct >= m.connected_pct_of_needed && m.connected_pct_of_needed >= m.confirmed_by_pct_of_needed);
  for (const d of T.days) {
    assert.equal(d.connected_pct_of_needed, d.needed ? Math.round(d.connected / d.needed * 1000) / 10 : 0);
    assert.equal(d.confirmed_pct_of_needed, d.needed ? Math.round(d.confirmed_by / d.needed * 1000) / 10 : 0);
    assert.equal(d.not_called_pct_of_needed, d.needed ? Math.round(d.not_called / d.needed * 1000) / 10 : 0);
    assert.ok(d.attempted_pct >= d.connected_pct_of_needed);
  }
});