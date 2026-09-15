'use strict';

// Endpoint guards for בקרת שכר — the four Apps Script endpoints and the
// Express proxy's validation in front of them.
//
// Same harness as tests/coordinators-endpoint.test.js: Code.gs is evaluated
// in a vm sandbox with the GAS services mocked, so the real functions run
// against in-memory sheets.
//
// The hard rules pinned here:
//   - THE RECONCILIATION GATE IS SERVER-SIDE. A payload whose rows do not
//     reproduce the printed total and headcount is refused with the delta
//     named, even though the browser already checked.
//   - INPUT VALIDATION ON EVERY ENDPOINT, fail-closed: unknown rule id,
//     unknown match status, unknown house, bad run id, missing note, note
//     too short or too long, too many lines, duplicate line id.
//   - A NOTE IS MANDATORY on every approve and reject, 2 to 200 characters.
//   - LOCKING DEMANDS ZERO OPEN FINDINGS, and a locked run is read-only.
//   - EVERY WRITE IS LOGGED to PayrollApprovalLog.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const gs = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
const { validateAction } = require('../lib/validate');
const R = require('../lib/payroll-rules');

const golden = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'tamhir-2026-08.json'), 'utf8'));

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function fakeSheet(rows) {
  const sh = {
    rows,
    getDataRange() { return { getValues: () => rows.map(r => r.slice()) }; },
    getLastRow() { return rows.length; },
    getLastColumn() { return rows.reduce((m, r) => Math.max(m, r.length), 0); },
    setFrozenRows() {},
    appendRow(r) { rows.push(r.slice()); },
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
        setNumberFormat() { return range; },
      };
      return range;
    },
  };
  return sh;
}

function loadCtx(props) {
  const store = Object.assign({ SHARED_SECRET: 'sekret', SHEET_ID: 'sheet' }, props);
  const ctx = vm.createContext({
    Logger: { log() {} },
    PropertiesService: {
      getScriptProperties() {
        return { getProperty(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; } };
      },
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput(s) { return { _text: s, setMimeType() { return this; } }; },
    },
    LockService: { getScriptLock() { return { waitLock() {}, releaseLock() {} }; } },
    Utilities: { formatDate(d) { return d.toISOString().slice(0, 10); } },
    Session: { getScriptTimeZone() { return 'UTC'; } },
  });
  vm.runInContext(gs, ctx);

  // One in-memory book for the four payroll tabs.
  const book = {};
  ctx.ss = () => ({
    getSheetByName(name) { return book[name] || null; },
    insertSheet(name) { book[name] = fakeSheet([]); return book[name]; },
  });
  ctx.sheetByNameOrNull = (name) => book[name] || null;
  ctx.sheetByName = (name) => {
    if (!book[name]) throw ctx.httpError(500, 'missing sheet: ' + name);
    return book[name];
  };
  ctx.__book = book;
  // `const` declarations in a vm script live in the context's global LEXICAL
  // scope, not on the global object, so they are reached by evaluating the
  // identifier rather than by reading a property off ctx.
  // Arrays are copied into THIS realm: deepStrictEqual compares prototypes,
  // and a vm array is never reference-equal to a host one.
  ctx.__eval = (expr) => {
    const v = vm.runInContext(expr, ctx);
    return Array.isArray(v) ? Array.from(v) : v;
  };
  return ctx;
}

const plain = (v) => JSON.parse(JSON.stringify(v));

// A small, self-consistent run: 2 lines that add up to the printed total.
function sampleLines() {
  return [
    {
      lineId: 'L001', empNumber: '33', rawName: 'רובין סופיה חן',
      matchedWorkerId: 'w1', matchStatus: 'number', dept: '001', mappedHouse: 'pardes',
      tashlumim: 8087.18, tagmulim: 0, keren: 0, pitzuim: 0, shonot: 0,
      bituach: 376.28, masMaasikim: 0, masSachar: 0, total: 8463.46,
    },
    {
      lineId: 'L002', empNumber: '145', rawName: 'ריף ענהאל',
      matchedWorkerId: '', matchStatus: 'unmatched', dept: '002', mappedHouse: '',
      tashlumim: 7300.95, tagmulim: 0, keren: 0, pitzuim: 0, shonot: 0,
      bituach: 329.02, masMaasikim: 0, masSachar: 0, total: 7629.97,
    },
  ];
}
const SAMPLE_TOTAL = 16093.43;

