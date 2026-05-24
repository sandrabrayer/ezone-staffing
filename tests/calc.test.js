'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  EMPLOYMENT_TYPES, SALARIED_TYPES, FREELANCER_TYPES,
  assignmentCategory, assignmentCost,
  assignmentsByHouse, houseAssignmentsCost, splitByCategory,
  isAbsenceActive, activeAbsences, openAbsences,
  coveragesForAbsence, activeCoveragesByHouse, coverageExtra,
  pendingTerminations, pendingHouseCost,
  houseTotal, networkTotal,
  assignmentsForWorker, workerTotalCost,
  activeAbsenceForWorker,
} = require('../lib/calc');

const TODAY = '2026-05-20';
const HOUSES = ['ramot', 'asher', 'ofroni', 'rehab'];

// ---------- factories ----------

function asg(over) {
  return Object.assign({
    id: 'a1',
    workerId: 'w1',
    house: 'ramot',
    role: 'אחות',
    roleDetail: '',
    employmentType: 'full_time',
    salary: 18000,
    pct: 0,
    hourlyRate: 0,
    estHours: 0,
    sessionRate: 0,
    estSessions: 0,
    retainerAmount: 0,
    notes: '',
  }, over);
}

function abs(over) {
  return Object.assign({
    id: 'ab1',
    workerId: 'w1',
    house: 'ramot',
    startDate: '2026-05-01',
    endDate: '2026-05-31',
    reasonType: 'מחלה',
    reasonDetail: '',
    notes: '',
    status: 'active',
  }, over);
}

function cov(over) {
  return Object.assign({
    id: 'c1',
    absenceId: 'ab1',
    coveringWorkerId: 'w2',
    providingHouse: 'asher',
    extraPayment: 2000,
    notes: '',
  }, over);
}

function arch(over) {
  return Object.assign({
    id: 'arc1',
    assignmentId: 'a1',
    workerId: 'w1',
    name: 'Test',
    house: 'ramot',
    role: 'אחות',
    employmentType: 'full_time',
    salary: 18000,
    pct: 0,
    hourlyRate: 0,
    estHours: 0,
    sessionRate: 0,
    estSessions: 0,
    retainerAmount: 0,
    terminationDate: '2026-05-20',
    reasonType: '',
    reasonDetail: '',
  }, over);
}

// ---------- employment type constants ----------

test('EMPLOYMENT_TYPES exposes five types in stable order', () => {
  assert.deepEqual(EMPLOYMENT_TYPES, [
    'full_time', 'part_time', 'hourly', 'per_session', 'fixed_retainer',
  ]);
});

test('SALARIED_TYPES vs FREELANCER_TYPES partition the universe', () => {
  const set = SALARIED_TYPES.concat(FREELANCER_TYPES).sort();
  assert.deepEqual(set.sort(), EMPLOYMENT_TYPES.slice().sort());
  // no overlap
  SALARIED_TYPES.forEach(t => assert.equal(FREELANCER_TYPES.indexOf(t), -1));
});

test('assignmentCategory: salaried for full_time/part_time/hourly', () => {
  assert.equal(assignmentCategory(asg({ employmentType: 'full_time' })), 'salaried');
  assert.equal(assignmentCategory(asg({ employmentType: 'part_time' })), 'salaried');
  assert.equal(assignmentCategory(asg({ employmentType: 'hourly' })), 'salaried');
});

test('assignmentCategory: freelancer for per_session/fixed_retainer', () => {
  assert.equal(assignmentCategory(asg({ employmentType: 'per_session' })), 'freelancer');
  assert.equal(assignmentCategory(asg({ employmentType: 'fixed_retainer' })), 'freelancer');
});

test('assignmentCategory: null for unknown / missing', () => {
  assert.equal(assignmentCategory(null), null);
  assert.equal(assignmentCategory(asg({ employmentType: 'mystery' })), null);
});

// ---------- assignmentCost per type ----------

test('assignmentCost: full_time uses salary as-is', () => {
  assert.equal(assignmentCost(asg({ employmentType: 'full_time', salary: 24000 })), 24000);
});

