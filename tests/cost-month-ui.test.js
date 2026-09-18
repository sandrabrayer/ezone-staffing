'use strict';

// The month picker must actually move the numbers on the page.
//
// This is the end-to-end half of the Phase 1 fix: tests/cost-engine*.test.js
// pin the arithmetic, and this file pins that the UI reads it. Before the
// fix, switching the month here changed only the label.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');

function buildInlinedHtml() {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const calc = fs.readFileSync(path.join(ROOT, 'lib', 'calc.js'), 'utf8');
  const engine = fs.readFileSync(path.join(ROOT, 'lib', 'cost-engine.js'), 'utf8');
  return html
    .replace(/<script src="\/lib\/calc\.js"><\/script>/, `<script>${calc}</script>`)
    .replace(/<script src="\/lib\/cost-engine\.js"><\/script>/, `<script>${engine}</script>`);
}

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

async function authAndBoot(dom, fixture) {
  const data = Object.assign({
    workers: [], assignments: [], absences: [], coverages: [], archiveV3: [],
    monthlyActuals: [], budgets: [], hearings: [], feedLog: [],
    houses: { ramot: [], asher: [], ofroni: [], rehab: [], pardes: [], sde_eliezer: [], hq: [] },
    events: [], archive: [],
  }, fixture || {});
  dom.window.fetch = async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify(data),
    json: async () => data,
  });
  dom.window.localStorage.setItem('ezone_staff_token_v1', 'fake.token');
  await dom.window.boot();
}

function fullTime(id, workerId, house, salary, over) {
  return Object.assign({
    id: id, workerId: workerId, house: house, role: 'מדריך/ה', roleDetail: '',
    employmentType: 'full_time', salary: salary, pct: 100,
    hourlyRate: 0, estHours: 0, sessionRate: 0, estSessions: 0,
    retainerAmount: 0, allowance: 0, status: 'active', statusDate: '',
    notes: '', createdAt: '2020-01-01T00:00:00.000Z',
  }, over || {});
}

// The brief's case: one worker already employed, one starting 2026-12-01.
const FIXTURE = {
  workers: [
    { id: 'w1', name: 'ותיקה', notes: '', createdAt: '', startDate: '2020-01-01' },
    { id: 'w2', name: 'עתידי', notes: '', createdAt: '', startDate: '2026-12-01' },
  ],
  assignments: [
    fullTime('a1', 'w1', 'ramot', 10000),
    fullTime('a2', 'w2', 'ramot', 8000),
  ],
};

// Read the network "עלות שכר" stat card value off the central view.
function networkTotalText(dom) {
  const stats = [...dom.window.document.querySelectorAll('.stat')];
  const card = stats.find(s => /עלות שכר/.test(s.querySelector('.lbl').textContent));
  assert.ok(card, 'expected the network payroll stat card');
  return card.querySelector('.val').textContent.trim();
}

async function totalForMonth(dom, month) {
  dom.window.onMonthChange(month);
  return networkTotalText(dom);
}

test('THE FIX: changing the month changes the network total, not just the label', async () => {
  const { dom, errors } = loadPage();
  await authAndBoot(dom, FIXTURE);

  const aug = await totalForMonth(dom, '2026-08');
  const sep = await totalForMonth(dom, '2026-09');
  const oct = await totalForMonth(dom, '2026-10');
  const dec = await totalForMonth(dom, '2026-12');

  assert.match(aug, /10,?000/, 'August bills only the worker who had started');
  assert.match(sep, /10,?000/);
  assert.match(oct, /10,?000/);
  assert.match(dec, /18,?000/, 'December is when the second worker starts — the total must move');
  assert.notEqual(sep, dec, 'this equality WAS the bug');

  dom.window.close();
  assert.equal(errors.length, 0, 'no script errors');
});

test('the selected month is shown next to the total, and on every house card', async () => {
  const { dom } = loadPage();
  await authAndBoot(dom, FIXTURE);
  dom.window.onMonthChange('2026-09');
  const doc = dom.window.document;

  const stats = [...doc.querySelectorAll('.stat .lbl')].map(e => e.textContent);
  assert.ok(stats.some(t => /09\/2026/.test(t)), 'the payroll card names the month');

  const tags = [...doc.querySelectorAll('.house-box .month-tag')];
  assert.ok(tags.length > 0, 'every house card carries the month');
  tags.forEach(t => assert.equal(t.textContent.trim(), '09/2026'));

  dom.window.close();
});

