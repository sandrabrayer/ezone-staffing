'use strict';

// PWA installability (Chrome/Android + iOS Safari).
//
// Pinned here:
//   - the manifest is valid JSON with every field an install check reads, and
//     every icon it declares exists as a real PNG of the declared size;
//   - the maskable icon keeps its glyph inside the 80% safe zone;
//   - index.html links the manifest, the apple-touch-icon (180×180), the
//     apple/theme metas, and registers /sw.js;
//   - manifest, sw.js, icons and start_url are reachable WITHOUT a session,
//     with the right Content-Type, no redirect, and never the HTML page;
//   - the service worker has a fetch handler and never handles /api, a
//     non-GET, an Authorization-bearing request, or any other origin (Apps
//     Script, googleusercontent, fonts).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const vm = require('node:vm');

process.env.NODE_ENV = 'test';
process.env.APPS_SCRIPT_URL = 'https://script.example.com/exec';
process.env.SHARED_SECRET = 'p'.repeat(40);
process.env.MORAN_PIN = '4242';
process.env.SESSION_SECRET = 'z'.repeat(64);

const { app } = require('../server');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const manifestText = fs.readFileSync(path.join(PUBLIC, 'manifest.webmanifest'), 'utf8');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const swSource = fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');

// ---- minimal PNG reader: IHDR + (for RGB/RGBA 8-bit) decoded pixels ----
function readPng(file) {
  const b = fs.readFileSync(file);
  assert.deepEqual([...b.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], file + ' is a PNG');
  assert.equal(b.toString('ascii', 12, 16), 'IHDR');
  const width = b.readUInt32BE(16);
  const height = b.readUInt32BE(20);
  const colorType = b[25];
  const idat = [];
  let o = 8;
  while (o < b.length) {
    const len = b.readUInt32BE(o);
    const type = b.toString('ascii', o + 4, o + 8);
    if (type === 'IDAT') idat.push(b.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const px = Buffer.alloc(height * stride);
  const paeth = (a, b2, c) => {
    const p = a + b2 - c, pa = Math.abs(p - a), pb = Math.abs(p - b2), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b2 : c;
  };
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const r = raw[y * (stride + 1) + 1 + x];
      const a = x >= bpp ? px[y * stride + x - bpp] : 0;
      const up = y ? px[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y ? px[(y - 1) * stride + x - bpp] : 0;
      px[y * stride + x] = (r + [0, a, up, (a + up) >> 1, paeth(a, up, c)][f]) & 255;
    }
  }
  return { width, height, bpp, px };
}

// ---------------------------------------------------------------------------
// manifest + icons (static)
// ---------------------------------------------------------------------------

test('manifest is valid JSON with every installability field', () => {
  const m = JSON.parse(manifestText);
  assert.ok(m.name && m.name.length > 0);
  assert.ok(m.short_name && m.short_name.length > 0 && m.short_name.length <= 12);
  assert.equal(m.start_url, '/');
  assert.equal(m.scope, '/');
  assert.equal(m.display, 'standalone');
  assert.equal(m.dir, 'rtl');
  assert.equal(m.lang, 'he');
  assert.match(m.background_color, /^#[0-9a-f]{6}$/i);
  assert.match(m.theme_color, /^#[0-9a-f]{6}$/i);
  const any = m.icons.filter(i => (i.purpose || 'any').split(' ').includes('any'));
  const mask = m.icons.filter(i => (i.purpose || '').split(' ').includes('maskable'));
  assert.ok(any.some(i => i.sizes === '192x192'), 'a 192×192 "any" icon');
  assert.ok(any.some(i => i.sizes === '512x512'), 'a 512×512 "any" icon');
  assert.ok(mask.length >= 1, 'a separate maskable icon');
  assert.ok(mask.every(i => !i.purpose.includes('any')), 'the maskable icon is separate from the "any" ones');
});

test('every declared icon exists as a PNG of exactly the declared size', () => {
  const m = JSON.parse(manifestText);
  for (const icon of m.icons) {
    assert.equal(icon.type, 'image/png');
    assert.ok(icon.src.startsWith('/'), 'absolute path, independent of the page URL');
    const [w, h] = icon.sizes.split('x').map(Number);
    const png = readPng(path.join(PUBLIC, icon.src));
    assert.equal(png.width, w, icon.src);
    assert.equal(png.height, h, icon.src);
  }
  const apple = readPng(path.join(PUBLIC, 'icons', 'apple-touch-icon.png'));
  assert.equal(apple.width, 180);
  assert.equal(apple.height, 180);
});

test('icons are the E-ZONE green "E": opaque green corners, white ink', () => {
  for (const f of ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png']) {
    const { width, bpp, px } = readPng(path.join(PUBLIC, 'icons', f));
    const at = (x, y) => [...px.subarray((y * width + x) * bpp, (y * width + x) * bpp + 3)];
    assert.deepEqual(at(0, 0), [0x0f, 0x63, 0x4f], f + ' corner is #0F634F');
    let white = 0;
    for (let i = 0; i < px.length; i += bpp) if (px[i] === 255 && px[i + 1] === 255 && px[i + 2] === 255) white++;
    const cov = white / (px.length / bpp);
    assert.ok(cov > 0.12 && cov < 0.45, `${f}: letter coverage ${cov.toFixed(2)} is bold but not solid`);
  }
});

test('maskable icon: the whole glyph sits inside the 80% safe-zone circle', () => {
  const { width, height, bpp, px } = readPng(path.join(PUBLIC, 'icons', 'icon-maskable-512.png'));
  const r = 0.4 * width;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * bpp;
      if (px[i] > 0x40) { // any ink (the background red channel is 0x0f)
        const d = Math.hypot(x + 0.5 - width / 2, y + 0.5 - height / 2);
        assert.ok(d <= r, `ink at (${x},${y}) is outside the safe zone`);
      }
    }
  }
});

test('the committed icons are exactly what scripts/gen-icons.js produces', () => {
  const { render, OUTPUTS } = require('../scripts/gen-icons');
  for (const o of OUTPUTS) {
    const committed = fs.readFileSync(path.join(PUBLIC, 'icons', o.file));
    assert.ok(committed.equals(render(o.size, o.scale)), o.file + ' — re-run node scripts/gen-icons.js');
  }
});

test('index.html: manifest link, apple-touch-icon, apple + theme metas, SW registration', () => {
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest"\/>/);
  assert.match(html, /<link rel="apple-touch-icon" sizes="180x180" href="\/icons\/apple-touch-icon\.png"\/>/);
  assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes"\/>/);
  assert.match(html, /<meta name="theme-color" content="#0F634F"\/>/);
  assert.match(html, /navigator\.serviceWorker\.register\('\/sw\.js', \{ scope: '\/' \}\)/);
});

// ---------------------------------------------------------------------------
// served without the PIN, with the right Content-Type
// ---------------------------------------------------------------------------

function listen() {
  return new Promise(resolve => {
    const srv = http.createServer(app).listen(0, '127.0.0.1', () => {
      resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` });
    });
  });
}

async function fetchNoAuth(base, p) {
  const r = await fetch(base + p, { redirect: 'manual' });
  const body = Buffer.from(await r.arrayBuffer());
  return { status: r.status, type: r.headers.get('content-type') || '', headers: r.headers, body };
}

test('manifest, sw.js, icons and start_url are reachable WITHOUT a session, correct MIME, no redirect', async () => {
  const { srv, base } = await listen();
  try {
    const m = await fetchNoAuth(base, '/manifest.webmanifest');
    assert.equal(m.status, 200);
    assert.match(m.type, /^application\/manifest\+json/);
    assert.deepEqual(JSON.parse(m.body.toString('utf8')), JSON.parse(manifestText));

    const sw = await fetchNoAuth(base, '/sw.js');
    assert.equal(sw.status, 200);
    assert.match(sw.type, /^application\/javascript/);
    assert.equal(sw.headers.get('cache-control'), 'no-cache');
    assert.ok(!sw.body.toString('utf8').includes('<!DOCTYPE'), 'never the HTML page');

    const icons = JSON.parse(manifestText).icons.map(i => i.src).concat(['/icons/apple-touch-icon.png']);
    for (const src of icons) {
      const r = await fetchNoAuth(base, src);
      assert.equal(r.status, 200, src);
      assert.equal(r.type, 'image/png', src);
      assert.deepEqual([...r.body.subarray(1, 4)], [0x50, 0x4e, 0x47], src + ' body is a PNG');
    }

    const start = await fetchNoAuth(base, JSON.parse(manifestText).start_url);
    assert.equal(start.status, 200, 'start_url answers 200 directly — no redirect');
    assert.match(start.type, /^text\/html/);

    // Sanity: the data is still gated.
    assert.equal((await fetchNoAuth(base, '/api/data')).status, 401);
  } finally { await new Promise(r => srv.close(r)); }
});

// ---------------------------------------------------------------------------
// service worker behaviour (evaluated in a sandbox)
// ---------------------------------------------------------------------------

function loadSw() {
  const listeners = {};
  const self = {
    location: { origin: 'https://ezone-staffing.up.railway.app' },
    addEventListener(type, fn) { listeners[type] = fn; },
    skipWaiting() {}, clients: { claim() {} },
  };
  const ctx = vm.createContext({ self, URL, caches: {}, fetch: () => { throw new Error('no network in test'); }, Promise });
  vm.runInContext(swSource, ctx);
  return { self, listeners };
}

function fakeRequest(url, opts) {
  const o = opts || {};
  const headers = new Map(Object.entries(o.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  return { url, method: o.method || 'GET', mode: o.mode || 'cors', headers: { get: k => headers.get(k.toLowerCase()) || null } };
}

test('sw.js has a fetch handler and a cache version', () => {
  const { listeners } = loadSw();
  assert.equal(typeof listeners.fetch, 'function');
  assert.equal(typeof listeners.install, 'function');
  assert.equal(typeof listeners.activate, 'function');
  assert.match(swSource, /const CACHE_VERSION = 'v\d+';/);
});

test('sw.js never handles /api, non-GET, Authorization-bearing or cross-origin requests', () => {
  const { self, listeners } = loadSw();
  const O = 'https://ezone-staffing.up.railway.app';
  const never = [
    fakeRequest(O + '/api/data', { headers: { Authorization: 'Bearer t' } }),
    fakeRequest(O + '/api/data'),
    fakeRequest(O + '/api/login', { method: 'POST' }),
    fakeRequest(O + '/api/action', { method: 'POST' }),
    fakeRequest(O + '/api/hadrachot-status'),
    fakeRequest(O + '/api'),
    fakeRequest(O + '/', { method: 'POST' }),
    fakeRequest(O + '/lib/calc.js?v=1', { headers: { Authorization: 'Bearer t' } }),
    fakeRequest('https://script.google.com/macros/s/X/exec?secret=s'),
    fakeRequest('https://script.googleusercontent.com/macros/echo?user_content_key=k'),
    fakeRequest('https://fonts.googleapis.com/css2?family=Heebo'),
    fakeRequest(O + '/sw.js'),
  ];
  for (const r of never) {
    assert.equal(self.__swShouldHandle(r), false, `${r.method} ${r.url}`);
    let responded = false;
    listeners.fetch({ request: r, respondWith() { responded = true; } });
    assert.equal(responded, false, `respondWith must not be called for ${r.method} ${r.url}`);
  }
  for (const r of [fakeRequest(O + '/', { mode: 'navigate' }), fakeRequest(O + '/icons/icon-192.png'),
    fakeRequest(O + '/lib/calc.js?v=abc')]) {
    assert.equal(self.__swShouldHandle(r), true, r.url);
  }
});

test('sw.js source: no Apps Script / Google host and nothing under /api in the precache', () => {
  const code = swSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.equal(/script\.google|googleusercontent/.test(code), false, 'no Google host in the code');
  const pre = /const PRECACHE = \[([\s\S]*?)\];/.exec(swSource)[1];
  assert.equal(/\/api/.test(pre), false);
});
