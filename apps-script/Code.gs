/* ============================================================
   E-ZONE Staffing — Apps Script backend (v3)
   Bound to a Google Sheet. Deployed as Web App (execute as: me,
   who has access: anyone). Auth is enforced via a shared secret
   passed in every request — the URL alone is NOT authorization.

   Script properties required:
     - SHARED_SECRET   : must match server.js SHARED_SECRET env var
     - SHEET_ID        : the spreadsheet id (the long string in the
                         Sheet URL between /d/ and /edit)
   Script properties written by this script:
     - V3_MIGRATION_DONE = 'true' once migrateToV3 has succeeded.
       Cleared by rollbackV3.

   Data model (v3) — see CHANGELOG.md and MIGRATION.md.

   workers tab:
     id | name | notes | created_at
     One row per person. id is reused as worker_id everywhere.

   assignments tab:
     id | worker_id | house | role | role_detail | employment_type |
     salary | pct | hourly_rate | est_hours | session_rate |
     est_sessions | retainer_amount | notes | created_at
     One row per (worker × house). Each row carries its own terms;
     cost per house is the amount entered, never auto-split.

   absences tab:
     id | worker_id | house | start_date | end_date | reason_type |
     reason_detail | notes | status | created_at
     `house` is the house the worker is missing FROM (= "house
     needing coverage" in the UI). status is derived from dates on
     read; stored value is a hint and gets lazily corrected.

   coverages tab (v3.1 — independent events):
     id | absence_id | covering_worker_id | covering_house |
     receiving_house | start_date | end_date | extra_payment |
     notes | created_at
     covering_house = where the helper is based (cost of their own
     assignment continues to accrue there). receiving_house = where the
     help is going (extra_payment accrues here). absence_id is OPTIONAL —
     a coverage may be logged without a linked absence; if set, it's a
     reference, not a parent pointer. A coverage's effective date range
     is its own start_date..end_date, independent of any linked absence.

   archive_v3 tab:
     id | assignment_id | worker_id | name | house | role |
     role_detail | employment_type | salary | pct | hourly_rate |
     est_hours | session_rate | est_sessions | retainer_amount |
     notes | termination_date | reason_type | reason_detail |
     archived_at
     A snapshot of a terminated assignment. Cost continues counting
     until termination_date arrives, then drops to 0. Any active
     absence at the same (worker, house) is auto-truncated to
     termination_date.

   LEGACY tabs (untouched by migrateToV3, renamed to _legacy_* by
   finalizeV3): ramot/asher/ofroni/rehab, events, history, archive.
   Read by doGet for the transition window — return as `houses`,
   `events`, `archive` keys in the response so the v2 UI keeps
   functioning until the v3 UI ships. After finalize, those keys
   return empty / [].
   ============================================================ */

// `hq` is a pseudo-house for headquarters / admin staff. See
// lib/validate.js and MIGRATION.md "Houses" for the canonical id →
// Hebrew display name mapping; this list must mirror lib/validate.js.
const HOUSE_IDS = [
  'ramot', 'asher', 'ofroni', 'rehab',
  'pardes', 'sde_eliezer',
  'hq',
];

// v3 tabs
const WORKERS_TAB = 'workers';
const ASSIGNMENTS_TAB = 'assignments';
const ABSENCES_TAB = 'absences';
const COVERAGES_TAB = 'coverages';
const ARCHIVE_V3_TAB = 'archive_v3';
// Monthly actuals: real hours/sessions worked per (assignment, month),
// replacing the one-time estimate for hourly / per_session cost. Append-only
// columns; one row per (assignment, month), updated in place on re-upsert.
const MONTHLY_ACTUALS_TAB = 'monthly_actuals';
// Per-house monthly salary budgets. One row per (house, month) where month
// is 'YYYY-MM' or the sentinel 'default' (fallback for any month without a
// specific override). Append-only; upserted in place per (house, month).
const BUDGETS_TAB = 'budgets';

// Legacy tabs (read-only during transition; renamed by finalizeV3).
const HISTORY_TAB = 'history';
const EVENTS_TAB = 'events';
const ARCHIVE_TAB = 'archive';
const LEGACY_PREFIX = '_legacy_';

// APPEND-ONLY. _readAll/_writeAll map columns by position, so a mid-array
// insert would shift every stored value one column right and corrupt every
// row. 'shift_commitment' (worker-level contractual commitment) must stay
// last; new columns go after it, never before.
const HEADERS_WORKERS = ['id', 'name', 'notes', 'created_at', 'shift_commitment'];
// APPEND-ONLY (columns 0-14 are the original v3 shape). Columns 15+ were
// appended later and MUST stay in this order — read/write map by position:
//   15 allowance, 16 status, 17 status_date  (fixes the leave-status bug —
//      previously validated but never persisted, so חל"ד never stuck);
//   18-23 the per_session 3-rate model (individual / group / external),
//      populated for existing rows by migratePerSessionRatesToThreeRate().
const HEADERS_ASSIGNMENTS = [
  'id', 'worker_id', 'house', 'role', 'role_detail', 'employment_type',
  'salary', 'pct', 'hourly_rate', 'est_hours',
  'session_rate', 'est_sessions', 'retainer_amount',
  'notes', 'created_at',
  'allowance', 'status', 'status_date',
  'rate_individual', 'sessions_individual',
  'rate_group', 'sessions_group',
  'rate_external', 'external_patients',
];
const HEADERS_ABSENCES = [
  'id', 'worker_id', 'house', 'start_date', 'end_date',
  'reason_type', 'reason_detail', 'notes', 'status', 'created_at',
];
// v3.1 schema. The previous shape had `providing_house` and inherited
// dates from the parent absence. migrateCoveragesToV3_1 rewrites the
// existing tab in-place: providing_house → covering_house, plus new
// receiving_house / start_date / end_date columns backfilled from the
// linked absence.
const HEADERS_COVERAGES = [
  'id', 'absence_id', 'covering_worker_id',
  'covering_house', 'receiving_house', 'start_date', 'end_date',
  'extra_payment', 'notes', 'created_at',
];
// APPEND-ONLY. Columns 20-25 (the per_session 3-rate snapshot) were
// appended so a terminated therapist's frozen terms keep their real cost
// during the notice window — the legacy session_rate/est_sessions pair is 0
// for workers created under the 3-rate model.
const HEADERS_ARCHIVE_V3 = [
  'id', 'assignment_id', 'worker_id', 'name', 'house', 'role', 'role_detail',
  'employment_type',
  'salary', 'pct', 'hourly_rate', 'est_hours',
  'session_rate', 'est_sessions', 'retainer_amount',
  'notes', 'termination_date', 'reason_type', 'reason_detail', 'archived_at',
  'rate_individual', 'sessions_individual',
  'rate_group', 'sessions_group',
  'rate_external', 'external_patients',
];
// Append-only. Blank actual_hours / actual_sessions mean "not recorded for
// this type" (an hourly row leaves actual_sessions blank and vice versa).
const HEADERS_MONTHLY_ACTUALS = [
  'id', 'assignment_id', 'month', 'actual_hours', 'actual_sessions',
  'note', 'created_at', 'updated_at',
];
// APPEND-ONLY. `amount` is the house TOTAL budget; `instructors_amount`
// (appended after the split) is the optional מדריך/ה sub-line — blank on
// legacy rows written before the split, which read back as instructorsAmount
// = null (total-only, backward compatible). New columns go at the END so the
// position-based reader keeps mapping the original columns unchanged.
const HEADERS_BUDGETS = [
  'id', 'house', 'month', 'amount', 'created_at', 'updated_at', 'instructors_amount',
];

// Legacy headers (only used by setupSheetsV3 to repair partial legacy state
// during testing; migrateToV3 reads whatever is there regardless of header
// presence).
const HEADERS_HOUSE = ['id', 'name', 'role', 'salary', 'pct', 'notes', 'role_detail'];
const HEADERS_EVENTS = [
  'id', 'employee_id', 'employee_name', 'home_house', 'host_house',
  'start_date', 'end_date', 'reason_type', 'reason_detail',
  'covers_employee_id', 'bonus_amount', 'status', 'created_at',
];
const HEADERS_ARCHIVE = [
  'id', 'employee_id', 'name', 'role', 'role_detail', 'salary', 'pct', 'notes',
  'home_house', 'termination_date', 'reason_type', 'reason_detail', 'archived_at',
];

const ROLE_OPTIONS = [
  'מנהל/ת', 'רכז/ת', 'מדריך/ה', 'מטפל/ת', 'אחות',
  'פסיכיאטר/ית', 'טבח/ית', 'איש/אשת אחזקה', 'אחר',
];
const ABSENCE_REASON_TYPES = [
  'חופשה', 'חל״ת', 'מחלה', 'חופשת לידה', 'ניתוח', 'צורך תפעולי', 'אישי', 'אחר',
];
const TERMINATION_REASONS = [
  'התפטרות', 'פיטורין', 'סיום חוזה', 'מעבר תפקיד', 'אחר',
];
const EMPLOYMENT_TYPES = [
  'full_time', 'part_time', 'hourly', 'per_session', 'fixed_retainer',
];

// Contractual weekly shift-commitment enum for instructors: weekday shifts
// plus one weekend shift. ASCII keys — must match SHIFT_COMMITMENTS in
// lib/shift-compliance.js, the shared source of truth. Raw value only; the
// backend never computes a compliance / qualifies flag from it.
const SHIFT_COMMITMENT_VALUES = ['3+1', '4+1', '5+1'];

// Mirror of TYPE_COST_FIELDS / ALL_COST_FIELDS in lib/validate.js.
// Defense in depth: the Express proxy validates first, but Apps Script
// re-validates so the Sheet can never be written to with an inconsistent
// (type, cost-fields) combo even if someone calls /exec directly.
// per_session carries the three optional rate/count pairs (individual /
// group / external) PLUS the legacy single sessionRate/estSessions pair.
const PER_SESSION_RATE_FIELDS = [
  'rateIndividual', 'sessionsIndividual',
  'rateGroup', 'sessionsGroup',
  'rateExternal', 'externalPatients',
];
const TYPE_COST_FIELDS = {
  full_time:      ['salary'],
  part_time:      ['salary', 'pct'],
  hourly:         ['hourlyRate', 'estHours'],
  per_session:    ['sessionRate', 'estSessions'].concat(PER_SESSION_RATE_FIELDS),
  fixed_retainer: ['retainerAmount'],
};
const ALL_COST_FIELDS = [
  'salary', 'pct',
  'hourlyRate', 'estHours',
  'sessionRate', 'estSessions',
  'retainerAmount',
].concat(PER_SESSION_RATE_FIELDS);

