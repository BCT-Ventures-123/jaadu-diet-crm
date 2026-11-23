// THE ORDER LEDGER: one row per real COD tea order. Every number on the Home pages (Overall, Aman, Call centre, IVR, WhatsApp) is added up from THIS list, so the pages cannot disagree
// (owner, 2026-11-23). Pure functions, no database.
//
// rows:    [{ id, order_name, amount, team: 'InHouse'|'CC'|other, status: 'pending'|'confirmed'|'cancelled'|..., order_at: Date, decided_at: Date|null, actor, actor_role }]   (the Home cohort rows)
// touches: Map(order id -> [{ t: Date, team: 'aman'|'cc'|'ivr'|'wa', connected: boolean }])   every attempt on every channel
//
// Rules, each order gets exactly one answer to each question:
//   Whose lead      the team the order was given to: Aman or the call centre.
//   Attempted       any channel tried it (a call by Aman or the call centre, a real IVR call, a WhatsApp message or reply).
//   Reached by      the channel that FIRST reached the customer (spoke, pressed a key, replied). Nobody reached = no channel.
//   Credited to     reached_by; if nobody reached the customer, the channel that tried LAST; if nobody tried, nobody.
//   Result          confirmed, cancelled, or not confirmed (still pending, or closed some other way).
//   Decided by      the channel that made the confirm / cancel decision (Aman, call centre, IVR, WhatsApp, the sheet).
const IST = 19800000;
const CH = ['aman', 'cc', 'ivr', 'wa'];
const istDay = (d) => new Date(new Date(d).getTime() + IST).toISOString().slice(0, 10);
const istStamp = (d) => new Date(new Date(d).getTime() + IST).toISOString().slice(0, 16).replace('T', ' ');
const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
const zero4 = () => ({ aman: 0, cc: 0, ivr: 0, wa: 0 });

const WA_ACTORS = ['whatsapp', 'whatsapp_late'], IVR_ACTORS = ['ivr_call', 'ivr_late'];
function decidedBy(o) {
  const a = String(o.actor || '').toLowerCase();
  if (WA_ACTORS.includes(a)) return 'wa';
  if (IVR_ACTORS.includes(a)) return 'ivr';
  if (a === 'sheet') return 'sheet';
  if (o.actor_role === 'agent') return 'cc';
  if (o.actor_role === 'aman' || o.actor_role === 'admin') return 'aman';
  return 'other';
}

// How long a not-yet-attempted order has been waiting. A new order is not "late" in its first hour.
const WAIT_BUCKETS = ['lt1h', 'h1_6', 'h6_24', 'gt24'];
const waitBucket = (hours) => (hours < 1 ? 'lt1h' : hours < 6 ? 'h1_6' : hours < 24 ? 'h6_24' : 'gt24');

function buildLedger(rows, touches, now = new Date()) {
  return rows.map(o => {
    const ts = (touches.get(o.id) || []).map(x => ({ ...x, t: new Date(x.t) })).sort((a, b) => a.t - b.t);
    const tries = zero4(); ts.forEach(x => { if (tries[x.team] !== undefined) tries[x.team]++; });
    const first = ts.find(x => x.connected), last = ts.length ? ts[ts.length - 1] : null;
    const status = o.status === 'confirmed' || o.status === 'cancelled' ? o.status : 'not_confirmed';
    const ageHours = Math.max(0, (new Date(now) - new Date(o.order_at)) / 3600e3);
    return {
      id: o.id, order: o.order_name || '', day: o.day || istDay(o.order_at), placed_at: new Date(o.order_at), amount: Number(o.amount) || 0,
      team: o.team === 'InHouse' ? 'aman' : o.team === 'CC' ? 'cc' : 'other',
      status, raw_status: o.status, decided_at: o.decided_at ? new Date(o.decided_at) : null, decided_by: status === 'not_confirmed' ? null : decidedBy(o),
      tries, attempts: ts.length, attempted: ts.length > 0, connected: !!first, reached_by: first ? first.team : null, last_try_by: last ? last.team : null,
      credit: ts.length ? (first || last).team : null,
      age_hours: Math.round(ageHours * 10) / 10, wait_bucket: !ts.length && status === 'not_confirmed' ? waitBucket(ageHours) : null,
    };
  });
}

