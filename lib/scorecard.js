// Owner scoreboard: goal tracking (reached / shipped / cancelled / not reached) and team + person quality flags.
// Goal (set by the owner): 95% of orders reached; 90% shipped; the last 5% = cancelled + not reached (90 + 5 + 5 = 100).
const { WA, IVR } = require('./channels');
const cfg = require('./config');

const TARGETS = {
  reached: 95, shipped: 90, cancelled_max: 5, not_reached_max: 5,
  redial_min: 85,            // % of DNP orders that must get another attempt within 24h
  confirm_min: 65,           // % of customers spoken to who confirm
  cancel_max_person: 12,     // % of customers spoken to who cancel, before a person is flagged
  dnp_max_person: 60,        // % of calls marked DNP, before a person is flagged
  wrong_max_person: 8,       // % of orders marked wrong number
};
const CONNECTED = new Set(cfg.CONNECTED_DISPOSITIONS);
const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);

// Who decided the order: whatsapp | ivr | aman | cc | other (sheet, admin, system, payment, unknown)
function deciderChannel(actor, role) {
  if (WA.includes(actor)) return 'whatsapp';
  if (IVR.includes(actor)) return 'ivr';
  if (role === 'aman') return 'aman';
  if (role === 'agent') return 'cc';
  return 'other';
}

// rows: [{ status, shipped, calls: [dispositions], actor, actor_role }]  (COD orders placed in the period)
function buildGoal(rows) {
  const g = { total: rows.length, shipped: 0, reached: 0, confirmed: 0, cancelled: 0, auto_cancelled: 0, spoke_pending: 0, not_reached: 0,
    by_channel: { whatsapp: { confirmed: 0, cancelled: 0 }, ivr: { confirmed: 0, cancelled: 0 }, aman: { confirmed: 0, cancelled: 0 }, cc: { confirmed: 0, cancelled: 0 }, other: { confirmed: 0, cancelled: 0 } } };
  for (const o of rows) {
    if (o.shipped) g.shipped++;
    const spoke = (o.calls || []).some(d => CONNECTED.has(d));
    const ch = deciderChannel(o.actor, o.actor_role);
    if (o.status === 'confirmed') {
      g.confirmed++; g.reached++; g.by_channel[ch].confirmed++;
    } else if (o.status === 'cancelled') {
      // A cancel the customer asked for counts as reached. Auto-cancel of an order nobody reached is NOT a customer decision.
      const byCustomer = spoke || ch !== 'other';
      if (byCustomer) { g.cancelled++; g.reached++; g.by_channel[ch].cancelled++; } else { g.auto_cancelled++; g.not_reached++; }
    } else if (spoke) { g.spoke_pending++; g.reached++; }
    else g.not_reached++;
  }
  const t = g.total;
  const need = (target) => Math.ceil((target / 100) * t);
  const res = {
    ...g,
    shipped_pct: pct(g.shipped, t), reached_pct: pct(g.reached, t), confirmed_pct: pct(g.confirmed, t), cancelled_pct: pct(g.cancelled, t), not_reached_pct: pct(g.not_reached, t),
    targets: TARGETS,
  };
  res.status = {
    reached: { ok: res.reached_pct >= TARGETS.reached, gap: Math.max(0, need(TARGETS.reached) - g.reached) },
    shipped: { ok: res.shipped_pct >= TARGETS.shipped, gap: Math.max(0, need(TARGETS.shipped) - g.shipped) },
    cancelled: { ok: res.cancelled_pct <= TARGETS.cancelled_max, gap: Math.max(0, g.cancelled - Math.floor((TARGETS.cancelled_max / 100) * t)) },
    not_reached: { ok: res.not_reached_pct <= TARGETS.not_reached_max, gap: Math.max(0, g.not_reached - Math.floor((TARGETS.not_reached_max / 100) * t)) },
  };
  return res;
}

// raw: { calls, orders_called, connected, confirmed, cancelled, dnp, wrong, callbacks, address_fix }, redial: { followed, missed, resolved_other }
function shapeStats(raw, redial) {
  const r = redial || { followed: 0, missed: 0, resolved_other: 0 };
  const redialBase = r.followed + r.missed;
  return {
    calls: raw.calls, orders_called: raw.orders_called, spoke: raw.connected, confirmed: raw.confirmed, cancelled: raw.cancelled, dnp: raw.dnp, wrong: raw.wrong,
    callbacks: raw.callbacks, address_fix: raw.address_fix,
    spoke_pct: pct(raw.connected, raw.calls), confirm_pct: pct(raw.confirmed, raw.connected), cancel_pct: pct(raw.cancelled, raw.connected),
    dnp_pct: pct(raw.dnp, raw.calls), wrong_pct: pct(raw.wrong, raw.orders_called),
    redial: { followed: r.followed, missed: r.missed, resolved_other: r.resolved_other, pct: redialBase ? pct(r.followed, redialBase) : null },
  };
}

// Plain-language flags. teamName for the heading; people compared with their team average.
function attention(teamName, team, people, backlog) {
  const out = [];
  const add = (level, text) => out.push({ level, text });
  if (team.redial.pct !== null && team.redial.pct < TARGETS.redial_min && team.redial.missed >= 3)
    add('bad', `${teamName}: ${team.redial.missed} orders marked "did not pick up" were not called again within 24 hours (redial rate ${team.redial.pct}%, should be ${TARGETS.redial_min}%+).`);
  if (backlog && backlog.fresh_waiting > 0) add('bad', `${teamName}: ${backlog.fresh_waiting} fresh order${backlog.fresh_waiting === 1 ? ' has' : 's have'} had no call for over 24 hours.`);
  if (backlog && backlog.callbacks_overdue > 0) add('warn', `${teamName}: ${backlog.callbacks_overdue} promised callback${backlog.callbacks_overdue === 1 ? ' is' : 's are'} more than 2 hours late.`);
  if (team.spoke >= 20 && team.confirm_pct < TARGETS.confirm_min) add('warn', `${teamName}: only ${team.confirm_pct}% of customers spoken to confirm (should be ${TARGETS.confirm_min}%+).`);
  const avgCalls = people.length > 1 ? people.reduce((s, p) => s + p.calls, 0) / people.length : 0;
  for (const p of people) {
    if (p.redial.pct !== null && p.redial.pct < TARGETS.redial_min && p.redial.missed >= 3) add('bad', `${p.name}: did not call back ${p.redial.missed} no-answer orders within 24 hours (redial ${p.redial.pct}%).`);
    if (p.spoke >= 20 && p.cancel_pct >= TARGETS.cancel_max_person && p.cancelled >= 5 && p.cancel_pct > 1.5 * team.cancel_pct)
      add('bad', `${p.name}: cancels ${p.cancel_pct}% of the customers they speak to (team ${team.cancel_pct}%). Check these cancels.`);
    if (p.calls >= 30 && p.dnp_pct >= TARGETS.dnp_max_person && p.dnp_pct > 1.3 * team.dnp_pct)
      add('bad', `${p.name}: marks ${p.dnp_pct}% of calls as "did not pick up" (team ${team.dnp_pct}%). Check against the call recordings.`);
    if (p.orders_called >= 20 && p.wrong_pct >= TARGETS.wrong_max_person) add('warn', `${p.name}: marks ${p.wrong_pct}% of orders as "wrong number".`);
    if (avgCalls >= 30 && p.calls < 0.4 * avgCalls) add('warn', `${p.name}: only ${p.calls} calls (team average ${Math.round(avgCalls)}).`);
  }
  return out;
}

module.exports = { TARGETS, buildGoal, shapeStats, attention, deciderChannel, pct };
