const test = require('node:test');
const assert = require('node:assert');
const { prioritise, sortQueue, summarise } = require('../lib/queue');
const { dnpStatus } = require('../lib/dnp');

const now = new Date('2026-11-10T10:00:00Z');
const minsAgo = (m) => new Date(now.getTime() - m * 60000);
// lead(name, ageMinutes, dnpAttemptMinutesAgo[], extra)
const lead = (id, age, tries = [], extra = {}) => {
  const l = { id, total_price: 600, age_minutes: age, created_at: minsAgo(age), ...extra };
  const d = dnpStatus(tries.map(minsAgo), now);
  return { ...l, dnp: d, priority: prioritise(l, d, now) };
};

test('work order: callback due, overdue fresh, new fresh, normal fresh, THEN retries, then not-yet-due and capped', () => {
  const leads = [
    lead('retry', 300, [200]),                                            // 1 try 200 min ago: gap passed
    lead('fresh', 300),                                                   // 5 h old, never called
    lead('new', 20),                                                      // 20 min old
    lead('overdue', 30 * 60),                                             // 30 h old, never called
    lead('callback', 500, [], { callback_at: minsAgo(25) }),              // promised 25 min ago
    lead('wait', 400, [30]),                                              // last try 30 min ago
    lead('capped', 900, [10, 120, 200, 300, 400].map(m => m % 2000)),     // 5 tries today
  ];
  const order = sortQueue(leads).map(l => l.id);
  assert.deepEqual(order.slice(0, 5), ['callback', 'overdue', 'new', 'fresh', 'retry']);    // fresh first: every lead with zero attempts comes before any retry
  assert.deepEqual(order.slice(5).sort(), ['capped', 'wait']);
  const c = summarise(leads);
  assert.equal(c.ready, 5);
  assert.equal(c.wait, 1);
  assert.equal(c.capped, 1);
});

test('not ready leads never jump ahead of ready ones', () => {
  const q = sortQueue([lead('wait', 5000, [10]), lead('fresh', 200)]);
  assert.equal(q[0].id, 'fresh');
  assert.equal(q[1].priority.ready, false);
  assert.match(q[1].priority.reason, /in about \d+ min/);
});

test('retry: fewer attempts first, and needing more tries today lifts a lead', () => {
  const one = lead('one', 3000, [200]);
  const two = lead('two', 3000, [400, 200]);
  assert.ok(one.priority.score > two.priority.score);
  assert.equal(one.priority.tier, 'retry_due');
});

test('fresh first: every lead with zero attempts, of any age, ranks above every second or third try', () => {
  const second = lead('second', 3000, [200]);                  // 1 unanswered try, 200 min ago
  const yesterday = lead('yesterday', 4000, [1500]);           // tried yesterday, nothing today
  const freshBusy = lead('fresh', 400);                        // 6 h old, never called
  const brandNew = lead('new', 20), overdue = lead('overdue', 30 * 60);
  const order = sortQueue([freshBusy, second, yesterday, brandNew, overdue]).map(l => l.id);
  assert.deepEqual(order, ['overdue', 'new', 'fresh', 'yesterday', 'second']);   // fresh leads first (both ages), then the retries: the one that has waited longest goes first
  assert.equal(second.priority.tier, 'retry_due');
  assert.equal(yesterday.priority.tier, 'retry_due');
  assert.match(second.priority.reason, /Attempt 2: last try was 3 h ago, 1 of 2 tries today/);
});

test('retries that are not yet 3 hours old, or already have the minimum tries today, stay below fresh leads', () => {
  const soon = lead('soon', 3000, [100]);                      // gap passed (90 min) but only 100 min since the last try
  assert.equal(soon.priority.tier, 'retry');
  const enough = lead('enough', 3000, [600, 400, 200]);        // 3 tries today: the minimum is done, further tries are extras
  assert.equal(enough.priority.tier, 'retry');
  assert.ok(lead('fresh', 400).priority.score > soon.priority.score);
  assert.ok(lead('fresh', 400).priority.score > enough.priority.score);
});

test('the 3-hour rule can be changed', () => {
  const l = { id: 'x', total_price: 600, age_minutes: 3000, created_at: minsAgo(3000) };
  const d = dnpStatus([minsAgo(100)], now);
  const cfg = require('../lib/config');
  assert.equal(prioritise(l, d, now, { ...cfg, DNP_RETRY_PRIORITY_MINUTES: 90 }).tier, 'retry_due');
  assert.equal(prioritise(l, d, now, { ...cfg, DNP_RETRY_PRIORITY_MINUTES: 240 }).tier, 'retry');
});

test('a bigger order breaks a tie but never beats a higher tier', () => {
  const big = lead('big', 300, [], { total_price: 5000 });
  const callbackSmall = lead('cb', 300, [], { total_price: 100, callback_at: minsAgo(1) });
  assert.ok(sortQueue([big, callbackSmall])[0].id === 'cb');
  const a = lead('a', 300, [], { total_price: 1500 }), b = lead('b', 300, [], { total_price: 300 });
  assert.equal(sortQueue([b, a])[0].id, 'a');
});

