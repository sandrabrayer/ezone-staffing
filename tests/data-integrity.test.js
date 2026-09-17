'use strict';

// Guards for runDataIntegrityReportNow() / computeDataIntegrityReport_ in
// apps-script/Code.gs — the Phase 0 read-only diagnostic.
//
// Code.gs has no JS harness, so (as in tests/coordinators-endpoint.test.js)
// it is evaluated in a vm sandbox with the Apps Script services mocked, and
// the pure computation is driven against in-memory fixtures.
//
// The hard rules pinned here:
//   - READ ONLY: computing the report performs ZERO sheet writes. The
//     sandbox's Range mock throws on setValue/setValues, so any write at
//     all fails the test. (This is why the report uses
//     readAbsencesReadOnly_ instead of readAbsencesSafe, whose lazy status
//     correction writes back to the sheet.)
//   - Every check the brief asks for is present and fires on a seeded row.
//   - Finding codes stay ASCII (stored values are ASCII; Hebrew is display
//     only).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const gs = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');

// A sheet mock over a 2-D array of values. Every write path throws, so the
// read-only contract is enforced by construction rather than by inspection.
function sheetMock(values, writeGuard) {
  function range() {
    return {
      getValues() { return values; },
      getValue() { return values[0] && values[0][0]; },
      setValue() { writeGuard('setValue'); },
      setValues() { writeGuard('setValues'); },
      setNumberFormat() { writeGuard('setNumberFormat'); return this; },
    };
  }
  return {
    getDataRange: range,
    getRange: range,
    getLastRow() { return values.length; },
    setFrozenRows() { writeGuard('setFrozenRows'); },
  };
}

function loadCtx(tabs, onWrite) {
  const writeGuard = onWrite || function (op) {
    throw new Error('the integrity report must not write to the sheet (called ' + op + ')');
  };
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
      openById() {
        return {
          getSheetByName(name) {
            return Object.prototype.hasOwnProperty.call(tabs, name)
              ? sheetMock(tabs[name], writeGuard)
              : null;
          },
          insertSheet() { writeGuard('insertSheet'); },
        };
      },
    },
  });
  vm.runInContext(gs, ctx);
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

test('duplicate workers are caught by normalized name and by phone', () => {
  const report = runReport(dirtyTabs());
  const byName = findingsFor(report, 'DUP_WORKER_NAME').map(f => f.entityId).sort();
  assert.deepStrictEqual(byName, ['w1', 'w2'], 'padding and double spaces must not hide a duplicate');
  const byPhone = findingsFor(report, 'DUP_WORKER_PHONE').map(f => f.entityId).sort();
  assert.deepStrictEqual(byPhone, ['w3', 'w4'], 'dashes must not hide a duplicate phone');
});

test('duplicate and orphan assignments are caught', () => {
  const report = runReport(dirtyTabs());
  assert.deepStrictEqual(findingsFor(report, 'DUP_ASSIGNMENT').map(f => f.entityId).sort(), ['a1', 'a2']);
  assert.deepStrictEqual(findingsFor(report, 'ORPHAN_ASSIGNMENT').map(f => f.entityId), ['a4']);
});

test('workers with no assignment are reported', () => {
  const report = runReport(dirtyTabs());
  assert.deepStrictEqual(findingsFor(report, 'WORKER_NO_ASSIGNMENT').map(f => f.entityId), ['w5']);
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

test('runDataIntegrityReportNow logs and writes nothing', () => {
  const lines = [];
  const tabs = dirtyTabs();
  const ctx = loadCtx(tabs);
  ctx.Logger.log = (s) => lines.push(String(s));
  const report = plain(ctx.runDataIntegrityReportNow());
  assert.ok(report.findings.length > 0);
  assert.ok(lines.some(l => /READ-ONLY: nothing was written/.test(l)),
    'the log must state that nothing was written');
});
