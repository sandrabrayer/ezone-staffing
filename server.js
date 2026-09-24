'use strict';
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const compression = require('compression');

const { signToken, parseToken, checkPin } = require('./lib/auth');
const { validateAction } = require('./lib/validate');
const { createProxyCache } = require('./lib/proxy-cache');
const { createUpstreamQueue, classifyUpstream, fetchWithDeadline } = require('./lib/upstream');
const cacheSnapshot = require('./lib/cache-snapshot');

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

// ---- request timing log ----
// One line per request: method, PATH ONLY (never the query string), status,
// duration and — for cached reads — the cache outcome. Never headers, never
// a body: the login body carries the PIN and responses carry the token and
// salary data. This is what docs/perf-load.md reads its timings from.
app.use((req, res, next) => {
  const t0 = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const xc = res.getHeader('X-Cache');
    console.log(`[timing] ${req.method} ${req.path} ${res.statusCode} ${ms.toFixed(1)}ms` +
      (xc ? ` cache=${xc}` : ''));
  });
  next();
});

// ---- gzip ----
// The page is ~215 KB of HTML + ~125 KB of JS and /api/data is a large JSON
// document; all of it was sent uncompressed. /api/login and /api/logout are
// excluded: tiny bodies, and the login response carries the session token.
app.use(compression({
  filter: (req, res) => {
    if (req.path === '/api/login' || req.path === '/api/logout') return false;
    return compression.filter(req, res);
  },
}));

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

// ---- static shell + PWA files ----
//
// None of these are behind the PIN — the PIN gate is the client-side overlay
// plus requireAuth on /api/data and /api/action, and that is where the data
// lives. The shell, the manifest, the icons and the service worker carry no
// data and MUST be reachable without a session: a browser fetches the
// manifest and icons without credentials, and an install check that gets a
// 401 or an HTML page instead of JSON reports "app can't be installed".
const PUBLIC_DIR = path.join(__dirname, 'public');
const LONG_CACHE = 'public, max-age=31536000, immutable';
const WEEK_CACHE = 'public, max-age=604800';

// The client-safe libraries the page loads. Each is served with a content
// hash in its URL (?v=<hash>), so the browser may keep it for a year and a
// deploy that changes a file changes its URL. Server-only modules in lib/
// (auth.js, validate.js, proxy-cache.js) are NOT exposed.
const CLIENT_LIBS = ['calc.js', 'cost-engine.js', 'exports.js'];
function sha(buf, n) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, n || 12);
}
const LIB_VERSIONS = {};
CLIENT_LIBS.forEach((name) => {
  LIB_VERSIONS[name] = sha(fs.readFileSync(path.join(__dirname, 'lib', name)));
});

// index.html, read once, with the library URLs versioned. Served from memory
// with an ETag and `no-cache`, so every load revalidates (a 304 when nothing
// changed) and a deploy is picked up immediately.
function buildIndexHtml() {
  let html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  CLIENT_LIBS.forEach((name) => {
    html = html.split(`<script src="/lib/${name}"></script>`)
      .join(`<script src="/lib/${name}?v=${LIB_VERSIONS[name]}"></script>`);
  });
  return html;
}
const INDEX_HTML = buildIndexHtml();
const INDEX_ETAG = `"${sha(INDEX_HTML, 16)}"`;

function sendIndex(req, res) {
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('ETag', INDEX_ETAG);
  if (req.get('if-none-match') === INDEX_ETAG) return res.status(304).end();
  res.type('html').send(INDEX_HTML);
}
app.get('/', sendIndex);
app.get('/index.html', sendIndex);

CLIENT_LIBS.forEach((name) => {
  app.get(`/lib/${name}`, (req, res) => {
    res.setHeader('Cache-Control', req.query.v === LIB_VERSIONS[name] ? LONG_CACHE : 'no-cache');
    res.sendFile(path.join(__dirname, 'lib', name));
  });
});

// Service worker: root scope, JavaScript MIME type, never cached by the HTTP
// cache (the browser must see a new sw.js as soon as it is deployed).
app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Service-Worker-Allowed', '/');
  res.sendFile(path.join(PUBLIC_DIR, 'sw.js'));
});

