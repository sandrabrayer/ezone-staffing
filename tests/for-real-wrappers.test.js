'use strict';

// The *ForRealNow wrappers in apps-script/Code.gs.
//
// The Apps Script editor's Run button calls the selected function with NO
// arguments. That makes `applyXNow(false)` untriggerable from the dropdown —
// every Run is a dry run — and the only way round it would be hand-editing
// deployed code in the editor, which is worse than the problem.
//
// So each dry-run-first function has a zero-argument twin. What is pinned
// here is the whole contract:
//   - the wrapper calls its function with the literal `false`, exactly once;
//   - it says THIS RUN WRITES before anything happens, and names the dry run;
//   - the bare function is UNCHANGED: called with no arguments it is still a
//     dry run, and it still writes nothing;
//   - neither name is reachable over HTTP.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const gs = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');

// wrapper → the function it must call.
const PAIRS = [
  ['applyVerifiedFixesForRealNow', 'applyVerifiedFixesNow'],
  ['applyCleanupDecisionsForRealNow', 'applyCleanupDecisionsNow'],
  ['applyMissingAssignmentsForRealNow', 'applyMissingAssignmentsNow'],
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
// the wrapper
// ---------------------------------------------------------------------------

PAIRS.forEach(([wrapper, target]) => {
  test(wrapper + ' calls ' + target + '(false) — exactly once, with the literal false', () => {
    const ctx = loadCtx();
    const calls = [];
    ctx[target] = function () { calls.push([...arguments]); return { stub: true }; };
    const out = ctx[wrapper]();

    assert.strictEqual(calls.length, 1, 'exactly once');
    assert.strictEqual(calls[0].length, 1, 'with one argument');
    assert.strictEqual(calls[0][0], false, 'and that argument is the literal false');
    assert.notStrictEqual(calls[0][0], 0, 'not a falsy stand-in');
    assert.deepStrictEqual(out, { stub: true }, 'and the result is passed straight back');
  });

  test(wrapper + ' says THIS RUN WRITES first, and names the dry run', () => {
    const ctx = loadCtx();
    ctx[target] = function () { ctx.logs.push('(the function ran)'); return {}; };
    ctx[wrapper]();

    assert.ok(ctx.logs.length, 'it logs something');
    const first = ctx.logs[0];
    assert.match(first, /THIS RUN WRITES/, 'the first line, before anything happens');
    assert.ok(first.indexOf(target + '()') >= 0, 'and it names the dry run: ' + first);
    assert.match(first, /DRY RUN/);
    assert.strictEqual(ctx.logs.indexOf('(the function ran)'), 1,
      'the warning comes BEFORE the work, not after it');
  });

  test(wrapper + ' takes no arguments, so the Run button can trigger it', () => {
    const ctx = loadCtx();
    assert.strictEqual(ctx[wrapper].length, 0);
  });

  test(target + ' is UNCHANGED: no argument is still a dry run that writes nothing', () => {
    const ctx = loadCtx();
    ctx.writes.length = 0;
    const res = ctx[target]();
    assert.strictEqual(res.dryRun, true, 'still dry by default');
    assert.deepStrictEqual(ctx.writes, [], 'and still writes nothing');
  });

  test(target + ' stays dry for every falsy value that is not `false`', () => {
    [undefined, 0, null, '', NaN, 'false'].forEach(arg => {
      const ctx = loadCtx();
      ctx.writes.length = 0;
      assert.strictEqual(ctx[target](arg).dryRun, true, String(arg) + ' must not write');
      assert.deepStrictEqual(ctx.writes, [], String(arg) + ' must write nothing');
    });
  });

  test(wrapper + ' is EDITOR-RUN ONLY — no HTTP action reaches it', () => {
    const ctx = loadCtx();
    [wrapper, target].forEach(action => {
      const out = ctx.doPost({ parameter: {}, postData: { contents: JSON.stringify({
        action, secret: 'x' }) } });
      assert.ok(JSON.parse(out._text).error, action + ' must not be an HTTP action');
    });
  });
});

test('the dry-run function is the one with the ordinary name, in every pair', () => {
  // The safe one is what somebody picks by accident from the dropdown, so it
  // must be the one whose name does not announce itself.
  PAIRS.forEach(([wrapper, target]) => {
    assert.ok(wrapper.endsWith('ForRealNow'));
    assert.ok(target.endsWith('Now') && !target.endsWith('ForRealNow'));
    assert.ok(gs.includes('function ' + wrapper + '() {'), wrapper + ' must take no arguments');
    assert.ok(gs.includes('function ' + target + '(dryRun) {'), target + ' keeps its dryRun parameter');
  });
});

test('every dry-run-first function has a twin — none is left untriggerable', () => {
  const dryRunFirst = [...gs.matchAll(/^function (apply\w+Now)\(dryRun\)/gm)].map(m => m[1]);
  assert.deepStrictEqual(dryRunFirst.sort(), PAIRS.map(p => p[1]).sort(),
    'a new applyXNow(dryRun) needs an applyXForRealNow twin and a row in PAIRS');
});
