'use strict';

// applyVerifiedFixesNow(dryRun) and logMonthTotalsNow(months) — the
// payroll-verified maintenance functions in apps-script/Code.gs.
//
// What is pinned here, in the order it matters:
//   - FAIL LOUDLY. A verified fact names a person. A name that matches two
//     workers, or none, aborts the WHOLE run before a single write — in a
//     dry run exactly as in an apply run.
//   - DRY RUN BY DEFAULT. Only the literal `false` writes anything.
//   - A payroll-floor date is never a confirmed date: it is written with
//     start_date_source = 'payroll_floor', the cost engine tags every line
//     it prices, and a date entered by a person clears the tag.
//   - A leaver is ARCHIVED, never deleted, and never while placed.
//   - logMonthTotalsNow writes nothing at all.
//
// Code.gs has no JS harness, so it is evaluated in a vm sandbox over
// in-memory sheets, with the deployed cost engine loaded beside it exactly
// as clasp deploys it.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const gs = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
const engineGs = fs.readFileSync(path.join(ROOT, 'apps-script', 'CostEngine.gs'), 'utf8');

const TODAY = '2026-09-17';

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

function loadCtx(seed) {
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
  // The cost engine is deployed beside Code.gs, so the sandbox loads it the
  // same way: one global, assigned by the UMD tail.
  vm.runInContext(engineGs, ctx);
  vm.runInContext(gs, ctx);
  ctx.todayLocal = () => TODAY;
  ctx.tabs = tabs;
  ctx.writes = writes;
  ctx.logs = logs;
  return ctx;
}

function plain(v) { return JSON.parse(JSON.stringify(v)); }

// A worker row. `source` is the appended start_date_source column.
function w(id, name, startDate, source) {
  return [id, name, '', '2026-01-02T00:00:00.000Z', '', startDate || '', '', '', source || ''];
}
function ft(id, workerId, house, salary) {
  return [id, workerId, house, 'מדריך/ה', '', 'full_time', salary === undefined ? 10000 : salary,
    100, 0, 0, 0, 0, 0, '', '2026-01-02T00:00:00.000Z', 0, 'active', '',
    0, 0, 0, 0, 0, 0, ''];
}

// The eight payroll-floor worker ids and the rename target, exactly as the
// production «דוח תקינות» tab prints them.
const FL = ['wmppe7df8du66', 'wmppe7ki6k9oi', 'wmppe7np0sv8u', 'wmppeb6asz4v7',
  'wmppe9mr3fv2z', 'wmppe805nlehh', 'wmppeeqxzqs7m', 'wmrc0am7cy2gv'];
const REN = 'wmrrld1h8vpg7';

// The live shape: the typo worker, the four leavers, the eight floors, the
// rename, plus one placed worker with a hand-entered date as a control.
function seed(extra) {
  const workers = [
    H.workers,
    w('wmppe95x5vd8o', 'שובל לובטון', '2026-12-01'),
    w('wlead1', 'שלומציון כהן'),
    w('wlead2', 'דן רובינסון'),
    w('wlead3', 'ניר לוי'),
    w('wlead4', 'שלי הלפט'),
    // The ids are the live ones from «דוח תקינות»: every fact in this
    // section is keyed on an id, so a fixture keyed on anything else would
    // be testing a different program.
    w(FL[0], 'sergei makarov'),
    w(FL[1], 'שחר מזור'),
    w(FL[2], 'מעיין דלומי'),
    w(FL[3], 'חנן וייל'),
    w(FL[4], 'אלה שפירא'),
    w(FL[5], 'עדי איזנברג'),
    w(FL[6], 'בן ציון אדרי'),
    w(FL[7], 'אורן סילמניק'),
    w(REN, 'אתי (אסתר) דבוש'),
    w('wok', 'עובדת תקינה', '2026-03-01'),
  ];
  const assignments = [
    H.assignments,
    ft('a-typo', 'wmppe95x5vd8o', 'ramot'),
    ft('a-fl1', FL[0], 'asher'),
    ft('a-ok', 'wok', 'pardes'),
  ];
  return Object.assign({
    workers, assignments,
    absences: [H.absences],
    coverages: [H.coverages],
    archive_v3: [H.archive_v3],
    monthly_actuals: [H.monthly_actuals],
    budgets: [H.budgets],
  }, extra || {});
}

