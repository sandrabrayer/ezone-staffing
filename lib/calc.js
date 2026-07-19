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

// Per-session base cost. A per_session therapist is now paid across three
// independent session types, each with its own rate × count:
//   - individual sessions   (rate_individual   × sessions_individual)
//   - group sessions        (rate_group        × sessions_group)
//   - external patients      (rate_external     × external_patients)
// All six fields are optional and default to 0, so a therapist who only
// does individual work simply leaves the group/external pairs blank.
//
// Backward compatibility: rows created before the 3-rate model (and rows
// not yet touched by the one-time migration) carry only the legacy
// `sessionRate` × `estSessions` pair. When none of the three new products
// contributes anything, fall back to that legacy pair so existing per_session
// workers keep their cost until the migration copies legacy → individual.
function perSessionCost(a) {
  if (!a) return 0;
  const individual = Math.max(0, num(a.rateIndividual)) * Math.max(0, num(a.sessionsIndividual));
  const group      = Math.max(0, num(a.rateGroup))      * Math.max(0, num(a.sessionsGroup));
  const external   = Math.max(0, num(a.rateExternal))   * Math.max(0, num(a.externalPatients));
  const total = individual + group + external;
  if (total > 0) return Math.round(total);
  // Un-migrated legacy row → single-rate pricing.
  return Math.round(Math.max(0, num(a.sessionRate)) * Math.max(0, num(a.estSessions)));
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
      return perSessionCost(a);
    case 'fixed_retainer':
      return Math.max(0, Math.round(num(a.retainerAmount)));
    default:
      return 0;
  }
}

// Worker status values. 'active' = paid normally. 'chld' (חל"ד,
// maternity) and 'chlt' (חל"ט, extended sick leave) mean the worker is
// NOT paid while on leave — their assignment cost counts as 0.
const WORKER_STATUSES = ['active', 'chld', 'chlt'];
const LEAVE_STATUSES = ['chld', 'chlt'];

// Normalizes any incoming status to a known value; unknown/missing → active.
function workerStatus(a) {
  const s = a && a.status ? String(a.status) : 'active';
  return WORKER_STATUSES.indexOf(s) >= 0 ? s : 'active';
}

// True when the assignment's worker is on unpaid leave (חל"ד / חל"ט).
function isOnLeave(a) {
  return LEAVE_STATUSES.indexOf(workerStatus(a)) >= 0;
}

// Total monthly cost = employment terms + allowance (car+gas / gas / none).
// The allowance applies to every employment type, so it's added on top of
// the per-type base cost rather than living inside the switch.
// A worker on חל"ד / חל"ט is not paid, so their cost is 0 (salary AND
// allowance both stop).
function assignmentCost(a) {
  if (!a) return 0;
  if (isOnLeave(a)) return 0;
  return assignmentBaseCost(a) + allowanceValue(a);
}

// ---------- monthly actuals (hourly / per_session) ----------
// Hourly and per_session assignments are paid by what was actually worked
// each month. A monthly_actuals row (keyed by assignmentId + month) carries
// the real actualHours / actualSessions; when present, cost is
// rate × actual (+ allowance) instead of the one-time estimate on the
// assignment. When absent, we fall back to the estimate and flag it so the
// UI can badge it ("אומדן"). Fixed-salary types (full_time / part_time /
// fixed_retainer) never use actuals — their cost is the same every month.
// Leave (חל"ד / חל"ט) still zeroes the cost, ahead of any actual/estimate.

// The current month as 'YYYY-MM' (from today's date).
function currentMonth() {
  return todayStr().slice(0, 7);
}

// Index a flat monthly_actuals list into a lookup keyed by
// `${assignmentId}|${month}`. Later rows win on a duplicate key (the server
// stores one row per pair, so duplicates shouldn't occur — last-wins is a
// safe tie-break).
function indexActuals(actuals) {
  const idx = Object.create(null);
  (actuals || []).forEach(r => {
    if (!r || !r.assignmentId || !r.month) return;
    idx[r.assignmentId + '|' + r.month] = r;
  });
  return idx;
}

function lookupActual(actualsIndex, assignmentId, month) {
  if (!actualsIndex || !assignmentId || !month) return null;
  return actualsIndex[assignmentId + '|' + month] || null;
}

// True when a recorded quantity is a usable non-null number. A blank cell
// reads back as null (see the Apps Script reader) and must be treated as
// "not recorded" — which is different from a recorded 0.
function hasRecorded(v) {
  return v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
}

