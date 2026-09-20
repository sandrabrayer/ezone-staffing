'use strict';

// Guards for runDataIntegrityReportNow() / computeDataIntegrityReport_ in
// apps-script/Code.gs — the Phase 0 diagnostic.
//
// Code.gs has no JS harness, so (as in tests/coordinators-endpoint.test.js)
// it is evaluated in a vm sandbox with the Apps Script services mocked, and
// the pure computation is driven against in-memory fixtures.
//
// The hard rules pinned here:
//   - The COMPUTATION is read-only: computeDataIntegrityReport_ performs
//     ZERO sheet writes. The sandbox's Range mock throws on
//     setValue/setValues for every tab, so any write at all fails the test.
//     (This is why the report uses readAbsencesReadOnly_ instead of
//     readAbsencesSafe, whose lazy status correction writes back.)
//   - The RUN writes the two report tabs — «דוח תקינות» and «ניקוי נתונים» —
//     and NOTHING else. The mock throws on a write to any other tab, so a
//     stray write to a data tab fails the test rather than being noticed
//     afterwards in production.
//   - Duplicates are reported once per GROUP, with the member details and a
//     recommended keeper; never once per member.
//   - Every finding row carries workerName / houseId / employmentType — a
//     report of bare ids cannot be acted on.
//   - Finding codes stay ASCII (stored values are ASCII; Hebrew is display
//     only).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const gs = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');

// The two tabs the report is allowed to write, by name. Everything else is
// a data tab as far as this test is concerned.
const REPORT_TABS = ['דוח תקינות', 'ניקוי נתונים'];

// A sheet mock over a 2-D array of values. Writes are routed through
// writeGuard(op, tabName), which throws for any tab that is not a report
// tab — the contract is enforced by construction rather than by inspection.
function sheetMock(name, values, writeGuard) {
  const validations = [];
  function range(r, c, nr, nc) {
    return {
      getValues() { return values; },
      getValue() { return values[0] && values[0][0]; },
      setValue(v) { writeGuard('setValue', name); return this; },
      setValues(vals) {
        writeGuard('setValues', name);
        vals.forEach((row, i) => {
          const at = (r || 1) - 1 + i;
          while (values.length <= at) values.push([]);
          row.forEach((v, j) => { values[at][(c || 1) - 1 + j] = v; });
        });
        return this;
      },
      setNumberFormat() { writeGuard('setNumberFormat', name); return this; },
      setDataValidation(rule) { writeGuard('setDataValidation', name); validations.push({ r, c, nr, nc, rule }); return this; },
    };
  }
  return {
    name, values, validations,
    getDataRange() { return range(1, 1, values.length, 1); },
    getRange: range,
    getLastRow() { return values.length; },
    clear() { writeGuard('clear', name); values.length = 0; },
    setFrozenRows() { writeGuard('setFrozenRows', name); },
  };
}

function loadCtx(tabs, onWrite) {
  const writeGuard = onWrite || function (op, name) {
    throw new Error('the integrity report must not write to the sheet (called ' + op + ' on ' + name + ')');
  };
  const sheets = {};
  Object.keys(tabs).forEach((name) => { sheets[name] = sheetMock(name, tabs[name], writeGuard); });
  const ctx = vm.createContext({
    Logger: { log() {} },
    PropertiesService: {
      getScriptProperties() {
        return { getProperty(k) { return k === 'SHEET_ID' ? 'sheet-1' : null; } };
      },
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput(s) { return { _text: s, setMimeType() { return this; } }; },
    },
    LockService: { getScriptLock() { return { waitLock() {}, releaseLock() {} }; } },
    Utilities: {
      formatDate(d, tz, fmt) {
        const iso = d.toISOString();
        if (fmt === 'yyyy-MM-dd') return iso.slice(0, 10);
        if (fmt === 'yyyy-MM') return iso.slice(0, 7);
        if (fmt === 'yyyyMMdd') return iso.slice(0, 10).replace(/-/g, '');
        if (fmt === 'HHmm') return iso.slice(11, 16).replace(':', '');
        return iso;
      },
    },
    Session: { getScriptTimeZone() { return 'UTC'; } },
    SpreadsheetApp: {
      newDataValidation() {
        const rule = { values: null, allowInvalid: null, strict: null };
        const builder = {
          requireValueInList(list, strict) { rule.values = list.slice(); rule.strict = strict; return builder; },
          setAllowInvalid(v) { rule.allowInvalid = v; return builder; },
          build() { return rule; },
        };
        return builder;
      },
      openById() {
        return {
          getSheetByName(name) {
            if (!Object.prototype.hasOwnProperty.call(sheets, name)) return null;
            return sheets[name];
          },
          insertSheet(name) {
            writeGuard('insertSheet', name);
            sheets[name] = sheetMock(name, [], writeGuard);
            return sheets[name];
          },
        };
      },
    },
  });
  vm.runInContext(gs, ctx);
  ctx.sheets = sheets;
  return ctx;
}

