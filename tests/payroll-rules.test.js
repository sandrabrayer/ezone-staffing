'use strict';

// Rule guards for בקרת שכר — lib/payroll-rules.js.
//
// EVERY rule id R01..R17 gets a fail path (the rule fires, on the values it
// is supposed to fire on) AND a pass path (it stays silent on a clean row).
// tests/payroll-guards.test.js separately asserts that this file covers the
// full catalogue, so a new rule cannot be added without tests.
//
// The last block runs the rules over the REAL August 2026 file, which is the
// check that the thresholds describe reality rather than a made-up roster.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const R = require('../lib/payroll-rules');

const golden = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'tamhir-2026-08.json'), 'utf8'));

const MONTH = '2026-08';

// A clean salaried row: matched worker, mapped house, legal pension split,
// ordinary national insurance, arithmetic that adds up. Every fail-path test
// below starts from this and changes ONE thing.
function cleanRow(over) {
  const row = Object.assign({
    empNumber: '33', rawName: 'רובין סופיה חן', dept: '001', deptName: 'רעננה פרדס',
    tashlumim: 10000, tagmulim: 650, keren: 0, pitzuim: 600,
    shonot: 0, bituach: 500, masMaasikim: 0, masSachar: 0,
  }, over || {});
  if (!Object.prototype.hasOwnProperty.call(over || {}, 'total')) {
    row.total = Math.round((row.tashlumim + row.tagmulim + row.keren + row.pitzuim +
      row.shonot + row.bituach + row.masMaasikim + row.masSachar) * 100) / 100;
  }
  return row;
}

const WORKER = {
  id: 'w1', name: 'רובין סופיה חן', startDate: '2020-01-01', payrollEmpNumber: '33',
};

function run(over) {
  const input = Object.assign({
    month: MONTH,
    runId: 'pr_test',
    rows: [cleanRow()],
    workers: [WORKER],
    placements: [{ workerId: 'w1', house: 'pardes', houseLabel: 'רעננה הפרדס', active: true }],
    terminations: [],
    previousTotals: {},
  }, over || {});
  return R.evaluateRun(input);
}

function ids(result) {
  return [...new Set(result.findings.map(f => f.ruleId))].sort();
}

function fired(result, ruleId) {
  return result.findings.some(f => f.ruleId === ruleId);
}

// ---------------------------------------------------------------------------
// The baseline must be silent, or every "fires" test below proves nothing
// ---------------------------------------------------------------------------

test('baseline: a clean matched row raises NO findings at all', () => {
  const res = run();
  assert.deepStrictEqual(res.findings, [], 'the clean fixture must be clean');
  assert.strictEqual(res.lines.length, 1);
  assert.strictEqual(res.lines[0].matchStatus, 'number');
  assert.strictEqual(res.lines[0].matchedWorkerId, 'w1');
  assert.strictEqual(res.lines[0].mappedHouse, 'pardes');
});

// ---------------------------------------------------------------------------
// R01 — employee number or name not found in the staffing workers tab
// ---------------------------------------------------------------------------

test('R01 fires when neither the number nor the name matches', () => {
  const res = run({ rows: [cleanRow({ empNumber: '999', rawName: 'מישהו אחר' })] });
  assert.ok(fired(res, 'R01'));
  assert.strictEqual(res.lines[0].matchStatus, 'unmatched');
  const f = res.findings.find(x => x.ruleId === 'R01');
  assert.strictEqual(f.severity, 'critical');
  assert.ok(f.messageHe.indexOf('999') >= 0, 'the message names the employee number');
});

