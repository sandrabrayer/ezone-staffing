'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  HOUSE_IDS, ROLE_OPTIONS, ABSENCE_REASON_TYPES, TERMINATION_REASONS,
  EMPLOYMENT_TYPES,
  SALARY_MAX, HOURLY_RATE_MAX, SESSION_RATE_MAX, RETAINER_MAX,
  EST_HOURS_MAX, EST_SESSIONS_MAX, EXTRA_PAYMENT_MAX,
  isHouse, isRole, isEmploymentType,
  clampPct, clampMoney, clampInt,
  validateWorker, validateAssignment, validateAbsence, validateCoverage,
  validateAction,
} = require('../lib/validate');

// ---------- constants ----------

test('HOUSE_IDS: seven houses incl. pardes, sde_eliezer, hq', () => {
  assert.deepEqual(HOUSE_IDS, [
    'ramot', 'asher', 'ofroni', 'rehab',
    'pardes', 'sde_eliezer',
    'hq',
  ]);
});

test('isHouse: accepts all new house codes', () => {
  // Regression guard for the v3 expansion. If anything breaks the
  // validator's recognition of these specifically, this test fails
  // loudly rather than hiding inside a single assertion above.
  ['pardes', 'sde_eliezer', 'hq'].forEach(id => {
    assert.equal(isHouse(id), true, `expected isHouse('${id}') === true`);
  });
});

test('ROLE_OPTIONS: nine roles', () => {
  assert.equal(ROLE_OPTIONS.length, 9);
  assert.ok(ROLE_OPTIONS.includes('מטפל/ת'));
  assert.ok(ROLE_OPTIONS.includes('אחר'));
});

test('ABSENCE_REASON_TYPES: eight reasons including אישי', () => {
  assert.deepEqual(ABSENCE_REASON_TYPES, [
    'חופשה', 'חל״ת', 'מחלה', 'חופשת לידה', 'ניתוח', 'צורך תפעולי', 'אישי', 'אחר',
  ]);
});

test('TERMINATION_REASONS: five reasons', () => {
  assert.deepEqual(TERMINATION_REASONS, [
    'התפטרות', 'פיטורין', 'סיום חוזה', 'מעבר תפקיד', 'אחר',
  ]);
});

test('EMPLOYMENT_TYPES: five types', () => {
  assert.deepEqual(EMPLOYMENT_TYPES, [
    'full_time', 'part_time', 'hourly', 'per_session', 'fixed_retainer',
  ]);
});

// ---------- predicates ----------

test('isHouse / isRole / isEmploymentType', () => {
  HOUSE_IDS.forEach(id => assert.equal(isHouse(id), true));
  assert.equal(isHouse('bogus'), false);
  assert.equal(isRole('אחות'), true);
  assert.equal(isRole(''), false);
  assert.equal(isEmploymentType('full_time'), true);
  assert.equal(isEmploymentType('weekly'), false);
});

// ---------- clampers ----------

test('clampPct: [1,100]', () => {
  assert.equal(clampPct(0), 1);
  assert.equal(clampPct(101), 100);
  assert.equal(clampPct(75.4), 75);
  assert.equal(clampPct('abc'), 100);
});

test('clampMoney: [0, max]', () => {
  assert.equal(clampMoney(-100, 1000), 0);
  assert.equal(clampMoney(500.6, 1000), 501);
  assert.equal(clampMoney(99999, 1000), 1000);
  assert.equal(clampMoney('abc', 1000), 0);
});

test('clampInt: [0, max]', () => {
  assert.equal(clampInt(-5, 100), 0);
  assert.equal(clampInt(50.7, 100), 51);
  assert.equal(clampInt(1000, 100), 100);
});

// ---------- validateWorker ----------

test('validateWorker: trims and caps', () => {
  const w = validateWorker({ name: '  שחר לוי  ', notes: '  שלום  ' });
  assert.equal(w.name, 'שחר לוי');
  assert.equal(w.notes, 'שלום');
});

test('validateWorker: requires name', () => {
  assert.throws(() => validateWorker({ name: '   ' }), /name required/);
  assert.throws(() => validateWorker({}), /name required/);
  assert.throws(() => validateWorker(null), /worker required/);
});

test('validateWorker: caps long strings', () => {
  const w = validateWorker({ name: 'a'.repeat(200), notes: 'b'.repeat(800) });
  assert.equal(w.name.length, 80);
  assert.equal(w.notes.length, 500);
});

// ---------- validateAssignment ----------