function sampleFindings() {
  return [
    { lineId: 'L002', ruleId: 'R01', severity: 'critical', expected: 'עובד קיים', actual: 'לא נמצא', messageHe: 'לא נמצא' },
    { lineId: 'L002', ruleId: 'R16', severity: 'warning', expected: 'שיוך מאושר', actual: 'ממתין', messageHe: 'טרם אושר' },
    { lineId: '', ruleId: 'R03', severity: 'critical', expected: 'שורה', actual: 'אין', messageHe: 'אין שורה בקובץ' },
  ];
}

function importSample(ctx, over) {
  return plain(ctx.importPayrollRun(Object.assign({
    month: '2026-08', fileName: 'tamhir.pdf', importedBy: 'moran',
    printedTotal: SAMPLE_TOTAL, printedHeadcount: 2,
    lines: sampleLines(), findings: sampleFindings(),
  }, over || {})));
}

// ---------------------------------------------------------------------------
// importPayrollRun
// ---------------------------------------------------------------------------

test('importPayrollRun stores the run, its lines and its findings', () => {
  const ctx = loadCtx();
  const res = importSample(ctx);
  assert.strictEqual(res.ok, true);
  assert.match(res.run.runId, /^pr_/);
  assert.strictEqual(res.run.month, '2026-08');
  assert.strictEqual(res.run.rowCount, 2);
  assert.strictEqual(res.run.parsedTotal, SAMPLE_TOTAL);
  assert.strictEqual(res.run.printedTotal, SAMPLE_TOTAL);
  assert.strictEqual(res.run.status, 'open');
  assert.strictEqual(res.run.flaggedCount, 1, 'one LINE carries findings; R03 has no line');

  assert.deepStrictEqual(ctx.__book.PayrollRuns.rows[0], ctx.__eval('HEADERS_PAYROLL_RUNS'));
  assert.deepStrictEqual(ctx.__book.PayrollLines.rows[0], ctx.__eval('HEADERS_PAYROLL_LINES'));
  assert.deepStrictEqual(ctx.__book.PayrollFindings.rows[0], ctx.__eval('HEADERS_PAYROLL_FINDINGS'));
  assert.strictEqual(ctx.__book.PayrollLines.rows.length, 3, 'header + 2 lines');
  assert.strictEqual(ctx.__book.PayrollFindings.rows.length, 4, 'header + 3 findings');
  // Findings land in state 'open' with no resolver.
  assert.deepStrictEqual(ctx.__book.PayrollFindings.rows[1].slice(7), ['open', '', '', '']);
});

test('importPayrollRun stores every line column in its pinned position', () => {
  const ctx = loadCtx();
  importSample(ctx);
  const row = ctx.__book.PayrollLines.rows[1];
  const headers = ctx.__eval('HEADERS_PAYROLL_LINES');
  const l = sampleLines()[0];
  assert.strictEqual(row[headers.indexOf('lineId')], 'L001');
  assert.strictEqual(row[headers.indexOf('empNumber')], '33');
  assert.strictEqual(row[headers.indexOf('rawName')], l.rawName);
  assert.strictEqual(row[headers.indexOf('mappedHouse')], 'pardes');
  assert.strictEqual(row[headers.indexOf('tashlumim')], 8087.18);
  assert.strictEqual(row[headers.indexOf('total')], 8463.46);
});

test('importPayrollRun REFUSES a total mismatch and names the delta', () => {
  const ctx = loadCtx();
  assert.throws(
    () => importSample(ctx, { printedTotal: SAMPLE_TOTAL + 10 }),
    (err) => {
      assert.strictEqual(err.status, 400);
      assert.match(err.message, /reconciliation failed/);
      assert.match(err.message, /delta -10\.00/);
      return true;
    },
    'the gate must be re-asserted server-side, not trusted from the browser'
  );
  assert.strictEqual(ctx.__book.PayrollRuns, undefined, 'and nothing at all is written');
});

