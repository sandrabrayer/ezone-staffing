'use strict';

// Perf — the page side of the load (public/index.html).
//
// Pinned here:
//   - the <head> starts /api/data before the libraries and the page body load,
//     only when a session token exists, only to our own /api/data;
//   - loadData() consumes that early request ONCE, and falls back to a normal
//     fetch if it failed at the network level;
//   - the shell (topbar + house tabs) is painted BEFORE the data arrives.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM, VirtualConsole } = require('jsdom');
const { buildInlinedHtml } = require('./inline-page');

const TOKEN_KEY = 'ezone_staff_token_v1';

function payload() {
  return {
    workers: [], assignments: [], absences: [], coverages: [], archiveV3: [],
    monthlyActuals: [], budgets: [], hearings: [], feedLog: [],
    houses: {}, events: [], archive: [],
  };
}
const okResponse = () => ({ ok: true, status: 200, text: async () => JSON.stringify(payload()) });

function loadPage(beforeParse) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => { if (!/^Not implemented:/.test(e.message || '')) errors.push(e.message); });
  const dom = new JSDOM(buildInlinedHtml(), {
    url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse,
  });
  return { dom, errors };
}

test('with a token, /api/data is requested from <head>, before the libraries run', () => {
  const calls = [];
  const { dom, errors } = loadPage((win) => {
    win.localStorage.setItem(TOKEN_KEY, 'tok.en.value');
    win.fetch = (url, init) => {
      // At this moment the libraries have not executed yet.
      calls.push({ url, auth: init.headers.Authorization, calcLoaded: typeof win.EZONE_CALC !== 'undefined' });
      return new Promise(() => {}); // never resolves — only the request matters here
    };
  });
  assert.deepEqual(errors, []);
  assert.equal(calls[0].url, '/api/data');
  assert.equal(calls[0].auth, 'Bearer tok.en.value');
  assert.equal(calls[0].calcLoaded, false, 'the request starts before lib/calc.js executes');
  dom.window.close();
});

test('without a token nothing is requested early', () => {
  let called = 0;
  const { dom } = loadPage((win) => { win.fetch = () => { called++; return new Promise(() => {}); }; });
  assert.equal(called, 0);
  assert.equal(dom.window.__EZ_EARLY_DATA, undefined);
  dom.window.close();
});

test('loadData consumes the early response once, then fetches normally', async () => {
  const { dom } = loadPage();
  const w = dom.window;
  w.localStorage.setItem(TOKEN_KEY, 't');
  let fetches = 0;
  w.fetch = async (url) => { if (url === '/api/data') fetches++; return okResponse(); };
  w.__EZ_EARLY_DATA = Promise.resolve(okResponse());
  await w.boot();
  assert.equal(fetches, 0, 'the early response was used');
  assert.equal(w.__EZ_EARLY_DATA, null);
  await w.reconcile();
  assert.equal(fetches, 1, 'later loads fetch normally');
  w.close();
});

test('a network failure of the early request falls back to a normal fetch', async () => {
  const { dom } = loadPage();
  const w = dom.window;
  w.localStorage.setItem(TOKEN_KEY, 't');
  let fetches = 0;
  w.fetch = async (url) => { if (url === '/api/data') fetches++; return okResponse(); };
  const failed = Promise.reject(new Error('network'));
  failed.catch(() => {});
  w.__EZ_EARLY_DATA = failed;
  await w.boot();
  assert.equal(fetches, 1);
  assert.equal(w.document.getElementById('boot').style.display, 'none');
  w.close();
});

test('the shell (topbar + house tabs) is painted while the data is still loading', async () => {
  const { dom } = loadPage();
  const w = dom.window;
  w.localStorage.setItem(TOKEN_KEY, 't');
  let release;
  w.fetch = () => new Promise((resolve) => { release = () => resolve(okResponse()); });
  const booting = w.boot();
  await new Promise(r => setTimeout(r, 0));
  const doc = w.document;
  assert.notEqual(doc.getElementById('topbar').style.display, 'none', 'topbar visible before data');
  assert.ok(doc.getElementById('houseSwitch').children.length > 0, 'house tabs rendered before data');
  assert.equal(doc.getElementById('boot').style.display, 'flex', 'loading state shown under the shell');
  release();
  await booting;
  assert.equal(doc.getElementById('boot').style.display, 'none');
  w.close();
});
