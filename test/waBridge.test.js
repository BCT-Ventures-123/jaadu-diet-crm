const test = require('node:test');
const assert = require('node:assert/strict');
const wa = require('../lib/waBridge');

const S = wa.settings({ WA_MODE: 'on', WA_GO_LIVE: '2026-11-20T00:00:00Z', WA_SHARED_KEY: 'k', IVR_TEST_NUMBERS: '9076219087,8459803501', WA_ENABLED_KEYS: 'confirm,reminder_1,reminder_2,reminder_3,reminder_4', WA_MAX_REMINDERS: '3' });   // same-day reminders are capped at 2 (three messages a day); steps 3 and 4 are the next-morning messages
const T = (s) => new Date(s);
const DAY = '2026-11-21T06:30:00Z';        // 12:00 noon in India
const NIGHT = '2026-11-21T17:00:00Z';      // 22:30 in India
const base = { created_at: DAY, phone: '9876543210', last_step: null, last_status: null };

test('wa settings: modes, tolerant values, safe defaults', () => {
  assert.equal(wa.settings({}).mode, 'off');
  for (const v of ['on', 'ON', ' "on" ', 'true', '1', 'yes']) assert.equal(wa.settings({ WA_MODE: v }).mode, 'on');
  assert.equal(wa.settings({ WA_MODE: 'test' }).mode, 'test'); assert.equal(wa.settings({ WA_MODE: 'maybe' }).mode, 'off');
  const d = wa.settings({});
  assert.deepEqual(d.enabledKeys, ['confirm', 'reminder_1', 'reminder_2', 'reminder_3', 'reminder_4']);   // all five messages use the approved confirm template
  assert.equal(d.followups, 2); assert.equal(d.dayHourFixed, null); assert.equal(d.followupMaxAgeDays, 4); assert.equal(d.followupPace, 20);
  assert.equal(wa.settings({ WA_DAY_HOUR: '10' }).dayHourFixed, 10); assert.equal(wa.settings({ WA_DAY_HOUR: '3' }).dayHourFixed, 8); assert.equal(wa.settings({ WA_DAILY_FOLLOWUPS: '9' }).followups, 2);
  assert.equal(d.reminderHours, 4); assert.equal(d.maxReminders, 2); assert.equal(d.busyHoldMinutes, 30); assert.equal(d.holdMinutes, 0); assert.equal(d.quietFrom, 21); assert.equal(d.quietTo, 8); assert.equal(d.minAmount, 350);
  assert.equal(wa.settings({ WA_MAX_REMINDERS: '9' }).maxReminders, 2);                       // never more than 2 same-day reminders (3 messages a day)
  assert.deepEqual(S.testNumbers, ['9076219087', '8459803501']);
  assert.equal(wa.settings({ WA_GO_LIVE: 'garbage' }).goLive, null);
});

test('wa numbers: digits with country code only for a real Indian mobile', () => {
  assert.equal(wa.waNumber('+91 98765 43210'), '919876543210'); assert.equal(wa.waNumber('09876543210'), '919876543210');
  assert.equal(wa.waNumber('12345'), null); assert.equal(wa.waNumber('5876543210'), null); assert.equal(wa.waNumber(''), null);
});

test('wa quiet hours: none between 21:00 and 08:00 India time', () => {
  assert.equal(wa.inQuiet(T('2026-11-21T15:30:00Z'), S), true);    // 21:00 IST
  assert.equal(wa.inQuiet(T('2026-11-21T20:00:00Z'), S), true);    // 01:30 IST
  assert.equal(wa.inQuiet(T('2026-11-21T02:29:00Z'), S), true);    // 07:59 IST
  assert.equal(wa.inQuiet(T('2026-11-21T02:30:00Z'), S), false);   // 08:00 IST
  assert.equal(wa.inQuiet(T('2026-11-21T15:29:00Z'), S), false);   // 20:59 IST
  assert.equal(wa.quietEnds(T(NIGHT), S).toISOString(), '2026-11-22T02:30:00.000Z');   // next 08:00 IST
  assert.equal(wa.quietEnds(T('2026-11-21T20:00:00Z'), S).toISOString(), '2026-11-22T02:30:00.000Z');
});

test('wa decide: a new order gets the confirmation at once, at ANY hour (night too)', () => {
  const d = wa.decide(base, T(DAY), S); assert.equal(d.action, 'offer'); assert.equal(d.step, 0); assert.equal(d.template_key, 'confirm');
  const n = wa.decide(base, T(NIGHT), S); assert.equal(n.action, 'offer'); assert.equal(n.step, 0); assert.equal(n.template_key, 'confirm');
});

test('wa decide: stop rules', () => {
  assert.deepEqual(wa.decide({ ...base, opted_out: true }, T(DAY), S).reason, 'opted_out');
  assert.equal(wa.decide({ ...base, wa_stop: true }, T(DAY), S).action, 'stop');
  assert.equal(wa.decide({ ...base, phone: '123' }, T(DAY), S).reason, 'bad_phone');
  const f = wa.decide({ ...base, last_step: 0, last_status: 'failed', last_error: '131026' }, T(DAY), S); assert.equal(f.action, 'stop'); assert.equal(f.reason, 'not_on_whatsapp');
  assert.equal(wa.decide({ ...base, last_step: 0, last_status: 'failed', last_error: '130429' }, T(DAY), S).reason, 'send_failed');
});