test('a future starter shows 0 with a "טרם התחיל/ה" note, and a full cost once started', async () => {
  const { dom } = loadPage();
  await authAndBoot(dom, FIXTURE);
  dom.window.onMonthChange('2026-09');
  dom.window.go('ramot');
  let text = dom.window.document.querySelector('#rosterSalaried').textContent;
  assert.match(text, /טרם התחיל/, 'the September roster explains the zero');

  dom.window.onMonthChange('2026-12');
  text = dom.window.document.querySelector('#rosterSalaried').textContent;
  assert.doesNotMatch(text, /טרם התחיל/, 'by December they have started');
  assert.match(text, /8,?000/);

  dom.window.close();
});

test('a house with no budget for the month says אין תקציב, with the month named', async () => {
  const { dom } = loadPage();
  await authAndBoot(dom, FIXTURE);
  dom.window.onMonthChange('2026-09');
  const line = dom.window.document.querySelector('.house-box .bud-line');
  assert.ok(line, 'expected a budget line on the house card');
  assert.match(line.textContent, /אין תקציב/);
  assert.match(line.textContent, /09\/2026/);
  dom.window.close();
});

test('the month drives the budget too: a month override beats the default', async () => {
  const { dom } = loadPage();
  await authAndBoot(dom, Object.assign({}, FIXTURE, {
    budgets: [
      { id: 'b1', house: 'ramot', month: 'default', amount: 100000, instructorsAmount: null },
      { id: 'b2', house: 'ramot', month: '2026-09', amount: 120000, instructorsAmount: null },
    ],
  }));

  dom.window.onMonthChange('2026-09');
  let line = dom.window.document.querySelector('.house-box .bud-line').textContent;
  assert.match(line, /120,?000/, 'September has its own budget row');

  dom.window.onMonthChange('2026-10');
  line = dom.window.document.querySelector('.house-box .bud-line').textContent;
  assert.match(line, /100,?000/, 'October falls back to the default row');

  dom.window.close();
});

test('a missing rate is badged rather than shown as a silent zero', async () => {
  const { dom } = loadPage();
  await authAndBoot(dom, {
    workers: [{ id: 'w1', name: 'ללא שכר', notes: '', createdAt: '', startDate: '2020-01-01' }],
    assignments: [fullTime('a1', 'w1', 'ramot', 0)],
  });
  dom.window.onMonthChange('2026-09');
  dom.window.go('ramot');
  const doc = dom.window.document;
  assert.ok(doc.querySelector('.miss-badge'), 'expected a חסרים נתונים badge');
  const sub = [...doc.querySelectorAll('.stat .sub')].map(e => e.textContent).join(' ');
  assert.match(sub, /ללא נתונים מלאים/, 'the house total says how many placements are short');
  dom.window.close();
});

test('the instructors sub-row is labelled as part of the house total, never added to it', async () => {
  const { dom } = loadPage();
  await authAndBoot(dom, {
    workers: [
      { id: 'w1', name: 'מדריכה', notes: '', createdAt: '', startDate: '2020-01-01' },
      { id: 'w2', name: 'מנהל', notes: '', createdAt: '', startDate: '2020-01-01' },
    ],
    assignments: [
      fullTime('a1', 'w1', 'ramot', 3000),
      fullTime('a2', 'w2', 'ramot', 5000, { role: 'מנהל/ת' }),
    ],
    budgets: [{ id: 'b1', house: 'ramot', month: 'default', amount: 10000, instructorsAmount: 4000 }],
  });
  dom.window.onMonthChange('2026-09');
  const doc = dom.window.document;
  const rows = [...doc.querySelectorAll('.budget-table tbody tr')];
  const houseRow = rows.find(r => /רמות/.test(r.textContent));
  const subRow = rows.find(r => r.classList.contains('bud-sub'));
  assert.ok(houseRow && subRow, 'expected a house row and an indented מדריכים sub-row');
  assert.match(houseRow.textContent, /8,?000/, 'the house total is every role at the house');
  assert.match(subRow.textContent, /3,?000/, 'the instructors line counts only מדריך/ה');
  // 8000, not 11000: the sub-row is a breakdown of the house total.
  assert.doesNotMatch(houseRow.textContent, /11,?000/);
  dom.window.close();
});

