'use strict';

// The editor-run PAIRS in apps-script/Code.gs — one naming rule for every
// maintenance run that can write:
//
//   <thing>PreviewNow()   DRY RUN. Writes nothing, ever.
//   apply<Thing>Now()     WRITES. «THIS RUN WRITES» is its first log line.
//
// Both take NO arguments (the editor's Run button passes none), and both
// hand the shared core run<Thing>_(dryRun) a literal: true for the preview,
// false for the apply. The core's trailing underscore keeps it out of the
// Run dropdown, and it stays dry for anything but the literal false. No name
// of a pair is reachable over HTTP.
//
// Pinned for all five pairs, plus a guard that no dry-run parameter is left
// on a public function and no pair is missing a half.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const gs = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');

// [preview, apply, shared core]
const PAIRS = [
  ['verifiedFixesPreviewNow', 'applyVerifiedFixesNow', 'runVerifiedFixes_'],
  ['cleanupDecisionsPreviewNow', 'applyCleanupDecisionsNow', 'runCleanupDecisions_'],
  ['missingAssignmentsPreviewNow', 'applyMissingAssignmentsNow', 'runMissingAssignments_'],
  ['marketersMigrationPreviewNow', 'applyMarketersMigrationNow', 'runMarketersMigration_'],
  ['perSessionRatesMigrationPreviewNow', 'applyPerSessionRatesMigrationNow', 'runPerSessionRatesMigration_'],
];

function fakeSheet(name, rows, writes) {
  const sh = {
    name, rows, validations: [],
    getDataRange() { return { getValues: () => rows.map(r => r.slice()) }; },
    getLastRow() { return rows.length; },
    getLastColumn() { return rows.reduce((m, r) => Math.max(m, r.length), 0); },
    getMaxRows() { return Math.max(rows.length, 1); },
    getMaxColumns() { return Math.max(sh.getLastColumn(), 1); },
    setFrozenRows() { writes.push({ op: 'setFrozenRows', name }); },
    clear() { writes.push({ op: 'clear', name }); rows.length = 0; },
    appendRow(r) { writes.push({ op: 'appendRow', name }); rows.push(r.slice()); },
    deleteRow(r) { writes.push({ op: 'deleteRow', name }); rows.splice(r - 1, 1); },
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
          writes.push({ op: 'setValue', name });
          while (rows.length < r) rows.push([]);
          rows[r - 1][c - 1] = v;
          return range;
        },
        setValues(vals) {
          writes.push({ op: 'setValues', name });
          vals.forEach((row, i) => {
            while (rows.length < r + i) rows.push([]);
            row.forEach((v, j) => { rows[r - 1 + i][c - 1 + j] = v; });
          });
          return range;
        },
        setNumberFormat() { writes.push({ op: 'setNumberFormat', name }); return range; },
        clearDataValidations() { return range; },
        setDataValidation() { writes.push({ op: 'setDataValidation', name }); return range; },
      };
      return range;
    },
  };
  return sh;
}

const H_WORKERS = ['id', 'name', 'notes', 'created_at', 'shift_commitment', 'start_date',
  'gmach_month', 'phone', 'start_date_source'];

// The fixture is DERIVED from the verified facts in Code.gs, so it cannot
// drift away from them: every id the facts name gets a worker row, and so
// does every leaver name.
function factIds() {
  return [...gs.matchAll(/workerId: '([A-Za-z0-9]+)'/g)].map(m => m[1]);
}
function leaverNames() {
  const block = /const VERIFIED_LEAVERS = \[([\s\S]*?)\];/.exec(gs)[1];
  return [...block.matchAll(/name: '([^']+)'/g)].map(m => m[1]);
}

