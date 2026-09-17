'use strict';
const express = require('express');
const path = require('path');
const crypto = require('crypto');

const { signToken, parseToken, checkPin } = require('./lib/auth');
const { validateAction } = require('./lib/validate');

const PORT = Number(process.env.PORT) || 3000;
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL || '';
const SHARED_SECRET = process.env.SHARED_SECRET || '';
const MORAN_PIN = process.env.MORAN_PIN || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const SESSION_DAYS = Number(process.env.SESSION_DAYS) || 7;
// Optional: the hadrachot app's read-only first-hadracha status feed. The
// browser NEVER calls it directly and never sees the secret — the proxy
// below adds it server-side. Unset = feature off (the client shows nothing).
const HADRACHOT_STATUS_URL = process.env.HADRACHOT_STATUS_URL || '';
const HADRACHOT_STATUS_SECRET = process.env.HADRACHOT_STATUS_SECRET || '';

function fatal(msg) {
  console.error(`[fatal] ${msg}`);
  process.exit(1);
}

// In production, demand all secrets at startup. In tests, the module is
// required without these set — skip the check by inspecting NODE_ENV.
if (process.env.NODE_ENV !== 'test' && require.main === module) {
  if (!APPS_SCRIPT_URL) fatal('APPS_SCRIPT_URL is required');
  if (!SHARED_SECRET) fatal('SHARED_SECRET is required');
  if (!MORAN_PIN) fatal('MORAN_PIN is required');
  if (!SESSION_SECRET) fatal('SESSION_SECRET is required');
  if (SESSION_SECRET.length < 32) fatal('SESSION_SECRET must be at least 32 chars');
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

// ---- security headers ----
// The app is one HTML page with a large inline <script> and inline styles, so
// the CSP has to allow 'unsafe-inline' for both. That is a real weakening of
// what a CSP can do about injected script, and it is stated rather than
// papered over: the value here is the rest of the policy — no external
// script or style source, no framing, no object, and connections only to our
// own origin, which is where the /api routes live. Moving the inline script
// to a file with a nonce is a worthwhile follow-up, not a Phase 2 change.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  // The app holds salary data; a referrer must never carry a path to a third
  // party, and there is nowhere legitimate for one to go.
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  // Railway terminates TLS in front of us, so HSTS is safe to assert.
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

// ---- static (public) but gate the index ----
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
// expose only the shared client-safe helper (calc.js).
// Server-only modules in lib/ (auth.js, validate.js) MUST NOT be exposed.
app.get('/lib/calc.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'lib', 'calc.js'));
});
// The monthly cost engine. Same rule as calc.js: it is pure, client-safe
// arithmetic over data the browser already holds, and contains no secret.
app.get('/lib/cost-engine.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'lib', 'cost-engine.js'));
});
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---- health ----
app.get('/api/health', (req, res) => {
  res.json({ ok: true, t: Date.now() });
});

// ---- login: rate limit + escalating brute-force lockout ----
//
// Two layers, because one was not enough:
//   1. A per-IP window: LOGIN_MAX wrong PINs inside LOGIN_WINDOW_MS locks
//      that IP out. A CORRECT PIN clears the counter, so Moran mistyping
//      twice and then getting it right leaves no residue.
//   2. Escalation: each further lockout for the same IP doubles the lockout,
//      15 min → 30 → 60 … capped at LOCKOUT_MAX_MS. A patient attacker gets
//      a handful of guesses per day instead of 8 per quarter hour.
//
// Counted state is per-process and a Railway restart clears it — the same
// honest limit as session revocation, and stated for the same reason. The PIN
// is short, which is exactly why the lockout escalates.
const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX = 8;
const LOCKOUT_BASE_MS = 15 * 60 * 1000;
const LOCKOUT_MAX_MS = 24 * 60 * 60 * 1000;
// Bound the map so a spray of spoofed source addresses cannot grow it
// without limit. Oldest entries are dropped first.
const LOGIN_ATTEMPTS_MAX_KEYS = 5000;

