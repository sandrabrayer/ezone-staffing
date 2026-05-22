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
  // Status acts as an explicit override. We need this because
  // `terminateEmployee` truncates an active event's end_date to
  // terminationDate (a date that may equal today) and sets status='ended'
  // to mean "stop counting from this date". Without the status check,
  // the date-only window [start..end] would still include today and
  // activeBonus would keep counting until tomorrow.
  if (String(event.status) === 'ended') return false;
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

// ---------- termination / archive helpers ----------
// An archive row represents a terminated employee. Their salary still
// contributes to the home_house cost up until terminationDate; from that
// date onward they contribute 0. This lets the dashboard handle the
// "scheduled termination at end of month" case correctly: the row is
// moved out of the active roster immediately, but the cost stays until
// the termination date is reached.

function pendingTerminations(archive, today) {
  const t = today || todayStr();
  return (archive || []).filter(a => a && String(a.terminationDate) > t);
}

function pendingHomeCost(archive, homeHouse, today) {
  return pendingTerminations(archive, today)
    .filter(a => a.homeHouse === homeHouse)
    .reduce((s, a) => s + cost(a), 0);
}

// Total monthly cost attributed to a house: base salaries of its home roster
// + incoming active coverage bonuses + base salaries of employees scheduled
// to terminate later (still on the payroll until termination_date).
// Base salaries of employees currently helping ELSEWHERE still count here —
// they live here.
function houseTotal(homeRoster, events, hostHouse, today, archive) {
  return houseCost(homeRoster)
    + activeBonus(events, hostHouse, today)
    + pendingHomeCost(archive, hostHouse, today);
}

// Network-wide total: sum of every home cost + sum of every active bonus
// + sum of pending-termination salaries. Base salaries appear exactly once
// (in their home house). No double-counting.
function networkTotal(housesObj, events, today, archive) {
  const houseIds = Object.keys(housesObj || {});
  const homeSum = houseIds.reduce((s, h) => s + houseCost(housesObj[h]), 0);
  const bonusSum = activeEvents(events, today)
    .reduce((s, e) => s + (Number(e.bonusAmount) || 0), 0);
  const pendingSum = pendingTerminations(archive, today)
    .reduce((s, a) => s + cost(a), 0);
  return homeSum + bonusSum + pendingSum;
}

// For the home-house view: returns the currently-active outgoing event for
// an employee (if any), so the row can show a coverage badge.
function activeOutgoingFor(events, employeeId, today) {
  return (events || []).find(e =>
    e.employeeId === employeeId && isActive(e, today)
  ) || null;
}

const API = {
  cost, houseCost, houseGross, avgPct,
  todayStr, isActive,
  activeEvents, endedEvents,
  eventsHostedBy, activeBonus,
  pendingTerminations, pendingHomeCost,
  houseTotal, networkTotal,
  activeOutgoingFor,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = API;
}
if (typeof window !== 'undefined') {
  window.EZONE_CALC = API;
}
