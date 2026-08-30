'use strict';
// The final_settlement (גמ"ח) worker status: salary zeroed at COMPUTATION
// time (the stored terms survive a revert), the month recorded in the
// worker-level gmach_month column, and the roster rule — visible with a
// badge through gmach_month, listed with the finished workers from the
// following month.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const calc = require('../lib/calc');
const { validateAssignment, validateWorker, validateAction } = require('../lib/validate');

const gs = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

// ---------------------------------------------------------------------------
// month helpers for the roster-rule tests (real current month, jsdom uses
// the real clock too)
// ---------------------------------------------------------------------------

function ym(d) {
  return `${d.getFullYear()}-${('0' + (d.getMonth() + 1)).slice(-2)}`;
}
const now = new Date();
const CURRENT_MONTH = ym(now);
const PREV_MONTH = ym(new Date(now.getFullYear(), now.getMonth() - 1, 1));

// ---------------------------------------------------------------------------
// salary zeroing at computation time
// ---------------------------------------------------------------------------

test('assignmentCost: a final_settlement worker costs 0 (salary AND allowance)', () => {
  const a = {
    id: 'a1', workerId: 'w1', house: 'ramot', employmentType: 'full_time',
    salary: 18000, allowance: 6000, status: 'final_settlement',
  };
  assert.equal(calc.assignmentCost(a), 0);
  // The stored terms are NOT overwritten — zeroing happens at computation
  // only, so the original salary survives on the object.
  assert.equal(a.salary, 18000);
  assert.equal(a.allowance, 6000);
});

test('assignmentCost: reverting final_settlement back to active restores the original salary', () => {
  const a = {
    id: 'a1', workerId: 'w1', house: 'ramot', employmentType: 'full_time',
    salary: 18000, allowance: 2000, status: 'final_settlement',
  };
  assert.equal(calc.assignmentCost(a), 0, 'zero while final_settlement');
  a.status = 'active';
  assert.equal(calc.assignmentCost(a), 20000, 'revert restores salary + allowance untouched');
});

test('monthlyAssignmentCost: final_settlement zeroes the month cost ahead of actuals', () => {
  const a = {
    id: 'a1', workerId: 'w1', house: 'ramot', employmentType: 'hourly',
    hourlyRate: 80, estHours: 100, status: 'final_settlement',
  };
  const withActual = calc.monthlyAssignmentCost(a, { actualHours: 90 });
  assert.deepEqual(withActual, { cost: 0, isEstimate: false });
  const noActual = calc.monthlyAssignmentCost(a, null);
  assert.deepEqual(noActual, { cost: 0, isEstimate: false });
});

test('houseAssignmentsCost: a final_settlement worker drops out of the house total', () => {
  const active = {
    id: 'a1', workerId: 'w1', house: 'asher', employmentType: 'full_time', salary: 12000,
  };
  const finished = {
    id: 'a2', workerId: 'w2', house: 'asher', employmentType: 'full_time',
    salary: 9000, status: 'final_settlement',
  };
  assert.equal(calc.houseAssignmentsCost([active, finished], 'asher'), 12000);
});

test('status helpers: final_settlement is unpaid but is not a leave', () => {
  const a = { status: 'final_settlement' };
  assert.equal(calc.workerStatus(a), 'final_settlement');
  assert.equal(calc.isFinalSettlement(a), true);
  assert.equal(calc.isUnpaid(a), true);
  assert.equal(calc.isOnLeave(a), false, 'the leave badge/date rules do not apply');
  assert.ok(calc.WORKER_STATUSES.includes('final_settlement'));
});

// ---------------------------------------------------------------------------
// roster rule: current month vs gmach_month (plain YYYY-MM comparison)
// ---------------------------------------------------------------------------

