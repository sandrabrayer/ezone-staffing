'use strict';

// Phase 2 — prevention. Every guard that stops bad data being created in the
// first place, rather than reported afterwards by the Phase 0 integrity
// report.
//
// apps-script/Code.gs has no JS harness, so it is evaluated in a vm sandbox
// over in-memory sheets (same recipe as tests/coordinators-endpoint.test.js).
// The sheets are real enough to be written to, so a guard that fails to fire
// leaves visible evidence in the rows.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const gs = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');

// A writable in-memory sheet. rows[0] is the header row.
function fakeSheet(rows) {
  const formats = {};
  const sh = {
    rows, formats,
    getDataRange() { return { getValues: () => rows.map(r => r.slice()) }; },
    getLastRow() { return rows.length; },
    getLastColumn() { return rows.reduce((m, r) => Math.max(m, r.length), 0); },
    setFrozenRows() {},
    appendRow(r) { rows.push(r.slice()); },
    deleteRow(r) { rows.splice(r - 1, 1); },
    getRange(r, c, nr, nc) {
      const range = {
        getValue() { return (rows[r - 1] || [])[c - 1]; },
        getValues() {
          const out = [];
          for (let i = 0; i < (nr || 1); i++) {
            const row = rows[r - 1 + i] || [];
            const v = [];
            for (let j = 0; j < (nc || 1); j++) v.push(row[c - 1 + j] === undefined ? '' : row[c - 1 + j]);
            out.push(v);
          }
          return out;
        },
        setValue(v) { while (rows.length < r) rows.push([]); rows[r - 1][c - 1] = v; return range; },
        setValues(vals) {
          vals.forEach((row, i) => {
            while (rows.length < r + i) rows.push([]);
            row.forEach((v, j) => { rows[r - 1 + i][c - 1 + j] = v; });
          });
          return range;
        },
        setNumberFormat(f) { formats[r + ':' + c] = f; return range; },
      };
      return range;
    },
  };
  return sh;
}

const H = {
  workers: ['id', 'name', 'notes', 'created_at', 'shift_commitment', 'start_date', 'gmach_month', 'phone'],
  assignments: ['id', 'worker_id', 'house', 'role', 'role_detail', 'employment_type',
    'salary', 'pct', 'hourly_rate', 'est_hours', 'session_rate', 'est_sessions',
    'retainer_amount', 'notes', 'created_at', 'allowance', 'status', 'status_date',
    'rate_individual', 'sessions_individual', 'rate_group', 'sessions_group',
    'rate_external', 'external_patients', 'effective_from',
    'weekday_min', 'weekend_min', 'allowed_shifts'],
  absences: ['id', 'worker_id', 'house', 'start_date', 'end_date', 'reason_type',
    'reason_detail', 'notes', 'status', 'created_at'],
  coverages: ['id', 'absence_id', 'covering_worker_id', 'covering_house', 'receiving_house',
    'start_date', 'end_date', 'extra_payment', 'notes', 'created_at',
    'replaced_assignment_id', 'role', 'shift_count', 'approval_status', 'approved_by', 'cancelled'],
  archive_v3: ['id', 'assignment_id', 'worker_id', 'name', 'house', 'role', 'role_detail',
    'employment_type', 'salary', 'pct', 'hourly_rate', 'est_hours', 'session_rate',
    'est_sessions', 'retainer_amount', 'notes', 'termination_date', 'reason_type',
    'reason_detail', 'archived_at', 'rate_individual', 'sessions_individual',
    'rate_group', 'sessions_group', 'rate_external', 'external_patients'],
  audit_log: ['ts', 'action', 'entity', 'entity_id', 'field', 'before', 'after', 'reason'],
};

const TODAY = '2026-09-17';

// Build a sandbox over a set of tabs. Missing tabs are created empty on
// demand, which is how insertSheet behaves for the audit log.
function loadCtx(seed) {
  const tabs = {};
  Object.keys(seed || {}).forEach(k => { tabs[k] = fakeSheet(seed[k].map(r => r.slice())); });
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
        return iso;
      },
    },
    Session: { getScriptTimeZone() { return 'UTC'; } },
    SpreadsheetApp: {
      openById() {
        return {
          getSheetByName(name) { return tabs[name] || null; },
          insertSheet(name) { tabs[name] = fakeSheet([]); return tabs[name]; },
        };
      },
    },
  });
  vm.runInContext(gs, ctx);
  // Freeze "today" so date-dependent guards are reproducible.
  ctx.todayLocal = () => TODAY;
  ctx.tabs = tabs;
  return ctx;
}

