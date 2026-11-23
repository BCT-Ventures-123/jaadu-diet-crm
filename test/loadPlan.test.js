const test = require('node:test');
const assert = require('node:assert');
const lp = require('../lib/loadPlan');

const s = lp.settings({});
const now = new Date('2026-11-18T11:00:00+05:30');                       // a Wednesday, 9 hours left in the 9-to-20 shift
const mk = (id, team, extra = {}) => ({ id, team, placed_at: new Date(now - 5 * 3600e3), attempts: 0, today_attempts: 0, dnp_attempts: 0, dnp_days: 0, spoke: false, callback_at: null, ...extra });
const many = (n, team, extra = {}, from = 0) => Array.from({ length: n }, (_, i) => mk(`${team}${from + i}`, team, { placed_at: new Date(now - (i + 1) * 60e3 * 20), ...extra }));
const crew = (cc, aman) => [...Array.from({ length: cc }, () => ({ team: 'cc', last_seen_at: new Date(now - 60e3) })), ...Array.from({ length: aman }, () => ({ team: 'aman', last_seen_at: new Date(now - 60e3) }))];

test('expected calls: a high pickup chance costs fewer calls than the number of tries', () => {
  assert.equal(lp.expected(1, 0.5), 1);
  assert.equal(lp.expected(3, 0.5), 1.75);
  assert.equal(lp.expected(0, 0.5), 0);
  assert.ok(lp.expected(5, 0.25) > lp.expected(5, 0.55));
});

test('hours left in the shift', () => {
  assert.equal(lp.hoursLeft(now, s), 9);
  assert.equal(lp.hoursLeft(new Date('2026-11-18T07:00:00+05:30'), s), 11);   // before the shift: the whole shift
  assert.equal(lp.hoursLeft(new Date('2026-11-18T21:00:00+05:30'), s), 0);
});

test('plenty of time: the plan raises the goal from 3 tries to 5 per lead', () => {
  const p = lp.buildPlan({ now, leads: many(40, 'CC', { attempts: 1, dnp_attempts: 1, dnp_days: 1 }), agents: crew(5, 1) });
  assert.equal(p.teams.cc.tries_today, 5);
  assert.equal(p.teams.cc.status, 'ok');
  assert.equal(p.teams.cc.deficit, 0);
  assert.ok(p.teams.cc.spare > 0);
});

test('less time: the goal stays at 2 tries (the second call the same day), and a real shortfall turns red', () => {
  const tight = lp.buildPlan({ now, leads: many(600, 'CC', { attempts: 1, dnp_attempts: 1, dnp_days: 1 }), agents: crew(3, 0) });
  assert.equal(tight.teams.cc.tries_today, 2);
  assert.ok(tight.teams.cc.deficit > 0);
  assert.equal(tight.teams.cc.status, 'bad');
  assert.ok(tight.teams.cc.agents_needed > 3);
  const mid = lp.buildPlan({ now, leads: many(300, 'CC', { attempts: 1, dnp_attempts: 1, dnp_days: 1 }), agents: crew(3, 0) });
  assert.ok(mid.teams.cc.tries_today >= 2 && mid.teams.cc.tries_today <= 5);
});

test('tries already made today count: a lead that has had 3 tries needs nothing more at the minimum goal', () => {
  const done = mk('d', 'CC', { attempts: 3, today_attempts: 3, dnp_attempts: 3, dnp_days: 1 });
  assert.equal(lp.leadDemand(done, 3, now, s, { fresh: 0.55, retry: 0.25 }), 0);
  assert.ok(lp.leadDemand(done, 5, now, s, { fresh: 0.55, retry: 0.25 }) > 0);
});

test('leads that need no calls today: spoke already, callback promised later, over the limit', () => {
  const pick = { fresh: 0.55, retry: 0.25 };
  assert.equal(lp.leadDemand(mk('a', 'CC', { spoke: true, attempts: 1 }), 3, now, s, pick), 0);
  assert.equal(lp.leadDemand(mk('b', 'CC', { callback_at: new Date(now.getTime() + 3600e3), attempts: 1 }), 3, now, s, pick), 0);
  assert.equal(lp.leadDemand(mk('c', 'CC', { callback_at: new Date(now.getTime() - 3600e3), attempts: 1 }), 3, now, s, pick), 1);
  assert.equal(lp.leadDemand(mk('d', 'CC', { attempts: 9, dnp_attempts: 9, dnp_days: 3 }), 3, now, s, pick), 0);
});

