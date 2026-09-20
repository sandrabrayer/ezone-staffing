'use strict';

// The monthly cost engine — the brief's 20 cases, plus the aggregation and
// budget rules they depend on.
//
// Every case is a fixture, not a production read, so the whole suite runs
// offline and is reproducible.

const { test } = require('node:test');
const assert = require('node:assert');

const E = require('../lib/cost-engine');
const { costForMonth } = E;

// ---------- fixture helpers ----------

function worker(id, startDate, over) {
  return Object.assign({ id: id, name: 'עובד ' + id, startDate: startDate }, over || {});
}
function fullTime(id, workerId, house, salary, over) {
  return Object.assign({
    id: id, workerId: workerId, house: house, role: 'מדריך/ה',
    employmentType: 'full_time', salary: salary, status: 'active',
    createdAt: '2020-01-01T00:00:00.000Z',
  }, over || {});
}
function archived(assignmentId, workerId, house, salary, terminationDate, over) {
  return Object.assign({
    id: 'arc-' + assignmentId, assignmentId: assignmentId, workerId: workerId,
    house: house, role: 'מדריך/ה', employmentType: 'full_time', salary: salary,
    terminationDate: terminationDate,
  }, over || {});
}
function run(fx, month, extra) {
  return costForMonth(
    fx.workers || [], fx.assignments || [], fx.absences || [],
    fx.coverages || [], fx.budgets || [], month,
    Object.assign({ archive: fx.archive || [], monthlyActuals: fx.actuals || [] }, extra || {}));
}
function lineOf(report, assignmentId) {
  return E.lineForAssignmentId(report, assignmentId);
}

// ============================================================
// 1–4 · the month must actually drive the number
// ============================================================

test('case 1 — a future start costs 0 in an earlier month', () => {
  const fx = {
    workers: [worker('w1', '2026-12-01')],
    assignments: [fullTime('a1', 'w1', 'ramot', 8000)],
  };
  assert.strictEqual(run(fx, '2026-09').totals.projectedTotal, 0);
  assert.strictEqual(lineOf(run(fx, '2026-09'), 'a1').rule, 'NOT_STARTED');
});

test('case 2 — the same worker costs a full month once employment starts', () => {
  const fx = {
    workers: [worker('w1', '2026-12-01')],
    assignments: [fullTime('a1', 'w1', 'ramot', 8000)],
  };
  const dec = run(fx, '2026-12');
  assert.strictEqual(dec.totals.projectedTotal, 8000);
  assert.strictEqual(lineOf(dec, 'a1').daysCounted, 31);
});

test('case 3 — December rolls into January without a year-boundary glitch', () => {
  const fx = {
    workers: [worker('w1', '2026-12-15')],
    assignments: [fullTime('a1', 'w1', 'ramot', 3100)],
  };
  const dec = run(fx, '2026-12');
  const jan = run(fx, '2027-01');
  // 17 of December's 31 days (15th–31st inclusive), then all of January.
  assert.strictEqual(dec.daysInMonth, 31);
  assert.strictEqual(lineOf(dec, 'a1').daysEmployed, 17);
  assert.strictEqual(dec.totals.projectedTotal, Math.round(3100 * 17 / 31));
  assert.strictEqual(jan.daysInMonth, 31);
  assert.strictEqual(jan.totals.projectedTotal, 3100);
});

test('case 4 — February gets its real length, leap year included', () => {
  assert.strictEqual(E.daysInMonth('2026-02'), 28);
  assert.strictEqual(E.daysInMonth('2028-02'), 29);
  const fx = {
    workers: [worker('w1', '2028-02-15')],
    assignments: [fullTime('a1', 'w1', 'ramot', 2900)],
  };
  const feb = run(fx, '2028-02');
  assert.strictEqual(feb.daysInMonth, 29);
  assert.strictEqual(lineOf(feb, 'a1').daysEmployed, 15);   // 15th–29th
});

// ============================================================
// 5–8 · starts, ends and transfers
// ============================================================

test('case 5 — a mid-month start is prorated by calendar days', () => {
  const fx = {
    workers: [worker('w1', '2026-09-16')],
    assignments: [fullTime('a1', 'w1', 'ramot', 3000)],
  };
  const sep = run(fx, '2026-09');
  const l = lineOf(sep, 'a1');
  assert.strictEqual(l.daysEmployed, 15);           // 16th–30th
  assert.strictEqual(l.cost, Math.round(3000 * 15 / 30));
  assert.match(l.rule, /_PRORATED$/);
});

test('case 6 — a mid-month termination is prorated, and the next month is 0', () => {
  const fx = {
    workers: [worker('w1', '2020-01-01')],
    assignments: [],
    archive: [archived('a1', 'w1', 'ramot', 3000, '2026-09-10')],
  };
  const sep = run(fx, '2026-09');
  assert.strictEqual(lineOf(sep, 'a1').daysEmployed, 10);
  assert.strictEqual(sep.totals.projectedTotal, Math.round(3000 * 10 / 30));
  const oct = run(fx, '2026-10');
  assert.strictEqual(oct.totals.projectedTotal, 0);
  assert.strictEqual(lineOf(oct, 'a1').rule, 'ENDED_BEFORE_MONTH');
});

