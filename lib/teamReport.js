// Team performance: four separate measures for the owner. Pure (no database): the endpoint loads the rows and this turns them into
//   1. Aman (in-house caller)   2. Call centre   3. Both callers together   4. All channels together (WhatsApp, IVR, Aman, call centre)
//
// How a COD order moves (owner, 2026-11-17): Aman and the call centre confirm by calling; every COD order also gets a WhatsApp message and
// the customer can confirm there; from 6 PM the IVR calls the orders when both callers are unavailable or no WhatsApp reply has come.
//
// Inputs
//   rows:     one per COD order placed in the dates { id, team: 'CC'|'InHouse', status, day, order_at, actor, actor_role }
//   callsMap: Map(order id -> [{ d: disposition, t: Date, team: 'aman'|'cc', agent }]) every call on those orders, oldest first
//   activity: { agents:[...], teams:[...], all:{...}, days:[...] } calls made in the dates, on any order, from the call log
const cfg = require('./config');
const { WA, IVR } = require('./channels');

const CONNECTED = new Set(cfg.CONNECTED_DISPOSITIONS);
const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
const num = (v) => Number(v) || 0;
const IST = 19800000;

// Targets used to colour the numbers. They are the owner's rules where the owner gave one, and sensible defaults otherwise (marked).
const TARGETS = {
  attempted: { ok: 100, warn: 95 },            // every COD order that needs a call gets a first call (owner: 100%)
  first_call_on_time: { ok: 90, warn: 75 },    // every new order gets its first call within 1 hour (owner rule, 2026-11-22), 90% is a default
  redial: { ok: 85, warn: 70 },                // not-connected orders older than a day called again (owner: keep calling until confirmed)
  confirmed_of_leads: { ok: 65, warn: 50 },    // default
  ontime_cutoff_hour: 17, first_call_minutes: 60, shift_start_hour: 9, ontime_deadline_hour: 14, ivr_from_hour: 18,   // orders placed before 5 PM are due within 60 minutes (of the order, or of 9 AM for an earlier one)
};
const tone = (v, t) => (v == null ? '' : v >= t.ok ? 'ok' : v >= t.warn ? 'warn' : 'bad');

const istHour = (d) => new Date(new Date(d).getTime() + IST).getUTCHours();
const istDay = (d) => new Date(new Date(d).getTime() + IST).toISOString().slice(0, 10);
// When the first call of an order is due: 60 minutes after the order, or after the shift opens at 9 AM if the order came earlier.
const dueFirstCall = (placed) => Math.max(new Date(placed).getTime(), new Date(istDay(placed) + 'T' + String(TARGETS.shift_start_hour).padStart(2, '0') + ':00:00+05:30').getTime()) + TARGETS.first_call_minutes * 60000;
const median = (a) => { const v = a.filter(x => x != null && x >= 0).sort((x, y) => x - y); return v.length ? v[Math.floor((v.length - 1) / 2)] : null; };

const SCOPES = {
  aman: { label: 'Aman (in-house caller)', owns: ['InHouse'], callTeams: ['aman'], roles: ['aman', 'admin'] },
  cc: { label: 'Call centre', owns: ['CC'], callTeams: ['cc'], roles: ['agent'] },
  callers: { label: 'Both callers together (Aman + call centre)', owns: ['InHouse', 'CC'], callTeams: ['aman', 'cc'], roles: ['aman', 'admin', 'agent'] },
};

