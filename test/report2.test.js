const test = require('node:test');
const assert = require('node:assert');
const { buildReport2 } = require('../lib/report2');

const base = new Date('2026-11-05T06:30:00Z');                 // 12:00 India time
const at = (min) => new Date(base.getTime() + min * 60000);
const row = (o) => ({ day: '2026-11-05', order_at: base, decided_at: null, status: 'pending', calls: [], call_times: [], actor: null, actor_role: null, dnc: false, ...o });
const callConfirm = (gapMin, decideMin) => row({ status: 'confirmed', calls: ['confirmed'], call_times: [at(gapMin)], decided_at: at(decideMin), actor: 'Aman', actor_role: 'aman' });

function sample() {
  return [
    callConfirm(10, 12),                                                                   // call confirmed, first call after 10 min
    callConfirm(45, 50),                                                                   // call confirmed after 45 min
    row({ status: 'confirmed', decided_at: at(300), actor: 'whatsapp' }),                  // WhatsApp confirmed, D0
    row({ status: 'confirmed', decided_at: at(60 * 30), actor: 'ivr_call' }),              // IVR confirmed, D1
    row({ status: 'cancelled', calls: ['cancelled'], call_times: [at(20)], decided_at: at(25), actor: 'Priya', actor_role: 'agent' }), // call cancelled
    row({ status: 'cancelled', decided_at: at(60 * 80), actor: 'system' }),                // cancelled without a call
    row({ calls: ['dnp', 'dnp'], call_times: [at(30), at(200)] }),                         // called, nobody answered
    row({ calls: ['callback'], call_times: [at(90)] }),                                    // spoke, not decided
    row({ status: 'wrong_number', calls: ['wrong_number'], call_times: [at(15)] }),        // ops issue
    row({}),                                                                               // awaiting first call
  ];
}

test('every order lands in exactly one outcome, so the outcome table adds up to the orders', () => {
  const r = buildReport2(sample(), [], 1);
  assert.equal(r.outcomes.reduce((s, x) => s + x.orders, 0), 10);
  const get = (k) => r.outcomes.find(x => x.key === k).orders;
  assert.deepEqual(['wa_confirmed', 'ivr_confirmed', 'call_confirmed', 'call_cancelled', 'other_cancelled', 'call_no_response', 'in_progress', 'ops_issue', 'awaiting_call'].map(get), [1, 1, 2, 1, 1, 1, 1, 1, 1]);
});

test('overview: confirmed, cancelled, connectivity and the calling block', () => {
  const o = buildReport2(sample(), [], 1).overview;
  assert.equal(o.orders, 10);
  assert.equal(o.confirmed, 4); assert.equal(o.cancelled, 2); assert.equal(o.unconfirmed, 3);
  assert.equal(o.reached, 6);                              // 2 call confirmed + WhatsApp + IVR + call cancelled + spoke-not-decided
  assert.equal(o.calling.orders_called, 6);
  assert.equal(o.calling.calls_made, 7);
  assert.equal(o.calling.connected_calls, 4);              // confirmed x2, cancelled, callback
  assert.equal(o.calling.median_to_first_call_min, 25);    // gaps 10, 15, 20, 30, 45, 90: median is 25
});

test('timing: confirm rate by gap to the first call', () => {
  const t = buildReport2(sample(), [], 1).timing.first_call;
  assert.equal(t[0].orders, 3); assert.equal(t[0].confirmed, 1);          // 0-30 min: 10, 20, 15
  assert.equal(t[1].orders, 2); assert.equal(t[1].confirmed, 1);          // 30-60 min: 45, 30
  assert.equal(t[2].orders, 1);                                          // 1-2 h: 90
});

test('attempts: connect rate per attempt number, cumulative confirmed uses all orders', () => {
  const a = buildReport2(sample(), [], 1).attempts;
  assert.equal(a[0].calls_made, 6); assert.equal(a[0].connected, 4); assert.equal(a[0].confirmed_on_call, 2);
  assert.equal(a[1].calls_made, 1); assert.equal(a[1].connected, 0);
  assert.equal(a[0].cumulative_confirmed_pct, 20);
});

test('journey: D0 / D1 / D2+ by channel', () => {
  const j = buildReport2(sample(), [], 1).journey;
  const d0 = j.find(x => x.window === 'd0'), d1 = j.find(x => x.window === 'd1');
  assert.deepEqual([d0.wa, d0.call, d0.confirmed], [1, 2, 3]);
  assert.deepEqual([d1.ivr, d1.confirmed], [1, 1]);
  assert.equal(j.find(x => x.window === 'd2').cancelled, 1);
});

test('by hour: orders and calls land in India-time hours', () => {
  const r = buildReport2(sample(), [{ hour: 12, calls: 8, connected: 4, confirmed: 2, no_response: 2 }], 2);
  const h = r.by_hour[12];
  assert.equal(h.orders, 10); assert.equal(h.avg_orders_per_day, 5);
  assert.equal(h.calls, 8); assert.equal(h.connect_pct, 50);
  assert.equal(r.by_hour[3].orders, 0);
  assert.equal(r.grid[0].hours[12], 10);
});

test('daily: connectivity within 24 h, 48 h and ever', () => {
  const d = buildReport2(sample(), [], 1).daily[0];
  assert.equal(d.orders, 10); assert.equal(d.confirmed, 4); assert.equal(d.confirmed_d0, 3);
  assert.equal(d.connectivity_all_pct, 60);
  assert.equal(d.connectivity_d0_pct, 50);                  // IVR was reached on day 1, so 5 of 10 within 24 h
});

test('empty input does not divide by zero', () => {
  const r = buildReport2([], [], 1);
  assert.equal(r.overview.orders, 0); assert.equal(r.overview.confirmed_pct, null); assert.equal(r.outcomes.reduce((s, x) => s + x.orders, 0), 0);
});
