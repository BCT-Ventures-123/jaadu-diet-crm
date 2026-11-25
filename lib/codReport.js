// The "end to end" block of the Daily report, on the right base (owner 2026-11-25):
//   * the base of EVERY percentage is the COD orders (real COD tea orders: test orders and orders under the minimum price left out). Prepaid orders are never part of it: they ship directly, so they are shown as one separate line.
//   * every number comes from the order ledger (lib/ledger.js), the same list the Home pages add up, so all four channels count: callers (Aman, call centre), IVR and WhatsApp.
//   * Connected = the customer answered on ANY channel (spoke, pressed a key, replied); an address fix counts as connected AND confirmed. Not connected = tried, nobody ever answered (no answer, switched off, not reachable).
//   * Cancelled = the customer clearly refused. Goal: 95 percent confirmed; cancelled + not connected + not tried must stay inside 5 percent.
// Pure functions, no database. The ledger rows and the prepaid-by-day map are made by cc_routes.js.
const ledgerLib = require('./ledger');
const GOAL = 95;
const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
const CH = [['aman', 'Aman'], ['cc', 'Call centre'], ['ivr', 'IVR'], ['wa', 'WhatsApp']];
const split = (o, extra) => CH.map(([k, n]) => n + ' ' + (o[k] || 0)).join(' · ') + (extra ? extra : '');

function build(led, prepaidByDay = {}, { today } = {}) {
  const S = ledgerLib.summarize(led).total, T = S.leads;
  const prepaid = Object.values(prepaidByDay).reduce((s, n) => s + (Number(n) || 0), 0);
  const open = S.not_confirmed, notDone = S.cancelled + open;                          // everything that is not confirmed: refused, not reached, not tried
  const need = Math.max(0, Math.ceil(GOAL / 100 * T) - S.confirmed);
  const L = (label, count, hint, tone) => ({ label, count, pct: T ? pct(count, T) : null, base: 'of COD orders', hint: hint || '', tone: tone || '' });
  const other = (S.confirmed_by.sheet || 0) + (S.confirmed_by.other || 0);
  const table = [
    { label: 'COD orders', count: T, pct: T ? 100 : null, base: 'the base of every percentage below · real COD tea orders placed in these dates', hint: '', tone: '' },
    { label: 'Prepaid orders (not counted)', count: prepaid, pct: null, base: '', hint: 'paid already and shipped directly: left out of every percentage on this page', tone: '' },
    L('Attempted (call, IVR or WhatsApp)', S.attempted, 'any channel tried the customer at least once'),
    L('Not attempted yet', S.not_attempted, S.waiting ? S.waiting + ' waiting for their first try' : ''),
    L('Connected (the customer answered)', S.connected, 'on any channel · ' + split(S.reached) + ' · address-fix counts as connected'),
    L('Not connected (tried, nobody answered)', S.tried_not_reached, 'no answer, switched off, not reachable · last tried by ' + split(S.tried_by)),
    L('Cancelled (the customer refused)', S.cancelled, 'decided by ' + split(S.cancelled_by, S.cancelled_by.sheet || S.cancelled_by.other ? ' · other ' + ((S.cancelled_by.sheet || 0) + (S.cancelled_by.other || 0)) : '')),
    { ...L('TOTAL CONFIRMATION (all ways)', S.confirmed, 'the number to compare with the ' + GOAL + '% goal · address-fix counts as confirmed · ' + split(S.confirmed_by, other ? ' · other ' + other : ''), T && pct(S.confirmed, T) >= GOAL ? 'ok' : 'warn') },
    L('Still open (not connected + not tried yet)', open, 'no final answer yet · ' + S.tried_not_reached + ' not connected + ' + S.not_attempted + ' not tried', open ? 'warn' : ''),
    { ...L('Not confirmed in all (cancelled + open)', notDone, 'must stay inside ' + (100 - GOAL) + '%' + (need ? ' · ' + need + ' more orders must be confirmed to reach ' + GOAL + '%' : ' · the ' + GOAL + '% goal is reached'), T && pct(notDone, T) <= 100 - GOAL ? 'ok' : 'bad') },
  ];
  const line = (b, day, isToday) => ({ day, is_today: isToday, cod: b.leads, prepaid: Number(prepaidByDay[day]) || 0, attempted: b.attempted, attempted_pct: pct(b.attempted, b.leads), connected: b.connected, connected_pct: pct(b.connected, b.leads),
    not_connected: b.tried_not_reached, not_attempted: b.not_attempted, cancelled: b.cancelled, confirmed: b.confirmed, confirmed_pct: pct(b.confirmed, b.leads), open: b.not_confirmed, open_pct: pct(b.not_confirmed, b.leads) });
  const byDay = new Map(ledgerLib.byDay(led).map(d => [d.day, d]));
  const empty = ledgerLib.summarize([]).total;
  for (const day of Object.keys(prepaidByDay)) if (!byDay.has(day)) byDay.set(day, { day, ...empty });     // a day with only prepaid orders still shows
  const days = [...byDay.keys()].sort().map(day => line(byDay.get(day), day, day === today));
  return { base: 'COD', goal: GOAL, orders: T, prepaid, need_for_goal: need, table, days, totals: { ...line(S, 'Total', false), prepaid } };
}

module.exports = { build, GOAL };
