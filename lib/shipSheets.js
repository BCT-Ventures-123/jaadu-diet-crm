// Shipping sheets for the Daily report Excel: what the person who ships needs, order by order.
// Pure: takes the workbook and the ship gate snapshot (lib/shipGateDb.js). Adds sheets; changes nothing that exists.
const gate = require('./shipGate');

const ist = (d) => (d ? new Date(new Date(d).getTime() + 19800000).toISOString().replace('T', ' ').slice(0, 16) : '');
const WAIT = (o, now) => Math.max(0, Math.round(((now - new Date(o.shopify_created_at || o.created_at)) / 3600000) * 10) / 10);
const STATUS = { overdue: 'OVERDUE', due_today: 'Due today', scheduled: 'Next shipping day' };

function addShipSheets(wb, snap, headerStyle, opt = {}) {
  const { r, now } = snap;
  const sheet = (name, head, body, widths) => {
    const w = wb.addWorksheet(name);
    w.columns = head.map((h, i) => ({ header: h, width: (widths && widths[i]) || Math.max(12, h.length + 3) }));
    w.getRow(1).eachCell(cell => Object.assign(cell, headerStyle));
    w.views = [{ state: 'frozen', ySplit: 1 }];
    body.forEach(b => w.addRow(b));
    return w;
  };
  const common = (o) => [o.order_name, o.customer_name, o.customer_phone];

  const pending = r.blocked.filter(o => o.reasons.includes('unconfirmed')).sort((a, b) => new Date(a.shopify_created_at || a.created_at) - new Date(b.shopify_created_at || b.created_at));
  const held = r.blocked.filter(o => o.reasons.some(x => x !== 'unconfirmed'));
  const ready = r.ready;
  const count = (f) => ready.filter(f).length;
  const reasonCount = (k) => r.blocked.filter(o => o.reasons.includes(k)).length;

  const first = sheet('Ship summary', ['Block', 'Metric', 'Value'], [
    ['As of', 'Generated (India time)', ist(now)],
    ['As of', 'Is today a shipping day?', snap.shippingDay ? 'Yes' : 'No (Sunday or holiday)'],
    ['As of', 'Next shipping day', snap.nextShippingDay],
    ['As of', 'Orders looked at', 'Placed from ' + ist(snap.since).slice(0, 10) + ' onward, all dates, not only the report dates'],
    ['Ready to ship', 'Total ready to ship', ready.length],
    ['Ready to ship', 'COD, confirmed', count(o => !o.prepaid)],
    ['Ready to ship', 'Prepaid, ship directly', count(o => o.prepaid)],
    ['Ready to ship', 'OVERDUE (should have shipped already)', count(o => o.ship_status === 'overdue')],
    ['Ready to ship', 'Due today', count(o => o.ship_status === 'due_today')],
    ['Ready to ship', 'Wait for the next shipping day', count(o => o.ship_status === 'scheduled')],
    ['Before tracking', 'Ready before courier updates began (shipped or not is unknown, not counted above)', (r.untracked || []).length],
    ['Confirmation pending', 'COD orders waiting for confirmation', pending.length],
    ['Held back', 'Short address, needs fixing', reasonCount('short_address')],
    ['Held back', 'Duplicate waiting for review', reasonCount('duplicate')],
    ['Held back', 'Cancelled', reasonCount('cancelled')],
    ['Wrong ships', 'AWB made but the order should not have shipped', r.wrong.length],
    ['Note', 'Sheets', 'To ship = full details of every ready order. Confirmation pending = COD orders still to confirm. Held back = orders kept off the ship list, with the reason. Wrong ships = shipped by mistake.'],
  ], [16, 52, 60]);

  sheet('To ship', ['Order', 'Ship status', 'Ship by', 'Payment', 'Collect on delivery (Rs)', 'Order total (Rs)', 'Customer', 'Phone', 'Address', 'City', 'State', 'Pincode', 'Product and quantity', 'Ready since', 'Team'],
    ready.map(o => [o.order_name, STATUS[o.ship_status] || o.ship_status, o.due, o.prepaid ? 'Prepaid' : 'COD', gate.collectAmount(o), Number(o.total_price) || 0, o.customer_name, o.customer_phone,
      gate.addressText(o), o.shipping_city, o.shipping_province, o.shipping_zip, gate.itemsText(o.line_items), ist(o.ready_at), o.assigned_to]),
    [12, 16, 12, 10, 14, 14, 22, 14, 48, 16, 16, 10, 40, 17, 10]);

  sheet('Confirmation pending', ['Order', 'Customer', 'Phone', 'City', 'Pincode', 'Product and quantity', 'Order total (Rs)', 'Ordered at', 'Hours waiting', 'Calls made', 'Last call', 'Team', 'Agent'],
    pending.map(o => [...common(o), o.shipping_city, o.shipping_zip, gate.itemsText(o.line_items), Number(o.total_price) || 0, ist(o.shopify_created_at || o.created_at), WAIT(o, now), o.call_attempts || 0, ist(o.last_call_at), o.assigned_to, o.assigned_agent || '']),
    [12, 22, 14, 16, 10, 40, 14, 17, 13, 11, 17, 10, 16]);

  sheet('Held back', ['Order', 'Why it is held', 'Payment', 'Order total (Rs)', 'Customer', 'Phone', 'Address', 'City', 'Pincode', 'Product and quantity'],
    held.map(o => [o.order_name, o.reason_text.join(', '), o.prepaid ? 'Prepaid' : 'COD', Number(o.total_price) || 0, o.customer_name, o.customer_phone, gate.addressText(o), o.shipping_city, o.shipping_zip, gate.itemsText(o.line_items)]),
    [12, 40, 10, 14, 22, 14, 48, 16, 10, 40]);

  sheet('Wrong ships', ['Order', 'Why it should not have shipped', 'AWB', 'Courier', 'Payment', 'Order total (Rs)', 'Customer', 'Phone'],
    r.wrong.map(o => [o.order_name, o.reason_text.join(', '), o.awb_number || '', o.courier_name || '', o.prepaid ? 'Prepaid' : 'COD', Number(o.total_price) || 0, o.customer_name, o.customer_phone]),
    [12, 46, 22, 16, 10, 14, 22, 14]);

  // Optionally open the workbook on the shipping summary.
  if (opt.activate) {
    const idx = wb.worksheets.findIndex(w => w === first);
    wb.views = [{ x: 0, y: 0, width: 10000, height: 20000, firstSheet: 0, activeTab: idx < 0 ? 0 : idx, visibility: 'visible' }];
  }
  return { to_ship: ready.length, pending: pending.length, held: held.length, wrong: r.wrong.length };
}

module.exports = { addShipSheets };
