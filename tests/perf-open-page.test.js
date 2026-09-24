'use strict';

// Slow app OPEN — the page side (docs/perf-open.md).
//
// Pinned here, in jsdom with a controlled fetch:
//   - With a session token AND a local copy, the page paints from the copy
//     BEFORE /api/data answers, with «מתעדכן…» in the topbar; the fresh
//     answer hides it.
//   - A STALE answer keeps «מתעדכן…» and schedules another request.
//   - A failing /api/data with a copy on screen never swaps it for the error
//     page.
//   - Without a token the copy is never read; logout and a 401 delete it;
//     an old copy is ignored; blocked storage just means no instant paint.
//   - A background refresh never re-renders under an open form.

const { test } = require('node:test');
const assert = require('node:assert');
const { JSDOM, VirtualConsole } = require('jsdom');
const { buildInlinedHtml } = require('./inline-page');

const HTML = buildInlinedHtml();
const TOKEN_KEY = 'ezone_staff_token_v1';
const DATA_KEY = 'ezone_staff_data_v1';

function payload(name) {
  return {
    workers: [{ id: 'w1', name, notes: '', startDate: '2024-01-01', gmachMonth: '', shift_commitment: '' }],
    assignments: [{ id: 'a1', workerId: 'w1', house: 'ramot', role: 'מדריך/ה', employmentType: 'full_time', salary: 9000, status: 'active' }],
    absences: [], coverages: [], archiveV3: [], monthlyActuals: [], budgets: [], feedLog: [],
  };
}

function response(body, opts) {
  const o = opts || {};
  const headers = { 'x-cache': o.xcache || 'HIT' };
  return {
    ok: (o.status || 200) < 400, status: o.status || 200,
    headers: { get: (k) => headers[String(k).toLowerCase()] || null },
    text: async () => JSON.stringify(body),
  };
}

// Load the page with storage and fetch in place BEFORE its scripts run.
// fetchImpl(url, init) → a response(); `calls` records every URL.
function loadPage({ token, local, fetchImpl, storageThrows }) {
  const calls = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { if (!/^Not implemented:/.test(e.message || '')) throw e; });
  const dom = new JSDOM(HTML, {
    url: 'http://localhost/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      if (token) window.localStorage.setItem(TOKEN_KEY, token);
      if (local) window.localStorage.setItem(DATA_KEY, JSON.stringify(local));
      if (storageThrows) {
        const real = window.localStorage;
        Object.defineProperty(window, 'localStorage', {
          configurable: true,
          get() {
            return {
              getItem: (k) => (k === TOKEN_KEY ? real.getItem(k) : (() => { throw new Error('blocked'); })()),
              setItem: (k, v) => { if (k === TOKEN_KEY) return real.setItem(k, v); throw new Error('blocked'); },
              removeItem: (k) => { if (k === TOKEN_KEY) return real.removeItem(k); throw new Error('blocked'); },
            };
          },
        });
      }
      window.fetch = (url, init) => { calls.push(String(url)); return fetchImpl(String(url), init); };
    },
  });
  return { dom, calls, w: dom.window, doc: dom.window.document };
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
const pill = (doc) => doc.getElementById('syncPill');

test('paints from the local copy BEFORE /api/data answers, with «מתעדכן…»; the answer hides it', async () => {
  const gate = deferred();
  const { dom, doc, w } = loadPage({
    token: 't.k', local: { savedAt: Date.now() - 60e3, data: payload('ישן') },
    fetchImpl: async (url) => {
      if (url === '/api/data') { await gate.promise; return response(payload('חדש')); }
      return response({ configured: false });
    },
  });
  await tick(10);
  const app = doc.getElementById('app');
  assert.ok(app.innerHTML.length > 300, 'painted without waiting');
  assert.equal(doc.getElementById('boot').style.display, 'none', 'no spinner over the copy');
  assert.ok(pill(doc).classList.contains('updating'));
  assert.equal(pill(doc).textContent, 'מתעדכן…');
  gate.resolve();
  await tick(20);
  assert.ok(pill(doc).classList.contains('hidden'), 'fresh data → pill hidden');
  assert.equal(w.eval('WORKERS[0].name'), 'חדש');
  const saved = JSON.parse(w.localStorage.getItem(DATA_KEY));
  assert.equal(saved.data.workers[0].name, 'חדש', 'the fresh copy replaced the local one');
  dom.window.close();
});

test('a STALE answer keeps «מתעדכן…» and schedules another request', async () => {
  const { dom, doc, w } = loadPage({
    token: 't.k', local: null,
    fetchImpl: async (url) => (url === '/api/data' ? response(payload('א'), { xcache: 'STALE' }) : response({ configured: false })),
  });
  await tick(20);
  assert.ok(doc.getElementById('app').innerHTML.length > 300);
  assert.ok(pill(doc).classList.contains('updating'));
  assert.equal(w.eval('refreshAttempt'), 1, 'one follow-up request is scheduled');
  w.eval('clearTimeout(refreshTimer)');
  dom.window.close();
});

