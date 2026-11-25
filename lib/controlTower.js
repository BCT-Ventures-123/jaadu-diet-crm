// Control Tower: one screen that says whether the whole chain is healthy and what to fix next. Pure: no database here.
// Inputs are results the other engines already produce, so the numbers on this screen are the same numbers as on the reports:
//   e2e   = lib/e2e.js buildE2E over the last 14 days (by order date)
//   team  = lib/teamReport.js buildTeamReport over the last 7 days
//   ship  = counts from the ship gate snapshot { ready, overdue, due_today, blocked, wrong, untracked }
//   shippedConfirmed = confirmed COD orders in the last-7-day window that already have an AWB / shipped status
// Stages after "Shipped" (pickup, delivery) need the courier history and are shown as "no data yet" rather than guessed.
const TARGETS = { confirmed: { ok: 95, warn: 90 }, called: { ok: 100, warn: 95 }, shipped: { ok: 100, warn: 90 } };
const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
const tone = (v, t) => (v == null ? '' : v >= t.ok ? 'ok' : v >= t.warn ? 'warn' : 'bad');

function sumDays(days, keys) {
  const s = {}; keys.forEach(k => { s[k] = 0; });
  days.forEach(d => keys.forEach(k => { s[k] += d[k] || 0; }));
  return s;
}

function buildControlTower({ e2e, team, ship, plan, shippedConfirmed = 0, today, windowDays = 7 }) {
  const all = (e2e && e2e.days) || [];
  const win = all.slice(-windowDays);
  const w = sumDays(win, ['total', 'prepaid', 'cod', 'needed_call', 'attempted', 'not_attempted', 'connected', 'confirmed_all', 'pending', 'rejected']);
  const confirmedPct = pct(w.confirmed_all, w.cod), calledPct = pct(w.attempted, w.needed_call), reachedPct = pct(w.connected, w.cod);
  const shippedPct = pct(shippedConfirmed, w.confirmed_all);

  const stages = [
    { key: 'orders', label: 'Orders', count: w.total, pct: null, caption: w.prepaid + ' prepaid, ' + w.cod + ' COD', tone: '' },
    { key: 'called', label: 'Called', count: w.attempted, pct: calledPct, caption: 'of ' + w.needed_call + ' COD orders, tried on any channel (call, IVR or WhatsApp)', target: '100%', tone: tone(calledPct, TARGETS.called) },
    { key: 'reached', label: 'Reached', count: w.connected, pct: reachedPct, caption: 'of ' + w.cod + ' COD orders, the customer answered on any channel', tone: '' },
    { key: 'confirmed', label: 'Confirmed', count: w.confirmed_all, pct: confirmedPct, caption: 'of ' + w.cod + ' COD orders, all ways', target: '95%', tone: tone(confirmedPct, TARGETS.confirmed) },
    { key: 'shipped', label: 'Shipped', count: shippedConfirmed, pct: shippedPct, caption: 'of confirmed orders have an AWB', target: '100%', tone: tone(shippedPct, TARGETS.shipped) },
    { key: 'pickup', label: 'Picked up', count: null, pct: null, caption: 'needs the courier history', tone: '', nodata: true },
    { key: 'delivered', label: 'Delivered', count: null, pct: null, caption: 'needs the courier history', target: '92%', tone: '', nodata: true },
  ];

  // What needs action now: ranked, worst first. Each item says what to open.
  const actions = [];
  const add = (level, text, go) => actions.push({ level, text, go });
  const earlier = all.filter(d => d.day < today);
  const missedEarlier = earlier.reduce((a, d) => a + (d.not_attempted || 0), 0);
  if (missedEarlier) add('bad', missedEarlier + ' COD orders from earlier days were never tried (no call, IVR or WhatsApp).', 'funnel');
  const todayRow = all.find(d => d.day === today);
  if (todayRow && todayRow.not_attempted) add('warn', todayRow.not_attempted + " of today's COD orders have not been tried yet.", 'funnel');
  if (confirmedPct != null && confirmedPct < TARGETS.confirmed.ok) add(confirmedPct < TARGETS.confirmed.warn ? 'bad' : 'warn', 'Confirmation is ' + confirmedPct + '% over the last ' + win.length + ' days. The target is 95%.', 'daily');
  if (ship) {
    if (ship.overdue) add('bad', ship.overdue + ' confirmed orders are past their ship-by time.', 'shipgate');
    if (ship.due_today) add('warn', ship.due_today + ' confirmed orders must ship today.', 'shipgate');
    if (ship.wrong) add('bad', ship.wrong + ' orders were shipped when they should not have been.', 'shipgate');
    if (ship.blocked) add('warn', ship.blocked + ' orders are held back (address, duplicate, cancelled).', 'shipgate');
  }
  if (plan && plan.teams) {
    for (const k of ['cc', 'aman']) {
      const t = plan.teams[k];
      if (t && t.deficit > 0) add('bad', t.label + " cannot finish today's calls: short by about " + t.deficit + ' calls' + (t.agents_needed ? ' (about ' + t.agents_needed + ' people needed)' : '') + '.', 'plan');
    }
    if (plan.review_count) add('warn', plan.review_count + ' leads are over the redial limit: send WhatsApp / IVR, then review.', 'plan');
  }
  if (team) {
    for (const [k, label] of [['aman', 'Aman'], ['cc', 'Call centre']]) {
      for (const f of (team[k] && team[k].flags) || []) if (f.level === 'bad') add('bad', label + ': ' + f.text, 'teamperf');
    }
  }
  actions.sort((a, b) => (a.level === 'bad' ? 0 : 1) - (b.level === 'bad' ? 0 : 1));

  const teams = [];
  for (const [k, label] of [['aman', 'Aman'], ['cc', 'Call centre']]) {
    const m = team && team[k] && team[k].metrics;
    if (m) teams.push({ key: k, label, leads: m.leads, called_pct: m.attempted_pct, reached_pct: m.connected_pct_of_attempted, confirmed_pct: m.confirmed_by_pct, not_called: m.not_called, tone: tone(m.attempted_pct, TARGETS.called) });
  }
  const C = team && team.channels;
  if (C) teams.push({ key: 'channels', label: 'WhatsApp + IVR + callers', leads: C.totals.cod, called_pct: null, reached_pct: C.reached_pct, confirmed_pct: C.confirmed_pct, not_called: null, tone: tone(C.confirmed_pct, TARGETS.confirmed) });

  const trend = all.map(d => ({ day: d.day, orders: d.total, called_pct: d.attempted_pct, reached_pct: d.connected_pct, confirmed_pct: d.confirmed_pct }));
  const healthy = !actions.some(a => a.level === 'bad');
  return { window_days: win.length, healthy, stages, actions: actions.slice(0, 8), actions_total: actions.length, teams, trend, ship: ship || null, targets: TARGETS };
}

module.exports = { buildControlTower, TARGETS };
