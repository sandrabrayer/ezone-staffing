'use strict';

// applyCleanupDecisionsNow(dryRun) — the guided cleanup in apps-script/Code.gs.
//
// The rules pinned here, in the order they matter:
//   - DRY RUN BY DEFAULT. Called with no argument, or with anything other
//     than the literal `false`, it writes NOTHING: not a worker row, not an
//     assignment, not an audit entry. The sandbox counts every write, so a
//     single stray one fails the test.
//   - MERGE keeps the chosen id, moves the other members' assignments,
//     absences and coverages onto it, and ARCHIVES the emptied rows. A
//     worker row is MOVED to workers_archive — never deleted — and the
//     reason travels with it.
//   - A merge that would put two placements at the SAME house on one worker
//     is refused, because that is the double count the integrity report
//     exists to find.
//   - ARCHIVE is refused while the worker still holds a live assignment.
//   - השאר and תקן do nothing at all.
//   - Everything applied lands in the audit log.
//
// Code.gs has no JS harness, so it is evaluated in a vm sandbox over
// in-memory sheets (same recipe as tests/prevention.test.js).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const gs = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');

// A writable in-memory sheet that also counts its writes. rows[0] is the
// header row.
function fakeSheet(name, rows, writes) {
  const validations = [];
  function note(op) { writes.push({ op, name }); }
  const sh = {
    name, rows, validations,
    getDataRange() { return { getValues: () => rows.map(r => r.slice()) }; },
    getLastRow() { return rows.length; },
    getLastColumn() { return rows.reduce((m, r) => Math.max(m, r.length), 0); },
    setFrozenRows() { note('setFrozenRows'); },
    clear() { note('clear'); rows.length = 0; },
    appendRow(r) { note('appendRow'); rows.push(r.slice()); },
    deleteRow(r) { note('deleteRow'); rows.splice(r - 1, 1); },
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
        setValue(v) {
          note('setValue');
          while (rows.length < r) rows.push([]);
          rows[r - 1][c - 1] = v;
          return range;
        },
        setValues(vals) {
          note('setValues');
          vals.forEach((row, i) => {
            while (rows.length < r + i) rows.push([]);
            row.forEach((v, j) => { rows[r - 1 + i][c - 1 + j] = v; });
          });
          return range;
        },
        setNumberFormat() { note('setNumberFormat'); return range; },
        setDataValidation(rule) { note('setDataValidation'); validations.push({ c, rule }); return range; },
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
    'rate_external', 'external_patients', 'effective_from'],
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
  monthly_actuals: ['id', 'assignment_id', 'month', 'actual_hours', 'actual_sessions',
    'note', 'created_at', 'updated_at'],
  budgets: ['id', 'house', 'month', 'amount', 'created_at', 'updated_at', 'instructors_amount'],
  audit_log: ['ts', 'action', 'entity', 'entity_id', 'field', 'before', 'after', 'reason'],
};

const TODAY = '2026-09-17';

function loadCtx(seed) {
  const writes = [];
  const tabs = {};
  Object.keys(seed || {}).forEach(k => { tabs[k] = fakeSheet(k, seed[k].map(r => r.slice()), writes); });
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
        const rule = { values: null, allowInvalid: null };
        const builder = {
          requireValueInList(list) { rule.values = list.slice(); return builder; },
          setAllowInvalid(v) { rule.allowInvalid = v; return builder; },
          build() { return rule; },
        };
        return builder;
      },
      openById() {
        return {
          getSheetByName(name) { return tabs[name] || null; },
          insertSheet(name) {
            writes.push({ op: 'insertSheet', name });
            tabs[name] = fakeSheet(name, [], writes);
            return tabs[name];
          },
        };
      },
    },
  });
  vm.runInContext(gs, ctx);
  ctx.todayLocal = () => TODAY;
  ctx.tabs = tabs;
  ctx.writes = writes;
  return ctx;
}