// Whitelisted monthly allowance values (₪) — mirror lib/calc.js /
// lib/validate.js: none / gas-only / car+gas.
const ALLOWANCE_VALUES = [0, 2000, 6000];
// Worker status: active (paid) / chld (חל"ד) / chlt (חל"ט). Leave states
// are unpaid and carry a start date.
const WORKER_STATUS_VALUES = ['active', 'chld', 'chlt'];

// Per-field caps — must mirror lib/validate.js.
const SALARY_MAX = 1000000;
const HOURLY_RATE_MAX = 1000;
const SESSION_RATE_MAX = 5000;
const RETAINER_MAX = 200000;
const EST_HOURS_MAX = 744;
const EST_SESSIONS_MAX = 500;
const EXTRA_PAYMENT_MAX = 100000;
const ACTUAL_HOURS_MAX = EST_HOURS_MAX;
const ACTUAL_SESSIONS_MAX = EST_SESSIONS_MAX;
const MONTHLY_ACTUALS_MAX_ITEMS = 1000;
const BUDGET_MAX = 100000000;

// Migration markers — mirror lib/migrate.js.
const MIGRATION_NOTE_NO_ABSENTEE = 'יובא ממודל ישן ללא רישום נעדר';
const MIGRATION_NOTE_COVERAGE = 'יובא ממודל ישן';

// ---------- entry points ----------

function doGet(e) {
  return handle(e, function () {
    const houses = {};
    HOUSE_IDS.forEach(function (h) { houses[h] = readLegacyHouseSafe(h); });
    return {
      // v3 shape
      workers: readWorkersSafe(),
      assignments: readAssignmentsSafe(),
      absences: readAbsencesSafe(),
      coverages: readCoveragesSafe(),
      archiveV3: readArchiveV3Safe(),
      monthlyActuals: readMonthlyActualsSafe(),
      budgets: readBudgetsSafe(),
      // legacy passthrough — empty arrays/objects when tabs are missing
      // (e.g. after finalizeV3 or on a fresh v3-only install).
      houses: houses,
      events: readLegacyEventsSafe(),
      archive: readLegacyArchiveSafe(),
      _compat: true,
    };
  });
}

function doPost(e) {
  return handle(e, function () {
    const body = parseBody(e);
    switch (body.action) {
      case 'createWorker':         return createWorker(body);
      case 'updateWorker':         return updateWorker(body);
      case 'deleteWorker':         return deleteWorker(body);
      case 'addAssignment':        return addAssignment(body);
      case 'updateAssignment':     return updateAssignment(body);
      case 'deleteAssignment':     return deleteAssignment(body);
      case 'moveAssignment':       return moveAssignment(body);
      case 'terminateAssignment':  return terminateAssignment(body);
      case 'logAbsence':           return logAbsence(body);
      case 'endAbsence':           return endAbsence(body);
      case 'deleteAbsence':        return deleteAbsence(body);
      case 'addCoverage':          return addCoverage(body);
      case 'deleteCoverage':       return deleteCoverage(body);
      case 'upsertMonthlyActuals': return upsertMonthlyActuals(body);
      case 'getMonthlyActuals':    return getMonthlyActuals(body);
      case 'setBudget':            return setBudget(body);
      case 'getBudgets':           return getBudgets(body);
      default: throw httpError(400, 'unknown action');
    }
  });
}

function handle(e, fn) {
  try {
    if (!authorized(e)) return json({ error: 'unauthorized' }, 401);
    return json(fn(), 200);
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    const msg = (err && err.message) || String(err);
    return json({ error: msg }, status);
  }
}

function authorized(e) {
  const required = PropertiesService.getScriptProperties().getProperty('SHARED_SECRET');
  if (!required) return false;
  const provided = (e && e.parameter && e.parameter.secret) || '';
  if (provided.length !== required.length) return false;
  let diff = 0;
  for (let i = 0; i < required.length; i++) {
    diff |= required.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return diff === 0;
}

function parseBody(e) {
  if (!e || !e.postData || !e.postData.contents) throw httpError(400, 'empty body');
  try { return JSON.parse(e.postData.contents); }
  catch (err) { throw httpError(400, 'bad json'); }
}

function json(obj, status) {
  const payload = Object.assign({ _status: status || 200 }, obj);
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// ---------- sheet plumbing ----------

function ss() {
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!id) throw httpError(500, 'SHEET_ID script property is not set');
  return SpreadsheetApp.openById(id);
}

function sheetByName(name) {
  const sh = ss().getSheetByName(name);
  if (!sh) throw httpError(500, 'missing sheet: ' + name);
  return sh;
}

function sheetByNameOrNull(name) {
  return ss().getSheetByName(name);
}

// ---------- validators (mirror lib/validate.js) ----------

function isHouse(id)          { return HOUSE_IDS.indexOf(id) >= 0; }
function isRole(role)         { return ROLE_OPTIONS.indexOf(role) >= 0; }
function isEmploymentType(t)  { return EMPLOYMENT_TYPES.indexOf(t) >= 0; }

// Worker-level shift commitment. Optional: '' / missing is valid. When
// present it must be a whitelisted enum value — otherwise we throw, so a
// caller hitting /exec directly can never write free text into the sheet.
// Returns the normalized value ('' when absent). No compliance computed.
function validateShiftCommitment(v) {
  if (v === undefined || v === null) return '';
  const s = String(v).trim();
  if (s === '') return '';
  if (SHIFT_COMMITMENT_VALUES.indexOf(s) < 0) throw httpError(400, 'bad shift_commitment');
  return s;
}

function clampPct(n) {
  if (!isFinite(n)) return 100;
  return Math.max(1, Math.min(100, Math.round(n)));
}

function clampMoney(n, max) {
  const num = Number(n);
  if (!isFinite(num)) return 0;
  return Math.max(0, Math.min(max, Math.round(num)));
}

function clampInt(n, max) {
  const num = Number(n);
  if (!isFinite(num)) return 0;
  return Math.max(0, Math.min(max, Math.round(num)));
}

function validateWorker(w) {
  if (!w || typeof w !== 'object') throw httpError(400, 'worker required');
  const name = String(w.name || '').trim().slice(0, 80);
  if (!name) throw httpError(400, 'name required');
  const notes = String(w.notes || '').trim().slice(0, 500);
  const shiftCommitment = validateShiftCommitment(w.shift_commitment);
  return { name: name, notes: notes, shiftCommitment: shiftCommitment };
}

function validateAssignment(a) {
  if (!a || typeof a !== 'object') throw httpError(400, 'assignment required');
  const workerId = String(a.workerId || '').trim();
  if (!workerId) throw httpError(400, 'workerId required');
  if (!isHouse(a.house)) throw httpError(400, 'unknown house');
  const role = String(a.role || '').trim();
  if (!isRole(role)) throw httpError(400, 'bad role');
  const roleDetail = String(a.roleDetail || '').trim().slice(0, 80);
  if (role === 'אחר' && !roleDetail) {
    throw httpError(400, 'roleDetail required when role is אחר');
  }
  const employmentType = String(a.employmentType || '').trim();
  if (!isEmploymentType(employmentType)) throw httpError(400, 'bad employmentType');
  const notes = String(a.notes || '').trim().slice(0, 500);

  // Monthly allowance (₪): whitelisted enum, applies to every type.
  const allowanceRaw = Number(a.allowance);
  const allowance = ALLOWANCE_VALUES.indexOf(allowanceRaw) >= 0 ? allowanceRaw : 0;

  // Worker status: active / chld (חל"ד) / chlt (חל"ט). Leave states are
  // unpaid and REQUIRE a start date; active carries none. Unknown → active.
  const statusRaw = String(a.status || 'active').trim();
  const status = WORKER_STATUS_VALUES.indexOf(statusRaw) >= 0 ? statusRaw : 'active';
  let statusDate = '';
  if (status === 'chld' || status === 'chlt') {
    statusDate = validateRequiredDate(a.statusDate, 'statusDate');
  }

  // Mirror of lib/validate.js: reject cost fields that don't belong to
  // the chosen type. Checks the raw input — silently zeroing would mask
  // the inconsistency rather than surface it.
  const allowed = TYPE_COST_FIELDS[employmentType];
  for (let i = 0; i < ALL_COST_FIELDS.length; i++) {
    const f = ALL_COST_FIELDS[i];
    if (allowed.indexOf(f) >= 0) continue;
    const raw = a[f];
    if (raw === undefined || raw === null || raw === '') continue;
    const v = Number(raw);
    if (isFinite(v) && v > 0) {
      throw httpError(400, f + ' not allowed for employmentType=' + employmentType);
    }
  }

  let salary = 0, pct = 0, hourlyRate = 0, estHours = 0;
  let sessionRate = 0, estSessions = 0, retainerAmount = 0;
  // per_session 3-rate model (all optional, default 0).
  let rateIndividual = 0, sessionsIndividual = 0;
  let rateGroup = 0, sessionsGroup = 0;
  let rateExternal = 0, externalPatients = 0;

  switch (employmentType) {
    case 'full_time':
      salary = clampMoney(a.salary, SALARY_MAX);
      if (salary <= 0) throw httpError(400, 'salary required for full_time');
      break;
    case 'part_time':
      salary = clampMoney(a.salary, SALARY_MAX);
      if (salary <= 0) throw httpError(400, 'salary required for part_time');
      pct = clampPct(a.pct);
      break;
    case 'hourly':
      hourlyRate = clampMoney(a.hourlyRate, HOURLY_RATE_MAX);
      if (hourlyRate <= 0) throw httpError(400, 'hourlyRate required for hourly');
      estHours = clampInt(a.estHours, EST_HOURS_MAX);
      if (estHours <= 0) throw httpError(400, 'estHours required for hourly');
      break;
    case 'per_session':
      // Three optional rate/count pairs; legacy pair stays accepted so
      // pre-migration rows round-trip. clampMoney/clampInt floor negatives
      // to 0 and cap at the session maxima.
      sessionRate = clampMoney(a.sessionRate, SESSION_RATE_MAX);
      estSessions = clampInt(a.estSessions, EST_SESSIONS_MAX);
      rateIndividual     = clampMoney(a.rateIndividual, SESSION_RATE_MAX);
      sessionsIndividual = clampInt(a.sessionsIndividual, EST_SESSIONS_MAX);
      rateGroup          = clampMoney(a.rateGroup, SESSION_RATE_MAX);
      sessionsGroup      = clampInt(a.sessionsGroup, EST_SESSIONS_MAX);
      rateExternal       = clampMoney(a.rateExternal, SESSION_RATE_MAX);
      externalPatients   = clampInt(a.externalPatients, EST_SESSIONS_MAX);
      break;
    case 'fixed_retainer':
      retainerAmount = clampMoney(a.retainerAmount, RETAINER_MAX);
      if (retainerAmount <= 0) throw httpError(400, 'retainerAmount required for fixed_retainer');
      break;
  }

  return {
    workerId: workerId, house: a.house, role: role, roleDetail: roleDetail,
    employmentType: employmentType,
    salary: salary, pct: pct,
    hourlyRate: hourlyRate, estHours: estHours,
    sessionRate: sessionRate, estSessions: estSessions,
    retainerAmount: retainerAmount,
    rateIndividual: rateIndividual, sessionsIndividual: sessionsIndividual,
    rateGroup: rateGroup, sessionsGroup: sessionsGroup,
    rateExternal: rateExternal, externalPatients: externalPatients,
    allowance: allowance,
    status: status, statusDate: statusDate,
    notes: notes,
  };
}

// v3.1: workerId is optional (stub rows). Mirror of lib/validate.js.
function validateAbsence(a) {
  if (!a || typeof a !== 'object') throw httpError(400, 'absence required');
  const workerId = String(a.workerId || '').trim();  // '' allowed → stub
  if (!isHouse(a.house)) throw httpError(400, 'unknown house');
  const startDate = validateRequiredDate(a.startDate, 'startDate');
  const endDate = validateRequiredDate(a.endDate, 'endDate');
  if (endDate < startDate) throw httpError(400, 'endDate before startDate');
  const reasonType = String(a.reasonType || '');
  if (ABSENCE_REASON_TYPES.indexOf(reasonType) < 0) throw httpError(400, 'bad reasonType');
  const reasonDetail = String(a.reasonDetail || '').trim().slice(0, 500);
  const notes = String(a.notes || '').trim().slice(0, 500);
  return {
    workerId: workerId, house: a.house,
    startDate: startDate, endDate: endDate,
    reasonType: reasonType, reasonDetail: reasonDetail, notes: notes,
  };
}

// v3.1: coverage is now independent of any parent absence.
//   - coveringHouse (was providingHouse): where the helper is based.
//   - receivingHouse (NEW): where the help is going.
//   - startDate/endDate are the coverage's own range, not the absence's.
//   - absenceId is optional. When set, it's a reference; the server adds
//     an extra FK consistency check in addCoverage.
// Mirror of lib/validate.js.
function validateCoverage(c) {
  if (!c || typeof c !== 'object') throw httpError(400, 'coverage required');
  const absenceId = String(c.absenceId || '').trim();  // '' allowed → unlinked
  const coveringWorkerId = String(c.coveringWorkerId || '').trim();
  if (!coveringWorkerId) throw httpError(400, 'coveringWorkerId required');
  if (!isHouse(c.coveringHouse)) throw httpError(400, 'unknown coveringHouse');
  if (!isHouse(c.receivingHouse)) throw httpError(400, 'unknown receivingHouse');
  if (c.coveringHouse === c.receivingHouse) {
    throw httpError(400, 'receivingHouse must differ from coveringHouse');
  }
  const startDate = validateRequiredDate(c.startDate, 'startDate');
  const endDate = validateRequiredDate(c.endDate, 'endDate');
  if (endDate < startDate) throw httpError(400, 'endDate before startDate');
  const extraPayment = clampMoney(c.extraPayment, EXTRA_PAYMENT_MAX);
  const notes = String(c.notes || '').trim().slice(0, 500);
  return {
    absenceId: absenceId, coveringWorkerId: coveringWorkerId,
    coveringHouse: c.coveringHouse, receivingHouse: c.receivingHouse,
    startDate: startDate, endDate: endDate,
    extraPayment: extraPayment, notes: notes,
  };
}

function validateRequiredDate(d, label) {
  const s = String(d || '').trim();
  if (!s) throw httpError(400, 'missing ' + label);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw httpError(400, 'bad ' + label);
  return s;
}

// Month key 'YYYY-MM' with a real 01–12 month. Mirror of lib/validate.js.
function validateMonth(m, label) {
  const s = String(m || '').trim();
  if (!s) throw httpError(400, 'missing ' + label);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(s)) throw httpError(400, 'bad ' + label);
  return s;
}