test('a failing /api/data with a copy on screen keeps the copy — never the error page', async () => {
  const { dom, doc, w } = loadPage({
    token: 't.k', local: { savedAt: Date.now() - 3600e3, data: payload('עותק') },
    fetchImpl: async (url) => (url === '/api/data' ? response({ error: 'x' }, { status: 502 }) : response({ configured: false })),
  });
  await tick(20);
  assert.equal(doc.querySelector('.load-error'), null, 'no error page');
  assert.equal(w.eval('WORKERS[0].name'), 'עותק');
  // After the retries run out the pill says so and offers a retry.
  w.eval('clearTimeout(refreshTimer); refreshAttempt = REFRESH_DELAYS_MS.length; scheduleRefresh()');
  assert.ok(pill(doc).classList.contains('failed'));
  assert.match(pill(doc).textContent, /^לא עודכן · נתונים מ-\d\d:\d\d · נסי שוב$/);
  assert.equal(pill(doc).disabled, false, 'clickable → refreshData(true)');
  dom.window.close();
});

test('no token → the local copy is never read or shown', async () => {
  const { dom, doc, w } = loadPage({
    token: null, local: { savedAt: Date.now(), data: payload('סודי') },
    fetchImpl: async () => response({}),
  });
  await tick(10);
  assert.equal(doc.getElementById('pinOverlay').style.display, 'flex');
  assert.equal(w.eval('WORKERS.length'), 0);
  assert.ok(!doc.getElementById('app').innerHTML.includes('סודי'));
  dom.window.close();
});

test('logout and a 401 both delete the local copy', async () => {
  let r = loadPage({
    token: 't.k', local: { savedAt: Date.now(), data: payload('א') },
    fetchImpl: async (url) => (url === '/api/data' ? response(payload('א')) : response({ ok: true })),
  });
  await tick(20);
  assert.ok(r.w.localStorage.getItem(DATA_KEY));
  await r.w.logout();
  assert.equal(r.w.localStorage.getItem(DATA_KEY), null, 'logout');
  r.dom.window.close();

  r = loadPage({
    token: 't.k', local: { savedAt: Date.now(), data: payload('א') },
    fetchImpl: async () => response({ error: 'unauthorized' }, { status: 401 }),
  });
  await tick(20);
  assert.equal(r.w.localStorage.getItem(DATA_KEY), null, '401');
  assert.equal(r.doc.getElementById('pinOverlay').style.display, 'flex');
  r.dom.window.close();
});

test('a copy older than 72 h, or from the future, is ignored and deleted', async () => {
  for (const savedAt of [Date.now() - 73 * 3600e3, Date.now() + 3600e3]) {
    const gate = deferred();
    const { dom, doc, w } = loadPage({
      token: 't.k', local: { savedAt, data: payload('ישן מדי') },
      fetchImpl: async (url) => { if (url === '/api/data') await gate.promise; return response(payload('x')); },
    });
    await tick(10);
    assert.notEqual(doc.getElementById('boot').style.display, 'none', 'waits for the server instead');
    assert.equal(w.localStorage.getItem(DATA_KEY), null);
    gate.resolve();
    await tick(10);
    dom.window.close();
  }
});

test('blocked storage: no instant paint, but the app still loads', async () => {
  const { dom, doc } = loadPage({
    token: 't.k', storageThrows: true,
    fetchImpl: async (url) => (url === '/api/data' ? response(payload('ב')) : response({ configured: false })),
  });
  await tick(20);
  assert.ok(doc.getElementById('app').innerHTML.length > 300);
  assert.equal(doc.querySelector('.load-error'), null);
  dom.window.close();
});

test('a background refresh never re-renders under an open form; it renders when the form closes', async () => {
  const { dom, doc, w } = loadPage({
    token: 't.k', local: null,
    fetchImpl: async (url) => (url === '/api/data' ? response(payload('א')) : response({ configured: false })),
  });
  await tick(20);
  let renders = 0;
  w.eval('const __r = render; render = function(){ window.__renders = (window.__renders||0) + 1; return __r(); }');
  doc.getElementById('hearingOverlay').classList.add('show');
  w.renderWhenIdle();
  assert.equal(w.__renders || 0, renders, 'no render while a form is open');
  doc.getElementById('hearingOverlay').classList.remove('show');
  w.clearFormDirty();
  await tick(5);
  renders = w.__renders || 0;
  assert.equal(renders, 1, 'rendered once the form closed');
  dom.window.close();
});

test('/api/data is the only request the first paint depends on; hearings are not fetched until opened', async () => {
  const { dom, calls, w } = loadPage({
    token: 't.k', local: null,
    fetchImpl: async (url) => (url === '/api/data/hearings' ? response({ hearings: [] }) : url === '/api/data' ? response(payload('א')) : response({ configured: false })),
  });
  await tick(20);
  assert.deepEqual(calls.filter((u) => u.startsWith('/api/')).sort(), ['/api/data', '/api/hadrachot-status']);
  w.go('hearings');
  await tick(10);
  assert.ok(calls.includes('/api/data/hearings'), 'fetched when the screen opened');
  dom.window.close();
});