test('validateAssignment: full_time happy path', () => {
  const a = validateAssignment({
    workerId: 'w1', house: 'ramot', role: 'אחות',
    employmentType: 'full_time', salary: 18000.6,
    notes: '  הערה  ',
  });
  assert.equal(a.workerId, 'w1');
  assert.equal(a.house, 'ramot');
  assert.equal(a.role, 'אחות');
  assert.equal(a.employmentType, 'full_time');
  assert.equal(a.salary, 18001);
  assert.equal(a.pct, 0);
  assert.equal(a.notes, 'הערה');
});

test('validateAssignment: part_time keeps salary AND pct', () => {
  const a = validateAssignment({
    workerId: 'w1', house: 'ramot', role: 'אחות',
    employmentType: 'part_time', salary: 12000, pct: 80,
  });
  assert.equal(a.salary, 12000);
  assert.equal(a.pct, 80);
});

test('validateAssignment: part_time clamps unreasonable pct', () => {
  const a = validateAssignment({
    workerId: 'w1', house: 'ramot', role: 'אחות',
    employmentType: 'part_time', salary: 12000, pct: 500,
  });
  assert.equal(a.pct, 100);
});

test('validateAssignment: hourly requires rate and hours', () => {
  const a = validateAssignment({
    workerId: 'w1', house: 'ramot', role: 'מטפל/ת',
    employmentType: 'hourly', hourlyRate: 80, estHours: 120,
  });
  assert.equal(a.hourlyRate, 80);
  assert.equal(a.estHours, 120);

  assert.throws(() => validateAssignment({
    workerId: 'w1', house: 'ramot', role: 'מטפל/ת',
    employmentType: 'hourly', hourlyRate: 0, estHours: 120,
  }), /hourlyRate required/);

  assert.throws(() => validateAssignment({
    workerId: 'w1', house: 'ramot', role: 'מטפל/ת',
    employmentType: 'hourly', hourlyRate: 80, estHours: 0,
  }), /estHours required/);
});

test('validateAssignment: per_session requires rate and sessions', () => {
  const a = validateAssignment({
    workerId: 'w1', house: 'ramot', role: 'פסיכיאטר/ית',
    employmentType: 'per_session', sessionRate: 400, estSessions: 12,
  });
  assert.equal(a.sessionRate, 400);
  assert.equal(a.estSessions, 12);

  assert.throws(() => validateAssignment({
    workerId: 'w1', house: 'ramot', role: 'פסיכיאטר/ית',
    employmentType: 'per_session', sessionRate: 0, estSessions: 12,
  }), /sessionRate required/);
});

test('validateAssignment: fixed_retainer requires amount', () => {
  const a = validateAssignment({
    workerId: 'w1', house: 'ramot', role: 'אחר', roleDetail: 'יועץ',
    employmentType: 'fixed_retainer', retainerAmount: 4500,
  });
  assert.equal(a.retainerAmount, 4500);

  assert.throws(() => validateAssignment({
    workerId: 'w1', house: 'ramot', role: 'אחר', roleDetail: 'יועץ',
    employmentType: 'fixed_retainer',
  }), /retainerAmount required/);
});

test('validateAssignment: rejects positive cost fields not allowed by the chosen type', () => {
  // The validator was previously permissive (silently zeroed foreign
  // fields). v3 tightens it: any cost field outside the type's allowed
  // set must be absent / null / '' / 0. A positive value is a 400.
  // This catches inconsistent UIs and hostile clients that mix
  // incompatible terms, e.g. type=full_time + hourlyRate=80.
  const baseFT = {
    workerId: 'w1', house: 'ramot', role: 'אחות',
    employmentType: 'full_time', salary: 18000,
  };
  assert.throws(() => validateAssignment({ ...baseFT, pct: 80 }),
    /pct not allowed for employmentType=full_time/);
  assert.throws(() => validateAssignment({ ...baseFT, hourlyRate: 80 }),
    /hourlyRate not allowed for employmentType=full_time/);
  assert.throws(() => validateAssignment({ ...baseFT, retainerAmount: 5000 }),
    /retainerAmount not allowed for employmentType=full_time/);

  const basePT = { ...baseFT, employmentType: 'part_time', pct: 80 };
  assert.throws(() => validateAssignment({ ...basePT, hourlyRate: 80 }),
    /hourlyRate not allowed for employmentType=part_time/);

  const baseH = {
    workerId: 'w1', house: 'ramot', role: 'אחות',
    employmentType: 'hourly', hourlyRate: 80, estHours: 120,
  };
  assert.throws(() => validateAssignment({ ...baseH, salary: 18000 }),
    /salary not allowed for employmentType=hourly/);
  assert.throws(() => validateAssignment({ ...baseH, sessionRate: 200 }),
    /sessionRate not allowed for employmentType=hourly/);

  const baseS = {
    workerId: 'w1', house: 'ramot', role: 'מטפל/ת', roleDetail: 'אמנות',
    employmentType: 'per_session', sessionRate: 280, estSessions: 16,
  };
  assert.throws(() => validateAssignment({ ...baseS, salary: 5000 }),
    /salary not allowed for employmentType=per_session/);
  assert.throws(() => validateAssignment({ ...baseS, hourlyRate: 80 }),
    /hourlyRate not allowed for employmentType=per_session/);
  assert.throws(() => validateAssignment({ ...baseS, retainerAmount: 1000 }),
    /retainerAmount not allowed for employmentType=per_session/);

  const baseR = {
    workerId: 'w1', house: 'ramot', role: 'פסיכיאטר/ית',
    employmentType: 'fixed_retainer', retainerAmount: 8000,
  };
  assert.throws(() => validateAssignment({ ...baseR, salary: 5000 }),
    /salary not allowed for employmentType=fixed_retainer/);
  assert.throws(() => validateAssignment({ ...baseR, sessionRate: 200 }),
    /sessionRate not allowed for employmentType=fixed_retainer/);
});