function workerRow(ctx, id) {
  return ctx.tabs.workers.rows.slice(1).find(r => String(r[0]) === id);
}
function workerIds(ctx) {
  return ctx.tabs.workers.rows.slice(1).map(r => String(r[0]));
}
function auditRows(ctx) {
  const sh = ctx.tabs.audit_log;
  return sh ? sh.rows.slice(1) : [];
}

// ---------------------------------------------------------------------------
// logMonthTotalsNow — read-only
// ---------------------------------------------------------------------------

test('logMonthTotalsNow writes NOTHING — not a tab, not the audit log', () => {
  const ctx = loadCtx(seed());
  ctx.writes.length = 0;
  ctx.logMonthTotalsNow();
  assert.deepStrictEqual(ctx.writes, [], 'a baseline must never change what it measures');
});

test('logMonthTotalsNow defaults to 08 / 09 / 10 of 2026', () => {
  const ctx = loadCtx(seed());
  const out = plain(ctx.logMonthTotalsNow());
  assert.deepStrictEqual(out.map(m => m.month), ['2026-08', '2026-09', '2026-10']);
});

test('the three buckets sum to the total, per month and per house', () => {
  const ctx = loadCtx(seed());
  plain(ctx.logMonthTotalsNow(['2026-08'])).forEach(m => {
    assert.strictEqual(
      m.actualConfirmed + m.estimated + m.missingDataCost, m.projectedTotal,
      'the invariant the whole report rests on');
    Object.keys(m.byHouse).forEach(h => {
      const hb = m.byHouse[h];
      assert.strictEqual(hb.actualConfirmed + hb.estimated + hb.missingDataCost,
        hb.projectedTotal, h + ' must balance too');
    });
  });
});

test('with no monthly_actuals the confirmed figure is ₪0 and the log says so', () => {
  const ctx = loadCtx(seed());
  const out = plain(ctx.logMonthTotalsNow(['2026-08']))[0];
  assert.strictEqual(out.hasActuals, false);
  assert.strictEqual(out.actualConfirmed, 0);
  assert.ok(ctx.logs.join('\n').includes('no real hours or sessions recorded for 2026-08'));
});

test('logMonthTotalsNow refuses a month that is not YYYY-MM', () => {
  const ctx = loadCtx(seed());
  assert.throws(() => ctx.logMonthTotalsNow(['August']), /not a YYYY-MM month/);
  assert.deepStrictEqual(ctx.writes.filter(x => x.op !== 'insertSheet'), []);
});

test('it fails loudly when the engine was not deployed, instead of a ReferenceError', () => {
  const ctx = loadCtx(seed());
  ctx.CostEngine = null;
  vm.runInContext('globalThis.CostEngine = null;', ctx);
  assert.throws(() => ctx.logMonthTotalsNow(), /CostEngine is not in this Apps Script project/);
});

// ---------------------------------------------------------------------------
// fail loudly
// ---------------------------------------------------------------------------

test('a name that matches TWO workers aborts the whole run — nothing is written', () => {
  const s = seed();
  s.workers.push(w('wdup', 'ניר לוי'));   // a second ניר לוי
  const ctx = loadCtx(s);
  ctx.writes.length = 0;
  assert.throws(() => ctx.applyVerifiedFixesNow(false),
    /NOTHING was written.*matches 2 workers \(wlead3, wdup\)/s);
  assert.deepStrictEqual(ctx.writes, [], 'not one cell, not even for the unambiguous fixes');
  // The unambiguous fixes really did not happen.
  assert.strictEqual(String(workerRow(ctx, 'wmppe95x5vd8o')[5]), '2026-12-01');
  assert.strictEqual(String(workerRow(ctx, FL[0])[5]), '');
  assert.ok(workerIds(ctx).includes('wlead1'), 'and no leaver was archived');
});

