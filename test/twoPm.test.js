const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../lib/twoPm');

const at = (s) => new Date(s + '+05:30');
const o = (id, status, placed, decided) => ({ id, status, order_at: at(placed), decided_at: decided ? at(decided) : null });
const t = (when, team = 'cc', connected = false) => ({ t: at(when), team, connected });
const NOW = at('2026-11-23T16:00:00');                                                 // after the 2 PM cut-off of 23 Nov

test('2 PM scorecard: fresh orders are those placed after yesterday 2 PM and before 1 PM today', () => {
  const rows = [
    o('a', 'confirmed', '2026-11-23T09:00:00', '2026-11-23T11:00:00'),                 // confirmed in time
    o('b', 'confirmed', '2026-11-22T20:00:00', '2026-11-23T13:59:00'),                 // placed last evening, confirmed at 1:59 PM: in time
    o('c', 'confirmed', '2026-11-23T10:00:00', '2026-11-23T14:30:00'),                 // confirmed after the lock
    o('d', 'pending', '2026-11-23T10:30:00', null),                                    // tried, still open
    o('e', 'pending', '2026-11-23T11:00:00', null),                                    // never tried
    o('f', 'cancelled', '2026-11-23T08:00:00', '2026-11-23T09:00:00'),
    o('g', 'confirmed', '2026-11-23T13:30:00', '2026-11-23T13:45:00'),                 // placed after 1 PM: not in the pool
    o('h', 'confirmed', '2026-11-22T13:00:00', '2026-11-22T15:00:00'),                 // placed before yesterday's cut-off: not fresh
  ];
  const tm = new Map([['a', [t('2026-11-23T09:30:00', 'cc', true)]], ['b', [t('2026-11-23T09:00:00', 'ivr', true)]], ['c', [t('2026-11-23T12:00:00')]], ['d', [t('2026-11-23T11:00:00'), t('2026-11-23T13:00:00')]], ['f', [t('2026-11-23T08:30:00', 'aman', true)]]]);
  const s = T.build(rows, tm, '2026-11-23', NOW).fresh;
  assert.equal(s.pool, 6);                                                              // a, b, c, d, e, f
  assert.equal(s.confirmed_by_cut, 2); assert.equal(s.cancelled_by_cut, 1); assert.equal(s.open, 3);   // c is open at the cut-off even though it was confirmed later
  assert.equal(s.confirmed_after_cut, 1); assert.equal(s.open_tried, 2); assert.equal(s.open_not_tried, 1);
  assert.equal(s.attempted_by_cut, 5); assert.equal(s.not_attempted_by_cut, 1);
  assert.equal(s.confirmed_by_cut_pct, 33.3); assert.equal(s.attempted_by_cut_pct, 83.3);
  assert.equal(s.confirmed_by_cut + s.cancelled_by_cut + s.open, s.pool);               // adds up
  assert.equal(T.build(rows, tm, '2026-11-23', NOW).live, false);
});

test('2 PM scorecard: old no-answer leads still open when the day began, and how many were reached and confirmed before 2 PM', () => {
  const rows = [
    o('p', 'confirmed', '2026-11-10T10:00:00', '2026-11-23T11:00:00'),                 // old DNP, reached and confirmed this morning
    o('q', 'pending', '2026-11-12T10:00:00', null),                                    // old DNP, reached, still open
    o('r', 'pending', '2026-11-14T10:00:00', null),                                    // old DNP, nobody called today
    o('s', 'confirmed', '2026-11-11T10:00:00', '2026-11-21T10:00:00'),                 // confirmed days ago: not in the pool
    o('u', 'pending', '2026-11-05T10:00:00', null),                                    // old, never tried by anyone
    o('v', 'confirmed', '2026-11-13T10:00:00', '2026-11-23T15:00:00'),                 // old DNP confirmed after 2 PM
  ];
  const tm = new Map([['p', [t('2026-11-12T10:00:00'), t('2026-11-23T10:30:00', 'cc', true)]], ['q', [t('2026-11-18T10:00:00'), t('2026-11-23T12:00:00')]], ['r', [t('2026-11-18T10:00:00')]], ['v', [t('2026-11-15T10:00:00'), t('2026-11-23T14:30:00', 'ivr', true)]]]);
  const s = T.build(rows, tm, '2026-11-23', NOW).old;
  assert.equal(s.pool, 5); assert.equal(s.never_tried, 1);                              // p, q, r, u, v
  assert.equal(s.reached, 2); assert.equal(s.not_reached, 3);                           // p and q were reached before 2 PM; v only at 2:30 PM, r and u not at all
  assert.equal(s.confirmed_by_cut, 1); assert.equal(s.open, 4); assert.equal(s.confirmed_after_cut, 1);
  assert.equal(s.reached_pct, 40);
});

test('2 PM scorecard: before the cut-off the numbers are "so far", and a week of days can be asked at once', () => {
  const rows = [o('a', 'confirmed', '2026-11-23T08:00:00', '2026-11-23T09:30:00'), o('b', 'confirmed', '2026-11-23T08:30:00', '2026-11-23T13:00:00')];
  const tm = new Map([['a', [t('2026-11-23T09:00:00', 'cc', true)]], ['b', [t('2026-11-23T12:30:00', 'cc', true)]]]);
  const morning = T.build(rows, tm, '2026-11-23', at('2026-11-23T10:00:00'));
  assert.equal(morning.live, true); assert.equal(morning.fresh.confirmed_by_cut, 1); assert.equal(morning.fresh.open, 1);      // b is not confirmed yet at 10 AM
  const days = T.buildDays(rows, tm, ['2026-11-22', '2026-11-23'], NOW);
  assert.deepEqual(days.map(d => d.day), ['2026-11-22', '2026-11-23']); assert.equal(days[1].fresh.confirmed_by_cut, 2);
  assert.equal(T.build([], new Map(), '2026-11-23', NOW).fresh.confirmed_by_cut_pct, null);
});
