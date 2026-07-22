'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  EMPLOYMENT_TYPES, SALARIED_TYPES, FREELANCER_TYPES,
  assignmentCategory, assignmentCost, perSessionCost,
  assignmentsByHouse, houseAssignmentsCost, splitByCategory,
  currentMonth, indexActuals, lookupActual, monthlyAssignmentCost,
  houseMonthlyAssignmentsCost, houseMonthlyTotal, networkMonthlyTotal,
  isAbsenceActive, activeAbsences, openAbsences,
  coveragesForAbsence, isCoverageActive, activeCoveragesByHouse, coverageExtra,
  pendingTerminations, pendingHouseCost,
  houseTotal, networkTotal,
  budgetForHouse, budgetVariance,
  isInstructorRole, instructorAssignments, houseMonthlyInstructorsCost,
  hasInstructorsBudget, instructorsBudgetForHouse, budgetWarning,
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

test('assignmentCost: per_session (legacy single pair) multiplies rate × estSessions', () => {
  // Un-migrated rows carry only the legacy pair → priced off the fallback.
  assert.equal(assignmentCost(asg({ employmentType: 'per_session', sessionRate: 300, estSessions: 12 })), 3600);
});

test('perSessionCost: sums the three rate/count products', () => {
  const a = asg({
    employmentType: 'per_session',
    rateIndividual: 300, sessionsIndividual: 10,   // 3000
    rateGroup: 200, sessionsGroup: 4,              // 800
    rateExternal: 150, externalPatients: 6,        // 900
  });
  assert.equal(perSessionCost(a), 4700);
  assert.equal(assignmentCost(a), 4700);
});

test('perSessionCost: fields are optional and default to 0', () => {
  // Only individual work — group/external blank.
  assert.equal(perSessionCost(asg({
    employmentType: 'per_session', rateIndividual: 400, sessionsIndividual: 8,
  })), 3200);
  // Nothing set at all → 0.
  assert.equal(perSessionCost(asg({ employmentType: 'per_session' })), 0);
});

test('perSessionCost: the new 3-rate model takes precedence over the legacy pair', () => {
  // When any new product is present the legacy pair is ignored entirely.
  const a = asg({
    employmentType: 'per_session',
    sessionRate: 999, estSessions: 999,            // legacy noise
    rateIndividual: 300, sessionsIndividual: 10,   // 3000 wins
  });
  assert.equal(perSessionCost(a), 3000);
});

