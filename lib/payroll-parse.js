'use strict';

// ---------------------------------------------------------------------------
// Payroll cost-report parser — "תמחיר חודשי כל העובדים", company 026.
//
// The bureau prints the monthly report to PDF through "Microsoft Print to
// PDF" (A4, 595 x 842 pt, right-to-left Hebrew). The browser runs pdfjs-dist
// over it and hands THIS module a normalised token stream; every parsing
// decision lives here so it can be unit-tested in Node without pdfjs.
//
// Input shape (see toItems() in the frontend):
//   pages: [ [ { str, x, y }, ... ], ... ]      // one array of items per page
//   x, y are PDF user-space points, y measured from the BOTTOM of the page
//   (pdfjs `transform[5]`), so a larger y is higher up the page.
//
// This module is shared verbatim between Node (tests) and the browser
// (served by the Express app at /lib/payroll-parse.js). It must therefore
// stay dependency-free and ES5-compatible in its public surface.
// ---------------------------------------------------------------------------

// Column x-coordinate bands on the 595pt-wide page, measured off the real
// August 2026 file. The page is RTL: the employee number and name sit on the
// RIGHT (largest x) and the total cost on the LEFT (smallest x).
//
// A band is [minX, maxX] inclusive-exclusive on the upper edge; a token is
// assigned to the band its x falls into. NAME_MIN_X is the left edge of the
// number/name zone — everything at or beyond it is name/number text, never a
// money column.
const COLUMN_BANDS = [
  { key: 'total',        min: 30,  max: 75 },   // סה"כ עלות
  { key: 'masSachar',    min: 80,  max: 115 },  // מס שכר
  { key: 'masMaasikim',  min: 118, max: 165 },  // מס מעסיקים או עלות הפחתה
  { key: 'bituach',      min: 180, max: 215 },  // ביטוח לאומי מעסיק
  { key: 'shonot',       min: 225, max: 255 },  // שונות
  { key: 'pitzuim',      min: 262, max: 295 },  // פיצויים
  { key: 'keren',        min: 300, max: 340 },  // קרן השתלמות
  { key: 'tagmulim',     min: 350, max: 375 },  // תגמולי מעסיק
  { key: 'tashlumim',    min: 395, max: 435 },  // תשלומים
];
const NAME_MIN_X = 440;

// The money columns, in the order they are summed for the row-arithmetic
// check. Kept separate from COLUMN_BANDS so callers never depend on the
// physical layout to know which fields are amounts.
const AMOUNT_KEYS = [
  'tashlumim', 'tagmulim', 'keren', 'pitzuim',
  'shonot', 'bituach', 'masMaasikim', 'masSachar', 'total',
];

// Two items belong to the same printed line when their y differs by less
// than this. The report prints at ~13pt leading; 3pt absorbs the sub-pixel
// jitter "Microsoft Print to PDF" introduces without ever merging two rows.
const LINE_EPSILON = 3;

// Money is compared to the cent. Floating point noise never reaches this.
const CENT = 0.005;

const HEBREW_RE = /[֐-׿]/;

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

// "Microsoft Print to PDF" writes RTL runs in VISUAL order, so pdfjs hands
// back each Hebrew token with its letters reversed: רובין arrives as ןיבור.
// Digits inside a token keep their logical left-to-right order, so a token is
// only ever reversed as a whole AFTER any glued number has been split off.
function reverseChars(s) {
  return String(s).split('').reverse().join('');
}

function hasHebrew(s) {
  return HEBREW_RE.test(String(s));
}

// Whether this document's Hebrew arrives reversed. Decided once per document
// from the department-header keyword, which is present on every page: a
// visual-order producer writes מחלקה as הקלחמ. Some producers (and every
// fixture written in logical order) do not reverse — supporting both means a
// future change of printer driver cannot silently corrupt every name.
function detectReversed(pages) {
  let logical = 0;
  let visual = 0;
  forEachItem(pages, function (it) {
    const s = String(it.str || '');
    if (s.indexOf('מחלקה') >= 0 || s.indexOf('תשלומים') >= 0) logical++;
    if (s.indexOf('הקלחמ') >= 0 || s.indexOf('םימולשת') >= 0) visual++;
  });
  return visual > logical;
}