function seed() {
  const workers = [H_WORKERS];
  factIds().forEach((id, i) => {
    // The start-date fix's own id carries the future date it must correct,
    // so the plan has real work in it rather than being empty.
    workers.push([id, 'עובד ' + i, '', '2026-01-02T00:00:00.000Z', '',
      id === 'wmppe95x5vd8o' ? '2026-12-01' : '', '', '', '']);
  });
  leaverNames().forEach((name, i) => {
    workers.push(['wleaver' + i, name, '', '2026-01-02T00:00:00.000Z', '', '', '', '', '']);
  });
  return {
    workers,
    assignments: [['id', 'worker_id', 'house', 'role', 'role_detail', 'employment_type',
      'salary', 'pct', 'hourly_rate', 'est_hours', 'session_rate', 'est_sessions',
      'retainer_amount', 'notes', 'created_at', 'allowance', 'status', 'status_date',
      'rate_individual', 'sessions_individual', 'rate_group', 'sessions_group',
      'rate_external', 'external_patients', 'effective_from']],
    absences: [['id', 'worker_id', 'house', 'start_date', 'end_date', 'reason_type',
      'reason_detail', 'notes', 'status', 'created_at']],
    coverages: [['id', 'absence_id', 'covering_worker_id', 'covering_house', 'receiving_house',
      'start_date', 'end_date', 'extra_payment', 'notes', 'created_at',
      'replaced_assignment_id', 'role', 'shift_count', 'approval_status', 'approved_by', 'cancelled']],
  };
}