test('case 7 — a FUTURE termination keeps costing until that date', () => {
  const fx = {
    workers: [worker('w1', '2020-01-01')],
    assignments: [],
    archive: [archived('a1', 'w1', 'ramot', 3000, '2026-11-20')],
  };
  assert.strictEqual(run(fx, '2026-09').totals.projectedTotal, 3000, 'full month before the notice period ends');
  assert.strictEqual(run(fx, '2026-10').totals.projectedTotal, 3000);
  assert.strictEqual(run(fx, '2026-11').totals.projectedTotal, Math.round(3000 * 20 / 30));
  assert.strictEqual(run(fx, '2026-12').totals.projectedTotal, 0);
});

test('case 8 — a mid-month transfer costs ONE month across the two houses', () => {
  // Same worker, same terms: ends at ramot on the 14th, starts at asher on
  // the 15th. The month must total one salary, split by days.
  const fx = {
    workers: [worker('w1', '2020-01-01')],
    assignments: [fullTime('a2', 'w1', 'asher', 3000, { createdAt: '2026-09-15T08:00:00.000Z' })],
    archive: [archived('a1', 'w1', 'ramot', 3000, '2026-09-14')],
  };
  const sep = run(fx, '2026-09');
  const ramot = lineOf(sep, 'a1');
  const asher = lineOf(sep, 'a2');
  assert.strictEqual(ramot.daysEmployed, 14);
  assert.strictEqual(asher.daysEmployed, 16);
  assert.strictEqual(ramot.daysEmployed + asher.daysEmployed, sep.daysInMonth,
    'the two halves must tile the month exactly — no gap, no overlap');
  assert.strictEqual(sep.totals.projectedTotal, 3000, 'one month of salary, not two');
  assert.strictEqual(sep.byHouse.ramot.projectedTotal, Math.round(3000 * 14 / 30));
  assert.strictEqual(sep.byHouse.asher.projectedTotal, Math.round(3000 * 16 / 30));
});

test('case 9 — a genuine second house is TWO placements, counted twice', () => {
  // The opposite of a transfer: one person working at two houses, both
  // live all month. Each row carries its own terms and both are charged.
  const fx = {
    workers: [worker('w1', '2020-01-01')],
    assignments: [
      fullTime('a1', 'w1', 'ramot', 3000),
      fullTime('a2', 'w1', 'asher', 2000),
    ],
  };
  const sep = run(fx, '2026-09');
  assert.strictEqual(sep.totals.projectedTotal, 5000);
});

// ============================================================
// 10–13 · leave and absence
// ============================================================

test('case 10 — חל"ד zeroes the month, and it is a CONFIRMED zero', () => {
  const fx = {
    workers: [worker('w1', '2020-01-01')],
    assignments: [fullTime('a1', 'w1', 'ramot', 3000, { status: 'chld' })],
  };
  const sep = run(fx, '2026-09');
  const l = lineOf(sep, 'a1');
  assert.strictEqual(l.cost, 0);
  assert.strictEqual(l.rule, 'UNPAID_STATUS');
  assert.strictEqual(l.source, 'actual', 'a known zero is not an estimate');
  assert.strictEqual(sep.totals.estimated, 0);
  assert.strictEqual(E.CHLD_PAID_BY_EMPLOYER, false);
});

test('case 11 — חל"ת and גמ"ח zero the month too', () => {
  const fx = {
    workers: [worker('w1', '2020-01-01'), worker('w2', '2020-01-01')],
    assignments: [
      fullTime('a1', 'w1', 'ramot', 3000, { status: 'chlt' }),
      fullTime('a2', 'w2', 'ramot', 4000, { status: 'final_settlement' }),
    ],
  };
  assert.strictEqual(run(fx, '2026-09').totals.projectedTotal, 0);
});

test('case 12 — an unknown status falls back to active and is paid', () => {
  const fx = {
    workers: [worker('w1', '2020-01-01')],
    assignments: [fullTime('a1', 'w1', 'ramot', 3000, { status: 'nonsense' })],
  };
  assert.strictEqual(run(fx, '2026-09').totals.projectedTotal, 3000);
});

test('case 13 — a logged absence does NOT reduce cost, but is reported', () => {
  const fx = {
    workers: [worker('w1', '2020-01-01')],
    assignments: [fullTime('a1', 'w1', 'ramot', 3000)],
    absences: [{ id: 'ab1', workerId: 'w1', house: 'ramot',
      startDate: '2026-09-05', endDate: '2026-09-14', reasonType: 'מחלה' }],
  };
  const sep = run(fx, '2026-09');
  assert.strictEqual(sep.totals.projectedTotal, 3000);
  assert.strictEqual(lineOf(sep, 'a1').absenceDays, 10);
  assert.strictEqual(E.ABSENCE_REDUCES_COST, false);
});