test('wa decide: reminders come 4 hours after the previous message was SENT, at most 3', () => {
  const sent = (step, at) => ({ ...base, last_step: step, last_status: 'sent', last_sent_at: at });
  const w = wa.decide(sent(0, '2026-11-21T04:00:00Z'), T('2026-11-21T07:59:00Z'), S); assert.equal(w.action, 'wait'); assert.equal(w.reason, 'not_yet');
  const r1 = wa.decide(sent(0, '2026-11-21T04:00:00Z'), T('2026-11-21T08:00:00Z'), S); assert.equal(r1.action, 'offer'); assert.equal(r1.step, 1); assert.equal(r1.template_key, 'reminder_1');
  assert.equal(wa.decide(sent(1, '2026-11-21T04:00:00Z'), T('2026-11-21T08:00:00Z'), S).template_key, 'reminder_2');
  const m1 = wa.decide(sent(2, '2026-11-21T04:00:00Z'), T('2026-11-21T08:00:00Z'), S); assert.equal(m1.action, 'wait'); assert.equal(m1.reason, 'next_morning'); assert.equal(m1.not_before.toISOString(), '2026-11-22T03:30:00.000Z');   // 9 AM India, at least 16 h after the last message
  assert.equal(wa.decide(sent(2, '2026-11-21T04:00:00Z'), T('2026-11-22T03:29:00Z'), S).action, 'wait');
  const m4 = wa.decide(sent(2, '2026-11-21T04:00:00Z'), T('2026-11-22T03:30:00Z'), S); assert.equal(m4.action, 'offer'); assert.equal(m4.step, 3); assert.equal(m4.template_key, 'reminder_3'); assert.equal(m4.reason, 'next_morning');
  const m5 = wa.decide(sent(3, '2026-11-22T03:30:00Z'), T('2026-11-23T03:30:00Z'), S); assert.equal(m5.action, 'offer'); assert.equal(m5.step, 4); assert.equal(m5.template_key, 'reminder_4');
  assert.equal(wa.decide(sent(3, '2026-11-22T03:30:00Z'), T('2026-11-23T03:29:00Z'), S).action, 'wait');
  assert.equal(wa.decide(sent(4, '2026-11-23T03:30:00Z'), T('2026-11-24T03:30:00Z'), S).reason, 'all_followups_sent');                                          // never a sixth message
  assert.equal(wa.decide(sent(2, '2026-11-21T04:00:00Z'), T('2026-11-22T03:30:00Z'), wa.settings({ WA_MODE: 'on', WA_ENABLED_KEYS: 'confirm,reminder_1,reminder_2', WA_DAILY_FOLLOWUPS: '0' })).reason, 'all_followups_sent');   // switched off
  assert.equal(wa.decide({ ...sent(2, '2026-11-25T04:00:00Z'), created_at: '2026-11-21T06:30:00Z' }, T('2026-11-26T03:30:00Z'), S).reason, 'too_old');          // an order older than 4 days is left to the callers and the IVR
  const eleven = wa.settings({ WA_MODE: 'on', WA_DAY_HOUR: '11', WA_ENABLED_KEYS: 'confirm,reminder_1,reminder_2,reminder_3' }); eleven.dayHour = eleven.dayHourFixed;      // a fixed hour of 11 AM India = 05:30 UTC
  assert.equal(wa.decide(sent(2, '2026-11-21T04:00:00Z'), T('2026-11-22T05:29:00Z'), eleven).action, 'wait');
  assert.equal(wa.decide(sent(2, '2026-11-21T04:00:00Z'), T('2026-11-22T05:30:00Z'), eleven).action, 'offer');
  assert.equal(wa.nextMorning(Date.parse('2026-11-21T04:00:00Z'), { dayHour: 11 }).toISOString(), '2026-11-22T05:30:00.000Z');
  const lim = wa.settings({ WA_MAX_REMINDERS: '1' }); assert.equal(wa.decide(sent(1, '2026-11-20T04:00:00Z'), T('2026-11-21T08:00:00Z'), lim).reason, 'all_reminders_sent');
  const q = wa.decide(sent(0, '2026-11-21T10:00:00Z'), T('2026-11-21T16:00:00Z'), S); assert.equal(q.reason, 'quiet_hours');   // due at 14:00 UTC, asked at 21:30 IST
});

test('wa decide: a person who really spoke to the customer holds the reminder back; an IVR call or a planned callback does not; never the first message', () => {
  const sent0 = { ...base, last_step: 0, last_status: 'sent', last_sent_at: '2026-11-21T01:00:00Z' };
  assert.equal(wa.decide({ ...sent0, person_spoke_at: '2026-11-21T05:00:00Z' }, T(DAY), S).reason, 'person_spoke_recently');
  assert.equal(wa.decide({ ...sent0, person_spoke_at: '2026-11-21T02:00:00Z' }, T(DAY), S).action, 'offer');          // spoke 4.5 h ago: fine
  assert.equal(wa.decide({ ...sent0, ivr_at: '2026-11-21T06:00:00Z' }, T(DAY), S).action, 'offer');                    // owner: no wait after an IVR call
  assert.equal(wa.decide({ ...sent0, callback_at: '2026-11-21T09:00:00Z' }, T(DAY), S).action, 'offer');               // owner: no wait for a planned callback
  assert.equal(wa.decide({ ...base, person_spoke_at: DAY }, T(DAY), S).action, 'offer');                                // step 0 is not held back
});

