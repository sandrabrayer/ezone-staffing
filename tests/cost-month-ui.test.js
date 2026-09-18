'use strict';

// The month picker must actually move the numbers on the page.
//
// This is the end-to-end half of the Phase 1 fix: tests/cost-engine*.test.js
// pin the arithmetic, and this file pins that the UI reads it. Before the
// fix, switching the month here changed only the label.

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

// `opts.hadrachot` is what GET /api/hadrachot-status answers. The default
// is the deployment as it actually stands: the feature has no configuration,
// so the server says so and the whole feature renders nothing.
async function authAndBoot(dom, fixture, opts) {
  const data = Object.assign({
    workers: [], assignments: [], absences: [], coverages: [], archiveV3: [],
    monthlyActuals: [], budgets: [], hearings: [], feedLog: [],
    houses: { ramot: [], asher: [], ofroni: [], rehab: [], pardes: [], sde_eliezer: [], hq: [] },
    events: [], archive: [],
  }, fixture || {});
  const hadrachot = (opts && opts.hadrachot) || { configured: false };
  dom.window.fetch = async (url) => {
    const body = String(url).indexOf('/api/hadrachot-status') >= 0 ? hadrachot : data;
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify(body),
      json: async () => body,
    };
  };
  dom.window.localStorage.setItem('ezone_staff_token_v1', 'fake.token');
  await dom.window.boot();
  // boot fires loadHadrachotStatus and does not await it, by design. Let the
  // promise chain settle so the panel reflects the answer.
  await new Promise(r => setTimeout(r, 0));
  await new Promise(r => setTimeout(r, 0));
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

test('the sync panel names every CONFIGURED consumer, even ones that never pulled', async () => {
  const { dom } = loadPage();
  await authAndBoot(dom, {});
  const text = dom.window.document.body.textContent;
  assert.match(text, /סטטוס סנכרון/);
  ['רכזים', 'מטפלים'].forEach(label => {
    assert.match(text, new RegExp(label), label + ' must be listed');
  });
  const never = [...dom.window.document.querySelectorAll('tr.sync-never')];
  assert.equal(never.length, 2, 'with nothing in the log, both read "never"');
  assert.match(never[0].textContent, /לא סונכרן מעולם/);
  dom.window.close();
});

test('an unconfigured consumer is hidden entirely rather than reading "never synced" forever', async () => {
  const { dom } = loadPage();
  await authAndBoot(dom, {});            // hadrachot: { configured: false }
  const rows = [...dom.window.document.querySelectorAll('.budget-table tr')];
  assert.strictEqual(rows.find(r => /הדרכות/.test(r.textContent)), undefined,
    'a feature that does not exist in this deployment must not render a dead row');
  dom.window.close();
});

test('configure it and the row comes straight back — the code never went away', async () => {
  const { dom } = loadPage();
  await authAndBoot(dom, {}, { hadrachot: { configured: true, data: { completed: [] } } });
  const rows = [...dom.window.document.querySelectorAll('.budget-table tr')];
  assert.ok(rows.find(r => /הדרכות/.test(r.textContent)),
    'configured → the consumer is listed again');
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

  // hadrachot is unconfigured in this deployment, so it has no row at all.
  assert.strictEqual(rows.find(r => /הדרכות/.test(r.textContent)), undefined);
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
  }, { hadrachot: { configured: true, data: { completed: [] } } });
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
  assert.equal(rows.length, 2, 'the two configured consumers');
  dom.window.close();
  assert.equal(errors.length, 0, 'no script errors');
});

// ---------------------------------------------------------------------------
// missing start dates, and a month with no real data
// ---------------------------------------------------------------------------

test('a placement whose worker has no start date wears the amber חסר תאריך תחילה chip', async () => {
  const { dom, errors } = loadPage();
  await authAndBoot(dom, {
    workers: [
      { id: 'w1', name: 'ללא תאריך', notes: '', createdAt: '', startDate: '' },
      { id: 'w2', name: 'עם תאריך', notes: '', createdAt: '', startDate: '2020-01-01' },
    ],
    assignments: [fullTime('a1', 'w1', 'ramot', 3000), fullTime('a2', 'w2', 'ramot', 5000)],
  });
  dom.window.onMonthChange('2026-09');
  dom.window.go('ramot');
  const doc = dom.window.document;

  const chips = [...doc.querySelectorAll('.nostart-badge')];
  assert.equal(chips.length, 1, 'exactly the undated placement is chipped');
  assert.match(chips[0].textContent, /חסר תאריך תחילה/);
  assert.match(chips[0].getAttribute('title'), /תאריך תחילת עבודה/,
    'the chip explains itself on hover');

  dom.window.close();
  assert.equal(errors.length, 0, 'no script errors');
});