// One block of numbers for a group of orders (all, or one team's leads). Every row of the page is one of these fields.
function block(list) {
  const b = { leads: list.length, attempted: 0, connected: 0, tried_not_reached: 0, not_attempted: 0, waiting: 0, closed_without_attempt: 0,
    reached: zero4(), tried_by: zero4(), wait_age: { lt1h: 0, h1_6: 0, h6_24: 0, gt24: 0 },
    confirmed: 0, cancelled: 0, not_confirmed: 0, confirmed_by: { ...zero4(), sheet: 0, other: 0 }, cancelled_by: { ...zero4(), sheet: 0, other: 0 },
    own: { aman: { tried: 0, reached: 0, confirmed: 0, cancelled: 0 }, cc: { tried: 0, reached: 0, confirmed: 0, cancelled: 0 }, ivr: { tried: 0, reached: 0, confirmed: 0, cancelled: 0 }, wa: { tried: 0, reached: 0, confirmed: 0, cancelled: 0 } } };
  for (const o of list) {
    if (o.attempted) {
      b.attempted++;
      if (o.connected) { b.connected++; b.reached[o.reached_by]++; } else { b.tried_not_reached++; b.tried_by[o.last_try_by]++; }
    } else {
      b.not_attempted++;
      if (o.status === 'not_confirmed') { b.waiting++; b.wait_age[o.wait_bucket]++; } else b.closed_without_attempt++;
    }
    b[o.status]++;
    if (o.status === 'confirmed' || o.status === 'cancelled') { const k = o.decided_by in b.confirmed_by ? o.decided_by : 'other'; b[o.status + '_by'][k]++; }
    for (const c of CH) {
      if (o.tries[c] > 0) { b.own[c].tried++; if (o.reached_by === c) b.own[c].reached++; }
      if (o.decided_by === c) { if (o.status === 'confirmed') b.own[c].confirmed++; else if (o.status === 'cancelled') b.own[c].cancelled++; }
    }
  }
  return b;
}

function summarize(ledger) {
  const by = (t) => ledger.filter(o => o.team === t);
  return { total: block(ledger), teams: { aman: block(by('aman')), cc: block(by('cc')), other: block(by('other')) } };
}

// The same block for each order date (oldest first), for everyone (team = null) or for one team's leads.
function byDay(ledger, team = null) {
  const days = new Map();
  for (const o of ledger) { if (team && o.team !== team) continue; if (!days.has(o.day)) days.set(o.day, []); days.get(o.day).push(o); }
  return [...days.keys()].sort().map(day => ({ day, ...block(days.get(day)) }));
}

// Confirmation by order age: share of the orders old enough for each window that were confirmed in it, so a day is compared with other days at the SAME age
// (an order placed an hour ago cannot yet be "confirmed within 24 hours": it is left out of that column, not counted as a failure).
const WINDOWS = [['h2', 2], ['h24', 24], ['h48', 48]];
function byAge(ledger, now = new Date()) {
  const days = new Map();
  for (const o of ledger) {
    if (!days.has(o.day)) days.set(o.day, { day: o.day, orders: 0, ...Object.fromEntries(WINDOWS.flatMap(([k]) => [[k, 0], [k + '_of', 0]])), cancelled_h48: 0 });
    const d = days.get(o.day); d.orders++;
    for (const [k, h] of WINDOWS) {
      if (o.age_hours >= h || (o.decided_at && (o.decided_at - o.placed_at) / 3600e3 <= h)) {            // old enough, or already decided inside the window
        d[k + '_of']++;
        if (o.status === 'confirmed' && o.decided_at && (o.decided_at - o.placed_at) / 3600e3 <= h) d[k]++;
      }
    }
    if (o.status === 'cancelled' && o.decided_at && (o.decided_at - o.placed_at) / 3600e3 <= 48) d.cancelled_h48++;
  }
  return [...days.values()].sort((a, b) => (a.day < b.day ? -1 : 1)).map(d => ({ ...d, ...Object.fromEntries(WINDOWS.map(([k]) => [k + '_pct', pct(d[k], d[k + '_of'])])) }));
}

