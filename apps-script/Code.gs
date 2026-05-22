/* ============================================================
   E-ZONE Staffing — Apps Script backend
   Bound to a Google Sheet. Deployed as Web App (execute as: me,
   who has access: anyone). Auth is enforced via a shared secret
   passed in every request — the URL alone is NOT authorization.

   Script properties required (Project Settings → Script Properties):
     - SHARED_SECRET   : must match server.js SHARED_SECRET env var
     - SHEET_ID        : the spreadsheet id (the long string in the
                         Sheet URL between /d/ and /edit)

   Data model
   ----------
   House tabs (ramot/asher/ofroni/rehab):
     id | name | role | salary | pct | notes | role_detail
   Employees stay in their home house permanently. Salary is ALWAYS
   attributed to the home house.

   events tab:
     id | employee_id | employee_name | home_house | host_house |
     start_date | end_date | reason_type | reason_detail |
     covers_employee_id | bonus_amount | status | created_at
   A coverage event records a temporary helping stint at host_house.
   Status is derived from dates on read (active iff start <= today
   <= end). Stored status is a hint that gets corrected lazily.

   archive tab:
     id | employee_id | name | role | role_detail | salary | pct | notes |
     home_house | termination_date | reason_type | reason_detail | archived_at
   When an employee is terminated, their snapshot moves here and the
   row is removed from the home tab. termination_date is the effective
   last day on payroll: cost continues to count until that date (so a
   "schedule a termination at end of month" workflow works), then drops
   to zero. Any active coverage event whose subject is this employee
   is auto-truncated to terminationDate on save.

   history tab (legacy):
     kept untouched as a backup. After running migrateHistoryToEvents()
     once, its rows are also present in events with status='ended'.
   ============================================================ */

const HOUSE_IDS = ['ramot', 'asher', 'ofroni', 'rehab'];
const HISTORY_TAB = 'history';
const EVENTS_TAB = 'events';
const ARCHIVE_TAB = 'archive';

const HEADERS_HOUSE = ['id', 'name', 'role', 'salary', 'pct', 'notes', 'role_detail'];
const HEADERS_HISTORY = ['timestamp', 'name', 'from_house', 'to_house', 'reason_type', 'reason', 'date'];
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
const REASON_TYPES = [
  'חופשה', 'חל״ת', 'מחלה', 'חופשת לידה', 'ניתוח', 'צורך תפעולי', 'אחר',
];
const TERMINATION_REASONS = [
  'התפטרות', 'פיטורין', 'סיום חוזה', 'מעבר תפקיד', 'אחר',
];
const BONUS_MAX = 100000;

// ---------- entry points ----------

function doGet(e) {
  return handle(e, () => {
    const houses = {};
    HOUSE_IDS.forEach(h => { houses[h] = readHouse(h); });
    return { houses, events: readEvents(), archive: readArchive() };
  });
}

function doPost(e) {
  return handle(e, () => {
    const body = parseBody(e);
    switch (body.action) {
      case 'addEmployee':       return addEmployee(body);
      case 'updateEmployee':    return updateEmployee(body);
      case 'deleteEmployee':    return deleteEmployee(body);
      case 'startCoverage':     return startCoverage(body);
      case 'endCoverage':       return endCoverage(body);
      case 'terminateEmployee': return terminateEmployee(body);
      default: throw httpError(400, 'unknown action');
    }
  });
}