test('wa decide: a message that was leased but not reported is offered again only after the lease ends', () => {
  const l = { ...base, last_step: 0, last_status: 'leased', last_lease_until: '2026-11-21T06:40:00Z' };
  assert.equal(wa.decide(l, T(DAY), S).reason, 'leased');
  const again = wa.decide(l, T('2026-11-21T06:41:00Z'), S); assert.equal(again.action, 'offer'); assert.equal(again.step, 0);
  assert.equal(wa.decide({ ...base, last_step: 1, last_status: 'skipped' }, T(DAY), S).step, 1);
});

// ---- a tiny fake database ----
function fakeDb(h = {}) {
  const log = [];
  const db = async (sql, p = []) => {
    log.push({ sql, p });
    for (const [re, fn] of Object.entries(h)) if (new RegExp(re, 's').test(sql)) return fn(sql, p);
    if (/CREATE (TABLE|INDEX)/.test(sql)) return [];
    if (/to_regclass/.test(sql)) return [{ t: null }];
    return [];
  };
  db.log = log; return db;
}
const order = (o = {}) => ({ id: 'o1', order_name: '#40001', customer_name: 'Ramesh Kumar', phone: '9876543210', total_price: '599', created_at: DAY, callback_at: null, last_step: null, last_status: null, last_sent_at: null, last_lease_until: null, last_error: null, person_spoke_at: null, ivr_at: null, wa_stop: false, opted_out: false, shipping_address1: '12 MG Road', shipping_address2: '', shipping_city: 'Pune', shipping_province: 'Maharashtra', shipping_zip: '411001', ...o });

test('wa queue: off = nothing; on without a go-live time = nothing for real orders', async () => {
  wa._reset();
  const db = fakeDb({ 'FROM orders_master o': () => [order()] });
  assert.deepEqual((await wa.queue(db, T(DAY), { WA_MODE: 'off', WA_SHARED_KEY: 'k' })).items, []);
  assert.equal(db.log.filter(l => /FROM orders_master o/.test(l.sql)).length, 0);
  assert.deepEqual((await wa.queue(db, T(DAY), { WA_MODE: 'on', WA_SHARED_KEY: 'k' })).items, []);
});

test('wa queue: on = the new order is offered with the exact contract shape and leased for 10 minutes', async () => {
  wa._reset();
  const db = fakeDb({ 'FROM orders_master o': () => [order()], 'INSERT INTO wa_messages': () => [{ send_id: 'x' }] });
  const q = await wa.queue(db, T(DAY), { WA_MODE: 'on', WA_GO_LIVE: '2026-11-20T00:00:00Z', WA_SHARED_KEY: 'k' });
  assert.equal(q.mode, 'on'); assert.equal(q.items.length, 1);
  const it = q.items[0];
  assert.deepEqual(it, { send_id: 'o1-s0', order_id: 'o1', order_name: '#40001', step: 0, template_key: 'confirm', to: '919876543210',
    variables: { customer_name: 'Ramesh', amount: '599', order_name: '#40001', product: 'Arjuna Cardio Care Tea', delivery_address: '12 MG Road, Pune, Maharashtra, 411001' }, lease_until: '2026-11-21T06:40:00.000Z' });
});

test('wa queue: if another poll already took the message, it is not returned twice', async () => {
  wa._reset();
  const db = fakeDb({ 'FROM orders_master o': () => [order()], 'INSERT INTO wa_messages': () => [] });
  assert.deepEqual((await wa.queue(db, T(DAY), { WA_MODE: 'on', WA_GO_LIVE: '2026-11-20T00:00:00Z' })).items, []);
});

test('wa queue: test mode only ever reaches the owner\'s own numbers', async () => {
  wa._reset();
  const db = fakeDb({ 'FROM orders_master o': () => [order({ id: 'a', phone: '9000000001' }), order({ id: 'b', phone: '9076219087', order_name: '#2' })], 'INSERT INTO wa_messages': () => [{ send_id: 'x' }] });
  const q = await wa.queue(db, T(DAY), { WA_MODE: 'test', IVR_TEST_NUMBERS: '9076219087', WA_SHARED_KEY: 'k' });
  assert.deepEqual(q.items.map(i => i.to), ['919076219087']);
});

test('wa queue: a customer who already has a message sent 1 hour ago gets nothing yet; confirmed orders are never selected', async () => {
  wa._reset();
  const db = fakeDb({ 'FROM orders_master o': (sql) => { assert.match(sql, /confirmation_status = 'pending'/); assert.match(sql, /UPPER\(COALESCE\(o\.payment_method, 'COD'\)\) = 'COD'/); assert.match(sql, /is_blacklisted/); assert.match(sql, /wrong_number_at IS NULL/); return [order({ last_step: 0, last_status: 'sent', last_sent_at: '2026-11-21T05:30:00Z' })]; } });
  assert.deepEqual((await wa.queue(db, T(DAY), { WA_MODE: 'on', WA_GO_LIVE: '2026-11-20T00:00:00Z' })).items, []);
});