const TODAY = '2026-09-17';

// Rows are written positionally, exactly as the sheet stores them.
function workersTab(rows) {
  return [['id', 'name', 'notes', 'created_at', 'shift_commitment', 'start_date', 'gmach_month', 'phone']].concat(rows);
}
function assignmentsTab(rows) {
  return [[
    'id', 'worker_id', 'house', 'role', 'role_detail', 'employment_type',
    'salary', 'pct', 'hourly_rate', 'est_hours', 'session_rate', 'est_sessions',
    'retainer_amount', 'notes', 'created_at', 'allowance', 'status', 'status_date',
    'rate_individual', 'sessions_individual', 'rate_group', 'sessions_group',
    'rate_external', 'external_patients',
  ]].concat(rows);
}
function absencesTab(rows) {
  return [['id', 'worker_id', 'house', 'start_date', 'end_date', 'reason_type',
    'reason_detail', 'notes', 'status', 'created_at']].concat(rows);
}
function coveragesTab(rows) {
  return [['id', 'absence_id', 'covering_worker_id', 'covering_house',
    'receiving_house', 'start_date', 'end_date', 'extra_payment', 'notes', 'created_at']].concat(rows);
}
function archiveTab(rows) {
  return [['id', 'assignment_id', 'worker_id', 'name', 'house', 'role', 'role_detail',
    'employment_type', 'salary', 'pct', 'hourly_rate', 'est_hours', 'session_rate',
    'est_sessions', 'retainer_amount', 'notes', 'termination_date', 'reason_type',
    'reason_detail', 'archived_at', 'rate_individual', 'sessions_individual',
    'rate_group', 'sessions_group', 'rate_external', 'external_patients']].concat(rows);
}
function actualsTab(rows) {
  return [['id', 'assignment_id', 'month', 'actual_hours', 'actual_sessions',
    'note', 'created_at', 'updated_at']].concat(rows);
}

// A worker row: full-time instructor at ramot, ₪10,000, started long ago.
function ftAssignment(id, workerId, house) {
  return [id, workerId, house, 'מדריך/ה', '', 'full_time', 10000, 100, 0, 0, 0, 0, 0, '', '2025-01-01', 0, 'active', '', 0, 0, 0, 0, 0, 0];
}