app.get('/manifest.webmanifest', (req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(PUBLIC_DIR, 'manifest.webmanifest'));
});

// Everything else in public/ (emblem, icons). Not content-hashed, so a week
// rather than a year; the SW refreshes them network-first anyway.
app.use(express.static(PUBLIC_DIR, {
  index: false,
  setHeaders(res, filePath) {
    if (/\.png$/i.test(filePath)) res.setHeader('Cache-Control', WEEK_CACHE);
  },
}));

// ---- /api responses are never stored by a browser or intermediary ----
// They carry salary data and session tokens. (The proxy's own in-memory
// cache below is server-side and keyed by route, not by anything the client
// sends.)
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
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
//
// Every call goes through ONE queue (lib/upstream.js), capped at
// UPSTREAM_CONCURRENCY (default 2): a burst of simultaneous executions is
// exactly what makes Apps Script answer with an HTML page instead of JSON
// (the coordinators incident of Sep 15–16). User requests take the next free
// slot ahead of queued background work (warm-up, refresh, keep-warm).
//
// READS are retried when the answer is retryable (HTML / quota page, 429,
// 5xx, timeout): up to twice, after RETRY_BASE_MS and 3× that. WRITES are
// never retried — a write that timed out may still have happened.
function envMs(name, fallback) {
  const raw = process.env[name];
  const n = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(n) && n >= 0 ? n : fallback;
}
const UPSTREAM_CONCURRENCY = envMs('UPSTREAM_CONCURRENCY', 2);
const upstreamQueue = createUpstreamQueue({ concurrency: UPSTREAM_CONCURRENCY });
const READ_DEADLINE_MS = envMs('UPSTREAM_READ_TIMEOUT_MS', 45 * 1000);
const WRITE_DEADLINE_MS = envMs('UPSTREAM_WRITE_TIMEOUT_MS', 120 * 1000);
const RETRY_BASE_MS = envMs('UPSTREAM_RETRY_BASE_MS', 400);
const READ_RETRIES = 2;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function queueDepth() {
  const d = upstreamQueue.depth();
  return `${d.active + d.queued}/${d.limit}`;
}