test('R01 fires on an AMBIGUOUS multi-hit name rather than guessing', () => {
  const res = run({
    rows: [cleanRow({ empNumber: '999', rawName: 'כפיל שם' })],
    workers: [
      { id: 'wa', name: 'כפיל שם', startDate: '2020-01-01', payrollEmpNumber: '' },
      { id: 'wb', name: 'כפיל שם', startDate: '2020-01-01', payrollEmpNumber: '' },
    ],
    placements: [],
  });
  assert.ok(fired(res, 'R01'));
  assert.strictEqual(res.lines[0].matchStatus, 'ambiguous');
  assert.strictEqual(res.lines[0].matchedWorkerId, '', 'an ambiguous match binds nobody');
});

test('R01 does NOT fire when the worker matches', () => {
  assert.ok(!fired(run(), 'R01'));
});

// ---------------------------------------------------------------------------
// R02 — matched worker terminated before the payroll month
// ---------------------------------------------------------------------------

test('R02 fires when a terminated worker is still being paid', () => {
  const res = run({ terminations: [{ workerId: 'w1', terminationDate: '2026-06-30' }] });
  assert.ok(fired(res, 'R02'));
  const f = res.findings.find(x => x.ruleId === 'R02');
  assert.strictEqual(f.severity, 'critical');
  assert.ok(f.messageHe.indexOf('2026-06-30') >= 0);
});

test('R02 does NOT fire for a termination inside or after the payroll month', () => {
  assert.ok(!fired(run({ terminations: [{ workerId: 'w1', terminationDate: '2026-08-15' }] }), 'R02'));
  assert.ok(!fired(run({ terminations: [{ workerId: 'w1', terminationDate: '2026-09-01' }] }), 'R02'));
});

test('R02 uses the LATEST termination, so a rehire is not flagged', () => {
  const res = run({
    terminations: [
      { workerId: 'w1', terminationDate: '2024-01-31' },
      { workerId: 'w1', terminationDate: '2026-09-30' },
    ],
  });
  assert.ok(!fired(res, 'R02'), 'the most recent archive row wins');
});

// ---------------------------------------------------------------------------
// R03 — active worker with a current placement and no line in the file
// ---------------------------------------------------------------------------

test('R03 fires for a placed worker with no line in the file', () => {
  const res = run({
    workers: [WORKER, { id: 'w2', name: 'עובד חסר', startDate: '2020-01-01', payrollEmpNumber: '77' }],
    placements: [
      { workerId: 'w1', house: 'pardes', houseLabel: 'רעננה הפרדס', active: true },
      { workerId: 'w2', house: 'sde_eliezer', houseLabel: 'שדה אליעזר', active: true },
    ],
  });
  assert.ok(fired(res, 'R03'));
  const f = res.findings.find(x => x.ruleId === 'R03');
  assert.strictEqual(f.lineId, '', 'R03 has no line — the whole point is that there is none');
  assert.ok(f.messageHe.indexOf('עובד חסר') >= 0);
  assert.ok(f.messageHe.indexOf('שדה אליעזר') >= 0);
});

test('R03: a worker placed at שדה אליעזר always fires — that house has no payroll department', () => {
  const res = run({
    rows: [],
    workers: [{ id: 'w2', name: 'עובד שדה', startDate: '2020-01-01', payrollEmpNumber: '77' }],
    placements: [{ workerId: 'w2', house: 'sde_eliezer', houseLabel: 'שדה אליעזר', active: true }],
  });
  assert.ok(fired(res, 'R03'));
});

test('R03 does NOT fire for a worker terminated before the month', () => {
  const res = run({
    rows: [],
    workers: [{ id: 'w2', name: 'עזב', startDate: '2020-01-01', payrollEmpNumber: '77' }],
    placements: [{ workerId: 'w2', house: 'pardes', houseLabel: 'רעננה הפרדס', active: true }],
    terminations: [{ workerId: 'w2', terminationDate: '2026-05-31' }],
  });
  assert.ok(!fired(res, 'R03'), 'somebody who legitimately left is not a missing line');
});

test('R03 does NOT fire when every placed worker has a line', () => {
  assert.ok(!fired(run(), 'R03'));
});

