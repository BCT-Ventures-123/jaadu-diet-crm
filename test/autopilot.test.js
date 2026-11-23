const test = require('node:test');
const assert = require('node:assert');
const ap = require('../lib/autopilot');

const s = ap.settings({});
const at = (hhmm) => new Date(`2026-11-10T${hhmm}:00+05:30`);                // a Tuesday, India time
const agent = (team, seenMin = null, callMin = null, now = at('11:00')) => ({ team, last_seen_at: seenMin == null ? null : new Date(now - seenMin * 60000), last_call_at: callMin == null ? null : new Date(now - callMin * 60000) });
const lead = (id, team, hoursOld, extra = {}) => ({ id, team, placed_at: new Date(at('11:00') - hoursOld * 3600e3), attempts: 0, dnp_attempts: 0, dnp_days: 0, spoke: false, callback_at: null, ...extra });

test('default mode is dry: planning only, nothing moves until AUTOPILOT=on', () => {
  assert.equal(ap.settings({}).mode, 'dry');
  assert.equal(ap.settings({ AUTOPILOT: 'on' }).mode, 'on');
  assert.equal(ap.settings({ AUTOPILOT: 'nonsense' }).mode, 'dry');
});

test('presence: a recent "I am here" signal or a recent call counts', () => {
  const now = at('11:00');
  const p = ap.teamPresence([agent('cc', 2), agent('cc', 30, 40), agent('cc', 30, 10), agent('aman', null, null)], now, s);
  assert.deepEqual(p.cc, { active: 2, total: 3 });
  assert.deepEqual(p.aman, { active: 0, total: 1 });
});

test('new order: the configured split, but the working team covers an absent one', () => {
  const both = { cc: { active: 2 }, aman: { active: 1 } };
  assert.equal(ap.ownerFor(both, at('11:00'), s, 5).assigned_to, 'InHouse');          // inside Aman's 10% share
  assert.equal(ap.ownerFor(both, at('11:00'), s, 50).assigned_to, 'CC');
  assert.equal(ap.ownerFor({ cc: { active: 0 }, aman: { active: 1 } }, at('11:00'), s, 50).assigned_to, 'InHouse');
  assert.equal(ap.ownerFor({ cc: { active: 2 }, aman: { active: 0 } }, at('11:00'), s, 5).assigned_to, 'CC');
  assert.equal(ap.ownerFor({ cc: { active: 0 }, aman: { active: 1 } }, at('09:10'), s, 50).assigned_to, 'CC');   // inside the 30-minute grace period
  assert.equal(ap.ownerFor({ cc: { active: 0 }, aman: { active: 1 } }, at('22:00'), s, 50).assigned_to, 'CC');   // shift is over
  assert.equal(ap.ownerFor({ cc: { active: 0 }, aman: { active: 0 } }, at('11:00'), s, 50).assigned_to, 'CC');   // nobody: default owner
  assert.equal(ap.settings({ AMAN_NEW_COD_SHARE: '0' }).amanNewShare, 0);
});

test('absent team: the working team takes over its open leads', () => {
  const leads = [lead('a', 'CC', 3), lead('b', 'InHouse', 2)];
  const callCentreOff = ap.planMoves({ now: at('11:00'), presence: { cc: { active: 0 }, aman: { active: 1 } }, leads }, s);
  assert.deepEqual(callCentreOff.map(m => [m.id, m.to, m.reason]), [['a', 'InHouse', 'cover_absent']]);
  const amanOff = ap.planMoves({ now: at('11:00'), presence: { cc: { active: 1 }, aman: { active: 0 } }, leads }, s);
  assert.deepEqual(amanOff.map(m => [m.id, m.to, m.reason]), [['b', 'CC', 'cover_absent']]);
  assert.deepEqual(ap.planMoves({ now: at('11:00'), presence: { cc: { active: 0 }, aman: { active: 0 } }, leads }, s), []);
});

test('nothing moves outside the working window or inside the grace period', () => {
  const leads = [lead('a', 'CC', 3)];
  const presence = { cc: { active: 0 }, aman: { active: 1 } };
  assert.deepEqual(ap.planMoves({ now: at('09:10'), presence, leads }, s), []);
  assert.deepEqual(ap.planMoves({ now: at('21:00'), presence, leads }, s), []);
});

test('call centre failed: 4 unanswered tries over 2 days, or still not reached after 48 hours', () => {
  const both = { cc: { active: 2 }, aman: { active: 1 } };
  const leads = [
    lead('tries', 'CC', 30, { attempts: 4, dnp_attempts: 4, dnp_days: 2 }),
    lead('sameDay', 'CC', 5, { attempts: 5, dnp_attempts: 5, dnp_days: 1 }),       // many tries but all on one day: not yet
    lead('slow', 'CC', 50, { attempts: 1, dnp_attempts: 1, dnp_days: 1 }),
    lead('spoke', 'CC', 60, { attempts: 3, dnp_attempts: 2, dnp_days: 2, spoke: true }),
    lead('promised', 'CC', 60, { attempts: 4, dnp_attempts: 4, dnp_days: 2, callback_at: new Date(at('11:00').getTime() + 3600e3) }),
  ];
  const moves = ap.planMoves({ now: at('11:00'), presence: both, leads }, s);
  assert.deepEqual(moves.filter(m => m.reason === 'cc_failed').map(m => m.id).sort(), ['slow', 'tries']);
  assert.ok(!moves.some(m => ['sameDay', 'spoke', 'promised'].includes(m.id)));
});

test('never called for 24 hours is handed over, only when Aman is working', () => {
  const leads = [lead('old', 'CC', 26), lead('new', 'CC', 3)];
  const moves = ap.planMoves({ now: at('11:00'), presence: { cc: { active: 2 }, aman: { active: 1 } }, leads }, s);
  assert.deepEqual(moves.map(m => [m.id, m.reason]), [['old', 'overflow_uncalled']]);
  assert.deepEqual(ap.planMoves({ now: at('11:00'), presence: { cc: { active: 2 }, aman: { active: 0 } }, leads }, s), []);
});

test('2 PM target: when the call centre cannot make it, the oldest uncalled leads are handed over', () => {
  const presence = { cc: { active: 1 }, aman: { active: 1 } };
  const many = Array.from({ length: 60 }, (_, i) => lead('c' + i, 'CC', 2 + i / 100));            // all placed before 13:00, none called
  const p = ap.pace('CC', many, presence, 0, at('12:00'), s);
  assert.equal(p.uncalled, 60); assert.equal(p.capacity, 24);                                     // 1 agent x 12 per hour x 2 hours left
  assert.equal(p.deficit, 36); assert.equal(p.behind, true);
  const moves = ap.planMoves({ now: at('12:00'), presence, leads: many }, s);
  assert.equal(moves.length, 30);                                                                  // capped by the batch size
  assert.ok(moves.every(m => m.reason === 'deadline_overflow' && m.to === 'InHouse'));
  assert.equal(ap.pace('CC', many, presence, 0, at('10:00'), s).behind, false);                    // pushing starts at 11:00
  assert.equal(ap.pace('CC', many, presence, 0, at('14:30'), s).phase, 'after');
});

test('leads placed after the 1 PM cut-off are not part of the 2 PM target', () => {
  const late = { ...lead('late', 'CC', 0), placed_at: at('13:30') };
  const p = ap.pace('CC', [late], { cc: { active: 1 }, aman: { active: 1 } }, 0, at('13:40'), s);
  assert.equal(p.uncalled, 0);
});