test('assignmentCost: full_time rounds to int', () => {
  assert.equal(assignmentCost(asg({ employmentType: 'full_time', salary: 24000.6 })), 24001);
});

test('assignmentCost: part_time weights salary by pct', () => {
  assert.equal(assignmentCost(asg({ employmentType: 'part_time', salary: 12000, pct: 80 })), 9600);
  // rounding
  assert.equal(assignmentCost(asg({ employmentType: 'part_time', salary: 9999, pct: 75 })), 7499);
});

test('assignmentCost: part_time clamps pct out of range', () => {
  assert.equal(assignmentCost(asg({ employmentType: 'part_time', salary: 10000, pct: 200 })), 10000);
  assert.equal(assignmentCost(asg({ employmentType: 'part_time', salary: 10000, pct: -10 })), 0);
});

test('assignmentCost: hourly multiplies rate × estHours', () => {
  assert.equal(assignmentCost(asg({ employmentType: 'hourly', hourlyRate: 80, estHours: 120 })), 9600);
  assert.equal(assignmentCost(asg({ employmentType: 'hourly', hourlyRate: 75.5, estHours: 100 })), 7550);
});

test('assignmentCost: per_session multiplies rate × estSessions', () => {
  assert.equal(assignmentCost(asg({ employmentType: 'per_session', sessionRate: 300, estSessions: 12 })), 3600);
});

test('assignmentCost: fixed_retainer = retainerAmount', () => {
  assert.equal(assignmentCost(asg({ employmentType: 'fixed_retainer', retainerAmount: 5500 })), 5500);
});

test('assignmentCost: unknown type / null → 0', () => {
  assert.equal(assignmentCost(null), 0);
  assert.equal(assignmentCost(asg({ employmentType: 'mystery' })), 0);
});

test('assignmentCost: negative / NaN values clamp to 0', () => {
  assert.equal(assignmentCost(asg({ employmentType: 'full_time', salary: -100 })), 0);
  assert.equal(assignmentCost(asg({ employmentType: 'hourly', hourlyRate: 'abc', estHours: 10 })), 0);
});

// ---------- house aggregation ----------

test('assignmentsByHouse: filters', () => {
  const list = [
    asg({ id: 'a1', house: 'ramot' }),
    asg({ id: 'a2', house: 'asher' }),
    asg({ id: 'a3', house: 'ramot' }),
  ];
  assert.deepEqual(assignmentsByHouse(list, 'ramot').map(a => a.id), ['a1', 'a3']);
  assert.deepEqual(assignmentsByHouse(list, 'asher').map(a => a.id), ['a2']);
});

test('houseAssignmentsCost: sums per-type costs', () => {
  const list = [
    asg({ house: 'ramot', employmentType: 'full_time', salary: 20000 }),
    asg({ house: 'ramot', employmentType: 'part_time', salary: 10000, pct: 50 }),
    asg({ house: 'ramot', employmentType: 'hourly', hourlyRate: 100, estHours: 80 }),
    asg({ house: 'asher', employmentType: 'full_time', salary: 99999 }),  // wrong house
  ];
  // 20000 + 5000 + 8000 = 33000
  assert.equal(houseAssignmentsCost(list, 'ramot'), 33000);
});

test('houseAssignmentsCost: empty list', () => {
  assert.equal(houseAssignmentsCost([], 'ramot'), 0);
  assert.equal(houseAssignmentsCost(null, 'ramot'), 0);
});

test('splitByCategory: groups salaried vs freelancer', () => {
  const list = [
    asg({ id: 'a1', employmentType: 'full_time' }),
    asg({ id: 'a2', employmentType: 'per_session', sessionRate: 200, estSessions: 10 }),
    asg({ id: 'a3', employmentType: 'hourly', hourlyRate: 80, estHours: 100 }),
    asg({ id: 'a4', employmentType: 'fixed_retainer', retainerAmount: 5000 }),
  ];
  const { salaried, freelancer } = splitByCategory(list);
  assert.deepEqual(salaried.map(a => a.id), ['a1', 'a3']);
  assert.deepEqual(freelancer.map(a => a.id), ['a2', 'a4']);
});

