'use strict';

// ---------------------------------------------------------------------------
// בקרת שכר — payroll compliance rules.
//
// Every reconciliation and compliance decision the payroll-control tab makes
// lives in THIS file, as pure functions over plain data. Code.gs stores rows;
// the frontend renders them; neither decides anything. That split is what
// makes the rules testable and is enforced by tests/payroll-guards.test.js.
//
// Phase 1 covers SALARIED employees only — the תלוש side of the bureau's
// monthly "תמחיר חודשי כל העובדים" report. Freelancer invoices are phase 2
// and are deliberately not modelled here.
//
// Shared verbatim between Node (tests, and the Express proxy's validation)
// and the browser, which loads it from /lib/payroll-rules.js.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// House mapping — THE single source of truth
// ---------------------------------------------------------------------------
//
// The payroll bureau's department numbers, mapped to the staffing app's house
// ids. This object is the ONLY place in the payroll subsystem where a house
// id string may appear; tests/payroll-guards.test.js fails the build if one
// shows up anywhere else, so a mapping can never drift into a rule, an
// endpoint or the UI.
//
// `house: null` means the department is KNOWN but its house is NOT YET
// CONFIRMED with Moran. A null never silently becomes a house — it raises R16
// so the run cannot be locked until the mapping is settled.
//
//   002 קיסריה — the staffing app has TWO Caesarea houses, עפרוני and ריהאב,
//                and the bureau prints a single קיסריה department. Which
//                house a קיסריה line belongs to cannot be derived from the
//                report. TO BE CONFIRMED.
//   006 הולינה — no corresponding house exists in the staffing app at all.
//                TO BE CONFIRMED.
//
// שדה אליעזר has no payroll department of its own. A worker placed there
// therefore never appears in the file, which R03 reports as a missing line —
// that is intended, not a mapping gap.
const DEPT_TO_HOUSE = {
  '001': { deptName: 'רעננה פרדס', house: 'pardes' },
  '002': { deptName: 'קיסריה', house: null },
  '003': { deptName: 'רמות השבים', house: 'ramot' },
  '004': { deptName: 'מטה', house: 'hq' },
  '005': { deptName: 'רעננה אשר', house: 'asher' },
  '006': { deptName: 'הולינה', house: null },
};

function houseForDept(dept) {
  const entry = DEPT_TO_HOUSE[String(dept || '').trim()];
  return entry ? entry.house : null;
}

function deptIsKnown(dept) {
  return Object.prototype.hasOwnProperty.call(DEPT_TO_HOUSE, String(dept || '').trim());
}

// ---------------------------------------------------------------------------
// Thresholds — named, never inlined into a message or a comparison
// ---------------------------------------------------------------------------
const TAGMULIM_MAX_PCT = 7.5;      // R09 — תגמולי מעסיק ceiling
const PITZUIM_MAX_PCT = 9;         // R10 — פיצויים ceiling
const PITZUIM_TAGMULIM_RATIOS = [6 / 6.5, 8.33 / 6.5];  // R11 — the two legal splits
const RATIO_TOLERANCE_PCT = 1;     // R11 — relative tolerance on those ratios
const BITUACH_MIN_PCT = 3;         // R12 — ביטוח לאומי מעסיק floor
const BITUACH_MAX_PCT = 7.9;       // R13 — ביטוח לאומי מעסיק ceiling
const BITUACH_MIN_TASHLUMIM = 1000;// R12 — only meaningful above this salary
const LOW_TASHLUMIM = 1000;        // R14 — verify entitlement below this
const PENSION_MIN_TASHLUMIM = 1500;// R07 — pension obligation kicks in above this
const PENSION_TENURE_MONTHS = 6;   // R07 — and after this much tenure
const MONTH_DELTA_PCT = 15;        // R15 — month-over-month cost swing
const ARITHMETIC_TOLERANCE = 0.01; // R17 — components vs stated total, in ₪

const SEVERITY = { CRITICAL: 'critical', WARNING: 'warning' };