function plain(v) { return JSON.parse(JSON.stringify(v)); }

// `const` declarations inside a vm script live in its lexical scope, not on
// the context object, so they are read back by evaluating the name. Values
// also come from another realm, so they are round-tripped through JSON to be
// comparable with deepStrictEqual.
function constOf(ctx, name) { return plain(vm.runInContext(name, ctx)); }

function baseSeed(over) {
  return Object.assign({
    workers: [H.workers],
    assignments: [H.assignments],
    absences: [H.absences],
    coverages: [H.coverages],
    archive_v3: [H.archive_v3],
  }, over || {});
}

function workerRow(id, name, phone, startDate) {
  return [id, name, '', '2025-01-01', '', startDate || '2020-01-01', '', phone || ''];
}
function asgRow(id, workerId, house, over) {
  const r = [id, workerId, house, 'מדריך/ה', '', 'full_time', 10000, 100, 0, 0, 0, 0, 0,
    '', '2020-01-01T00:00:00.000Z', 0, 'active', '', 0, 0, 0, 0, 0, 0, ''];
  Object.keys(over || {}).forEach(k => { r[Number(k)] = over[k]; });
  return r;
}

// ---------------------------------------------------------------------------
// duplicate guard on add worker
// ---------------------------------------------------------------------------

test('createWorker refuses a duplicate NAME and names the matching row', () => {
  const ctx = loadCtx(baseSeed({ workers: [H.workers, workerRow('w1', 'דנה כהן', '0501111111')] }));
  let err = null;
  try { ctx.createWorker({ worker: { name: 'דנה כהן' } }); } catch (e) { err = e; }
  assert.ok(err, 'expected a refusal');
  assert.strictEqual(err.status, 409);
  assert.deepStrictEqual(plain(err.duplicates).map(d => d.id), ['w1']);
  assert.strictEqual(ctx.tabs.workers.rows.length, 2, 'nothing was written');
});

test('the duplicate guard sees through padding, double spaces and gershayim', () => {
  const ctx = loadCtx(baseSeed({ workers: [H.workers, workerRow('w1', 'מנהל״ן פלוני', '')] }));
  // Padded, double-spaced, and with an ASCII quote instead of the gershayim.
  assert.throws(() => ctx.createWorker({ worker: { name: '  מנהל"ן   פלוני ' } }), /409|קיים/);
});

test('createWorker refuses a duplicate PHONE even under a different name', () => {
  const ctx = loadCtx(baseSeed({ workers: [H.workers, workerRow('w1', 'דנה כהן', '0501234567')] }));
  let err = null;
  try { ctx.createWorker({ worker: { name: 'שם אחר לגמרי', phone: '050-123-4567' } }); } catch (e) { err = e; }
  assert.ok(err);
  assert.deepStrictEqual(plain(err.duplicates), [{ id: 'w1', name: 'דנה כהן', matchedOn: 'phone' }]);
});

test('confirmDuplicate:true is the ONLY way through, and it is recorded', () => {
  const ctx = loadCtx(baseSeed({ workers: [H.workers, workerRow('w1', 'דנה כהן', '')] }));
  const res = plain(ctx.createWorker({ worker: { name: 'דנה כהן' }, confirmDuplicate: true }));
  assert.strictEqual(res.ok, true);
  assert.strictEqual(ctx.tabs.workers.rows.length, 3);
  const audit = ctx.tabs.audit_log.rows;
  assert.ok(audit.length >= 1, 'the audit log records the create');
  const row = audit[audit.length - 1];
  assert.match(String(row[7]), /confirmed duplicate of w1/, 'the reason says it was confirmed');
});

test('a truthy-but-not-true confirmDuplicate does NOT open the guard', () => {
  const ctx = loadCtx(baseSeed({ workers: [H.workers, workerRow('w1', 'דנה כהן', '')] }));
  ['yes', 1, 'true', {}].forEach(v => {
    assert.throws(() => ctx.createWorker({ worker: { name: 'דנה כהן' }, confirmDuplicate: v }),
      /409|קיים/, 'confirmDuplicate=' + JSON.stringify(v) + ' must not bypass the guard');
  });
});

