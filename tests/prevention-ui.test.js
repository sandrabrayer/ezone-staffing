'use strict';

// Phase 2 — the UI half of prevention: the guards Moran actually meets.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const { buildInlinedHtml } = require('./inline-page');

// public/index.html with its classic-script libraries inlined — see
// tests/inline-page.js for why that helper is shared.

function loadPage() {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => {
    if (/^Not implemented:/.test(e.message || '')) return;
    errors.push(e.message);
  });
  const dom = new JSDOM(buildInlinedHtml(), {
    url: 'http://localhost/', runScripts: 'dangerously',
    pretendToBeVisual: true, virtualConsole: vc,
  });
  return { dom, errors };
}

// Records every fetch the page makes, and lets a test script the replies.
function installFetch(dom, data, handlers) {
  const calls = [];
  dom.window.fetch = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), method: (init && init.method) || 'GET', body, init });
    const h = handlers && handlers(String(url), body, calls);
    if (h) {
      return {
        ok: h.status < 400, status: h.status,
        text: async () => JSON.stringify(h.json),
        json: async () => h.json,
      };
    }
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify(data),
      json: async () => data,
    };
  };
  return calls;
}

function payload(over) {
  return Object.assign({
    workers: [], assignments: [], absences: [], coverages: [], archiveV3: [],
    monthlyActuals: [], budgets: [], hearings: [],
    houses: { ramot: [], asher: [], ofroni: [], rehab: [], pardes: [], sde_eliezer: [], hq: [] },
    events: [], archive: [],
  }, over || {});
}

async function boot(dom, data, handlers) {
  const calls = installFetch(dom, data, handlers);
  dom.window.localStorage.setItem('ezone_staff_token_v1', 'fake.token.value');
  await dom.window.boot();
  return calls;
}

function wk(id, name, over) {
  return Object.assign({ id, name, notes: '', createdAt: '', startDate: '2020-01-01', phone: '' }, over || {});
}
function asg(id, workerId, house, over) {
  return Object.assign({
    id, workerId, house, role: 'מדריך/ה', roleDetail: '', employmentType: 'full_time',
    salary: 10000, pct: 100, hourlyRate: 0, estHours: 0, sessionRate: 0, estSessions: 0,
    retainerAmount: 0, notes: '', createdAt: '2020-01-01T00:00:00.000Z',
    allowance: 0, status: 'active', statusDate: '',
  }, over || {});
}

// ---------------------------------------------------------------------------
// duplicate guard
// ---------------------------------------------------------------------------

test('the inline duplicate warning fires on a normalized NAME match', async () => {
  const { dom } = loadPage();
  await boot(dom, payload({ workers: [wk('w1', 'דנה כהן')], assignments: [asg('a1', 'w1', 'ramot')] }));
  const doc = dom.window.document;
  dom.window.openWorker(null, 'ramot');
  const warn = doc.getElementById('w_nameDupWarning');
  assert.equal(warn.style.display, 'none', 'nothing typed yet');

  // Padding and a double space are invisible on screen and fatal to the
  // consumers' exact-name matching — the warning must see through them.
  doc.getElementById('w_name').value = '  דנה  כהן ';
  dom.window.onWorkerNameInput();
  assert.notEqual(warn.style.display, 'none');
  assert.match(warn.textContent, /בית נוסף הוא שיבוץ נוסף/,
    'the warning names the actual cause: a second house is a second assignment');
  dom.window.close();
});

test('the inline duplicate warning fires on a PHONE match under a different name', async () => {
  const { dom } = loadPage();
  await boot(dom, payload({
    workers: [wk('w1', 'דנה כהן', { phone: '0501234567' })],
    assignments: [asg('a1', 'w1', 'ramot')],
  }));
  const doc = dom.window.document;
  dom.window.openWorker(null, 'ramot');
  doc.getElementById('w_name').value = 'שם אחר לגמרי';
  doc.getElementById('w_phone').value = '050-123-4567';
  dom.window.onWorkerNameInput();
  const warn = doc.getElementById('w_nameDupWarning');
  assert.notEqual(warn.style.display, 'none');
  assert.match(warn.textContent, /טלפון זהה רשום כבר לדנה כהן/);
  dom.window.close();
});

