'use strict';

// The disk snapshot, end to end with a REAL server process (docs/perf-open.md).
//
//   - Boot logs `[proxy] cache snapshot dir=… writable=… restored entries=N`
//     and `[proxy] upstream concurrency=2 volume mount=…`.
//   - A process started over a snapshot answers the first /api/data from
//     it at once (X-Cache: STALE) while Apps Script is still slow.
//   - SIGTERM writes the snapshot before exit: 0600, and never a secret.
//   - RAILWAY_VOLUME_MOUNT_PATH alone picks <mount>/staffing-cache.
//   - An unwritable directory is logged (writable=false) and changes nothing
//     else: the app still serves.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SECRET = 'boot-shared-secret-'.padEnd(40, 'B');
const PIN = '918273';

// A fake Apps Script over HTTP; each GET answers after `delayMs`.
function startUpstream(delayMs) {
  const state = { gets: 0, version: 1 };
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.method !== 'GET') { res.end('{"_status":200,"ok":true}'); return; }
      state.gets++;
      const v = state.version;
      setTimeout(() => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ _status: 200, workers: [{ id: 'w1', name: 'live v' + v }], hearings: [], feedLog: [] }));
      }, delayMs);
    }).listen(0, '127.0.0.1', () => resolve({ srv, state, url: `http://127.0.0.1:${srv.address().port}/exec` }));
  });
}

function startApp(env) {
  const port = 30000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      NODE_ENV: 'production', PORT: String(port), SHARED_SECRET: SECRET, MORAN_PIN: PIN,
      SESSION_SECRET: 'b'.repeat(64), CACHE_SNAPSHOT_INTERVAL_MS: '0', DATA_CACHE_KEEPWARM_MS: '0',
      HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '',
      RAILWAY_VOLUME_MOUNT_PATH: '',
    }, env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  const onData = (d) => String(d).split('\n').filter(Boolean).forEach((l) => logs.push(l));
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  const base = `http://127.0.0.1:${port}`;
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = async () => {
      try {
        const r = await fetch(base + '/api/health');
        if (r.ok) return resolve({ child, base, logs });
      } catch (_) { /* not up yet */ }
      if (Date.now() - t0 > 15000) return reject(new Error('server did not start: ' + logs.join('\n')));
      setTimeout(tick, 25);
    };
    tick();
  });
}

function stop(a, signal) {
  return new Promise((resolve) => {
    a.child.once('exit', (code) => resolve(code));
    a.child.kill(signal || 'SIGTERM');
  });
}

async function login(base) {
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: PIN }) });
  return (await r.json()).token;
}

async function waitFor(fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

test('SIGTERM leaves a 0600 snapshot with no secret; the next process serves it at once as STALE', async () => {
  const up = await startUpstream(50);
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'boot-snap-')), 'cache');
  try {
    let a = await startApp({ APPS_SCRIPT_URL: up.url, CACHE_SNAPSHOT_DIR: dir });
    assert.ok(await waitFor(() => a.logs.some((l) => /\[upstream\] bundle|\[upstream\] GET 200/.test(l)), 5000), 'warm-up ran');
    const boot1 = a.logs.find((l) => l.startsWith('[proxy] cache snapshot dir='));
    assert.equal(boot1, `[proxy] cache snapshot dir=${dir} writable=true restored entries=0 (absent)`);
    assert.ok(a.logs.includes('[proxy] upstream concurrency=2 volume mount=none'));
    await stop(a, 'SIGTERM');

    const file = path.join(dir, 'read-cache.json');
    assert.ok(fs.existsSync(file), 'SIGTERM wrote the snapshot');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.includes('live v1'));
    for (const bad of [SECRET, PIN, 'secret=', up.url]) assert.ok(!text.includes(bad), 'snapshot must not hold ' + bad.slice(0, 10));

    // Next process: Apps Script is now SLOW (3 s). The first read must not wait for it.
    up.state.version = 2;
    const slow = await startUpstream(3000);
    slow.state.version = 2;
    a = await startApp({ APPS_SCRIPT_URL: slow.url, CACHE_SNAPSHOT_DIR: dir });
    const boot2 = a.logs.find((l) => l.startsWith('[proxy] cache snapshot dir='));
    assert.match(boot2, new RegExp(`^\\[proxy\\] cache snapshot dir=${dir.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} writable=true restored entries=1 \\(ok\\) ageMs=\\d+$`));
    const token = await login(a.base);
    const t0 = Date.now();
    const r = await fetch(a.base + '/api/data', { headers: { Authorization: 'Bearer ' + token } });
    const ms = Date.now() - t0;
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-cache'), 'STALE');
    assert.equal((await r.json()).workers[0].name, 'live v1');
    assert.ok(ms < 1500, `answered from the snapshot in ${ms} ms, not after Apps Script`);
    await stop(a, 'SIGTERM');
    slow.srv.close();
  } finally {
    up.srv.close();
  }
});

test('RAILWAY_VOLUME_MOUNT_PATH alone → <mount>/staffing-cache, logged at boot', async () => {
  const up = await startUpstream(10);
  const mount = fs.mkdtempSync(path.join(os.tmpdir(), 'vol-'));
  try {
    const a = await startApp({ APPS_SCRIPT_URL: up.url, CACHE_SNAPSHOT_DIR: '', RAILWAY_VOLUME_MOUNT_PATH: mount });
    assert.ok(a.logs.includes(`[proxy] upstream concurrency=2 volume mount=${mount}`));
    assert.ok(a.logs.some((l) => l.startsWith(`[proxy] cache snapshot dir=${path.join(mount, 'staffing-cache')} writable=true`)));
    assert.ok(await waitFor(() => a.logs.some((l) => /\[upstream\] GET 200/.test(l)), 5000), 'warm-up ran');
    await stop(a, 'SIGTERM');
    assert.ok(fs.existsSync(path.join(mount, 'staffing-cache', 'read-cache.json')));
  } finally { up.srv.close(); }
});

test('an unwritable snapshot dir is logged and nothing else changes', async () => {
  const up = await startUpstream(10);
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nodir-')), 'a-file');
  fs.writeFileSync(f, 'x');
  try {
    const a = await startApp({ APPS_SCRIPT_URL: up.url, CACHE_SNAPSHOT_DIR: path.join(f, 'sub') });
    assert.ok(a.logs.some((l) => /^\[proxy\] cache snapshot dir=.* writable=false reason=\w+ restored entries=0/.test(l)));
    const token = await login(a.base);
    const r = await fetch(a.base + '/api/data', { headers: { Authorization: 'Bearer ' + token } });
    assert.equal(r.status, 200, 'the app still serves');
    await stop(a, 'SIGTERM');
  } finally { up.srv.close(); }
});

test('CACHE_SNAPSHOT=0 disables it entirely', async () => {
  const up = await startUpstream(10);
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'off-')), 'cache');
  try {
    const a = await startApp({ APPS_SCRIPT_URL: up.url, CACHE_SNAPSHOT_DIR: dir, CACHE_SNAPSHOT: '0' });
    assert.ok(a.logs.includes('[proxy] cache snapshot disabled (CACHE_SNAPSHOT=0)'));
    await stop(a, 'SIGTERM');
    assert.equal(fs.existsSync(path.join(dir, 'read-cache.json')), false);
  } finally { up.srv.close(); }
});