test('splitByCategory: drops items with unknown employmentType', () => {
  const list = [
    asg({ id: 'a1', employmentType: 'mystery' }),
    asg({ id: 'a2', employmentType: 'full_time' }),
  ];
  const { salaried, freelancer } = splitByCategory(list);
  assert.deepEqual(salaried.map(a => a.id), ['a2']);
  assert.deepEqual(freelancer, []);
});

// ---------- absence helpers ----------

test('isAbsenceActive: today inside range', () => {
  assert.equal(isAbsenceActive(abs({ startDate: '2026-05-01', endDate: '2026-05-31' }), TODAY), true);
});

test('isAbsenceActive: today on start or end boundary (inclusive)', () => {
  assert.equal(isAbsenceActive(abs({ startDate: TODAY, endDate: '2026-06-01' }), TODAY), true);
  assert.equal(isAbsenceActive(abs({ startDate: '2026-05-01', endDate: TODAY }), TODAY), true);
});

test('isAbsenceActive: before / after range', () => {
  assert.equal(isAbsenceActive(abs({ startDate: '2026-06-01', endDate: '2026-06-15' }), TODAY), false);
  assert.equal(isAbsenceActive(abs({ startDate: '2026-04-01', endDate: '2026-04-15' }), TODAY), false);
});

test('isAbsenceActive: status="ended" overrides the date window', () => {
  const a = abs({ startDate: '2026-05-01', endDate: TODAY, status: 'ended' });
  assert.equal(isAbsenceActive(a, TODAY), false);
});

test('isAbsenceActive: null / missing → false', () => {
  assert.equal(isAbsenceActive(null, TODAY), false);
});

test('activeAbsences vs openAbsences: today is active+open, future is open-only', () => {
  const list = [
    abs({ id: 'past', startDate: '2026-04-01', endDate: '2026-04-15' }),
    abs({ id: 'now', startDate: '2026-05-15', endDate: '2026-05-25' }),
    abs({ id: 'future', startDate: '2026-06-01', endDate: '2026-06-10' }),
    abs({ id: 'ended', startDate: '2026-05-01', endDate: '2026-05-30', status: 'ended' }),
  ];
  assert.deepEqual(activeAbsences(list, TODAY).map(a => a.id), ['now']);
  assert.deepEqual(openAbsences(list, TODAY).map(a => a.id).sort(), ['future', 'now']);
});

test('coveragesForAbsence: filters by absenceId', () => {
  const coverages = [
    cov({ id: 'c1', absenceId: 'ab1' }),
    cov({ id: 'c2', absenceId: 'ab2' }),
    cov({ id: 'c3', absenceId: 'ab1' }),
  ];
  assert.deepEqual(coveragesForAbsence(coverages, 'ab1').map(c => c.id), ['c1', 'c3']);
  assert.deepEqual(coveragesForAbsence(coverages, 'absent'), []);
});

// ---------- coverage extras attribution ----------

test('coverageExtra: paid to absence.house, not providingHouse', () => {
  // Worker absent from ramot. Helper from asher provides coverage. The
  // extra_payment is a COST to ramot (the house that needs help).
  const absences = [abs({ id: 'ab1', workerId: 'w1', house: 'ramot' })];
  const coverages = [cov({ id: 'c1', absenceId: 'ab1', providingHouse: 'asher', extraPayment: 1500 })];
  assert.equal(coverageExtra(coverages, absences, 'ramot', TODAY), 1500);
  assert.equal(coverageExtra(coverages, absences, 'asher', TODAY), 0);
});

test('coverageExtra: ignores coverages whose absence is inactive', () => {
  const absences = [abs({ id: 'ab1', house: 'ramot', endDate: '2026-04-01' })]; // past
  const coverages = [cov({ id: 'c1', absenceId: 'ab1', extraPayment: 9999 })];
  assert.equal(coverageExtra(coverages, absences, 'ramot', TODAY), 0);
});