test('wa queue: a test message the owner asked for is offered once and only to a test number', async () => {
  wa._reset();
  const db = fakeDb({ 'FROM wa_messages WHERE is_test': () => [{ send_id: 'test-1', order_name: 'TEST', phone10: '9076219087', step: 0, template_key: 'confirm', variables: { customer_name: 'Test' } }, { send_id: 'test-2', order_name: 'TEST', phone10: '9111111111', step: 0, template_key: 'confirm', variables: {} }],
    'INSERT INTO wa_messages': () => [{ send_id: 'x' }], 'FROM orders_master o': () => [] });
  const q = await wa.queue(db, T(DAY), { WA_MODE: 'test', IVR_TEST_NUMBERS: '9076219087' });
  assert.deepEqual(q.items.map(i => i.send_id), ['test-1']); assert.equal(q.items[0].order_id, null);
});

const msg = (o = {}) => ({ send_id: 'o1-s0', order_id: 'o1', order_name: '#40001', phone10: '9876543210', step: 0, is_test: false, status: 'leased', ...o });

test('wa result: unknown event or unknown message is refused', async () => {
  wa._reset();
  const db = fakeDb({ 'FROM wa_messages WHERE send_id': () => [] });
  assert.equal((await wa.result(db, { send_id: 'z', event: 'sent' })).status, 404);
  assert.equal((await wa.result(db, { send_id: 'z', event: 'exploded' })).status, 400);
});

test('wa result: the same event twice is a harmless duplicate', async () => {
  wa._reset();
  const db = fakeDb({ 'FROM wa_messages WHERE send_id': () => [msg()], 'INSERT INTO wa_events': () => [] });
  const r = await wa.result(db, { send_id: 'o1-s0', event: 'clicked_confirm', provider_message_id: 'wamid.1', at: DAY });
  assert.deepEqual(r, { status: 200, body: { ok: true, duplicate: true } });
  assert.equal(db.log.filter(l => /UPDATE orders_master/.test(l.sql)).length, 0);
});

test('wa result: Confirm confirms a pending order once and writes one history line from whatsapp', async () => {
  wa._reset();
  let confirmed = false;
  const db = fakeDb({ 'FROM wa_messages WHERE send_id': () => [msg({ status: 'sent' })], 'INSERT INTO wa_events': () => [{ id: 7 }],
    "SET confirmation_status = 'confirmed'": () => { confirmed = true; return [{ id: 'o1' }]; } });
  const r = await wa.result(db, { send_id: 'o1-s0', event: 'clicked_confirm', provider_message_id: 'wamid.1', at: DAY });
  assert.equal(r.body.applied, 'confirmed_order'); assert.ok(confirmed);
  const hist = db.log.find(l => /log_status_change/.test(l.sql)); assert.equal(hist.p[0], 'o1'); assert.match(hist.sql, /'whatsapp'/);
  assert.match(db.log.find(l => /SET confirmation_status = 'confirmed'/.test(l.sql)).sql, /confirmation_status = 'pending'/);   // only a pending order changes
});

test('wa result: Confirm on an order someone else already finished changes nothing', async () => {
  wa._reset();
  const db = fakeDb({ 'FROM wa_messages WHERE send_id': () => [msg()], 'INSERT INTO wa_events': () => [{ id: 7 }], "SET confirmation_status = 'confirmed'": () => [] });
  const r = await wa.result(db, { send_id: 'o1-s0', event: 'clicked_confirm', provider_message_id: 'wamid.1' });
  assert.equal(r.body.applied, 'order_not_pending'); assert.equal(db.log.filter(l => /log_status_change/.test(l.sql)).length, 0);
});

test('wa result: a tap on an order that is no longer pending changes nothing and says where the order stands (confirmed, shipped, cancelled)', async () => {
  const stateOf = (row) => fakeDb({ 'FROM wa_messages WHERE send_id': () => [msg({ status: 'sent' })], 'INSERT INTO wa_events': () => [{ id: 9 }], 'SELECT confirmation_status, order_status FROM orders_master': () => [row] });
  for (const [row, want] of [[{ confirmation_status: 'confirmed', order_status: 'pending' }, 'confirmed'], [{ confirmation_status: 'confirmed', order_status: 'shipped' }, 'shipped'],
                            [{ confirmation_status: 'cancelled', order_status: 'cancelled' }, 'cancelled'], [{ confirmation_status: 'confirmed', order_status: 'out_for_delivery' }, 'shipped']]) {
    wa._reset();
    const db = stateOf(row);
    const r = await wa.result(db, { send_id: 'o1-s0', event: 'clicked_cancel', provider_message_id: 'wamid.x' + want });
    assert.equal(r.body.applied, 'order_not_pending'); assert.equal(r.body.order_state, want);
    assert.equal(db.log.filter(l => /SET callback_at/.test(l.sql) && l.p && l.p[0] === 'o1' && /RETURNING/.test(l.sql)).length, 1);   // the guarded UPDATE ran, but only touches a pending order
  }
});

