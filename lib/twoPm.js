// The 2 PM scorecard (owner rule 2026-11-23). An order confirmed before 2 PM ships the same day (2 to 4 PM packing, 4 PM courier pickup), so by 2 PM:
//   FRESH orders    placed after the previous day's 2 PM and before 1 PM today: every one should be attempted and confirmed before 2 PM. (Orders placed in the hour before 2 PM cannot be called in time and ship the next day.)
//   OLD DNP leads   placed earlier, still not confirmed or cancelled when the day began (the month's no-answer leads): reach as many as bandwidth allows before 2 PM, so they ship today too.
// Pure functions, no database. Every number is a count of ORDERS (leads), not calls.
//
// rows:    [{ id, status: 'pending'|'confirmed'|'cancelled'|..., order_at: Date, decided_at: Date|null }]   decided_at = when it was confirmed or cancelled
// touches: Map(order id -> [{ t: Date, team: 'aman'|'cc'|'ivr'|'wa', connected: boolean }])               every attempt on every channel
const CUT_HOUR = 14, LAST_PLACED_HOUR = 13;
const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
const istStart = (day) => new Date(day + 'T00:00:00+05:30');
const at = (start, hour) => new Date(start.getTime() + hour * 3600e3);

function build(rows, touches, day, now = new Date()) {
  const start = istStart(day), cut = at(start, CUT_HOUR), lastPlaced = at(start, LAST_PLACED_HOUR), prevCut = new Date(cut.getTime() - 86400e3);
  const live = new Date(now) < cut;                                                       // the cut-off has not passed yet: the numbers are "so far"
  const asOf = live ? new Date(now) : cut;
  const tOf = (id) => (touches.get(id) || []).map(x => ({ ...x, t: new Date(x.t) }));
  const decidedBefore = (o, when) => o.decided_at && new Date(o.decided_at) < when;

  const fresh = { pool: 0, confirmed_by_cut: 0, cancelled_by_cut: 0, open: 0, open_tried: 0, open_not_tried: 0, attempted_by_cut: 0, not_attempted_by_cut: 0, confirmed_after_cut: 0 };
  const old = { pool: 0, never_tried: 0, reached: 0, not_reached: 0, confirmed_by_cut: 0, cancelled_by_cut: 0, open: 0, confirmed_after_cut: 0 };
  for (const o of rows) {
    const placed = new Date(o.order_at), ts = tOf(o.id);
    if (placed >= prevCut && placed < lastPlaced) {
      fresh.pool++;
      const tried = ts.some(x => x.t >= placed && x.t < asOf);
      if (tried) fresh.attempted_by_cut++; else fresh.not_attempted_by_cut++;
      if (o.status === 'confirmed' && decidedBefore(o, asOf)) fresh.confirmed_by_cut++;
      else if (o.status === 'cancelled' && decidedBefore(o, asOf)) fresh.cancelled_by_cut++;
      else {
        fresh.open++; if (tried) fresh.open_tried++; else fresh.open_not_tried++;
        if (o.status === 'confirmed') fresh.confirmed_after_cut++;
      }
    } else if (placed < prevCut) {
      const openAtStart = o.status === 'pending' || ((o.status === 'confirmed' || o.status === 'cancelled') && o.decided_at && new Date(o.decided_at) >= start);   // not yet decided when the day began
      if (!openAtStart) continue;
      old.pool++;
      if (!ts.some(x => x.t < start)) old.never_tried++;
      if (ts.some(x => x.t >= start && x.t < asOf)) old.reached++; else old.not_reached++;
      if (o.status === 'confirmed' && decidedBefore(o, asOf)) old.confirmed_by_cut++;
      else if (o.status === 'cancelled' && decidedBefore(o, asOf)) old.cancelled_by_cut++;
      else { old.open++; if (o.status === 'confirmed') old.confirmed_after_cut++; }
    }
  }
  const withPct = (b, extra) => ({ ...b, ...Object.fromEntries(extra.map(([k, num]) => [k + '_pct', pct(b[num], b.pool)])) });
  return { day, live, cutoff: cut.toISOString(),
    fresh: withPct(fresh, [['confirmed_by_cut', 'confirmed_by_cut'], ['cancelled_by_cut', 'cancelled_by_cut'], ['open', 'open'], ['attempted_by_cut', 'attempted_by_cut'], ['not_attempted_by_cut', 'not_attempted_by_cut']]),
    old: withPct(old, [['reached', 'reached'], ['not_reached', 'not_reached'], ['confirmed_by_cut', 'confirmed_by_cut'], ['open', 'open']]) };
}

// The scorecard for each of the given days (oldest first).
function buildDays(rows, touches, days, now = new Date()) { return days.map(d => build(rows, touches, d, now)); }

module.exports = { build, buildDays, CUT_HOUR, LAST_PLACED_HOUR };
