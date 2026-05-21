'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateEmployee,
  validateAction,
  clampPct,
  clampBonus,
  isHouse,
  isRole,
  HOUSE_IDS,
  ROLE_OPTIONS,
  REASON_TYPES,
} = require('../lib/validate');

test('isHouse: known and unknown', () => {
  HOUSE_IDS.forEach(id => assert.equal(isHouse(id), true));
  assert.equal(isHouse('bogus'), false);
  assert.equal(isHouse(''), false);
  assert.equal(isHouse(undefined), false);
});

test('isRole: known and unknown', () => {
  assert.equal(isRole('אחות'), true);
  assert.equal(isRole('מטפל/ת'), true);
  assert.equal(isRole('אחר'), true);
  assert.equal(isRole('מנהל בית'), false); // legacy free-text not in dropdown
  assert.equal(isRole(''), false);
});

test('clampPct: clamps to [1,100]', () => {
  assert.equal(clampPct(0), 1);
  assert.equal(clampPct(-50), 1);
  assert.equal(clampPct(101), 100);
  assert.equal(clampPct(75.4), 75);
  assert.equal(clampPct('80'), 80);
  assert.equal(clampPct('abc'), 100);
  assert.equal(clampPct(NaN), 100);
});

test('clampBonus: clamps to [0,100000]', () => {
  assert.equal(clampBonus(0), 0);
  assert.equal(clampBonus(-100), 0);
  assert.equal(clampBonus(2000), 2000);
  assert.equal(clampBonus(2000.6), 2001);
  assert.equal(clampBonus(999999), 100000);
  assert.equal(clampBonus('1500'), 1500);
  assert.equal(clampBonus('abc'), 0);
  assert.equal(clampBonus(NaN), 0);
});

test('validateEmployee: trims and clamps with role from dropdown', () => {
  const e = validateEmployee({
    name: '  שחר לוי  ',
    role: 'מנהל/ת',
    roleDetail: '  ',
    salary: '24000.6',
    pct: 150,
    notes: '  הערה  ',
  });
  assert.equal(e.name, 'שחר לוי');
  assert.equal(e.role, 'מנהל/ת');
  assert.equal(e.roleDetail, '');
  assert.equal(e.salary, 24001);
  assert.equal(e.pct, 100);
  assert.equal(e.notes, 'הערה');
});

test('validateEmployee: requires name', () => {
  assert.throws(() => validateEmployee({ name: '   ', role: 'אחות' }), /name required/);
  assert.throws(() => validateEmployee({ role: 'אחות' }), /name required/);
});

test('validateEmployee: rejects unknown role', () => {
  assert.throws(() => validateEmployee({ name: 'X', role: 'מנהל בית' }), /bad role/);
  assert.throws(() => validateEmployee({ name: 'X', role: '' }), /bad role/);
});

test('validateEmployee: role=אחר requires roleDetail', () => {
  assert.throws(() => validateEmployee({ name: 'X', role: 'אחר' }), /roleDetail required/);
  const e = validateEmployee({ name: 'X', role: 'אחר', roleDetail: 'מאבטח' });
  assert.equal(e.role, 'אחר');
  assert.equal(e.roleDetail, 'מאבטח');
});

test('validateEmployee: role=מטפל/ת keeps roleDetail when present, allows empty', () => {
  const a = validateEmployee({ name: 'X', role: 'מטפל/ת', roleDetail: 'אמנות' });
  assert.equal(a.roleDetail, 'אמנות');
  const b = validateEmployee({ name: 'X', role: 'מטפל/ת' });
  assert.equal(b.roleDetail, '');
});

test('validateEmployee: caps long strings', () => {
  const e = validateEmployee({
    name: 'a'.repeat(200),
    role: 'אחות',
    roleDetail: 'b'.repeat(200),
    notes: 'c'.repeat(800),
    salary: 1000,
    pct: 100,
  });
  assert.equal(e.name.length, 80);
  assert.equal(e.roleDetail.length, 80);
  assert.equal(e.notes.length, 500);
});

test('validateAction: addEmployee happy path', () => {
  const p = validateAction({
    action: 'addEmployee',
    house: 'ramot',
    employee: { name: 'דנה', role: 'אחות', salary: 18000, pct: 100 },
  });
  assert.equal(p.action, 'addEmployee');
  assert.equal(p.house, 'ramot');
  assert.equal(p.employee.name, 'דנה');
  assert.equal(p.employee.role, 'אחות');
});

test('validateAction: rejects unknown house', () => {
  assert.throws(() => validateAction({
    action: 'addEmployee',
    house: 'nope',
    employee: { name: 'x', role: 'אחות' },
  }), /unknown house/);
});

test('validateAction: updateEmployee requires id', () => {
  assert.throws(() => validateAction({
    action: 'updateEmployee',
    house: 'ramot',
    employee: { name: 'x', role: 'אחות' },
  }), /missing id/);
});

