'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// Configure env BEFORE requiring server.js
process.env.NODE_ENV = 'test';
process.env.APPS_SCRIPT_URL = 'https://script.example.com/exec';
process.env.SHARED_SECRET = 's'.repeat(40);
process.env.MORAN_PIN = '4242';
process.env.SESSION_SECRET = 'x'.repeat(64);

const { app, _loginAttempts } = require('../server');

// ----- fake upstream Apps Script -----
// Simulates the Sheet as in-memory tabs and answers GET/POST.
function makeFakeUpstream() {
  const state = {
    houses: { ramot: [], asher: [], ofroni: [], rehab: [] },
    history: [],
  };

  function handle(method, url, body) {
    const u = new URL(url);
    const secret = u.searchParams.get('secret');
    if (secret !== process.env.SHARED_SECRET) {
      return { status: 200, json: { _status: 401, error: 'unauthorized' } };
    }
    if (method === 'GET') {
      return { status: 200, json: { _status: 200, houses: state.houses, history: state.history } };
    }
    const b = JSON.parse(body);
    switch (b.action) {
      case 'addEmployee': {
        const emp = { id: 'e' + (++idCtr), ...b.employee };
        state.houses[b.house].push(emp);
        return { status: 200, json: { _status: 200, ok: true, employee: emp } };
      }
      case 'updateEmployee': {
        const arr = state.houses[b.house];
        const i = arr.findIndex(e => e.id === b.id);
        if (i < 0) return { status: 200, json: { _status: 404, error: 'not found' } };
        arr[i] = { ...arr[i], ...b.employee };
        return { status: 200, json: { _status: 200, ok: true, employee: arr[i] } };
      }
      case 'deleteEmployee': {
        const arr = state.houses[b.house];
        const i = arr.findIndex(e => e.id === b.id);
        if (i < 0) return { status: 200, json: { _status: 404, error: 'not found' } };
        arr.splice(i, 1);
        return { status: 200, json: { _status: 200, ok: true } };
      }
      case 'moveEmployee': {
        const src = state.houses[b.fromHouse];
        const i = src.findIndex(e => e.id === b.id);
        if (i < 0) return { status: 200, json: { _status: 404, error: 'not in source' } };
        const emp = src[i];
        src.splice(i, 1);
        state.houses[b.toHouse].push(emp);
        const hist = {
          timestamp: new Date().toISOString(),
          name: emp.name,
          from: b.fromHouse,
          to: b.toHouse,
          reasonType: b.reasonType,
          reason: b.reason,
          date: b.date,
        };
        state.history.push(hist);
        return { status: 200, json: { _status: 200, ok: true, moved: emp, history: hist } };
      }
      default:
        return { status: 200, json: { _status: 400, error: 'unknown action' } };
    }
  }
  let idCtr = 0;
  return { state, handle };
}

const originalFetch = global.fetch;
let fakeUpstream;

test.beforeEach(() => {
  _loginAttempts.clear();
  fakeUpstream = makeFakeUpstream();
  global.fetch = async (url, init) => {
    const r = fakeUpstream.handle((init && init.method) || 'GET', url, init && init.body);
    return {
      ok: true,
      status: r.status,
      text: async () => JSON.stringify(r.json),
    };
  };
});

test.afterEach(() => {
  global.fetch = originalFetch;
});

// ----- helpers -----

function listen() {
  return new Promise(resolve => {
    const srv = http.createServer(app).listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      resolve({ srv, base: `http://127.0.0.1:${port}` });
    });
  });
}

async function close(srv) {
  await new Promise(r => srv.close(r));
}

async function req(base, path, opts) {
  const resp = await originalFetch(base + path, opts || {});
  const text = await resp.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  return { status: resp.status, json };
}

async function login(base) {
  const r = await req(base, '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: '4242' }),
  });
  assert.equal(r.status, 200, 'login should succeed');
  return r.json.token;
}

// ----- tests -----

test('health endpoint', async () => {
  const { srv, base } = await listen();
  try {
    const r = await req(base, '/api/health');
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
  } finally { await close(srv); }
});

test('login: wrong pin returns 401', async () => {
  const { srv, base } = await listen();
  try {
    const r = await req(base, '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '0000' }),
    });
    assert.equal(r.status, 401);
    assert.match(r.json.error, /קוד שגוי/);
  } finally { await close(srv); }
});

test('login: correct pin returns token', async () => {
  const { srv, base } = await listen();
  try {
    const token = await login(base);
    assert.ok(token && token.includes('.'));
  } finally { await close(srv); }
});

test('GET /api/data without token → 401', async () => {
  const { srv, base } = await listen();
  try {
    const r = await req(base, '/api/data');
    assert.equal(r.status, 401);
  } finally { await close(srv); }
});