test('wa result: a tap on an OLD message (only the Shopify order id) is found by that id and handled like any other tap', async () => {
  wa._reset();
  let confirmed = false;
  const byShopify = () => [{ id: 'o1', order_name: '#40001', phone10: '9876543210' }];
  const db = fakeDb({ 'FROM orders_master WHERE shopify_order_id': byShopify, 'INSERT INTO wa_events': () => [{ id: 7 }], "SET confirmation_status = 'confirmed'": () => { confirmed = true; return [{ id: 'o1' }]; } });
  const r = await wa.result(db, { send_id: 'legacy-1234567890', shopify_order_id: '1234567890', event: 'clicked_confirm', provider_message_id: 'wamid.tap1' });
  assert.equal(r.status, 200); assert.equal(r.body.applied, 'confirmed_order'); assert.equal(r.body.order_name, '#40001'); assert.equal(r.order_id, 'o1'); assert.ok(confirmed);
  assert.ok(db.log.some(l => /INSERT INTO wa_events/.test(l.sql) && l.p[1] === 'legacy-1234567890' && l.p[2] === 'o1'));
  // Cancel and Change address from an old message: a person calls back, nothing is cancelled
  const db2 = fakeDb({ 'FROM orders_master WHERE shopify_order_id': byShopify, 'INSERT INTO wa_events': () => [{ id: 8 }], 'SET callback_at = NOW': () => [{ id: 'o1' }] });
  const c = await wa.result(db2, { send_id: 'legacy-1234567890', shopify_order_id: '1234567890', event: 'clicked_cancel', provider_message_id: 'wamid.tap2' });
  assert.equal(c.body.applied, 'followup_set'); assert.equal(db2.log.filter(l => /confirmation_status = 'cancelled'/.test(l.sql)).length, 0);
  // an unknown order, or a bad id, or an event that is not a tap: nothing happens
  assert.equal((await wa.result(fakeDb(), { send_id: 'legacy-999999', shopify_order_id: '999999', event: 'clicked_confirm' })).status, 404);
  assert.equal((await wa.result(fakeDb({ 'FROM orders_master WHERE shopify_order_id': byShopify }), { send_id: 'x', shopify_order_id: '12; DROP', event: 'clicked_confirm' })).status, 404);
  assert.equal((await wa.result(fakeDb({ 'FROM orders_master WHERE shopify_order_id': byShopify }), { send_id: 'x', shopify_order_id: '1234567890', event: 'sent' })).status, 404);
});

test('wa result: Cancel and Change address never change the order, they ask a person to call', async () => {
  wa._reset();
  for (const ev of ['clicked_cancel', 'clicked_change_address']) {
    const db = fakeDb({ 'FROM wa_messages WHERE send_id': () => [msg()], 'INSERT INTO wa_events': () => [{ id: 1 }], 'SET callback_at = NOW': () => [{ id: 'o1' }] });
    const r = await wa.result(db, { send_id: 'o1-s0', event: ev, provider_message_id: 'wamid.' + ev });
    assert.equal(r.body.applied, 'followup_set');
    const up = db.log.find(l => /SET callback_at = NOW/.test(l.sql)); assert.doesNotMatch(up.sql, /cancelled/); assert.doesNotMatch(up.sql, /order_status/);
    assert.match(up.p[1], ev === 'clicked_cancel' ? /try to save/ : /fix the address/);
  }
});

test('wa result: a test message never touches an order', async () => {
  wa._reset();
  const db = fakeDb({ 'FROM wa_messages WHERE send_id': () => [msg({ send_id: 'test-1', order_id: null, is_test: true })], 'INSERT INTO wa_events': () => [{ id: 1 }] });
  const r = await wa.result(db, { send_id: 'test-1', event: 'clicked_confirm', provider_message_id: 'wamid.t' });
  assert.equal(r.body.applied, 'recorded'); assert.equal(db.log.filter(l => /orders_master/.test(l.sql)).length, 0);
});

test('wa result: sent starts the 4-hour clock; the optional wait locks the lead for the callers only when WA_HOLD_MINUTES is set', async () => {
  wa._reset();
  const mk = () => fakeDb({ 'FROM wa_messages WHERE send_id': () => [msg()], 'INSERT INTO wa_events': () => [{ id: 1 }] });
  const a = mk(); await wa.result(a, { send_id: 'o1-s0', event: 'sent', provider_message_id: 'wamid.1', at: DAY }, T(DAY), { WA_MODE: 'on', WA_BUSY_HOLD_MINUTES: '0' });
  assert.ok(a.log.some(l => /SET status = 'sent'/.test(l.sql))); assert.equal(a.log.filter(l => /lead_locked_by = 'WHATSAPP'/.test(l.sql)).length, 0);
  const b = mk(); await wa.result(b, { send_id: 'o1-s0', event: 'sent', provider_message_id: 'wamid.1', at: DAY }, T(DAY), { WA_MODE: 'on', WA_HOLD_MINUTES: '30' });
  const lock = b.log.find(l => /lead_locked_by = 'WHATSAPP'/.test(l.sql)); assert.equal(lock.p[1].toISOString(), '2026-11-21T06:45:00.000Z');   // sent 06:30 + (30 - 15) minutes: the callers see it from 07:00
});

