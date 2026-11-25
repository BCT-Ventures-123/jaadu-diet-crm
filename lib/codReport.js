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

// Map(order id -> Date) of the first time the customer answered on ANY channel, from the ledger touches. Used by the Overview and the Daily by-date table so they use the same "connected" rule.
function connectedAtOf(touches) {
  const m = new Map();
  for (const [id, list] of touches) { const t = list.filter(x => x.connected).map(x => new Date(x.t).getTime()); if (t.length) m.set(id, new Date(Math.min(...t))); }
  return m;
}

function build(led, prepaidByDay = {}, { today } = {}) {
  const S = ledgerLib.summarize(led).total, T = S.leads;
  const prepaid = Object.values(prepaidByDay).reduce((s, n) => s + (Number(n) || 0), 0);
  const open = S.not_confirmed, notDone = S.cancelled + open;                          // everything that is not confirmed: refused, not reached, not tried
  const need = Math.max(0, Math.ceil(GOAL / 100 * T) - S.confirmed);
  const L = (label, count, hint, tone) => ({ label, count, pct: T ? pct(count, T) : null, base: 'of COD orders', hint: hint || '', tone: tone || '' });
  const other = (S.confirmed_by.sheet || 0) + (S.confirmed_by.other || 0);
  // How often the not-connected orders were tried (any channel: a call, an IVR call, a WhatsApp message): the redial discipline, on the same base as the lines above.
  const nc = led.filter(o => o.attempted && !o.connected), nc1 = nc.filter(o => o.attempts === 1).length, nc2 = nc.filter(o => o.attempts === 2).length, nc3 = nc.filter(o => o.attempts >= 3).length;
  const N = (label, count, hint) => ({ label, count, pct: pct(count, nc.length), base: 'of not connected', hint, tone: '', sub: true });
  const table = [
    { label: 'COD orders', count: T, pct: T ? 100 : null, base: 'the base of every percentage below · real COD tea orders placed in these dates', hint: '', tone: '' },
    { label: 'Prepaid orders (not counted)', count: prepaid, pct: null, base: '', hint: 'paid already and shipped directly: left out of every percentage on this page', tone: '' },
    L('Attempted (call, IVR or WhatsApp)', S.attempted, 'any channel tried the customer at least once'),
    L('Not attempted yet', S.not_attempted, S.waiting ? S.waiting + ' waiting for their first try' : ''),
    L('Connected (the customer answered)', S.connected, 'on any channel · ' + split(S.reached) + ' · address-fix counts as connected'),
    L('Not connected (tried, nobody answered)', S.tried_not_reached, 'no answer, switched off, not reachable · last tried by ' + split(S.tried_by)),
    N('Tried only once so far', nc1, 'the next try is still to be made'),
    N('Tried 2 times', nc2, 'any channel'),
    N('Tried 3 or more times', nc3, 'any channel'),
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

// The Funnel & leads numbers for a list of ledger orders, in the field names lib/funnel.js uses, so the page can show the SAME numbers as the Home and Daily report pages (COD base, every channel counted)
// instead of the older call-only counts. Only the order counts are replaced; the call-only facts (call timing, attempt-by-attempt call results) stay as they were.
function funnelFromLedger(list) {
  const T = list.length, b = ledgerLib.block(list), p = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
  const nc = list.filter(o => o.attempted && !o.connected), n2 = nc.filter(o => o.attempts >= 2).length, n3 = nc.filter(o => o.attempts >= 3).length;
  const noCall = (x) => (x.wa || 0) + (x.ivr || 0) + (x.sheet || 0) + (x.other || 0);
  const cwc = noCall(b.confirmed_by), xwc = noCall(b.cancelled_by);
  return { total_orders: T, total_for_pct: T, attempted: b.attempted, not_attempted: b.not_attempted, connected: b.connected, not_connected: b.tried_not_reached, confirmed: b.confirmed, cancelled: b.cancelled, pending: b.not_confirmed,
    total_attempts: list.reduce((s, o) => s + o.attempts, 0), confirmed_without_call: cwc, cancelled_without_call: xwc, other_closed: 0,
    nc_2nd: n2, nc_3rd: n3, nc_2nd_pending: nc.length - n2, nc_3rd_pending: nc.length - n3,
    attempted_pct: p(b.attempted, T), not_attempted_pct: p(b.not_attempted, T), connected_pct: p(b.connected, T), not_connected_pct: p(b.tried_not_reached, T), confirmed_pct: p(b.confirmed, T), cancelled_pct: p(b.cancelled, T), pending_pct: p(b.not_confirmed, T),
    confirmed_without_call_pct: p(cwc, T), cancelled_without_call_pct: p(xwc, T), nc_2nd_pct: p(n2, T), nc_3rd_pct: p(n3, T), nc_2nd_of_nc_pct: p(n2, nc.length), nc_3rd_of_nc_pct: p(n3, nc.length) };
}

// The by-day lines in the shape the Control Tower reads (lib/controlTower.js), so the tower uses the SAME numbers as the Daily report: COD base, every channel counted.
function asTowerDays(cod) {
  return (cod && cod.days ? cod.days : []).map(x => ({ day: x.day, is_today: x.is_today, total: x.cod + x.prepaid, prepaid: x.prepaid, cod: x.cod, needed_call: x.cod, attempted: x.attempted, not_attempted: x.not_attempted,
    connected: x.connected, confirmed_all: x.confirmed, pending: x.open, rejected: x.cancelled, attempted_pct: x.attempted_pct, connected_pct: x.connected_pct, confirmed_pct: x.confirmed_pct }));
}

module.exports = { build, connectedAtOf, asTowerDays, funnelFromLedger, GOAL };
