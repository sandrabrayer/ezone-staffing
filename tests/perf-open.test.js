'use strict';

// Slow app OPEN — the proxy side (docs/perf-open.md).
//
// Pinned here:
//   - ONE upstream queue capped at UPSTREAM_CONCURRENCY (2), user lane first.
//   - classifyUpstream: HTML / quota pages, 429 and 5xx are retryable.
//   - A READ answered with Google's 404 HTML is retried and recovers; a
//     WRITE is never retried.
//   - STALE-ON-ERROR: with a last good copy, a failing read serves it
//     (X-Cache: STALE_ERROR) instead of an error page; with none, a Hebrew
//     502 and nothing cached.
//   - The long stale window: a copy older than the old 6-minute limit is
//     STALE (instant + refresh), not MISS (wait for Apps Script).
//   - Restored (snapshot) entries are never a HIT, and a live read wins.
//   - The per-request log line, and no secret in any log line.
//   - /api/data drops the legacy keys and the lazy `hearings` part, which
//     /api/data/hearings serves from the same cache entry.
//   - lib/cache-snapshot.js: what may be written, and that a bad file reads
//     as "no file".

process.env.NODE_ENV = 'test';
process.env.APPS_SCRIPT_URL = 'https://script.example.com/macros/s/DEPLOYMENT-OPEN-XYZ/exec';
process.env.SHARED_SECRET = 'open-shared-secret-'.padEnd(40, 'Z');
process.env.MORAN_PIN = '918273';
process.env.SESSION_SECRET = 'o'.repeat(64);
process.env.DATA_CACHE_REWARM_MS = '0';
process.env.UPSTREAM_RETRY_BASE_MS = '5';
process.env.UPSTREAM_READ_TIMEOUT_MS = '400';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createUpstreamQueue, classifyUpstream, fetchWithDeadline } = require('../lib/upstream');
const { createProxyCache } = require('../lib/proxy-cache');
const snap = require('../lib/cache-snapshot');
const { app, _loginAttempts, _proxyCache, _cancelRewarm, _upstreamQueue } = require('../server');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }

// ---------------------------------------------------------------------------
// lib/upstream.js
// ---------------------------------------------------------------------------

test('queue: never more than `concurrency` calls in flight under a burst of 12', async () => {
  const q = createUpstreamQueue({ concurrency: 2 });
  let active = 0;
  let peak = 0;
  const jobs = Array.from({ length: 12 }, () => q.run(async () => {
    active++; peak = Math.max(peak, active);
    await sleep(5);
    active--;
    return 1;
  }));
  const out = await Promise.all(jobs);
  assert.equal(out.length, 12);
  assert.equal(peak, 2);
});

test('queue: a user call takes the next free slot ahead of queued background work', async () => {
  const q = createUpstreamQueue({ concurrency: 1 });
  const order = [];
  const gate = deferred();
  const first = q.run(async () => { await gate.promise; order.push('busy'); });
  const bg = [1, 2, 3].map((i) => q.run(async () => { order.push('bg' + i); }, 'background'));
  const user = q.run(async () => { order.push('user'); }, 'user');
  gate.resolve();
  await Promise.all([first, user, ...bg]);
  assert.deepEqual(order, ['busy', 'user', 'bg1', 'bg2', 'bg3']);
});

test('queue: the default is 2 and it is clamped to 1..6', () => {
  assert.equal(createUpstreamQueue({}).limit, 2);
  assert.equal(createUpstreamQueue({ concurrency: 0 }).limit, 2);
  assert.equal(createUpstreamQueue({ concurrency: 50 }).limit, 6);
  assert.equal(_upstreamQueue.limit, 2, 'the server uses the default');
});

