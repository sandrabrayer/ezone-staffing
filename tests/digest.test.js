'use strict';

// Guards for the NewGuides digest export (apps-script/Code.gs).
//
// This app is the SOLE writer of a small, standalone spreadsheet it creates
// and owns; the coordinators app reads it read-only. The digest lists
// guides/employees whose start date falls in the current week or the next two
// weeks. See DIGEST-CONTRACT.md at the repo root.
//
// The Apps Script backend has no JS harness, so — like the other backend
// guards in this suite — we (1) parse Code.gs as text for the frozen-contract
// invariants and (2) evaluate the PURE digest helpers in a vm sandbox to
// exercise the window math, house mapping, filtering, and the hard rule that
// NO financial field ever reaches the digest.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const GS_PATH = path.join(ROOT, 'apps-script', 'Code.gs');
const gs = fs.readFileSync(GS_PATH, 'utf8');

// The frozen column contract (append-only). Duplicated here on purpose: if
// someone reorders or renames a column in Code.gs, this literal must be
// updated too, which is exactly the review checkpoint we want.
const FROZEN_HEADERS = ['house', 'guideName', 'startDate', 'role', 'updatedAt'];
// GuidesRoster: the original four columns plus the two APPENDED (status, endDate).
const ROSTER_ORIGINAL_HEADERS = ['house', 'guideName', 'startDate', 'updatedAt'];
const FROZEN_ROSTER_HEADERS = ['house', 'guideName', 'startDate', 'updatedAt', 'status', 'endDate'];
const FROZEN_ACTIVITY_HEADERS = ['house', 'guideName', 'date', 'updatedAt'];
const FINANCIAL_WORDS = ['salary', 'cost', 'rate', 'budget', 'retainer', 'allowance', 'pct', 'amount'];

// Evaluate Code.gs once in a bare sandbox. Top-level only runs const/function
// declarations (no GAS calls happen at load), so a near-empty context is
// enough; the functions we call are pure or have their readers overridden.
// Top-level `const`s aren't reachable as globals, so we append a small
// exporter (same lexical scope) that copies the ones we assert on onto `this`.
function loadCtx() {
  const ctx = vm.createContext({ Logger: { log() {} } });
  vm.runInContext(gs
    + '\n;this.__DIGEST_HOUSE_CANONICAL = DIGEST_HOUSE_CANONICAL;'
    + '\n;this.__DIGEST_HOUSE_HEBREW = DIGEST_HOUSE_HEBREW;'
    + '\n;this.__HOUSE_IDS = HOUSE_IDS;', ctx);
  return ctx;
}

// Cross-realm objects fail deepStrictEqual's prototype check, so normalize
// anything coming out of the vm back into this realm.
function plain(v) {
  return JSON.parse(JSON.stringify(v));
}

// ---------------------------------------------------------------------------
// Frozen contract — source guards
// ---------------------------------------------------------------------------

test('DIGEST_HEADERS is exactly the frozen contract, in order', () => {
  const m = /const DIGEST_HEADERS = \[([^\]]*)\]/.exec(gs);
  assert.ok(m, 'DIGEST_HEADERS should be declared');
  const cols = m[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert.deepStrictEqual(cols, FROZEN_HEADERS,
    'columns are an append-only contract — never reorder/rename/remove');
});

test('the digest header carries NO financial field (hard rule)', () => {
  for (const col of FROZEN_HEADERS) {
    for (const bad of FINANCIAL_WORDS) {
      assert.ok(!col.toLowerCase().includes(bad),
        `header "${col}" must not resemble financial field "${bad}"`);
    }
  }
});

test('DIGEST_ROSTER_HEADERS is exactly the frozen GuidesRoster contract, in order', () => {
  const m = /const DIGEST_ROSTER_HEADERS = \[([^\]]*)\]/.exec(gs);
  assert.ok(m, 'DIGEST_ROSTER_HEADERS should be declared');
  const cols = m[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert.deepStrictEqual(cols, FROZEN_ROSTER_HEADERS,
    'GuidesRoster columns are an append-only contract — never reorder/rename/remove');
});