test('importPayrollRun REFUSES a headcount mismatch and names the delta', () => {
  const ctx = loadCtx();
  assert.throws(() => importSample(ctx, { printedHeadcount: 3 }), /reconciliation failed.*delta -1/);
});

test('importPayrollRun REFUSES the real August file if a single row is altered', () => {
  const ctx = loadCtx();
  const evaluated = R.evaluateRun({ month: '2026-08', runId: 'pr_x', rows: golden.rows, workers: [] });
  const lines = evaluated.lines.map(l => Object.assign({}, l, { mappedHouse: l.mappedHouse || '' }));
  // Sanity: unaltered, it imports.
  const ok = plain(ctx.importPayrollRun({
    month: '2026-08', fileName: 'tamhir-2026-08.pdf',
    printedTotal: 1107895.88, printedHeadcount: 93, lines, findings: [],
  }));
  assert.strictEqual(ok.run.rowCount, 93);
  assert.strictEqual(ok.run.parsedTotal, 1107895.88);

  const tampered = lines.map((l, i) => (i === 0 ? Object.assign({}, l, { total: l.total + 0.01 }) : l));
  assert.throws(() => ctx.importPayrollRun({
    month: '2026-09', fileName: 'tamhir.pdf',
    printedTotal: 1107895.88, printedHeadcount: 93, lines: tampered, findings: [],
  }), /reconciliation failed/, 'one agora out is still out');
});

test('importPayrollRun validates every field, fail-closed', () => {
  const bad = [
    [{ month: 'not-a-month' }, /bad month|month/],
    [{ fileName: '' }, /fileName required/],
    [{ lines: [] }, /lines empty/],
    [{ lines: 'nope' }, /lines required/],
    [{ findings: 'nope' }, /findings must be an array/],
  ];
  bad.forEach(([over, re]) => {
    const ctx = loadCtx();
    assert.throws(() => importSample(ctx, over), re, JSON.stringify(over));
  });
});

test('importPayrollRun rejects an unknown house, match status or rule id', () => {
  const withLine = (patch) => {
    const lines = sampleLines();
    Object.assign(lines[0], patch);
    return { lines };
  };
  assert.throws(() => importSample(loadCtx(), withLine({ mappedHouse: 'atlantis' })), /bad mappedHouse/);
  assert.throws(() => importSample(loadCtx(), withLine({ matchStatus: 'probably' })), /bad matchStatus/);
  assert.throws(() => importSample(loadCtx(), withLine({ empNumber: 'abc' })), /bad empNumber/);
  assert.throws(() => importSample(loadCtx(), withLine({ dept: '12345' })), /bad dept/);
  const findings = sampleFindings();
  findings[0].ruleId = 'R99';
  assert.throws(() => importSample(loadCtx(), { findings }), /bad ruleId/);
  const sev = sampleFindings();
  sev[0].severity = 'catastrophic';
  assert.throws(() => importSample(loadCtx(), { findings: sev }), /bad severity/);
});

test('importPayrollRun rejects a duplicate line id and a finding pointing at no line', () => {
  const dupes = sampleLines();
  dupes[1].lineId = 'L001';
  assert.throws(() => importSample(loadCtx(), { lines: dupes }), /duplicate lineId/);

  const orphan = sampleFindings();
  orphan[0].lineId = 'L999';
  assert.throws(() => importSample(loadCtx(), { findings: orphan }), /unknown lineId/);
});

test('importPayrollRun caps the number of lines', () => {
  const ctx = loadCtx();
  const many = [];
  for (let i = 0; i < ctx.__eval('PAYROLL_MAX_LINES') + 1; i++) {
    many.push(Object.assign(sampleLines()[0], { lineId: 'L' + i }));
  }
  assert.throws(() => importSample(ctx, { lines: many }), /too many lines/);
});

