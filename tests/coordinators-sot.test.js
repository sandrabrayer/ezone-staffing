'use strict';

// Staffing as the source of truth for the coordinators app.
//
// Pinned here:
//   1. GUIDE SHIFT MINIMUM per placement — weekdayMin (int 0–6 / week),
//      weekendMin (int 0–10 / month), allowedShifts (the coordinators shift
//      ids: בוקר / אחר צהריים / לילה, canonical order). Validated identically
//      in lib/validate.js (proxy) and Code.gs; blank = not set = null, never
//      0; key presence decides whether a stored value changes; a non-guide
//      placement can carry none.
//   2. updateAssignment writes the row at FULL header width (it wrote 24
//      values into a 25-column range after effective_from was appended —
//      Apps Script rejects that), and preserves effective_from.
//   3. getGuidesForCoordinators carries the minimum; exact key set.
//   4. getTherapistsForCoordinators — same COORDINATORS_READ_SECRET,
//      constant-time, fail-closed; current placements only (no ArchiveV3);
//      exact key set: name, phone, role, active, houses, startDate. No pay,
//      bank, salary, id.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');
const { buildInlinedHtml } = require('./inline-page');
const V = require('../lib/validate');

const ROOT = path.join(__dirname, '..');
const gs = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');

const COORD = 'coordinators-secret-0123456789abcdef';
const MAIN = 'main-shared-secret-0123456789abcdef';
const THER = 'therapists-secret-0123456789abcdef';

const H_ASSIGNMENTS = ['id', 'worker_id', 'house', 'role', 'role_detail', 'employment_type',
  'salary', 'pct', 'hourly_rate', 'est_hours', 'session_rate', 'est_sessions',
  'retainer_amount', 'notes', 'created_at', 'allowance', 'status', 'status_date',
  'rate_individual', 'sessions_individual', 'rate_group', 'sessions_group',
  'rate_external', 'external_patients', 'effective_from',
  'weekday_min', 'weekend_min', 'allowed_shifts'];
const H_WORKERS = ['id', 'name', 'notes', 'created_at', 'shift_commitment', 'start_date',
  'gmach_month', 'phone', 'start_date_source'];