test('the dry run aborts on the same ambiguity, so it is found while it is cheap', () => {
  const s = seed();
  s.workers.push(w('wdup', 'ניר לוי'));
  const ctx = loadCtx(s);
  assert.throws(() => ctx.applyVerifiedFixesNow(), /matches 2 workers/);
});

test('a verified leaver NAME that matches no worker is a no-op, not an abort', () => {
  // The leavers are the one group with no id: the name is their only
  // identifier, so a name that has already gone means the row was archived.
  const s = seed();
  s.workers = s.workers.filter(r => r[1] !== 'שלומציון כהן');
  const ctx = loadCtx(s);
  const res = plain(ctx.applyVerifiedFixesNow());
  assert.ok(res.alreadyDone.some(d => /already archived/.test(d.why)));
});

test('a verified leaver NAME that matches two workers still aborts', () => {
  const s = seed();
  s.workers.push(w('wdup', 'ניר לוי'));
  const ctx = loadCtx(s);
  ctx.writes.length = 0;
  assert.throws(() => ctx.applyVerifiedFixesNow(false), /matches 2 workers/);
  assert.deepStrictEqual(ctx.writes, []);
});

// ---------------------------------------------------------------------------
// the id is authoritative
// ---------------------------------------------------------------------------

test('an id that is not in the roster ABORTS the whole run', () => {
  const s = seed();
  s.workers = s.workers.filter(r => r[0] !== FL[1]);   // שחר מזור's row, by id
  const ctx = loadCtx(s);
  ctx.writes.length = 0;
  assert.throws(() => ctx.applyVerifiedFixesNow(false),
    new RegExp('no worker with id ' + FL[1]));
  assert.deepStrictEqual(ctx.writes, [], 'and nothing else in the batch is applied either');
});

test('a name that disagrees with the id is a WARNING — the id wins and the run proceeds', () => {
  const s = seed();
  // Same person, renamed in the sheet since the fact was written down.
  s.workers = s.workers.map(r => (r[0] === FL[1] ? w(FL[1], 'שחר מזור-לוי') : r));
  const ctx = loadCtx(s);
  const res = plain(ctx.applyVerifiedFixesNow(false));

  const row = workerRow(ctx, FL[1]);
  assert.strictEqual(String(row[5]), '2026-01-01', 'the floor is still written');
  assert.strictEqual(String(row[8]), 'payroll_floor');
  assert.strictEqual(String(row[1]), 'שחר מזור-לוי', 'and the sheet name is left alone');
  assert.strictEqual(res.warnings.length, 1);
  assert.match(res.warnings[0], /is "שחר מזור-לוי", the fact says "שחר מזור"/);
  assert.match(res.warnings[0], /proceeding on the id/);
  assert.match(ctx.logs.join('\n'), /WARN \| payroll floor: /, 'and it is never swallowed');
});

test('the same rule covers the start-date typo: a differing name never aborts it', () => {
  const s = seed();
  s.workers = s.workers.map(r => (r[0] === 'wmppe95x5vd8o' ? w(r[0], 'מישהו אחר', '2026-12-01') : r));
  const ctx = loadCtx(s);
  const res = plain(ctx.applyVerifiedFixesNow(false));
  assert.strictEqual(String(workerRow(ctx, 'wmppe95x5vd8o')[5]), '2026-01-01');
  assert.ok(res.warnings.some(x => /start date fix.*"מישהו אחר"/.test(x)));
});

test('a leaver who still holds a placement aborts the run rather than orphaning cost', () => {
  const s = seed();
  s.assignments.push(ft('a-lead1', 'wlead1', 'rehab'));
  const ctx = loadCtx(s);
  ctx.writes.length = 0;
  assert.throws(() => ctx.applyVerifiedFixesNow(false),
    /still holds 1 assignment\(s\).*Resolve that first/s);
  assert.deepStrictEqual(ctx.writes, []);
});

// ---------------------------------------------------------------------------
// dry run by default
// ---------------------------------------------------------------------------

test('with no argument it is a DRY RUN and writes nothing at all', () => {
  const ctx = loadCtx(seed());
  ctx.writes.length = 0;
  const res = plain(ctx.applyVerifiedFixesNow());
  assert.strictEqual(res.dryRun, true);
  assert.ok(res.planned.length > 0, 'it still says what it would do');
  assert.deepStrictEqual(ctx.writes, []);
});