test('wa result: failed and optout are saved; an opt-out blocks the phone for good', async () => {
  wa._reset();
  const db = fakeDb({ 'FROM wa_messages WHERE send_id': () => [msg()], 'INSERT INTO wa_events': () => [{ id: 1 }] });
  await wa.result(db, { send_id: 'o1-s0', event: 'failed', error_code: 131026, error_text: 'undeliverable' });
  assert.ok(db.log.some(l => /ELSE 'failed' END/.test(l.sql) && l.p[1] === '131026'));
  const db2 = fakeDb({ 'FROM wa_messages WHERE send_id': () => [msg()], 'INSERT INTO wa_events': () => [{ id: 1 }] });
  const r = await wa.result(db2, { send_id: 'o1-s0', event: 'optout', provider_message_id: 'wamid.s' });
  assert.equal(r.body.applied, 'optout_saved'); assert.ok(db2.log.some(l => /INSERT INTO wa_optouts/.test(l.sql) && l.p[0] === '9876543210'));
});

test('wa check: the last look before a send', async () => {
  wa._reset();
  const env = { WA_MODE: 'on', WA_GO_LIVE: '2026-11-20T00:00:00Z', WA_ENABLED_KEYS: 'confirm,reminder_1,reminder_2,reminder_3', WA_MAX_REMINDERS: '3' };
  const m = msg();
  const ok = fakeDb({ 'FROM wa_messages WHERE send_id': () => [m], 'FROM orders_master o': () => [order({ id: 'o1' })] });
  assert.deepEqual(await wa.check(ok, 'o1-s0', T(DAY), env), { send: true });
  const one = ok.log.find(l => /FROM orders_master o/.test(l.sql)); assert.match(one.sql, /AND o\.id = \$4/); assert.equal(one.p[3], 'o1');   // only this order is loaded
  const gone = fakeDb({ 'FROM wa_messages WHERE send_id': () => [m], 'FROM orders_master o': () => [] });                 // confirmed or cancelled meanwhile
  assert.deepEqual(await wa.check(gone, 'o1-s0', T(DAY), env), { send: false, reason: 'order_no_longer_pending' });
  assert.equal((await wa.check(fakeDb({ 'FROM wa_messages WHERE send_id': () => [msg({ status: 'sent' })] }), 'o1-s0', T(DAY), env)).reason, 'already_sent');
  assert.equal((await wa.check(fakeDb({ 'FROM wa_messages WHERE send_id': () => [] }), 'nope', T(DAY), env)).reason, 'unknown_send_id');
  assert.deepEqual(await wa.check(ok, 'o1-s0', T(NIGHT), env), { send: true });                                             // the first message goes at any hour
  const nightRem = fakeDb({ 'FROM wa_messages WHERE send_id': () => [msg({ send_id: 'o1-s1', step: 1, template_key: 'reminder_1' })], 'FROM orders_master o': () => [order({ id: 'o1' })] });
  assert.equal((await wa.check(nightRem, 'o1-s1', T(NIGHT), env)).reason, 'quiet_hours');                                    // a reminder never goes at night
  assert.equal((await wa.check(ok, 'o1-s0', T(DAY), { WA_MODE: 'off' })).reason, 'mode_off');
  const optout = fakeDb({ 'FROM wa_messages WHERE send_id': () => [m], 'FROM orders_master o': () => [order({ opted_out: true })] });
  assert.equal((await wa.check(optout, 'o1-s0', T(DAY), env)).reason, 'opted_out');
  const rem = msg({ send_id: 'o1-s1', step: 1 });
  const spoke = fakeDb({ 'FROM wa_messages WHERE send_id': () => [rem], 'FROM orders_master o': () => [order({ person_spoke_at: '2026-11-21T05:30:00Z' })] });
  assert.equal((await wa.check(spoke, 'o1-s1', T(DAY), env)).reason, 'person_spoke_recently');
  const testNum = fakeDb({ 'FROM wa_messages WHERE send_id': () => [msg({ is_test: true, order_id: null, phone10: '9000000009' })] });
  assert.equal((await wa.check(testNum, 'x', T(DAY), { ...env, IVR_TEST_NUMBERS: '9076219087' })).reason, 'not_a_test_number');
});

test('wa key: compared safely, empty never matches', () => {
  assert.equal(wa.safeEqual('abc', 'abc'), true); assert.equal(wa.safeEqual('abc', 'abd'), false); assert.equal(wa.safeEqual('', ''), false); assert.equal(wa.safeEqual(undefined, 'x'), false);
});

test('wa test message: only to the owner\'s own numbers, at most 10 an hour', async () => {
  wa._reset();
  const db = fakeDb({ 'COUNT\\(\\*\\)::int AS n FROM wa_messages': () => [{ n: 0 }] });
  const ok = await wa.testMessage(db, 0, 'confirm', T(DAY), { WA_MODE: 'test', IVR_TEST_NUMBERS: '9076219087' }); assert.equal(ok.ok, true); assert.match(ok.send_id, /^test-/);
  assert.equal((await wa.testMessage(db, 5, 'confirm', T(DAY), { IVR_TEST_NUMBERS: '9076219087' })).ok, false);
  assert.equal((await wa.testMessage(db, 0, 'nope', T(DAY), { IVR_TEST_NUMBERS: '9076219087' })).ok, false);
  const busy = fakeDb({ 'COUNT\\(\\*\\)::int AS n FROM wa_messages': () => [{ n: 10 }] });
  assert.equal((await wa.testMessage(busy, 0, 'confirm', T(DAY), { IVR_TEST_NUMBERS: '9076219087' })).ok, false);
});


