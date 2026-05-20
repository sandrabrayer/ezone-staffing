'use strict';
const crypto = require('crypto');

const DEFAULT_DAYS = 7;

function signToken(secret, days) {
  if (!secret) throw new Error('SESSION_SECRET is not set');
  const ttlMs = (Number(days) || DEFAULT_DAYS) * 24 * 60 * 60 * 1000;
  const expiresAt = Date.now() + ttlMs;
  const payload = `moran:${expiresAt}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `${expiresAt}.${sig}`;
}

function verifyToken(secret, token) {
  if (!secret || typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot < 0) return false;
  const expiresAt = Number(token.slice(0, dot));
  const sig = token.slice(dot + 1);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`moran:${expiresAt}`)
    .digest('hex');
  if (sig.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
}

function checkPin(input, expected) {
  if (typeof input !== 'string' || typeof expected !== 'string') return false;
  if (!expected) return false;
  const a = Buffer.from(input);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { signToken, verifyToken, checkPin };
