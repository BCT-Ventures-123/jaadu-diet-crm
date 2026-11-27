const test = require('node:test');
const assert = require('node:assert/strict');
const ip = require('../lib/ivrProvider');

const rec = (o = {}) => ({ id: 78901, dialer_id: 0, dialer_name: '', customer_no: '09876543210', call_time: '2026-11-27 08:54:30', call_duration: 45, call_status: 'answered', dtmf_input: '1', attempts: 1, ...o });

test('settings: off by default, on only when asked, the key is read but never exposed here', () => {
  assert.equal(ip.settings({}).on, false); assert.equal(ip.settings({ IVR_PROVIDER_SYNC: 'on', IVR_API_KEY: 'k' }).on, true); assert.equal(ip.settings({ IVR_PROVIDER_SYNC: ' "ON" ' }).on, true); assert.equal(ip.settings({ IVR_PROVIDER_SYNC: 'maybe' }).on, false);
});

test('normalize: the documented fields, the India-time call time, a ten digit phone', () => {
  const n = ip.normalize(rec());
  assert.equal(n.id, '78901'); assert.equal(n.phone, '9876543210'); assert.equal(n.seconds, 45); assert.equal(n.dtmf, '1'); assert.equal(n.outcome, 'answered');
  assert.equal(n.at.toISOString(), '2026-11-27T03:24:30.000Z');                                   // 08:54:30 India time
  assert.equal(ip.normalize(rec({ customer_no: '', client_no: '+91 98765 43211' })).phone, '9876543211');   // other field name, country code
  assert.equal(ip.normalize(rec({ customer_no: '12345' })), null); assert.equal(ip.normalize(rec({ call_time: '' })), null); assert.equal(ip.normalize(rec({ id: '' })), null);
});

test('classify: missed words, answered words, and the seconds when the word is unknown', () => {
  for (const s of ['missed', 'Customer Missed', 'no_answer', 'busy', 'failed', 'NOT REACHABLE']) assert.equal(ip.classify(s, 0), 'missed', s);
  for (const s of ['answered', 'Customer Answered', 'attended', 'connected', 'completed']) assert.equal(ip.classify(s, 0), 'answered', s);
  assert.equal(ip.classify('', 12), 'answered'); assert.equal(ip.classify('weird', 0), 'unknown');
  assert.equal(ip.normalize(rec({ call_status: 'no_answer', call_duration: 0, dtmf_input: '' })).outcome, 'missed');
});

test('normalize: the provider\'s real log shape (client_no, customer_attended, recordid, ISO time with +05:30)', () => {
  const real = { dialer_id: '678', client_no: '9876543458', customer_attended: '1', call_time: '2026-11-27T14:11:04+05:30', call_duration: '25', recordid: '3820327', note: null };
  const n = ip.normalize(real); assert.equal(n.id, '3820327'); assert.equal(n.phone, '9876543458'); assert.equal(n.outcome, 'answered'); assert.equal(n.at.toISOString(), '2026-11-27T08:41:04.000Z'); assert.equal(n.dialer, 'dialer 678');
  assert.equal(ip.normalize({ ...real, customer_attended: '0', call_duration: '0' }).outcome, 'missed'); assert.equal(ip.normalize({ ...real, customer_attended: '0', call_duration: '30' }).outcome, 'missed');
});

const ours = [{ id: 1, phone: '09876543210', placed_at: '2026-11-27T03:23:50Z' }, { id: 2, phone: '9876543210', placed_at: '2026-11-27T03:00:00Z' }, { id: 3, phone: '9000000001', placed_at: '2026-11-27T03:24:00Z' }];
test('matchOne: same phone, nearest in time, within the window, one provider call per call of ours', () => {
  const p = ip.normalize(rec());                                                                  // call started 08:54:30 India = 03:24:30Z
  assert.equal(ip.matchOne(p, ours).id, 1);                                                       // 40 seconds after request 1, not request 2 (24 minutes earlier)
  const used = new Set([1]); assert.equal(ip.matchOne(p, ours, used).id, 2);                      // request 1 is taken: the next nearest on the same phone
  assert.equal(ip.matchOne(p, ours, new Set([1, 2])), null);
  assert.equal(ip.matchOne({ ...p, phone: '9111111111' }, ours), null);                           // another phone
  assert.equal(ip.matchOne({ ...p, at: new Date('2026-11-27T05:00:00Z') }, ours), null);          // an hour later: not the same call
  assert.equal(ip.matchOne({ ...p, at: new Date('2026-11-27T03:20:00Z') }, ours, new Set([2])), null);   // started 3.8 minutes BEFORE our request 1 (and request 2 is taken): not that call
});

function fakeDb(h = {}) {
  const log = []; const db = async (sql, p = []) => { log.push({ sql, p }); for (const [re, fn] of Object.entries(h)) if (new RegExp(re, 's').test(sql)) return fn(sql, p); return []; }; db.log = log; return db;
}
const http = (pages) => { let i = 0; return { post: async () => { const r = pages[Math.min(i, pages.length - 1)]; i++; if (r instanceof Error) throw r; return { status: 200, data: r }; } }; };