// ---------------------------------------------------------------------------
// R04 — duplicate employee number in the file
// ---------------------------------------------------------------------------

test('R04 fires once per duplicated line and names the count', () => {
  const res = run({ rows: [cleanRow(), cleanRow({ rawName: 'שם אחר' })] });
  assert.ok(fired(res, 'R04'));
  const dupes = res.findings.filter(f => f.ruleId === 'R04');
  assert.strictEqual(dupes.length, 2, 'both offending lines are flagged');
  assert.strictEqual(dupes[0].severity, 'critical');
  assert.ok(dupes[0].messageHe.indexOf('2 פעמים') >= 0);
});

test('R04 does NOT fire on distinct employee numbers', () => {
  const res = run({
    rows: [cleanRow(), cleanRow({ empNumber: '34', rawName: 'שם אחר' })],
    workers: [WORKER, { id: 'w2', name: 'שם אחר', startDate: '2020-01-01', payrollEmpNumber: '34' }],
    placements: [
      { workerId: 'w1', house: 'pardes', houseLabel: 'רעננה הפרדס', active: true },
      { workerId: 'w2', house: 'pardes', houseLabel: 'רעננה הפרדס', active: true },
    ],
  });
  assert.ok(!fired(res, 'R04'));
});

// ---------------------------------------------------------------------------
// R05 — mapped house differs from the worker's current placement house
// ---------------------------------------------------------------------------

test('R05 fires when the payroll department maps to a different house', () => {
  const res = run({
    placements: [{ workerId: 'w1', house: 'ramot', houseLabel: 'רמות השבים', active: true }],
  });
  assert.ok(fired(res, 'R05'));
  const f = res.findings.find(x => x.ruleId === 'R05');
  assert.strictEqual(f.severity, 'warning');
  assert.ok(f.messageHe.indexOf('רמות השבים') >= 0);
  assert.ok(f.messageHe.indexOf('רעננה פרדס') >= 0);
});

test('R05 does NOT fire when the house matches, nor when the house is unconfirmed', () => {
  assert.ok(!fired(run(), 'R05'));
  // Department 002 maps to null, so there is nothing to compare against and
  // R16 is the finding that matters.
  const res = run({ rows: [cleanRow({ dept: '002', deptName: 'קיסריה' })] });
  assert.ok(!fired(res, 'R05'), 'an unconfirmed mapping never asserts a mismatch');
  assert.ok(fired(res, 'R16'));
});

// ---------------------------------------------------------------------------
// R06 — zero tashlumim but non-zero total
// ---------------------------------------------------------------------------

test('R06 fires on employer cost with no salary', () => {
  const res = run({ rows: [cleanRow({ tashlumim: 0, tagmulim: 1872, pitzuim: 1728, bituach: 162.08 })] });
  assert.ok(fired(res, 'R06'));
  const f = res.findings.find(x => x.ruleId === 'R06');
  assert.strictEqual(f.severity, 'critical');
  assert.strictEqual(f.actual, '0.00');
});

test('R06 does NOT fire on a paid row, nor on an all-zero row', () => {
  assert.ok(!fired(run(), 'R06'));
  const zero = run({ rows: [cleanRow({
    tashlumim: 0, tagmulim: 0, keren: 0, pitzuim: 0, bituach: 0, total: 0 })] });
  assert.ok(!fired(zero, 'R06'), 'nothing paid and nothing charged is not an anomaly');
});

// ---------------------------------------------------------------------------
// R07 — the pension rule. THE primary output of this tool.
// ---------------------------------------------------------------------------

test('R07 fires: no employer pension at all, tashlumim >= 1500, tenure over 6 months', () => {
  const res = run({ rows: [cleanRow({ tagmulim: 0, pitzuim: 0, tashlumim: 5000, bituach: 250 })] });
  assert.ok(fired(res, 'R07'));
  const f = res.findings.find(x => x.ruleId === 'R07');
  assert.strictEqual(f.severity, 'critical');
  assert.ok(f.messageHe.indexOf('79 חודשים') >= 0, 'the tenure in months is stated');
});