// ============================================================
// 14–17 · actual vs estimate, per employment type
// ============================================================

function hourly(id, workerId, house, rate, estHours) {
  return {
    id: id, workerId: workerId, house: house, role: 'מדריך/ה',
    employmentType: 'hourly', hourlyRate: rate, estHours: estHours,
    status: 'active', createdAt: '2020-01-01T00:00:00.000Z',
  };
}

test('case 14 — hourly with recorded actuals is CONFIRMED and month-specific', () => {
  const fx = {
    workers: [worker('w1', '2020-01-01')],
    assignments: [hourly('a1', 'w1', 'ramot', 60, 100)],
    actuals: [
      { id: 'm1', assignmentId: 'a1', month: '2026-08', actualHours: 120 },
      { id: 'm2', assignmentId: 'a1', month: '2026-09', actualHours: 80 },
    ],
  };
  const aug = run(fx, '2026-08');
  const sep = run(fx, '2026-09');
  const oct = run(fx, '2026-10');
  assert.strictEqual(aug.totals.projectedTotal, 7200);
  assert.strictEqual(aug.totals.actualConfirmed, 7200);
  assert.strictEqual(sep.totals.projectedTotal, 4800);
  assert.strictEqual(oct.totals.projectedTotal, 6000, 'no actuals for October — the estimate');
  assert.strictEqual(oct.totals.estimated, 6000);
  assert.strictEqual(oct.totals.actualConfirmed, 0);
  assert.strictEqual(lineOf(oct, 'a1').rule, 'HOURLY_ESTIMATE');
});

test('case 15 — a recorded ZERO is a confirmed zero, not a fallback to the estimate', () => {
  const fx = {
    workers: [worker('w1', '2020-01-01')],
    assignments: [hourly('a1', 'w1', 'ramot', 60, 100)],
    actuals: [{ id: 'm1', assignmentId: 'a1', month: '2026-09', actualHours: 0 }],
  };
  const sep = run(fx, '2026-09');
  assert.strictEqual(sep.totals.projectedTotal, 0);
  assert.strictEqual(lineOf(sep, 'a1').rule, 'HOURLY_ACTUAL');
  assert.strictEqual(sep.totals.estimated, 0);
});

test('case 16 — per_session prices the three products, and actuals cover individual only', () => {
  const a = {
    id: 'a1', workerId: 'w1', house: 'pardes', role: 'מטפל/ת',
    employmentType: 'per_session', status: 'active',
    createdAt: '2020-01-01T00:00:00.000Z',
    rateIndividual: 300, sessionsIndividual: 10,
    rateGroup: 500, sessionsGroup: 2,
    rateExternal: 400, externalPatients: 1,
  };
  const fx = { workers: [worker('w1', '2020-01-01')], assignments: [a] };
  const est = run(fx, '2026-09');
  assert.strictEqual(est.totals.projectedTotal, 300 * 10 + 500 * 2 + 400 * 1);
  assert.strictEqual(est.totals.estimated, est.totals.projectedTotal);

  const withActuals = run(
    Object.assign({}, fx, { actuals: [{ id: 'm1', assignmentId: 'a1', month: '2026-09', actualSessions: 4 }] }),
    '2026-09');
  assert.strictEqual(withActuals.totals.projectedTotal, 300 * 4 + 500 * 2 + 400 * 1);
  assert.strictEqual(lineOf(withActuals, 'a1').rule, 'PER_SESSION_ACTUAL');
});

test('case 17 — part_time, fixed_retainer and the allowance whitelist', () => {
  const fx = {
    workers: [worker('w1', '2020-01-01'), worker('w2', '2020-01-01'), worker('w3', '2020-01-01')],
    assignments: [
      { id: 'a1', workerId: 'w1', house: 'ramot', role: 'רכז/ת', employmentType: 'part_time',
        salary: 10000, pct: 60, status: 'active', createdAt: '2020-01-01T00:00:00.000Z' },
      { id: 'a2', workerId: 'w2', house: 'ramot', role: 'מנהל/ת', employmentType: 'fixed_retainer',
        retainerAmount: 7500, status: 'active', createdAt: '2020-01-01T00:00:00.000Z' },
      fullTime('a3', 'w3', 'ramot', 9000, { allowance: 2000 }),
    ],
  };
  const sep = run(fx, '2026-09');
  // pct is an informational label, NOT a multiplier: the salary field is the
  // amount actually paid for this placement. Mirrors lib/calc.js.
  assert.strictEqual(lineOf(sep, 'a1').cost, 10000);
  assert.match(lineOf(sep, 'a1').basis, /60% role/);
  assert.strictEqual(lineOf(sep, 'a2').cost, 7500);
  assert.strictEqual(lineOf(sep, 'a3').cost, 11000, 'salary plus a whitelisted allowance');

  // An allowance outside the whitelist is ignored, never charged.
  const bad = run({ workers: [worker('w1', '2020-01-01')],
    assignments: [fullTime('a1', 'w1', 'ramot', 9000, { allowance: 4321 })] }, '2026-09');
  assert.strictEqual(lineOf(bad, 'a1').cost, 9000);
});

