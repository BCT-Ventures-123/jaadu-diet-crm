const test = require('node:test');
const assert = require('node:assert/strict');
const rq = require('../lib/repeatQueue');

const NOW = new Date('2026-11-28T06:00:00Z');
const H = (h) => new Date(NOW.getTime() + h * 3600e3);
let seq = 0;
const lead = (o = {}) => ({ id: ++seq, phone10: String(9000000000 + seq), acq_month: '2026-06', delivered_orders: 1, last_order_date: '2026-06-10', status: 'new', attempts: 0, unreached: 0, next_due_at: null, ...o });
const many = (n, month, o = {}) => Array.from({ length: n }, (_, i) => lead({ acq_month: month, last_order_date: '2026-' + month.slice(5) + '-' + String(28 - (i % 27)).padStart(2, '0'), ...o }));

test('month and phone cleaning', () => {
  assert.equal(rq.monthKey('June 2026'), '2026-06'); assert.equal(rq.monthKey('October 2026'), '2026-10'); assert.equal(rq.monthKey('2026-09-01'), '2026-09'); assert.equal(rq.monthKey('Smarch 2026'), null); assert.equal(rq.monthKey(''), null);
  assert.equal(rq.tenDigits('+91 98765-43210'), '9876543210'); assert.equal(rq.tenDigits('12345'), ''); assert.equal(rq.tenDigits('09876543210'), '9876543210');
});

test('the mix changes as months run out: June first, then July, then August, then September and October', () => {
  assert.deepEqual(rq.mixFor({ '2026-06': 5, '2026-07': 5 }).weights, { '2026-06': 50, '2026-07': 25, '2026-08': 20, '2026-09': 5 });
  assert.deepEqual(rq.mixFor({ '2026-07': 5, '2026-08': 5 }).weights, { '2026-07': 55, '2026-08': 25, '2026-09': 15, '2026-10': 5 });
  assert.deepEqual(rq.mixFor({ '2026-08': 5, '2026-10': 1 }).weights, { '2026-08': 55, '2026-09': 30, '2026-10': 15 });
  assert.deepEqual(rq.mixFor({ '2026-09': 5, '2026-10': 5 }).weights, { '2026-09': 60, '2026-10': 40 });
  assert.equal(rq.mixFor({ '2026-06': 5 }).phase, 1); assert.equal(rq.mixFor({ '2026-10': 5 }).phase, 4);
});

test('of the first 100 fresh calls in phase 1: 50 June, 25 July, 20 August, 5 September, and no October', () => {
  const fresh = [...many(300, '2026-06'), ...many(300, '2026-07'), ...many(300, '2026-08'), ...many(300, '2026-09'), ...many(300, '2026-10')];
  const { list, phase } = rq.orderFresh(fresh); assert.equal(phase, 1);
  const first100 = list.slice(0, 100), c = {}; first100.forEach(l => { c[l.acq_month] = (c[l.acq_month] || 0) + 1; });
  assert.deepEqual(c, { '2026-06': 50, '2026-07': 25, '2026-08': 20, '2026-09': 5 });
  assert.ok(!list.some(l => l.acq_month === '2026-10'));                                           // October waits for its phase
  const first20 = list.slice(0, 20).reduce((a, l) => { a[l.acq_month] = (a[l.acq_month] || 0) + 1; return a; }, {}); assert.ok(first20['2026-06'] >= 9 && first20['2026-06'] <= 11);   // even through the day, not June first then July
});

test('when June is finished the mix moves on; a month with nothing left drops out and the rest keep their share', () => {
  const fresh = [...many(200, '2026-07'), ...many(200, '2026-08'), ...many(200, '2026-09'), ...many(200, '2026-10')];
  const { list, phase } = rq.orderFresh(fresh); assert.equal(phase, 2);
  const c = {}; list.slice(0, 100).forEach(l => { c[l.acq_month] = (c[l.acq_month] || 0) + 1; }); assert.deepEqual(c, { '2026-07': 55, '2026-08': 25, '2026-09': 15, '2026-10': 5 });
  const only = rq.orderFresh(many(10, '2026-07').concat(many(10, '2026-09'))); assert.equal(only.list.length, 20);   // July with September: nobody is lost
});

test('inside a month the most recent buyers come first', () => {
  const a = lead({ acq_month: '2026-06', last_order_date: '2026-06-02' }), b = lead({ acq_month: '2026-06', last_order_date: '2026-06-28' });
  assert.equal(rq.orderFresh([a, b]).list[0].id, b.id);
});

