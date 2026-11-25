const test = require('node:test');
const assert = require('node:assert');
const { buildControlTower } = require('../lib/controlTower');

const day = (d, o = {}) => ({ day: d, total: 50, prepaid: 10, cod: 40, needed_call: 30, attempted: 30, not_attempted: 0, connected: 28, confirmed_all: 38, pending: 2, rejected: 1, attempted_pct: 100, connected_pct: 70, confirmed_pct: 95, ...o });
const e2e = { days: [day('2026-11-15'), day('2026-11-16', { not_attempted: 4, attempted: 26, attempted_pct: 86.7 }), day('2026-11-17', { not_attempted: 6, attempted: 24 })] };
const team = { aman: { metrics: { leads: 10, attempted_pct: 90, connected_pct_of_attempted: 70, confirmed_by_pct: 40, not_called: 1 }, flags: [{ level: 'bad', text: 'Aman missed leads' }] }, cc: { metrics: { leads: 90, attempted_pct: 100, connected_pct_of_attempted: 60, confirmed_by_pct: 45, not_called: 0 }, flags: [{ level: 'warn', text: 'slow' }] }, channels: { totals: { cod: 100 }, reached_pct: 80, confirmed_pct: 93 } };

test('stages: counts and percentages come from the day totals', () => {
  const t = buildControlTower({ e2e, team, ship: { overdue: 0, due_today: 0, blocked: 0, wrong: 0 }, shippedConfirmed: 100, today: '2026-11-17' });
  const s = Object.fromEntries(t.stages.map(x => [x.key, x]));
  assert.strictEqual(s.orders.count, 150);
  assert.strictEqual(s.called.count, 80);
  assert.strictEqual(s.confirmed.count, 114);
  assert.strictEqual(s.confirmed.pct, 95);
  assert.strictEqual(s.confirmed.tone, 'ok');
  assert.strictEqual(s.shipped.pct, 87.7);
  assert.strictEqual(s.shipped.tone, 'bad');
  assert.ok(s.pickup.nodata && s.delivered.nodata);
});

test('actions: ranked, worst first, and earlier-day misses are separate from today', () => {
  const t = buildControlTower({ e2e, team, ship: { overdue: 3, due_today: 5, blocked: 2, wrong: 1 }, today: '2026-11-17' });
  assert.strictEqual(t.actions[0].level, 'bad');
  assert.ok(t.actions.some(a => /earlier days were never tried/.test(a.text) && /^4 /.test(a.text)));
  assert.ok(t.actions.some(a => /^6 of today/.test(a.text)));
  assert.ok(t.actions.some(a => /Aman: Aman missed leads/.test(a.text)));
  assert.ok(!t.actions.some(a => /slow/.test(a.text)));
  assert.strictEqual(t.healthy, false);
  const levels = t.actions.map(a => a.level);
  assert.deepStrictEqual(levels, [...levels].sort((a, b) => (a === 'bad' ? 0 : 1) - (b === 'bad' ? 0 : 1)));
});

test('teams and trend', () => {
  const t = buildControlTower({ e2e, team, ship: null, today: '2026-11-17' });
  assert.deepStrictEqual(t.teams.map(x => x.key), ['aman', 'cc', 'channels']);
  assert.strictEqual(t.trend.length, 3);
  assert.strictEqual(t.trend[1].called_pct, 86.7);
});

test('healthy when nothing is bad, and empty input is safe', () => {
  const ok = buildControlTower({ e2e: { days: [day('2026-11-16')] }, team: null, ship: { overdue: 0, due_today: 0, blocked: 0, wrong: 0 }, shippedConfirmed: 38, today: '2026-11-17' });
  assert.strictEqual(ok.healthy, true);
  const empty = buildControlTower({ e2e: null, team: null, ship: null, today: '2026-11-17' });
  assert.strictEqual(empty.stages[0].count, 0);
  assert.strictEqual(empty.stages[3].pct, null);
});

test('call plan: a team that cannot finish today and leads over the redial limit become actions that open the Call plan tab', () => {
  const plan = { teams: { cc: { label: 'Call centre', deficit: 120, agents_needed: 8 }, aman: { label: 'Aman', deficit: 0 } }, review_count: 40 };
  const t = buildControlTower({ e2e: { days: [] }, plan, today: '2026-11-18' });
  const planActions = t.actions.filter(a => a.go === 'plan');
  assert.equal(planActions.length, 2);
  assert.equal(planActions[0].level, 'bad');
  assert.match(planActions[0].text, /Call centre cannot finish today's calls: short by about 120 calls \(about 8 people needed\)/);
  assert.match(planActions[1].text, /40 leads are over the redial limit/);
  assert.equal(t.healthy, false);
  assert.equal(buildControlTower({ e2e: { days: [] }, plan: { teams: { cc: { deficit: 0 }, aman: { deficit: 0 } }, review_count: 0 }, today: '2026-11-18' }).actions.length, 0);
});