test('classifyUpstream: Google 404 HTML, quota pages, 429 and 5xx retry; garbage does not', () => {
  const notFound = '<!DOCTYPE html><html><head><title>Page Not Found</title></head><body>Sorry, unable to open the file at this time.</body></html>';
  assert.deepEqual(classifyUpstream(404, notFound), { kind: 'html', retryable: true });
  assert.deepEqual(classifyUpstream(200, '<html><body>Service invoked too many times for one day</body></html>'),
    { kind: 'quota', retryable: true });
  assert.deepEqual(classifyUpstream(429, 'slow down'), { kind: 'transient', retryable: true });
  assert.deepEqual(classifyUpstream(503, ''), { kind: 'transient', retryable: true });
  assert.deepEqual(classifyUpstream(200, 'not json at all'), { kind: 'nonjson', retryable: false });
});

test('fetchWithDeadline: gives up with a retryable timeout error', async () => {
  const never = () => new Promise(() => {});
  // The deadline timer is unref'd (it must never hold the server open); a
  // bare test has nothing else keeping the loop alive, so hold it here.
  const hold = setInterval(() => {}, 1000);
  try {
    await assert.rejects(fetchWithDeadline(never, 'x', {}, 20),
      (e) => e.retryable === true && e.upstreamKind === 'timeout' && e.status === 504);
  } finally { clearInterval(hold); }
});

// ---------------------------------------------------------------------------
// lib/proxy-cache.js
// ---------------------------------------------------------------------------

function clock(t0) { let t = t0; return { now: () => t, add: (ms) => { t += ms; } }; }

test('cache: a copy 10 minutes old is STALE (instant + refresh), not MISS', async () => {
  const c0 = clock(1000);
  const c = createProxyCache({ freshMs: 60e3, staleMs: 24 * 3600e3, now: c0.now });
  let calls = 0;
  await c.get('data', async () => { calls++; return { v: 1 }; });
  c0.add(10 * 60e3);
  const r = await c.get('data', async () => { calls++; return { v: 2 }; });
  assert.equal(r.status, 'STALE');
  assert.deepEqual(r.value, { v: 1 });
  await sleep(0);
  assert.equal(calls, 2, 'one background refresh was started');
});

test('cache: STALE_ERROR — a failing read serves the last good copy, even after an invalidation', async () => {
  const c = createProxyCache({ freshMs: 60e3, staleMs: 60e3 });
  await c.get('data', async () => ({ v: 'good' }));
  c.invalidate('data');
  const r = await c.get('data', async () => { throw Object.assign(new Error('html'), { upstreamStatus: 404 }); });
  assert.equal(r.status, 'STALE_ERROR');
  assert.deepEqual(r.value, { v: 'good' });
  assert.equal(r.error.upstreamStatus, 404);
});

test('cache: no last good copy → the failure propagates and nothing is cached', async () => {
  const c = createProxyCache();
  await assert.rejects(c.get('data', async () => { throw new Error('down'); }), /down/);
  assert.deepEqual(c.keys(), []);
  assert.equal(c.peek('data'), null);
});

test('cache: a restored entry is never a HIT, and a live value always wins', async () => {
  const c0 = clock(10_000_000);
  const c = createProxyCache({ freshMs: 60e3, staleMs: 60e3, restoredStaleMs: 3600e3, now: c0.now });
  assert.equal(c.restore('data', { v: 'disk' }, c0.now() - 1000), true);
  let calls = 0;
  const r = await c.get('data', async () => { calls++; return { v: 'live' }; });
  assert.equal(r.status, 'STALE', 'even 1 s old, a restored copy is served as STALE');
  assert.deepEqual(r.value, { v: 'disk' });
  await sleep(0);
  assert.equal(calls, 1, 'and it started a refresh');
  const again = await c.get('data', async () => ({ v: 'x' }));
  assert.equal(again.status, 'HIT');
  assert.deepEqual(again.value, { v: 'live' });
  assert.equal(c.restore('data', { v: 'older disk' }, c0.now() - 5000), false, 'live wins');
});

test('cache: a restored entry older than restoredStaleMs is a MISS', async () => {
  const c0 = clock(10_000_000);
  const c = createProxyCache({ restoredStaleMs: 1000, now: c0.now });
  c.restore('data', { v: 'disk' }, c0.now() - 5000);
  const r = await c.get('data', async () => ({ v: 'live' }));
  assert.equal(r.status, 'MISS');
});

