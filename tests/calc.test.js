'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { cost, houseCost, houseGross, avgPct } = require('../lib/calc');

test('cost: full-time = salary', () => {
  assert.equal(cost({ salary: 10000, pct: 100 }), 10000);
});

test('cost: 80% rounds to int', () => {
  assert.equal(cost({ salary: 12345, pct: 80 }), 9876);
});

test('cost: zero salary or pct', () => {
  assert.equal(cost({ salary: 0, pct: 100 }), 0);
  assert.equal(cost({ salary: 5000, pct: 0 }), 0);
});

test('cost: missing employee', () => {
  assert.equal(cost(null), 0);
  assert.equal(cost(undefined), 0);
});

test('cost: rounds (not truncates) 75% of 9999', () => {
  // 9999 * 0.75 = 7499.25 → 7499
  assert.equal(cost({ salary: 9999, pct: 75 }), 7499);
  // 10001 * 0.75 = 7500.75 → 7501
  assert.equal(cost({ salary: 10001, pct: 75 }), 7501);
});

test('houseCost: sum of weighted costs', () => {
  const list = [
    { salary: 24000, pct: 100 }, // 24000
    { salary: 12000, pct: 80 },  //  9600
    { salary: 9000,  pct: 60 },  //  5400
  ];
  assert.equal(houseCost(list), 39000);
});

test('houseCost: empty / missing list', () => {
  assert.equal(houseCost([]), 0);
  assert.equal(houseCost(null), 0);
  assert.equal(houseCost(undefined), 0);
});

test('houseGross: sum of unweighted salaries', () => {
  const list = [
    { salary: 24000, pct: 100 },
    { salary: 12000, pct: 80 },
    { salary: 9000,  pct: 60 },
  ];
  assert.equal(houseGross(list), 45000);
});

test('avgPct: average rounded to int', () => {
  assert.equal(avgPct([{ pct: 100 }, { pct: 80 }, { pct: 60 }]), 80);
  assert.equal(avgPct([{ pct: 100 }, { pct: 75 }]), 88);
});

test('avgPct: empty list → 0', () => {
  assert.equal(avgPct([]), 0);
});