test('coverageExtra: sums multiple active coverages on same absence', () => {
  const absences = [abs({ id: 'ab1', house: 'ramot' })];
  const coverages = [
    cov({ id: 'c1', absenceId: 'ab1', providingHouse: 'asher', extraPayment: 1500 }),
    cov({ id: 'c2', absenceId: 'ab1', providingHouse: 'ofroni', extraPayment: 800 }),
  ];
  assert.equal(coverageExtra(coverages, absences, 'ramot', TODAY), 2300);
});

test('coverageExtra: orphan coverage (no parent absence) contributes nothing', () => {
  const coverages = [cov({ id: 'c1', absenceId: 'gone', extraPayment: 1000 })];
  assert.equal(coverageExtra(coverages, [], 'ramot', TODAY), 0);
});

test('activeCoveragesByHouse: groups by absence.house only when active', () => {
  const absences = [
    abs({ id: 'ab1', house: 'ramot' }),
    abs({ id: 'ab2', house: 'asher', endDate: '2026-04-01' }), // past
    abs({ id: 'ab3', house: 'ofroni' }),
  ];
  const coverages = [
    cov({ id: 'c1', absenceId: 'ab1' }),
    cov({ id: 'c2', absenceId: 'ab2' }),  // dropped — parent inactive
    cov({ id: 'c3', absenceId: 'ab3' }),
  ];
  const grouped = activeCoveragesByHouse(coverages, absences, TODAY);
  assert.deepEqual(Object.keys(grouped).sort(), ['ofroni', 'ramot']);
  assert.equal(grouped.ramot.length, 1);
  assert.equal(grouped.ofroni.length, 1);
});

// ---------- pending termination ----------

test('pendingTerminations: strictly after today is pending', () => {
  const archive = [
    arch({ id: 'past', terminationDate: '2026-04-01' }),
    arch({ id: 'today', terminationDate: TODAY }),
    arch({ id: 'future', terminationDate: '2026-06-15' }),
  ];
  assert.deepEqual(pendingTerminations(archive, TODAY).map(a => a.id), ['future']);
});

test('pendingHouseCost: filters by house and uses frozen cost', () => {
  const archive = [
    arch({ house: 'ramot', employmentType: 'full_time', salary: 20000, terminationDate: '2026-06-15' }),
    arch({ house: 'ramot', employmentType: 'part_time', salary: 10000, pct: 50, terminationDate: '2026-06-15' }), // 5000
    arch({ house: 'asher', employmentType: 'full_time', salary: 15000, terminationDate: '2026-06-15' }),
    arch({ house: 'ramot', employmentType: 'full_time', salary: 8000, terminationDate: '2026-04-01' }), // past
  ];
  assert.equal(pendingHouseCost(archive, 'ramot', TODAY), 25000);
  assert.equal(pendingHouseCost(archive, 'asher', TODAY), 15000);
  assert.equal(pendingHouseCost(archive, 'ofroni', TODAY), 0);
});

test('pendingHouseCost: hourly archive row uses frozen rate × hours', () => {
  const archive = [
    arch({
      house: 'ramot', employmentType: 'hourly', salary: 0,
      hourlyRate: 100, estHours: 80, terminationDate: '2026-06-15',
    }),
  ];
  assert.equal(pendingHouseCost(archive, 'ramot', TODAY), 8000);
});

// ---------- house / network totals ----------

test('houseTotal: assignments + active coverage extras + pending terminations', () => {
  const assignments = [
    asg({ house: 'ramot', employmentType: 'full_time', salary: 18000 }),
  ];
  const absences = [abs({ id: 'ab1', house: 'ramot' })];
  const coverages = [cov({ id: 'c1', absenceId: 'ab1', extraPayment: 1500 })];
  const archive = [arch({ house: 'ramot', salary: 6000, terminationDate: '2026-06-15' })];
  // 18000 + 1500 + 6000 = 25500
  assert.equal(houseTotal(assignments, coverages, absences, archive, 'ramot', TODAY), 25500);
});

