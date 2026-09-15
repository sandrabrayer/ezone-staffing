'use strict';

// Contractual weekly shift-commitment enum. Owned by lib/shift-compliance.js
// (the shared source of truth); we reuse COMMITMENT_VALUES so the whitelist
// here can never drift from the compliance math.
const { COMMITMENT_VALUES } = require('./shift-compliance');

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
// per_session carries the three independent rate/count pairs (individual,
// group, external) PLUS the legacy single sessionRate/estSessions pair. The
// legacy pair stays valid so pre-migration rows still round-trip; the worker
// form writes only the new six. All six new fields are optional (default 0).
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

// Per-field caps. Tight enough to prevent obvious abuse; loose enough that
// real-world Israeli payroll fits comfortably.
const SALARY_MAX = 1000000;
const HOURLY_RATE_MAX = 1000;
const SESSION_RATE_MAX = 5000;
const RETAINER_MAX = 200000;
const EST_HOURS_MAX = 744;        // hours in a 31-day month
const EST_SESSIONS_MAX = 500;
const EXTRA_PAYMENT_MAX = 100000;

// Monthly actuals: real hours/sessions worked in a given month, replacing
// the one-time estimate for hourly / per_session assignments. Same upper
// bounds as the estimate fields; hours may be fractional (e.g. 12.5).
const ACTUAL_HOURS_MAX = EST_HOURS_MAX;
const ACTUAL_SESSIONS_MAX = EST_SESSIONS_MAX;
// Cap the bulk upsert so a single request can't append an unbounded number
// of rows. A month of network-wide actuals is a few dozen rows at most.
const MONTHLY_ACTUALS_MAX_ITEMS = 1000;
// Cap the bulk start-date save. The roster is ~130 employees; 1000 is ample
// headroom while still bounding a single request.
const WORKER_START_DATES_MAX_ITEMS = 1000;

// Per-house monthly salary budget cap (₪). Loose enough for a whole house.
const BUDGET_MAX = 100000000;

// ---- בקרת שכר caps and enums ---------------------------------------------
// Mirrors of the same constants in apps-script/Code.gs. The real monthly
// report is ~93 lines; these bound a broken or hostile client without ever
// getting in a real month's way.
const PAYROLL_MAX_LINES = 2000;
const PAYROLL_MAX_FINDINGS = 20000;
const PAYROLL_AMOUNT_MAX = 10000000;
const PAYROLL_NOTE_MIN = 2;
const PAYROLL_NOTE_MAX = 200;
const PAYROLL_MATCH_STATUSES = ['number', 'exact', 'normalized', 'ambiguous', 'unmatched'];
const PAYROLL_SEVERITIES = ['critical', 'warning'];
const PAYROLL_DECISIONS = ['approve', 'reject'];
// Stable rule ids — mirror of RULES in lib/payroll-rules.js.
const PAYROLL_RULE_IDS = [
  'R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07', 'R08', 'R09',
  'R10', 'R11', 'R12', 'R13', 'R14', 'R15', 'R16', 'R17',
];

// Whitelisted monthly allowance values (₪): none / gas-only / car+gas.
const ALLOWANCE_VALUES = [0, 2000, 6000];

// Worker status: active (paid) / chld (חל"ד maternity) / chlt (חל"ת
// extended sick leave) / final_settlement (גמ"ח — finished with a final
// settlement). Leave states and final_settlement are unpaid; the leave
// states carry a start date, final_settlement records its month in the
// worker-level gmach_month column (set by the backend).
const WORKER_STATUS_VALUES = ['active', 'chld', 'chlt', 'final_settlement'];

// Hearing (שימוע) results. ASCII stored values; the Hebrew labels
// (אזהרה / פיטורין) live in the frontend only.
const HEARING_RESULT_VALUES = ['warning', 'dismissal'];

function isHouse(id) {
  return HOUSE_IDS.indexOf(id) >= 0;
}

function isRole(role) {
  return ROLE_OPTIONS.indexOf(role) >= 0;
}

function isEmploymentType(t) {
  return EMPLOYMENT_TYPES.indexOf(t) >= 0;
}