// Rule catalogue. Ids are STABLE — they are written into PayrollFindings rows
// and referenced by the operating procedure in docs/payroll-control.md.
// Hebrew messages carry NO PARENTHESES anywhere, enforced by a guard test.
const RULES = {
  R01: { id: 'R01', severity: SEVERITY.CRITICAL, titleHe: 'עובד לא מזוהה במערכת הסטאפינג' },
  R02: { id: 'R02', severity: SEVERITY.CRITICAL, titleHe: 'תשלום לעובד שסיים העסקה' },
  R03: { id: 'R03', severity: SEVERITY.CRITICAL, titleHe: 'עובד פעיל ללא שורה בקובץ' },
  R04: { id: 'R04', severity: SEVERITY.CRITICAL, titleHe: 'מספר עובד כפול בקובץ' },
  R05: { id: 'R05', severity: SEVERITY.WARNING, titleHe: 'מחלקה בשכר שונה מהבית בשיבוץ' },
  R06: { id: 'R06', severity: SEVERITY.CRITICAL, titleHe: 'עלות מעסיק ללא תשלומים' },
  R07: { id: 'R07', severity: SEVERITY.CRITICAL, titleHe: 'אין הפרשות פנסיה לעובד ותיק' },
  R08: { id: 'R08', severity: SEVERITY.WARNING, titleHe: 'חסר תאריך תחילת עבודה' },
  R09: { id: 'R09', severity: SEVERITY.WARNING, titleHe: 'תגמולי מעסיק מעל התקרה' },
  R10: { id: 'R10', severity: SEVERITY.WARNING, titleHe: 'פיצויים מעל התקרה' },
  R11: { id: 'R11', severity: SEVERITY.WARNING, titleHe: 'יחס פיצויים לתגמולים אינו תקני' },
  R12: { id: 'R12', severity: SEVERITY.WARNING, titleHe: 'ביטוח לאומי מעסיק נמוך מהצפוי' },
  R13: { id: 'R13', severity: SEVERITY.WARNING, titleHe: 'ביטוח לאומי מעסיק גבוה מהצפוי' },
  R14: { id: 'R14', severity: SEVERITY.WARNING, titleHe: 'תשלומים נמוכים - יש לוודא זכאות' },
  R15: { id: 'R15', severity: SEVERITY.WARNING, titleHe: 'שינוי חד בעלות מול החודש הקודם' },
  R16: { id: 'R16', severity: SEVERITY.WARNING, titleHe: 'מחלקה ללא שיוך לבית' },
  R17: { id: 'R17', severity: SEVERITY.CRITICAL, titleHe: 'סכום הרכיבים אינו מסתדר עם הסה"כ' },
};
const RULE_IDS = Object.keys(RULES).sort();

// ---------------------------------------------------------------------------
// Small numeric / date helpers
// ---------------------------------------------------------------------------

function toNum(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

function round2(v) {
  return Math.round(toNum(v) * 100) / 100;
}

function pct(part, whole) {
  if (!whole) return null;
  return round2((toNum(part) / toNum(whole)) * 100);
}

function fmtAmount(v) {
  return round2(v).toFixed(2);
}

// 'YYYY-MM' -> the first day of that month, as a UTC date.
function monthStart(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month || '').trim());
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, 1);
}

function parseDate(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || '').trim());
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

// Whole months from a start date to the first of the payroll month.
// Returns null when either side is missing.
function tenureMonths(startDate, month) {
  const start = parseDate(startDate);
  const ref = monthStart(month);
  if (start === null || ref === null) return null;
  const s = new Date(start);
  const r = new Date(ref);
  let months = (r.getUTCFullYear() - s.getUTCFullYear()) * 12 + (r.getUTCMonth() - s.getUTCMonth());
  if (r.getUTCDate() < s.getUTCDate()) months -= 1;
  return months;
}

// ---------------------------------------------------------------------------
// Name / number matching
// ---------------------------------------------------------------------------

