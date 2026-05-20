/* ============================================================
   E-ZONE Staffing — Apps Script backend
   Bound to a Google Sheet. Deployed as Web App (execute as: me,
   who has access: anyone). Auth is enforced via a shared secret
   passed in every request — the URL alone is NOT authorization.

   Script properties required (Project Settings → Script Properties):
     - SHARED_SECRET   : must match server.js SHARED_SECRET env var
     - SHEET_ID        : the spreadsheet id (the long string in the
                         Sheet URL between /d/ and /edit)
   ============================================================ */

const HOUSE_IDS = ['ramot', 'asher', 'ofroni', 'rehab'];
const HISTORY_TAB = 'history';
const HEADERS_HOUSE = ['id', 'name', 'role', 'salary', 'pct', 'notes'];
const HEADERS_HISTORY = ['timestamp', 'name', 'from_house', 'to_house', 'reason_type', 'reason', 'date'];

const REASON_TYPES = ['כיסוי חוסר', 'העברה קבועה', 'צורך תפעולי', 'אחר'];

// ---------- entry points ----------

function doGet(e) {
  return handle(e, () => {
    const houses = {};
    HOUSE_IDS.forEach(h => { houses[h] = readHouse(h); });
    return { houses, history: readHistory() };
  });
}

function doPost(e) {
  return handle(e, () => {
    const body = parseBody(e);
    switch (body.action) {
      case 'addEmployee':    return addEmployee(body);
      case 'updateEmployee': return updateEmployee(body);
      case 'deleteEmployee': return deleteEmployee(body);
      case 'moveEmployee':   return moveEmployee(body);
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
  // constant-time-ish compare
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
  // Apps Script Web Apps can't set HTTP status codes directly via ContentService.
  // We always return 200 and put status in the body so the proxy can re-map.
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
  const rows = values.slice(1);
  return rows
    .filter(r => String(r[0] || '').trim() !== '')
    .map(r => ({
      id: String(r[0]),
      name: String(r[1] || ''),
      role: String(r[2] || ''),
      salary: Number(r[3]) || 0,
      pct: clampPct(Number(r[4])),
      notes: String(r[5] || ''),
    }));
}

function readHistory() {
  const sh = sheetByName(HISTORY_TAB);
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  return values.slice(1)
    .filter(r => String(r[1] || '').trim() !== '')
    .map(r => ({
      timestamp: r[0] instanceof Date ? r[0].toISOString() : String(r[0] || ''),
      name: String(r[1] || ''),
      from: String(r[2] || ''),
      to: String(r[3] || ''),
      reasonType: String(r[4] || ''),
      reason: String(r[5] || ''),
      date: r[6] instanceof Date
        ? Utilities.formatDate(r[6], Session.getScriptTimeZone(), 'yyyy-MM-dd')
        : String(r[6] || ''),
    }));
}

function findRow(sheet, empId) {
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]) === String(empId)) return i + 1; // 1-indexed
  }
  return -1;
}

// ---------- actions ----------

function addEmployee(body) {
  const house = body.house;
  assertHouse(house);
  const emp = validateEmployee(body.employee || {});
  emp.id = newId();
  sheetByName(house).appendRow([emp.id, emp.name, emp.role, emp.salary, emp.pct, emp.notes]);
  return { ok: true, employee: emp };
}

function updateEmployee(body) {
  const house = body.house;
  assertHouse(house);
  const id = String(body.id || '');
  if (!id) throw httpError(400, 'missing id');
  const emp = validateEmployee(body.employee || {});
  const sh = sheetByName(house);
  const row = findRow(sh, id);
  if (row < 0) throw httpError(404, 'employee not found');
  sh.getRange(row, 1, 1, HEADERS_HOUSE.length)
    .setValues([[id, emp.name, emp.role, emp.salary, emp.pct, emp.notes]]);
  return { ok: true, employee: { ...emp, id } };
}