// Worker-level shift commitment. Optional: empty / missing is valid (no
// commitment on file → never an alert). When present it MUST be one of the
// enum values; anything else throws rather than being silently dropped, so a
// buggy or hostile client can't smuggle free text into the sheet. Returns the
// normalized value ('' when absent). Raw value only — no compliance computed.
function validateShiftCommitment(v) {
  if (v === undefined || v === null) return '';
  const s = String(v).trim();
  if (s === '') return '';
  if (COMMITMENT_VALUES.indexOf(s) < 0) throw badRequest('bad shift_commitment');
  return s;
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
  const shift_commitment = validateShiftCommitment(w.shift_commitment);
  // Employment start date — תאריך תחילת עבודה. Tracked by KEY PRESENCE, not
  // by value: the key is forwarded only when the caller actually sent it.
  // An omitted key means "leave the stored date alone"; an explicit '' means
  // "clear it". Without this, any caller posting only name/notes — an older
  // cached client, a script, a future code path — silently wipes a date that
  // was entered by hand. Since the July 2026 backfill there are real dates in
  // the sheet, so that would be destructive rather than merely untidy.
  const out = { name, notes, shift_commitment };
  if (Object.prototype.hasOwnProperty.call(w, 'startDate')) {
    out.startDate = validateOptionalDate(w.startDate, 'startDate');
  }
  // Final-settlement month (גמ"ח) — same KEY-PRESENCE rule as startDate: an
  // omitted key leaves the stored value alone, an explicit '' clears it.
  // Normally written by the backend when the status is applied; accepted
  // here so it round-trips through updateWorker without being wiped.
  if (Object.prototype.hasOwnProperty.call(w, 'gmachMonth')) {
    out.gmachMonth = validateOptionalMonth(w.gmachMonth, 'gmachMonth');
  }
  // Mobile phone — same KEY-PRESENCE rule: omitted key leaves the stored
  // number alone, explicit '' clears it, anything else must be 10 digits
  // with the leading zero (kept as TEXT so the zero survives).
  if (Object.prototype.hasOwnProperty.call(w, 'phone')) {
    out.phone = validateOptionalPhone(w.phone, 'phone');
  }
  // Payroll bureau employee number — same KEY-PRESENCE rule. Bound once in
  // בקרת שכר and then permanent, so an omitted key must never unbind it.
  if (Object.prototype.hasOwnProperty.call(w, 'payrollEmpNumber')) {
    out.payrollEmpNumber = validateOptionalPayrollEmpNumber(w.payrollEmpNumber);
  }
  return out;
}

// Batch of { id, startDate } for the setWorkerStartDates bulk action. id
// required; startDate optional ('' clears). Mirror of apps-script/Code.gs.
function validateWorkerStartDates(items) {
  if (!Array.isArray(items)) throw badRequest('updates required');
  if (items.length > WORKER_START_DATES_MAX_ITEMS) throw badRequest('too many items');
  return items.map((it) => {
    if (!it || typeof it !== 'object') throw badRequest('bad update');
    const id = requireId(it.id);
    return { id, startDate: validateOptionalDate(it.startDate, 'startDate') };
  });
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

  // Monthly allowance (₪): car+gas (6000), gas-only (2000), or none (0).
  // Whitelisted enum — applies to every employment type, so it's validated
  // outside the per-type cost-field logic. Anything unexpected → 0.
  const allowanceRaw = Number(a.allowance);
  const allowance = ALLOWANCE_VALUES.indexOf(allowanceRaw) >= 0 ? allowanceRaw : 0;

  // Worker status: active (paid) / chld (חל"ד) / chlt (חל"ת). Leave
  // states carry a start date and mean the worker isn't paid. Unknown →
  // active. statusDate is required when on leave, blank otherwise.
  const statusRaw = String(a.status || 'active').trim();
  const status = WORKER_STATUS_VALUES.indexOf(statusRaw) >= 0 ? statusRaw : 'active';
  let statusDate = '';
  if (status === 'chld' || status === 'chlt') {
    statusDate = validateRequiredDate(a.statusDate, 'statusDate');
  }

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
  // per_session 3-rate model (all optional, default 0).
  let rateIndividual = 0, sessionsIndividual = 0;
  let rateGroup = 0, sessionsGroup = 0;
  let rateExternal = 0, externalPatients = 0;

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
      // The three rate/count pairs are each optional and default to 0.
      // clampMoney / clampInt reject negatives (floored to 0) and cap at the
      // session maxima. The legacy sessionRate/estSessions pair stays
      // accepted so pre-migration rows validate on round-trip.
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
    rateIndividual,
    sessionsIndividual,
    rateGroup,
    sessionsGroup,
    rateExternal,
    externalPatients,
    allowance,
    status,
    statusDate,
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

// ---------- hearings (שימועים) ----------

// One hearing event. workerId + hearingDate + result are required; reason
// is free text (optional, trimmed + capped like every other free-text
// field). result must be one of the ASCII enum values ('warning' /
// 'dismissal') — anything else throws rather than being silently dropped,
// so free text can never reach the sheet's result column. worker_name is
// resolved server-side in Code.gs from the workers tab (never taken from
// the client), so it is deliberately NOT part of this payload.
function validateHearing(h) {
  if (!h || typeof h !== 'object') throw badRequest('hearing required');
  const workerId = String(h.workerId || '').trim();
  if (!workerId) throw badRequest('workerId required');
  const hearingDate = validateRequiredDate(h.hearingDate, 'hearingDate');
  const reason = String(h.reason || '').trim().slice(0, 500);
  const result = String(h.result || '').trim();
  if (HEARING_RESULT_VALUES.indexOf(result) < 0) throw badRequest('bad result');
  return { workerId, hearingDate, reason, result };
}

// ---------- monthly actuals ----------

// Month key: 'YYYY-MM' with a real 01–12 month. Distinct from the
// 'YYYY-MM-DD' dates used elsewhere.
function validateMonth(m, label) {
  const s = String(m || '').trim();
  if (!s) throw badRequest('missing ' + label);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(s)) throw badRequest('bad ' + label);
  return s;
}

