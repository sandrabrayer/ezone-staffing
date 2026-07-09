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

// Allowed monthly allowance values (₪). Car+gas, gas-only, or none.
// Kept as a small whitelist rather than a free number so the value can't
// be abused and stays consistent with the assignment form's dropdown.
const ALLOWANCE_VALUES = [0, 2000, 6000];

// Normalizes any incoming allowance to one of the whitelisted values;
// anything else (including undefined/null on legacy rows) → 0.
function allowanceValue(a) {
  const v = num(a && a.allowance);
  return ALLOWANCE_VALUES.indexOf(v) >= 0 ? v : 0;
}

// Base cost of the assignment's employment terms, WITHOUT the allowance.
function assignmentBaseCost(a) {
  if (!a) return 0;
  switch (a.employmentType) {
    case 'full_time':
      return Math.max(0, Math.round(num(a.salary)));
    case 'part_time': {
      // The salary field IS the amount to pay for this assignment. `pct`
      // is an informational label only (e.g. "50% role") and does NOT
      // scale the cost — Moran types the actual amount per house and
      // splits multi-house salaries herself.
      return Math.max(0, Math.round(num(a.salary)));
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

// Total monthly cost = employment terms + allowance (car+gas / gas / none).
// The allowance applies to every employment type, so it's added on top of
// the per-type base cost rather than living inside the switch.
function assignmentCost(a) {
  if (!a) return 0;
  return assignmentBaseCost(a) + allowanceValue(a);
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

// v3.1: a coverage is "active" by its own date range, with a special
// case for LINKED coverages — when absenceId is set, the linked absence
// must also be active. This matches real-world substitute-pay logic:
// when the regular employee returns (absence ends), the substitute is
// no longer needed and the extra stops accruing — even if the
// coverage's own endDate stretches further out.
//
// Concretely:
//   - Unlinked coverage (absenceId='') → active iff today ∈ coverage's
//     own range. No absence to tie to.
//   - Linked coverage (absenceId set) → active iff today ∈ coverage's
//     own range AND the linked absence is active today. Because
//     `endAbsence` pulls absence.endDate to today AND flips status to
//     'ended', closing the absence drops the coverage cost on the same
//     day — even though the coverage's own endDate is unchanged. This
//     covers both branches of "stops at that new date": status-driven
//     (endAbsence) and date-driven (today > absence.endDate, lazily
//     corrected to status='ended' on read).
//   - Dangling link (absenceId set but the absence has been deleted)
//     → falls back to unlinked behavior. Same spirit as deleteAbsence
//     not cascading to coverages: the coverage row stands on its own.
function isCoverageActive(coverage, today, absences) {
  if (!coverage) return false;
  const t = today || todayStr();
  const s = String(coverage.startDate || '');
  const e = String(coverage.endDate || '');
  if (!s || !e) return false;
  if (!(s <= t && t <= e)) return false;
  const absenceId = String(coverage.absenceId || '');
  if (!absenceId) return true;
  const abs = (absences || []).find(a => a && a.id === absenceId);
  if (!abs) return true;  // dangling link → treat as unlinked
  return isAbsenceActive(abs, t);
}

// Returns active coverages grouped by receivingHouse — where the help is
// going. extraPayment accrues there. Orphan stubs with receivingHouse=''
// (produced by migration on v2 events without a recorded absentee that
// can't be paired with an absence) are skipped — cost belongs nowhere
// until Moran fixes them via the UI.
function activeCoveragesByHouse(coverages, absences, today) {
  const out = Object.create(null);
  (coverages || []).forEach(c => {
    if (!c) return;
    if (!isCoverageActive(c, today, absences)) return;
    const h = c.receivingHouse;
    if (!h) return;
    if (!out[h]) out[h] = [];
    out[h].push(c);
  });
  return out;
}

function coverageExtra(coverages, absences, house, today) {
  return (coverages || [])
    .filter(c => c && c.receivingHouse === house && isCoverageActive(c, today, absences))
    .reduce((s, c) => s + Math.max(0, num(c.extraPayment)), 0);
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
//   + sum of extra_payment on coverages whose receivingHouse = h AND
//     active today (per isCoverageActive — coverage's own range gated
//     by the linked absence when one is set)
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
  // Coverage extras: count each active coverage exactly once at its
  // receivingHouse. Orphan stubs (receivingHouse='') drop out of
  // activeCoveragesByHouse() — they accrue nowhere until Moran assigns
  // a receiving house via the UI.
  const byHouse = activeCoveragesByHouse(coverages, absences, today);
  Object.keys(byHouse).forEach(h => {
    byHouse[h].forEach(c => { total += Math.max(0, num(c.extraPayment)); });
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

// ---------- dashboard join (read-only) ----------

// One row per ACTIVE absence, with its matching coverage if any. Used by
// the central dashboard's "היעדרויות פעילות ברשת" section. The dashboard
// is read-only — this is a pure view-model helper, no side effects.
//
// Match rule: coverage.absenceId === absence.id (linked). Unlinked
// coverages (absenceId='') and dangling links don't surface in this
// view — they only matter for the cost contract, which is rendered
// elsewhere. When multiple coverages link the same absence (real-world
// edge case: two workers splitting one absence), the FIRST one wins so
// each absence still produces exactly one row.
//
// Sort: orphans (no coverage) first, then by startDate descending — so
// "what still needs a substitute" is visually pinned to the top of the
// list and the older fully-covered items sink down.
//
// Stub absences (workerId='') ARE included — they're a v3.1 first-class
// shape ("unfilled position, no identified absentee"). The UI renders
// them with a "(ללא רישום נעדר/ת)" placeholder name.
//
// `workers` and `assignments` are reserved in the signature for future
// enrichment (e.g. coverer's role pill, absentee's roles) — the join
// itself doesn't need them today.
function networkAbsenceCoverageRows(absences, coverages, workers, assignments, today) {
  const active = activeAbsences(absences, today);
  const rows = active.map(absence => {
    const coverage = (coverages || []).find(c => c && c.absenceId === absence.id) || null;
    return { absence: absence, coverage: coverage };
  });
  rows.sort((a, b) => {
    const aOpen = !a.coverage;
    const bOpen = !b.coverage;
    if (aOpen !== bOpen) return aOpen ? -1 : 1;
    return String(b.absence.startDate).localeCompare(String(a.absence.startDate));
  });
  return rows;
}

const API = {
  EMPLOYMENT_TYPES, SALARIED_TYPES, FREELANCER_TYPES,
  assignmentCategory, assignmentCost, assignmentBaseCost,
  ALLOWANCE_VALUES, allowanceValue,
  assignmentsByHouse, houseAssignmentsCost, splitByCategory,
  todayStr,
  isAbsenceActive, activeAbsences, openAbsences,
  coveragesForAbsence, isCoverageActive, activeCoveragesByHouse, coverageExtra,
  pendingTerminations, pendingHouseCost,
  houseTotal, networkTotal,
  assignmentsForWorker, workerTotalCost,
  activeAbsenceForWorker,
  networkAbsenceCoverageRows,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = API;
}
if (typeof window !== 'undefined') {
  window.EZONE_CALC = API;
}
