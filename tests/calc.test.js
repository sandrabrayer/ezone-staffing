'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  cost, houseCost, houseGross, avgPct,
  isActive, activeEvents, endedEvents,
  eventsHostedBy, activeBonus,
  houseTotal, networkTotal,
  activeOutgoingFor,
} = require('../lib/calc');

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
  assert.equal(cost({ salary: 9999, pct: 75 }), 7499);
  assert.equal(cost({ salary: 10001, pct: 75 }), 7501);
});

test('houseCost: sum of weighted costs', () => {
  const list = [
    { salary: 24000, pct: 100 },
    { salary: 12000, pct: 80 },
    { salary: 9000,  pct: 60 },
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

// ---------- coverage event helpers ----------

const TODAY = '2026-05-20';

function ev(over) {
  return Object.assign({
    id: 'ev1',
    employeeId: 'e1',
    employeeName: 'יוסי',
    homeHouse: 'ramot',
    hostHouse: 'asher',
    startDate: '2026-05-01',
    endDate: '2026-05-31',
    reasonType: 'חופשה',
    reasonDetail: '',
    coversEmployeeId: '',
    bonusAmount: 2000,
    status: 'active',
  }, over);
}

test('isActive: today inside range', () => {
  assert.equal(isActive(ev({ startDate: '2026-05-01', endDate: '2026-05-31' }), TODAY), true);
});

test('isActive: today on start or end boundary (inclusive)', () => {
  assert.equal(isActive(ev({ startDate: TODAY, endDate: '2026-06-01' }), TODAY), true);
  assert.equal(isActive(ev({ startDate: '2026-05-01', endDate: TODAY }), TODAY), true);
});

test('isActive: before start or after end', () => {
  assert.equal(isActive(ev({ startDate: '2026-06-01', endDate: '2026-06-15' }), TODAY), false);
  assert.equal(isActive(ev({ startDate: '2026-04-01', endDate: '2026-04-15' }), TODAY), false);
});

test('isActive: missing event returns false', () => {
  assert.equal(isActive(null, TODAY), false);
});

test('activeEvents and endedEvents split correctly', () => {
  const events = [
    ev({ id: 'a', endDate: '2026-04-15' }),   // ended
    ev({ id: 'b', endDate: '2026-05-31' }),   // active
    ev({ id: 'c', startDate: '2026-06-01', endDate: '2026-06-10' }), // future / ended
  ];
  const active = activeEvents(events, TODAY).map(e => e.id);
  const ended = endedEvents(events, TODAY).map(e => e.id);
  assert.deepEqual(active, ['b']);
  assert.deepEqual(ended.sort(), ['a', 'c']);
});

test('eventsHostedBy: filters by host AND active window', () => {
  const events = [
    ev({ id: 'a', hostHouse: 'asher' }),
    ev({ id: 'b', hostHouse: 'ofroni' }),
    ev({ id: 'c', hostHouse: 'asher', endDate: '2026-04-01' }), // ended
  ];
  assert.deepEqual(eventsHostedBy(events, 'asher', TODAY).map(e => e.id), ['a']);
});

test('activeBonus: sum of bonuses for host within active window', () => {
  const events = [
    ev({ hostHouse: 'asher', bonusAmount: 2000 }),
    ev({ hostHouse: 'asher', bonusAmount: 1500 }),
    ev({ hostHouse: 'asher', bonusAmount: 5000, endDate: '2026-04-01' }), // ended
    ev({ hostHouse: 'ofroni', bonusAmount: 800 }),
  ];
  assert.equal(activeBonus(events, 'asher', TODAY), 3500);
  assert.equal(activeBonus(events, 'ofroni', TODAY), 800);
  assert.equal(activeBonus(events, 'ramot', TODAY), 0);
});

test('houseTotal: home cost + incoming active bonus', () => {
  const roster = [
    { salary: 20000, pct: 100 }, // 20000
    { salary: 10000, pct: 80 },  //  8000
  ];
  const events = [
    ev({ hostHouse: 'asher', bonusAmount: 1500 }),
    ev({ hostHouse: 'ramot', bonusAmount: 9999 }), // host is different
  ];
  // asher's total: 28000 + 1500 = 29500
  assert.equal(houseTotal(roster, events, 'asher', TODAY), 29500);
});

test('houseTotal: base salary counts even when employee is helping elsewhere', () => {
  // employee e1 lives in ramot but is helping asher right now.
  // their base salary STILL counts in ramot's total.
  const ramotRoster = [{ id: 'e1', salary: 18000, pct: 100 }];
  const events = [ev({ employeeId: 'e1', homeHouse: 'ramot', hostHouse: 'asher', bonusAmount: 2000 })];
  // ramot total: base 18000 + no incoming bonus = 18000
  assert.equal(houseTotal(ramotRoster, events, 'ramot', TODAY), 18000);
});

test('networkTotal: every base salary appears exactly once', () => {
  const houses = {
    ramot:  [{ salary: 20000, pct: 100 }],
    asher:  [{ salary: 15000, pct: 100 }],
    ofroni: [],
    rehab:  [{ salary: 10000, pct: 50 }], // 5000
  };
  const events = [];
  // 20000 + 15000 + 5000 = 40000
  assert.equal(networkTotal(houses, events, TODAY), 40000);
});

test('networkTotal: adds active bonuses, ignores ended', () => {
  const houses = {
    ramot:  [{ salary: 20000, pct: 100 }],
    asher:  [{ salary: 15000, pct: 100 }],
    ofroni: [],
    rehab:  [],
  };
  const events = [
    ev({ hostHouse: 'asher', bonusAmount: 2000 }),
    ev({ hostHouse: 'ofroni', bonusAmount: 1000, endDate: '2026-04-01' }), // ended
    ev({ hostHouse: 'rehab', bonusAmount: 500 }),
  ];
  // base: 35000 + active bonuses: 2000 + 500 = 37500
  assert.equal(networkTotal(houses, events, TODAY), 37500);
});

test('networkTotal: no double-counting when an employee is on coverage', () => {
  // The key contract: base appears once, bonus appears once.
  const houses = {
    ramot: [{ id: 'e1', salary: 18000, pct: 100 }],
    asher: [],
    ofroni: [],
    rehab: [],
  };
  const events = [ev({ employeeId: 'e1', homeHouse: 'ramot', hostHouse: 'asher', bonusAmount: 2000 })];
  // 18000 (base in ramot) + 2000 (bonus in asher) = 20000
  assert.equal(networkTotal(houses, events, TODAY), 20000);
  // Sum of house totals should match.
  const sumHouseTotals =
    houseTotal(houses.ramot, events, 'ramot', TODAY) +
    houseTotal(houses.asher, events, 'asher', TODAY) +
    houseTotal(houses.ofroni, events, 'ofroni', TODAY) +
    houseTotal(houses.rehab, events, 'rehab', TODAY);
  assert.equal(sumHouseTotals, 20000);
});

test('activeOutgoingFor: finds the active event for an employee', () => {
  const events = [
    ev({ id: 'a', employeeId: 'e1', endDate: '2026-04-01' }), // ended
    ev({ id: 'b', employeeId: 'e1', endDate: '2026-06-01' }), // active
    ev({ id: 'c', employeeId: 'e2', endDate: '2026-06-01' }),
  ];
  const out = activeOutgoingFor(events, 'e1', TODAY);
  assert.ok(out && out.id === 'b');
  assert.equal(activeOutgoingFor(events, 'never', TODAY), null);
});