function forEachItem(pages, fn) {
  for (let p = 0; p < pages.length; p++) {
    const items = pages[p] || [];
    for (let i = 0; i < items.length; i++) fn(items[i], p);
  }
}

// Restore a token to logical order. Pure-digit tokens are never touched —
// a bidi producer leaves numeric runs alone.
function deReverse(token, reversed) {
  if (!reversed) return token;
  if (!hasHebrew(token)) return token;
  return reverseChars(token);
}

// "8,087.18" -> 8087.18 ; "" / " " / undefined -> 0.
// Returns null when the token is not a money literal at all.
function parseAmount(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return 0;
  if (!/^-?[\d,]+(\.\d+)?$/.test(s)) return null;
  const v = Number(s.replace(/,/g, ''));
  if (!Number.isFinite(v)) return null;
  return Math.round(v * 100) / 100;
}

// A Latin-script employee name is printed as an LTR run inside an RTL line,
// which pushes it hard against the תשלומים amount and makes pdfjs emit the
// two as ONE token: "16,315.00MAKAROV SERGEI". Split them back apart.
const LATIN_GLUE_RE = /^([\d,]+\.\d{2})([A-Za-z ]+)$/;

function splitLatinGlue(token) {
  const m = LATIN_GLUE_RE.exec(String(token).trim());
  if (!m) return null;
  return { amount: parseAmount(m[1]), latinName: m[2].trim() };
}

// The 4-digit, zero-padded employee number is printed glued to the end of the
// surname token: "ןיבור0033". Strip it off. Also accepts the number as its
// own token, and as a leading group, so a cleaner producer still parses.
function splitEmpNumber(token) {
  const s = String(token).trim();
  if (/^\d{1,4}$/.test(s)) return { empNumber: s, rest: '' };
  let m = /^(.*?)(\d{4})$/.exec(s);
  if (m && m[1]) return { empNumber: m[2], rest: m[1] };
  m = /^(\d{4})(.+)$/.exec(s);
  if (m) return { empNumber: m[1], rest: m[2] };
  return { empNumber: '', rest: s };
}

// Canonical employee-number form used for matching and storage: digits with
// leading zeros stripped, so the printed "0033" and the number 33 Moran types
// into the staffing roster are the same key.
function normalizeEmpNumber(raw) {
  const digits = String(raw == null ? '' : raw).replace(/\D/g, '');
  if (!digits) return '';
  return String(Number(digits));
}

// ---------------------------------------------------------------------------
// Line assembly
// ---------------------------------------------------------------------------

// Group a page's items into printed lines by y, top of page first, and sort
// each line right-to-left so token order matches Hebrew reading order.
function toLines(items) {
  const sorted = (items || []).slice().sort(function (a, b) { return b.y - a.y; });
  const lines = [];
  let current = null;
  for (let i = 0; i < sorted.length; i++) {
    const it = sorted[i];
    if (!current || Math.abs(current.y - it.y) > LINE_EPSILON) {
      current = { y: it.y, items: [] };
      lines.push(current);
    }
    current.items.push(it);
  }
  lines.forEach(function (ln) {
    ln.items.sort(function (a, b) { return b.x - a.x; });
  });
  return lines;
}