test('anything other than the literal false stays a dry run', () => {
  [true, 'false', 1, 0, null, ''].forEach(arg => {
    const ctx = loadCtx(seed());
    ctx.writes.length = 0;
    const res = plain(ctx.applyVerifiedFixesNow(arg));
    assert.strictEqual(res.dryRun, true, String(arg) + ' must not apply');
    assert.deepStrictEqual(ctx.writes, [], String(arg) + ' must write nothing');
  });
});

// A dry run whose plan nobody can read is not a dry run. This is the bug
// the early return introduced and the reason the log is asserted, not just
// the returned object.
test('the dry run LOGS the plan, line by line, and says how to apply it', () => {
  const ctx = loadCtx(seed());
  ctx.applyVerifiedFixesNow();
  const log = ctx.logs.join('\n');
  assert.match(log, /DRY RUN — nothing was written\. 14 change\(s\) planned/);
  assert.match(log, /plan \| start_date \| שובל לובטון \| 2026-12-01 → 2026-01-01/);
  assert.match(log, /plan \| start_floor \| sergei makarov \| \(blank\) → 2026-01-01 \[payroll_floor\]/);
  assert.match(log, /plan \| rename \| אתי \(אסתר\) דבוש .* → אתי אסתר דבוש/);
  assert.match(log, /plan \| archive \| שלומציון כהן/);
  assert.match(log, /Run applyVerifiedFixesNow\(false\) to apply/);
  assert.match(log, /Run logMonthTotalsNow\(\) before and after/);
});

test('an apply run with nothing left to do still says so in the log', () => {
  const ctx = loadCtx(seed());
  ctx.applyVerifiedFixesNow(false);
  ctx.logs.length = 0;
  ctx.applyVerifiedFixesNow(false);
  assert.match(ctx.logs.join('\n'), /APPLIED\. 0 change\(s\) planned, 0 applied, 14 already in place/);
});

test('the dry run plans exactly the verified facts: 1 typo, 8 floors, 1 rename, 4 leavers', () => {
  const ctx = loadCtx(seed());
  const res = plain(ctx.applyVerifiedFixesNow());
  const kinds = {};
  res.planned.forEach(a => { kinds[a.kind] = (kinds[a.kind] || 0) + 1; });
  assert.deepStrictEqual(kinds, { start_date: 1, start_floor: 8, rename: 1, archive: 4 });
});

// ---------------------------------------------------------------------------
// applying
// ---------------------------------------------------------------------------

test('(A) the future-start typo becomes 2026-01-01, as a CONFIRMED date', () => {
  const ctx = loadCtx(seed());
  ctx.applyVerifiedFixesNow(false);
  const row = workerRow(ctx, 'wmppe95x5vd8o');
  assert.strictEqual(String(row[5]), '2026-01-01');
  assert.strictEqual(String(row[8] || ''), '', 'a verified exact date carries no source tag');
});

test('(A) the assignments of the typo worker are not touched', () => {
  const ctx = loadCtx(seed());
  const before = JSON.stringify(ctx.tabs.assignments.rows);
  ctx.applyVerifiedFixesNow(false);
  assert.strictEqual(JSON.stringify(ctx.tabs.assignments.rows), before);
});

test('(D) a floor is written as the 1st of the month AND tagged payroll_floor', () => {
  const ctx = loadCtx(seed());
  ctx.applyVerifiedFixesNow(false);
  [[FL[0], '2026-01-01'], [FL[4], '2026-02-01'], [FL[5], '2026-03-01'],
    [FL[6], '2026-05-01'], [FL[7], '2026-06-01']].forEach(([id, date]) => {
    const row = workerRow(ctx, id);
    assert.strictEqual(String(row[5]), date, id + ' start date');
    assert.strictEqual(String(row[8]), 'payroll_floor', id + ' must be tagged as a floor');
  });
});

