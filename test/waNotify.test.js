const test = require('node:test');
const assert = require('node:assert/strict');
const wa = require('../lib/waBridge');
const nf = require('../lib/waNotify');

const ENV = { WA_MODE: 'on', WA_GO_LIVE: '2026-11-20T00:00:00Z', WA_SHARED_KEY: 'k', IVR_TEST_NUMBERS: '9076219087,8459803501', WA_NOTIFY_KEYS: 'prepaid_confirm,ofd_1,ofd_2,ndr_1,ndr_2,ndr_3', WA_NOTIFY_GO_LIVE: '2026-11-25T00:00:00Z' };
const S = nf.settings(ENV);
const T = (x) => new Date(x);
const NOON = '2026-11-25T06:30:00Z';       // 12:00 in India
const NIGHT = '2026-11-25T17:00:00Z';      // 22:30 in India
const ago = (min, from = NOON) => new Date(T(from).getTime() - min * 60e3).toISOString();
const base = { kind: 'ofd', phone: '9876543210', total_price: '599', order_status: 'in_transit', confirmation_status: 'confirmed', created_at: '2026-11-22T06:00:00Z', rows: [], episode_start: ago(20), episodes: 1, last_seen_at: ago(5) };

test('shipping settings: nothing is enabled by default, names and go-live are read', () => {
  const d = nf.settings({});
  assert.deepEqual(d.notifyKeys, []); assert.equal(d.notifyGoLive, null); assert.equal(d.ofdGapHours, 2); assert.equal(d.ndrGapHours, 12); assert.equal(d.minAmount, 350);
  assert.deepEqual(S.notifyKeys, ['prepaid_confirm', 'ofd_1', 'ofd_2', 'ndr_1', 'ndr_2', 'ndr_3']);
  assert.deepEqual(nf.settings({ WA_NOTIFY_KEYS: 'ofd_1, bogus ,NDR_1' }).notifyKeys, ['ofd_1', 'ndr_1']);
  assert.equal(nf.settings({ WA_NOTIFY_GO_LIVE: 'garbage' }).notifyGoLive, null);
});

test('prepaid: one message at once, at any hour; never twice; never an old, small or closed order', () => {
  const f = { ...base, kind: 'prepaid', created_at: ago(5), episode_start: null, last_seen_at: null };
  const d = nf.decide(f, T(NOON), S); assert.equal(d.action, 'offer'); assert.equal(d.key, 'prepaid_confirm'); assert.equal(d.step, 10);
  assert.equal(nf.decide({ ...f, created_at: ago(5, NIGHT) }, T(NIGHT), S).action, 'offer');                                    // night is fine for the first prepaid message
  assert.equal(nf.decide({ ...f, rows: [{ key: 'prepaid_confirm', status: 'sent', sent_at: ago(1) }] }, T(NOON), S).reason, 'already_sent');
  assert.equal(nf.decide({ ...f, rows: [{ key: 'prepaid_confirm', status: 'failed', error_code: '131000' }] }, T(NOON), S).reason, 'send_failed');
  assert.equal(nf.decide({ ...f, created_at: ago(13 * 60) }, T(NOON), S).reason, 'too_old');
  assert.equal(nf.decide({ ...f, created_at: '2026-11-24T10:00:00Z' }, T(NOON), S).reason, 'too_old');
  assert.equal(nf.decide({ ...f, total_price: '300' }, T(NOON), S).reason, 'small_order');
  assert.equal(nf.decide({ ...f, confirmation_status: 'cancelled' }, T(NOON), S).reason, 'order_closed');
  assert.equal(nf.decide({ ...f, opted_out: true }, T(NOON), S).reason, 'opted_out');
  assert.equal(nf.decide({ ...f, phone: '123' }, T(NOON), S).reason, 'bad_phone');
  assert.equal(nf.decide({ ...f, rows: [{ key: 'prepaid_confirm', status: 'queued' }] }, T(NOON), S).action, 'offer');          // not sent yet: offered again, the sender de-duplicates
  assert.equal(nf.decide({ ...f, rows: [{ key: 'prepaid_confirm', status: 'leased', lease_until: ago(-5) }] }, T(NOON), S).reason, 'leased');
});

