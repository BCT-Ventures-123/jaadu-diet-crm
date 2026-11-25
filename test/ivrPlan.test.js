const test = require('node:test');
const assert = require('node:assert');
const ivr = require('../lib/ivrPlan');

const s = ivr.settings({});
const at = (hhmm) => new Date('2026-11-19T' + hhmm + ':00+05:30');
const now = at('19:00');
const lead = (id, extra = {}) => ({ id, team: 'CC', placed_at: at('14:00'), callback_at: null, attempts: 0, dnp_attempts: 0, dnp_days: 0, today_attempts: 0, spoke: false, last_call_at: null, ...extra });
const ago = (days, hhmm = '12:00') => new Date(new Date('2026-11-19T' + hhmm + ':00+05:30').getTime() - days * 86400e3);

test('the IVR fixed windows are 7 to 9 AM and 6 to 10 PM, and the status says when it opens next', () => {
  assert.equal(ivr.windowStatus(at('06:59'), s).open, false);
  assert.equal(ivr.windowStatus(at('07:00'), s).open, true); assert.equal(ivr.windowStatus(at('08:59'), s).open, true);        // new orders placed overnight are called as the morning window opens
  assert.equal(ivr.windowStatus(at('09:00'), s).open, false);                                                                  // from 9 AM Aman and the call centre own the day
  const noon = ivr.windowStatus(at('12:00'), s);
  assert.equal(noon.open, false); assert.equal(noon.nextStartHour, 18); assert.equal(noon.tomorrow, false);
  assert.equal(ivr.windowStatus(at('17:59'), s).open, false); assert.equal(ivr.windowStatus(at('18:00'), s).open, true);
  assert.equal(ivr.windowStatus(at('21:59'), s).open, true); assert.equal(ivr.windowStatus(at('22:00'), s).open, false);
  const late = ivr.windowStatus(at('22:30'), s);
  assert.equal(late.open, false); assert.equal(late.nextStartHour, 7); assert.equal(late.tomorrow, true);
  assert.equal(ivr.windowStatus(at('19:00'), s).hoursLeft, 3);
  assert.equal(s.windows.length, 2);
});

test('a window can be changed in Railway, and a window that ends before it starts is off', () => {
  const on = ivr.settings({ IVR_MORNING_START: '6', IVR_MORNING_END: '9' });
  assert.equal(ivr.windowStatus(at('06:00'), on).open, true); assert.equal(ivr.windowStatus(at('08:59'), on).open, true);
  assert.equal(ivr.windowStatus(at('09:00'), on).open, false);
  assert.equal(ivr.windowStatus(at('23:30'), on).nextStartHour, 6);
  assert.equal(ivr.settings({ IVR_MORNING_START: '9', IVR_MORNING_END: '9' }).windows.length, 1);                                // the morning window switched off, the evening one stays
  assert.equal(ivr.settings({ IVR_MORNING_START: '9', IVR_MORNING_END: '9', IVR_EVENING_START: '20', IVR_EVENING_END: '20' }).windows.length, 0);       // both closed: no fixed window at all, the IVR then works only in the best hours
  assert.equal(ivr.settings({}).freshShare, 0.3); assert.equal(ivr.settings({ IVR_FRESH_SHARE: '0.5' }).freshShare, 0.5);
});

test('mode is off unless set, and a wrong value falls back to off', () => {
  assert.equal(ivr.settings({}).mode, 'off');
  assert.equal(ivr.settings({ IVR_MODE: 'ON' }).mode, 'on');
  assert.equal(ivr.settings({ IVR_MODE: 'yes please' }).mode, 'off');
});

test('a lead goes to a person, not the IVR, when someone spoke to it, a callback is promised, or a person called it in the last 3 hours', () => {
  assert.equal(ivr.blockedReason(lead('a', { spoke: true, attempts: 1 }), now, s), 'spoken_to');
  assert.equal(ivr.blockedReason(lead('b', { callback_at: at('21:00') }), now, s), 'callback');
  assert.equal(ivr.blockedReason(lead('c', { attempts: 1, last_call_at: at('17:00') }), now, s), 'person_called_recently');
  assert.equal(ivr.blockedReason(lead('d', { attempts: 1, last_call_at: at('15:00') }), now, s), null);
  assert.equal(ivr.blockedReason(lead('e', { attempts: 10, dnp_attempts: 10, dnp_days: 4 }), now, s), 'over_the_limit');
});

