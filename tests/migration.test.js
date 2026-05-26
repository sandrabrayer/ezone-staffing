'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ABSENCE_REASON_TYPES,
  MIGRATION_NOTE_NO_ABSENTEE,
  MIGRATION_NOTE_COVERAGE,
  legacyTermsFromPct,
  mapLegacyEmployeeToAssignment,
  mapLegacyEventToAbsenceCoverage,
  mapLegacyArchiveRow,
  collectWorkers,
} = require('../lib/migrate');

// ---------- legacyTermsFromPct ----------

test('legacyTermsFromPct: pct=100 → full_time, pct stored as 0', () => {
  assert.deepEqual(
    legacyTermsFromPct(18000, 100),
    { employmentType: 'full_time', salary: 18000, pct: 0 },
  );
});

test('legacyTermsFromPct: pct<100 → part_time, pct preserved', () => {
  assert.deepEqual(
    legacyTermsFromPct(12000, 80),
    { employmentType: 'part_time', salary: 12000, pct: 80 },
  );
});

test('legacyTermsFromPct: pct=0 → part_time with pct=1 (validator-safe)', () => {
  // The v3 part_time validator requires pct ≥ 1. Legacy data with pct=0
  // gets bumped so re-validating the migrated row doesn't throw.
  assert.deepEqual(
    legacyTermsFromPct(5000, 0),
    { employmentType: 'part_time', salary: 5000, pct: 1 },
  );
});

test('legacyTermsFromPct: rounds salary and clamps pct', () => {
  assert.deepEqual(
    legacyTermsFromPct(18000.6, 250),
    { employmentType: 'full_time', salary: 18001, pct: 0 },
  );
  assert.deepEqual(
    legacyTermsFromPct(-100, -10),
    { employmentType: 'part_time', salary: 0, pct: 1 },
  );
});

test('legacyTermsFromPct: NaN inputs → 0 salary, part_time pct=1', () => {
  assert.deepEqual(
    legacyTermsFromPct('abc', 'def'),
    { employmentType: 'part_time', salary: 0, pct: 1 },
  );
});

// ---------- mapLegacyEmployeeToAssignment ----------

test('mapLegacyEmployeeToAssignment: full_time happy path', () => {
  const emp = {
    id: 'eABC', name: 'דנה', role: 'אחות',
    salary: 18000, pct: 100, notes: 'בית רמות',
    roleDetail: '',
  };
  const a = mapLegacyEmployeeToAssignment(emp, 'ramot');
  assert.equal(a.workerId, 'eABC');
  assert.equal(a.house, 'ramot');
  assert.equal(a.role, 'אחות');
  assert.equal(a.employmentType, 'full_time');
  assert.equal(a.salary, 18000);
  assert.equal(a.pct, 0);
  assert.equal(a.notes, 'בית רמות');
  // Freelance fields zeroed
  assert.equal(a.hourlyRate, 0);
  assert.equal(a.estHours, 0);
  assert.equal(a.sessionRate, 0);
  assert.equal(a.estSessions, 0);
  assert.equal(a.retainerAmount, 0);
});

test('mapLegacyEmployeeToAssignment: part_time preserves pct', () => {
  const emp = {
    id: 'eXYZ', name: 'יוסי', role: 'מטפל/ת',
    salary: 12000, pct: 75, notes: '', roleDetail: 'אמנות',
  };
  const a = mapLegacyEmployeeToAssignment(emp, 'asher');
  assert.equal(a.employmentType, 'part_time');
  assert.equal(a.salary, 12000);
  assert.equal(a.pct, 75);
  assert.equal(a.roleDetail, 'אמנות');
});

test('mapLegacyEmployeeToAssignment: null input → null', () => {
  assert.equal(mapLegacyEmployeeToAssignment(null, 'ramot'), null);
});

test('mapLegacyEmployeeToAssignment: round-trips through validateAssignment', () => {
  const { validateAssignment } = require('../lib/validate');
  const emp = {
    id: 'eRT', name: 'X', role: 'אחות',
    salary: 12345.6, pct: 80, notes: '  N  ', roleDetail: '',
  };
  const mapped = mapLegacyEmployeeToAssignment(emp, 'ramot');
  // Should not throw.
  const validated = validateAssignment(mapped);
  assert.equal(validated.employmentType, 'part_time');
  assert.equal(validated.salary, 12346);
  assert.equal(validated.pct, 80);
});