// The kitchen-sink fixture: every check has at least one row that trips it.
function dirtyTabs() {
  return {
    workers: workersTab([
      ['w1', 'דנה כהן', '', '2025-01-01', '', '2025-01-01', '', '0501111111'],
      // duplicate of w1 by normalized name (padded + double space) AND a
      // name that would fail an exact-match sync.
      ['w2', '  דנה  כהן ', '', '2025-01-01', '', '2025-02-01', '', '0502222222'],
      // duplicate phone with w4, and a future start date while billing.
      ['w3', 'יוסי לוי', '', '2025-01-01', '', '2026-12-01', '', '0503333333'],
      ['w4', 'רונית מזרחי', '', '2025-01-01', '', '', '', '050-333-3333'],
      // no assignment at all, and a smoke-test name.
      ['w5', 'smoke test worker', '', '2025-01-01', '', '2025-01-01', '', ''],
      // blank name.
      ['w6', '   ', '', '2025-01-01', '', '2025-01-01', '', ''],
      // gershayim in the name — exact-match sync risk.
      ['w7', 'מנהל״ן פלוני', '', '2025-01-01', '', '2025-01-01', '', ''],
    ]),
    assignments: assignmentsTab([
      ftAssignment('a1', 'w1', 'ramot'),
      // duplicate assignment: w1 twice at ramot.
      ftAssignment('a2', 'w1', 'ramot'),
      ftAssignment('a3', 'w3', 'asher'),
      // orphan: worker w99 does not exist.
      ftAssignment('a4', 'w99', 'ramot'),
      // invalid house id.
      ftAssignment('a5', 'w4', 'atlantis'),
      // hourly with no rate and no hours.
      ['a6', 'w6', 'rehab', 'מדריך/ה', '', 'hourly', 0, 0, 0, 0, 0, 0, 0, '', '2025-01-01', 0, 'active', '', 0, 0, 0, 0, 0, 0],
      // per_session with no rate on any product.
      ['a7', 'w7', 'pardes', 'מטפל/ת', '', 'per_session', 0, 0, 0, 0, 0, 0, 0, '', '2025-01-01', 0, 'active', '', 0, 0, 0, 0, 0, 0],
      // negative salary.
      ['a8', 'w2', 'hq', 'רכז/ת', '', 'full_time', -500, 100, 0, 0, 0, 0, 0, '', '2025-01-01', 0, 'active', '', 0, 0, 0, 0, 0, 0],
      // archived but still live in the assignments tab.
      ftAssignment('a9', 'w4', 'ofroni'),
    ]),
    absences: absencesTab([
      ['ab1', 'w1', 'ramot', '2026-09-01', '2026-09-10', 'מחלה', '', '', 'active', '2026-09-01'],
      // overlaps ab1 for the same worker+house.
      ['ab2', 'w1', 'ramot', '2026-09-05', '2026-09-20', 'חופשה', '', '', 'active', '2026-09-01'],
      // unstaffed position (no worker).
      ['ab3', '', 'asher', '2026-09-01', '2026-09-30', 'צורך תפעולי', '', '', 'active', '2026-09-01'],
      // orphan worker.
      ['ab4', 'w98', 'rehab', '2026-09-01', '2026-09-30', 'מחלה', '', '', 'active', '2026-09-01'],
    ]),
    coverages: coveragesTab([
      ['c1', 'ab1', 'w3', 'asher', 'ramot', '2026-09-01', '2026-09-10', 500, '', '2026-09-01'],
      // dangling absence link + orphan covering worker.
      ['c2', 'ab99', 'w97', 'asher', 'ramot', '2026-09-01', '2026-09-10', 500, '', '2026-09-01'],
    ]),
    archive_v3: archiveTab([
      ['arc1', 'a9', 'w4', 'רונית מזרחי', 'ofroni', 'מדריך/ה', '', 'full_time',
        10000, 100, 0, 0, 0, 0, 0, '', '2026-08-31', 'התפטרות', '', '2026-08-31', 0, 0, 0, 0, 0, 0],
    ]),
    monthly_actuals: actualsTab([
      ['ma1', 'a6', '2026-09', 10, '', '', '2026-09-01', '2026-09-01'],
      // points at an assignment that no longer exists.
      ['ma2', 'a77', '2026-09', 10, '', '', '2026-09-01', '2026-09-01'],
    ]),
    budgets: [['id', 'house', 'month', 'amount', 'created_at', 'updated_at', 'instructors_amount'],
      ['b1', 'ramot', 'default', 100000, '2025-01-01', '2025-01-01', 40000],
      ['b2', 'narnia', '2026-09', 50000, '2025-01-01', '2025-01-01', '']],
  };
}