// The proof that the pages agree. Each check says what it compares and whether it holds. legacy = the older funnel engine's Overall numbers (lib/orderFunnel.js), when supplied.
function checks(summary, extra = {}) {
  const T = summary.total, out = [];
  const add = (name, ok, detail) => out.push({ name, ok: !!ok, detail });
  const sumTeams = (f) => ['aman', 'cc', 'other'].reduce((s, k) => s + f(summary.teams[k]), 0);
  add('Aman + call centre leads = all COD orders', sumTeams(b => b.leads) === T.leads, sumTeams(b => b.leads) + ' = ' + T.leads);
  add('Attempted + not attempted = all COD orders', T.attempted + T.not_attempted === T.leads, T.attempted + ' + ' + T.not_attempted + ' = ' + T.leads);
  add('Reached + tried but nobody answered = attempted', T.connected + T.tried_not_reached === T.attempted, T.connected + ' + ' + T.tried_not_reached + ' = ' + T.attempted);
  const reachedSum = CH.reduce((s, c) => s + T.reached[c], 0), triedSum = CH.reduce((s, c) => s + T.tried_by[c], 0);
  add('Aman + call centre + IVR + WhatsApp reached = connected', reachedSum === T.connected, reachedSum + ' = ' + T.connected);
  add('The four channels hold every tried order that nobody answered', triedSum === T.tried_not_reached, triedSum + ' = ' + T.tried_not_reached);
  add('Confirmed + cancelled + not confirmed = all COD orders', T.confirmed + T.cancelled + T.not_confirmed === T.leads, T.confirmed + ' + ' + T.cancelled + ' + ' + T.not_confirmed + ' = ' + T.leads);
  for (const k of ['aman', 'cc']) {
    const b = summary.teams[k];
    add((k === 'aman' ? 'Aman' : 'Call centre') + ': every lead is reached, tried, or not attempted', CH.reduce((s, c) => s + b.reached[c], 0) + b.tried_not_reached + b.not_attempted === b.leads, '');
  }
  const decided = CH.reduce((s, c) => s + T.confirmed_by[c], 0) + T.confirmed_by.sheet + T.confirmed_by.other;
  add('Confirmations by channel (with the sheet and other) = confirmed', decided === T.confirmed, decided + ' = ' + T.confirmed);
  const L = extra.legacy;
  if (L) {
    add('Home funnel agrees with the ledger: attempted', L.attempted === T.attempted, L.attempted + ' vs ' + T.attempted);
    add('Home funnel agrees with the ledger: connected', L.connected === T.connected, L.connected + ' vs ' + T.connected);
    add('Home funnel agrees with the ledger: confirmed', L.confirmed === T.confirmed, L.confirmed + ' vs ' + T.confirmed);
  }
  if (extra.sheet_rows != null) add('Backup sheet would hold the same orders', extra.sheet_rows === T.leads, extra.sheet_rows + ' in the sheet vs ' + T.leads + ' in the CRM');
  return { ok: out.every(c => c.ok), failed: out.filter(c => !c.ok).length, list: out };
}

