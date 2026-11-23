const test = require('node:test');
const assert = require('node:assert');
const { canOpen, homeFor, isGuardedPage } = require('../lib/access');

test('admin opens every page', () => {
  ['/', '/index.html', '/admin.html', '/aman-crm.html', '/cc-crm.html'].forEach(p => assert.equal(canOpen('admin', p), true, p));
});

test('aman opens his CRM and the call-centre CRM only', () => {
  assert.equal(canOpen('aman', '/aman-crm.html'), true);
  assert.equal(canOpen('aman', '/cc-crm.html'), true);
  assert.equal(canOpen('aman', '/admin.html'), false);
  assert.equal(canOpen('aman', '/'), false);
});

test('call-centre agent opens only the call-centre CRM', () => {
  assert.equal(canOpen('agent', '/cc-crm.html'), true);
  assert.equal(canOpen('agent', '/aman-crm.html'), false);
  assert.equal(canOpen('agent', '/admin.html'), false);
});

test('home page per role and unknown roles', () => {
  assert.equal(homeFor('admin'), '/admin.html');
  assert.equal(homeFor('aman'), '/aman-crm.html');
  assert.equal(homeFor('agent'), '/cc-crm.html');
  assert.equal(canOpen('nobody', '/cc-crm.html'), false);
  assert.equal(isGuardedPage('/login.html'), false);
});