// One caller scope: the leads it owns, what it did on them, and what its people did in the dates.
function scopeCard(key, rows, callsMap, activity, now) {
  const S = SCOPES[key];
  const leads = rows.filter(o => S.owns.includes(o.team));
  const c = { leads: leads.length, closed_without_call: 0, needed: 0, attempted: 0, called_by_other_team_only: 0, not_called: 0, calls: 0,
    connected: 0, not_connected: 0, shipped: 0, rto: 0, confirmed_any: 0, cancelled_any: 0, nc_old: 0, nc_old_redialed: 0, nc_2nd: 0, nc_3rd: 0, confirmed_by: 0, rejected_by: 0, pending: 0, on_time_base: 0, on_time: 0 };
  const firstMins = [];
  const byDay = new Map();
  for (const o of leads) {
    const all = callsMap.get(o.id) || [];
    const mine = all.filter(x => S.callTeams.includes(x.team));
    if (o.shipped) c.shipped++; if (o.rto) c.rto++; if (o.status === 'confirmed') c.confirmed_any++; else if (o.status === 'cancelled') c.cancelled_any++;
    const closedNoCall = o.status !== 'pending' && all.length === 0;
    const d = byDay.get(o.day) || { day: o.day, leads: 0, needed: 0, attempted: 0, connected: 0, confirmed_by: 0, not_called: 0 };
    byDay.set(o.day, d);
    d.leads++; c.closed_without_call += closedNoCall ? 1 : 0;
    if (closedNoCall) continue;
    c.needed++; d.needed++;
    const placed = new Date(o.order_at);
    const onTimeEligible = istHour(placed) < TARGETS.ontime_cutoff_hour;
    if (mine.length) {
      c.attempted++; d.attempted++;
      c.calls += mine.length;
      firstMins.push((mine[0].t - placed) / 60000);
      if (onTimeEligible) { c.on_time_base++; if (new Date(mine[0].t).getTime() <= dueFirstCall(placed)) c.on_time++; }
      const spoke = mine.some(x => CONNECTED.has(x.d));
      if (spoke) { c.connected++; d.connected++; }
      else {
        c.not_connected++;
        if (mine.length >= 2) c.nc_2nd++;
        if (mine.length >= 3) c.nc_3rd++;
        if (now - placed > 86400000) { c.nc_old++; if (mine.length >= 2) c.nc_old_redialed++; }
      }
      if (o.status === 'confirmed' && S.roles.includes(o.actor_role)) { c.confirmed_by++; d.confirmed_by++; }
      else if (o.status === 'cancelled' && spoke && S.roles.includes(o.actor_role)) c.rejected_by++;
    } else if (all.length) { c.called_by_other_team_only++; if (onTimeEligible) c.on_time_base++; }
    else { c.not_called++; d.not_called++; if (onTimeEligible) c.on_time_base++; }
    if (o.status === 'pending') c.pending++;
  }

  // What the people did in the dates (calls made, on any order).
  const team = key === 'callers' ? activity.all : (activity.teams || []).find(t => t.team === S.callTeams[0]) || {};
  const people = (activity.agents || []).filter(a => S.callTeams.includes(a.team)).map(a => ({
    name: a.agent, team: a.team, calls: num(a.calls), orders_dialled: num(a.orders_dialled), picked: num(a.picked), dnp: num(a.dnp), confirmed: num(a.confirmed), cancelled: num(a.cancelled),
    callbacks: num(a.callbacks), address_fix: num(a.address_fix), wrong: num(a.wrong), active_days: num(a.active_days),
    picked_pct: pct(num(a.picked), num(a.calls)), dnp_pct: pct(num(a.dnp), num(a.calls)), cancel_of_spoke_pct: pct(num(a.cancelled), num(a.confirmed) + num(a.cancelled)),
    calls_per_day: num(a.active_days) ? Math.round((num(a.calls) / num(a.active_days)) * 10) / 10 : null,
  })).sort((x, y) => y.calls - x.calls);
  const act = {
    calls: num(team.calls), orders_dialled: num(team.orders_dialled), picked: num(team.picked), dnp: num(team.dnp), confirmed: num(team.confirmed), cancelled: num(team.cancelled),
    callbacks: num(team.callbacks), address_fix: num(team.address_fix), wrong: num(team.wrong), active_days: num(team.active_days), people: people.length,
  };
  act.picked_pct = pct(act.picked, act.calls); act.calls_per_active_day = act.active_days ? Math.round((act.calls / act.active_days) * 10) / 10 : null;
  act.calls_per_person_day = people.length && act.active_days ? Math.round((act.calls / (act.active_days * people.length)) * 10) / 10 : null;

  const attemptedPct = pct(c.attempted, c.needed), onTimePct = pct(c.on_time, c.on_time_base), redialPct = pct(c.nc_old_redialed, c.nc_old);
  const m = {
    ...c, attempted_pct: attemptedPct, not_called_pct: pct(c.not_called, c.needed), connected_pct_of_attempted: pct(c.connected, c.attempted), connected_pct_of_leads: pct(c.connected, c.leads),
    not_connected_pct: pct(c.not_connected, c.attempted), nc_2nd_pct: pct(c.nc_2nd, c.not_connected), nc_3rd_pct: pct(c.nc_3rd, c.not_connected),
    redial_pct: redialPct, on_time_pct: onTimePct, median_first_call_min: median(firstMins), calls_per_attempted_lead: c.attempted ? Math.round((c.calls / c.attempted) * 100) / 100 : null,
    confirmed_any_pct: pct(c.confirmed_any, c.leads), cancelled_any_pct: pct(c.cancelled_any, c.leads), shipped_pct_of_confirmed: pct(c.shipped, c.confirmed_any), rto_pct_of_shipped: pct(c.rto, c.shipped), not_reached_pct: pct(c.not_connected, c.leads),
    confirmed_by_pct: pct(c.confirmed_by, c.leads), rejected_by_pct: pct(c.rejected_by, c.leads), conversion_pct: pct(c.confirmed_by, c.connected), pending_pct: pct(c.pending, c.leads),
    // One ladder, one base: every step below is a share of the leads that NEEDED a call (leads minus those closed before any call), so Called, Picked up, Confirmed and Not called read on the same scale.
    connected_pct_of_needed: pct(c.connected, c.needed), confirmed_by_pct_of_needed: pct(c.confirmed_by, c.needed), not_connected_pct_of_needed: pct(c.not_connected, c.needed),
  };
  const kpis = [
    { key: 'coverage', label: 'Leads called at least once', value: attemptedPct, unit: '%', target: '100%', tone: tone(attemptedPct, TARGETS.attempted), caption: c.attempted + ' of ' + c.needed + ' leads that needed a call' },
    { key: 'on_time', label: 'First call within 1 hour', value: onTimePct, unit: '%', target: '90%', tone: tone(onTimePct, TARGETS.first_call_on_time), caption: 'orders placed before 5 PM, first call within 1 hour of the order, or of 9 AM (' + c.on_time + ' of ' + c.on_time_base + ')' },
    { key: 'reach', label: 'Customers reached', value: m.connected_pct_of_attempted, unit: '%', target: '', tone: '', caption: c.connected + ' of ' + c.attempted + ' called leads, someone spoke' },
    { key: 'redial', label: 'Redial discipline', value: redialPct, unit: '%', target: '85%', tone: tone(redialPct, TARGETS.redial), caption: c.nc_old_redialed + ' of ' + c.nc_old + ' not-reached leads older than a day were called again' },
    { key: 'confirmed', label: 'Confirmed by this team', value: m.confirmed_by_pct, unit: '%', target: '', tone: '', caption: c.confirmed_by + ' of ' + c.leads + ' leads' },
    { key: 'pickup', label: 'Call pick-up rate', value: act.picked_pct, unit: '%', target: '', tone: '', caption: act.picked + ' of ' + act.calls + ' calls picked up (calls, not orders)' },
    { key: 'volume', label: 'Calls per person per day', value: act.calls_per_person_day, unit: '', target: '', tone: '', caption: act.calls + ' calls · ' + people.length + ' people · ' + act.active_days + ' working days' },
  ];

  // What to look at: plain sentences.
  const flags = [];
  const add = (level, text) => flags.push({ level, text });
  if (c.not_called > 0) add(c.not_called / Math.max(1, c.needed) > 0.05 ? 'bad' : 'warn', c.not_called + ' leads were never called by anyone (' + (m.not_called_pct == null ? 0 : m.not_called_pct) + '% of leads that needed a call).');
  if (c.called_by_other_team_only > 0) add('warn', c.called_by_other_team_only + ' leads were called only by the other team (handed over).');
  if (redialPct != null && redialPct < TARGETS.redial.ok && c.nc_old - c.nc_old_redialed >= 3) add(redialPct < TARGETS.redial.warn ? 'bad' : 'warn', (c.nc_old - c.nc_old_redialed) + ' leads that nobody reached have had only one call so far, against the rule of calling until confirmed.');
  if (onTimePct != null && onTimePct < TARGETS.first_call_on_time.ok) add(onTimePct < TARGETS.first_call_on_time.warn ? 'bad' : 'warn', 'Only ' + onTimePct + '% of new orders got their first call within 1 hour. Fresh leads come first, so that the not-connected leads can be worked before the 2 PM lock.');
  const avgCalls = people.length > 1 ? people.reduce((s, p) => s + p.calls, 0) / people.length : 0;
  const teamCancel = pct(act.cancelled, act.confirmed + act.cancelled), teamDnp = act.picked_pct == null ? null : pct(act.dnp, act.calls);
  for (const p of people) {
    if (p.confirmed + p.cancelled >= 20 && p.cancel_of_spoke_pct != null && teamCancel != null && p.cancel_of_spoke_pct >= 12 && p.cancel_of_spoke_pct > 1.5 * teamCancel) add('bad', p.name + ' cancels ' + p.cancel_of_spoke_pct + '% of the customers spoken to (team ' + teamCancel + '%). Check these cancels.');
    if (p.calls >= 30 && p.dnp_pct != null && teamDnp != null && p.dnp_pct >= 60 && p.dnp_pct > 1.3 * teamDnp) add('bad', p.name + ' marks ' + p.dnp_pct + '% of calls as no answer (team ' + teamDnp + '%). Check against the call recordings.');
    if (avgCalls >= 30 && p.calls < 0.4 * avgCalls) add('warn', p.name + ' made only ' + p.calls + ' calls (team average ' + Math.round(avgCalls) + ').');
  }

  const days = [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1)).map(d => ({ ...d, attempted_pct: pct(d.attempted, d.needed), connected_pct: pct(d.connected, d.leads), confirmed_pct: pct(d.confirmed_by, d.leads),
    connected_pct_of_needed: pct(d.connected, d.needed), confirmed_pct_of_needed: pct(d.confirmed_by, d.needed), not_called_pct_of_needed: pct(d.not_called, d.needed) }));
  const callDays = (activity.days || []).filter(x => S.callTeams.includes(x.team)).reduce((mp, x) => {
    const e = mp.get(x.day) || { day: x.day, calls: 0, picked: 0, orders_dialled: 0 };
    e.calls += num(x.calls); e.picked += num(x.picked); e.orders_dialled += num(x.orders_dialled); mp.set(x.day, e); return mp;
  }, new Map());
  return { key, label: S.label, metrics: m, activity: act, kpis, people, flags, days, call_days: [...callDays.values()].sort((a, b) => (a.day < b.day ? -1 : 1)).map(x => ({ ...x, picked_pct: pct(x.picked, x.calls) })) };
}