// ============================================================
// 18–20 · coverages, budgets, and what the totals include
// ============================================================

test('case 18 — a coverage is charged ONCE, to the receiving house', () => {
  const fx = {
    workers: [worker('w1', '2020-01-01')],
    assignments: [fullTime('a1', 'w1', 'asher', 3000)],
    coverages: [{ id: 'c1', coveringWorkerId: 'w1', coveringHouse: 'asher',
      receivingHouse: 'ramot', startDate: '2026-09-05', endDate: '2026-09-12',
      extraPayment: 800 }],
  };
  const sep = run(fx, '2026-09');
  assert.strictEqual(sep.totals.projectedTotal, 3800);
  assert.strictEqual(sep.byHouse.ramot.projectedTotal, 800, 'the extra goes where the help went');
  assert.strictEqual(sep.byHouse.asher.projectedTotal, 3000, 'the covering house keeps paying only its own worker');

  // Outside the month it is not charged at all.
  const oct = run(fx, '2026-10');
  assert.strictEqual(oct.totals.projectedTotal, 3000);
  assert.strictEqual(oct.lines.find(l => l.kind === 'coverage').rule, 'COVERAGE_OUT_OF_MONTH');
});

test('case 19 — the selected month drives the budget: month override, then default, then none', () => {
  const budgets = [
    { id: 'b1', house: 'ramot', month: 'default', amount: 100000, instructorsAmount: 40000 },
    { id: 'b2', house: 'ramot', month: '2026-09', amount: 120000, instructorsAmount: '' },
    { id: 'b3', house: 'asher', month: '2026-09', amount: 50000 },
  ];
  const fx = { workers: [worker('w1', '2020-01-01')],
    assignments: [fullTime('a1', 'w1', 'ramot', 3000)], budgets: budgets };

  assert.strictEqual(run(fx, '2026-09').byHouse.ramot.budget, 120000, 'the month override wins');
  assert.strictEqual(run(fx, '2026-10').byHouse.ramot.budget, 100000, 'and falls back to default');
  assert.strictEqual(run(fx, '2026-09').byHouse.ramot.instructorsBudget, 40000,
    'a blank instructors line on the month row falls through to the default');
  assert.strictEqual(run(fx, '2026-10').byHouse.asher.budget, null,
    'no month row and no default means NO budget, not zero');
  assert.strictEqual(run(fx, '2026-10').byHouse.asher.variance.status, 'none');

  // A house with a budget but no cost this month still reports its budget.
  const empty = run({ budgets: budgets }, '2026-09');
  assert.strictEqual(empty.byHouse.asher.budget, 50000);
  assert.strictEqual(empty.byHouse.asher.projectedTotal, 0);
});

test('case 20 — the instructors line is a SUBSET of the house total, never an addend', () => {
  const fx = {
    workers: [worker('w1', '2020-01-01'), worker('w2', '2020-01-01')],
    assignments: [
      fullTime('a1', 'w1', 'ramot', 3000),                              // מדריך/ה
      fullTime('a2', 'w2', 'ramot', 5000, { role: 'מנהל/ת' }),          // not
    ],
    budgets: [{ id: 'b1', house: 'ramot', month: 'default', amount: 10000, instructorsAmount: 4000 }],
  };
  const sep = run(fx, '2026-09');
  assert.strictEqual(sep.byHouse.ramot.projectedTotal, 8000, 'the house total is every role at the house');
  assert.strictEqual(sep.byHouse.ramot.instructorsCost, 3000, 'the instructors line counts only מדריך/ה');
  assert.ok(sep.byHouse.ramot.instructorsCost < sep.byHouse.ramot.projectedTotal,
    'instructors must be a subset — if it were ever added on top the house total would be 11000');
  assert.strictEqual(sep.totals.projectedTotal, 8000,
    'the network total must equal the house total, with no instructors double count');
});

// ============================================================
// data quality, aggregation and the alternative rule settings
// ============================================================

test('a missing rate produces a zero that is flagged, not a silent zero', () => {
  const fx = {
    workers: [worker('w1', '2020-01-01')],
    assignments: [fullTime('a1', 'w1', 'ramot', 0)],
  };
  const sep = run(fx, '2026-09');
  const l = lineOf(sep, 'a1');
  assert.strictEqual(l.cost, 0);
  assert.deepStrictEqual(l.missingData, ['salary']);
  assert.strictEqual(l.source, 'none');
  assert.strictEqual(sep.totals.missingData, 1);
  assert.strictEqual(sep.totals.actualConfirmed, 0);
  assert.strictEqual(sep.totals.estimated, 0);
});