test('R07 does NOT fire below the tashlumim floor', () => {
  const res = run({ rows: [cleanRow({ tagmulim: 0, pitzuim: 0, tashlumim: 1499, bituach: 60 })] });
  assert.ok(!fired(res, 'R07'));
});

test('R07 does NOT fire at or below 6 months of tenure', () => {
  // Exactly 6 months: the rule wants MORE than 6.
  const six = run({
    rows: [cleanRow({ tagmulim: 0, pitzuim: 0, tashlumim: 5000, bituach: 250 })],
    workers: [Object.assign({}, WORKER, { startDate: '2026-02-01' })],
  });
  assert.ok(!fired(six, 'R07'), 'exactly six months is not yet a liability');
  const seven = run({
    rows: [cleanRow({ tagmulim: 0, pitzuim: 0, tashlumim: 5000, bituach: 250 })],
    workers: [Object.assign({}, WORKER, { startDate: '2026-01-01' })],
  });
  assert.ok(fired(seven, 'R07'), 'seven months is');
});

test('R07 does NOT fire when there IS employer pension — either component counts', () => {
  assert.ok(!fired(run({ rows: [cleanRow({ pitzuim: 0 })] }), 'R07'), 'תגמולים alone is pension');
  assert.ok(!fired(run({ rows: [cleanRow({ tagmulim: 0 })] }), 'R07'), 'פיצויים alone is pension');
});

test('R07: קרן השתלמות is NOT pension and never satisfies the rule', () => {
  const res = run({ rows: [cleanRow({ tagmulim: 0, pitzuim: 0, tashlumim: 5000, keren: 400, bituach: 250 })] });
  assert.ok(fired(res, 'R07'), 'a study fund does not discharge a pension obligation');
});

// ---------------------------------------------------------------------------
// R08 — start_date missing, so pension compliance cannot be evaluated
// ---------------------------------------------------------------------------

test('R08 fires when the staffing start date is missing', () => {
  const res = run({ workers: [Object.assign({}, WORKER, { startDate: '' })] });
  assert.ok(fired(res, 'R08'));
  assert.strictEqual(res.findings.find(x => x.ruleId === 'R08').severity, 'warning');
});

test('R08 REPLACES R07 when the start date is missing — never both', () => {
  const res = run({
    rows: [cleanRow({ tagmulim: 0, pitzuim: 0, tashlumim: 5000, bituach: 250 })],
    workers: [Object.assign({}, WORKER, { startDate: '' })],
  });
  assert.ok(fired(res, 'R08'));
  assert.ok(!fired(res, 'R07'), 'a pension finding is never asserted on an unknown tenure');
  assert.strictEqual(res.findings.filter(f => f.ruleId === 'R08').length, 1, 'and only once');
});

test('R08 does NOT fire when the start date is present', () => {
  assert.ok(!fired(run(), 'R08'));
});

// ---------------------------------------------------------------------------
// R09 / R10 / R11 — the pension split
// ---------------------------------------------------------------------------

test('R09 fires above 7.5 percent of tashlumim, and not at the ceiling', () => {
  const over = run({ rows: [cleanRow({ tashlumim: 10000, tagmulim: 800, pitzuim: 738.46 })] });
  assert.ok(fired(over, 'R09'));
  assert.strictEqual(over.findings.find(f => f.ruleId === 'R09').actual, '8 אחוז');
  const at = run({ rows: [cleanRow({ tashlumim: 10000, tagmulim: 750, pitzuim: 692.31 })] });
  assert.ok(!fired(at, 'R09'), 'exactly 7.5 percent is within the ceiling');
});