test('gmachFinished: false during gmach_month, true from the following month', () => {
  const w = { id: 'w1', name: 'א', gmachMonth: '2026-07' };
  assert.equal(calc.gmachFinished(w, '2026-07'), false, 'same month → still on the roster');
  assert.equal(calc.gmachFinished(w, '2026-08'), true, 'following month → finished');
  assert.equal(calc.gmachFinished(w, '2027-01'), true, 'any later month → finished');
  assert.equal(calc.gmachFinished(w, '2026-06'), false, 'an earlier month is never finished');
  assert.equal(calc.gmachFinished({ id: 'w2', gmachMonth: '' }, '2026-08'), false,
    'blank gmach_month never hides a worker');
  assert.equal(calc.gmachFinished(null, '2026-08'), false);
});

test('filterGmachFinished: keeps the worker through gmach_month, drops them after', () => {
  const workers = [{ id: 'w1', name: 'א', gmachMonth: '2026-07' }];
  const assignments = [
    { id: 'a1', workerId: 'w1', house: 'ramot', employmentType: 'full_time', salary: 10000, status: 'final_settlement' },
    { id: 'a2', workerId: 'w2', house: 'ramot', employmentType: 'full_time', salary: 12000, status: 'active' },
  ];
  const during = calc.filterGmachFinished(assignments, workers, '2026-07');
  assert.deepEqual(during.map(a => a.id), ['a1', 'a2'], 'visible during gmach_month');
  const after = calc.filterGmachFinished(assignments, workers, '2026-08');
  assert.deepEqual(after.map(a => a.id), ['a2'], 'gone from the following month');
});

test('filterGmachFinished: non-final statuses are never filtered, whatever gmach_month says', () => {
  const workers = [{ id: 'w1', gmachMonth: '2026-01' }];
  const assignments = [
    { id: 'a1', workerId: 'w1', house: 'ramot', employmentType: 'full_time', salary: 10000, status: 'active' },
  ];
  assert.deepEqual(
    calc.filterGmachFinished(assignments, workers, '2026-08').map(a => a.id),
    ['a1'],
    'a reverted worker stays on the roster even with a stale gmach_month',
  );
});

test('gmachFinishedRows: the complement — rows for the finished-workers view', () => {
  const workers = [
    { id: 'w1', name: 'אורי לוי', gmachMonth: '2026-07' },
    { id: 'w2', name: 'דנה כהן', gmachMonth: '' },
  ];
  const assignments = [
    { id: 'a1', workerId: 'w1', house: 'ramot', role: 'מדריך/ה', roleDetail: '', employmentType: 'full_time', salary: 10000, status: 'final_settlement' },
    { id: 'a2', workerId: 'w2', house: 'asher', role: 'אחות', roleDetail: '', employmentType: 'full_time', salary: 12000, status: 'final_settlement' },
  ];
  assert.deepEqual(calc.gmachFinishedRows(assignments, workers, '2026-07'), [],
    'nobody is finished during their gmach_month');
  const after = calc.gmachFinishedRows(assignments, workers, '2026-08');
  assert.equal(after.length, 1, 'only the worker whose month passed');
  assert.equal(after[0].workerId, 'w1');
  assert.equal(after[0].name, 'אורי לוי');
  assert.equal(after[0].gmachMonth, '2026-07');
  assert.equal(after[0].house, 'ramot');
});

// ---------------------------------------------------------------------------
// validation (lib/validate.js)
// ---------------------------------------------------------------------------

test('validateAssignment: final_settlement is accepted and needs no statusDate', () => {
  const v = validateAssignment({
    workerId: 'w1', house: 'ramot', role: 'אחות',
    employmentType: 'full_time', salary: 18000, status: 'final_settlement',
  });
  assert.equal(v.status, 'final_settlement');
  assert.equal(v.statusDate, '');
  assert.equal(v.salary, 18000, 'the stored salary is NOT zeroed by validation');
});

