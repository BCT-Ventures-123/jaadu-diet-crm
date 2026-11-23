// The standard order funnel, one engine for every view of the Home report (Overall, Aman, Call centre, IVR). Pure: no database.
// Owner's definitions (2026-11-22):
//   Orders         COD tea orders placed in the dates (real orders: no test, no prepaid, no under-minimum price).
//   Attempted      any attempt on any channel: a call by Aman or the call centre, a real IVR call, or a WhatsApp message (or, before the WhatsApp bridge stores messages, a WhatsApp reply).
//   Connected      attempted AND the customer answered: spoke on a call, pressed a key on the IVR, or replied on WhatsApp.
//   Not connected  attempted, nobody picked up (yet).
//   Confirmed / Cancelled / Pending   where the order stands now, whoever or whatever decided it. A share of ALL orders.
//   First attempt  the first call or IVR call on the order: how many were picked up.
//   Not-connected orders: the 2nd and 3rd attempt, on the SAME DAY as the first attempt, on a LATER day, or not done yet.
// Every percentage is a share of the orders in the same scope and dates, so no row mixes bases.
// Views: Overall counts every channel together. The Aman, Call centre, IVR and WhatsApp views split the SAME orders by channel, each order counted under ONE channel (the one that first reached the customer,
// else the one that tried last), so the four views add up to Overall: attempted, connected and not connected. Confirmed / cancelled there are the orders THAT channel decided; orders decided by another channel
// or the sheet are closed_by_others, so each view adds up: confirmed + cancelled + closed by others + pending = orders.
//
// rows:    [{ id, team: 'CC'|'InHouse', status: 'pending'|'confirmed'|'cancelled'|..., day: 'YYYY-MM-DD' }]
// touches: Map(order id -> [{ t: Date, team: 'aman'|'cc'|'ivr'|'wa', connected: boolean }])
// row.actor / row.actor_role: who made the last confirm or cancel event (a person's name and role, or whatsapp / ivr_call / sheet).
const IST = 19800000;
const istDay = (d) => new Date(new Date(d).getTime() + IST).toISOString().slice(0, 10);
const istHour = (d) => new Date(new Date(d).getTime() + IST).getUTCHours();
const SHIP_PLACED_BEFORE = 13, LOCK_HOUR = 14;   // owner rule: an order confirmed before 2 PM ships the same day (2 to 4 PM packing, 4 PM courier pickup); orders placed before 1 PM can make it
const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);

const SCOPES = {
  overall: { label: 'All orders', owns: null, teams: ['aman', 'cc', 'ivr', 'wa'], channel: null },
  aman: { label: 'Aman', owns: null, teams: ['aman'], channel: 'aman', ladderOwns: ['InHouse'] },      // the attempt ladder of a team is read on ITS OWN leads
  cc: { label: 'Call centre', owns: null, teams: ['cc'], channel: 'cc', ladderOwns: ['CC'] },
  ivr: { label: 'IVR', owns: null, teams: ['ivr'], channel: 'ivr' },
  wa: { label: 'WhatsApp', owns: null, teams: ['wa'], channel: 'wa' },
};
// Which channel made the decision on an order.
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

// WHO GETS THE CREDIT FOR AN ORDER (channel views). One order is counted under ONE channel only, so the Aman, Call centre, IVR and WhatsApp views add up to the Overall report:
//   the channel that first reached the customer; if nobody answered, the channel that tried last; if nobody tried, no channel (it is "not attempted", shown in Overall).
function attribution(all) {
  if (!all.length) return null;
  const first = all.find(x => x.connected);
  return { channel: (first || all[all.length - 1]).team, connected: !!first };
}

