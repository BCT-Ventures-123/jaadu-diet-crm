const test = require('node:test');
const assert = require('node:assert');
const { parseCsv } = require('../lib/csv');
const { mapColumns, remittanceRows, weightRows, toNumber, toDate } = require('../lib/courierImport');

test('csv handles quotes, commas, CRLF and BOM', () => {
  const r = parseCsv('﻿a,b\r\n"x, y","he said ""hi"""\r\n\r\n3,4');
  assert.deepEqual(r, [['a', 'b'], ['x, y', 'he said "hi"'], ['3', '4']]);
});

test('numbers and dates from Indian reports', () => {
  assert.equal(toNumber('₹1,299.50'), 1299.5);
  assert.equal(toNumber('Rs. 599'), 599);
  assert.equal(toNumber('abc'), null);
  assert.equal(toDate('05-10-2026'), '2026-10-05');
  assert.equal(toDate('5/10/26'), '2026-10-05');
  assert.equal(toDate('2026-10-05 12:00:00'), '2026-10-05');
  assert.equal(toDate('05 Oct 2026'), '2026-10-05');
  assert.equal(toDate('garbage'), null);
});

test('remittance report maps headers and skips bad rows', () => {
  const t = parseCsv('AWB Number,COD Amount,UTR No.,Remittance Date,Note\n1091,599,UTR1,05-10-2026,x\n,100,U,05-10-2026,y\n1092,abc,U,,z');
  const { map, unrecognised } = mapColumns(t[0]);
  assert.deepEqual(unrecognised, ['Note']);
  const { rows, skipped } = remittanceRows(t.slice(1), map);
  assert.equal(rows.length, 1);
  assert.equal(skipped, 2);
  assert.deepEqual(rows[0], { awb: '1091', amount: 599, utr: 'UTR1', date: '2026-10-05', courier: null });
});

test('weight report keeps only over-charged parcels, kg to grams', () => {
  const t = parseCsv('AWB,Charged Weight,Declared Weight,Excess Weight Charge\nA1,1.0,0.5,45\nA2,0.5,0.5,0\nA3,0.4,0.5,0');
  const { map } = mapColumns(t[0]);
  const { rows, skipped } = weightRows(t.slice(1), map, 'kg');
  assert.equal(rows.length, 1);
  assert.equal(skipped, 2);
  assert.deepEqual(rows[0], { awb: 'A1', chargedGm: 1000, actualGm: 500, diffGm: 500, excess: 45, courier: null });
  const g = parseCsv('AWB,Charged Weight,Declared Weight\nB1,1200,1000');
  assert.equal(weightRows(g.slice(1), mapColumns(g[0]).map, 'gm').rows[0].diffGm, 200);
});