test('importPayrollRun refuses to re-import a LOCKED month', () => {
  const ctx = loadCtx();
  const first = importSample(ctx);
  ctx.resolvePayrollFinding({ runId: first.run.runId, lineId: 'L002', ruleId: 'R01', decision: 'approve', note: 'בדוק' });
  ctx.resolvePayrollFinding({ runId: first.run.runId, lineId: 'L002', ruleId: 'R16', decision: 'approve', note: 'בדוק' });
  ctx.resolvePayrollFinding({ runId: first.run.runId, lineId: '', ruleId: 'R03', decision: 'reject', note: 'בדוק' });
  ctx.lockPayrollRun({ runId: first.run.runId });
  assert.throws(() => importSample(ctx), (err) => {
    assert.strictEqual(err.status, 409);
    assert.match(err.message, /is locked/);
    return true;
  });
});

test('importPayrollRun allows a re-import while the month is still open, and says what it supersedes', () => {
  const ctx = loadCtx();
  const first = importSample(ctx);
  const second = importSample(ctx);
  assert.notStrictEqual(second.run.runId, first.run.runId);
  assert.deepStrictEqual(second.supersedes, [first.run.runId]);
});

// ---------------------------------------------------------------------------
// getPayrollRun
// ---------------------------------------------------------------------------

test('getPayrollRun returns the run with its lines and findings', () => {
  const ctx = loadCtx();
  const imported = importSample(ctx);
  const res = plain(ctx.getPayrollRun({ runId: imported.run.runId }));
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.run.runId, imported.run.runId);
  assert.strictEqual(res.lines.length, 2);
  assert.strictEqual(res.findings.length, 3);
  assert.strictEqual(res.lines[0].tashlumim, 8087.18);
  assert.strictEqual(res.findings[0].state, 'open');
});

test('getPayrollRun by month returns the NEWEST run of that month', () => {
  const ctx = loadCtx();
  importSample(ctx);
  const second = importSample(ctx);
  const res = plain(ctx.getPayrollRun({ month: '2026-08' }));
  assert.strictEqual(res.run.runId, second.run.runId);
});

test('getPayrollRun with no arguments returns just the run index', () => {
  const ctx = loadCtx();
  importSample(ctx);
  const res = plain(ctx.getPayrollRun({}));
  assert.strictEqual(res.run, null);
  assert.deepStrictEqual(res.lines, []);
  assert.strictEqual(res.runs.length, 1);
});

test('getPayrollRun supplies the PREVIOUS month totals as raw data for R15', () => {
  const ctx = loadCtx();
  ctx.importPayrollRun({
    month: '2026-07', fileName: 'july.pdf',
    printedTotal: SAMPLE_TOTAL, printedHeadcount: 2, lines: sampleLines(), findings: [],
  });
  const aug = importSample(ctx);
  const res = plain(ctx.getPayrollRun({ runId: aug.run.runId }));
  assert.deepStrictEqual(res.previousTotals, { 33: 8463.46, 145: 7629.97 });
});

test('getPayrollRun crosses the year boundary when looking up the previous month', () => {
  const ctx = loadCtx();
  ctx.importPayrollRun({
    month: '2025-12', fileName: 'dec.pdf',
    printedTotal: SAMPLE_TOTAL, printedHeadcount: 2, lines: sampleLines(), findings: [],
  });
  const jan = importSample(ctx, { month: '2026-01' });
  const res = plain(ctx.getPayrollRun({ runId: jan.run.runId }));
  assert.deepStrictEqual(Object.keys(res.previousTotals).sort(), ['145', '33']);
});

test('getPayrollRun rejects a malformed run id and 404s an unknown one', () => {
  const ctx = loadCtx();
  importSample(ctx);
  assert.throws(() => ctx.getPayrollRun({ runId: '../../etc' }), /bad runId/);
  assert.throws(() => ctx.getPayrollRun({ runId: 'pr_nosuchrun' }), (err) => {
    assert.strictEqual(err.status, 404);
    return true;
  });
});

