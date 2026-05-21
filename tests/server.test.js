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
// Simulates the Sheet as in-memory house tabs + events tab.
function makeFakeUpstream() {
  const state = {
    houses: { ramot: [], asher: [], ofroni: [], rehab: [] },
    events: [],
  };
  let idCtr = 0;
  const newId = (p) => p + (++idCtr);
  const today = () => new Date().toISOString().slice(0, 10);

  function handle(method, url, body) {
    const u = new URL(url);
    const secret = u.searchParams.get('secret');
    if (secret !== process.env.SHARED_SECRET) {
      return { status: 200, json: { _status: 401, error: 'unauthorized' } };
    }
    if (method === 'GET') {
      return { status: 200, json: { _status: 200, houses: state.houses, events: state.events } };
    }
    const b = JSON.parse(body);
    switch (b.action) {
      case 'addEmployee': {
        const emp = { id: newId('e'), ...b.employee };
        state.houses[b.house].push(emp);
        return { status: 200, json: { _status: 200, ok: true, employee: emp } };
      }
      case 'updateEmployee': {
        const arr = state.houses[b.house];
        const i = arr.findIndex(e => e.id === b.id);
        if (i < 0) return { status: 200, json: { _status: 404, error: 'not found' } };
        arr[i] = { ...arr[i], ...b.employee, id: arr[i].id };
        return { status: 200, json: { _status: 200, ok: true, employee: arr[i] } };
      }
      case 'deleteEmployee': {
        const arr = state.houses[b.house];
        const i = arr.findIndex(e => e.id === b.id);
        if (i < 0) return { status: 200, json: { _status: 404, error: 'not found' } };
        arr.splice(i, 1);
        return { status: 200, json: { _status: 200, ok: true } };
      }
      case 'startCoverage': {
        const home = state.houses[b.homeHouse];
        const emp = home.find(e => e.id === b.employeeId);
        if (!emp) return { status: 200, json: { _status: 404, error: 'employee not found in homeHouse' } };
        // overlap check
        const conflict = state.events.find(ev =>
          ev.employeeId === b.employeeId &&
          ev.status === 'active' &&
          ev.startDate <= b.endDate && b.startDate <= ev.endDate
        );
        if (conflict) return { status: 200, json: { _status: 409, error: 'overlap' } };
        const t = today();
        const status = b.startDate <= t && t <= b.endDate ? 'active' : 'ended';
        const event = {
          id: newId('ev'),
          employeeId: b.employeeId,
          employeeName: emp.name,
          homeHouse: b.homeHouse,
          hostHouse: b.hostHouse,
          startDate: b.startDate,
          endDate: b.endDate,
          reasonType: b.reasonType,
          reasonDetail: b.reasonDetail || '',
          coversEmployeeId: b.coversEmployeeId || '',
          bonusAmount: Number(b.bonusAmount) || 0,
          status,
          createdAt: new Date().toISOString(),
        };
        state.events.push(event);
        return { status: 200, json: { _status: 200, ok: true, event } };
      }
      case 'endCoverage': {
        const ev = state.events.find(e => e.id === b.eventId);
        if (!ev) return { status: 200, json: { _status: 404, error: 'event not found' } };
        const t = today();
        if (!ev.endDate || ev.endDate > t) ev.endDate = t;
        ev.status = 'ended';
        return { status: 200, json: { _status: 200, ok: true, eventId: ev.id, endDate: ev.endDate, status: 'ended' } };
      }
      default:
        return { status: 200, json: { _status: 400, error: 'unknown action' } };
    }
  }
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

function todayStr() { return new Date().toISOString().slice(0, 10); }
function plusDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
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

test('GET /api/data with token returns empty houses + events', async () => {
  const { srv, base } = await listen();
  try {
    const token = await login(base);
    const r = await req(base, '/api/data', {
      headers: { 'Authorization': 'Bearer ' + token },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.houses, { ramot: [], asher: [], ofroni: [], rehab: [] });
    assert.deepEqual(r.json.events, []);
  } finally { await close(srv); }
});

test('add → update → delete employee round-trips with roleDetail', async () => {
  const { srv, base } = await listen();
  try {
    const token = await login(base);
    const auth = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };

    let r = await req(base, '/api/action', {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        action: 'addEmployee', house: 'ramot',
        employee: { name: 'דנה', role: 'מטפל/ת', roleDetail: 'אמנות', salary: 18000, pct: 100 },
      }),
    });
    assert.equal(r.status, 200);
    const id = r.json.employee.id;
    assert.ok(id);
    assert.equal(r.json.employee.roleDetail, 'אמנות');

    r = await req(base, '/api/data', { headers: auth });
    assert.equal(r.json.houses.ramot.length, 1);
    assert.equal(r.json.houses.ramot[0].roleDetail, 'אמנות');

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
    assert.equal(r.json.houses.ramot[0].role, 'אחות');
    assert.equal(r.json.houses.ramot[0].pct, 90);

    r = await req(base, '/api/action', {
      method: 'POST', headers: auth,
      body: JSON.stringify({ action: 'deleteEmployee', house: 'ramot', id }),
    });
    assert.equal(r.status, 200);

    r = await req(base, '/api/data', { headers: auth });
    assert.equal(r.json.houses.ramot.length, 0);
  } finally { await close(srv); }
});

