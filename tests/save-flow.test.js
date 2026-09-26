'use strict';

// The save flow (docs/save-flow.md).
//
// Pinned here:
//   - QUEUE: a write never waits behind reads — not in-flight ones, not
//     queued ones, user or background — and a stream of reads cannot starve
//     writes; the proxy sends every write down that lane.
//   - BUTTON: spinner + «שומר…» + disabled on the click itself; a second
//     click never submits twice.
//   - RESULT: green toast on success, red Hebrew toast WITH the reason on
//     failure, «השמירה לא אושרה — נסו שוב» after the timeout — button
//     re-enabled every time, never silent.
//   - CONFIRMATION: the page updates from the row the server returns, and a
//     read that overlapped the save can no longer paint pre-save data over
//     it (the «role change did not persist» report).
//   - PREVIEW: every save / edit button reads «טוען נתונים עדכניים…» and
//     re-enables by itself when fresh data lands.
//   - MARKETER: «אחר» → «משווק/ת» + «עמלה לפי מקרה» sends no cost field and
//     the proxy validator accepts the payload; a worker-form edit that only
//     changes the placement costs one write, not two.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { buildInlinedHtml, ROOT } = require('./inline-page');
const { createUpstreamQueue } = require('../lib/upstream');
const V = require('../lib/validate');

const HTML = buildInlinedHtml();
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }

// ---------------------------------------------------------------------------
// queue
// ---------------------------------------------------------------------------

test('queue: a write starts at once while both read slots are busy and more reads are queued', async () => {
  const q = createUpstreamQueue({ concurrency: 2 });
  const gates = [];
  const started = [];
  const read = (name, lane) => q.run(() => { started.push(name); const d = deferred(); gates.push(d); return d.promise; }, lane);
  read('r1', 'user'); read('r2', 'background');
  for (let i = 0; i < 5; i++) { read('u' + i, 'user'); read('b' + i, 'background'); }
  await tick(1);
  assert.deepEqual(started, ['r1', 'r2'], 'both read slots busy');
  let wrote = false;
  const w = q.run(async () => { wrote = true; return 'ok'; }, 'write');
  await tick(1);
  assert.equal(wrote, true, 'the write did not wait for a read slot');
  assert.equal(await w, 'ok');
  assert.equal(q.depth().queued, 10, 'the queued reads are still waiting');
  gates.forEach((g) => g.resolve());
});

test('queue: under a continuous stream of reads, every write still runs promptly (no starvation)', async () => {
  const q = createUpstreamQueue({ concurrency: 2 });
  let stop = false;
  const pumpReads = async () => { while (!stop) { await Promise.all([q.run(() => tick(5)), q.run(() => tick(5), 'background')]); } };
  const loops = [pumpReads(), pumpReads(), pumpReads()];
  const waits = [];
  for (let i = 0; i < 10; i++) {
    const t0 = Date.now();
    await q.run(() => tick(2), 'write');
    waits.push(Date.now() - t0);
  }
  stop = true;
  await Promise.all(loops);
  assert.ok(Math.max(...waits) < 50, 'write waits: ' + waits.join(','));
});

test('queue: writes queue only behind writes (default one write slot), in order', async () => {
  const q = createUpstreamQueue({ concurrency: 2 });
  assert.equal(q.writeLimit, 1);
  const order = [];
  const a = deferred();
  const w1 = q.run(async () => { order.push('w1 start'); await a.promise; order.push('w1 end'); }, 'write');
  const w2 = q.run(async () => { order.push('w2 start'); }, 'write');
  await tick(1);
  assert.deepEqual(order, ['w1 start']);
  a.resolve();
  await Promise.all([w1, w2]);
  assert.deepEqual(order, ['w1 start', 'w1 end', 'w2 start']);
});