// Values built inside the vm live in another realm, so their prototypes are
// not reference-equal to the host's. Round-tripping through JSON gives plain
// host objects that deepStrictEqual can compare.
function plain(v) { return JSON.parse(JSON.stringify(v)); }

function runReport(tabs) {
  const ctx = loadCtx(tabs);
  return plain(ctx.computeDataIntegrityReport_(ctx.readAllForIntegrity_(), TODAY));
}

function findingsFor(report, code) {
  return report.findings.filter(f => f.code === code);
}

test('the report performs no sheet writes at all', () => {
  // sheetMock throws on every write path, so simply completing is the proof.
  const report = runReport(dirtyTabs());
  assert.ok(report.findings.length > 0, 'the dirty fixture must produce findings');
});

test('a clean roster produces no error-severity findings', () => {
  const tabs = {
    workers: workersTab([['w1', 'דנה כהן', '', '2025-01-01', '', '2025-01-01', '', '0501111111']]),
    assignments: assignmentsTab([ftAssignment('a1', 'w1', 'ramot')]),
    absences: absencesTab([]),
    coverages: coveragesTab([]),
    archive_v3: archiveTab([]),
    monthly_actuals: actualsTab([]),
    budgets: [['id', 'house', 'month', 'amount', 'created_at', 'updated_at', 'instructors_amount']],
  };
  const report = runReport(tabs);
  assert.deepStrictEqual(report.findings, [], 'clean data must produce no findings');
  assert.deepStrictEqual(report.bySeverity, { error: 0, warn: 0, info: 0 });
  assert.deepStrictEqual(report.counts.workers, 1);
});

test('duplicates are ONE finding per group, not one per member', () => {
  const report = runReport(dirtyTabs());
  const byName = findingsFor(report, 'DUP_WORKER_NAME');
  assert.strictEqual(byName.length, 1, 'a 2-member name group is ONE row, not two');
  assert.deepStrictEqual(byName[0].members, ['w1', 'w2'],
    'padding and double spaces must not hide a duplicate');
  assert.strictEqual(byName[0].entity, 'worker_group');

  const byPhone = findingsFor(report, 'DUP_WORKER_PHONE');
  assert.strictEqual(byPhone.length, 1, 'a 2-member phone group is ONE row, not two');
  assert.deepStrictEqual(byPhone[0].members, ['w3', 'w4'],
    'dashes must not hide a duplicate phone');
});

test('a duplicate group carries every member detail Moran needs to decide', () => {
  const report = runReport(dirtyTabs());
  const g = findingsFor(report, 'DUP_WORKER_NAME')[0];
  const byId = {};
  g.memberDetails.forEach(m => { byId[m.id] = m; });
  assert.deepStrictEqual(Object.keys(byId).sort(), ['w1', 'w2']);
  assert.strictEqual(byId.w1.name, 'דנה כהן');
  assert.strictEqual(byId.w1.phone, '0501111111');
  assert.strictEqual(byId.w1.houses, 'ramot', 'the houses the member is placed at');
  assert.strictEqual(byId.w1.assignmentCount, 2, 'how many assignment rows would move');
  assert.strictEqual(byId.w1.createdAt, '2025-01-01', 'when the row was created');
  assert.strictEqual(byId.w2.assignmentCount, 1);
  // The detail line repeats it in words, because the log has no columns.
  assert.match(g.detail, /דנה כהן/);
  assert.match(g.detail, /0501111111/);
  assert.match(g.detail, /created/);
});

test('the recommended keeper is the oldest id that carries assignments', () => {
  const tabs = dirtyTabs();
  // w1 (created 2025-01-01, 2 assignments) vs w2 (created 2025-06-01, 1).
  tabs.workers[2][3] = '2025-06-01';
  const report = runReport(tabs);
  const g = findingsFor(report, 'DUP_WORKER_NAME')[0];
  assert.strictEqual(g.recommendedKeeper, 'w1');
  assert.match(g.detail, /keep w1 — oldest id that carries assignments/);
});