// Canonical employee number: digits only, leading zeros stripped. The bureau
// prints 0033; Moran types 33; both key the same worker.
function normalizePayrollNumber(raw) {
  const digits = String(raw == null ? '' : raw).replace(/\D/g, '');
  if (!digits) return '';
  return String(Number(digits));
}

// Normalised name for the SECOND matching pass: collapse runs of whitespace
// and drop Hebrew punctuation - geresh, gershayim and their ASCII lookalikes,
// plus hyphens. Deliberately conservative: this must never turn two different
// people into one.
function normalizeName(raw) {
  return String(raw == null ? '' : raw)
    .replace(/[׳״'"`‘’“”]/g, '')
    .replace(/[-־‐-―]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Match one payroll line to a staffing worker.
//
// Order is deliberate and never negotiable: employee number, then an EXACT
// full-name match, then a normalised match. Anything that hits more than one
// worker is 'ambiguous' and raises R01 — a payment decision is never made off
// a fuzzy guess.
function matchWorker(row, workers) {
  const empNumber = normalizePayrollNumber(row && row.empNumber);
  const list = workers || [];

  if (empNumber) {
    const byNumber = list.filter(function (w) {
      return normalizePayrollNumber(w.payrollEmpNumber) === empNumber;
    });
    if (byNumber.length === 1) return { workerId: byNumber[0].id, matchStatus: 'number' };
    if (byNumber.length > 1) return { workerId: '', matchStatus: 'ambiguous' };
  }

  const rawName = String((row && row.rawName) || '').trim();
  if (rawName) {
    const exact = list.filter(function (w) { return String(w.name || '').trim() === rawName; });
    if (exact.length === 1) return { workerId: exact[0].id, matchStatus: 'exact' };
    if (exact.length > 1) return { workerId: '', matchStatus: 'ambiguous' };

    const key = normalizeName(rawName);
    if (key) {
      const loose = list.filter(function (w) { return normalizeName(w.name) === key; });
      if (loose.length === 1) return { workerId: loose[0].id, matchStatus: 'normalized' };
      if (loose.length > 1) return { workerId: '', matchStatus: 'ambiguous' };
    }
  }

  return { workerId: '', matchStatus: 'unmatched' };
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

function finding(ruleId, lineId, expected, actual, messageHe) {
  const rule = RULES[ruleId];
  return {
    ruleId: ruleId,
    lineId: lineId || '',
    severity: rule.severity,
    titleHe: rule.titleHe,
    expected: expected === null || expected === undefined ? '' : String(expected),
    actual: actual === null || actual === undefined ? '' : String(actual),
    messageHe: messageHe,
  };
}

// ---------------------------------------------------------------------------
// Per-line rules
// ---------------------------------------------------------------------------

// R04 needs the whole file, R03 needs the whole roster, R15 needs last month;
// everything else is decided from one line plus its matched worker.
function evaluateLine(line, ctx) {
  const out = [];
  const id = line.lineId;
  const tash = toNum(line.tashlumim);
  const tag = toNum(line.tagmulim);
  const keren = toNum(line.keren);
  const pitz = toNum(line.pitzuim);
  const bit = toNum(line.bituach);
  const total = toNum(line.total);

  // --- R16: department mapping -------------------------------------------
  if (!deptIsKnown(line.dept)) {
    out.push(finding('R16', id,
      'מחלקה מוכרת בטבלת השיוך',
      'מחלקה ' + (line.dept || 'ללא מספר'),
      'מחלקה ' + (line.dept || 'ללא מספר') + ' אינה מופיעה בטבלת שיוך המחלקות לבתים'));
  } else if (line.mappedHouse === null) {
    out.push(finding('R16', id,
      'שיוך בית מאושר',
      'ממתין לאישור',
      'שיוך הבית של מחלקה ' + line.dept + ' ' + DEPT_TO_HOUSE[line.dept].deptName + ' טרם אושר'));
  }

  // --- R01 / R02 / R05 / R08: identity and placement ----------------------
  if (line.matchStatus === 'ambiguous') {
    out.push(finding('R01', id, 'התאמה יחידה לעובד', 'יותר מהתאמה אחת',
      'השם ' + line.rawName + ' מתאים ליותר מעובד אחד במערכת הסטאפינג'));
  } else if (!line.matchedWorkerId) {
    out.push(finding('R01', id, 'עובד קיים במערכת הסטאפינג', 'לא נמצא',
      'מספר עובד ' + line.empNumber + ' בשם ' + line.rawName + ' לא נמצא במערכת הסטאפינג'));
  }

  const worker = line.matchedWorkerId ? ctx.workerById[line.matchedWorkerId] : null;

  if (worker) {
    const terminated = ctx.terminationByWorker[worker.id];
    if (terminated && monthStart(ctx.month) !== null) {
      const end = parseDate(terminated);
      if (end !== null && end < monthStart(ctx.month)) {
        out.push(finding('R02', id, 'עובד פעיל בחודש השכר', 'סיום העסקה ' + terminated,
          'לעובד ' + line.rawName + ' שולם שכר אף שההעסקה הסתיימה בתאריך ' + terminated));
      }
    }

    const placement = ctx.placementByWorker[worker.id];
    if (placement && line.mappedHouse && placement.house !== line.mappedHouse) {
      out.push(finding('R05', id, 'בית בשיבוץ ' + placement.houseLabel, 'מחלקה בשכר ' + line.deptName,
        'העובד משובץ בבית ' + placement.houseLabel + ' אך שולם ממחלקה ' + line.deptName));
    }

    if (!String(worker.startDate || '').trim()) {
      out.push(finding('R08', id, 'תאריך תחילת עבודה מוזן', 'חסר',
        'לעובד ' + line.rawName + ' אין תאריך תחילת עבודה בסטאפינג ולכן לא ניתן לבדוק חובת פנסיה'));
    }
  }

  // --- R06: employer cost with no salary ---------------------------------
  if (tash === 0 && total !== 0) {
    out.push(finding('R06', id, 'תשלומים גדולים מאפס', fmtAmount(tash),
      'לשורה יש עלות מעסיק של ' + fmtAmount(total) + ' שקלים ללא תשלומי שכר כלל'));
  }

  // --- R07 / R08: the pension rule, the highest-value output of this tool -
  // "No employer pension at all" means neither תגמולי מעסיק nor פיצויים.
  // קרן השתלמות is a study fund, not pension, and never satisfies R07.
  const noPension = tag === 0 && pitz === 0;
  if (noPension && tash >= PENSION_MIN_TASHLUMIM) {
    const tenure = worker ? tenureMonths(worker.startDate, ctx.month) : null;
    if (tenure === null) {
      // Missing start date: R08 instead of R07, NEVER both, and never a
      // pension finding we cannot stand behind.
      if (worker && !out.some(function (f) { return f.ruleId === 'R08'; })) {
        out.push(finding('R08', id, 'תאריך תחילת עבודה מוזן', 'חסר',
          'לעובד ' + line.rawName + ' אין תאריך תחילת עבודה בסטאפינג ולכן לא ניתן לבדוק חובת פנסיה'));
      }
    } else if (tenure > PENSION_TENURE_MONTHS) {
      out.push(finding('R07', id,
        'הפרשות פנסיה לאחר ' + PENSION_TENURE_MONTHS + ' חודשי עבודה',
        'אין הפרשות כלל',
        'לעובד ' + line.rawName + ' ותק של ' + tenure + ' חודשים ותשלומים של ' + fmtAmount(tash) +
        ' שקלים ללא הפרשות פנסיה כלל'));
    }
  }

  // --- R09 / R10 / R11: the pension split ---------------------------------
  if (tash > 0) {
    const tagPct = pct(tag, tash);
    if (tagPct !== null && tagPct > TAGMULIM_MAX_PCT) {
      out.push(finding('R09', id, 'עד ' + TAGMULIM_MAX_PCT + ' אחוז', tagPct + ' אחוז',
        'תגמולי מעסיק הם ' + tagPct + ' אחוז מהתשלומים ועוברים את התקרה של ' + TAGMULIM_MAX_PCT + ' אחוז'));
    }
    const pitzPct = pct(pitz, tash);
    if (pitzPct !== null && pitzPct > PITZUIM_MAX_PCT) {
      out.push(finding('R10', id, 'עד ' + PITZUIM_MAX_PCT + ' אחוז', pitzPct + ' אחוז',
        'פיצויים הם ' + pitzPct + ' אחוז מהתשלומים ועוברים את התקרה של ' + PITZUIM_MAX_PCT + ' אחוז'));
    }
  }

  if (tag !== 0 || pitz !== 0) {
    const ratio = tag === 0 ? null : pitz / tag;
    const ok = ratio !== null && PITZUIM_TAGMULIM_RATIOS.some(function (r) {
      return Math.abs(ratio - r) <= r * (RATIO_TOLERANCE_PCT / 100);
    });
    if (!ok) {
      out.push(finding('R11', id, 'יחס 6 ל 6.5 או 8.33 ל 6.5',
        ratio === null ? 'תגמולים אפס' : round2(ratio * 100) / 100,
        'יחס הפיצויים לתגמולים אינו אחד משני היחסים התקניים'));
    }
  }

  // --- R12 / R13: employer national insurance -----------------------------
  if (tash > BITUACH_MIN_TASHLUMIM) {
    const bitPct = pct(bit, tash);
    if (bitPct !== null && bitPct < BITUACH_MIN_PCT) {
      out.push(finding('R12', id, 'לפחות ' + BITUACH_MIN_PCT + ' אחוז', bitPct + ' אחוז',
        'ביטוח לאומי מעסיק הוא ' + bitPct + ' אחוז מהתשלומים ונמוך מהמינימום של ' + BITUACH_MIN_PCT + ' אחוז'));
    }
  }
  if (tash > 0) {
    const bitPct = pct(bit, tash);
    if (bitPct !== null && bitPct > BITUACH_MAX_PCT) {
      out.push(finding('R13', id, 'עד ' + BITUACH_MAX_PCT + ' אחוז', bitPct + ' אחוז',
        'ביטוח לאומי מעסיק הוא ' + bitPct + ' אחוז מהתשלומים ועובר את התקרה של ' + BITUACH_MAX_PCT + ' אחוז'));
    }
  }

  // --- R14: very low salary ----------------------------------------------
  if (tash > 0 && tash < LOW_TASHLUMIM) {
    out.push(finding('R14', id, 'לפחות ' + LOW_TASHLUMIM + ' שקלים', fmtAmount(tash),
      'התשלומים לעובד הם ' + fmtAmount(tash) + ' שקלים בלבד ויש לוודא זכאות'));
  }

  // --- R17: row arithmetic ------------------------------------------------
  const components = round2(tash + tag + keren + pitz + toNum(line.shonot) + bit +
    toNum(line.masMaasikim) + toNum(line.masSachar));
  // Rounded to the agora BEFORE the comparison: 11750.01 - 11750 is
  // 0.010000000000218 in IEEE arithmetic, which would make a one-agora
  // rounding difference fire a critical finding on a perfectly good row.
  const drift = round2(Math.abs(components - round2(total)));
  if (drift > ARITHMETIC_TOLERANCE) {
    out.push(finding('R17', id, fmtAmount(total), fmtAmount(components),
      'סכום רכיבי השורה הוא ' + fmtAmount(components) + ' שקלים אך הסה"כ המודפס הוא ' + fmtAmount(total) + ' שקלים'));
  }

  return out;
}

// ---------------------------------------------------------------------------
// Run-level evaluation
// ---------------------------------------------------------------------------

// Build the stored PayrollLines shape from a parsed row + the roster.
function buildLine(row, index, workers, runId) {
  const dept = String(row.dept || '').trim();
  const match = matchWorker(row, workers);
  return {
    runId: runId || '',
    lineId: (runId ? runId + '-' : '') + 'L' + String(index + 1).padStart(3, '0'),
    empNumber: normalizePayrollNumber(row.empNumber),
    rawName: String(row.rawName || '').trim(),
    matchedWorkerId: match.workerId,
    matchStatus: match.matchStatus,
    dept: dept,
    deptName: String(row.deptName || (DEPT_TO_HOUSE[dept] && DEPT_TO_HOUSE[dept].deptName) || '').trim(),
    mappedHouse: houseForDept(dept),
    tashlumim: round2(row.tashlumim),
    tagmulim: round2(row.tagmulim),
    keren: round2(row.keren),
    pitzuim: round2(row.pitzuim),
    shonot: round2(row.shonot),
    bituach: round2(row.bituach),
    masMaasikim: round2(row.masMaasikim),
    masSachar: round2(row.masSachar),
    total: round2(row.total),
  };
}

// Evaluate a whole import.
//
//   input.month            'YYYY-MM' of the payroll month
//   input.runId            id of this run, used to build stable line ids
//   input.rows             parsed rows from lib/payroll-parse.js
//   input.workers          [{ id, name, startDate, payrollEmpNumber }]
//   input.placements       [{ workerId, house, houseLabel, active }]
//   input.terminations     [{ workerId, terminationDate }] from archive_v3
//   input.previousTotals   { empNumber: total } from the previous imported run
//
// Returns { lines, findings }. Pure: no dates, no randomness, no I/O.
function evaluateRun(input) {
  const month = String((input && input.month) || '').trim();
  const runId = String((input && input.runId) || '').trim();
  const workers = (input && input.workers) || [];
  const rows = (input && input.rows) || [];
  const previousTotals = (input && input.previousTotals) || {};

  const workerById = {};
  workers.forEach(function (w) { workerById[w.id] = w; });

  const placementByWorker = {};
  ((input && input.placements) || []).forEach(function (p) {
    if (p && p.active !== false) placementByWorker[p.workerId] = p;
  });

  // Keep the LATEST termination per worker — a rehired worker has more than
  // one archive row and only the most recent one can retire them.
  const terminationByWorker = {};
  ((input && input.terminations) || []).forEach(function (t) {
    if (!t || !t.workerId || !t.terminationDate) return;
    const prev = terminationByWorker[t.workerId];
    if (!prev || String(t.terminationDate) > String(prev)) {
      terminationByWorker[t.workerId] = String(t.terminationDate);
    }
  });

  const lines = rows.map(function (r, i) { return buildLine(r, i, workers, runId); });
  const ctx = {
    month: month,
    workerById: workerById,
    placementByWorker: placementByWorker,
    terminationByWorker: terminationByWorker,
  };

  let findings = [];
  lines.forEach(function (line) {
    findings = findings.concat(evaluateLine(line, ctx));
  });

  // --- R04: duplicate employee number within the file ---------------------
  const byNumber = {};
  lines.forEach(function (l) {
    if (!l.empNumber) return;
    (byNumber[l.empNumber] = byNumber[l.empNumber] || []).push(l);
  });
  Object.keys(byNumber).sort().forEach(function (numKey) {
    const group = byNumber[numKey];
    if (group.length < 2) return;
    group.forEach(function (l) {
      findings.push(finding('R04', l.lineId, 'מספר עובד יחיד', group.length + ' שורות',
        'מספר עובד ' + numKey + ' מופיע ' + group.length + ' פעמים בקובץ'));
    });
  });

  // --- R03: an active worker with a placement but no line in the file -----
  const paidWorkerIds = {};
  lines.forEach(function (l) { if (l.matchedWorkerId) paidWorkerIds[l.matchedWorkerId] = true; });
  Object.keys(placementByWorker).sort().forEach(function (workerId) {
    if (paidWorkerIds[workerId]) return;
    const termination = terminationByWorker[workerId];
    if (termination && monthStart(month) !== null) {
      const end = parseDate(termination);
      if (end !== null && end < monthStart(month)) return;   // legitimately gone
    }
    const w = workerById[workerId];
    const place = placementByWorker[workerId];
    findings.push(finding('R03', '', 'שורת שכר בקובץ', 'אין שורה',
      'לעובד ' + ((w && w.name) || workerId) + ' המשובץ בבית ' + (place.houseLabel || place.house) +
      ' אין שורה בקובץ השכר'));
  });

  // --- R15: month-over-month cost swing -----------------------------------
  lines.forEach(function (l) {
    if (!l.empNumber) return;
    const prev = previousTotals[l.empNumber];
    if (prev === undefined || prev === null || toNum(prev) === 0) return;
    const delta = Math.abs(toNum(l.total) - toNum(prev)) / Math.abs(toNum(prev)) * 100;
    if (delta > MONTH_DELTA_PCT) {
      findings.push(finding('R15', l.lineId, fmtAmount(prev), fmtAmount(l.total),
        'העלות לעובד השתנתה ב ' + round2(delta) + ' אחוז מול החודש הקודם ועוברת את הסף של ' +
        MONTH_DELTA_PCT + ' אחוז'));
    }
  });

  return { lines: lines, findings: findings };
}

// Counters for the triage screen: תקין / לבדיקה / חריג.
function summarize(lines, findings) {
  const bySeverity = {};
  const flagged = {};
  (findings || []).forEach(function (f) {
    bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
    if (f.lineId) flagged[f.lineId] = Math.max(flagged[f.lineId] || 0, f.severity === SEVERITY.CRITICAL ? 2 : 1);
  });
  let critical = 0;
  let warning = 0;
  Object.keys(flagged).forEach(function (k) {
    if (flagged[k] === 2) critical++; else warning++;
  });
  const total = (lines || []).length;
  return {
    total: total,
    clean: Math.max(0, total - critical - warning),
    warning: warning,
    critical: critical,
    findings: (findings || []).length,
    orphanFindings: (findings || []).filter(function (f) { return !f.lineId; }).length,
  };
}

const payrollRulesApi = {
  DEPT_TO_HOUSE: DEPT_TO_HOUSE,
  RULES: RULES,
  RULE_IDS: RULE_IDS,
  SEVERITY: SEVERITY,
  TAGMULIM_MAX_PCT: TAGMULIM_MAX_PCT,
  PITZUIM_MAX_PCT: PITZUIM_MAX_PCT,
  PITZUIM_TAGMULIM_RATIOS: PITZUIM_TAGMULIM_RATIOS,
  RATIO_TOLERANCE_PCT: RATIO_TOLERANCE_PCT,
  BITUACH_MIN_PCT: BITUACH_MIN_PCT,
  BITUACH_MAX_PCT: BITUACH_MAX_PCT,
  BITUACH_MIN_TASHLUMIM: BITUACH_MIN_TASHLUMIM,
  LOW_TASHLUMIM: LOW_TASHLUMIM,
  PENSION_MIN_TASHLUMIM: PENSION_MIN_TASHLUMIM,
  PENSION_TENURE_MONTHS: PENSION_TENURE_MONTHS,
  MONTH_DELTA_PCT: MONTH_DELTA_PCT,
  ARITHMETIC_TOLERANCE: ARITHMETIC_TOLERANCE,
  houseForDept: houseForDept,
  deptIsKnown: deptIsKnown,
  normalizeEmpNumber: normalizePayrollNumber,
  normalizeName: normalizeName,
  matchWorker: matchWorker,
  tenureMonths: tenureMonths,
  buildLine: buildLine,
  evaluateLine: evaluateLine,
  evaluateRun: evaluateRun,
  summarize: summarize,
};

if (typeof module !== 'undefined' && module.exports) module.exports = payrollRulesApi;
if (typeof window !== 'undefined') window.PayrollRules = payrollRulesApi;