test('the proxy sends every write down the write lane, and only writes', () => {
  assert.match(SERVER, /callAppsScript\('POST', payload, \{ lane: isWrite \? 'write' : 'user'/);
  assert.match(SERVER, /createUpstreamQueue\(\{\s*concurrency: UPSTREAM_CONCURRENCY, writeConcurrency: UPSTREAM_WRITE_CONCURRENCY/);
});

// ---------------------------------------------------------------------------
// the page
// ---------------------------------------------------------------------------

function payload(opts) {
  const o = opts || {};
  return {
    workers: [{ id: 'w1', name: 'ציון מקנזי', notes: '', startDate: '2025-03-01', shift_commitment: '', phone: '' }],
    assignments: [{ id: 'a1', workerId: 'w1', house: 'ramot', role: o.role || 'אחר', roleDetail: 'משווק',
      employmentType: o.type || 'full_time', salary: o.type === 'per_case_commission' ? 0 : 12000,
      allowance: 0, status: 'active', statusDate: '', notes: '' }],
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
function loadPage({ fetchImpl, local, timeoutMs }) {
  const posts = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { if (!/^Not implemented:/.test(e.message || '')) throw e; });
  const dom = new JSDOM(HTML, {
    url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(window) {
      window.localStorage.setItem('ezone_staff_token_v1', 't.k');
      if (local) window.localStorage.setItem('ezone_staff_data_v2', JSON.stringify(local));
      if (timeoutMs) window.__EZ_SAVE_TIMEOUT_MS = timeoutMs;
      window.confirm = () => true;
      window.fetch = (url, init) => {
        url = String(url);
        if (url === '/api/action') posts.push(JSON.parse(init.body));
        return fetchImpl(url, init);
      };
    },
  });
  return { dom, w: dom.window, doc: dom.window.document, posts };
}
const echo = (body) => response({ ok: true, confirmed: true, assignment: Object.assign({ id: body.id }, body.assignment) });
const toastEl = (doc) => doc.getElementById('toast');

// The real path: placement edits are made in the worker form (the house
// roster's edit button → openWorker → saveWorker). A placement-only edit is
// one updateAssignment post (see the last test).
async function editPage(actionImpl, extra) {
  const r = loadPage(Object.assign({
    fetchImpl: async (url, init) => {
      if (url === '/api/action') return actionImpl(JSON.parse(init.body));
      if (url === '/api/data') return response(payload());
      return response({ configured: false });
    },
  }, extra || {}));
  await tick(30);
  r.w.openWorker('w1', 'ramot');
  return r;
}

test('button: spinner + «שומר…» + disabled on the click itself; a second click never posts twice', async () => {
  const gate = deferred();
  const { dom, w, doc, posts } = await editPage(async (b) => { await gate.promise; return echo(b); });
  const btn = doc.getElementById('workerSaveBtn');
  const label = btn.textContent;
  const p1 = w.saveWorker();
  assert.equal(btn.disabled, true, 'disabled at once');
  assert.ok(btn.querySelector('.btn-spin'), 'spinner at once');
  assert.match(btn.textContent, /שומר…/);
  assert.equal(btn.getAttribute('aria-busy'), 'true');
  const p2 = w.saveWorker();
  btn.click();
  await tick(5);
  assert.equal(posts.length, 1, 'one save, however many clicks');
  gate.resolve();
  await Promise.all([p1, p2]);
  assert.equal(btn.disabled, false);
  assert.equal(btn.textContent, label, 'label restored');
  dom.window.close();
});

test('success: green toast, form closed, the page shows the row the server confirmed', async () => {
  const { dom, w, doc } = await editPage(async (b) =>
    response({ ok: true, confirmed: true, assignment: Object.assign({ id: 'a1' }, b.assignment, { roleDetail: 'as stored' }) }));
  await w.saveWorker();
  assert.ok(toastEl(doc).classList.contains('ok'), 'green');
  assert.match(toastEl(doc).textContent, /נשמר/);
  assert.equal(w.eval("ASSIGNMENTS.find(a => a.id === 'a1').roleDetail"), 'as stored', 'from the confirmation, not the form');
  assert.ok(!doc.getElementById('workerOverlay').classList.contains('show'));
  w.eval('clearTimeout(refreshAfterSaveTimer)');
  dom.window.close();
});

test('failure: red Hebrew toast WITH the reason, button re-enabled, form stays open', async () => {
  const { dom, w, doc } = await editPage(async () =>
    response({ error: 'salary not allowed for employmentType=per_case_commission' }, { status: 400 }));
  await w.saveWorker();
  const t = toastEl(doc);
  assert.ok(t.classList.contains('err'), 'red');
  assert.equal(t.textContent, 'השמירה נדחתה: השדה «שכר ברוטו» לא מתאים לסוג העסקה «עמלה לפי מקרה»');
  assert.equal(t.getAttribute('role'), 'alert', 'announced');
  assert.equal(doc.getElementById('workerSaveBtn').disabled, false);
  assert.ok(doc.getElementById('workerOverlay').classList.contains('show'), 'nothing lost');
  dom.window.close();
});

test('failure: every kind of error becomes a Hebrew sentence that keeps the reason', async () => {
  const { dom, w } = await editPage(async (b) => echo(b));
  const say = (e) => w.saveErrorText(e);
  assert.equal(say({ timeout: true }), 'השמירה לא אושרה — נסו שוב');
  assert.match(say(Object.assign(new TypeError('Failed to fetch'))), /^אין חיבור לשרת/);
  assert.equal(say({ status: 400, message: 'bad house' }), 'השמירה נדחתה: ערך לא תקין (bad house)');
  assert.match(say({ status: 409, message: 'worker already has an assignment at this house' }), /^השמירה נדחתה: התנגשות.*worker already/);
  assert.match(say({ status: 404, message: 'assignment not found' }), /^השמירה נכשלה: הרשומה לא נמצאה/);
  assert.equal(say({ status: 502, message: 'שגיאה בשרת. נסי שוב בעוד רגע.' }), 'השמירה נכשלה: שגיאה בשרת. נסי שוב בעוד רגע.');
  assert.match(say({ status: 500, message: 'boom' }), /^השמירה נכשלה \(שגיאה 500\): boom$/);
  dom.window.close();
});

test('timeout: after the limit «השמירה לא אושרה — נסו שוב», button re-enabled, a refresh is scheduled', async () => {
  const { dom, w, doc } = await editPage(() => new Promise(() => {}), { timeoutMs: 60 });
  const t0 = Date.now();
  await w.saveWorker();
  assert.ok(Date.now() - t0 >= 55);
  assert.equal(toastEl(doc).textContent, 'השמירה לא אושרה — נסו שוב');
  assert.ok(toastEl(doc).classList.contains('err'));
  assert.equal(doc.getElementById('workerSaveBtn').disabled, false);
  assert.ok(w.eval('refreshAfterSaveTimer') !== null, 'the page checks what really got stored');
  assert.equal(w.eval('WRITES_IN_FLIGHT'), 0);
  w.eval('clearTimeout(refreshAfterSaveTimer)');
  dom.window.close();
});

test('the production timeout is 30 s', () => {
  assert.match(HTML, /return Number\(window\.__EZ_SAVE_TIMEOUT_MS\) \|\| 30000;/);
});

test('a read that overlapped the save never paints pre-save data over the confirmed row', async () => {
  const gate = deferred();
  let reads = 0;
  const { dom, w } = loadPage({
    fetchImpl: async (url, init) => {
      if (url === '/api/data') { reads++; if (reads === 1) return response(payload(), { xcache: 'STALE' }); await gate.promise; return response(payload()); }
      if (url === '/api/action') return echo(JSON.parse(init.body));
      return response({ configured: false });
    },
  });
  await tick(30);
  w.eval('clearTimeout(refreshTimer)');
  const inFlight = w.refreshData(false);  // started BEFORE the save
  await tick(2);
  w.openWorker('w1', 'ramot');
  w.document.getElementById('w_role').value = 'משווק/ת';
  w.onWorkerRoleChange(); w.preselectCommission('w');
  await w.saveWorker();
  assert.equal(w.eval("ASSIGNMENTS[0].role"), 'משווק/ת');
  gate.resolve();                          // the pre-save read lands now
  await inFlight;
  await tick(10);
  assert.equal(w.eval("ASSIGNMENTS[0].role"), 'משווק/ת', 'the saved role survives');
  assert.equal(w.eval("ASSIGNMENTS[0].employmentType"), 'per_case_commission');
  w.eval('clearTimeout(refreshAfterSaveTimer)');
  dom.window.close();
});

test('marketer: «אחר» → «משווק/ת» sends commission with NO cost field, and the proxy validator accepts it', async () => {
  const { dom, w, doc, posts } = await editPage(async (b) => echo(b));
  doc.getElementById('w_role').value = 'משווק/ת';
  w.onWorkerRoleChange(); w.preselectCommission('w');
  // Whatever the hidden inputs still hold must not travel.
  doc.getElementById('w_salary').value = '12000';
  await w.saveWorker();
  assert.equal(posts.length, 1);
  const a = posts[0].assignment;
  assert.equal(a.role, 'משווק/ת');
  assert.equal(a.employmentType, 'per_case_commission');
  ['salary', 'pct', 'hourlyRate', 'estHours', 'sessionRate', 'estSessions', 'retainerAmount',
    'rateIndividual', 'sessionsIndividual', 'rateGroup', 'sessionsGroup', 'rateExternal', 'externalPatients']
    .forEach((f) => assert.ok(!(f in a), f + ' must not be sent'));
  assert.doesNotThrow(() => V.validateAction(posts[0]));
  assert.ok(toastEl(doc).classList.contains('ok'));
  w.eval('clearTimeout(refreshAfterSaveTimer)');
  dom.window.close();
});

test('stripForeignCostFields drops every field the type does not allow — and keeps the ones it does', async () => {
  const { dom, w } = await editPage(async (b) => echo(b));
  const strip = (x) => JSON.parse(JSON.stringify(w.stripForeignCostFields(x)));
  assert.deepEqual(strip({ employmentType: 'per_case_commission', salary: 1, hourlyRate: 2, allowance: 2000 }),
    { employmentType: 'per_case_commission', allowance: 2000 });
  assert.deepEqual(strip({ employmentType: 'hourly', salary: 1, hourlyRate: 60, estHours: 40 }),
    { employmentType: 'hourly', hourlyRate: 60, estHours: 40 });
  dom.window.close();
});

test('worker form: a placement-only change (role → משווק/ת) is ONE write, not two', async () => {
  const r = loadPage({
    fetchImpl: async (url, init) => {
      if (url === '/api/action') return echo(JSON.parse(init.body));
      if (url === '/api/data') return response(payload());
      return response({ configured: false });
    },
  });
  await tick(30);
  const { w, doc, posts } = r;
  w.openWorker('w1', 'ramot');
  doc.getElementById('w_role').value = 'משווק/ת';
  w.onWorkerRoleChange(); w.preselectCommission('w');
  await w.saveWorker();
  assert.deepEqual(posts.map((p) => p.action), ['updateAssignment'], 'the unchanged worker row is not rewritten');
  assert.equal(posts[0].assignment.employmentType, 'per_case_commission');
  assert.ok(!('salary' in posts[0].assignment));
  assert.doesNotThrow(() => V.validateAction(posts[0]));
  // A real change to the person still writes the worker first.
  posts.length = 0;
  w.openWorker('w1', 'ramot');
  doc.getElementById('w_name').value = 'ציון מקנזי-לוי';
  await w.saveWorker();
  assert.deepEqual(posts.map((p) => p.action), ['updateWorker', 'updateAssignment']);
  w.eval('clearTimeout(refreshAfterSaveTimer)');
  r.dom.window.close();
});

test('preview: save / edit buttons read «טוען נתונים עדכניים…», disabled — and re-enable by themselves', async () => {
  const gate = deferred();
  const r = loadPage({
    local: { v: 2, savedAt: Date.now() - 60e3, data: payload() },
    fetchImpl: async (url) => {
      if (url === '/api/data') { await gate.promise; return response(payload()); }
      return response({ configured: false });
    },
  });
  await tick(20);
  const { w, doc } = r;
  assert.equal(w.eval('DATA_PREVIEW'), true);
  w.go('ramot');
  const locked = [...doc.querySelectorAll('#app button')].filter((b) => /^\s*(open|save|delete|terminate|move|end)\w*\(/.test(b.getAttribute('onclick') || ''));
  assert.ok(locked.length > 0, 'the house view has edit buttons');
  locked.forEach((b) => {
    assert.equal(b.disabled, true, 'disabled: ' + b.getAttribute('onclick'));
    assert.equal(b.getAttribute('title'), 'טוען נתונים עדכניים…');
  });
  const modalSave = doc.getElementById('workerSaveBtn');
  assert.equal(modalSave.disabled, true);
  assert.equal(modalSave.textContent, 'טוען נתונים עדכניים…', 'says why, instead of refusing silently');

  gate.resolve();
  await tick(20);
  assert.equal(w.eval('DATA_PREVIEW'), false);
  assert.equal(modalSave.disabled, false, 'enabled automatically');
  assert.notEqual(modalSave.textContent, 'טוען נתונים עדכניים…');
  [...doc.querySelectorAll('#app button')].forEach((b) => assert.ok(!b.dataset.previewLock, 'no button left locked'));
  const editBtn = [...doc.querySelectorAll('#app button')].find((b) => /^\s*open\w*\(/.test(b.getAttribute('onclick') || ''));
  assert.equal(editBtn.disabled, false);
  r.dom.window.close();
});