const chanOf = (actor, role) => (WA.includes(actor) ? 'whatsapp' : IVR.includes(actor) ? 'ivr' : role === 'aman' || role === 'admin' ? 'aman' : role === 'agent' ? 'cc' : 'other');
const CHANNELS = [['whatsapp', 'WhatsApp'], ['ivr', 'IVR'], ['aman', 'Aman'], ['cc', 'Call centre'], ['other', 'Sheet, admin or automatic']];

// All channels together: who confirmed the COD orders.
function channelsCard(rows, callsMap, now) {
  const z = () => ({ whatsapp: 0, ivr: 0, aman: 0, cc: 0, other: 0 });
  const t = { cod: rows.length, shipped: 0, rto: 0, confirmed: z(), cancelled: z(), confirmed_total: 0, cancelled_by_customer: 0, auto_cancelled: 0, pending: 0, spoke_pending: 0, reached: 0, not_reached: 0 };
  const win = { before: { orders: 0, confirmed: 0, ...z() }, from_6pm: { orders: 0, confirmed: 0, ...z() } };
  const by = new Map();
  for (const o of rows) {
    const calls = callsMap.get(o.id) || [], spoke = calls.some(x => CONNECTED.has(x.d)), ch = chanOf(o.actor, o.actor_role);
    const w = istHour(o.order_at) >= TARGETS.ivr_from_hour ? win.from_6pm : win.before;
    const d = by.get(o.day) || { day: o.day, cod: 0, confirmed: 0, ...z(), cancelled: 0, pending: 0, reached: 0 };
    by.set(o.day, d);
    d.cod++; w.orders++; if (o.shipped) t.shipped++; if (o.rto) t.rto++;
    if (o.status === 'confirmed') { t.confirmed[ch]++; t.confirmed_total++; t.reached++; w.confirmed++; w[ch]++; d.confirmed++; d[ch]++; d.reached++; }
    else if (o.status === 'cancelled') {
      t.cancelled[ch]++;
      if (spoke || ch !== 'other') { t.cancelled_by_customer++; t.reached++; d.reached++; d.cancelled++; } else { t.auto_cancelled++; t.not_reached++; }
    } else if (o.status === 'pending') { t.pending++; if (spoke) { t.spoke_pending++; t.reached++; d.reached++; } else t.not_reached++; d.pending++; }
    else if (spoke) { t.reached++; d.reached++; } else t.not_reached++;
  }
  const rowsOut = CHANNELS.map(([k, label]) => ({ key: k, label, confirmed: t.confirmed[k], confirmed_pct_of_cod: pct(t.confirmed[k], t.cod), share_of_confirmed_pct: pct(t.confirmed[k], t.confirmed_total), cancelled: t.cancelled[k], cancelled_pct_of_cod: pct(t.cancelled[k], t.cod) }));
  const winOut = (w, label) => ({ label, orders: w.orders, confirmed: w.confirmed, confirmed_pct: pct(w.confirmed, w.orders), ...Object.fromEntries(CHANNELS.map(([k]) => [k, w[k]])) });
  return {
    key: 'channels', label: 'All channels together (WhatsApp, IVR, Aman, call centre)', totals: t,
    confirmed_pct: pct(t.confirmed_total, t.cod), cancelled_total: Object.values(t.cancelled).reduce((a, b) => a + b, 0), cancelled_pct: pct(Object.values(t.cancelled).reduce((a, b) => a + b, 0), t.cod), shipped_pct_of_confirmed: pct(t.shipped, t.confirmed_total), rto_pct_of_shipped: pct(t.rto, t.shipped), reached_pct: pct(t.reached, t.cod), not_reached_pct: pct(t.not_reached, t.cod), pending_pct: pct(t.pending, t.cod),
    channels: rowsOut,
    windows: [winOut(win.before, 'Placed before 6 PM (callers and WhatsApp)'), winOut(win.from_6pm, 'Placed from 6 PM (IVR window)')],
    days: [...by.values()].sort((a, b) => (a.day < b.day ? -1 : 1)).map(d => ({ ...d, confirmed_pct: pct(d.confirmed, d.cod), reached_pct: pct(d.reached, d.cod) })),
    kpis: [
      { key: 'confirmed', label: 'Total confirmation', value: pct(t.confirmed_total, t.cod), unit: '%', target: '95%', tone: tone(pct(t.confirmed_total, t.cod), { ok: 95, warn: 85 }), caption: t.confirmed_total + ' of ' + t.cod + ' COD orders, every channel' },
      { key: 'reached', label: 'Customers reached', value: pct(t.reached, t.cod), unit: '%', target: '95%', tone: tone(pct(t.reached, t.cod), { ok: 95, warn: 85 }), caption: t.reached + ' reached on WhatsApp, IVR or a call' },
      { key: 'callers', label: 'Confirmed by callers', value: pct(t.confirmed.aman + t.confirmed.cc, t.cod), unit: '%', target: '', tone: '', caption: (t.confirmed.aman + t.confirmed.cc) + ' (Aman ' + t.confirmed.aman + ', call centre ' + t.confirmed.cc + ')' },
      { key: 'whatsapp', label: 'Confirmed on WhatsApp', value: pct(t.confirmed.whatsapp, t.cod), unit: '%', target: '', tone: '', caption: t.confirmed.whatsapp + ' orders' },
      { key: 'ivr', label: 'Confirmed on IVR', value: pct(t.confirmed.ivr, t.cod), unit: '%', target: '', tone: '', caption: t.confirmed.ivr + ' orders' },
      { key: 'pending', label: 'Still pending', value: pct(t.pending, t.cod), unit: '%', target: '', tone: t.pending ? 'warn' : '', caption: t.pending + ' orders with no answer yet' },
    ],
  };
}

