const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const C = require('../lib/cancelAsks');

test('cancel requests: IVR key 3 and the WhatsApp Cancel button are told apart, and the waiting ones are counted', () => {
  const now = new Date('2026-11-23T12:00:00Z');
  const r = C.summarize([
    { order: '#1', team: 'CC', callback_at: '2026-11-23T11:30:00Z', callback_note: 'IVR: customer pressed 3 (cancel). Please call and try to save the order.', tries_since: 0 },
    { order: '#2', team: 'InHouse', callback_at: '2026-11-23T08:00:00Z', callback_note: 'WhatsApp: customer tapped "Cancel". Please call and try to save the order.', tries_since: 1 },
    { order: '#3', team: 'CC', callback_at: '2026-11-23T09:00:00Z', callback_note: 'IVR: customer pressed 2, wants to change the delivery address.', tries_since: 0 },   // not a cancel request
  ], now);
  assert.equal(r.waiting, 2); assert.equal(r.overdue_2h, 1); assert.equal(r.never_called_since, 1);
  assert.deepEqual(r.by_channel, { IVR: 1, WhatsApp: 1 }); assert.deepEqual(r.list.map(x => x.order), ['#2', '#1']);        // the longest waiting first
  assert.deepEqual([r.list[0].team, r.list[0].channel, r.list[0].waiting_hours, r.list[0].calls_since], ['Aman', 'WhatsApp', 4, 1]);
  assert.equal(C.channelOfNote(null), null);
});

test('cancel requests: pressing 2 or 3 on the IVR ends the IVR hold at once, so a caller sees the lead straight away, and the order is never cancelled by the key', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ivrDb.js'), 'utf8').replace(/\r\n/g, '\n');
  const i = src.indexOf('async function followUp'); assert.ok(i > 0); const body = src.slice(i, i + 900);
  assert.match(body, /lead_locked_by = CASE WHEN lead_locked_by = 'IVR' THEN NULL ELSE lead_locked_by END/);
  assert.match(body, /lead_locked_at = CASE WHEN lead_locked_by = 'IVR' THEN NULL ELSE lead_locked_at END/);
  assert.match(body, /callback_at = NOW\(\)/); assert.doesNotMatch(body, /confirmation_status = 'cancelled'/);        // the key never cancels by itself
  const wa = fs.readFileSync(path.join(__dirname, '..', 'lib', 'waBridge.js'), 'utf8');
  assert.match(wa, /CLICK_NOTE[\s\S]{0,400}Cancel it only if the customer says so on the call/);                           // WhatsApp: same rule
});