// THE DEFINITIONS, in plain words, shown on the Home page and locked by a test. connected = the caller outcomes (lib/config.js CONNECTED_DISPOSITIONS) that mean the customer was on the line.
const DISP_NAME = { confirmed: 'confirmed', cancelled: 'cancelled', callback: 'asked for a callback', address_fix: 'address fixed', dnc: 'asked not to be called', escalated: 'escalated', dnp: 'no answer (DNP)', wrong_number: 'wrong number' };
function definitions(connectedDispositions, callDispositions) {
  const conn = connectedDispositions.map(d => DISP_NAME[d] || d).join(', ');
  const notConn = callDispositions.filter(d => !connectedDispositions.includes(d)).map(d => DISP_NAME[d] || d).join(', ');
  return [
    ['COD order', 'A real cash-on-delivery tea order: not a test order, not prepaid, at least Rs 350, and given to Aman or the call centre. Every percentage is a share of these orders.'],
    ['Attempt', 'One try to reach the customer on any channel: a call by Aman or the call centre with a result saved, a real IVR call, or a WhatsApp message. Opening a lead, a note or a payment link is not an attempt.'],
    ['Connected (reached)', 'The customer was on the line or answered. Caller results that count: ' + conn + '. IVR: the customer pressed a key. WhatsApp: the customer tapped a button or replied. A message that was only delivered or read is not a connection.'],
    ['Not connected', 'Attempted, but the customer was not reached: ' + notConn + ', an IVR call with no key pressed, a WhatsApp message with no reply.'],
    ['Not attempted', 'No attempt on any channel yet. A new order is not late in its first hour.'],
    ['Reached by / credited to', 'Each order is counted once. It goes to the channel that first reached the customer; if nobody reached the customer, to the channel that tried last; if nobody tried, to nobody.'],
    ['Confirmed / Cancelled', 'The order stands confirmed or cancelled in the CRM, whichever channel decided it. The decision goes to the channel that made it (Aman, call centre, IVR, WhatsApp, or the old sheet).'],
    ['Not confirmed', 'Everything else: still pending, no answer, or being worked. This is the number to bring down.'],
    ['Lead of Aman / of the call centre', 'The team the order was given to when it arrived (or handed over to). A lead that another channel reached stays in its team\'s row; the credit goes to the channel.'],
  ];
}

const CSV_HEAD = ['Order', 'Order date', 'Amount', 'Lead of', 'Result', 'Decided by', 'Decided at', 'Attempts Aman', 'Attempts Call centre', 'Attempts IVR', 'Attempts WhatsApp', 'Attempted', 'Reached the customer', 'Reached by', 'Last tried by', 'Credited to', 'Age (hours)', 'Waiting for a first attempt'];
const NAME = { aman: 'Aman', cc: 'Call centre', ivr: 'IVR', wa: 'WhatsApp', sheet: 'Sheet', other: 'Other', fresh: '' };
const RESULT = { confirmed: 'Confirmed', cancelled: 'Cancelled', not_confirmed: 'Not confirmed' };
const BUCKET = { lt1h: 'under 1 hour', h1_6: '1 to 6 hours', h6_24: '6 to 24 hours', gt24: 'over 24 hours' };
function csvRows(ledger) {
  return ledger.map(o => [o.order, istStamp(o.placed_at), o.amount, o.team === 'other' ? 'Neither' : NAME[o.team], RESULT[o.status], o.decided_by ? NAME[o.decided_by] : '', o.decided_at ? istStamp(o.decided_at) : '',
    o.tries.aman, o.tries.cc, o.tries.ivr, o.tries.wa, o.attempted ? 'Yes' : 'No', o.connected ? 'Yes' : 'No', o.reached_by ? NAME[o.reached_by] : '', o.last_try_by ? NAME[o.last_try_by] : '', o.credit ? NAME[o.credit] : '', o.age_hours, o.wait_bucket ? BUCKET[o.wait_bucket] : '']);
}

module.exports = { buildLedger, summarize, block, byDay, byAge, checks, csvRows, definitions, decidedBy, waitBucket, CSV_HEAD, WAIT_BUCKETS, istDay, pct };