test('with no member holding a placement the oldest row is recommended, and it says so', () => {
  const tabs = {
    workers: workersTab([
      ['n1', 'נועה אבן', '', '2025-05-01', '', '', '', ''],
      ['n2', 'נועה אבן', '', '2024-01-01', '', '', '', ''],
    ]),
    assignments: assignmentsTab([]),
    absences: absencesTab([]),
    coverages: coveragesTab([]),
    archive_v3: archiveTab([]),
    monthly_actuals: actualsTab([]),
    budgets: [['id', 'house', 'month', 'amount', 'created_at', 'updated_at', 'instructors_amount']],
  };
  const g = findingsFor(runReport(tabs), 'DUP_WORKER_NAME')[0];
  assert.strictEqual(g.recommendedKeeper, 'n2', 'oldest by created_at');
  assert.match(g.detail, /no member carries an assignment/);
});

test('ten duplicate rows across four groups become four findings', () => {
  // The shape of the live roster the report flagged: groups of 2, 2, 4 and 2.
  const rows = [];
  const groups = [['a', 2], ['b', 2], ['c', 4], ['d', 2]];
  groups.forEach(([tag, n]) => {
    for (let i = 0; i < n; i++) {
      rows.push([tag + i, 'שם משותף ' + tag, '', '2025-0' + (i + 1) + '-01', '', '', '', '']);
    }
  });
  const tabs = {
    workers: workersTab(rows),
    assignments: assignmentsTab([]),
    absences: absencesTab([]),
    coverages: coveragesTab([]),
    archive_v3: archiveTab([]),
    monthly_actuals: actualsTab([]),
    budgets: [['id', 'house', 'month', 'amount', 'created_at', 'updated_at', 'instructors_amount']],
  };
  const report = runReport(tabs);
  assert.strictEqual(report.byCode.DUP_WORKER_NAME, 4,
    'ten member rows, four real questions');
  const sizes = findingsFor(report, 'DUP_WORKER_NAME').map(f => f.members.length).sort();
  assert.deepStrictEqual(sizes, [2, 2, 2, 4]);
});

test('every finding carries the worker name, house and employment type', () => {
  const report = runReport(dirtyTabs());
  report.findings.forEach(f => {
    assert.ok('workerName' in f && 'houseId' in f && 'employmentType' in f,
      f.code + ' must carry the readable columns');
  });
  const missingStart = findingsFor(report, 'MISSING_START_DATE')[0];
  assert.strictEqual(missingStart.workerName, 'רונית מזרחי');
  assert.strictEqual(missingStart.houseId, 'atlantis + ofroni');

  const rate = findingsFor(report, 'MISSING_RATE').find(f => f.entityId === 'a7');
  assert.strictEqual(rate.workerName, 'מנהל״ן פלוני');
  assert.strictEqual(rate.houseId, 'pardes');
  assert.strictEqual(rate.employmentType, 'per_session');
});

test('duplicate and orphan assignments are caught', () => {
  const report = runReport(dirtyTabs());
  assert.deepStrictEqual(findingsFor(report, 'DUP_ASSIGNMENT').map(f => f.entityId).sort(), ['a1', 'a2']);
  assert.deepStrictEqual(findingsFor(report, 'ORPHAN_ASSIGNMENT').map(f => f.entityId), ['a4']);
});