test('addEmployee: rejects role not in dropdown', async () => {
  const { srv, base } = await listen();
  try {
    const token = await login(base);
    const auth = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
    const r = await req(base, '/api/action', {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        action: 'addEmployee', house: 'ramot',
        employee: { name: 'X', role: 'מנהל בית', salary: 10000, pct: 100 },
      }),
    });
    assert.equal(r.status, 400);
  } finally { await close(srv); }
});

test('addEmployee: role=אחר requires roleDetail', async () => {
  const { srv, base } = await listen();
  try {
    const token = await login(base);
    const auth = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
    const r = await req(base, '/api/action', {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        action: 'addEmployee', house: 'ramot',
        employee: { name: 'X', role: 'אחר', salary: 10000, pct: 100 },
      }),
    });
    assert.equal(r.status, 400);
  } finally { await close(srv); }
});

test('startCoverage → endCoverage round-trip; base salary stays in home', async () => {
  const { srv, base } = await listen();
  try {
    const token = await login(base);
    const auth = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };

    let r = await req(base, '/api/action', {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        action: 'addEmployee', house: 'ramot',
        employee: { name: 'יוסי', role: 'מטפל/ת', roleDetail: 'אמנות', salary: 12000, pct: 80 },
      }),
    });
    const id = r.json.employee.id;

    r = await req(base, '/api/action', {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        action: 'startCoverage',
        employeeId: id,
        homeHouse: 'ramot',
        hostHouse: 'asher',
        startDate: todayStr(),
        endDate: plusDays(7),
        reasonType: 'חופשה',
        reasonDetail: 'מחליף את דנה',
        bonusAmount: 2000,
      }),
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    const eventId = r.json.event.id;

    // Verify: employee still in ramot, event is active
    r = await req(base, '/api/data', { headers: auth });
    assert.equal(r.json.houses.ramot.length, 1, 'employee stays in home house');
    assert.equal(r.json.houses.asher.length, 0, 'employee NOT moved to host');
    assert.equal(r.json.events.length, 1);
    assert.equal(r.json.events[0].status, 'active');
    assert.equal(r.json.events[0].hostHouse, 'asher');
    assert.equal(r.json.events[0].bonusAmount, 2000);

    // End the coverage
    r = await req(base, '/api/action', {
      method: 'POST', headers: auth,
      body: JSON.stringify({ action: 'endCoverage', eventId }),
    });
    assert.equal(r.status, 200);

    r = await req(base, '/api/data', { headers: auth });
    assert.equal(r.json.events[0].status, 'ended');
    assert.equal(r.json.houses.ramot.length, 1, 'employee still in home');
  } finally { await close(srv); }
});

test('startCoverage: blocks overlapping active events for same employee', async () => {
  const { srv, base } = await listen();
  try {
    const token = await login(base);
    const auth = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };

    let r = await req(base, '/api/action', {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        action: 'addEmployee', house: 'ramot',
        employee: { name: 'יוסי', role: 'אחות', salary: 12000, pct: 100 },
      }),
    });
    const id = r.json.employee.id;

    r = await req(base, '/api/action', {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        action: 'startCoverage',
        employeeId: id, homeHouse: 'ramot', hostHouse: 'asher',
        startDate: todayStr(), endDate: plusDays(10),
        reasonType: 'חופשה',
      }),
    });
    assert.equal(r.status, 200);

    // overlapping range → should fail
    r = await req(base, '/api/action', {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        action: 'startCoverage',
        employeeId: id, homeHouse: 'ramot', hostHouse: 'ofroni',
        startDate: plusDays(5), endDate: plusDays(15),
        reasonType: 'חופשה',
      }),
    });
    assert.equal(r.status, 409);
  } finally { await close(srv); }
});

test('startCoverage: rejects same homeHouse and hostHouse', async () => {
  const { srv, base } = await listen();
  try {
    const token = await login(base);
    const auth = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };

    const r = await req(base, '/api/action', {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        action: 'startCoverage',
        employeeId: 'e1', homeHouse: 'ramot', hostHouse: 'ramot',
        startDate: '2026-05-20', endDate: '2026-06-01',
        reasonType: 'חופשה',
      }),
    });
    assert.equal(r.status, 400);
  } finally { await close(srv); }
});

test('moveEmployee action is gone (returns 400)', async () => {
  const { srv, base } = await listen();
  try {
    const token = await login(base);
    const auth = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
    const r = await req(base, '/api/action', {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        action: 'moveEmployee',
        fromHouse: 'ramot', toHouse: 'asher', id: 'e1',
        reasonType: 'חופשה',
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
        employee: { name: '   ', role: 'אחות', salary: 1000, pct: 100 },
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
        employee: { name: 'x', role: 'אחות' },
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