test('perSessionCost: negative inputs are floored to 0', () => {
  assert.equal(perSessionCost(asg({
    employmentType: 'per_session',
    rateIndividual: -300, sessionsIndividual: 10,
    rateGroup: 200, sessionsGroup: -4,
  })), 0);
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

test('houseAssignmentsCost: a חל"ד worker contributes 0 to the house total', () => {
  // Putting someone on חל"ד must drop their cost from the house immediately
  // (salary AND allowance stop). Only the active worker remains.
  const active = asg({ id: 'a-active', house: 'ramot', employmentType: 'full_time', salary: 20000 });
  const onLeave = asg({
    id: 'a-leave', house: 'ramot', employmentType: 'full_time', salary: 18000,
    allowance: 6000, status: 'chld', statusDate: '2026-07-01',
  });
  assert.equal(assignmentCost(onLeave), 0, 'the חל"ד worker alone costs 0');
  assert.equal(houseAssignmentsCost([active, onLeave], 'ramot'), 20000);
});

test('houseTotal: a חל"ט worker drops out of the house total', () => {
  const active = asg({ id: 'a1', house: 'asher', employmentType: 'full_time', salary: 12000 });
  const onLeave = asg({ id: 'a2', house: 'asher', employmentType: 'per_session',
    rateIndividual: 400, sessionsIndividual: 10, status: 'chlt', statusDate: '2026-06-15' });
  // Only the active worker's 12000 counts — the חל"ט therapist's 4000 is zeroed.
  assert.equal(houseTotal([active, onLeave], [], [], [], 'asher', TODAY), 12000);
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

// ---------- monthly actuals: cost fallback logic ----------

const MONTH = '2026-07';

function hourly(over) {
  return asg(Object.assign({
    id: 'h1', employmentType: 'hourly',
    salary: 0, hourlyRate: 60, estHours: 100,
  }, over));
}
function perSession(over) {
  return asg(Object.assign({
    id: 's1', employmentType: 'per_session',
    salary: 0, sessionRate: 400, estSessions: 12,
  }, over));
}
function actual(over) {
  return Object.assign({
    id: 'ma1', assignmentId: 'h1', month: MONTH,
    actualHours: null, actualSessions: null, note: '',
  }, over);
}

test('monthlyAssignmentCost: hourly WITH actuals uses rate × actualHours', () => {
  const a = hourly();                       // rate 60, est 100 → estimate 6000
  const r = monthlyAssignmentCost(a, actual({ actualHours: 92 }));
  assert.equal(r.cost, 5520);               // 60 × 92
  assert.equal(r.isEstimate, false);
});

test('monthlyAssignmentCost: hourly WITHOUT actuals falls back to estimate + flags it', () => {
  const a = hourly();
  const r = monthlyAssignmentCost(a, null);
  assert.equal(r.cost, 6000);               // 60 × 100 estimate
  assert.equal(r.isEstimate, true);
});

test('monthlyAssignmentCost: actuals row with only sessions leaves hourly on estimate', () => {
  // An actuals row exists but actualHours is null (blank) → still estimate.
  const r = monthlyAssignmentCost(hourly(), actual({ actualSessions: 5 }));
  assert.equal(r.cost, 6000);
  assert.equal(r.isEstimate, true);
});

test('monthlyAssignmentCost: recorded 0 hours is a real value, not a fallback', () => {
  const r = monthlyAssignmentCost(hourly(), actual({ actualHours: 0 }));
  assert.equal(r.cost, 0);
  assert.equal(r.isEstimate, false);
});

test('monthlyAssignmentCost: per_session WITH actuals uses rate × actualSessions', () => {
  const a = perSession();                   // rate 400, est 12 → estimate 4800
  const r = monthlyAssignmentCost(a, actual({ assignmentId: 's1', actualSessions: 9 }));
  assert.equal(r.cost, 3600);               // 400 × 9
  assert.equal(r.isEstimate, false);
});

test('monthlyAssignmentCost: per_session WITHOUT actuals flags the estimate', () => {
  const r = monthlyAssignmentCost(perSession(), null);
  assert.equal(r.cost, 4800);
  assert.equal(r.isEstimate, true);
});

test('monthlyAssignmentCost: adds the allowance on top of the actual', () => {
  const a = hourly({ allowance: 2000 });
  const r = monthlyAssignmentCost(a, actual({ actualHours: 92 }));
  assert.equal(r.cost, 5520 + 2000);
  assert.equal(r.isEstimate, false);
});

test('monthlyAssignmentCost: fixed types are month-invariant, never flagged', () => {
  const ft = asg({ employmentType: 'full_time', salary: 18000 });
  assert.deepEqual(monthlyAssignmentCost(ft, null), { cost: 18000, isEstimate: false });
  const ret = asg({ employmentType: 'fixed_retainer', salary: 0, retainerAmount: 4500 });
  assert.deepEqual(monthlyAssignmentCost(ret, null), { cost: 4500, isEstimate: false });
});

test('monthlyAssignmentCost: leave zeroes the cost, ahead of actual/estimate', () => {
  const a = hourly({ status: 'chld', statusDate: '2026-07-01' });
  assert.deepEqual(monthlyAssignmentCost(a, actual({ actualHours: 92 })), { cost: 0, isEstimate: false });
});

test('indexActuals / lookupActual: keyed by assignmentId + month', () => {
  const idx = indexActuals([
    actual({ assignmentId: 'h1', month: '2026-07', actualHours: 92 }),
    actual({ assignmentId: 'h1', month: '2026-08', actualHours: 40 }),
    actual({ assignmentId: 's1', month: '2026-07', actualSessions: 9 }),
  ]);
  assert.equal(lookupActual(idx, 'h1', '2026-07').actualHours, 92);
  assert.equal(lookupActual(idx, 'h1', '2026-08').actualHours, 40);
  assert.equal(lookupActual(idx, 's1', '2026-07').actualSessions, 9);
  assert.equal(lookupActual(idx, 'h1', '2026-09'), null);
  assert.equal(lookupActual(idx, 'nope', '2026-07'), null);
});

test('currentMonth: YYYY-MM prefix of today', () => {
  assert.match(currentMonth(), /^\d{4}-(0[1-9]|1[0-2])$/);
});

test('houseMonthlyAssignmentsCost: mixes actuals + estimate + fixed within a house', () => {
  const assignments = [
    asg({ id: 'ft', house: 'ramot', employmentType: 'full_time', salary: 18000 }),
    hourly({ id: 'h1', house: 'ramot' }),                 // has actuals → 5520
    hourly({ id: 'h2', house: 'ramot', hourlyRate: 50, estHours: 80 }), // no actuals → 4000 est
  ];
  const idx = indexActuals([actual({ assignmentId: 'h1', actualHours: 92 })]);
  // 18000 + 5520 + 4000
  assert.equal(houseMonthlyAssignmentsCost(assignments, idx, 'ramot', MONTH), 27520);
});

test('houseMonthlyTotal: month assignment costs + coverage extra (today) + pending (today)', () => {
  const assignments = [hourly({ id: 'h1', house: 'ramot' })];
  const idx = indexActuals([actual({ assignmentId: 'h1', actualHours: 92 })]); // 5520
  const absences = [{ id: 'ab1', workerId: 'w9', house: 'ramot',
    startDate: '2026-05-01', endDate: '2026-05-31', status: 'active' }];
  const coverages = [{ id: 'c1', absenceId: 'ab1', coveringWorkerId: 'w2',
    coveringHouse: 'asher', receivingHouse: 'ramot',
    startDate: '2026-05-01', endDate: '2026-05-31', extraPayment: 800 }];
  // today falls inside May so coverage is active; month view is July.
  const t = '2026-05-20';
  assert.equal(
    houseMonthlyTotal(assignments, coverages, absences, [], idx, 'ramot', MONTH, t),
    5520 + 800);
});

test('networkMonthlyTotal: sums month assignment costs across houses + one coverage extra', () => {
  const assignments = [
    hourly({ id: 'h1', house: 'ramot' }),              // actuals → 5520
    perSession({ id: 's1', house: 'asher' }),          // no actuals → 4800 est
  ];
  const idx = indexActuals([actual({ assignmentId: 'h1', actualHours: 92 })]);
  const absences = [{ id: 'ab1', workerId: 'w9', house: 'ramot',
    startDate: '2026-05-01', endDate: '2026-05-31', status: 'active' }];
  const coverages = [{ id: 'c1', absenceId: 'ab1', coveringWorkerId: 'w2',
    coveringHouse: 'asher', receivingHouse: 'ramot',
    startDate: '2026-05-01', endDate: '2026-05-31', extraPayment: 800 }];
  const t = '2026-05-20';
  assert.equal(
    networkMonthlyTotal(assignments, coverages, absences, [], idx, HOUSES, MONTH, t),
    5520 + 4800 + 800);
});

// ---------- budgets ----------

test('budgetForHouse: month-specific overrides default; null when none', () => {
  const budgets = [
    { id: 'b1', house: 'ramot', month: 'default', amount: 100000 },
    { id: 'b2', house: 'ramot', month: '2026-07', amount: 120000 },
    { id: 'b3', house: 'asher', month: 'default', amount: 80000 },
  ];
  assert.equal(budgetForHouse(budgets, 'ramot', '2026-07'), 120000); // specific
  assert.equal(budgetForHouse(budgets, 'ramot', '2026-08'), 100000); // falls to default
  assert.equal(budgetForHouse(budgets, 'asher', '2026-07'), 80000);  // only default
  assert.equal(budgetForHouse(budgets, 'ofroni', '2026-07'), null);  // none set
  assert.equal(budgetForHouse([], 'ramot', '2026-07'), null);
});

test('budgetVariance: none when no budget', () => {
  const v = budgetVariance(null, 5000);
  assert.deepEqual(v, { budget: null, cost: 5000, variance: null, pct: null, status: 'none' });
});

test('budgetVariance: green at or under budget', () => {
  const v = budgetVariance(100000, 90000);
  assert.equal(v.status, 'ok');
  assert.equal(v.variance, 10000);   // headroom
  assert.equal(v.pct, 90);
  const exact = budgetVariance(100000, 100000);
  assert.equal(exact.status, 'ok');
  assert.equal(exact.variance, 0);
  assert.equal(exact.pct, 100);
});

test('budgetVariance: amber when over by up to 10%', () => {
  const v = budgetVariance(100000, 105000);
  assert.equal(v.status, 'warn');
  assert.equal(v.variance, -5000);   // over
  assert.equal(v.pct, 105);
  const edge = budgetVariance(100000, 110000);   // exactly +10% → still amber
  assert.equal(edge.status, 'warn');
});

test('budgetVariance: red when over by more than 10%', () => {
  const v = budgetVariance(100000, 130000);
  assert.equal(v.status, 'over');
  assert.equal(v.variance, -30000);
  assert.equal(v.pct, 130);
});

test('budgetVariance: zero budget is ok at 0 cost, over when cost > 0', () => {
  assert.equal(budgetVariance(0, 0).status, 'ok');
  const over = budgetVariance(0, 5000);
  assert.equal(over.status, 'over');
  assert.equal(over.pct, Infinity);
});

// ---------- instructor (מדריך/ה) cost aggregation ----------

const INSTR = 'מדריך/ה';

test('isInstructorRole: exact match on מדריך/ה only', () => {
  assert.equal(isInstructorRole(INSTR), true);
  assert.equal(isInstructorRole(' מדריך/ה '), true);  // trimmed
  assert.equal(isInstructorRole('מטפל/ת'), false);
  assert.equal(isInstructorRole('אחות'), false);
  assert.equal(isInstructorRole(''), false);
  assert.equal(isInstructorRole(undefined), false);
});

test('instructorAssignments: only מדריך/ה rows at the house', () => {
  const list = [
    asg({ id: 'i1', house: 'ramot', role: INSTR }),
    asg({ id: 'n1', house: 'ramot', role: 'אחות' }),
    asg({ id: 'i2', house: 'asher', role: INSTR }),
  ];
  const got = instructorAssignments(list, 'ramot').map(a => a.id);
  assert.deepEqual(got, ['i1']);
});

test('houseMonthlyInstructorsCost: sums fixed instructor salaries, not an estimate', () => {
  const list = [
    asg({ id: 'i1', house: 'ramot', role: INSTR, employmentType: 'full_time', salary: 12000 }),
    asg({ id: 'i2', house: 'ramot', role: INSTR, employmentType: 'full_time', salary: 8000 }),
    asg({ id: 'n1', house: 'ramot', role: 'אחות', employmentType: 'full_time', salary: 18000 }),
  ];
  const idx = indexActuals([]);
  const r = houseMonthlyInstructorsCost(list, idx, 'ramot', MONTH);
  assert.equal(r.cost, 20000);       // only the two instructors, nurse excluded
  assert.equal(r.isEstimate, false); // full_time is month-invariant
});

test('houseMonthlyInstructorsCost: hourly instructor uses actuals when present', () => {
  const list = [
    asg({ id: 'h1', house: 'ramot', role: INSTR, employmentType: 'hourly',
      salary: 0, hourlyRate: 60, estHours: 100 }),
  ];
  const idx = indexActuals([{ assignmentId: 'h1', month: MONTH, actualHours: 120 }]);
  const r = houseMonthlyInstructorsCost(list, idx, 'ramot', MONTH);
  assert.equal(r.cost, 7200);        // 60 × 120 actual, not the 6000 estimate
  assert.equal(r.isEstimate, false);
});

test('houseMonthlyInstructorsCost: hourly instructor falls back to estimate (isEstimate=true)', () => {
  const list = [
    asg({ id: 'h1', house: 'ramot', role: INSTR, employmentType: 'hourly',
      salary: 0, hourlyRate: 60, estHours: 100 }),
  ];
  const idx = indexActuals([]);     // no actuals for the month
  const r = houseMonthlyInstructorsCost(list, idx, 'ramot', MONTH);
  assert.equal(r.cost, 6000);        // estimate 60 × 100
  assert.equal(r.isEstimate, true);  // flagged so the UI shows אומדן
});

test('houseMonthlyInstructorsCost: any estimate fallback flags the whole total', () => {
  const list = [
    asg({ id: 'f1', house: 'ramot', role: INSTR, employmentType: 'full_time', salary: 10000 }),
    asg({ id: 'h1', house: 'ramot', role: INSTR, employmentType: 'hourly',
      salary: 0, hourlyRate: 50, estHours: 40 }),   // no actuals → estimate 2000
  ];
  const idx = indexActuals([]);
  const r = houseMonthlyInstructorsCost(list, idx, 'ramot', MONTH);
  assert.equal(r.cost, 12000);       // 10000 + 2000
  assert.equal(r.isEstimate, true);  // the hourly leg fell back
});

test('houseMonthlyInstructorsCost: no instructors → zero, not an estimate', () => {
  const list = [asg({ id: 'n1', house: 'ramot', role: 'אחות', salary: 18000 })];
  const r = houseMonthlyInstructorsCost(list, indexActuals([]), 'ramot', MONTH);
  assert.deepEqual(r, { cost: 0, isEstimate: false });
});

// ---------- instructors budget resolution + warning ----------

test('instructorsBudgetForHouse: specific month wins, blank falls through to default', () => {
  const budgets = [
    { id: 'b1', house: 'ramot', month: 'default', amount: 200000, instructorsAmount: 60000 },
    { id: 'b2', house: 'ramot', month: '2026-07', amount: 210000, instructorsAmount: 72744 },
    { id: 'b3', house: 'asher', month: 'default', amount: 190000, instructorsAmount: null },
    { id: 'b4', house: 'ofroni', month: 'default', amount: 180000 }, // no instructors field
  ];
  assert.equal(instructorsBudgetForHouse(budgets, 'ramot', '2026-07'), 72744); // specific
  assert.equal(instructorsBudgetForHouse(budgets, 'ramot', '2026-08'), 60000); // default
  assert.equal(instructorsBudgetForHouse(budgets, 'asher', '2026-07'), null);  // blank line
  assert.equal(instructorsBudgetForHouse(budgets, 'ofroni', '2026-07'), null); // missing line
  assert.equal(instructorsBudgetForHouse(budgets, 'rehab', '2026-07'), null);  // no house
});

test('instructorsBudgetForHouse: month-specific total with blank instructors falls back to default instructors', () => {
  const budgets = [
    { id: 'b1', house: 'ramot', month: 'default', amount: 200000, instructorsAmount: 60000 },
    { id: 'b2', house: 'ramot', month: '2026-07', amount: 210000, instructorsAmount: null },
  ];
  assert.equal(instructorsBudgetForHouse(budgets, 'ramot', '2026-07'), 60000);
});

test('hasInstructorsBudget: only a finite non-blank value counts', () => {
  assert.equal(hasInstructorsBudget({ instructorsAmount: 0 }), true);
  assert.equal(hasInstructorsBudget({ instructorsAmount: 60000 }), true);
  assert.equal(hasInstructorsBudget({ instructorsAmount: null }), false);
  assert.equal(hasInstructorsBudget({ instructorsAmount: '' }), false);
  assert.equal(hasInstructorsBudget({}), false);
  assert.equal(hasInstructorsBudget(null), false);
});

test('budgetWarning: warns only when instructors exceed total; blank never warns', () => {
  assert.equal(budgetWarning(200000, 72744), null);        // within
  assert.equal(budgetWarning(200000, 200000), null);       // equal is fine
  assert.equal(budgetWarning(200000, null), null);         // blank line
  assert.equal(budgetWarning(200000, ''), null);
  assert.ok(budgetWarning(50000, 60000));                  // instructors > total
  assert.match(budgetWarning(50000, 60000), /מדריכים/);
});