function plain(v) { return JSON.parse(JSON.stringify(v)); }

function ft(id, workerId, house) {
  return [id, workerId, house, 'מדריך/ה', '', 'full_time', 10000, 100, 0, 0, 0, 0, 0, '',
    '2025-01-01', 0, 'active', '', 0, 0, 0, 0, 0, 0, ''];
}

// Two rows for the same person: w1 is older and holds the placement, w2 is
// the accidental re-entry with a placement at a DIFFERENT house.
function seed(extra) {
  const base = {
    workers: [H.workers,
      ['w1', 'דנה כהן', '', '2025-01-01', '', '2025-01-01', '', '0501111111'],
      ['w2', 'דנה  כהן', '', '2025-06-01', '', '', '', '0501111111'],
      ['w3', 'smoke test worker', '', '2025-01-01', '', '', '', ''],
    ],
    assignments: [H.assignments, ft('a1', 'w1', 'ramot'), ft('a2', 'w2', 'asher')],
    absences: [H.absences,
      ['ab1', 'w2', 'asher', '2026-09-01', '2026-09-10', 'מחלה', '', '', 'active', '2026-09-01']],
    coverages: [H.coverages,
      ['c1', '', 'w2', 'asher', 'ramot', '2026-09-01', '2026-09-10', 500, '', '2026-09-01',
        '', '', '', '', '', '']],
    archive_v3: [H.archive_v3],
    monthly_actuals: [H.monthly_actuals],
    budgets: [H.budgets],
  };
  return Object.assign(base, extra || {});
}

// Run the report so the cleanup tab exists, then set one decision on the row
// whose code matches, and return the sandbox.
function withDecision(code, decision, note) {
  const ctx = loadCtx(seed());
  ctx.runDataIntegrityReportNow();
  const sheet = ctx.tabs['ניקוי נתונים'];
  const header = sheet.rows[0];
  const dCol = header.indexOf('החלטה');
  const nCol = header.indexOf('הערה');
  const row = sheet.rows.find(r => r[0] === code);
  assert.ok(row, 'expected a cleanup row for ' + code);
  row[dCol] = decision;
  if (note) row[nCol] = note;
  ctx.writes.length = 0;    // only count writes made by the apply run
  return ctx;
}

function auditRows(ctx) {
  const sh = ctx.tabs.audit_log;
  return sh ? sh.rows.slice(1) : [];
}

function workerIds(ctx) {
  return ctx.tabs.workers.rows.slice(1).map(r => String(r[0]));
}

function assignmentOwner(ctx, id) {
  const r = ctx.tabs.assignments.rows.slice(1).find(x => String(x[0]) === id);
  return r ? String(r[1]) : null;
}

// ---------------------------------------------------------------------------
// dry run
// ---------------------------------------------------------------------------

test('with no argument it is a DRY RUN and writes nothing at all', () => {
  const ctx = withDecision('DUP_WORKER_NAME', 'מזג');
  const res = plain(ctx.applyCleanupDecisionsNow());
  assert.strictEqual(res.dryRun, true);
  assert.deepStrictEqual(ctx.writes, [], 'not one write — not even the audit log');
  assert.deepStrictEqual(workerIds(ctx), ['w1', 'w2', 'w3'], 'no worker row moved');
  assert.strictEqual(assignmentOwner(ctx, 'a2'), 'w2', 'no assignment moved');
  assert.strictEqual(ctx.tabs.workers_archive, undefined, 'no archive tab was created');
  assert.deepStrictEqual(auditRows(ctx), []);
});

test('a dry run still says exactly what it WOULD do', () => {
  const ctx = withDecision('DUP_WORKER_NAME', 'מזג');
  const res = plain(ctx.applyCleanupDecisionsNow());
  assert.strictEqual(res.planned.length, 1);
  const p = res.planned[0];
  assert.strictEqual(p.decision, 'מזג');
  assert.strictEqual(p.keeper, 'w1', 'the oldest id that carries assignments');
  assert.strictEqual(p.member, 'w2');
  assert.deepStrictEqual(p.assignments, ['a2'], 'the rows that would move');
  assert.strictEqual(res.applied.length, 0, 'planned is not applied');
});