test('a missing start date is flagged but still priced — never guessed at', () => {
  const fx = {
    workers: [worker('w1', '')],
    assignments: [fullTime('a1', 'w1', 'ramot', 3000)],
  };
  const sep = run(fx, '2026-09');
  const l = lineOf(sep, 'a1');
  assert.strictEqual(l.cost, 3000, 'a wrong start date is worse than a missing one');
  assert.ok(l.missingData.includes('startDate'));
  assert.strictEqual(sep.totals.missingData, 1);
});

// ============================================================
// the missing-data bucket · a blank start date is counted, never trusted
// ============================================================

test('a missing start date sends the cost to the missing-data bucket, not to confirmed', () => {
  const fx = {
    workers: [worker('w1', ''), worker('w2', '2020-01-01')],
    assignments: [fullTime('a1', 'w1', 'ramot', 3000), fullTime('a2', 'w2', 'ramot', 5000)],
    actuals: [{ id: 'm1', assignmentId: 'a2', month: '2026-09', actualHours: 1 }],
  };
  const sep = run(fx, '2026-09');
  const l = lineOf(sep, 'a1');

  assert.strictEqual(l.missingStartDate, true, 'the line is tagged');
  assert.strictEqual(l.bucket, 'missing');
  assert.strictEqual(l.cost, 3000, 'the worker is still counted — the total does not move');

  assert.strictEqual(sep.totals.projectedTotal, 8000);
  assert.strictEqual(sep.totals.missingDataCost, 3000, 'its money sits in the missing bucket');
  assert.strictEqual(sep.totals.actualConfirmed, 5000, 'and NOT in confirmed');
  assert.strictEqual(sep.totals.estimated, 0, 'and NOT in estimated');
  assert.strictEqual(sep.byHouse.ramot.missingDataCost, 3000, 'per house too');
});

test('a worker WITH a start date is never tagged', () => {
  const fx = {
    workers: [worker('w1', '2020-01-01')],
    assignments: [fullTime('a1', 'w1', 'ramot', 3000)],
    actuals: [{ id: 'm1', assignmentId: 'a1', month: '2026-09', actualHours: 1 }],
  };
  const l = lineOf(run(fx, '2026-09'), 'a1');
  assert.strictEqual(l.missingStartDate, false);
  assert.strictEqual(l.bucket, 'confirmed');
});

test('filling the start date in moves the money out of the missing bucket', () => {
  const assignments = [fullTime('a1', 'w1', 'ramot', 3000)];
  const actuals = [{ id: 'm1', assignmentId: 'a1', month: '2026-09', actualHours: 1 }];
  const before = run({ workers: [worker('w1', '')], assignments, actuals }, '2026-09');
  const after = run({ workers: [worker('w1', '2020-01-01')], assignments, actuals }, '2026-09');

  assert.strictEqual(before.totals.missingDataCost, 3000);
  assert.strictEqual(after.totals.missingDataCost, 0);
  assert.strictEqual(after.totals.actualConfirmed, 3000);
  assert.strictEqual(before.totals.projectedTotal, after.totals.projectedTotal,
    'the bill is the same either way — only its honesty changed');
});

test('thirty undated workers are thirty tagged lines, not thirty silent ones', () => {
  const workers = [];
  const assignments = [];
  for (let i = 0; i < 30; i++) {
    workers.push(worker('w' + i, ''));
    assignments.push(fullTime('a' + i, 'w' + i, 'ramot', 1000));
  }
  const sep = run({ workers, assignments }, '2026-09');
  assert.strictEqual(sep.lines.filter(l => l.missingStartDate).length, 30);
  assert.strictEqual(sep.totals.missingDataCost, 30000);
  assert.strictEqual(sep.totals.actualConfirmed, 0);
  assert.strictEqual(sep.totals.missingData, 30, 'the count still counts');
});

// ============================================================
// a month with no recorded actuals at all
// ============================================================

test('a zero-actuals month reports NO confirmed money — the whole figure is an estimate', () => {
  const fx = {
    workers: [worker('w1', '2020-01-01'), worker('w2', '2020-01-01')],
    assignments: [fullTime('a1', 'w1', 'ramot', 3000), hourly('a2', 'w2', 'asher', 60, 100)],
    coverages: [{ id: 'c1', coveringWorkerId: 'w1', coveringHouse: 'ramot',
      receivingHouse: 'asher', startDate: '2026-09-01', endDate: '2026-09-30', extraPayment: 500 }],
    actuals: [],
  };
  const sep = run(fx, '2026-09');
  assert.strictEqual(sep.hasActuals, false, 'the month says so about itself');
  assert.strictEqual(sep.actualsForMonth, 0);
  assert.strictEqual(sep.totals.actualConfirmed, 0, 'confirmed is ₪0, not "the salary"');
  assert.strictEqual(sep.totals.estimated, sep.totals.projectedTotal,
    'the whole figure sits in estimated');
  assert.strictEqual(lineOf(sep, 'a1').bucket, 'estimated',
    'even a contractual salary is a projection while nothing real is recorded');
});

