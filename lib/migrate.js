'use strict';

// Pure migration mappers — legacy v2 row shape → v3 entity shape.
// Used by tests/migration.test.js (directly) and by apps-script/Code.gs
// (inlined copy in `migrateToV3`/`dryRunMigrateToV3` — keep in sync).
//
// Input shape: the parsed JS objects that v2 Code.gs returned for each
// row of the legacy `<house>` / `events` / `archive` tabs. NOT raw cell
// arrays — that parsing is Apps-Script-specific and stays in Code.gs.

// Legacy data only ever held salaried workers (full_time + part_time). The
// new freelance types (hourly / per_session / fixed_retainer) are entered
// post-migration; nothing in legacy maps to them.
const LEGACY_EMPLOYMENT_TYPES = ['full_time', 'part_time'];

// Reasons recognized when copying over absences. Must match
// ABSENCE_REASON_TYPES in lib/validate.js. Legacy reasonType values that
// aren't in this list collapse to 'אחר' to keep migration lossless.
const ABSENCE_REASON_TYPES = [
  'חופשה', 'חל״ת', 'מחלה', 'חופשת לידה', 'ניתוח', 'צורך תפעולי', 'אישי', 'אחר',
];

// Marker text on synthesized rows so a human reading the Sheet can tell
// migrated rows from native v3 rows.
const MIGRATION_NOTE_NO_ABSENTEE = 'יובא ממודל ישן ללא רישום נעדר';
const MIGRATION_NOTE_COVERAGE = 'יובא ממודל ישן';

// Convert legacy (salary, pct) → v3 (employmentType, salary, pct).
//   pct === 100 → full_time. Salary kept, pct stored as 0 because it's
//                 not meaningful for full_time.
//   pct  <  100 → part_time. Salary kept, pct kept (clamped to [1,100]).
function legacyTermsFromPct(salary, pct) {
  const s = Math.max(0, Math.round(Number(salary) || 0));
  const p = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
  if (p === 100) return { employmentType: 'full_time', salary: s, pct: 0 };
  // Guard: pct === 0 in legacy data → store as 1 in part_time so the
  // assignment validator doesn't reject it on round-trip.
  return { employmentType: 'part_time', salary: s, pct: p > 0 ? p : 1 };
}

// Legacy employee row + the house tab it came from → v3 assignment row.
// `emp.id` is reused as the worker_id (opaque). All freelance-type fields
// are zeroed.
function mapLegacyEmployeeToAssignment(emp, house) {
  if (!emp) return null;
  const terms = legacyTermsFromPct(emp.salary, emp.pct);
  return {
    workerId: String(emp.id || ''),
    house: String(house || ''),
    role: String(emp.role || ''),
    roleDetail: String(emp.roleDetail || ''),
    employmentType: terms.employmentType,
    salary: terms.salary,
    pct: terms.pct,
    hourlyRate: 0,
    estHours: 0,
    sessionRate: 0,
    estSessions: 0,
    retainerAmount: 0,
    notes: String(emp.notes || ''),
  };
}