test('R10 fires above 9 percent of tashlumim, and not at the ceiling', () => {
  const over = run({ rows: [cleanRow({ tashlumim: 10000, tagmulim: 780.2, pitzuim: 1000 })] });
  assert.ok(fired(over, 'R10'));
  const at = run({ rows: [cleanRow({ tashlumim: 10000, tagmulim: 702.28, pitzuim: 900 })] });
  assert.ok(!fired(at, 'R10'), 'exactly 9 percent is within the ceiling');
});

test('R11 accepts both legal splits and rejects anything else', () => {
  // 6 / 6.5
  assert.ok(!fired(run({ rows: [cleanRow({ tashlumim: 10000, tagmulim: 650, pitzuim: 600 })] }), 'R11'));
  // 8.33 / 6.5
  assert.ok(!fired(run({ rows: [cleanRow({ tashlumim: 10000, tagmulim: 650, pitzuim: 833 })] }), 'R11'));
  // Neither.
  const bad = run({ rows: [cleanRow({ tashlumim: 10000, tagmulim: 650, pitzuim: 715 })] });
  assert.ok(fired(bad, 'R11'));
  assert.strictEqual(bad.findings.find(f => f.ruleId === 'R11').severity, 'warning');
});

test('R11 tolerates 1 percent of drift on either legal ratio', () => {
  const inside = 650 * (6 / 6.5) * 1.009;
  assert.ok(!fired(run({ rows: [cleanRow({ tagmulim: 650, pitzuim: Math.round(inside * 100) / 100 })] }), 'R11'));
  const outside = 650 * (6 / 6.5) * 1.05;
  assert.ok(fired(run({ rows: [cleanRow({ tagmulim: 650, pitzuim: Math.round(outside * 100) / 100 })] }), 'R11'));
});

test('R11 fires on פיצויים with no תגמולים, and stays silent when there is no pension at all', () => {
  assert.ok(fired(run({ rows: [cleanRow({ tagmulim: 0, pitzuim: 600 })] }), 'R11'));
  const none = run({ rows: [cleanRow({ tagmulim: 0, pitzuim: 0, tashlumim: 1000, bituach: 50 })] });
  assert.ok(!fired(none, 'R11'), 'no pension at all is R07 territory, not a ratio problem');
});

test('R09 / R10 stay silent when there is no salary to take a percentage of', () => {
  const res = run({ rows: [cleanRow({ tashlumim: 0, tagmulim: 1872, pitzuim: 1728, bituach: 162.08 })] });
  assert.ok(!fired(res, 'R09'));
  assert.ok(!fired(res, 'R10'));
  assert.ok(fired(res, 'R06'), 'R06 is the finding that matters on such a row');
});

// ---------------------------------------------------------------------------
// R12 / R13 — employer national insurance
// ---------------------------------------------------------------------------

test('R12 fires below 3 percent when tashlumim is over 1000', () => {
  const res = run({ rows: [cleanRow({ tashlumim: 5392.24, tagmulim: 0, pitzuim: 0, bituach: 33.06 })] });
  assert.ok(fired(res, 'R12'));
  assert.strictEqual(res.findings.find(f => f.ruleId === 'R12').actual, '0.61 אחוז');
});

test('R12 does NOT fire at or above 3 percent, nor at or below 1000 of tashlumim', () => {
  assert.ok(!fired(run({ rows: [cleanRow({ tashlumim: 10000, bituach: 300 })] }), 'R12'));
  const low = run({ rows: [cleanRow({ tashlumim: 1000, tagmulim: 0, pitzuim: 0, bituach: 0 })] });
  assert.ok(!fired(low, 'R12'), 'the floor is meaningless on a tiny salary');
});

test('R13 fires above 7.9 percent, and not at the ceiling', () => {
  const over = run({ rows: [cleanRow({ tashlumim: 28000, tagmulim: 894.99, pitzuim: 826.14, bituach: 2252.07 })] });
  assert.ok(fired(over, 'R13'));
  assert.strictEqual(over.findings.find(f => f.ruleId === 'R13').actual, '8.04 אחוז');
  const at = run({ rows: [cleanRow({ tashlumim: 10000, bituach: 790 })] });
  assert.ok(!fired(at, 'R13'), 'exactly 7.9 percent is within the ceiling');
});

