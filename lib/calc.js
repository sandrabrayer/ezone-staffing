'use strict';

// v3: workers + per-house assignments + absence/coverage split.
// All event helpers take a `today` string (YYYY-MM-DD). Callers should pass
// the same value to every helper in one render pass to keep results coherent.

// ---------- employment types ----------

const SALARIED_TYPES = ['full_time', 'part_time', 'hourly'];
const FREELANCER_TYPES = ['per_session', 'fixed_retainer'];
const EMPLOYMENT_TYPES = SALARIED_TYPES.concat(FREELANCER_TYPES);

function assignmentCategory(a) {
  if (!a) return null;
  if (SALARIED_TYPES.indexOf(a.employmentType) >= 0) return 'salaried';
  if (FREELANCER_TYPES.indexOf(a.employmentType) >= 0) return 'freelancer';
  return null;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function assignmentCost(a) {
  if (!a) return 0;
  switch (a.employmentType) {
    case 'full_time':
      return Math.max(0, Math.round(num(a.salary)));
    case 'part_time': {
      const salary = Math.max(0, num(a.salary));
      const pct = Math.max(0, Math.min(100, num(a.pct)));
      return Math.round(salary * pct / 100);
    }
    case 'hourly':
      return Math.round(Math.max(0, num(a.hourlyRate)) * Math.max(0, num(a.estHours)));
    case 'per_session':
      return Math.round(Math.max(0, num(a.sessionRate)) * Math.max(0, num(a.estSessions)));
    case 'fixed_retainer':
      return Math.max(0, Math.round(num(a.retainerAmount)));
    default:
      return 0;
  }
}

function assignmentsByHouse(assignments, house) {
  return (assignments || []).filter(a => a && a.house === house);
}

function houseAssignmentsCost(assignments, house) {
  return assignmentsByHouse(assignments, house)
    .reduce((s, a) => s + assignmentCost(a), 0);
}

// Splits a list of assignments into { salaried, freelancer } preserving order.
function splitByCategory(assignments) {
  const out = { salaried: [], freelancer: [] };
  (assignments || []).forEach(a => {
    const cat = assignmentCategory(a);
    if (cat === 'salaried') out.salaried.push(a);
    else if (cat === 'freelancer') out.freelancer.push(a);
  });
  return out;
}

// ---------- absence / coverage helpers ----------

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function isAbsenceActive(absence, today) {
  if (!absence) return false;
  // Explicit status='ended' overrides the date window — same pattern as v2:
  // `endAbsence` truncates end_date to today AND sets status, so the absence
  // stops counting on the same day even though [start..end] still contains it.
  if (String(absence.status) === 'ended') return false;
  const t = today || todayStr();
  return String(absence.startDate) <= t && t <= String(absence.endDate);
}

function activeAbsences(absences, today) {
  return (absences || []).filter(a => isAbsenceActive(a, today));
}

// "Open" = end_date is on or after today AND status not explicitly ended.
// Used to populate the "Add coverage" picker — includes today's and future
// absences. Past absences and explicitly-ended ones are excluded.
function openAbsences(absences, today) {
  const t = today || todayStr();
  return (absences || []).filter(a => {
    if (!a) return false;
    if (String(a.status) === 'ended') return false;
    return String(a.endDate) >= t;
  });
}

function coveragesForAbsence(coverages, absenceId) {
  return (coverages || []).filter(c => c && c.absenceId === absenceId);
}

// Returns active coverages grouped by the house that needs the coverage
// (= absence.house). Extra payment accrues here — that's the house paying
// the helper.
function activeCoveragesByHouse(coverages, absences, today) {
  const absMap = Object.create(null);
  (absences || []).forEach(a => { if (a) absMap[a.id] = a; });
  const out = Object.create(null);
  (coverages || []).forEach(c => {
    if (!c) return;
    const abs = absMap[c.absenceId];
    if (!abs) return;
    if (!isAbsenceActive(abs, today)) return;
    const h = abs.house;
    if (!out[h]) out[h] = [];
    out[h].push({ coverage: c, absence: abs });
  });
  return out;
}

function coverageExtra(coverages, absences, house, today) {
  const byHouse = activeCoveragesByHouse(coverages, absences, today);
  return (byHouse[house] || [])
    .reduce((s, x) => s + Math.max(0, num(x.coverage.extraPayment)), 0);
}

// ---------- termination / archive (now per-assignment) ----------
// Each archive row carries the assignment's frozen terms, so cost
// reconstruction for the pending-termination window works without joining
// back to the active assignments list.

function pendingTerminations(archive, today) {
  const t = today || todayStr();
  return (archive || []).filter(a => a && String(a.terminationDate) > t);
}

function pendingHouseCost(archive, house, today) {
  return pendingTerminations(archive, today)
    .filter(a => a.house === house)
    .reduce((s, a) => s + assignmentCost(a), 0);
}

// ---------- house / network totals ----------
// houseTotal(h) =
//     sum of active assignment costs at h
//   + sum of extra_payment on coverages whose parent absence.house = h AND active
//   + sum of pending-termination assignment costs whose house = h

function houseTotal(assignments, coverages, absences, archive, house, today) {
  return houseAssignmentsCost(assignments, house)
    + coverageExtra(coverages, absences, house, today)
    + pendingHouseCost(archive, house, today);
}

function networkTotal(assignments, coverages, absences, archive, houseIds, today) {
  const ids = houseIds || [];
  let total = 0;
  ids.forEach(h => {
    total += houseAssignmentsCost(assignments, h);
    total += pendingHouseCost(archive, h, today);
  });
  // Coverage extras: count each active coverage exactly once (regardless of
  // which house's absence list it belongs to — the houseIds loop already
  // captures every house we care about, but the extra is paid once).
  const byHouse = activeCoveragesByHouse(coverages, absences, today);
  Object.keys(byHouse).forEach(h => {
    byHouse[h].forEach(x => { total += Math.max(0, num(x.coverage.extraPayment)); });
  });
  return total;
}

// ---------- worker-level views ----------

function assignmentsForWorker(assignments, workerId) {
  return (assignments || []).filter(a => a && a.workerId === workerId);
}

function workerTotalCost(assignments, workerId) {
  return assignmentsForWorker(assignments, workerId)
    .reduce((s, a) => s + assignmentCost(a), 0);
}

function activeAbsenceForWorker(absences, workerId, today) {
  return (absences || []).find(a =>
    a && a.workerId === workerId && isAbsenceActive(a, today)
  ) || null;
}

const API = {
  EMPLOYMENT_TYPES, SALARIED_TYPES, FREELANCER_TYPES,
  assignmentCategory, assignmentCost,
  assignmentsByHouse, houseAssignmentsCost, splitByCategory,
  todayStr,
  isAbsenceActive, activeAbsences, openAbsences,
  coveragesForAbsence, activeCoveragesByHouse, coverageExtra,
  pendingTerminations, pendingHouseCost,
  houseTotal, networkTotal,
  assignmentsForWorker, workerTotalCost,
  activeAbsenceForWorker,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = API;
}
if (typeof window !== 'undefined') {
  window.EZONE_CALC = API;
}