test('the IVR stops after its maximum tries and waits between tries (an older lead: 90 minutes)', () => {
  const old = lead('a', { placed_at: ago(10) });                                                                                   // placed 10 days ago: the normal rules
  assert.equal(ivr.blockedReason(old, now, s, { tries: 5, last_at: at('10:00') }), 'ivr_done');
  assert.equal(ivr.blockedReason(old, now, s, { tries: 4, last_at: at('10:00') }), null);                                         // the fifth try is still allowed
  assert.equal(ivr.blockedReason(old, now, s, { tries: 1, last_at: at('18:30') }), 'ivr_too_soon');
  assert.equal(ivr.blockedReason(old, now, s, { tries: 1, last_at: at('17:00') }), null);
});

test('goal 95 percent a day (owner 2026-11-25): a recent unconfirmed order may get TWO IVR calls a day, at least 4 hours apart; an older lead still one', () => {
  assert.equal(s.triesPerDayNew, 2); assert.equal(s.newDays, 3); assert.equal(s.newGapMinutes, 240);
  const recent = lead('r', { placed_at: ago(1) }), old = lead('o', { placed_at: ago(10) });
  assert.equal(ivr.blockedReason(recent, now, s, { tries: 1, tries_today: 1, last_at: at('10:00') }), null);                    // the morning call was 9 hours ago: the evening call may go
  assert.equal(ivr.blockedReason(recent, now, s, { tries: 1, tries_today: 1, last_at: at('16:00') }), 'ivr_too_soon');             // only 3 hours ago
  assert.equal(ivr.blockedReason(recent, now, s, { tries: 2, tries_today: 2, last_at: at('10:00') }), 'ivr_done_today');           // never a third call in a day
  assert.equal(ivr.blockedReason(old, now, s, { tries: 1, tries_today: 1, last_at: at('10:00') }), 'ivr_done_today');             // an older lead: one a day
  assert.equal(ivr.blockedReason(lead('x', { placed_at: ago(3, '20:00') }), now, s, { tries: 1, tries_today: 1, last_at: at('10:00') }), null);   // 2 days 23 h old: still new
  assert.equal(ivr.blockedReason(lead('y', { placed_at: ago(3, '18:00') }), now, s, { tries: 1, tries_today: 1, last_at: at('10:00') }), 'ivr_done_today');   // 3 days 1 h old: no longer new
  const off = ivr.settings({ IVR_TRIES_PER_DAY_NEW: '1' }); assert.equal(ivr.blockedReason(recent, now, off, { tries: 1, tries_today: 1, last_at: at('10:00') }), 'ivr_done_today');   // can be switched back in Railway
  assert.equal(ivr.blockedReason(recent, now, s, { tries: 5, tries_today: 0, last_at: ago(1) }), 'ivr_done');                       // five in total still holds
});

test('the list is grouped, ordered fresh first, then today, recent and backlog, never-called first, and each lead is listed once', () => {
  const leads = [
    lead('old-dnp', { placed_at: ago(12), attempts: 3, dnp_attempts: 3, dnp_days: 2, last_call_at: ago(2) }),
    lead('recent-never', { placed_at: ago(1) }),
    lead('today-dnp', { attempts: 1, dnp_attempts: 1, dnp_days: 1, last_call_at: at('11:00') }),
    lead('today-never', { placed_at: at('16:00') }),
    lead('old-never', { placed_at: ago(9) }),
    lead('spoken', { spoke: true, attempts: 1 }),
  ];
  const p = ivr.buildList({ now, leads });
  assert.deepEqual(p.ids, ['today-never', 'today-dnp', 'recent-never', 'old-never', 'old-dnp']);
  assert.equal(p.ready_total, 5);
  assert.equal(p.blocked.spoken_to, 1);
  assert.deepEqual(p.groups.map(g => g.group), ['fresh', 'today', 'recent', 'backlog']);
  assert.equal(p.groupById['old-dnp'], 'backlog/dnp');
  assert.equal(new Set(p.ids).size, p.ids.length);
});