test('validateAssignment: 0 / null / undefined / "" for foreign fields is fine', () => {
  // Migration mappers (lib/migrate.js) emit assignments with every
  // non-applicable cost field set to 0. The strict guard must let
  // those through — only positive values are rejected.
  const passes = [
    { hourlyRate: 0,          estHours: 0,         sessionRate: 0,         estSessions: 0,        retainerAmount: 0,         pct: 0 },
    { hourlyRate: null,       estHours: undefined, sessionRate: '',        estSessions: 0,        retainerAmount: undefined, pct: null },
    { /* no foreign fields at all */ },
  ];
  for (const extra of passes) {
    const v = validateAssignment({
      workerId: 'w1', house: 'ramot', role: 'אחות',
      employmentType: 'full_time', salary: 18000,
      ...extra,
    });
    assert.equal(v.employmentType, 'full_time');
    assert.equal(v.salary, 18000);
    // The validator still clears every non-relevant field on the way
    // out — strictness is about REJECTING positives, not about
    // accepting "weird-but-zero" through unchanged.
    assert.equal(v.pct, 0);
    assert.equal(v.hourlyRate, 0);
    assert.equal(v.estHours, 0);
    assert.equal(v.sessionRate, 0);
    assert.equal(v.estSessions, 0);
    assert.equal(v.retainerAmount, 0);
  }
});

test('validateAssignment: bad employmentType / role / house', () => {
  const base = { workerId: 'w1', house: 'ramot', role: 'אחות', employmentType: 'full_time', salary: 1 };
  assert.throws(() => validateAssignment({ ...base, employmentType: 'weekly' }), /bad employmentType/);
  assert.throws(() => validateAssignment({ ...base, role: 'מנהל בית' }), /bad role/);
  assert.throws(() => validateAssignment({ ...base, house: 'bogus' }), /unknown house/);
  assert.throws(() => validateAssignment({ ...base, workerId: '' }), /workerId required/);
});

test('validateAssignment: role=אחר requires roleDetail', () => {
  assert.throws(() => validateAssignment({
    workerId: 'w1', house: 'ramot', role: 'אחר',
    employmentType: 'full_time', salary: 1000,
  }), /roleDetail required/);
});

test('validateAssignment: caps long notes / roleDetail / clamps cap on money', () => {
  const a = validateAssignment({
    workerId: 'w1', house: 'ramot', role: 'אחר',
    roleDetail: 'b'.repeat(200),
    employmentType: 'full_time', salary: SALARY_MAX * 10,
    notes: 'c'.repeat(800),
  });
  assert.equal(a.roleDetail.length, 80);
  assert.equal(a.notes.length, 500);
  assert.equal(a.salary, SALARY_MAX);
});