test('validateWorker: gmachMonth follows the startDate key-presence rule', () => {
  // Omitted key → key absent from the payload (leave the stored value alone).
  const omitted = validateWorker({ name: 'א' });
  assert.ok(!Object.prototype.hasOwnProperty.call(omitted, 'gmachMonth'));
  // Explicit '' → '' (clear the stored value).
  const cleared = validateWorker({ name: 'א', gmachMonth: '' });
  assert.equal(cleared.gmachMonth, '');
  // A valid month round-trips.
  const set = validateWorker({ name: 'א', gmachMonth: '2026-08' });
  assert.equal(set.gmachMonth, '2026-08');
  // Garbage is rejected, not silently dropped.
  assert.throws(() => validateWorker({ name: 'א', gmachMonth: '08/2026' }), /bad gmachMonth/);
  assert.throws(() => validateWorker({ name: 'א', gmachMonth: '2026-13' }), /bad gmachMonth/);
});

test('validateAction: updateWorker forwards gmachMonth only when the key was sent', () => {
  const withKey = validateAction({ action: 'updateWorker', id: 'w1', worker: { name: 'א', gmachMonth: '2026-08' } });
  assert.equal(withKey.worker.gmachMonth, '2026-08');
  const withoutKey = validateAction({ action: 'updateWorker', id: 'w1', worker: { name: 'א' } });
  assert.ok(!Object.prototype.hasOwnProperty.call(withoutKey.worker, 'gmachMonth'));
});

// ---------------------------------------------------------------------------
// backend source guards (apps-script/Code.gs)
// ---------------------------------------------------------------------------

test('Code.gs: final_settlement is a known status and gmach_month is synced automatically', () => {
  const m = /const WORKER_STATUS_VALUES = \[([^\]]*)\]/.exec(gs);
  assert.ok(m, 'WORKER_STATUS_VALUES should be declared');
  const vals = m[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert.deepEqual(vals, ['active', 'chld', 'chlt', 'final_settlement']);
  assert.ok(/function\s+syncWorkerGmachMonth_\s*\(/.test(gs),
    'the automatic gmach_month sync helper must exist');
  // Both assignment writes run the sync — applying the status records the
  // month with no manual second step.
  const addBody = gs.slice(gs.indexOf('function addAssignment'), gs.indexOf('function updateAssignment'));
  const updBody = gs.slice(gs.indexOf('function updateAssignment'), gs.indexOf('function deleteAssignment'));
  assert.ok(addBody.includes('syncWorkerGmachMonth_'), 'addAssignment must sync gmach_month');
  assert.ok(updBody.includes('syncWorkerGmachMonth_'), 'updateAssignment must sync gmach_month');
});

// ---------------------------------------------------------------------------
// frontend roster behaviour in jsdom (real DOM, real current month)
// ---------------------------------------------------------------------------

function buildInlinedHtml() {
  const calcSrc = fs.readFileSync(path.join(ROOT, 'lib', 'calc.js'), 'utf8');
  const inlined = html.replace(
    /<script src="\/lib\/calc\.js"><\/script>/,
    `<script>${calcSrc}</script>`,
  );
  assert.notEqual(inlined, html, 'expected the calc.js script tag');
  return inlined;
}

function loadPage() {
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => {
    if (!/^Not implemented:/.test(e.message || '')) throw e;
  });
  return new JSDOM(buildInlinedHtml(), {
    url: 'http://localhost/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
  });
}

async function authAndBoot(dom, data) {
  const payload = Object.assign({
    workers: [], assignments: [], absences: [], coverages: [], archiveV3: [],
    monthlyActuals: [], budgets: [], hearings: [],
    houses: { ramot: [], asher: [], ofroni: [], rehab: [], pardes: [], sde_eliezer: [], hq: [] },
    events: [], archive: [],
  }, data || {});
  dom.window.fetch = async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  });
  dom.window.localStorage.setItem('ezone_staff_token_v1', 'fake.token');
  await dom.window.boot();
}

