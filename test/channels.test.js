const test = require('node:test');
const assert = require('node:assert');
const { shapeChannels, channelOf } = require('../lib/channels');

test('sheet actors map to the right channel', () => {
  assert.equal(channelOf('whatsapp'), 'whatsapp');
  assert.equal(channelOf('whatsapp_late'), 'whatsapp');
  assert.equal(channelOf('ivr_call'), 'ivr');
  assert.equal(channelOf('ivr_late'), 'ivr');
  assert.equal(channelOf('sheet'), 'sheet');
  assert.equal(channelOf('system'), 'other');
  assert.equal(channelOf(null), 'other');
});

test('each channel is counted on its own and the total is their sum', () => {
  const calls = [
    { role: 'aman', calls: 40, orders_called: 35, connected: 25, confirmed: 18, cancelled: 4, address_fix: 3, dnp: 15, callbacks: 2 },
    { role: 'agent', calls: 200, orders_called: 150, connected: 120, confirmed: 90, cancelled: 12, address_fix: 8, dnp: 80, callbacks: 5 },
  ];
  const events = [
    { actor: 'whatsapp', event_type: 'confirmed', n: 30 }, { actor: 'whatsapp_late', event_type: 'confirmed', n: 5 }, { actor: 'whatsapp', event_type: 'cancelled', n: 3 },
    { actor: 'ivr_call', event_type: 'confirmed', n: 20 }, { actor: 'ivr_call', event_type: 'cancelled', n: 2 }, { actor: 'ivr_call', event_type: 'rnr', n: 40 },
    { actor: 'sheet', event_type: 'confirmed', n: 1 }, { actor: 'system', event_type: 'cancelled', n: 6 },
  ];
  const c = shapeChannels(calls, events);
  assert.equal(c.aman.confirmed, 18);
  assert.equal(c.cc.calls, 200);
  assert.deepEqual(c.ivr, { results: 62, answered: 22, confirmed: 20, cancelled: 2, no_answer: 40 });
  assert.deepEqual(c.whatsapp, { replies: 38, confirmed: 35, cancelled: 3 });
  assert.equal(c.sheet.confirmed, 1);
  assert.equal(c.other.cancelled, 6);
  assert.equal(c.total.confirmed, 18 + 90 + 20 + 35 + 1);
  assert.equal(c.total.cancelled, 4 + 12 + 2 + 3 + 6);
});

test('Aman and call centre never mix, and no-answer from IVR is not a confirmation', () => {
  const c = shapeChannels([{ role: 'aman', calls: 5, confirmed: 2 }], [{ actor: 'ivr_call', event_type: 'rnr', n: 9 }]);
  assert.equal(c.cc.calls, 0);
  assert.equal(c.aman.confirmed, 2);
  assert.equal(c.total.confirmed, 2);
  assert.equal(c.ivr.no_answer, 9);
});

test('empty data gives zeros', () => {
  const c = shapeChannels([], []);
  assert.equal(c.total.confirmed, 0);
  assert.equal(c.ivr.results, 0);
});