test('validateAssignment: caps hourly/session/retainer values', () => {
  const a = validateAssignment({
    workerId: 'w1', house: 'ramot', role: 'מטפל/ת',
    employmentType: 'hourly', hourlyRate: HOURLY_RATE_MAX * 5, estHours: EST_HOURS_MAX * 5,
  });
  assert.equal(a.hourlyRate, HOURLY_RATE_MAX);
  assert.equal(a.estHours, EST_HOURS_MAX);

  const b = validateAssignment({
    workerId: 'w1', house: 'ramot', role: 'פסיכיאטר/ית',
    employmentType: 'per_session', sessionRate: SESSION_RATE_MAX * 5, estSessions: EST_SESSIONS_MAX * 5,
  });
  assert.equal(b.sessionRate, SESSION_RATE_MAX);
  assert.equal(b.estSessions, EST_SESSIONS_MAX);

  const c = validateAssignment({
    workerId: 'w1', house: 'ramot', role: 'אחר', roleDetail: 'יועץ',
    employmentType: 'fixed_retainer', retainerAmount: RETAINER_MAX * 5,
  });
  assert.equal(c.retainerAmount, RETAINER_MAX);
});

// ---------- validateAbsence ----------

test('validateAbsence: happy path', () => {
  const a = validateAbsence({
    workerId: 'w1', house: 'ramot',
    startDate: '2026-05-20', endDate: '2026-05-30',
    reasonType: 'מחלה', reasonDetail: 'שפעת', notes: 'נחה בבית',
  });
  assert.equal(a.workerId, 'w1');
  assert.equal(a.house, 'ramot');
  assert.equal(a.startDate, '2026-05-20');
  assert.equal(a.endDate, '2026-05-30');
  assert.equal(a.reasonType, 'מחלה');
  assert.equal(a.reasonDetail, 'שפעת');
  assert.equal(a.notes, 'נחה בבית');
});

test('validateAbsence: accepts new אישי reason', () => {
  const a = validateAbsence({
    workerId: 'w1', house: 'ramot',
    startDate: '2026-05-20', endDate: '2026-05-20',
    reasonType: 'אישי',
  });
  assert.equal(a.reasonType, 'אישי');
});

test('validateAbsence: rejects bad fields', () => {
  const base = {
    workerId: 'w1', house: 'ramot',
    startDate: '2026-05-20', endDate: '2026-05-30',
    reasonType: 'מחלה',
  };
  assert.throws(() => validateAbsence({ ...base, workerId: '' }), /workerId required/);
  assert.throws(() => validateAbsence({ ...base, house: 'bogus' }), /unknown house/);
  assert.throws(() => validateAbsence({ ...base, reasonType: 'אקראי' }), /bad reasonType/);
  assert.throws(() => validateAbsence({ ...base, startDate: '20/5/26' }), /bad startDate/);
  assert.throws(() => validateAbsence({ ...base, endDate: '' }), /missing endDate/);
  assert.throws(() => validateAbsence({ ...base, endDate: '2026-05-10' }), /endDate before startDate/);
});

test('validateAbsence: caps long free text', () => {
  const a = validateAbsence({
    workerId: 'w1', house: 'ramot',
    startDate: '2026-05-20', endDate: '2026-05-20',
    reasonType: 'מחלה', reasonDetail: 'a'.repeat(800), notes: 'b'.repeat(800),
  });
  assert.equal(a.reasonDetail.length, 500);
  assert.equal(a.notes.length, 500);
});

// ---------- validateCoverage ----------

test('validateCoverage: happy path', () => {
  const c = validateCoverage({
    absenceId: 'ab1', coveringWorkerId: 'w2',
    providingHouse: 'asher', extraPayment: 1500, notes: 'עזר במשמרת',
  });
  assert.equal(c.absenceId, 'ab1');
  assert.equal(c.coveringWorkerId, 'w2');
  assert.equal(c.providingHouse, 'asher');
  assert.equal(c.extraPayment, 1500);
  assert.equal(c.notes, 'עזר במשמרת');
});

test('validateCoverage: rejects bad fields', () => {
  const base = { absenceId: 'ab1', coveringWorkerId: 'w2', providingHouse: 'asher' };
  assert.throws(() => validateCoverage({ ...base, absenceId: '' }), /absenceId required/);
  assert.throws(() => validateCoverage({ ...base, coveringWorkerId: '' }), /coveringWorkerId required/);
  assert.throws(() => validateCoverage({ ...base, providingHouse: 'bogus' }), /unknown providingHouse/);
});

test('validateCoverage: clamps extraPayment', () => {
  const c = validateCoverage({
    absenceId: 'ab1', coveringWorkerId: 'w2',
    providingHouse: 'asher', extraPayment: EXTRA_PAYMENT_MAX * 5,
  });
  assert.equal(c.extraPayment, EXTRA_PAYMENT_MAX);

  const c2 = validateCoverage({
    absenceId: 'ab1', coveringWorkerId: 'w2',
    providingHouse: 'asher', extraPayment: -500,
  });
  assert.equal(c2.extraPayment, 0);
});