test('a mid-month transfer shows one month of salary split across the two houses', async () => {
  const { dom } = loadPage();
  await authAndBoot(dom, {
    workers: [{ id: 'w1', name: 'עוברת בית', notes: '', createdAt: '', startDate: '2020-01-01' }],
    assignments: [fullTime('a2', 'w1', 'asher', 3000, { createdAt: '2026-09-15T08:00:00.000Z' })],
    archiveV3: [{
      id: 'arc1', assignmentId: 'a1', workerId: 'w1', name: 'עוברת בית', house: 'ramot',
      role: 'מדריך/ה', roleDetail: '', employmentType: 'full_time', salary: 3000, pct: 100,
      hourlyRate: 0, estHours: 0, sessionRate: 0, estSessions: 0, retainerAmount: 0,
      notes: '', terminationDate: '2026-09-14', reasonType: 'מעבר תפקיד', reasonDetail: '',
      archivedAt: '2026-09-14T00:00:00.000Z',
    }],
  });
  dom.window.onMonthChange('2026-09');
  assert.match(networkTotalText(dom), /3,?000/,
    'one month of salary across both houses, not two');
  dom.window.close();
});

// ---------------------------------------------------------------------------
// Phase 3 — the סטטוס סנכרון panel
// ---------------------------------------------------------------------------

test('the sync panel names all three consumers, even ones that never pulled', async () => {
  const { dom } = loadPage();
  await authAndBoot(dom, {});
  const text = dom.window.document.body.textContent;
  assert.match(text, /סטטוס סנכרון/);
  ['רכזים', 'מטפלים', 'הדרכות'].forEach(label => {
    assert.match(text, new RegExp(label), label + ' must be listed');
  });
  const never = [...dom.window.document.querySelectorAll('tr.sync-never')];
  assert.equal(never.length, 3, 'with nothing in the log, all three read "never"');
  assert.match(never[0].textContent, /לא סונכרן מעולם/);
  dom.window.close();
});

test('a recent pull reads as synced, a long-ago one as stale', async () => {
  const { dom } = loadPage();
  const now = Date.now();
  await authAndBoot(dom, {
    feedLog: [
      { consumer: 'coordinators', lastServedAt: new Date(now - 2 * 3600000).toISOString(),
        lastRowCount: 42, serveCount: 9, status: 'ok' },
      { consumer: 'therapists', lastServedAt: new Date(now - 5 * 86400000).toISOString(),
        lastRowCount: 7, serveCount: 3, status: 'ok' },
    ],
  });
  const doc = dom.window.document;
  const rows = [...doc.querySelectorAll('.budget-table tr')];

  const coord = rows.find(r => /רכזים/.test(r.textContent));
  assert.ok(coord.classList.contains('sync-ok'), 'two hours ago is fine');
  assert.match(coord.textContent, /לפני 2 שעות/);
  assert.match(coord.textContent, /42/, 'and says how many rows it got');

  const ther = rows.find(r => /מטפלים/.test(r.textContent));
  assert.ok(ther.classList.contains('sync-stale'), 'five days of silence is not');
  assert.match(ther.textContent, /לפני 5 ימים/);
  assert.match(ther.textContent, /לא סונכרן זמן רב/);

  // hadrachot pulls far less often, so five days would NOT be stale there —
  // but it has not pulled at all here.
  const hadr = rows.find(r => /הדרכות/.test(r.textContent));
  assert.ok(hadr.classList.contains('sync-never'));
  dom.window.close();
});

test('the hadrachot consumer has a longer staleness threshold than the other two', async () => {
  const { dom } = loadPage();
  const fiveDaysAgo = new Date(Date.now() - 5 * 86400000).toISOString();
  await authAndBoot(dom, {
    feedLog: [
      { consumer: 'hadrachot', lastServedAt: fiveDaysAgo, lastRowCount: 12, serveCount: 2, status: 'ok' },
      { consumer: 'coordinators', lastServedAt: fiveDaysAgo, lastRowCount: 12, serveCount: 2, status: 'ok' },
    ],
  });
  const rows = [...dom.window.document.querySelectorAll('.budget-table tr')];
  const hadr = rows.find(r => /הדרכות/.test(r.textContent));
  const coord = rows.find(r => /רכזים/.test(r.textContent));
  assert.ok(hadr.classList.contains('sync-ok'),
    'hadrachot pulls rarely, so five days is normal for it');
  assert.ok(coord.classList.contains('sync-stale'),
    'the coordinators app pulls on every house open, so five days is not');
  dom.window.close();
});

test('an unusable timestamp reads as never synced rather than crashing', async () => {
  const { dom, errors } = loadPage();
  await authAndBoot(dom, {
    feedLog: [
      { consumer: 'coordinators', lastServedAt: '', lastRowCount: 0, serveCount: 0, status: 'ok' },
      { consumer: 'therapists', lastServedAt: 'not a date', lastRowCount: 0, serveCount: 0, status: 'ok' },
    ],
  });
  const rows = [...dom.window.document.querySelectorAll('tr.sync-never')];
  assert.equal(rows.length, 3);
  dom.window.close();
  assert.equal(errors.length, 0, 'no script errors');
});