test('doGet routes getPayrollRun through the ordinary SHARED_SECRET gate', () => {
  const ctx = loadCtx();
  importSample(ctx);
  const unauth = JSON.parse(ctx.doGet({ parameter: { action: 'getPayrollRun' } })._text);
  assert.strictEqual(unauth._status, 401);
  assert.strictEqual(unauth.error, 'unauthorized');

  const wrong = JSON.parse(ctx.doGet({ parameter: { action: 'getPayrollRun', secret: 'nope' } })._text);
  assert.strictEqual(wrong._status, 401);

  const ok = JSON.parse(ctx.doGet({ parameter: { action: 'getPayrollRun', secret: 'sekret' } })._text);
  assert.strictEqual(ok._status, 200);
  assert.strictEqual(ok.runs.length, 1);
});

// ---------------------------------------------------------------------------
// resolvePayrollFinding
// ---------------------------------------------------------------------------

test('resolvePayrollFinding approves, records who and when, and logs it', () => {
  const ctx = loadCtx();
  const imported = importSample(ctx);
  const res = plain(ctx.resolvePayrollFinding({
    runId: imported.run.runId, lineId: 'L002', ruleId: 'R01',
    decision: 'approve', note: 'אומת מול הלשכה', actor: 'moran',
  }));
  assert.strictEqual(res.finding.state, 'approved');
  assert.strictEqual(res.finding.resolvedBy, 'moran');
  assert.ok(res.finding.resolvedAt);
  assert.strictEqual(res.openFindings, 2);

  const row = ctx.__book.PayrollFindings.rows.find(r => r[2] === 'R01' && r[1] === 'L002');
  assert.deepStrictEqual(row.slice(7, 9), ['approved', 'moran']);
  assert.strictEqual(row[10], 'אומת מול הלשכה');

  const log = ctx.__book.PayrollApprovalLog.rows;
  assert.deepStrictEqual(log[0], ctx.__eval('HEADERS_PAYROLL_APPROVAL_LOG'));
  assert.strictEqual(log.length, 2, 'header + one decision');
  assert.deepStrictEqual([log[1][0], log[1][1], log[1][2], log[1][3], log[1][5]],
    [imported.run.runId, 'L002', 'approve', 'moran', 'אומת מול הלשכה']);
});

test('resolvePayrollFinding rejects, and resolves a finding with NO line', () => {
  const ctx = loadCtx();
  const imported = importSample(ctx);
  const res = plain(ctx.resolvePayrollFinding({
    runId: imported.run.runId, lineId: '', ruleId: 'R03', decision: 'reject', note: 'עזב באוגוסט',
  }));
  assert.strictEqual(res.finding.state, 'rejected');
  assert.strictEqual(res.finding.resolvedBy, 'moran', 'the actor defaults rather than being blank');
});

test('resolvePayrollFinding DEMANDS a note of 2 to 200 characters', () => {
  const ctx = loadCtx();
  const imported = importSample(ctx);
  const call = (note) => ctx.resolvePayrollFinding({
    runId: imported.run.runId, lineId: 'L002', ruleId: 'R01', decision: 'approve', note,
  });
  assert.throws(() => call(undefined), /note too short/);
  assert.throws(() => call(''), /note too short/);
  assert.throws(() => call('א'), /note too short/);
  assert.throws(() => call('  א  '), /note too short/, 'whitespace is not a reason');
  assert.throws(() => call('א'.repeat(201)), /note too long/);
  assert.doesNotThrow(() => call('אב'), 'two characters is the floor');
  assert.doesNotThrow(() => call('א'.repeat(200)), 'two hundred is the ceiling');
});

test('resolvePayrollFinding validates the decision, the ids and the target', () => {
  const ctx = loadCtx();
  const imported = importSample(ctx);
  const base = { runId: imported.run.runId, lineId: 'L002', ruleId: 'R01', decision: 'approve', note: 'בדוק' };
  assert.throws(() => ctx.resolvePayrollFinding(Object.assign({}, base, { decision: 'maybe' })), /bad decision/);
  assert.throws(() => ctx.resolvePayrollFinding(Object.assign({}, base, { ruleId: 'R99' })), /bad ruleId/);
  assert.throws(() => ctx.resolvePayrollFinding(Object.assign({}, base, { runId: 'nope' })), /bad runId/);
  assert.throws(() => ctx.resolvePayrollFinding(Object.assign({}, base, { lineId: 'L 002' })), /bad lineId/);
  assert.throws(() => ctx.resolvePayrollFinding(Object.assign({}, base, { runId: 'pr_absent' })), /run not found/);
  assert.throws(() => ctx.resolvePayrollFinding(Object.assign({}, base, { ruleId: 'R05' })), /finding not found/);
});