test('anything other than the literal false stays a dry run', () => {
  ['true', 1, null, undefined, 0, ''].forEach(v => {
    const ctx = withDecision('DUP_WORKER_NAME', 'מזג');
    const res = plain(ctx.applyCleanupDecisionsNow(v));
    assert.strictEqual(res.dryRun, true, 'dryRun for ' + JSON.stringify(v));
    assert.deepStrictEqual(ctx.writes, [], 'no writes for ' + JSON.stringify(v));
  });
});

// ---------------------------------------------------------------------------
// merge
// ---------------------------------------------------------------------------

test('merge moves the assignments onto the keeper and archives the other row', () => {
  const ctx = withDecision('DUP_WORKER_NAME', 'מזג');
  const res = plain(ctx.applyCleanupDecisionsNow(false));

  assert.strictEqual(res.dryRun, false);
  assert.strictEqual(res.applied.length, 1);
  assert.strictEqual(assignmentOwner(ctx, 'a2'), 'w1', 'the placement moved to the keeper');
  assert.strictEqual(assignmentOwner(ctx, 'a1'), 'w1', 'the keeper keeps its own');
  assert.deepStrictEqual(workerIds(ctx), ['w1', 'w3'], 'the merged row left the workers tab');
});

test('merge takes the absences and coverages with it, so nothing is orphaned', () => {
  const ctx = withDecision('DUP_WORKER_NAME', 'מזג');
  ctx.applyCleanupDecisionsNow(false);
  const absence = ctx.tabs.absences.rows.slice(1).find(r => String(r[0]) === 'ab1');
  assert.strictEqual(String(absence[1]), 'w1');
  const coverage = ctx.tabs.coverages.rows.slice(1).find(r => String(r[0]) === 'c1');
  assert.strictEqual(String(coverage[2]), 'w1');
});

test('the merged worker is ARCHIVED with its reason — never deleted', () => {
  const ctx = withDecision('DUP_WORKER_NAME', 'מזג');
  ctx.applyCleanupDecisionsNow(false);
  const arch = ctx.tabs.workers_archive;
  assert.ok(arch, 'workers_archive is created on first use');
  assert.deepStrictEqual(arch.rows[0], ['id', 'name', 'notes', 'created_at',
    'shift_commitment', 'start_date', 'gmach_month', 'phone', 'decision', 'reason',
    'keeper_id', 'archived_at', 'start_date_source']);
  const row = arch.rows[1];
  assert.strictEqual(String(row[0]), 'w2', 'the id survives');
  assert.strictEqual(String(row[1]), 'דנה  כהן', 'and the name, exactly as entered');
  assert.strictEqual(String(row[7]), '0501111111', 'and the phone, leading zero intact');
  assert.strictEqual(String(row[8]), 'מזג');
  assert.strictEqual(String(row[9]), 'merge into w1', 'the reason travels with the row');
  assert.strictEqual(String(row[10]), 'w1');
  assert.ok(String(row[11]).length > 0, 'and when it happened');
});