test('editing a worker never warns about itself', async () => {
  const { dom } = loadPage();
  await boot(dom, payload({
    workers: [wk('w1', 'דנה כהן', { phone: '0501234567' })],
    assignments: [asg('a1', 'w1', 'ramot')],
  }));
  const doc = dom.window.document;
  dom.window.openWorker('w1', 'ramot', 'a1');
  dom.window.onWorkerNameInput();
  assert.equal(doc.getElementById('w_nameDupWarning').style.display, 'none');
  dom.window.close();
});

test('a server duplicate refusal asks, and only a yes re-sends with confirmDuplicate', async () => {
  const { dom } = loadPage();
  const data = payload({ workers: [wk('w1', 'דנה כהן')], assignments: [asg('a1', 'w1', 'ramot')] });
  let createCalls = 0;
  const calls = await boot(dom, data, (url, body) => {
    if (url !== '/api/action' || !body || body.action !== 'createWorker') return null;
    createCalls++;
    if (body.confirmDuplicate === true) {
      return { status: 200, json: { ok: true, worker: wk('w2', 'דנה כהן') } };
    }
    return {
      status: 409,
      json: {
        error: 'עובד/ת עם שם או טלפון זהה כבר קיים/ת במערכת',
        duplicates: [{ id: 'w1', name: 'דנה כהן', matchedOn: 'name' }],
      },
    };
  });

  const doc = dom.window.document;
  function fillForm() {
    dom.window.openWorker(null, 'ramot');
    doc.getElementById('w_name').value = 'דנה כהן';
    doc.getElementById('w_role').value = 'מדריך/ה';
    doc.getElementById('w_type').value = 'full_time';
    dom.window.onWorkerTypeChange();
    doc.getElementById('w_salary').value = '9000';
  }

  // 1. Moran says NO: nothing more is sent, and the modal stays open.
  dom.window.confirm = () => false;
  fillForm();
  await dom.window.saveWorker();
  assert.equal(createCalls, 1, 'one attempt, refused');
  assert.equal(calls.filter(c => c.body && c.body.confirmDuplicate).length, 0,
    'a refusal must never be retried behind her back');
  assert.ok(doc.getElementById('workerOverlay').classList.contains('show'),
    'the form stays open so she can fix the name');

  // 2. Moran says YES: exactly one retry, carrying the confirmation.
  dom.window.confirm = () => true;
  await dom.window.saveWorker();
  const confirmed = calls.filter(c => c.body && c.body.confirmDuplicate === true);
  assert.equal(confirmed.length, 1);
  assert.equal(confirmed[0].body.action, 'createWorker');
  dom.window.close();
});

// ---------------------------------------------------------------------------
// phone: validated before anything is sent
// ---------------------------------------------------------------------------

test('a malformed phone stops the save before ANY request is made', async () => {
  const { dom } = loadPage();
  const calls = await boot(dom, payload());
  const doc = dom.window.document;
  dom.window.openWorker(null, 'ramot');
  doc.getElementById('w_name').value = 'עובדת חדשה';
  doc.getElementById('w_role').value = 'מדריך/ה';
  doc.getElementById('w_type').value = 'full_time';
  dom.window.onWorkerTypeChange();
  doc.getElementById('w_salary').value = '9000';

  const before = calls.length;
  for (const bad of ['123', '0501234', '15012345678', 'לא טלפון', '9501234567']) {
    doc.getElementById('w_phone').value = bad;
    await dom.window.saveWorker();
    assert.equal(calls.length, before, 'nothing was sent onward for phone ' + JSON.stringify(bad));
  }

  // A well-formed one, with dashes, goes through normalized.
  doc.getElementById('w_phone').value = '050-123-4567';
  await dom.window.saveWorker();
  const create = calls.find(c => c.body && c.body.action === 'createWorker');
  assert.ok(create, 'now it is sent');
  assert.equal(create.body.worker.phone, '0501234567', 'dashes stripped, leading zero kept');
  dom.window.close();
});

// ---------------------------------------------------------------------------
// termination
// ---------------------------------------------------------------------------

