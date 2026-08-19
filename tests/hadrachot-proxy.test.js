'use strict';

// GET /api/hadrachot-status — the server-side proxy to the hadrachot app's
// first-hadracha status feed. Runs in its OWN process (node --test spawns one
// per file) so HADRACHOT_STATUS_URL / HADRACHOT_STATUS_SECRET can be set
// BEFORE server.js is required; the unset-env case lives in server.test.js,
// whose process deliberately never sets them.
//
// Pinned here:
//   - the route is session-gated (PIN token) like every other /api route;
//   - the secret is attached server-side as a query param and NEVER appears
//     in anything sent back to the browser;
//   - upstream JSON is relayed verbatim under `data` with configured:true;
//   - upstream failure (non-JSON, _status>=400, network error) → 5xx with a
//     generic body, so the client shows nothing rather than false alerts.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.NODE_ENV = 'test';
process.env.APPS_SCRIPT_URL = 'https://script.example.com/exec';
process.env.SHARED_SECRET = 's'.repeat(40);
process.env.MORAN_PIN = '4242';
process.env.SESSION_SECRET = 'x'.repeat(64);
process.env.HADRACHOT_STATUS_URL = 'https://script.example.com/hadrachot/exec';
process.env.HADRACHOT_STATUS_SECRET = 'hadrachot-status-secret-value';

const { app } = require('../server');
const { signToken } = require('../lib/auth');

const originalFetch = global.fetch;

// Per-test upstream stub. Each test assigns `upstream` (an async url =>
// response-ish) and can inspect `calls` afterwards.
let upstream;
let calls;

test.beforeEach(() => {
  calls = [];
  upstream = null;
  global.fetch = async (url, init) => {
    calls.push(String(url));
    return upstream(String(url), init);
  };
});

test.afterEach(() => {
  global.fetch = originalFetch;
});

function listen() {
  return new Promise(resolve => {
    const srv = http.createServer(app).listen(0, '127.0.0.1', () => {
      resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` });
    });
  });
}

async function close(srv) {
  await new Promise(r => srv.close(r));
}

async function getStatus(base, token) {
  const headers = token ? { 'Authorization': 'Bearer ' + token } : {};
  const resp = await originalFetch(base + '/api/hadrachot-status', { headers });
  const text = await resp.text();
  return { status: resp.status, json: JSON.parse(text), raw: text };
}

function freshToken() {
  return signToken(process.env.SESSION_SECRET, 1);
}

test('unauthenticated request is rejected and never proxied upstream', async () => {
  const { srv, base } = await listen();
  try {
    upstream = async () => { throw new Error('must not be called'); };
    const r = await getStatus(base, null);
    assert.equal(r.status, 401);
    assert.equal(calls.length, 0, 'no upstream call without a session');
  } finally { await close(srv); }
});

test('happy path: secret attached server-side, payload relayed under data', async () => {
  const { srv, base } = await listen();
  try {
    const payload = {
      _status: 200,
      guides: [
        { name: 'דנה לוי', house: 'ramot', firstHadrachaDone: true },
        { name: 'יואב כהן', house: 'asher', firstHadrachaDone: false },
      ],
    };
    upstream = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(payload) });

    const r = await getStatus(base, freshToken());
    assert.equal(r.status, 200);
    assert.equal(r.json.configured, true);
    assert.deepEqual(r.json.data.guides.map(g => g.name), ['דנה לוי', 'יואב כהן']);
    assert.ok(!('_status' in r.json.data), '_status is stripped before relaying');

    assert.equal(calls.length, 1);
    const u = new URL(calls[0]);
    assert.equal(u.origin + u.pathname, process.env.HADRACHOT_STATUS_URL,
      'proxies to HADRACHOT_STATUS_URL');
    assert.equal(u.searchParams.get('secret'), process.env.HADRACHOT_STATUS_SECRET,
      'the secret travels server-side only, as a query param upstream');
    assert.ok(!r.raw.includes(process.env.HADRACHOT_STATUS_SECRET),
      'the secret NEVER appears in the browser response');
  } finally { await close(srv); }
});

test('upstream non-JSON → 502 with a generic body', async () => {
  const { srv, base } = await listen();
  try {
    upstream = async () => ({ ok: true, status: 200, text: async () => '<html>sign in</html>' });
    const r = await getStatus(base, freshToken());
    assert.equal(r.status, 502);
    assert.equal(r.json.error, 'hadrachot status unavailable');
    assert.ok(!r.raw.includes('sign in'), 'upstream body is never echoed');
  } finally { await close(srv); }
});

test('upstream _status 401 (wrong/rotated secret) → 5xx, never data', async () => {
  const { srv, base } = await listen();
  try {
    upstream = async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({ _status: 401, error: 'unauthorized' }),
    });
    const r = await getStatus(base, freshToken());
    assert.equal(r.status, 502);
    assert.ok(!('data' in r.json) && !('configured' in r.json),
      'an upstream auth failure must not look like a configured, healthy feed');
  } finally { await close(srv); }
});

test('upstream network error → 502, client can safely show nothing', async () => {
  const { srv, base } = await listen();
  try {
    upstream = async () => { throw new Error('ECONNREFUSED'); };
    const r = await getStatus(base, freshToken());
    assert.equal(r.status, 502);
    assert.equal(r.json.error, 'hadrachot status unavailable');
  } finally { await close(srv); }
});