test('every applied change lands in the audit log', () => {
  const ctx = withDecision('DUP_WORKER_NAME', 'מזג');
  ctx.applyCleanupDecisionsNow(false);
  const rows = auditRows(ctx).map(r => ({
    action: String(r[1]), entity: String(r[2]), entityId: String(r[3]),
    field: String(r[4]), before: String(r[5]), after: String(r[6]), reason: String(r[7]),
  }));
  assert.ok(rows.every(r => r.action === 'applyCleanupDecisions'));
  assert.ok(rows.some(r => r.entity === 'assignment' && r.entityId === 'a2'
    && r.field === 'worker_id' && r.before === 'w2' && r.after === 'w1'));
  assert.ok(rows.some(r => r.entity === 'absence' && r.entityId === 'ab1' && r.after === 'w1'));
  assert.ok(rows.some(r => r.entity === 'coverage' && r.entityId === 'c1' && r.after === 'w1'));
  assert.ok(rows.some(r => r.entity === 'worker' && r.entityId === 'w2'
    && r.field === 'tab' && r.before === 'workers' && r.after === 'workers_archive'));
  assert.ok(rows.every(r => r.reason === 'merge into w1'), 'every row carries the reason');
});

test('a merge that would put two placements at one house is refused, not guessed at', () => {
  // w2 is placed at ramot too — merging would give w1 two rows at ramot,
  // which is exactly the double count the report flags as DUP_ASSIGNMENT.
  const s = seed();
  s.assignments = [H.assignments, ft('a1', 'w1', 'ramot'), ft('a2', 'w2', 'ramot')];
  const ctx = loadCtx(s);
  ctx.runDataIntegrityReportNow();
  const sheet = ctx.tabs['ניקוי נתונים'];
  const dCol = sheet.rows[0].indexOf('החלטה');
  sheet.rows.find(r => r[0] === 'DUP_WORKER_NAME')[dCol] = 'מזג';
  ctx.writes.length = 0;

  const res = plain(ctx.applyCleanupDecisionsNow(false));
  assert.strictEqual(res.applied.length, 0, 'nothing was applied');
  assert.strictEqual(res.conflicts.length, 1);
  assert.match(res.skipped.map(x => x.why).join(' '), /double count/);
  assert.strictEqual(assignmentOwner(ctx, 'a2'), 'w2', 'the placement stayed put');
  assert.deepStrictEqual(workerIds(ctx), ['w1', 'w2', 'w3'], 'and so did the worker row');
});

test('within one group, a later member landing on a house the keeper just gained is a conflict', () => {
  // Three rows for one name: w1 at ramot, w2 at asher, w4 also at asher.
  // Merging w2 gives the keeper asher, so w4's asher placement would be the
  // second row at one house — the conflict must be caught on the SECOND
  // member too, not only against the keeper's original houses.
  const s2 = seed();
  s2.workers = [H.workers,
    ['w1', 'דנה כהן', '', '2025-01-01', '', '2025-01-01', '', ''],
    ['w2', 'דנה  כהן', '', '2025-06-01', '', '', '', ''],
    ['w4', 'דנה כהן ', '', '2025-07-01', '', '', '', ''],
  ];
  s2.assignments = [H.assignments, ft('a1', 'w1', 'ramot'), ft('a2', 'w2', 'asher'),
    ft('a4', 'w4', 'asher')];
  s2.absences = [H.absences];
  s2.coverages = [H.coverages];

  const ctx = loadCtx(s2);
  ctx.runDataIntegrityReportNow();
  const sheet = ctx.tabs['ניקוי נתונים'];
  const dCol = sheet.rows[0].indexOf('החלטה');
  sheet.rows.find(r => r[0] === 'DUP_WORKER_NAME')[dCol] = 'מזג';
  ctx.writes.length = 0;

  const res = plain(ctx.applyCleanupDecisionsNow(false));
  assert.strictEqual(assignmentOwner(ctx, 'a2'), 'w1', 'the first member merges');
  assert.strictEqual(assignmentOwner(ctx, 'a4'), 'w4', 'the second is refused');
  assert.strictEqual(res.conflicts.length, 1);
  assert.ok(workerIds(ctx).includes('w4'), 'and its row is left alone');
  assert.ok(!workerIds(ctx).includes('w2'));
});