// ---------- mapLegacyEventToAbsenceCoverage ----------

test('mapLegacyEventToAbsenceCoverage: with covers_employee_id', () => {
  // e1 from ramot helped asher cover for e7.
  const ev = {
    id: 'ev1', employeeId: 'e1', employeeName: 'יוסי',
    homeHouse: 'ramot', hostHouse: 'asher',
    startDate: '2026-05-01', endDate: '2026-05-15',
    reasonType: 'חופשה', reasonDetail: 'חופשה שנתית',
    coversEmployeeId: 'e7', bonusAmount: 2000,
    status: 'active', createdAt: '2026-05-01T08:00:00.000Z',
  };
  const { absence, coverage } = mapLegacyEventToAbsenceCoverage(ev);
  // Absence: e7 is absent FROM asher (the house needing coverage).
  assert.equal(absence.workerId, 'e7');
  assert.equal(absence.house, 'asher');
  assert.equal(absence.startDate, '2026-05-01');
  assert.equal(absence.endDate, '2026-05-15');
  assert.equal(absence.reasonType, 'חופשה');
  assert.equal(absence.reasonDetail, 'חופשה שנתית');
  assert.equal(absence.notes, '');   // not a stub — real absentee
  assert.equal(absence.status, 'active');
  // Coverage: e1 from ramot is helping asher. v3.1 shape — coveringHouse,
  // receivingHouse, dates, all first-class.
  assert.equal(coverage.coveringWorkerId, 'e1');
  assert.equal(coverage.coveringHouse, 'ramot');
  assert.equal(coverage.receivingHouse, 'asher');
  assert.equal(coverage.startDate, '2026-05-01');
  assert.equal(coverage.endDate, '2026-05-15');
  assert.equal(coverage.extraPayment, 2000);
  assert.equal(coverage.notes, MIGRATION_NOTE_COVERAGE);
  assert.equal(coverage.absenceId, ''); // filled by writer
});

test('mapLegacyEventToAbsenceCoverage: without covers_employee_id → stub absence', () => {
  // Legacy event that didn't record who was being covered for. The
  // coverage still carries receivingHouse + dates directly (v3.1), so
  // it remains valid on its own even without the FK pairing.
  const ev = {
    id: 'ev2', employeeId: 'e1',
    homeHouse: 'ramot', hostHouse: 'asher',
    startDate: '2026-05-01', endDate: '2026-05-15',
    reasonType: 'מחלה', reasonDetail: '',
    coversEmployeeId: '', bonusAmount: 1500,
    status: 'ended',
  };
  const { absence, coverage } = mapLegacyEventToAbsenceCoverage(ev);
  assert.equal(absence.workerId, '');
  assert.equal(absence.house, 'asher');
  assert.equal(absence.notes, MIGRATION_NOTE_NO_ABSENTEE);
  assert.equal(absence.status, 'ended');
  // Coverage carries the extra_payment cost record + the receivingHouse
  // / dates needed to attribute it.
  assert.equal(coverage.coveringWorkerId, 'e1');
  assert.equal(coverage.coveringHouse, 'ramot');
  assert.equal(coverage.receivingHouse, 'asher');
  assert.equal(coverage.startDate, '2026-05-01');
  assert.equal(coverage.endDate, '2026-05-15');
  assert.equal(coverage.extraPayment, 1500);
});

test('mapLegacyEventToAbsenceCoverage: unknown reason → אחר', () => {
  // v1 had different reasonTypes (e.g., 'העברה קבועה'). Unknown values
  // collapse to 'אחר' so migration is lossless to the closed v3 set.
  const ev = {
    id: 'ev3', employeeId: 'e1', homeHouse: 'ramot', hostHouse: 'asher',
    startDate: '2026-05-01', endDate: '2026-05-15',
    reasonType: 'העברה קבועה', coversEmployeeId: 'e7',
    bonusAmount: 0, status: 'ended',
  };
  const { absence } = mapLegacyEventToAbsenceCoverage(ev);
  assert.equal(absence.reasonType, 'אחר');
});