test('over the limit: leads stop being redialled and appear in the review list', () => {
  const over = mk('over', 'CC', { attempts: 9, dnp_attempts: 9, dnp_days: 3 });
  const manyTriesOneDay = mk('x', 'CC', { attempts: 9, dnp_attempts: 9, dnp_days: 1 });
  const p = lp.buildPlan({ now, leads: [over, manyTriesOneDay, mk('n', 'CC')], agents: crew(2, 1) });
  assert.deepEqual(p.review, ['over']);
  assert.equal(p.teams.cc.review, 1);
  const row = p.backlog.find(r => r.key === 'review');
  assert.equal(row.cc, 1);
});

test('uneven load: leads move from the overloaded team to the team with spare time, fresh ones first', () => {
  const leads = [...many(500, 'CC'), ...many(10, 'InHouse')];
  const p = lp.buildPlan({ now, leads, agents: crew(2, 4) });
  assert.ok(p.teams.cc.deficit > 0);
  assert.ok(p.teams.aman.spare > 0);
  assert.ok(p.moves.length > 0);
  assert.ok(p.moves.every(m => m.from === 'CC' && m.to === 'InHouse' && m.reason === 'load_balance'));
  // the oldest fresh leads go first (they have waited longest)
  const ids = leads.filter(l => l.team === 'CC').sort((a, b) => a.placed_at - b.placed_at).slice(0, 3).map(l => l.id);
  assert.deepEqual(p.moves.slice(0, 3).map(m => m.id), ids);
  assert.match(p.teams.cc.advice, /Moving \d+ leads to Aman/);
  assert.match(p.teams.aman.advice, /leads can come over/);
});

test('no moves when both teams are short, when the other team has nobody, or when the shortfall is small', () => {
  assert.equal(lp.buildPlan({ now, leads: [...many(500, 'CC'), ...many(500, 'InHouse')], agents: crew(1, 1) }).moves.length, 0);
  assert.equal(lp.buildPlan({ now, leads: many(500, 'CC'), agents: crew(2, 0) }).moves.length, 0);
  assert.equal(lp.buildPlan({ now, leads: many(30, 'CC'), agents: crew(2, 2) }).moves.length, 0);
});

test('moves never include leads that should stay: callback promised, over the limit, or already spoken to', () => {
  const stay = [mk('cb', 'CC', { attempts: 1, callback_at: new Date(now.getTime() + 3600e3) }), mk('ov', 'CC', { attempts: 9, dnp_attempts: 9, dnp_days: 3 }), mk('sp', 'CC', { attempts: 1, spoke: true })];
  const p = lp.buildPlan({ now, leads: [...stay, ...many(500, 'CC')], agents: crew(2, 4) });
  const moved = new Set(p.moves.map(m => m.id));
  stay.forEach(l => assert.ok(!moved.has(l.id), l.id));
});

test('after the shift there are no moves and the advice says so', () => {
  const late = new Date('2026-11-18T21:00:00+05:30');
  const p = lp.buildPlan({ now: late, leads: many(500, 'CC'), agents: crew(1, 4).map(a => ({ ...a, last_seen_at: new Date(late - 60e3) })) });
  assert.equal(p.moves.length, 0);
  assert.match(p.teams.cc.advice, /shift is over/);
});

test('a team with nobody on it is reported, not hidden', () => {
  const p = lp.buildPlan({ now, leads: many(20, 'CC'), agents: crew(0, 1) });
  assert.equal(p.teams.cc.agents_on_team, 0);
  assert.match(p.teams.cc.advice, /Nobody from Call centre/);
});