function loadCtx() {
  const writes = [];
  const logs = [];
  const tabs = {};
  const s = seed();
  Object.keys(s).forEach(k => { tabs[k] = fakeSheet(k, s[k].map(r => r.slice()), writes); });
  const ctx = vm.createContext({
    Logger: { log(m) { logs.push(String(m)); } },
    PropertiesService: {
      getScriptProperties() {
        return { getProperty(k) { return k === 'SHEET_ID' ? 'sheet-1' : null; } };
      },
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput(t) { return { _text: t, setMimeType() { return this; } }; },
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
        const b = {
          requireValueInList(list) { rule.values = list.slice(); return b; },
          setAllowInvalid(v) { rule.allowInvalid = v; return b; },
          build() { return rule; },
        };
        return b;
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
  ctx.todayLocal = () => '2026-09-20';
  ctx.tabs = tabs;
  ctx.writes = writes;
  ctx.logs = logs;
  return ctx;
}

// ---------------------------------------------------------------------------
// each pair
// ---------------------------------------------------------------------------

PAIRS.forEach(([preview, apply, core]) => {
  test(apply + ' calls ' + core + '(false) — exactly once, with the literal false', () => {
    const ctx = loadCtx();
    const calls = [];
    ctx[core] = function () { calls.push([...arguments]); return { stub: true }; };
    const out = ctx[apply]();
    assert.strictEqual(calls.length, 1, 'exactly once');
    assert.strictEqual(calls[0].length, 1, 'with one argument');
    assert.strictEqual(calls[0][0], false, 'and that argument is the literal false');
    assert.deepStrictEqual(out, { stub: true }, 'and the result is passed straight back');
  });

  test(preview + ' calls ' + core + '(true) — exactly once, and never the write', () => {
    const ctx = loadCtx();
    const calls = [];
    ctx[core] = function () { calls.push([...arguments]); return { stub: true }; };
    ctx[preview]();
    assert.deepStrictEqual(calls, [[true]]);
  });

  test(apply + ' says THIS RUN WRITES first, and names ' + preview, () => {
    const ctx = loadCtx();
    ctx[core] = function () { ctx.logs.push('(the function ran)'); return {}; };
    ctx[apply]();
    const first = ctx.logs[0];
    assert.match(first, /^THIS RUN WRITES/, 'the first line, before anything happens');
    assert.ok(first.includes(preview + '()'), 'and it names the dry run: ' + first);
    assert.strictEqual(ctx.logs.indexOf('(the function ran)'), 1, 'the warning comes BEFORE the work');
  });

  test(preview + ' and ' + apply + ' take no arguments, so the Run button can start either', () => {
    const ctx = loadCtx();
    assert.strictEqual(ctx[preview].length, 0);
    assert.strictEqual(ctx[apply].length, 0);
    assert.ok(gs.includes('function ' + preview + '() {'));
    assert.ok(gs.includes('function ' + apply + '() {'));
    assert.ok(gs.includes('function ' + core + '(dryRun) {'), core + ' is the one with the parameter');
  });

  test(preview + ' (for real, no stub) is a dry run that writes nothing', () => {
    const ctx = loadCtx();
    ctx.writes.length = 0;
    const res = ctx[preview]();
    assert.strictEqual(res.dryRun, true);
    assert.deepStrictEqual(ctx.writes, [], 'writes nothing');
  });

  test(core + ' stays dry for every value that is not the literal false', () => {
    [undefined, true, 0, null, '', NaN, 'false'].forEach(arg => {
      const ctx = loadCtx();
      ctx.writes.length = 0;
      assert.strictEqual(ctx[core](arg).dryRun, true, String(arg) + ' must not write');
      assert.deepStrictEqual(ctx.writes, [], String(arg) + ' must write nothing');
    });
  });

  test('no name of the ' + apply + ' pair is an HTTP action', () => {
    const ctx = loadCtx();
    [preview, apply, core].forEach(action => {
      const out = ctx.doPost({ parameter: {}, postData: { contents: JSON.stringify({
        action, secret: 'x' }) } });
      assert.ok(JSON.parse(out._text).error, action + ' must not be an HTTP action');
    });
  });
});

// ---------------------------------------------------------------------------
// the rule, for the whole file
// ---------------------------------------------------------------------------

test('every dry run ends in PreviewNow and every write is apply…Now — and each has its other half', () => {
  const fns = [...gs.matchAll(/^function (\w+)\(([^)]*)\)/gm)].map(m => ({ name: m[1], args: m[2].trim() }));
  const previews = fns.filter(f => /PreviewNow$/.test(f.name)).map(f => f.name).sort();
  const applies = fns.filter(f => /^apply\w+Now$/.test(f.name)).map(f => f.name).sort();
  assert.deepStrictEqual(previews, PAIRS.map(p => p[0]).sort(), 'a new PreviewNow needs a row in PAIRS');
  assert.deepStrictEqual(applies, PAIRS.map(p => p[1]).sort(), 'a new apply…Now needs a row in PAIRS');
  // No function the Run dropdown shows (no trailing underscore) takes a
  // dryRun parameter: it could never be set to false from there.
  const visibleDry = fns.filter(f => /\bdryRun\b/.test(f.args) && !/_$/.test(f.name)).map(f => f.name);
  assert.deepStrictEqual(visibleDry, [], 'a dryRun parameter on a Run-dropdown function');
  // Every hidden dry-run core belongs to exactly one pair.
  const cores = fns.filter(f => /\bdryRun\b/.test(f.args)).map(f => f.name).sort();
  assert.deepStrictEqual(cores, PAIRS.map(p => p[2]).sort());
});

test('the retired names are gone — no half-renamed pair left behind', () => {
  ['applyVerifiedFixesForRealNow', 'applyCleanupDecisionsForRealNow', 'applyMissingAssignmentsForRealNow',
    'migrateMarketersNow', 'migratePerSessionRatesToThreeRate', 'dryRunMigratePerSessionRatesToThreeRate',
    '_migratePerSessionRates'].forEach(name => {
    assert.ok(!new RegExp('\\b' + name + '\\b').test(gs), name + ' is still in Code.gs');
  });
  // Every log hint names a function the Run button can start.
  const hints = [...gs.matchAll(/Run (\w+)\(([^)]*)\) to /g)];
  assert.ok(hints.length >= 4, 'the hints were found');
  hints.forEach(m => assert.strictEqual(m[2], '', m[1] + '(' + m[2] + ') cannot be started from the dropdown'));
});

test('the per-session migration: preview counts without writing (not even headers), apply writes', () => {
  const row = ['a1', 'w1', 'ramot', 'מטפל/ת', '', 'per_session', 0, 0, 0, 0, 200, 10, 0, '',
    '2026-01-02T00:00:00.000Z', 0, 'active', '', '', '', 0, 0, 0, 0, ''];
  const ctx = loadCtx();
  ctx.tabs.assignments.rows.push(row.slice());
  ctx.writes.length = 0;
  const pv = ctx.perSessionRatesMigrationPreviewNow();
  assert.deepStrictEqual([pv.dryRun, pv.migrated], [true, 1]);
  assert.deepStrictEqual(ctx.writes, [], 'the preview writes nothing at all');
  const ap = ctx.applyPerSessionRatesMigrationNow();
  assert.deepStrictEqual([ap.dryRun, ap.migrated], [false, 1]);
  const r = ctx.tabs.assignments.rows[1];
  assert.deepStrictEqual([r[18], r[19]], [200, 10], 'rate_individual / sessions_individual filled');
  assert.strictEqual(ctx.applyPerSessionRatesMigrationNow().migrated, 0, 'and it is idempotent');
});
