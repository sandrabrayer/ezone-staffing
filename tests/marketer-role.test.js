'use strict';

// The «משווק/ת» role and the «עמלה לפי מקרה» (per_case_commission)
// employment type.
//
// Pinned here:
//   - VALIDATION: a commission placement validates with NO rate at all, and
//     any rate / count field on it is rejected — in lib/validate.js and,
//     identically, in the Apps Script mirror.
//   - COST: the base is a confirmed 0 (only an allowance counts) and never a
//     «missing data» line.
//   - FEEDS: «משווק/ת» NEVER appears in getTherapistsForTherapists,
//     getTherapistsForCoordinators or getGuidesForCoordinators.
//   - MIGRATION: migrateMarketersNow is dry-run by default, rewrites only the
//     role and employment_type cells, deletes nothing, audits every field and
//     is idempotent.
//   - UI: every enum mirror agrees, the commission form shows no cost field,
//     and opening an existing record never changes its stored type.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const V = require('../lib/validate');
const calc = require('../lib/calc');
const CostEngine = require('../lib/cost-engine');

const ROOT = path.join(__dirname, '..');
const gs = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
const engineGs = fs.readFileSync(path.join(ROOT, 'apps-script', 'CostEngine.gs'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

const MARKETER = 'משווק/ת';
const COMMISSION = 'per_case_commission';

function plain(v) { return JSON.parse(JSON.stringify(v)); }
// Top-level `const`s of Code.gs are not properties of the vm context.
function g(ctx, name) { return vm.runInContext(name, ctx); }

// ---------------------------------------------------------------------------
// Apps Script sandbox over in-memory sheets (same shape as
// tests/payroll-verified-fixes.test.js).
// ---------------------------------------------------------------------------

function fakeSheet(name, rows, writes) {
  const sh = {
    name, rows,
    getDataRange() { return { getValues: () => rows.map(r => r.slice()) }; },
    getLastRow() { return rows.length; },
    getLastColumn() { return rows.reduce((m, r) => Math.max(m, r.length), 0); },
    getMaxRows() { return Math.max(rows.length, 1); },
    getMaxColumns() { return Math.max(sh.getLastColumn(), 1); },
    setFrozenRows() {},
    appendRow(r) { writes.push({ op: 'appendRow', name }); rows.push(r.slice()); },
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
          writes.push({ op: 'setValue', name, r, c, v });
          while (rows.length < r) rows.push([]);
          rows[r - 1][c - 1] = v;
          return range;
        },
        setValues(vals) {
          writes.push({ op: 'setValues', name, r, c });
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

const H_WORKERS = ['id', 'name', 'notes', 'created_at', 'shift_commitment', 'start_date',
  'gmach_month', 'phone', 'start_date_source'];
const H_ASSIGNMENTS = ['id', 'worker_id', 'house', 'role', 'role_detail', 'employment_type',
  'salary', 'pct', 'hourly_rate', 'est_hours', 'session_rate', 'est_sessions',
  'retainer_amount', 'notes', 'created_at', 'allowance', 'status', 'status_date',
  'rate_individual', 'sessions_individual', 'rate_group', 'sessions_group',
  'rate_external', 'external_patients', 'effective_from'];
const H_AUDIT = ['ts', 'action', 'entity', 'entity_id', 'field', 'before', 'after', 'reason'];

function loadCtx(seed, props) {
  const writes = [];
  const logs = [];
  const tabs = {};
  const cachePuts = [];
  Object.keys(seed || {}).forEach(k => { tabs[k] = fakeSheet(k, seed[k].map(r => r.slice()), writes); });
  const store = Object.assign({ SHEET_ID: 'sheet-1' }, props);
  const ctx = vm.createContext({
    Logger: { log(m) { logs.push(String(m)); } },
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
    CacheService: {
      getScriptCache() {
        return { get() { return null; }, put(k) { cachePuts.push(k); }, remove() {}, getAll() { return {}; } };
      },
    },
    Utilities: { formatDate(d) { return d.toISOString().slice(0, 10); } },
    Session: { getScriptTimeZone() { return 'UTC'; } },
    SpreadsheetApp: {
      openById() {
        return {
          getSheetByName(name) { return tabs[name] || null; },
          insertSheet(name) { tabs[name] = fakeSheet(name, [], writes); return tabs[name]; },
        };
      },
    },
  });
  vm.runInContext(engineGs, ctx);
  vm.runInContext(gs, ctx);
  ctx.tabs = tabs;
  ctx.writes = writes;
  ctx.logs = logs;
  ctx.cachePuts = cachePuts;
  return ctx;
}

function asg(id, workerId, house, role, detail, type, terms) {
  const t = Object.assign({ salary: 0, pct: 0, hourlyRate: 0, estHours: 0, sessionRate: 0,
    estSessions: 0, retainerAmount: 0, allowance: 0 }, terms);
  return [id, workerId, house, role, detail, type, t.salary, t.pct, t.hourlyRate, t.estHours,
    t.sessionRate, t.estSessions, t.retainerAmount, 'הערה', '2026-01-02T00:00:00.000Z',
    t.allowance, 'active', '', 0, 0, 0, 0, 0, 0, ''];
}
function wkr(id, name) {
  return [id, name, '', '2026-01-02T00:00:00.000Z', '', '2025-03-01', '', '', ''];
}

// The live case: ציון מקנזי entered as «אחר» + «משווק» with a monthly
// salary before the commission type existed. Beside it: a padded spelling,
// an «אחר» that is NOT a marketer, a therapist, and one already migrated.
function seed() {
  return {
    workers: [H_WORKERS,
      wkr('wz', 'ציון מקנזי'), wkr('wp', 'פלוני פדינג'), wkr('wo', 'אלמוני אחר'),
      wkr('wt', 'תמר מטפלת'), wkr('wd', 'דנה משווקת')],
    assignments: [H_ASSIGNMENTS,
      asg('az', 'wz', 'hq', 'אחר', 'משווק', 'full_time', { salary: 12000, allowance: 2000 }),
      asg('ap', 'wp', 'ramot', ' אחר ', '  משווקת ', 'hourly', { hourlyRate: 60, estHours: 40 }),
      asg('ao', 'wo', 'rehab', 'אחר', 'נהג', 'full_time', { salary: 7000 }),
      asg('at', 'wt', 'asher', 'מטפל/ת', 'משווק', 'per_session', {}),
      asg('ad', 'wd', 'pardes', MARKETER, '', COMMISSION, {}),
    ],
    audit_log: [H_AUDIT],
  };
}

// ---------------------------------------------------------------------------
// Validation — proxy (lib/validate.js)
// ---------------------------------------------------------------------------

test('«משווק/ת» is a role and per_case_commission an employment type (proxy)', () => {
  assert.ok(V.ROLE_OPTIONS.includes(MARKETER));
  assert.ok(V.EMPLOYMENT_TYPES.includes(COMMISSION));
  assert.deepStrictEqual(V.TYPE_COST_FIELDS[COMMISSION], []);
  assert.equal(V.isRole(MARKETER), true);
  assert.equal(V.isEmploymentType(COMMISSION), true);
});

test('a commission placement validates with no rate at all, and no role detail', () => {
  const out = V.validateAssignment({ workerId: 'w1', house: 'hq', role: MARKETER, employmentType: COMMISSION });
  assert.equal(out.role, MARKETER);
  assert.equal(out.employmentType, COMMISSION);
  assert.equal(out.roleDetail, '');
  ['salary', 'pct', 'hourlyRate', 'estHours', 'sessionRate', 'estSessions', 'retainerAmount',
    'rateIndividual', 'sessionsIndividual', 'rateGroup', 'sessionsGroup', 'rateExternal',
    'externalPatients'].forEach(f => assert.strictEqual(out[f], 0, f));
});

test('a commission placement keeps its allowance', () => {
  const out = V.validateAssignment({ workerId: 'w1', house: 'hq', role: MARKETER,
    employmentType: COMMISSION, allowance: 2000 });
  assert.equal(out.allowance, 2000);
});

test('every rate / count field is REJECTED on a commission placement', () => {
  V.ALL_COST_FIELDS.forEach(f => {
    assert.throws(
      () => V.validateAssignment({ workerId: 'w1', house: 'hq', role: MARKETER, employmentType: COMMISSION, [f]: 50 }),
      new RegExp(f + ' not allowed for employmentType=' + COMMISSION), f);
  });
});

test('zero / blank cost fields are fine on a commission placement (hidden inputs)', () => {
  assert.doesNotThrow(() => V.validateAssignment({ workerId: 'w1', house: 'hq', role: MARKETER,
    employmentType: COMMISSION, salary: 0, hourlyRate: '', retainerAmount: null }));
});

test('the marketer role works with any other type too (the type is a choice, not forced)', () => {
  const out = V.validateAssignment({ workerId: 'w1', house: 'hq', role: MARKETER,
    employmentType: 'full_time', salary: 9000 });
  assert.equal(out.salary, 9000);
});

// ---------------------------------------------------------------------------
// Validation — Apps Script mirror
// ---------------------------------------------------------------------------

test('Code.gs validateAssignment mirrors the proxy for commission', () => {
  const ctx = loadCtx({});
  const out = plain(ctx.validateAssignment({ workerId: 'w1', house: 'hq', role: MARKETER, employmentType: COMMISSION }));
  assert.equal(out.employmentType, COMMISSION);
  assert.equal(out.role, MARKETER);
  assert.strictEqual(out.salary, 0);
  assert.throws(() => ctx.validateAssignment({ workerId: 'w1', house: 'hq', role: MARKETER,
    employmentType: COMMISSION, salary: 5000 }), /salary not allowed/);
});

function gsArray(name) {
  const m = new RegExp('const ' + name + ' = \\[([^\\]]*)\\]').exec(gs);
  assert.ok(m, name + ' declared in Code.gs');
  return m[1].match(/'[^']*'/g).map(s => s.slice(1, -1));
}
function htmlArray(name) {
  const m = new RegExp('const ' + name + ' = \\[([^\\]]*)\\]').exec(html);
  assert.ok(m, name + ' declared in index.html');
  return m[1].match(/'[^']*'/g).map(s => s.slice(1, -1));
}

test('ROLE_OPTIONS is identical in validate.js, Code.gs and index.html', () => {
  assert.deepStrictEqual(gsArray('ROLE_OPTIONS'), V.ROLE_OPTIONS);
  assert.deepStrictEqual(htmlArray('ROLE_OPTIONS'), V.ROLE_OPTIONS);
});

test('EMPLOYMENT_TYPES is identical in validate.js, calc.js, cost-engine.js and Code.gs', () => {
  assert.deepStrictEqual(gsArray('EMPLOYMENT_TYPES'), V.EMPLOYMENT_TYPES);
  assert.deepStrictEqual(calc.EMPLOYMENT_TYPES.slice().sort(), V.EMPLOYMENT_TYPES.slice().sort());
  assert.deepStrictEqual(CostEngine.EMPLOYMENT_TYPES.slice().sort(), V.EMPLOYMENT_TYPES.slice().sort());
});

test('every employment type has a Hebrew label in the UI, the exports and the Code.gs tab', () => {
  const ctx = loadCtx({});
  V.EMPLOYMENT_TYPES.forEach(t => {
    assert.ok(new RegExp('\\b' + t + ":\\s*'[^']+'").test(html), 'index.html label for ' + t);
    assert.ok(g(ctx, 'EMPLOYMENT_TYPE_LABELS_HE')[t], 'Code.gs label for ' + t);
    assert.ok(g(ctx, 'MA_TYPE_FIELDS')[t], 'Code.gs MA_TYPE_FIELDS for ' + t);
  });
  assert.equal(g(ctx, 'EMPLOYMENT_TYPE_LABELS_HE')[COMMISSION], 'עמלה לפי מקרה');
  assert.match(fs.readFileSync(path.join(ROOT, 'lib', 'exports.js'), 'utf8'),
    /per_case_commission: 'עמלה לפי מקרה'/);
});

test('«שיבוצים חסרים» tab: a commission row needs no סכום / כמות', () => {
  const ctx = loadCtx({});
  const src = gs.slice(gs.indexOf('const spec = MA_TYPE_FIELDS[row.employmentType]'));
  assert.match(src.slice(0, 300), /if \(spec\.amount && !\(Number\(row\.amount\) > 0\)\)/);
  assert.deepStrictEqual(plain(g(ctx, 'MA_TYPE_FIELDS')[COMMISSION]),
    { amount: '', amountWhat: '', count: '', countWhat: '' });
});

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

test('calc: a commission placement costs only its allowance', () => {
  assert.equal(calc.assignmentBaseCost({ employmentType: COMMISSION, salary: 9999 }), 0);
  assert.equal(calc.assignmentCost({ employmentType: COMMISSION, allowance: 2000 }), 2000);
  assert.equal(calc.assignmentCategory({ employmentType: COMMISSION }), 'freelancer');
});

test('cost engine: commission is a confirmed zero base, never missing data', () => {
  const workers = [{ id: 'w1', name: 'ציון מקנזי', startDate: '2025-01-01' }];
  const assignments = [
    { id: 'a1', workerId: 'w1', house: 'hq', role: MARKETER, employmentType: COMMISSION,
      salary: 12000, allowance: 2000, status: 'active', createdAt: '2025-01-01T00:00:00Z' },
  ];
  const r = CostEngine.costForMonth(workers, assignments, [], [], [], '2026-09', { today: '2026-09-24' });
  const line = r.lines.find(l => l.assignmentId === 'a1');
  assert.ok(line, 'the placement is priced');
  assert.equal(line.rule, 'COMMISSION_PER_CASE');
  assert.equal(line.cost, 2000, 'allowance only — the stale salary is ignored');
  assert.deepStrictEqual(line.missingData, []);
});

// ---------------------------------------------------------------------------
// Feeds: «משווק/ת» never leaves staffing
// ---------------------------------------------------------------------------

function feedCtx() {
  const ctx = loadCtx({});
  ctx.readWorkersSafe = () => [
    { id: 'm1', name: 'משווק אחד', startDate: '2025-01-01', phone: '0501111111' },
    { id: 'm2', name: 'משווקת שתיים', startDate: '2025-01-01', phone: '' },
    { id: 'mx', name: 'משווקת ומטפלת', startDate: '2025-01-01', phone: '' },
    { id: 'mg', name: 'משווק ומדריך', startDate: '2025-01-01', phone: '' },
  ];
  ctx.readAssignmentsSafe = () => [
    { id: 'x1', workerId: 'm1', house: 'hq', role: MARKETER, employmentType: COMMISSION, status: 'active' },
    { id: 'x2', workerId: 'm2', house: 'ramot', role: ' ' + MARKETER + ' ', employmentType: COMMISSION, status: 'active' },
    { id: 'x3', workerId: 'm2', house: 'asher', role: MARKETER, employmentType: COMMISSION, status: 'chld' },
    // A person who is ALSO a therapist / guide appears for THAT placement only.
    { id: 'x4', workerId: 'mx', house: 'hq', role: MARKETER, employmentType: COMMISSION, status: 'active' },
    { id: 'x5', workerId: 'mx', house: 'rehab', role: 'מטפל/ת', employmentType: 'per_session', status: 'active' },
    { id: 'x6', workerId: 'mg', house: 'hq', role: MARKETER, employmentType: COMMISSION, status: 'active' },
    { id: 'x7', workerId: 'mg', house: 'ofroni', role: 'מדריך/ה', employmentType: 'full_time', status: 'active' },
  ];
  ctx.readArchiveV3Safe = () => [
    { id: 'r1', assignmentId: 'x9', workerId: 'm1', name: 'משווק אחד', house: 'pardes',
      role: MARKETER, terminationDate: '2026-01-31' },
  ];
  return ctx;
}

test('getTherapistsForTherapists never carries a marketer', () => {
  const rows = plain(feedCtx().computeTherapistsFeed_());
  assert.deepStrictEqual(rows.map(r => r.name), ['משווקת ומטפלת']);
  assert.deepStrictEqual(rows[0].houses, ['rehab'], 'only the therapist placement');
  assert.ok(!JSON.stringify(rows).includes(MARKETER));
});

test('getTherapistsForCoordinators never carries a marketer', () => {
  const rows = plain(feedCtx().computeTherapistsForCoordinators_());
  assert.deepStrictEqual(rows.map(r => r.name), ['משווקת ומטפלת']);
  assert.ok(!JSON.stringify(rows).includes(MARKETER));
  rows.forEach(r => assert.notStrictEqual(r.role, MARKETER));
});

test('getGuidesForCoordinators never carries a marketer (current or archived)', () => {
  const rows = plain(feedCtx().computeGuidesForCoordinators_());
  assert.deepStrictEqual(rows.map(r => r.name), ['משווק ומדריך']);
  assert.deepStrictEqual(rows[0].houses, ['ofroni']);
  assert.ok(!JSON.stringify(rows).includes(MARKETER));
});

test('the feed allowlists do not name the marketer role', () => {
  const ctx = loadCtx({});
  assert.ok(!Array.from(g(ctx, 'THERAPISTS_FEED_ROLES')).includes(MARKETER));
  assert.notStrictEqual(g(ctx, 'COORDINATORS_FEED_ROLE'), MARKETER);
});

test('end to end: the three doGet feeds with their own secrets never return a marketer', () => {
  const props = { THERAPISTS_READ_SECRET: 't'.repeat(40), COORDINATORS_READ_SECRET: 'c'.repeat(40) };
  const s = seed();
  s.assignments.push(asg('az2', 'wz', 'ramot', MARKETER, '', COMMISSION, {}));
  const ctx = loadCtx(s, props);
  [['getTherapistsForTherapists', props.THERAPISTS_READ_SECRET],
    ['getTherapistsForCoordinators', props.COORDINATORS_READ_SECRET],
    ['getGuidesForCoordinators', props.COORDINATORS_READ_SECRET]].forEach(([action, secret]) => {
    const body = JSON.parse(ctx.doGet({ parameter: { action, secret } })._text);
    assert.ok(!body._status || body._status < 400, action + ' answered');
    const text = JSON.stringify(body);
    assert.ok(!text.includes('ציון מקנזי'), action + ' must not list the marketer');
    assert.ok(!text.includes('דנה משווקת'), action + ' must not list the marketer');
    assert.ok(!text.includes(MARKETER), action + ' must not carry the role');
  });
});

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

test('migrateMarketersNow is a DRY RUN by default: plans, reports, writes nothing', () => {
  const ctx = loadCtx(seed());
  const before = JSON.stringify(ctx.tabs.assignments.rows);
  const res = plain(ctx.migrateMarketersNow());
  assert.equal(res.dryRun, true);
  assert.deepStrictEqual(res.planned.map(p => p.name).sort(), ['פלוני פדינג', 'ציון מקנזי'].sort());
  assert.deepStrictEqual(res.applied, []);
  assert.deepStrictEqual(res.alreadyDone.map(p => p.id), ['ad']);
  assert.equal(JSON.stringify(ctx.tabs.assignments.rows), before, 'no cell changed');
  assert.equal(ctx.writes.length, 0, 'no write of any kind');
  assert.ok(ctx.logs[0].startsWith('DRY RUN'), 'says so');
  const zion = ctx.logs.find(l => l.startsWith('row | ציון מקנזי'));
  assert.ok(zion, 'ציון מקנזי is reported');
  assert.match(zion, /\| hq \| az \|/);
  assert.match(zion, /full_time → per_case_commission/);
  assert.match(zion, /salary=12000/);
  assert.match(zion, /allowance=2000/);
});

test('only «אחר» + a marketer spelling is migrated — never another אחר, never a therapist', () => {
  const ctx = loadCtx(seed());
  const ids = plain(ctx.migrateMarketersNow()).planned.map(p => p.id).sort();
  assert.deepStrictEqual(ids, ['ap', 'az']);
});

test('migrateMarketersNow(false) rewrites ONLY role + employment_type, deletes nothing, audits', () => {
  const ctx = loadCtx(seed());
  const beforeRows = ctx.tabs.assignments.rows.map(r => r.slice());
  const res = plain(ctx.migrateMarketersNow(false));
  assert.equal(res.dryRun, false);
  assert.deepStrictEqual(res.applied.map(a => a.id).sort(), ['ap', 'az']);

  const rows = ctx.tabs.assignments.rows;
  const roleCol = H_ASSIGNMENTS.indexOf('role');
  const typeCol = H_ASSIGNMENTS.indexOf('employment_type');
  rows.forEach((r, i) => {
    const b = beforeRows[i];
    const migrated = r[0] === 'az' || r[0] === 'ap';
    r.forEach((cell, c) => {
      if (migrated && (c === roleCol || c === typeCol)) return;
      assert.deepStrictEqual(cell, b[c], `row ${r[0]} col ${H_ASSIGNMENTS[c]} must be untouched`);
    });
    if (migrated) {
      assert.equal(r[roleCol], MARKETER);
      assert.equal(r[typeCol], COMMISSION);
    }
  });
  // role_detail and the old salary are still on the row.
  const az = rows.find(r => r[0] === 'az');
  assert.equal(az[H_ASSIGNMENTS.indexOf('role_detail')], 'משווק');
  assert.equal(az[H_ASSIGNMENTS.indexOf('salary')], 12000);

  const cellWrites = ctx.writes.filter(w => w.name === 'assignments');
  assert.equal(cellWrites.length, 4, 'two cells per migrated placement, nothing else');
  assert.ok(cellWrites.every(w => w.op === 'setValue'));

  const audit = ctx.tabs.audit_log.rows.slice(1);
  assert.equal(audit.length, 4, 'one audit row per changed field');
  assert.ok(audit.every(r => r[1] === 'migrateMarketers'));
  assert.ok(ctx.cachePuts.length > 0, 'bundle cache invalidated after the write');
});

test('re-running after an apply is free: nothing planned, nothing written', () => {
  const ctx = loadCtx(seed());
  ctx.migrateMarketersNow(false);
  const n = ctx.writes.length;
  const res = plain(ctx.migrateMarketersNow(false));
  assert.deepStrictEqual(res.planned, []);
  assert.equal(res.alreadyDone.length, 3);
  assert.equal(ctx.writes.length, n);
});

test('the migrated placement validates on its next edit (no stale rate is re-sent by the UI)', () => {
  const ctx = loadCtx(seed());
  ctx.migrateMarketersNow(false);
  const a = plain(ctx.readAssignmentsSafe()).find(x => x.id === 'az');
  // The form sends only TYPE_COST_FIELDS[type] — none for commission.
  assert.doesNotThrow(() => V.validateAssignment({ workerId: a.workerId, house: a.house,
    role: a.role, roleDetail: a.roleDetail, employmentType: a.employmentType, allowance: a.allowance }));
});

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

test('UI: the commission type shows no cost field and sends none', () => {
  assert.match(html, /per_case_commission: \[\],/);
  assert.match(html, /id="w_commission_hint"/);
  assert.match(html, /id="asg_commission_hint"/);
});

test('UI: picking משווק/ת pre-selects commission only from the select, never on prefill', () => {
  assert.match(html, /id="w_role" onchange="onWorkerRoleChange\(\);preselectCommission\('w'\)"/);
  assert.match(html, /id="asg_role" onchange="onAssignmentRoleChange\(\);preselectCommission\('asg'\)"/);
  const body = (fn) => {
    const i = html.indexOf('function ' + fn + '(');
    return html.slice(i, html.indexOf('\n}\n', i));
  };
  assert.ok(!/COMMISSION_TYPE|preselectCommission/.test(body('onWorkerRoleChange')),
    'the prefill path must not touch the type');
  assert.ok(!/COMMISSION_TYPE|preselectCommission/.test(body('onAssignmentRoleChange')));
});
