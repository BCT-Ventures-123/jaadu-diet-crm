const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../lib/pipeline');

test('end-to-end check: finds the step where a confirmed order stopped, per channel', () => {
  const samples = [
    { id: 'a', name: '#A', channel: 'ivr', tag_synced: true, shopify_id: 1 },        // fine everywhere
    { id: 'b', name: '#B', channel: 'ivr', tag_synced: false, shopify_id: 2 },       // no tag on Shopify
    { id: 'c', name: '#C', channel: 'wa', tag_synced: true, shopify_id: 3 },         // missing from the report and the logistics gate
    { id: 'd', name: '#D', channel: 'aman', tag_synced: false, shopify_id: 4 },      // tagged on Shopify itself
    { id: 'e', name: '#E', channel: 'sheet', tag_synced: true, shopify_id: 5 },
  ];
  const ctx = {
    reportIds: new Set(['a', 'b', 'd', 'e']), reportChannel: new Map([['a', 'ivr'], ['b', 'ivr'], ['d', 'aman'], ['e', 'sheet']]),
    attemptTeams: new Map([['a', new Set(['ivr'])], ['b', new Set(['ivr'])], ['c', new Set(['wa'])], ['d', new Set(['aman'])]]),
    gate: new Map([['a', 'ready'], ['b', 'blocked'], ['d', 'ready'], ['e', 'ready']]),
    tags: new Map([['2', 'cod'], ['4', 'cod, Confirmed']]),
  };
  const r = P.check(samples, ctx), by = Object.fromEntries(r.channels.map(c => [c.channel, c])), hop = (ch, h) => by[ch].hops.find(x => x.hop === h);
  assert.equal(r.ok, false);
  assert.deepEqual([hop('ivr', 'report').pass, hop('ivr', 'report').of], [2, 2]); assert.deepEqual([hop('ivr', 'shopify').pass, hop('ivr', 'shopify').of], [1, 2]); assert.deepEqual(hop('ivr', 'shopify').bad, ['#B']);
  assert.deepEqual(hop('wa', 'report').bad, ['#C']); assert.deepEqual(hop('wa', 'logistics').bad, ['#C']); assert.equal(hop('wa', 'attempt').pass, 1);
  assert.equal(hop('aman', 'shopify').pass, 1);                                                                          // the tag is on Shopify even though our flag was not set
  assert.equal(hop('sheet', 'attempt').of, 0);                                                                          // the old sheet leaves no attempt: that step is not asked
  assert.equal(by.cc.n, 0); assert.equal(by.cc.hops.length, 0);
});

test('end-to-end check: everything passes when every hop holds, and a channel credited wrongly fails the report step', () => {
  const samples = [{ id: 'a', name: '#A', channel: 'wa', tag_synced: true, shopify_id: 1 }];
  const ok = { reportIds: new Set(['a']), reportChannel: new Map([['a', 'wa']]), attemptTeams: new Map([['a', new Set(['wa'])]]), gate: new Map([['a', 'ready']]), tags: null };
  assert.equal(P.check(samples, ok).ok, true);
  const wrong = { ...ok, reportChannel: new Map([['a', 'cc']]) };
  assert.equal(P.check(samples, wrong).ok, false);
  assert.equal(P.channelOf('whatsapp', null), 'wa'); assert.equal(P.channelOf('Priya', 'agent'), 'cc'); assert.equal(P.hasTag('a, CONFIRMED'), true);
});
