'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  EMPLOYMENT_TYPES, SALARIED_TYPES, FREELANCER_TYPES,
  assignmentCategory, assignmentCost,
  assignmentsByHouse, houseAssignmentsCost, splitByCategory,
  isAbsenceActive, activeAbsences, openAbsences,
  coveragesForAbsence, isCoverageActive, activeCoveragesByHouse, coverageExtra,
  pendingTerminations, pendingHouseCost,
  houseTotal, networkTotal,
  assignmentsForWorker, workerTotalCost,
  activeAbsenceForWorker,
  networkAbsenceCoverageRows,
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
    // v3.1: coverage carries its own houses + dates, independent of any
    // linked absence. coveringHouse = where the helper is from;
    // receivingHouse = where the help is going (extra accrues here).
    coveringHouse: 'asher',
    receivingHouse: 'ramot',
    startDate: '2026-05-01',
    endDate: '2026-05-31',
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

test('isCoverageActive (unlinked): today inside the coverage range', () => {
  // No absenceId → cost accrues purely on the coverage's own dates.
  const c = cov({ absenceId: '', startDate: '2026-05-01', endDate: '2026-05-31' });
  assert.equal(isCoverageActive(c, TODAY, []), true);
  assert.equal(isCoverageActive(cov({ absenceId: '', startDate: TODAY, endDate: '2026-06-01' }), TODAY, []), true);
  assert.equal(isCoverageActive(cov({ absenceId: '', startDate: '2026-05-01', endDate: TODAY }), TODAY, []), true);
  assert.equal(isCoverageActive(cov({ absenceId: '', startDate: '2026-06-01', endDate: '2026-06-15' }), TODAY, []), false);
  assert.equal(isCoverageActive(null, TODAY, []), false);
});

test('isCoverageActive (linked): active only when the linked absence is also active', () => {
  // Linked coverage is gated by isAbsenceActive — captures both:
  //   - absence.endDate clamping the coverage from the right
  //   - endAbsence flipping status='ended' (drops on the same day)
  // even though the coverage's own endDate is later.
  const absences = [
    abs({ id: 'ab-open', house: 'ramot', endDate: '2026-05-31' }),                // active
    abs({ id: 'ab-ended-status', house: 'ramot', endDate: TODAY, status: 'ended' }),  // closed today
    abs({ id: 'ab-past', house: 'ramot', endDate: '2026-04-01' }),               // past by date
  ];
  // Coverage range extends past each absence end, but cost stops when
  // the linked absence stops being active.
  const cActive = cov({ id: 'c1', absenceId: 'ab-open', startDate: '2026-05-01', endDate: '2026-06-30' });
  const cEnded  = cov({ id: 'c2', absenceId: 'ab-ended-status', startDate: '2026-05-01', endDate: '2026-06-30' });
  const cPast   = cov({ id: 'c3', absenceId: 'ab-past', startDate: '2026-05-01', endDate: '2026-06-30' });
  assert.equal(isCoverageActive(cActive, TODAY, absences), true);
  assert.equal(isCoverageActive(cEnded,  TODAY, absences), false);
  assert.equal(isCoverageActive(cPast,   TODAY, absences), false);
});

test('isCoverageActive (linked): dangling absenceId falls back to unlinked behavior', () => {
  // Coverage has absenceId set but the absence has been deleted (or was
  // never created). Same spirit as deleteAbsence not cascading — the
  // coverage row stands on its own, gated only by its dates.
  const c = cov({ id: 'c1', absenceId: 'gone', startDate: '2026-05-01', endDate: '2026-05-31' });
  assert.equal(isCoverageActive(c, TODAY, []), true);
});

test('coverageExtra: paid to receivingHouse, not coveringHouse', () => {
  // Helper from asher (coveringHouse) helps ramot (receivingHouse). The
  // extra_payment is a COST to ramot.
  const coverages = [cov({
    id: 'c1', absenceId: '', coveringHouse: 'asher', receivingHouse: 'ramot',
    extraPayment: 1500,
  })];
  assert.equal(coverageExtra(coverages, [], 'ramot', TODAY), 1500);
  assert.equal(coverageExtra(coverages, [], 'asher', TODAY), 0);
});