// ---------------------------------------------------------------------------
// R14 — tashlumim below 1000
// ---------------------------------------------------------------------------

test('R14 fires below 1000 of tashlumim', () => {
  const res = run({ rows: [cleanRow({ tashlumim: 538.88, tagmulim: 0, pitzuim: 0, bituach: 24.31 })] });
  assert.ok(fired(res, 'R14'));
  assert.strictEqual(res.findings.find(f => f.ruleId === 'R14').actual, '538.88');
});

test('R14 does NOT fire at 1000 or above, nor on a row with no salary at all', () => {
  assert.ok(!fired(run({ rows: [cleanRow({ tashlumim: 1000, tagmulim: 65, pitzuim: 60, bituach: 45 })] }), 'R14'));
  const zero = run({ rows: [cleanRow({ tashlumim: 0, tagmulim: 1872, pitzuim: 1728, bituach: 162.08 })] });
  assert.ok(!fired(zero, 'R14'), 'that is R06, not a low salary');
});

// ---------------------------------------------------------------------------
// R15 — month-over-month cost swing
// ---------------------------------------------------------------------------

test('R15 fires above a 15 percent swing in either direction', () => {
  const base = run().lines[0].total;
  const up = run({ previousTotals: { 33: base / 1.2 } });
  assert.ok(fired(up, 'R15'));
  const down = run({ previousTotals: { 33: base * 1.2 } });
  assert.ok(fired(down, 'R15'), 'a sharp DROP is just as interesting as a rise');
});

test('R15 does NOT fire within 15 percent, nor without a previous month', () => {
  const base = run().lines[0].total;
  assert.ok(!fired(run({ previousTotals: { 33: base * 1.1 } }), 'R15'));
  assert.ok(!fired(run({ previousTotals: { 33: base } }), 'R15'));
  assert.ok(!fired(run({ previousTotals: {} }), 'R15'), 'a first import has nothing to compare to');
  assert.ok(!fired(run({ previousTotals: { 33: 0 } }), 'R15'), 'a zero baseline is not a percentage');
});

// ---------------------------------------------------------------------------
// R16 — department mapping
// ---------------------------------------------------------------------------

test('R16 fires on a department that is not in DEPT_TO_HOUSE at all', () => {
  const res = run({ rows: [cleanRow({ dept: '099', deptName: 'מחלקה חדשה' })] });
  assert.ok(fired(res, 'R16'));
  const f = res.findings.find(x => x.ruleId === 'R16');
  assert.ok(f.messageHe.indexOf('099') >= 0);
  assert.ok(f.messageHe.indexOf('אינה מופיעה') >= 0);
  assert.strictEqual(res.lines[0].mappedHouse, null);
});

test('R16 fires on the two departments whose house is not yet confirmed', () => {
  ['002', '006'].forEach((dept) => {
    const res = run({ rows: [cleanRow({ dept })] });
    assert.ok(fired(res, 'R16'), `department ${dept} must raise a finding`);
    const f = res.findings.find(x => x.ruleId === 'R16');
    assert.ok(f.messageHe.indexOf('טרם אושר') >= 0, 'and say the mapping is unconfirmed');
    assert.strictEqual(res.lines[0].mappedHouse, null, 'and never guess a house');
  });
});

test('R16 does NOT fire on a confirmed department', () => {
  ['001', '003', '004', '005'].forEach((dept) => {
    assert.ok(!fired(run({ rows: [cleanRow({ dept })] }), 'R16'), `department ${dept} is mapped`);
  });
});

// ---------------------------------------------------------------------------
// R17 — row arithmetic
// ---------------------------------------------------------------------------