function validateNonNegative(raw, label, max, decimals) {
  const n = Number(raw);
  if (!isFinite(n)) throw httpError(400, 'bad ' + label);
  if (n < 0) throw httpError(400, label + ' must be non-negative');
  const capped = Math.min(n, max);
  if (decimals === 0) return Math.round(capped);
  const f = Math.pow(10, decimals);
  return Math.round(capped * f) / f;
}

// Mirror of lib/validate.js validateMonthlyActualsItem. assignmentId +
// month required; hours/sessions/note optional but validated when present;
// unknown fields rejected. FK (assignment exists) is checked in the action.
const MONTHLY_ACTUALS_FIELDS = ['assignmentId', 'month', 'actualHours', 'actualSessions', 'note'];
function validateMonthlyActualsItem(item) {
  if (!item || typeof item !== 'object') throw httpError(400, 'actuals item required');
  Object.keys(item).forEach(function (k) {
    if (MONTHLY_ACTUALS_FIELDS.indexOf(k) < 0) throw httpError(400, 'unknown field: ' + k);
  });
  const assignmentId = String(item.assignmentId || '').trim();
  if (!assignmentId) throw httpError(400, 'assignmentId required');
  const month = validateMonth(item.month, 'month');
  const out = { assignmentId: assignmentId, month: month };
  let hasValue = false;
  if (item.actualHours !== undefined && item.actualHours !== null && item.actualHours !== '') {
    out.actualHours = validateNonNegative(item.actualHours, 'actualHours', ACTUAL_HOURS_MAX, 2);
    hasValue = true;
  } else {
    out.actualHours = null;
  }
  if (item.actualSessions !== undefined && item.actualSessions !== null && item.actualSessions !== '') {
    out.actualSessions = validateNonNegative(item.actualSessions, 'actualSessions', ACTUAL_SESSIONS_MAX, 0);
    hasValue = true;
  } else {
    out.actualSessions = null;
  }
  const note = String(item.note || '').trim().slice(0, 500);
  out.note = note;
  if (note) hasValue = true;
  if (!hasValue) throw httpError(400, 'actuals item needs actualHours, actualSessions, or note');
  return out;
}

function validateMonthlyActuals(items) {
  if (!Array.isArray(items)) throw httpError(400, 'items must be an array');
  if (!items.length) throw httpError(400, 'items required');
  if (items.length > MONTHLY_ACTUALS_MAX_ITEMS) throw httpError(400, 'too many items');
  const seen = Object.create(null);
  return items.map(function (it) {
    const v = validateMonthlyActualsItem(it);
    const key = v.assignmentId + '|' + v.month;
    if (seen[key]) throw httpError(400, 'duplicate assignmentId+month in request: ' + key);
    seen[key] = true;
    return v;
  });
}

// Budget month: 'YYYY-MM' or the sentinel 'default'. Mirror of lib/validate.js.
function validateBudgetMonth(m) {
  const s = String(m || '').trim();
  if (s === 'default') return 'default';
  return validateMonth(s, 'month');
}

// Mirror of validateBudget in lib/validate.js. `amount` is the house TOTAL;
// `instructorsAmount` is the optional מדריך/ה sub-line — validated
// non-negative + capped when present, null when blank. instructors > total
// is intentionally NOT an error (independent lines, warn-only on the client).
function validateBudget(b) {
  if (!b || typeof b !== 'object') throw httpError(400, 'budget required');
  if (!isHouse(b.house)) throw httpError(400, 'unknown house');
  const month = validateBudgetMonth(b.month);
  const amount = validateNonNegative(b.amount, 'amount', BUDGET_MAX, 0);
  var instructorsAmount = null;
  if (b.instructorsAmount !== undefined && b.instructorsAmount !== null && b.instructorsAmount !== '') {
    instructorsAmount = validateNonNegative(b.instructorsAmount, 'instructorsAmount', BUDGET_MAX, 0);
  }
  return { house: b.house, month: month, amount: amount, instructorsAmount: instructorsAmount };
}

// ---------- v3 readers ----------

function rowsOf(sheet) {
  if (!sheet) return [];
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  return values.slice(1).filter(function (r) {
    return String(r[0] || '').trim() !== '';
  });
}

function readWorkersSafe() {
  const sh = sheetByNameOrNull(WORKERS_TAB);
  return rowsOf(sh).map(function (r) {
    return {
      id: String(r[0]),
      name: String(r[1] || ''),
      notes: String(r[2] || ''),
      createdAt: cellToIso(r[3]),
      // Worker-level contractual commitment. Raw value straight off the
      // sheet — key name matches lib/shift-compliance.js worker.shift_commitment.
      shift_commitment: String(r[4] || ''),
    };
  });
}

function readAssignmentsSafe() {
  const sh = sheetByNameOrNull(ASSIGNMENTS_TAB);
  return rowsOf(sh).map(function (r) {
    return {
      id: String(r[0]),
      workerId: String(r[1] || ''),
      house: String(r[2] || ''),
      role: String(r[3] || ''),
      roleDetail: String(r[4] || ''),
      employmentType: String(r[5] || ''),
      salary: Number(r[6]) || 0,
      pct: Number(r[7]) || 0,
      hourlyRate: Number(r[8]) || 0,
      estHours: Number(r[9]) || 0,
      sessionRate: Number(r[10]) || 0,
      estSessions: Number(r[11]) || 0,
      retainerAmount: Number(r[12]) || 0,
      notes: String(r[13] || ''),
      createdAt: cellToIso(r[14]),
      // Appended columns (blank on legacy rows → sensible defaults).
      allowance: Number(r[15]) || 0,
      status: normalizeStatus(r[16]),
      statusDate: String(r[17] || ''),
      rateIndividual: Number(r[18]) || 0,
      sessionsIndividual: Number(r[19]) || 0,
      rateGroup: Number(r[20]) || 0,
      sessionsGroup: Number(r[21]) || 0,
      rateExternal: Number(r[22]) || 0,
      externalPatients: Number(r[23]) || 0,
    };
  });
}

