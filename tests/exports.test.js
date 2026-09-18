'use strict';

// Phase 4 — the read-only CSV exports.
//
// Two things matter beyond "does it produce rows":
//   1. An exported number must MATCH the screen, because it is computed from
//      the same lib/cost-engine.js report.
//   2. A CSV carrying free text typed by a person must not be a payload.
//      Excel treats a cell starting with =, +, -, @ as a FORMULA.

const { test } = require('node:test');
const assert = require('node:assert');

const X = require('../lib/exports');
const engine = require('../lib/cost-engine');

const MONTH = '2026-09';
const TODAY = '2026-09-17';

const HOUSE_NAMES = {
  ramot: 'רמות השבים', asher: 'רעננה אשר', ofroni: 'קיסריה עפרוני',
  rehab: 'קיסריה ריהאב', pardes: 'הפרדס', sde_eliezer: 'שדה אליעזר', hq: 'מטה',
};

function wk(id, name, over) {
  return Object.assign({ id, name, phone: '', startDate: '2020-01-01', notes: '' }, over || {});
}
function asg(id, workerId, house, over) {
  return Object.assign({
    id, workerId, house, role: 'מדריך/ה', roleDetail: '', employmentType: 'full_time',
    salary: 10000, pct: 100, hourlyRate: 0, estHours: 0, sessionRate: 0, estSessions: 0,
    retainerAmount: 0, notes: '', createdAt: '2020-01-01T00:00:00.000Z',
    allowance: 0, status: 'active', statusDate: '',
  }, over || {});
}

function ctx(over) {
  return Object.assign({
    workers: [], assignments: [], absences: [], coverages: [], budgets: [],
    archive: [], monthlyActuals: [],
    month: MONTH, today: TODAY, houseNames: HOUSE_NAMES,
  }, over || {});
}

// The fixture used by most tests: two houses, five employment shapes, a
// leave status, a future starter, a missing rate, a duplicate, an absence
// and a coverage.
function fullCtx() {
  return ctx({
    workers: [
      wk('w1', 'דנה כהן', { phone: '0501111111' }),
      wk('w2', 'דנה כהן', { phone: '0502222222' }),             // duplicate name
      wk('w3', 'יוסי לוי', { phone: '050-111-1111' }),          // duplicate phone with w1
      wk('w4', 'עובד עתידי', { startDate: '2026-12-01' }),
      wk('w5', 'ללא תאריך', { startDate: '' }),
      wk('w6', 'ללא שיבוץ'),
      wk('w7', 'מטפלת', { phone: '0507777777' }),
    ],
    assignments: [
      asg('a1', 'w1', 'ramot', { salary: 12000 }),
      asg('a2', 'w2', 'asher', { salary: 8000, role: 'רכז/ת', employmentType: 'part_time', pct: 60 }),
      asg('a3', 'w3', 'ramot', { employmentType: 'hourly', salary: 0, hourlyRate: 60, estHours: 100 }),
      asg('a4', 'w4', 'ramot', { salary: 9000 }),               // future starter
      asg('a5', 'w5', 'rehab', { salary: 0 }),                  // missing rate
      asg('a6', 'w7', 'pardes', {
        role: 'מטפל/ת', employmentType: 'per_session',
        rateIndividual: 300, sessionsIndividual: 10, salary: 0,
      }),
      asg('a7', 'w1', 'hq', { salary: 3000, status: 'chlt' }),  // unpaid
    ],
    absences: [
      // Spans TODAY (2026-09-17), so it is genuinely active.
      { id: 'ab1', workerId: 'w1', house: 'ramot', startDate: '2026-09-05', endDate: '2026-09-14',
        reasonType: 'מחלה', reasonDetail: '', notes: '' },
      { id: 'ab4', workerId: 'w2', house: 'asher', startDate: '2026-09-10', endDate: '2026-09-25',
        reasonType: 'מחלה', reasonDetail: '', notes: '' },
      { id: 'ab2', workerId: '', house: 'asher', startDate: '2026-09-01', endDate: '2026-09-30',
        reasonType: 'צורך תפעולי', reasonDetail: '', notes: '' },
      { id: 'ab3', workerId: 'w3', house: 'ramot', startDate: '2026-12-01', endDate: '2026-12-10',
        reasonType: 'חופשה', reasonDetail: '', notes: '' },
    ],
    coverages: [
      { id: 'c1', coveringWorkerId: 'w3', coveringHouse: 'ramot', receivingHouse: 'asher',
        startDate: '2026-09-05', endDate: '2026-09-12', extraPayment: 800,
        role: 'מדריך/ה', shiftCount: 6, approvalStatus: 'approved', approvedBy: 'מורן',
        cancelled: false, notes: '', replacedAssignmentId: 'a2' },
      { id: 'c2', coveringWorkerId: 'w1', coveringHouse: 'ramot', receivingHouse: 'rehab',
        startDate: '2026-09-20', endDate: '2026-09-22', extraPayment: 400,
        approvalStatus: 'pending', cancelled: true, notes: 'בוטל' },
    ],
    budgets: [
      { id: 'b1', house: 'ramot', month: 'default', amount: 10000, instructorsAmount: 5000 },
      { id: 'b2', house: 'asher', month: MONTH, amount: 100000, instructorsAmount: null },
    ],
    archive: [
      { id: 'arc1', assignmentId: 'a9', workerId: 'w6', house: 'ofroni', role: 'מדריך/ה',
        employmentType: 'full_time', salary: 5000, terminationDate: '2026-08-31' },
    ],
    monthlyActuals: [
      { id: 'm1', assignmentId: 'a3', month: MONTH, actualHours: 80, actualSessions: null },
    ],
  });
}