test('prepaid: an order from before the go-live moment is not messaged', () => {
  const f = { ...base, kind: 'prepaid', created_at: '2026-11-24T23:00:00Z', episode_start: null };
  assert.equal(nf.decide(f, T('2026-11-25T01:00:00Z'), S).reason, 'before_go_live');
});

test('out for delivery: 1st message when first seen, 2nd after 2 hours only while still out, never a 3rd', () => {
  let d = nf.decide(base, T(NOON), S); assert.equal(d.action, 'offer'); assert.equal(d.key, 'ofd_1'); assert.equal(d.step, 11);
  const sent1 = [{ key: 'ofd_1', status: 'sent', sent_at: ago(90) }];
  d = nf.decide({ ...base, rows: sent1, episode_start: ago(100) }, T(NOON), S); assert.equal(d.action, 'wait'); assert.equal(d.reason, 'not_yet');
  d = nf.decide({ ...base, rows: [{ key: 'ofd_1', status: 'sent', sent_at: ago(125) }], episode_start: ago(130) }, T(NOON), S); assert.equal(d.key, 'ofd_2'); assert.equal(d.action, 'offer');
  d = nf.decide({ ...base, rows: [{ key: 'ofd_1', status: 'sent', sent_at: ago(300) }, { key: 'ofd_2', status: 'sent', sent_at: ago(180) }], episode_start: ago(320) }, T(NOON), S); assert.equal(d.reason, 'all_sent');
  d = nf.decide({ ...base, rows: [{ key: 'ofd_1', status: 'sent', sent_at: ago(125) }], episode_start: ago(130), last_seen_at: ago(90) }, T(NOON), S); assert.equal(d.reason, 'not_in_latest_scan');   // no longer out for delivery (delivered or moved on): no 2nd message
  assert.equal(nf.decide({ ...base, order_status: 'delivered' }, T(NOON), S).reason, 'order_closed');
});

test('out for delivery: only fresh events after go-live; nothing at night; the order must be in the latest scan', () => {
  assert.equal(nf.decide({ ...base, episode_start: '2026-11-24T20:00:00Z' }, T(NOON), S).reason, 'before_go_live');                // already out for delivery when we went live
  assert.equal(nf.decide({ ...base, episode_start: ago(37 * 60) }, T('2026-11-27T06:30:00Z'), nf.settings({ ...ENV, WA_NOTIFY_GO_LIVE: '2026-11-20T00:00:00Z' })).reason, 'too_old');
  assert.equal(nf.decide({ ...base, last_seen_at: ago(60) }, T(NOON), S).reason, 'not_in_latest_scan');
  const n = nf.decide({ ...base, episode_start: ago(20, NIGHT), last_seen_at: ago(5, NIGHT) }, T(NIGHT), S); assert.equal(n.reason, 'quiet_hours'); assert.ok(n.not_before);
  assert.equal(nf.decide({ ...base, episode_start: null }, T(NOON), S).reason, 'no_courier_event');
});

test('delivery failed: one message per failed attempt, at least 12 hours apart, at most 3, nothing at night', () => {
  const f = { ...base, kind: 'ndr', order_status: 'ndr' };
  let d = nf.decide(f, T(NOON), S); assert.equal(d.key, 'ndr_1'); assert.equal(d.step, 13);
  const one = [{ key: 'ndr_1', status: 'sent', sent_at: ago(60) }];
  assert.equal(nf.decide({ ...f, rows: one }, T(NOON), S).reason, 'no_new_attempt');                                                 // same failed attempt: nothing more
  d = nf.decide({ ...f, rows: one, episodes: 2 }, T(NOON), S); assert.equal(d.reason, 'not_yet');                                    // a 2nd attempt failed but the last message is recent
  d = nf.decide({ ...f, rows: [{ key: 'ndr_1', status: 'sent', sent_at: ago(13 * 60) }], episodes: 2, episode_start: ago(60) }, T(NOON), S); assert.equal(d.key, 'ndr_2'); assert.equal(d.action, 'offer');
  const three = [1, 2, 3].map(i => ({ key: 'ndr_' + i, status: 'sent', sent_at: ago(2000 - i) }));
  assert.equal(nf.decide({ ...f, rows: three, episodes: 4 }, T(NOON), S).reason, 'all_sent');
  assert.equal(nf.decide({ ...f, episode_start: ago(20, NIGHT), last_seen_at: ago(5, NIGHT) }, T(NIGHT), S).reason, 'quiet_hours');
});

