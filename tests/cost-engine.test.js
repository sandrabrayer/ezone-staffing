'use strict';

// PROOF OF THE BUG — written before the engine exists, and failing against
// the behaviour on main.
//
// Reported: changing the cost month between 08/2026, 09/2026 and 10/2026
// changes the label but not the numbers, and budget/balance stay the same.
//
// The fixture below is the brief's own case: a worker whose employment
// starts 2026-12-01. In September 2026 they are not employed yet, so they
// must cost 0 — and August, September and October must not all return the
// same number.
//
// Against lib/calc.js as it stands, monthlyAssignmentCost() takes no month
// at all: for a fixed-salary assignment it returns a constant, so all three
// months are byte-identical and the future starter is billed in September.

const { test } = require('node:test');
const assert = require('node:assert');

const { costForMonth } = require('../lib/cost-engine');

const WORKERS = [
  { id: 'w1', name: 'עובדת ותיקה', startDate: '2020-01-01' },
  { id: 'w2', name: 'עובד עתידי', startDate: '2026-12-01' },
];

const ASSIGNMENTS = [
  { id: 'a1', workerId: 'w1', house: 'ramot', role: 'מדריך/ה',
    employmentType: 'full_time', salary: 10000, status: 'active' },
  { id: 'a2', workerId: 'w2', house: 'ramot', role: 'מדריך/ה',
    employmentType: 'full_time', salary: 8000, status: 'active' },
];

function run(month) {
  return costForMonth(WORKERS, ASSIGNMENTS, [], [], [], month);
}

test('THE BUG: a worker starting 2026-12-01 must cost 0 in September 2026', () => {
  const sep = run('2026-09');
  assert.strictEqual(sep.totals.projectedTotal, 10000,
    'only the worker who had already started may be billed in September');
  const future = sep.lines.find(l => l.assignmentId === 'a2');
  assert.strictEqual(future.cost, 0);
  assert.strictEqual(future.rule, 'NOT_STARTED');
});

test('THE BUG: 08/2026, 09/2026 and 10/2026 must not all return the same number', () => {
  const aug = run('2026-08').totals.projectedTotal;
  const sep = run('2026-09').totals.projectedTotal;
  const oct = run('2026-10').totals.projectedTotal;
  const dec = run('2026-12').totals.projectedTotal;

  assert.strictEqual(aug, 10000);
  assert.strictEqual(sep, 10000);
  assert.strictEqual(oct, 10000);
  assert.strictEqual(dec, 18000,
    'December is the month the second worker starts — the total must move');
});