const GMACH_FIXTURE = (gmachMonth) => ({
  workers: [
    { id: 'w-gm', name: 'רועי גמח', notes: '', shift_commitment: '', startDate: '', gmachMonth },
    { id: 'w-act', name: 'שרון פעילה', notes: '', shift_commitment: '', startDate: '', gmachMonth: '' },
  ],
  assignments: [
    { id: 'a-gm', workerId: 'w-gm', house: 'ramot', role: 'מדריך/ה', roleDetail: '',
      employmentType: 'full_time', salary: 10000, pct: 0, hourlyRate: 0, estHours: 0,
      sessionRate: 0, estSessions: 0, retainerAmount: 0, notes: '', allowance: 0,
      status: 'final_settlement', statusDate: '',
      rateIndividual: 0, sessionsIndividual: 0, rateGroup: 0, sessionsGroup: 0,
      rateExternal: 0, externalPatients: 0 },
    { id: 'a-act', workerId: 'w-act', house: 'ramot', role: 'אחות', roleDetail: '',
      employmentType: 'full_time', salary: 12000, pct: 0, hourlyRate: 0, estHours: 0,
      sessionRate: 0, estSessions: 0, retainerAmount: 0, notes: '', allowance: 0,
      status: 'active', statusDate: '',
      rateIndividual: 0, sessionsIndividual: 0, rateGroup: 0, sessionsGroup: 0,
      rateExternal: 0, externalPatients: 0 },
  ],
});

test('roster DOM: during gmach_month the worker shows on the house roster with a גמ"ח badge', async () => {
  const dom = loadPage();
  await authAndBoot(dom, GMACH_FIXTURE(CURRENT_MONTH));
  dom.window.go('ramot');
  const row = dom.window.document.querySelector('tr[data-worker="w-gm"]');
  assert.ok(row, 'the גמ"ח worker must still be on the roster this month');
  const badge = row.querySelector('.gmach-badge');
  assert.ok(badge, 'the roster row must carry the גמ"ח badge');
  assert.equal(badge.textContent.trim(), 'גמ"ח');
  dom.window.close();
});

test('roster DOM: from the following month the worker leaves the roster and joins the finished workers', async () => {
  const dom = loadPage();
  await authAndBoot(dom, GMACH_FIXTURE(PREV_MONTH));
  dom.window.go('ramot');
  assert.equal(dom.window.document.querySelector('tr[data-worker="w-gm"]'), null,
    'the גמ"ח worker must be gone from the active roster');
  assert.ok(dom.window.document.querySelector('tr[data-worker="w-act"]'),
    'the active worker is unaffected');
  // Same place terminated workers show: ארכיב עובדים.
  dom.window.go('archive');
  const archiveHtml = dom.window.document.getElementById('app').innerHTML;
  assert.ok(archiveHtml.includes('רועי גמח'), 'the finished worker is listed in the archive view');
  assert.ok(archiveHtml.includes('gmach-badge'), 'with a גמ"ח badge as the reason');
  dom.window.close();
});

test('house cost DOM: the גמ"ח salary is excluded from the house total while stored terms survive', async () => {
  const dom = loadPage();
  await authAndBoot(dom, GMACH_FIXTURE(CURRENT_MONTH));
  dom.window.go('ramot');
  // Only the active worker's 12,000 counts toward the house month total —
  // the two salaries never sum to 22,000 anywhere on the page.
  const appHtml = dom.window.document.getElementById('app').innerHTML;
  assert.ok(appHtml.includes('₪12,000'), 'house total = the active worker only');
  assert.ok(!appHtml.includes('₪22,000'), 'the גמ"ח salary must not be counted');
  // The stored terms survive: the roster row still DISPLAYS the original
  // salary (zeroing happens at computation, never in the stored data).
  const row = dom.window.document.querySelector('tr[data-worker="w-gm"]');
  assert.ok(row.innerHTML.includes('₪10,000'), 'the stored salary is intact on the roster row');
  dom.window.close();
});