test('GET /api/data with token returns empty data', async () => {
  const { srv, base } = await listen();
  try {
    const token = await login(base);
    const r = await req(base, '/api/data', {
      headers: { 'Authorization': 'Bearer ' + token },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.houses, { ramot: [], asher: [], ofroni: [], rehab: [] });
    assert.deepEqual(r.json.history, []);
  } finally { await close(srv); }
});

test('add → update → delete employee round-trips', async () => {
  const { srv, base } = await listen();
  try {
    const token = await login(base);
    const auth = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };

    // add
    let r = await req(base, '/api/action', {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        action: 'addEmployee', house: 'ramot',
        employee: { name: 'דנה', role: 'אחות', salary: 18000, pct: 100 },
      }),
    });
    assert.equal(r.status, 200);
    const id = r.json.employee.id;
    assert.ok(id);

    // verify in /api/data
    r = await req(base, '/api/data', { headers: auth });
    assert.equal(r.json.houses.ramot.length, 1);
    assert.equal(r.json.houses.ramot[0].name, 'דנה');

    // update
    r = await req(base, '/api/action', {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        action: 'updateEmployee', house: 'ramot', id,
        employee: { name: 'דנה כהן', role: 'אחות', salary: 19000, pct: 90 },
      }),
    });
    assert.equal(r.status, 200);

    r = await req(base, '/api/data', { headers: auth });
    assert.equal(r.json.houses.ramot[0].name, 'דנה כהן');
    assert.equal(r.json.houses.ramot[0].pct, 90);

    // delete
    r = await req(base, '/api/action', {
      method: 'POST', headers: auth,
      body: JSON.stringify({ action: 'deleteEmployee', house: 'ramot', id }),
    });
    assert.equal(r.status, 200);

    r = await req(base, '/api/data', { headers: auth });
    assert.equal(r.json.houses.ramot.length, 0);
  } finally { await close(srv); }
});

test('moveEmployee: moves between houses and appends history', async () => {
  const { srv, base } = await listen();
  try {
    const token = await login(base);
    const auth = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };

    // add an employee to ramot
    let r = await req(base, '/api/action', {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        action: 'addEmployee', house: 'ramot',
        employee: { name: 'יוסי', role: 'מטפל', salary: 12000, pct: 80 },
      }),
    });
    const id = r.json.employee.id;

    // move to asher
    r = await req(base, '/api/action', {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        action: 'moveEmployee',
        fromHouse: 'ramot', toHouse: 'asher', id,
        reasonType: 'כיסוי חוסר', reason: 'מחליף את דנה', date: '2026-05-20',
      }),
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);

    // verify state
    r = await req(base, '/api/data', { headers: auth });
    assert.equal(r.json.houses.ramot.length, 0, 'ramot should be empty');
    assert.equal(r.json.houses.asher.length, 1, 'asher should have the moved emp');
    assert.equal(r.json.houses.asher[0].name, 'יוסי');
    assert.equal(r.json.history.length, 1);
    assert.equal(r.json.history[0].from, 'ramot');
    assert.equal(r.json.history[0].to, 'asher');
    assert.equal(r.json.history[0].reasonType, 'כיסוי חוסר');
    assert.equal(r.json.history[0].date, '2026-05-20');
  } finally { await close(srv); }
});

test('moveEmployee: rejects move to same house', async () => {
  const { srv, base } = await listen();
  try {
    const token = await login(base);
    const auth = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };

    const r = await req(base, '/api/action', {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        action: 'moveEmployee',
        fromHouse: 'ramot', toHouse: 'ramot', id: 'e1',
        reasonType: 'כיסוי חוסר',
      }),
    });
    assert.equal(r.status, 400);
  } finally { await close(srv); }
});

test('addEmployee: rejects empty name (server-side validation)', async () => {
  const { srv, base } = await listen();
  try {
    const token = await login(base);
    const auth = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };

    const r = await req(base, '/api/action', {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        action: 'addEmployee', house: 'ramot',
        employee: { name: '   ', salary: 1000, pct: 100 },
      }),
    });
    assert.equal(r.status, 400);
  } finally { await close(srv); }
});

test('action with unknown house → 400', async () => {
  const { srv, base } = await listen();
  try {
    const token = await login(base);
    const auth = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };

    const r = await req(base, '/api/action', {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        action: 'addEmployee', house: 'nope',
        employee: { name: 'x' },
      }),
    });
    assert.equal(r.status, 400);
  } finally { await close(srv); }
});

test('tampered token is rejected', async () => {
  const { srv, base } = await listen();
  try {
    const token = await login(base);
    const tampered = token.slice(0, -2) + 'aa';
    const r = await req(base, '/api/data', {
      headers: { 'Authorization': 'Bearer ' + tampered },
    });
    assert.equal(r.status, 401);
  } finally { await close(srv); }
});