// Normalize a stored status cell to a known value; blank/unknown → active.
function normalizeStatus(v) {
  const s = String(v || '').trim();
  return WORKER_STATUS_VALUES.indexOf(s) >= 0 ? s : 'active';
}

// Reads absences and lazily corrects stored status: any row stored as
// 'active' whose end_date < today is rewritten to 'ended' in-place.
function readAbsencesSafe() {
  const sh = sheetByNameOrNull(ABSENCES_TAB);
  if (!sh) return [];
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  const today = todayLocal();
  const corrections = [];
  const out = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    if (String(r[0] || '').trim() === '') continue;
    const startDate = formatDateCell(r[3]);
    const endDate = formatDateCell(r[4]);
    let status = String(r[8] || '').trim() || (active(startDate, endDate, today) ? 'active' : 'ended');
    if (status === 'active' && endDate && endDate < today) {
      status = 'ended';
      corrections.push({ row: i + 1, status: status });
    }
    out.push({
      id: String(r[0]),
      workerId: String(r[1] || ''),
      house: String(r[2] || ''),
      startDate: startDate,
      endDate: endDate,
      reasonType: String(r[5] || ''),
      reasonDetail: String(r[6] || ''),
      notes: String(r[7] || ''),
      status: status,
      createdAt: cellToIso(r[9]),
    });
  }
  if (corrections.length) {
    corrections.forEach(function (c) {
      sh.getRange(c.row, 9).setValue(c.status); // status col = 9
    });
  }
  return out;
}

function readCoveragesSafe() {
  const sh = sheetByNameOrNull(COVERAGES_TAB);
  return rowsOf(sh).map(function (r) {
    return {
      id: String(r[0]),
      absenceId: String(r[1] || ''),
      coveringWorkerId: String(r[2] || ''),
      coveringHouse: String(r[3] || ''),
      receivingHouse: String(r[4] || ''),
      startDate: formatDateCell(r[5]),
      endDate: formatDateCell(r[6]),
      extraPayment: Number(r[7]) || 0,
      notes: String(r[8] || ''),
      createdAt: cellToIso(r[9]),
    };
  });
}

function readArchiveV3Safe() {
  const sh = sheetByNameOrNull(ARCHIVE_V3_TAB);
  return rowsOf(sh).map(function (r) {
    return {
      id: String(r[0]),
      assignmentId: String(r[1] || ''),
      workerId: String(r[2] || ''),
      name: String(r[3] || ''),
      house: String(r[4] || ''),
      role: String(r[5] || ''),
      roleDetail: String(r[6] || ''),
      employmentType: String(r[7] || ''),
      salary: Number(r[8]) || 0,
      pct: Number(r[9]) || 0,
      hourlyRate: Number(r[10]) || 0,
      estHours: Number(r[11]) || 0,
      sessionRate: Number(r[12]) || 0,
      estSessions: Number(r[13]) || 0,
      retainerAmount: Number(r[14]) || 0,
      notes: String(r[15] || ''),
      terminationDate: formatDateCell(r[16]),
      reasonType: String(r[17] || ''),
      reasonDetail: String(r[18] || ''),
      archivedAt: cellToIso(r[19]),
      rateIndividual: Number(r[20]) || 0,
      sessionsIndividual: Number(r[21]) || 0,
      rateGroup: Number(r[22]) || 0,
      sessionsGroup: Number(r[23]) || 0,
      rateExternal: Number(r[24]) || 0,
      externalPatients: Number(r[25]) || 0,
    };
  });
}

// Monthly actuals. Blank hour/session cells stay as null (not 0) so the
// reader can tell "recorded 0" apart from "not recorded for this type".
function readMonthlyActualsSafe() {
  const sh = sheetByNameOrNull(MONTHLY_ACTUALS_TAB);
  return rowsOf(sh).map(function (r) {
    return {
      id: String(r[0]),
      assignmentId: String(r[1] || ''),
      month: formatMonthCell(r[2]),
      actualHours: numOrNull(r[3]),
      actualSessions: numOrNull(r[4]),
      note: String(r[5] || ''),
      createdAt: cellToIso(r[6]),
      updatedAt: cellToIso(r[7]),
    };
  });
}

function readBudgetsSafe() {
  const sh = sheetByNameOrNull(BUDGETS_TAB);
  return rowsOf(sh).map(function (r) {
    return {
      id: String(r[0]),
      house: String(r[1] || ''),
      month: formatBudgetMonthCell(r[2]),
      amount: Number(r[3]) || 0,
      createdAt: cellToIso(r[4]),
      updatedAt: cellToIso(r[5]),
      instructorsAmount: budgetInstructorsCell(r[6]),
    };
  });
}

// Instructors-budget cell → a non-negative number, or null when blank
// (a legacy row written before the total/instructors split, or a house
// budget with no instructors sub-line). NaN → null.
function budgetInstructorsCell(cell) {
  if (cell === '' || cell === null || cell === undefined) return null;
  var n = Number(cell);
  if (n !== n) return null;   // NaN
  return n < 0 ? 0 : n;
}

// ---------- legacy readers (transition + migration) ----------

// Tries the canonical name first, then the _legacy_ prefix (post-finalize).
function legacySheet(name) {
  return sheetByNameOrNull(name) || sheetByNameOrNull(LEGACY_PREFIX + name);
}

function readLegacyHouseSafe(houseId) {
  const sh = legacySheet(houseId);
  return rowsOf(sh).map(function (r) {
    return {
      id: String(r[0]),
      name: String(r[1] || ''),
      role: String(r[2] || ''),
      salary: Number(r[3]) || 0,
      pct: clampPct(Number(r[4])),
      notes: String(r[5] || ''),
      roleDetail: String(r[6] || ''),
    };
  });
}

function readLegacyEventsSafe() {
  const sh = legacySheet(EVENTS_TAB);
  return rowsOf(sh).map(function (r) {
    return {
      id: String(r[0]),
      employeeId: String(r[1] || ''),
      employeeName: String(r[2] || ''),
      homeHouse: String(r[3] || ''),
      hostHouse: String(r[4] || ''),
      startDate: formatDateCell(r[5]),
      endDate: formatDateCell(r[6]),
      reasonType: String(r[7] || ''),
      reasonDetail: String(r[8] || ''),
      coversEmployeeId: String(r[9] || ''),
      bonusAmount: Number(r[10]) || 0,
      status: String(r[11] || ''),
      createdAt: cellToIso(r[12]),
    };
  });
}

function readLegacyArchiveSafe() {
  const sh = legacySheet(ARCHIVE_TAB);
  return rowsOf(sh).map(function (r) {
    return {
      id: String(r[0]),
      employeeId: String(r[1] || ''),
      name: String(r[2] || ''),
      role: String(r[3] || ''),
      roleDetail: String(r[4] || ''),
      salary: Number(r[5]) || 0,
      pct: clampPct(Number(r[6])),
      notes: String(r[7] || ''),
      homeHouse: String(r[8] || ''),
      terminationDate: formatDateCell(r[9]),
      reasonType: String(r[10] || ''),
      reasonDetail: String(r[11] || ''),
      archivedAt: cellToIso(r[12]),
    };
  });
}

// ---------- helpers ----------

function findRow(sheet, idColIndex, id) {
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][idColIndex]) === String(id)) return i + 1;
  }
  return -1;
}

function newId(prefix) {
  return (prefix || 'x') + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ---------- worker actions ----------

function createWorker(body) {
  const w = validateWorker(body.worker || {});
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sh = sheetByName(WORKERS_TAB);
    const id = newId('w');
    const createdAt = new Date().toISOString();
    // Column order MUST match HEADERS_WORKERS (append-only): shift_commitment last.
    sh.appendRow([id, w.name, w.notes, createdAt, w.shiftCommitment]);
    return { ok: true, worker: { id: id, name: w.name, notes: w.notes, createdAt: createdAt, shift_commitment: w.shiftCommitment } };
  } finally {
    lock.releaseLock();
  }
}

function updateWorker(body) {
  const id = requireBodyId(body);
  const w = validateWorker(body.worker || {});
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sh = sheetByName(WORKERS_TAB);
    const row = findRow(sh, 0, id);
    if (row < 0) throw httpError(404, 'worker not found');
    sh.getRange(row, 2).setValue(w.name);
    sh.getRange(row, 3).setValue(w.notes);
    // Column 5 = shift_commitment (HEADERS_WORKERS index 4, 1-based col 5).
    sh.getRange(row, 5).setValue(w.shiftCommitment);
    return { ok: true, worker: { id: id, name: w.name, notes: w.notes, shift_commitment: w.shiftCommitment } };
  } finally {
    lock.releaseLock();
  }
}

function deleteWorker(body) {
  const id = requireBodyId(body);
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    // Refuse if anything references this worker. Forces termination of
    // assignments / cleanup of absences/coverages first — protects history.
    const assignments = readAssignmentsSafe().filter(function (a) { return a.workerId === id; });
    if (assignments.length) throw httpError(409, 'worker has active assignments');
    const absences = readAbsencesSafe().filter(function (a) { return a.workerId === id; });
    if (absences.length) throw httpError(409, 'worker has absence records');
    const coverages = readCoveragesSafe().filter(function (c) { return c.coveringWorkerId === id; });
    if (coverages.length) throw httpError(409, 'worker has coverage records');
    const archived = readArchiveV3Safe().filter(function (a) { return a.workerId === id; });
    if (archived.length) throw httpError(409, 'worker has archive records');

    const sh = sheetByName(WORKERS_TAB);
    const row = findRow(sh, 0, id);
    if (row < 0) throw httpError(404, 'worker not found');
    sh.deleteRow(row);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

// ---------- assignment actions ----------

function addAssignment(body) {
  const a = validateAssignment(body.assignment || {});
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    // Confirm the worker exists.
    if (findRow(sheetByName(WORKERS_TAB), 0, a.workerId) < 0) {
      throw httpError(404, 'worker not found');
    }
    // Reject duplicate (worker, house) — one assignment per pair.
    const dup = readAssignmentsSafe().find(function (x) {
      return x.workerId === a.workerId && x.house === a.house;
    });
    if (dup) throw httpError(409, 'worker already has an assignment at this house');

    const id = newId('a');
    const createdAt = new Date().toISOString();
    sheetByName(ASSIGNMENTS_TAB).appendRow([
      id, a.workerId, a.house, a.role, a.roleDetail, a.employmentType,
      a.salary, a.pct, a.hourlyRate, a.estHours,
      a.sessionRate, a.estSessions, a.retainerAmount,
      a.notes, createdAt,
      a.allowance, a.status, a.statusDate,
      a.rateIndividual, a.sessionsIndividual,
      a.rateGroup, a.sessionsGroup,
      a.rateExternal, a.externalPatients,
    ]);
    return { ok: true, assignment: Object.assign({ id: id, createdAt: createdAt }, a) };
  } finally {
    lock.releaseLock();
  }
}

