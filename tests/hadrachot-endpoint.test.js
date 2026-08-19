'use strict';

// Guards for the read-only getGuidesForHadrachot feed (apps-script/Code.gs).
//
// Like tests/digest.test.js, the Apps Script backend has no JS harness, so we
// (1) evaluate Code.gs in a vm sandbox with the GAS services mocked and drive
// doGet end-to-end for the auth behaviour, and (2) exercise the pure builder
// computeGuidesForHadrachot_ with overridden readers for the field filtering.
//
// The two hard rules pinned here:
//   - FIELD FILTERING: the feed carries name / house / active / startDate and
//     NOTHING else — no salary, cost, rate, pct, allowance, retainer, id.
//   - FAIL-CLOSED AUTH: missing HADRACHOT_READ_SECRET property, missing
//     secret, wrong secret, or the main SHARED_SECRET → 401 error, never data.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const GS_PATH = path.join(ROOT, 'apps-script', 'Code.gs');
const gs = fs.readFileSync(GS_PATH, 'utf8');

// Evaluate Code.gs in a sandbox with the GAS surface the hadrachot path
// touches mocked out. `props` seeds the Script Properties store.
function loadCtx(props) {
  const store = Object.assign({}, props);
  const ctx = vm.createContext({
    Logger: { log() {} },
    PropertiesService: {
      getScriptProperties() {
        return {
          getProperty(k) {
            return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null;
          },
        };
      },
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput(s) { return { _text: s, setMimeType() { return this; } }; },
    },
  });
  vm.runInContext(gs, ctx);
  return ctx;
}

// A ContentService TextOutput mock → the parsed JSON body.
function out(o) { return JSON.parse(o._text); }

function plain(v) { return JSON.parse(JSON.stringify(v)); }

const FINANCIAL_WORDS = ['salary', 'cost', 'rate', 'budget', 'retainer', 'allowance', 'pct', 'amount'];

// Roster fixture: one guide with every financial field populated, one
// therapist (must be excluded — hadrachot are for guides), one guide on
// חל"ד leave (active:false), one orphaned assignment, one undated guide.
function seedReaders(ctx) {
  ctx.readWorkersSafe = () => [
    { id: 'w1', name: 'דנה לוי', notes: 'סודי', startDate: '2026-08-01', shift_commitment: '4+1' },
    { id: 'w2', name: 'יואב כהן', notes: '', startDate: '2026-07-01' },
    { id: 'w3', name: 'רות אשר', notes: '', startDate: '' },
    { id: 'w4', name: 'מטפלת', notes: '', startDate: '2026-01-01' },
  ];
  ctx.readAssignmentsSafe = () => [
    { id: 'a1', workerId: 'w1', house: 'ramot', role: 'מדריך/ה', employmentType: 'full_time',
      salary: 99999, pct: 50, hourlyRate: 80, estHours: 100, sessionRate: 400, estSessions: 10,
      retainerAmount: 5000, allowance: 6000, status: 'active', notes: 'תנאים' },
    { id: 'a2', workerId: 'w2', house: 'asher', role: 'מדריך/ה', status: 'chld', statusDate: '2026-07-20' },
    { id: 'a3', workerId: 'w3', house: 'rehab', role: 'מדריך/ה', status: 'active' },
    { id: 'a4', workerId: 'w4', house: 'ramot', role: 'מטפל/ת', status: 'active' },
    { id: 'a5', workerId: 'ghost', house: 'ramot', role: 'מדריך/ה', status: 'active' },
  ];
}

// ---------------------------------------------------------------------------
// Field filtering
// ---------------------------------------------------------------------------

test('computeGuidesForHadrachot_ emits ONLY name/house/active/startDate', () => {
  const ctx = loadCtx();
  seedReaders(ctx);
  const guides = plain(ctx.computeGuidesForHadrachot_());
  assert.ok(guides.length > 0, 'fixture must produce entries');
  for (const g of guides) {
    assert.deepStrictEqual(Object.keys(g).sort(), ['active', 'house', 'name', 'startDate'],
      'every entry carries exactly the four whitelisted fields');
  }
});

test('salary and every other financial field are ABSENT from the feed', () => {
  const ctx = loadCtx();
  seedReaders(ctx);
  const flat = JSON.stringify(plain(ctx.computeGuidesForHadrachot_()));
  for (const bad of ['salary', 'hourlyRate', 'sessionRate', 'retainerAmount', 'allowance',
    'pct', 'employmentType', 'notes', 'shift_commitment']) {
    assert.ok(!flat.includes(bad), `field "${bad}" must never appear in the feed`);
  }
  // The fixture's financial VALUES must not leak either.
  for (const bad of ['99999', '5000', '6000', '400']) {
    assert.ok(!flat.includes(bad), `financial value ${bad} must never appear in the feed`);
  }
});

