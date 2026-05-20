'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateEmployee,
  validateAction,
  clampPct,
  isHouse,
  HOUSE_IDS,
  REASON_TYPES,
} = require('../lib/validate');

test('isHouse: known and unknown', () => {
  HOUSE_IDS.forEach(id => assert.equal(isHouse(id), true));
  assert.equal(isHouse('bogus'), false);
  assert.equal(isHouse(''), false);
  assert.equal(isHouse(undefined), false);
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

test('validateEmployee: trims and clamps', () => {
  const e = validateEmployee({
    name: '  שחר לוי  ',
    role: '  מנהל בית  ',
    salary: '24000.6',
    pct: 150,
    notes: '  הערה  ',
  });
  assert.equal(e.name, 'שחר לוי');
  assert.equal(e.role, 'מנהל בית');
  assert.equal(e.salary, 24001);
  assert.equal(e.pct, 100);
  assert.equal(e.notes, 'הערה');
});

test('validateEmployee: requires name', () => {
  assert.throws(() => validateEmployee({ name: '   ' }), /name required/);
  assert.throws(() => validateEmployee({}), /name required/);
});

test('validateEmployee: caps long strings', () => {
  const e = validateEmployee({
    name: 'a'.repeat(200),
    role: 'b'.repeat(200),
    notes: 'c'.repeat(800),
    salary: 1000,
    pct: 100,
  });
  assert.equal(e.name.length, 80);
  assert.equal(e.role.length, 80);
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
});

test('validateAction: rejects unknown house', () => {
  assert.throws(() => validateAction({
    action: 'addEmployee',
    house: 'nope',
    employee: { name: 'x' },
  }), /unknown house/);
});

test('validateAction: updateEmployee requires id', () => {
  assert.throws(() => validateAction({
    action: 'updateEmployee',
    house: 'ramot',
    employee: { name: 'x' },
  }), /missing id/);
});

test('validateAction: moveEmployee happy path', () => {
  const p = validateAction({
    action: 'moveEmployee',
    fromHouse: 'ramot',
    toHouse: 'asher',
    id: 'e1',
    reasonType: 'כיסוי חוסר',
    reason: 'מחליפה',
    date: '2026-05-20',
  });
  assert.equal(p.action, 'moveEmployee');
  assert.equal(p.fromHouse, 'ramot');
  assert.equal(p.toHouse, 'asher');
  assert.equal(p.reasonType, 'כיסוי חוסר');
  assert.equal(p.date, '2026-05-20');
});

test('validateAction: moveEmployee rejects same source and target', () => {
  assert.throws(() => validateAction({
    action: 'moveEmployee',
    fromHouse: 'ramot', toHouse: 'ramot',
    id: 'e1', reasonType: 'כיסוי חוסר',
  }), /same/);
});

test('validateAction: moveEmployee rejects bad reasonType', () => {
  assert.throws(() => validateAction({
    action: 'moveEmployee',
    fromHouse: 'ramot', toHouse: 'asher',
    id: 'e1', reasonType: 'בלה',
  }), /reasonType/);
});

test('validateAction: moveEmployee rejects malformed date', () => {
  assert.throws(() => validateAction({
    action: 'moveEmployee',
    fromHouse: 'ramot', toHouse: 'asher',
    id: 'e1', reasonType: 'כיסוי חוסר', date: '20/5/26',
  }), /bad date/);
});

test('validateAction: moveEmployee defaults date to today if empty', () => {
  const today = new Date().toISOString().slice(0, 10);
  const p = validateAction({
    action: 'moveEmployee',
    fromHouse: 'ramot', toHouse: 'asher',
    id: 'e1', reasonType: 'כיסוי חוסר',
  });
  assert.equal(p.date, today);
});

test('validateAction: rejects unknown action', () => {
  assert.throws(() => validateAction({ action: 'nope' }), /unknown action/);
});

test('REASON_TYPES exposes the four reasons', () => {
  assert.deepEqual(REASON_TYPES, ['כיסוי חוסר', 'העברה קבועה', 'צורך תפעולי', 'אחר']);
});
