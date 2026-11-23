const test = require('node:test');
const assert = require('node:assert');
const { validateCallback, isInMainQueue, callbackBadge } = require('../lib/callback');

const now = new Date('2026-03-10T06:30:00Z');
const plus = (h) => new Date(now.getTime() + h * 3600000).toISOString();

test('requires a time', () => {
  assert.equal(validateCallback('', now).ok, false);
  assert.equal(validateCallback(undefined, now).ok, false);
});

test('rejects invalid and past times', () => {
  assert.equal(validateCallback('nope', now).ok, false);
  assert.equal(validateCallback(plus(-1), now).ok, false);
  assert.equal(validateCallback(now.toISOString(), now).ok, false);
});

test('accepts a future time, rejects beyond 30 days', () => {
  assert.equal(validateCallback(plus(2), now).ok, true);
  assert.equal(validateCallback(plus(24 * 31), now).ok, false);
});

test('future callback leaves the main queue; due callback returns', () => {
  assert.equal(isInMainQueue({ callback_at: plus(2) }, now), false);
  assert.equal(isInMainQueue({ callback_at: plus(-1) }, now), true);
  assert.equal(isInMainQueue({ callback_at: null }, now), true);
});

test('do-not-call leads never return to the queue', () => {
  assert.equal(isInMainQueue({ dnc: true, callback_at: null }, now), false);
  assert.equal(isInMainQueue({ dnc: true, callback_at: plus(-5) }, now), false);
});

test('badge: scheduled, due, none', () => {
  assert.equal(callbackBadge({ callback_at: plus(1) }, now), 'scheduled');
  assert.equal(callbackBadge({ callback_at: plus(-1) }, now), 'due');
  assert.equal(callbackBadge({}, now), null);
});
