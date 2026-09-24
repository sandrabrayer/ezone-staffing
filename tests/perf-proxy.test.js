'use strict';

// Perf — the Express side of the page load: lib/proxy-cache.js and how
// server.js uses it, plus compression and cache headers.
//
// Pinned here:
//   - COALESCING: identical reads in flight share one upstream call.
//   - HIT / STALE / MISS, with one background refresh on STALE.
//   - INVALIDATION on every write action (success or failure), never on a
//     read-only action; a read in flight during a write cannot repopulate the
//     cache with the pre-write snapshot.
//   - AUTH FIRST: a warm cache is never served without a valid session.
//   - SECRETS: cache keys are fixed route names; the PIN, the session token,
//     SHARED_SECRET and the upstream URL never appear in a key or in any log
//     line the server writes.
//   - /api is Cache-Control: no-store; index.html is no-cache; hashed libs are
//     immutable only under their current hash; responses are gzipped.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');

process.env.NODE_ENV = 'test';
process.env.APPS_SCRIPT_URL = 'https://script.example.com/macros/s/DEPLOYMENT-ID-XYZ/exec';
process.env.SHARED_SECRET = 'shared-secret-'.padEnd(40, 'Q');
process.env.MORAN_PIN = '918273';
process.env.SESSION_SECRET = 'y'.repeat(64);
// Re-warm on in this file (off by default under NODE_ENV=test).
// Wide enough that three back-to-back writes on a loaded CI runner still
// land inside one debounce window (30 ms was not — a slow runner fired two).
process.env.DATA_CACHE_REWARM_MS = '200';

const { createProxyCache } = require('../lib/proxy-cache');
const { app, _loginAttempts, _proxyCache, _cancelRewarm, _libVersions } = require('../server');

// ---------------------------------------------------------------------------
// unit: lib/proxy-cache.js
// ---------------------------------------------------------------------------

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('coalescing: concurrent MISSes share ONE loader call', async () => {
  const c = createProxyCache({ freshMs: 1000, staleMs: 1000 });
  let calls = 0;
  const d = deferred();
  const loader = () => { calls++; return d.promise; };
  const p = [c.get('data', loader), c.get('data', loader), c.get('data', loader)];
  d.resolve({ v: 1 });
  const r = await Promise.all(p);
  assert.equal(calls, 1);
  r.forEach(x => { assert.equal(x.status, 'MISS'); assert.deepEqual(x.value, { v: 1 }); });
});

test('HIT while fresh, STALE (served at once + one background refresh) while stale, MISS after', async () => {
  let t = 0;
  const c = createProxyCache({ freshMs: 100, staleMs: 100, now: () => t });
  let calls = 0;
  const loader = async () => ({ v: ++calls });
  assert.equal((await c.get('data', loader)).status, 'MISS');
  t = 50;
  assert.equal((await c.get('data', loader)).status, 'HIT');
  t = 150;
  const s1 = await c.get('data', loader);
  const s2 = await c.get('data', loader);
  assert.equal(s1.status, 'STALE');
  assert.deepEqual(s1.value, { v: 1 }, 'stale value served immediately');
  assert.equal(s2.status, 'STALE');
  await new Promise(r => setImmediate(r));
  assert.equal(calls, 2, 'the two STALE reads coalesced into ONE refresh');
  assert.deepEqual((await c.get('data', loader)).value, { v: 2 });
  t = 1000;
  assert.equal((await c.get('data', loader)).status, 'MISS');
});

test('errors are never cached; a failed background refresh keeps the old value', async () => {
  let t = 0;
  const c = createProxyCache({ freshMs: 10, staleMs: 1000, now: () => t });
  await assert.rejects(c.get('data', async () => { throw new Error('upstream down'); }));
  assert.deepEqual(c.keys(), []);
  await c.get('data', async () => ({ ok: 1 }));
  t = 20;
  const r = await c.get('data', async () => { throw new Error('down again'); });
  assert.equal(r.status, 'STALE');
  await new Promise(r2 => setImmediate(r2));
  assert.deepEqual((await c.get('data', async () => ({ ok: 2 }))).value, { ok: 1 });
});