test('workers with no assignment are classified against the archive', () => {
  const tabs = dirtyTabs();
  // w5 has no trace anywhere. Add w8, whose only placement is archived.
  tabs.workers.push(['w8', 'אורית דגן', '', '2024-01-01', '', '2024-01-01', '', '0509999999']);
  tabs.archive_v3.push(['arc2', 'a80', 'w8', 'אורית דגן', 'rehab', 'מדריך/ה', '', 'full_time',
    9000, 100, 0, 0, 0, 0, 0, '', '2026-06-30', 'התפטרות', '', '2026-06-30', 0, 0, 0, 0, 0, 0]);
  const report = runReport(tabs);
  const found = findingsFor(report, 'WORKER_NO_ASSIGNMENT');
  const byId = {};
  found.forEach(f => { byId[f.entityId] = f; });
  assert.deepStrictEqual(Object.keys(byId).sort(), ['w5', 'w8']);

  assert.strictEqual(byId.w5.classification, 'never_assigned');
  assert.strictEqual(byId.w5.severity, 'warn');
  assert.match(byId.w5.detail, /never assigned/);

  assert.strictEqual(byId.w8.classification, 'probably_departed');
  assert.strictEqual(byId.w8.severity, 'info');
  assert.match(byId.w8.detail, /probably departed/);
  assert.match(byId.w8.detail, /rehab/, 'the house it ended at');
  assert.match(byId.w8.detail, /2026-06-30/, 'when it ended');
  assert.strictEqual(byId.w8.houseId, 'rehab');

  assert.strictEqual(report.byClassification.never_assigned, 1);
  assert.strictEqual(report.byClassification.probably_departed, 1);
});

test('nothing is archived automatically on the strength of a classification', () => {
  // The report is a reading, not a verdict: it has no write path at all for
  // a WORKER_NO_ASSIGNMENT row, which is why computing it cannot write.
  const report = runReport(dirtyTabs());
  assert.ok(findingsFor(report, 'WORKER_NO_ASSIGNMENT').length > 0);
});

test('missing and future start dates are reported', () => {
  const report = runReport(dirtyTabs());
  assert.deepStrictEqual(findingsFor(report, 'MISSING_START_DATE').map(f => f.entityId), ['w4']);
  const future = findingsFor(report, 'FUTURE_START_ACTIVE');
  assert.deepStrictEqual(future.map(f => f.entityId), ['w3']);
  assert.match(future[0].detail, /2026-12-01/);
});

test('an archived assignment still live in the assignments tab is an error', () => {
  const report = runReport(dirtyTabs());
  const f = findingsFor(report, 'ARCHIVED_STILL_ACTIVE');
  assert.deepStrictEqual(f.map(x => x.entityId), ['a9']);
  assert.strictEqual(f[0].severity, 'error');
});

test('invalid house ids are caught on every entity that carries one', () => {
  const report = runReport(dirtyTabs());
  const houses = findingsFor(report, 'INVALID_HOUSE');
  assert.deepStrictEqual(houses.map(f => f.entityId).sort(), ['a5', 'b2']);
});

test('missing, zero and negative rates are reported', () => {
  const report = runReport(dirtyTabs());
  const missing = findingsFor(report, 'MISSING_RATE').map(f => f.entityId);
  assert.ok(missing.includes('a6'), 'hourly with no rate');
  assert.ok(missing.includes('a7'), 'per_session with no product');
  assert.deepStrictEqual(findingsFor(report, 'NEGATIVE_RATE').map(f => f.entityId), ['a8']);
});

test('smoke records and blank names are flagged', () => {
  const report = runReport(dirtyTabs());
  assert.deepStrictEqual(findingsFor(report, 'SMOKE_RECORD').map(f => f.entityId), ['w5']);
  assert.deepStrictEqual(findingsFor(report, 'BLANK_NAME').map(f => f.entityId), ['w6']);
});

test('names that would fail an exact-match sync are flagged', () => {
  const report = runReport(dirtyTabs());
  const ids = findingsFor(report, 'NAME_SYNC_RISK').map(f => f.entityId).sort();
  assert.deepStrictEqual(ids, ['w2', 'w7']);
});

