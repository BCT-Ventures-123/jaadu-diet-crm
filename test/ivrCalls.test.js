const test = require('node:test');
const assert = require('node:assert');
const c = require('../lib/ivrCalls');
const ivrDb = require('../lib/ivrDb');

const env = { IVR_API_KEY: 'k-test', IVR_DID: '+910000000000', IVR_FLOW_ID: '777', IVR_WEBHOOK_KEY: 'w-test', IVR_TEST_NUMBERS: '9000000001, 9000000002' };

test('numbers: last ten digits, with a 0 in front for the dial request', () => {
  assert.equal(c.tenDigits('+91 90000-00001'), '9000000001');
  assert.equal(c.dialNumber('919000000001'), '09000000001');
});

test('template variables are comma separated, so commas and line breaks inside a value are removed', () => {
  assert.equal(c.buildVariables({ name: 'Ram, Kumar', amount: 599, orderId: '#1234' }), 'Ram Kumar,599,#1234');
  assert.equal(c.buildVariables({ name: '', amount: 1, orderId: 'A' }), 'Customer,1,A');
});

test('keys: 1 confirms, 2 changes the address, 3 asks to cancel, anything else is unknown', () => {
  assert.equal(c.mapKey('1'), 'confirmed'); assert.equal(c.mapKey(2), 'address_change'); assert.equal(c.mapKey(' 3 '), 'cancel_requested');
  assert.equal(c.mapKey('9'), 'unknown'); assert.equal(c.mapKey(undefined), 'unknown');
});

test('set-up check lists only names of what is missing, never values', () => {
  assert.deepEqual(c.missing(c.settings({})).sort(), ['IVR_API_KEY', 'IVR_DID', 'IVR_FLOW_ID', 'IVR_TEST_NUMBERS', 'IVR_WEBHOOK_KEY']);
  assert.deepEqual(c.missing(c.settings(env)), []);
  assert.deepEqual(c.settings(env).testNumbers, ['9000000001', '9000000002']);
});

test('the secret key never reaches storage and is compared safely', () => {
  assert.deepEqual(c.withoutSecret({ key: 'abc', dtmf: '1', Token: 'x', phone: '9000000001' }), { dtmf: '1', phone: '9000000001' });
  assert.equal(c.safeEqual('abc', 'abc'), true); assert.equal(c.safeEqual('abc', 'abd'), false); assert.equal(c.safeEqual('', ''), false); assert.equal(c.safeEqual(undefined, 'a'), false);
});

test('the call id and the customer number are found under whichever name the IVR uses', () => {
  assert.equal(c.pickCallId({ Call_ID: ' 55 ' }), '55'); assert.equal(c.pickCallId({ foo: 1 }), '');
  assert.equal(c.pickPhone({ customer_no: '09000000001' }), '9000000001'); assert.equal(c.pickPhone({ caller: '+919000000002' }), '9000000002');
});

test('placing a call sends the template, flow and variables with the bearer token, and reads the call id', async () => {
  let seen;
  const http = { post: async (url, body, opt) => { seen = { url, body, opt }; return { status: 200, data: { status: 200, message: 'Call initiated successfully', call_id: 'call_1' } }; } };
  const r = await c.dialByText({ phone: '9000000001', name: 'Test', amount: '599', orderId: 'T1', settings: c.settings(env), http });
  assert.equal(r.ok, true); assert.equal(r.callId, 'call_1');
  assert.equal(seen.url, 'https://api.ivrsolutions.in/api/dial_by_text');
  assert.equal(seen.body.customer_no, '09000000001'); assert.equal(seen.body.template_name, 'cod_confirm_open_v4'); assert.equal(seen.body.flow_id, '777'); assert.equal(seen.body.Variable, 'Test,599,T1');
  assert.equal(seen.body.customer_name, 'Test'); assert.equal(seen.body.amount, '599'); assert.equal(seen.body.order_id, 'T1');   // the named variables the template checks
  assert.equal(seen.opt.headers.Authorization, 'Bearer k-test');
});

test('an API error or a missing set-up is returned, not thrown, and the token is not in the message', async () => {
  const bad = { post: async () => { const e = new Error('Request failed'); e.response = { data: { message: 'Template not approved' } }; throw e; } };
  const r = await c.dialByText({ phone: '9000000001', name: 'T', amount: '1', orderId: 'x', settings: c.settings(env), http: bad });
  assert.equal(r.ok, false); assert.equal(r.message, 'Template not approved'); assert.ok(!JSON.stringify(r).includes('k-test'));
  const none = await c.dialByText({ phone: '9000000001', settings: c.settings({}), http: bad });
  assert.equal(none.ok, false); assert.match(none.message, /IVR_API_KEY/);
});

// ---- key press handling, against a tiny in-memory stand-in for the database ----
function fakeDb(rows, orders) {
  const log = [];
  const db = async (sql, p = []) => {
    if (/^\s*(CREATE|ALTER|INSERT INTO ivr_keypress_log)/i.test(sql)) { if (/keypress_log/.test(sql) && /INSERT/i.test(sql)) log.push(p); return []; }
    if (/FROM ivr_calls WHERE call_id/.test(sql)) return rows.filter(r => r.call_id === p[0]).slice(-1);
    if (/FROM ivr_calls WHERE phone/.test(sql)) return rows.filter(r => r.phone === p[0] && !r.result).slice(-1);
    if (/UPDATE ivr_calls SET dtmf/.test(sql)) { const r = rows.find(x => x.id === p[0] && !x.result); if (!r) return []; r.dtmf = p[1]; r.result = p[2]; return [{ id: r.id }]; }
    if (/UPDATE orders_master SET callback_at/.test(sql)) { const o = orders.find(x => x.id === p[0] && x.confirmation_status === 'pending'); if (!o) return []; o.callback_at = true; return [{ id: o.id }]; }
    if (/UPDATE orders_master SET lead_locked_by = NULL/.test(sql)) return [];
    if (/UPDATE orders_master/.test(sql)) { const o = orders.find(x => x.id === p[0] && x.confirmation_status === 'pending'); if (!o) return []; o.confirmation_status = 'confirmed'; return [{ id: o.id }]; }
    if (/log_status_change/.test(sql)) { orders.events = (orders.events || 0) + 1; return []; }
    if (/UPDATE ivr_calls SET (applied|note)/.test(sql)) return [];
    throw new Error('unexpected sql ' + sql.slice(0, 60));
  };
  return { db, log };
}

