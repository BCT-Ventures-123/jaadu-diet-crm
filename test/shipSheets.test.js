const test = require('node:test');
const assert = require('node:assert');
const ExcelJS = require('exceljs');
const gate = require('../lib/shipGate');
const { addShipSheets } = require('../lib/shipSheets');

const at = (s) => new Date(s + '+05:30');
const FULL = 'Flat 12, Shanti Apartments';
const item = [{ title: 'Arjuna Cardio Tea', quantity: 2 }];
const order = (o = {}) => ({
  id: 'x', order_name: '#1', customer_name: 'Rohit Sharma', customer_phone: '9000000001', payment_method: 'COD', confirmation_status: 'confirmed', order_status: 'new',
  total_price: 799, confirmed_at: at('2026-11-11T09:00:00'), shopify_created_at: at('2026-11-11T08:00:00'), created_at: at('2026-11-11T08:00:00'),
  shipping_address1: FULL, shipping_address2: 'Near City Mall', shipping_city: 'Pune', shipping_province: 'Maharashtra', shipping_zip: '411001',
  line_items: item, awb_number: null, is_duplicate: false, address_fixed: false, assigned_to: 'CC', ...o,
});

test('helpers: address, product and quantity, money to collect', () => {
  assert.strictEqual(gate.addressText(order()), 'Flat 12, Shanti Apartments, Near City Mall');
  assert.strictEqual(gate.itemsText(item), 'Arjuna Cardio Tea x2');
  assert.strictEqual(gate.itemsText(JSON.stringify(item)), 'Arjuna Cardio Tea x2');
  assert.strictEqual(gate.itemsText(null), '');
  assert.strictEqual(gate.itemsText('not json'), '');
  assert.strictEqual(gate.collectAmount(order()), 799);
  assert.strictEqual(gate.collectAmount(order({ payment_method: 'Prepaid' })), 0);
  assert.strictEqual(gate.collectAmount(order({ converted_to_prepaid: true })), 0);
});

test('addShipSheets adds the five sheets and leaves existing sheets alone', () => {
  const now = at('2026-11-11T11:00:00');
  const orders = [
    order({ id: 'a', order_name: '#10' }),
    order({ id: 'b', order_name: '#11', payment_method: 'Prepaid', confirmation_status: 'pending', confirmed_at: null }),
    order({ id: 'c', order_name: '#12', confirmed_at: at('2026-11-09T10:00:00') }),
    order({ id: 'd', order_name: '#13', confirmation_status: 'pending', confirmed_at: null, call_attempts: 2, assigned_agent: 'Priya' }),
    order({ id: 'e', order_name: '#14', shipping_address1: 'Rampur', shipping_address2: '', shipping_city: '', shipping_province: '' }),
    order({ id: 'f', order_name: '#15', confirmation_status: 'pending', confirmed_at: null, awb_number: 'AWB1' }),
  ];
  const r = gate.evaluate(orders, { now });
  const snap = { r, now, shippingDay: true, nextShippingDay: '2026-11-11', since: at('2026-10-26T00:00:00') };
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Funnel').addRow(['keep me']);
  const out = addShipSheets(wb, snap, { font: { bold: true } }, { activate: true });
  assert.deepStrictEqual(wb.worksheets.map(w => w.name), ['Funnel', 'Ship summary', 'To ship', 'Confirmation pending', 'Held back', 'Wrong ships']);
  assert.strictEqual(wb.getWorksheet('Funnel').getRow(1).getCell(1).value, 'keep me');
  assert.deepStrictEqual(out, { to_ship: 3, pending: 1, held: 1, wrong: 1 });
  const ship = wb.getWorksheet('To ship');
  assert.strictEqual(ship.rowCount, 4);
  assert.deepStrictEqual([ship.getRow(2).getCell(1).value, ship.getRow(2).getCell(2).value], ['#12', 'OVERDUE']);
  const prepaid = [2, 3, 4].map(i => ship.getRow(i)).find(x => x.getCell(1).value === '#11');
  assert.deepStrictEqual([prepaid.getCell(4).value, prepaid.getCell(5).value, prepaid.getCell(6).value], ['Prepaid', 0, 799]);
  assert.strictEqual(ship.getRow(2).getCell(9).value, 'Flat 12, Shanti Apartments, Near City Mall');
  assert.strictEqual(ship.getRow(2).getCell(13).value, 'Arjuna Cardio Tea x2');
  const pend = wb.getWorksheet('Confirmation pending');
  assert.deepStrictEqual([pend.getRow(2).getCell(1).value, pend.getRow(2).getCell(10).value, pend.getRow(2).getCell(13).value], ['#13', 2, 'Priya']);
  assert.strictEqual(wb.getWorksheet('Held back').getRow(2).getCell(2).value, 'Address too short, needs fixing');
  assert.strictEqual(wb.getWorksheet('Wrong ships').getRow(2).getCell(3).value, 'AWB1');
  assert.strictEqual(wb.views[0].activeTab, 1);
});
