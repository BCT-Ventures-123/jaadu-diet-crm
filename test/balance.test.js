const test = require('node:test');
const assert = require('node:assert');
const { settings, inWindow, planMove } = require('../lib/balance');

const s = settings({});

test('defaults', () => {
  assert.equal(s.auto, false);                                       // off by default: the autopilot hands over failed leads instead
  assert.equal(s.minAman, 8);
  assert.equal(settings({ AUTO_BALANCE: 'on' }).auto, true);
  assert.equal(settings({ BALANCE_BATCH: '25' }).batch, 25);
});

test('automatic run only moves leads when Aman is nearly out', () => {
  assert.equal(planMove({ amanOpen: 20, ccMovable: 100 }, s), 0);
  assert.equal(planMove({ amanOpen: 3, ccMovable: 100 }, s), 15);        // one batch
  assert.equal(planMove({ amanOpen: 0, ccMovable: 20 }, s), 5);          // leaves 15 with the call centre
  assert.equal(planMove({ amanOpen: 0, ccMovable: 10 }, s), 0);          // call centre is not drained
});

test('a manual request is honoured up to what the call centre has', () => {
  assert.equal(planMove({ amanOpen: 50, ccMovable: 100 }, s, 20), 20);
  assert.equal(planMove({ amanOpen: 0, ccMovable: 6 }, s, 20), 6);
  assert.equal(planMove({ amanOpen: 0, ccMovable: 6 }, s, -3), 0);
});

test('working window is in India time and ends before the 2 PM cut-off', () => {
  assert.equal(inWindow(new Date('2026-10-13T04:00:00Z'), s), true);   // 09:30 IST
  assert.equal(inWindow(new Date('2026-10-13T03:00:00Z'), s), false);  // 08:30 IST
  assert.equal(inWindow(new Date('2026-10-13T08:15:00Z'), s), false);  // 13:45 IST
});