test('absence overlaps, orphan links and orphan actuals are reported', () => {
  const report = runReport(dirtyTabs());
  assert.deepStrictEqual(findingsFor(report, 'ABSENCE_OVERLAP').map(f => f.entityId), ['ab1']);
  assert.deepStrictEqual(findingsFor(report, 'ORPHAN_ABSENCE').map(f => f.entityId), ['ab4']);
  assert.deepStrictEqual(findingsFor(report, 'UNSTAFFED_POSITION').map(f => f.entityId), ['ab3']);
  assert.deepStrictEqual(findingsFor(report, 'ORPHAN_COVERAGE').map(f => f.entityId), ['c2']);
  assert.deepStrictEqual(findingsFor(report, 'DANGLING_COVERAGE_LINK').map(f => f.entityId), ['c2']);
  assert.deepStrictEqual(findingsFor(report, 'ORPHAN_ACTUALS').map(f => f.entityId), ['ma2']);
});

test('findings are sorted worst-first and every code is ASCII', () => {
  const report = runReport(dirtyTabs());
  const rank = { error: 0, warn: 1, info: 2 };
  let prev = -1;
  report.findings.forEach(f => {
    assert.ok(rank[f.severity] >= prev, 'findings must be sorted by severity');
    prev = rank[f.severity];
    assert.match(f.code, /^[A-Z0-9_]+$/, 'finding codes stay ASCII: ' + f.code);
  });
  assert.strictEqual(report.bySeverity.error + report.bySeverity.warn + report.bySeverity.info,
    report.findings.length);
});

test('a missing tab is tolerated rather than throwing', () => {
  const report = runReport({ workers: workersTab([]) });
  assert.deepStrictEqual(report.counts, {
    workers: 0, assignments: 0, absences: 0, coverages: 0,
    archiveV3: 0, monthlyActuals: 0, budgets: 0,
  });
  assert.deepStrictEqual(report.findings, []);
});

// ---------------------------------------------------------------------------
// the run: two report tabs, and not one cell anywhere else
// ---------------------------------------------------------------------------

// A sandbox whose write guard allows the two report tabs and throws for
// every other tab, so a stray write to a data tab fails the test.
function runCtx(tabs) {
  const writes = [];
  const ctx = loadCtx(tabs, (op, name) => {
    writes.push({ op, name });
    if (REPORT_TABS.indexOf(name) < 0) {
      throw new Error('the report must not write to the data tab "' + name + '" (called ' + op + ')');
    }
  });
  ctx.writes = writes;
  return ctx;
}

test('runDataIntegrityReportNow writes the two report tabs and no data tab', () => {
  const lines = [];
  const ctx = runCtx(dirtyTabs());
  ctx.Logger.log = (s) => lines.push(String(s));
  const report = plain(ctx.runDataIntegrityReportNow());
  assert.ok(report.findings.length > 0);

  const written = Array.from(new Set(ctx.writes.map(w => w.name))).sort();
  assert.deepStrictEqual(written, REPORT_TABS.slice().sort(),
    'exactly the two report tabs were written');
  assert.ok(lines.some(l => /no data tab was touched/.test(l)),
    'the log must state that no data tab was touched');
});

test('the report tab is one row per finding, with a readable Hebrew header', () => {
  const ctx = runCtx(dirtyTabs());
  const report = plain(ctx.runDataIntegrityReportNow());
  const sheet = ctx.sheets['דוח תקינות'];
  const header = sheet.values[0];
  ['חומרה', 'קוד', 'שם העובד/ת', 'בית', 'סוג העסקה', 'סיווג', 'מה לעשות', 'מומלץ לשמור']
    .forEach(h => assert.ok(header.includes(h), 'header must carry ' + h));
  assert.strictEqual(sheet.values.length, report.findings.length + 1,
    'one row per finding, plus the header');

  const nameCol = header.indexOf('שם העובד/ת');
  const codeCol = header.indexOf('קוד');
  const adviceCol = header.indexOf('מה לעשות');
  const row = sheet.values.find(r => r[codeCol] === 'MISSING_START_DATE');
  assert.strictEqual(row[nameCol], 'רונית מזרחי', 'a name, not only an id');
  assert.ok(row[adviceCol].length > 0, 'and a Hebrew sentence saying what to do');
  assert.strictEqual(sheet.values[1][0], 'שגיאה', 'severity is shown in Hebrew, worst first');
});