// channel = null: the Overall report, every channel together. channel = 'aman' | 'cc' | 'ivr' | 'wa': that channel's share of the SAME orders (all of them), credited as above.
// Confirmed / cancelled in a channel view are the orders THAT channel decided; orders decided by another channel (or the sheet) are closed_by_others, so confirmed + cancelled + closed_by_others + pending = orders.
function counts(rows, touches, teams, channel = null) {
  const c = { orders: 0, closed_by_others: 0, attempted_by_others: 0, attempted: 0, not_attempted: 0, closed_without_attempt: 0, waiting_for_first_attempt: 0, connected: 0, not_connected: 0,
    confirmed: 0, cancelled: 0, pending: 0, other_closed: 0, first_connected: 0, first_not_connected: 0,
    nc_orders: 0, second_same_day: 0, second_later_day: 0, second_not_yet: 0, third_same_day: 0, third_later_day: 0, third_not_yet: 0,
    ship_pool: 0, same_day_confirmed: 0, pool_confirmed_late: 0, pool_not_confirmed: 0 };
  for (const o of rows) {
    const all = (touches.get(o.id) || []).slice().sort((a, b) => new Date(a.t) - new Date(b.t));
    const ts = channel ? all.filter(x => x.team === channel) : all.filter(x => teams.includes(x.team));
    c.orders++;
    if (o.order_at && istHour(o.order_at) < SHIP_PLACED_BEFORE) {                       // same-day shipping: placed before 1 PM, confirmed before the 2 PM lock
      c.ship_pool++;
      if (o.status === 'confirmed' && o.decided_at && istDay(o.decided_at) === istDay(o.order_at) && istHour(o.decided_at) < LOCK_HOUR) c.same_day_confirmed++;
      else if (o.status === 'confirmed') c.pool_confirmed_late++; else c.pool_not_confirmed++;
    }
    if (o.status === 'pending') c.pending++;
    else if (o.status === 'confirmed' || o.status === 'cancelled') {
      if (channel && decidedBy(o) !== channel) c.closed_by_others++;      // another channel decided this order: not this view's number
      else if (o.status === 'confirmed') c.confirmed++; else c.cancelled++;
    } else c.other_closed++;
    if (!all.length) {                                                                  // nobody on any channel has tried it
      c.not_attempted++;
      if (o.status === 'pending') c.waiting_for_first_attempt++; else c.closed_without_attempt++;
      continue;
    }
    if (channel) { const a = attribution(all); if (!a || a.channel !== channel) continue; }   // another channel gets the credit for this order
    c.attempted++;
    if (ts[0] && ts[0].connected) c.first_connected++; else c.first_not_connected++;
    if (channel ? attribution(all).connected : ts.some(x => x.connected)) { c.connected++; continue; }
    c.not_connected++; c.nc_orders++;
    const day1 = istDay(ts[0].t);
    if (ts.length >= 2) { if (istDay(ts[1].t) === day1) c.second_same_day++; else c.second_later_day++; } else c.second_not_yet++;
    if (ts.length >= 3) { if (istDay(ts[2].t) === day1) c.third_same_day++; else c.third_later_day++; } else c.third_not_yet++;
  }
  return c;
}
// LEADS BY ATTEMPT NUMBER (owner 2026-11-23: report leads, not calls). Of the orders in these dates: how many had a 1st attempt, a 2nd, a 3rd ... by the given channels, and on which attempt the customer was first reached.
// Every number is a count of ORDERS. connected_so_far is a share of the orders that were tried at all; leads is a share of all the orders.
function ladder(rows, touches, teams, maxK = 5) {
  const reached = new Array(maxK + 1).fill(0), connectedAt = new Array(maxK + 1).fill(0);
  let tried = 0, connectedEver = 0, beyond = 0;
  for (const o of rows) {
    const ts = (touches.get(o.id) || []).filter(x => teams.includes(x.team)).sort((a, b) => new Date(a.t) - new Date(b.t));
    if (!ts.length) continue;
    tried++;
    for (let k = 1; k <= Math.min(ts.length, maxK); k++) reached[k]++;
    if (ts.length > maxK) beyond++;
    const i = ts.findIndex(x => x.connected);
    if (i >= 0) { connectedEver++; if (i < maxK) connectedAt[i + 1]++; }
  }
  let cum = 0;
  const out = [];
  for (let k = 1; k <= maxK; k++) {
    cum += connectedAt[k];
    out.push({ attempt: k, leads: reached[k], leads_pct: pct(reached[k], rows.length), connected_here: connectedAt[k], connected_here_pct: pct(connectedAt[k], reached[k]), connected_so_far: cum, connected_so_far_pct: pct(cum, tried), not_connected_after: tried - cum });
  }
  return { orders: rows.length, tried, tried_pct: pct(tried, rows.length), connected: connectedEver, connected_pct: pct(connectedEver, tried), more_than_max: beyond, max: maxK, rows: out };
}