// A non-negative numeric quantity. Returns the rounded value (hours keep
// 2 decimals, sessions are whole). Rejects negatives and non-numbers so a
// bad value surfaces rather than being silently zeroed.
function validateNonNegative(raw, label, max, decimals) {
  const n = Number(raw);
  if (!Number.isFinite(n)) throw badRequest('bad ' + label);
  if (n < 0) throw badRequest(label + ' must be non-negative');
  const capped = Math.min(n, max);
  if (decimals === 0) return Math.round(capped);
  const f = Math.pow(10, decimals);
  return Math.round(capped * f) / f;
}

const MONTHLY_ACTUALS_FIELDS = ['assignmentId', 'month', 'actualHours', 'actualSessions', 'note'];

// One actuals row. assignmentId + month are required; actualHours /
// actualSessions / note are each optional but validated when present. At
// least one of hours/sessions/note must be provided — an all-empty row is
// meaningless. Unknown fields are rejected (rule: reject unknown fields).
// The assignmentId → assignment existence check is done server-side in
// Code.gs (it has the assignments); here we only validate shape.
function validateMonthlyActualsItem(item) {
  if (!item || typeof item !== 'object') throw badRequest('actuals item required');
  Object.keys(item).forEach(function (k) {
    if (MONTHLY_ACTUALS_FIELDS.indexOf(k) < 0) throw badRequest('unknown field: ' + k);
  });
  const assignmentId = String(item.assignmentId || '').trim();
  if (!assignmentId) throw badRequest('assignmentId required');
  const month = validateMonth(item.month, 'month');

  const out = { assignmentId: assignmentId, month: month };
  let hasValue = false;
  if (item.actualHours !== undefined && item.actualHours !== null && item.actualHours !== '') {
    out.actualHours = validateNonNegative(item.actualHours, 'actualHours', ACTUAL_HOURS_MAX, 2);
    hasValue = true;
  }
  if (item.actualSessions !== undefined && item.actualSessions !== null && item.actualSessions !== '') {
    out.actualSessions = validateNonNegative(item.actualSessions, 'actualSessions', ACTUAL_SESSIONS_MAX, 0);
    hasValue = true;
  }
  const note = String(item.note || '').trim().slice(0, 500);
  if (note) { out.note = note; hasValue = true; }
  else out.note = '';
  if (!hasValue) throw badRequest('actuals item needs actualHours, actualSessions, or note');
  return out;
}

function validateMonthlyActuals(items) {
  if (!Array.isArray(items)) throw badRequest('items must be an array');
  if (!items.length) throw badRequest('items required');
  if (items.length > MONTHLY_ACTUALS_MAX_ITEMS) throw badRequest('too many items');
  // Reject duplicate (assignmentId, month) within one request — the upsert
  // is one row per pair, so duplicates would be an ambiguous double-write.
  const seen = Object.create(null);
  return items.map(function (it) {
    const v = validateMonthlyActualsItem(it);
    const key = v.assignmentId + '|' + v.month;
    if (seen[key]) throw badRequest('duplicate assignmentId+month in request: ' + key);
    seen[key] = true;
    return v;
  });
}

// ---------- budgets ----------