test('a first, non-duplicate worker is created with no friction', () => {
  const ctx = loadCtx(baseSeed());
  const res = plain(ctx.createWorker({ worker: { name: 'עובדת ראשונה', phone: '0501111111' } }));
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.duplicates, []);
});

// ---------------------------------------------------------------------------
// transfer = end the old placement + start a new one
// ---------------------------------------------------------------------------

test('moveAssignment ENDS the old placement and STARTS a new one, same workerId', () => {
  const ctx = loadCtx(baseSeed({
    workers: [H.workers, workerRow('w1', 'עוברת בית', '')],
    assignments: [H.assignments, asgRow('a1', 'w1', 'ramot')],
  }));
  const res = plain(ctx.moveAssignment({ id: 'a1', house: 'asher', effectiveFrom: '2026-09-15' }));

  assert.strictEqual(res.ok, true);
  assert.notStrictEqual(res.assignment.id, 'a1', 'the new placement gets a new id');
  assert.strictEqual(res.assignment.workerId, 'w1', 'the same person throughout');
  assert.strictEqual(res.assignment.house, 'asher');
  assert.strictEqual(res.assignment.effectiveFrom, '2026-09-15');
  assert.strictEqual(res.assignment.salary, 10000, 'terms carry over');
  assert.strictEqual(res.previousAssignmentId, 'a1');

  // History survives: an archive row for the OLD placement.
  const arc = ctx.tabs.archive_v3.rows;
  assert.strictEqual(arc.length, 2);
  assert.strictEqual(arc[1][1], 'a1', 'archived under the old assignment id');
  assert.strictEqual(arc[1][4], 'ramot', 'at the house they left');
  assert.strictEqual(arc[1][16], '2026-09-14', 'last paid day is the day before the transfer');
  assert.strictEqual(arc[1][17], 'מעבר תפקיד');

  // Exactly one live placement, at the new house.
  const live = ctx.tabs.assignments.rows.slice(1);
  assert.strictEqual(live.length, 1);
  assert.strictEqual(live[0][2], 'asher');
});

test('a transfer leaves no gap and no overlap between the two placements', () => {
  const ctx = loadCtx(baseSeed({
    workers: [H.workers, workerRow('w1', 'עוברת בית', '')],
    assignments: [H.assignments, asgRow('a1', 'w1', 'ramot')],
  }));
  const res = plain(ctx.moveAssignment({ id: 'a1', house: 'asher', effectiveFrom: '2026-10-01' }));
  // Crossing a month boundary: the old placement's last day is Sep 30.
  assert.strictEqual(ctx.tabs.archive_v3.rows[1][16], '2026-09-30');
  assert.strictEqual(res.assignment.effectiveFrom, '2026-10-01');
});

test('a transfer with no date defaults to today', () => {
  const ctx = loadCtx(baseSeed({
    workers: [H.workers, workerRow('w1', 'עוברת בית', '')],
    assignments: [H.assignments, asgRow('a1', 'w1', 'ramot')],
  }));
  const res = plain(ctx.moveAssignment({ id: 'a1', house: 'asher' }));
  assert.strictEqual(res.assignment.effectiveFrom, TODAY);
  assert.strictEqual(ctx.tabs.archive_v3.rows[1][16], '2026-09-16');
});

test('a transfer to a house the worker already works at is refused', () => {
  const ctx = loadCtx(baseSeed({
    workers: [H.workers, workerRow('w1', 'עוברת בית', '')],
    assignments: [H.assignments, asgRow('a1', 'w1', 'ramot'), asgRow('a2', 'w1', 'asher')],
  }));
  assert.throws(() => ctx.moveAssignment({ id: 'a1', house: 'asher' }), /already assigned/);
  assert.strictEqual(ctx.tabs.archive_v3.rows.length, 1, 'nothing archived');
});

test('a transfer truncates an absence at the house being left', () => {
  const ctx = loadCtx(baseSeed({
    workers: [H.workers, workerRow('w1', 'עוברת בית', '')],
    assignments: [H.assignments, asgRow('a1', 'w1', 'ramot')],
    absences: [H.absences,
      ['ab1', 'w1', 'ramot', '2026-09-01', '2026-09-30', 'מחלה', '', '', 'active', '2026-09-01']],
  }));
  ctx.moveAssignment({ id: 'a1', house: 'asher', effectiveFrom: '2026-09-15' });
  assert.strictEqual(ctx.tabs.absences.rows[1][4], '2026-09-14', 'absence ends with the placement');
});

