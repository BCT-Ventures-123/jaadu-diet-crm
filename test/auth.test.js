const test = require('node:test');
const assert = require('node:assert');
const a = require('../lib/auth');

test('password hash verifies and is salted', async () => {
  const h1 = await a.hashPassword('correct horse');
  const h2 = await a.hashPassword('correct horse');
  assert.notEqual(h1, h2);
  assert.ok(!h1.includes('correct horse'));
  assert.equal(await a.verifyPassword('correct horse', h1), true);
  assert.equal(await a.verifyPassword('wrong', h1), false);
  assert.equal(await a.verifyPassword('x', 'garbage'), false);
});

test('token roundtrip, tamper and expiry', () => {
  const t = a.signToken({ id: 1, v: 0, exp: Date.now() + 1000 }, 'secret');
  assert.equal(a.verifyToken(t, 'secret').id, 1);
  assert.equal(a.verifyToken(t, 'other'), null);
  assert.equal(a.verifyToken(t + 'x', 'secret'), null);
  assert.equal(a.verifyToken(t, 'secret', Date.now() + 5000), null);
});

test('generated password is strong enough and cookies parse', () => {
  assert.equal(a.checkPasswordStrength(a.generatePassword()), null);
  assert.ok(a.checkPasswordStrength('short'));
  assert.equal(a.parseCookies('a=1; jd_session=abc').jd_session, 'abc');
});
