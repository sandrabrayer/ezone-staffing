'use strict';

// v3: workers + per-house assignments + absence/coverage split.
// Each free-text field is trimmed + length-capped here; the client applies
// HTML escape on render (escapeHtml in index.html). Storage stays raw.

// `hq` is a pseudo-house for headquarters / admin staff who don't
// belong to a specific physical house. Treated as a house in the data
// model for simplicity — assignments and absences validate against it
// just like any other house code. See MIGRATION.md "Houses" for the
// canonical id → Hebrew display name mapping.
const HOUSE_IDS = [
  'ramot', 'asher', 'ofroni', 'rehab',
  'pardes', 'sde_eliezer',
  'hq',
];

// Roles users can pick in the assignment form. Exact strings (including
// gender slashes) are the contract — stored verbatim.
const ROLE_OPTIONS = [
  'מנהל/ת',
  'רכז/ת',
  'מדריך/ה',
  'מטפל/ת',
  'אחות',
  'פסיכיאטר/ית',
  'טבח/ית',
  'איש/אשת אחזקה',
  'אחר',
];

// Reasons an absence is opened. Closed for new writes; legacy values from
// migrated rows still parse on read.
const ABSENCE_REASON_TYPES = [
  'חופשה',
  'חל״ת',
  'מחלה',
  'חופשת לידה',
  'ניתוח',
  'צורך תפעולי',
  'אישי',
  'אחר',
];

// Reasons for terminating an assignment. Optional on the action — Moran may
// save a termination without a reason. If present, must match this list.
const TERMINATION_REASONS = [
  'התפטרות',
  'פיטורין',
  'סיום חוזה',
  'מעבר תפקיד',
  'אחר',
];

const EMPLOYMENT_TYPES = [
  'full_time', 'part_time', 'hourly', 'per_session', 'fixed_retainer',
];

// Which cost fields each employment type is *allowed* to set. Any other
// cost field arriving with a positive value gets rejected by
// validateAssignment — this catches buggy UIs and hostile clients that
// mix incompatible terms (e.g. full_time + hourlyRate=80). The
// migration mappers in lib/migrate.js zero out the irrelevant fields,
// so legacy → v3 round-trips through validateAssignment cleanly (see
// the round-trip assertion in tests/migration.test.js).
const TYPE_COST_FIELDS = {
  full_time:      ['salary'],
  part_time:      ['salary', 'pct'],
  hourly:         ['hourlyRate', 'estHours'],
  per_session:    ['sessionRate', 'estSessions'],
  fixed_retainer: ['retainerAmount'],
};
const ALL_COST_FIELDS = [
  'salary', 'pct',
  'hourlyRate', 'estHours',
  'sessionRate', 'estSessions',
  'retainerAmount',
];

// Per-field caps. Tight enough to prevent obvious abuse; loose enough that
// real-world Israeli payroll fits comfortably.
const SALARY_MAX = 1000000;
const HOURLY_RATE_MAX = 1000;
const SESSION_RATE_MAX = 5000;
const RETAINER_MAX = 200000;
const EST_HOURS_MAX = 744;        // hours in a 31-day month
const EST_SESSIONS_MAX = 500;
const EXTRA_PAYMENT_MAX = 100000;

function isHouse(id) {
  return HOUSE_IDS.indexOf(id) >= 0;
}

function isRole(role) {
  return ROLE_OPTIONS.indexOf(role) >= 0;
}

function isEmploymentType(t) {
  return EMPLOYMENT_TYPES.indexOf(t) >= 0;
}

function clampPct(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return 100;
  return Math.max(1, Math.min(100, Math.round(num)));
}

function clampMoney(n, max) {
  const num = Number(n);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.min(max, Math.round(num)));
}

function clampInt(n, max) {
  const num = Number(n);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.min(max, Math.round(num)));
}

function badRequest(msg) {
  const err = new Error(msg);
  err.status = 400;
  return err;
}

// ---------- entity validators ----------

function validateWorker(w) {
  if (!w || typeof w !== 'object') throw badRequest('worker required');
  const name = String(w.name || '').trim().slice(0, 80);
  if (!name) throw badRequest('name required');
  const notes = String(w.notes || '').trim().slice(0, 500);
  return { name, notes };
}

