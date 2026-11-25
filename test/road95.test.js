const test = require('node:test');
const assert = require('node:assert/strict');
const road = require('../lib/road95');
const brief = require('../lib/opsBrief');

const NOW = new Date('2026-11-26T06:00:00Z');            // 11:30 India
const T0 = { aman: 0, cc: 0, ivr: 0, wa: 0 };
let n = 0;
const o = (day, status, attempts = 0, over = {}) => ({ id: 'o' + (++n), order: '#' + (40000 + n), day, status, attempts, tries: { ...T0, wa: attempts }, last_try_by: attempts ? 'wa' : null, last_try_at: attempts ? new Date(NOW.getTime() - 5 * 3600e3) : null, age_hours: 30, ...over });
const many = (day, k, status, attempts, over) => Array.from({ length: k }, () => o(day, status, attempts, over));

test('road to 95: one row per day with the gap to 95 percent, the days left, and the state', () => {
  const ledger = [...many('2026-11-24', 15, 'confirmed', 2), ...many('2026-11-24', 1, 'cancelled', 1), ...many('2026-11-24', 4, 'not_confirmed', 3),
    ...many('2026-11-21', 10, 'confirmed', 1),
    ...many('2026-11-20', 8, 'confirmed', 1), ...many('2026-11-20', 2, 'not_confirmed', 4)];
  const r = road.build(ledger, NOW);
  assert.equal(r.target, 95); assert.equal(r.mature_days, 5); assert.equal(r.days.length, 3);
  const d24 = r.days.find(d => d.day === '2026-11-24');
  assert.equal(d24.orders, 20); assert.equal(d24.confirmed, 15); assert.equal(d24.cancelled, 1); assert.equal(d24.open, 4); assert.equal(d24.confirmed_pct, 75);
  assert.equal(d24.need, 4);                                  // 95% of 20 is 19 confirmed, 15 so far
  assert.equal(d24.age_days, 2); assert.equal(d24.days_left, 3); assert.equal(d24.state, 'in_progress');
  const d21 = r.days.find(d => d.day === '2026-11-21'); assert.equal(d21.confirmed_pct, 100); assert.equal(d21.need, 0); assert.equal(d21.state, 'on_target'); assert.equal(d21.days_left, 0);
  const d20 = r.days.find(d => d.day === '2026-11-20'); assert.equal(d20.confirmed_pct, 80); assert.equal(d20.state, 'missed'); assert.equal(d20.days_left, 0); assert.equal(d20.need, 2);
  assert.deepEqual(r.days.map(d => d.day), ['2026-11-20', '2026-11-21', '2026-11-24']);          // oldest first
});

test('road to 95: the open orders, longest waiting first, with how many tries each has had', () => {
  const ledger = [o('2026-11-25', 'not_confirmed', 0, { age_hours: 5 }), o('2026-11-25', 'not_confirmed', 1, { age_hours: 20 }), o('2026-11-24', 'not_confirmed', 3, { age_hours: 40, last_try_by: 'ivr', last_try_at: new Date(NOW.getTime() - 3.5 * 3600e3) }),
    o('2026-11-23', 'not_confirmed', 6, { age_hours: 70 }), o('2026-11-24', 'confirmed', 2)];
  const r = road.build(ledger, NOW);
  assert.equal(r.stuck.total, 4); assert.deepEqual(r.stuck.buckets, { none: 1, one: 1, two_three: 1, four_plus: 1 });
  assert.deepEqual(r.stuck.list.map(x => x.waiting_hours), [70, 40, 20, 5]);
  const ivr = r.stuck.list.find(x => x.attempts === 3); assert.equal(ivr.last_try_by, 'IVR'); assert.equal(ivr.last_try_hours_ago, 3.5);
  assert.equal(r.stuck.list.find(x => x.attempts === 0).last_try_by, null);
  assert.equal(road.build(many('2026-11-25', 50, 'not_confirmed', 1), NOW, { listMax: 10 }).stuck.list.length, 10);
  assert.equal(road.build([], NOW).days.length, 0);
});

test('ops brief: a day that is short of 95 percent with few days left is a problem to work, a missed day is told plainly', () => {
  const r = road.build([...many('2026-11-24', 15, 'confirmed', 2), ...many('2026-11-24', 5, 'not_confirmed', 3), ...many('2026-11-20', 8, 'confirmed', 1), ...many('2026-11-20', 2, 'not_confirmed', 4)], NOW);
  const f = brief.collectFacts({ tower: { actions: [], stages: [], healthy: true }, plan: null, road: r, now: NOW });
  assert.equal(f.road_to_95.length, 2); assert.equal(f.healthy, false);
  const bad = f.problems.find(p => p.level === 'bad'); assert.match(bad.text, /Orders of 2026-11-24: 15 of 20 confirmed \(75 percent\)\. 4 more needed for 95 percent, 3 days left\./);
  assert.match(f.problems.find(p => p.level === 'warn').text, /Orders of 2026-11-20 ended at 80 percent confirmed \(8 of 10\), below 95 percent\./);
  assert.equal(brief.collectFacts({ tower: null, plan: null, now: NOW }).road_to_95.length, 0);      // no road data: the brief works as before
});