test('feed filters to guides, maps active status, keeps empty start dates, skips orphans', () => {
  const ctx = loadCtx();
  seedReaders(ctx);
  const guides = plain(ctx.computeGuidesForHadrachot_());
  // w4 is a מטפל/ת (not a guide) and a5 is orphaned — both out.
  assert.deepStrictEqual(guides.map(g => g.name).sort(),
    ['דנה לוי', 'יואב כהן', 'רות אשר'].sort());
  const byName = {};
  guides.forEach(g => { byName[g.name] = g; });
  assert.strictEqual(byName['דנה לוי'].active, true);
  assert.strictEqual(byName['דנה לוי'].house, 'ramot');
  assert.strictEqual(byName['דנה לוי'].startDate, '2026-08-01');
  // On חל"ד leave → active:false, but still listed.
  assert.strictEqual(byName['יואב כהן'].active, false);
  // Empty start date is a first-class value, passed through as ''.
  assert.strictEqual(byName['רות אשר'].startDate, '');
});

test('a blank stored status reads as active (matches readAssignmentsSafe normalization)', () => {
  const ctx = loadCtx();
  ctx.readWorkersSafe = () => [{ id: 'w1', name: 'א', startDate: '' }];
  ctx.readAssignmentsSafe = () => [{ id: 'a1', workerId: 'w1', house: 'ramot', role: 'מדריך/ה' }];
  assert.strictEqual(plain(ctx.computeGuidesForHadrachot_())[0].active, true);
});

// ---------------------------------------------------------------------------
// Fail-closed auth (end-to-end through doGet)
// ---------------------------------------------------------------------------

function callFeed(ctx, secret) {
  const e = { parameter: { action: 'getGuidesForHadrachot' } };
  if (secret !== undefined) e.parameter.secret = secret;
  return out(ctx.doGet(e));
}

test('HADRACHOT_READ_SECRET unset → 401 error, never data (fail-closed)', () => {
  const ctx = loadCtx({ SHARED_SECRET: 'main-secret' }); // feature secret NOT set
  seedReaders(ctx);
  const body = callFeed(ctx, 'anything');
  assert.strictEqual(body._status, 401);
  assert.strictEqual(body.error, 'unauthorized');
  assert.ok(!('guides' in body), 'no data key on an unauthorized response');
});

test('missing or wrong secret → 401, correct secret → the guides payload', () => {
  const ctx = loadCtx({ HADRACHOT_READ_SECRET: 'hadr-secret' });
  seedReaders(ctx);
  assert.strictEqual(callFeed(ctx)._status, 401);
  assert.strictEqual(callFeed(ctx, '')._status, 401);
  assert.strictEqual(callFeed(ctx, 'wrong-secret')._status, 401);
  const ok = callFeed(ctx, 'hadr-secret');
  assert.strictEqual(ok._status, 200);
  assert.ok(Array.isArray(ok.guides) && ok.guides.length === 3);
});

test('the two secrets never unlock each other\'s surface', () => {
  const ctx = loadCtx({ SHARED_SECRET: 'main-secret', HADRACHOT_READ_SECRET: 'hadr-secret' });
  seedReaders(ctx);
  // Main roster secret does NOT open the hadrachot feed…
  assert.strictEqual(callFeed(ctx, 'main-secret')._status, 401);
  // …and the hadrachot secret does NOT open the main doGet dump.
  const body = out(ctx.doGet({ parameter: { secret: 'hadr-secret' } }));
  assert.strictEqual(body._status, 401);
  assert.ok(!('workers' in body) && !('assignments' in body),
    'the roster dump must not open for the feed secret');
});

// ---------------------------------------------------------------------------
// Source guards
// ---------------------------------------------------------------------------

test('HEADERS_WORKERS is untouched — the feed is read-only, no schema change', () => {
  const m = /const HEADERS_WORKERS = \[([^\]]*)\]/.exec(gs);
  assert.ok(m, 'HEADERS_WORKERS should be declared');
  const cols = m[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert.deepStrictEqual(cols,
    ['id', 'name', 'notes', 'created_at', 'shift_commitment', 'start_date'],
    'HEADERS_WORKERS is append-only and position-mapped — this feature must not touch it');
});

test('computeGuidesForHadrachot_ source contains no financial word', () => {
  const start = gs.indexOf('function computeGuidesForHadrachot_');
  assert.ok(start >= 0, 'builder must exist');
  const fn = gs.slice(start, gs.indexOf('\n}', start));
  for (const bad of FINANCIAL_WORDS) {
    assert.ok(!fn.toLowerCase().includes(bad),
      `computeGuidesForHadrachot_ must never mention "${bad}"`);
  }
});

test('the feed authorizes via its own property through the constant-time comparator', () => {
  assert.ok(/const HADRACHOT_READ_SECRET_PROP = 'HADRACHOT_READ_SECRET'/.test(gs),
    'the property name is part of the contract');
  const start = gs.indexOf('function hadrachotAuthorized_');
  const fn = gs.slice(start, gs.indexOf('\n}', start));
  assert.ok(/HADRACHOT_READ_SECRET_PROP/.test(fn), 'reads its own property');
  assert.ok(/secretMatches_\(/.test(fn), 'uses the shared constant-time compare');
  assert.ok(!/SHARED_SECRET/.test(fn), 'never consults the roster secret');
});
