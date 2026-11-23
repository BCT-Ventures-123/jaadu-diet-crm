const test = require('node:test');
const assert = require('node:assert');
const { buildRepeat } = require('../lib/repeatMath');

const o = (phone, date, price = 599, name = 'N') => ({ phone, name, date: `${date}T06:00:00Z`, price });
const NOW = new Date('2026-10-10T00:00:00Z');

test('cohort repeat % and gap use each customer\'s first order month', () => {
  const r = buildRepeat([
    o('A', '2026-06-05'), o('A', '2026-06-20'),          // repeats after 15 days
    o('B', '2026-06-10'),                                  // never repeats
    o('C', '2026-06-12'), o('C', '2026-09-12'),          // repeats after 92 days
    o('D', '2026-07-01'),
  ], NOW);
  const jun = r.cohorts.find(c => c.month === '2026-06');
  assert.equal(jun.customers, 3);
  assert.equal(jun.repeaters, 2);
  assert.equal(jun.repeat_pct, 66.7);
  assert.equal(jun.avg_days_to_second, 54);              // (15 + 92) / 2 rounded
  assert.equal(jun.within[15].repeated, 1);
  assert.equal(jun.within[90].repeated, 1);              // only A is inside 90 days; C took 92
  assert.equal(r.totals.customers, 4);
  assert.equal(r.totals.repeaters, 2);
});

test('windows only count customers old enough to have had the chance', () => {
  const r = buildRepeat([o('X', '2026-10-01')], NOW);   // 9 days old
  const oct = r.cohorts[0];
  assert.equal(oct.within[15].eligible, 0);
  assert.equal(oct.within[15].pct, null);
});

test('monthly view separates new and returning orders', () => {
  const r = buildRepeat([o('A', '2026-06-05'), o('A', '2026-07-05'), o('B', '2026-07-06')], NOW);
  const jul = r.months.find(m => m.month === '2026-07');
  assert.equal(jul.orders, 2);
  assert.equal(jul.returning_orders, 1);
  assert.equal(jul.returning_pct, 50);
  assert.equal(r.customers.find(c => c.phone === 'A').days_to_second, 30);
});