test('the dry run predicts that same conflict rather than discovering it on apply', () => {
  const s2 = seed();
  s2.workers = [H.workers,
    ['w1', 'דנה כהן', '', '2025-01-01', '', '2025-01-01', '', ''],
    ['w2', 'דנה  כהן', '', '2025-06-01', '', '', '', ''],
    ['w4', 'דנה כהן ', '', '2025-07-01', '', '', '', ''],
  ];
  s2.assignments = [H.assignments, ft('a1', 'w1', 'ramot'), ft('a2', 'w2', 'asher'),
    ft('a4', 'w4', 'asher')];
  s2.absences = [H.absences];
  s2.coverages = [H.coverages];

  const ctx = loadCtx(s2);
  ctx.runDataIntegrityReportNow();
  const sheet = ctx.tabs['ניקוי נתונים'];
  const dCol = sheet.rows[0].indexOf('החלטה');
  sheet.rows.find(r => r[0] === 'DUP_WORKER_NAME')[dCol] = 'מזג';
  ctx.writes.length = 0;

  const res = plain(ctx.applyCleanupDecisionsNow());
  assert.strictEqual(res.dryRun, true);
  assert.strictEqual(res.conflicts.length, 1, 'the plan says so before anything moves');
  assert.deepStrictEqual(ctx.writes, []);
});

// ---------------------------------------------------------------------------
// archive / keep / fix
// ---------------------------------------------------------------------------

test('העבר לארכיון moves a worker with no placements into workers_archive', () => {
  const ctx = withDecision('SMOKE_RECORD', 'העבר לארכיון', 'רשומת בדיקה');
  const res = plain(ctx.applyCleanupDecisionsNow(false));
  assert.strictEqual(res.applied.length, 1);
  assert.deepStrictEqual(workerIds(ctx), ['w1', 'w2']);
  const row = ctx.tabs.workers_archive.rows[1];
  assert.strictEqual(String(row[0]), 'w3');
  assert.strictEqual(String(row[8]), 'העבר לארכיון');
  assert.strictEqual(String(row[9]), 'רשומת בדיקה', 'the note becomes the reason');
});

// The dropdown said «העבר לארכיב» before it said «העבר לארכיון». A sheet is
// filled in over days, so a decision picked under the old wording must still
// be honoured — and must not be left sitting in the tab as a value the
// dropdown now rejects.
test('the previous spelling «העבר לארכיב» is still honoured on apply', () => {
  const ctx = withDecision('SMOKE_RECORD', 'העבר לארכיב', 'רשומת בדיקה');
  const res = plain(ctx.applyCleanupDecisionsNow(false));
  assert.strictEqual(res.applied.length, 1, 'an old decision must not be silently skipped');
  assert.deepStrictEqual(workerIds(ctx), ['w1', 'w2']);
  const row = ctx.tabs.workers_archive.rows[1];
  assert.strictEqual(String(row[0]), 'w3');
  assert.strictEqual(String(row[8]), 'העבר לארכיון', 'stored under the current wording');
});

test('a rebuild rewrites the previous spelling to the current one', () => {
  const ctx = withDecision('SMOKE_RECORD', 'העבר לארכיב');
  ctx.runDataIntegrityReportNow();
  const sheet = ctx.tabs['ניקוי נתונים'];
  const dCol = sheet.rows[0].indexOf('החלטה');
  const row = sheet.rows.find(r => r[0] === 'SMOKE_RECORD');
  assert.strictEqual(String(row[dCol]), 'העבר לארכיון',
    'carried over as a value the dropdown accepts, not as an invalid entry');
});

