const test = require('node:test');
const assert = require('node:assert');
const { PRODUCTS, ALLOWED_PREFIXES, MIN_PRICE, keyOfTitle, skusOf } = require('../lib/products');
const { buildBySku } = require('../lib/funnel');

test('every product title maps to its key; unknown products do not', () => {
  assert.equal(keyOfTitle("Dr. Bimal's Arjuna Cardio Care Tea with Ashwagandha, Shankhpushpi & Daalchini | 50 Tea Bags"), 'arjuna_cardio');
  assert.equal(keyOfTitle("Dr.Bimal's Arjuna Cardio Care Black Leaf Tea 100g"), 'black_leaf');
  assert.equal(keyOfTitle("Bundle of 3 - Dr. Bimal's Arjuna Cardio Care Tea"), 'bundle3');
  assert.equal(keyOfTitle('Shipping protection'), null);
  assert.equal(ALLOWED_PREFIXES.length, PRODUCTS.length);
  assert.equal(MIN_PRICE, 350);
});

test('quantity per product, ignoring items we do not sell', () => {
  const s = skusOf([
    { t: "Dr.Bimal's Arjuna Cardio Care Black Leaf Tea 100g", q: 2 },
    { t: 'Shipping protection', q: 1 },
    { t: "Dr.Bimal's Arjuna Cardio Care Black Leaf Tea 250g", q: 1 },   // same product again: quantities add up
  ]);
  assert.deepEqual(s, [{ key: 'black_leaf', name: 'Black Leaf Tea', qty: 3 }]);
  assert.deepEqual(skusOf(null), []);
  assert.equal(skusOf([{ t: PRODUCTS[0].prefix, q: 0 }])[0].qty, 1);
});

const order = (skus, status, calls) => ({ skus, status, calls, team: 'CC' });

test('by-SKU table counts orders, units and the 1 / 2 / 3+ quantity split', () => {
  const rows = [
    order([{ key: 'black_leaf', qty: 1 }], 'confirmed', ['confirmed']),
    order([{ key: 'black_leaf', qty: 2 }], 'confirmed', ['dnp', 'confirmed']),
    order([{ key: 'black_leaf', qty: 3 }], 'cancelled', ['cancelled']),
    order([{ key: 'arjuna_cardio', qty: 1 }], 'pending', []),
    order([{ key: 'arjuna_cardio', qty: 1 }, { key: 'black_leaf', qty: 1 }], 'pending', ['dnp']),   // contains two products
  ];
  const t = buildBySku(rows);
  const bl = t.rows.find(r => r.key === 'black_leaf');
  assert.equal(bl.orders, 4);
  assert.equal(bl.units, 7);
  assert.deepEqual([bl.qty1, bl.qty2, bl.qty3_plus], [2, 1, 1]);
  assert.equal(bl.confirmed, 2);
  assert.equal(bl.confirmed_pct, 50);
  assert.equal(bl.not_connected, 1);
  const ac = t.rows.find(r => r.key === 'arjuna_cardio');
  assert.equal(ac.orders, 2);
  assert.equal(t.total_units, 9);
  assert.equal(t.rows[0].key, 'black_leaf');           // busiest product first
});
