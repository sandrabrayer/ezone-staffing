'use strict';

function cost(emp) {
  if (!emp) return 0;
  const salary = Number(emp.salary) || 0;
  const pct = Number(emp.pct) || 0;
  return Math.round(salary * (pct / 100));
}

function houseCost(list) {
  return (list || []).reduce((s, e) => s + cost(e), 0);
}

function houseGross(list) {
  return (list || []).reduce((s, e) => s + (Number(e.salary) || 0), 0);
}

function avgPct(list) {
  const arr = list || [];
  if (!arr.length) return 0;
  return Math.round(arr.reduce((s, e) => s + (Number(e.pct) || 0), 0) / arr.length);
}

// ---------- coverage event helpers ----------
// All event functions take a `today` string (YYYY-MM-DD). Callers should pass
// the same value to every helper in one render pass to keep results coherent.

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function isActive(event, today) {
  if (!event) return false;
  const t = today || todayStr();
  return String(event.startDate) <= t && t <= String(event.endDate);
}

function activeEvents(events, today) {
  return (events || []).filter(e => isActive(e, today));
}

function endedEvents(events, today) {
  return (events || []).filter(e => !isActive(e, today));
}

function eventsHostedBy(events, hostHouse, today) {
  return (events || []).filter(e => e.hostHouse === hostHouse && isActive(e, today));
}

function activeBonus(events, hostHouse, today) {
  return eventsHostedBy(events, hostHouse, today)
    .reduce((s, e) => s + (Number(e.bonusAmount) || 0), 0);
}

// Total monthly cost attributed to a house: base salaries of its home roster
// plus bonuses for incoming active coverage. Base salaries of employees
// currently helping ELSEWHERE still count here — they live here.
function houseTotal(homeRoster, events, hostHouse, today) {
  return houseCost(homeRoster) + activeBonus(events, hostHouse, today);
}

// Network-wide total: sum of every home cost + sum of every active bonus.
// Base salaries appear exactly once (in their home house). No double-counting.
function networkTotal(housesObj, events, today) {
  const houseIds = Object.keys(housesObj || {});
  const homeSum = houseIds.reduce((s, h) => s + houseCost(housesObj[h]), 0);
  const bonusSum = activeEvents(events, today)
    .reduce((s, e) => s + (Number(e.bonusAmount) || 0), 0);
  return homeSum + bonusSum;
}

// For the home-house view: returns the currently-active outgoing event for
// an employee (if any), so the row can show a "כרגע עוזר/ת ב..." badge.
function activeOutgoingFor(events, employeeId, today) {
  return (events || []).find(e =>
    e.employeeId === employeeId && isActive(e, today)
  ) || null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    cost, houseCost, houseGross, avgPct,
    todayStr, isActive,
    activeEvents, endedEvents,
    eventsHostedBy, activeBonus,
    houseTotal, networkTotal,
    activeOutgoingFor,
  };
}
if (typeof window !== 'undefined') {
  window.EZONE_CALC = {
    cost, houseCost, houseGross, avgPct,
    todayStr, isActive,
    activeEvents, endedEvents,
    eventsHostedBy, activeBonus,
    houseTotal, networkTotal,
    activeOutgoingFor,
  };
}