// Strict per-type validation. Fields that don't belong to the chosen
// employment_type are zeroed out (rather than rejected) so the UI can keep
// stale values in hidden inputs without the action failing.
function validateAssignment(a) {
  if (!a || typeof a !== 'object') throw badRequest('assignment required');
  const workerId = String(a.workerId || '').trim();
  if (!workerId) throw badRequest('workerId required');
  if (!isHouse(a.house)) throw badRequest('unknown house');
  const role = String(a.role || '').trim();
  if (!isRole(role)) throw badRequest('bad role');
  const roleDetail = String(a.roleDetail || '').trim().slice(0, 80);
  if (role === 'אחר' && !roleDetail) {
    throw badRequest('roleDetail required when role is אחר');
  }
  const employmentType = String(a.employmentType || '').trim();
  if (!isEmploymentType(employmentType)) throw badRequest('bad employmentType');
  const notes = String(a.notes || '').trim().slice(0, 500);

  // Strict per-type rejection: any cost field outside the chosen type's
  // allowed set must be absent / zero. We compare against the RAW input,
  // not the clamped output — silently zeroing an incompatible value would
  // hide the inconsistency, defeating the point of this guard.
  const allowed = TYPE_COST_FIELDS[employmentType];
  for (let i = 0; i < ALL_COST_FIELDS.length; i++) {
    const f = ALL_COST_FIELDS[i];
    if (allowed.indexOf(f) >= 0) continue;
    const raw = a[f];
    if (raw === undefined || raw === null || raw === '') continue;
    const v = Number(raw);
    if (Number.isFinite(v) && v > 0) {
      throw badRequest(f + ' not allowed for employmentType=' + employmentType);
    }
  }

  let salary = 0, pct = 0, hourlyRate = 0, estHours = 0;
  let sessionRate = 0, estSessions = 0, retainerAmount = 0;

  switch (employmentType) {
    case 'full_time':
      salary = clampMoney(a.salary, SALARY_MAX);
      if (salary <= 0) throw badRequest('salary required for full_time');
      break;
    case 'part_time':
      salary = clampMoney(a.salary, SALARY_MAX);
      if (salary <= 0) throw badRequest('salary required for part_time');
      pct = clampPct(a.pct);
      break;
    case 'hourly':
      hourlyRate = clampMoney(a.hourlyRate, HOURLY_RATE_MAX);
      if (hourlyRate <= 0) throw badRequest('hourlyRate required for hourly');
      estHours = clampInt(a.estHours, EST_HOURS_MAX);
      if (estHours <= 0) throw badRequest('estHours required for hourly');
      break;
    case 'per_session':
      sessionRate = clampMoney(a.sessionRate, SESSION_RATE_MAX);
      if (sessionRate <= 0) throw badRequest('sessionRate required for per_session');
      estSessions = clampInt(a.estSessions, EST_SESSIONS_MAX);
      if (estSessions <= 0) throw badRequest('estSessions required for per_session');
      break;
    case 'fixed_retainer':
      retainerAmount = clampMoney(a.retainerAmount, RETAINER_MAX);
      if (retainerAmount <= 0) throw badRequest('retainerAmount required for fixed_retainer');
      break;
  }

  return {
    workerId,
    house: a.house,
    role,
    roleDetail,
    employmentType,
    salary,
    pct,
    hourlyRate,
    estHours,
    sessionRate,
    estSessions,
    retainerAmount,
    notes,
  };
}

// v3.1: workerId is optional. An absence row with workerId='' is a
// "stub" — known unfilled position, no identified absentee yet. Migration
// from v2 events that lacked covers_employee_id produces these. Moran can
// edit/delete stubs from the dashboard like any other row.
function validateAbsence(a) {
  if (!a || typeof a !== 'object') throw badRequest('absence required');
  const workerId = String(a.workerId || '').trim();  // '' allowed → stub
  if (!isHouse(a.house)) throw badRequest('unknown house');
  const startDate = validateRequiredDate(a.startDate, 'startDate');
  const endDate = validateRequiredDate(a.endDate, 'endDate');
  if (endDate < startDate) throw badRequest('endDate before startDate');
  const reasonType = String(a.reasonType || '');
  if (ABSENCE_REASON_TYPES.indexOf(reasonType) < 0) throw badRequest('bad reasonType');
  const reasonDetail = String(a.reasonDetail || '').trim().slice(0, 500);
  const notes = String(a.notes || '').trim().slice(0, 500);
  return {
    workerId,
    house: a.house,
    startDate,
    endDate,
    reasonType,
    reasonDetail,
    notes,
  };
}