test('termination requires a reason, and the dropdown offers the explicit opt-out', async () => {
  const { dom } = loadPage();
  const calls = await boot(dom, payload({
    workers: [wk('w1', 'יוצאת')], assignments: [asg('a1', 'w1', 'ramot')],
  }));
  const doc = dom.window.document;
  dom.window.openTerminate('a1');

  const sel = doc.getElementById('tm_reasonType');
  assert.equal(sel.options[0].value, '', 'the first option forces a choice');
  assert.match(sel.options[0].textContent, /יש לבחור סיבה/);
  const values = [...sel.options].map(o => o.value);
  assert.ok(values.includes('לא צוין'), 'no reason is an explicit choice, not a blank');

  // No reason: nothing is sent.
  dom.window.confirm = () => true;
  const before = calls.length;
  sel.value = '';
  await dom.window.saveTerminate();
  assert.equal(calls.length, before, 'a reasonless termination is refused client-side');

  // With a reason: sent, and the reason rides along.
  sel.value = 'התפטרות';
  await dom.window.saveTerminate();
  const term = calls.find(c => c.body && c.body.action === 'terminateAssignment');
  assert.ok(term);
  assert.equal(term.body.reasonType, 'התפטרות');
  dom.window.close();
});

test('the termination confirmation says what happens to the cost', async () => {
  const { dom } = loadPage();
  await boot(dom, payload({ workers: [wk('w1', 'יוצאת')], assignments: [asg('a1', 'w1', 'ramot')] }));
  const doc = dom.window.document;
  const prompts = [];
  dom.window.confirm = (m) => { prompts.push(m); return false; };

  dom.window.openTerminate('a1');
  doc.getElementById('tm_reasonType').value = 'פיטורין';
  doc.getElementById('tm_date').value = '2026-12-31';   // future
  await dom.window.saveTerminate();
  assert.match(prompts[0], /פיטורין/, 'the reason is in the confirmation');
  assert.match(prompts[0], /תמשיך להיצבר עד התאריך/, 'a future date keeps costing until then');

  doc.getElementById('tm_date').value = '2026-01-01';   // past
  await dom.window.saveTerminate();
  assert.match(prompts[1], /מתאפסת מהתאריך/);
  dom.window.close();
});

test('reason אחר requires the detail', async () => {
  const { dom } = loadPage();
  const calls = await boot(dom, payload({
    workers: [wk('w1', 'יוצאת')], assignments: [asg('a1', 'w1', 'ramot')],
  }));
  const doc = dom.window.document;
  dom.window.confirm = () => true;
  dom.window.openTerminate('a1');
  doc.getElementById('tm_reasonType').value = 'אחר';
  doc.getElementById('tm_reasonDetail').value = '';
  const before = calls.length;
  await dom.window.saveTerminate();
  assert.equal(calls.length, before, 'אחר with no detail says nothing useful — refused');
  dom.window.close();
});

// ---------------------------------------------------------------------------
// transfer
// ---------------------------------------------------------------------------

test('a transfer explains that the old placement ends and history is kept', async () => {
  const { dom } = loadPage();
  const data = payload({ workers: [wk('w1', 'עוברת')], assignments: [asg('a1', 'w1', 'ramot')] });
  const calls = await boot(dom, data);
  const doc = dom.window.document;
  const prompts = [];
  dom.window.confirm = (m) => { prompts.push(m); return true; };

  dom.window.openWorker('w1', 'ramot', 'a1');
  doc.getElementById('w_targetHouse').value = 'asher';
  doc.getElementById('w_targetFrom').value = '2026-09-15';
  await dom.window.moveWorkerHouse();

  assert.match(prompts[0], /יסתיים ויישמר בהיסטוריה/,
    'the confirmation must say the placement ends, not that the row moves');
  const move = calls.find(c => c.body && c.body.action === 'moveAssignment');
  assert.ok(move);
  assert.equal(move.body.house, 'asher');
  assert.equal(move.body.effectiveFrom, '2026-09-15');
  dom.window.close();
});

// ---------------------------------------------------------------------------
// absences: active / future / history, and unstaffed kept apart
// ---------------------------------------------------------------------------

function absence(id, workerId, house, start, end, over) {
  return Object.assign({
    id, workerId, house, startDate: start, endDate: end,
    reasonType: 'מחלה', reasonDetail: '', notes: '', status: 'active', createdAt: '',
  }, over || {});
}