function handle(e, fn) {
  try {
    if (!authorized(e)) return json({ error: 'unauthorized' }, 401);
    const result = fn();
    return json(result, 200);
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
  return ContentService
    .createTextOutput(JSON.stringify({ _status: status || 200, ...obj }))
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

function readHouse(houseId) {
  assertHouse(houseId);
  const sh = sheetByName(houseId);
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  return values.slice(1)
    .filter(r => String(r[0] || '').trim() !== '')
    .map(r => ({
      id: String(r[0]),
      name: String(r[1] || ''),
      role: String(r[2] || ''),
      salary: Number(r[3]) || 0,
      pct: clampPct(Number(r[4])),
      notes: String(r[5] || ''),
      roleDetail: String(r[6] || ''),
    }));
}

// Reads events and lazily corrects status: any row whose stored status is
// 'active' but whose end_date < today is rewritten to 'ended' in the sheet
// AND in the returned row. This keeps the sheet readable without depending
// on a trigger.
function readEvents() {
  const sh = sheetByName(EVENTS_TAB);
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  const today = todayLocal();
  const corrections = [];
  const out = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    if (String(r[0] || '').trim() === '') continue;
    const startDate = formatDateCell(r[5]);
    const endDate = formatDateCell(r[6]);
    let status = String(r[11] || '').trim() || (active(startDate, endDate, today) ? 'active' : 'ended');
    if (status === 'active' && endDate && endDate < today) {
      status = 'ended';
      corrections.push({ row: i + 1, status });
    }
    out.push({
      id: String(r[0]),
      employeeId: String(r[1] || ''),
      employeeName: String(r[2] || ''),
      homeHouse: String(r[3] || ''),
      hostHouse: String(r[4] || ''),
      startDate,
      endDate,
      reasonType: String(r[7] || ''),
      reasonDetail: String(r[8] || ''),
      coversEmployeeId: String(r[9] || ''),
      bonusAmount: Number(r[10]) || 0,
      status,
      createdAt: r[12] instanceof Date ? r[12].toISOString() : String(r[12] || ''),
    });
  }
  if (corrections.length) {
    corrections.forEach(c => {
      sh.getRange(c.row, 12).setValue(c.status); // status column (1-indexed: col 12)
    });
  }
  return out;
}

function findRow(sheet, idColIndex, id) {
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][idColIndex]) === String(id)) return i + 1; // 1-indexed
  }
  return -1;
}

// ---------- actions ----------

function addEmployee(body) {
  const house = body.house;
  assertHouse(house);
  const emp = validateEmployee(body.employee || {});
  emp.id = newId('e');
  sheetByName(house).appendRow([emp.id, emp.name, emp.role, emp.salary, emp.pct, emp.notes, emp.roleDetail]);
  return { ok: true, employee: emp };
}

function updateEmployee(body) {
  const house = body.house;
  assertHouse(house);
  const id = String(body.id || '');
  if (!id) throw httpError(400, 'missing id');
  const emp = validateEmployee(body.employee || {});
  const sh = sheetByName(house);
  const row = findRow(sh, 0, id);
  if (row < 0) throw httpError(404, 'employee not found');
  sh.getRange(row, 1, 1, HEADERS_HOUSE.length)
    .setValues([[id, emp.name, emp.role, emp.salary, emp.pct, emp.notes, emp.roleDetail]]);
  return { ok: true, employee: { ...emp, id } };
}

function deleteEmployee(body) {
  const house = body.house;
  assertHouse(house);
  const id = String(body.id || '');
  if (!id) throw httpError(400, 'missing id');
  const sh = sheetByName(house);
  const row = findRow(sh, 0, id);
  if (row < 0) throw httpError(404, 'employee not found');
  sh.deleteRow(row);
  return { ok: true };
}