test('one recorded actual is enough to bucket the month line by line again', () => {
  const fx = {
    workers: [worker('w1', '2020-01-01'), worker('w2', '2020-01-01')],
    assignments: [fullTime('a1', 'w1', 'ramot', 3000), hourly('a2', 'w2', 'asher', 60, 100)],
    actuals: [{ id: 'm1', assignmentId: 'a2', month: '2026-09', actualHours: 50 }],
  };
  const sep = run(fx, '2026-09');
  assert.strictEqual(sep.hasActuals, true);
  assert.strictEqual(sep.totals.actualConfirmed, 3000 + 3000);
  assert.strictEqual(sep.totals.estimated, 0);
});

test('hasActuals is per MONTH, not per sheet', () => {
  const fx = {
    workers: [worker('w1', '2020-01-01')],
    assignments: [fullTime('a1', 'w1', 'ramot', 3000)],
    actuals: [{ id: 'm1', assignmentId: 'a1', month: '2026-08', actualHours: 10 }],
  };
  assert.strictEqual(run(fx, '2026-08').hasActuals, true);
  assert.strictEqual(run(fx, '2026-09').hasActuals, false,
    'August having data says nothing about September');
});

test('an assignment that is also archived is counted ONCE', () => {
  const fx = {
    workers: [worker('w1', '2020-01-01')],
    assignments: [fullTime('a1', 'w1', 'ramot', 3000)],
    archive: [archived('a1', 'w1', 'ramot', 3000, '2026-09-20')],
  };
  const sep = run(fx, '2026-09');
  assert.strictEqual(sep.lines.filter(l => l.assignmentId === 'a1').length, 1);
  assert.strictEqual(sep.totals.projectedTotal, Math.round(3000 * 20 / 30),
    'the archive row wins — it is the one carrying the termination date');
});

test('actualConfirmed + estimated + missingDataCost always equals projectedTotal', () => {
  const fx = {
    workers: [worker('w1', '2020-01-01'), worker('w2', '2020-01-01'), worker('w3', '2020-01-01')],
    assignments: [
      fullTime('a1', 'w1', 'ramot', 3000),
      hourly('a2', 'w2', 'asher', 60, 100),
      fullTime('a3', 'w3', 'rehab', 0),
    ],
    actuals: [{ id: 'm1', assignmentId: 'a2', month: '2026-09', actualHours: 50 }],
    coverages: [{ id: 'c1', coveringWorkerId: 'w1', coveringHouse: 'ramot',
      receivingHouse: 'asher', startDate: '2026-09-01', endDate: '2026-09-30', extraPayment: 500 }],
  };
  const sep = run(fx, '2026-09');
  assert.strictEqual(
    sep.totals.actualConfirmed + sep.totals.estimated + sep.totals.missingDataCost,
    sep.totals.projectedTotal, 'the three buckets are exhaustive');
  const houseSum = Object.keys(sep.byHouse)
    .reduce((s, h) => s + sep.byHouse[h].projectedTotal, 0);
  assert.strictEqual(houseSum, sep.totals.projectedTotal, 'the houses must sum to the network');
});

test('PRORATION_METHOD "none" is available and charges the full month', () => {
  const fx = {
    workers: [worker('w1', '2026-09-16')],
    assignments: [fullTime('a1', 'w1', 'ramot', 3000)],
  };
  const prorated = run(fx, '2026-09');
  const whole = run(fx, '2026-09', { prorationMethod: 'none' });
  assert.strictEqual(prorated.totals.projectedTotal, 1500);
  assert.strictEqual(whole.totals.projectedTotal, 3000);
  assert.match(lineOf(whole, 'a1').basis, /charged in full/);
  assert.strictEqual(E.PRORATION_METHOD, 'calendar_days', 'the shipped default');
});

test('LEAVE_PRORATION "from_status_date" is available and pays the days before', () => {
  const fx = {
    workers: [worker('w1', '2020-01-01')],
    assignments: [fullTime('a1', 'w1', 'ramot', 3000, { status: 'chlt', statusDate: '2026-09-11' })],
  };
  assert.strictEqual(run(fx, '2026-09').totals.projectedTotal, 0, 'the shipped default zeroes the month');
  const partial = run(fx, '2026-09', { leaveProration: 'from_status_date' });
  assert.strictEqual(partial.totals.projectedTotal, Math.round(3000 * 10 / 30), 'paid through the 10th');
  assert.strictEqual(E.LEAVE_PRORATION, 'whole_month');
});