test('wa queue: an order without an address still gets a sendable text (the sender refuses an empty variable)', async () => {
  wa._reset();
  const db = fakeDb({ 'FROM orders_master o': () => [order({ shipping_address1: null, shipping_city: null, shipping_province: null, shipping_zip: null })], 'INSERT INTO wa_messages': () => [{ send_id: 'x' }] });
  const q = await wa.queue(db, T(DAY), { WA_MODE: 'on', WA_GO_LIVE: '2026-11-20T00:00:00Z' });
  assert.equal(q.items[0].variables.delivery_address, 'the address on your order');
});

test('wa decide: only enabled messages are offered (reminders wait until their templates are approved)', () => {
  const only = wa.settings({ WA_ENABLED_KEYS: 'confirm' });
  assert.deepEqual(only.enabledKeys, ['confirm']);
  assert.equal(wa.decide(base, T(DAY), only).action, 'offer');
  const sent0 = { ...base, last_step: 0, last_status: 'sent', last_sent_at: '2026-11-21T01:00:00Z' };
  const d = wa.decide(sent0, T(DAY), only); assert.equal(d.action, 'wait'); assert.equal(d.reason, 'template_not_enabled');
  assert.equal(wa.decide(sent0, T(DAY), wa.settings({ WA_ENABLED_KEYS: 'confirm, reminder_1' })).action, 'offer');
  assert.deepEqual(wa.settings({ WA_ENABLED_KEYS: 'bogus' }).enabledKeys, []);
});

test('wa decide: a reminder is not sent more than a day after the previous message', () => {
  const old = { ...base, last_step: 0, last_status: 'sent', last_sent_at: '2026-11-20T01:00:00Z' };
  assert.equal(wa.decide(old, T(DAY), S).reason, 'too_old');
});

test('wa decide: "not on WhatsApp" that arrives after the message was sent still ends WhatsApp for the order', () => {
  const late = { ...base, last_step: 0, last_status: 'sent', last_sent_at: '2026-11-21T01:00:00Z', last_error: '131026' };
  assert.equal(wa.decide(late, T(DAY), S).reason, 'not_on_whatsapp');
  assert.equal(wa.decide({ ...late, last_error: '131049' }, T(DAY), S).action, 'offer');                     // other errors do not stop the reminders
});

test('wa result: a late failed status keeps the message as sent (4-hour clock) but records the code', async () => {
  wa._reset();
  const db = fakeDb({ 'FROM wa_messages WHERE send_id': () => [msg({ status: 'sent' })], 'INSERT INTO wa_events': () => [{ id: 1 }] });
  await wa.result(db, { send_id: 'o1-s0', event: 'failed', provider_message_id: 'wamid.1', error_code: 131026, error_text: 'undeliverable' });
  const up = db.log.find(l => /UPDATE wa_messages SET status = CASE WHEN status = 'sent'/.test(l.sql)); assert.ok(up); assert.equal(up.p[1], '131026');
});

test('task 2: three messages a day by default (now, +4 h, +8 h), and the 30-minute head start only when that team is busy or absent', () => {
  const d = wa.settings({ WA_MODE: 'on', WA_ENABLED_KEYS: 'confirm,reminder_1,reminder_2' });
  const sent = (step, hoursAgo) => ({ ...base, last_step: step, last_status: 'sent', last_sent_at: new Date(T(DAY).getTime() - hoursAgo * 3600e3) });
  assert.equal(wa.decide(base, T(DAY), d).template_key, 'confirm');                                          // message 1 at once
  assert.equal(wa.decide(sent(0, 3), T(DAY), d).action, 'wait');                                              // not yet 4 hours
  assert.equal(wa.decide(sent(0, 4), T(DAY), d).template_key, 'reminder_1');                                  // message 2, 4 hours later
  assert.equal(wa.decide(sent(1, 4), T(DAY), d).template_key, 'reminder_2');                                  // message 3, 4 hours after that
  assert.equal(wa.decide(sent(2, 5), T(DAY), d).reason, 'next_morning');                                      // the next message waits for the next morning, never a fourth the same day
  // the head start: busy or absent team = 30 minutes; spare time = no hold, the caller calls in parallel
  const busy = { cc: { active_agents: 3, uncalled: 80, capacity: 40 }, aman: { active_agents: 1, uncalled: 5, capacity: 30 } };
  assert.equal(wa.holdMinutes('CC', busy, d), 30); assert.equal(wa.holdMinutes('InHouse', busy, d), 0);        // the call centre is behind, Aman has spare time
  assert.equal(wa.holdMinutes('InHouse', { aman: { active_agents: 0, uncalled: 0, capacity: 0 } }, d), 30);    // nobody working: WhatsApp goes first
  assert.equal(wa.holdMinutes('CC', null, d), 0); assert.equal(wa.holdMinutes('CC', {}, d), 0);                // unknown workload: never hold the callers back
  assert.equal(wa.holdMinutes('CC', busy, wa.settings({ WA_HOLD_MINUTES: '20' })), 20);                        // a fixed hold always wins
  assert.equal(wa.holdMinutes('CC', busy, wa.settings({ WA_BUSY_HOLD_MINUTES: '45' })), 45);
});

