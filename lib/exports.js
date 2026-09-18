'use strict';

// ============================================================
// E-ZONE staffing — read-only CSV exports.
//
// Pure functions: data in, a CSV string out. No fetch, no DOM, no writes.
// Every report is a projection of data the app already holds, computed from
// the SAME lib/cost-engine.js report the screen is showing — so an exported
// number can never disagree with the number Moran was looking at.
//
//   buildExport(kind, ctx) -> { filename, csv, rowCount }
//
// `ctx` is { workers, assignments, absences, coverages, budgets, archive,
//            monthlyActuals, month, today, houseNames, report? }
// `report` is an already-computed costForMonth result; when absent, one is
// computed. Passing the screen's own report is what guarantees the match.
//
// Loaded in the browser as a CLASSIC script beside lib/calc.js and
// lib/cost-engine.js, so everything lives inside a closure and exactly one
// global name is exposed. See the note in lib/cost-engine.js.
// ============================================================

(function (root, factory) {
  const API = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root) root.StaffingExports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const engine = (typeof require === 'function')
    ? require('./cost-engine')
    : (typeof globalThis !== 'undefined' ? globalThis.CostEngine : null);

  // ---------- CSV writing ----------

  // Excel on Windows needs the BOM to read UTF-8 Hebrew, and CRLF to treat
  // the file as rows. Both are load-bearing, not decoration.
  const BOM = '﻿';
  const EOL = '\r\n';

  // Characters that make Excel and Sheets treat a cell as a FORMULA rather
  // than text. Worker names and notes are free text typed by a person, so a
  // cell beginning with one of these is neutralized with a leading
  // apostrophe. Without this, a note of `=1+1` becomes a formula, and
  // `=HYPERLINK(...)` in a file someone forwards is a live payload. The
  // apostrophe is Excel's own "treat as text" prefix.
  const FORMULA_LEADERS = ['=', '+', '-', '@', '\t', '\r'];

  function csvCell(value) {
    let s = value === null || value === undefined ? '' : String(value);
    if (s && FORMULA_LEADERS.indexOf(s.charAt(0)) >= 0) s = "'" + s;
    if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function csvRow(cells) {
    return cells.map(csvCell).join(',');
  }

  // headers: string[]; rows: array of arrays
  function toCsv(headers, rows) {
    const lines = [csvRow(headers)];
    rows.forEach(r => lines.push(csvRow(r)));
    return BOM + lines.join(EOL) + EOL;
  }

  // ---------- small helpers ----------

  function byId(list) {
    const m = Object.create(null);
    (list || []).forEach(x => { if (x && x.id) m[x.id] = x; });
    return m;
  }

  function nameOf(workersById, workerId) {
    const w = workersById[workerId];
    return w ? String(w.name || '') : '';
  }

  // Normalization used for duplicate detection. Mirror of
  // normalizeWorkerName_ in apps-script/Code.gs: whatever this changes is
  // invisible on screen and fatal to the consumers' exact-name matching.
  function normalizeName(name) {
    return String(name === null || name === undefined ? '' : name)
      .replace(/[‎‏‪-‮⁦-⁩﻿]/g, '')
      .replace(/״/g, '"')
      .replace(/׳/g, "'")
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function normalizePhone(phone) {
    return String(phone === null || phone === undefined ? '' : phone).replace(/\D/g, '');
  }

  // Hebrew labels for the enums, so an export is readable without a decoder.
  // Stored values stay ASCII; these are display only.
  const EMPLOYMENT_TYPE_LABELS = {
    full_time: 'משכורת חודשית מלאה',
    part_time: 'משכורת חודשית חלקית',
    hourly: 'לפי שעה',
    per_session: 'לפי מפגש',
    fixed_retainer: 'ריטיינר קבוע',
  };
  const STATUS_LABELS = {
    active: 'פעיל',
    chld: 'חל"ד',
    chlt: 'חל"ת',
    final_settlement: 'גמ"ח',
  };
  const SOURCE_LABELS = {
    actual: 'בפועל',
    estimate: 'אומדן',
    none: 'חסרים נתונים',
  };
  const SALARIED_TYPES = ['full_time', 'part_time', 'hourly'];

  function categoryLabel(employmentType) {
    if (SALARIED_TYPES.indexOf(String(employmentType)) >= 0) return 'שכיר';
    return 'פרילנסר';
  }

  function houseLabel(houseNames, id) {
    if (!houseNames) return String(id || '');
    return String(houseNames[id] || id || '');
  }

  function fmtMonth(month) {
    const m = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
    return m ? m[2] + '/' + m[1] : String(month || '');
  }

  // The cost report for the context's month, computed once and reused.
  function reportFor(ctx) {
    if (ctx.report) return ctx.report;
    if (!engine) throw new Error('lib/exports.js needs lib/cost-engine.js');
    return engine.costForMonth(
      ctx.workers || [], ctx.assignments || [], ctx.absences || [],
      ctx.coverages || [], ctx.budgets || [], ctx.month,
      { archive: ctx.archive || [], monthlyActuals: ctx.monthlyActuals || [] });
  }

  // Assignment lines only, in a stable order: house, then worker name.
  function assignmentLines(report, workersById) {
    return report.lines
      .filter(l => l.kind === 'assignment')
      .slice()
      .sort((a, b) => (a.house + ' ' + nameOf(workersById, a.workerId))
        .localeCompare(b.house + ' ' + nameOf(workersById, b.workerId)));
  }

  // ---------- the reports ----------
  // Each entry: { label, filename(ctx), build(ctx) -> { headers, rows } }.
  // `label` is the Hebrew button text — no parentheses, per the UI rule.

  const REPORTS = {

    // 1. Monthly payroll: one row per placement, with the trace.
    payroll: {
      label: 'שכר חודשי',
      filename: ctx => 'payroll-' + ctx.month + '.csv',
      build(ctx) {
        const report = reportFor(ctx);
        const workersById = byId(ctx.workers);
        const headers = ['חודש', 'בית', 'שם', 'תפקיד', 'סוג העסקה', 'סטטוס',
          'עלות', 'מקור הנתון', 'ימים שחויבו', 'ימים בחודש', 'חוקיות החישוב',
          'פירוט החישוב', 'נתונים חסרים', 'workerId', 'assignmentId'];
        const rows = assignmentLines(report, workersById).map(l => [
          ctx.month,
          houseLabel(ctx.houseNames, l.house),
          nameOf(workersById, l.workerId),
          l.role,
          EMPLOYMENT_TYPE_LABELS[l.employmentType] || l.employmentType,
          STATUS_LABELS[l.status] || l.status,
          l.cost,
          SOURCE_LABELS[l.source] || l.source,
          l.daysCounted,
          l.daysInMonth,
          l.rule,
          l.basis,
          (l.missingData || []).join(' '),
          l.workerId,
          l.assignmentId,
        ]);
        return { headers, rows };
      },
    },

    // 2. Actual vs estimate: the same lines, split by how solid the number is.
    actualVsEstimate: {
      label: 'בפועל מול אומדן',
      filename: ctx => 'actual-vs-estimate-' + ctx.month + '.csv',
      build(ctx) {
        const report = reportFor(ctx);
        const workersById = byId(ctx.workers);
        const headers = ['חודש', 'בית', 'שם', 'סוג העסקה', 'עלות',
          'מאושר בפועל', 'אומדן', 'חסרים נתונים', 'חוקיות החישוב', 'workerId', 'assignmentId'];
        const rows = assignmentLines(report, workersById).map(l => [
          ctx.month,
          houseLabel(ctx.houseNames, l.house),
          nameOf(workersById, l.workerId),
          EMPLOYMENT_TYPE_LABELS[l.employmentType] || l.employmentType,
          l.cost,
          l.source === 'actual' ? l.cost : 0,
          l.source === 'estimate' ? l.cost : 0,
          (l.missingData || []).length ? 'כן' : '',
          l.rule,
          l.workerId,
          l.assignmentId,
        ]);
        // A totals row, because this report exists to be reconciled.
        rows.push(['סה״כ', '', '', '',
          report.totals.projectedTotal,
          report.totals.actualConfirmed,
          report.totals.estimated,
          report.totals.missingData, '', '', '']);
        return { headers, rows };
      },
    },

    // 3. By house, with the budget for the SAME month.
    byHouse: {
      label: 'לפי בית',
      filename: ctx => 'by-house-' + ctx.month + '.csv',
      build(ctx) {
        const report = reportFor(ctx);
        const headers = ['חודש', 'בית', 'שיבוצים', 'עלות', 'מאושר בפועל', 'אומדן',
          'שיבוצים ללא נתונים מלאים', 'מתוכה עלות מדריכים', 'תקציב',
          'תקציב מדריכים', 'יתרה', 'ניצול באחוזים'];
        const houses = Object.keys(report.byHouse).sort();
        const rows = houses.map(h => {
          const hb = report.byHouse[h];
          const count = report.lines.filter(l => l.kind === 'assignment' && l.house === h).length;
          return [
            ctx.month,
            houseLabel(ctx.houseNames, h),
            count,
            hb.projectedTotal,
            hb.actualConfirmed,
            hb.estimated,
            hb.missingData,
            hb.instructorsCost,
            hb.budget === null ? 'אין תקציב' : hb.budget,
            hb.instructorsBudget === null ? 'אין תקציב' : hb.instructorsBudget,
            hb.variance.variance === null ? '' : hb.variance.variance,
            hb.variance.pct === null ? '' : hb.variance.pct,
          ];
        });
        rows.push([ctx.month, 'סה״כ רשת',
          report.lines.filter(l => l.kind === 'assignment').length,
          report.totals.projectedTotal, report.totals.actualConfirmed,
          report.totals.estimated, report.totals.missingData, '', '', '', '', '']);
        return { headers, rows };
      },
    },

    // 4. By role.
    byRole: {
      label: 'לפי תפקיד',
      filename: ctx => 'by-role-' + ctx.month + '.csv',
      build(ctx) {
        const report = reportFor(ctx);
        const acc = Object.create(null);
        report.lines.filter(l => l.kind === 'assignment').forEach(l => {
          const k = l.role || 'לא צוין';
          if (!acc[k]) acc[k] = { count: 0, cost: 0, actual: 0, estimate: 0, missing: 0 };
          acc[k].count++;
          acc[k].cost += l.cost;
          if (l.source === 'actual') acc[k].actual += l.cost;
          if (l.source === 'estimate') acc[k].estimate += l.cost;
          if ((l.missingData || []).length) acc[k].missing++;
        });
        const headers = ['חודש', 'תפקיד', 'שיבוצים', 'עלות', 'מאושר בפועל', 'אומדן',
          'שיבוצים ללא נתונים מלאים'];
        const rows = Object.keys(acc).sort().map(k => [
          ctx.month, k, acc[k].count, acc[k].cost, acc[k].actual, acc[k].estimate, acc[k].missing,
        ]);
        return { headers, rows };
      },
    },

    // 5. Salaried vs freelance.
    byCategory: {
      label: 'שכירים מול פרילנסרים',
      filename: ctx => 'salaried-vs-freelance-' + ctx.month + '.csv',
      build(ctx) {
        const report = reportFor(ctx);
        const workersById = byId(ctx.workers);
        const headers = ['חודש', 'קטגוריה', 'בית', 'שם', 'סוג העסקה', 'עלות', 'מקור הנתון',
          'workerId', 'assignmentId'];
        const rows = assignmentLines(report, workersById).map(l => [
          ctx.month,
          categoryLabel(l.employmentType),
          houseLabel(ctx.houseNames, l.house),
          nameOf(workersById, l.workerId),
          EMPLOYMENT_TYPE_LABELS[l.employmentType] || l.employmentType,
          l.cost,
          SOURCE_LABELS[l.source] || l.source,
          l.workerId,
          l.assignmentId,
        ]);
        // Two subtotal rows.
        ['שכיר', 'פרילנסר'].forEach(cat => {
          const lines = assignmentLines(report, workersById)
            .filter(l => categoryLabel(l.employmentType) === cat);
          rows.push(['סה״כ', cat, '', lines.length + ' שיבוצים', '',
            lines.reduce((s, l) => s + l.cost, 0), '', '', '']);
        });
        return { headers, rows };
      },
    },

    // 6. Absences, all of them, with the derived status.
    absences: {
      label: 'היעדרויות',
      filename: () => 'absences.csv',
      build(ctx) {
        const workersById = byId(ctx.workers);
        const today = ctx.today;
        function status(a) {
          const s = String(a.startDate || ''), e = String(a.endDate || '');
          if (!s || !e) return 'ended';
          if (s > today) return 'future';
          if (e < today) return 'ended';
          return 'active';
        }
        const STATUS = { active: 'פעילה', future: 'עתידית', ended: 'הסתיימה' };
        const headers = ['סוג רשומה', 'בית', 'שם', 'מתאריך', 'עד תאריך', 'ימים',
          'סיבה', 'פירוט', 'סטטוס', 'workerId', 'absenceId'];
        const rows = (ctx.absences || []).slice()
          .sort((a, b) => String(b.startDate).localeCompare(String(a.startDate)))
          .map(a => {
            const unstaffed = !String(a.workerId || '').trim();
            const days = (engine && a.startDate && a.endDate)
              ? engine.daysBetweenInclusive(a.startDate, a.endDate) : '';
            return [
              unstaffed ? 'משבצת לא מאוישת' : 'היעדרות עובד',
              houseLabel(ctx.houseNames, a.house),
              unstaffed ? '' : nameOf(workersById, a.workerId),
              a.startDate, a.endDate, days,
              a.reasonType, a.reasonDetail,
              STATUS[status(a)],
              a.workerId || '', a.id,
            ];
          });
        return { headers, rows };
      },
    },

    // 7. Coverages, including cancelled ones — the history is the point.
    coverages: {
      label: 'החלפות',
      filename: () => 'coverages.csv',
      build(ctx) {
        const workersById = byId(ctx.workers);
        const APPROVAL = { pending: 'ממתין לאישור', approved: 'מאושר', rejected: 'נדחה' };
        const headers = ['מחליף', 'בית המחליף', 'בית מקבל', 'מתאריך', 'עד תאריך', 'ימים',
          'תוספת תשלום', 'תפקיד מוחלף', 'מספר משמרות', 'סטטוס אישור', 'אושר על ידי',
          'בוטל', 'הערות', 'workerId', 'coverageId', 'replacedAssignmentId'];
        const rows = (ctx.coverages || []).slice()
          .sort((a, b) => String(b.startDate).localeCompare(String(a.startDate)))
          .map(c => [
            nameOf(workersById, c.coveringWorkerId),
            houseLabel(ctx.houseNames, c.coveringHouse),
            houseLabel(ctx.houseNames, c.receivingHouse),
            c.startDate, c.endDate,
            (engine && c.startDate && c.endDate)
              ? engine.daysBetweenInclusive(c.startDate, c.endDate) : '',
            c.extraPayment,
            c.role || '',
            c.shiftCount || '',
            APPROVAL[c.approvalStatus] || c.approvalStatus || '',
            c.approvedBy || '',
            c.cancelled ? 'כן' : '',
            c.notes || '',
            c.coveringWorkerId, c.id, c.replacedAssignmentId || '',
          ]);
        return { headers, rows };
      },
    },

    // 8. Workers with a live placement and no start date.
    missingStartDates: {
      label: 'חסרי תאריך תחילת עבודה',
      filename: () => 'missing-start-dates.csv',
      build(ctx) {
        const placed = Object.create(null);
        (ctx.assignments || []).forEach(a => { if (a && a.workerId) placed[a.workerId] = true; });
        const headers = ['שם', 'טלפון', 'בתים', 'תפקידים', 'workerId'];
        const rows = (ctx.workers || [])
          .filter(w => w && placed[w.id] && !String(w.startDate || '').trim())
          .sort((a, b) => String(a.name).localeCompare(String(b.name)))
          .map(w => {
            const mine = (ctx.assignments || []).filter(a => a && a.workerId === w.id);
            return [
              w.name, w.phone || '',
              mine.map(a => houseLabel(ctx.houseNames, a.house)).sort().join(' '),
              mine.map(a => a.role).sort().join(' '),
              w.id,
            ];
          });
        return { headers, rows };
      },
    },

    // 9. Placements whose cost fields cannot produce a number.
    missingRates: {
      label: 'שיבוצים ללא תעריף',
      filename: ctx => 'missing-rates-' + ctx.month + '.csv',
      build(ctx) {
        const report = reportFor(ctx);
        const workersById = byId(ctx.workers);
        const headers = ['חודש', 'בית', 'שם', 'תפקיד', 'סוג העסקה', 'עלות מחושבת',
          'נתונים חסרים', 'פירוט החישוב', 'workerId', 'assignmentId'];
        const rows = assignmentLines(report, workersById)
          .filter(l => (l.missingData || []).length)
          .map(l => [
            ctx.month,
            houseLabel(ctx.houseNames, l.house),
            nameOf(workersById, l.workerId),
            l.role,
            EMPLOYMENT_TYPE_LABELS[l.employmentType] || l.employmentType,
            l.cost,
            (l.missingData || []).join(' '),
            l.basis,
            l.workerId, l.assignmentId,
          ]);
        return { headers, rows };
      },
    },

    // 10. Workers with no placement at all.
    unassigned: {
      label: 'עובדים ללא שיבוץ',
      filename: () => 'unassigned.csv',
      build(ctx) {
        const placed = Object.create(null);
        (ctx.assignments || []).forEach(a => { if (a && a.workerId) placed[a.workerId] = true; });
        const archived = Object.create(null);
        (ctx.archive || []).forEach(a => { if (a && a.workerId) archived[a.workerId] = true; });
        const headers = ['שם', 'טלפון', 'תאריך תחילת עבודה', 'מצב', 'workerId'];
        const rows = (ctx.workers || [])
          .filter(w => w && !placed[w.id])
          .sort((a, b) => String(a.name).localeCompare(String(b.name)))
          .map(w => [
            w.name, w.phone || '', w.startDate || '',
            archived[w.id] ? 'סיים/ה עבודה' : 'ללא שיבוץ וללא היסטוריה',
            w.id,
          ]);
        return { headers, rows };
      },
    },

    // 11. Duplicate workers, by normalized name and by phone.
    duplicates: {
      label: 'כפילויות עובדים',
      filename: () => 'duplicates.csv',
      build(ctx) {
        const byName = Object.create(null);
        const byPhone = Object.create(null);
        (ctx.workers || []).forEach(w => {
          if (!w) return;
          const n = normalizeName(w.name);
          if (n) (byName[n] = byName[n] || []).push(w);
          const p = normalizePhone(w.phone);
          if (p) (byPhone[p] = byPhone[p] || []).push(w);
        });
        const headers = ['סוג הכפילות', 'ערך', 'שם', 'טלפון', 'בתים', 'workerId'];
        const rows = [];
        function emit(kind, value, group) {
          group.forEach(w => {
            const mine = (ctx.assignments || []).filter(a => a && a.workerId === w.id);
            rows.push([kind, value, w.name, w.phone || '',
              mine.map(a => houseLabel(ctx.houseNames, a.house)).sort().join(' '), w.id]);
          });
        }
        Object.keys(byName).sort().forEach(n => {
          if (byName[n].length > 1) emit('שם זהה', n, byName[n]);
        });
        Object.keys(byPhone).sort().forEach(p => {
          if (byPhone[p].length > 1) emit('טלפון זהה', p, byPhone[p]);
        });
        return { headers, rows };
      },
    },

    // 12. Budget exceptions: over budget, or no budget while costing money.
    budgetExceptions: {
      label: 'חריגות תקציב',
      filename: ctx => 'budget-exceptions-' + ctx.month + '.csv',
      build(ctx) {
        const report = reportFor(ctx);
        const headers = ['חודש', 'בית', 'שורה', 'תקציב', 'עלות', 'חריגה',
          'ניצול באחוזים', 'סוג החריגה'];
        const rows = [];
        Object.keys(report.byHouse).sort().forEach(h => {
          const hb = report.byHouse[h];
          const label = houseLabel(ctx.houseNames, h);
          if (hb.budget === null) {
            if (hb.projectedTotal > 0) {
              rows.push([ctx.month, label, 'בית', 'אין תקציב', hb.projectedTotal,
                '', '', 'עלות ללא תקציב מוגדר']);
            }
          } else if (hb.variance.variance < 0) {
            rows.push([ctx.month, label, 'בית', hb.budget, hb.projectedTotal,
              -hb.variance.variance, hb.variance.pct, 'חריגה מהתקציב']);
          }
          if (hb.instructorsBudget !== null && hb.instructorsVariance.variance < 0) {
            rows.push([ctx.month, label, 'מדריכים', hb.instructorsBudget, hb.instructorsCost,
              -hb.instructorsVariance.variance, hb.instructorsVariance.pct,
              'חריגה מתקציב המדריכים']);
          }
        });
        return { headers, rows };
      },
    },

    // 13. The full roster, as a plain snapshot.
    roster: {
      label: 'מצבת עובדים',
      filename: ctx => 'roster-' + ctx.month + '.csv',
      build(ctx) {
        const report = reportFor(ctx);
        const workersById = byId(ctx.workers);
        const headers = ['בית', 'שם', 'טלפון', 'תפקיד', 'פירוט תפקיד', 'סוג העסקה',
          'קטגוריה', 'סטטוס', 'תאריך תחילת עבודה', 'עלות בחודש הנבחר',
          'workerId', 'assignmentId'];
        const rows = assignmentLines(report, workersById).map(l => {
          const w = workersById[l.workerId] || {};
          const a = (ctx.assignments || []).find(x => x && x.id === l.assignmentId) || {};
          return [
            houseLabel(ctx.houseNames, l.house),
            w.name || '', w.phone || '',
            l.role, a.roleDetail || '',
            EMPLOYMENT_TYPE_LABELS[l.employmentType] || l.employmentType,
            categoryLabel(l.employmentType),
            STATUS_LABELS[l.status] || l.status,
            w.startDate || '',
            l.cost,
            l.workerId, l.assignmentId,
          ];
        });
        return { headers, rows };
      },
    },
  };

  // ---------- public entry point ----------

  function exportKinds() {
    return Object.keys(REPORTS).map(k => ({ kind: k, label: REPORTS[k].label }));
  }

  function buildExport(kind, ctx) {
    const def = REPORTS[kind];
    if (!def) throw new Error('unknown export: ' + kind);
    const c = ctx || {};
    const built = def.build(c);
    return {
      filename: def.filename(c),
      csv: toCsv(built.headers, built.rows),
      rowCount: built.rows.length,
      label: def.label,
    };
  }

  const API = {
    buildExport,
    exportKinds,
    toCsv,
    csvCell,
    normalizeName,
    normalizePhone,
    BOM,
    EOL,
    FORMULA_LEADERS,
    EMPLOYMENT_TYPE_LABELS,
    STATUS_LABELS,
    REPORT_KINDS: Object.keys(REPORTS),
  };
  return API;
});