test('a message name that is not enabled is not offered', () => {
  const only = nf.settings({ ...ENV, WA_NOTIFY_KEYS: 'prepaid_confirm' });
  assert.equal(nf.decide(base, T(NOON), only).reason, 'template_not_enabled');
  assert.equal(nf.decide({ ...base, kind: 'prepaid', created_at: ago(5), episode_start: null }, T(NOON), only).action, 'offer');
});

test('a number that is not on WhatsApp ends every shipping message for the order', () => {
  const r = nf.decide({ ...base, rows: [{ key: 'prepaid_confirm', status: 'sent', sent_at: ago(500), error_code: '131026' }] }, T(NOON), S);
  assert.equal(r.reason, 'not_on_whatsapp');
});

// ---- a tiny fake database ----
function fakeDb(h = {}) {
  const log = [];
  const db = async (sql, p = []) => {
    log.push({ sql, p });
    for (const [re, fn] of Object.entries(h)) if (new RegExp(re, 's').test(sql)) return fn(sql, p);
    return [];
  };
  db.log = log; return db;
}
const row = (o = {}) => ({ id: 'o1', order_name: '#44153', customer_name: 'Jagriti Razdan', phone: '9702009999', total_price: '467', created_at: ago(5), order_status: 'in_transit', confirmation_status: 'confirmed', line_items: null, opted_out: false, episode_start: ago(20), episodes: 1, last_seen_at: ago(5), ...o });

test('sync: only orders the CRM knows and placed in the last 7 days are kept, RTO is not an NDR, bad numbers are ignored', async () => {
  nf._reset();
  const db = fakeDb({ 'FROM orders_master WHERE order_name': () => [{ id: 'o1', order_name: '#44153' }] });
  const r = await nf.syncSeen(db, [{ channel_order_id: '44153', status: 'OUT FOR DELIVERY' }, { channel_order_id: 'abc', status: 'x' }, { channel_order_id: '', status: 'x' }], 'ofd', T(NOON));
  assert.equal(r.seen, 1);
  const q = db.log.find(l => /FROM orders_master WHERE order_name/.test(l.sql)); assert.deepEqual(q.p[0], ['#44153']);
  const ins = db.log.find(l => /INSERT INTO wa_courier_seen/.test(l.sql)); assert.deepEqual(ins.p[0], ['o1']); assert.equal(ins.p[1], 'ofd');
  const rto = fakeDb({ 'FROM orders_master WHERE order_name': () => [] });
  assert.equal((await nf.syncSeen(rto, [{ channel_order_id: '1001', status: 'RTO INITIATED' }], 'ndr', T(NOON))).seen, 0);
  assert.equal(rto.log.filter(l => /FROM orders_master WHERE order_name/.test(l.sql)).length, 0);       // an RTO order never even reaches the lookup
  assert.deepEqual(await nf.syncFromShiprocket(db, { ofd: [], undelivered: [], updatedAt: 0 }, T(NOON)), { skipped: 'scan_not_fresh' });
  assert.deepEqual(await nf.syncFromShiprocket(db, { ofd: [], undelivered: [], updatedAt: T(NOON).getTime() - 30 * 60e3 }, T(NOON)), { skipped: 'scan_not_fresh' });
});

test('queue: shipping messages are offered with the exact shape, named, leased, and only when enabled', async () => {
  wa._reset(); nf._reset();
  const mk = () => fakeDb({ 'notify:ofd': () => [row()], 'INSERT INTO wa_messages': () => [{ send_id: 'x' }] });
  const db = mk();
  const q = await wa.queue(db, T(NOON), ENV);
  assert.equal(q.items.length, 1); const it = q.items[0];
  assert.equal(it.send_id, 'o1-ofd_1'); assert.equal(it.template_key, 'ofd_1'); assert.equal(it.step, 11); assert.equal(it.to, '919702009999'); assert.equal(it.variables.customer_name, 'Jagriti'); assert.equal(it.variables.order_name, '#44153');
  const ins = db.log.find(l => /INSERT INTO wa_messages/.test(l.sql)); assert.equal(ins.p[0], 'o1-ofd_1'); assert.equal(ins.p[5], 'ofd_1');          // stored under its name
  assert.equal((await wa.queue(mk(), T(NOON), { ...ENV, WA_NOTIFY_KEYS: '' })).items.length, 0);                                           // nothing enabled: nothing offered, nothing even looked up
  const none = mk(); await wa.queue(none, T(NOON), { ...ENV, WA_NOTIFY_KEYS: '' }); assert.equal(none.log.filter(l => /notify:/.test(l.sql)).length, 0);
  assert.equal((await wa.queue(mk(), T(NOON), { ...ENV, WA_NOTIFY_GO_LIVE: '' })).items.length, 0);                                        // on without a go-live moment: nothing for real orders
  assert.equal((await wa.queue(mk(), T(NOON), { ...ENV, WA_MODE: 'off' })).items.length, 0);
  assert.equal((await wa.queue(mk(), T(NOON), { ...ENV, WA_MODE: 'test' })).items.length, 0);                                              // test mode: only the owner's own numbers
});