// ---------------------------------------------------------------------------
// lib/cache-snapshot.js
// ---------------------------------------------------------------------------

test('snapshot: round trip keeps only persistable entries, newest first', () => {
  const now = 5_000_000;
  const { text, count } = snap.serialize([
    ['data', { value: { workers: [1] }, storedAt: now - 10 }],
    ['token', { value: { a: 1 }, storedAt: now }],            // credential-looking key
    ['other', { value: { error: 'x' }, storedAt: now }],      // error body
    ['arr', { value: [1, 2], storedAt: now }],                // not an object
    ['nots', { value: { a: 1 }, storedAt: 0 }],               // no timestamp
  ], { now });
  assert.equal(count, 1);
  const doc = snap.parse(text, { now, maxAgeMs: 3600e3 });
  assert.deepEqual(doc.entries, [{ key: 'data', value: { workers: [1] }, storedAt: now - 10 }]);
});

test('snapshot: corrupt, truncated, wrong-version, future and too-old files read as "no file"', () => {
  const now = 5_000_000;
  const good = snap.serialize([['data', { value: { a: 1 }, storedAt: now }]], { now }).text;
  for (const bad of ['', 'null', '{', good.slice(0, good.length - 5), JSON.stringify({ v: 99, savedAt: now, entries: [] }),
    JSON.stringify({ v: 1, savedAt: now + 3600e3, entries: [] }), 42, undefined]) {
    assert.equal(snap.parse(bad, { now, maxAgeMs: 3600e3 }), null, String(bad).slice(0, 30));
  }
  assert.equal(snap.parse(good, { now: now + 7200e3, maxAgeMs: 3600e3 }), null, 'too old');
});

test('snapshot: the size cap drops the oldest entries rather than writing a huge file', () => {
  const now = 5_000_000;
  const big = 'x'.repeat(1000);
  const pairs = Array.from({ length: 8 }, (_, i) => ['k' + i, { value: { big }, storedAt: now - i }]);
  const { text, count } = snap.serialize(pairs, { now, maxBytes: 3000 });
  assert.ok(text.length <= 3000);
  assert.ok(count >= 1 && count < 8);
  assert.equal(JSON.parse(text).entries[0].key, 'k0', 'newest kept');
});

test('snapshot fs: atomic write, 0600 file in a 0700 dir, readable back; unwritable dir never throws', () => {
  // Encryption itself is pinned in tests/snapshot-security.test.js.
  const key = require('node:crypto').randomBytes(32);
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'snap-t-')), 'nested');
  const w = snap.writeSnapshot(dir, '{"v":1}', key);
  assert.equal(w.ok, true);
  const st = fs.statSync(path.join(dir, snap.FILE_NAME));
  assert.equal(st.mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.existsSync(path.join(dir, snap.FILE_NAME + '.tmp')), false, 'no temp file left');
  assert.equal(snap.readSnapshot(dir, key).text, '{"v":1}');
  assert.equal(snap.readSnapshot(path.join(dir, 'none'), key).reason, 'absent');
  // A path UNDER A FILE can never be a directory.
  const file = path.join(dir, snap.FILE_NAME);
  assert.equal(snap.probeDir(path.join(file, 'x')).ok, false);
  assert.equal(snap.writeSnapshot(path.join(file, 'x'), '{}', key).ok, false);
});

// ---------------------------------------------------------------------------
// server.js integration
// ---------------------------------------------------------------------------

const originalFetch = global.fetch;
const NOT_FOUND_HTML = '<!DOCTYPE html><html><head><title>Page Not Found</title></head><body>Sorry, unable to open the file at this time.</body></html>';
let up;