test('R17 fires when the components do not sum to the stated total', () => {
  const res = run({ rows: [cleanRow({ total: 11760 })] });
  assert.ok(fired(res, 'R17'));
  const f = res.findings.find(x => x.ruleId === 'R17');
  assert.strictEqual(f.severity, 'critical');
  assert.strictEqual(f.expected, '11760.00');
  assert.strictEqual(f.actual, '11750.00');
});

test('R17 tolerates a one-agora rounding difference and no more', () => {
  const exact = 11750;
  assert.ok(!fired(run({ rows: [cleanRow({ total: exact + 0.01 })] }), 'R17'));
  assert.ok(fired(run({ rows: [cleanRow({ total: exact + 0.02 })] }), 'R17'));
});

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

test('matching prefers the employee number over any name', () => {
  const m = R.matchWorker({ empNumber: '33', rawName: 'שם שגוי לגמרי' }, [
    { id: 'w1', name: 'רובין סופיה חן', payrollEmpNumber: '0033' },
    { id: 'w2', name: 'שם שגוי לגמרי', payrollEmpNumber: '' },
  ]);
  assert.deepStrictEqual(m, { workerId: 'w1', matchStatus: 'number' },
    'a bound number beats a name every time, leading zeros and all');
});

test('matching falls back to an EXACT full name, then a normalized one', () => {
  assert.deepStrictEqual(
    R.matchWorker({ empNumber: '99', rawName: 'דנדקר עינת יבגניה' },
      [{ id: 'w1', name: 'דנדקר עינת יבגניה', payrollEmpNumber: '' }]),
    { workerId: 'w1', matchStatus: 'exact' });
  assert.deepStrictEqual(
    R.matchWorker({ empNumber: '99', rawName: 'בן  ארי  נויה' },
      [{ id: 'w1', name: 'בן ארי נויה', payrollEmpNumber: '' }]),
    { workerId: 'w1', matchStatus: 'normalized' }, 'double spaces are collapsed');
  assert.deepStrictEqual(
    R.matchWorker({ empNumber: '99', rawName: 'דוד בן־גוריון' },
      [{ id: 'w1', name: 'דוד בן גוריון', payrollEmpNumber: '' }]),
    { workerId: 'w1', matchStatus: 'normalized' }, 'the Hebrew maqaf is punctuation');
});

test('matching NEVER fuzzy-matches a near miss into a payment decision', () => {
  assert.deepStrictEqual(
    R.matchWorker({ empNumber: '99', rawName: 'רובין סופי' },
      [{ id: 'w1', name: 'רובין סופיה חן', payrollEmpNumber: '' }]),
    { workerId: '', matchStatus: 'unmatched' }, 'a prefix is not a match');
});

test('a number bound to two workers is ambiguous, never the first hit', () => {
  assert.deepStrictEqual(
    R.matchWorker({ empNumber: '33', rawName: 'רובין סופיה חן' }, [
      { id: 'w1', name: 'רובין סופיה חן', payrollEmpNumber: '33' },
      { id: 'w2', name: 'מישהו אחר', payrollEmpNumber: '0033' },
    ]),
    { workerId: '', matchStatus: 'ambiguous' });
});

test('tenureMonths counts whole months and refuses to guess', () => {
  assert.strictEqual(R.tenureMonths('2026-02-01', '2026-08'), 6);
  assert.strictEqual(R.tenureMonths('2026-01-01', '2026-08'), 7);
  assert.strictEqual(R.tenureMonths('2026-02-15', '2026-08'), 5, 'a mid-month start has not completed month six');
  assert.strictEqual(R.tenureMonths('', '2026-08'), null);
  assert.strictEqual(R.tenureMonths('2026-02-01', ''), null);
});

// ---------------------------------------------------------------------------
// Summary counters
// ---------------------------------------------------------------------------

