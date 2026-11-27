const test = require('node:test');
const assert = require('node:assert/strict');
const ivr = require('../lib/ivrPlan');

const S = (o = {}) => ivr.settings({ IVR_MODE: 'on', ...o });
const lead = (o = {}) => ({ id: 'a', placed_at: '2026-11-27T14:00:00Z', attempts: 0, ...o });          // 19:30 India time
const T = (iso) => new Date(iso);

test('off by default: the IVR does not wait for WhatsApp', () => {
  assert.equal(S().waWaitMinutes, 0);
  assert.equal(ivr.blockedReason(lead({ wa_first_at: '2026-11-27T14:29:00Z' }), T('2026-11-27T14:30:00Z'), S(), null), null);
  assert.equal(ivr.blockedReason(lead({ wa_responded: true }), T('2026-11-27T14:30:00Z'), S(), null), null);
});

test('on (15 minutes): waits 15 minutes after the first WhatsApp message, then the order may be called', () => {
  const s = S({ IVR_WA_WAIT_MINUTES: '15' }), l = lead({ placed_at: '2026-11-27T14:00:00Z', wa_first_at: '2026-11-27T14:02:00Z' });
  assert.equal(s.waWaitMinutes, 15);
  assert.equal(ivr.blockedReason(l, T('2026-11-27T14:10:00Z'), s, null), 'waiting_for_whatsapp');       // 8 minutes after the message
  assert.equal(ivr.blockedReason(l, T('2026-11-27T14:16:59Z'), s, null), 'waiting_for_whatsapp');       // 14 min 59 s
  assert.equal(ivr.blockedReason(l, T('2026-11-27T14:17:00Z'), s, null), null);                         // 15 minutes: it may be called
});

test('on: a customer who already tapped or replied on WhatsApp is never called, at any time', () => {
  const s = S({ IVR_WA_WAIT_MINUTES: '15' });
  assert.equal(ivr.blockedReason(lead({ wa_first_at: '2026-11-27T14:02:00Z', wa_responded: true }), T('2026-11-27T14:10:00Z'), s, null), 'whatsapp_answered');
  assert.equal(ivr.blockedReason(lead({ wa_first_at: '2026-11-27T14:02:00Z', wa_responded: true }), T('2026-11-27T18:00:00Z'), s, null), 'whatsapp_answered');
});

test('on: no WhatsApp message yet, the wait counts from the order time; an old order is not held back', () => {
  const s = S({ IVR_WA_WAIT_MINUTES: '15' });
  assert.equal(ivr.blockedReason(lead({ placed_at: '2026-11-27T14:00:00Z' }), T('2026-11-27T14:10:00Z'), s, null), 'waiting_for_whatsapp');
  assert.equal(ivr.blockedReason(lead({ placed_at: '2026-11-27T14:00:00Z' }), T('2026-11-27T14:15:00Z'), s, null), null);
  assert.equal(ivr.blockedReason(lead({ placed_at: '2026-11-20T14:00:00Z', wa_first_at: '2026-11-20T14:02:00Z', attempts: 3 }), T('2026-11-27T14:10:00Z'), s, null), null);
});

test('the evening rule: an order at 9:45 PM is messaged at once and its call time falls after the 10 PM window end, so it waits for 7 AM; an order at 9:30 PM is called at 9:45 PM', () => {
  const s = S({ IVR_WA_WAIT_MINUTES: '15' });
  const late = lead({ placed_at: '2026-11-27T16:15:00Z', wa_first_at: '2026-11-27T16:16:00Z' });          // placed 9:45 PM India, message 9:46 PM
  assert.equal(ivr.blockedReason(late, T('2026-11-27T16:30:00Z'), s, null), 'waiting_for_whatsapp');    // 10:00 PM, 14 minutes after the message
  assert.equal(ivr.windowStatus(T('2026-11-27T16:31:00Z'), s).open, false);                              // 10:01 PM: the window is closed, so no call tonight
  assert.equal(ivr.windowStatus(T('2026-11-28T01:30:00Z'), s).open, true);                               // 7:00 AM next day: the morning window opens, the wait is long over
  assert.equal(ivr.blockedReason(late, T('2026-11-28T01:30:00Z'), s, null), null);
  const ok = lead({ placed_at: '2026-11-27T16:00:00Z', wa_first_at: '2026-11-27T16:01:00Z' });           // placed 9:30 PM India
  assert.equal(ivr.blockedReason(ok, T('2026-11-27T16:16:00Z'), s, null), null);                          // 9:46 PM: waited 15 minutes
  assert.equal(ivr.windowStatus(T('2026-11-27T16:16:00Z'), s).open, true);
});

test('buildList counts the held back orders under their own reason', () => {
  const s = S({ IVR_WA_WAIT_MINUTES: '15', IVR_DAILY_CAP: '50' }), now = T('2026-11-27T14:10:00Z');
  const leads = [lead({ id: 'new', wa_first_at: '2026-11-27T14:05:00Z' }), lead({ id: 'tapped', wa_first_at: '2026-11-27T13:00:00Z', wa_responded: true }), lead({ id: 'ready', placed_at: '2026-11-27T13:30:00Z', wa_first_at: '2026-11-27T13:31:00Z' })];
  const p = ivr.buildList({ now, leads, ivrByLead: {} }, s);
  assert.deepEqual(p.ids, ['ready']); assert.equal(p.blocked.waiting_for_whatsapp, 1); assert.equal(p.blocked.whatsapp_answered, 1);
});
