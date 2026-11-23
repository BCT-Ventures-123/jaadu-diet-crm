const test = require('node:test');
const assert = require('node:assert');
const { statusCondition, dayRange, buildDaily } = require('../lib/leadFilters');

test('status filter only accepts known names', () => {
  assert.match(statusCondition('callback'), /callback_at IS NOT NULL/);
  assert.equal(statusCondition('x; DROP TABLE orders_master'), null);
  assert.equal(statusCondition(undefined), null);
  assert.equal(statusCondition('toString'), null);
});

test('dayRange covers whole IST days and defaults', () => {
  const r = dayRange({ from: '2026-10-01', to: '2026-10-02' }, '2026-10-09');
  assert.equal(r.start.toISOString(), '2026-09-30T18:30:00.000Z');
  assert.equal(r.end.toISOString(), '2026-10-02T18:30:00.000Z');
  assert.equal(dayRange({}, '2026-10-09').start, null);
  assert.equal(dayRange({}, '2026-10-09', true).from, '2026-10-09');
  assert.equal(dayRange({ from: '2026-10-05' }, 'x').to, '2026-10-05');
  assert.equal(dayRange({ from: 'bad' }, 'x').start, null);
  assert.throws(() => dayRange({ from: '2026-10-05', to: '2026-10-01' }, 'x'));
});

test('buildDaily computes connectivity per day', () => {
  const out = buildDaily([
    { day: '2026-10-02', disposition: 'dnp', n: 6 },
    { day: '2026-10-02', disposition: 'confirmed', n: 3 },
    { day: '2026-10-02', disposition: 'cancelled', n: 1 },
    { day: '2026-10-01', disposition: 'callback', n: 2 },
    { day: '2026-10-01', disposition: 'dnp', n: 2 },
  ]);
  assert.deepEqual(out.days.map(d => d.day), ['2026-10-01', '2026-10-02']);
  const d2 = out.days[1];
  assert.equal(d2.total_attempts, 10);
  assert.equal(d2.connected_calls, 4);
  assert.equal(d2.connectivity_pct, 40);
  assert.equal(out.totals.total_attempts, 14);
  assert.equal(out.totals.callbacks, 2);
});