function startCoverage(body) {
  const employeeId = String(body.employeeId || '');
  if (!employeeId) throw httpError(400, 'missing employeeId');
  assertHouse(body.homeHouse);
  assertHouse(body.hostHouse);
  if (body.homeHouse === body.hostHouse) throw httpError(400, 'hostHouse must differ from homeHouse');
  const startDate = validateRequiredDate(body.startDate, 'startDate');
  const endDate = validateRequiredDate(body.endDate, 'endDate');
  if (endDate < startDate) throw httpError(400, 'endDate before startDate');
  const reasonType = String(body.reasonType || '');
  if (REASON_TYPES.indexOf(reasonType) < 0) throw httpError(400, 'bad reasonType');
  const reasonDetail = String(body.reasonDetail || '').trim().slice(0, 500);
  const coversEmployeeId = String(body.coversEmployeeId || '').trim();
  const bonusAmount = clampBonus(body.bonusAmount);

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    // Confirm employee exists in homeHouse.
    const homeSh = sheetByName(body.homeHouse);
    const homeRow = findRow(homeSh, 0, employeeId);
    if (homeRow < 0) throw httpError(404, 'employee not found in homeHouse');
    const empName = String(homeSh.getRange(homeRow, 2).getValue() || '');

    // Reject overlapping active events for the same employee.
    const events = readEvents();
    const conflict = events.find(ev =>
      ev.employeeId === employeeId &&
      ev.status === 'active' &&
      datesOverlap(ev.startDate, ev.endDate, startDate, endDate)
    );
    if (conflict) {
      throw httpError(409, 'employee already has an active coverage event in this range');
    }

    const today = todayLocal();
    const status = active(startDate, endDate, today) ? 'active' : 'ended';
    const id = newId('ev');
    const createdAt = new Date().toISOString();
    sheetByName(EVENTS_TAB).appendRow([
      id, employeeId, empName, body.homeHouse, body.hostHouse,
      startDate, endDate, reasonType, reasonDetail,
      coversEmployeeId, bonusAmount, status, createdAt,
    ]);
    return {
      ok: true,
      event: {
        id, employeeId, employeeName: empName,
        homeHouse: body.homeHouse, hostHouse: body.hostHouse,
        startDate, endDate, reasonType, reasonDetail,
        coversEmployeeId, bonusAmount, status, createdAt,
      },
    };
  } finally {
    lock.releaseLock();
  }
}

function endCoverage(body) {
  const eventId = String(body.eventId || '');
  if (!eventId) throw httpError(400, 'missing eventId');
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sh = sheetByName(EVENTS_TAB);
    const row = findRow(sh, 0, eventId);
    if (row < 0) throw httpError(404, 'event not found');
    const today = todayLocal();
    const currentEndStr = formatDateCell(sh.getRange(row, 7).getValue());
    const newEnd = currentEndStr && currentEndStr < today ? currentEndStr : today;
    sh.getRange(row, 7).setValue(newEnd);   // end_date
    sh.getRange(row, 12).setValue('ended'); // status
    return { ok: true, eventId, endDate: newEnd, status: 'ended' };
  } finally {
    lock.releaseLock();
  }
}

// Reads the archive tab. Each row is a terminated-employee snapshot
// including the salary/pct at termination time, so cost reconstruction
// for pending-termination periods works without joining back to the
// active roster.
function readArchive() {
  const sh = ss().getSheetByName(ARCHIVE_TAB);
  if (!sh) return []; // tab might not exist yet on first deploy
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  return values.slice(1)
    .filter(r => String(r[0] || '').trim() !== '')
    .map(r => ({
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
      archivedAt: r[12] instanceof Date ? r[12].toISOString() : String(r[12] || ''),
    }));
}