test('coverageExtra (orphan): accrues on its own dates independently of any absence', () => {
  // No absenceId → no linked-absence gate. Today within coverage range
  // ⇒ extras accrue, even if there are no absences at all.
  const cFuture = cov({ id: 'f', absenceId: '', receivingHouse: 'ramot',
    startDate: '2026-06-01', endDate: '2026-06-15', extraPayment: 9999 });
  const cNow    = cov({ id: 'n', absenceId: '', receivingHouse: 'ramot',
    startDate: '2026-05-01', endDate: '2026-05-31', extraPayment: 1000 });
  assert.equal(coverageExtra([cFuture], [], 'ramot', TODAY), 0);
  assert.equal(coverageExtra([cNow], [], 'ramot', TODAY), 1000);
});

test('coverageExtra (linked): clamps to absence.endDate — early-end stops extras', () => {
  // Coverage range stretches to 2026-06-30, but the linked absence was
  // ended early (endAbsence pulled endDate to TODAY and flipped status
  // to 'ended'). Real-world: regular employee returned, substitute is
  // no longer needed. Cost stops on the absence's end date even though
  // the coverage row is unchanged.
  const earlyEnded = abs({ id: 'ab1', house: 'ramot', endDate: TODAY, status: 'ended' });
  const c = cov({ id: 'c1', absenceId: 'ab1', receivingHouse: 'ramot',
    startDate: '2026-05-01', endDate: '2026-06-30', extraPayment: 5000 });
  assert.equal(coverageExtra([c], [earlyEnded], 'ramot', TODAY), 0);

  // For comparison: if the absence is still active, the linked
  // coverage's extra DOES count (despite its own endDate stretching
  // past — capped by absence on the upper side, but absence is still
  // open today so today is within both).
  const stillOpen = abs({ id: 'ab1', house: 'ramot', endDate: '2026-05-31' });
  assert.equal(coverageExtra([c], [stillOpen], 'ramot', TODAY), 5000);
});

test('coverageExtra (linked, dangling): absence deleted → falls back to own dates', () => {
  // absenceId set but the absence is gone. v3.1 doesn't cascade-delete;
  // the coverage carries its own dates + receivingHouse so it keeps
  // accruing as if unlinked.
  const c = cov({ id: 'c1', absenceId: 'gone', receivingHouse: 'ramot',
    startDate: '2026-05-01', endDate: '2026-05-31', extraPayment: 1200 });
  assert.equal(coverageExtra([c], [], 'ramot', TODAY), 1200);
});

test('coverageExtra: sums multiple active coverages at the same receivingHouse', () => {
  const coverages = [
    cov({ id: 'c1', absenceId: '', coveringHouse: 'asher',  receivingHouse: 'ramot', extraPayment: 1500 }),
    cov({ id: 'c2', absenceId: '', coveringHouse: 'ofroni', receivingHouse: 'ramot', extraPayment: 800  }),
  ];
  assert.equal(coverageExtra(coverages, [], 'ramot', TODAY), 2300);
});

test('coverageExtra: orphan stub (receivingHouse="") contributes nowhere', () => {
  // Migration of v2 events with no recorded absentee → stub coverages
  // with receivingHouse=''. Cost cannot accrue without a destination
  // house; Moran has to assign one via the UI before the extra counts.
  const coverages = [cov({ id: 'c1', absenceId: '', receivingHouse: '', extraPayment: 1000 })];
  assert.equal(coverageExtra(coverages, [], 'ramot', TODAY), 0);
});

test('activeCoveragesByHouse: groups by receivingHouse only when coverage is active', () => {
  const absences = [abs({ id: 'ab-open', house: 'ramot' })]; // still active today
  const coverages = [
    cov({ id: 'c1', absenceId: '', receivingHouse: 'ramot' }),                                                  // active
    cov({ id: 'c2', absenceId: '', receivingHouse: 'asher',  startDate: '2026-03-01', endDate: '2026-04-01' }), // past — drop
    cov({ id: 'c3', absenceId: 'ab-open', receivingHouse: 'ofroni' }),                                          // active via link
    cov({ id: 'c4', absenceId: '', receivingHouse: '' }),                                                       // orphan — drop
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
  // cov() defaults to receivingHouse='ramot', active today.
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
    // Active coverage at ramot — counts.
    cov({ id: 'c1', absenceId: 'ab1', coveringHouse: 'asher', receivingHouse: 'ramot', extraPayment: 1500 }),
    // Past coverage at ofroni — dropped on its OWN dates, not on its linked absence.
    cov({ id: 'c2', absenceId: 'ab2', coveringHouse: 'rehab', receivingHouse: 'ofroni',
      startDate: '2026-03-01', endDate: '2026-04-01', extraPayment: 9999 }),
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
  // Default cov() factory has receivingHouse='ramot', active today.
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

// ---------- networkAbsenceCoverageRows (dashboard join) ----------

test('networkAbsenceCoverageRows: matches a linked coverage to its absence', () => {
  const absences = [abs({ id: 'ab1' })];
  const coverages = [cov({ id: 'c1', absenceId: 'ab1' })];
  const rows = networkAbsenceCoverageRows(absences, coverages, [], [], TODAY);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].absence.id, 'ab1');
  assert.ok(rows[0].coverage && rows[0].coverage.id === 'c1');
});

test('networkAbsenceCoverageRows: absence without coverage gets coverage=null', () => {
  const absences = [abs({ id: 'ab1' })];
  const coverages = [];
  const rows = networkAbsenceCoverageRows(absences, coverages, [], [], TODAY);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].coverage, null);
});