test('resolvePayrollFinding is refused on a LOCKED run', () => {
  const ctx = loadCtx();
  const imported = importSample(ctx);
  ['R01', 'R16'].forEach(ruleId => ctx.resolvePayrollFinding({
    runId: imported.run.runId, lineId: 'L002', ruleId, decision: 'approve', note: 'בדוק' }));
  ctx.resolvePayrollFinding({ runId: imported.run.runId, lineId: '', ruleId: 'R03', decision: 'approve', note: 'בדוק' });
  ctx.lockPayrollRun({ runId: imported.run.runId });
  assert.throws(() => ctx.resolvePayrollFinding({
    runId: imported.run.runId, lineId: 'L002', ruleId: 'R01', decision: 'reject', note: 'שינוי דעה',
  }), (err) => {
    assert.strictEqual(err.status, 409);
    assert.match(err.message, /run is locked/);
    return true;
  });
});

// ---------------------------------------------------------------------------
// lockPayrollRun
// ---------------------------------------------------------------------------

test('lockPayrollRun REFUSES while findings are open, and names how many', () => {
  const ctx = loadCtx();
  const imported = importSample(ctx);
  assert.throws(() => ctx.lockPayrollRun({ runId: imported.run.runId }), (err) => {
    assert.strictEqual(err.status, 409);
    assert.match(err.message, /cannot lock: 3 open findings/);
    return true;
  });
  ctx.resolvePayrollFinding({ runId: imported.run.runId, lineId: 'L002', ruleId: 'R01', decision: 'approve', note: 'בדוק' });
  assert.throws(() => ctx.lockPayrollRun({ runId: imported.run.runId }), /cannot lock: 2 open findings/);
});

test('lockPayrollRun locks once every finding is resolved, and logs it', () => {
  const ctx = loadCtx();
  const imported = importSample(ctx);
  ['R01', 'R16'].forEach(ruleId => ctx.resolvePayrollFinding({
    runId: imported.run.runId, lineId: 'L002', ruleId, decision: 'approve', note: 'בדוק' }));
  ctx.resolvePayrollFinding({ runId: imported.run.runId, lineId: '', ruleId: 'R03', decision: 'reject', note: 'בדוק' });

  const res = plain(ctx.lockPayrollRun({ runId: imported.run.runId, actor: 'moran' }));
  assert.strictEqual(res.status, 'locked');
  assert.strictEqual(res.lockedBy, 'moran');
  const runRow = ctx.__book.PayrollRuns.rows[1];
  assert.strictEqual(runRow[ctx.__eval('HEADERS_PAYROLL_RUNS').indexOf('status')], 'locked');
  const log = ctx.__book.PayrollApprovalLog.rows;
  assert.strictEqual(log[log.length - 1][2], 'lock');
});

test('lockPayrollRun is not silently idempotent — a second lock is a 409', () => {
  const ctx = loadCtx();
  const imported = importSample(ctx);
  ['R01', 'R16'].forEach(ruleId => ctx.resolvePayrollFinding({
    runId: imported.run.runId, lineId: 'L002', ruleId, decision: 'approve', note: 'בדוק' }));
  ctx.resolvePayrollFinding({ runId: imported.run.runId, lineId: '', ruleId: 'R03', decision: 'approve', note: 'בדוק' });
  ctx.lockPayrollRun({ runId: imported.run.runId });
  assert.throws(() => ctx.lockPayrollRun({ runId: imported.run.runId }), /already locked/);
});