// opts: { lane: 'user' | 'background', retry: boolean, query: {k: v}, meta: {} }
// meta is filled in with { upstream, attempts, kind } for the log line.
async function callAppsScript(method, body, opts) {
  const o = opts || {};
  const meta = o.meta || {};
  if (!APPS_SCRIPT_URL || !SHARED_SECRET) {
    throw Object.assign(new Error('server misconfigured'), { status: 500 });
  }
  const sep = APPS_SCRIPT_URL.includes('?') ? '&' : '?';
  let url = `${APPS_SCRIPT_URL}${sep}secret=${encodeURIComponent(SHARED_SECRET)}`;
  Object.keys(o.query || {}).forEach((k) => {
    url += `&${encodeURIComponent(k)}=${encodeURIComponent(o.query[k])}`;
  });
  const init = {
    method,
    redirect: 'follow',
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const deadline = method === 'GET' ? READ_DEADLINE_MS : WRITE_DEADLINE_MS;
  const maxAttempts = o.retry ? 1 + READ_RETRIES : 1;
  const label = String((body && body.action) || (method === 'GET' ? 'data' : 'post')).slice(0, 40);

  async function once() {
    const t0 = Date.now();
    const resp = await fetchWithDeadline(fetch, url, init, deadline);
    const text = await resp.text();
    meta.upstream = resp.status;
    // Timing only — never the URL (it carries SHARED_SECRET) and never a body.
    console.log(`[upstream] ${method} ${resp.status} ${Date.now() - t0}ms bytes=${text.length}`);
    let parsed;
    try { parsed = JSON.parse(text); }
    catch (e) {
      const cls = classifyUpstream(resp.status, text);
      throw Object.assign(new Error('upstream non-JSON: ' + text.slice(0, 200)), {
        status: 502, retryable: cls.retryable, upstreamKind: cls.kind, upstreamStatus: resp.status,
      });
    }
    const status = Number(parsed._status) || 200;
    delete parsed._status;
    if (status >= 400) {
      const err = new Error(parsed.error || 'upstream error');
      err.status = status;
      err.body = parsed;
      err.upstreamStatus = resp.status;
      err.upstreamKind = 'app';
      // An Apps Script 5xx (lock or service timeout) is worth one more try on
      // a read; a 4xx is a validation answer and final.
      err.retryable = status >= 500;
      throw err;
    }
    return parsed;
  }

  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    meta.attempts = attempt;
    try {
      const out = await upstreamQueue.run(once, o.lane === 'background' ? 'background' : 'user');
      if (attempt > 1) {
        console.log(`[proxy] upstream recovered action=${label} attempt=${attempt} upstream=${meta.upstream}`);
      }
      meta.kind = 'ok';
      return out;
    } catch (err) {
      lastErr = err;
      meta.kind = err.upstreamKind || 'error';
      if (err.upstreamStatus !== undefined) meta.upstream = err.upstreamStatus;
      if (!err.retryable || attempt >= maxAttempts) break;
      console.log(`[proxy] upstream retry action=${label} attempt=${attempt + 1} kind=${meta.kind} upstream=${meta.upstream}`);
      await sleep(RETRY_BASE_MS * (attempt === 1 ? 1 : 3));
    }
  }
  throw lastErr;
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
// Log lines must never carry the upstream URL (it names the deployment) or
// any secret, even when an error message happens to echo them.
function redact(msg) {
  let out = String(msg || '');
  [APPS_SCRIPT_URL, SHARED_SECRET, HADRACHOT_STATUS_URL, HADRACHOT_STATUS_SECRET]
    .filter((v) => v && v.length >= 8)
    .forEach((v) => { out = out.split(v).join('[redacted]'); });
  return out.replace(/([?&]secret=)[^&\s"']+/gi, '$1[redacted]');
}

function sendUpstreamError(res, err, tag) {
  const status = err.status || 500;
  console.error(tag, status, redact(err.message));
  if (status >= 400 && status < 500) {
    const body = Object.assign({}, err.body || {}, { error: err.message });
    delete body._status;
    return res.status(status).json(body);
  }
  return res.status(status).json({ error: 'שגיאה בשרת. נסי שוב בעוד רגע.' });
}

// ---- read cache for /api/data (see lib/proxy-cache.js) ----
// One key, 'data', for the whole-Sheet read. The app is single-tenant — one
// PIN, one data set — so every authenticated session sees the same payload;
// requireAuth still runs BEFORE the cache on every request, so an
// unauthenticated caller never reaches a cached value.
const DATA_CACHE_KEY = 'data';
//
// Windows (all env-overridable, ms):
//   fresh — 60 s: served as HIT.
//   stale — 24 h: served at once as STALE while ONE refresh runs; the page
//           shows «מתעדכן…» and asks again. It used to be 5 min, so ANY open
//           after ~6 minutes of nobody using the app waited for a full Apps
//           Script execution — the "staffing takes long to open" complaint.
//   restored — 24 h: how long a copy read back from the disk snapshot may be
//           served (as STALE, never as fresh).
// Past the stale window, or with no copy at all, the read waits (MISS). If
// that read fails upstream, the last good copy — at any age — is served as
// STALE_ERROR instead of an error page.
const proxyCache = createProxyCache({
  freshMs: envMs('DATA_CACHE_FRESH_MS', 60 * 1000),
  staleMs: envMs('DATA_CACHE_STALE_MS', 24 * 60 * 60 * 1000),
  restoredStaleMs: envMs('CACHE_SNAPSHOT_MAX_AGE_MS', 24 * 60 * 60 * 1000),
  log: (line) => console.error(line),
  onStore: () => scheduleSnapshot(),
  onRefreshError: (key, err) => {
    console.error(`[proxy] refresh failed key=${key} upstream=${err && err.upstreamStatus !== undefined ? err.upstreamStatus : '-'}` +
      ` kind=${(err && err.upstreamKind) || 'error'} reason=${redact(err && err.message).slice(0, 200)}`);
  },
});
// The Apps Script bundle reports whether IT served from CacheService
// (_gasCache: hit | miss | off). Logged for docs/perf-load.md, then removed:
// the browser never sees it.
//
// `view=app` asks Code.gs for the lean bundle (no legacy v2 tabs, which the
// page never reads). An older Code.gs ignores the parameter; the legacy keys
// are dropped here either way, so the cache, the snapshot and the browser
// never carry them.
const LEGACY_BUNDLE_KEYS = ['houses', 'events', 'archive', '_compat'];
async function loadData(how, meta) {
  const data = await callAppsScript('GET', undefined, {
    lane: how === 'background' ? 'background' : 'user',
    retry: true,
    query: { view: 'app' },
    meta,
  });
  if (data && Object.prototype.hasOwnProperty.call(data, '_gasCache')) {
    console.log(`[upstream] bundle gas_cache=${String(data._gasCache).slice(0, 8)}`);
    delete data._gasCache;
  }
  if (data && typeof data === 'object') LEGACY_BUNDLE_KEYS.forEach((k) => { delete data[k]; });
  return data;
}

// The bundle minus the parts a screen loads lazily. `hearings` is read only
// by the שימועים screen, so the first render does not wait to parse it; the
// page asks /api/data/hearings when that screen opens.
const LAZY_PARTS = { hearings: ['hearings'] };
function withoutLazyParts(value) {
  const out = Object.assign({}, value);
  Object.keys(LAZY_PARTS).forEach((part) => LAZY_PARTS[part].forEach((k) => { delete out[k]; }));
  return out;
}

// [proxy] GET action=data ms=12 cache=HIT upstream=- outcome=ok q=0/2
function proxyLog(method, action, t0, fields) {
  const f = Object.assign({ cache: '-', upstream: '-', outcome: 'ok' }, fields || {});
  console.log(`[proxy] ${method} action=${action} ms=${Date.now() - t0} cache=${f.cache}` +
    ` upstream=${f.upstream} outcome=${f.outcome}` + (f.kind ? ` kind=${f.kind}` : '') +
    (f.ageMs !== undefined ? ` ageMs=${f.ageMs}` : '') + ` q=${queueDepth()}`);
}

// Actions that only read. Every OTHER action is a write and drops the data
// cache — whether it succeeded or not, since a 5xx/timeout may still have
// written. An unknown future action is therefore treated as a write, which
// is the safe direction.
const READ_ONLY_ACTIONS = new Set(['getMonthlyActuals', 'getBudgets', 'getHearings']);

// After a write the cache is empty, so the NEXT page load would pay for a
// full Apps Script read. Re-fill it in the background once writes go quiet
// (debounced, so a burst of edits costs one refresh, not one per edit).
// Off by default under NODE_ENV=test so a timer can never leak one test's
// fake upstream into the next; tests/perf-proxy.test.js turns it on.
const REWARM_MS = envMs('DATA_CACHE_REWARM_MS', process.env.NODE_ENV === 'test' ? 0 : 1500);
let rewarmTimer = null;
function scheduleRewarm() {
  if (!REWARM_MS) return;
  if (rewarmTimer) clearTimeout(rewarmTimer);
  rewarmTimer = setTimeout(() => {
    rewarmTimer = null;
    proxyCache.warm(DATA_CACHE_KEY, loadData);
  }, REWARM_MS);
  if (rewarmTimer.unref) rewarmTimer.unref();
}
// Tests only: drop a pending re-warm so it cannot fire into the next test.
function cancelRewarm() {
  if (rewarmTimer) clearTimeout(rewarmTimer);
  rewarmTimer = null;
}

// Serve one cached read. `pick` shapes the cached bundle into the response.
async function serveCachedRead(req, res, action, pick) {
  const t0 = Date.now();
  const meta = {};
  try {
    const r = await proxyCache.get(DATA_CACHE_KEY, (how) => loadData(how, meta));
    res.setHeader('X-Cache', r.status);
    res.setHeader('X-Data-Age', String(Math.max(0, Math.round((r.ageMs || 0) / 1000))));
    res.setHeader('Server-Timing', `proxy;desc="${r.status}";dur=${Date.now() - t0}`);
    const fields = { cache: r.status };
    if (r.status === 'MISS') {
      fields.upstream = meta.upstream !== undefined ? meta.upstream : 'joined';
    }
    if (r.status === 'STALE_ERROR') {
      const e = r.error || {};
      Object.assign(fields, {
        outcome: 'stale_after_error', ageMs: r.ageMs,
        upstream: e.upstreamStatus !== undefined ? e.upstreamStatus : (meta.upstream !== undefined ? meta.upstream : '-'),
        kind: e.upstreamKind || meta.kind || 'error',
      });
      console.error(`[proxy] upstream failed, serving stale action=${action} ageMs=${r.ageMs} reason=${redact(e.message).slice(0, 200)}`);
    }
    proxyLog('GET', action, t0, fields);
    res.json(pick(r.value));
  } catch (err) {
    proxyLog('GET', action, t0, {
      cache: 'MISS', outcome: 'error',
      upstream: err.upstreamStatus !== undefined ? err.upstreamStatus : (meta.upstream !== undefined ? meta.upstream : '-'),
      kind: err.upstreamKind || meta.kind || 'error',
    });
    sendUpstreamError(res, err, `[GET /api/${action}]`);
  }
}

app.get('/api/data', requireAuth, (req, res) =>
  serveCachedRead(req, res, 'data', withoutLazyParts));

// Lazy part: the שימועים list, from the SAME cached bundle (no extra Apps
// Script call when the cache is warm).
app.get('/api/data/hearings', requireAuth, (req, res) =>
  serveCachedRead(req, res, 'hearings', (v) => ({
    hearings: Array.isArray(v && v.hearings) ? v.hearings : [],
  })));

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
    console.error('[GET /api/hadrachot-status]', err.status || 502, redact(err.message));
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
  const isWrite = !READ_ONLY_ACTIONS.has(payload.action);
  // Invalidate BEFORE the write too: a read that starts while the write is
  // in flight must not be served (or cache) the pre-write snapshot.
  if (isWrite) proxyCache.invalidate(DATA_CACHE_KEY);
  const t0 = Date.now();
  const meta = {};
  try {
    // Only a read-only action may be retried; a write never is.
    const result = await callAppsScript('POST', payload, { lane: 'user', retry: !isWrite, meta });
    proxyLog('POST', payload.action, t0, { upstream: meta.upstream });
    res.json(result);
  } catch (err) {
    proxyLog('POST', payload.action, t0, {
      outcome: 'error', upstream: meta.upstream !== undefined ? meta.upstream : '-',
      kind: err.upstreamKind || meta.kind || 'error',
    });
    sendUpstreamError(res, err, '[POST /api/action]');
  } finally {
    if (isWrite) {
      proxyCache.invalidate(DATA_CACHE_KEY);
      scheduleRewarm();
    }
  }
});

// ---- read-cache snapshot on disk (lib/cache-snapshot.js) ----
//
// Where: CACHE_SNAPSHOT_DIR if set; else, when Railway has a volume mounted
// on this service, <RAILWAY_VOLUME_MOUNT_PATH>/staffing-cache (Railway sets
// that variable itself); else <repo>/.cache, which survives a crash restart
// but not a redeploy. CACHE_SNAPSHOT=0 turns the whole feature off.
const RAILWAY_VOLUME = process.env.RAILWAY_VOLUME_MOUNT_PATH || '';
const SNAPSHOT_ENABLED = process.env.CACHE_SNAPSHOT !== '0';
const SNAPSHOT_DIR = process.env.CACHE_SNAPSHOT_DIR ||
  (RAILWAY_VOLUME ? path.join(RAILWAY_VOLUME, 'staffing-cache') : path.join(__dirname, '.cache'));
const SNAPSHOT_MAX_AGE_MS = envMs('CACHE_SNAPSHOT_MAX_AGE_MS', 24 * 60 * 60 * 1000);
const SNAPSHOT_INTERVAL_MS = envMs('CACHE_SNAPSHOT_INTERVAL_MS', 5 * 60 * 1000);
const SNAPSHOT_DEBOUNCE_MS = envMs('CACHE_SNAPSHOT_DEBOUNCE_MS', 5 * 1000);
let snapshotArmed = false;   // only after bootProxy(): tests never write one
let snapshotTimer = null;

function saveSnapshot(reason) {
  if (!SNAPSHOT_ENABLED || !snapshotArmed) return null;
  const { text, count } = cacheSnapshot.serialize(proxyCache.snapshotPairs());
  if (!count) return null;
  const r = cacheSnapshot.writeSnapshot(SNAPSHOT_DIR, text);
  if (r.ok) console.log(`[proxy] cache snapshot saved entries=${count} bytes=${r.bytes} reason=${reason}`);
  else console.error(`[proxy] cache snapshot write failed reason=${r.reason}`);
  return r;
}

function scheduleSnapshot() {
  if (!SNAPSHOT_ENABLED || !snapshotArmed) return;
  if (snapshotTimer) clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(() => { snapshotTimer = null; saveSnapshot('refresh'); }, SNAPSHOT_DEBOUNCE_MS);
  if (snapshotTimer.unref) snapshotTimer.unref();
}

// Boot: log where the snapshot lives, restore it, then warm. → a summary.
function restoreSnapshot() {
  const probe = cacheSnapshot.probeDir(SNAPSHOT_DIR);
  let restored = 0;
  let note = 'absent';
  let ageMs = null;
  const read = cacheSnapshot.readSnapshot(SNAPSHOT_DIR);
  if (read.text !== null) {
    const doc = cacheSnapshot.parse(read.text, { maxAgeMs: SNAPSHOT_MAX_AGE_MS });
    if (!doc) note = 'ignored (corrupt, wrong version or too old)';
    else {
      ageMs = Date.now() - doc.savedAt;
      doc.entries.forEach((e) => {
        if (e.key === DATA_CACHE_KEY && proxyCache.restore(e.key, e.value, e.storedAt)) restored++;
      });
      note = 'ok';
    }
  } else if (read.reason !== 'absent') note = 'unreadable (' + read.reason + ')';
  console.log(`[proxy] cache snapshot dir=${SNAPSHOT_DIR} writable=${probe.ok}` +
    (probe.ok ? '' : ` reason=${probe.reason}`) + ` restored entries=${restored} (${note})` +
    (ageMs !== null ? ` ageMs=${ageMs}` : ''));
  return { dir: SNAPSHOT_DIR, writable: probe.ok, restored, note };
}

// Keep-warm: re-read the bundle in the background every
// DATA_CACHE_KEEPWARM_MS (default 10 min, 0 = off) so the copy a user opens
// is at most that old, and Apps Script's own cache stays warm.
const KEEPWARM_MS = envMs('DATA_CACHE_KEEPWARM_MS', 10 * 60 * 1000);

let booted = false;
function bootProxy() {
  if (booted) return null;
  booted = true;
  console.log(`[proxy] upstream concurrency=${upstreamQueue.limit} volume mount=${RAILWAY_VOLUME || 'none'}`);
  let summary = { dir: SNAPSHOT_DIR, writable: false, restored: 0, note: 'disabled' };
  if (SNAPSHOT_ENABLED) {
    summary = restoreSnapshot();
    snapshotArmed = true;
    if (SNAPSHOT_INTERVAL_MS) {
      const iv = setInterval(() => saveSnapshot('interval'), SNAPSHOT_INTERVAL_MS);
      if (iv.unref) iv.unref();
    }
    // The freshest copy is the one the next process should inherit.
    ['SIGTERM', 'SIGINT'].forEach((sig) => process.once(sig, () => {
      saveSnapshot(sig);
      process.exit(0);
    }));
  } else {
    console.log('[proxy] cache snapshot disabled (CACHE_SNAPSHOT=0)');
  }
  // Warm (or, after a restore, refresh) the data cache so the first page
  // load after a deploy is not the one that pays for Apps Script.
  proxyCache.warm(DATA_CACHE_KEY, loadData);
  if (KEEPWARM_MS) {
    const kw = setInterval(() => proxyCache.warm(DATA_CACHE_KEY, loadData), KEEPWARM_MS);
    if (kw.unref) kw.unref();
  }
  return summary;
}

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
    bootProxy();
  });
}

module.exports = {
  app, callAppsScript,
  _loginAttempts: loginAttempts,
  _revokedSessions: revokedSessions,
  _proxyCache: proxyCache,
  _cancelRewarm: cancelRewarm,
  _upstreamQueue: upstreamQueue,
  _bootProxy: bootProxy,
  _saveSnapshot: saveSnapshot,
  _libVersions: LIB_VERSIONS,
  READ_ONLY_ACTIONS,
};