// Legacy event row → v3.1 absence + coverage pair (independent events).
//
// Old model: "employee E helped host_house from home_house, possibly
//   replacing covers_employee_id."
// v3.1 model: an ABSENCE record (who is missing from where) + a COVERAGE
//   record (who is helping, from where, to where, when, for how much).
//   The two records are now independent; the coverage carries its own
//   dates + receivingHouse, and the absenceId FK is reference-only.
//
// Mapping:
//   absence.workerId = ev.coversEmployeeId   (the person being covered for)
//   absence.house    = ev.hostHouse          (where they're missing FROM)
//   coverage.coveringWorkerId = ev.employeeId
//   coverage.coveringHouse    = ev.homeHouse  (where the helper is based)
//   coverage.receivingHouse   = ev.hostHouse  (where the help is going =
//                                              same as absence.house)
//   coverage.startDate/endDate = ev.startDate/ev.endDate
//   coverage.extraPayment     = ev.bonusAmount
//
// Most legacy events have coversEmployeeId === '' because the v1/v2 UI
// didn't require it. In that case we synthesize a stub absence with
// workerId='' and a marker note. The coverage stays valid on its own
// even without the FK because it now carries receivingHouse + dates
// directly.
function mapLegacyEventToAbsenceCoverage(ev) {
  if (!ev) return null;
  const reasonType = ABSENCE_REASON_TYPES.indexOf(ev.reasonType) >= 0
    ? ev.reasonType
    : 'אחר';
  const hasAbsentee = !!String(ev.coversEmployeeId || '').trim();
  const status = String(ev.status) === 'active' ? 'active' : 'ended';
  const startDate = String(ev.startDate || '');
  const endDate = String(ev.endDate || '');
  const hostHouse = String(ev.hostHouse || '');
  const absence = {
    workerId: hasAbsentee ? String(ev.coversEmployeeId) : '',
    house: hostHouse,
    startDate,
    endDate,
    reasonType,
    reasonDetail: String(ev.reasonDetail || ''),
    notes: hasAbsentee ? '' : MIGRATION_NOTE_NO_ABSENTEE,
    status,
  };
  const coverage = {
    // absenceId is filled in by the migration writer once the absence
    // row is committed and has an id.
    absenceId: '',
    coveringWorkerId: String(ev.employeeId || ''),
    coveringHouse: String(ev.homeHouse || ''),
    receivingHouse: hostHouse,
    startDate,
    endDate,
    extraPayment: Math.max(0, Math.round(Number(ev.bonusAmount) || 0)),
    notes: MIGRATION_NOTE_COVERAGE,
  };
  return { absence, coverage };
}

// Legacy archive row → v3 archive_v3 row. Carries frozen terms so cost
// reconstruction for pending terminations works without joining back to
// the active assignments list. `assignmentId` is blank because no
// v3 assignment ever existed for these — they predate the assignments tab.
function mapLegacyArchiveRow(arch) {
  if (!arch) return null;
  const terms = legacyTermsFromPct(arch.salary, arch.pct);
  return {
    assignmentId: '',
    workerId: String(arch.employeeId || ''),
    name: String(arch.name || ''),
    house: String(arch.homeHouse || ''),
    role: String(arch.role || ''),
    roleDetail: String(arch.roleDetail || ''),
    employmentType: terms.employmentType,
    salary: terms.salary,
    pct: terms.pct,
    hourlyRate: 0,
    estHours: 0,
    sessionRate: 0,
    estSessions: 0,
    retainerAmount: 0,
    notes: String(arch.notes || ''),
    terminationDate: String(arch.terminationDate || ''),
    reasonType: String(arch.reasonType || ''),
    reasonDetail: String(arch.reasonDetail || ''),
    archivedAt: String(arch.archivedAt || ''),
  };
}

// Build the workers list by collecting unique employee_id + name across
// all legacy sources. House tabs are authoritative for the current name;
// archive provides names for terminated employees no longer in any house
// tab. First occurrence wins (so house-tab names take precedence over
// archive snapshots).
function collectWorkers({ houses, archive }) {
  const seen = Object.create(null);
  const out = [];

  function add(id, name) {
    const key = String(id || '').trim();
    if (!key) return;
    if (seen[key]) return;
    seen[key] = true;
    out.push({ id: key, name: String(name || ''), notes: '' });
  }

  const houseIds = Object.keys(houses || {});
  houseIds.forEach(h => {
    (houses[h] || []).forEach(emp => add(emp.id, emp.name));
  });
  (archive || []).forEach(arch => add(arch.employeeId, arch.name));

  return out;
}

module.exports = {
  LEGACY_EMPLOYMENT_TYPES,
  ABSENCE_REASON_TYPES,
  MIGRATION_NOTE_NO_ABSENTEE,
  MIGRATION_NOTE_COVERAGE,
  legacyTermsFromPct,
  mapLegacyEmployeeToAssignment,
  mapLegacyEventToAbsenceCoverage,
  mapLegacyArchiveRow,
  collectWorkers,
};