function loginEntry(ip) {
  let e = loginAttempts.get(ip);
  if (!e) {
    // Evict until we are under the cap, not just once: a single eviction
    // per insert bounds ordinary growth but can never bring an
    // already-oversized map back down.
    while (loginAttempts.size >= LOGIN_ATTEMPTS_MAX_KEYS) {
      const oldest = loginAttempts.keys().next().value;
      if (oldest === undefined) break;
      loginAttempts.delete(oldest);
    }
    e = { count: 0, windowEndsAt: 0, lockedUntil: 0, lockouts: 0 };
    loginAttempts.set(ip, e);
  }
  return e;
}

// Returns null when the attempt may proceed, or the seconds still to wait.
function loginLockRemaining(ip) {
  const e = loginEntry(ip);
  const now = Date.now();
  if (e.lockedUntil > now) return Math.ceil((e.lockedUntil - now) / 1000);
  return null;
}

function recordLoginFailure(ip) {
  const e = loginEntry(ip);
  const now = Date.now();
  if (now > e.windowEndsAt) {
    e.count = 0;
    e.windowEndsAt = now + LOGIN_WINDOW_MS;
  }
  e.count++;
  if (e.count >= LOGIN_MAX) {
    const ms = Math.min(LOCKOUT_BASE_MS * Math.pow(2, e.lockouts), LOCKOUT_MAX_MS);
    e.lockedUntil = now + ms;
    e.lockouts++;
    e.count = 0;
    e.windowEndsAt = now + LOGIN_WINDOW_MS;
  }
}

function recordLoginSuccess(ip) {
  loginAttempts.delete(ip);
}

app.post('/api/login', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const wait = loginLockRemaining(ip);
  if (wait !== null) {
    res.setHeader('Retry-After', String(wait));
    return res.status(429).json({ error: 'יותר מדי ניסיונות. נסי שוב מאוחר יותר.' });
  }
  const pin = (req.body && req.body.pin) || '';
  if (!checkPin(String(pin), MORAN_PIN)) {
    recordLoginFailure(ip);
    // Never says whether the PIN was the wrong length, nor how many tries
    // are left — both are free information for a guesser.
    return res.status(401).json({ error: 'קוד שגוי' });
  }
  recordLoginSuccess(ip);
  const token = signToken(SESSION_SECRET, SESSION_DAYS);
  res.json({ token, expiresInDays: SESSION_DAYS });
});

// ---- session revocation ----
// jti → the token's own expiry. A revoked jti is refused until it would have
// expired anyway, at which point it is pruned: the set cannot grow without
// bound because every entry has a deadline. Per-process (see lib/auth.js).
const revokedSessions = new Map();

function pruneRevoked() {
  const now = Date.now();
  revokedSessions.forEach((expiresAt, jti) => {
    if (expiresAt <= now) revokedSessions.delete(jti);
  });
}

function isRevoked(jti) {
  const expiresAt = revokedSessions.get(jti);
  if (expiresAt === undefined) return false;
  if (expiresAt <= Date.now()) {
    revokedSessions.delete(jti);
    return false;
  }
  return true;
}

function bearerToken(req) {
  const h = req.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1] : '';
}

// ---- auth middleware for /api/data and /api/action ----
function requireAuth(req, res, next) {
  const session = parseToken(SESSION_SECRET, bearerToken(req), isRevoked);
  if (!session) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  req.session = session;
  next();
}

// ---- logout: actually invalidates the session ----
// Before this existed, "logout" only cleared localStorage — the token stayed
// valid for its full lifetime. Idempotent, and answers 200 even for a token
// that is already invalid so the client can always complete a sign-out.
app.post('/api/logout', (req, res) => {
  pruneRevoked();
  const session = parseToken(SESSION_SECRET, bearerToken(req), isRevoked);
  if (session) revokedSessions.set(session.jti, session.expiresAt);
  res.json({ ok: true });
});

// ---- Apps Script proxy ----
async function callAppsScript(method, body) {
  if (!APPS_SCRIPT_URL || !SHARED_SECRET) {
    throw Object.assign(new Error('server misconfigured'), { status: 500 });
  }
  const sep = APPS_SCRIPT_URL.includes('?') ? '&' : '?';
  const url = `${APPS_SCRIPT_URL}${sep}secret=${encodeURIComponent(SHARED_SECRET)}`;
  const init = {
    method,
    redirect: 'follow',
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) init.body = JSON.stringify(body);

  const resp = await fetch(url, init);
  const text = await resp.text();
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (e) {
    throw Object.assign(new Error('upstream non-JSON: ' + text.slice(0, 200)), { status: 502 });
  }
  const status = Number(parsed._status) || 200;
  delete parsed._status;
  if (status >= 400) {
    const err = new Error(parsed.error || 'upstream error');
    err.status = status;
    err.body = parsed;
    throw err;
  }
  return parsed;
}