test('(D) a floor NEVER overwrites a date a person entered', () => {
  const s = seed();
  s.workers = s.workers.map(r => (r[0] === FL[1] ? w(FL[1], 'שחר מזור', '2026-01-17') : r));
  const ctx = loadCtx(s);
  const res = plain(ctx.applyVerifiedFixesNow(false));
  assert.strictEqual(String(workerRow(ctx, FL[1])[5]), '2026-01-17', 'the exact date stands');
  assert.ok(res.alreadyDone.some(d => /keeping the entered date 2026-01-17/.test(d.why)));
});

test('(E) the parenthesised name is rewritten', () => {
  const ctx = loadCtx(seed());
  ctx.applyVerifiedFixesNow(false);
  assert.strictEqual(String(workerRow(ctx, REN)[1]), 'אתי אסתר דבוש');
});

test('(C) a leaver is MOVED to workers_archive with its reason — never deleted', () => {
  const ctx = loadCtx(seed());
  ctx.applyVerifiedFixesNow(false);
  ['wlead1', 'wlead2', 'wlead3', 'wlead4'].forEach(id => {
    assert.ok(!workerIds(ctx).includes(id), id + ' leaves the live roster');
  });
  const arch = ctx.tabs.workers_archive;
  assert.ok(arch, 'workers_archive is created on first use');
  const row = arch.rows.slice(1).find(r => String(r[0]) === 'wlead1');
  assert.ok(row, 'the row survives in full');
  assert.strictEqual(String(row[1]), 'שלומציון כהן');
  assert.strictEqual(String(row[8]), 'העבר לארכיון');
  assert.strictEqual(String(row[9]), 'לא מופיע/ה בדוח השכר מאז ינואר 2026');
  assert.ok(String(row[11]).length > 0, 'and when it happened');
});

test('every applied change lands in the audit log with the verified reason', () => {
  const ctx = loadCtx(seed());
  ctx.applyVerifiedFixesNow(false);
  const rows = auditRows(ctx);
  assert.ok(rows.length > 0);
  rows.forEach(r => {
    assert.strictEqual(String(r[1]), 'applyVerifiedFixes');
    assert.ok(String(r[7]).startsWith('תיקון מאומת מול דוח שכר'),
      'the reason names what it was checked against: ' + r[7]);
  });
  const floor = rows.find(r => String(r[3]) === FL[0] && String(r[4]) === 'start_date');
  assert.strictEqual(String(floor[5]), '', 'from blank');
  assert.strictEqual(String(floor[6]), '2026-01-01', 'to the floor');
  const src = rows.find(r => String(r[3]) === FL[0] && String(r[4]) === 'start_date_source');
  assert.strictEqual(String(src[6]), 'payroll_floor', 'and the source is audited as its own field');
  const arch = rows.find(r => String(r[3]) === 'wlead1' && String(r[4]) === 'tab');
  assert.strictEqual(String(arch[6]), 'workers_archive');
});

test('running it twice changes nothing the second time', () => {
  const ctx = loadCtx(seed());
  ctx.applyVerifiedFixesNow(false);
  const snapshot = JSON.stringify(ctx.tabs.workers.rows);
  ctx.writes.length = 0;
  const second = plain(ctx.applyVerifiedFixesNow(false));
  assert.deepStrictEqual(second.planned, [], 'nothing left to do');
  assert.strictEqual(second.alreadyDone.length, 14, 'and it says so, fact by fact');
  assert.strictEqual(JSON.stringify(ctx.tabs.workers.rows), snapshot);
  assert.deepStrictEqual(ctx.writes, []);
});

// ---------------------------------------------------------------------------
// a floor is never a confirmed date
// ---------------------------------------------------------------------------

test('a payroll_floor date is reported as an ESTIMATE, never as confirmed', () => {
  const ctx = loadCtx(seed());
  ctx.applyVerifiedFixesNow(false);
  const report = plain(ctx.computeDataIntegrityReport_(ctx.readAllForIntegrity_(), TODAY));
  const f = report.findings.find(x => x.code === 'ESTIMATED_START_DATE' && x.workerId === FL[0]);
  assert.ok(f, 'the worker stays visible in the report after the fix');
  assert.strictEqual(f.severity, 'info');
  assert.match(f.detail, /payroll floor, not a confirmed date/);
  // And the engine agrees, on the line that prices the money.
  const month = plain(ctx.logMonthTotalsNow(['2026-08']))[0];
  assert.ok(month.startDateEstimatedLines >= 1);
});

