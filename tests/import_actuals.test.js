'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  detectColumns, findHeaderRow, resolveHouse, parseQuantity,
  matchActuals, buildUpsertItems,
} = require('../lib/import_actuals');

const HOUSES = [
  { id: 'ramot', name: 'בית מאזן רמות השבים' },
  { id: 'asher', name: 'איזון רעננה - אשר' },
  { id: 'ofroni', name: 'קיסריה עפרוני' },
  { id: 'rehab', name: 'קיסריה ריהאב' },
];

// Workers — note the deliberately duplicated name "דנה כהן" (w1, w3).
const WORKERS = [
  { id: 'w1', name: 'דנה כהן' },
  { id: 'w2', name: 'יוסי לוי' },
  { id: 'w3', name: 'דנה כהן' },
  { id: 'w4', name: 'רות רון' },
];
const ASSIGNMENTS = [
  { id: 'a1', workerId: 'w1', house: 'ofroni', employmentType: 'hourly', hourlyRate: 60 },
  { id: 'a2', workerId: 'w1', house: 'ramot', employmentType: 'hourly', hourlyRate: 55 },
  { id: 'a3', workerId: 'w2', house: 'asher', employmentType: 'per_session', sessionRate: 400 },
  { id: 'a4', workerId: 'w3', house: 'rehab', employmentType: 'hourly', hourlyRate: 50 },
  { id: 'a5', workerId: 'w4', house: 'ramot', employmentType: 'full_time', salary: 18000 },
];

// ---------- header detection ----------

test('detectColumns: canonical Hebrew headers', () => {
  assert.deepEqual(detectColumns(['שם', 'בית', 'שעות', 'טיפולים']),
    { name: 0, house: 1, hours: 2, sessions: 3 });
});

test('detectColumns: tolerant of variants (English + descriptive Hebrew)', () => {
  const c = detectColumns(['שם עובד', 'סניף', 'שעות בפועל', 'מספר טיפולים']);
  assert.equal(c.name, 0);
  assert.equal(c.house, 1);
  assert.equal(c.hours, 2);
  assert.equal(c.sessions, 3);
  const en = detectColumns(['Worker Name', 'House', 'Hours', 'Sessions']);
  assert.deepEqual(en, { name: 0, house: 1, hours: 2, sessions: 3 });
});

test('detectColumns: house + sessions optional', () => {
  const c = detectColumns(['name', 'hours']);
  assert.equal(c.name, 0);
  assert.equal(c.hours, 1);
  assert.equal(c.house, -1);
  assert.equal(c.sessions, -1);
});

test('findHeaderRow: skips title / blank rows above the header', () => {
  const rows = [
    ['דוח שעות חודשי'], [], ['שם', 'בית', 'שעות'], ['דנה כהן', 'קיסריה עפרוני', '10'],
  ];
  assert.equal(findHeaderRow(rows), 2);
});

test('findHeaderRow: -1 when no name+quantity header exists', () => {
  assert.equal(findHeaderRow([['a', 'b'], ['c', 'd']]), -1);
});

// ---------- house resolution ----------

test('resolveHouse: id, exact name, or distinctive token', () => {
  assert.equal(resolveHouse('ofroni', HOUSES), 'ofroni');
  assert.equal(resolveHouse('קיסריה עפרוני', HOUSES), 'ofroni');
  assert.equal(resolveHouse('עפרוני', HOUSES), 'ofroni');   // partial token
  assert.equal(resolveHouse('לא קיים', HOUSES), '');
});

// ---------- quantity parsing ----------

test('parseQuantity: number / blank / invalid / negative', () => {
  assert.deepEqual(parseQuantity('92'), { value: 92 });
  assert.deepEqual(parseQuantity('12.5'), { value: 12.5 });
  assert.deepEqual(parseQuantity('1,024'), { value: 1024 });   // thousands sep
  assert.deepEqual(parseQuantity(''), { empty: true });
  assert.deepEqual(parseQuantity('  '), { empty: true });
  assert.deepEqual(parseQuantity('abc'), { invalid: true });
  assert.deepEqual(parseQuantity('-5'), { invalid: true });
});

// ---------- matching ----------

function run(dataRows) {
  const rows = [['שם', 'בית', 'שעות', 'טיפולים']].concat(dataRows);
  return matchActuals({ rows, workers: WORKERS, assignments: ASSIGNMENTS, houses: HOUSES });
}