test('every line carries a usable trace', () => {
  const fx = {
    workers: [worker('w1', '2020-01-01')],
    assignments: [hourly('a1', 'w1', 'ramot', 60, 100)],
  };
  const l = lineOf(run(fx, '2026-09'), 'a1');
  assert.strictEqual(l.workerId, 'w1');
  assert.strictEqual(l.assignmentId, 'a1');
  assert.strictEqual(l.house, 'ramot');
  assert.strictEqual(l.rule, 'HOURLY_ESTIMATE');
  assert.strictEqual(l.daysCounted, 30);
  assert.strictEqual(l.source, 'estimate');
  assert.match(l.basis, /rate 60 x 100 estimated hours/);
});

test('an unparseable month is rejected rather than silently costed', () => {
  assert.throws(() => costForMonth([], [], [], [], [], '2026-13'), /YYYY-MM/);
  assert.throws(() => costForMonth([], [], [], [], [], ''), /YYYY-MM/);
  assert.throws(() => costForMonth([], [], [], [], [], '2026-09-01'), /YYYY-MM/);
});

test('the rules that are not settled are enumerated for the PR description', () => {
  const ids = E.RULES_TO_CONFIRM.map(r => r.id);
  assert.ok(ids.includes('PRORATION_METHOD'));
  assert.ok(ids.includes('LEAVE_PRORATION'));
  assert.ok(ids.includes('CHLD_PAID_BY_EMPLOYER'));
  assert.ok(ids.includes('ABSENCE_REDUCES_COST'));
  E.RULES_TO_CONFIRM.forEach(r => {
    assert.ok(r.question && r.question.length > 20, r.id + ' needs a real question');
  });
});

// ============================================================
// parity with lib/calc.js
// ============================================================

// The engine replaced lib/calc.js for every cost the UI shows. For a
// placement that is live for the WHOLE month, with no actuals, the two must
// still agree to the shekel — otherwise the fix silently changed somebody's
// pay. This guard caught exactly one real drift while it was being written:
// part_time's `pct` is an informational label, not a multiplier, and an
// engine that scaled by it would have halved every part-time cost.
const calc = require('../lib/calc');

test('parity: for a full month with no actuals the engine matches lib/calc.js', () => {
  const cases = [
    fullTime('a1', 'w1', 'ramot', 12345),
    { id: 'a2', workerId: 'w1', house: 'ramot', role: 'רכז/ת', employmentType: 'part_time',
      salary: 9000, pct: 60, status: 'active', createdAt: '2020-01-01T00:00:00.000Z' },
    { id: 'a3', workerId: 'w1', house: 'ramot', role: 'מנהל/ת', employmentType: 'fixed_retainer',
      retainerAmount: 7500, allowance: 2000, status: 'active', createdAt: '2020-01-01T00:00:00.000Z' },
    hourly('a4', 'w1', 'ramot', 73, 111),
    { id: 'a5', workerId: 'w1', house: 'pardes', role: 'מטפל/ת', employmentType: 'per_session',
      rateIndividual: 310, sessionsIndividual: 9, rateGroup: 480, sessionsGroup: 3,
      rateExternal: 400, externalPatients: 2, allowance: 6000,
      status: 'active', createdAt: '2020-01-01T00:00:00.000Z' },
    // Legacy per_session row predating the 3-rate split.
    { id: 'a6', workerId: 'w1', house: 'pardes', role: 'מטפל/ת', employmentType: 'per_session',
      sessionRate: 250, estSessions: 8, status: 'active', createdAt: '2020-01-01T00:00:00.000Z' },
    // Unpaid statuses must be zero on both sides.
    fullTime('a7', 'w1', 'ramot', 12345, { status: 'chld' }),
    fullTime('a8', 'w1', 'ramot', 12345, { status: 'final_settlement' }),
  ];
  cases.forEach(a => {
    const report = run({ workers: [worker('w1', '2020-01-01')], assignments: [a] }, '2026-09');
    assert.strictEqual(lineOf(report, a.id).cost, calc.assignmentCost(a),
      'engine and lib/calc.js disagree on ' + a.id + ' (' + a.employmentType + ')');
  });
});

test('parity: hourly and per_session with actuals match lib/calc.js monthlyAssignmentCost', () => {
  const cases = [
    [hourly('a1', 'w1', 'ramot', 73, 111), { actualHours: 88 }],
    [hourly('a2', 'w1', 'ramot', 73, 111), { actualHours: 0 }],
    [{ id: 'a3', workerId: 'w1', house: 'pardes', role: 'מטפל/ת', employmentType: 'per_session',
       rateIndividual: 310, sessionsIndividual: 9, rateGroup: 480, sessionsGroup: 3,
       rateExternal: 400, externalPatients: 2,
       status: 'active', createdAt: '2020-01-01T00:00:00.000Z' }, { actualSessions: 5 }],
  ];
  cases.forEach(([a, rec]) => {
    const actual = Object.assign({ id: 'm', assignmentId: a.id, month: '2026-09',
      actualHours: null, actualSessions: null }, rec);
    const report = run({ workers: [worker('w1', '2020-01-01')], assignments: [a], actuals: [actual] }, '2026-09');
    assert.strictEqual(lineOf(report, a.id).cost, calc.monthlyAssignmentCost(a, actual).cost,
      'engine and lib/calc.js disagree on ' + a.id + ' with actuals');
  });
});