test('mapLegacyEventToAbsenceCoverage: status defaults to ended when not "active"', () => {
  const ev = {
    employeeId: 'e1', homeHouse: 'ramot', hostHouse: 'asher',
    startDate: '2026-05-01', endDate: '2026-05-15',
    reasonType: 'מחלה', coversEmployeeId: 'e7',
    bonusAmount: 0, status: '',
  };
  const { absence } = mapLegacyEventToAbsenceCoverage(ev);
  assert.equal(absence.status, 'ended');
});

test('mapLegacyEventToAbsenceCoverage: bonus rounds + clamps to ≥ 0', () => {
  const { coverage } = mapLegacyEventToAbsenceCoverage({
    employeeId: 'e1', homeHouse: 'ramot', hostHouse: 'asher',
    startDate: '2026-05-01', endDate: '2026-05-15',
    reasonType: 'מחלה', coversEmployeeId: 'e7',
    bonusAmount: -100, status: 'ended',
  });
  assert.equal(coverage.extraPayment, 0);

  const { coverage: c2 } = mapLegacyEventToAbsenceCoverage({
    employeeId: 'e1', homeHouse: 'ramot', hostHouse: 'asher',
    startDate: '2026-05-01', endDate: '2026-05-15',
    reasonType: 'מחלה', coversEmployeeId: 'e7',
    bonusAmount: 1499.6, status: 'ended',
  });
  assert.equal(c2.extraPayment, 1500);
});

test('mapLegacyEventToAbsenceCoverage: null → null', () => {
  assert.equal(mapLegacyEventToAbsenceCoverage(null), null);
});

// ---------- mapLegacyArchiveRow ----------

test('mapLegacyArchiveRow: copies frozen terms + termination metadata', () => {
  const arch = {
    id: 'arc1', employeeId: 'e9', name: 'גילה',
    role: 'אחות', roleDetail: '',
    salary: 22000, pct: 100, notes: '',
    homeHouse: 'ofroni', terminationDate: '2026-04-30',
    reasonType: 'התפטרות', reasonDetail: 'מצאה משרה אחרת',
    archivedAt: '2026-04-25T08:00:00.000Z',
  };
  const out = mapLegacyArchiveRow(arch);
  assert.equal(out.assignmentId, '');
  assert.equal(out.workerId, 'e9');
  assert.equal(out.name, 'גילה');
  assert.equal(out.house, 'ofroni');
  assert.equal(out.employmentType, 'full_time');
  assert.equal(out.salary, 22000);
  assert.equal(out.pct, 0);
  assert.equal(out.terminationDate, '2026-04-30');
  assert.equal(out.reasonType, 'התפטרות');
  assert.equal(out.archivedAt, '2026-04-25T08:00:00.000Z');
});

test('mapLegacyArchiveRow: part_time archive row preserves pct', () => {
  const out = mapLegacyArchiveRow({
    id: 'arc2', employeeId: 'e10', name: 'בני',
    role: 'מטפל/ת', roleDetail: 'אמנות',
    salary: 10000, pct: 60, notes: '',
    homeHouse: 'rehab', terminationDate: '2026-06-30',
    reasonType: '', reasonDetail: '', archivedAt: '',
  });
  assert.equal(out.employmentType, 'part_time');
  assert.equal(out.pct, 60);
});

// ---------- collectWorkers ----------

test('collectWorkers: de-dups across houses; house-name beats archive', () => {
  const houses = {
    ramot: [{ id: 'eA', name: 'אריאל' }, { id: 'eB', name: 'בן' }],
    asher: [{ id: 'eC', name: 'גלית' }],
    ofroni: [],
    rehab: [{ id: 'eA', name: 'אריאל-משנה' }], // dup — first wins
  };
  const archive = [
    { employeeId: 'eA', name: 'אריאל-ארכיון' }, // dup — house wins
    { employeeId: 'eD', name: 'דליה' },          // only in archive
  ];
  const workers = collectWorkers({ houses, archive });
  const byId = {};
  workers.forEach(w => { byId[w.id] = w.name; });
  assert.deepEqual(Object.keys(byId).sort(), ['eA', 'eB', 'eC', 'eD']);
  assert.equal(byId.eA, 'אריאל'); // house-tab name wins
  assert.equal(byId.eD, 'דליה');   // archive-only worker still included
});

