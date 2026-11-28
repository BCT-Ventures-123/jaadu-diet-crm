const test = require('node:test');
const assert = require('node:assert/strict');
const tl = require('../lib/teamLeave');

const SAT = '2026-11-28', SUN = '2026-11-29', MON = '2026-11-30', WED = '2026-12-02';

test('default week: Saturday the call centre is off, Sunday Aman is off, other days nobody', () => {
  const s = tl.settings({});
  assert.equal(tl.weekdayOf(SAT), 6); assert.equal(tl.weekdayOf(SUN), 0);
  assert.deepEqual(tl.resolve(SAT, null, s), { off: 'cc', source: 'weekly', weekly: 'cc' });
  assert.deepEqual(tl.resolve(SUN, null, s), { off: 'aman', source: 'weekly', weekly: 'aman' });
  assert.equal(tl.resolve(MON, null, s).off, 'none'); assert.equal(tl.resolve(WED, undefined, s).off, 'none');
});

test('a day chosen by hand wins over the weekly default, both ways', () => {
  const s = tl.settings({});
  assert.equal(tl.resolve(SAT, 'none', s).off, 'none');                    // the call centre works this Saturday
  assert.equal(tl.resolve(SAT, 'none', s).source, 'chosen');
  assert.equal(tl.resolve(WED, 'aman', s).off, 'aman');                    // Aman is ill on a Wednesday
  assert.equal(tl.resolve(SUN, 'cc', s).off, 'cc');
  assert.equal(tl.resolve(SAT, 'garbage', s).off, 'cc');                   // an unknown value is ignored: the weekly default applies
});

test('everything goes to the team that is working', () => {
  assert.equal(tl.receiver('cc'), 'InHouse'); assert.equal(tl.receiver('aman'), 'CC'); assert.equal(tl.receiver('none'), null);
  assert.match(tl.label('cc'), /Call centre on leave: all new leads go to Aman/); assert.match(tl.label('aman'), /Aman on leave: all new leads go to the call centre/); assert.equal(tl.label('none'), '');
});

test('settings: weekly list from the environment, "none", and the off switch', () => {
  assert.deepEqual(tl.settings({ TEAM_LEAVE_WEEKLY: ' "Sat:CC, Wed:aman" ' }).weekly, { 6: 'cc', 3: 'aman' });
  assert.deepEqual(tl.settings({ TEAM_LEAVE_WEEKLY: 'none' }).weekly, {});
  assert.deepEqual(tl.settings({ TEAM_LEAVE_WEEKLY: 'funday:cc,sat:robot' }).weekly, {});                      // nonsense is ignored
  const off = tl.settings({ TEAM_LEAVE: 'off' }); assert.equal(off.on, false);
  assert.equal(tl.resolve(SAT, 'aman', off).off, 'none');                                                        // switched off: nobody is ever off
});

test('the India date is used, not the server date', () => {
  assert.equal(tl.istDateKey(new Date('2026-11-27T19:00:00Z')), '2026-11-28');       // 12:30 AM Saturday in India
  assert.equal(tl.istDateKey(new Date('2026-11-28T18:29:00Z')), '2026-11-28');       // 11:59 PM Saturday in India
  assert.equal(tl.istDateKey(new Date('2026-11-28T18:30:00Z')), '2026-11-29');       // midnight: Sunday
});

const fakeDb = (h = {}) => { const log = []; const db = async (sql, p = []) => { log.push({ sql, p }); for (const [re, fn] of Object.entries(h)) if (new RegExp(re, 's').test(sql)) return fn(sql, p); return []; }; db.log = log; return db; };

test('database helpers: choose a day, go back to the default, reject a bad value', async () => {
  const db = fakeDb();
  assert.equal(await tl.setOverride(db, SAT, 'none', 'Aman'), 'none'); assert.match(db.log[0].sql, /INSERT INTO team_leave/); assert.deepEqual(db.log[0].p, [SAT, 'none', 'Aman']);
  assert.equal(await tl.setOverride(db, SAT, 'default', 'Aman'), null); assert.match(db.log[1].sql, /DELETE FROM team_leave/);
  await assert.rejects(() => tl.setOverride(db, SAT, 'both', 'Aman'));
  assert.equal(await tl.getOverride(fakeDb({ 'FROM team_leave': () => [{ off: 'aman' }] }), SUN), 'aman'); assert.equal(await tl.getOverride(fakeDb(), SUN), null);
});

test('today(): reads the choice for the India date; a database failure means nobody is off, never an error', async () => {
  const now = new Date('2026-11-28T06:00:00Z');                                                       // Saturday
  assert.equal((await tl.today(fakeDb(), now, {})).off, 'cc');                                        // nothing chosen: weekly default
  assert.equal((await tl.today(fakeDb({ 'FROM team_leave': () => [{ off: 'none' }] }), now, {})).off, 'none');
  const broken = async () => { throw new Error('db down'); };
  const t = await tl.today(broken, now, {}); assert.equal(t.off, 'none'); assert.equal(t.source, 'error');
});