test('task 2: the first message locks the lead for the callers 30 minutes when they are busy, and not at all when they have spare time', async () => {
  const auto = require('../lib/autopilotDb');
  const run = async (agents, leads) => {
    wa._reset(); auto._resetBandwidth();
    const db = fakeDb({ 'FROM wa_messages WHERE send_id': () => [msg()], 'INSERT INTO wa_events': () => [{ id: 1 }], 'SELECT assigned_to FROM orders_master': () => [{ assigned_to: 'CC' }],
      'FROM agents a LEFT JOIN agent_presence': () => agents, 'LEFT JOIN LATERAL': () => leads });
    await wa.result(db, { send_id: 'o1-s0', event: 'sent', provider_message_id: 'wamid.1', at: DAY }, T(DAY), { WA_MODE: 'on' });
    return db.log.find(l => /lead_locked_by = 'WHATSAPP'/.test(l.sql));
  };
  const working = [{ id: 1, team: 'cc', last_seen_at: T(DAY), last_call_at: null }, { id: 2, team: 'cc', last_seen_at: T(DAY), last_call_at: null }];
  const lock = await run([], []);                                                                           // nobody is logged in: busy, WhatsApp goes first
  assert.ok(lock); assert.equal(lock.p[1].toISOString(), '2026-11-21T06:45:00.000Z');                       // 06:30 + (30 - 15): the callers see it from 07:00
  assert.equal(await run(working, []), undefined);                                                          // callers are working and have nothing waiting: they call in parallel, no lock
});
test('wa next morning: the hour is learned from the customers (9 to 13, at least 30 messages), 9 AM without data, and the messages are paced', async () => {
  wa._reset();
  const rows = [{ hour: 9, sent: 40, tapped: 4 }, { hour: 10, sent: 50, tapped: 10 }, { hour: 11, sent: 20, tapped: 9 }, { hour: 15, sent: 100, tapped: 60 }];
  const db = fakeDb({ 'FROM wa_messages m WHERE NOT m.is_test': () => rows });
  const l = await wa.learnedDayHour(db, T('2026-11-23T05:00:00Z')); assert.equal(l.hour, 10); assert.equal(l.learned, true); assert.equal(l.table.find(x => x.hour === 10).rate, 20);   // 11 AM has too few messages, 3 PM is too late to ship the same day
  await wa.learnedDayHour(db, T('2026-11-23T06:00:00Z')); assert.equal(db.log.filter(x => /FROM wa_messages m WHERE NOT m.is_test/.test(x.sql)).length, 1);   // cached for 6 hours
  wa._reset();
  const none = await wa.learnedDayHour(fakeDb({ 'FROM wa_messages m WHERE NOT m.is_test': () => [{ hour: 9, sent: 5, tapped: 5 }] }), T('2026-11-23T05:00:00Z')); assert.equal(none.hour, 9); assert.equal(none.learned, false);

  wa._reset();
  const env = { WA_MODE: 'on', WA_GO_LIVE: '2026-11-20T00:00:00Z', WA_FOLLOWUP_PACE: '3', WA_DAY_HOUR: '9' };
  const orders = Array.from({ length: 10 }, (_, i) => order({ id: 'o' + i, order_name: '#4000' + i, last_step: 2, last_status: 'sent', last_sent_at: '2026-11-22T06:00:00Z', created_at: '2026-11-21T06:00:00Z', phone: '98765432' + String(10 + i) }));
  const q = fakeDb({ 'FROM orders_master o': () => orders, 'INSERT INTO wa_messages': () => [{ send_id: 'x' }] });
  const out = await wa.queue(q, T('2026-11-23T05:00:00Z'), env);
  assert.equal(out.items.length, 3);                                                         // paced: 3 per poll, never a burst
  assert.ok(out.items.every(i => i.step === 3 && i.template_key === 'reminder_3'));
  // before the morning hour nothing goes
  wa._reset();
  assert.equal((await wa.queue(fakeDb({ 'FROM orders_master o': () => orders, 'INSERT INTO wa_messages': () => [{ send_id: 'x' }] }), T('2026-11-23T03:00:00Z'), env)).items.length, 0);
});

test('wa next morning: only in the morning window, never in the afternoon or evening', () => {
  const sent = { ...base, last_step: 2, last_status: 'sent', last_sent_at: '2026-11-21T04:00:00Z' };
  assert.equal(wa.decide(sent, T('2026-11-22T07:29:00Z'), S).action, 'offer');                       // 12:59 India: still the morning window (9 AM + 4 h)
  const late = wa.decide(sent, T('2026-11-22T07:30:00Z'), S); assert.equal(late.action, 'wait'); assert.equal(late.reason, 'morning_only');   // 1 PM India: waits for tomorrow
  assert.equal(wa.decide(sent, T('2026-11-22T13:00:00Z'), S).reason, 'morning_only');                // 6:30 PM
  assert.equal(wa.decide(sent, T('2026-11-23T03:30:00Z'), S).action, 'offer');                       // next day 9 AM: goes
});