test('collectWorkers: skips blank ids', () => {
  const workers = collectWorkers({
    houses: { ramot: [{ id: '', name: 'no-id' }, { id: 'eX', name: 'X' }] },
    archive: [{ employeeId: '   ', name: 'blank' }],
  });
  assert.deepEqual(workers.map(w => w.id), ['eX']);
});

test('collectWorkers: empty input → empty list', () => {
  assert.deepEqual(collectWorkers({ houses: {}, archive: [] }), []);
  assert.deepEqual(collectWorkers({ houses: {}, archive: null }), []);
  assert.deepEqual(collectWorkers({}), []);
});

// ---------- end-to-end ----------

test('end-to-end: synthetic legacy Sheet → mapped v3 entities', () => {
  // A minimal but realistic legacy dataset. Mirrors what migrateToV3()
  // would read from a real v2 Sheet.
  const houses = {
    ramot: [
      { id: 'e1', name: 'דנה', role: 'אחות', salary: 18000, pct: 100, notes: '', roleDetail: '' },
      { id: 'e2', name: 'יוסי', role: 'מטפל/ת', salary: 12000, pct: 80, notes: '', roleDetail: 'אמנות' },
    ],
    asher: [
      { id: 'e3', name: 'מורן', role: 'מנהל/ת', salary: 28000, pct: 100, notes: '', roleDetail: '' },
    ],
    ofroni: [],
    rehab: [],
  };
  const events = [
    {
      id: 'ev1', employeeId: 'e1', homeHouse: 'ramot', hostHouse: 'asher',
      startDate: '2026-04-01', endDate: '2026-04-15',
      reasonType: 'חופשה', reasonDetail: 'חופשה שנתית',
      coversEmployeeId: 'e3', bonusAmount: 2000, status: 'ended',
    },
    {
      id: 'ev2', employeeId: 'e2', homeHouse: 'ramot', hostHouse: 'asher',
      startDate: '2026-05-01', endDate: '2026-05-10',
      reasonType: 'מחלה', reasonDetail: '',
      coversEmployeeId: '', bonusAmount: 800, status: 'ended',
    },
  ];
  const archive = [
    {
      id: 'arc1', employeeId: 'e9', name: 'גילה',
      role: 'אחות', roleDetail: '',
      salary: 22000, pct: 100, notes: '',
      homeHouse: 'ofroni', terminationDate: '2026-03-30',
      reasonType: 'התפטרות', reasonDetail: '', archivedAt: '',
    },
  ];

  const workers = collectWorkers({ houses, archive });
  const assignments = [];
  Object.keys(houses).forEach(h => {
    houses[h].forEach(emp => assignments.push(mapLegacyEmployeeToAssignment(emp, h)));
  });
  const absences = [];
  const coverages = [];
  events.forEach(ev => {
    const pair = mapLegacyEventToAbsenceCoverage(ev);
    absences.push(pair.absence);
    coverages.push(pair.coverage);
  });
  const archiveV3 = archive.map(mapLegacyArchiveRow);

  // 4 unique workers: e1, e2, e3 (from houses), e9 (from archive)
  assert.equal(workers.length, 4);
  // 3 assignments total
  assert.equal(assignments.length, 3);
  // 2 events → 2 absences + 2 coverages
  assert.equal(absences.length, 2);
  assert.equal(coverages.length, 2);
  // Stub absence on the event without coversEmployeeId
  assert.equal(absences[1].workerId, '');
  assert.equal(absences[1].notes, MIGRATION_NOTE_NO_ABSENTEE);
  // Archive carries forward
  assert.equal(archiveV3.length, 1);
  assert.equal(archiveV3[0].workerId, 'e9');
});

test('ABSENCE_REASON_TYPES matches lib/validate.js', () => {
  const validate = require('../lib/validate');
  assert.deepEqual(ABSENCE_REASON_TYPES, validate.ABSENCE_REASON_TYPES);
});