test('reasons are plain words', () => {
  assert.match(lead('x', 10).priority.reason, /Placed 10 min ago/);
  assert.match(lead('y', 2000).priority.reason, /never called \(over 24 h\)/);
});

test('a handed-over lead comes right after due callbacks and says why', () => {
  const ho = lead('ho', 300, [], { handover_reason: 'cc_failed' });
  const cb = lead('cb', 300, [], { callback_at: minsAgo(5) });
  const fresh = lead('fresh', 3000);
  const order = sortQueue([fresh, ho, cb]).map(l => l.id);
  assert.deepEqual(order, ['cb', 'ho', 'fresh']);
  assert.equal(ho.priority.tier, 'handed_over');
  assert.match(ho.priority.reason, /call centre could not reach/);
  assert.equal(lead('wait', 300, [20], { handover_reason: 'cc_failed' }).priority.tier, 'wait');   // not due again yet
});
test('a leads moved by the manual backlog split rank like any other lead, not above today\'s new orders', () => {
  const split = lead('split', 3000, [], { handover_reason: 'split_backlog' });
  assert.notEqual(split.priority.tier, 'handed_over');
  const newer = lead('new', 20);
  assert.equal(sortQueue([split, newer]).map(l => l.id)[0], 'split');          // placed 50 h ago and never called: overdue, as it would be without the split
  const retry = lead('r', 3000, [200], { handover_reason: 'split_backlog' });
  assert.equal(retry.priority.tier, 'retry_due');
});


test('fresh first: with many fresh leads waiting, a retry never gets ahead of them, even a very overdue one', () => {
  const freshLeads = Array.from({ length: 30 }, (_, i) => lead('f' + i, 70 + i * 5));            // 70 min to 3.6 h old, never called
  const hotRetry = lead('retryHot', 5000, [600, 400, 200]);                                      // called three times already today, long overdue for another try
  const order = sortQueue([hotRetry, ...freshLeads]).map(l => l.id);
  assert.equal(order[order.length - 1], 'retryHot');                                              // last: the 30 fresh leads are finished first
  assert.ok(freshLeads.every(l => l.priority.tier === 'fresh'));
});

test('same-day shipping: before the 2 PM lock a not-connected lead placed today ranks above an older one, and never above a fresh lead', () => {
  const noon = new Date('2026-11-20T11:00:00+05:30');                                              // 11 AM, before the lock
  const mk = (id, placed, tries) => { const l = { id, shopify_created_at: placed, created_at: placed, total_price: 600 }; return { ...l, priority: prioritise(l, { totalAttempts: tries.length, atMax: false, tooSoon: false, minutesSinceLast: 200, belowTarget: true, neededToday: 2, todayCount: 1 }, noon) }; };
  const today = mk('today', new Date('2026-11-20T08:30:00+05:30'), [1]), old = mk('old', new Date('2026-11-18T09:00:00+05:30'), [1]);
  const freshLead = { id: 'fresh', shopify_created_at: new Date('2026-11-20T10:00:00+05:30'), total_price: 600 };
  const fresh = { ...freshLead, priority: prioritise(freshLead, { totalAttempts: 0 }, noon) };
  assert.deepEqual(sortQueue([old, today, fresh]).map(l => l.id), ['fresh', 'today', 'old']);
  assert.match(today.priority.reason, /confirm before 2 PM and it ships today/);
  const afterLock = new Date('2026-11-20T15:00:00+05:30');                                         // after the lock: no same-day bonus
  const late = prioritise({ id: 'x', shopify_created_at: new Date('2026-11-20T08:30:00+05:30'), total_price: 600 }, { totalAttempts: 1, minutesSinceLast: 200, belowTarget: true, neededToday: 2, todayCount: 1 }, afterLock);
  assert.doesNotMatch(late.reason, /ships today/);
});

test('4 tries by the callers: the lead leaves their queue and the IVR takes it; a promised callback still comes first', () => {
  const four = lead('x', 3000, [4000, 3000, 2000, 1000]);
  assert.equal(four.priority.tier, 'to_ivr'); assert.equal(four.priority.ready, false); assert.match(four.priority.reason, /4 tries/);
  const three = lead('y', 3000, [4000, 3000, 2000]);
  assert.notEqual(three.priority.tier, 'to_ivr');                                                                  // the fourth call is still the callers'
  const cb = lead('z', 3000, [4000, 3000, 2000, 1000], { callback_at: new Date(now.getTime() - 20 * 60000) });
  assert.equal(cb.priority.tier, 'callback_due');                                                                  // a customer promised a call is never dropped
  assert.ok(prioritise.length >= 1); assert.ok(require('../lib/queue').TIER_ORDER.includes('to_ivr'));
});