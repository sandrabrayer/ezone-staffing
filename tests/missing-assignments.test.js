'use strict';

// «שיבוצים חסרים» and missingAssignmentsPreviewNow() / applyMissingAssignmentsNow() — the proposal
// sheet for the workers who are paid but hold no placement.
//
// The point of this sheet is what it does NOT do. Ten people draw a salary
// and are missing from every month's cost, and the app has no house, no
// employment type and no rate for any of them. So:
//   - NOTHING IS DEFAULTED. A row that is not completely filled in creates
//     nothing, and is reported with exactly what it still needs.
//   - NOTHING IS APPROVED BY ACCIDENT. «אשר» must say כן.
//   - THE DEPARTMENT MAPPING IS A SUGGESTION. It fills one reference
//     column and is never written to a data tab; 002 (קיסריה) and 006
//     (הולינה) deliberately resolve to no house at all.
//   - DRY RUN BY DEFAULT: only the literal `false` creates anything.
//   - Work already entered survives a rebuild of the sheet.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const gs = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
// Deployed beside Code.gs, so the sandbox loads it the same way — the
// payroll reference column is checked against the engine that actually
// prices a month, not against a stand-in.
const engineGs = fs.readFileSync(path.join(ROOT, 'apps-script', 'CostEngine.gs'), 'utf8');

const TAB = 'שיבוצים חסרים';
const TODAY = '2026-09-17';
// The ten verified names, in the order Code.gs lists them.
const PAID_NO_PLACEMENT = ['רון מנחם', 'דניאל קוטסי', 'בר ליידרמן', 'עידו בוזגלו',
  'שירן כהן', 'אופק רחמים', 'אופיר רוטנברג', 'ניב מנחם סין', 'דפנה כץ', 'דניאל סייג'];

function fakeSheet(name, rows, writes) {
  const validations = [];
  function note(op) { writes.push({ op, name }); }
  const sh = {
    name, rows, validations,
    getDataRange() { return { getValues: () => rows.map(r => r.slice()) }; },
    getLastRow() { return rows.length; },
    getLastColumn() { return rows.reduce((m, r) => Math.max(m, r.length), 0); },
    getMaxRows() { return Math.max(rows.length, 1); },
    getMaxColumns() { return Math.max(sh.getLastColumn(), 1); },
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
        clearDataValidations() { return range; },
        setDataValidation(rule) { note('setDataValidation'); validations.push({ c, rule }); return range; },
      };
      return range;
    },
  };
  return sh;
}

const H = {
  workers: ['id', 'name', 'notes', 'created_at', 'shift_commitment', 'start_date',
    'gmach_month', 'phone', 'start_date_source'],
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
  audit_log: ['ts', 'action', 'entity', 'entity_id', 'field', 'before', 'after', 'reason'],
  archive_v3: ['id', 'assignment_id', 'worker_id', 'name', 'house', 'role', 'role_detail',
    'employment_type', 'salary', 'pct', 'hourly_rate', 'est_hours', 'session_rate',
    'est_sessions', 'retainer_amount', 'notes', 'termination_date', 'reason_type',
    'reason_detail', 'archived_at', 'rate_individual', 'sessions_individual',
    'rate_group', 'sessions_group', 'rate_external', 'external_patients'],
  monthly_actuals: ['id', 'assignment_id', 'month', 'actual_hours', 'actual_sessions',
    'note', 'created_at', 'updated_at'],
  budgets: ['id', 'house', 'month', 'amount', 'created_at', 'updated_at', 'instructors_amount'],
};