test('queue: a lease that is already taken is not offered twice (send_id is the lock)', async () => {
  wa._reset(); nf._reset();
  const db = fakeDb({ 'notify:ofd': () => [row()], 'INSERT INTO wa_messages': () => [] });
  assert.equal((await wa.queue(db, T(NOON), ENV)).items.length, 0);
});

test('queue: prepaid and delivery-failed messages use their own names and steps', async () => {
  wa._reset(); nf._reset();
  const db = fakeDb({ 'notify:prepaid': () => [row({ id: 'p1', order_name: '#44200', kind: 'prepaid', episode_start: null, last_seen_at: null, episodes: 0, line_items: JSON.stringify([{ title: 'Arjuna Tea 300g' }]) })], 'notify:ndr': () => [row({ id: 'n1', order_name: '#44100', order_status: 'ndr' })], 'INSERT INTO wa_messages': () => [{ send_id: 'x' }] });
  const q = await wa.queue(db, T(NOON), ENV);
  assert.deepEqual(q.items.map(i => i.template_key).sort(), ['ndr_1', 'prepaid_confirm']);
  assert.equal(q.items.find(i => i.template_key === 'prepaid_confirm').variables.product, 'Arjuna Tea 300g');
  assert.equal(q.items.find(i => i.template_key === 'prepaid_confirm').step, 10);
});

test('check: a shipping message goes only while it is still due; a delivered order stops it', async () => {
  wa._reset(); nf._reset();
  const m = { send_id: 'o1-ofd_1', order_id: 'o1', order_name: '#44153', phone10: '9702009999', step: 11, template_key: 'ofd_1', status: 'leased', is_test: false };
  const db = fakeDb({ 'SELECT \\* FROM wa_messages': () => [m], 'notify:ofd': () => [row()] });
  assert.deepEqual(await wa.check(db, 'o1-ofd_1', T(NOON), ENV), { send: true });
  const gone = fakeDb({ 'SELECT \\* FROM wa_messages': () => [m], 'notify:ofd': () => [row({ order_status: 'delivered' })] });
  assert.deepEqual(await wa.check(gone, 'o1-ofd_1', T(NOON), ENV), { send: false, reason: 'order_closed' });
  const missing = fakeDb({ 'SELECT \\* FROM wa_messages': () => [m], 'notify:ofd': () => [] });
  assert.equal((await wa.check(missing, 'o1-ofd_1', T(NOON), ENV)).send, false);
  const night = fakeDb({ 'SELECT \\* FROM wa_messages': () => [m], 'notify:ofd': () => [row({ episode_start: ago(20, NIGHT), last_seen_at: ago(5, NIGHT) })] });
  assert.equal((await wa.check(night, 'o1-ofd_1', T(NIGHT), ENV)).reason, 'quiet_hours');
  assert.equal((await wa.check(db, 'o1-ofd_1', T(NOON), { ...ENV, WA_NOTIFY_KEYS: 'prepaid_confirm' })).send, false);              // switched off after it was queued
});