test('a key press is saved once; a repeat of the same press is a duplicate and changes nothing', async () => {
  const rows = [{ id: 1, call_id: 'c1', phone: '9000000001', is_test: true, result: null }];
  const { db } = fakeDb(rows, []);
  assert.equal((await ivrDb.recordKeypress(db, { dtmf: '1', call_id: 'c1' })).outcome, 'test_recorded');
  assert.equal(rows[0].result, 'confirmed');
  assert.equal((await ivrDb.recordKeypress(db, { dtmf: '3', call_id: 'c1' })).outcome, 'duplicate');
  assert.equal(rows[0].result, 'confirmed');
});

test('a press with no call id is matched by phone; one that matches nothing is kept as unmatched, not guessed', async () => {
  const rows = [{ id: 1, call_id: null, phone: '9000000001', is_test: true, result: null }];
  const { db } = fakeDb(rows, []);
  assert.equal((await ivrDb.recordKeypress(db, { dtmf: '2', customer_no: '09000000001' })).outcome, 'test_recorded');
  assert.equal(rows[0].result, 'address_change');
  assert.equal((await ivrDb.recordKeypress(db, { dtmf: '1', customer_no: '09111111111' })).outcome, 'unmatched');
});

test('a real order is confirmed once, only while pending, with one history line; 2 and 3 only set a callback for a person', async () => {
  const orders = [{ id: 'o1', confirmation_status: 'pending' }, { id: 'o2', confirmation_status: 'confirmed' }, { id: 'o3', confirmation_status: 'pending' }];
  const rows = [{ id: 1, call_id: 'a', phone: '9', order_id: 'o1', is_test: false, result: null }, { id: 2, call_id: 'b', phone: '8', order_id: 'o2', is_test: false, result: null }, { id: 3, call_id: 'c', phone: '7', order_id: 'o3', is_test: false, result: null }];
  const { db } = fakeDb(rows, orders);
  assert.equal((await ivrDb.recordKeypress(db, { dtmf: '1', call_id: 'a' })).outcome, 'confirmed_order');
  assert.equal(orders[0].confirmation_status, 'confirmed'); assert.equal(orders.events, 1);
  assert.equal((await ivrDb.recordKeypress(db, { dtmf: '1', call_id: 'a' })).outcome, 'duplicate'); assert.equal(orders.events, 1);
  assert.equal((await ivrDb.recordKeypress(db, { dtmf: '1', call_id: 'b' })).outcome, 'order_not_pending'); assert.equal(orders.events, 1);   // a person got there first
  assert.equal((await ivrDb.recordKeypress(db, { dtmf: '3', call_id: 'c' })).outcome, 'followup_set'); assert.equal(orders[2].confirmation_status, 'pending'); assert.equal(orders[2].callback_at, true);   // a person calls back, the order is not cancelled
});


