const test = require('node:test');
const assert = require('node:assert');
const { isShortAddress, fullAddressOf } = require('../lib/address');

test('complete addresses without a house/flat/near word are no longer flagged', () => {
  for (const a of [
    'Vill Rampur Post Sadar Dist Bareilly Uttar Pradesh',
    'Ward no 5 Ramnagar Colony Main Road Kota Rajasthan',
    '12 MG Road Indore Madhya Pradesh',
    'Radha Residency Tower B 402 Andheri West Mumbai Maharashtra',
    'Tilak Nagar Main Road Ludhiana Punjab',
    'Mohalla Chaudhary Tola Kishanganj Bihar',
  ]) assert.equal(isShortAddress(a), false, a);
});

test('really short addresses are still flagged', () => {
  assert.equal(isShortAddress('Flat 5 Andheri Mumbai'), true);        // 21 characters
  assert.equal(isShortAddress('Andheri West Mumbai Maharashtra'), false);
  assert.equal(isShortAddress('Rampur UP'), true);
  assert.equal(isShortAddress('Main Road Kota Raj'), true);
  assert.equal(isShortAddress(''), true);
  assert.equal(isShortAddress(null), true);
  assert.equal(isShortAddress('   '), true);
});

test('too few words is short even when long enough', () => {
  assert.equal(isShortAddress('Maharashtra-Mumbai-Andheri-WestDistrictXYZ'), true);
});

test('the old strict rule can be switched back on', () => {
  assert.equal(isShortAddress('Tilak Nagar Main Road Ludhiana Punjab', { requirePremise: true }), true);
  assert.equal(isShortAddress('Gandhi Chowk Near Bus Stand Patna Bihar', { requirePremise: true }), false);
});

test('the checked text is address lines + city + state, like at order arrival', () => {
  assert.equal(fullAddressOf({ shipping_address1: 'Flat 5', shipping_address2: null, shipping_city: 'Andheri', shipping_province: 'Maharashtra' }), 'Flat 5 Andheri Maharashtra');
});