test('its cost is still counted in the total, and reported in its own bucket', async () => {
  const { dom } = loadPage();
  await authAndBoot(dom, {
    workers: [
      { id: 'w1', name: 'ללא תאריך', notes: '', createdAt: '', startDate: '' },
      { id: 'w2', name: 'עם תאריך', notes: '', createdAt: '', startDate: '2020-01-01' },
    ],
    assignments: [fullTime('a1', 'w1', 'ramot', 3000), fullTime('a2', 'w2', 'ramot', 5000)],
    monthlyActuals: [{ id: 'm1', assignmentId: 'a2', month: '2026-09', actualHours: 1 }],
  });
  dom.window.onMonthChange('2026-09');

  assert.match(networkTotalText(dom), /8,?000/, 'the worker is counted, not dropped');
  const sub = [...dom.window.document.querySelectorAll('.stat .sub')].map(e => e.textContent).join(' ');
  assert.match(sub, /חסר תאריך תחילה ₪?3,?000/, 'the missing-data bucket is named and sized');
  assert.match(sub, /מאושר ₪?5,?000/, 'and it is NOT inside the confirmed figure');
  dom.window.close();
});

test('the start-dates screen shows the same chip, where it can be fixed', async () => {
  const { dom } = loadPage();
  await authAndBoot(dom, {
    workers: [
      { id: 'w1', name: 'ללא תאריך', notes: '', createdAt: '', startDate: '' },
      { id: 'w2', name: 'עם תאריך', notes: '', createdAt: '', startDate: '2020-01-01' },
    ],
    assignments: [fullTime('a1', 'w1', 'ramot', 3000), fullTime('a2', 'w2', 'ramot', 5000)],
  });
  dom.window.go('startdates');
  const doc = dom.window.document;
  const chips = [...doc.querySelectorAll('.nostart-badge')];
  assert.equal(chips.length, 1);
  assert.ok(doc.getElementById('sdrow_w1').contains(chips[0]), 'on the undated row');
  dom.window.close();
});

test('a month with no recorded actuals says so, instead of calling the projection confirmed', async () => {
  const { dom } = loadPage();
  await authAndBoot(dom, {
    workers: [{ id: 'w1', name: 'ותיקה', notes: '', createdAt: '', startDate: '2020-01-01' }],
    assignments: [fullTime('a1', 'w1', 'ramot', 10000)],
    monthlyActuals: [],
  });
  dom.window.onMonthChange('2026-09');
  const sub = [...dom.window.document.querySelectorAll('.stat .sub')].map(e => e.textContent).join(' ');

  assert.match(sub, /מאושר ₪?0/, 'confirmed-actual is ₪0');
  assert.match(sub, /לא הוזנו נתוני אמת/, 'and the page says why');
  assert.match(sub, /אומדן ₪?10,?000/, 'the whole figure sits in the estimate');
  assert.match(networkTotalText(dom), /10,?000/, 'the total itself does not move');
  dom.window.close();
});

test('record one actual and the confirmed figure comes back', async () => {
  const { dom } = loadPage();
  await authAndBoot(dom, {
    workers: [{ id: 'w1', name: 'ותיקה', notes: '', createdAt: '', startDate: '2020-01-01' }],
    assignments: [fullTime('a1', 'w1', 'ramot', 10000)],
    monthlyActuals: [{ id: 'm1', assignmentId: 'a1', month: '2026-09', actualHours: 0 }],
  });
  dom.window.onMonthChange('2026-09');
  const sub = [...dom.window.document.querySelectorAll('.stat .sub')].map(e => e.textContent).join(' ');
  assert.match(sub, /מאושר ₪?10,?000/);
  assert.ok(!/לא הוזנו נתוני אמת/.test(sub));
  dom.window.close();
});
