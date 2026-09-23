#!/usr/bin/env node
/* Measure the initial-load requests of a running staffing app and check the
 * PWA install prerequisites. No dependencies (Node ≥ 20).
 *
 *   STAFFING_PIN=… node scripts/measure-load.js https://ezone-staffing.up.railway.app
 *
 * Prints, per request: status, Content-Type, bytes on the wire (gzip
 * requested), time to first byte and total time, and X-Cache for /api/data.
 * /api/data is fetched three times so the proxy cache shows MISS/STALE → HIT.
 *
 * The PIN is read from the environment only and is never printed; the session
 * this opens is revoked (POST /api/logout) before the script exits. Without
 * STAFFING_PIN only the public requests (shell, libs, PWA files) are timed.
 */
'use strict';

const base = (process.argv[2] || '').replace(/\/+$/, '');
if (!/^https?:\/\//.test(base)) {
  console.error('usage: STAFFING_PIN=… node scripts/measure-load.js https://host');
  process.exit(2);
}

async function timed(path, init) {
  const t0 = performance.now();
  const r = await fetch(base + path, Object.assign({ redirect: 'manual' }, init || {},
    { headers: Object.assign({ 'Accept-Encoding': 'gzip' }, (init && init.headers) || {}) }));
  const ttfb = performance.now() - t0;
  const buf = Buffer.from(await r.arrayBuffer());
  return {
    path, status: r.status, type: (r.headers.get('content-type') || '').split(';')[0],
    wire: Number(r.headers.get('content-length')) || null, decoded: buf.length,
    enc: r.headers.get('content-encoding') || '', xcache: r.headers.get('x-cache') || '',
    cc: r.headers.get('cache-control') || '', ttfb: Math.round(ttfb), total: Math.round(performance.now() - t0), buf,
  };
}

function row(r) {
  return [r.path.padEnd(28), String(r.status).padEnd(4), r.type.padEnd(26), (r.enc || '-').padEnd(5),
    String(r.decoded).padStart(8), `${r.ttfb}ms`.padStart(8), `${r.total}ms`.padStart(8), r.xcache].join(' ');
}

(async () => {
  console.log('path                         st   content-type               enc   decoded     ttfb    total cache');
  const index = await timed('/');
  console.log(row(index));
  const libs = [...index.buf.toString('utf8').matchAll(/<script src="(\/lib\/[^"]+)"/g)].map((m) => m[1]);
  const pub = await Promise.all(libs.concat(['/manifest.webmanifest', '/sw.js', '/icons/icon-192.png',
    '/icons/icon-512.png', '/icons/icon-maskable-512.png', '/icons/apple-touch-icon.png']).map((p) => timed(p)));
  pub.forEach((r) => console.log(row(r)));

  // PWA prerequisites
  const want = { '/manifest.webmanifest': 'application/manifest+json', '/sw.js': 'application/javascript',
    '/icons/icon-192.png': 'image/png', '/icons/icon-512.png': 'image/png', '/icons/icon-maskable-512.png': 'image/png' };
  let pwaOk = index.status === 200;
  for (const r of pub) {
    if (want[r.path] && (r.status !== 200 || r.type !== want[r.path])) {
      pwaOk = false;
      console.log(`  ✗ ${r.path}: ${r.status} ${r.type} (want 200 ${want[r.path]})`);
    }
  }
  console.log(pwaOk ? 'PWA prerequisites: OK' : 'PWA prerequisites: FAILING (see above)');

  const pin = process.env.STAFFING_PIN;
  if (!pin) { console.log('(STAFFING_PIN not set — /api/data not measured)'); return; }
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin }) });
  if (!login.ok) { console.error('login failed: HTTP ' + login.status); process.exit(1); }
  const { token } = await login.json();
  const auth = { Authorization: 'Bearer ' + token };
  try {
    for (let i = 0; i < 3; i++) console.log(row(await timed('/api/data', { headers: auth })));
  } finally {
    await fetch(base + '/api/logout', { method: 'POST', headers: auth }).catch(() => {});
  }
})().catch((e) => { console.error('measure failed:', e.message); process.exit(1); });
