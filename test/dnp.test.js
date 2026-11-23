const test = require('node:test');
const assert = require('node:assert');
const { dnpStatus, isUnreachableDue } = require('../lib/dnp');

// 2026-03-10 12:00 IST = 06:30 UTC
const now = new Date('2026-03-10T06:30:00Z');
const minsAgo = (m) => new Date(now.getTime() - m * 60000).toISOString();

test('no attempts: nothing blocks, 2 still needed (the second call the same day)', () => {
  const s = dnpStatus([], now);
  assert.equal(s.todayCount, 0);
  assert.equal(s.tooSoon, false);
  assert.equal(s.neededToday, 2);
  assert.equal(s.hint, null);
});

test('attempt 30 minutes ago triggers the too-soon hint', () => {
  const s = dnpStatus([minsAgo(30)], now);
  assert.equal(s.tooSoon, true);
  assert.equal(s.minutesSinceLast, 30);
  assert.match(s.hint, /30 min ago/);
});

test('attempt exactly 90 minutes ago is fine', () => {
  const s = dnpStatus([minsAgo(90)], now);
  assert.equal(s.tooSoon, false);
  assert.equal(s.hint, null);
});

test('only attempts made today (IST) count toward the daily total', () => {
  const s = dnpStatus([minsAgo(60 * 30), minsAgo(60 * 28), minsAgo(120)], now);
  assert.equal(s.totalAttempts, 3);
  assert.equal(s.todayCount, 1);
  assert.equal(s.belowTarget, true);
  assert.equal(s.neededToday, 1);
});

test('5th attempt reaches the daily maximum', () => {
  const t = [minsAgo(600), minsAgo(480), minsAgo(360), minsAgo(240), minsAgo(120)];
  const s = dnpStatus(t, now);
  assert.equal(s.todayCount, 5);
  assert.equal(s.atMax, true);
  assert.match(s.hint, /maximum/i);
});

test('3 attempts meets the target', () => {
  const s = dnpStatus([minsAgo(400), minsAgo(300), minsAgo(200)], now);
  assert.equal(s.belowTarget, false);
  assert.equal(s.neededToday, 0);
});

test('IST day boundary: 23:30 IST yesterday is not today', () => {
  // 2026-03-09 23:30 IST = 18:00 UTC on 03-09
  const s = dnpStatus(['2026-03-09T18:00:00Z'], now);
  assert.equal(s.todayCount, 0);
});

test('invalid timestamps are ignored', () => {
  const s = dnpStatus(['garbage', null, minsAgo(200)], now);
  assert.equal(s.totalAttempts, 1);
});

test('unreachable after 7 days from order date', () => {
  const created = new Date('2026-03-03T06:30:00Z');
  assert.equal(isUnreachableDue(created, now, 7), true);
  assert.equal(isUnreachableDue(new Date('2026-03-04T06:30:00Z'), now, 7), false);
  assert.equal(isUnreachableDue('bad', now, 7), false);
});
