const test = require('node:test');
const assert = require('node:assert');
const { buildGoal, shapeStats, attention, deciderChannel, TARGETS } = require('../lib/scorecard');

const ord = (status, o = {}) => ({ status, shipped: false, calls: [], actor: null, actor_role: null, ...o });

test('who decided the order', () => {
  assert.equal(deciderChannel('whatsapp', null), 'whatsapp');
  assert.equal(deciderChannel('ivr_late', null), 'ivr');
  assert.equal(deciderChannel('Aman', 'aman'), 'aman');
  assert.equal(deciderChannel('Agent One', 'agent'), 'cc');
  assert.equal(deciderChannel('system', null), 'other');
  assert.equal(deciderChannel(null, null), 'other');
});

test('goal: 95 reached, 90 shipped, 5 cancelled, 5 not reached adds up and hits every target', () => {
  const rows = [];
  for (let i = 0; i < 90; i++) rows.push(ord('confirmed', { shipped: true, actor: i < 30 ? 'whatsapp' : i < 45 ? 'ivr_call' : 'Agent One', actor_role: i < 45 ? null : 'agent' }));
  for (let i = 0; i < 5; i++) rows.push(ord('cancelled', { actor: 'Agent One', actor_role: 'agent', calls: ['cancelled'] }));
  for (let i = 0; i < 5; i++) rows.push(ord('pending', { calls: ['dnp'] }));
  const g = buildGoal(rows);
  assert.equal(g.total, 100);
  assert.equal(g.reached_pct, 95); assert.equal(g.shipped_pct, 90); assert.equal(g.cancelled_pct, 5); assert.equal(g.not_reached_pct, 5);
  assert.ok(g.status.reached.ok && g.status.shipped.ok && g.status.cancelled.ok && g.status.not_reached.ok);
  assert.deepEqual([g.by_channel.whatsapp.confirmed, g.by_channel.ivr.confirmed, g.by_channel.cc.confirmed], [30, 15, 45]);
});

test('auto-cancelled orders nobody reached are NOT customer cancellations; they count as not reached', () => {
  const g = buildGoal([ord('cancelled', { actor: 'system' }), ord('cancelled', { actor: 'Aman', actor_role: 'aman', calls: ['cancelled'] })]);
  assert.equal(g.auto_cancelled, 1);
  assert.equal(g.not_reached, 1);
  assert.equal(g.cancelled, 1);
  assert.equal(g.reached, 1);
});

test('spoke but still pending counts as reached; untouched or only-DNP does not', () => {
  const g = buildGoal([ord('pending', { calls: ['callback'] }), ord('pending', { calls: ['dnp', 'dnp'] }), ord('pending')]);
  assert.equal(g.spoke_pending, 1);
  assert.equal(g.reached, 1);
  assert.equal(g.not_reached, 2);
});

test('gap tells how many orders short of each target', () => {
  const rows = [];
  for (let i = 0; i < 80; i++) rows.push(ord('confirmed', { shipped: i < 70, actor: 'whatsapp' }));
  for (let i = 0; i < 20; i++) rows.push(ord('pending'));
  const g = buildGoal(rows);
  assert.equal(g.reached_pct, 80);
  assert.equal(g.status.reached.gap, 15);       // need 95, have 80
  assert.equal(g.status.shipped.gap, 20);       // need 90, have 70
  assert.equal(g.status.not_reached.ok, false);
});

test('empty period does not crash', () => {
  const g = buildGoal([]);
  assert.equal(g.total, 0);
  assert.equal(g.reached_pct, 0);
});

const stat = (o) => shapeStats({ calls: 100, orders_called: 80, connected: 40, confirmed: 30, cancelled: 4, dnp: 40, wrong: 2, callbacks: 3, address_fix: 1, ...o.raw }, o.redial);

test('redial rate ignores orders that were resolved some other way', () => {
  const s = stat({ redial: { followed: 60, missed: 20, resolved_other: 30 } });
  assert.equal(s.redial.pct, 75);   // 60 / (60 + 20); the 30 resolved by WhatsApp / IVR do not count against the caller
});

test('flags: missed redials, cancel spike, dnp dodging, idle person, backlog', () => {
  const team = stat({ redial: { followed: 60, missed: 20, resolved_other: 0 } });
  const good = { name: 'Priya', ...stat({ raw: { calls: 120 }, redial: { followed: 30, missed: 1 } }) };
  const cancels = { name: 'Raju', ...stat({ raw: { calls: 100, connected: 40, cancelled: 14, confirmed: 20 }, redial: { followed: 10, missed: 0 } }) };
  const dodger = { name: 'Sunil', ...stat({ raw: { calls: 100, connected: 20, dnp: 80, confirmed: 15 }, redial: { followed: 5, missed: 8 } }) };
  const idle = { name: 'Mona', ...stat({ raw: { calls: 10, orders_called: 10, connected: 5, confirmed: 3, dnp: 5 }, redial: { followed: 2, missed: 0 } }) };
  const f = attention('Call centre', team, [good, cancels, dodger, idle], { fresh_waiting: 7, callbacks_overdue: 2 });
  const text = f.map(x => x.text).join('\n');
  assert.match(text, /Call centre: 20 orders marked "did not pick up" were not called again/);
  assert.match(text, /Call centre: 7 fresh orders/);
  assert.match(text, /2 promised callbacks/);
  assert.match(text, /Raju: cancels 35%/);
  assert.match(text, /Sunil: marks 80% of calls/);
  assert.match(text, /Sunil: did not call back 8/);
  assert.match(text, /Mona: only 10 calls/);
  assert.ok(!/Priya/.test(text));
});

test('targets are the owner\'s numbers', () => {
  assert.equal(TARGETS.reached, 95);
  assert.equal(TARGETS.shipped, 90);
  assert.equal(TARGETS.cancelled_max + TARGETS.not_reached_max, 10);
});