function updateAssignment(body) {
  const id = requireBodyId(body);
  const a = validateAssignment(body.assignment || {});
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sh = sheetByName(ASSIGNMENTS_TAB);
    const row = findRow(sh, 0, id);
    if (row < 0) throw httpError(404, 'assignment not found');
    // Confirm (worker, house) of the row matches the payload — the UI
    // can't change which (worker × house) an assignment row represents.
    const current = sh.getRange(row, 1, 1, HEADERS_ASSIGNMENTS.length).getValues()[0];
    if (String(current[1]) !== a.workerId) throw httpError(409, 'workerId mismatch');
    if (String(current[2]) !== a.house) throw httpError(409, 'house mismatch');
    sh.getRange(row, 1, 1, HEADERS_ASSIGNMENTS.length).setValues([[
      id, a.workerId, a.house, a.role, a.roleDetail, a.employmentType,
      a.salary, a.pct, a.hourlyRate, a.estHours,
      a.sessionRate, a.estSessions, a.retainerAmount,
      a.notes, current[14] || new Date().toISOString(),
      a.allowance, a.status, a.statusDate,
      a.rateIndividual, a.sessionsIndividual,
      a.rateGroup, a.sessionsGroup,
      a.rateExternal, a.externalPatients,
    ]]);
    return { ok: true, assignment: Object.assign({ id: id }, a) };
  } finally {
    lock.releaseLock();
  }
}

function deleteAssignment(body) {
  const id = requireBodyId(body);
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sh = sheetByName(ASSIGNMENTS_TAB);
    const row = findRow(sh, 0, id);
    if (row < 0) throw httpError(404, 'assignment not found');
    sh.deleteRow(row);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

// Move a worker's existing assignment to a different house, keeping ALL
// employment terms unchanged. Only the `house` column is rewritten. This
// is the dedicated action behind the "מעבר לבית זה" button. It refuses
// to move onto a house where the worker already has an assignment
// (that collision is an edit, not a move).
function moveAssignment(body) {
  const id = requireBodyId(body);
  const target = String(body.house || '').trim();
  if (!isHouse(target)) throw httpError(400, 'bad house');

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sh = sheetByName(ASSIGNMENTS_TAB);
    const row = findRow(sh, 0, id);
    if (row < 0) throw httpError(404, 'assignment not found');

    const cur = sh.getRange(row, 1, 1, HEADERS_ASSIGNMENTS.length).getValues()[0];
    const workerId = String(cur[1]);
    const fromHouse = String(cur[2]);
    if (fromHouse === target) throw httpError(409, 'already at target house');

    // Reject if this worker already has an assignment at the target house.
    const all = sh.getDataRange().getValues();
    for (let i = 1; i < all.length; i++) {
      const r = all[i];
      if (String(r[0] || '').trim() === '') continue;
      if (String(r[0]) === id) continue;
      if (String(r[1]) === workerId && String(r[2]) === target) {
        throw httpError(409, 'worker already assigned to target house');
      }
    }

    sh.getRange(row, 3).setValue(target);  // house is column 3 (1-indexed)

    const assignment = {
      id: id,
      workerId: workerId,
      house: target,
      role: String(cur[3]),
      roleDetail: String(cur[4]),
      employmentType: String(cur[5]),
      salary: Number(cur[6]) || 0,
      pct: Number(cur[7]) || 0,
      hourlyRate: Number(cur[8]) || 0,
      estHours: Number(cur[9]) || 0,
      sessionRate: Number(cur[10]) || 0,
      estSessions: Number(cur[11]) || 0,
      retainerAmount: Number(cur[12]) || 0,
      notes: String(cur[13] || ''),
      allowance: Number(cur[15]) || 0,
      status: normalizeStatus(cur[16]),
      statusDate: String(cur[17] || ''),
      rateIndividual: Number(cur[18]) || 0,
      sessionsIndividual: Number(cur[19]) || 0,
      rateGroup: Number(cur[20]) || 0,
      sessionsGroup: Number(cur[21]) || 0,
      rateExternal: Number(cur[22]) || 0,
      externalPatients: Number(cur[23]) || 0,
    };
    return { ok: true, assignment: assignment };
  } finally {
    lock.releaseLock();
  }
}

function terminateAssignment(body) {
  const id = requireBodyId(body);
  const terminationDate = validateRequiredDate(body.terminationDate, 'terminationDate');
  const reasonType = String(body.reasonType || '').trim();
  if (reasonType && TERMINATION_REASONS.indexOf(reasonType) < 0) {
    throw httpError(400, 'bad reasonType');
  }
  const reasonDetail = String(body.reasonDetail || '').trim().slice(0, 500);

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sh = sheetByName(ASSIGNMENTS_TAB);
    const row = findRow(sh, 0, id);
    if (row < 0) throw httpError(404, 'assignment not found');
    const r = sh.getRange(row, 1, 1, HEADERS_ASSIGNMENTS.length).getValues()[0];
    const snapshot = {
      assignmentId: id,
      workerId: String(r[1]),
      house: String(r[2]),
      role: String(r[3]),
      roleDetail: String(r[4]),
      employmentType: String(r[5]),
      salary: Number(r[6]) || 0,
      pct: Number(r[7]) || 0,
      hourlyRate: Number(r[8]) || 0,
      estHours: Number(r[9]) || 0,
      sessionRate: Number(r[10]) || 0,
      estSessions: Number(r[11]) || 0,
      retainerAmount: Number(r[12]) || 0,
      notes: String(r[13] || ''),
      rateIndividual: Number(r[18]) || 0,
      sessionsIndividual: Number(r[19]) || 0,
      rateGroup: Number(r[20]) || 0,
      sessionsGroup: Number(r[21]) || 0,
      rateExternal: Number(r[22]) || 0,
      externalPatients: Number(r[23]) || 0,
    };
    // Look up worker name (frozen into the archive).
    const wsh = sheetByName(WORKERS_TAB);
    const wrow = findRow(wsh, 0, snapshot.workerId);
    const name = wrow >= 0 ? String(wsh.getRange(wrow, 2).getValue() || '') : '';

    // Auto-truncate any active absence for this (worker, house) — same
    // pattern as v2 terminateEmployee: an absence that runs past the
    // termination date no longer makes sense.
    const today = todayLocal();
    let autoEnded = 0;
    const absh = sheetByName(ABSENCES_TAB);
    const absVals = absh.getDataRange().getValues();
    for (let i = 1; i < absVals.length; i++) {
      const ar = absVals[i];
      if (String(ar[0] || '').trim() === '') continue;
      if (String(ar[1]) !== snapshot.workerId) continue;
      if (String(ar[2]) !== snapshot.house) continue;
      const stored = String(ar[8] || '').trim();
      if (stored !== 'active') continue;
      const aEnd = formatDateCell(ar[4]);
      if (!(aEnd > terminationDate)) continue;
      const newStatus = terminationDate > today ? 'active' : 'ended';
      absh.getRange(i + 1, 5).setValue(terminationDate);
      absh.getRange(i + 1, 9).setValue(newStatus);
      autoEnded++;
    }

    // Append archive row.
    const archId = newId('arc');
    const archivedAt = new Date().toISOString();
    sheetByName(ARCHIVE_V3_TAB).appendRow([
      archId, snapshot.assignmentId, snapshot.workerId, name, snapshot.house,
      snapshot.role, snapshot.roleDetail, snapshot.employmentType,
      snapshot.salary, snapshot.pct, snapshot.hourlyRate, snapshot.estHours,
      snapshot.sessionRate, snapshot.estSessions, snapshot.retainerAmount,
      snapshot.notes, terminationDate, reasonType, reasonDetail, archivedAt,
      snapshot.rateIndividual, snapshot.sessionsIndividual,
      snapshot.rateGroup, snapshot.sessionsGroup,
      snapshot.rateExternal, snapshot.externalPatients,
    ]);

    // Remove the active assignment row.
    sh.deleteRow(row);

    return {
      ok: true,
      archive: Object.assign(
        { id: archId, name: name, terminationDate: terminationDate,
          reasonType: reasonType, reasonDetail: reasonDetail, archivedAt: archivedAt },
        snapshot,
      ),
      autoEndedAbsences: autoEnded,
    };
  } finally {
    lock.releaseLock();
  }
}

// ---------- absence actions ----------

function logAbsence(body) {
  const a = validateAbsence(body.absence || {});
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    // Stub absence (workerId='') skips the worker FK and overlap checks
    // entirely — multiple stubs at the same house can legitimately
    // co-exist (one unfilled position per stub).
    if (a.workerId) {
      // Worker exists.
      if (findRow(sheetByName(WORKERS_TAB), 0, a.workerId) < 0) {
        throw httpError(404, 'worker not found');
      }
      // v3.1: the absent worker must have an active assignment at this
      // house. Active = present in the assignments tab (terminated rows
      // live in archive_v3). Hebrew error so the UI can surface it to
      // Moran verbatim.
      const hasAsg = readAssignmentsSafe().some(function (x) {
        return x.workerId === a.workerId && x.house === a.house;
      });
      if (!hasAsg) {
        throw httpError(409, 'העובד/ת אינו/ה משובץ/ת בבית הנבחר');
      }
      // Reject overlapping active absences for the same (worker, house).
      const existing = readAbsencesSafe();
      const conflict = existing.find(function (x) {
        return x.workerId === a.workerId &&
          x.house === a.house &&
          x.status === 'active' &&
          datesOverlap(x.startDate, x.endDate, a.startDate, a.endDate);
      });
      if (conflict) throw httpError(409, 'worker already has an absence in this range');
    }

    const today = todayLocal();
    const status = active(a.startDate, a.endDate, today) ? 'active' : 'ended';
    const id = newId('ab');
    const createdAt = new Date().toISOString();
    sheetByName(ABSENCES_TAB).appendRow([
      id, a.workerId, a.house, a.startDate, a.endDate,
      a.reasonType, a.reasonDetail, a.notes, status, createdAt,
    ]);
    return { ok: true, absence: Object.assign({ id: id, status: status, createdAt: createdAt }, a) };
  } finally {
    lock.releaseLock();
  }
}

