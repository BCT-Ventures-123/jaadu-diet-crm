const test = require('node:test');
const assert = require('node:assert');
const { buildReport, toCsv, pct } = require('../lib/reportMath');

test('pct handles zero denominators', () => {
  assert.equal(pct(1, 0), null);
  assert.equal(pct(1, 3), 33.3);
});

test('connectivity = connected / total attempts; cancelled = cancelled / decided', () => {
  const r = buildReport({ confirmed: 80, cancelled: 4, dnp: 5, callback: 6, address_fix: 3, wrong_number: 2 }, 7);
  assert.equal(r.total_attempts, 100);
  assert.equal(r.connected_calls, 93);          // dnp + wrong_number are not connected
  assert.equal(r.connectivity_pct, 93);
  assert.equal(r.connectivity_ok, false);       // target 95
  assert.equal(r.decided_orders, 84);
  assert.equal(r.cancelled_pct, 4.8);
  assert.equal(r.cancelled_ok, true);           // target <= 5
  assert.equal(r.prepaid_conversions, 7);
  assert.equal(r.callbacks, 6);
  assert.equal(r.address_fixes, 3);
  assert.equal(r.wrong_numbers, 2);
});

test('empty period gives null percentages, not NaN', () => {
  const r = buildReport({}, 0);
  assert.equal(r.total_attempts, 0);
  assert.equal(r.connectivity_pct, null);
  assert.equal(r.cancelled_pct, null);
  assert.equal(r.connectivity_ok, null);
});

test('boundary: exactly 95% and exactly 5% meet targets', () => {
  const r = buildReport({ confirmed: 91, cancelled: 4, dnp: 5 }, 0);
  assert.equal(r.connectivity_pct, 95);
  assert.equal(r.connectivity_ok, true);
  const r2 = buildReport({ confirmed: 95, cancelled: 5 }, 0);
  assert.equal(r2.cancelled_pct, 5);
  assert.equal(r2.cancelled_ok, true);
});

test('CSV escapes quotes/commas and neutralises formulas', () => {
  const csv = toCsv(['a', 'b'], [{ a: 'x,"y"', b: '=SUM(A1)' }, { a: 5, b: null }]);
  assert.equal(csv, 'a,b\r\n"x,""y""",\'=SUM(A1)\r\n5,\r\n');
});