// A budget row targets a house for a specific month, or the sentinel
// 'default' (the fallback used for any month without a specific override).
function validateBudgetMonth(m) {
  const s = String(m || '').trim();
  if (s === 'default') return 'default';
  return validateMonth(s, 'month');
}

// `amount` is the house's TOTAL monthly budget (backward compatible: an
// existing single-value budget is the total). `instructorsAmount` is the
// OPTIONAL instructors (מדריך/ה) sub-line — validated non-negative and
// capped when present, left null when blank/absent. An instructors budget
// larger than the total is deliberately NOT rejected: the two lines are
// tracked independently and the client only warns, so this validator accepts
// the pair either way.
function validateBudget(b) {
  if (!b || typeof b !== 'object') throw badRequest('budget required');
  if (!isHouse(b.house)) throw badRequest('unknown house');
  const month = validateBudgetMonth(b.month);
  const amount = validateNonNegative(b.amount, 'amount', BUDGET_MAX, 0);
  let instructorsAmount = null;
  if (b.instructorsAmount !== undefined && b.instructorsAmount !== null && b.instructorsAmount !== '') {
    instructorsAmount = validateNonNegative(b.instructorsAmount, 'instructorsAmount', BUDGET_MAX, 0);
  }
  return { house: b.house, month: month, amount: amount, instructorsAmount: instructorsAmount };
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

    case 'setWorkerStartDates':
      return { action, updates: validateWorkerStartDates(body.updates) };

    case 'addAssignment':
      return { action, assignment: validateAssignment(body.assignment) };

    case 'updateAssignment': {
      const id = requireId(body.id);
      return { action, id, assignment: validateAssignment(body.assignment) };
    }

    case 'moveAssignment': {
      // Relocate an assignment to another house. Only id + target house.
      const id = requireId(body.id);
      const house = String(body.house || '').trim();
      if (!isHouse(house)) throw badRequest('bad target house');
      return { action, id, house };
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

    case 'upsertMonthlyActuals':
      return { action, items: validateMonthlyActuals(body.items) };

    case 'getMonthlyActuals':
      return { action, month: validateMonth(body.month, 'month') };

    case 'setBudget':
      return { action, budget: validateBudget(body.budget) };

    case 'getBudgets':
      return { action };

    case 'getHearings':
      return { action };

    case 'addHearing':
      return { action, hearing: validateHearing(body.hearing) };

    case 'updateHearing': {
      const id = requireId(body.id);
      return { action, id, hearing: validateHearing(body.hearing) };
    }

    case 'deleteHearing':
      return { action, id: requireId(body.id) };

    // ---- בקרת שכר -------------------------------------------------------
    // The proxy is the first gate in front of the Apps Script backend; it
    // rejects a malformed payroll payload before it can reach the sheet.
    // Apps Script validates all of this again (defence in depth) and is the
    // authority on the reconciliation gate.
    case 'importPayrollRun':
      return {
        action,
        month: validateMonth(body.month, 'month'),
        fileName: validateFileName(body.fileName),
        importedBy: String(body.importedBy || '').trim().slice(0, 80),
        printedTotal: validateNonNegative(body.printedTotal, 'printedTotal', PAYROLL_AMOUNT_MAX, 2),
        printedHeadcount: validateNonNegative(body.printedHeadcount, 'printedHeadcount', PAYROLL_MAX_LINES, 0),
        lines: validatePayrollLines(body.lines),
        findings: validatePayrollFindings(body.findings),
      };

    case 'getPayrollRun': {
      const out = { action };
      if (body.runId !== undefined && String(body.runId).trim()) out.runId = validatePayrollRunId(body.runId);
      if (body.month !== undefined && String(body.month).trim()) out.month = validateMonth(body.month, 'month');
      return out;
    }

    // `action` is the dispatch key, so the approve / reject choice travels
    // under its own name: `decision`.
    case 'resolvePayrollFinding':
      return {
        action,
        runId: validatePayrollRunId(body.runId),
        lineId: validatePayrollLineId(body.lineId, false),
        ruleId: validatePayrollRuleId(body.ruleId),
        decision: validatePayrollDecision(body.decision),
        note: validatePayrollNote(body.note),
        actor: String(body.actor || '').trim().slice(0, 80),
      };

    case 'lockPayrollRun':
      return {
        action,
        runId: validatePayrollRunId(body.runId),
        actor: String(body.actor || '').trim().slice(0, 80),
      };

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

// A date that may be blank: '' passes through (means "not entered"); a
// non-empty value must be 'YYYY-MM-DD'. Mirror of apps-script/Code.gs.
function validateOptionalDate(d, label) {
  const s = String(d || '').trim();
  if (!s) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw badRequest('bad ' + label);
  return s;
}

// A month key that may be blank: '' passes through (clears the stored
// value); a non-empty value must be 'YYYY-MM'. Mirror of apps-script/Code.gs.
function validateOptionalMonth(m, label) {
  const s = String(m || '').trim();
  if (!s) return '';
  return validateMonth(s, label);
}

// A mobile phone that may be blank: '' passes through (clears the stored
// value); otherwise spaces / dashes are stripped and the result must be
// EXACTLY 10 digits starting with 0 ('0501234567'). Mirror of
// apps-script/Code.gs.
function validateOptionalPhone(p, label) {
  const s = String(p || '').replace(/[\s-]/g, '').trim();
  if (!s) return '';
  if (!/^0\d{9}$/.test(s)) throw badRequest('bad ' + label);
  return s;
}

// ---------- בקרת שכר validators ----------
// Every one of these mirrors a check in apps-script/Code.gs. The proxy
// rejects early; Apps Script rejects again and owns the reconciliation gate.

// Optional payroll employee number: '' clears the binding, otherwise 1-6
// digits stored with leading zeros stripped, so the bureau's printed '0033'
// and a typed '33' are the same key.
function validateOptionalPayrollEmpNumber(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  if (!/^\d{1,6}$/.test(s)) throw badRequest('bad payrollEmpNumber');
  return String(Number(s));
}

// The uploaded file's name, kept for the audit trail only. Path separators
// and control characters are stripped — it is never used to open anything,
// but it IS rendered, so it must not carry a path or a newline.
function validateFileName(v) {
  const s = String(v == null ? '' : v)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\\/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  if (!s) throw badRequest('fileName required');
  return s;
}

function validatePayrollRunId(v) {
  const s = String(v == null ? '' : v).trim();
  if (!/^pr_[A-Za-z0-9_]{4,40}$/.test(s)) throw badRequest('bad runId');
  return s;
}

function validatePayrollLineId(v, required) {
  const s = String(v == null ? '' : v).trim();
  if (!s) {
    if (required) throw badRequest('lineId required');
    return '';
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(s)) throw badRequest('bad lineId');
  return s;
}

function validatePayrollRuleId(v) {
  const s = String(v == null ? '' : v).trim();
  if (PAYROLL_RULE_IDS.indexOf(s) < 0) throw badRequest('bad ruleId');
  return s;
}

function validatePayrollDecision(v) {
  const s = String(v == null ? '' : v).trim();
  if (PAYROLL_DECISIONS.indexOf(s) < 0) throw badRequest('bad decision');
  return s;
}

// The mandatory reason on every approve / reject. 2-200 characters, so a
// resolution is never a bare click.
function validatePayrollNote(v) {
  const s = String(v == null ? '' : v).trim();
  if (s.length < PAYROLL_NOTE_MIN) throw badRequest('note too short');
  if (s.length > PAYROLL_NOTE_MAX) throw badRequest('note too long');
  return s;
}

function validatePayrollAmount(v, label) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw badRequest('bad ' + label);
  if (Math.abs(n) > PAYROLL_AMOUNT_MAX) throw badRequest(label + ' out of range');
  return Math.round(n * 100) / 100;
}

const PAYROLL_LINE_AMOUNTS = [
  'tashlumim', 'tagmulim', 'keren', 'pitzuim', 'shonot', 'bituach',
  'masMaasikim', 'masSachar', 'total',
];

function validatePayrollLines(items) {
  if (!Array.isArray(items)) throw badRequest('lines required');
  if (!items.length) throw badRequest('lines empty');
  if (items.length > PAYROLL_MAX_LINES) throw badRequest('too many lines');
  const seen = Object.create(null);
  return items.map((it, i) => {
    if (!it || typeof it !== 'object') throw badRequest('bad line at ' + i);
    const lineId = validatePayrollLineId(it.lineId, true);
    if (seen[lineId]) throw badRequest('duplicate lineId ' + lineId);
    seen[lineId] = true;
    const empNumber = String(it.empNumber == null ? '' : it.empNumber).trim();
    if (!/^\d{1,6}$/.test(empNumber)) throw badRequest('bad empNumber at ' + i);
    const dept = String(it.dept == null ? '' : it.dept).trim();
    if (!/^\d{1,4}$/.test(dept)) throw badRequest('bad dept at ' + i);
    // '' means the department is known but its house is not confirmed yet —
    // the rules raise R16 for that. Anything else must be a real house id.
    const mappedHouse = String(it.mappedHouse == null ? '' : it.mappedHouse).trim();
    if (mappedHouse && !isHouse(mappedHouse)) throw badRequest('bad mappedHouse at ' + i);
    const matchStatus = String(it.matchStatus == null ? '' : it.matchStatus).trim();
    if (PAYROLL_MATCH_STATUSES.indexOf(matchStatus) < 0) throw badRequest('bad matchStatus at ' + i);
    const out = {
      lineId,
      empNumber: String(Number(empNumber)),
      rawName: String(it.rawName || '').trim().slice(0, 120),
      matchedWorkerId: String(it.matchedWorkerId || '').trim().slice(0, 64),
      matchStatus,
      dept,
      mappedHouse,
    };
    if (!out.rawName) throw badRequest('rawName required at ' + i);
    PAYROLL_LINE_AMOUNTS.forEach((k) => { out[k] = validatePayrollAmount(it[k], k + ' at ' + i); });
    return out;
  });
}

function validatePayrollFindings(items) {
  if (items === undefined || items === null) return [];
  if (!Array.isArray(items)) throw badRequest('findings must be an array');
  if (items.length > PAYROLL_MAX_FINDINGS) throw badRequest('too many findings');
  return items.map((it, i) => {
    if (!it || typeof it !== 'object') throw badRequest('bad finding at ' + i);
    const severity = String(it.severity == null ? '' : it.severity).trim();
    if (PAYROLL_SEVERITIES.indexOf(severity) < 0) throw badRequest('bad severity at ' + i);
    const messageHe = String(it.messageHe || '').trim().slice(0, 300);
    if (!messageHe) throw badRequest('messageHe required at ' + i);
    return {
      // A run-level finding legitimately has no line: R03 names a worker who
      // has no line in the file at all.
      lineId: validatePayrollLineId(it.lineId, false),
      ruleId: validatePayrollRuleId(it.ruleId),
      severity,
      expected: String(it.expected == null ? '' : it.expected).trim().slice(0, 120),
      actual: String(it.actual == null ? '' : it.actual).trim().slice(0, 120),
      messageHe,
    };
  });
}

module.exports = {
  HOUSE_IDS,
  ROLE_OPTIONS,
  ABSENCE_REASON_TYPES,
  TERMINATION_REASONS,
  EMPLOYMENT_TYPES,
  PER_SESSION_RATE_FIELDS,
  SALARY_MAX,
  HOURLY_RATE_MAX,
  SESSION_RATE_MAX,
  RETAINER_MAX,
  EST_HOURS_MAX,
  EST_SESSIONS_MAX,
  EXTRA_PAYMENT_MAX,
  ACTUAL_HOURS_MAX,
  ACTUAL_SESSIONS_MAX,
  MONTHLY_ACTUALS_MAX_ITEMS,
  BUDGET_MAX,
  PAYROLL_MAX_LINES,
  PAYROLL_MAX_FINDINGS,
  PAYROLL_AMOUNT_MAX,
  PAYROLL_NOTE_MIN,
  PAYROLL_NOTE_MAX,
  PAYROLL_MATCH_STATUSES,
  PAYROLL_SEVERITIES,
  PAYROLL_DECISIONS,
  PAYROLL_RULE_IDS,
  validateOptionalPayrollEmpNumber,
  validateFileName,
  validatePayrollRunId,
  validatePayrollLineId,
  validatePayrollRuleId,
  validatePayrollDecision,
  validatePayrollNote,
  validatePayrollLines,
  validatePayrollFindings,
  COMMITMENT_VALUES,
  isHouse,
  isRole,
  isEmploymentType,
  validateShiftCommitment,
  clampPct,
  clampMoney,
  clampInt,
  validateWorker,
  validateWorkerStartDates,
  WORKER_START_DATES_MAX_ITEMS,
  validateAssignment,
  validateAbsence,
  validateCoverage,
  validateMonth,
  validateOptionalMonth,
  validateOptionalPhone,
  HEARING_RESULT_VALUES,
  validateHearing,
  validateMonthlyActualsItem,
  validateMonthlyActuals,
  validateBudget,
  validateAction,
  validateDate,
  validateRequiredDate,
  validateOptionalDate,
};