test('a transfer is recorded in the audit log, both sides', () => {
  const ctx = loadCtx(baseSeed({
    workers: [H.workers, workerRow('w1', 'עוברת בית', '')],
    assignments: [H.assignments, asgRow('a1', 'w1', 'ramot')],
  }));
  ctx.moveAssignment({ id: 'a1', house: 'asher', effectiveFrom: '2026-09-15' });
  const rows = ctx.tabs.audit_log.rows;
  const fields = rows.map(r => r[4]);
  assert.ok(fields.includes('house'));
  assert.ok(fields.includes('termination_date'));
  assert.ok(fields.includes('effective_from'));
  const houseRow = rows.find(r => r[4] === 'house');
  assert.strictEqual(houseRow[5], 'ramot', 'before');
  assert.strictEqual(houseRow[6], 'asher', 'after');
});

// ---------------------------------------------------------------------------
// termination
// ---------------------------------------------------------------------------

test('terminateAssignment turns a missing reason into the explicit לא צוין', () => {
  const ctx = loadCtx(baseSeed({
    workers: [H.workers, workerRow('w1', 'יוצאת', '')],
    assignments: [H.assignments, asgRow('a1', 'w1', 'ramot')],
  }));
  const res = plain(ctx.terminateAssignment({ id: 'a1', terminationDate: '2026-09-30' }));
  assert.strictEqual(res.archive.reasonType, 'לא צוין');
  assert.strictEqual(ctx.tabs.archive_v3.rows[1][17], 'לא צוין');
});

test('terminateAssignment still rejects an off-enum reason', () => {
  const ctx = loadCtx(baseSeed({
    workers: [H.workers, workerRow('w1', 'יוצאת', '')],
    assignments: [H.assignments, asgRow('a1', 'w1', 'ramot')],
  }));
  assert.throws(() => ctx.terminateAssignment({
    id: 'a1', terminationDate: '2026-09-30', reasonType: 'כי בא לי',
  }), /bad reasonType/);
});

test('terminateAssignment is idempotent: never a second archive row', () => {
  const ctx = loadCtx(baseSeed({
    workers: [H.workers, workerRow('w1', 'יוצאת', '')],
    assignments: [H.assignments, asgRow('a1', 'w1', 'ramot'), asgRow('a1', 'w1', 'ramot')],
  }));
  ctx.terminateAssignment({ id: 'a1', terminationDate: '2026-09-30', reasonType: 'התפטרות' });
  assert.strictEqual(ctx.tabs.archive_v3.rows.length, 2);
  // The duplicate live row is still there (that is the ARCHIVED_STILL_ACTIVE
  // state the integrity report flags) — terminating again must NOT archive it
  // a second time, which would double the cost.
  let err = null;
  try { ctx.terminateAssignment({ id: 'a1', terminationDate: '2026-09-30', reasonType: 'התפטרות' }); }
  catch (e) { err = e; }
  assert.ok(err, 'the second call is refused');
  assert.strictEqual(err.status, 409);
  assert.ok(err.archiveId, 'and it points at the existing archive row');
  assert.strictEqual(ctx.tabs.archive_v3.rows.length, 2, 'still exactly one archive row');
});

// ---------------------------------------------------------------------------
// absences
// ---------------------------------------------------------------------------

test('a not-yet-started absence is FUTURE, not ended', () => {
  const ctx = loadCtx(baseSeed({
    workers: [H.workers, workerRow('w1', 'נעדרת', '')],
    assignments: [H.assignments, asgRow('a1', 'w1', 'ramot')],
  }));
  const res = plain(ctx.logAbsence({ absence: {
    workerId: 'w1', house: 'ramot', startDate: '2026-12-01', endDate: '2026-12-10',
    reasonType: 'חופשה' } }));
  assert.strictEqual(res.absence.status, 'future');
  assert.strictEqual(ctx.tabs.absences.rows[1][8], 'future');
});