test('the daily cap cuts the list and says how many were cut', () => {
  const leads = Array.from({ length: 7 }, (_, i) => lead('l' + i, { placed_at: new Date(at('14:00').getTime() - i * 60000) }));
  const p = ivr.buildList({ now, leads }, { ...s, dailyCap: 5 });
  assert.equal(p.in_list, 5); assert.equal(p.ready_total, 7); assert.equal(p.cut_by_cap, 2);
  assert.equal(p.ids[0], 'l6');   // all fresh: the one that has waited longest goes first
});


test('address check: a 6-digit pincode and a long enough address are needed, otherwise a person calls', () => {
  const good = { shipping_address1: 'House 12, Gali 3, Rampur Village', shipping_address2: 'Near Shiv Mandir', shipping_city: 'Patna', shipping_province: 'Bihar', shipping_zip: '800001' };
  assert.equal(ivr.addressProblem(good), null);
  assert.equal(ivr.addressProblem({ ...good, shipping_zip: '80001' }), 'no_pincode');
  assert.equal(ivr.addressProblem({ ...good, shipping_zip: '' }), 'no_pincode');
  assert.equal(ivr.addressProblem({ shipping_zip: '800001', shipping_address1: 'Rampur' }), 'short_address');
});

test('a lead whose customer already pressed a key is left to a person, and the daily cap defaults to 20 real calls', () => {
  assert.equal(ivr.blockedReason(lead('a'), now, s, { tries: 1, last_at: at('10:00'), answered: true }), 'ivr_answered');
  assert.equal(s.dailyCap, 20); assert.equal(s.perRun, 10);
});


test('fresh orders go first, the one waiting longest first, and orders the IVR already tried come after the untried ones', () => {
  const leads = [lead('old', { placed_at: new Date(now - 40 * 3600e3) }),                              // placed 40 h ago, never called: not fresh any more
    lead('f2', { placed_at: new Date(now - 2 * 3600e3) }), lead('f1', { placed_at: new Date(now - 5 * 3600e3) }),
    lead('f-tried', { placed_at: new Date(now - 9 * 3600e3) })];
  const p = ivr.buildList({ now, leads, ivrByLead: { 'f-tried': { tries: 1, last_at: at('10:00') } } });
  assert.deepEqual(p.ids, ['f1', 'f2', 'f-tried', 'old']);
  assert.deepEqual(p.kindById, { f1: 'fresh', f2: 'fresh', 'f-tried': 'retry', old: 'backlog' });
  assert.equal(p.groupById.f1, 'fresh/never');
});

test('a lead the IVR left to a person (risky or bad address) is not offered to the IVR again', () => {
  assert.equal(ivr.blockedReason(lead('a'), now, s, { tries: 0, skipped_recently: true }), 'left_to_person');
  assert.equal(s.freshHours, 18); assert.equal(s.nonFreshShare, 0.7); assert.equal(s.maxRisk, 'low');
});

test('an order the IVR service refused twice in a day is left to a person, so one bad number can never block the queue', () => {
  assert.equal(ivr.blockedReason(lead('a'), now, s, { tries: 0, fails_recent: 2 }), 'left_to_person');
  assert.equal(ivr.blockedReason(lead('a'), now, s, { tries: 0, fails_recent: 1 }), null);
});

test('one try per lead per day by default, five in total (five days), and a lead tried today waits for tomorrow', () => {
  assert.equal(s.triesPerDay, 1); assert.equal(s.maxTries, 5); assert.equal(s.smart, true);
  assert.equal(ivr.blockedReason(lead('a', { placed_at: ago(10) }), now, s, { tries: 1, tries_today: 1, last_at: at('10:00') }), 'ivr_done_today');
  assert.equal(ivr.blockedReason(lead('a', { placed_at: ago(10) }), now, s, { tries: 1, tries_today: 0, last_at: new Date(now - 26 * 3600e3) }), null);
});