test('GuidesRoster: status + endDate were APPENDED to the end, not inserted', () => {
  const m = /const DIGEST_ROSTER_HEADERS = \[([^\]]*)\]/.exec(gs);
  const cols = m[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  // The original four columns keep their exact positions (0..3).
  assert.deepStrictEqual(cols.slice(0, ROSTER_ORIGINAL_HEADERS.length), ROSTER_ORIGINAL_HEADERS,
    'the original GuidesRoster columns must not move — new columns go on the END only');
  // The two new columns are strictly appended after them, in this order.
  assert.deepStrictEqual(cols.slice(ROSTER_ORIGINAL_HEADERS.length), ['status', 'endDate'],
    'status then endDate must be appended after the original columns');
  assert.strictEqual(cols.length, ROSTER_ORIGINAL_HEADERS.length + 2,
    'exactly two columns were appended');
});

test('DIGEST_ACTIVITY_HEADERS is the frozen NewlyHired/NewlyDeparted contract', () => {
  const m = /const DIGEST_ACTIVITY_HEADERS = \[([^\]]*)\]/.exec(gs);
  assert.ok(m, 'DIGEST_ACTIVITY_HEADERS should be declared');
  const cols = m[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert.deepStrictEqual(cols, FROZEN_ACTIVITY_HEADERS);
});

test('the new tabs (GuidesRoster status/endDate + activity) carry NO financial field', () => {
  for (const col of FROZEN_ROSTER_HEADERS.concat(FROZEN_ACTIVITY_HEADERS)) {
    for (const bad of FINANCIAL_WORDS) {
      assert.ok(!col.toLowerCase().includes(bad),
        `header "${col}" must not resemble financial field "${bad}"`);
    }
  }
});