function endAbsence(body) {
  const id = requireBodyId(body);
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sh = sheetByName(ABSENCES_TAB);
    const row = findRow(sh, 0, id);
    if (row < 0) throw httpError(404, 'absence not found');
    const today = todayLocal();
    const currentEnd = formatDateCell(sh.getRange(row, 5).getValue());
    const newEnd = currentEnd && currentEnd < today ? currentEnd : today;
    sh.getRange(row, 5).setValue(newEnd);   // end_date
    sh.getRange(row, 9).setValue('ended');  // status
    return { ok: true, id: id, endDate: newEnd, status: 'ended' };
  } finally {
    lock.releaseLock();
  }
}

function deleteAbsence(body) {
  const id = requireBodyId(body);
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    // v3.1: coverages are independent of absences. Deleting an absence
    // does NOT cascade to coverages, and is NOT blocked by linked
    // coverages — the FK is reference-only. Any coverage with absenceId
    // pointing at this row simply becomes an unlinked coverage; its
    // dates + receivingHouse are intact, so cost attribution is
    // unaffected.
    const sh = sheetByName(ABSENCES_TAB);
    const row = findRow(sh, 0, id);
    if (row < 0) throw httpError(404, 'absence not found');
    sh.deleteRow(row);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

// ---------- coverage actions ----------

function addCoverage(body) {
  const c = validateCoverage(body.coverage || {});
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    // Covering worker must exist and have an active assignment at the
    // coveringHouse (mirror of the absence rule on logAbsence).
    if (findRow(sheetByName(WORKERS_TAB), 0, c.coveringWorkerId) < 0) {
      throw httpError(404, 'covering worker not found');
    }
    const hasAsg = readAssignmentsSafe().some(function (x) {
      return x.workerId === c.coveringWorkerId && x.house === c.coveringHouse;
    });
    if (!hasAsg) {
      throw httpError(409, 'המחליף/ה אינו/ה משובץ/ת בבית המקור הנבחר');
    }
    // v3.1: linked absence is optional. When set, enforce two consistency
    // rules so the link is meaningful:
    //   (1) the absence's house must match this coverage's receivingHouse
    //       — you can't link a coverage that's helping house X to an
    //       absence that says someone is missing FROM house Y.
    //   (2) the coverage's date range must overlap the absence's range.
    if (c.absenceId) {
      const absences = readAbsencesSafe();
      const abs = absences.find(function (x) { return x.id === c.absenceId; });
      if (!abs) throw httpError(404, 'absence not found');
      if (abs.house !== c.receivingHouse) {
        throw httpError(409, 'הבית של ההיעדרות המקושרת אינו תואם את בית היעד של ההחלפה');
      }
      if (!datesOverlap(abs.startDate, abs.endDate, c.startDate, c.endDate)) {
        throw httpError(409, 'תאריכי ההחלפה אינם חופפים את תאריכי ההיעדרות שנבחרה');
      }
    }

    const id = newId('c');
    const createdAt = new Date().toISOString();
    sheetByName(COVERAGES_TAB).appendRow([
      id, c.absenceId, c.coveringWorkerId,
      c.coveringHouse, c.receivingHouse,
      c.startDate, c.endDate,
      c.extraPayment, c.notes, createdAt,
    ]);
    return { ok: true, coverage: Object.assign({ id: id, createdAt: createdAt }, c) };
  } finally {
    lock.releaseLock();
  }
}

function deleteCoverage(body) {
  const id = requireBodyId(body);
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sh = sheetByName(COVERAGES_TAB);
    const row = findRow(sh, 0, id);
    if (row < 0) throw httpError(404, 'coverage not found');
    sh.deleteRow(row);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

function requireBodyId(body) {
  const id = String((body && body.id) || '').trim();
  if (!id) throw httpError(400, 'missing id');
  return id;
}

// ---------- monthly actuals actions ----------

// Bulk upsert of monthly actuals. One row per (assignmentId, month): if a
// row already exists for the pair it's updated in place (values + updated_at),
// otherwise a new row is appended. Every referenced assignment must exist.
// The whole batch is validated (and the FK checked) BEFORE any write, so a
// bad item fails the request without leaving a partial write.
function upsertMonthlyActuals(body) {
  const items = validateMonthlyActuals(body.items);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    // FK: every assignmentId must exist in the assignments tab.
    const known = Object.create(null);
    readAssignmentsSafe().forEach(function (a) { known[a.id] = true; });
    items.forEach(function (it) {
      if (!known[it.assignmentId]) {
        throw httpError(404, 'assignment not found: ' + it.assignmentId);
      }
    });

    const sh = sheetByName(MONTHLY_ACTUALS_TAB);
    const values = sh.getDataRange().getValues();
    // Build (assignmentId|month) → row-number index from existing rows.
    const rowByKey = Object.create(null);
    for (let i = 1; i < values.length; i++) {
      const r = values[i];
      if (String(r[0] || '').trim() === '') continue;
      const key = String(r[1] || '') + '|' + formatMonthCell(r[2]);
      rowByKey[key] = i + 1;
    }

    const now = new Date().toISOString();
    const results = items.map(function (it) {
      const key = it.assignmentId + '|' + it.month;
      const existingRow = rowByKey[key];
      if (existingRow) {
        // Update in place; preserve id + created_at, refresh values + updated_at.
        const id = String(sh.getRange(existingRow, 1).getValue());
        const createdAt = cellToIso(sh.getRange(existingRow, 7).getValue()) || now;
        sh.getRange(existingRow, 1, 1, HEADERS_MONTHLY_ACTUALS.length).setValues([[
          id, it.assignmentId, it.month,
          it.actualHours === null ? '' : it.actualHours,
          it.actualSessions === null ? '' : it.actualSessions,
          it.note, createdAt, now,
        ]]);
        return { id: id, assignmentId: it.assignmentId, month: it.month,
          actualHours: it.actualHours, actualSessions: it.actualSessions,
          note: it.note, createdAt: createdAt, updatedAt: now, updated: true };
      }
      const id = newId('ma');
      sh.appendRow([
        id, it.assignmentId, it.month,
        it.actualHours === null ? '' : it.actualHours,
        it.actualSessions === null ? '' : it.actualSessions,
        it.note, now, now,
      ]);
      // Record so a later item in the same batch with the same pair updates
      // this freshly-appended row rather than appending a duplicate. (The
      // request-level validator already rejects dup pairs, so this is
      // belt-and-suspenders.)
      rowByKey[key] = sh.getLastRow();
      return { id: id, assignmentId: it.assignmentId, month: it.month,
        actualHours: it.actualHours, actualSessions: it.actualSessions,
        note: it.note, createdAt: now, updatedAt: now, updated: false };
    });

    return { ok: true, count: results.length, actuals: results };
  } finally {
    lock.releaseLock();
  }
}

function getMonthlyActuals(body) {
  const month = validateMonth(body.month, 'month');
  const rows = readMonthlyActualsSafe().filter(function (r) { return r.month === month; });
  return { ok: true, month: month, actuals: rows };
}

// ---------- budget actions ----------

// Upsert a single per-house budget. One row per (house, month): updated in
// place if the pair exists (amount + updated_at), otherwise appended.
function setBudget(body) {
  const b = validateBudget(body.budget || {});
  // Blank instructors line → empty cell (keeps legacy total-only rows blank).
  const instrCell = (b.instructorsAmount === null || b.instructorsAmount === undefined)
    ? '' : b.instructorsAmount;
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sh = sheetByName(BUDGETS_TAB);
    // Guarantee the appended instructors_amount column physically exists +
    // carries its label before we write a full-width row into it.
    ensureHeaders(sh, HEADERS_BUDGETS);
    const values = sh.getDataRange().getValues();
    let row = -1;
    for (let i = 1; i < values.length; i++) {
      const r = values[i];
      if (String(r[0] || '').trim() === '') continue;
      if (String(r[1]) === b.house && formatBudgetMonthCell(r[2]) === b.month) {
        row = i + 1;
        break;
      }
    }
    const now = new Date().toISOString();
    if (row > 0) {
      const id = String(sh.getRange(row, 1).getValue());
      const createdAt = cellToIso(sh.getRange(row, 5).getValue()) || now;
      sh.getRange(row, 1, 1, HEADERS_BUDGETS.length).setValues([[
        id, b.house, b.month, b.amount, createdAt, now, instrCell,
      ]]);
      return { ok: true, budget: { id: id, house: b.house, month: b.month,
        amount: b.amount, instructorsAmount: b.instructorsAmount,
        createdAt: createdAt, updatedAt: now }, updated: true };
    }
    const id = newId('bud');
    sh.appendRow([id, b.house, b.month, b.amount, now, now, instrCell]);
    return { ok: true, budget: { id: id, house: b.house, month: b.month,
      amount: b.amount, instructorsAmount: b.instructorsAmount,
      createdAt: now, updatedAt: now }, updated: false };
  } finally {
    lock.releaseLock();
  }
}

function getBudgets() {
  return { ok: true, budgets: readBudgetsSafe() };
}

// ---------- setup / migration / rollback / finalize ----------

// Idempotent — safe to re-run. Creates v3 tabs with the right headers,
// leaves existing data alone.
function setupSheetsV3() {
  const book = ss();
  const wanted = [
    { name: WORKERS_TAB, headers: HEADERS_WORKERS },
    { name: ASSIGNMENTS_TAB, headers: HEADERS_ASSIGNMENTS },
    { name: ABSENCES_TAB, headers: HEADERS_ABSENCES },
    { name: COVERAGES_TAB, headers: HEADERS_COVERAGES },
    { name: ARCHIVE_V3_TAB, headers: HEADERS_ARCHIVE_V3 },
    { name: MONTHLY_ACTUALS_TAB, headers: HEADERS_MONTHLY_ACTUALS },
    { name: BUDGETS_TAB, headers: HEADERS_BUDGETS },
  ];
  wanted.forEach(function (w) {
    let sh = book.getSheetByName(w.name);
    if (!sh) sh = book.insertSheet(w.name);
    ensureHeaders(sh, w.headers);
  });
  return 'setupSheetsV3 ok';
}

// ---------- one-time migration: per_session single rate → 3-rate model ----------
//
// Run ONCE from the Apps Script editor (Run ▸ migratePerSessionRatesToThreeRate)
// AFTER deploying the new Code.gs. For every existing per_session assignment
// it copies the legacy single pair into the new `individual` pair:
//   session_rate  → rate_individual
//   est_sessions  → sessions_individual
// group + external stay 0 (Moran fills them in per therapist later).
//
// Idempotent: a row whose rate_individual is already populated is skipped,
// so re-running is safe. Mirrors perSessionRatesToThreeRate() in
// lib/migrate.js (the pure, unit-tested mapping). Use
// dryRunMigratePerSessionRatesToThreeRate() first to preview the count.
function migratePerSessionRatesToThreeRate() {
  return _migratePerSessionRates(false);
}