// What the browser is told when an upstream call fails.
//
// A 4xx from Apps Script is a VALIDATION result — short, deliberate, often
// Hebrew, and written to be shown to Moran verbatim ('העובד/ת אינו/ה
// משובץ/ת בבית הנבחר'). Those are relayed.
//
// A 5xx is an internal failure, and its message can carry up to 200
// characters of whatever Apps Script returned — including Google's sign-in
// HTML when a deployment loses anonymous access. Those get a generic Hebrew
// sentence; the detail stays in the Railway log, where it is useful and not
// public. Any extra keys the upstream attached (duplicates, conflictId) ride
// along on a 4xx so the UI can act on them.
function sendUpstreamError(res, err, tag) {
  const status = err.status || 500;
  console.error(tag, status, err.message);
  if (status >= 400 && status < 500) {
    const body = Object.assign({}, err.body || {}, { error: err.message });
    delete body._status;
    return res.status(status).json(body);
  }
  return res.status(status).json({ error: 'שגיאה בשרת. נסי שוב בעוד רגע.' });
}

app.get('/api/data', requireAuth, async (req, res) => {
  try {
    const data = await callAppsScript('GET');
    res.json(data);
  } catch (err) {
    sendUpstreamError(res, err, '[GET /api/data]');
  }
});

// ---- first-hadracha status (optional, read-only) ----
// Proxies the hadrachot app's status feed for the dashboard banner. Deliberate
// contract with the client: when the feature is unconfigured (URL or secret
// missing) it answers 200 { configured: false }, and any upstream failure is a
// 5xx — in BOTH cases the client renders nothing rather than false alerts.
// All flag logic (7-day rule etc.) lives in the frontend; this route only
// relays the payload verbatim under `data`, never interpreting it.
app.get('/api/hadrachot-status', requireAuth, async (req, res) => {
  if (!HADRACHOT_STATUS_URL || !HADRACHOT_STATUS_SECRET) {
    return res.json({ configured: false });
  }
  try {
    const sep = HADRACHOT_STATUS_URL.includes('?') ? '&' : '?';
    const url = `${HADRACHOT_STATUS_URL}${sep}secret=${encodeURIComponent(HADRACHOT_STATUS_SECRET)}`;
    const resp = await fetch(url, { redirect: 'follow' });
    const text = await resp.text();
    let parsed;
    try { parsed = JSON.parse(text); }
    catch (e) {
      throw Object.assign(new Error('upstream non-JSON'), { status: 502 });
    }
    const status = Number(parsed._status) || (resp.ok ? 200 : resp.status || 502);
    delete parsed._status;
    if (status >= 400) {
      throw Object.assign(new Error('upstream error ' + status), { status: 502 });
    }
    res.json({ configured: true, data: parsed });
  } catch (err) {
    console.error('[GET /api/hadrachot-status]', err.status || 502, err.message);
    // Generic body on purpose — never echo upstream details to the browser.
    res.status(err.status || 502).json({ error: 'hadrachot status unavailable' });
  }
});

app.post('/api/action', requireAuth, async (req, res) => {
  let payload;
  try {
    payload = validateAction(req.body || {});
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }
  try {
    const result = await callAppsScript('POST', payload);
    res.json(result);
  } catch (err) {
    sendUpstreamError(res, err, '[POST /api/action]');
  }
});

// ---- 404 fallback for /api ----
app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

// ---- start ----
if (require.main === module) {
  // Bind explicitly to 0.0.0.0 so Railway's edge router can reach us.
  // Without an explicit host, Node's default in some environments is
  // ::1/127.0.0.1, which passes the internal healthcheck (same container)
  // but is unreachable from outside.
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`E-ZONE staffing server listening on 0.0.0.0:${PORT} (PORT=${PORT}, process.env.PORT=${process.env.PORT || '<unset>'})`);
  });
}

module.exports = {
  app, callAppsScript,
  _loginAttempts: loginAttempts,
  _revokedSessions: revokedSessions,
};
