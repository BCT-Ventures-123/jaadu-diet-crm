// IVR performance for the admin Home. Pure: takes the day rows from ivr_calls (see lib/ivrDb.js report()) and returns totals, percentages and plain numbers.
//   placed          real calls the IVR service accepted (test calls and refused requests are not counted)
//   pressed         the customer pressed a key, so a person answered: this is the IVR's "reached"
//   k1 / k2 / k3    pressed 1 (confirm), 2 (change address), 3 (cancel). Key 3 never cancels an order: a caller tries to save it.
//   no_key          placed minus pressed: not answered, or hung up before pressing
//   confirmed_applied  orders the CRM really confirmed from a press of 1 (the order was still pending)
//   left_to_person  orders the IVR did not call because of risk, address or phone: a person calls them
const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
const num = (v) => Number(v) || 0;

function summarise(rows) {
  const days = (rows || []).map(r => {
    const placed = num(r.placed), k1 = num(r.k1), k2 = num(r.k2), k3 = num(r.k3), pressed = k1 + k2 + k3;
    return { day: r.day, orders_called: num(r.orders_called), placed, pressed, pressed_pct: pct(pressed, placed), k1, k2, k3, no_key: Math.max(0, placed - pressed),
      confirmed_applied: num(r.confirmed_applied), left_to_person: num(r.left_to_person), failed: num(r.failed) };
  });
  const t = { orders_called: 0, placed: 0, pressed: 0, k1: 0, k2: 0, k3: 0, no_key: 0, confirmed_applied: 0, left_to_person: 0, failed: 0 };
  for (const d of days) for (const k of Object.keys(t)) t[k] += d[k];
  const totals = { ...t, pressed_pct: pct(t.pressed, t.placed), confirm_pct_of_placed: pct(t.k1, t.placed), confirm_pct_of_pressed: pct(t.k1, t.pressed), no_key_pct: pct(t.no_key, t.placed),
    address_pct_of_pressed: pct(t.k2, t.pressed), cancel_pct_of_pressed: pct(t.k3, t.pressed) };
  return { totals, days };
}

module.exports = { summarise };
