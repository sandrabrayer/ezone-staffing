'use strict';

// Staffing → coordinators: the THERAPIST roster feed, and what did NOT move.
//
// Scope decision: guide shift minimums (weekdayMin / weekendMin /
// allowedShifts) stay owned by the COORDINATORS app. Staffing carries none:
// no fields on a placement, no UI, no feed keys. Assignment columns 25-27
// (weekday_min / weekend_min / allowed_shifts) are RETIRED reserved header
// positions — never read, never exposed, passed through untouched.
//
// Pinned here:
//   1. getTherapistsForCoordinators — same COORDINATORS_READ_SECRET,
//      constant-time, fail-closed; current placements only (no ArchiveV3);
//      exact key set: name, phone, role, active, houses, startDate. No pay,
//      bank, salary, id.
//   2. getGuidesForCoordinators is UNCHANGED — its original key set, and no
//      minimum field anywhere (feed, proxy validation, reader, page).
//   3. updateAssignment writes the row at FULL header width (it wrote 24
//      values into a 25-column range after effective_from was appended —
//      Apps Script rejects that), preserving effective_from and the retired
//      cells as stored.
//   4. reportRecentTherapistsNow — the editor report on the newest therapists.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
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
// write paths on a strict sheet
// ---------------------------------------------------------------------------

function writeCtx(asgRows) {
  return loadCtx({ seed: {
    workers: [H_WORKERS, ['w1', 'דנה כהן', '', '', '', '2025-01-01', '', '0501234567', '']],
    assignments: [H_ASSIGNMENTS].concat(asgRows || []),
  } });
}

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

test('updateAssignment on a legacy 25-column row works and adds blank retired cells', () => {
  const ctx = writeCtx([asgRow().slice(0, 25)]);
  const r = post(ctx, { action: 'updateAssignment', id: 'a1', assignment: guideAssignment({ hourlyRate: 60 }) });
  assert.equal(r._status, 200, JSON.stringify(r));
  const row = ctx.tabs.assignments.rows[1];
  assert.equal(row.length, H_ASSIGNMENTS.length);
  assert.deepEqual(plain(row.slice(25)), ['', '', '']);
});

test('addAssignment writes the full header width with blank retired cells', () => {
  const ctx = writeCtx();
  const r = post(ctx, { action: 'addAssignment', assignment: guideAssignment() });
  assert.equal(r._status, 200, JSON.stringify(r));
  const row = ctx.tabs.assignments.rows[1];
  assert.equal(row.length, H_ASSIGNMENTS.length);
  assert.deepEqual(plain(row.slice(24)), ['', '', '', '']);
});

// ---------------------------------------------------------------------------
// shift minimums stay in coordinators: nothing of them in staffing
// ---------------------------------------------------------------------------

test('no minimum field survives: proxy validation strips them, the reader never exposes them', () => {
  const a = V.validateAssignment(guideAssignment({ weekdayMin: 3, weekendMin: 4, allowedShifts: 'בוקר' }));
  for (const k of ['weekdayMin', 'weekendMin', 'allowedShifts']) assert.equal(k in a, false, k);
  const ctx = writeCtx([asgRow({ 25: 3, 26: 4, 27: 'בוקר' })]);
  const back = plain(ctx.readAssignmentsSafe())[0];
  for (const k of ['weekdayMin', 'weekendMin', 'allowedShifts']) assert.equal(k in back, false, k);
  const r = post(ctx, { action: 'addAssignment', assignment: Object.assign(guideAssignment({ house: 'asher' }),
    { weekdayMin: 3 }) });
  assert.equal(r._status, 200);
  assert.equal('weekdayMin' in r.assignment, false);
  assert.deepEqual(plain(ctx.tabs.assignments.rows[2].slice(25)), ['', '', ''], 'a direct /exec caller cannot write them');
});

test('no minimum field in the page', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.equal(/weekdayMin|weekendMin|allowedShifts|מינימום משמרות/.test(html), false);
});

test('a stored retired value is passed through by an edit, never cleared or exposed', () => {
  const ctx = writeCtx([asgRow({ 24: '2026-09-01', 25: 3, 26: 4, 27: 'בוקר' })]);
  const r = post(ctx, { action: 'updateAssignment', id: 'a1', assignment: guideAssignment({ hourlyRate: 50 }) });
  assert.equal(r._status, 200, JSON.stringify(r));
  assert.deepEqual(plain(ctx.tabs.assignments.rows[1].slice(24)), ['2026-09-01', 3, 4, 'בוקר']);
  assert.equal(JSON.stringify(r).includes('בוקר'), false);
});

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

const GUIDE_KEYS = ['active', 'assignmentIds', 'houses', 'name', 'phone', 'startDate', 'workerId'];
const THERAPIST_KEYS = ['active', 'houses', 'name', 'phone', 'role', 'startDate'];

test('guides feed: UNCHANGED — the original key set, no minimum keys, no pay/bank/salary', () => {
  const body = feed(feedCtx(), 'getGuidesForCoordinators', COORD);
  assert.deepEqual(Object.keys(body).sort(), ['_status', 'feedGeneratedAt', 'guides']);
  assert.ok(body.guides.length >= 3);
  for (const g of body.guides) assert.deepEqual(Object.keys(g).sort(), GUIDE_KEYS);
  const text = JSON.stringify(body);
  for (const leak of ['99999', '88888', 'סודי', '4+1', 'minimum', 'weekday', 'allowedShifts']) {
    assert.equal(text.includes(leak), false, leak);
  }
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
