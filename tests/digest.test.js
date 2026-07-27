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
const FINANCIAL_WORDS = ['salary', 'cost', 'rate', 'budget', 'retainer', 'allowance', 'pct', 'amount'];

// Evaluate Code.gs once in a bare sandbox. Top-level only runs const/function
// declarations (no GAS calls happen at load), so a near-empty context is
// enough; the functions we call are pure or have their readers overridden.
// Top-level `const`s aren't reachable as globals, so we append a small
// exporter (same lexical scope) that copies the ones we assert on onto `this`.
function loadCtx() {
  const ctx = vm.createContext({ Logger: { log() {} } });
  vm.runInContext(gs + '\n;this.__DIGEST_HOUSE_CANONICAL = DIGEST_HOUSE_CANONICAL;', ctx);
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

test('DIGEST_HOUSE_CANONICAL maps internal ids to canonical ids and excludes pre-opening/pseudo houses', () => {
  const ctx = loadCtx();
  const map = plain(ctx.__DIGEST_HOUSE_CANONICAL);
  assert.deepStrictEqual(map, {
    ramot: 'ramot',
    asher: 'raanana',
    ofroni: 'efroni',
    rehab: 'rehab',
  });
  // Pre-opening houses (הפרדס / שדה אליעזר) and the HQ pseudo-house are excluded.
  for (const excluded of ['pardes', 'sde_eliezer', 'hq']) {
    assert.ok(!(excluded in map), `${excluded} must be excluded from the digest`);
  }
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
  assert.deepStrictEqual(houses.sort(), ['efroni', 'raanana', 'ramot', 'rehab']);
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