// ---- the dialer (one minute of work) ----
const dialerDb = (leads, orders, { used = 0, paused = false, nonFresh = 0, freshUsed = 0, refuseClaim = false, nobodyWorking = false } = {}) => {
  const rec = { inserted: [], updates: [], locks: [], skipped: [], calls: 0, released: [] };
  let n = 100;
  const db = async (sql, p = []) => {
    if (/^\s*(CREATE|ALTER)/i.test(sql)) return [];
    if (/FROM agent_presence/.test(sql)) return [{ seen: nobodyWorking ? 0 : 1, calls: 0 }];   // the cover-day check: has any caller opened the CRM or logged a call in the last 30 minutes
    if (/FROM ivr_flags/.test(sql)) return paused ? [{ value: '1' }] : [];
    if (/LEFT JOIN LATERAL/.test(sql)) return leads;
    if (/GROUP BY order_id/.test(sql)) return [];
    if (/COUNT\(\*\)::int AS n FROM ivr_calls WHERE order_id/.test(sql)) return [{ n: 0 }];
    if (/COALESCE\(kind/.test(sql)) return [{ n: nonFresh, fresh: freshUsed }];
    if (/COUNT\(\*\)::int AS n FROM ivr_calls WHERE NOT is_test/.test(sql)) return [{ n: used }];
    if (/SELECT shipping_zip,/.test(sql) || /SELECT o\.id AS order_id/.test(sql)) return [];
    if (/FROM orders_master WHERE id = ANY/.test(sql)) return orders.filter(o => p[0].includes(o.id));
    if (/SELECT phone FROM ivr_calls/.test(sql)) return [];
    if (/INSERT INTO ivr_calls/.test(sql)) { if (/'skipped'/.test(sql)) { rec.skipped.push(p); return []; } rec.inserted.push(p); return [{ id: ++n }]; }
    if (/status = 'failed_system'/.test(sql)) { rec.sys = p[0]; return []; }
    if (/UPDATE ivr_calls SET call_id/.test(sql)) { rec.updates.push(p); return []; }
    if (/lead_locked_by = 'IVR'/.test(sql)) {
      if (/RETURNING id/.test(sql)) { if (refuseClaim) return []; rec.locks.push(p[0]); return [{ id: p[0] }]; }   // the atomic claim before the call
      rec.released.push(p[0]); return [];                                                                         // the lead given back after a failed request
    }
    throw new Error('unexpected sql ' + sql.slice(0, 70));
  };
  return { db, rec };
};
const evening = new Date('2026-11-19T19:00:00+05:30');
const lead = (id) => ({ id, team: 'CC', placed_at: new Date('2026-11-19T14:00:00+05:30'), callback_at: null, attempts: 0, dnp_attempts: 0, dnp_days: 0, today_attempts: 0, spoke: false, last_call_at: null });
const order = (id, extra = {}) => ({ id, order_name: '#12' + id.slice(-2), customer_name: 'Ram Kumar', customer_phone: '+91 9000000011', total_price: '599.00', shipping_address1: 'House 12, Gali 3, Rampur Village', shipping_address2: 'Near Shiv Mandir', shipping_city: 'Patna', shipping_province: 'Bihar', shipping_zip: '800001', ...extra });
const liveEnv = { ...env, IVR_MODE: 'on' };
const okHttp = (log) => ({ post: async (u, b) => { log.push(b); return { status: 200, data: { status: 200, message: 'Call initiated successfully', call_id: 'c' + log.length } }; } });

test('dialer: places a call for a free lead with a good address, locks the lead for the people, and skips short addresses and repeat phones', async () => {
  const leads = [lead('a-01'), lead('b-02'), lead('c-03')];
  const orders = [order('a-01'), order('b-02', { shipping_address1: 'Rampur', shipping_address2: '', shipping_city: '', shipping_province: '', customer_phone: '9000000022' }), order('c-03')];
  const { db, rec } = dialerDb(leads, orders), sent = [];
  const r = await ivrDb.tick(db, { now: evening, env: liveEnv, http: okHttp(sent) });
  assert.equal(r.placed, 1); assert.equal(r.skipped.short_address, 1); assert.equal(r.skipped.same_phone_called, 1);
  assert.equal(sent.length, 1); assert.equal(sent[0].customer_no, '09000000011'); assert.equal(sent[0].customer_name, 'Ram Kumar'); assert.equal(sent[0].amount, '599'); assert.equal(sent[0].order_id, '1201');
  assert.deepEqual(rec.locks, ['a-01']);
});

test('dialer: does nothing when the mode is not on, when paused, outside the windows, or when the set-up is incomplete', async () => {
  const mk = () => dialerDb([lead('a-01')], [order('a-01')]);
  assert.equal((await ivrDb.tick(mk().db, { now: evening, env: { ...env, IVR_MODE: 'dry' } })).skipped, 'mode_dry');
  assert.equal((await ivrDb.tick(mk().db, { now: evening, env: { ...env } })).skipped, 'mode_off');
  assert.equal((await ivrDb.tick(dialerDb([lead('a-01')], [order('a-01')], { paused: true }).db, { now: evening, env: liveEnv })).skipped, 'paused');
  assert.equal((await ivrDb.tick(mk().db, { now: new Date('2026-11-19T12:00:00+05:30'), env: liveEnv })).skipped, 'window_closed');
  assert.equal((await ivrDb.tick(mk().db, { now: evening, env: { IVR_MODE: 'on', IVR_API_KEY: 'k' } })).skipped, 'not_set_up');
});

test('dialer: stops at the daily cap and at 10 calls a minute, and stops after three failed requests in a row', async () => {
  const many = Array.from({ length: 15 }, (_, i) => ({ l: lead('x-' + String(i).padStart(2, '0')), o: order('x-' + String(i).padStart(2, '0'), { customer_phone: '90000001' + String(i).padStart(2, '0') }) }));
  const a = dialerDb(many.map(m => m.l), many.map(m => m.o)), sent = [];
  assert.equal((await ivrDb.tick(a.db, { now: evening, env: { ...liveEnv, IVR_DAILY_CAP: '100' }, http: okHttp(sent) })).placed, 10);   // 10 a minute
  const b = dialerDb(many.map(m => m.l), many.map(m => m.o), { used: 20 });
  assert.equal((await ivrDb.tick(b.db, { now: evening, env: liveEnv, http: okHttp([]) })).placed, 0);                                // 20 a day by default, all used
  const bad = { post: async () => { const e = new Error('x'); e.response = { data: { message: 'Insufficient balance' } }; throw e; } };
  const c = dialerDb(many.map(m => m.l), many.map(m => m.o)), r = await ivrDb.tick(c.db, { now: evening, env: { ...liveEnv, IVR_DAILY_CAP: '100' }, http: bad });
  assert.equal(r.failed, 3); assert.equal(r.stopped, 'three_failures_in_a_row'); assert.equal(r.last_error, 'Insufficient balance'); assert.equal(c.rec.released.length, 3);   // the three leads were claimed, the calls never went out, so all three were given back to the callers
  assert.equal(c.rec.sys.length, 3);   // those three refusals are marked as a system problem, so they are not counted against the three orders
});


test('key press list shows when, the key, what happened and only the NAMES of the details sent, never their values or the secret', async () => {
  const db = async (sql) => /CREATE|ALTER/i.test(sql) ? [] : [{ received_at: new Date('2026-11-19T20:00:00Z'), outcome: 'unmatched', params: { dtmf: '1', customer_no: '09000000001', call_id: 'c9' } }];
  const r = await ivrDb.recentKeypresses(db, 5);
  assert.deepEqual(r[0].fields, ['customer_no', 'call_id']); assert.equal(r[0].key, '1'); assert.equal(r[0].outcome, 'unmatched');
  assert.ok(!JSON.stringify(r).includes('09000000001'));
});


test('the worker saves what its last IVR run did, so the CRM can show whether it runs and why it placed nothing', async () => {
  let saved = null;
  const db = async (sql, p = []) => {
    if (/^\s*(CREATE|ALTER)/i.test(sql)) return [];
    if (/INSERT INTO ivr_flags/.test(sql)) { saved = p[0]; return []; }
    if (/SELECT value FROM ivr_flags WHERE name = 'paused'/.test(sql)) return [];
    if (/SELECT value FROM ivr_flags WHERE name = 'force_until'/.test(sql)) return [];
    if (/SELECT value, updated_at FROM ivr_flags/.test(sql)) return saved ? [{ value: saved, updated_at: new Date('2026-11-19T20:00:00Z') }] : [];
    throw new Error('unexpected sql ' + sql.slice(0, 60));
  };
  assert.equal(await ivrDb.lastTick(db), null);
  const r = await ivrDb.runAndRecord(db, { env: { IVR_MODE: 'off' } });
  assert.equal(r.skipped, 'mode_off');
  assert.equal((await ivrDb.lastTick(db)).reason, 'mode_off');
  await ivrDb.runAndRecord(db, { env: { IVR_MODE: 'on', IVR_API_KEY: 'k' }, now: new Date('2026-11-19T19:00:00+05:30') });
  const t = await ivrDb.lastTick(db);
  assert.equal(t.reason, 'not_set_up'); assert.ok(t.missing.includes('IVR_DID'));   // names only, never values
});


test('dialer: a risky order is never auto-called, it is recorded as left to a person; a low-risk one is called', async () => {
  const leads = [lead('r-01'), lead('g-02')];
  const orders = [order('r-01', { total_price: '3500.00', customer_phone: '9000000031' }), order('g-02', { customer_phone: '9000000032' })];   // a high order value adds risk points
  const { db, rec } = dialerDb(leads, orders), sent = [];
  const r = await ivrDb.tick(db, { now: evening, env: liveEnv, http: okHttp(sent) });
  assert.equal(r.placed, 1); assert.equal(r.skipped.risk_medium, 1);
  assert.equal(sent[0].customer_no, '09000000032');
  assert.equal(rec.skipped.length, 1); assert.equal(rec.skipped[0][0], 'r-01');          // saved, so it is not tried again every minute
  const loose = dialerDb([lead('r-01')], [orders[0]]), sent2 = [];
  assert.equal((await ivrDb.tick(loose.db, { now: evening, env: { ...liveEnv, IVR_MAX_RISK: 'medium' }, http: okHttp(sent2) })).placed, 1);   // the owner can allow medium risk
});

test('dialer: fresh orders go first, and retries and old backlog may use only 70% of the daily cap so new orders always find room', async () => {
  const oldLead = (id) => ({ ...lead(id), placed_at: new Date('2026-11-14T12:00:00+05:30'), attempts: 2, dnp_attempts: 2, dnp_days: 1, last_call_at: new Date('2026-11-18T12:00:00+05:30') });
  const leads = [oldLead('o-01'), oldLead('o-02'), lead('n-03')];
  const orders = [order('o-01', { customer_phone: '9000000041' }), order('o-02', { customer_phone: '9000000042' }), order('n-03', { customer_phone: '9000000043' })];
  const a = dialerDb(leads, orders), sa = [];
  await ivrDb.tick(a.db, { now: evening, env: { ...liveEnv, IVR_DAILY_CAP: '10' }, http: okHttp(sa) });
  assert.equal(sa[0].customer_no, '09000000043');                                          // the fresh order is called before the old ones
  const b = dialerDb(leads, orders, { nonFresh: 7 }), sb = [];                              // 7 of the 10 calls (70%) already went to old leads today
  const r = await ivrDb.tick(b.db, { now: evening, env: { ...liveEnv, IVR_DAILY_CAP: '10' }, http: okHttp(sb) });
  assert.equal(r.placed, 1); assert.equal(sb[0].customer_no, '09000000043');                 // only the fresh order is called now
});

test('dialer: if another worker or the same minute already created the call for this order, nobody is called twice', async () => {
  const { db, rec } = dialerDb([lead('a-01')], [order('a-01')]);
  const dup = async (sql, p) => { if (/INSERT INTO ivr_calls \(order_id, phone, is_test, template/.test(sql)) { const e = new Error('duplicate key'); e.code = '23505'; throw e; } return db(sql, p); };
  const sent = [], r = await ivrDb.tick(dup, { now: evening, env: liveEnv, http: okHttp(sent) });
  assert.equal(r.placed, 0); assert.equal(sent.length, 0); assert.equal(r.skipped.already_being_called, 1);
});

// ---- holding old no-answer leads for the IVR ----
const holdDb = (leads, orders) => {
  const rec = { lock: null, sqls: [] };
  const db = async (sql, p = []) => {
    rec.sqls.push(sql);
    if (/^\s*(CREATE|ALTER)/i.test(sql)) return [];
    if (/LEFT JOIN LATERAL/.test(sql)) return leads;
    if (/GROUP BY order_id/.test(sql)) return [];
    if (/COUNT\(\*\)::int AS n FROM ivr_calls/.test(sql)) return [{ n: 0 }];
    if (/FROM orders_master WHERE id = ANY/.test(sql)) return orders.filter(o => p[0].includes(o.id));
    if (/SELECT shipping_zip,/.test(sql) || /SELECT o\.id AS order_id/.test(sql)) return [];
    if (/SET lead_locked_by = 'IVR'/.test(sql) && /RETURNING id/.test(sql)) { rec.lock = p; return p[0].map(id => ({ id })); }
    throw new Error('unexpected sql ' + sql.slice(0, 70));
  };
  return { db, rec };
};
const oldLead = (id) => ({ ...lead(id), placed_at: new Date('2026-11-14T12:00:00+05:30'), attempts: 2, dnp_attempts: 2, dnp_days: 1, last_call_at: new Date('2026-11-18T12:00:00+05:30') });

test('hold: old no-answer leads that the IVR can call are locked for the callers; new orders and risky or bad ones are not', async () => {
  const leads = [oldLead('o-01'), oldLead('o-02'), oldLead('o-03'), lead('n-04')];
  const orders = [order('o-01', { customer_phone: '9000000051' }), order('o-02', { customer_phone: '9000000052' }), order('o-03', { customer_phone: '9000000053', total_price: '3500.00' }), order('n-04', { customer_phone: '9000000054' })];
  const { db, rec } = holdDb(leads, orders);
  const r = await ivrDb.holdBacklog(db, { count: 10, hours: 48, now: evening, env: liveEnv });
  assert.equal(r.candidates, 3);                                   // the new order is not a candidate: it keeps its normal flow
  assert.equal(r.held, 2); assert.deepEqual(r.left_to_person, { risk_medium: 1 });
  assert.deepEqual(rec.lock[0].sort(), ['o-01', 'o-02']); assert.equal(rec.lock[1], String(48 * 60 - 15));   // the lock clears by itself after 48 hours
});

test('hold: it never holds more than asked, and the hours are kept between 1 hour and a week', async () => {
  const leads = [oldLead('o-01'), oldLead('o-02'), oldLead('o-03')];
  const orders = leads.map((l, i) => order(l.id, { customer_phone: '90000000' + (60 + i) }));
  const a = holdDb(leads, orders), r = await ivrDb.holdBacklog(a.db, { count: 1, hours: 9999, now: evening, env: liveEnv });
  assert.equal(r.held, 1); assert.equal(r.hours, 168); assert.equal(a.rec.lock[1], String(168 * 60 - 15));
});

test('release: leads go back to the callers when the IVR is finished, and Release all gives every held lead back', async () => {
  let seen = null;
  const db = async (sql, p = []) => { seen = { sql, p }; return [{ id: 'x' }, { id: 'y' }]; };
  assert.equal(await ivrDb.releaseFinished(db, { IVR_MAX_TRIES: '3' }), 2);
  assert.equal(seen.p[0], 3); assert.match(seen.sql, /lead_locked_by = 'IVR'/); assert.match(seen.sql, /confirmation_status <> 'pending'/);
  assert.equal(await ivrDb.releaseAll(db), 2); assert.match(seen.sql, /WHERE lead_locked_by = 'IVR'/);
});

test('the planner sees leads the IVR holds, but the callers\' loader does not', async () => {
  const sqls = [];
  const db = async (sql) => { sqls.push(sql); return []; };
  await require('../lib/autopilotDb').loadLeads(db, { includeIvrLocked: true });
  await require('../lib/autopilotDb').loadLeads(db, {});
  assert.match(sqls[0], /OR o\.lead_locked_by = 'IVR'/); assert.doesNotMatch(sqls[1], /lead_locked_by = 'IVR'/);
});

test('automatic hold: tops up to the wanted number once in the hour before a window, never outside it, never when paused or switched off', async () => {
  const leads = [oldLead('o-01'), oldLead('o-02'), oldLead('o-03')];
  const orders = leads.map((l, i) => order(l.id, { customer_phone: '90000000' + (70 + i) }));
  const base = holdDb(leads, orders), claimed = new Set(); let held = 0, flags = {};
  const db = async (sql, p = []) => {
    if (/SELECT value FROM ivr_flags WHERE name = 'paused'/.test(sql)) return [];
    if (/INSERT INTO ivr_flags \(name, value\) VALUES \(\$1, '1'\)/.test(sql)) { if (claimed.has(p[0])) return []; claimed.add(p[0]); return [{ name: p[0] }]; }
    if (/INSERT INTO ivr_flags \(name, value\) VALUES \('last_auto_hold'/.test(sql)) { flags.last = p[0]; return []; }
    if (/FROM orders_master WHERE lead_locked_by = 'IVR' AND lead_locked_at >/.test(sql)) return [{ n: held }];
    return base.db(sql, p);
  };
  const env = { ...liveEnv, IVR_AUTO_HOLD: '2' }, t1730 = new Date('2026-11-20T17:30:00+05:30');
  const a = await ivrDb.autoHold(db, { now: t1730, env });
  assert.equal(a.wanted, 2); assert.equal(a.held, 2); assert.equal(base.rec.lock[0].length, 2); assert.ok(flags.last);
  assert.equal(await ivrDb.autoHold(db, { now: t1730, env }), null);                       // the same hour again: nothing
  assert.equal(await ivrDb.autoHold(db, { now: new Date('2026-11-20T12:00:00+05:30'), env }), null);   // not the hour before a window
  assert.equal(await ivrDb.autoHold(db, { now: new Date('2026-11-21T17:30:00+05:30'), env: { ...liveEnv } }), null);   // switched off (IVR_AUTO_HOLD not set)
  held = 2; const b = await ivrDb.autoHold(db, { now: new Date('2026-11-21T05:10:00+05:30'), env });   // next day, already 2 held: nothing to add
  assert.equal(b.held, 0); assert.equal(b.already, 2);
});
const curveCacheReset = () => { /* the curve is cached per worker for 30 minutes: tests start from a clean cache */ ivrDb._resetCurve(); };


// ---- smart hours: the day-time campaign for no-answer leads ----
const curveRows = (good) => Array.from({ length: 24 }, (_, hour) => ({ hour, calls: 100, connected: good.includes(hour) ? 60 : 20, retry_calls: 100, retry_connected: good.includes(hour) ? 60 : 20 }));
const smartDb = (leads, orders, { usedHour = 0, good = [12, 13] } = {}) => {
  const base = dialerDb(leads, orders);
  const db = async (sql, p = []) => {
    if (/FROM lead_call_log g JOIN orders_master o/.test(sql)) return curveRows(good);
    if (/FROM ivr_calls WHERE NOT is_test AND placed_at >= NOW\(\) - INTERVAL '30 days'/.test(sql)) return [];
    if (/placed_at < \$2/.test(sql)) return [{ n: usedHour }];
    return base.db(sql, p);
  };
  return { db, rec: base.rec };
};
const noon = new Date('2026-11-20T12:10:00+05:30');
const freshLead = (id) => ({ ...lead(id), placed_at: new Date('2026-11-20T11:00:00+05:30') });
const smartEnv = { ...liveEnv, IVR_DAILY_CAP: '100' };

test('smart hours: in a good hour of the day the IVR calls only no-answer leads, never fresh orders', async () => {
  curveCacheReset();
  const leads = [freshLead('f-01'), oldLead('o-02'), oldLead('o-03')];
  const orders = [order('f-01', { customer_phone: '9000000081' }), order('o-02', { customer_phone: '9000000082' }), order('o-03', { customer_phone: '9000000083' })];
  const { db } = smartDb(leads, orders), sent = [];
  const r = await ivrDb.tick(db, { now: noon, env: smartEnv, http: okHttp(sent) });
  assert.equal(r.placed, 2); assert.deepEqual(sent.map(x => x.customer_no).sort(), ['09000000082', '09000000083']);   // the fresh order was left to the callers
  assert.equal(r.smart_hour.hour, 12); assert.equal(r.smart_hour.share, 0.5);
});

test('smart hours: closed in a bad hour, closed when switched off, and paced by the hour\'s share of the budget', async () => {
  curveCacheReset();
  const leads = [oldLead('o-02'), oldLead('o-03')], orders = [order('o-02', { customer_phone: '9000000082' }), order('o-03', { customer_phone: '9000000083' })];
  assert.equal((await ivrDb.tick(smartDb(leads, orders).db, { now: new Date('2026-11-20T15:10:00+05:30'), env: smartEnv, http: okHttp([]) })).skipped, 'window_closed');   // 3 PM is not a good hour
  assert.equal((await ivrDb.tick(smartDb(leads, orders).db, { now: noon, env: { ...smartEnv, IVR_SMART: 'off' }, http: okHttp([]) })).skipped, 'window_closed');
  const full = await ivrDb.tick(smartDb(leads, orders, { usedHour: 35 }).db, { now: noon, env: smartEnv, http: okHttp([]) });   // the hour's allowance (35 of 70) is already used
  assert.equal(full.placed, 0); assert.equal(full.smart_hour.room, 0);
});

test('smart hours: with too little data to choose hours, every day hour counts equally, and the fixed windows are never affected', async () => {
  const hc = require('../lib/hourCurve');
  const none = hc.build({ human: [], ivr: [] });
  assert.deepEqual(none.smart_hours, []);
  const s9 = hc.smartNow(none, new Date('2026-11-20T10:00:00+05:30'));
  assert.equal(s9.open, true); assert.equal(Math.round(s9.share * 12), 1);             // 12 allowed hours, an equal share each
  assert.equal(hc.smartNow(none, new Date('2026-11-20T23:30:00+05:30')).open, false);   // outside 9 AM to 9 PM
});

test('hour curve: indexes compare each hour with its own source\'s average, and the IVR\'s own evidence takes over as it grows', () => {
  const hc = require('../lib/hourCurve');
  const c = hc.build({ human: curveRows([12, 13]) });
  assert.deepEqual(c.smart_hours, [12, 13]); assert.equal(c.human_avg_pct, 23.3);
  const h12 = c.hours[12]; assert.equal(h12.pickup_pct, 60); assert.ok(h12.index > 2.5);
  const many = hc.build({ human: curveRows([12, 13]), ivr: [{ hour: 12, placed: 400, pressed: 4 }, { hour: 15, placed: 400, pressed: 100 }, { hour: 17, placed: 400, pressed: 40 }] });
  assert.equal(many.hours[12].chosen, false);                                         // the IVR gets almost no key presses at noon, however well callers do then
  assert.equal(many.hours[15].ivr_pct, 25);
});


const curveResetFn = () => ivrDb._resetCurve();


// ---- settings read tolerantly, Start now, the worker's own settings ----
test('settings: spaces, quotes and capital letters in a Railway value are ignored', () => {
  const p = require('../lib/ivrPlan');
  assert.equal(p.settings({ IVR_MODE: ' On ' }).mode, 'on'); assert.equal(p.settings({ IVR_MODE: '"on"' }).mode, 'on'); assert.equal(p.settings({ IVR_MODE: "'ON'" }).mode, 'on');
  assert.equal(p.settings({ IVR_MODE: 'maybe' }).mode, 'off'); assert.equal(p.settings({}).mode, 'off');
  assert.equal(p.settings({ IVR_DAILY_CAP: ' 900 ' }).dailyCap, 900); assert.equal(p.settings({ IVR_DAILY_CAP: '"900"' }).dailyCap, 900);
});

test('Start now: outside the best hours, no-answer calls run for a while; it never reaches outside 9 AM to 9 PM and the fresh orders stay with the callers', async () => {
  curveResetFn();
  const leads = [freshLead('f-01'), oldLead('o-02')], orders = [order('f-01', { customer_phone: '9000000091' }), order('o-02', { customer_phone: '9000000092' })];
  const mk = (until) => { const base = smartDb(leads, orders, { good: [11] }); const db = async (sql, p = []) => /SELECT value FROM ivr_flags WHERE name = 'force_until'/.test(sql) ? (until ? [{ value: until }] : []) : base.db(sql, p); return { db, rec: base.rec }; };
  const t3pm = new Date('2026-11-20T15:10:00+05:30');                           // 3 PM is not a best hour in this curve (only 11 AM is)
  assert.equal((await ivrDb.tick(mk(null).db, { now: t3pm, env: smartEnv, http: okHttp([]) })).skipped, 'window_closed');
  curveResetFn();
  const sent = [], r = await ivrDb.tick(mk('2026-11-20T17:00:00+05:30').db, { now: t3pm, env: smartEnv, http: okHttp(sent) });
  assert.equal(r.forced, true); assert.equal(r.placed, 1); assert.equal(sent[0].customer_no, '09000000092');   // only the no-answer lead
  curveResetFn();
  assert.equal((await ivrDb.tick(mk('2026-11-20T23:55:00+05:30').db, { now: new Date('2026-11-20T23:30:00+05:30'), env: smartEnv, http: okHttp([]) })).skipped, 'window_closed');   // 11:30 PM is outside the day hours and the fixed windows
  curveResetFn();
  assert.equal((await ivrDb.tick(mk('2026-11-20T15:00:00+05:30').db, { now: t3pm, env: smartEnv, http: okHttp([]) })).skipped, 'window_closed');   // the Start now time is over
});

test('the worker saves the mode and cap it reads, so the page can show if the web service and the worker disagree', async () => {
  let saved = null;
  const db = async (sql, p = []) => { if (/^\s*(CREATE|ALTER)/i.test(sql)) return []; if (/INSERT INTO ivr_flags \(name, value\) VALUES \('last_tick'/.test(sql)) { saved = JSON.parse(p[0]); return []; } return []; };
  await ivrDb.runAndRecord(db, { env: { IVR_MODE: ' On ', IVR_DAILY_CAP: '900' } });
  assert.deepEqual(saved.worker, { mode: 'on', cap: 900, smart: true, per_day: 1 });
});

test('best hours: an hour with too few retries is never filled in from first calls, and "true" or "1" in IVR_MODE means on', () => {
  const hc = require('../lib/hourCurve'), p = require('../lib/ivrPlan');
  const rows = Array.from({ length: 24 }, (_, hour) => ({ hour, calls: 1000, connected: 700, retry_calls: hour === 9 ? 4 : 100, retry_connected: hour === 9 ? 4 : (hour === 15 ? 45 : 25) }));
  const c = hc.build({ human: rows });
  assert.equal(c.hours[9].enough, false); assert.equal(c.hours[9].chosen, false);       // 9 AM looks great on first calls (70%), but it has almost no retries
  assert.deepEqual(c.smart_hours, [15]);
  for (const v of ['true', '1', 'Yes', ' ENABLED ']) assert.equal(p.settings({ IVR_MODE: v }).mode, 'on');
  assert.equal(p.settings({ IVR_MODE: 'dry' }).mode, 'dry'); assert.equal(p.settings({ IVR_MODE: 'maybe' }).mode, 'off');
});

test('budget: new orders can use only their share of the day (30%), so an early burst can never spend the whole day', async () => {
  const leads = [lead('n-01'), lead('n-02'), lead('n-03')];
  const orders = [order('n-01', { customer_phone: '9000000051' }), order('n-02', { customer_phone: '9000000052' }), order('n-03', { customer_phone: '9000000053' })];
  const cap10 = { ...liveEnv, IVR_DAILY_CAP: '10' };                                  // 30% of 10 = 3 new-order calls a day
  const a = dialerDb(leads, orders, { freshUsed: 3 }), sa = [];
  const ra = await ivrDb.tick(a.db, { now: evening, env: cap10, http: okHttp(sa) });
  assert.equal(ra.placed, 0); assert.equal(sa.length, 0);                              // the 3 are already used today
  const b = dialerDb(leads, orders, { freshUsed: 2 }), sb = [];
  const rb = await ivrDb.tick(b.db, { now: evening, env: cap10, http: okHttp(sb) });
  assert.equal(rb.placed, 1);                                                          // room for exactly one more
});

test('budget: nothing is called at 6 AM by default, and no-answer leads are not called in the evening window unless it is also a best hour', async () => {
  const oldLead = (id) => ({ ...lead(id), placed_at: new Date('2026-11-14T12:00:00+05:30'), attempts: 2, dnp_attempts: 2, dnp_days: 1, last_call_at: new Date('2026-11-18T12:00:00+05:30') });
  const leads = [oldLead('o-01'), oldLead('o-02'), lead('n-03')];
  const orders = [order('o-01', { customer_phone: '9000000061' }), order('o-02', { customer_phone: '9000000062' }), order('n-03', { customer_phone: '9000000063' })];
  const morning = dialerDb(leads, orders), sm = [];
  const rm = await ivrDb.tick(morning.db, { now: new Date('2026-11-19T06:30:00+05:30'), env: liveEnv, http: okHttp(sm) });
  assert.equal(rm.skipped, 'window_closed'); assert.equal(sm.length, 0);                // the 6 AM burst is gone
  const eve = dialerDb(leads, orders), se = [];
  const re = await ivrDb.tick(eve.db, { now: evening, env: { ...liveEnv, IVR_DAILY_CAP: '100', IVR_SMART: 'off' }, http: okHttp(se) });
  assert.equal(re.placed, 1); assert.equal(se[0].customer_no, '09000000063');          // only the new order; with the best hours off, the old no-answer leads are not called in the evening window
});

test('first call: an older lead nobody has called gets its first IVR call at the first day hour, even outside the best hours; retries still wait for the best hours', async () => {
  const oldNever = (id) => ({ ...lead(id), placed_at: new Date('2026-11-17T12:00:00+05:30'), attempts: 0 });                 // placed 2 days ago, no attempt by anyone
  const oldRetry = (id) => ({ ...lead(id), placed_at: new Date('2026-11-14T12:00:00+05:30'), attempts: 2, dnp_attempts: 2, dnp_days: 1, last_call_at: new Date('2026-11-18T12:00:00+05:30') });
  const leads = [oldRetry('r-01'), oldNever('n-02')];
  const orders = [order('r-01', { customer_phone: '9000000071' }), order('n-02', { customer_phone: '9000000072' })];
  const eleven = new Date('2026-11-19T11:00:00+05:30');                                                                         // a day hour, not a fixed window
  const a = dialerDb(leads, orders), sa = [];
  const ra = await ivrDb.tick(a.db, { now: eleven, env: { ...liveEnv, IVR_DAILY_CAP: '100', IVR_SMART: 'off', IVR_FIRST_SHARE: '0.4' }, http: okHttp(sa) });
  assert.equal(ra.placed, 1); assert.equal(sa[0].customer_no, '09000000072');                                                    // only the never-called lead
  assert.equal(a.rec.inserted[0][4], 1); assert.equal(a.rec.inserted[0][5], 'first');                                            // recorded as attempt 1, kind "first"
  const night = dialerDb(leads, orders), sn = [];
  const rn = await ivrDb.tick(night.db, { now: new Date('2026-11-19T06:00:00+05:30'), env: { ...liveEnv, IVR_DAILY_CAP: '100', IVR_SMART: 'off', IVR_FIRST_SHARE: '0.4' }, http: okHttp(sn) });
  assert.equal(rn.skipped, 'window_closed'); assert.equal(sn.length, 0);                                                        // 6 AM is neither a day hour nor a fixed window
  const cap = dialerDb(leads, orders, { }), sc = [];
  const rc = await ivrDb.tick(cap.db, { now: eleven, env: { ...liveEnv, IVR_DAILY_CAP: '100', IVR_SMART: 'off', IVR_FIRST_SHARE: '0' }, http: okHttp(sc) });
  assert.ok(!rc.placed); assert.equal(sc.length, 0);                                                                            // the first-call share can be set to 0: nothing goes out
});

test('agents own the day: by default the IVR makes NO first call on any lead between 9 AM and 6 PM, fresh or older', async () => {
  const oldNever = { ...lead('n-02'), placed_at: new Date('2026-11-17T12:00:00+05:30'), attempts: 0 };
  const fresh = lead('f-03');
  const orders = [order('n-02', { customer_phone: '9000000082' }), order('f-03', { customer_phone: '9000000083' })];
  for (const hh of ['09:00', '11:00', '14:00', '17:59']) {
    const d = dialerDb([oldNever, fresh], orders), sent = [];
    const r = await ivrDb.tick(d.db, { now: new Date('2026-11-19T' + hh + ':00+05:30'), env: { ...liveEnv, IVR_DAILY_CAP: '100', IVR_SMART: 'off' }, http: okHttp(sent) });
    assert.equal(sent.length, 0, hh); assert.ok(!r.placed, hh);
  }
});

test('one owner per lead: the IVR claims the lead BEFORE it dials, and if a person has it the IVR does not call', async () => {
  const a = dialerDb([lead('a-01')], [order('a-01', { customer_phone: '9000000091' })]), sa = [];
  const ra = await ivrDb.tick(a.db, { now: evening, env: liveEnv, http: okHttp(sa) });
  assert.equal(ra.placed, 1); assert.deepEqual(a.rec.locks, ['a-01']);                         // claimed, then called
  const b = dialerDb([lead('b-01')], [order('b-01', { customer_phone: '9000000092' })], { refuseClaim: true }), sb = [];   // Aman or the call centre opened it a moment ago
  const rb = await ivrDb.tick(b.db, { now: evening, env: liveEnv, http: okHttp(sb) });
  assert.equal(rb.placed, 0); assert.equal(sb.length, 0); assert.equal(rb.skipped.person_has_it, 1);   // nobody is called twice
  assert.equal(b.rec.inserted.length, 0);                                                      // not even a call record was made
});

test('one owner per lead: a request the IVR service refuses gives the lead back to the callers', async () => {
  const bad = { post: async () => ({ status: 200, data: { status: 400, message: 'Invalid number' } }) };
  const d = dialerDb([lead('c-01')], [order('c-01', { customer_phone: '9000000093' })]);
  const r = await ivrDb.tick(d.db, { now: evening, env: liveEnv, http: bad });
  assert.equal(r.placed, 0); assert.equal(r.failed, 1); assert.deepEqual(d.rec.released, ['c-01']);
});

test('cover day: when nobody from Aman or the call centre is working, the IVR calls new orders in the day and the cap rises; when a caller is back, the normal rules return', async () => {
  const noon = new Date('2026-11-22T12:00:00+05:30'), cEnv = { ...liveEnv, IVR_SMART: 'off' };   // best hours off: this test is about the cover day only, whatever an earlier test left in the pick-up curve cache
  const mk = (extra) => dialerDb([{ ...lead('k-01'), placed_at: new Date('2026-11-22T09:30:00+05:30') }], [order('k-01', { customer_phone: '9000000041' })], extra);   // placed this morning, nobody has called it
  const a = mk({ nobodyWorking: true }), sa = [];
  const ra = await ivrDb.tick(a.db, { now: noon, env: cEnv, http: okHttp(sa) });
  assert.equal(ra.placed, 1); assert.equal(ra.cover, true); assert.ok(ra.cap_left >= 400);            // a new order is called at noon; the cap is 500, not 20
  const b = mk({ nobodyWorking: false }), sb = [];
  const rb = await ivrDb.tick(b.db, { now: noon, env: cEnv, http: okHttp(sb) });
  assert.equal(rb.skipped, 'window_closed'); assert.equal(sb.length, 0);                              // a caller is working: agents own the day, as before
  const c = mk({ nobodyWorking: true }), sc = [];
  const rc = await ivrDb.tick(c.db, { now: noon, env: { ...cEnv, IVR_COVER: 'off' }, http: okHttp(sc) });
  assert.equal(rc.skipped, 'window_closed'); assert.equal(sc.length, 0);                              // switched off
  const d = mk({ nobodyWorking: true }), sd = [];
  const rd = await ivrDb.tick(d.db, { now: new Date('2026-11-22T09:10:00+05:30'), env: cEnv, http: okHttp(sd) });
  assert.equal(rd.cover, undefined); assert.equal(sd.length, 0);                                       // before 9:30 the callers may still be arriving: no cover, no call to a new order
});

test('task 1: an order placed overnight is called as the 7 AM window opens; at 10 AM, with callers working, new orders wait for the callers; at 7 PM the evening window calls them', async () => {
  const cEnv = { ...liveEnv, IVR_SMART: 'off' };
  const overnight = { ...lead('m-01'), placed_at: new Date('2026-11-23T01:30:00+05:30') };   // placed overnight, still 'fresh' (under 18 hours) at 7 PM
  const mk = () => dialerDb([overnight], [order('m-01', { customer_phone: '9000000051' })]);
  const a = mk(), sa = [];
  assert.equal((await ivrDb.tick(a.db, { now: new Date('2026-11-23T07:05:00+05:30'), env: cEnv, http: okHttp(sa) })).placed, 1);        // 7:05 AM: the morning window is open, the order is called at once
  const b = mk(), sb = [];
  assert.equal((await ivrDb.tick(b.db, { now: new Date('2026-11-23T10:00:00+05:30'), env: cEnv, http: okHttp(sb) })).skipped, 'window_closed'); assert.equal(sb.length, 0);   // 10 AM: Aman and the call centre own the day
  const c = mk(), sc = [];
  assert.equal((await ivrDb.tick(c.db, { now: new Date('2026-11-23T19:00:00+05:30'), env: cEnv, http: okHttp(sc) })).placed, 1);         // 7 PM: the evening window is open
  const d = mk(), sd = [];
  assert.equal((await ivrDb.tick(d.db, { now: new Date('2026-11-23T22:30:00+05:30'), env: cEnv, http: okHttp(sd) })).skipped, 'window_closed'); assert.equal(sd.length, 0);   // after 10 PM nothing goes out
});