function buildTeamReport(rows, callsMap, activity, { now = new Date() } = {}) {
  const act = { agents: [], teams: [], all: {}, days: [], ...(activity || {}) };
  return { aman: scopeCard('aman', rows, callsMap, act, now), cc: scopeCard('cc', rows, callsMap, act, now), callers: scopeCard('callers', rows, callsMap, act, now), channels: channelsCard(rows, callsMap, now), targets: TARGETS };
}

const DEFINITIONS = [
  'Leads = COD orders placed in the dates (real tea orders, test orders left out) given to that team. A lead that nobody had to call because WhatsApp, IVR, the sheet or the system closed it first is left out of "needed a call".',
  'Leads called at least once = leads with a call by that team. Target 100%. Leads called only by the other team (handed over) are shown separately, and "never called" means no call by anyone.',
  'First call within 1 hour = orders placed before 5 PM whose first call came within 60 minutes of the order (or of 9 AM, for an order placed before the shift opened). Fresh leads are worked first; the not-connected leads come next, so that more orders are confirmed before the 2 PM lock and ship the same day.',
  'Customers reached = a lead where the customer spoke on at least one call. Address-fix, callback, do-not-call and escalated calls count, like confirmed and cancelled.',
  'Redial discipline = of the leads nobody reached that are more than a day old, how many were called again. The owner rule is to keep calling until confirmed.',
  'Confirmed by this team = orders whose confirmation was recorded by a person of that team. Orders confirmed on WhatsApp or the IVR are credited to those channels.',
  'Call pick-up rate counts calls (picked up / calls made, on any order) and is a different number from customers reached, which counts orders.',
  'Total confirmation and Customers reached (all channels) are percentages of COD orders placed in the dates, whoever or whatever confirmed them.',
];