test('archiving a worker who still holds a live assignment is refused', () => {
  const s = seed();
  // Give the smoke-named row a live placement.
  s.assignments = [H.assignments, ft('a1', 'w1', 'ramot'), ft('a2', 'w2', 'asher'), ft('a3', 'w3', 'rehab')];
  const ctx = loadCtx(s);
  ctx.runDataIntegrityReportNow();
  const sheet = ctx.tabs['ניקוי נתונים'];
  const dCol = sheet.rows[0].indexOf('החלטה');
  sheet.rows.find(r => r[0] === 'SMOKE_RECORD')[dCol] = 'העבר לארכיון';
  ctx.writes.length = 0;

  const res = plain(ctx.applyCleanupDecisionsNow(false));
  assert.strictEqual(res.applied.length, 0);
  assert.match(res.skipped.map(x => x.why).join(' '), /orphan their cost/);
  assert.ok(workerIds(ctx).includes('w3'));
});

test('השאר and תקן change nothing', () => {
  ['השאר', 'תקן'].forEach(decision => {
    const ctx = withDecision('DUP_WORKER_NAME', decision);
    const res = plain(ctx.applyCleanupDecisionsNow(false));
    assert.strictEqual(res.applied.length, 0, decision + ' must apply nothing');
    assert.deepStrictEqual(ctx.writes, [], decision + ' must write nothing');
    assert.deepStrictEqual(workerIds(ctx), ['w1', 'w2', 'w3']);
  });
});

test('an empty or unrecognized decision is skipped and named, never guessed at', () => {
  const ctx = withDecision('DUP_WORKER_NAME', 'אולי');
  const res = plain(ctx.applyCleanupDecisionsNow(false));
  assert.strictEqual(res.applied.length, 0);
  assert.match(res.skipped.map(x => x.why).join(' '), /unrecognized decision "אולי"/);
  // The rows left blank are reported too, so nothing is silently ignored.
  assert.ok(res.skipped.some(x => /no decision/.test(x.why)));
});

test('with no cleanup tab at all it reports that, rather than throwing', () => {
  const ctx = loadCtx(seed());
  const res = plain(ctx.applyCleanupDecisionsNow(false));
  assert.strictEqual(res.rows, 0);
  assert.deepStrictEqual(res.applied, []);
});

// ---------------------------------------------------------------------------
// reachability: editor-run only
// ---------------------------------------------------------------------------

test('cleanup is EDITOR-RUN ONLY — no HTTP action can reach it', () => {
  const ctx = loadCtx(seed());
  ['applyCleanupDecisions', 'applyCleanupDecisionsNow', 'runDataIntegrityReportNow',
    'cleanupArchiveWorker', 'writeCleanupTab'].forEach(action => {
    const resp = ctx.doPost({
      parameter: { secret: 'x' },
      postData: { contents: JSON.stringify({ action }) },
    });
    const body = JSON.parse(resp._text);
    assert.ok(body.error, action + ' must not be routable over HTTP');
  });
});

test('a merge and an archive in the same run see each other', () => {
  // Decide «מזג» on the duplicate group AND «העבר לארכיון» on the keeper's
  // own row: the archive must see the placements the merge just handed it,
  // rather than the roster as it looked before the run started.
  const ctx = loadCtx(seed());
  ctx.runDataIntegrityReportNow();
  const sheet = ctx.tabs['ניקוי נתונים'];
  const header = sheet.rows[0];
  const dCol = header.indexOf('החלטה');
  const mCol = header.indexOf('מזהים בקבוצה');
  sheet.rows.find(r => r[0] === 'DUP_WORKER_NAME')[dCol] = 'מזג';
  // A hand-written archive row for the keeper, appended the way a rebuild
  // would have written one.
  sheet.rows.push(['SMOKE_RECORD', 'worker', 'דנה כהן', 'ramot', '', '', 'w1', '',
    'העבר לארכיון', '', 'SMOKE_RECORD:w1']);
  assert.ok(sheet.rows[sheet.rows.length - 1][mCol] === 'w1');
  ctx.writes.length = 0;

  const res = plain(ctx.applyCleanupDecisionsNow(false));
  assert.ok(workerIds(ctx).includes('w1'), 'the keeper is NOT archived');
  assert.match(res.skipped.map(x => x.why).join(' '), /orphan their cost/);
});