test('houseTotal: assignment cost counts at its own house, regardless of any absence', () => {
  // Worker w1 has assignments at ramot AND asher. They're absent from ramot
  // today. Both assignments' costs still count at their respective houses.
  const assignments = [
    asg({ id: 'a1', workerId: 'w1', house: 'ramot', salary: 18000 }),
    asg({ id: 'a2', workerId: 'w1', house: 'asher', salary: 6000 }),
  ];
  const absences = [abs({ id: 'ab1', workerId: 'w1', house: 'ramot' })];
  assert.equal(houseTotal(assignments, [], absences, [], 'ramot', TODAY), 18000);
  assert.equal(houseTotal(assignments, [], absences, [], 'asher', TODAY), 6000);
});

test('houseTotal: empty inputs → 0', () => {
  assert.equal(houseTotal([], [], [], [], 'ramot', TODAY), 0);
});

test('networkTotal: every assignment cost + every active coverage extra + pending term', () => {
  const assignments = [
    asg({ house: 'ramot', employmentType: 'full_time', salary: 20000 }),
    asg({ house: 'asher', employmentType: 'part_time', salary: 10000, pct: 50 }), // 5000
    asg({ house: 'rehab', employmentType: 'fixed_retainer', retainerAmount: 4000 }),
  ];
  const absences = [
    abs({ id: 'ab1', house: 'ramot' }),
    abs({ id: 'ab2', house: 'ofroni', endDate: '2026-04-01' }), // past
  ];
  const coverages = [
    cov({ id: 'c1', absenceId: 'ab1', providingHouse: 'asher', extraPayment: 1500 }),
    cov({ id: 'c2', absenceId: 'ab2', providingHouse: 'rehab', extraPayment: 9999 }), // dropped
  ];
  const archive = [
    arch({ house: 'ramot', employmentType: 'full_time', salary: 8000, terminationDate: '2026-06-15' }),
  ];
  // 20000 + 5000 + 4000 + 1500 + 8000 = 38500
  assert.equal(networkTotal(assignments, coverages, absences, archive, HOUSES, TODAY), 38500);
});

test('networkTotal equals sum of houseTotal across all houses', () => {
  const assignments = [
    asg({ house: 'ramot', salary: 20000 }),
    asg({ house: 'asher', salary: 15000 }),
    asg({ house: 'ofroni', employmentType: 'hourly', hourlyRate: 80, estHours: 120, salary: 0 }), // 9600
  ];
  const absences = [abs({ id: 'ab1', house: 'ramot' })];
  const coverages = [cov({ id: 'c1', absenceId: 'ab1', extraPayment: 1200 })];
  const archive = [arch({ house: 'asher', salary: 5000, terminationDate: '2026-06-15' })];
  const net = networkTotal(assignments, coverages, absences, archive, HOUSES, TODAY);
  const sumOfHouses = HOUSES.reduce((s, h) =>
    s + houseTotal(assignments, coverages, absences, archive, h, TODAY), 0);
  assert.equal(sumOfHouses, net);
});

// ---------- worker views ----------

test('assignmentsForWorker / workerTotalCost: sums across houses', () => {
  const assignments = [
    asg({ id: 'a1', workerId: 'w1', house: 'ramot', salary: 18000 }),
    asg({ id: 'a2', workerId: 'w1', house: 'asher', salary: 6000 }),
    asg({ id: 'a3', workerId: 'w2', house: 'ramot', salary: 15000 }),
  ];
  assert.deepEqual(assignmentsForWorker(assignments, 'w1').map(a => a.id), ['a1', 'a2']);
  assert.equal(workerTotalCost(assignments, 'w1'), 24000);
  assert.equal(workerTotalCost(assignments, 'unknown'), 0);
});

test('activeAbsenceForWorker: finds active absence for a worker', () => {
  const absences = [
    abs({ id: 'ab1', workerId: 'w1', endDate: '2026-04-01' }), // past
    abs({ id: 'ab2', workerId: 'w1' }),                         // active
    abs({ id: 'ab3', workerId: 'w2' }),
  ];
  const found = activeAbsenceForWorker(absences, 'w1', TODAY);
  assert.ok(found && found.id === 'ab2');
  assert.equal(activeAbsenceForWorker(absences, 'never', TODAY), null);
});
