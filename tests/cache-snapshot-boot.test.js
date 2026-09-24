'use strict';

// The disk snapshot, end to end with a REAL server process (docs/perf-open.md).
//
//   - Boot logs `[proxy] cache snapshot dir=… writable=… restored entries=N`
//     and `[proxy] upstream concurrency=2 volume mount=…`.
//   - A process started over a snapshot answers the first /api/data from
//     it at once (X-Cache: STALE) while Apps Script is still slow.
//   - SIGTERM writes the snapshot before exit: 0600, ENCRYPTED (the data
//     is not readable in the file), and never a secret.
//   - RAILWAY_VOLUME_MOUNT_PATH alone picks <mount>/staffing-cache.
//   - An unwritable directory is logged (writable=false) and changes nothing
//     else: the app still serves.
//   - Without CACHE_SNAPSHOT_KEY (or with an invalid one) NO snapshot is
//     written or read, and «snapshot disabled: no key» is logged ONCE.
//   - A file made with another key is ignored, not an error.
//   - The unencrypted read-cache.json an earlier version wrote is deleted
//     at boot, key or no key.
//   - No log line carries the key or any of the data.

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
const snap = require('../lib/cache-snapshot');
const KEY_B64 = require('node:crypto').randomBytes(32).toString('base64');
const KEY = Buffer.from(KEY_B64, 'base64');

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
      RAILWAY_VOLUME_MOUNT_PATH: '', CACHE_SNAPSHOT_KEY: KEY_B64,
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

test('SIGTERM leaves a 0600 ENCRYPTED snapshot with no secret; the next process serves it at once as STALE', async () => {
  const up = await startUpstream(50);
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'boot-snap-')), 'cache');
  try {
    let a = await startApp({ APPS_SCRIPT_URL: up.url, CACHE_SNAPSHOT_DIR: dir });
    assert.ok(await waitFor(() => a.logs.some((l) => /\[upstream\] bundle|\[upstream\] GET 200/.test(l)), 5000), 'warm-up ran');
    const boot1 = a.logs.find((l) => l.startsWith('[proxy] cache snapshot dir='));
    assert.equal(boot1, `[proxy] cache snapshot dir=${dir} writable=true restored entries=0 (absent)`);
    assert.ok(a.logs.includes('[proxy] upstream concurrency=2 volume mount=none'));
    await stop(a, 'SIGTERM');

    const file = path.join(dir, 'read-cache.enc');
    assert.ok(fs.existsSync(file), 'SIGTERM wrote the snapshot');
    assert.equal(fs.existsSync(path.join(dir, 'read-cache.json')), false, 'never a plaintext file');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const raw = fs.readFileSync(file);
    assert.ok(!raw.includes('live v1'), 'the data is not readable in the file');
    assert.ok(!raw.includes('workers'), 'not even the field names');
    const text = snap.decrypt(raw, KEY);
    assert.ok(text.includes('live v1'), 'it decrypts with the key');
    for (const bad of [SECRET, PIN, 'secret=', up.url, KEY_B64]) {
      assert.ok(!text.includes(bad) && !raw.includes(bad), 'snapshot must not hold ' + bad.slice(0, 10));
    }
    for (const line of a.logs) assert.ok(!line.includes(KEY_B64) && !line.includes('live v1'), 'log leaked: ' + line.slice(0, 60));

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
    assert.ok(fs.existsSync(path.join(mount, 'staffing-cache', 'read-cache.enc')));
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
    assert.equal(fs.existsSync(path.join(dir, 'read-cache.enc')), false);
  } finally { up.srv.close(); }
});

// ---------------------------------------------------------------------------
// CACHE_SNAPSHOT_KEY
// ---------------------------------------------------------------------------

const count = (logs, re) => logs.filter((l) => re.test(l)).length;

