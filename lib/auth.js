const crypto = require('crypto');

// ---------- Passwords (scrypt, built into Node, no extra dependency) ----------
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, (err, key) => {
      if (err) return reject(err);
      resolve(`scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`);
    });
  });
}

function verifyPassword(password, stored) {
  return new Promise((resolve) => {
    try {
      const [scheme, N, r, p, saltB64, keyB64] = String(stored || '').split('$');
      if (scheme !== 'scrypt') return resolve(false);
      const salt = Buffer.from(saltB64, 'base64');
      const expected = Buffer.from(keyB64, 'base64');
      crypto.scrypt(String(password), salt, expected.length, { N: Number(N), r: Number(r), p: Number(p) }, (err, key) => {
        if (err) return resolve(false);
        resolve(key.length === expected.length && crypto.timingSafeEqual(key, expected));
      });
    } catch (e) { resolve(false); }
  });
}

function checkPasswordStrength(pw) {
  if (!pw || pw.length < 8) return 'Password must be at least 8 characters';
  return null;
}

function generatePassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(12);
  return Array.from(bytes, b => alphabet[b % alphabet.length]).join('');
}

// ---------- Signed session tokens ----------
// token = base64url(payload).base64url(hmac). Payload: { id, v (token_version), exp }.
const b64 = (buf) => Buffer.from(buf).toString('base64url');

function signToken(payload, secret) {
  const body = b64(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyToken(token, secret, now = Date.now()) {
  if (!token || !secret || typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < now) return null;
    return payload;
  } catch (e) { return null; }
}

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

module.exports = { hashPassword, verifyPassword, checkPasswordStrength, generatePassword, signToken, verifyToken, parseCookies };