test('the house view shows active, future and past absences, each in its own list', async () => {
  const { dom } = loadPage();
  const today = new Date().toISOString().slice(0, 10);
  const yr = Number(today.slice(0, 4));
  await boot(dom, payload({
    workers: [wk('w1', 'נעדרת פעילה'), wk('w2', 'נעדרת עתידית'), wk('w3', 'נעדרת בעבר')],
    assignments: [asg('a1', 'w1', 'ramot'), asg('a2', 'w2', 'ramot'), asg('a3', 'w3', 'ramot')],
    absences: [
      absence('ab1', 'w1', 'ramot', `${yr - 1}-01-01`, `${yr + 1}-12-31`),
      absence('ab2', 'w2', 'ramot', `${yr + 2}-01-01`, `${yr + 2}-01-10`),
      absence('ab3', 'w3', 'ramot', `${yr - 2}-01-01`, `${yr - 2}-01-10`),
      absence('ab4', '', 'ramot', `${yr - 1}-01-01`, `${yr + 1}-12-31`, { reasonType: 'צורך תפעולי' }),
    ],
  }));
  dom.window.go('ramot');
  const text = dom.window.document.body.textContent;

  assert.match(text, /היעדרויות עובדים פעילות/);
  assert.match(text, /משבצות לא מאוישות/);
  assert.match(text, /היעדרויות עתידיות/);
  assert.match(text, /היסטוריית היעדרויות/);

  // The unstaffed slot is NOT filed under employee absences.
  const doc = dom.window.document;
  const unstaffedRows = [...doc.querySelectorAll('.event-row.event-unstaffed')];
  assert.equal(unstaffedRows.length, 1, 'exactly the one slot with no worker');
  assert.match(unstaffedRows[0].textContent, /משבצת לא מאוישת/);
  assert.match(unstaffedRows[0].textContent, /משבצת פנויה/);

  // A future absence is visible and badged as such — before Phase 2 it was
  // stored as 'ended' and appeared nowhere.
  const pills = [...doc.querySelectorAll('.abs-status-future')];
  assert.ok(pills.length >= 1, 'the planned absence is on screen');
  assert.equal(pills[0].textContent, 'עתידית');
  dom.window.close();
});

test('a future absence can be cancelled but not "ended"', async () => {
  const { dom } = loadPage();
  const yr = Number(new Date().toISOString().slice(0, 4));
  await boot(dom, payload({
    workers: [wk('w1', 'נעדרת עתידית')],
    assignments: [asg('a1', 'w1', 'ramot')],
    absences: [absence('ab1', 'w1', 'ramot', `${yr + 2}-01-01`, `${yr + 2}-01-10`)],
  }));
  dom.window.go('ramot');
  const row = [...dom.window.document.querySelectorAll('.event-row')]
    .find(r => r.classList.contains('abs-future'));
  assert.ok(row, 'the future absence has a row');
  const labels = [...row.querySelectorAll('button')].map(b => b.textContent);
  assert.deepEqual(labels, ['ביטול'], 'nothing to "end" yet — only cancel');
  dom.window.close();
});

test('an ended absence is history and offers no actions', async () => {
  const { dom } = loadPage();
  const yr = Number(new Date().toISOString().slice(0, 4));
  await boot(dom, payload({
    workers: [wk('w1', 'נעדרת בעבר')],
    assignments: [asg('a1', 'w1', 'ramot')],
    absences: [absence('ab1', 'w1', 'ramot', `${yr - 2}-01-01`, `${yr - 2}-01-10`)],
  }));
  dom.window.go('ramot');
  const row = [...dom.window.document.querySelectorAll('.event-row')]
    .find(r => r.classList.contains('abs-ended'));
  assert.ok(row);
  assert.equal(row.querySelectorAll('button').length, 0);
  dom.window.close();
});

// ---------------------------------------------------------------------------
// logout
// ---------------------------------------------------------------------------

test('logout tells the server to revoke the session, then clears the token', async () => {
  const { dom } = loadPage();
  const calls = await boot(dom, payload());
  assert.ok(dom.window.localStorage.getItem('ezone_staff_token_v1'), 'signed in');

  await dom.window.logout();

  const out = calls.find(c => c.url === '/api/logout');
  assert.ok(out, 'the server is told');
  assert.equal(out.method, 'POST');
  assert.match(out.init.headers.Authorization, /^Bearer /, 'and told WHICH session');
  assert.equal(dom.window.localStorage.getItem('ezone_staff_token_v1'), null);
  assert.equal(dom.window.document.getElementById('pinOverlay').style.display, 'flex',
    'and the PIN gate is back');
  dom.window.close();
});

test('logout still signs out locally when the revoke call fails', async () => {
  const { dom } = loadPage();
  await boot(dom, payload());
  dom.window.fetch = async () => { throw new Error('network down'); };
  await dom.window.logout();
  assert.equal(dom.window.localStorage.getItem('ezone_staff_token_v1'), null,
    'a failed network call must never leave her stuck signed in');
  dom.window.close();
});