function terminateEmployee(body) {
  const house = body.house;
  assertHouse(house);
  const id = String(body.id || '');
  if (!id) throw httpError(400, 'missing id');
  const terminationDate = validateRequiredDate(body.terminationDate, 'terminationDate');
  const reasonTypeRaw = String(body.reasonType || '').trim();
  if (reasonTypeRaw && TERMINATION_REASONS.indexOf(reasonTypeRaw) < 0) {
    throw httpError(400, 'bad reasonType');
  }
  const reasonDetail = String(body.reasonDetail || '').trim().slice(0, 500);

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    // Snapshot the employee row from the home tab.
    const homeSh = sheetByName(house);
    const row = findRow(homeSh, 0, id);
    if (row < 0) throw httpError(404, 'employee not found');
    const r = homeSh.getRange(row, 1, 1, HEADERS_HOUSE.length).getValues()[0];
    const snapshot = {
      id: String(r[0]),
      name: String(r[1] || ''),
      role: String(r[2] || ''),
      salary: Number(r[3]) || 0,
      pct: clampPct(Number(r[4])),
      notes: String(r[5] || ''),
      roleDetail: String(r[6] || ''),
    };

    // Auto-truncate any active coverage event where the subject is this
    // employee and the current end_date is after terminationDate. If the
    // current end_date is already on or before terminationDate, leave it.
    const evSh = sheetByName(EVENTS_TAB);
    const evValues = evSh.getDataRange().getValues();
    const today = todayLocal();
    let autoEnded = 0;
    for (let i = 1; i < evValues.length; i++) {
      const ev = evValues[i];
      if (String(ev[0] || '').trim() === '') continue;
      if (String(ev[1]) !== id) continue;
      const stored = String(ev[11] || '').trim();
      if (stored !== 'active') continue;
      const evEnd = formatDateCell(ev[6]);
      if (!(evEnd > terminationDate)) continue;
      // terminationDate is the first day NOT counted (cost rule). Event
      // stays active only while terminationDate is strictly in the future
      // — equal-to-today means we stop counting from today.
      const newStatus = terminationDate > today ? 'active' : 'ended';
      evSh.getRange(i + 1, 7).setValue(terminationDate);
      evSh.getRange(i + 1, 12).setValue(newStatus);
      autoEnded++;
    }

    // Append the archive row.
    const archId = newId('arch');
    const archivedAt = new Date().toISOString();
    const archSh = sheetByName(ARCHIVE_TAB);
    archSh.appendRow([
      archId, snapshot.id, snapshot.name, snapshot.role, snapshot.roleDetail,
      snapshot.salary, snapshot.pct, snapshot.notes,
      house, terminationDate, reasonTypeRaw, reasonDetail, archivedAt,
    ]);

    // Remove from the home tab.
    homeSh.deleteRow(row);

    return {
      ok: true,
      archive: {
        id: archId,
        employeeId: snapshot.id,
        name: snapshot.name,
        role: snapshot.role,
        roleDetail: snapshot.roleDetail,
        salary: snapshot.salary,
        pct: snapshot.pct,
        notes: snapshot.notes,
        homeHouse: house,
        terminationDate,
        reasonType: reasonTypeRaw,
        reasonDetail,
        archivedAt,
      },
      autoEndedEvents: autoEnded,
    };
  } finally {
    lock.releaseLock();
  }
}

// ---------- validation ----------

function assertHouse(id) {
  if (HOUSE_IDS.indexOf(id) < 0) throw httpError(400, 'unknown house: ' + id);
}

function clampPct(n) {
  if (!isFinite(n)) return 100;
  return Math.max(1, Math.min(100, Math.round(n)));
}

function clampBonus(n) {
  const num = Number(n);
  if (!isFinite(num)) return 0;
  return Math.max(0, Math.min(BONUS_MAX, Math.round(num)));
}

function validateEmployee(emp) {
  const name = String(emp.name || '').trim().slice(0, 80);
  if (!name) throw httpError(400, 'name required');
  const role = String(emp.role || '').trim();
  if (ROLE_OPTIONS.indexOf(role) < 0) throw httpError(400, 'bad role');
  const roleDetail = String(emp.roleDetail || '').trim().slice(0, 80);
  if (role === 'אחר' && !roleDetail) throw httpError(400, 'roleDetail required when role is אחר');
  const salary = Math.max(0, Math.round(Number(emp.salary) || 0));
  const pct = clampPct(Number(emp.pct));
  const notes = String(emp.notes || '').trim().slice(0, 500);
  return { name, role, roleDetail, salary, pct, notes };
}

function validateRequiredDate(d, label) {
  const s = String(d || '').trim();
  if (!s) throw httpError(400, 'missing ' + label);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw httpError(400, 'bad ' + label);
  return s;
}