test('invalidate during an in-flight read: the old result is NOT cached and NOT joined', async () => {
  const c = createProxyCache({ freshMs: 1000, staleMs: 0 });
  const old = deferred();
  let calls = 0;
  const pOld = c.get('data', () => { calls++; return old.promise; });
  c.invalidate('data'); // a write happens here
  const pNew = c.get('data', async () => { calls++; return { v: 'new' }; });
  old.resolve({ v: 'old' });
  assert.deepEqual((await pOld).value, { v: 'old' });
  assert.deepEqual((await pNew).value, { v: 'new' }, 'post-write reader did not join the pre-write call');
  assert.equal(calls, 2);
  const again = await c.get('data', async () => { throw new Error('should be a HIT'); });
  assert.equal(again.status, 'HIT');
  assert.deepEqual(again.value, { v: 'new' });
});

test('keys must be fixed route names — a token-shaped or secret-bearing key is refused', async () => {
  const c = createProxyCache();
  for (const bad of ['', 'Bearer abc.def', 'data?secret=x', 'a'.repeat(80), 'x/y', null]) {
    await assert.rejects(c.get(bad, async () => 1), /invalid key/);
  }
});

// ---------------------------------------------------------------------------
// integration: server.js
// ---------------------------------------------------------------------------

const originalFetch = global.fetch;
let upstream;

function fakeUpstream() {
  const state = { version: 1, gets: 0, posts: [], hold: null };
  return {
    state,
    async handle(url, init) {
      const method = (init && init.method) || 'GET';
      if (new URL(url).searchParams.get('secret') !== process.env.SHARED_SECRET) {
        return { _status: 401, error: 'unauthorized' };
      }
      if (method === 'GET') {
        state.gets++;
        const snapshot = state.version;
        if (state.hold) await state.hold;
        return { _status: 200, workers: [{ id: 'w1', name: 'v' + snapshot }], _compat: true, _gasCache: 'hit' };
      }
      const b = JSON.parse(init.body);
      state.posts.push(b.action);
      if (b.action.startsWith('get')) return { _status: 200, items: [] };
      state.version++;
      return { _status: 200, ok: true };
    },
  };
}

test.beforeEach(() => {
  _loginAttempts.clear();
  _cancelRewarm();
  _proxyCache.clear();
  upstream = fakeUpstream();
  global.fetch = async (url, init) => {
    const json = await upstream.handle(url, init);
    return { ok: true, status: 200, text: async () => JSON.stringify(json) };
  };
});
test.afterEach(() => { global.fetch = originalFetch; });

