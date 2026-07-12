'use strict';

// Pure matching logic for the monthly-actuals Excel import. Takes already-
// parsed spreadsheet rows (see lib/xlsx_read.js) plus the current workers /
// assignments / houses, and resolves each timesheet row to an hourly /
// per_session assignment, computing the cost (rate × actual). Everything
// here is side-effect-free and unit-tested; the CLI
// (scripts/import_monthly_actuals.js) does the I/O (auth, fetch, POST).

// Header synonyms. Matching is tolerant: a header cell matches a category
// if, once normalized, it CONTAINS any of the category's normalized keys.
const HOURS_KEYS = ['שעות', 'hours', 'hour'];
const SESSION_KEYS = ['טיפול', 'מפגש', 'session'];
const HOUSE_KEYS = ['בית', 'house', 'סניף', 'מסגרת'];
const NAME_KEYS = ['שם', 'name', 'עובד', 'worker', 'employee'];

// Only these employment types are paid by monthly actuals.
const VARIABLE_TYPES = ['hourly', 'per_session'];

function normalizeHeader(s) {
  return String(s == null ? '' : s)
    .trim().toLowerCase()
    .replace(/["'׳״.\-_/\\:()]/g, '')
    .replace(/\s+/g, '');
}

// Names / house values: trim, lowercase, collapse internal whitespace.
function normalizeName(s) {
  return String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');
}

function headerMatches(cell, keys) {
  const h = normalizeHeader(cell);
  if (!h) return false;
  return keys.some(k => h.includes(normalizeHeader(k)));
}

// Detect column indices from a header row. Returns { name, house, hours,
// sessions } (each -1 if absent). Hours / sessions / house are checked
// before name because the name keys ('עובד') are the broadest.
function detectColumns(headerRow) {
  const cols = { name: -1, house: -1, hours: -1, sessions: -1 };
  (headerRow || []).forEach((cell, i) => {
    if (cols.hours < 0 && headerMatches(cell, HOURS_KEYS)) { cols.hours = i; return; }
    if (cols.sessions < 0 && headerMatches(cell, SESSION_KEYS)) { cols.sessions = i; return; }
    if (cols.house < 0 && headerMatches(cell, HOUSE_KEYS)) { cols.house = i; return; }
    if (cols.name < 0 && headerMatches(cell, NAME_KEYS)) { cols.name = i; return; }
  });
  return cols;
}

// The header is the first row (within the first 15) that has a name column
// and at least one quantity column. Tolerates title / blank rows above it.
function findHeaderRow(rows) {
  const limit = Math.min((rows || []).length, 15);
  for (let i = 0; i < limit; i++) {
    const c = detectColumns(rows[i]);
    if (c.name >= 0 && (c.hours >= 0 || c.sessions >= 0)) return i;
  }
  return -1;
}

// Resolve an Excel house cell to a house id. Accepts the id itself, the
// exact display name, or a distinctive token of the name (e.g. "עפרוני"
// for "קיסריה עפרוני"). Returns '' when unresolved.
function resolveHouse(value, houses) {
  const v = normalizeName(value);
  if (!v) return '';
  const list = houses || [];
  const exact = list.find(h => normalizeName(h.id) === v || normalizeName(h.name) === v);
  if (exact) return exact.id;
  const partial = list.find(h => {
    const n = normalizeName(h.name);
    return n.includes(v) || v.includes(normalizeName(h.id));
  });
  return partial ? partial.id : '';
}

function houseNameOf(houseId, houses) {
  const h = (houses || []).find(x => x.id === houseId);
  return h ? h.name : houseId;
}

// Parse a numeric cell. Returns { value } for a valid non-negative number,
// { empty:true } for a blank cell, { invalid:true } for garbage / negative.
function parseQuantity(raw) {
  const s = String(raw == null ? '' : raw).trim().replace(/,/g, '');
  if (s === '') return { empty: true };
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return { invalid: true };
  return { value: n };
}

function rateOf(assignment) {
  if (assignment.employmentType === 'hourly') return Number(assignment.hourlyRate) || 0;
  if (assignment.employmentType === 'per_session') return Number(assignment.sessionRate) || 0;
  return 0;
}

// Core: match every data row to an assignment.
// Returns { columns, matched, unmatched, ambiguous }.
//   matched:   { rowNumber, name, houseId, house, assignmentId, workerId,
//                type, quantity, rate, cost }
//   unmatched: { rowNumber, name, house, reason }
//   ambiguous: { rowNumber, name, house, reason, candidates:[assignmentId] }
function matchActuals(opts) {
  const rows = (opts && opts.rows) || [];
  const workers = (opts && opts.workers) || [];
  const assignments = (opts && opts.assignments) || [];
  const houses = (opts && opts.houses) || [];

  const headerIdx = findHeaderRow(rows);
  if (headerIdx < 0) {
    return { error: 'no header row detected (need a name column and a hours/sessions column)',
      columns: null, matched: [], unmatched: [], ambiguous: [] };
  }
  const columns = detectColumns(rows[headerIdx]);

  // name (normalized) → [workers with that name]
  const workersByName = Object.create(null);
  workers.forEach(w => {
    const key = normalizeName(w.name);
    (workersByName[key] || (workersByName[key] = [])).push(w);
  });

  const matched = [];
  const unmatched = [];
  const ambiguous = [];
  const seenAssignment = Object.create(null); // assignmentId → rowNumber (dup guard)

  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const rowNumber = r + 1; // 1-based, matches spreadsheet row numbering
    const name = String(row[columns.name] == null ? '' : row[columns.name]).trim();
    if (!name) continue; // blank row

    const houseCell = columns.house >= 0 ? String(row[columns.house] || '').trim() : '';
    const houseId = houseCell ? resolveHouse(houseCell, houses) : '';
    const base = { rowNumber, name, house: houseCell };

    const nameMatches = workersByName[normalizeName(name)] || [];
    if (nameMatches.length === 0) {
      unmatched.push(Object.assign({ reason: 'שם לא נמצא במערכת (worker name not found)' }, base));
      continue;
    }

    // Candidate hourly / per_session assignments for the matched worker(s).
    let cands = assignments.filter(a =>
      nameMatches.some(w => w.id === a.workerId) &&
      VARIABLE_TYPES.indexOf(a.employmentType) >= 0);
    // Disambiguate by house when the file names one and it resolves.
    if (houseId) cands = cands.filter(a => a.house === houseId);

    if (cands.length === 0) {
      const why = houseCell
        ? (houseId
            ? 'אין שיבוץ שעתי/מפגש לעובד/ת בבית הנבחר'
            : 'עמודת הבית לא זוהתה (' + houseCell + ')')
        : 'אין שיבוץ שעתי/מפגש לעובד/ת';
      unmatched.push(Object.assign({ reason: why }, base));
      continue;
    }
    if (cands.length > 1) {
      ambiguous.push(Object.assign({
        reason: 'כמה שיבוצים שעתיים/מפגש — יש לציין בית להבחנה',
        candidates: cands.map(a => a.id),
      }, base));
      continue;
    }

    const a = cands[0];
    const type = a.employmentType;
    const qCol = type === 'hourly' ? columns.hours : columns.sessions;
    const q = parseQuantity(qCol >= 0 ? row[qCol] : '');
    if (q.empty) {
      unmatched.push(Object.assign({
        reason: type === 'hourly' ? 'אין ערך שעות בשורה' : 'אין ערך טיפולים בשורה',
      }, base));
      continue;
    }
    if (q.invalid) {
      unmatched.push(Object.assign({
        reason: (type === 'hourly' ? 'ערך שעות' : 'ערך טיפולים') + ' לא תקין',
      }, base));
      continue;
    }

    if (seenAssignment[a.id] !== undefined) {
      ambiguous.push(Object.assign({
        reason: 'שורה כפולה לאותו שיבוץ (כבר הותאם בשורה ' + seenAssignment[a.id] + ')',
        candidates: [a.id],
      }, base));
      continue;
    }
    seenAssignment[a.id] = rowNumber;

    const rate = rateOf(a);
    matched.push({
      rowNumber, name,
      houseId: a.house, house: houseNameOf(a.house, houses),
      assignmentId: a.id, workerId: a.workerId,
      type, quantity: q.value, rate,
      cost: Math.round(rate * q.value),
    });
  }

  return { columns, matched, unmatched, ambiguous };
}

// Convert matched rows into upsertMonthlyActuals items for a given month.
function buildUpsertItems(matched, month) {
  return (matched || []).map(m => {
    const item = { assignmentId: m.assignmentId, month: month };
    if (m.type === 'hourly') item.actualHours = m.quantity;
    else item.actualSessions = m.quantity;
    return item;
  });
}

module.exports = {
  detectColumns,
  findHeaderRow,
  resolveHouse,
  parseQuantity,
  matchActuals,
  buildUpsertItems,
  normalizeName,
  normalizeHeader,
};