function validateDate(d) {
  const s = String(d || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    if (!s) return todayLocal();
    throw httpError(400, 'bad date');
  }
  return s;
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

function active(startDate, endDate, today) {
  return startDate && endDate && startDate <= today && today <= endDate;
}

function datesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && bStart <= aEnd;
}

function newId(prefix) {
  return (prefix || 'x') + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ---------- one-time setup helper ----------
// Run this once from the Apps Script editor (Run → setupSheets) AFTER
// setting SHEET_ID in Script Properties. Safe to re-run — it never
// deletes data and only writes missing headers / appends missing tabs.

function setupSheets() {
  const book = ss();
  const wanted = HOUSE_IDS.map(h => ({ name: h, headers: HEADERS_HOUSE }))
    .concat([
      { name: HISTORY_TAB, headers: HEADERS_HISTORY },
      { name: EVENTS_TAB, headers: HEADERS_EVENTS },
      { name: ARCHIVE_TAB, headers: HEADERS_ARCHIVE },
    ]);

  wanted.forEach(w => {
    let sh = book.getSheetByName(w.name);
    if (!sh) sh = book.insertSheet(w.name);
    ensureHeaders(sh, w.headers);
  });

  const def = book.getSheetByName('Sheet1') || book.getSheetByName('גיליון1');
  if (def && def.getLastRow() === 0 && book.getSheets().length > 1) {
    book.deleteSheet(def);
  }
  return 'ok';
}

// Writes any missing header cells without disturbing existing data. If the
// sheet is brand new (empty first row), it writes the whole header. If the
// sheet already has N < expected.length headers, it appends the missing ones
// at columns N+1..expected.length, leaving columns 1..N alone.
function ensureHeaders(sh, expected) {
  const lastCol = Math.max(sh.getLastColumn(), 1);
  const firstRow = sh.getRange(1, 1, 1, Math.max(lastCol, expected.length)).getValues()[0];
  const empty = firstRow.every(c => String(c || '').trim() === '');
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

// One-shot migration: copy every history row into events with status='ended'.
// Safe to re-run — skips rows that already have a matching entry in events
// (matched by name + date + from_house + to_house, since legacy history has
// no stable id).
function migrateHistoryToEvents() {
  const histSh = sheetByName(HISTORY_TAB);
  const evSh = sheetByName(EVENTS_TAB);
  const hist = histSh.getDataRange().getValues();
  if (hist.length < 2) return 'no history rows';

  const existing = evSh.getDataRange().getValues();
  const existingKeys = {};
  for (let i = 1; i < existing.length; i++) {
    const r = existing[i];
    if (String(r[0] || '').trim() === '') continue;
    // legacy migrated rows have employee_id === '' — key on name + dates + houses
    const key = [
      String(r[2] || ''), // name
      String(r[3] || ''), // home_house
      String(r[4] || ''), // host_house
      formatDateCell(r[5]), // start_date
    ].join('|');
    existingKeys[key] = true;
  }

  let added = 0;
  for (let i = 1; i < hist.length; i++) {
    const r = hist[i];
    const name = String(r[1] || '').trim();
    if (!name) continue;
    const fromHouse = String(r[2] || '');
    const toHouse = String(r[3] || '');
    const reasonType = String(r[4] || '');
    const reason = String(r[5] || '');
    const date = formatDateCell(r[6]);
    const tsIso = r[0] instanceof Date ? r[0].toISOString() : String(r[0] || '');
    const key = [name, fromHouse, toHouse, date].join('|');
    if (existingKeys[key]) continue;
    evSh.appendRow([
      newId('ev'), '', name, fromHouse, toHouse,
      date, date, reasonType, reason,
      '', 0, 'ended', tsIso,
    ]);
    existingKeys[key] = true;
    added++;
  }
  return 'migrated ' + added + ' rows';
}