test('sync: off does nothing; on reads pages, stores each record once, advances the cursor, then matches', async () => {
  ip._reset();
  assert.deepEqual(await ip.sync(fakeDb(), new Date(), { env: {}, http: http([]) }), { skipped: 'off' });
  const env = { IVR_PROVIDER_SYNC: 'on', IVR_API_KEY: 'k' };
  const db = fakeDb({ "FROM ivr_flags": () => [{ value: '100' }], 'INSERT INTO ivr_provider_calls': () => [{ provider_log_id: 'x' }] });
  const pages = [{ status: 200, dialer_logs: [rec({ id: 101 }), rec({ id: 102 }), { junk: true }], next_dialer_log_id: 102, has_more: { dialer_logs: true } }, { status: 200, dialer_logs: [rec({ id: 103 })], next_dialer_log_id: 103, has_more: { dialer_logs: false } }];
  const r = await ip.sync(db, new Date('2026-11-27T04:00:00Z'), { env, http: http(pages) });
  assert.equal(r.stored, 3); assert.equal(r.pages, 2); assert.equal(r.cursor, '103');
  assert.equal(db.log.filter(l => /INSERT INTO ivr_provider_calls/.test(l.sql)).length, 3);        // the junk record is ignored
  const cursors = db.log.filter(l => /INSERT INTO ivr_flags/.test(l.sql)).map(l => l.p[0]); assert.deepEqual(cursors, ['102', '103']);
  const dup = fakeDb({ "FROM ivr_flags": () => [], 'INSERT INTO ivr_provider_calls': () => [] });   // the same records again: stored once
  assert.equal((await ip.sync(dup, new Date(), { env, http: http([{ status: 200, dialer_logs: [rec({ id: 101 })], next_dialer_log_id: 101, has_more: {} }]) })).stored, 0);
});

test('sync: a provider error or a missing key is reported, never thrown, and nothing is stored', async () => {
  ip._reset();
  const env = { IVR_PROVIDER_SYNC: 'on', IVR_API_KEY: 'k' }, db = fakeDb({ "FROM ivr_flags": () => [] });
  const e1 = await ip.sync(db, new Date(), { env, http: http([Object.assign(new Error('boom'), { response: { data: { message: 'Invalid token' } } })]) });
  assert.equal(e1.error, 'Invalid token'); assert.equal(db.log.filter(l => /INSERT INTO ivr_provider_calls/.test(l.sql)).length, 0);
  assert.equal((await ip.sync(fakeDb({ "FROM ivr_flags": () => [] }), new Date(), { env: { IVR_PROVIDER_SYNC: 'on' }, http: http([]) })).error, 'IVR_API_KEY is not set');
});

test('fetchPage: sends the read-only request with the cursor and a bearer key, returns the raw field names', async () => {
  let seen = null; const client = { post: async (url, body, opt) => { seen = { url, body, opt }; return { status: 200, data: { status: 200, dialer_logs: [rec({ id: 5 })], next_dialer_log_id: 5, has_more: { dialer_logs: false } } }; } };
  const r = await ip.fetchPage({ http: client, apiKey: 'sekret', cursors: { dialer: '7' } });
  assert.equal(seen.url, 'https://api.ivrsolutions.in/v1/all_call_logs'); assert.equal(seen.body.last_dialer_log_id, '7'); assert.equal(seen.opt.headers.Authorization, 'Bearer sekret');
  assert.ok(r.keys.includes('call_status') && r.keys.includes('dtmf_input')); assert.equal(r.records.length, 1); assert.equal(r.next, '5');
});

test('check: the reconciliation returns our calls against the provider\'s, and what is missing', async () => {
  ip._reset();
  const db = fakeDb({ 'FROM ivr_calls WHERE NOT is_test AND status IN': () => [{ placed: 66, pressed: 19 }], 'JOIN ivr_provider_calls p': () => [{ matched: 60, answered: 33, missed: 25, unknown: 2, answered_no_key: 15, answered_seconds: 900 }],
    'WHERE ivr_call_id IS NULL AND': () => [{ n: 1, no_campaign: 1 }], 'MAX\\(call_time\\)': () => [{ t: '2026-11-27T04:00:00Z', f: '2026-11-27T04:05:00Z' }] });
  const c = await ip.check(db, '2026-11-27', '2026-11-27');
  assert.equal(c.our_calls_placed, 66); assert.equal(c.found_at_provider, 60); assert.equal(c.not_found_at_provider, 6); assert.equal(c.answered, 33); assert.equal(c.answered_and_pressed_a_key, 18); assert.equal(c.answered_no_key, 15); assert.equal(c.missed, 25); assert.equal(c.provider_calls_not_ours, 1);
});
