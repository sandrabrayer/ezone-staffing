'use strict';

// Save-flow bench (docs/save-flow.md). NOT production numbers.
//
// The real server.js as a child process over a MOCK Apps Script that
// answers every call after UPSTREAM_MS (default 3000). Measures, per
// scenario, how long POST /api/action takes to answer — i.e. how long the
// «שומר…» button stays busy — and, for a save the page follows with a full
// reload, how long until the page has fresh data.
//
//   node scripts/measure-save.js            # all scenarios, prints a table
//   UPSTREAM_MS=2000 node scripts/measure-save.js
//
// Scenarios:
//   1 idle            — a save with nothing else in flight.
//   2 behind reads    — a save issued while a keep-warm (background) read and
//                       a page refresh read (user) are already in flight, plus
//                       one more page refresh queued ahead of it.
//   3 save + reload   — a save the page follows with a full /api/data reload
//                       (terminate, and every fallback path): the cache was
//                       invalidated by the write, so the reload is a MISS.

const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const UPSTREAM_MS = Number(process.env.UPSTREAM_MS) || 3000;
const SECRET = 'bench-shared-secret-'.padEnd(40, 'S');
const PIN = '246810';

function startUpstream() {
  let version = 1;
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => setTimeout(() => {
        res.setHeader('Content-Type', 'application/json');
        if (req.method === 'POST') {
          version++;
          const p = JSON.parse(body || '{}');
          res.end(JSON.stringify({ _status: 200, ok: true, assignment: Object.assign({ id: p.id || 'a1' }, p.assignment || {}) }));
        } else {
          res.end(JSON.stringify({ _status: 200, workers: [{ id: 'w1', name: 'v' + version }], assignments: [], hearings: [], feedLog: [] }));
        }
      }, UPSTREAM_MS));
    }).listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}/exec` }));
  });
}

function startApp(upUrl) {
  const port = 30000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      NODE_ENV: 'production', PORT: String(port), SHARED_SECRET: SECRET, MORAN_PIN: PIN,
      SESSION_SECRET: 'b'.repeat(64), APPS_SCRIPT_URL: upUrl, CACHE_SNAPSHOT: '0',
      DATA_CACHE_KEEPWARM_MS: '0', DATA_CACHE_REWARM_MS: '0', DATA_CACHE_FRESH_MS: '0',
      HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  const base = `http://127.0.0.1:${port}`;
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = async () => {
      try { if ((await fetch(base + '/api/health')).ok) return resolve({ child, base }); } catch (_) { /* not up */ }
      if (Date.now() - t0 > 15000) return reject(new Error('server did not start'));
      setTimeout(tick, 25);
    };
    tick();
  });
}

async function login(base) {
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: PIN }) });
  return (await r.json()).token;
}

const save = (base, token) => fetch(base + '/api/action', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
  body: JSON.stringify({ action: 'updateAssignment', id: 'a1', assignment: {
    workerId: 'w1', house: 'ramot', role: 'משווק/ת', roleDetail: '', employmentType: 'per_case_commission',
    notes: '', allowance: 0, status: 'active', statusDate: '' } }),
}).then((r) => r.status);
const read = (base, token) => fetch(base + '/api/data', { headers: { Authorization: 'Bearer ' + token } }).then((r) => r.status);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function scenario(name, fn) {
  const up = await startUpstream();
  const app = await startApp(up.url);
  try {
    const token = await login(app.base);
    await sleep(UPSTREAM_MS + 300); // let the boot warm-up finish
    const out = await fn(app.base, token);
    return Object.assign({ name }, out);
  } finally {
    app.child.kill('SIGKILL');
    up.srv.close();
  }
}

async function main() {
  const rows = [];
  rows.push(await scenario('1 idle', async (base, token) => {
    const t0 = Date.now();
    const st = await save(base, token);
    return { saveMs: Date.now() - t0, status: st };
  }));
  rows.push(await scenario('2 behind reads', async (base, token) => {
    // Two upstream reads in flight (both slots) and one more queued, then
    // the save. In the app this shape comes from a keep-warm / re-warm /
    // «מתעדכן…» refresh racing a post-save reload — invalidate() drops the
    // read coalescing, so a pre-save and a post-save read can both be
    // running. Uncached read-only actions stand in for them here.
    const act = (body) => fetch(base + '/api/action', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(body) }).then((r) => r.status);
    const reads = [act({ action: 'getHearings' }), act({ action: 'getBudgets' })];
    await sleep(30);
    reads.push(act({ action: 'getMonthlyActuals', month: '2026-09' }));
    await sleep(30);
    const t0 = Date.now();
    const st = await save(base, token);
    const ms = Date.now() - t0;
    await Promise.all(reads);
    return { saveMs: ms, status: st };
  }));
  rows.push(await scenario('3 save + reload', async (base, token) => {
    const t0 = Date.now();
    const st = await save(base, token);
    const saveMs = Date.now() - t0;
    await read(base, token);
    return { saveMs, status: st, untilReloadedMs: Date.now() - t0 };
  }));
  rows.push(await scenario('4 worker form, role change', async (base, token) => {
    // The worker form sends updateWorker AND updateAssignment, one after the
    // other. SAVE_WRITES=1 measures the form after the fix, which skips the
    // worker write when name / phone / notes / date / commitment are unchanged.
    const n = Number(process.env.SAVE_WRITES || 2);
    const t0 = Date.now();
    let st = 0;
    for (let i = 0; i < n; i++) st = await save(base, token);
    return { saveMs: Date.now() - t0, status: st };
  }));
  console.log(`upstream latency ${UPSTREAM_MS} ms`);
  console.log('| scenario | save answered (ms) | page has fresh data (ms) | status |');
  console.log('|---|---|---|---|');
  rows.forEach((r) => console.log(`| ${r.name} | ${r.saveMs} | ${r.untilReloadedMs || r.saveMs} | ${r.status} |`));
}

main().catch((err) => { console.error(err); process.exit(1); });