function fakeUpstream() {
  const state = { version: 1, gets: 0, posts: 0, htmlNext: 0, htmlPosts: 0, hang: false, lastGetUrl: '' };
  return {
    state,
    async handle(url, init) {
      const method = (init && init.method) || 'GET';
      if (method === 'GET') {
        state.gets++;
        state.lastGetUrl = url;
        if (state.hang) return new Promise(() => {});
        if (state.htmlNext > 0) { state.htmlNext--; return { status: 404, text: NOT_FOUND_HTML }; }
        return { status: 200, text: JSON.stringify({
          _status: 200, workers: [{ id: 'w1', name: 'v' + state.version }],
          hearings: [{ id: 'h1', workerId: 'w1' }], feedLog: [],
          houses: { ramot: [] }, events: [], archive: [], _compat: true, _gasCache: 'miss',
        }) };
      }
      state.posts++;
      const b = JSON.parse(init.body);
      if (state.htmlPosts > 0) { state.htmlPosts--; return { status: 404, text: NOT_FOUND_HTML }; }
      if (b.action.startsWith('get')) return { status: 200, text: JSON.stringify({ _status: 200, items: [] }) };
      state.version++;
      return { status: 200, text: JSON.stringify({ _status: 200, ok: true }) };
    },
  };
}

let logs = [];
const origLog = console.log;
const origErr = console.error;

test.beforeEach(() => {
  _loginAttempts.clear();
  _cancelRewarm();
  _proxyCache.clear();
  up = fakeUpstream();
  global.fetch = async (url, init) => {
    const r = await up.handle(url, init);
    return { ok: r.status < 400, status: r.status, text: async () => r.text };
  };
  logs = [];
  console.log = (...a) => { logs.push(a.join(' ')); };
  console.error = (...a) => { logs.push(a.join(' ')); };
});
test.afterEach(() => { global.fetch = originalFetch; console.log = origLog; console.error = origErr; });

