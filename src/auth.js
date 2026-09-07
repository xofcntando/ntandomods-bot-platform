// ── Auth primitives: scrypt passwords, HS256 JWTs, API keys, rate limiting ──
'use strict';

const crypto = require('crypto');

// ── passwords: scrypt with per-password salt → "salt:hash" (hex) ──
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  try {
    const [saltHex, hashHex] = String(stored).split(':');
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(String(password), salt, expected.length);
    return crypto.timingSafeEqual(actual, expected);
  } catch (_) {
    return false;
  }
}

// ── minimal HS256 JWT (no external library) ──────────────────────
function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

function signToken(payload, secret, ttlSec = 24 * 60 * 60) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const body = b64url(JSON.stringify({ ...payload, iat: now, exp: now + ttlSec }));
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

function verifyToken(token, secret) {
  try {
    const [h, b, s] = String(token).split('.');
    if (!h || !b || !s) return null;
    const expected = crypto.createHmac('sha256', secret).update(`${h}.${b}`).digest('base64url');
    const a = Buffer.from(s);
    const e = Buffer.from(expected);
    if (a.length !== e.length || !crypto.timingSafeEqual(a, e)) return null;
    const payload = JSON.parse(Buffer.from(b, 'base64url').toString('utf8'));
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

// ── API keys: "ntando_<random>" shown once, stored as SHA-256 hash ──
function generateApiKey() {
  return 'ntando_' + crypto.randomBytes(24).toString('base64url');
}
function hashApiKey(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex');
}
function keyPrefix(key) {
  return String(key).slice(0, 13);
}

// ── sliding-window rate limiter (per IP) ─────────────────────────
class RateLimiter {
  constructor(max, windowMs) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map(); // ip → timestamps
  }

  check(ip) {
    const now = Date.now();
    let arr = this.hits.get(ip);
    if (!arr) {
      arr = [];
      this.hits.set(ip, arr);
    }
    arr = arr.filter((t) => now - t < this.windowMs);
    if (arr.length >= this.max) {
      this.hits.set(ip, arr);
      return { ok: false, retryAfterMs: Math.max(1000, this.windowMs - (now - arr[0])) };
    }
    arr.push(now);
    this.hits.set(ip, arr);
    if (this.hits.size > 5000) { // garbage-collect cold entries
      for (const [k, v] of this.hits) {
        if (!v.some((t) => now - t < this.windowMs)) this.hits.delete(k);
      }
    }
    return { ok: true, remaining: this.max - arr.length };
  }
}

module.exports = {
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  generateApiKey,
  hashApiKey,
  keyPrefix,
  RateLimiter,
};