test('networkAbsenceCoverageRows: unlinked coverage (absenceId="") does NOT attach to anything', () => {
  // Unlinked coverages stand alone — the dashboard JOIN is by absenceId,
  // so a coverage with absenceId='' simply has no absence partner.
  const absences = [abs({ id: 'ab1' })];
  const coverages = [cov({ id: 'c1', absenceId: '' })];
  const rows = networkAbsenceCoverageRows(absences, coverages, [], [], TODAY);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].coverage, null,
    'absence should remain orphaned in the dashboard view');
});

test('networkAbsenceCoverageRows: dangling link (no such absenceId) does NOT attach', () => {
  // The cost contract treats danglers as unlinked. The dashboard JOIN
  // similarly drops them — the orphan absence stays orphan.
  const absences = [abs({ id: 'ab1' })];
  const coverages = [cov({ id: 'c1', absenceId: 'missing' })];
  const rows = networkAbsenceCoverageRows(absences, coverages, [], [], TODAY);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].coverage, null);
});

test('networkAbsenceCoverageRows: stub absence (workerId="") is still included', () => {
  // v3.1 makes stub rows a first-class shape ("position open, no
  // identified absentee"). The dashboard surfaces them so Moran can
  // see the open slot — the UI renders the name as "(ללא רישום נעדר/ת)".
  const absences = [abs({ id: 'ab1', workerId: '' })];
  const rows = networkAbsenceCoverageRows(absences, [], [], [], TODAY);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].absence.workerId, '');
});

test('networkAbsenceCoverageRows: ended/past absences excluded', () => {
  const absences = [
    abs({ id: 'ab1' }),                                  // active
    abs({ id: 'ab2', status: 'ended' }),                 // ended status
    abs({ id: 'ab3', endDate: '2026-04-01' }),           // past
  ];
  const rows = networkAbsenceCoverageRows(absences, [], [], [], TODAY);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].absence.id, 'ab1');
});

test('networkAbsenceCoverageRows: multiple coverages on one absence — first wins (one row per absence)', () => {
  const absences = [abs({ id: 'ab1' })];
  const coverages = [
    cov({ id: 'c1', absenceId: 'ab1' }),
    cov({ id: 'c2', absenceId: 'ab1' }),  // second one ignored in the join
  ];
  const rows = networkAbsenceCoverageRows(absences, coverages, [], [], TODAY);
  assert.equal(rows.length, 1, 'one row per absence regardless of coverage count');
  assert.equal(rows[0].coverage.id, 'c1');
});

test('networkAbsenceCoverageRows: sort order — orphans first, then by startDate desc', () => {
  // Three absences: two covered, one orphan. Expected order:
  //   1. orphan first (regardless of its date)
  //   2. then covered in startDate-desc order (newest first)
  const absences = [
    abs({ id: 'aOldCovered',  startDate: '2026-05-10', endDate: '2026-05-31' }),
    abs({ id: 'aOrphan',      startDate: '2026-05-01', endDate: '2026-05-31' }),
    abs({ id: 'aNewCovered',  startDate: '2026-05-19', endDate: '2026-05-31' }),
  ];
  const coverages = [
    cov({ id: 'c1', absenceId: 'aOldCovered' }),
    cov({ id: 'c2', absenceId: 'aNewCovered' }),
    // aOrphan intentionally has no coverage
  ];
  const rows = networkAbsenceCoverageRows(absences, coverages, [], [], TODAY);
  assert.deepEqual(
    rows.map(r => r.absence.id),
    ['aOrphan', 'aNewCovered', 'aOldCovered'],
  );
});

test('networkAbsenceCoverageRows: empty inputs → empty array', () => {
  assert.deepEqual(networkAbsenceCoverageRows([], [], [], [], TODAY), []);
  assert.deepEqual(networkAbsenceCoverageRows(null, null, null, null, TODAY), []);
});