function loadCtx(seed, srcOverride) {
  const writes = [];
  const logs = [];
  const tabs = {};
  Object.keys(seed || {}).forEach(k => { tabs[k] = fakeSheet(k, seed[k].map(r => r.slice()), writes); });
  const ctx = vm.createContext({
    Logger: { log(m) { logs.push(String(m)); } },
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
  vm.runInContext(engineGs, ctx);
  vm.runInContext(srcOverride || gs, ctx);
  ctx.todayLocal = () => TODAY;
  ctx.tabs = tabs;
  ctx.writes = writes;
  ctx.logs = logs;
  return ctx;
}

function plain(v) { return JSON.parse(JSON.stringify(v)); }

function seed(extra) {
  const workers = [H.workers];
  PAID_NO_PLACEMENT.forEach((name, i) => {
    workers.push(['wpaid' + (i + 1), name, '', '2026-01-02T00:00:00.000Z', '', '', '', '', '']);
  });
  workers.push(['wplaced', 'עובדת משובצת', '', '2026-01-02T00:00:00.000Z', '', '2026-01-01', '', '', '']);
  return Object.assign({
    workers,
    assignments: [H.assignments,
      ['aplaced', 'wplaced', 'ramot', 'מדריך/ה', '', 'full_time', 10000, 100, 0, 0, 0, 0, 0,
        '', '2026-01-02T00:00:00.000Z', 0, 'active', '', 0, 0, 0, 0, 0, 0, '']],
    absences: [H.absences],
    coverages: [H.coverages],
    archive_v3: [H.archive_v3],
    monthly_actuals: [H.monthly_actuals],
    budgets: [H.budgets],
  }, extra || {});
}

// One archived placement, so the cross-check column has something to find.
function archivedRow(workerId, name, house, terminationDate) {
  return ['arc-' + workerId, 'a-old-' + workerId, workerId, name, house, 'מדריך/ה', '',
    'full_time', 9000, 100, 0, 0, 0, 0, 0, '', terminationDate, 'התפטרות', '',
    '2026-02-01T00:00:00.000Z', 0, 0, 0, 0, 0, 0];
}

function header(ctx) { return ctx.tabs[TAB].rows[0]; }
function col(ctx, label) { return header(ctx).indexOf(label); }
function rowFor(ctx, name) {
  return ctx.tabs[TAB].rows.slice(1).find(r => String(r[1]) === name);
}
// Fill one proposal row in, field by field, the way Moran would.
function fill(ctx, name, values) {
  const r = rowFor(ctx, name);
  assert.ok(r, 'expected a proposal row for ' + name);
  Object.keys(values).forEach(label => {
    const c = col(ctx, label);
    assert.ok(c >= 0, 'unknown column ' + label);
    r[c] = values[label];
  });
  return r;
}
const FULL = {
  'בית': 'ramot · רמות השבים',
  'תפקיד': 'מדריך/ה',
  'סוג העסקה': 'full_time · משכורת חודשית מלאה',
  'סכום': 9000,
  'תאריך תחילת השיבוץ': '2026-02-01',
  'אשר': 'כן',
};

// ---------------------------------------------------------------------------
// building the sheet
// ---------------------------------------------------------------------------

test('one row per verified worker who is paid and holds no placement', () => {
  const ctx = loadCtx(seed());
  const res = ctx.writeMissingAssignmentsTabNow();
  assert.strictEqual(res.count, 10);
  const names = ctx.tabs[TAB].rows.slice(1).map(r => String(r[1]));
  assert.deepStrictEqual(names.slice().sort(), PAID_NO_PLACEMENT.slice().sort());
  assert.ok(!names.includes('עובדת משובצת'), 'a placed worker is not proposed');
});

test('the decision columns start EMPTY — nothing is guessed at', () => {
  const ctx = loadCtx(seed());
  ctx.writeMissingAssignmentsTabNow();
  const r = rowFor(ctx, 'רון מנחם');
  ['בית', 'תפקיד', 'סוג העסקה', 'סכום', 'כמות', 'תאריך תחילת השיבוץ', 'אשר']
    .forEach(label => assert.strictEqual(String(r[col(ctx, label)] || ''), '', label + ' must be blank'));
  assert.strictEqual(String(r[0]), 'wpaid1', 'the id IS known, so it is filled in');
  assert.match(String(r[col(ctx, 'מה חסר')]), /בית/, 'and the row says what it still needs');
});

test('a worker who gains an assignment drops off the sheet by itself', () => {
  const ctx = loadCtx(seed());
  ctx.writeMissingAssignmentsTabNow();
  ctx.tabs.assignments.rows.push(['anew', 'wpaid1', 'asher', 'מדריך/ה', '', 'full_time',
    9000, 100, 0, 0, 0, 0, 0, '', '2026-02-01T00:00:00.000Z', 0, 'active', '',
    0, 0, 0, 0, 0, 0, '']);
  const res = ctx.writeMissingAssignmentsTabNow();
  assert.strictEqual(res.count, 9);
  assert.ok(!rowFor(ctx, 'רון מנחם'), 'the open work shrinks; the sheet is never a stale checklist');
});

test('every decision column is a dropdown, and «אשר» offers exactly כן / לא', () => {
  const ctx = loadCtx(seed());
  ctx.writeMissingAssignmentsTabNow();
  const sh = ctx.tabs[TAB];
  const byCol = {};
  sh.validations.forEach(v => { byCol[v.c] = v.rule; });
  ['מחלקה בשכר', 'בית', 'תפקיד', 'סוג העסקה', 'אשר'].forEach(label => {
    const rule = byCol[col(ctx, label) + 1];
    assert.ok(rule, label + ' must carry a dropdown');
    assert.strictEqual(rule.allowInvalid, false, label + ': a typed value must be impossible');
  });
  assert.deepStrictEqual(plain(byCol[col(ctx, 'אשר') + 1].values), ['כן', 'לא']);
  assert.ok(plain(byCol[col(ctx, 'בית') + 1].values).every(v => /^[a-z_]+ · /.test(v)),
    'a house option carries the ASCII id AND the Hebrew, so nothing is matched by guesswork');
});

test('work already entered survives a rebuild', () => {
  const ctx = loadCtx(seed());
  ctx.writeMissingAssignmentsTabNow();
  fill(ctx, 'דפנה כץ', FULL);
  ctx.writeMissingAssignmentsTabNow();
  const r = rowFor(ctx, 'דפנה כץ');
  assert.strictEqual(String(r[col(ctx, 'בית')]), 'ramot · רמות השבים');
  assert.strictEqual(String(r[col(ctx, 'אשר')]), 'כן');
  assert.strictEqual(Number(r[col(ctx, 'סכום')]), 9000);
  assert.strictEqual(String(r[col(ctx, 'מה חסר')]), 'מוכן ליצירה',
    'and a complete row says so, instead of listing what is missing');
});

test('the sheet is written through the guarded path — a data tab is refused', () => {
  const ctx = loadCtx(seed());
  assert.throws(() => ctx.integrityWriteReportTab_('workers', [['x']]),
    /refusing to write to "workers"/);
  assert.throws(() => ctx.integrityWriteReportTab_('assignments', [['x']]),
    /refusing to write to "assignments"/);
});

// ---------------------------------------------------------------------------
// the department mapping is a SUGGESTION
// ---------------------------------------------------------------------------

test('a mapped department fills the suggestion column only', () => {
  const ctx = loadCtx(seed());
  ctx.writeMissingAssignmentsTabNow();
  fill(ctx, 'רון מנחם', { 'מחלקה בשכר': '003 · רמות השבים' });
  ctx.writeMissingAssignmentsTabNow();
  const r = rowFor(ctx, 'רון מנחם');
  assert.strictEqual(String(r[col(ctx, 'בית מוצע (הצעה בלבד)')]), 'ramot · רמות השבים');
  assert.strictEqual(String(r[col(ctx, 'בית')] || ''), '',
    'the suggestion must NEVER become the answer by itself');
});

test('002 קיסריה resolves to no house, because it covers two', () => {
  const ctx = loadCtx(seed());
  ctx.writeMissingAssignmentsTabNow();
  fill(ctx, 'שירן כהן', { 'מחלקה בשכר': '002 · קיסריה' });
  ctx.writeMissingAssignmentsTabNow();
  const r = rowFor(ctx, 'שירן כהן');
  assert.match(String(r[col(ctx, 'בית מוצע (הצעה בלבד)')]), /עפרוני.*ריהאב|ריהאב.*עפרוני/);
  assert.strictEqual(String(r[col(ctx, 'בית')] || ''), '');
});

test('006 הולינה is flagged as having no house at all', () => {
  const ctx = loadCtx(seed());
  ctx.writeMissingAssignmentsTabNow();
  fill(ctx, 'דניאל סייג', { 'מחלקה בשכר': '006 · הולינה' });
  ctx.writeMissingAssignmentsTabNow();
  assert.match(String(rowFor(ctx, 'דניאל סייג')[col(ctx, 'בית מוצע (הצעה בלבד)')]),
    /אין בית מקביל/);
});

test('a department alone creates nothing, however approved the row is', () => {
  const ctx = loadCtx(seed());
  ctx.writeMissingAssignmentsTabNow();
  fill(ctx, 'רון מנחם', { 'מחלקה בשכר': '003 · רמות השבים', 'אשר': 'כן' });
  const res = plain(ctx.applyMissingAssignmentsNow());
  assert.deepStrictEqual(res.created, []);
  assert.match(res.skipped.map(s => s.why).join(' '), /בית/);
});

// ---------------------------------------------------------------------------
// applying
// ---------------------------------------------------------------------------

test('the PreviewNow run is a DRY RUN and creates nothing', () => {
  const ctx = loadCtx(seed());
  ctx.writeMissingAssignmentsTabNow();
  fill(ctx, 'דפנה כץ', FULL);
  ctx.writes.length = 0;
  const res = plain(ctx.missingAssignmentsPreviewNow());
  assert.strictEqual(res.dryRun, true);
  assert.strictEqual(res.planned.length, 1, 'it still says what it would create');
  assert.deepStrictEqual(res.created, []);
  assert.deepStrictEqual(ctx.writes, []);
});

test('the shared core stays a dry run for anything but the literal false', () => {
  [true, 'false', 1, 0, null, ''].forEach(arg => {
    const ctx = loadCtx(seed());
    ctx.writeMissingAssignmentsTabNow();
    fill(ctx, 'דפנה כץ', FULL);
    ctx.writes.length = 0;
    const res = plain(ctx.runMissingAssignments_(arg));
    assert.strictEqual(res.dryRun, true, String(arg) + ' must not create anything');
    assert.deepStrictEqual(ctx.writes, [], String(arg) + ' must write nothing');
  });
});

test('a PARTIALLY filled approved row is skipped, and named with what it needs', () => {
  const ctx = loadCtx(seed());
  ctx.writeMissingAssignmentsTabNow();
  // Everything but the rate.
  fill(ctx, 'בר ליידרמן', {
    'בית': 'asher · רעננה אשר', 'תפקיד': 'מדריך/ה',
    'סוג העסקה': 'full_time · משכורת חודשית מלאה',
    'תאריך תחילת השיבוץ': '2026-03-01', 'אשר': 'כן',
  });
  ctx.writes.length = 0;
  const res = plain(ctx.applyMissingAssignmentsNow());
  assert.deepStrictEqual(res.created, [], 'nothing partial is ever created');
  const why = res.skipped.find(s => s.name === 'בר ליידרמן').why;
  assert.match(why, /incomplete/);
  assert.match(why, /שכר חודשי/, 'and it says which field, in the words the sheet uses');
  assert.deepStrictEqual(ctx.writes, [], 'a skipped row writes nothing at all');
});

test('a missing start date alone is enough to skip the row', () => {
  const ctx = loadCtx(seed());
  ctx.writeMissingAssignmentsTabNow();
  const values = Object.assign({}, FULL);
  delete values['תאריך תחילת השיבוץ'];
  fill(ctx, 'עידו בוזגלו', values);
  const res = plain(ctx.applyMissingAssignmentsNow());
  assert.deepStrictEqual(res.created, []);
  assert.match(res.skipped.find(s => s.name === 'עידו בוזגלו').why, /תאריך תחילת השיבוץ/);
});

test('a complete but UNAPPROVED row creates nothing', () => {
  const ctx = loadCtx(seed());
  ctx.writeMissingAssignmentsTabNow();
  const values = Object.assign({}, FULL, { 'אשר': '' });
  fill(ctx, 'אופק רחמים', values);
  const res = plain(ctx.applyMissingAssignmentsNow());
  assert.deepStrictEqual(res.created, []);
  assert.match(res.skipped.find(s => s.name === 'אופק רחמים').why, /not approved/);

  const ctx2 = loadCtx(seed());
  ctx2.writeMissingAssignmentsTabNow();
  fill(ctx2, 'אופק רחמים', Object.assign({}, FULL, { 'אשר': 'לא' }));
  assert.deepStrictEqual(plain(ctx2.applyMissingAssignmentsNow()).created, []);
});

test('a complete, approved row creates the assignment through the app\'s own path', () => {
  const ctx = loadCtx(seed());
  ctx.writeMissingAssignmentsTabNow();
  fill(ctx, 'דפנה כץ', FULL);
  const res = plain(ctx.applyMissingAssignmentsNow());
  assert.strictEqual(res.created.length, 1);
  const row = ctx.tabs.assignments.rows.slice(1).find(r => String(r[1]) === 'wpaid9');
  assert.ok(row, 'the assignment row exists');
  assert.strictEqual(String(row[2]), 'ramot');
  assert.strictEqual(String(row[3]), 'מדריך/ה');
  assert.strictEqual(String(row[5]), 'full_time');
  assert.strictEqual(Number(row[6]), 9000);
  assert.strictEqual(String(row[24]), '2026-02-01',
    'the placement is costed from the date on the sheet, not from its creation timestamp');
});

test('an hourly row needs BOTH the rate and the hours', () => {
  const ctx = loadCtx(seed());
  ctx.writeMissingAssignmentsTabNow();
  fill(ctx, 'שירן כהן', Object.assign({}, FULL, {
    'סוג העסקה': 'hourly · שכר שעתי', 'סכום': 60, 'כמות': '',
  }));
  const partial = plain(ctx.applyMissingAssignmentsNow());
  assert.deepStrictEqual(partial.created, []);
  assert.match(partial.skipped.find(s => s.name === 'שירן כהן').why, /שעות בחודש/);

  fill(ctx, 'שירן כהן', { 'כמות': 80 });
  const full = plain(ctx.applyMissingAssignmentsNow());
  assert.strictEqual(full.created.length, 1);
  const row = ctx.tabs.assignments.rows.slice(1).find(r => String(r[1]) === 'wpaid5');
  assert.strictEqual(Number(row[8]), 60, 'hourly_rate');
  assert.strictEqual(Number(row[9]), 80, 'est_hours');
  assert.strictEqual(Number(row[6]), 0, 'and no salary was invented');
});

test('creation lands in the audit log with the verified reason', () => {
  const ctx = loadCtx(seed());
  ctx.writeMissingAssignmentsTabNow();
  fill(ctx, 'דפנה כץ', FULL);
  ctx.applyMissingAssignmentsNow();
  const row = ctx.tabs.audit_log.rows.slice(1).find(r => String(r[1]) === 'applyMissingAssignments');
  assert.ok(row, 'an assignment created from a sheet is still an audited change');
  assert.strictEqual(String(row[2]), 'assignment');
  assert.match(String(row[6]), /wpaid9 @ ramot \(full_time\)/);
  assert.strictEqual(String(row[7]), 'תיקון מאומת מול דוח שכר');
});

test('a second apply run does not create a duplicate placement', () => {
  const ctx = loadCtx(seed());
  ctx.writeMissingAssignmentsTabNow();
  fill(ctx, 'דפנה כץ', FULL);
  ctx.applyMissingAssignmentsNow();
  const res = plain(ctx.applyMissingAssignmentsNow());
  assert.deepStrictEqual(res.created, []);
  assert.match(res.skipped.find(s => s.name === 'דפנה כץ').why, /already has an assignment at ramot/);
});

test('with no sheet at all it says so rather than throwing', () => {
  const ctx = loadCtx(seed());
  const res = plain(ctx.applyMissingAssignmentsNow());
  assert.strictEqual(res.rows, 0);
  assert.deepStrictEqual(res.created, []);
  assert.match(ctx.logs.join('\n'), /Run writeMissingAssignmentsTabNow\(\) first/);
});

test('an unresolvable verified name aborts the build — no half-built sheet', () => {
  const s = seed();
  s.workers.push(['wdup', 'דפנה כץ', '', '2026-01-02T00:00:00.000Z', '', '', '', '', '']);
  const ctx = loadCtx(s);
  assert.throws(() => ctx.writeMissingAssignmentsTabNow(),
    /NOTHING was written.*"דפנה כץ" matches 2 workers/s);
  assert.ok(!ctx.tabs[TAB], 'the sheet is not created at all');
});

test('an unknown value in a row is caught by the sheet check, and the batch goes on', () => {
  const ctx = loadCtx(seed());
  ctx.writeMissingAssignmentsTabNow();
  fill(ctx, 'רון מנחם', FULL);
  rowFor(ctx, 'רון מנחם')[col(ctx, 'בית')] = 'atlantis · אטלנטיס';   // no such house
  fill(ctx, 'דפנה כץ', FULL);                                        // a good row after it

  const res = plain(ctx.applyMissingAssignmentsNow());
  assert.strictEqual(res.created.length, 1, 'the good row still goes through');
  assert.strictEqual(res.created[0].name, 'דפנה כץ');
  assert.match(res.skipped.find(x => x.name === 'רון מנחם').why, /בית לא מוכר: atlantis/);
});

test('a rejection from the shared write path is reported, never left half-applied', () => {
  const ctx = loadCtx(seed());
  ctx.writeMissingAssignmentsTabNow();
  fill(ctx, 'רון מנחם', FULL);
  fill(ctx, 'דפנה כץ', FULL);
  // The backstop: whatever the shared validation refuses — today or after a
  // rule changes under this sheet — must not halt a batch mid-way.
  const real = ctx.addAssignment;
  ctx.addAssignment = function (body) {
    if (body.assignment.workerId === 'wpaid1') throw new Error('worker already has an assignment at this house');
    return real(body);
  };

  const res = plain(ctx.applyMissingAssignmentsNow());
  assert.strictEqual(res.created.length, 1, 'the row after the rejected one is still created');
  assert.strictEqual(res.created[0].name, 'דפנה כץ');
  const bad = res.skipped.find(x => x.name === 'רון מנחם');
  assert.match(bad.why, /rejected: worker already has an assignment/);
  assert.ok(!res.planned.some(p => p.name === 'רון מנחם'),
    'a row that created nothing is not left in the plan as if it had');
});

// ---------------------------------------------------------------------------
// the payroll reference columns
// ---------------------------------------------------------------------------

// The August payroll export, per person. Facts — never decisions, and never
// inputs to a calculation.
const AUG = {
  'רון מנחם':      { empNo: '2',   dept: '004', cost: 30229, house: 'hq' },
  'שירן כהן':      { empNo: '157', dept: '004', cost: 14839, house: 'hq' },
  'עידו בוזגלו':   { empNo: '70',  dept: '005', cost: 23950, house: 'asher' },
  'ניב מנחם סין':  { empNo: '149', dept: '005', cost: 585,   house: 'asher' },
  'דניאל קוטסי':   { empNo: '21',  dept: '003', cost: 1025,  house: 'ramot' },
  'אופק רחמים':    { empNo: '146', dept: '003', cost: 7653,  house: 'ramot' },
  'אופיר רוטנברג': { empNo: '165', dept: '003', cost: 3359,  house: 'ramot' },
  'בר ליידרמן':    { empNo: '63',  dept: '002', cost: 8004,  house: '' },
  'דפנה כץ':       { empNo: '129', dept: '006', cost: 3369,  house: '' },
  'דניאל סייג':    { empNo: '',    dept: '',    cost: 800,   house: '' },
};

test('every row is pre-filled with that person\'s payroll number, department and August cost', () => {
  const ctx = loadCtx(seed());
  ctx.writeMissingAssignmentsTabNow();
  Object.keys(AUG).forEach(name => {
    const r = rowFor(ctx, name);
    assert.ok(r, name + ' must have a row');
    const emp = String(r[col(ctx, "מס' עובד בשכר")]);
    if (AUG[name].empNo) assert.strictEqual(emp, AUG[name].empNo, name + ' payroll number');
    else assert.match(emp, /אין.*פרילנסר/, name + ' has no payroll number, and the cell says so');
    const dept = String(r[col(ctx, 'מחלקה בשכר')]);
    if (AUG[name].dept) assert.ok(dept.startsWith(AUG[name].dept + ' · '), name + ' department: ' + dept);
    else assert.strictEqual(dept, '', name + ' has no department');
    assert.strictEqual(Number(r[col(ctx, 'עלות אוגוסט בפועל (שכר — לעיון בלבד)')]), AUG[name].cost,
      name + ' August cost');
  });
});

test('the pre-filled department drives the suggestion — and 002 / 006 still resolve to none', () => {
  const ctx = loadCtx(seed());
  ctx.writeMissingAssignmentsTabNow();
  const c = col(ctx, 'בית מוצע (הצעה בלבד)');
  Object.keys(AUG).forEach(name => {
    const cell = String(rowFor(ctx, name)[c]);
    if (AUG[name].house) {
      assert.ok(cell.startsWith(AUG[name].house + ' · '), name + ' → ' + AUG[name].house + ', got ' + cell);
    } else {
      assert.ok(!/^[a-z_]+ · /.test(cell), name + ' must not resolve to a house: ' + cell);
    }
  });
  // And the two that cannot resolve say WHY, rather than sitting blank.
  assert.match(String(rowFor(ctx, 'בר ליידרמן')[c]), /עפרוני.*ריהאב|ריהאב.*עפרוני/);
  assert.match(String(rowFor(ctx, 'דפנה כץ')[c]), /אין בית מקביל/);
  assert.strictEqual(String(rowFor(ctx, 'דניאל סייג')[c]), '', 'no department, nothing to suggest');
});

test('pre-filling reference columns does not fill a single DECISION column', () => {
  const ctx = loadCtx(seed());
  ctx.writeMissingAssignmentsTabNow();
  Object.keys(AUG).forEach(name => {
    const r = rowFor(ctx, name);
    ['בית', 'תפקיד', 'סוג העסקה', 'סכום', 'כמות', 'תאריך תחילת השיבוץ', 'אשר']
      .forEach(label => assert.strictEqual(String(r[col(ctx, label)] || ''), '',
        name + ' · ' + label + ' must stay empty for Moran'));
  });
});

test('a department corrected by hand wins over the pre-filled one', () => {
  const ctx = loadCtx(seed());
  ctx.writeMissingAssignmentsTabNow();
  fill(ctx, 'רון מנחם', { 'מחלקה בשכר': '003 · רמות השבים' });   // 004 in the export
  ctx.writeMissingAssignmentsTabNow();
  const r = rowFor(ctx, 'רון מנחם');
  assert.ok(String(r[col(ctx, 'מחלקה בשכר')]).startsWith('003 · '), 'the correction stands');
  assert.ok(String(r[col(ctx, 'בית מוצע (הצעה בלבד)')]).startsWith('ramot · '),
    'and the suggestion follows it');
});

test('the August figure is REFERENCE ONLY — it never reaches the cost engine', () => {
  const ctx = loadCtx(seed());
  ctx.writeMissingAssignmentsTabNow();
  // רון מנחם was paid ₪30,229 in August. Moran enters a ₪9,000 rate.
  fill(ctx, 'רון מנחם', Object.assign({}, FULL, { 'סכום': 9000 }));
  ctx.applyMissingAssignmentsNow();

  // Nothing in the created assignment carries the payroll figure.
  const row = ctx.tabs.assignments.rows.slice(1).find(r => String(r[1]) === 'wpaid1');
  assert.ok(row, 'the assignment exists');
  assert.strictEqual(Number(row[6]), 9000, 'the salary is the rate that was entered');
  assert.ok(!row.some(cell => Number(cell) === 30229), 'no cell carries the payroll figure');

  // And the engine that prices the month agrees.
  const month = plain(ctx.logMonthTotalsNow(['2026-09']))[0];
  assert.strictEqual(month.projectedTotal, 9000 + 10000,
    'the month costs the entered rate plus the pre-existing placement — not the payroll figure');
  assert.notStrictEqual(month.projectedTotal, 30229 + 10000);
  assert.strictEqual(month.byHouse.ramot.projectedTotal, 9000 + 10000);
});

test('the reference column is not read back as data by the apply run either', () => {
  const ctx = loadCtx(seed());
  ctx.writeMissingAssignmentsTabNow();
  const r = fill(ctx, 'דפנה כץ', FULL);
  // Corrupt the reference cell: it must change nothing at all.
  r[col(ctx, 'עלות אוגוסט בפועל (שכר — לעיון בלבד)')] = 999999;
  const res = plain(ctx.applyMissingAssignmentsNow());
  assert.strictEqual(res.created.length, 1);
  assert.strictEqual(res.created[0].amount, 9000, 'the plan still uses the entered rate');
  const row = ctx.tabs.assignments.rows.slice(1).find(x => String(x[1]) === 'wpaid9');
  assert.ok(!row.some(cell => Number(cell) === 999999));
});

test('the log names the payroll total, so the size of the gap is stated once', () => {
  const ctx = loadCtx(seed());
  ctx.writeMissingAssignmentsTabNow();
  const log = ctx.logs.join('\n');
  assert.match(log, /₪93813/, 'all ten, from the payroll export');
  assert.match(log, /never reaches the cost engine/);
});

// ---------------------------------------------------------------------------
// the archive cross-check
// ---------------------------------------------------------------------------

test('each row says what archive_v3 remembers — a cross-check, not a verdict', () => {
  const s = seed();
  s.archive_v3.push(archivedRow('wpaid1', 'רון מנחם', 'ramot', '2026-03-31'));
  const ctx = loadCtx(s);
  ctx.writeMissingAssignmentsTabNow();
  const c = col(ctx, 'היסטוריה בארכיון');
  const withHistory = String(rowFor(ctx, 'רון מנחם')[c]);
  assert.match(withHistory, /1 שיבוץ/);
  assert.match(withHistory, /רמות השבים/, 'the house it was at');
  assert.match(withHistory, /2026-03-31/, 'and when it ended');
  assert.match(String(rowFor(ctx, 'דפנה כץ')[c]), /אין היסטוריה/, 'no trace anywhere says so plainly');
});

test('an archived history changes nothing on its own — the row still awaits a decision', () => {
  const s = seed();
  s.archive_v3.push(archivedRow('wpaid1', 'רון מנחם', 'ramot', '2026-03-31'));
  const ctx = loadCtx(s);
  const res = ctx.writeMissingAssignmentsTabNow();
  assert.strictEqual(res.count, 10, 'nobody is dropped for having a past');
  assert.strictEqual(String(rowFor(ctx, 'רון מנחם')[col(ctx, 'אשר')] || ''), '');
  assert.strictEqual(ctx.tabs.workers.rows.slice(1).length, 11, 'and nothing is archived by it');
  assert.deepStrictEqual(plain(ctx.applyMissingAssignmentsNow()).created, []);
});

test('the two verified lists describe the same ten people, and disagreeing aborts', () => {
  // Static: every name on one list is on the other, in Code.gs itself.
  const names = /const VERIFIED_PAID_WITHOUT_ASSIGNMENT = \[([\s\S]*?)\]/.exec(gs)[1]
    .split(',').map(x => x.trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert.strictEqual(names.length, 10);
  names.forEach(n => assert.ok(gs.includes("name: '" + n + "'"),
    n + ' must also appear in PAYROLL_AUGUST_FACTS'));
  assert.deepStrictEqual(names.slice().sort(), Object.keys(AUG).sort());

  // And at run time, a name with no payroll facts stops the build rather
  // than producing a row with blank reference cells.
  const patched = gs.replace(/^.*name: 'דפנה כץ'.*$/m, '');
  assert.notStrictEqual(patched, gs, 'the fixture must actually remove the entry');
  const ctx = loadCtx(seed(), patched);
  assert.throws(() => ctx.writeMissingAssignmentsTabNow(),
    /"דפנה כץ" has no row in PAYROLL_AUGUST_FACTS/);
  assert.ok(!ctx.tabs['שיבוצים חסרים'], 'and no half-built sheet is left behind');
});