test('check: the 2nd out-for-delivery message waits for its 2 hours even if the sender asks early', async () => {
  wa._reset(); nf._reset();
  const m = { send_id: 'o1-ofd_2', order_id: 'o1', phone10: '9702009999', step: 12, template_key: 'ofd_2', status: 'leased', is_test: false };
  const early = fakeDb({ 'SELECT \\* FROM wa_messages': () => [m], 'notify:ofd': () => [row({ episode_start: ago(100) })], 'notify:history': () => [{ order_id: 'o1', key: 'ofd_1', status: 'sent', sent_at: ago(60) }] });
  assert.equal((await wa.check(early, 'o1-ofd_2', T(NOON), ENV)).send, false);
  const due = fakeDb({ 'SELECT \\* FROM wa_messages': () => [m], 'notify:ofd': () => [row({ episode_start: ago(150) })], 'notify:history': () => [{ order_id: 'o1', key: 'ofd_1', status: 'sent', sent_at: ago(125) }] });
  assert.equal((await wa.check(due, 'o1-ofd_2', T(NOON), ENV)).send, true);
});

test('result: delivery-failed and out-for-delivery taps are only recorded (the old flow answers them); nothing on the order changes; stored once', async () => {
  wa._reset(); nf._reset();
  const m = { send_id: 'o1-ndr_1', order_id: 'o1', order_name: '#44153', phone10: '9702009999', step: 13, is_test: false };
  const db = fakeDb({ 'SELECT \\* FROM wa_messages WHERE send_id': () => [m], 'INSERT INTO wa_events': () => [{ id: 1 }], 'UPDATE orders_master SET callback_at': () => [{ id: 'o1' }] });
  const r = await wa.result(db, { send_id: 'o1-ndr_1', event: 'clicked_ndr_yes', provider_message_id: 'wamid.1', at: NOON });
  assert.equal(r.status, 200); assert.equal(r.body.applied, 'recorded');
  assert.ok(!db.log.some(l => /UPDATE orders_master/.test(l.sql)));                                                                   // a shipping reply changes nothing on the order
  const alt = await wa.result(fakeDb({ 'SELECT \\* FROM wa_messages WHERE send_id': () => [{ ...m, send_id: 'o1-ofd_1', step: 11 }], 'INSERT INTO wa_events': () => [{ id: 2 }] }), { send_id: 'o1-ofd_1', event: 'clicked_ofd_alt', provider_message_id: 'wamid.2' });
  assert.equal(alt.body.applied, 'recorded');
  const dup = fakeDb({ 'SELECT \\* FROM wa_messages WHERE send_id': () => [m], 'INSERT INTO wa_events': () => [] });
  assert.equal((await wa.result(dup, { send_id: 'o1-ndr_1', event: 'clicked_ndr_no', provider_message_id: 'wamid.1' })).body.duplicate, true);
});

test('result: an old out-for-delivery button (no send id) is found by the order number', async () => {
  wa._reset(); nf._reset();
  const db = fakeDb({ 'FROM orders_master WHERE order_name': () => [{ id: 'o1', order_name: '#44153', phone10: '9702009999' }], 'INSERT INTO wa_events': () => [{ id: 3 }] });
  const r = await wa.result(db, { send_id: 'x', order_number: '44153', event: 'clicked_ofd_alt', provider_message_id: 'wamid.9' });
  assert.equal(r.status, 200); assert.equal(r.order_id, 'o1');
  assert.equal((await wa.result(fakeDb(), { send_id: 'x', order_number: '44153', event: 'clicked_ofd_alt' })).status, 404);
});

test('test messages: all six names can be sent to the owner\'s own numbers; an unknown name cannot', async () => {
  wa._reset(); nf._reset();
  for (const k of nf.KEYS) {
    const db = fakeDb({ 'SELECT COUNT': () => [{ n: 0 }] });
    const r = await wa.testMessage(db, 0, k, T(NOON), ENV); assert.equal(r.ok, true, k);
    const ins = db.log.find(l => /INSERT INTO wa_messages/.test(l.sql)); assert.equal(ins.p[3], nf.STEP[k]); assert.equal(ins.p[4], k);
  }
  assert.equal((await wa.testMessage(fakeDb(), 0, 'bogus', T(NOON), ENV)).ok, false);
});

test('COD messages are not disturbed: the COD lookup only sees steps 0 to 4, and the shipping steps are 10 to 15', () => {
  assert.deepEqual(Object.values(nf.STEP).sort((a, b) => a - b), [10, 11, 12, 13, 14, 15]);
  assert.ok(Math.min(...Object.values(nf.STEP)) > wa.KEYS.length);
  assert.ok(/w\.step <= 4/.test(require('fs').readFileSync(require.resolve('../lib/waBridge'), 'utf8')));
});