test('a date entered by hand afterwards CLEARS the floor tag', () => {
  const ctx = loadCtx(seed());
  ctx.applyVerifiedFixesNow(false);
  assert.strictEqual(String(workerRow(ctx, FL[0])[8]), 'payroll_floor');
  ctx.setWorkerStartDates({ updates: [{ id: FL[0], startDate: '2026-01-19' }] });
  const row = workerRow(ctx, FL[0]);
  assert.strictEqual(String(row[5]), '2026-01-19');
  assert.strictEqual(String(row[8] || ''), '', 'a person typing a date outranks a reconstruction');
  const audit = auditRows(ctx).find(r => String(r[4]) === 'start_date_source' &&
    String(r[1]) === 'setWorkerStartDate');
  assert.ok(audit, 'and dropping the tag is itself audited');
  assert.strictEqual(String(audit[5]), 'payroll_floor');
  assert.strictEqual(String(audit[6]), '');
});

test('updateWorker clears the tag the same way', () => {
  const ctx = loadCtx(seed());
  ctx.applyVerifiedFixesNow(false);
  ctx.updateWorker({ id: FL[0], worker: { name: 'sergei makarov', startDate: '2026-01-19' } });
  assert.strictEqual(String(workerRow(ctx, FL[0])[8] || ''), '');
});

// ---------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------

test('these are EDITOR-RUN ONLY — no HTTP action can reach them', () => {
  const ctx = loadCtx(seed());
  ['applyVerifiedFixes', 'applyVerifiedFixesNow', 'applyVerifiedFixesForRealNow',
    'logMonthTotals', 'logMonthTotalsNow', 'writeMissingAssignmentsTabNow',
    'applyMissingAssignmentsNow', 'applyMissingAssignmentsForRealNow'].forEach(action => {
    const out = ctx.doPost({ parameter: {}, postData: { contents: JSON.stringify({
      action, secret: 'x' }) } });
    const body = JSON.parse(out._text);
    assert.ok(body.error, action + ' must not be an HTTP action');
    assert.ok(!/applied|created/.test(JSON.stringify(body)), action + ' must do nothing over HTTP');
  });
});