test('summarize counts each LINE once, at its worst severity', () => {
  const lines = [{ lineId: 'a' }, { lineId: 'b' }, { lineId: 'c' }];
  const findings = [
    { lineId: 'a', severity: 'warning' },
    { lineId: 'a', severity: 'critical' },
    { lineId: 'b', severity: 'warning' },
    { lineId: '', severity: 'critical' },
  ];
  assert.deepStrictEqual(R.summarize(lines, findings), {
    total: 3, clean: 1, warning: 1, critical: 1, findings: 4, orphanFindings: 1,
  });
});

// ---------------------------------------------------------------------------
// The real August 2026 file
// ---------------------------------------------------------------------------

test('the real file: every line is built, and the totals survive the rules', () => {
  const res = R.evaluateRun({ month: MONTH, runId: 'pr_aug', rows: golden.rows, workers: [] });
  assert.strictEqual(res.lines.length, 93);
  const sum = Math.round(res.lines.reduce((a, l) => a + l.total, 0) * 100) / 100;
  assert.strictEqual(sum, 1107895.88);
  const uniqueLineIds = new Set(res.lines.map(l => l.lineId));
  assert.strictEqual(uniqueLineIds.size, 93, 'line ids are unique inside a run');
});

test('the real file: R17 fires on NOTHING — every printed row adds up', () => {
  const res = R.evaluateRun({ month: MONTH, runId: 'pr_aug', rows: golden.rows, workers: [] });
  assert.ok(!fired(res, 'R17'), 'the bureau\'s own arithmetic is sound');
});

test('the real file: R11 fires on NOTHING — every pension split is legal', () => {
  const res = R.evaluateRun({ month: MONTH, runId: 'pr_aug', rows: golden.rows, workers: [] });
  assert.ok(!fired(res, 'R11'),
    'the two legal ratios describe the real file, which is what makes R11 worth having');
});

test('the real file: R16 flags exactly the 28 lines in the two unconfirmed departments', () => {
  const res = R.evaluateRun({ month: MONTH, runId: 'pr_aug', rows: golden.rows, workers: [] });
  const r16 = res.findings.filter(f => f.ruleId === 'R16');
  assert.strictEqual(r16.length, 28, 'department 002 has 18 lines and 006 has 10');
});

test('the real file: the rules find the anomalies a human would', () => {
  const res = R.evaluateRun({ month: MONTH, runId: 'pr_aug', rows: golden.rows, workers: [] });
  const byLine = {};
  res.lines.forEach(l => { byLine[l.lineId] = l; });
  const names = (ruleId) => res.findings
    .filter(f => f.ruleId === ruleId)
    .map(f => byLine[f.lineId].rawName)
    .sort();
  assert.deepStrictEqual(names('R06'), ['מזור שחר'], 'the one employer-cost-only row');
  assert.deepStrictEqual(names('R13'), ['דדוש אולגה'], 'the one over-ceiling national insurance row');
  assert.deepStrictEqual(names('R09'), ['בוזגלו עידו', 'חן שירן', 'ימין צפי', 'רוזנפלד ירדן']);
  assert.deepStrictEqual(names('R10'), ['בוזגלו עידו', 'חן שירן', 'ימין צפי', 'רוזנפלד ירדן']);
  assert.strictEqual(res.findings.filter(f => f.ruleId === 'R12').length, 5);
  assert.strictEqual(res.findings.filter(f => f.ruleId === 'R14').length, 6);
});

test('the real file with no roster loaded: every line is R01, and nothing crashes', () => {
  const res = R.evaluateRun({ month: MONTH, runId: 'pr_aug', rows: golden.rows, workers: [] });
  assert.strictEqual(res.findings.filter(f => f.ruleId === 'R01').length, 93);
  assert.ok(!fired(res, 'R07'), 'a pension finding is never raised against an unmatched worker');
  assert.ok(!fired(res, 'R08'));
  assert.ok(ids(res).every(id => R.RULE_IDS.indexOf(id) >= 0), 'only catalogued rule ids are emitted');
});