test('an overlapping FUTURE absence is blocked — the Phase 2 fix', () => {
  // Before Phase 2 the overlap guard required status==='active', and a
  // future absence was stored as 'ended', so two overlapping planned
  // absences were BOTH accepted and the same leave was recorded twice.
  const ctx = loadCtx(baseSeed({
    workers: [H.workers, workerRow('w1', 'נעדרת', '')],
    assignments: [H.assignments, asgRow('a1', 'w1', 'ramot')],
    absences: [H.absences,
      ['ab1', 'w1', 'ramot', '2026-12-01', '2026-12-10', 'חופשה', '', '', 'future', '2026-09-01']],
  }));
  let err = null;
  try {
    ctx.logAbsence({ absence: {
      workerId: 'w1', house: 'ramot', startDate: '2026-12-05', endDate: '2026-12-20',
      reasonType: 'מחלה' } });
  } catch (e) { err = e; }
  assert.ok(err, 'the overlap must be refused');
  assert.strictEqual(err.status, 409);
  assert.strictEqual(err.conflictId, 'ab1');
  assert.strictEqual(ctx.tabs.absences.rows.length, 2, 'nothing was written');
});

test('an overlapping PAST absence is blocked too', () => {
  const ctx = loadCtx(baseSeed({
    workers: [H.workers, workerRow('w1', 'נעדרת', '')],
    assignments: [H.assignments, asgRow('a1', 'w1', 'ramot')],
    absences: [H.absences,
      ['ab1', 'w1', 'ramot', '2026-03-01', '2026-03-10', 'מחלה', '', '', 'ended', '2026-03-01']],
  }));
  assert.throws(() => ctx.logAbsence({ absence: {
    workerId: 'w1', house: 'ramot', startDate: '2026-03-05', endDate: '2026-03-08',
    reasonType: 'חופשה' } }), /409|היעדרות/);
});

test('a non-overlapping absence at the same house is accepted', () => {
  const ctx = loadCtx(baseSeed({
    workers: [H.workers, workerRow('w1', 'נעדרת', '')],
    assignments: [H.assignments, asgRow('a1', 'w1', 'ramot')],
    absences: [H.absences,
      ['ab1', 'w1', 'ramot', '2026-12-01', '2026-12-10', 'חופשה', '', '', 'future', '2026-09-01']],
  }));
  const res = plain(ctx.logAbsence({ absence: {
    workerId: 'w1', house: 'ramot', startDate: '2026-12-11', endDate: '2026-12-20',
    reasonType: 'מחלה' } }));
  assert.strictEqual(res.ok, true);
});

test('unstaffed positions may overlap each other — they are slots, not people', () => {
  const ctx = loadCtx(baseSeed({
    absences: [H.absences,
      ['ab1', '', 'ramot', '2026-09-01', '2026-09-30', 'צורך תפעולי', '', '', 'active', '2026-09-01']],
  }));
  const res = plain(ctx.logAbsence({ absence: {
    workerId: '', house: 'ramot', startDate: '2026-09-05', endDate: '2026-09-25',
    reasonType: 'צורך תפעולי' } }));
  assert.strictEqual(res.ok, true, 'two unfilled slots at one house is a real situation');
});

// ---------------------------------------------------------------------------
// coverages
// ---------------------------------------------------------------------------

function coverageSeed(extra) {
  return baseSeed(Object.assign({
    workers: [H.workers, workerRow('w1', 'מחליף', ''), workerRow('w2', 'נעדר', '')],
    assignments: [H.assignments, asgRow('a1', 'w1', 'asher'), asgRow('a2', 'w2', 'ramot')],
  }, extra || {}));
}
const COVERAGE = {
  coveringWorkerId: 'w1', coveringHouse: 'asher', receivingHouse: 'ramot',
  startDate: '2026-09-05', endDate: '2026-09-12', extraPayment: 800,
};

test('a coverage stores the appended fields, and defaults cleanly', () => {
  const ctx = loadCtx(coverageSeed());
  const res = plain(ctx.addCoverage({ coverage: Object.assign({}, COVERAGE, {
    replacedAssignmentId: 'a2', role: 'מדריך/ה', shiftCount: 6,
    approvalStatus: 'approved', approvedBy: 'מורן',
  }) }));
  assert.strictEqual(res.ok, true);
  const row = ctx.tabs.coverages.rows[1];
  assert.strictEqual(row[10], 'a2', 'replaced_assignment_id');
  assert.strictEqual(row[11], 'מדריך/ה', 'role');
  assert.strictEqual(row[12], 6, 'shift_count');
  assert.strictEqual(row[13], 'approved', 'approval_status');
  assert.strictEqual(row[14], 'מורן', 'approved_by');
  assert.strictEqual(row[15], 'false', 'cancelled');

  const bare = loadCtx(coverageSeed());
  bare.addCoverage({ coverage: COVERAGE });
  assert.strictEqual(bare.tabs.coverages.rows[1][13], 'pending', 'approval defaults to pending');
});

