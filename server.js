'use strict';
const express = require('express');
const path = require('path');
const crypto = require('crypto');

const { signToken, verifyToken, checkPin } = require('./lib/auth');
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

// ---- static (public) but gate the index ----
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
// expose only the shared client-safe helpers. Server-only modules in lib/
// (auth.js, validate.js) MUST NOT be exposed — they are listed nowhere here
// and the whitelist below is exact, not a prefix match.
//   calc.js          — cost maths, shared with the browser
//   payroll-parse.js — the בקרת שכר PDF parser and reconciliation gate
//   payroll-rules.js — the בקרת שכר compliance rules
//   xlsx_write.js    — the בקרת שכר xlsx export writer
const CLIENT_LIBS = ['calc.js', 'payroll-parse.js', 'payroll-rules.js', 'xlsx_write.js'];
CLIENT_LIBS.forEach((file) => {
  app.get(`/lib/${file}`, (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.sendFile(path.join(__dirname, 'lib', file));
  });
});

// pdfjs, served from node_modules rather than a CDN so the payroll report —
// which never leaves the browser — is parsed by same-origin code only, with
// no third-party script in the path of an HR document.
const PDFJS_FILES = {
  '/vendor/pdf.min.mjs': 'build/pdf.min.mjs',
  '/vendor/pdf.worker.min.mjs': 'build/pdf.worker.min.mjs',
};
Object.keys(PDFJS_FILES).forEach((route) => {
  app.get(route, (req, res) => {
    let file;
    try {
      file = require.resolve(`pdfjs-dist/${PDFJS_FILES[route]}`);
    } catch (err) {
      return res.status(503).json({ error: 'pdfjs not installed' });
    }
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    res.sendFile(file);
  });
});
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---- health ----
app.get('/api/health', (req, res) => {
  res.json({ ok: true, t: Date.now() });
});

// ---- login (rate-limited) ----
const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX = 8;

function rateLimitLogin(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip) || { count: 0, resetAt: now + LOGIN_WINDOW_MS };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + LOGIN_WINDOW_MS;
  }
  entry.count++;
  loginAttempts.set(ip, entry);
  return entry.count <= LOGIN_MAX;
}

app.post('/api/login', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!rateLimitLogin(ip)) {
    return res.status(429).json({ error: 'יותר מדי ניסיונות. נסי שוב מאוחר יותר.' });
  }
  const pin = (req.body && req.body.pin) || '';
  if (!checkPin(String(pin), MORAN_PIN)) {
    return res.status(401).json({ error: 'קוד שגוי' });
  }
  const token = signToken(SESSION_SECRET, SESSION_DAYS);
  res.json({ token, expiresInDays: SESSION_DAYS });
});

// ---- auth middleware for /api/data and /api/action ----
function requireAuth(req, res, next) {
  const h = req.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  const token = m ? m[1] : '';
  if (!verifyToken(SESSION_SECRET, token)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// ---- Apps Script proxy ----
async function callAppsScript(method, body, query) {
  if (!APPS_SCRIPT_URL || !SHARED_SECRET) {
    throw Object.assign(new Error('server misconfigured'), { status: 500 });
  }
  const sep = APPS_SCRIPT_URL.includes('?') ? '&' : '?';
  let url = `${APPS_SCRIPT_URL}${sep}secret=${encodeURIComponent(SHARED_SECRET)}`;
  // Extra query params for the doGet routes. Only values the caller's own
  // route has already validated ever reach this — never raw req.query.
  Object.keys(query || {}).forEach((k) => {
    url += `&${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`;
  });
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

app.get('/api/data', requireAuth, async (req, res) => {
  try {
    const data = await callAppsScript('GET');
    res.json(data);
  } catch (err) {
    console.error('[GET /api/data]', err.status || 500, err.message);
    res.status(err.status || 500).json({ error: err.message });
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

// ---- בקרת שכר read (the Apps Script doGet route) ----
// A GET of its own rather than another /api/action POST, because reading a
// payroll run is a read: it is cacheable, it is safe to retry, and it must
// stay reachable when a run is locked and every write is refused.
app.get('/api/payroll/run', requireAuth, async (req, res) => {
  const query = { action: 'getPayrollRun' };
  try {
    const runId = String(req.query.runId || '').trim();
    const month = String(req.query.month || '').trim();
    // Validated HERE, before anything is put on the upstream URL.
    if (runId) {
      if (!/^pr_[A-Za-z0-9_]{4,40}$/.test(runId)) throw Object.assign(new Error('bad runId'), { status: 400 });
      query.runId = runId;
    }
    if (month) {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw Object.assign(new Error('bad month'), { status: 400 });
      query.month = month;
    }
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }
  try {
    const data = await callAppsScript('GET', undefined, query);
    res.json(data);
  } catch (err) {
    console.error('[GET /api/payroll/run]', err.status || 500, err.message);
    res.status(err.status || 500).json({ error: err.message });
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
    console.error('[POST /api/action]', err.status || 500, err.message);
    res.status(err.status || 500).json({ error: err.message });
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

module.exports = { app, callAppsScript, _loginAttempts: loginAttempts };