// v3.1: absence and coverage are now INDEPENDENT events.
//   - coveringHouse (renamed from providingHouse) — where the covering
//     worker is based. Cost of the underlying assignment still accrues
//     here.
//   - receivingHouse (NEW) — where the help is going. extraPayment
//     accrues here. Previously inherited from absence.house; now a
//     first-class field on the coverage row.
//   - absenceId is OPTIONAL — a coverage can be logged without a linked
//     absence (e.g. ad-hoc coverage not tied to a recorded absentee).
//   - startDate/endDate are the coverage's own range. The cost helpers
//     read these directly; linked absences are reference-only.
function validateCoverage(c) {
  if (!c || typeof c !== 'object') throw badRequest('coverage required');
  const absenceId = String(c.absenceId || '').trim();  // '' allowed → unlinked
  const coveringWorkerId = String(c.coveringWorkerId || '').trim();
  if (!coveringWorkerId) throw badRequest('coveringWorkerId required');
  if (!isHouse(c.coveringHouse)) throw badRequest('unknown coveringHouse');
  if (!isHouse(c.receivingHouse)) throw badRequest('unknown receivingHouse');
  if (c.coveringHouse === c.receivingHouse) {
    throw badRequest('receivingHouse must differ from coveringHouse');
  }
  const startDate = validateRequiredDate(c.startDate, 'startDate');
  const endDate = validateRequiredDate(c.endDate, 'endDate');
  if (endDate < startDate) throw badRequest('endDate before startDate');
  const extraPayment = clampMoney(c.extraPayment, EXTRA_PAYMENT_MAX);
  const notes = String(c.notes || '').trim().slice(0, 500);
  return {
    absenceId,
    coveringWorkerId,
    coveringHouse: c.coveringHouse,
    receivingHouse: c.receivingHouse,
    startDate,
    endDate,
    extraPayment,
    notes,
  };
}

// ---------- action dispatch ----------

function validateAction(body) {
  if (!body || typeof body !== 'object') throw badRequest('body required');
  const action = String(body.action || '');
  switch (action) {
    case 'createWorker':
      return { action, worker: validateWorker(body.worker) };

    case 'updateWorker': {
      const id = requireId(body.id);
      return { action, id, worker: validateWorker(body.worker) };
    }

    case 'deleteWorker':
      return { action, id: requireId(body.id) };

    case 'addAssignment':
      return { action, assignment: validateAssignment(body.assignment) };

    case 'updateAssignment': {
      const id = requireId(body.id);
      return { action, id, assignment: validateAssignment(body.assignment) };
    }

    case 'deleteAssignment':
      return { action, id: requireId(body.id) };

    case 'terminateAssignment': {
      const id = requireId(body.id);
      const terminationDate = validateRequiredDate(body.terminationDate, 'terminationDate');
      const reasonType = String(body.reasonType || '').trim();
      if (reasonType && TERMINATION_REASONS.indexOf(reasonType) < 0) {
        throw badRequest('bad reasonType');
      }
      const reasonDetail = String(body.reasonDetail || '').trim().slice(0, 500);
      return { action, id, terminationDate, reasonType, reasonDetail };
    }

    case 'logAbsence':
      return { action, absence: validateAbsence(body.absence) };

    case 'endAbsence':
      return { action, id: requireId(body.id) };

    case 'deleteAbsence':
      return { action, id: requireId(body.id) };

    case 'addCoverage':
      return { action, coverage: validateCoverage(body.coverage) };

    case 'deleteCoverage':
      return { action, id: requireId(body.id) };

    default:
      throw badRequest('unknown action');
  }
}

function requireId(id) {
  const s = String(id || '').trim();
  if (!s) throw badRequest('missing id');
  return s;
}

function validateDate(d) {
  const s = String(d || '').trim();
  if (!s) return new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw badRequest('bad date');
  return s;
}

function validateRequiredDate(d, label) {
  const s = String(d || '').trim();
  if (!s) throw badRequest('missing ' + label);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw badRequest('bad ' + label);
  return s;
}

module.exports = {
  HOUSE_IDS,
  ROLE_OPTIONS,
  ABSENCE_REASON_TYPES,
  TERMINATION_REASONS,
  EMPLOYMENT_TYPES,
  SALARY_MAX,
  HOURLY_RATE_MAX,
  SESSION_RATE_MAX,
  RETAINER_MAX,
  EST_HOURS_MAX,
  EST_SESSIONS_MAX,
  EXTRA_PAYMENT_MAX,
  isHouse,
  isRole,
  isEmploymentType,
  clampPct,
  clampMoney,
  clampInt,
  validateWorker,
  validateAssignment,
  validateAbsence,
  validateCoverage,
  validateAction,
  validateDate,
  validateRequiredDate,
};