test('no CACHE_SNAPSHOT_KEY → no snapshot written, none read, «snapshot disabled: no key» logged ONCE', async () => {
  const up = await startUpstream(10);
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nokey-')), 'cache');
  try {
    // A valid encrypted file from an earlier keyed run is NOT read either.
    const seeded = snap.serialize([['data', { value: { workers: [{ id: 'w', name: 'from disk' }] }, storedAt: Date.now() }]]).text;
    assert.equal(snap.writeSnapshot(dir, seeded, KEY).ok, true);
    const before = fs.readFileSync(path.join(dir, 'read-cache.enc'));

    const a = await startApp({ APPS_SCRIPT_URL: up.url, CACHE_SNAPSHOT_DIR: dir, CACHE_SNAPSHOT_KEY: '' });
    assert.ok(await waitFor(() => a.logs.some((l) => /\[upstream\] GET 200/.test(l)), 5000), 'warm-up ran');
    const token = await login(a.base);
    // Several refreshes: each would have scheduled a save.
    for (let i = 0; i < 3; i++) {
      const r = await fetch(a.base + '/api/data', { headers: { Authorization: 'Bearer ' + token } });
      assert.equal(r.status, 200, 'the app still serves');
      assert.notEqual((await r.json()).workers[0].name, 'from disk', 'the file was not read');
    }
    await stop(a, 'SIGTERM');
    assert.equal(count(a.logs, /snapshot disabled: no key/), 1, 'logged exactly once:\n' + a.logs.join('\n'));
    assert.ok(a.logs.includes('[proxy] snapshot disabled: no key'));
    assert.ok(!a.logs.some((l) => /cache snapshot saved|cache snapshot dir=/.test(l)), 'no save, no restore');
    assert.deepEqual(fs.readFileSync(path.join(dir, 'read-cache.enc')), before, 'the file was not touched');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['read-cache.enc'], 'nothing else was written');
  } finally { up.srv.close(); }
});

test('an invalid CACHE_SNAPSHOT_KEY is refused the same way, and never echoed', async () => {
  const up = await startUpstream(10);
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'badkey-')), 'cache');
  const bad = 'my-short-passphrase';
  try {
    const a = await startApp({ APPS_SCRIPT_URL: up.url, CACHE_SNAPSHOT_DIR: dir, CACHE_SNAPSHOT_KEY: bad });
    assert.ok(await waitFor(() => a.logs.some((l) => /\[upstream\] GET 200/.test(l)), 5000), 'warm-up ran');
    await stop(a, 'SIGTERM');
    assert.equal(count(a.logs, /snapshot disabled: invalid key/), 1);
    assert.ok(!a.logs.some((l) => l.includes(bad)), 'the key is never logged');
    assert.equal(fs.existsSync(path.join(dir, 'read-cache.enc')), false);
  } finally { up.srv.close(); }
});

test('a snapshot made with ANOTHER key is ignored (not an error) and replaced with one under the current key', async () => {
  const up = await startUpstream(10);
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rotkey-')), 'cache');
  try {
    const other = require('node:crypto').randomBytes(32);
    const seeded = snap.serialize([['data', { value: { workers: [{ id: 'w', name: 'old key' }] }, storedAt: Date.now() }]]).text;
    assert.equal(snap.writeSnapshot(dir, seeded, other).ok, true);
    const a = await startApp({ APPS_SCRIPT_URL: up.url, CACHE_SNAPSHOT_DIR: dir });
    const boot = a.logs.find((l) => l.startsWith('[proxy] cache snapshot dir='));
    assert.match(boot, /restored entries=0 \(ignored \(cannot decrypt: wrong key or damaged\)\)$/);
    assert.ok(await waitFor(() => a.logs.some((l) => /\[upstream\] GET 200/.test(l)), 5000), 'warm-up ran');
    await stop(a, 'SIGTERM');
    const raw = fs.readFileSync(path.join(dir, 'read-cache.enc'));
    assert.equal(snap.decrypt(raw, other), null, 'no longer the old key');
    assert.ok(snap.decrypt(raw, KEY).includes('live v1'), 'rewritten under the current key');
  } finally { up.srv.close(); }
});

test('the UNENCRYPTED read-cache.json an earlier version wrote is deleted at boot — with a key and without one', async () => {
  for (const key of [KEY_B64, '']) {
    const up = await startUpstream(10);
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-')), 'cache');
    fs.mkdirSync(dir, { recursive: true });
    const legacy = path.join(dir, 'read-cache.json');
    fs.writeFileSync(legacy, JSON.stringify({ v: 1, savedAt: Date.now(), entries: [{ key: 'data', storedAt: Date.now(), value: { workers: [{ id: 'w', name: 'plaintext salary 12000' }] } }] }));
    try {
      const a = await startApp({ APPS_SCRIPT_URL: up.url, CACHE_SNAPSHOT_DIR: dir, CACHE_SNAPSHOT_KEY: key });
      assert.ok(await waitFor(() => a.logs.some((l) => /\[upstream\] GET 200/.test(l)), 5000), 'warm-up ran');
      await stop(a, 'SIGTERM');
      assert.equal(fs.existsSync(legacy), false, 'plaintext file deleted (key=' + (key ? 'set' : 'unset') + ')');
      assert.equal(count(a.logs, /removed the old unencrypted cache snapshot/), 1);
      assert.ok(!a.logs.some((l) => l.includes('plaintext salary')), 'its contents never logged');
    } finally { up.srv.close(); }
  }
});