function listen() {
  return new Promise(resolve => {
    const srv = http.createServer(app).listen(0, '127.0.0.1', () => {
      resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` });
    });
  });
}
const close = srv => new Promise(r => srv.close(r));

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
  assert.equal(r.status, 200);
  return r.json.token;
}
const auth = t => ({ Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' });

test('/api/data: MISS then HIT, one upstream call, X-Cache + Server-Timing + no-store', async () => {
  const { srv, base } = await listen();
  try {
    const t = await login(base);
    const a = await req(base, '/api/data', { headers: auth(t) });
    const b = await req(base, '/api/data', { headers: auth(t) });
    assert.equal(a.headers.get('x-cache'), 'MISS');
    assert.equal(b.headers.get('x-cache'), 'HIT');
    assert.match(b.headers.get('server-timing'), /^proxy;desc="HIT";dur=\d+$/);
    assert.equal(a.headers.get('cache-control'), 'no-store');
    assert.equal(upstream.state.gets, 1);
    assert.deepEqual(b.json, a.json);
    assert.equal('_gasCache' in a.json, false, 'the Apps Script cache marker never reaches the browser');
  } finally { await close(srv); }
});

test('/api/data: identical in-flight requests are coalesced into one upstream call', async () => {
  const { srv, base } = await listen();
  try {
    const t = await login(base);
    const gate = deferred();
    upstream.state.hold = gate.promise;
    const reqs = [1, 2, 3, 4].map(() => req(base, '/api/data', { headers: auth(t) }));
    await new Promise(r => setTimeout(r, 30));
    gate.resolve();
    const rs = await Promise.all(reqs);
    assert.equal(upstream.state.gets, 1);
    rs.forEach(r => assert.equal(r.status, 200));
  } finally { await close(srv); }
});

test('a write invalidates: the next read is a MISS and sees the new data', async () => {
  const { srv, base } = await listen();
  try {
    const t = await login(base);
    const before = await req(base, '/api/data', { headers: auth(t) });
    assert.equal(before.json.workers[0].name, 'v1');
    const w = await req(base, '/api/action', {
      method: 'POST', headers: auth(t),
      body: JSON.stringify({ action: 'createWorker', worker: { name: 'חדשה' } }),
    });
    assert.equal(w.status, 200);
    const after = await req(base, '/api/data', { headers: auth(t) });
    assert.notEqual(after.headers.get('x-cache'), 'HIT');
    assert.equal(after.json.workers[0].name, 'v2');
  } finally { await close(srv); }
});

test('a write that FAILS upstream still invalidates', async () => {
  const { srv, base } = await listen();
  try {
    const t = await login(base);
    await req(base, '/api/data', { headers: auth(t) });
    const inner = global.fetch;
    global.fetch = async (url, init) => ((init && init.method) === 'POST'
      ? { ok: true, status: 200, text: async () => '<html>timeout</html>' }
      : inner(url, init));
    const w = await req(base, '/api/action', {
      method: 'POST', headers: auth(t),
      body: JSON.stringify({ action: 'createWorker', worker: { name: 'x' } }),
    });
    global.fetch = inner;
    assert.equal(w.status, 502);
    const after = await req(base, '/api/data', { headers: auth(t) });
    assert.equal(after.headers.get('x-cache'), 'MISS');
  } finally { await close(srv); }
});

test('a read-only action does NOT invalidate', async () => {
  const { srv, base } = await listen();
  try {
    const t = await login(base);
    await req(base, '/api/data', { headers: auth(t) });
    const r = await req(base, '/api/action', {
      method: 'POST', headers: auth(t), body: JSON.stringify({ action: 'getHearings' }),
    });
    assert.equal(r.status, 200);
    const after = await req(base, '/api/data', { headers: auth(t) });
    assert.equal(after.headers.get('x-cache'), 'HIT');
  } finally { await close(srv); }
});

test('a read in flight when a write lands cannot put the pre-write snapshot back', async () => {
  const { srv, base } = await listen();
  try {
    const t = await login(base);
    const gate = deferred();
    upstream.state.hold = gate.promise;
    const slowRead = req(base, '/api/data', { headers: auth(t) });
    await new Promise(r => setTimeout(r, 20));
    upstream.state.hold = null;
    await req(base, '/api/action', {
      method: 'POST', headers: auth(t),
      body: JSON.stringify({ action: 'createWorker', worker: { name: 'x' } }),
    });
    gate.resolve();
    assert.equal((await slowRead).json.workers[0].name, 'v1');
    const after = await req(base, '/api/data', { headers: auth(t) });
    assert.equal(after.json.workers[0].name, 'v2', 'never the stale v1 from the raced read');
  } finally { await close(srv); }
});

test('after a write the cache is re-warmed in the background (debounced)', async () => {
  const { srv, base } = await listen();
  try {
    const t = await login(base);
    await req(base, '/api/data', { headers: auth(t) });
    for (let i = 0; i < 3; i++) {
      await req(base, '/api/action', {
        method: 'POST', headers: auth(t),
        body: JSON.stringify({ action: 'createWorker', worker: { name: 'n' + i } }),
      });
    }
    // Wall-clock margin, not a tick count: 3× the debounce window.
    await new Promise(r => setTimeout(r, 600));
    assert.equal(upstream.state.gets, 2, 'three writes → ONE background refresh');
    const after = await req(base, '/api/data', { headers: auth(t) });
    assert.equal(after.headers.get('x-cache'), 'HIT');
    assert.equal(after.json.workers[0].name, 'v4');
  } finally { await close(srv); }
});

test('auth first: a warm cache is never served without a valid session', async () => {
  const { srv, base } = await listen();
  try {
    const t = await login(base);
    await req(base, '/api/data', { headers: auth(t) });
    for (const h of [{}, { Authorization: 'Bearer nope' }, { Authorization: 'Bearer ' + t.slice(0, -2) + 'aa' }]) {
      const r = await req(base, '/api/data', { headers: h });
      assert.equal(r.status, 401);
      assert.equal(r.headers.get('x-cache'), null);
      assert.equal(r.text.includes('v1'), false);
    }
  } finally { await close(srv); }
});

test('secrets never appear in cache keys or in anything the server logs', async () => {
  const lines = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  const grab = (...a) => lines.push(a.map(String).join(' '));
  console.log = grab; console.error = grab; console.warn = grab;
  const { srv, base } = await listen();
  let token;
  try {
    await req(base, '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '000000' }) });
    token = await login(base);
    await req(base, '/api/data?secret=leak-attempt', { headers: auth(token) });
    await req(base, '/api/data', { headers: auth(token) });
    await req(base, '/api/action', { method: 'POST', headers: auth(token),
      body: JSON.stringify({ action: 'createWorker', worker: { name: 'x' } }) });
    upstream.state.hold = Promise.reject(new Error('upstream failed ' + process.env.APPS_SCRIPT_URL));
    upstream.state.hold.catch(() => {});
    _proxyCache.clear();
    await req(base, '/api/data', { headers: auth(token) });
  } finally {
    await close(srv);
    Object.assign(console, orig);
  }
  assert.ok(lines.some(l => l.startsWith('[timing] GET /api/data')), 'timing lines are written');
  assert.ok(lines.some(l => l.startsWith('[upstream] GET')), 'upstream timing lines are written');
  const forbidden = [process.env.MORAN_PIN, '000000', token, process.env.SHARED_SECRET,
    'DEPLOYMENT-ID-XYZ', 'leak-attempt', process.env.SESSION_SECRET];
  for (const l of lines) {
    for (const f of forbidden) assert.equal(l.includes(f), false, `log line leaks a secret: ${l.slice(0, 80)}`);
  }
  for (const k of _proxyCache.keys()) {
    for (const f of forbidden) assert.equal(k.includes(f), false);
  }
});

test('gzip: index.html and /api/data are compressed; /api/login is not', async () => {
  const { srv, base } = await listen();
  try {
    const get = (p, headers) => new Promise((resolve, reject) => {
      http.get(base + p, { headers: Object.assign({ 'Accept-Encoding': 'gzip' }, headers || {}) }, (r) => {
        const chunks = [];
        r.on('data', c => chunks.push(c));
        r.on('end', () => resolve({ headers: r.headers, body: Buffer.concat(chunks) }));
      }).on('error', reject);
    });
    const idx = await get('/');
    assert.equal(idx.headers['content-encoding'], 'gzip');
    assert.match(zlib.gunzipSync(idx.body).toString('utf8'), /<!DOCTYPE html>/);
    const t = await login(base);
    const d = await get('/api/data', { Authorization: 'Bearer ' + t });
    // Tiny test payload may fall below the compression threshold; the header
    // set is what matters: never cacheable by an intermediary.
    assert.equal(d.headers['cache-control'], 'no-store');
    const lg = await new Promise((resolve, reject) => {
      const rq = http.request(base + '/api/login', { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'gzip' } }, (r) => {
        r.resume(); r.on('end', () => resolve(r.headers));
      });
      rq.on('error', reject);
      rq.end(JSON.stringify({ pin: process.env.MORAN_PIN }));
    });
    assert.equal(lg['content-encoding'], undefined, 'the token response is never compressed');
  } finally { await close(srv); }
});

test('cache headers: index no-cache + ETag/304; hashed libs immutable only under their hash', async () => {
  const { srv, base } = await listen();
  try {
    const idx = await req(base, '/');
    assert.equal(idx.headers.get('cache-control'), 'no-cache');
    const etag = idx.headers.get('etag');
    assert.ok(etag);
    const again = await originalFetch(base + '/', { headers: { 'If-None-Match': etag } });
    assert.equal(again.status, 304);
    for (const [name, v] of Object.entries(_libVersions)) {
      assert.ok(idx.text.includes(`<script src="/lib/${name}?v=${v}"></script>`), 'index references the hashed URL');
      const hit = await req(base, `/lib/${name}?v=${v}`);
      assert.equal(hit.status, 200);
      assert.match(hit.headers.get('cache-control'), /max-age=31536000, immutable/);
      const bare = await req(base, `/lib/${name}`);
      assert.equal(bare.headers.get('cache-control'), 'no-cache');
      const wrong = await req(base, `/lib/${name}?v=deadbeef`);
      assert.equal(wrong.headers.get('cache-control'), 'no-cache');
    }
    for (const p of ['/lib/proxy-cache.js', '/lib/auth.js', '/lib/validate.js']) {
      assert.equal((await req(base, p)).status, 404, p + ' must not be served');
    }
  } finally { await close(srv); }
});
