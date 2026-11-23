// Repeat-customer maths. Input: one row per counted order { phone, name, date, price }.
// A customer is a phone number. Month = IST calendar month.
const DAY = 86400000;
const WINDOWS = [15, 30, 60, 90];

const monthOf = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).slice(0, 7);
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
const r2 = (n) => Math.round(n * 100) / 100;

function buildRepeat(orders, now = new Date()) {
  const byPhone = new Map();
  for (const o of orders) {
    if (!byPhone.has(o.phone)) byPhone.set(o.phone, []);
    byPhone.get(o.phone).push({ ...o, date: new Date(o.date), price: Number(o.price) || 0 });
  }
  const cohorts = new Map(), months = new Map(), customers = [];
  const cohort = (m) => {
    if (!cohorts.has(m)) {
      cohorts.set(m, { month: m, customers: 0, repeaters: 0, repeat_orders: 0, gap_sum: 0, gaps: 0, first_revenue: 0, repeat_revenue: 0,
        within: Object.fromEntries(WINDOWS.map(w => [w, { eligible: 0, repeated: 0 }])) });
    }
    return cohorts.get(m);
  };
  const month = (m) => {
    if (!months.has(m)) months.set(m, { month: m, orders: 0, new_customer_orders: 0, returning_orders: 0, revenue: 0, returning_revenue: 0 });
    return months.get(m);
  };

  for (const [phone, list] of byPhone) {
    list.sort((a, b) => a.date - b.date);
    const first = list[0], second = list[1] || null;
    const c = cohort(monthOf(first.date));
    c.customers++; c.first_revenue += first.price;
    if (second) {
      c.repeaters++; c.repeat_orders += list.length - 1;
      c.repeat_revenue += list.slice(1).reduce((s, o) => s + o.price, 0);
      c.gap_sum += (second.date - first.date) / DAY; c.gaps++;
    }
    for (const w of WINDOWS) {
      if ((now - first.date) / DAY >= w) { // only customers old enough to have had the chance
        c.within[w].eligible++;
        if (second && (second.date - first.date) / DAY <= w) c.within[w].repeated++;
      }
    }
    list.forEach((o, i) => {
      const m = month(monthOf(o.date));
      m.orders++; m.revenue += o.price;
      if (i === 0) m.new_customer_orders++; else { m.returning_orders++; m.returning_revenue += o.price; }
    });
    customers.push({
      phone, name: first.name || '', orders: list.length, first_order: first.date.toISOString().slice(0, 10),
      last_order: list[list.length - 1].date.toISOString().slice(0, 10),
      days_to_second: second ? Math.round((second.date - first.date) / DAY) : null,
      total_spent: r2(list.reduce((s, o) => s + o.price, 0)),
    });
  }

  const cohortRows = [...cohorts.values()].sort((a, b) => a.month.localeCompare(b.month)).map(c => ({
    month: c.month, customers: c.customers, repeaters: c.repeaters, repeat_pct: pct(c.repeaters, c.customers),
    repeat_orders: c.repeat_orders, avg_days_to_second: c.gaps ? Math.round(c.gap_sum / c.gaps) : null,
    first_revenue: r2(c.first_revenue), repeat_revenue: r2(c.repeat_revenue),
    within: Object.fromEntries(WINDOWS.map(w => [w, { ...c.within[w], pct: pct(c.within[w].repeated, c.within[w].eligible) }])),
  }));
  const monthRows = [...months.values()].sort((a, b) => a.month.localeCompare(b.month)).map(m => ({
    ...m, revenue: r2(m.revenue), returning_revenue: r2(m.returning_revenue), returning_pct: pct(m.returning_orders, m.orders),
  }));
  const total = cohortRows.reduce((t, c) => ({ customers: t.customers + c.customers, repeaters: t.repeaters + c.repeaters, repeat_orders: t.repeat_orders + c.repeat_orders }),
    { customers: 0, repeaters: 0, repeat_orders: 0 });
  const gapRows = customers.filter(c => c.days_to_second !== null);
  return {
    totals: { ...total, repeat_pct: pct(total.repeaters, total.customers),
      avg_days_to_second: gapRows.length ? Math.round(gapRows.reduce((s, c) => s + c.days_to_second, 0) / gapRows.length) : null,
      orders_counted: orders.length },
    cohorts: cohortRows, months: monthRows, customers,
  };
}

module.exports = { buildRepeat, monthOf, WINDOWS };