test('validateCoverage: caps long notes', () => {
  const c = validateCoverage({
    absenceId: 'ab1', coveringWorkerId: 'w2',
    providingHouse: 'asher', notes: 'x'.repeat(800),
  });
  assert.equal(c.notes.length, 500);
});

// ---------- validateAction ----------

test('validateAction: createWorker', () => {
  const p = validateAction({ action: 'createWorker', worker: { name: 'דנה' } });
  assert.equal(p.action, 'createWorker');
  assert.equal(p.worker.name, 'דנה');
});

test('validateAction: updateWorker requires id', () => {
  assert.throws(() => validateAction({
    action: 'updateWorker',
    worker: { name: 'X' },
  }), /missing id/);
});

test('validateAction: deleteWorker / deleteAssignment / deleteAbsence / deleteCoverage require id', () => {
  ['deleteWorker', 'deleteAssignment', 'deleteAbsence', 'deleteCoverage'].forEach(action => {
    assert.throws(() => validateAction({ action }), /missing id/);
    const p = validateAction({ action, id: 'x1' });
    assert.equal(p.id, 'x1');
  });
});

test('validateAction: addAssignment / updateAssignment', () => {
  const assignment = {
    workerId: 'w1', house: 'ramot', role: 'אחות',
    employmentType: 'full_time', salary: 18000,
  };
  const add = validateAction({ action: 'addAssignment', assignment });
  assert.equal(add.action, 'addAssignment');
  assert.equal(add.assignment.workerId, 'w1');

  const upd = validateAction({ action: 'updateAssignment', id: 'a1', assignment });
  assert.equal(upd.id, 'a1');
});

test('validateAction: terminateAssignment happy path + future date', () => {
  const p = validateAction({
    action: 'terminateAssignment',
    id: 'a1',
    terminationDate: '2099-12-31',
    reasonType: 'התפטרות',
    reasonDetail: 'מעבר למקום אחר',
  });
  assert.equal(p.terminationDate, '2099-12-31');
  assert.equal(p.reasonType, 'התפטרות');
  assert.equal(p.reasonDetail, 'מעבר למקום אחר');
});

test('validateAction: terminateAssignment accepts missing reason', () => {
  const p = validateAction({
    action: 'terminateAssignment',
    id: 'a1',
    terminationDate: '2026-05-31',
  });
  assert.equal(p.reasonType, '');
  assert.equal(p.reasonDetail, '');
});

test('validateAction: terminateAssignment rejects bad inputs', () => {
  assert.throws(() => validateAction({
    action: 'terminateAssignment',
    id: 'a1',
    terminationDate: '2026-05-31',
    reasonType: 'מומצא',
  }), /bad reasonType/);

  assert.throws(() => validateAction({
    action: 'terminateAssignment',
    id: 'a1',
    terminationDate: '31/05/2026',
  }), /bad terminationDate/);

  assert.throws(() => validateAction({
    action: 'terminateAssignment',
    terminationDate: '2026-05-31',
  }), /missing id/);
});

test('validateAction: logAbsence + endAbsence', () => {
  const log = validateAction({
    action: 'logAbsence',
    absence: {
      workerId: 'w1', house: 'ramot',
      startDate: '2026-05-20', endDate: '2026-05-25',
      reasonType: 'מחלה',
    },
  });
  assert.equal(log.action, 'logAbsence');
  assert.equal(log.absence.workerId, 'w1');

  const end = validateAction({ action: 'endAbsence', id: 'ab1' });
  assert.equal(end.id, 'ab1');
});

test('validateAction: addCoverage', () => {
  const p = validateAction({
    action: 'addCoverage',
    coverage: {
      absenceId: 'ab1', coveringWorkerId: 'w2',
      providingHouse: 'asher', extraPayment: 1200,
    },
  });
  assert.equal(p.action, 'addCoverage');
  assert.equal(p.coverage.absenceId, 'ab1');
});

test('validateAction: legacy v2 actions are no longer recognized', () => {
  ['addEmployee', 'updateEmployee', 'deleteEmployee',
   'startCoverage', 'endCoverage', 'terminateEmployee',
   'moveEmployee'].forEach(action => {
    assert.throws(() => validateAction({ action }), /unknown action/);
  });
});

test('validateAction: rejects empty / missing body', () => {
  assert.throws(() => validateAction(null), /body required/);
  assert.throws(() => validateAction({}), /unknown action/);
});