// Parse a CSV back into rows, honouring quoting. Deliberately independent of
// the writer so a broken writer cannot produce a passing round-trip.
function parseCsv(text) {
  assert.strictEqual(text.charAt(0), '﻿', 'every export starts with the UTF-8 BOM');
  const body = text.slice(1);
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quoted) {
      if (ch === '"') {
        if (body[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(cell); cell = ''; continue; }
    if (ch === '\r' && body[i + 1] === '\n') {
      row.push(cell); cell = ''; rows.push(row); row = []; i++;
      continue;
    }
    cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function runExport(kind, c) {
  const out = X.buildExport(kind, c || fullCtx());
  return { out, rows: parseCsv(out.csv) };
}

// ---------------------------------------------------------------------------
// CSV mechanics
// ---------------------------------------------------------------------------

test('every export is UTF-8 BOM + CRLF, so Excel reads the Hebrew and the rows', () => {
  X.REPORT_KINDS.forEach(kind => {
    const out = X.buildExport(kind, fullCtx());
    assert.strictEqual(out.csv.charAt(0), '﻿', kind + ' needs the BOM');
    assert.ok(out.csv.includes('\r\n'), kind + ' needs CRLF');
    assert.ok(!/[^\r]\n/.test(out.csv), kind + ' must not contain a bare LF');
    assert.ok(out.csv.endsWith('\r\n'), kind + ' ends with a newline');
    assert.match(out.filename, /\.csv$/, kind + ' has a .csv filename');
  });
});

test('a cell containing a comma, a quote or a newline is quoted correctly', () => {
  assert.strictEqual(X.csvCell('plain'), 'plain');
  assert.strictEqual(X.csvCell('a,b'), '"a,b"');
  assert.strictEqual(X.csvCell('say "hi"'), '"say ""hi"""');
  assert.strictEqual(X.csvCell('line1\nline2'), '"line1\nline2"');
  assert.strictEqual(X.csvCell(null), '');
  assert.strictEqual(X.csvCell(undefined), '');
  assert.strictEqual(X.csvCell(0), '0', 'zero is a value, not an empty cell');
});

test('FORMULA INJECTION: a cell that Excel would run as a formula is neutralized', () => {
  // Worker names and notes are free text typed by a person. Without this, a
  // note of =HYPERLINK(...) in a forwarded file is a live payload.
  ['=1+1', '+1', '-1', '@SUM(A1)', '=HYPERLINK("http://evil","click")', '\tx', '\rx']
    .forEach(bad => {
      const cell = X.csvCell(bad);
      assert.ok(cell.replace(/^"/, '').charAt(0) === "'",
        'must be prefixed with an apostrophe: ' + JSON.stringify(bad) + ' -> ' + JSON.stringify(cell));
    });
  // And a legitimate value that merely CONTAINS one of those characters is
  // left alone — only the first character matters to Excel.
  assert.strictEqual(X.csvCell('a-b'), 'a-b');
  assert.strictEqual(X.csvCell('דנה כהן'), 'דנה כהן');
});

test('a malicious worker name is neutralized end-to-end, in a real export', () => {
  const c = ctx({
    workers: [wk('w1', '=HYPERLINK("http://evil.example","לחצי כאן")')],
    assignments: [asg('a1', 'w1', 'ramot')],
  });
  const { rows } = runExport('roster', c);
  const nameCell = rows[1][1];
  assert.strictEqual(nameCell.charAt(0), "'", 'the formula is inert');
  assert.ok(nameCell.includes('HYPERLINK'), 'but the text is preserved, not silently mangled');
});

// ---------------------------------------------------------------------------
// the numbers match the screen
// ---------------------------------------------------------------------------

test('exported totals equal the engine report the screen renders', () => {
  const c = fullCtx();
  const report = engine.costForMonth(
    c.workers, c.assignments, c.absences, c.coverages, c.budgets, c.month,
    { archive: c.archive, monthlyActuals: c.monthlyActuals });

  const { rows } = runExport('actualVsEstimate', c);
  const totals = rows[rows.length - 1];
  assert.strictEqual(totals[0], 'סה״כ');
  assert.strictEqual(Number(totals[4]), report.totals.projectedTotal);
  assert.strictEqual(Number(totals[5]), report.totals.actualConfirmed);
  assert.strictEqual(Number(totals[6]), report.totals.estimated);
  assert.strictEqual(Number(totals[7]), report.totals.missingData);
  assert.strictEqual(report.totals.actualConfirmed + report.totals.estimated,
    report.totals.projectedTotal, 'the engine invariant still holds');
});

test('passing the screen\'s own report is what guarantees the match', () => {
  const c = fullCtx();
  // A report for a DIFFERENT month, handed in explicitly. The export must
  // use what it was given rather than recomputing — that is the mechanism
  // by which a screen and its export cannot disagree.
  const decReport = engine.costForMonth(
    c.workers, c.assignments, c.absences, c.coverages, c.budgets, '2026-12',
    { archive: c.archive, monthlyActuals: c.monthlyActuals });
  const withReport = X.buildExport('byHouse', Object.assign({}, c, { report: decReport }));
  const withoutReport = X.buildExport('byHouse', c);
  assert.notStrictEqual(withReport.csv, withoutReport.csv,
    'the handed-in report is honoured, not ignored');
});

test('the payroll export carries the engine trace on every line', () => {
  const { rows } = runExport('payroll');
  const header = rows[0];
  ['חוקיות החישוב', 'פירוט החישוב', 'ימים שחויבו', 'מקור הנתון', 'workerId', 'assignmentId']
    .forEach(h => assert.ok(header.includes(h), 'header must carry ' + h));

  const ruleCol = header.indexOf('חוקיות החישוב');
  const basisCol = header.indexOf('פירוט החישוב');
  rows.slice(1).forEach(r => {
    assert.ok(r[ruleCol], 'every line names the rule that fired');
    assert.ok(r[basisCol], 'and shows its arithmetic');
  });

  // The future starter is in the file, at zero, with the reason stated.
  const nameCol = header.indexOf('שם');
  const costCol = header.indexOf('עלות');
  const future = rows.slice(1).find(r => r[nameCol] === 'עובד עתידי');
  assert.ok(future, 'a worker who has not started is still listed');
  assert.strictEqual(Number(future[costCol]), 0);
  assert.strictEqual(future[ruleCol], 'NOT_STARTED');
});

test('by-house includes a budget for the SAME month, and says אין תקציב when there is none', () => {
  const { rows } = runExport('byHouse');
  const header = rows[0];
  const houseCol = header.indexOf('בית');
  const budgetCol = header.indexOf('תקציב');
  const byHouse = {};
  rows.slice(1).forEach(r => { byHouse[r[houseCol]] = r; });

  assert.strictEqual(byHouse['רעננה אשר'][budgetCol], '100000', 'the month row wins');
  assert.strictEqual(byHouse['רמות השבים'][budgetCol], '10000', 'falling back to default');
  assert.strictEqual(byHouse['הפרדס'][budgetCol], 'אין תקציב',
    'no budget is stated in words, never as a zero');
  assert.ok(byHouse['סה״כ רשת'], 'and a network total row');
});

test('by-house rows sum to the network total row', () => {
  const { rows } = runExport('byHouse');
  const header = rows[0];
  const houseCol = header.indexOf('בית');
  const costCol = header.indexOf('עלות');
  let sum = 0;
  let network = null;
  rows.slice(1).forEach(r => {
    if (r[houseCol] === 'סה״כ רשת') network = Number(r[costCol]);
    else sum += Number(r[costCol]);
  });
  assert.strictEqual(sum, network, 'the houses must add up to the network');
});

// ---------------------------------------------------------------------------
// each report finds what it is for
// ---------------------------------------------------------------------------

test('missing start dates lists only placed workers with no date', () => {
  const { rows } = runExport('missingStartDates');
  const names = rows.slice(1).map(r => r[0]);
  assert.deepStrictEqual(names, ['ללא תאריך']);
  // NOT the unplaced worker: they cost nothing, so a missing date is moot.
  assert.ok(!names.includes('ללא שיבוץ'));
});

test('missing rates lists placements whose cost fields cannot produce a number', () => {
  const { rows } = runExport('missingRates');
  const header = rows[0];
  const nameCol = header.indexOf('שם');
  const missingCol = header.indexOf('נתונים חסרים');
  const names = rows.slice(1).map(r => r[nameCol]);
  assert.ok(names.includes('ללא תאריך'), 'the salary-0 placement is here');
  rows.slice(1).forEach(r => assert.ok(r[missingCol], 'every row says what is missing'));
});

test('unassigned separates "left" from "never placed"', () => {
  const { rows } = runExport('unassigned');
  const header = rows[0];
  const stateCol = header.indexOf('מצב');
  const byName = {};
  rows.slice(1).forEach(r => { byName[r[0]] = r; });
  assert.strictEqual(byName['ללא שיבוץ'][stateCol], 'סיים/ה עבודה',
    'this one has an archive row, so they left rather than never existing');
  assert.ok(!byName['דנה כהן'], 'placed workers are not in this report');
});

test('duplicates finds both the name match and the phone match', () => {
  const { rows } = runExport('duplicates');
  const kinds = rows.slice(1).map(r => r[0]);
  assert.ok(kinds.includes('שם זהה'));
  assert.ok(kinds.includes('טלפון זהה'));
  const nameRows = rows.slice(1).filter(r => r[0] === 'שם זהה');
  assert.strictEqual(nameRows.length, 2, 'both sides of the pair are listed');
  const phoneRows = rows.slice(1).filter(r => r[0] === 'טלפון זהה');
  assert.strictEqual(phoneRows.length, 2, 'dashes must not hide a phone duplicate');
});

test('budget exceptions reports both an overage and cost with no budget', () => {
  const { rows } = runExport('budgetExceptions');
  const header = rows[0];
  const typeCol = header.indexOf('סוג החריגה');
  const types = rows.slice(1).map(r => r[typeCol]);
  assert.ok(types.includes('חריגה מהתקציב'), 'ramot is over its 10,000');
  assert.ok(types.includes('עלות ללא תקציב מוגדר'), 'pardes costs money with no budget');
  // A house inside its budget is NOT an exception.
  const houseCol = header.indexOf('בית');
  assert.ok(!rows.slice(1).some(r => r[houseCol] === 'רעננה אשר' && r[typeCol] === 'חריגה מהתקציב'));
});

test('absences carry the derived status and separate unstaffed positions', () => {
  const { rows } = runExport('absences');
  const header = rows[0];
  const kindCol = header.indexOf('סוג רשומה');
  const statusCol = header.indexOf('סטטוס');
  const idCol = header.indexOf('absenceId');
  const byId = {};
  rows.slice(1).forEach(r => { byId[r[idCol]] = r; });
  assert.strictEqual(byId.ab4[statusCol], 'פעילה', 'ab4 spans today');
  assert.strictEqual(byId.ab1[statusCol], 'הסתיימה', 'ab1 ended on the 14th, today is the 17th');
  assert.strictEqual(byId.ab3[statusCol], 'עתידית', 'a planned absence is exported as such');
  assert.strictEqual(byId.ab2[kindCol], 'משבצת לא מאוישת');
  assert.strictEqual(byId.ab1[kindCol], 'היעדרות עובד');
  assert.strictEqual(byId.ab1[header.indexOf('ימים')], '10', 'the 5th to the 14th inclusive');
});

test('coverages include cancelled ones — the history is the point', () => {
  const { rows } = runExport('coverages');
  const header = rows[0];
  const idCol = header.indexOf('coverageId');
  const cancelledCol = header.indexOf('בוטל');
  const byId = {};
  rows.slice(1).forEach(r => { byId[r[idCol]] = r; });
  assert.strictEqual(byId.c1[cancelledCol], '');
  assert.strictEqual(byId.c2[cancelledCol], 'כן');
  assert.strictEqual(byId.c1[header.indexOf('סטטוס אישור')], 'מאושר');
  assert.strictEqual(byId.c2[header.indexOf('סטטוס אישור')], 'ממתין לאישור');
  assert.strictEqual(byId.c1[header.indexOf('מספר משמרות')], '6');
});

test('salaried vs freelance labels every line and subtotals both categories', () => {
  const { rows } = runExport('byCategory');
  const header = rows[0];
  const catCol = header.indexOf('קטגוריה');
  const cats = new Set(rows.slice(1).map(r => r[catCol]));
  assert.ok(cats.has('שכיר'));
  assert.ok(cats.has('פרילנסר'));
  const subtotals = rows.slice(1).filter(r => r[0] === 'סה״כ');
  assert.strictEqual(subtotals.length, 2, 'one subtotal per category');
});

test('by-role groups every placement exactly once', () => {
  const c = fullCtx();
  const { rows } = runExport('byRole', c);
  const header = rows[0];
  const countCol = header.indexOf('שיבוצים');
  const total = rows.slice(1).reduce((s, r) => s + Number(r[countCol]), 0);
  const report = engine.costForMonth(
    c.workers, c.assignments, c.absences, c.coverages, c.budgets, c.month,
    { archive: c.archive, monthlyActuals: c.monthlyActuals });
  const lines = report.lines.filter(l => l.kind === 'assignment').length;
  assert.strictEqual(total, lines, 'every placement is counted once and only once');
});

// ---------------------------------------------------------------------------
// robustness
// ---------------------------------------------------------------------------

test('every export survives completely empty data', () => {
  X.REPORT_KINDS.forEach(kind => {
    const out = X.buildExport(kind, ctx());
    const rows = parseCsv(out.csv);
    assert.ok(rows.length >= 1, kind + ' still writes its header row');
    assert.ok(rows[0].length > 1, kind + ' header has columns');
  });
});

test('an unknown export kind is refused rather than producing an empty file', () => {
  assert.throws(() => X.buildExport('nonsense', ctx()), /unknown export/);
});

test('the filename carries the month for month-specific reports', () => {
  assert.strictEqual(X.buildExport('payroll', ctx()).filename, 'payroll-2026-09.csv');
  assert.strictEqual(X.buildExport('duplicates', ctx()).filename, 'duplicates.csv',
    'and not for the ones that are not about a month');
});

test('exports are READ-ONLY: the input data is never mutated', () => {
  const c = fullCtx();
  const before = JSON.stringify(c);
  X.REPORT_KINDS.forEach(kind => X.buildExport(kind, c));
  assert.strictEqual(JSON.stringify(c), before, 'not one field was touched');
});

test('every report has a Hebrew label with no parentheses', () => {
  X.exportKinds().forEach(({ kind, label }) => {
    assert.ok(label, kind + ' needs a label');
    assert.ok(!/[()]/.test(label), kind + ' label must carry no parentheses: ' + label);
    assert.match(label, /[֐-׿]/, kind + ' label must be Hebrew: ' + label);
  });
});

test('no export leaks a value it should not — ids are internal but present on purpose', () => {
  // The exports DO carry workerId / assignmentId: these files are for Moran,
  // who needs to be able to point at a row. What must never appear is a
  // secret or a PIN, and there are none in this data — this test pins the
  // intent so a future report cannot quietly add one.
  X.REPORT_KINDS.forEach(kind => {
    const csv = X.buildExport(kind, fullCtx()).csv;
    ['SHARED_SECRET', 'SESSION_SECRET', 'MORAN_PIN', 'READ_SECRET', 'Bearer ']
      .forEach(bad => assert.ok(!csv.includes(bad), kind + ' must never carry ' + bad));
  });
});
