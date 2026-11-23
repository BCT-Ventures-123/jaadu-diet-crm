// The products the business sells (one place), the minimum order value, and helpers to read an order's items.
// Orders that contain none of these products, or are below MIN_PRICE, are not real tea orders
// (fee / transaction-only orders, other stores' products) and are left out of reports.
const PRODUCTS = [
  { key: 'arjuna_cardio', name: 'Arjuna Cardio Tea', prefix: "Dr. Bimal's Arjuna Cardio Care Tea with Ashwagandha, Shankhpushpi & Daalchini" },
  { key: 'arjuna_black', name: 'Arjuna Cardio Black Tea', prefix: "Dr. Bimal's Arjuna Cardio Care Black Tea with Ashwagandha, Brahmi & Daalchini" },
  { key: 'black_leaf', name: 'Black Leaf Tea', prefix: "Dr.Bimal's Arjuna Cardio Care Black Leaf Tea" },
  { key: 'bundle2', name: 'Bundle of 2', prefix: "Bundle of 2 - Dr. Bimal's Arjuna Cardio Care Tea" },
  { key: 'bundle3', name: 'Bundle of 3', prefix: "Bundle of 3 - Dr. Bimal's Arjuna Cardio Care Tea" },
];
const ALLOWED_PREFIXES = PRODUCTS.map(p => p.prefix);
const MIN_PRICE = 350;

const keyOfTitle = (title) => {
  const t = String(title || '');
  const p = PRODUCTS.find(x => t.startsWith(x.prefix));
  return p ? p.key : null;
};
const productByKey = (key) => PRODUCTS.find(p => p.key === key) || null;

// items: [{ t: title, q: quantity }] (as built in the SQL) -> one entry per product line that we sell.
function skusOf(items) {
  const out = new Map();
  for (const it of Array.isArray(items) ? items : []) {
    const key = keyOfTitle(it.t);
    if (!key) continue;
    out.set(key, (out.get(key) || 0) + (Number(it.q) > 0 ? Number(it.q) : 1));
  }
  return [...out.entries()].map(([key, qty]) => ({ key, name: productByKey(key).name, qty }));
}

module.exports = { PRODUCTS, ALLOWED_PREFIXES, MIN_PRICE, keyOfTitle, productByKey, skusOf };