// A sheet that behaves like Apps Script where it matters here: setValues
// THROWS when the data width differs from the range width.
function strictSheet(rows) {
  return {
    rows,
    getDataRange() { return { getValues: () => rows.map(r => r.slice()) }; },
    getLastRow() { return rows.length; },
    getLastColumn() { return rows.reduce((m, r) => Math.max(m, r.length), 0); },
    getMaxColumns() { return 40; },
    setFrozenRows() {},
    appendRow(r) { rows.push(r.slice()); },
    deleteRow(r) { rows.splice(r - 1, 1); },
    getRange(r, c, nr, nc) {
      nr = nr || 1; nc = nc || 1;
      const range = {
        getValue() { return (rows[r - 1] || [])[c - 1]; },
        getValues() {
          const out = [];
          for (let i = 0; i < nr; i++) {
            const row = rows[r - 1 + i] || [];
            const v = [];
            for (let j = 0; j < nc; j++) v.push(row[c - 1 + j] === undefined ? '' : row[c - 1 + j]);
            out.push(v);
          }
          return out;
        },
        setValue(v) { while (rows.length < r) rows.push([]); rows[r - 1][c - 1] = v; return range; },
        setValues(vals) {
          if (vals.length !== nr || vals.some(row => row.length !== nc)) {
            throw new Error(`The number of columns in the data does not match the number of columns in the range. The data has ${vals[0].length} but the range has ${nc}.`);
          }
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
}

function loadCtx(opts) {
  const o = opts || {};
  const props = Object.assign({ SHEET_ID: 'sheet-1', SHARED_SECRET: MAIN,
    COORDINATORS_READ_SECRET: COORD, THERAPISTS_READ_SECRET: THER }, o.props || {});
  Object.keys(props).forEach(k => { if (props[k] === undefined) delete props[k]; });
  const tabs = {};
  const seed = o.seed || {};
  Object.keys(seed).forEach(k => { tabs[k] = strictSheet(seed[k].map(r => r.slice())); });
  const ctx = vm.createContext({
    Logger: { log() {} },
    PropertiesService: { getScriptProperties() {
      return { getProperty(k) { return Object.prototype.hasOwnProperty.call(props, k) ? props[k] : null; } };
    } },
    ContentService: { MimeType: { JSON: 1 }, createTextOutput(s) { return { _text: s, setMimeType() { return this; } }; } },
    LockService: { getScriptLock() { return { waitLock() {}, tryLock() { return true; }, releaseLock() {} }; } },
    Utilities: { formatDate(d, tz, fmt) { const iso = d.toISOString(); return fmt === 'yyyy-MM-dd' ? iso.slice(0, 10) : iso; } },
    Session: { getScriptTimeZone() { return 'UTC'; } },
    SpreadsheetApp: { openById() { return {
      getSheetByName(n) { return tabs[n] || null; },
      insertSheet(n) { tabs[n] = strictSheet([]); return tabs[n]; },
    }; } },
  });
  vm.runInContext(gs, ctx);
  ctx.tabs = tabs;
  return ctx;
}

const plain = v => JSON.parse(JSON.stringify(v));
const out = o => JSON.parse(o._text);
const post = (ctx, body) => out(ctx.doPost({ parameter: { secret: MAIN }, postData: { contents: JSON.stringify(body) } }));

function asgRow(over) {
  const r = ['a1', 'w1', 'ramot', 'מדריך/ה', '', 'hourly', 0, 0, 45, 100, 0, 0, 0, '', '2026-01-01T00:00:00.000Z',
    0, 'active', '', 0, 0, 0, 0, 0, 0, '', '', '', ''];
  Object.keys(over || {}).forEach(k => { r[Number(k)] = over[k]; });
  return r;
}
const guideAssignment = (over) => Object.assign({
  workerId: 'w1', house: 'ramot', role: 'מדריך/ה', employmentType: 'hourly', hourlyRate: 45, estHours: 100,
}, over || {});

// ---------------------------------------------------------------------------
// 1. validation — proxy and Code.gs agree
// ---------------------------------------------------------------------------

const VALID = [
  [{ weekdayMin: 0 }, { weekdayMin: 0 }],
  [{ weekdayMin: 6, weekendMin: 10 }, { weekdayMin: 6, weekendMin: 10 }],
  [{ weekdayMin: '3', weekendMin: '4' }, { weekdayMin: 3, weekendMin: 4 }],
  [{ weekdayMin: '', weekendMin: null }, { weekdayMin: null, weekendMin: null }],
  [{ allowedShifts: 'לילה,בוקר' }, { allowedShifts: 'בוקר,לילה' }],
  [{ allowedShifts: ['אחר צהריים', ' בוקר '] }, { allowedShifts: 'בוקר,אחר צהריים' }],
  [{ allowedShifts: [] }, { allowedShifts: null }],
  [{ allowedShifts: '' }, { allowedShifts: null }],
];
const INVALID = [
  { weekdayMin: 7 }, { weekdayMin: -1 }, { weekdayMin: 2.5 }, { weekdayMin: 'x' }, { weekdayMin: true },
  { weekendMin: 11 }, { weekendMin: -1 },
  { allowedShifts: 'בוקר,ערב' }, { allowedShifts: 'morning' }, { allowedShifts: [1] }, { allowedShifts: 5 },
];

test('proxy (lib/validate.js): minimum ranges, canonical shifts, null for blank', () => {
  for (const [input, want] of VALID) {
    const a = V.validateAssignment(guideAssignment(input));
    for (const k of Object.keys(want)) assert.deepEqual(a[k], want[k], JSON.stringify(input));
  }
  for (const bad of INVALID) {
    assert.throws(() => V.validateAssignment(guideAssignment(bad)), /bad (weekdayMin|weekendMin|allowedShifts)/,
      JSON.stringify(bad));
  }
});

test('Code.gs: the same inputs give the same results as the proxy', () => {
  const ctx = loadCtx();
  for (const [input, want] of VALID) {
    const m = plain(ctx.validateAssignment(guideAssignment(input)).shiftMinimums);
    for (const k of Object.keys(want)) assert.deepEqual(m[k], want[k], JSON.stringify(input));
  }
  for (const bad of INVALID) {
    assert.throws(() => ctx.validateAssignment(guideAssignment(bad)), /bad (weekdayMin|weekendMin|allowedShifts)/);
  }
  assert.deepEqual(plain(vm.runInContext('SHIFT_LABELS', ctx)), V.SHIFT_LABELS);
  assert.deepEqual(V.SHIFT_LABELS, ['בוקר', 'אחר צהריים', 'לילה'], 'the coordinators shift ids, byte-exact');
  assert.equal(vm.runInContext('WEEKDAY_MIN_MAX', ctx), 6);
  assert.equal(vm.runInContext('WEEKEND_MIN_MAX', ctx), 10);
});

test('key presence: the proxy forwards only keys that were sent', () => {
  const a = V.validateAssignment(guideAssignment({ weekdayMin: 3 }));
  assert.equal(a.weekdayMin, 3);
  assert.equal('weekendMin' in a, false);
  assert.equal('allowedShifts' in a, false);
});

test('non-guide placement: a minimum is a 400; none sent → all three cleared', () => {
  const ther = { workerId: 'w1', house: 'ramot', role: 'מטפל/ת', employmentType: 'hourly', hourlyRate: 1, estHours: 1 };
  assert.throws(() => V.validateAssignment(Object.assign({}, ther, { weekdayMin: 2 })), /מדריך\/ה only/);
  const a = V.validateAssignment(ther);
  assert.deepEqual([a.weekdayMin, a.weekendMin, a.allowedShifts], [null, null, null]);
  const ctx = loadCtx();
  assert.throws(() => ctx.validateAssignment(Object.assign({}, ther, { allowedShifts: 'בוקר' })), /מדריך\/ה only/);
});

// ---------------------------------------------------------------------------
// 2. write paths on a strict sheet
// ---------------------------------------------------------------------------

function writeCtx(asgRows) {
  return loadCtx({ seed: {
    workers: [H_WORKERS, ['w1', 'דנה כהן', '', '', '', '2025-01-01', '', '0501234567', '']],
    assignments: [H_ASSIGNMENTS].concat(asgRows || []),
  } });
}

test('addAssignment writes the minimum, reads it back, and echoes it', () => {
  const ctx = writeCtx();
  const r = post(ctx, { action: 'addAssignment',
    assignment: guideAssignment({ weekdayMin: 3, weekendMin: 4, allowedShifts: 'לילה,בוקר' }) });
  assert.equal(r._status, 200, JSON.stringify(r));
  assert.deepEqual([r.assignment.weekdayMin, r.assignment.weekendMin, r.assignment.allowedShifts], [3, 4, 'בוקר,לילה']);
  assert.equal('shiftMinimums' in r.assignment, false, 'the internal envelope never reaches the client');
  const row = ctx.tabs.assignments.rows[1];
  assert.equal(row.length, H_ASSIGNMENTS.length);
  assert.deepEqual(plain(row.slice(24)), ['', 3, 4, 'בוקר,לילה']);
  const back = plain(ctx.readAssignmentsSafe())[0];
  assert.deepEqual([back.weekdayMin, back.weekendMin, back.allowedShifts], [3, 4, 'בוקר,לילה']);
});

test('a blank minimum is stored blank and reads as null — never 0', () => {
  const ctx = writeCtx();
  post(ctx, { action: 'addAssignment', assignment: guideAssignment({ weekdayMin: '', weekendMin: 0 }) });
  const back = plain(ctx.readAssignmentsSafe())[0];
  assert.equal(back.weekdayMin, null);
  assert.equal(back.weekendMin, 0, 'an explicit 0 stays 0');
  assert.equal(back.allowedShifts, null);
});

test('updateAssignment: full-width write (strict sheet), effective_from preserved', () => {
  const ctx = writeCtx([asgRow({ 24: '2026-09-01', 25: 2, 26: 3, 27: 'בוקר' })]);
  const r = post(ctx, { action: 'updateAssignment', id: 'a1', assignment: guideAssignment({ hourlyRate: 50 }) });
  assert.equal(r._status, 200, JSON.stringify(r));
  const row = ctx.tabs.assignments.rows[1];
  assert.equal(row[8], 50);
  assert.equal(row[24], '2026-09-01', 'effective_from is not blanked by an edit');
  assert.deepEqual(plain(row.slice(25)), [2, 3, 'בוקר'], 'keys not sent keep their stored values');
  assert.equal(r.assignment.effectiveFrom, '2026-09-01');
});

test('updateAssignment changes exactly the minimum keys that were sent', () => {
  const ctx = writeCtx([asgRow({ 25: 2, 26: 3, 27: 'בוקר' })]);
  post(ctx, { action: 'updateAssignment', id: 'a1',
    assignment: guideAssignment({ weekdayMin: 5, allowedShifts: null }) });
  assert.deepEqual(plain(ctx.tabs.assignments.rows[1].slice(25)), [5, 3, '']);
});

test('changing a guide placement to a non-guide role clears the minimum', () => {
  const ctx = writeCtx([asgRow({ 25: 2, 26: 3, 27: 'בוקר' })]);
  const r = post(ctx, { action: 'updateAssignment', id: 'a1', assignment: {
    workerId: 'w1', house: 'ramot', role: 'מטפל/ת', employmentType: 'hourly', hourlyRate: 45, estHours: 100 } });
  assert.equal(r._status, 200, JSON.stringify(r));
  assert.deepEqual(plain(ctx.tabs.assignments.rows[1].slice(25)), ['', '', '']);
});

test('updateAssignment on a legacy 25-column row (no minimum cells) works', () => {
  const ctx = writeCtx([asgRow().slice(0, 25)]);
  const r = post(ctx, { action: 'updateAssignment', id: 'a1', assignment: guideAssignment({ weekendMin: 4 }) });
  assert.equal(r._status, 200, JSON.stringify(r));
  assert.deepEqual(plain(ctx.tabs.assignments.rows[1].slice(25)), ['', 4, '']);
});

test('a transfer carries the guide minimum to the new placement', () => {
  const ctx = writeCtx([asgRow({ 25: 3, 26: 4, 27: 'בוקר,לילה' })]);
  ctx.tabs.archive_v3 = strictSheet([['id']]);
  ctx.tabs.absences = strictSheet([['id']]);
  ctx.tabs.audit_log = strictSheet([['ts']]);
  const r = post(ctx, { action: 'moveAssignment', id: 'a1', house: 'asher', effectiveFrom: '2026-10-01' });
  assert.equal(r._status, 200, JSON.stringify(r));
  assert.deepEqual([r.assignment.weekdayMin, r.assignment.weekendMin, r.assignment.allowedShifts], [3, 4, 'בוקר,לילה']);
  const moved = plain(ctx.readAssignmentsSafe()).find(a => a.house === 'asher');
  assert.equal(moved.weekdayMin, 3);
});

// ---------------------------------------------------------------------------
// 3 + 4. the feeds
// ---------------------------------------------------------------------------

const FORBIDDEN_KEYS = /salary|pay|bank|rate|cost|amount|allowance|retainer|pct|notes|gmach|id$|^id|employment|detail/i;

function feedCtx(props) {
  return loadCtx({ props, seed: {
    workers: [H_WORKERS,
      ['w1', 'מדריכה שני בתים', 'סודי', '', '4+1', '2024-01-01', '', '0501111111', ''],
      ['w2', 'מדריך בלי מינימום', '', '', '', '', '', '', ''],
      ['w3', 'מדריכה בחל"ד', '', '', '', '2024-02-01', '', '', ''],
      ['w4', 'מטפלת פעילה', 'סודי', '', '', '2025-03-01', '', '0502222222', ''],
      ['w5', 'פסיכיאטר בשני תפקידים', '', '', '', '', '', '0503333333', ''],
      ['w6', 'מטפל בחל"ת', '', '', '', '', '', '', ''],
      ['w7', 'מטפלת שעזבה', '', '', '', '', '', '', ''],
      ['w8', 'מטפל בגמר חשבון', '', '', '', '', '', '', '']],
    assignments: [H_ASSIGNMENTS,
      asgRow({ 0: 'a1', 1: 'w1', 2: 'ramot', 6: 99999, 25: 3, 26: 4, 27: 'בוקר,לילה' }),
      asgRow({ 0: 'a2', 1: 'w1', 2: 'asher', 6: 88888, 25: 3, 26: 2, 27: 'בוקר,לילה' }),
      asgRow({ 0: 'a3', 1: 'w2', 2: 'rehab' }),
      asgRow({ 0: 'a4', 1: 'w3', 2: 'pardes', 16: 'chld', 25: 0 }),
      asgRow({ 0: 'a5', 1: 'w4', 2: 'ofroni', 3: 'מטפל/ת', 4: 'אמנות', 6: 77777 }),
      asgRow({ 0: 'a6', 1: 'w5', 2: 'ramot', 3: 'מטפל/ת' }),
      asgRow({ 0: 'a7', 1: 'w5', 2: 'asher', 3: 'פסיכיאטר/ית' }),
      asgRow({ 0: 'a8', 1: 'w6', 2: 'rehab', 3: 'מטפל/ת', 16: 'chlt' }),
      asgRow({ 0: 'a9', 1: 'w8', 2: 'rehab', 3: 'מטפל/ת', 16: 'final_settlement' })],
    archive_v3: [['id', 'assignment_id', 'worker_id', 'name', 'house', 'role'],
      ['arc1', 'a0', 'w7', 'מטפלת שעזבה', 'ramot', 'מטפל/ת']],
    feed_log: [['consumer', 'last_served_at', 'last_row_count', 'serve_count', 'status']],
  } });
}
const feed = (ctx, action, secret) => out(ctx.doGet({ parameter: { action, secret } }));

const GUIDE_KEYS = ['active', 'allowedShifts', 'assignmentIds', 'houses', 'minimumsByHouse', 'name', 'phone',
  'startDate', 'weekdayMin', 'weekendMin', 'workerId'];
const THERAPIST_KEYS = ['active', 'houses', 'name', 'phone', 'role', 'startDate'];

test('guides feed: exact key set on every entry, no pay/bank/salary', () => {
  const body = feed(feedCtx(), 'getGuidesForCoordinators', COORD);
  assert.deepEqual(Object.keys(body).sort(), ['_status', 'feedGeneratedAt', 'guides']);
  assert.ok(body.guides.length >= 3);
  for (const g of body.guides) {
    assert.deepEqual(Object.keys(g).sort(), GUIDE_KEYS);
    for (const h of Object.keys(g.minimumsByHouse)) {
      assert.deepEqual(Object.keys(g.minimumsByHouse[h]).sort(), ['allowedShifts', 'weekdayMin', 'weekendMin']);
    }
  }
  const text = JSON.stringify(body);
  for (const leak of ['99999', '88888', 'סודי', '4+1']) assert.equal(text.includes(leak), false, leak);
});

test('guides feed: minimum values — shared, per-house, null when not set (never 0)', () => {
  const by = {};
  feed(feedCtx(), 'getGuidesForCoordinators', COORD).guides.forEach(g => { by[g.name] = g; });
  const two = by['מדריכה שני בתים'];
  assert.equal(two.weekdayMin, 3, 'both houses agree');
  assert.equal(two.weekendMin, null, 'houses disagree (4 vs 2) → null scalar');
  assert.equal(two.allowedShifts, 'בוקר,לילה');
  assert.deepEqual(two.minimumsByHouse, {
    asher: { weekdayMin: 3, weekendMin: 2, allowedShifts: 'בוקר,לילה' },
    ramot: { weekdayMin: 3, weekendMin: 4, allowedShifts: 'בוקר,לילה' },
  });
  const none = by['מדריך בלי מינימום'];
  assert.deepEqual([none.weekdayMin, none.weekendMin, none.allowedShifts], [null, null, null]);
  assert.deepEqual(none.minimumsByHouse, { rehab: { weekdayMin: null, weekendMin: null, allowedShifts: null } });
  assert.equal(by['מדריכה בחל"ד'].weekdayMin, 0, 'an explicit 0 is 0');
  assert.equal(by['מדריכה בחל"ד'].active, false);
});

test('therapists feed: exact key set, current placements only, statuses, role', () => {
  const body = feed(feedCtx(), 'getTherapistsForCoordinators', COORD);
  assert.equal(body._status, 200);
  assert.deepEqual(Object.keys(body).sort(), ['_status', 'feedGeneratedAt', 'therapists']);
  const by = {};
  for (const t of body.therapists) {
    assert.deepEqual(Object.keys(t).sort(), THERAPIST_KEYS);
    for (const k of Object.keys(t)) assert.equal(FORBIDDEN_KEYS.test(k), false, 'forbidden key ' + k);
    by[t.name] = t;
  }
  assert.deepEqual(Object.keys(by).sort(),
    ['מטפל בגמר חשבון', 'מטפל בחל"ת', 'מטפלת פעילה', 'פסיכיאטר בשני תפקידים'].sort(),
    'guides excluded; the archived-only therapist excluded');
  assert.deepEqual(by['מטפלת פעילה'], { name: 'מטפלת פעילה', phone: '0502222222', role: 'מטפל/ת',
    active: true, houses: ['ofroni'], startDate: '2025-03-01' });
  assert.equal(by['פסיכיאטר בשני תפקידים'].role, 'פסיכיאטר/ית');
  assert.deepEqual(by['פסיכיאטר בשני תפקידים'].houses, ['asher', 'ramot'], 'sorted internal ids');
  assert.equal(by['מטפל בחל"ת'].active, false);
  assert.equal(by['מטפל בגמר חשבון'].active, false);
  const text = JSON.stringify(body);
  for (const leak of ['77777', 'סודי', 'אמנות', 'a5', 'w4']) assert.equal(text.includes(leak), false, leak);
});

test('therapists feed: fail-closed auth — only COORDINATORS_READ_SECRET opens it', () => {
  const ctx = feedCtx();
  for (const secret of [undefined, '', 'wrong', MAIN, THER, COORD + 'x', COORD.slice(0, -1)]) {
    const r = feed(ctx, 'getTherapistsForCoordinators', secret);
    assert.equal(r._status, 401, String(secret));
    assert.deepEqual(Object.keys(r).sort(), ['_status', 'error']);
  }
  const unset = feedCtx({ COORDINATORS_READ_SECRET: undefined });
  assert.equal(feed(unset, 'getTherapistsForCoordinators', COORD)._status, 401, 'unset property → closed');
  assert.equal(feed(unset, 'getTherapistsForCoordinators', '')._status, 401);
  // The coordinators secret unlocks nothing else.
  assert.equal(out(ctx.doGet({ parameter: { secret: COORD } }))._status, 401, 'not the main roster');
  assert.equal(feed(ctx, 'getTherapistsForTherapists', COORD)._status, 401);
});

test('therapists feed: constant-time comparison via secretMatches_, same property as guides', () => {
  const body = gs.slice(gs.indexOf('function handleCoordinatorsTherapistsRead_'),
    gs.indexOf('function computeTherapistsForCoordinators_'));
  assert.match(body, /coordinatorsAuthorized_\(e\)/);
  const auth = gs.slice(gs.indexOf('function coordinatorsAuthorized_'), gs.indexOf('function handleCoordinatorsRead_'));
  assert.match(auth, /secretMatches_\(required, provided\)/);
  assert.match(auth, /COORDINATORS_READ_SECRET_PROP/);
  assert.equal(/getProperty\('(?!SHEET_ID)[A-Z_]+SECRET/.test(body), false, 'no new secret');
});

test('therapists feed: served pulls are logged under their own consumer', () => {
  const ctx = feedCtx();
  feed(ctx, 'getTherapistsForCoordinators', COORD);
  const log = ctx.tabs.feed_log.rows.slice(1);
  assert.deepEqual(log.map(r => r[0]), ['coordinators_therapists']);
  assert.equal(log[0][2], 4);
});

// ---------------------------------------------------------------------------
// UI: HR edit fields
// ---------------------------------------------------------------------------

function page() {
  const vc = new VirtualConsole();
  const dom = new JSDOM(buildInlinedHtml(), { url: 'http://localhost/', runScripts: 'dangerously',
    pretendToBeVisual: true, virtualConsole: vc });
  return dom.window;
}

test('UI: minimum fields exist with Hebrew labels in both forms, shown only for מדריך/ה', () => {
  const w = page();
  const doc = w.document;
  for (const p of ['w', 'asg']) {
    assert.match(doc.querySelector(`label[for="${p}_weekdayMin"]`).textContent, /מינימום משמרות חול בשבוע/);
    assert.match(doc.querySelector(`label[for="${p}_weekendMin"]`).textContent, /מינימום משמרות סופ״ש בחודש/);
    assert.equal(doc.getElementById(`${p}_weekdayMin`).max, '6');
    assert.equal(doc.getElementById(`${p}_weekendMin`).max, '10');
    ['בוקר', 'אחר צהריים', 'לילה'].forEach((l, i) => {
      assert.equal(doc.getElementById(`${p}_shift_${i}`).value, l);
      assert.equal(doc.querySelector(`label[for="${p}_shift_${i}"]`).textContent, l);
    });
    w.toggleShiftMinimumFields(p, 'מדריך/ה');
    assert.equal(doc.getElementById(`${p}_min_wrap`).classList.contains('hidden'), false);
    doc.getElementById(`${p}_weekdayMin`).value = '4';
    w.toggleShiftMinimumFields(p, 'מטפל/ת');
    assert.equal(doc.getElementById(`${p}_min_wrap`).classList.contains('hidden'), true);
    assert.equal(doc.getElementById(`${p}_weekdayMin`).value, '', 'hidden = cleared');
  }
  w.close();
});

test('UI: readShiftMinimumFields → nulls for blank, canonical shifts, rejects out of range', () => {
  const w = page();
  const doc = w.document;
  w.toast = () => {};
  w.toggleShiftMinimumFields('asg', 'מדריך/ה');
  assert.deepEqual(plain(w.readShiftMinimumFields('asg', 'מדריך/ה')),
    { weekdayMin: null, weekendMin: null, allowedShifts: null });
  doc.getElementById('asg_weekdayMin').value = '3';
  doc.getElementById('asg_weekendMin').value = '0';
  doc.getElementById('asg_shift_2').checked = true;
  doc.getElementById('asg_shift_0').checked = true;
  assert.deepEqual(plain(w.readShiftMinimumFields('asg', 'מדריך/ה')),
    { weekdayMin: 3, weekendMin: 0, allowedShifts: 'בוקר,לילה' });
  doc.getElementById('asg_weekdayMin').value = '7';
  assert.equal(w.readShiftMinimumFields('asg', 'מדריך/ה'), null, 'out of range blocks the save');
  assert.deepEqual(plain(w.readShiftMinimumFields('asg', 'מטפל/ת')),
    { weekdayMin: null, weekendMin: null, allowedShifts: null });
  w.setShiftMinimumFields('w', { weekdayMin: 2, weekendMin: null, allowedShifts: 'אחר צהריים' });
  assert.equal(doc.getElementById('w_weekdayMin').value, '2');
  assert.equal(doc.getElementById('w_weekendMin').value, '');
  assert.equal(doc.getElementById('w_shift_1').checked, true);
  assert.equal(doc.getElementById('w_shift_0').checked, false);
  w.close();
});

// ---------------------------------------------------------------------------
// editor report: the most recently added therapists
// ---------------------------------------------------------------------------

test('reportRecentTherapistsNow: newest therapists first, lists what HR must fill, writes nothing', () => {
  const ctx = loadCtx({ seed: {
    workers: [H_WORKERS,
      ['w1', 'ותיקה', '', '2025-01-01T00:00:00.000Z', '', '2025-01-01', '', '0501111111', ''],
      ['w2', 'חדשה בלי טלפון', '', '2026-09-20T00:00:00.000Z', '', '2026-09-20', '', '', ''],
      ['w3', 'הכי חדש', '', '2026-09-22T00:00:00.000Z', '', '', '', '0502222222', ''],
      ['w4', 'מדריך חדש מאוד', '', '2026-09-23T00:00:00.000Z', '', '', '', '', '']],
    assignments: [H_ASSIGNMENTS,
      asgRow({ 0: 'a1', 1: 'w1', 3: 'מטפל/ת', 6: 55555 }),
      asgRow({ 0: 'a2', 1: 'w2', 2: 'asher', 3: 'פסיכיאטר/ית' }),
      asgRow({ 0: 'a3', 1: 'w3', 2: 'rehab', 3: 'מטפל/ת' }),
      asgRow({ 0: 'a4', 1: 'w4', 3: 'מדריך/ה' })],
  } });
  const before = JSON.stringify(ctx.tabs);
  const r = plain(ctx.reportRecentTherapistsNow());
  assert.equal(JSON.stringify(ctx.tabs), before, 'read-only');
  assert.deepEqual(r.map(x => x.name), ['הכי חדש', 'חדשה בלי טלפון'], 'guides excluded, newest first, default 2');
  assert.deepEqual(r[0].missing, ['תאריך תחילת עבודה']);
  assert.deepEqual(r[1].missing, ['טלפון נייד']);
  assert.equal(r[1].placements[0].role, 'פסיכיאטר/ית');
  assert.equal(r[0].inCoordinatorsFeed, true);
  assert.equal(JSON.stringify(r).includes('55555'), false, 'no pay in the report');
});