function dryRunMigratePerSessionRatesToThreeRate() {
  return _migratePerSessionRates(true);
}

function _migratePerSessionRates(dryRun) {
  const sh = sheetByName(ASSIGNMENTS_TAB);
  // Guarantee the appended columns physically exist + carry their labels.
  ensureHeaders(sh, HEADERS_ASSIGNMENTS);
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return { migrated: 0, skipped: 0, total: 0, dryRun: !!dryRun };

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const n = lastRow - 1;
    // Columns are 1-based: employment_type=6, session_rate=11, est_sessions=12,
    // rate_individual=19, sessions_individual=20.
    const types = sh.getRange(2, 6, n, 1).getValues();          // col 6
    const legacy = sh.getRange(2, 11, n, 2).getValues();        // cols 11-12
    const indiv = sh.getRange(2, 19, n, 2).getValues();         // cols 19-20
    let migrated = 0, skipped = 0, total = 0;
    for (let i = 0; i < n; i++) {
      if (String(types[i][0]).trim() !== 'per_session') continue;
      total++;
      const alreadyRate = Number(indiv[i][0]) || 0;
      const alreadySess = Number(indiv[i][1]) || 0;
      if (alreadyRate > 0 || alreadySess > 0) { skipped++; continue; }
      const mapped = perSessionRatesToThreeRate_(legacy[i][0], legacy[i][1]);
      indiv[i][0] = mapped.rateIndividual;
      indiv[i][1] = mapped.sessionsIndividual;
      migrated++;
    }
    if (!dryRun && migrated > 0) {
      sh.getRange(2, 19, n, 2).setValues(indiv);
    }
    return { migrated: migrated, skipped: skipped, total: total, dryRun: !!dryRun };
  } finally {
    lock.releaseLock();
  }
}

// Pure mapping — mirror of perSessionRatesToThreeRate() in lib/migrate.js.
function perSessionRatesToThreeRate_(legacyRate, legacySessions) {
  const rate = Math.max(0, Math.round(Number(legacyRate) || 0));
  const sessions = Math.max(0, Math.round(Number(legacySessions) || 0));
  return { rateIndividual: rate, sessionsIndividual: sessions };
}

function ensureHeaders(sh, expected) {
  const lastCol = Math.max(sh.getLastColumn(), 1);
  const firstRow = sh.getRange(1, 1, 1, Math.max(lastCol, expected.length)).getValues()[0];
  const empty = firstRow.every(function (c) { return String(c || '').trim() === ''; });
  if (empty) {
    sh.getRange(1, 1, 1, expected.length).setValues([expected]);
    sh.setFrozenRows(1);
    return;
  }
  for (let i = 0; i < expected.length; i++) {
    if (String(firstRow[i] || '').trim() === '') {
      sh.getRange(1, i + 1).setValue(expected[i]);
    }
  }
  sh.setFrozenRows(1);
}

// Inlined migration mappers — keep in sync with lib/migrate.js.
// See that file's comments for the rationale.

function legacyTermsFromPct_(salary, pct) {
  const s = Math.max(0, Math.round(Number(salary) || 0));
  const p = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
  if (p === 100) return { employmentType: 'full_time', salary: s, pct: 0 };
  return { employmentType: 'part_time', salary: s, pct: p > 0 ? p : 1 };
}

function mapLegacyEmployeeToAssignment_(emp, house) {
  if (!emp) return null;
  const terms = legacyTermsFromPct_(emp.salary, emp.pct);
  return {
    workerId: String(emp.id || ''), house: String(house || ''),
    role: String(emp.role || ''), roleDetail: String(emp.roleDetail || ''),
    employmentType: terms.employmentType, salary: terms.salary, pct: terms.pct,
    hourlyRate: 0, estHours: 0, sessionRate: 0, estSessions: 0, retainerAmount: 0,
    notes: String(emp.notes || ''),
  };
}

function mapLegacyEventToAbsenceCoverage_(ev) {
  if (!ev) return null;
  const reasonType = ABSENCE_REASON_TYPES.indexOf(ev.reasonType) >= 0
    ? ev.reasonType : 'אחר';
  const hasAbsentee = !!String(ev.coversEmployeeId || '').trim();
  const status = String(ev.status) === 'active' ? 'active' : 'ended';
  const startDate = String(ev.startDate || '');
  const endDate = String(ev.endDate || '');
  const hostHouse = String(ev.hostHouse || '');
  return {
    absence: {
      workerId: hasAbsentee ? String(ev.coversEmployeeId) : '',
      house: hostHouse,
      startDate: startDate, endDate: endDate,
      reasonType: reasonType, reasonDetail: String(ev.reasonDetail || ''),
      notes: hasAbsentee ? '' : MIGRATION_NOTE_NO_ABSENTEE,
      status: status,
    },
    // v3.1 coverage shape: carries its own dates + houses, independent
    // of the linked absence.
    coverage: {
      absenceId: '',
      coveringWorkerId: String(ev.employeeId || ''),
      coveringHouse: String(ev.homeHouse || ''),
      receivingHouse: hostHouse,
      startDate: startDate, endDate: endDate,
      extraPayment: Math.max(0, Math.round(Number(ev.bonusAmount) || 0)),
      notes: MIGRATION_NOTE_COVERAGE,
    },
  };
}

function mapLegacyArchiveRow_(arch) {
  if (!arch) return null;
  const terms = legacyTermsFromPct_(arch.salary, arch.pct);
  return {
    assignmentId: '', workerId: String(arch.employeeId || ''),
    name: String(arch.name || ''), house: String(arch.homeHouse || ''),
    role: String(arch.role || ''), roleDetail: String(arch.roleDetail || ''),
    employmentType: terms.employmentType, salary: terms.salary, pct: terms.pct,
    hourlyRate: 0, estHours: 0, sessionRate: 0, estSessions: 0, retainerAmount: 0,
    notes: String(arch.notes || ''),
    terminationDate: String(arch.terminationDate || ''),
    reasonType: String(arch.reasonType || ''),
    reasonDetail: String(arch.reasonDetail || ''),
    archivedAt: String(arch.archivedAt || ''),
  };
}

function collectWorkers_(houses, archive) {
  const seen = Object.create(null);
  const out = [];
  function add(id, name) {
    const key = String(id || '').trim();
    if (!key || seen[key]) return;
    seen[key] = true;
    out.push({ id: key, name: String(name || ''), notes: '' });
  }
  Object.keys(houses || {}).forEach(function (h) {
    (houses[h] || []).forEach(function (e) { add(e.id, e.name); });
  });
  (archive || []).forEach(function (a) { add(a.employeeId, a.name); });
  return out;
}

// Builds the v3 entity collections from legacy data WITHOUT writing.
// Returns { workers, assignments, absencePairs, archiveV3 } where each
// absencePairs[i] is { absence, coverage }; the coverage's absenceId is
// still '' (the writer fills it in once the absence row has an id).
function buildV3FromLegacy_() {
  const houses = {};
  HOUSE_IDS.forEach(function (h) { houses[h] = readLegacyHouseSafe(h); });
  const archive = readLegacyArchiveSafe();
  const events = readLegacyEventsSafe();

  const workers = collectWorkers_(houses, archive);
  const assignments = [];
  HOUSE_IDS.forEach(function (h) {
    houses[h].forEach(function (emp) {
      assignments.push(mapLegacyEmployeeToAssignment_(emp, h));
    });
  });
  const absencePairs = events.map(mapLegacyEventToAbsenceCoverage_);
  const archiveV3 = archive.map(mapLegacyArchiveRow_);
  return {
    workers: workers,
    assignments: assignments,
    absencePairs: absencePairs,
    archiveV3: archiveV3,
  };
}

// Reads the legacy data, runs the mappers, and logs counts + 1-2 sample
// rows per new tab. Writes NOTHING. Run this before migrateToV3 to sanity
// check what the migration will produce.
function dryRunMigrateToV3() {
  const built = buildV3FromLegacy_();
  Logger.log('--- dryRunMigrateToV3 ---');
  Logger.log('workers     : %d (samples shown)', built.workers.length);
  Logger.log(JSON.stringify(built.workers.slice(0, 2), null, 2));
  Logger.log('assignments : %d', built.assignments.length);
  Logger.log(JSON.stringify(built.assignments.slice(0, 2), null, 2));
  Logger.log('absences    : %d (each has a paired coverage)', built.absencePairs.length);
  Logger.log(JSON.stringify(built.absencePairs.slice(0, 2).map(function (p) { return p.absence; }), null, 2));
  Logger.log('coverages   : %d', built.absencePairs.length);
  Logger.log(JSON.stringify(built.absencePairs.slice(0, 2).map(function (p) { return p.coverage; }), null, 2));
  Logger.log('archive_v3  : %d', built.archiveV3.length);
  Logger.log(JSON.stringify(built.archiveV3.slice(0, 2), null, 2));
  Logger.log('--- end dryRunMigrateToV3 (no writes performed) ---');
  return {
    workers: built.workers.length,
    assignments: built.assignments.length,
    absences: built.absencePairs.length,
    coverages: built.absencePairs.length,
    archiveV3: built.archiveV3.length,
  };
}

