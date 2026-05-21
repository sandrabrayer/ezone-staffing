'use strict';

const HOUSE_IDS = ['ramot', 'asher', 'ofroni', 'rehab'];

// Roles users can pick from in the Add/Edit dialog. The exact strings
// (including gender slashes) are the contract — stored verbatim.
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

// Reasons a coverage event is opened. The list is closed for *new* writes;
// legacy values from migrated history rows still parse on read.
const REASON_TYPES = [
  'חופשה',
  'חל״ת',
  'מחלה',
  'חופשת לידה',
  'ניתוח',
  'צורך תפעולי',
  'אחר',
];

// Reasons for employment termination. Optional on the action — the user
// may save a termination without a reason. If present, must match this list.
const TERMINATION_REASONS = [
  'התפטרות',
  'פיטורין',
  'סיום חוזה',
  'מעבר תפקיד',
  'אחר',
];

const BONUS_MAX = 100000;

function isHouse(id) {
  return HOUSE_IDS.indexOf(id) >= 0;
}

function isRole(role) {
  return ROLE_OPTIONS.indexOf(role) >= 0;
}

function clampPct(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return 100;
  return Math.max(1, Math.min(100, Math.round(num)));
}

function clampBonus(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.min(BONUS_MAX, Math.round(num)));
}

function validateEmployee(emp) {
  if (!emp || typeof emp !== 'object') throw badRequest('employee required');
  const name = String(emp.name || '').trim().slice(0, 80);
  if (!name) throw badRequest('name required');
  const role = String(emp.role || '').trim();
  if (!isRole(role)) throw badRequest('bad role');
  const roleDetail = String(emp.roleDetail || '').trim().slice(0, 80);
  if (role === 'אחר' && !roleDetail) throw badRequest('roleDetail required when role is אחר');
  const salary = Math.max(0, Math.round(Number(emp.salary) || 0));
  const pct = clampPct(emp.pct);
  const notes = String(emp.notes || '').trim().slice(0, 500);
  return { name, role, roleDetail, salary, pct, notes };
}

function validateAction(body) {
  if (!body || typeof body !== 'object') throw badRequest('body required');
  const action = String(body.action || '');
  switch (action) {
    case 'addEmployee': {
      if (!isHouse(body.house)) throw badRequest('unknown house');
      return { action, house: body.house, employee: validateEmployee(body.employee) };
    }
    case 'updateEmployee': {
      if (!isHouse(body.house)) throw badRequest('unknown house');
      const id = String(body.id || '').trim();
      if (!id) throw badRequest('missing id');
      return { action, house: body.house, id, employee: validateEmployee(body.employee) };
    }
    case 'deleteEmployee': {
      if (!isHouse(body.house)) throw badRequest('unknown house');
      const id = String(body.id || '').trim();
      if (!id) throw badRequest('missing id');
      return { action, house: body.house, id };
    }
    case 'startCoverage': {
      const employeeId = String(body.employeeId || '').trim();
      if (!employeeId) throw badRequest('missing employeeId');
      if (!isHouse(body.homeHouse)) throw badRequest('unknown homeHouse');
      if (!isHouse(body.hostHouse)) throw badRequest('unknown hostHouse');
      if (body.homeHouse === body.hostHouse) throw badRequest('hostHouse must differ from homeHouse');
      const startDate = validateRequiredDate(body.startDate, 'startDate');
      const endDate = validateRequiredDate(body.endDate, 'endDate');
      if (endDate < startDate) throw badRequest('endDate before startDate');
      const reasonType = String(body.reasonType || '');
      if (REASON_TYPES.indexOf(reasonType) < 0) throw badRequest('bad reasonType');
      const reasonDetail = String(body.reasonDetail || '').trim().slice(0, 500);
      const coversEmployeeId = String(body.coversEmployeeId || '').trim();
      const bonusAmount = clampBonus(body.bonusAmount);
      return {
        action,
        employeeId,
        homeHouse: body.homeHouse,
        hostHouse: body.hostHouse,
        startDate,
        endDate,
        reasonType,
        reasonDetail,
        coversEmployeeId,
        bonusAmount,
      };
    }
    case 'endCoverage': {
      const eventId = String(body.eventId || '').trim();
      if (!eventId) throw badRequest('missing eventId');
      return { action, eventId };
    }
    case 'terminateEmployee': {
      if (!isHouse(body.house)) throw badRequest('unknown house');
      const id = String(body.id || '').trim();
      if (!id) throw badRequest('missing id');
      // Termination date is required but unbounded: past dates record a
      // retroactive termination, future dates schedule one (cost keeps
      // counting until that date arrives — see lib/calc.js pendingHomeCost).
      const terminationDate = validateRequiredDate(body.terminationDate, 'terminationDate');
      const reasonTypeRaw = String(body.reasonType || '').trim();
      if (reasonTypeRaw && TERMINATION_REASONS.indexOf(reasonTypeRaw) < 0) {
        throw badRequest('bad reasonType');
      }
      const reasonDetail = String(body.reasonDetail || '').trim().slice(0, 500);
      return {
        action,
        house: body.house,
        id,
        terminationDate,
        reasonType: reasonTypeRaw,
        reasonDetail,
      };
    }
    default:
      throw badRequest('unknown action');
  }
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

function badRequest(msg) {
  const err = new Error(msg);
  err.status = 400;
  return err;
}

module.exports = {
  HOUSE_IDS,
  ROLE_OPTIONS,
  REASON_TYPES,
  TERMINATION_REASONS,
  BONUS_MAX,
  isHouse,
  isRole,
  clampPct,
  clampBonus,
  validateEmployee,
  validateAction,
  validateDate,
  validateRequiredDate,
};