test('a coverage naming a replaced assignment at the WRONG house is refused', () => {
  const ctx = loadCtx(coverageSeed());
  assert.throws(() => ctx.addCoverage({ coverage: Object.assign({}, COVERAGE, {
    replacedAssignmentId: 'a1',   // a1 is at asher, the COVERING house
  }) }), /409|בית היעד/);
});

test('a re-submitted identical coverage is not paid twice', () => {
  const ctx = loadCtx(coverageSeed());
  const first = plain(ctx.addCoverage({ coverage: COVERAGE }));
  const second = plain(ctx.addCoverage({ coverage: COVERAGE }));
  assert.strictEqual(second.duplicate, true);
  assert.strictEqual(second.coverage.id, first.coverage.id);
  assert.strictEqual(ctx.tabs.coverages.rows.length, 2, 'one row, one payment');
});

test('one person cannot cover two places at once', () => {
  const ctx = loadCtx(coverageSeed());
  ctx.addCoverage({ coverage: COVERAGE });
  let err = null;
  try {
    ctx.addCoverage({ coverage: Object.assign({}, COVERAGE, {
      receivingHouse: 'rehab', startDate: '2026-09-10', endDate: '2026-09-15' }) });
  } catch (e) { err = e; }
  assert.ok(err);
  assert.strictEqual(err.status, 409);
  assert.ok(err.conflictId);
  assert.strictEqual(ctx.tabs.coverages.rows.length, 2);
});

test('a worker who is themselves absent cannot be the one covering', () => {
  const ctx = loadCtx(coverageSeed({
    absences: [H.absences,
      ['ab1', 'w1', 'asher', '2026-09-08', '2026-09-20', 'מחלה', '', '', 'active', '2026-09-01']],
  }));
  let err = null;
  try { ctx.addCoverage({ coverage: COVERAGE }); } catch (e) { err = e; }
  assert.ok(err, 'paying an extra to someone who was not there is the mistake this prevents');
  assert.strictEqual(err.conflictId, 'ab1');
});

test('a worker on חל"ת is not available to cover', () => {
  const ctx = loadCtx(coverageSeed({
    workers: [H.workers, workerRow('w1', 'מחליף', ''), workerRow('w2', 'נעדר', '')],
    assignments: [H.assignments, asgRow('a1', 'w1', 'asher', { 16: 'chlt' }), asgRow('a2', 'w2', 'ramot')],
  }));
  assert.throws(() => ctx.addCoverage({ coverage: COVERAGE }), /חל/);
});

test('deleteCoverage CANCELS, keeping the row and the history', () => {
  const ctx = loadCtx(coverageSeed());
  const added = plain(ctx.addCoverage({ coverage: COVERAGE }));
  const res = plain(ctx.deleteCoverage({ id: added.coverage.id, reason: 'בוטל על ידי מורן' }));
  assert.strictEqual(res.cancelled, true);
  assert.strictEqual(ctx.tabs.coverages.rows.length, 2, 'the row survives');
  assert.strictEqual(ctx.tabs.coverages.rows[1][15], 'true');
  const audit = ctx.tabs.audit_log.rows.find(r => r[4] === 'cancelled');
  assert.ok(audit, 'the cancellation is on the record');
  assert.strictEqual(audit[7], 'בוטל על ידי מורן');
});

test('cancelling twice is a no-op, not an error', () => {
  const ctx = loadCtx(coverageSeed());
  const added = plain(ctx.addCoverage({ coverage: COVERAGE }));
  ctx.deleteCoverage({ id: added.coverage.id });
  const again = plain(ctx.deleteCoverage({ id: added.coverage.id }));
  assert.strictEqual(again.alreadyCancelled, true);
});

test('a cancelled coverage no longer blocks a replacement for the same slot', () => {
  const ctx = loadCtx(coverageSeed());
  const added = plain(ctx.addCoverage({ coverage: COVERAGE }));
  ctx.deleteCoverage({ id: added.coverage.id });
  const res = plain(ctx.addCoverage({ coverage: COVERAGE }));
  assert.strictEqual(res.ok, true);
  assert.notStrictEqual(res.coverage.id, added.coverage.id);
  assert.strictEqual(res.duplicate, undefined, 'a fresh row, not the cancelled one');
});