test('measured rates replace the defaults', () => {
  const leads = many(200, 'CC', { attempts: 1, dnp_attempts: 1, dnp_days: 1 });
  const slow = lp.buildPlan({ now, leads, agents: crew(3, 0), rates: { cc: { perHour: 6, source: 'measured' } } });
  const fast = lp.buildPlan({ now, leads, agents: crew(3, 0), rates: { cc: { perHour: 30, source: 'measured' } } });
  assert.equal(slow.teams.cc.rate_source, 'measured');
  assert.ok(slow.teams.cc.capacity < fast.teams.cc.capacity);
  assert.ok(slow.teams.cc.deficit > fast.teams.cc.deficit);
});

test('backlog buckets count the open leads by how many unanswered tries they have had', () => {
  const leads = [mk('n', 'CC'), mk('a', 'CC', { attempts: 2, dnp_attempts: 2, dnp_days: 1 }), mk('b', 'InHouse', { attempts: 4, dnp_attempts: 4, dnp_days: 2 }), mk('c', 'CC', { attempts: 7, dnp_attempts: 7, dnp_days: 2 }), mk('s', 'CC', { attempts: 1, spoke: true })];
  const rows = Object.fromEntries(lp.backlog(leads, now, s).map(r => [r.key, r]));
  assert.equal(rows.never.cc, 1);
  assert.equal(rows.b12.cc, 1);
  assert.equal(rows.b35.aman, 1);
  assert.equal(rows.b68.cc, 1);
  assert.equal(Object.values(rows).reduce((t, r) => t + r.cc + r.aman, 0), 4);        // the lead already spoken to is not in the backlog
});

// ---- manual backlog split ----
const old = (id, team, extra = {}) => ({ ...mk(id, team, extra), placed_at: new Date(now - 3 * 86400e3 - Number(String(id).replace(/\D/g, '') || 0) * 60e3) });

test('split: moves the asked number from the call centre to Aman, never called first, then fewest tries, then longest waiting', () => {
  const leads = [old('CC1', 'CC', { attempts: 3, dnp_attempts: 3, dnp_days: 2 }), old('CC2', 'CC', { attempts: 1, dnp_attempts: 1, dnp_days: 1 }), old('CC3', 'CC'), old('CC4', 'CC'), old('CC5', 'CC', { attempts: 1, dnp_attempts: 1, dnp_days: 1 })];
  const r = lp.splitMoves({ now, leads, toAman: 3 });
  assert.equal(r.cc_to_aman, 3);
  assert.equal(r.aman_to_cc, 0);
  assert.deepEqual(r.moves.map(m => m.id), ['CC4', 'CC3', 'CC5']);          // never called (the one that waited longest first), then the fewest tries
  assert.ok(r.moves.every(m => m.from === 'CC' && m.to === 'InHouse' && m.reason === 'split_backlog'));
});

test('split: leaves callbacks, spoken-to leads, over-the-limit leads and today\'s new orders alone', () => {
  const leads = [old('CC1', 'CC', { callback_at: new Date(now.getTime() + 3600e3) }), old('CC2', 'CC', { spoke: true, attempts: 2 }), old('CC3', 'CC', { attempts: 10, dnp_attempts: 10, dnp_days: 4 }),
    mk('CC4', 'CC', { placed_at: new Date(now - 3600e3) }), old('CC5', 'CC')];
  const r = lp.splitMoves({ now, leads, toAman: 50 });
  assert.deepEqual(r.moves.map(m => m.id), ['CC5']);
  assert.equal(r.available.cc, 1);
});

test('split: both directions, the asked number is capped at what exists and at 500', () => {
  const leads = [...many(3, 'CC').map(l => ({ ...l, placed_at: new Date(now - 4 * 86400e3) })), ...many(2, 'InHouse').map(l => ({ ...l, placed_at: new Date(now - 4 * 86400e3) }))];
  const r = lp.splitMoves({ now, leads, toAman: 99, toCc: 1 });
  assert.equal(r.cc_to_aman, 3);
  assert.equal(r.aman_to_cc, 1);
  assert.ok(r.moves.some(m => m.from === 'InHouse' && m.to === 'CC'));
  assert.equal(lp.splitMoves({ now, leads, toAman: -5, toCc: 'abc' }).moves.length, 0);
  assert.equal(lp.SPLIT_MAX, 500);
});
