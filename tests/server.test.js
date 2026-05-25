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

// ----- fake upstream Apps Script (v3) -----
// Models the v3 Sheet shape: workers, assignments, absences, coverages,
// archive_v3. Mirrors the action semantics from apps-script/Code.gs (FK
// guards, dup-detection, overlap rejection, auto-truncation on terminate).
// Legacy keys (houses/events/archive) are returned empty — the server
// still passes them through to the client during the transition window.
function makeFakeUpstream() {
  const state = {
    workers: [],
    assignments: [],
    absences: [],
    coverages: [],
    archiveV3: [],
  };
  let idCtr = 0;
  const newId = (p) => p + (++idCtr);
  const today = () => new Date().toISOString().slice(0, 10);
  const nowIso = () => new Date().toISOString();
  const isActive = (start, end, t) => start && end && start <= t && t <= end;
  const overlap = (aS, aE, bS, bE) => aS <= bE && bS <= aE;

  function handle(method, url, body) {
    const u = new URL(url);
    const secret = u.searchParams.get('secret');
    if (secret !== process.env.SHARED_SECRET) {
      return { status: 200, json: { _status: 401, error: 'unauthorized' } };
    }

    if (method === 'GET') {
      return { status: 200, json: {
        _status: 200,
        workers: state.workers,
        assignments: state.assignments,
        absences: state.absences,
        coverages: state.coverages,
        archiveV3: state.archiveV3,
        // legacy passthrough — empty in a v3-only world
        houses: { ramot: [], asher: [], ofroni: [], rehab: [] },
        events: [],
        archive: [],
        _compat: true,
      } };
    }

    const b = JSON.parse(body);
    switch (b.action) {

      // ---------- workers ----------
      case 'createWorker': {
        const w = {
          id: newId('w'),
          name: b.worker.name,
          notes: b.worker.notes || '',
          createdAt: nowIso(),
        };
        state.workers.push(w);
        return { status: 200, json: { _status: 200, ok: true, worker: w } };
      }
      case 'updateWorker': {
        const w = state.workers.find(x => x.id === b.id);
        if (!w) return { status: 200, json: { _status: 404, error: 'worker not found' } };
        w.name = b.worker.name;
        w.notes = b.worker.notes || '';
        return { status: 200, json: { _status: 200, ok: true, worker: { id: w.id, name: w.name, notes: w.notes } } };
      }
      case 'deleteWorker': {
        if (state.assignments.some(a => a.workerId === b.id)) {
          return { status: 200, json: { _status: 409, error: 'worker has active assignments' } };
        }
        if (state.absences.some(a => a.workerId === b.id)) {
          return { status: 200, json: { _status: 409, error: 'worker has absence records' } };
        }
        if (state.coverages.some(c => c.coveringWorkerId === b.id)) {
          return { status: 200, json: { _status: 409, error: 'worker has coverage records' } };
        }
        if (state.archiveV3.some(a => a.workerId === b.id)) {
          return { status: 200, json: { _status: 409, error: 'worker has archive records' } };
        }
        const i = state.workers.findIndex(w => w.id === b.id);
        if (i < 0) return { status: 200, json: { _status: 404, error: 'worker not found' } };
        state.workers.splice(i, 1);
        return { status: 200, json: { _status: 200, ok: true } };
      }

      // ---------- assignments ----------
      case 'addAssignment': {
        const a = b.assignment;
        if (!state.workers.some(w => w.id === a.workerId)) {
          return { status: 200, json: { _status: 404, error: 'worker not found' } };
        }
        if (state.assignments.some(x => x.workerId === a.workerId && x.house === a.house)) {
          return { status: 200, json: { _status: 409, error: 'worker already has an assignment at this house' } };
        }
        const row = Object.assign({ id: newId('a'), createdAt: nowIso() }, a);
        state.assignments.push(row);
        return { status: 200, json: { _status: 200, ok: true, assignment: row } };
      }
      case 'updateAssignment': {
        const row = state.assignments.find(x => x.id === b.id);
        if (!row) return { status: 200, json: { _status: 404, error: 'assignment not found' } };
        if (row.workerId !== b.assignment.workerId) {
          return { status: 200, json: { _status: 409, error: 'workerId mismatch' } };
        }
        if (row.house !== b.assignment.house) {
          return { status: 200, json: { _status: 409, error: 'house mismatch' } };
        }
        Object.assign(row, b.assignment);
        return { status: 200, json: { _status: 200, ok: true, assignment: row } };
      }
      case 'deleteAssignment': {
        const i = state.assignments.findIndex(x => x.id === b.id);
        if (i < 0) return { status: 200, json: { _status: 404, error: 'assignment not found' } };
        state.assignments.splice(i, 1);
        return { status: 200, json: { _status: 200, ok: true } };
      }
      case 'terminateAssignment': {
        const i = state.assignments.findIndex(x => x.id === b.id);
        if (i < 0) return { status: 200, json: { _status: 404, error: 'assignment not found' } };
        const a = state.assignments[i];
        const worker = state.workers.find(w => w.id === a.workerId);
        const t = today();
        let autoEnded = 0;
        for (const ab of state.absences) {
          if (ab.workerId !== a.workerId) continue;
          if (ab.house !== a.house) continue;
          if (ab.status !== 'active') continue;
          if (!(ab.endDate > b.terminationDate)) continue;
          ab.endDate = b.terminationDate;
          ab.status = b.terminationDate > t ? 'active' : 'ended';
          autoEnded++;
        }
        const archRow = {
          id: newId('arc'),
          assignmentId: a.id,
          workerId: a.workerId,
          name: worker ? worker.name : '',
          house: a.house,
          role: a.role,
          roleDetail: a.roleDetail,
          employmentType: a.employmentType,
          salary: a.salary,
          pct: a.pct,
          hourlyRate: a.hourlyRate,
          estHours: a.estHours,
          sessionRate: a.sessionRate,
          estSessions: a.estSessions,
          retainerAmount: a.retainerAmount,
          notes: a.notes,
          terminationDate: b.terminationDate,
          reasonType: b.reasonType || '',
          reasonDetail: b.reasonDetail || '',
          archivedAt: nowIso(),
        };
        state.archiveV3.push(archRow);
        state.assignments.splice(i, 1);
        return { status: 200, json: { _status: 200, ok: true, archive: archRow, autoEndedAbsences: autoEnded } };
      }

      // ---------- absences ----------
      case 'logAbsence': {
        const a = b.absence;
        if (!state.workers.some(w => w.id === a.workerId)) {
          return { status: 200, json: { _status: 404, error: 'worker not found' } };
        }
        const conflict = state.absences.find(x =>
          x.workerId === a.workerId &&
          x.house === a.house &&
          x.status === 'active' &&
          overlap(x.startDate, x.endDate, a.startDate, a.endDate)
        );
        if (conflict) return { status: 200, json: { _status: 409, error: 'worker already has an absence in this range' } };
        const t = today();
        const status = isActive(a.startDate, a.endDate, t) ? 'active' : 'ended';
        const row = Object.assign({ id: newId('ab'), status, createdAt: nowIso() }, a);
        state.absences.push(row);
        return { status: 200, json: { _status: 200, ok: true, absence: row } };
      }
      case 'endAbsence': {
        const ab = state.absences.find(x => x.id === b.id);
        if (!ab) return { status: 200, json: { _status: 404, error: 'absence not found' } };
        const t = today();
        const newEnd = ab.endDate && ab.endDate < t ? ab.endDate : t;
        ab.endDate = newEnd;
        ab.status = 'ended';
        return { status: 200, json: { _status: 200, ok: true, id: ab.id, endDate: newEnd, status: 'ended' } };
      }
      case 'deleteAbsence': {
        if (state.coverages.some(c => c.absenceId === b.id)) {
          return { status: 200, json: { _status: 409, error: 'absence has coverage records' } };
        }
        const i = state.absences.findIndex(x => x.id === b.id);
        if (i < 0) return { status: 200, json: { _status: 404, error: 'absence not found' } };
        state.absences.splice(i, 1);
        return { status: 200, json: { _status: 200, ok: true } };
      }

      // ---------- coverages ----------
      case 'addCoverage': {
        const c = b.coverage;
        if (!state.absences.some(a => a.id === c.absenceId)) {
          return { status: 200, json: { _status: 404, error: 'absence not found' } };
        }
        if (!state.workers.some(w => w.id === c.coveringWorkerId)) {
          return { status: 200, json: { _status: 404, error: 'covering worker not found' } };
        }
        const row = Object.assign({ id: newId('c'), createdAt: nowIso() }, c);
        state.coverages.push(row);
        return { status: 200, json: { _status: 200, ok: true, coverage: row } };
      }
      case 'deleteCoverage': {
        const i = state.coverages.findIndex(x => x.id === b.id);
        if (i < 0) return { status: 200, json: { _status: 404, error: 'coverage not found' } };
        state.coverages.splice(i, 1);
        return { status: 200, json: { _status: 200, ok: true } };
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

function authHeaders(token) {
  return { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
}

async function post(base, token, body) {
  return req(base, '/api/action', {
    method: 'POST', headers: authHeaders(token),
    body: JSON.stringify(body),
  });
}

async function get(base, token) {
  return req(base, '/api/data', { headers: authHeaders(token) });
}

function todayStr() { return new Date().toISOString().slice(0, 10); }
function plusDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

// Tiny helpers so individual tests stay readable.
async function createWorker(base, token, name, notes) {
  const r = await post(base, token, { action: 'createWorker', worker: { name, notes: notes || '' } });
  assert.equal(r.status, 200, 'createWorker should succeed');
  return r.json.worker.id;
}

async function addAssignment(base, token, overrides) {
  // Defaults are full_time-shaped. If the caller switches employmentType
  // we drop the `salary` default — otherwise the strict validator would
  // (correctly) reject `{employmentType: 'hourly', salary: 18000, ...}`
  // as having a cost field foreign to the chosen type.
  const defaults = {
    workerId: '', house: 'ramot', role: 'אחות', roleDetail: '',
    employmentType: 'full_time', salary: 18000,
  };
  if (overrides && overrides.employmentType && overrides.employmentType !== 'full_time') {
    delete defaults.salary;
  }
  const r = await post(base, token, {
    action: 'addAssignment',
    assignment: Object.assign(defaults, overrides),
  });
  return r;
}

// ----- health / login / auth -----

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

test('tampered token is rejected', async () => {
  const { srv, base } = await listen();
  try {
    const token = await login(base);
    // Deterministically mutate the last char to a guaranteed-different
    // value. The previous "+ 'aa'" trick was a no-op when the token's
    // real last two chars were already 'aa' (~1/65536 of the time),
    // flaking the test. Picking 'a' or 'b' based on the existing char
    // can never produce the original.
    const last = token.slice(-1);
    const tampered = token.slice(0, -1) + (last === 'a' ? 'b' : 'a');
    assert.notEqual(tampered, token, 'tamper must actually change the token');
    const r = await req(base, '/api/data', {
      headers: { 'Authorization': 'Bearer ' + tampered },
    });
    assert.equal(r.status, 401);
  } finally { await close(srv); }
});

// ----- GET /api/data shape -----

test('GET /api/data returns v3 shape with legacy passthrough keys', async () => {
  const { srv, base } = await listen();
  try {
    const token = await login(base);
    const r = await get(base, token);
    assert.equal(r.status, 200);
    // v3 keys
    assert.deepEqual(r.json.workers, []);
    assert.deepEqual(r.json.assignments, []);
    assert.deepEqual(r.json.absences, []);
    assert.deepEqual(r.json.coverages, []);
    assert.deepEqual(r.json.archiveV3, []);
    // legacy passthrough (still in the response during the transition)
    assert.deepEqual(r.json.houses, { ramot: [], asher: [], ofroni: [], rehab: [] });
    assert.deepEqual(r.json.events, []);
    assert.deepEqual(r.json.archive, []);
  } finally { await close(srv); }
});

// ----- workers CRUD -----

test('createWorker → updateWorker → deleteWorker round-trip', async () => {
  const { srv, base } = await listen();
  try {
    const token = await login(base);

    let r = await post(base, token, {
      action: 'createWorker',
      worker: { name: 'דנה', notes: 'אחות ראשית' },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    const id = r.json.worker.id;
    assert.ok(id);
    assert.equal(r.json.worker.name, 'דנה');

    r = await get(base, token);
    assert.equal(r.json.workers.length, 1);
    assert.equal(r.json.workers[0].name, 'דנה');

    r = await post(base, token, {
      action: 'updateWorker', id,
      worker: { name: 'דנה כהן', notes: '' },
    });
    assert.equal(r.status, 200);
    r = await get(base, token);
    assert.equal(r.json.workers[0].name, 'דנה כהן');

    r = await post(base, token, { action: 'deleteWorker', id });
    assert.equal(r.status, 200);
    r = await get(base, token);
    assert.equal(r.json.workers.length, 0);
  } finally { await close(srv); }
});

test('createWorker: rejects empty name (validator)', async () => {
  const { srv, base } = await listen();
  try {
    const token = await login(base);
    const r = await post(base, token, {
      action: 'createWorker', worker: { name: '   ' },
    });
    assert.equal(r.status, 400);
  } finally { await close(srv); }
});

test('deleteWorker: refuses while worker still has an assignment', async () => {
  const { srv, base } = await listen();
  try {
    const token = await login(base);
    const workerId = await createWorker(base, token, 'יוסי');
    await addAssignment(base, token, { workerId });
    const r = await post(base, token, { action: 'deleteWorker', id: workerId });
    assert.equal(r.status, 409);
  } finally { await close(srv); }
});

// ----- assignments lifecycle -----

test('addAssignment: full_time happy path; rejects duplicate (worker, house)', async () => {
  const { srv, base } = await listen();
  try {
    const token = await login(base);
    const workerId = await createWorker(base, token, 'דנה');

    let r = await addAssignment(base, token, {
      workerId, house: 'ramot', role: 'אחות',
      employmentType: 'full_time', salary: 18000,
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.assignment.employmentType, 'full_time');
    assert.equal(r.json.assignment.salary, 18000);
    assert.equal(r.json.assignment.pct, 0, 'full_time stores pct=0');

    // Same worker, same house → duplicate.
    r = await addAssignment(base, token, {
      workerId, house: 'ramot', role: 'אחות',
      employmentType: 'full_time', salary: 18000,
    });
    assert.equal(r.status, 409);

    // Same worker, different house → allowed.
    r = await addAssignment(base, token, {
      workerId, house: 'asher', role: 'אחות',
      employmentType: 'full_time', salary: 5000,
    });
    assert.equal(r.status, 200);
  } finally { await close(srv); }
});

test('addAssignment: per_session validates sessionRate + estSessions', async () => {
  const { srv, base } = await listen();
  try {
    const token = await login(base);
    const workerId = await createWorker(base, token, 'איציק');

    // Missing sessionRate → rejected.
    let r = await addAssignment(base, token, {
      workerId, house: 'ramot', role: 'מטפל/ת', roleDetail: 'אמנות',
      employmentType: 'per_session', estSessions: 10,
    });
    assert.equal(r.status, 400);

    // Missing estSessions → rejected.
    r = await addAssignment(base, token, {
      workerId, house: 'ramot', role: 'מטפל/ת', roleDetail: 'אמנות',
      employmentType: 'per_session', sessionRate: 300,
    });
    assert.equal(r.status, 400);

    // Both present → ok.
    r = await addAssignment(base, token, {
      workerId, house: 'ramot', role: 'מטפל/ת', roleDetail: 'אמנות',
      employmentType: 'per_session', sessionRate: 300, estSessions: 10,
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.assignment.sessionRate, 300);
    assert.equal(r.json.assignment.estSessions, 10);
    assert.equal(r.json.assignment.salary, 0, 'per_session zeros salary');
  } finally { await close(srv); }
});

test('addAssignment: hourly validates hourlyRate + estHours', async () => {
  const { srv, base } = await listen();
  try {
    const token = await login(base);
    const workerId = await createWorker(base, token, 'X');
    const r = await addAssignment(base, token, {
      workerId, house: 'ramot', role: 'אחות',
      employmentType: 'hourly', hourlyRate: 80, estHours: 120,
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.assignment.hourlyRate, 80);
    assert.equal(r.json.assignment.estHours, 120);
  } finally { await close(srv); }
});

test('addAssignment: fixed_retainer requires retainerAmount', async () => {
  const { srv, base } = await listen();
  try {
    const token = await login(base);
    const workerId = await createWorker(base, token, 'X');

    let r = await addAssignment(base, token, {
      workerId, house: 'ramot', role: 'פסיכיאטר/ית',
      employmentType: 'fixed_retainer',
    });
    assert.equal(r.status, 400);

    r = await addAssignment(base, token, {
      workerId, house: 'ramot', role: 'פסיכיאטר/ית',
      employmentType: 'fixed_retainer', retainerAmount: 4000,
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.assignment.retainerAmount, 4000);
  } finally { await close(srv); }
});

test('addAssignment: rejects role not in dropdown', async () => {
  const { srv, base } = await listen();
  try {
    const token = await login(base);
    const workerId = await createWorker(base, token, 'X');
    const r = await addAssignment(base, token, {
      workerId, house: 'ramot', role: 'מנהל בית',
      employmentType: 'full_time', salary: 10000,
    });
    assert.equal(r.status, 400);
  } finally { await close(srv); }
});

test('addAssignment: role=אחר requires roleDetail', async () => {
  const { srv, base } = await listen();
  try {
    const token = await login(base);
    const workerId = await createWorker(base, token, 'X');
    const r = await addAssignment(base, token, {
      workerId, house: 'ramot', role: 'אחר',
      employmentType: 'full_time', salary: 10000,
    });
    assert.equal(r.status, 400);
  } finally { await close(srv); }
});

test('addAssignment: rejects positive cost field incompatible with employment type (strict)', async () => {
  // Defense in depth: the validator's per-type strict guard should
  // surface as a 400 over HTTP without ever hitting the fake upstream.
  // (Hostile / buggy clients can't smuggle e.g. hourlyRate into a
  // full_time row.)
  const { srv, base } = await listen();
  try {
    const token = await login(base);
    const workerId = await createWorker(base, token, 'X');
    const r = await addAssignment(base, token, {
      workerId, house: 'ramot', role: 'אחות',
      employmentType: 'full_time', salary: 18000,
      hourlyRate: 80,  // foreign to full_time → reject
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /hourlyRate not allowed/);
  } finally { await close(srv); }
});

test('addAssignment: unknown house → 400', async () => {
  const { srv, base } = await listen();
  try {
    const token = await login(base);
    const workerId = await createWorker(base, token, 'X');
    const r = await addAssignment(base, token, {
      workerId, house: 'nope', role: 'אחות',
      employmentType: 'full_time', salary: 10000,
    });
    assert.equal(r.status, 400);
  } finally { await close(srv); }
});

test('updateAssignment: changes terms but workerId/house must match', async () => {
  const { srv, base } = await listen();
  try {
    const token = await login(base);
    const workerId = await createWorker(base, token, 'X');
    const r1 = await addAssignment(base, token, {
      workerId, house: 'ramot', role: 'אחות',
      employmentType: 'part_time', salary: 12000, pct: 80,
    });
    const aid = r1.json.assignment.id;

    // Legitimate update (change pct).
    let r = await post(base, token, {
      action: 'updateAssignment', id: aid,
      assignment: { workerId, house: 'ramot', role: 'אחות',
        employmentType: 'part_time', salary: 12000, pct: 90 },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.assignment.pct, 90);

    // Mismatched house → 409.
    r = await post(base, token, {
      action: 'updateAssignment', id: aid,
      assignment: { workerId, house: 'asher', role: 'אחות',
        employmentType: 'part_time', salary: 12000, pct: 80 },
    });
    assert.equal(r.status, 409);
  } finally { await close(srv); }
});

test('terminateAssignment: snapshots to archive, removes assignment, auto-truncates active absence', async () => {
  const { srv, base } = await listen();
  try {
    const token = await login(base);
    const workerId = await createWorker(base, token, 'יוסי');
    const r1 = await addAssignment(base, token, {
      workerId, house: 'ramot', role: 'מטפל/ת', roleDetail: 'אמנות',
      employmentType: 'part_time', salary: 12000, pct: 80,
    });
    const aid = r1.json.assignment.id;

    // Open an active absence that extends well past termination day.
    const ab = await post(base, token, {
      action: 'logAbsence',
      absence: {
        workerId, house: 'ramot',
        startDate: todayStr(), endDate: plusDays(30),
        reasonType: 'חופשה', reasonDetail: '',
      },
    });
    assert.equal(ab.status, 200);

    // Terminate effective today.
    const r = await post(base, token, {
      action: 'terminateAssignment', id: aid,
      terminationDate: todayStr(),
      reasonType: 'התפטרות', reasonDetail: 'smoke',
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.archive.assignmentId, aid);
    assert.equal(r.json.archive.workerId, workerId);
    assert.equal(r.json.archive.terminationDate, todayStr());
    assert.equal(r.json.autoEndedAbsences, 1);

    const data = await get(base, token);
    assert.equal(data.json.assignments.find(a => a.id === aid), undefined,
      'assignment is gone from active set');
    assert.ok(data.json.archiveV3.find(a => a.assignmentId === aid),
      'archive_v3 contains the snapshot');
    const truncated = data.json.absences.find(x => x.workerId === workerId);
    assert.equal(truncated.endDate, todayStr(), 'absence end pulled to termination date');
    assert.equal(truncated.status, 'ended');
  } finally { await close(srv); }
});

test('terminateAssignment: future date — absence end_date updated but stays active until then', async () => {
  const { srv, base } = await listen();
  try {
    const token = await login(base);
    const workerId = await createWorker(base, token, 'דנה');
    const r1 = await addAssignment(base, token, {
      workerId, house: 'ramot', role: 'אחות',
      employmentType: 'full_time', salary: 18000,
    });
    const aid = r1.json.assignment.id;

    await post(base, token, {
      action: 'logAbsence',
      absence: { workerId, house: 'ramot',
        startDate: todayStr(), endDate: plusDays(60),
        reasonType: 'חופשה' },
    });

    const future = plusDays(15);
    const r = await post(base, token, {
      action: 'terminateAssignment', id: aid, terminationDate: future,
    });
    assert.equal(r.status, 200);

    const data = await get(base, token);
    const ab = data.json.absences.find(x => x.workerId === workerId);
    assert.equal(ab.endDate, future);
    assert.equal(ab.status, 'active', 'still active because new end is in the future');
  } finally { await close(srv); }
});

test('terminateAssignment: missing terminationDate → 400', async () => {
  const { srv, base } = await listen();
  try {
    const token = await login(base);
    const r = await post(base, token, { action: 'terminateAssignment', id: 'a1' });
    assert.equal(r.status, 400);
  } finally { await close(srv); }
});

test('terminateAssignment: unknown reasonType → 400', async () => {
  const { srv, base } = await listen();
  try {
    const token = await login(base);
    const r = await post(base, token, {
      action: 'terminateAssignment', id: 'a1',
      terminationDate: todayStr(), reasonType: 'משהו אחר',
    });
    assert.equal(r.status, 400);
  } finally { await close(srv); }
});

// ----- absences lifecycle -----

test('logAbsence → endAbsence round-trip', async () => {
  const { srv, base } = await listen();
  try {
    const token = await login(base);
    const workerId = await createWorker(base, token, 'דנה');

    let r = await post(base, token, {
      action: 'logAbsence',
      absence: {
        workerId, house: 'ramot',
        startDate: todayStr(), endDate: plusDays(7),
        reasonType: 'חופשה', reasonDetail: 'חופשה שנתית',
      },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.absence.status, 'active');
    const id = r.json.absence.id;

    r = await post(base, token, { action: 'endAbsence', id });
    assert.equal(r.status, 200);
    assert.equal(r.json.status, 'ended');

    const data = await get(base, token);
    const ab = data.json.absences.find(x => x.id === id);
    assert.equal(ab.status, 'ended');
    assert.equal(ab.endDate, todayStr());
  } finally { await close(srv); }
});

test('logAbsence: rejects overlapping active absence for same (worker, house)', async () => {
  const { srv, base } = await listen();
  try {
    const token = await login(base);
    const workerId = await createWorker(base, token, 'דנה');

    let r = await post(base, token, {
      action: 'logAbsence',
      absence: { workerId, house: 'ramot',
        startDate: todayStr(), endDate: plusDays(10), reasonType: 'חופשה' },
    });
    assert.equal(r.status, 200);

    // Overlapping range, same worker + house.
    r = await post(base, token, {
      action: 'logAbsence',
      absence: { workerId, house: 'ramot',
        startDate: plusDays(5), endDate: plusDays(15), reasonType: 'מחלה' },
    });
    assert.equal(r.status, 409);

    // Different house → allowed.
    r = await post(base, token, {
      action: 'logAbsence',
      absence: { workerId, house: 'asher',
        startDate: plusDays(5), endDate: plusDays(15), reasonType: 'מחלה' },
    });
    assert.equal(r.status, 200);
  } finally { await close(srv); }
});

test('logAbsence: rejects endDate before startDate', async () => {
  const { srv, base } = await listen();
  try {
    const token = await login(base);
    const workerId = await createWorker(base, token, 'X');
    const r = await post(base, token, {
      action: 'logAbsence',
      absence: { workerId, house: 'ramot',
        startDate: plusDays(10), endDate: plusDays(5), reasonType: 'חופשה' },
    });
    assert.equal(r.status, 400);
  } finally { await close(srv); }
});

test('logAbsence: rejects unknown reasonType', async () => {
  const { srv, base } = await listen();
  try {
    const token = await login(base);
    const workerId = await createWorker(base, token, 'X');
    const r = await post(base, token, {
      action: 'logAbsence',
      absence: { workerId, house: 'ramot',
        startDate: todayStr(), endDate: plusDays(3), reasonType: 'משהו' },
    });
    assert.equal(r.status, 400);
  } finally { await close(srv); }
});

test('logAbsence: accepts new "אישי" reason type', async () => {
  const { srv, base } = await listen();
  try {
    const token = await login(base);
    const workerId = await createWorker(base, token, 'X');
    const r = await post(base, token, {
      action: 'logAbsence',
      absence: { workerId, house: 'ramot',
        startDate: todayStr(), endDate: plusDays(3), reasonType: 'אישי' },
    });
    assert.equal(r.status, 200);
  } finally { await close(srv); }
});

test('deleteAbsence: refuses while a coverage still references it', async () => {
  const { srv, base } = await listen();
  try {
    const token = await login(base);
    const absentee = await createWorker(base, token, 'דנה');
    const helper = await createWorker(base, token, 'יוסי');

    let r = await post(base, token, {
      action: 'logAbsence',
      absence: { workerId: absentee, house: 'ramot',
        startDate: todayStr(), endDate: plusDays(10), reasonType: 'חופשה' },
    });
    const absenceId = r.json.absence.id;

    r = await post(base, token, {
      action: 'addCoverage',
      coverage: { absenceId, coveringWorkerId: helper,
        providingHouse: 'asher', extraPayment: 1500 },
    });
    assert.equal(r.status, 200);

    r = await post(base, token, { action: 'deleteAbsence', id: absenceId });
    assert.equal(r.status, 409);
  } finally { await close(srv); }
});

// ----- coverages lifecycle -----

test('addCoverage → deleteCoverage round-trip', async () => {
  const { srv, base } = await listen();
  try {
    const token = await login(base);
    const absentee = await createWorker(base, token, 'דנה');
    const helper = await createWorker(base, token, 'יוסי');

    let r = await post(base, token, {
      action: 'logAbsence',
      absence: { workerId: absentee, house: 'ramot',
        startDate: todayStr(), endDate: plusDays(7), reasonType: 'חופשה' },
    });
    const absenceId = r.json.absence.id;

    r = await post(base, token, {
      action: 'addCoverage',
      coverage: { absenceId, coveringWorkerId: helper,
        providingHouse: 'asher', extraPayment: 2000,
        notes: 'מחליף את דנה' },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.coverage.extraPayment, 2000);
    const covId = r.json.coverage.id;

    // Both absentee and helper stay on their own rosters — coverage is
    // just a record of who's helping out, not a transfer.
    const data = await get(base, token);
    assert.equal(data.json.workers.length, 2, 'both workers still present');
    assert.equal(data.json.coverages.length, 1);

    r = await post(base, token, { action: 'deleteCoverage', id: covId });
    assert.equal(r.status, 200);
  } finally { await close(srv); }
});

test('addCoverage: rejects unknown providingHouse', async () => {
  const { srv, base } = await listen();
  try {
    const token = await login(base);
    const r = await post(base, token, {
      action: 'addCoverage',
      coverage: { absenceId: 'ab1', coveringWorkerId: 'w1',
        providingHouse: 'nope', extraPayment: 100 },
    });
    assert.equal(r.status, 400);
  } finally { await close(srv); }
});

test('addCoverage: rejects missing absenceId', async () => {
  const { srv, base } = await listen();
  try {
    const token = await login(base);
    const r = await post(base, token, {
      action: 'addCoverage',
      coverage: { coveringWorkerId: 'w1', providingHouse: 'ramot', extraPayment: 100 },
    });
    assert.equal(r.status, 400);
  } finally { await close(srv); }
});

// ----- removed v2 actions all return 400 -----

test('removed v2 actions all return 400 from /api/action', async () => {
  const { srv, base } = await listen();
  try {
    const token = await login(base);
    const removed = [
      { action: 'addEmployee', house: 'ramot',
        employee: { name: 'x', role: 'אחות', salary: 1000, pct: 100 } },
      { action: 'updateEmployee', house: 'ramot', id: 'e1',
        employee: { name: 'x', role: 'אחות', salary: 1000, pct: 100 } },
      { action: 'deleteEmployee', house: 'ramot', id: 'e1' },
      { action: 'moveEmployee', fromHouse: 'ramot', toHouse: 'asher',
        id: 'e1', reasonType: 'חופשה' },
      { action: 'startCoverage', employeeId: 'e1', homeHouse: 'ramot',
        hostHouse: 'asher', startDate: '2026-05-20', endDate: '2026-06-01',
        reasonType: 'חופשה' },
      { action: 'endCoverage', eventId: 'ev1' },
      { action: 'terminateEmployee', house: 'ramot', id: 'e1',
        terminationDate: '2026-05-20' },
    ];
    for (const body of removed) {
      const r = await post(base, token, body);
      assert.equal(r.status, 400, `expected 400 for removed action ${body.action}`);
    }
  } finally { await close(srv); }
});

test('validateAction: rejects empty / missing body', async () => {
  const { srv, base } = await listen();
  try {
    const token = await login(base);
    const r = await post(base, token, {});
    assert.equal(r.status, 400);
  } finally { await close(srv); }
});