// The same four measures as Excel sheets.
function addTeamSheets(wb, rep, headerStyle) {
  const p = (v) => (v == null ? '' : v + '%');
  const mk = (name, widths) => { const w = wb.addWorksheet(name); w.columns = widths.map(x => ({ width: x })); return w; };
  const head = (w, cells) => { const r = w.addRow(cells); r.eachCell(c => Object.assign(c, headerStyle)); return r; };
  for (const key of ['aman', 'cc', 'callers']) {
    const T = rep[key], w = mk(T.label.length > 28 ? (key === 'callers' ? 'All callers' : T.label.slice(0, 28)) : T.label, [44, 16, 12, 12, 14, 14, 14, 14, 14, 14, 14]);
    w.addRow([T.label]); w.getRow(1).font = { bold: true, size: 12 };
    w.addRow([]);
    head(w, ['Scorecard', 'Value', 'Target', 'Status', 'Detail']);
    T.kpis.forEach(k => w.addRow([k.label, k.value == null ? '' : k.value + (k.unit || ''), k.target, k.tone === 'ok' ? 'On target' : k.tone === 'warn' ? 'Close' : k.tone === 'bad' ? 'Below target' : '', k.caption]));
    w.addRow([]);
    head(w, ['Counts', 'Number', '%']);
    const m = T.metrics;
    [['Leads (COD orders given to this team)', m.leads, null], ['Closed without a call by WhatsApp, IVR or system', m.closed_without_call, null], ['Leads that needed a call', m.needed, null],
      ['Called at least once', m.attempted, m.attempted_pct], ['Called only by the other team', m.called_by_other_team_only, null], ['Never called by anyone', m.not_called, m.not_called_pct],
      ['Customers reached', m.connected, m.connected_pct_of_attempted], ['Not reached', m.not_connected, m.not_connected_pct], ['Not reached: second call done', m.nc_2nd, m.nc_2nd_pct], ['Not reached: third call done', m.nc_3rd, m.nc_3rd_pct],
      ['Confirmed by this team', m.confirmed_by, m.confirmed_by_pct], ['Rejected (cancelled on a call)', m.rejected_by, m.rejected_by_pct], ['Still pending', m.pending, m.pending_pct]].forEach(r => w.addRow([r[0], r[1], p(r[2])]));
    w.addRow([]);
    head(w, ['Person', 'Calls', 'Orders dialled', 'Picked up %', 'No answer %', 'Confirmed', 'Cancelled', 'Cancel % of spoke', 'Address fixes', 'Working days', 'Calls per day']);
    T.people.forEach(x => w.addRow([x.name, x.calls, x.orders_dialled, p(x.picked_pct), p(x.dnp_pct), x.confirmed, x.cancelled, p(x.cancel_of_spoke_pct), x.address_fix, x.active_days, x.calls_per_day]));
    w.addRow([]);
    head(w, ['Order date', 'Leads', 'Needed a call', 'Called', 'Called %', 'Reached', 'Reached %', 'Confirmed by team', 'Confirmed %', 'Never called']);
    T.days.forEach(d => w.addRow([d.day, d.leads, d.needed, d.attempted, p(d.attempted_pct), d.connected, p(d.connected_pct), d.confirmed_by, p(d.confirmed_pct), d.not_called]));
    w.addRow([]);
    head(w, ['Call date', 'Calls made', 'Orders dialled', 'Picked up %']);
    T.call_days.forEach(d => w.addRow([d.day, d.calls, d.orders_dialled, p(d.picked_pct)]));
    if (T.flags.length) { w.addRow([]); head(w, ['What to look at']); T.flags.forEach(f => w.addRow([(f.level === 'bad' ? 'ACT: ' : 'WATCH: ') + f.text])); }
  }
  const C = rep.channels, w = mk('All channels', [46, 14, 16, 16, 14, 14, 14, 14, 14]);
  w.addRow([C.label]); w.getRow(1).font = { bold: true, size: 12 };
  w.addRow([]);
  head(w, ['Scorecard', 'Value', 'Target', 'Status', 'Detail']);
  C.kpis.forEach(k => w.addRow([k.label, k.value == null ? '' : k.value + (k.unit || ''), k.target, k.tone === 'ok' ? 'On target' : k.tone === 'warn' ? 'Close' : k.tone === 'bad' ? 'Below target' : '', k.caption]));
  w.addRow([]);
  head(w, ['Who confirmed', 'Confirmed', '% of COD orders', '% of all confirmed', 'Cancelled', '% of COD orders']);
  C.channels.forEach(x => w.addRow([x.label, x.confirmed, p(x.confirmed_pct_of_cod), p(x.share_of_confirmed_pct), x.cancelled, p(x.cancelled_pct_of_cod)]));
  w.addRow(['Total', C.totals.confirmed_total, p(C.confirmed_pct), '100%', Object.values(C.totals.cancelled).reduce((a, b) => a + b, 0), '']);
  w.addRow([]);
  head(w, ['When the order was placed', 'COD orders', 'Confirmed', 'Confirmed %', 'WhatsApp', 'IVR', 'Aman', 'Call centre', 'Other']);
  C.windows.forEach(x => w.addRow([x.label, x.orders, x.confirmed, p(x.confirmed_pct), x.whatsapp, x.ivr, x.aman, x.cc, x.other]));
  w.addRow([]);
  head(w, ['Order date', 'COD orders', 'Confirmed', 'Confirmed %', 'WhatsApp', 'IVR', 'Aman', 'Call centre', 'Other', 'Pending', 'Reached %']);
  C.days.forEach(d => w.addRow([d.day, d.cod, d.confirmed, p(d.confirmed_pct), d.whatsapp, d.ivr, d.aman, d.cc, d.other, d.pending, p(d.reached_pct)]));
  const d = mk('How to read', [140]);
  DEFINITIONS.forEach(t => d.addRow([t]));
  return wb;
}

module.exports = { buildTeamReport, addTeamSheets, scopeCard, channelsCard, chanOf, TARGETS, DEFINITIONS };