function deleteEmployee(body) {
  const house = body.house;
  assertHouse(house);
  const id = String(body.id || '');
  if (!id) throw httpError(400, 'missing id');
  const sh = sheetByName(house);
  const row = findRow(sh, id);
  if (row < 0) throw httpError(404, 'employee not found');
  sh.deleteRow(row);
  return { ok: true };
}

function moveEmployee(body) {
  const from = body.fromHouse;
  const to = body.toHouse;
  assertHouse(from);
  assertHouse(to);
  if (from === to) throw httpError(400, 'cannot move to same house');
  const id = String(body.id || '');
  if (!id) throw httpError(400, 'missing id');

  const reasonType = String(body.reasonType || '');
  if (REASON_TYPES.indexOf(reasonType) < 0) throw httpError(400, 'bad reasonType');
  const reason = String(body.reason || '').trim().slice(0, 500);
  const date = validateDate(body.date);

  // Use the script lock to make the move atomic across sheets.
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const fromSh = sheetByName(from);
    const row = findRow(fromSh, id);
    if (row < 0) throw httpError(404, 'employee not found in source house');

    const range = fromSh.getRange(row, 1, 1, HEADERS_HOUSE.length).getValues()[0];
    const emp = {
      id: String(range[0]),
      name: String(range[1] || ''),
      role: String(range[2] || ''),
      salary: Number(range[3]) || 0,
      pct: clampPct(Number(range[4])),
      notes: String(range[5] || ''),
    };

    const toSh = sheetByName(to);
    toSh.appendRow([emp.id, emp.name, emp.role, emp.salary, emp.pct, emp.notes]);
    fromSh.deleteRow(row);

    const historySh = sheetByName(HISTORY_TAB);
    const tsIso = new Date().toISOString();
    historySh.appendRow([tsIso, emp.name, from, to, reasonType, reason, date]);

    return {
      ok: true,
      moved: { id: emp.id, name: emp.name, from, to },
      history: { timestamp: tsIso, name: emp.name, from, to, reasonType, reason, date },
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

function validateEmployee(emp) {
  const name = String(emp.name || '').trim().slice(0, 80);
  if (!name) throw httpError(400, 'name required');
  const role = String(emp.role || '').trim().slice(0, 80);
  const salary = Math.max(0, Math.round(Number(emp.salary) || 0));
  const pct = clampPct(Number(emp.pct));
  const notes = String(emp.notes || '').trim().slice(0, 500);
  return { name, role, salary, pct, notes };
}

function validateDate(d) {
  const s = String(d || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    // accept empty → today
    if (!s) return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
    throw httpError(400, 'bad date');
  }
  return s;
}

function newId() {
  return 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ---------- one-time setup helper ----------
// Run this once from the Apps Script editor (Run → setupSheets) AFTER
// setting SHEET_ID in Script Properties. It will create any missing
// tabs and write header rows. Safe to re-run — it never deletes data.

function setupSheets() {
  const book = ss();
  const wanted = HOUSE_IDS.map(h => ({ name: h, headers: HEADERS_HOUSE }))
    .concat([{ name: HISTORY_TAB, headers: HEADERS_HISTORY }]);

  wanted.forEach(w => {
    let sh = book.getSheetByName(w.name);
    if (!sh) sh = book.insertSheet(w.name);
    const firstRow = sh.getRange(1, 1, 1, w.headers.length).getValues()[0];
    const empty = firstRow.every(c => String(c || '').trim() === '');
    if (empty) {
      sh.getRange(1, 1, 1, w.headers.length).setValues([w.headers]);
      sh.setFrozenRows(1);
    }
  });

  // Optional: drop the default "Sheet1" if it's still there and empty.
  const def = book.getSheetByName('Sheet1') || book.getSheetByName('גיליון1');
  if (def && def.getLastRow() === 0 && book.getSheets().length > 1) {
    book.deleteSheet(def);
  }
  return 'ok';
}