test('lockPayrollRun validates its run id and 404s an unknown run', () => {
  const ctx = loadCtx();
  importSample(ctx);
  assert.throws(() => ctx.lockPayrollRun({ runId: 'nope' }), /bad runId/);
  assert.throws(() => ctx.lockPayrollRun({ runId: 'pr_absent' }), /run not found/);
});

// ---------------------------------------------------------------------------
// The proxy validator
// ---------------------------------------------------------------------------

test('the proxy forwards a well-formed import unchanged', () => {
  const out = validateAction({
    action: 'importPayrollRun', month: '2026-08', fileName: 'tamhir.pdf',
    printedTotal: SAMPLE_TOTAL, printedHeadcount: 2,
    lines: sampleLines(), findings: sampleFindings(),
  });
  assert.strictEqual(out.action, 'importPayrollRun');
  assert.strictEqual(out.lines.length, 2);
  assert.strictEqual(out.findings.length, 3);
  assert.strictEqual(out.printedHeadcount, 2);
});

test('the proxy strips path separators and control characters from the file name', () => {
  const out = validateAction({
    action: 'importPayrollRun', month: '2026-08',
    fileName: '../../etc/passwd\nתמחיר.pdf',
    printedTotal: SAMPLE_TOTAL, printedHeadcount: 2, lines: sampleLines(), findings: [],
  });
  assert.ok(out.fileName.indexOf('/') < 0 && out.fileName.indexOf('\\') < 0);
  assert.ok(out.fileName.indexOf('\n') < 0);
});

test('the proxy rejects the same bad payloads as Apps Script', () => {
  const base = {
    action: 'importPayrollRun', month: '2026-08', fileName: 'x.pdf',
    printedTotal: SAMPLE_TOTAL, printedHeadcount: 2, findings: [],
  };
  const withLines = (patch) => {
    const lines = sampleLines();
    Object.assign(lines[0], patch);
    return Object.assign({}, base, { lines });
  };
  assert.throws(() => validateAction(withLines({ mappedHouse: 'atlantis' })), /bad mappedHouse/);
  assert.throws(() => validateAction(withLines({ matchStatus: 'probably' })), /bad matchStatus/);
  assert.throws(() => validateAction(withLines({ empNumber: '' })), /bad empNumber/);
  assert.throws(() => validateAction(withLines({ rawName: '' })), /rawName required/);
  assert.throws(() => validateAction(withLines({ total: 'lots' })), /bad total/);
  assert.throws(() => validateAction(withLines({ total: 1e12 })), /out of range/);
  assert.throws(() => validateAction(Object.assign({}, base, { lines: [] })), /lines empty/);
  assert.throws(() => validateAction(Object.assign({}, base, { fileName: '', lines: sampleLines() })), /fileName required/);
});

test('the proxy accepts the two unconfirmed departments with a blank house', () => {
  const lines = sampleLines();
  lines[0].mappedHouse = '';
  const out = validateAction({
    action: 'importPayrollRun', month: '2026-08', fileName: 'x.pdf',
    printedTotal: SAMPLE_TOTAL, printedHeadcount: 2, lines, findings: [],
  });
  assert.strictEqual(out.lines[0].mappedHouse, '', 'a blank house is how R16 travels');
});

test('the proxy validates resolvePayrollFinding, note and all', () => {
  const ok = validateAction({
    action: 'resolvePayrollFinding', runId: 'pr_abcd1234', lineId: 'L002',
    ruleId: 'R07', decision: 'approve', note: 'אושר מול הלשכה',
  });
  assert.strictEqual(ok.decision, 'approve');
  assert.strictEqual(ok.note, 'אושר מול הלשכה');
  const bad = (over) => () => validateAction(Object.assign({
    action: 'resolvePayrollFinding', runId: 'pr_abcd1234', lineId: 'L002',
    ruleId: 'R07', decision: 'approve', note: 'בדוק',
  }, over));
  assert.throws(bad({ runId: 'x' }), /bad runId/);
  assert.throws(bad({ ruleId: 'R99' }), /bad ruleId/);
  assert.throws(bad({ decision: 'perhaps' }), /bad decision/);
  assert.throws(bad({ note: 'א' }), /note too short/);
  assert.throws(bad({ note: 'א'.repeat(201) }), /note too long/);
  assert.throws(bad({ lineId: 'L 002' }), /bad lineId/);
});

