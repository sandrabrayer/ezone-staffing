'use strict';

// HTTP guards for the בקרת שכר surface the Express proxy exposes.
//
// The whole point of this file is that a route can look right in server.js and
// still 404 — one of these caught exactly that for /lib/xlsx_write.js, which
// the page loads with a <script> tag.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = 'test';
process.env.SHARED_SECRET = process.env.SHARED_SECRET || 'test-shared-secret';
process.env.MORAN_PIN = process.env.MORAN_PIN || '4242';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'a'.repeat(48);
process.env.APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL || 'https://example.invalid/exec';

const { app } = require('../server');

const ROOT = path.join(__dirname, '..');
const originalFetch = global.fetch;

function listen() {
  return new Promise((resolve) => {
    const srv = http.createServer(app).listen(0, '127.0.0.1', () => {
      resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` });
    });
  });
}

async function withServer(fn) {
  const { srv, base } = await listen();
  try { return await fn(base); }
  finally { await new Promise(r => srv.close(r)); }
}

async function login(base) {
  const r = await originalFetch(base + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: process.env.MORAN_PIN }),
  });
  assert.strictEqual(r.status, 200);
  return (await r.json()).token;
}

test('every client library the page loads is actually served', async () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const tags = [...html.matchAll(/<script src="(\/lib\/[^"]+)"><\/script>/g)].map(m => m[1]);
  assert.ok(tags.length >= 4, 'the page loads the shared libraries');
  await withServer(async (base) => {
    for (const src of tags) {
      const r = await originalFetch(base + src);
      assert.strictEqual(r.status, 200, `${src} must be served, not 404`);
      assert.match(r.headers.get('content-type') || '', /javascript/);
    }
  });
});

test('the server-only libraries are NOT served', async () => {
  await withServer(async (base) => {
    for (const src of ['/lib/validate.js', '/lib/auth.js', '/lib/xlsx_read.js', '/lib/migrate.js']) {
      const r = await originalFetch(base + src);
      assert.strictEqual(r.status, 404, `${src} must never reach the browser`);
    }
  });
});

test('pdfjs is served from the app itself', async () => {
  await withServer(async (base) => {
    for (const src of ['/vendor/pdf.min.mjs', '/vendor/pdf.worker.min.mjs']) {
      const r = await originalFetch(base + src);
      assert.strictEqual(r.status, 200, src);
      assert.match(r.headers.get('content-type') || '', /javascript/);
    }
  });
});

test('GET /api/payroll/run demands a session', async () => {
  await withServer(async (base) => {
    const r = await originalFetch(base + '/api/payroll/run');
    assert.strictEqual(r.status, 401);
  });
});

test('GET /api/payroll/run validates its query BEFORE calling upstream', async () => {
  await withServer(async (base) => {
    const token = await login(base);
    let called = false;
    global.fetch = async () => { called = true; throw new Error('upstream must not be reached'); };
    try {
      for (const qs of ['?runId=../../etc', '?runId=nope', '?month=2026-13', '?month=x']) {
        const r = await originalFetch(base + '/api/payroll/run' + qs, {
          headers: { Authorization: 'Bearer ' + token },
        });
        assert.strictEqual(r.status, 400, qs);
        assert.ok(!called, 'a bad query never reaches the Apps Script backend: ' + qs);
      }
    } finally {
      global.fetch = originalFetch;
    }
  });
});

test('GET /api/payroll/run forwards the secret and only validated params', async () => {
  await withServer(async (base) => {
    const token = await login(base);
    let seen = null;
    global.fetch = async (url) => {
      seen = new URL(url);
      return { ok: true, status: 200, text: async () => JSON.stringify({ _status: 200, ok: true, runs: [] }) };
    };
    try {
      const r = await originalFetch(base + '/api/payroll/run?month=2026-08&evil=1', {
        headers: { Authorization: 'Bearer ' + token },
      });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(seen.searchParams.get('action'), 'getPayrollRun');
      assert.strictEqual(seen.searchParams.get('month'), '2026-08');
      assert.strictEqual(seen.searchParams.get('secret'), process.env.SHARED_SECRET);
      assert.strictEqual(seen.searchParams.get('evil'), null, 'unknown params are dropped, not relayed');
    } finally {
      global.fetch = originalFetch;
    }
  });
});

test('POST /api/action rejects a malformed payroll payload before upstream', async () => {
  await withServer(async (base) => {
    const token = await login(base);
    let called = false;
    global.fetch = async () => { called = true; throw new Error('upstream must not be reached'); };
    try {
      const r = await originalFetch(base + '/api/action', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'resolvePayrollFinding', runId: 'pr_abcd1234', lineId: 'L1', ruleId: 'R07', decision: 'approve', note: 'x' }),
      });
      assert.strictEqual(r.status, 400);
      assert.match((await r.json()).error, /note too short/);
      assert.ok(!called);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