function listen() {
  return new Promise((resolve) => {
    const srv = http.createServer(app).listen(0, '127.0.0.1', () => {
      resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` });
    });
  });
}
const close = (srv) => new Promise((r) => srv.close(r));
async function req(base, p, opts) {
  const r = await originalFetch(base + p, opts);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not json */ }
  return { status: r.status, headers: r.headers, text, json };
}
async function login(base) {
  const r = await req(base, '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: process.env.MORAN_PIN }),
  });
  return r.json.token;
}
const auth = (t) => ({ Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' });

test('a READ answered with Google 404 HTML is retried and recovers (no error for the user)', async () => {
  const { srv, base } = await listen();
  try {
    const t = await login(base);
    up.state.htmlNext = 1;
    const r = await req(base, '/api/data', { headers: auth(t) });
    assert.equal(r.status, 200);
    assert.equal(r.json.workers[0].name, 'v1');
    assert.equal(up.state.gets, 2, 'one retry');
    assert.ok(logs.some((l) => /\[proxy\] upstream retry action=data attempt=2 kind=html upstream=404/.test(l)));
    assert.ok(logs.some((l) => /\[proxy\] upstream recovered action=data attempt=2 upstream=200/.test(l)));
    assert.ok(logs.some((l) => /^\[proxy\] GET action=data ms=\d+ cache=MISS upstream=200 outcome=ok q=\d+\/2$/.test(l)),
      'the per-request line');
  } finally { await close(srv); }
});

test('the proxy asks Apps Script for the lean bundle (view=app)', async () => {
  const { srv, base } = await listen();
  try {
    const t = await login(base);
    await req(base, '/api/data', { headers: auth(t) });
    assert.equal(new URL(up.state.lastGetUrl).searchParams.get('view'), 'app');
  } finally { await close(srv); }
});

test('a WRITE answered with HTML is NEVER retried', async () => {
  const { srv, base } = await listen();
  try {
    const t = await login(base);
    up.state.htmlPosts = 1;
    const r = await req(base, '/api/action', { method: 'POST', headers: auth(t),
      body: JSON.stringify({ action: 'createWorker', worker: { name: 'x' } }) });
    assert.equal(r.status, 502);
    assert.equal(up.state.posts, 1, 'exactly one attempt');
    assert.ok(logs.some((l) => /^\[proxy\] POST action=createWorker ms=\d+ cache=- upstream=404 outcome=error kind=html/.test(l)));
  } finally { await close(srv); }
});

test('a read-only ACTION answered with HTML is retried', async () => {
  const { srv, base } = await listen();
  try {
    const t = await login(base);
    up.state.htmlPosts = 1;
    const r = await req(base, '/api/action', { method: 'POST', headers: auth(t),
      body: JSON.stringify({ action: 'getBudgets' }) });
    assert.equal(r.status, 200);
    assert.equal(up.state.posts, 2);
  } finally { await close(srv); }
});

test('STALE-ON-ERROR: after a save, Apps Script down → the last good copy, flagged, not an error page', async () => {
  const { srv, base } = await listen();
  try {
    const t = await login(base);
    await req(base, '/api/data', { headers: auth(t) });
    await req(base, '/api/action', { method: 'POST', headers: auth(t),
      body: JSON.stringify({ action: 'createWorker', worker: { name: 'x' } }) });
    up.state.htmlNext = 99;
    const r = await req(base, '/api/data', { headers: auth(t) });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-cache'), 'STALE_ERROR');
    assert.equal(r.json.workers[0].name, 'v1');
    assert.equal(up.state.gets, 1 + 3, 'three attempts before falling back');
    assert.ok(logs.some((l) => /^\[proxy\] GET action=data ms=\d+ cache=STALE_ERROR upstream=404 outcome=stale_after_error kind=html ageMs=\d+ q=/.test(l)));
  } finally { await close(srv); }
});

test('no copy at all + Apps Script down → Hebrew 502, nothing cached, no upstream text leaked', async () => {
  const { srv, base } = await listen();
  try {
    const t = await login(base);
    up.state.htmlNext = 99;
    const r = await req(base, '/api/data', { headers: auth(t) });
    assert.equal(r.status, 502);
    assert.match(r.json.error, /שגיאה בשרת/);
    assert.ok(!r.text.includes('Sorry'), 'Google page never reaches the browser');
    assert.deepEqual(_proxyCache.keys(), []);
    assert.ok(logs.some((l) => /^\[proxy\] GET action=data ms=\d+ cache=MISS upstream=404 outcome=error kind=html/.test(l)));
  } finally { await close(srv); }
});

test('a hung Apps Script read times out (deadline) instead of hanging the page', async () => {
  const { srv, base } = await listen();
  try {
    const t = await login(base);
    up.state.hang = true;
    const t0 = Date.now();
    const r = await req(base, '/api/data', { headers: auth(t) });
    assert.equal(r.status, 504);
    assert.ok(Date.now() - t0 < 5000, 'bounded by the deadline × attempts');
  } finally { await close(srv); }
});

test('/api/data drops the legacy keys and the lazy hearings part; /api/data/hearings serves it', async () => {
  const { srv, base } = await listen();
  try {
    const t = await login(base);
    const d = await req(base, '/api/data', { headers: auth(t) });
    for (const k of ['houses', 'events', 'archive', '_compat', '_gasCache', 'hearings']) {
      assert.equal(k in d.json, false, k);
    }
    assert.ok(d.headers.get('x-data-age') !== null);
    const h = await req(base, '/api/data/hearings', { headers: auth(t) });
    assert.equal(h.status, 200);
    assert.deepEqual(h.json, { hearings: [{ id: 'h1', workerId: 'w1' }] });
    assert.equal(h.headers.get('x-cache'), 'HIT', 'same cache entry — no extra Apps Script call');
    assert.equal(up.state.gets, 1);
    const anon = await req(base, '/api/data/hearings');
    assert.equal(anon.status, 401, 'behind the session gate');
  } finally { await close(srv); }
});

test('no secret, PIN, token or upstream URL in any log line of this file', async () => {
  const { srv, base } = await listen();
  try {
    const t = await login(base);
    up.state.htmlNext = 1;
    await req(base, '/api/data', { headers: auth(t) });
    up.state.htmlNext = 99;
    _proxyCache.invalidate('data');
    await req(base, '/api/data', { headers: auth(t) });
    const text = logs.join('\n');
    for (const bad of [process.env.SHARED_SECRET, process.env.MORAN_PIN, t, 'DEPLOYMENT-OPEN-XYZ', 'script.example.com']) {
      assert.ok(!text.includes(bad), 'leaked: ' + String(bad).slice(0, 12));
    }
  } finally { await close(srv); }
});