test('a re-run overwrites the report tab rather than appending to it', () => {
  const ctx = runCtx(dirtyTabs());
  ctx.runDataIntegrityReportNow();
  const first = ctx.sheets['דוח תקינות'].values.length;
  ctx.runDataIntegrityReportNow();
  assert.strictEqual(ctx.sheets['דוח תקינות'].values.length, first,
    'the tab is cleared and rewritten, never appended to');
});

test('writing anywhere but the two report tabs is refused by name', () => {
  const ctx = runCtx(dirtyTabs());
  assert.throws(() => ctx.integrityWriteReportTab_('workers', [['x']]),
    /refusing to write to "workers"/);
  assert.throws(() => ctx.integrityWriteReportTab_('assignments', [['x']]),
    /refusing to write/);
});

// ---------------------------------------------------------------------------
// the cleanup worksheet
// ---------------------------------------------------------------------------

test('the cleanup tab offers one decision row per group or record, with an empty החלטה', () => {
  const ctx = runCtx(dirtyTabs());
  const report = plain(ctx.runDataIntegrityReportNow());
  const sheet = ctx.sheets['ניקוי נתונים'];
  const header = sheet.values[0];
  assert.ok(header.includes('החלטה'), 'the decision column exists');
  assert.ok(header.includes('מפתח'), 'and the key that carries it across runs');

  const decisionCol = header.indexOf('החלטה');
  const rows = sheet.values.slice(1);
  rows.forEach(r => assert.strictEqual(r[decisionCol], '', 'every decision starts empty'));

  const cleanupCodes = ['DUP_WORKER_NAME', 'DUP_WORKER_PHONE', 'SMOKE_RECORD',
    'WORKER_NO_ASSIGNMENT', 'BLANK_NAME'];
  const expected = report.findings.filter(f => cleanupCodes.includes(f.code)).length;
  assert.strictEqual(rows.length, expected);
  // One row per duplicate GROUP — the four members of a group share one row.
  assert.strictEqual(rows.filter(r => r[0] === 'DUP_WORKER_NAME').length, 1);
});

test('the החלטה column is a dropdown of exactly the four decisions', () => {
  const ctx = runCtx(dirtyTabs());
  ctx.runDataIntegrityReportNow();
  const sheet = ctx.sheets['ניקוי נתונים'];
  assert.strictEqual(sheet.validations.length, 1, 'one validation, on one column');
  const v = sheet.validations[0];
  assert.strictEqual(v.c, sheet.values[0].indexOf('החלטה') + 1);
  assert.deepStrictEqual(plain(v.rule.values), ['השאר', 'מזג', 'העבר לארכיב', 'תקן']);
  assert.strictEqual(v.rule.allowInvalid, false, 'a typed decision must be impossible');
});

test('a decision already entered survives the next run', () => {
  const ctx = runCtx(dirtyTabs());
  ctx.runDataIntegrityReportNow();
  const sheet = ctx.sheets['ניקוי נתונים'];
  const decisionCol = sheet.values[0].indexOf('החלטה');
  const noteCol = sheet.values[0].indexOf('הערה');
  const target = sheet.values.findIndex(r => r[0] === 'DUP_WORKER_NAME');
  sheet.values[target][decisionCol] = 'מזג';
  sheet.values[target][noteCol] = 'אותה עובדת';

  ctx.runDataIntegrityReportNow();
  const after = ctx.sheets['ניקוי נתונים'].values.find(r => r[0] === 'DUP_WORKER_NAME');
  assert.strictEqual(after[decisionCol], 'מזג', 'a rebuild must not erase a decision');
  assert.strictEqual(after[noteCol], 'אותה עובדת');
});