// Cost of one assignment for a given month, with the actuals-or-estimate
// decision. Returns { cost, isEstimate }:
//   - isEstimate=true means an hourly / per_session assignment had NO
//     actuals row for the month, so the estimate (rate × est) was used and
//     the UI should flag it.
//   - isEstimate=false covers fixed types, leave (cost 0), and hourly /
//     per_session rows that DO have actuals.
function monthlyAssignmentCost(a, actual) {
  if (!a) return { cost: 0, isEstimate: false };
  if (isOnLeave(a)) return { cost: 0, isEstimate: false };
  const allowance = allowanceValue(a);
  if (a.employmentType === 'hourly') {
    if (actual && hasRecorded(actual.actualHours)) {
      const base = Math.round(Math.max(0, num(a.hourlyRate)) * Math.max(0, num(actual.actualHours)));
      return { cost: base + allowance, isEstimate: false };
    }
    return { cost: assignmentCost(a), isEstimate: true };
  }
  if (a.employmentType === 'per_session') {
    if (actual && hasRecorded(actual.actualSessions)) {
      // Actuals record the count of INDIVIDUAL sessions actually held this
      // month. Price them at the individual rate (falling back to the legacy
      // single rate for rows not yet migrated), then add the group + external
      // estimates on top — those have no per-month actuals of their own.
      const indRate = Math.max(0, num(a.rateIndividual)) || Math.max(0, num(a.sessionRate));
      const indBase = Math.round(indRate * Math.max(0, num(actual.actualSessions)));
      const grpExt = Math.max(0, num(a.rateGroup)) * Math.max(0, num(a.sessionsGroup))
                   + Math.max(0, num(a.rateExternal)) * Math.max(0, num(a.externalPatients));
      return { cost: indBase + Math.round(grpExt) + allowance, isEstimate: false };
    }
    return { cost: assignmentCost(a), isEstimate: true };
  }
  // Fixed-salary types are month-invariant.
  return { cost: assignmentCost(a), isEstimate: false };
}

function assignmentsByHouse(assignments, house) {
  return (assignments || []).filter(a => a && a.house === house);
}

// Month-aware sum of a house's assignment costs (actuals where present,
// estimate otherwise). Parallel to houseAssignmentsCost, which always uses
// the estimate.
function houseMonthlyAssignmentsCost(assignments, actualsIndex, house, month) {
  return assignmentsByHouse(assignments, house)
    .reduce((s, a) => s + monthlyAssignmentCost(a, lookupActual(actualsIndex, a.id, month)).cost, 0);
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

// ---------- month-aware house / network totals ----------
// Same shape as houseTotal / networkTotal, but assignment costs use the
// selected month's actuals (falling back to the estimate). Coverage extras
// and pending-termination costs keep their "active today" semantics — they
// are inherently about who is helping / leaving right now, not a historical
// month reconstruction — so both are computed against `today` as before.
// This keeps the v3 coverage/termination cost contract unchanged.

function houseMonthlyTotal(assignments, coverages, absences, archive, actualsIndex, house, month, today) {
  return houseMonthlyAssignmentsCost(assignments, actualsIndex, house, month)
    + coverageExtra(coverages, absences, house, today)
    + pendingHouseCost(archive, house, today);
}

function networkMonthlyTotal(assignments, coverages, absences, archive, actualsIndex, houseIds, month, today) {
  const ids = houseIds || [];
  let total = 0;
  ids.forEach(h => {
    total += houseMonthlyAssignmentsCost(assignments, actualsIndex, h, month);
    total += pendingHouseCost(archive, h, today);
  });
  const byHouse = activeCoveragesByHouse(coverages, absences, today);
  Object.keys(byHouse).forEach(h => {
    byHouse[h].forEach(c => { total += Math.max(0, num(c.extraPayment)); });
  });
  return total;
}

// ---------- budgets ----------
// A per-house monthly salary budget. Rows target a house for a specific
// month ('YYYY-MM') or the sentinel 'default'. The most specific match
// wins: a row for the exact month overrides the 'default' row.

// Resolve the budget amount for (house, month), or null if none is set.
function budgetForHouse(budgets, house, month) {
  const list = (budgets || []).filter(b => b && b.house === house);
  const specific = list.find(b => String(b.month) === String(month));
  if (specific) return Math.max(0, num(specific.amount));
  const def = list.find(b => String(b.month) === 'default');
  if (def) return Math.max(0, num(def.amount));
  return null;
}

// Compare a cost against a budget. Returns:
//   { budget, cost, variance, pct, status }
//   - variance = budget − cost (₪): positive = under budget (headroom),
//     negative = over.
//   - pct = cost as a percentage of budget (utilization); null when no
//     budget, Infinity when budget is 0 but cost > 0.
//   - status: 'none' (no budget set), 'ok' (green, at or under budget),
//     'warn' (amber, over by ≤10%), 'over' (red, over by >10%).
function budgetVariance(budget, cost) {
  const c = Math.max(0, num(cost));
  if (budget === null || budget === undefined) {
    return { budget: null, cost: c, variance: null, pct: null, status: 'none' };
  }
  const b = Math.max(0, num(budget));
  const variance = b - c;
  let pct;
  if (b > 0) pct = Math.round((c / b) * 1000) / 10;   // one decimal
  else pct = c > 0 ? Infinity : 0;
  let status;
  if (c <= b) status = 'ok';
  else if (c <= b * 1.1) status = 'warn';
  else status = 'over';
  return { budget: b, cost: c, variance: variance, pct: pct, status: status };
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
  assignmentCategory, assignmentCost, assignmentBaseCost, perSessionCost,
  ALLOWANCE_VALUES, allowanceValue,
  WORKER_STATUSES, LEAVE_STATUSES, workerStatus, isOnLeave,
  assignmentsByHouse, houseAssignmentsCost, splitByCategory,
  currentMonth, indexActuals, lookupActual, monthlyAssignmentCost,
  houseMonthlyAssignmentsCost, houseMonthlyTotal, networkMonthlyTotal,
  todayStr,
  isAbsenceActive, activeAbsences, openAbsences,
  coveragesForAbsence, isCoverageActive, activeCoveragesByHouse, coverageExtra,
  pendingTerminations, pendingHouseCost,
  houseTotal, networkTotal,
  budgetForHouse, budgetVariance,
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