function withPct(c) {
  const n = c.orders;
  return { ...c,
    attempted_pct: pct(c.attempted, n), not_attempted_pct: pct(c.not_attempted, n), connected_pct: pct(c.connected, n), not_connected_pct: pct(c.not_connected, n),
    confirmed_pct: pct(c.confirmed, n), cancelled_pct: pct(c.cancelled, n), pending_pct: pct(c.pending, n), closed_by_others_pct: pct(c.closed_by_others, n), attempted_by_others_pct: pct(c.attempted_by_others, n),
    same_day_confirmed_pct: pct(c.same_day_confirmed, c.ship_pool), pool_confirmed_late_pct: pct(c.pool_confirmed_late, c.ship_pool), pool_not_confirmed_pct: pct(c.pool_not_confirmed, c.ship_pool),
    connected_of_attempted_pct: pct(c.connected, c.attempted), first_connected_pct: pct(c.first_connected, c.attempted), first_not_connected_pct: pct(c.first_not_connected, c.attempted) };
}

function build(rows, touches, scopeKey) {
  const S = SCOPES[scopeKey];
  const mine = S.owns ? rows.filter(o => S.owns.includes(o.team)) : rows;
  const total = withPct(counts(mine, touches, S.teams, S.channel));
  const by = new Map();
  for (const o of mine) { if (!by.has(o.day)) by.set(o.day, []); by.get(o.day).push(o); }
  const days = [...by.keys()].sort().map(day => ({ day, ...withPct(counts(by.get(day), touches, S.teams, S.channel)) }));
  return { key: scopeKey, label: S.label, ...total, ladder: ladder(S.ladderOwns ? mine.filter(o => S.ladderOwns.includes(o.team)) : mine, touches, S.teams), days };
}

// WHERE THE OVERALL NUMBERS SIT. Two partitions of the same orders, each adding up exactly to the Overall report:
//   by_owner  every order belongs to one team (Aman or the call centre): its orders, attempted (any channel), connected, not connected, not attempted.
//   reach     every order lands in exactly ONE row: connected by Aman / the call centre / the IVR / WhatsApp (the channel that first reached the customer), attempted but nobody answered, or not attempted.
function breakdown(rows, touches) {
  const blank = () => ({ orders: 0, attempted: 0, connected: 0, not_connected: 0, not_attempted: 0 });
  const owner = { aman: blank(), cc: blank(), other: blank() }, total = blank();
  const reach = { aman: 0, cc: 0, ivr: 0, wa: 0, not_connected: 0, not_attempted: 0 };
  for (const o of rows) {
    const ts = (touches.get(o.id) || []).slice().sort((a, b) => new Date(a.t) - new Date(b.t));
    const k = o.team === 'InHouse' ? 'aman' : o.team === 'CC' ? 'cc' : 'other';
    for (const b of [owner[k], total]) { b.orders++; if (!ts.length) b.not_attempted++; else { b.attempted++; if (ts.some(x => x.connected)) b.connected++; else b.not_connected++; } }
    if (!ts.length) reach.not_attempted++;
    else { const first = ts.find(x => x.connected); if (first && reach[first.team] !== undefined) reach[first.team]++; else reach.not_connected++; }
  }
  const pcts = (b) => ({ ...b, attempted_pct: pct(b.attempted, b.orders), connected_pct: pct(b.connected, b.orders), not_connected_pct: pct(b.not_connected, b.orders), not_attempted_pct: pct(b.not_attempted, b.orders) });
  const n = total.orders, connected = reach.aman + reach.cc + reach.ivr + reach.wa;
  return { by_owner: { aman: pcts(owner.aman), cc: pcts(owner.cc), other: pcts(owner.other) }, total: pcts(total),
    reach: { ...reach, connected, orders: n, aman_pct: pct(reach.aman, n), cc_pct: pct(reach.cc, n), ivr_pct: pct(reach.ivr, n), wa_pct: pct(reach.wa, n), connected_pct: pct(connected, n), not_connected_pct: pct(reach.not_connected, n), not_attempted_pct: pct(reach.not_attempted, n) } };
}

function buildAll(rows, touches) {
  const out = {};
  for (const k of Object.keys(SCOPES)) out[k] = build(rows, touches, k);
  out.breakdown = breakdown(rows, touches);
  return out;
}

module.exports = { build, buildAll, breakdown, ladder, counts, attribution, withPct, decidedBy, SCOPES, istDay, pct };