// Reads legacy data and writes it to the v3 tabs. Refuses to re-run if
// V3_MIGRATION_DONE is set in Script Properties — to re-run, call
// rollbackV3() first.
function migrateToV3() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('V3_MIGRATION_DONE') === 'true') {
    throw httpError(409, 'V3_MIGRATION_DONE is already set — run rollbackV3 first to re-migrate');
  }

  // Pre-flight: v3 tabs must exist (run setupSheetsV3 first).
  [WORKERS_TAB, ASSIGNMENTS_TAB, ABSENCES_TAB, COVERAGES_TAB, ARCHIVE_V3_TAB]
    .forEach(function (n) {
      if (!sheetByNameOrNull(n)) {
        throw httpError(500, 'missing v3 tab: ' + n + ' — run setupSheetsV3 first');
      }
    });

  const lock = LockService.getScriptLock();
  lock.waitLock(60000);
  try {
    const built = buildV3FromLegacy_();
    const now = new Date().toISOString();

    // Workers: id is reused from legacy employee_id, no `w` prefix.
    const wsh = sheetByName(WORKERS_TAB);
    built.workers.forEach(function (w) {
      wsh.appendRow([w.id, w.name, w.notes, now]);
    });

    // Assignments.
    const ash = sheetByName(ASSIGNMENTS_TAB);
    built.assignments.forEach(function (a) {
      const id = newId('a');
      ash.appendRow([
        id, a.workerId, a.house, a.role, a.roleDetail, a.employmentType,
        a.salary, a.pct, a.hourlyRate, a.estHours,
        a.sessionRate, a.estSessions, a.retainerAmount,
        a.notes, now,
      ]);
    });

    // Absences + paired coverages. Write absence first, capture its id,
    // then write the coverage with absence_id filled in. v3.1 coverage
    // shape: carries its own dates + houses (covering vs receiving).
    const absh = sheetByName(ABSENCES_TAB);
    const csh = sheetByName(COVERAGES_TAB);
    built.absencePairs.forEach(function (pair) {
      const absId = newId('ab');
      absh.appendRow([
        absId, pair.absence.workerId, pair.absence.house,
        pair.absence.startDate, pair.absence.endDate,
        pair.absence.reasonType, pair.absence.reasonDetail,
        pair.absence.notes, pair.absence.status, now,
      ]);
      const covId = newId('c');
      csh.appendRow([
        covId, absId, pair.coverage.coveringWorkerId,
        pair.coverage.coveringHouse, pair.coverage.receivingHouse,
        pair.coverage.startDate, pair.coverage.endDate,
        pair.coverage.extraPayment, pair.coverage.notes, now,
      ]);
    });

    // archive_v3 — straight copy.
    const arsh = sheetByName(ARCHIVE_V3_TAB);
    built.archiveV3.forEach(function (a) {
      const id = newId('arc');
      arsh.appendRow([
        id, a.assignmentId, a.workerId, a.name, a.house, a.role, a.roleDetail,
        a.employmentType, a.salary, a.pct, a.hourlyRate, a.estHours,
        a.sessionRate, a.estSessions, a.retainerAmount,
        a.notes, a.terminationDate, a.reasonType, a.reasonDetail, a.archivedAt,
      ]);
    });

    props.setProperty('V3_MIGRATION_DONE', 'true');
    const summary = {
      workers: built.workers.length,
      assignments: built.assignments.length,
      absences: built.absencePairs.length,
      coverages: built.absencePairs.length,
      archiveV3: built.archiveV3.length,
    };
    Logger.log('migrateToV3 ok: %s', JSON.stringify(summary));
    return summary;
  } finally {
    lock.releaseLock();
  }
}

// Deletes the v3 tabs (workers/assignments/absences/coverages/archive_v3)
// and clears the V3_MIGRATION_DONE flag. Legacy tabs are NOT touched.
// Safe rollback before finalizeV3 is run.
function rollbackV3() {
  const book = ss();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    [WORKERS_TAB, ASSIGNMENTS_TAB, ABSENCES_TAB, COVERAGES_TAB, ARCHIVE_V3_TAB]
      .forEach(function (n) {
        const sh = book.getSheetByName(n);
        if (sh) book.deleteSheet(sh);
      });
    const p = PropertiesService.getScriptProperties();
    p.deleteProperty('V3_MIGRATION_DONE');
    p.deleteProperty('V3_1_MIGRATION_DONE');
    return 'rollbackV3 ok — v3 tabs deleted, flags cleared, legacy tabs intact';
  } finally {
    lock.releaseLock();
  }
}

// v3.1 schema patch. In-place ALTER of the coverages tab: the column
// formerly known as `providing_house` becomes `covering_house`, and three
// new columns are added — `receiving_house`, `start_date`, `end_date`.
// Existing rows are backfilled from the linked absence: receiving_house
// gets the absence's house; start_date/end_date get the absence's date
// range. Coverages without a linked absence (orphans / migration stubs)
// get receiving_house='' and inherit no dates — cost accrues nowhere for
// those until Moran fills them in via the UI.
//
// Idempotent. Sets V3_1_MIGRATION_DONE script property; subsequent runs
// are no-ops. Pre-flight refuses if V3_MIGRATION_DONE is not yet set —
// the v3.0 schema must exist before this patch can apply.
//
// Pre-production: this is an in-place patch, not a separate v3.1
// install. There is no rollback path; if you need to revert, restore
// the Sheet from the manual copy taken before migration.
function migrateCoveragesToV3_1() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('V3_1_MIGRATION_DONE') === 'true') {
    return 'migrateCoveragesToV3_1: already done (V3_1_MIGRATION_DONE set) — no-op';
  }
  if (props.getProperty('V3_MIGRATION_DONE') !== 'true') {
    throw httpError(409,
      'migrateToV3 has not been run — the v3.0 schema must exist before the v3.1 patch can apply');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(60000);
  try {
    const sh = sheetByName(COVERAGES_TAB);
    const values = sh.getDataRange().getValues();
    if (values.length < 1) {
      // Empty tab — just rewrite the header row to the v3.1 shape and
      // mark done.
      sh.clear();
      sh.getRange(1, 1, 1, HEADERS_COVERAGES.length).setValues([HEADERS_COVERAGES]);
      sh.setFrozenRows(1);
      props.setProperty('V3_1_MIGRATION_DONE', 'true');
      return 'migrateCoveragesToV3_1 ok: 0 rows migrated';
    }

    // Build absence-id → absence lookup for backfilling receiving_house
    // and dates.
    const absences = readAbsencesSafe();
    const absById = Object.create(null);
    absences.forEach(function (a) { absById[a.id] = a; });

    // Read existing rows in the OLD layout:
    //   [id, absence_id, covering_worker_id, providing_house,
    //    extra_payment, notes, created_at]
    const oldRows = values.slice(1).filter(function (r) {
      return String(r[0] || '').trim() !== '';
    });
    const newRows = oldRows.map(function (r) {
      const id = String(r[0]);
      const absenceId = String(r[1] || '');
      const coveringWorkerId = String(r[2] || '');
      const coveringHouse = String(r[3] || '');  // was providing_house
      const extraPayment = Number(r[4]) || 0;
      const notes = String(r[5] || '');
      const createdAt = r[6];

      // Backfill receivingHouse + dates from the linked absence when it
      // exists. Orphans (no linked absence, or pointing to a deleted
      // absence) get receivingHouse='' + empty dates.
      const abs = absById[absenceId];
      const receivingHouse = abs ? abs.house : '';
      const startDate = abs ? abs.startDate : '';
      const endDate = abs ? abs.endDate : '';

      // v3.1 layout:
      //   [id, absence_id, covering_worker_id, covering_house,
      //    receiving_house, start_date, end_date,
      //    extra_payment, notes, created_at]
      return [
        id, absenceId, coveringWorkerId,
        coveringHouse, receivingHouse, startDate, endDate,
        extraPayment, notes, createdAt,
      ];
    });

    // Rewrite the tab: clear + write headers + write data. setValues is
    // atomic within the LockService lock; no partial-write window.
    sh.clear();
    sh.getRange(1, 1, 1, HEADERS_COVERAGES.length).setValues([HEADERS_COVERAGES]);
    sh.setFrozenRows(1);
    if (newRows.length) {
      sh.getRange(2, 1, newRows.length, HEADERS_COVERAGES.length).setValues(newRows);
    }

    props.setProperty('V3_1_MIGRATION_DONE', 'true');
    const summary = 'migrateCoveragesToV3_1 ok: ' + newRows.length + ' rows migrated';
    Logger.log(summary);
    return summary;
  } finally {
    lock.releaseLock();
  }
}

// Renames the legacy tabs to _legacy_<name>. Run this only after you are
// sure the v3 cutover is stable. The legacy data stays in the Sheet,
// just under different names. To roll back AFTER finalize:
//   - rename _legacy_<name> tabs back to canonical names manually
//   - run rollbackV3 to drop the v3 tabs
//   - redeploy the v2 Code.gs
function finalizeV3() {
  if (PropertiesService.getScriptProperties().getProperty('V3_MIGRATION_DONE') !== 'true') {
    throw httpError(409, 'migrateToV3 has not been run — refusing to finalize');
  }
  const book = ss();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const toRename = HOUSE_IDS.concat([EVENTS_TAB, ARCHIVE_TAB, HISTORY_TAB]);
    const renamed = [];
    toRename.forEach(function (n) {
      const sh = book.getSheetByName(n);
      if (!sh) return;
      const newName = LEGACY_PREFIX + n;
      // If a previous finalize already happened, the target may exist —
      // skip rather than blow up.
      if (book.getSheetByName(newName)) return;
      sh.setName(newName);
      renamed.push(n + ' → ' + newName);
    });
    Logger.log('finalizeV3 ok: %s', renamed.length ? renamed.join(', ') : '(nothing to rename)');
    return { ok: true, renamed: renamed };
  } finally {
    lock.releaseLock();
  }
}

// ---------- date helpers ----------

function todayLocal() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function formatDateCell(cell) {
  if (cell instanceof Date) {
    return Utilities.formatDate(cell, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  const s = String(cell || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return s;
}

function cellToIso(cell) {
  if (cell instanceof Date) return cell.toISOString();
  return String(cell || '');
}

// A numeric cell → Number, but a blank cell → null (distinguishes a
// recorded 0 from "not recorded"). Used by the monthly-actuals reader.
function numOrNull(cell) {
  if (cell === '' || cell === null || cell === undefined) return null;
  const n = Number(cell);
  return isFinite(n) ? n : null;
}

// A month cell → 'YYYY-MM'. Sheets may coerce 'YYYY-MM' to a Date; handle
// both. Falls through to the raw string for anything unexpected.
function formatMonthCell(cell) {
  if (cell instanceof Date) {
    return Utilities.formatDate(cell, Session.getScriptTimeZone(), 'yyyy-MM');
  }
  const s = String(cell || '').trim();
  const m = /^(\d{4}-\d{2})/.exec(s);
  return m ? m[1] : s;
}

// Budget month cell → 'YYYY-MM' or the literal 'default'. Same coercion
// handling as formatMonthCell, plus the sentinel passthrough.
function formatBudgetMonthCell(cell) {
  if (String(cell || '').trim() === 'default') return 'default';
  return formatMonthCell(cell);
}

function active(startDate, endDate, today) {
  return startDate && endDate && startDate <= today && today <= endDate;
}

function datesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && bStart <= aEnd;
}
