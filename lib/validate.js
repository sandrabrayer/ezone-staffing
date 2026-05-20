'use strict';

const HOUSE_IDS = ['ramot', 'asher', 'ofroni', 'rehab'];
const REASON_TYPES = ['כיסוי חוסר', 'העברה קבועה', 'צורך תפעולי', 'אחר'];

function isHouse(id) {
  return HOUSE_IDS.indexOf(id) >= 0;
}

function clampPct(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return 100;
  return Math.max(1, Math.min(100, Math.round(num)));
}

function validateEmployee(emp) {
  if (!emp || typeof emp !== 'object') throw badRequest('employee required');
  const name = String(emp.name || '').trim().slice(0, 80);
  if (!name) throw badRequest('name required');
  const role = String(emp.role || '').trim().slice(0, 80);
  const salary = Math.max(0, Math.round(Number(emp.salary) || 0));
  const pct = clampPct(emp.pct);
  const notes = String(emp.notes || '').trim().slice(0, 500);
  return { name, role, salary, pct, notes };
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
    case 'moveEmployee': {
      if (!isHouse(body.fromHouse)) throw badRequest('unknown fromHouse');
      if (!isHouse(body.toHouse)) throw badRequest('unknown toHouse');
      if (body.fromHouse === body.toHouse) throw badRequest('same source and target');
      const id = String(body.id || '').trim();
      if (!id) throw badRequest('missing id');
      const reasonType = String(body.reasonType || '');
      if (REASON_TYPES.indexOf(reasonType) < 0) throw badRequest('bad reasonType');
      const reason = String(body.reason || '').trim().slice(0, 500);
      const date = validateDate(body.date);
      return {
        action,
        fromHouse: body.fromHouse,
        toHouse: body.toHouse,
        id,
        reasonType,
        reason,
        date,
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

function badRequest(msg) {
  const err = new Error(msg);
  err.status = 400;
  return err;
}

module.exports = {
  HOUSE_IDS,
  REASON_TYPES,
  isHouse,
  clampPct,
  validateEmployee,
  validateAction,
  validateDate,
};
