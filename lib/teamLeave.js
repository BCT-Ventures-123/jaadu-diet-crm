// Team on leave (owner 2026-11-28): when the call centre or Aman is not working on a day, 100 percent of that day's new leads go to the other team.
// The default week: Saturday the call centre is off, Sunday Aman is off. The admin or Aman can change any single day (mark either team off, or mark nobody off) from the CRM.
//   TEAM_LEAVE_WEEKLY = "sat:cc,sun:aman"   (default; a day name and the team that is off: cc or aman; set it to "none" for no weekly default)
//   TEAM_LEAVE = off   switches the whole thing off (the old routing runs unchanged)
// Pure rules here; the database part is at the bottom. A failed read of the setting means "nobody is off", so a database problem never stops an order being routed.
const DAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const TEAM_NAME = { cc: 'Call centre', aman: 'Aman' };
const plain = (v) => String(v == null ? '' : v).trim().replace(/^["']+|["']+$/g, '').trim().toLowerCase();

function settings(env = process.env) {
  const on = plain(env.TEAM_LEAVE || 'on') !== 'off';
  const raw = plain(env.TEAM_LEAVE_WEEKLY === undefined ? 'sat:cc,sun:aman' : env.TEAM_LEAVE_WEEKLY), weekly = {};
  if (raw && raw !== 'none') for (const part of raw.split(',')) { const [d, t] = part.split(':').map(plain); if (DAYS[d.slice(0, 3)] !== undefined && TEAM_NAME[t]) weekly[DAYS[d.slice(0, 3)]] = t; }
  return { on, weekly };
}

const istDateKey = (now = new Date()) => new Date(new Date(now).getTime() + 19800000).toISOString().slice(0, 10);
const weekdayOf = (dateKey) => new Date(dateKey + 'T00:00:00Z').getUTCDay();

// override: 'cc' | 'aman' | 'none' (a person chose it for this day) or null / undefined (nothing chosen: the weekly default applies).
function resolve(dateKey, override, s = settings()) {
  if (!s.on) return { off: 'none', source: 'disabled', weekly: 'none' };
  const weekly = s.weekly[weekdayOf(dateKey)] || 'none';
  if (override === 'cc' || override === 'aman' || override === 'none') return { off: override, source: 'chosen', weekly };
  return { off: weekly, source: weekly === 'none' ? 'none' : 'weekly', weekly };
}

// Who gets every new lead while a team is off: the other team. null when nobody is off.
const receiver = (off) => (off === 'cc' ? 'InHouse' : off === 'aman' ? 'CC' : null);
const label = (off) => (off === 'cc' || off === 'aman' ? TEAM_NAME[off] + ' on leave: all new leads go to ' + (off === 'cc' ? 'Aman' : 'the call centre') : '');

// ---- database part
async function ensureTables(db) {
  await db(`CREATE TABLE IF NOT EXISTS team_leave (day DATE PRIMARY KEY, off TEXT NOT NULL CHECK (off IN ('cc', 'aman', 'none')), set_by TEXT, set_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
}
async function getOverride(db, dateKey) {
  const r = await db(`SELECT off FROM team_leave WHERE day = $1`, [dateKey]);
  return r[0] ? r[0].off : null;
}
// off: 'cc' | 'aman' | 'none' to choose, or 'default' to remove the choice and go back to the weekly default.
async function setOverride(db, dateKey, off, by) {
  if (off === 'default') { await db(`DELETE FROM team_leave WHERE day = $1`, [dateKey]); return null; }
  if (!['cc', 'aman', 'none'].includes(off)) throw new Error('off must be cc, aman, none or default');
  await db(`INSERT INTO team_leave (day, off, set_by, set_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (day) DO UPDATE SET off = EXCLUDED.off, set_by = EXCLUDED.set_by, set_at = NOW()`, [dateKey, off, String(by || '').slice(0, 80)]);
  return off;
}
// Today's state, read fresh. A failure returns "nobody off" and says so.
async function today(db, now = new Date(), env = process.env) {
  const s = settings(env), day = istDateKey(now);
  try { await ensureTables(db); return { day, ...resolve(day, await getOverride(db, day), s) }; }
  catch (e) { console.error('[TeamLeave] could not read today, nobody is marked off:', e.message); return { day, off: 'none', source: 'error', weekly: 'none', error: e.message }; }
}

module.exports = { settings, resolve, receiver, label, istDateKey, weekdayOf, ensureTables, getOverride, setOverride, today, TEAM_NAME };
