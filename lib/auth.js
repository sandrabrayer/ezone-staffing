'use strict';
const crypto = require('crypto');

const DEFAULT_DAYS = 7;

// A session token is `<expiresAt>.<jti>.<hmac>`.
//
// The `jti` (a random 16-byte id) exists so a session can be REVOKED. Before
// Phase 2 the payload was `moran:<expiresAt>` and nothing else: two logins in
// the same millisecond produced the same token, logout only cleared
// localStorage, and a copied token stayed valid for its full 7 days with no
// way to stop it short of rotating SESSION_SECRET. Now logout adds the jti to
// a revocation set and the token stops working.
//
// KNOWN LIMIT, deliberately not hidden: the revocation set lives in process
// memory, so a Railway restart forgets it and a revoked-but-unexpired token
// works again. Rotating SESSION_SECRET remains the hard revocation. For a
// single-user app with no database this is the honest trade; the alternative
// is a Sheets round-trip on every request.
//
// Tokens issued by the previous format are NOT accepted — the shape changed,
// so Moran re-enters her PIN once after deploy. That is the safe direction.

function signToken(secret, days) {
  if (!secret) throw new Error('SESSION_SECRET is not set');
  const ttlMs = (Number(days) || DEFAULT_DAYS) * 24 * 60 * 60 * 1000;
  const expiresAt = Date.now() + ttlMs;
  const jti = crypto.randomBytes(16).toString('hex');
  return `${expiresAt}.${jti}.${hmac(secret, expiresAt, jti)}`;
}

function hmac(secret, expiresAt, jti) {
  return crypto.createHmac('sha256', secret)
    .update(`moran:${expiresAt}:${jti}`)
    .digest('hex');
}

// Parses and verifies a token. Returns { expiresAt, jti } when valid, or
// null. `isRevoked` is an optional predicate over the jti so the caller owns
// the revocation store.
function parseToken(secret, token, isRevoked) {
  if (!secret || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [expiresRaw, jti, sig] = parts;
  const expiresAt = Number(expiresRaw);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return null;
  if (!/^[0-9a-f]{32}$/.test(jti)) return null;
  if (!/^[0-9a-f]{64}$/.test(sig)) return null;
  const expected = hmac(secret, expiresRaw, jti);
  // Both are fixed-length lowercase hex by the checks above, so the buffers
  // are always the same length and timingSafeEqual cannot throw.
  if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) {
    return null;
  }
  if (typeof isRevoked === 'function' && isRevoked(jti)) return null;
  return { expiresAt, jti };
}

function verifyToken(secret, token, isRevoked) {
  return parseToken(secret, token, isRevoked) !== null;
}

function checkPin(input, expected) {
  if (typeof input !== 'string' || typeof expected !== 'string') return false;
  if (!expected) return false;
  const a = Buffer.from(input);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { signToken, verifyToken, parseToken, checkPin };