test('validateAction: startCoverage happy path', () => {
  const p = validateAction({
    action: 'startCoverage',
    employeeId: 'e1',
    homeHouse: 'ramot',
    hostHouse: 'asher',
    startDate: '2026-05-20',
    endDate: '2026-06-10',
    reasonType: 'חופשה',
    reasonDetail: 'חופשה שנתית',
    coversEmployeeId: 'e7',
    bonusAmount: 2000,
  });
  assert.equal(p.action, 'startCoverage');
  assert.equal(p.employeeId, 'e1');
  assert.equal(p.homeHouse, 'ramot');
  assert.equal(p.hostHouse, 'asher');
  assert.equal(p.startDate, '2026-05-20');
  assert.equal(p.endDate, '2026-06-10');
  assert.equal(p.reasonType, 'חופשה');
  assert.equal(p.coversEmployeeId, 'e7');
  assert.equal(p.bonusAmount, 2000);
});

test('validateAction: startCoverage rejects same home and host', () => {
  assert.throws(() => validateAction({
    action: 'startCoverage',
    employeeId: 'e1',
    homeHouse: 'ramot', hostHouse: 'ramot',
    startDate: '2026-05-20', endDate: '2026-06-10',
    reasonType: 'חופשה',
  }), /differ/);
});

test('validateAction: startCoverage rejects bad reasonType', () => {
  assert.throws(() => validateAction({
    action: 'startCoverage',
    employeeId: 'e1',
    homeHouse: 'ramot', hostHouse: 'asher',
    startDate: '2026-05-20', endDate: '2026-06-10',
    reasonType: 'מומצא',
  }), /reasonType/);
});

test('validateAction: startCoverage requires dates', () => {
  assert.throws(() => validateAction({
    action: 'startCoverage',
    employeeId: 'e1',
    homeHouse: 'ramot', hostHouse: 'asher',
    reasonType: 'חופשה',
    endDate: '2026-06-10',
  }), /missing startDate/);
  assert.throws(() => validateAction({
    action: 'startCoverage',
    employeeId: 'e1',
    homeHouse: 'ramot', hostHouse: 'asher',
    reasonType: 'חופשה',
    startDate: '2026-05-20',
  }), /missing endDate/);
});

test('validateAction: startCoverage rejects endDate before startDate', () => {
  assert.throws(() => validateAction({
    action: 'startCoverage',
    employeeId: 'e1',
    homeHouse: 'ramot', hostHouse: 'asher',
    startDate: '2026-06-10', endDate: '2026-05-20',
    reasonType: 'חופשה',
  }), /endDate before startDate/);
});

test('validateAction: startCoverage rejects malformed date', () => {
  assert.throws(() => validateAction({
    action: 'startCoverage',
    employeeId: 'e1',
    homeHouse: 'ramot', hostHouse: 'asher',
    startDate: '20/5/26', endDate: '2026-06-10',
    reasonType: 'חופשה',
  }), /bad startDate/);
});

test('validateAction: startCoverage clamps bonus and defaults missing fields', () => {
  const p = validateAction({
    action: 'startCoverage',
    employeeId: 'e1',
    homeHouse: 'ramot', hostHouse: 'asher',
    startDate: '2026-05-20', endDate: '2026-05-20',
    reasonType: 'חופשה',
    bonusAmount: 999999,
  });
  assert.equal(p.bonusAmount, 100000);
  assert.equal(p.reasonDetail, '');
  assert.equal(p.coversEmployeeId, '');
});

test('validateAction: endCoverage happy path', () => {
  const p = validateAction({ action: 'endCoverage', eventId: 'ev123' });
  assert.equal(p.action, 'endCoverage');
  assert.equal(p.eventId, 'ev123');
});

test('validateAction: endCoverage requires eventId', () => {
  assert.throws(() => validateAction({ action: 'endCoverage' }), /missing eventId/);
});

test('validateAction: moveEmployee is no longer recognized', () => {
  assert.throws(() => validateAction({
    action: 'moveEmployee',
    fromHouse: 'ramot', toHouse: 'asher',
    id: 'e1', reasonType: 'חופשה',
  }), /unknown action/);
});

test('validateAction: rejects unknown action', () => {
  assert.throws(() => validateAction({ action: 'nope' }), /unknown action/);
});

test('REASON_TYPES exposes the seven new reasons', () => {
  assert.deepEqual(REASON_TYPES, ['חופשה','חל״ת','מחלה','חופשת לידה','ניתוח','צורך תפעולי','אחר']);
});

test('ROLE_OPTIONS exposes the nine role choices', () => {
  assert.equal(ROLE_OPTIONS.length, 9);
  assert.ok(ROLE_OPTIONS.includes('מטפל/ת'));
  assert.ok(ROLE_OPTIONS.includes('אחר'));
});