test('matchActuals: hourly with house disambiguation → cost = rate × hours', () => {
  const res = run([['דנה כהן', 'קיסריה עפרוני', '92', '']]);
  assert.equal(res.unmatched.length, 0);
  assert.equal(res.ambiguous.length, 0);
  assert.equal(res.matched.length, 1);
  const m = res.matched[0];
  assert.equal(m.assignmentId, 'a1');
  assert.equal(m.type, 'hourly');
  assert.equal(m.quantity, 92);
  assert.equal(m.rate, 60);
  assert.equal(m.cost, 5520);       // 60 × 92
});

test('matchActuals: per_session uses the sessions column', () => {
  const res = run([['יוסי לוי', '', '', '9']]);
  assert.equal(res.matched.length, 1);
  const m = res.matched[0];
  assert.equal(m.assignmentId, 'a3');
  assert.equal(m.type, 'per_session');
  assert.equal(m.quantity, 9);
  assert.equal(m.cost, 3600);       // 400 × 9
});

test('matchActuals: name not found → unmatched', () => {
  const res = run([['מישהו אחר', '', '10', '']]);
  assert.equal(res.matched.length, 0);
  assert.equal(res.unmatched.length, 1);
  assert.match(res.unmatched[0].reason, /לא נמצא/);
});

test('matchActuals: worker with no hourly/per_session assignment → unmatched', () => {
  const res = run([['רות רון', '', '10', '']]);   // w4 is full_time only
  assert.equal(res.matched.length, 0);
  assert.equal(res.unmatched.length, 1);
  assert.match(res.unmatched[0].reason, /אין שיבוץ/);
});

test('matchActuals: multiple variable assignments without a house → ambiguous', () => {
  // "דנה כהן" resolves to w1 (ofroni + ramot) and w3 (rehab) — 3 hourly
  // candidates, no house to disambiguate.
  const res = run([['דנה כהן', '', '80', '']]);
  assert.equal(res.matched.length, 0);
  assert.equal(res.ambiguous.length, 1);
  assert.match(res.ambiguous[0].reason, /יש לציין בית/);
  assert.ok(res.ambiguous[0].candidates.length >= 2);
});

test('matchActuals: house given but no matching assignment there → unmatched', () => {
  const res = run([['יוסי לוי', 'קיסריה ריהאב', '', '9']]);  // w2 only at asher
  assert.equal(res.matched.length, 0);
  assert.equal(res.unmatched.length, 1);
  assert.match(res.unmatched[0].reason, /בבית הנבחר/);
});

test('matchActuals: missing quantity for the assignment type → unmatched', () => {
  // a1 is hourly but the row only fills the sessions column.
  const res = run([['דנה כהן', 'קיסריה עפרוני', '', '5']]);
  assert.equal(res.matched.length, 0);
  assert.equal(res.unmatched.length, 1);
  assert.match(res.unmatched[0].reason, /שעות/);
});

test('matchActuals: duplicate row for the same assignment → second is ambiguous', () => {
  const res = run([
    ['יוסי לוי', '', '', '9'],
    ['יוסי לוי', '', '', '4'],
  ]);
  assert.equal(res.matched.length, 1, 'first row matches');
  assert.equal(res.ambiguous.length, 1, 'second row flagged duplicate');
  assert.match(res.ambiguous[0].reason, /כפולה/);
});

test('matchActuals: blank name rows are skipped silently', () => {
  const res = run([['', '', '', ''], ['יוסי לוי', '', '', '9']]);
  assert.equal(res.matched.length, 1);
  assert.equal(res.unmatched.length, 0);
});

test('matchActuals: error when no header row', () => {
  const res = matchActuals({ rows: [['x', 'y'], ['1', '2']],
    workers: WORKERS, assignments: ASSIGNMENTS, houses: HOUSES });
  assert.ok(res.error);
  assert.equal(res.matched.length, 0);
});

// ---------- upsert items ----------

test('buildUpsertItems: hourly → actualHours, per_session → actualSessions', () => {
  const matched = [
    { assignmentId: 'a1', type: 'hourly', quantity: 92 },
    { assignmentId: 'a3', type: 'per_session', quantity: 9 },
  ];
  assert.deepEqual(buildUpsertItems(matched, '2026-07'), [
    { assignmentId: 'a1', month: '2026-07', actualHours: 92 },
    { assignmentId: 'a3', month: '2026-07', actualSessions: 9 },
  ]);
});