function bandOf(x) {
  for (let i = 0; i < COLUMN_BANDS.length; i++) {
    const b = COLUMN_BANDS[i];
    if (x >= b.min && x < b.max) return b.key;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Line classification
// ---------------------------------------------------------------------------

const DEPT_HEADER_RE = /מחלקה\s*:?\s*(\d{3})\s*[-–]\s*(.+)$/;

function classify(lineText) {
  if (DEPT_HEADER_RE.test(lineText)) return 'deptHeader';
  if (lineText.indexOf('סך למחל') >= 0) return 'subtotal';
  if (lineText.indexOf('לחברה') >= 0) return 'companyTotal';
  if (lineText.indexOf('שם העובד') >= 0 || lineText.indexOf('תגמולי') >= 0) return 'columnHeader';
  if (lineText.indexOf('תמחיר חודשי') >= 0) return 'title';
  return 'data';
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

function ParseError(message, detail) {
  const err = new Error(message);
  err.name = 'PayrollParseError';
  err.detail = detail || {};
  return err;
}

// Parse a whole document. Returns
//   { rows, printedTotal, printedHeadcount, deptSubtotals, reversed }
// and never throws on a merely odd line — unparseable lines are skipped and
// the reconciliation gate below is what refuses a bad import.
function parseTamhir(pages) {
  if (!Array.isArray(pages)) throw ParseError('pages must be an array');
  const reversed = detectReversed(pages);

  const rows = [];
  const deptSubtotals = [];
  let printedTotal = null;
  let printedHeadcount = null;
  let dept = null;
  let deptName = null;

  for (let p = 0; p < pages.length; p++) {
    const lines = toLines(pages[p]);
    for (let l = 0; l < lines.length; l++) {
      const line = lines[l];

      // Tokens in reading order, restored to logical character order. The
      // employee number is split off BEFORE de-reversing, because it is glued
      // to a token whose Hebrew is reversed but whose digits are not.
      const tokens = [];
      for (let i = 0; i < line.items.length; i++) {
        const it = line.items[i];
        const raw = String(it.str == null ? '' : it.str).trim();
        if (!raw) continue;
        tokens.push({ raw: raw, x: it.x, band: it.x >= NAME_MIN_X ? 'name' : bandOf(it.x) });
      }
      if (!tokens.length) continue;

      const lineText = tokens
        .map(function (t) { return deReverse(t.raw, reversed); })
        .join(' ');
      const kind = classify(lineText);

      if (kind === 'deptHeader') {
        const m = DEPT_HEADER_RE.exec(lineText);
        dept = m[1];
        deptName = m[2].trim();
        continue;
      }
      if (kind === 'columnHeader' || kind === 'title') continue;

      if (kind === 'subtotal') {
        deptSubtotals.push({ dept: dept, deptName: deptName, total: amountIn(tokens, 'total') });
        continue;
      }
      if (kind === 'companyTotal') {
        printedTotal = amountIn(tokens, 'total');
        printedHeadcount = headcountIn(tokens);
        continue;
      }

      const row = parseDataRow(tokens, dept, deptName, reversed);
      if (row) rows.push(row);
    }
  }

  return {
    rows: rows,
    printedTotal: printedTotal,
    printedHeadcount: printedHeadcount,
    deptSubtotals: deptSubtotals,
    reversed: reversed,
  };
}

function amountIn(tokens, key) {
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].band !== key) continue;
    const v = parseAmount(tokens[i].raw);
    if (v !== null) return v;
  }
  return null;
}

// The printed headcount sits in the number column of the company-total line.
function headcountIn(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].band !== 'name') continue;
    const s = tokens[i].raw.replace(/,/g, '');
    if (/^\d{1,5}$/.test(s)) return Number(s);
  }
  return null;
}

// A data row is identified by the presence of an employee number in the name
// zone plus at least one money column. A row may legitimately carry NO
// תשלומים value — employer contributions only — so that column must never be
// part of the test.
function parseDataRow(tokens, dept, deptName, reversed) {
  const amounts = {};
  for (let i = 0; i < AMOUNT_KEYS.length; i++) amounts[AMOUNT_KEYS[i]] = 0;

  let sawAmount = false;
  let empNumber = '';
  let latinName = '';
  const nameParts = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];

    if (t.band === 'name') {
      const split = splitEmpNumber(t.raw);
      if (split.empNumber && !empNumber) empNumber = split.empNumber;
      const rest = split.rest.trim();
      if (rest) nameParts.push(deReverse(rest, reversed));
      continue;
    }
    if (!t.band) continue;

    const glued = splitLatinGlue(t.raw);
    if (glued) {
      amounts[t.band] = glued.amount;
      latinName = glued.latinName;
      sawAmount = true;
      continue;
    }
    const v = parseAmount(t.raw);
    if (v === null) continue;
    amounts[t.band] = v;
    sawAmount = true;
  }

  if (!empNumber || !sawAmount) return null;

  let rawName = nameParts.join(' ').replace(/\s+/g, ' ').trim();
  if (latinName) rawName = rawName ? rawName + ' ' + latinName : latinName;
  if (!rawName) return null;

  return {
    empNumber: normalizeEmpNumber(empNumber),
    rawName: rawName,
    dept: dept,
    deptName: deptName,
    tashlumim: amounts.tashlumim,
    tagmulim: amounts.tagmulim,
    keren: amounts.keren,
    pitzuim: amounts.pitzuim,
    shonot: amounts.shonot,
    bituach: amounts.bituach,
    masMaasikim: amounts.masMaasikim,
    masSachar: amounts.masSachar,
    total: amounts.total,
  };
}

