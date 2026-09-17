'use strict';

// Phase 2 — the security hardening from docs/STAFFING_AUDIT.md findings
// A3 (brute-force lockout), A4 (session revocation), A5 (error bodies) and
// A6 (security headers).

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.NODE_ENV = 'test';
process.env.APPS_SCRIPT_URL = 'https://script.example.com/exec';
process.env.SHARED_SECRET = 's'.repeat(40);
process.env.MORAN_PIN = '4242';
process.env.SESSION_SECRET = 'x'.repeat(64);

const { app, _loginAttempts, _revokedSessions } = require('../server');
const { signToken, parseToken } = require('../lib/auth');

const originalFetch = global.fetch;

function listen() {
  return new Promise(resolve => {
    const srv = http.createServer(app).listen(0, '127.0.0.1', () => {
      resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` });
    });
  });
}
async function close(srv) { await new Promise(r => srv.close(r)); }

async function raw(base, path, opts) {
  const resp = await originalFetch(base + path, opts || {});
  const text = await resp.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  return { status: resp.status, json, headers: resp.headers };
}

function reset() {
  _loginAttempts.clear();
  _revokedSessions.clear();
}

async function login(base, pin) {
  return raw(base, '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: pin === undefined ? '4242' : pin }),
  });
}

// ---------------------------------------------------------------------------
// A6 — security headers
// ---------------------------------------------------------------------------

test('every response carries the security headers', async () => {
  reset();
  const { srv, base } = await listen();
  try {
    for (const path of ['/', '/api/health']) {
      const r = await raw(base, path);
      const h = r.headers;
      assert.equal(h.get('x-content-type-options'), 'nosniff', path);
      assert.equal(h.get('x-frame-options'), 'DENY', path);
      assert.equal(h.get('referrer-policy'), 'no-referrer', path);
      assert.match(h.get('strict-transport-security') || '', /max-age=31536000/, path);
      const csp = h.get('content-security-policy') || '';
      assert.match(csp, /default-src 'self'/, path);
      assert.match(csp, /frame-ancestors 'none'/, path);
      assert.match(csp, /object-src 'none'/, path);
      assert.equal(h.get('x-powered-by'), null, 'express must not announce itself');
    }
  } finally { await close(srv); }
});

// ---------------------------------------------------------------------------
// A3 — brute-force lockout
// ---------------------------------------------------------------------------

test('a wrong PIN never says how wrong it was, or how many tries are left', async () => {
  reset();
  const { srv, base } = await listen();
  try {
    const short = await login(base, '1');
    const long = await login(base, '999999999999');
    const wrong = await login(base, '4243');
    assert.equal(short.status, 401);
    assert.equal(long.status, 401);
    assert.equal(wrong.status, 401);
    // Byte-identical bodies: the length of the PIN must not be inferable.
    assert.deepEqual(short.json, wrong.json);
    assert.deepEqual(long.json, wrong.json);
    assert.equal(JSON.stringify(wrong.json).includes('4242'), false, 'never echo the PIN');
  } finally { await close(srv); }
});

test('eight wrong PINs lock the caller out, with a Retry-After', async () => {
  reset();
  const { srv, base } = await listen();
  try {
    for (let i = 0; i < 7; i++) {
      assert.equal((await login(base, '0000')).status, 401, 'attempt ' + (i + 1));
    }
    // The 8th failure trips the lockout; the 9th call is refused outright.
    assert.equal((await login(base, '0000')).status, 401);
    const locked = await login(base, '0000');
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.headers.get('retry-after')) > 0, 'tells the client when to come back');
    // And the CORRECT PIN is refused too while locked out — otherwise the
    // lockout would be trivially bypassed by the attacker who just found it.
    assert.equal((await login(base)).status, 429);
  } finally { await close(srv); }
});

test('the lockout escalates: each further lockout is longer than the last', async () => {
  reset();
  const { srv, base } = await listen();
  try {
    async function tripLockout() {
      for (let i = 0; i < 8; i++) await login(base, '0000');
      const r = await login(base, '0000');
      assert.equal(r.status, 429);
      return Number(r.headers.get('retry-after'));
    }
    const first = await tripLockout();
    // Clear only the lock clock, keeping the escalation counter, the way
    // time passing would.
    const entry = [..._loginAttempts.values()][0];
    entry.lockedUntil = 0;
    const second = await tripLockout();
    assert.ok(second > first,
      `a second lockout must be longer than the first (${first}s then ${second}s)`);
  } finally { await close(srv); }
});

test('a correct PIN clears the failure counter, so mistyping leaves no residue', async () => {
  reset();
  const { srv, base } = await listen();
  try {
    for (let i = 0; i < 5; i++) await login(base, '0000');
    assert.equal((await login(base)).status, 200, 'still allowed after 5 failures');
    // Counter cleared: a fresh run of 7 failures must not trip the lockout.
    for (let i = 0; i < 7; i++) {
      assert.equal((await login(base, '0000')).status, 401);
    }
    assert.equal((await login(base)).status, 200, 'the counter really was reset');
  } finally { await close(srv); }
});

test('the attempt map is bounded, so spoofed sources cannot grow it forever', async () => {
  reset();
  const { srv, base } = await listen();
  try {
    // Reach in rather than forging 5001 source addresses over the wire.
    for (let i = 0; i < 6000; i++) {
      _loginAttempts.set('ip-' + i, { count: 0, windowEndsAt: 0, lockedUntil: 0, lockouts: 0 });
    }
    await login(base, '0000');
    assert.ok(_loginAttempts.size <= 5001, 'size stayed bounded: ' + _loginAttempts.size);
  } finally { await close(srv); }
});

// ---------------------------------------------------------------------------
// A4 — session revocation
// ---------------------------------------------------------------------------

test('two logins produce two DIFFERENT tokens', async () => {
  reset();
  const { srv, base } = await listen();
  try {
    const a = (await login(base)).json.token;
    const b = (await login(base)).json.token;
    assert.notEqual(a, b, 'a token carries its own random id, so it is unique per login');
  } finally { await close(srv); }
});

test('logout REVOKES the session: the same token stops working', async () => {
  reset();
  const { srv, base } = await listen();
  try {
    const token = (await login(base)).json.token;
    const headers = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };

    // Proves the token worked before logout: /api/data is behind requireAuth,
    // so a 401 here would mean "rejected", and anything else means "accepted"
    // (the upstream is not stubbed in this file, so it fails at the proxy).
    const before = await raw(base, '/api/data', { headers });
    assert.notEqual(before.status, 401, 'the token is accepted before logout');

    const out = await raw(base, '/api/logout', { method: 'POST', headers });
    assert.equal(out.status, 200);

    const after = await raw(base, '/api/data', { headers });
    assert.equal(after.status, 401, 'and refused after');
  } finally { await close(srv); }
});

test('logout is idempotent and never fails a sign-out', async () => {
  reset();
  const { srv, base } = await listen();
  try {
    const token = (await login(base)).json.token;
    const headers = { 'Authorization': 'Bearer ' + token };
    assert.equal((await raw(base, '/api/logout', { method: 'POST', headers })).status, 200);
    assert.equal((await raw(base, '/api/logout', { method: 'POST', headers })).status, 200);
    // Even with no token at all, so the client can always complete.
    assert.equal((await raw(base, '/api/logout', { method: 'POST' })).status, 200);
    assert.equal((await raw(base, '/api/logout', {
      method: 'POST', headers: { 'Authorization': 'Bearer nonsense' } })).status, 200);
  } finally { await close(srv); }
});

test('revoking one session does not touch another', async () => {
  reset();
  const { srv, base } = await listen();
  try {
    const a = (await login(base)).json.token;
    const b = (await login(base)).json.token;
    await raw(base, '/api/logout', { method: 'POST', headers: { 'Authorization': 'Bearer ' + a } });
    assert.equal((await raw(base, '/api/data',
      { headers: { 'Authorization': 'Bearer ' + a } })).status, 401);
    assert.notEqual((await raw(base, '/api/data',
      { headers: { 'Authorization': 'Bearer ' + b } })).status, 401);
  } finally { await close(srv); }
});

test('the revocation set is pruned, so it cannot grow without bound', async () => {
  reset();
  const { srv, base } = await listen();
  try {
    // A revoked entry whose own expiry has passed is dropped on the next
    // logout, because it can never be presented successfully again anyway.
    _revokedSessions.set('a'.repeat(32), Date.now() - 1000);
    const token = (await login(base)).json.token;
    await raw(base, '/api/logout', { method: 'POST', headers: { 'Authorization': 'Bearer ' + token } });
    assert.equal(_revokedSessions.has('a'.repeat(32)), false, 'the stale entry was pruned');
    assert.equal(_revokedSessions.size, 1, 'only the live revocation remains');
  } finally { await close(srv); }
});

// ---------------------------------------------------------------------------
// token integrity
// ---------------------------------------------------------------------------

test('a tampered token is refused, in every part', async () => {
  const secret = 'x'.repeat(64);
  const token = signToken(secret, 7);
  const [expires, jti, sig] = token.split('.');
  assert.ok(parseToken(secret, token), 'the real token parses');

  // A forged expiry invalidates the signature.
  assert.equal(parseToken(secret, `${Number(expires) + 86400000}.${jti}.${sig}`), null);
  // A swapped jti invalidates it too — so a token cannot be re-pointed at
  // another session to dodge a revocation.
  assert.equal(parseToken(secret, `${expires}.${'b'.repeat(32)}.${sig}`), null);
  // A flipped signature byte.
  const flipped = sig[0] === '0' ? '1' + sig.slice(1) : '0' + sig.slice(1);
  assert.equal(parseToken(secret, `${expires}.${jti}.${flipped}`), null);
  // Another secret.
  assert.equal(parseToken('y'.repeat(64), token), null);
  // Malformed shapes, including the PREVIOUS two-part format.
  ['', 'x', `${expires}.${sig}`, `${expires}.${jti}`, `${expires}.${jti}.${sig}.extra`,
    `${expires}.NOTHEX..${sig}`].forEach(t => {
    assert.equal(parseToken(secret, t), null, 'refused: ' + JSON.stringify(t));
  });
});

test('an expired token is refused even though its signature is valid', () => {
  const secret = 'x'.repeat(64);
  // Sign with a negative lifetime: the HMAC is genuine, the clock is not.
  const expiresAt = Date.now() - 1000;
  const crypto = require('node:crypto');
  const jti = crypto.randomBytes(16).toString('hex');
  const sig = crypto.createHmac('sha256', secret)
    .update(`moran:${expiresAt}:${jti}`).digest('hex');
  assert.equal(parseToken(secret, `${expiresAt}.${jti}.${sig}`), null);
});

test('isRevoked is consulted, and a revoked jti is refused', () => {
  const secret = 'x'.repeat(64);
  const token = signToken(secret, 7);
  const { jti } = parseToken(secret, token);
  assert.equal(parseToken(secret, token, id => id === jti), null);
  assert.ok(parseToken(secret, token, () => false));
});

// ---------------------------------------------------------------------------
// A5 — error bodies
// ---------------------------------------------------------------------------

test('a 5xx from upstream reaches the browser as a generic message', async () => {
  reset();
  const { srv, base } = await listen();
  const secretish = process.env.SHARED_SECRET;
  // Upstream returns HTML — what a deployment that lost anonymous access
  // does. Before Phase 2 the first 200 characters of it, and any secret in
  // it, were relayed to the browser verbatim.
  global.fetch = async () => ({
    ok: true, status: 200,
    text: async () => '<html>Sign in to continue ' + secretish + '</html>',
  });
  try {
    const token = (await login(base)).json.token;
    const r = await raw(base, '/api/data', { headers: { 'Authorization': 'Bearer ' + token } });
    assert.equal(r.status, 502);
    const body = JSON.stringify(r.json);
    assert.equal(body.includes(secretish), false, 'no secret may reach the browser');
    assert.equal(body.includes('html'), false, 'no upstream markup either');
    assert.match(r.json.error, /שגיאה בשרת/);
  } finally {
    global.fetch = originalFetch;
    await close(srv);
  }
});

test('a 4xx from upstream IS relayed, with its structured detail', async () => {
  reset();
  const { srv, base } = await listen();
  // A validation result is written to be shown to Moran verbatim, and its
  // extra keys are what the UI acts on.
  global.fetch = async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({
      _status: 409,
      error: 'עובד/ת עם שם או טלפון זהה כבר קיים/ת במערכת',
      duplicates: [{ id: 'w1', name: 'דנה כהן', matchedOn: 'name' }],
    }),
  });
  try {
    const token = (await login(base)).json.token;
    const r = await raw(base, '/api/action', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'createWorker', worker: { name: 'דנה כהן' } }),
    });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /כבר קיים/);
    assert.deepEqual(r.json.duplicates, [{ id: 'w1', name: 'דנה כהן', matchedOn: 'name' }]);
    assert.equal('_status' in r.json, false, 'the internal status marker is stripped');
  } finally {
    global.fetch = originalFetch;
    await close(srv);
  }
});

test('the PIN is never returned by any route, and never logged to a response', async () => {
  reset();
  const { srv, base } = await listen();
  try {
    const ok = await login(base);
    assert.equal(JSON.stringify(ok.json).includes('4242'), false);
    const health = await raw(base, '/api/health');
    assert.equal(JSON.stringify(health.json).includes('4242'), false);
    // And the client-side libraries carry no secret either.
    const engine = await raw(base, '/lib/cost-engine.js');
    assert.equal(engine.status, 200);
    const src = engine.json.raw || '';
    [process.env.SHARED_SECRET, process.env.SESSION_SECRET, process.env.MORAN_PIN]
      .forEach(v => assert.equal(src.includes(v), false, 'no secret in a served lib'));
  } finally { await close(srv); }
});

test('server-only modules are NOT served', async () => {
  reset();
  const { srv, base } = await listen();
  try {
    for (const p of ['/lib/auth.js', '/lib/validate.js', '/server.js', '/.env']) {
      const r = await raw(base, p);
      assert.notEqual(r.status, 200, p + ' must not be served');
    }
  } finally { await close(srv); }
});