test('NewlyHired + NewlyDeparted tabs are named and written on every rebuild', () => {
  assert.ok(/const DIGEST_NEWLY_HIRED_TAB = 'NewlyHired'/.test(gs), 'NewlyHired tab name');
  assert.ok(/const DIGEST_NEWLY_DEPARTED_TAB = 'NewlyDeparted'/.test(gs), 'NewlyDeparted tab name');
  assert.ok(/writeDigestTab_\(book, DIGEST_NEWLY_HIRED_TAB,/.test(gs), 'NewlyHired written');
  assert.ok(/writeDigestTab_\(book, DIGEST_NEWLY_DEPARTED_TAB,/.test(gs), 'NewlyDeparted written');
});

test('DIGEST_HOUSE_HEBREW maps the five physical houses to their app display names', () => {
  const m = /const DIGEST_HOUSE_HEBREW = \{([\s\S]*?)\};/.exec(gs);
  assert.ok(m, 'DIGEST_HOUSE_HEBREW should be declared');
  const block = m[1];
  assert.ok(/ramot:\s*'רמות השבים'/.test(block));
  assert.ok(/asher:\s*'רעננה אשר'/.test(block));
  assert.ok(/ofroni:\s*'קיסריה עפרוני'/.test(block));
  assert.ok(/rehab:\s*'קיסריה ריהאב'/.test(block));
  assert.ok(/pardes:\s*'רעננה הפרדס'/.test(block), 'pardes opened — it is a digest house now');
  // Excluded houses must not appear.
  for (const excluded of ['sde_eliezer', 'hq']) {
    assert.ok(!new RegExp(excluded + ':').test(block), `${excluded} must be excluded`);
  }
});

test('the GuidesRoster header carries NO financial field (hard rule)', () => {
  for (const col of FROZEN_ROSTER_HEADERS) {
    for (const bad of FINANCIAL_WORDS) {
      assert.ok(!col.toLowerCase().includes(bad),
        `header "${col}" must not resemble financial field "${bad}"`);
    }
  }
});

test('the GuidesRoster tab is named and written on every rebuild', () => {
  assert.ok(/const DIGEST_ROSTER_TAB = 'GuidesRoster'/.test(gs),
    'GuidesRoster tab name is part of the contract');
  // rebuildDigest must write BOTH tabs.
  assert.ok(/writeDigestTab_\(book, DIGEST_TAB,/.test(gs), 'NewGuides tab is written');
  assert.ok(/writeDigestTab_\(book, DIGEST_ROSTER_TAB,/.test(gs), 'GuidesRoster tab is written');
});

test('setWorkerStartDates triggers a digest rebuild', () => {
  const m = /const DIGEST_REBUILD_ACTIONS = \[([^\]]*)\]/.exec(gs);
  assert.ok(m, 'DIGEST_REBUILD_ACTIONS should be declared');
  assert.ok(/setWorkerStartDates/.test(m[1]),
    'the bulk start-date action must rebuild the digest so GuidesRoster picks up new dates');
});

test('DIGEST_HOUSE_CANONICAL maps internal ids to canonical ids and excludes pre-opening/pseudo houses', () => {
  const ctx = loadCtx();
  const map = plain(ctx.__DIGEST_HOUSE_CANONICAL);
  assert.deepStrictEqual(map, {
    ramot: 'ramot',
    asher: 'raanana',
    ofroni: 'efroni',
    rehab: 'rehab',
    pardes: 'pardes',
  });
  // The pre-opening house (שדה אליעזר) and the HQ pseudo-house are excluded.
  for (const excluded of ['sde_eliezer', 'hq']) {
    assert.ok(!(excluded in map), `${excluded} must be excluded from the digest`);
  }
});

// The guard that caught the pardes gap: every house id the app knows
// (lib/validate.js HOUSE_IDS — mirrored by Code.gs HOUSE_IDS) must either be
// covered by BOTH digest maps or appear on the explicit exclusion list below.
// Opening a new house means adding it to the digest maps OR consciously adding
// it here — never silently dropping its guide rows from the digest.
const DIGEST_EXCLUDED_HOUSES = ['sde_eliezer', 'hq'];

test('digest maps cover every house id except the explicit exclusions (no silent gaps)', () => {
  const { HOUSE_IDS } = require(path.join(ROOT, 'lib', 'validate.js'));
  const ctx = loadCtx();
  const canonical = plain(ctx.__DIGEST_HOUSE_CANONICAL);
  const hebrew = plain(ctx.__DIGEST_HOUSE_HEBREW);
  assert.deepStrictEqual(plain(ctx.__HOUSE_IDS), HOUSE_IDS,
    'Code.gs HOUSE_IDS must mirror lib/validate.js HOUSE_IDS');
  for (const id of HOUSE_IDS) {
    const excluded = DIGEST_EXCLUDED_HOUSES.includes(id);
    assert.strictEqual(id in canonical, !excluded,
      `house '${id}' must be ${excluded ? 'excluded from' : 'covered by'} DIGEST_HOUSE_CANONICAL`);
    assert.strictEqual(id in hebrew, !excluded,
      `house '${id}' must be ${excluded ? 'excluded from' : 'covered by'} DIGEST_HOUSE_HEBREW`);
  }
  // The two maps must always cover the exact same set of houses.
  assert.deepStrictEqual(Object.keys(hebrew).sort(), Object.keys(canonical).sort(),
    'DIGEST_HOUSE_HEBREW and DIGEST_HOUSE_CANONICAL must cover the same houses');
});

test('this app owns a SEPARATE digest spreadsheet (distinct from the roster SHEET_ID)', () => {
  assert.ok(/const DIGEST_SHEET_ID_PROP = 'DIGEST_SHEET_ID'/.test(gs),
    'digest lives in its own spreadsheet, keyed by DIGEST_SHEET_ID');
  assert.ok(/function setupDigestSpreadsheet\s*\(/.test(gs),
    'one-time setup function must exist');
  assert.ok(/SpreadsheetApp\.create\(/.test(gs),
    'setup must CREATE the spreadsheet this app owns');
  assert.ok(/addViewer\(DIGEST_READER_EMAIL\)/.test(gs),
    'setup must share the digest read-only with the reader');
  assert.ok(/const DIGEST_READER_EMAIL = 'brayersandra@gmail\.com'/.test(gs),
    'reader email is part of the contract');
});

test('rebuild is wired into the write path AND a periodic trigger backstop', () => {
  assert.ok(/DIGEST_REBUILD_ACTIONS\.indexOf\(body\.action\) >= 0\) rebuildDigestSafe\(\)/.test(gs),
    'doPost must rebuild after relevant writes');
  assert.ok(/function installDigestTrigger\s*\(/.test(gs),
    'a time-based trigger installer must exist');
  assert.ok(/newTrigger\('rebuildDigest'\)/.test(gs),
    'the trigger must run rebuildDigest');
});

// ---------------------------------------------------------------------------
// Window math (pure)
// ---------------------------------------------------------------------------

test('digestWindow_ spans the current week Sunday .. Saturday two weeks later (21 days)', () => {
  const ctx = loadCtx();
  // 2026-07-27 is a Monday. Its week's Sunday is 2026-07-26; +2 full weeks
  // ends on the Saturday 2026-08-15 (20 days later, inclusive → 21-day span).
  const win = plain(ctx.digestWindow_('2026-07-27'));
  assert.deepStrictEqual(win, { start: '2026-07-26', end: '2026-08-15' });

  // A Sunday anchor is itself the window start.
  assert.strictEqual(ctx.digestWindow_('2026-07-26').start, '2026-07-26');
  // A Saturday anchor still uses that week's Sunday as the start.
  assert.strictEqual(ctx.digestWindow_('2026-08-01').start, '2026-07-26');
});

test('digestIsoToYmd_ extracts the date part; junk → empty', () => {
  const ctx = loadCtx();
  assert.strictEqual(ctx.digestIsoToYmd_('2026-07-27T08:00:00.000Z'), '2026-07-27');
  assert.strictEqual(ctx.digestIsoToYmd_('2026-07-27'), '2026-07-27');
  assert.strictEqual(ctx.digestIsoToYmd_(''), '');
  assert.strictEqual(ctx.digestIsoToYmd_('not-a-date'), '');
});

// ---------------------------------------------------------------------------
// computeDigestRows_ (readers overridden)
// ---------------------------------------------------------------------------

function withRoster(workers, assignments) {
  const ctx = loadCtx();
  ctx.readWorkersSafe = () => workers;
  ctx.readAssignmentsSafe = () => assignments;
  return ctx;
}

test('computeDigestRows_ emits names/dates/roles only — NEVER financial data', () => {
  const ctx = withRoster(
    [{ id: 'w1', name: 'דנה' }],
    [{
      id: 'a1', workerId: 'w1', house: 'asher', role: 'מדריך/ה',
      createdAt: '2026-07-27T08:00:00.000Z',
      // Financial fields present on the source row must be ignored:
      salary: 99999, hourlyRate: 80, retainerAmount: 5000, allowance: 6000, pct: 50,
    }],
  );
  const rows = plain(ctx.computeDigestRows_('2026-07-27T12:00:00.000Z', '2026-07-27'));
  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual(rows[0], ['raanana', 'דנה', '2026-07-27', 'מדריך/ה', '2026-07-27T12:00:00.000Z']);
  // No financial value leaked into any cell.
  const flat = JSON.stringify(rows);
  for (const bad of ['99999', '80', '5000', '6000']) {
    assert.ok(!flat.includes(bad), `financial value ${bad} must not appear in the digest`);
  }
});

test('computeDigestRows_ maps houses and excludes pre-opening/pseudo houses', () => {
  const ctx = withRoster(
    [{ id: 'w1', name: 'A' }, { id: 'w2', name: 'B' }, { id: 'w3', name: 'C' },
     { id: 'w4', name: 'D' }, { id: 'w5', name: 'E' }, { id: 'w6', name: 'F' }, { id: 'w7', name: 'G' }],
    [
      { id: 'a1', workerId: 'w1', house: 'ramot',       role: '', createdAt: '2026-07-27T00:00:00Z' },
      { id: 'a2', workerId: 'w2', house: 'asher',       role: '', createdAt: '2026-07-27T00:00:00Z' },
      { id: 'a3', workerId: 'w3', house: 'ofroni',      role: '', createdAt: '2026-07-27T00:00:00Z' },
      { id: 'a4', workerId: 'w4', house: 'rehab',       role: '', createdAt: '2026-07-27T00:00:00Z' },
      { id: 'a5', workerId: 'w5', house: 'pardes',      role: '', createdAt: '2026-07-27T00:00:00Z' },
      { id: 'a6', workerId: 'w6', house: 'sde_eliezer', role: '', createdAt: '2026-07-27T00:00:00Z' },
      { id: 'a7', workerId: 'w7', house: 'hq',          role: '', createdAt: '2026-07-27T00:00:00Z' },
    ],
  );
  const houses = plain(ctx.computeDigestRows_('2026-07-27T12:00:00Z', '2026-07-27')).map(r => r[0]);
  // pardes is an OPEN house now (canonical id 'pardes'); sde_eliezer + hq stay out.
  assert.deepStrictEqual(houses.sort(), ['efroni', 'pardes', 'raanana', 'ramot', 'rehab']);
});

test('computeDigestRows_ keeps only startDates inside the window', () => {
  const ctx = withRoster(
    [{ id: 'w1', name: 'in' }, { id: 'w2', name: 'past' }, { id: 'w3', name: 'future' }, { id: 'w4', name: 'edge' }],
    [
      { id: 'a1', workerId: 'w1', house: 'ramot', role: '', createdAt: '2026-07-27T00:00:00Z' }, // in window
      { id: 'a2', workerId: 'w2', house: 'ramot', role: '', createdAt: '2026-07-01T00:00:00Z' }, // before start
      { id: 'a3', workerId: 'w3', house: 'ramot', role: '', createdAt: '2026-09-01T00:00:00Z' }, // after end
      { id: 'a4', workerId: 'w4', house: 'ramot', role: '', createdAt: '2026-08-15T00:00:00Z' }, // last day (inclusive)
    ],
  );
  const names = plain(ctx.computeDigestRows_('2026-07-27T12:00:00Z', '2026-07-27')).map(r => r[1]).sort();
  assert.deepStrictEqual(names, ['edge', 'in']);
});

test('computeDigestRows_ skips assignments whose worker is missing, and sorts by house/date/name', () => {
  const ctx = withRoster(
    [{ id: 'w1', name: 'זהר' }, { id: 'w2', name: 'אבי' }],
    [
      { id: 'a0', workerId: 'ghost', house: 'ramot', role: '', createdAt: '2026-07-27T00:00:00Z' }, // orphan
      { id: 'a1', workerId: 'w1', house: 'rehab', role: 'מטפל/ת', createdAt: '2026-07-27T00:00:00Z' },
      { id: 'a2', workerId: 'w2', house: 'ramot', role: 'מדריך/ה', createdAt: '2026-07-28T00:00:00Z' },
    ],
  );
  const rows = plain(ctx.computeDigestRows_('2026-07-27T12:00:00Z', '2026-07-27'));
  assert.strictEqual(rows.length, 2, 'orphan assignment is skipped');
  // ramot sorts before rehab.
  assert.deepStrictEqual(rows.map(r => r[0]), ['ramot', 'rehab']);
});

// ---------------------------------------------------------------------------
// computeRosterRows_ — the GuidesRoster tab (readers overridden)
// ---------------------------------------------------------------------------

test('computeRosterRows_ emits house/guideName/startDate/updatedAt — NEVER financial data', () => {
  const ctx = withRoster(
    [{ id: 'w1', name: 'דנה', startDate: '2025-01-15' }],
    [{
      id: 'a1', workerId: 'w1', house: 'asher', role: 'מדריך/ה',
      createdAt: '2026-07-27T08:00:00.000Z',
      // Financial fields present on the source row must be ignored:
      salary: 99999, hourlyRate: 80, retainerAmount: 5000, allowance: 6000, pct: 50,
    }],
  );
  const rows = plain(ctx.computeRosterRows_('2026-07-27T12:00:00.000Z'));
  assert.strictEqual(rows.length, 1);
  // startDate is the WORKER's employment start date, not the assignment's createdAt.
  // Appended cols: status defaults to 'active', endDate '' while active.
  assert.deepStrictEqual(rows[0],
    ['raanana', 'דנה', '2025-01-15', '2026-07-27T12:00:00.000Z', 'active', '']);
  const flat = JSON.stringify(rows);
  for (const bad of ['99999', '80', '5000', '6000']) {
    assert.ok(!flat.includes(bad), `financial value ${bad} must not appear in the roster`);
  }
});

test('computeRosterRows_ includes ALL active guides regardless of date window; empty startDate allowed', () => {
  const ctx = withRoster(
    [{ id: 'w1', name: 'ותיק', startDate: '2019-03-01' },   // long-tenured
     { id: 'w2', name: 'חדש', startDate: '' }],              // not yet entered
    [
      { id: 'a1', workerId: 'w1', house: 'ramot', role: 'מדריך/ה', createdAt: '2019-03-01T00:00:00Z' },
      { id: 'a2', workerId: 'w2', house: 'ramot', role: 'מדריך/ה', createdAt: '2026-07-27T00:00:00Z' },
    ],
  );
  const rows = plain(ctx.computeRosterRows_('2026-07-27T12:00:00Z'));
  assert.strictEqual(rows.length, 2, 'no date-window filter — both guides appear');
  const byName = {};
  rows.forEach(r => { byName[r[1]] = r[2]; });
  assert.strictEqual(byName['ותיק'], '2019-03-01');
  assert.strictEqual(byName['חדש'], '', 'a guide with no start date entered yet is still listed');
});

test('computeRosterRows_ maps houses, excludes pre-opening/pseudo houses, skips orphans, sorts by house/name', () => {
  const ctx = withRoster(
    [{ id: 'w1', name: 'B', startDate: '' }, { id: 'w2', name: 'A', startDate: '' },
     { id: 'w3', name: 'C', startDate: '' }, { id: 'w4', name: 'D', startDate: '' },
     { id: 'w5', name: 'E', startDate: '' }],
    [
      { id: 'a1', workerId: 'w1', house: 'ramot',  role: '', createdAt: '2026-07-27T00:00:00Z' },
      { id: 'a2', workerId: 'w2', house: 'ramot',  role: '', createdAt: '2026-07-27T00:00:00Z' },
      { id: 'a3', workerId: 'w3', house: 'rehab',  role: '', createdAt: '2026-07-27T00:00:00Z' },
      { id: 'a4', workerId: 'w4', house: 'sde_eliezer', role: '', createdAt: '2026-07-27T00:00:00Z' }, // excluded
      { id: 'a5', workerId: 'ghost', house: 'ramot', role: '', createdAt: '2026-07-27T00:00:00Z' }, // orphan
      { id: 'a6', workerId: 'w5', house: 'pardes', role: '', createdAt: '2026-07-27T00:00:00Z' }, // included (open house)
    ],
  );
  const rows = plain(ctx.computeRosterRows_('2026-07-27T12:00:00Z'));
  // sde_eliezer excluded + orphan skipped → 4 rows; pardes (E) before ramot (A, B) before rehab (C).
  assert.deepStrictEqual(rows.map(r => [r[0], r[1]]),
    [['pardes', 'E'], ['ramot', 'A'], ['ramot', 'B'], ['rehab', 'C']]);
});

test('computeRosterRows_ lists a guide once per house when placed at several', () => {
  const ctx = withRoster(
    [{ id: 'w1', name: 'משה', startDate: '2020-06-01' }],
    [
      { id: 'a1', workerId: 'w1', house: 'ramot', role: 'מדריך/ה', createdAt: '2020-06-01T00:00:00Z' },
      { id: 'a2', workerId: 'w1', house: 'rehab', role: 'מדריך/ה', createdAt: '2026-07-01T00:00:00Z' },
    ],
  );
  const rows = plain(ctx.computeRosterRows_('2026-07-27T12:00:00Z'));
  assert.deepStrictEqual(rows, [
    ['ramot', 'משה', '2020-06-01', '2026-07-27T12:00:00Z', 'active', ''],
    ['rehab', 'משה', '2020-06-01', '2026-07-27T12:00:00Z', 'active', ''],
  ]);
});

test('computeRosterRows_ reflects leave status + endDate (status_date) when not active', () => {
  const ctx = withRoster(
    [{ id: 'w1', name: 'רות', startDate: '2022-01-01' },
     { id: 'w2', name: 'גל', startDate: '2023-05-05' }],
    [
      // active → status 'active', endDate ''
      { id: 'a1', workerId: 'w1', house: 'ramot', role: 'מדריך/ה', status: 'active', statusDate: '' },
      // on חל"ד → status 'chld', endDate = the leave start (status_date)
      { id: 'a2', workerId: 'w2', house: 'ramot', role: 'מדריך/ה', status: 'chld', statusDate: '2026-07-16' },
    ],
  );
  const rows = plain(ctx.computeRosterRows_('2026-07-27T12:00:00Z'));
  const byName = {};
  rows.forEach(r => { byName[r[1]] = { status: r[4], endDate: r[5] }; });
  assert.deepStrictEqual(byName['רות'], { status: 'active', endDate: '' });
  assert.deepStrictEqual(byName['גל'], { status: 'chld', endDate: '2026-07-16' });
});

// ---------------------------------------------------------------------------
// NewlyHired — trailing-30-day intakes (Hebrew house names)
// ---------------------------------------------------------------------------

test('computeNewlyHiredRows_ lists start dates in the last 30 days, Hebrew house, NO financials', () => {
  const ctx = withRoster(
    [{ id: 'w1', name: 'טרי', startDate: '2026-07-10' },   // 17 days ago — in
     { id: 'w2', name: 'ותיק', startDate: '2026-01-01' },  // long ago — out
     { id: 'w3', name: 'קצה', startDate: '2026-06-27' },   // exactly 30 days ago — in
     { id: 'w4', name: 'עתידי', startDate: '2026-08-20' }], // future — out
    [
      { id: 'a1', workerId: 'w1', house: 'asher',  role: 'מדריך/ה', salary: 9999 },
      { id: 'a2', workerId: 'w2', house: 'ramot',  role: 'מדריך/ה' },
      { id: 'a3', workerId: 'w3', house: 'rehab',  role: 'מדריך/ה' },
      { id: 'a4', workerId: 'w4', house: 'ramot',  role: 'מדריך/ה' },
    ],
  );
  const rows = plain(ctx.computeNewlyHiredRows_('2026-07-27T12:00:00Z', '2026-07-27'));
  assert.deepStrictEqual(rows, [
    ['קיסריה ריהאב', 'קצה', '2026-06-27', '2026-07-27T12:00:00Z'],
    ['רעננה אשר', 'טרי', '2026-07-10', '2026-07-27T12:00:00Z'],
  ]);
  assert.ok(!JSON.stringify(rows).includes('9999'), 'no financial value leaks');
});

test('computeNewlyHiredRows_ excludes pre-opening / hq houses and undated workers', () => {
  const ctx = withRoster(
    [{ id: 'w1', name: 'A', startDate: '2026-07-10' },
     { id: 'w2', name: 'B', startDate: '2026-07-10' },
     { id: 'w3', name: 'C', startDate: '' },
     { id: 'w4', name: 'D', startDate: '2026-07-10' }],
    [
      { id: 'a1', workerId: 'w1', house: 'sde_eliezer', role: 'מדריך/ה' }, // excluded
      { id: 'a2', workerId: 'w2', house: 'hq',          role: 'אחר' },      // excluded
      { id: 'a3', workerId: 'w3', house: 'ramot',       role: 'מדריך/ה' }, // no start date
      { id: 'a4', workerId: 'w4', house: 'pardes',      role: 'מדריך/ה' }, // included (open house)
    ],
  );
  const rows = plain(ctx.computeNewlyHiredRows_('2026-07-27T12:00:00Z', '2026-07-27'));
  assert.deepStrictEqual(rows, [
    ['רעננה הפרדס', 'D', '2026-07-10', '2026-07-27T12:00:00Z'],
  ]);
});

// ---------------------------------------------------------------------------
// NewlyDeparted — trailing-30-day departures from the archive (Hebrew house)
// ---------------------------------------------------------------------------

function withArchive(archiveRows, workers) {
  const ctx = loadCtx();
  ctx.readArchiveV3Safe = () => archiveRows;
  ctx.readWorkersSafe = () => (workers || []);
  ctx.readAssignmentsSafe = () => [];
  return ctx;
}

test('computeNewlyDepartedRows_ lists termination dates in the last 30 days, Hebrew house, NO financials', () => {
  const ctx = withArchive([
    { id: 'arc1', name: 'עוזב', house: 'ofroni', terminationDate: '2026-07-20', salary: 12345 }, // in
    { id: 'arc2', name: 'ישן',  house: 'ramot',  terminationDate: '2026-01-01' },                 // out
    { id: 'arc3', name: 'קצה',  house: 'rehab',  terminationDate: '2026-06-27' },                 // 30 days — in
    { id: 'arc4', name: '',     house: 'ramot',  terminationDate: '2026-07-21' },                 // no name — skip
    { id: 'arc5', name: 'פרדס', house: 'pardes', terminationDate: '2026-07-21' },                 // included (open house)
    { id: 'arc6', name: 'שדה',  house: 'sde_eliezer', terminationDate: '2026-07-21' },            // excluded house
  ]);
  const rows = plain(ctx.computeNewlyDepartedRows_('2026-07-27T12:00:00Z', '2026-07-27'));
  assert.deepStrictEqual(rows, [
    ['קיסריה עפרוני', 'עוזב', '2026-07-20', '2026-07-27T12:00:00Z'],
    ['קיסריה ריהאב', 'קצה', '2026-06-27', '2026-07-27T12:00:00Z'],
    ['רעננה הפרדס', 'פרדס', '2026-07-21', '2026-07-27T12:00:00Z'],
  ]);
  assert.ok(!JSON.stringify(rows).includes('12345'), 'no financial value leaks');
});