// ============================================================
// a payroll-floor start date — a date that is only a floor
// ============================================================

// applyVerifiedFixesNow writes a start date recovered from the payroll book
// and tags it start_date_source = 'payroll_floor'. The engine's job is to
// price the month exactly as it would with any other date, and to make sure
// nothing downstream can present that DATE as confirmed.

const FLOOR = E.START_DATE_SOURCE_PAYROLL_FLOOR;

test('a payroll-floor date prices the month exactly as a known date would', () => {
  const known = run({
    workers: [worker('w1', '2026-01-01')],
    assignments: [fullTime('a1', 'w1', 'ramot', 10000)],
  }, '2026-08');
  const floor = run({
    workers: [worker('w1', '2026-01-01', { startDateSource: FLOOR })],
    assignments: [fullTime('a1', 'w1', 'ramot', 10000)],
  }, '2026-08');
  assert.strictEqual(lineOf(floor, 'a1').cost, lineOf(known, 'a1').cost,
    'the money must not move — only what the page may claim about the date');
  assert.strictEqual(floor.totals.projectedTotal, known.totals.projectedTotal);
});

test('every line it prices is tagged, so the DATE is never reported as confirmed', () => {
  const report = run({
    workers: [worker('w1', '2026-01-01', { startDateSource: FLOOR })],
    assignments: [fullTime('a1', 'w1', 'ramot', 10000)],
  }, '2026-08');
  const line = lineOf(report, 'a1');
  assert.strictEqual(line.startDateEstimated, true);
  assert.strictEqual(line.startDateSource, FLOOR);
  assert.strictEqual(line.missingStartDate, false,
    'a floor is not a missing date: something IS known');
  assert.strictEqual(report.startDateEstimatedLines, 1);
});

test('a date a person entered carries no tag at all', () => {
  const report = run({
    workers: [worker('w1', '2026-01-01')],
    assignments: [fullTime('a1', 'w1', 'ramot', 10000)],
  }, '2026-08');
  const line = lineOf(report, 'a1');
  assert.strictEqual(line.startDateEstimated, false);
  assert.strictEqual(line.startDateSource, '');
  assert.strictEqual(report.startDateEstimatedLines, 0);
});

test('a month BEFORE the floor is counted separately — it may be understating', () => {
  // The floor says June or earlier. April therefore shows 0, and that 0 is
  // the one number a floor can quietly get wrong.
  const report = run({
    workers: [worker('w1', '2026-06-01', { startDateSource: FLOOR })],
    assignments: [fullTime('a1', 'w1', 'ramot', 10000)],
  }, '2026-04');
  const line = lineOf(report, 'a1');
  assert.strictEqual(line.rule, 'NOT_STARTED');
  assert.strictEqual(line.cost, 0);
  assert.strictEqual(report.startDateFloorNotStarted, 1);
});

test('the three buckets still sum with floor-dated lines in the mix', () => {
  const report = run({
    workers: [
      worker('w1', '2026-01-01', { startDateSource: FLOOR }),
      worker('w2', ''),
      worker('w3', '2026-01-01'),
    ],
    assignments: [
      fullTime('a1', 'w1', 'ramot', 10000),
      fullTime('a2', 'w2', 'ramot', 8000),
      fullTime('a3', 'w3', 'asher', 9000),
    ],
    actuals: [{ id: 'm1', assignmentId: 'a3', month: '2026-08', actualHours: 0, actualSessions: 0 }],
  }, '2026-08');
  const t = report.totals;
  assert.strictEqual(t.actualConfirmed + t.estimated + t.missingDataCost, t.projectedTotal);
  assert.strictEqual(lineOf(report, 'a2').bucket, 'missing', 'a BLANK date still goes to missing-data');
  assert.strictEqual(lineOf(report, 'a1').missingStartDate, false, 'a floor does not');
});

test('the floor rule is named, with its alternative, rather than being folklore', () => {
  assert.ok(E.PAYROLL_FLOOR_HANDLINGS.includes(E.PAYROLL_FLOOR_HANDLING));
  assert.ok(E.PAYROLL_FLOOR_HANDLINGS.includes('missing_data'), 'the other choice is documented');
  assert.ok(E.RULES_TO_CONFIRM.some(r => r.id === 'PAYROLL_FLOOR_HANDLING'));
});