test('an off-enum approval status or role is rejected', () => {
  const ctx = loadCtx(coverageSeed());
  assert.throws(() => ctx.addCoverage({ coverage: Object.assign({}, COVERAGE,
    { approvalStatus: 'maybe' }) }), /bad approvalStatus/);
  assert.throws(() => ctx.addCoverage({ coverage: Object.assign({}, COVERAGE,
    { role: 'שוליית הקוסם' }) }), /bad role/);
});

// ---------------------------------------------------------------------------
// audit log
// ---------------------------------------------------------------------------

test('the audit log is append-only and never loses a row', () => {
  const ctx = loadCtx(coverageSeed());
  ctx.addCoverage({ coverage: COVERAGE });
  const afterFirst = ctx.tabs.audit_log.rows.length;
  ctx.deleteCoverage({ id: ctx.tabs.coverages.rows[1][0] });
  assert.ok(ctx.tabs.audit_log.rows.length > afterFirst, 'rows only ever grow');
  assert.deepStrictEqual(ctx.tabs.audit_log.rows[0], H.audit_log,
    'the header row is written once, on creation');
});

test('an audit failure never fails the mutation it was describing', () => {
  const ctx = loadCtx(coverageSeed());
  // Make the audit sheet unwritable, exactly as a permissions problem would.
  ctx.auditSheet_ = () => { throw new Error('no access to the audit tab'); };
  const res = plain(ctx.addCoverage({ coverage: COVERAGE }));
  assert.strictEqual(res.ok, true, 'Moran\'s save must not fail because logging did');
  assert.strictEqual(ctx.tabs.coverages.rows.length, 2);
});

test('the audit log records only the fields that actually changed', () => {
  const ctx = loadCtx(baseSeed());
  const diff = plain(ctx.auditDiff_('updateWorker', 'worker', 'w1',
    { name: 'דנה', phone: '0501111111' },
    { name: 'דנה כהן', phone: '0501111111' },
    ['name', 'phone'], 'שינוי שם'));
  assert.strictEqual(diff.length, 1, 'phone did not change, so it is not logged');
  assert.strictEqual(diff[0].field, 'name');
  assert.strictEqual(diff[0].before, 'דנה');
  assert.strictEqual(diff[0].after, 'דנה כהן');
  assert.strictEqual(diff[0].reason, 'שינוי שם');
});

// ---------------------------------------------------------------------------
// frozen contracts still hold
// ---------------------------------------------------------------------------

test('every appended column is at the END of its header array', () => {
  const ctx = loadCtx(baseSeed());
  const asg = constOf(ctx, 'HEADERS_ASSIGNMENTS');
  const cov = constOf(ctx, 'HEADERS_COVERAGES');
  assert.deepStrictEqual(asg, H.assignments);
  assert.deepStrictEqual(cov, H.coverages);
  assert.deepStrictEqual(constOf(ctx, 'HEADERS_AUDIT_LOG'), H.audit_log);
  // The columns that existed before Phase 2 keep their exact positions.
  // effective_from was appended at 24; 25-27 are RETIRED reserved positions
  // (the dropped guide shift minimum) — kept so they are never reused.
  assert.strictEqual(asg.indexOf('effective_from'), 24);
  assert.deepStrictEqual(asg.slice(25), ['weekday_min', 'weekend_min', 'allowed_shifts']);
  ['id', 'absence_id', 'covering_worker_id', 'covering_house', 'receiving_house',
    'start_date', 'end_date', 'extra_payment', 'notes', 'created_at']
    .forEach((h, i) => assert.strictEqual(cov[i], h, h + ' must stay at index ' + i));
});

test('a legacy coverage row with no approval cell reads as approved, not pending', () => {
  const ctx = loadCtx(baseSeed({
    coverages: [H.coverages.slice(0, 10),
      ['c1', '', 'w1', 'asher', 'ramot', '2026-09-01', '2026-09-05', 500, '', '2026-09-01']],
  }));
  const rows = plain(ctx.readCoveragesSafe());
  assert.strictEqual(rows[0].approvalStatus, 'approved',
    'a row written before the field existed is not a backlog item');
  assert.strictEqual(rows[0].cancelled, false, 'and it is not silently cancelled');
  assert.strictEqual(rows[0].extraPayment, 500, 'its payment is unchanged');
});