// ---------------------------------------------------------------------------
// Reconciliation gate
// ---------------------------------------------------------------------------

// The import is refused unless the parsed rows reproduce the two figures the
// bureau printed on the report itself: the company total and the headcount.
// A parser that silently drops or duplicates a line would otherwise feed a
// wrong pension picture into a payment decision — so this is fail-closed and
// the error names the exact delta.
function reconcile(parsed) {
  const rows = (parsed && parsed.rows) || [];
  const parsedTotal = Math.round(rows.reduce(function (a, r) { return a + (r.total || 0); }, 0) * 100) / 100;
  const parsedCount = rows.length;
  const printedTotal = parsed ? parsed.printedTotal : null;
  const printedHeadcount = parsed ? parsed.printedHeadcount : null;
  const problems = [];

  if (printedTotal === null || printedTotal === undefined) {
    problems.push({ code: 'missingPrintedTotal', messageHe: 'לא נמצאה שורת סה"כ לחברה בקובץ' });
  } else if (Math.abs(parsedTotal - printedTotal) > CENT) {
    const delta = Math.round((parsedTotal - printedTotal) * 100) / 100;
    problems.push({
      code: 'totalMismatch',
      expected: printedTotal,
      actual: parsedTotal,
      delta: delta,
      messageHe: 'סכום השורות שנקראו אינו תואם את סה"כ החברה המודפס. הפרש ' + delta.toFixed(2) + ' שקלים',
    });
  }

  if (printedHeadcount === null || printedHeadcount === undefined) {
    problems.push({ code: 'missingPrintedHeadcount', messageHe: 'לא נמצא מספר העובדים המודפס בקובץ' });
  } else if (parsedCount !== printedHeadcount) {
    const delta = parsedCount - printedHeadcount;
    problems.push({
      code: 'countMismatch',
      expected: printedHeadcount,
      actual: parsedCount,
      delta: delta,
      messageHe: 'מספר השורות שנקראו אינו תואם את מספר העובדים המודפס. הפרש ' + delta + ' שורות',
    });
  }

  return {
    ok: problems.length === 0,
    parsedTotal: parsedTotal,
    parsedCount: parsedCount,
    printedTotal: printedTotal === undefined ? null : printedTotal,
    printedHeadcount: printedHeadcount === undefined ? null : printedHeadcount,
    problems: problems,
  };
}

// Convenience wrapper: parse and gate in one call. Throws a PayrollParseError
// carrying every problem when the gate refuses the file.
function parseAndReconcile(pages) {
  const parsed = parseTamhir(pages);
  const gate = reconcile(parsed);
  if (!gate.ok) {
    throw ParseError(gate.problems.map(function (p) { return p.messageHe; }).join(' · '), gate);
  }
  return { parsed: parsed, gate: gate };
}

const payrollParseApi = {
  COLUMN_BANDS: COLUMN_BANDS,
  NAME_MIN_X: NAME_MIN_X,
  AMOUNT_KEYS: AMOUNT_KEYS,
  LINE_EPSILON: LINE_EPSILON,
  parseTamhir: parseTamhir,
  reconcile: reconcile,
  parseAndReconcile: parseAndReconcile,
  // exported for testing / reuse
  toLines: toLines,
  bandOf: bandOf,
  classify: classify,
  parseAmount: parseAmount,
  splitLatinGlue: splitLatinGlue,
  splitEmpNumber: splitEmpNumber,
  normalizeEmpNumber: normalizeEmpNumber,
  detectReversed: detectReversed,
  deReverse: deReverse,
};

if (typeof module !== 'undefined' && module.exports) module.exports = payrollParseApi;
if (typeof window !== 'undefined') window.PayrollParse = payrollParseApi;