test('the verified facts are DATA, so what was checked is readable without reading logic', () => {
  assert.ok(/const VERIFIED_START_DATE_FIXES = \[/.test(gs));
  assert.ok(/const VERIFIED_LEAVERS = \[/.test(gs));
  assert.ok(/const VERIFIED_START_DATE_FLOORS = \[/.test(gs));
  assert.ok(/const VERIFIED_RENAMES = \[/.test(gs));
  assert.ok(/const VERIFIED_PAID_WITHOUT_ASSIGNMENT = \[/.test(gs));
  assert.ok(/const VERIFIED_FIX_REASON = 'תיקון מאומת מול דוח שכר'/.test(gs));
});

// ---------------------------------------------------------------------------
// the rename is computed from the sheet, not from a literal
// ---------------------------------------------------------------------------

test('the new name is derived from the STORED value, whatever it happens to be', () => {
  const s = seed();
  // A different spelling from the one written down in the fact: the
  // transform still does the right thing, because it reads the cell.
  s.workers = s.workers.map(r => (r[0] === REN ? w(REN, 'אתי (אסתי) דבוש כהן') : r));
  const ctx = loadCtx(s);
  const res = plain(ctx.applyVerifiedFixesNow(false));
  assert.strictEqual(String(workerRow(ctx, REN)[1]), 'אתי אסתי דבוש כהן',
    'every word survives; only the brackets go');
  assert.ok(res.warnings.some(x => /rename: /.test(x)), 'and the differing name is flagged');
});

test('fullwidth brackets and the spacing they leave behind are handled too', () => {
  const s = seed();
  s.workers = s.workers.map(r => (r[0] === REN ? w(REN, 'אתי （אסתר） דבוש') : r));
  const ctx = loadCtx(s);
  ctx.applyVerifiedFixesNow(false);
  assert.strictEqual(String(workerRow(ctx, REN)[1]), 'אתי אסתר דבוש');
});

test('a stored name with no brackets is left alone, and said to be done', () => {
  const s = seed();
  s.workers = s.workers.map(r => (r[0] === REN ? w(REN, 'אתי אסתר דבוש') : r));
  const ctx = loadCtx(s);
  const res = plain(ctx.applyVerifiedFixesNow(false));
  assert.ok(!res.planned.some(a => a.kind === 'rename'));
  assert.ok(res.alreadyDone.some(d => /nothing to strip/.test(d.why)));
  assert.strictEqual(String(workerRow(ctx, REN)[1]), 'אתי אסתר דבוש');
});

// ---------------------------------------------------------------------------
// the month log says what it means
// ---------------------------------------------------------------------------

test('a per-house variance is logged as a signed number, never as an object', () => {
  const s = seed();
  // pardes costs ₪10,000 in August (the control worker's placement).
  s.budgets.push(['b1', 'pardes', '2026-08', 50000, '', '', '']);
  s.budgets.push(['b2', 'asher', '2026-08', 1000, '', '', '']);
  const ctx = loadCtx(s);
  ctx.logMonthTotalsNow(['2026-08']);
  const log = ctx.logs.join('\n');
  assert.ok(!/\[object Object\]/.test(log), 'the bug this test exists for');
  assert.match(log, /pardes: .*budget 50000 \| variance \+40000 \(under · 20% of budget · ok\)/);
  assert.match(log, /asher: .*budget 1000 \| variance -9000 \(OVER/, 'over budget reads as over');
});

test('a house with no budget says so instead of printing a null', () => {
  const ctx = loadCtx(seed());
  ctx.logMonthTotalsNow(['2026-08']);
  assert.ok(!/variance null/.test(ctx.logs.join('\n')));
});

test('a house whose cost is mostly missing-data money is called out', () => {
  const s = seed();
  // One undated worker at a house of their own: 100% missing-data money.
  s.workers.push(w('wsde', 'ללא תאריך'));
  s.assignments.push(ft('a-sde', 'wsde', 'sde_eliezer', 13000));
  const ctx = loadCtx(s);
  const out = plain(ctx.logMonthTotalsNow(['2026-08']))[0];

  assert.strictEqual(out.byHouse.sde_eliezer.missingDataPct, 100);
  const alert = out.missingDataAlerts.find(a => a.house === 'sde_eliezer');
  assert.ok(alert, 'the house is named in the returned alerts, not only in the log');
  assert.strictEqual(alert.missingDataCost, 13000);
  assert.strictEqual(alert.projectedTotal, 13000);
  out.missingDataAlerts.forEach(a => assert.ok(a.pct > 50,
    a.house + ' was alerted at ' + a.pct + '% — below the threshold'));
  const log = ctx.logs.join('\n');
  assert.match(log, /!! sde_eliezer: 100% of its total is missing-data money \(13000 of 13000\)/);
  assert.match(log, /cannot be .*defended until the missing dates and rates are filled in/s);
});

test('a house below the threshold is NOT called out', () => {
  const s = seed();
  s.workers.push(w('wsde', 'ללא תאריך'));
  s.workers.push(w('wsde2', 'עם תאריך', '2020-01-01'));
  s.assignments.push(ft('a-sde', 'wsde', 'sde_eliezer', 4000));
  s.assignments.push(ft('a-sde2', 'wsde2', 'sde_eliezer', 10000));
  const ctx = loadCtx(s);
  const out = plain(ctx.logMonthTotalsNow(['2026-08']))[0];
  assert.ok(out.byHouse.sde_eliezer.missingDataPct < 50, 'the premise: under the threshold');
  assert.ok(!out.missingDataAlerts.some(a => a.house === 'sde_eliezer'));
  assert.ok(!/!! sde_eliezer/.test(ctx.logs.join('\n')));
});

test('the alert threshold is a named constant, not a number buried in a branch', () => {
  assert.ok(/const MISSING_DATA_HOUSE_ALERT_PCT = 50/.test(gs));
});