test('the proxy validates getPayrollRun and lockPayrollRun', () => {
  assert.deepStrictEqual(validateAction({ action: 'getPayrollRun' }), { action: 'getPayrollRun' });
  assert.deepStrictEqual(validateAction({ action: 'getPayrollRun', month: '2026-08' }),
    { action: 'getPayrollRun', month: '2026-08' });
  assert.throws(() => validateAction({ action: 'getPayrollRun', runId: 'nope' }), /bad runId/);
  assert.throws(() => validateAction({ action: 'getPayrollRun', month: '2026-13' }), /month/);
  assert.deepStrictEqual(validateAction({ action: 'lockPayrollRun', runId: 'pr_abcd1234' }),
    { action: 'lockPayrollRun', runId: 'pr_abcd1234', actor: '' });
  assert.throws(() => validateAction({ action: 'lockPayrollRun', runId: '' }), /bad runId/);
});

// ---------------------------------------------------------------------------
// The appended workers column
// ---------------------------------------------------------------------------

const WORKER_HEADERS = ['id', 'name', 'notes', 'created_at', 'shift_commitment',
  'start_date', 'gmach_month', 'phone', 'payroll_emp_number'];

test('payrollEmpNumber round-trips through createWorker and readWorkersSafe', () => {
  const ctx = loadCtx();
  ctx.__book.workers = fakeSheet([WORKER_HEADERS.slice()]);
  const res = plain(ctx.createWorker({ worker: { name: 'רון', payrollEmpNumber: '0033' } }));
  assert.strictEqual(res.worker.payrollEmpNumber, '33', 'leading zeros are stripped on the way in');
  assert.strictEqual(ctx.__book.workers.rows[1][8], '33', 'and it lands in the appended 9th column');
  assert.strictEqual(ctx.readWorkersSafe()[0].payrollEmpNumber, '33');
});

test('updateWorker leaves the binding alone when the key is absent, and clears it on an explicit blank', () => {
  const ctx = loadCtx();
  ctx.__book.workers = fakeSheet([WORKER_HEADERS.slice(), ['w1', 'רון', '', '', '', '', '', '', '33']]);
  const kept = plain(ctx.updateWorker({ id: 'w1', worker: { name: 'רון' } }));
  assert.strictEqual(kept.worker.payrollEmpNumber, '33',
    'an older client that knows nothing about the binding must never unbind it');
  const cleared = plain(ctx.updateWorker({ id: 'w1', worker: { name: 'רון', payrollEmpNumber: '' } }));
  assert.strictEqual(cleared.worker.payrollEmpNumber, '');
});

test('payrollEmpNumber is validated on both sides', () => {
  const ctx = loadCtx();
  ctx.__book.workers = fakeSheet([WORKER_HEADERS.slice()]);
  assert.throws(() => ctx.createWorker({ worker: { name: 'רון', payrollEmpNumber: 'abc' } }), /bad payrollEmpNumber/);
  assert.throws(() => ctx.createWorker({ worker: { name: 'רון', payrollEmpNumber: '1234567' } }), /bad payrollEmpNumber/);
  assert.throws(() => validateAction({ action: 'createWorker', worker: { name: 'רון', payrollEmpNumber: 'abc' } }),
    /bad payrollEmpNumber/);
  const ok = validateAction({ action: 'createWorker', worker: { name: 'רון', payrollEmpNumber: '0033' } });
  assert.strictEqual(ok.worker.payrollEmpNumber, '33');
});

test('the two sides normalise an employee number identically', () => {
  const ctx = loadCtx();
  ['0033', '33', ' 33 ', '0001'].forEach((raw) => {
    assert.strictEqual(ctx.normalizePayrollEmpNumber_(raw), R.normalizeEmpNumber(raw),
      'a worker bound in the UI must still match on the next import');
  });
});