test('after a call: closes, follow-ups, retries and the rest period', () => {
  const l = lead();
  const sale = rq.afterCall(l, 'sale_done', NOW, {}); assert.equal(sale.closed, true); assert.equal(sale.next_due_at, null);
  assert.equal(rq.afterCall(l, 'not_interested', NOW).closed, true);
  assert.equal(rq.afterCall(l, 'interested', NOW).next_due_at.getTime(), H(24).getTime());
  assert.equal(rq.afterCall(l, 'p2p', NOW, { callback_at: H(5).toISOString() }).next_due_at.getTime(), H(5).getTime());      // a time Aman chose wins
  assert.throws(() => rq.afterCall(l, 'call_back', NOW, {}), /when to call back/);
  assert.equal(rq.afterCall(l, 'call_back', NOW, { callback_at: H(2).toISOString() }).next_due_at.getTime(), H(2).getTime());
  assert.equal(rq.afterCall(l, 'dnp', NOW).next_due_at.getTime(), H(3).getTime()); assert.equal(rq.afterCall(l, 'sw_off', NOW).next_due_at.getTime(), H(4).getTime());
  const tired = rq.afterCall(lead({ unreached: 5, attempts: 5 }), 'dnp', NOW); assert.equal(tired.unreached, 6); assert.equal(tired.next_due_at.getTime(), NOW.getTime() + 3 * 86400e3);   // six tries: rest three days
  assert.equal(rq.afterCall(lead({ unreached: 4, attempts: 4 }), 'interested', NOW).unreached, 0);                              // speaking to the customer clears the count
  assert.throws(() => rq.afterCall(l, 'maybe', NOW));
});

test('follow-ups first: no fresh lead is shown in Ready now while a follow-up or retry is due', () => {
  const fresh = many(5, '2026-06');
  const cb = lead({ status: 'call_back', attempts: 1, next_due_at: H(-1) }), p2p = lead({ status: 'p2p', attempts: 1, next_due_at: H(-30) }), wfc = lead({ status: 'wfc', attempts: 1, next_due_at: H(-50) }), intr = lead({ status: 'interested', attempts: 1, next_due_at: H(-80) });
  const dnp = lead({ status: 'dnp', attempts: 1, unreached: 1, next_due_at: H(-2) }), later = lead({ status: 'wfc', attempts: 1, next_due_at: H(10) }), laterDnp = lead({ status: 'dnp', attempts: 1, next_due_at: H(1) });
  const q = rq.buildQueue([...fresh, intr, wfc, p2p, cb, dnp, later, laterDnp], NOW);
  assert.deepEqual(q.views.ready.map(l => l.id), [cb.id, p2p.id, wfc.id, intr.id, dnp.id]);            // call back, then P2P, WFC, interested (oldest first inside), then retries
  assert.equal(q.counts.ready, 5); assert.equal(q.counts.callbacks, 4); assert.equal(q.counts.retry, 1); assert.equal(q.counts.fresh, 5); assert.equal(q.counts.notdue, 2); assert.equal(q.counts.all, 12);
  assert.equal(q.blocked_fresh, 5); assert.equal(q.views.fresh.length, 5);                          // the Fresh button still shows them
});

test('daily limit: only today\'s share of fresh leads is released, picked by the month mix; the rest wait for later days', () => {
  const fresh = [...many(1000, '2026-06'), ...many(1000, '2026-07'), ...many(1000, '2026-08'), ...many(1000, '2026-09'), ...many(1000, '2026-10')];
  const q = rq.buildQueue(fresh, NOW);                                                   // default limit: 100 a day
  assert.equal(q.counts.ready, 100); assert.equal(q.counts.fresh, 100); assert.equal(q.counts.all, 100);
  const c = {}; q.views.ready.forEach(l => { c[l.acq_month] = (c[l.acq_month] || 0) + 1; }); assert.deepEqual(c, { '2026-06': 50, '2026-07': 25, '2026-08': 20, '2026-09': 5 });
  assert.deepEqual(q.daily, { limit: 100, used_today: 0, released_now: 100, waiting_for_later_days: 4900, fresh_total: 5000 });
});

test('daily limit: first calls already made today use up the share; at the limit nothing fresh is shown; follow-ups are never limited', () => {
  const fresh = many(500, '2026-06'), due = lead({ status: 'wfc', attempts: 1, next_due_at: H(-1) });
  assert.equal(rq.buildQueue(fresh, NOW, rq.settings({}), { freshUsedToday: 30 }).counts.fresh, 70);
  const none = rq.buildQueue(fresh, NOW, rq.settings({}), { freshUsedToday: 100 }); assert.equal(none.counts.ready, 0); assert.equal(none.counts.fresh, 0); assert.equal(none.daily.waiting_for_later_days, 500);
  assert.equal(rq.buildQueue(fresh, NOW, rq.settings({}), { freshUsedToday: 250 }).counts.fresh, 0);                    // over the limit never goes negative
  const withDue = rq.buildQueue([...fresh, due], NOW, rq.settings({}), { freshUsedToday: 100 }); assert.equal(withDue.counts.ready, 1);   // the follow-up still comes
  assert.equal(rq.buildQueue(fresh, NOW, rq.settings({ REPEAT_DAILY_FRESH: '40' })).counts.fresh, 40);                  // the limit can be changed in Railway
});

test('with nothing due, Ready now is the fresh leads in mix order; a future follow-up does not block them', () => {
  const q = rq.buildQueue([...many(4, '2026-06'), lead({ status: 'wfc', attempts: 1, next_due_at: H(6) })], NOW);
  assert.equal(q.counts.ready, 4); assert.equal(q.blocked_fresh, 0); assert.ok(q.views.ready.every(l => l.why === 'fresh'));
  assert.equal(q.views.notdue.length, 1);
});
