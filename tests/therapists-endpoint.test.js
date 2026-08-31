'use strict';

// Guards for the read-only getTherapistsForTherapists feed
// (apps-script/Code.gs) — the therapists app's roster sync.
//
// Like tests/hadrachot-endpoint.test.js, the Apps Script backend has no JS
// harness, so we (1) evaluate Code.gs in a vm sandbox with the GAS services
// mocked and drive doGet end-to-end for the auth behaviour, and (2) exercise
// the pure builder computeTherapistsFeed_ with overridden readers for the
// field filtering.
//
// The hard rules pinned here:
//   - FIELD FILTERING: the feed carries name / active / houses / startDate
//     and NOTHING else — no salary, cost, rate, pct, allowance, retainer,
//     notes, role_detail, id.
//   - ONE ENTRY PER WORKER: a therapist placed at two houses is one person
//     with both house ids; active is true iff ANY therapist-role placement
//     is active.
//   - ROLE FILTER: trimmed role ∈ {מטפל/ת, פסיכיאטר/ית} only.
//   - FAIL-CLOSED AUTH: missing THERAPISTS_READ_SECRET property, missing
//     secret, wrong secret, SHARED_SECRET, or HADRACHOT_READ_SECRET →
//     401 error, never data — and the therapists secret unlocks nothing else.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const GS_PATH = path.join(ROOT, 'apps-script', 'Code.gs');
const gs = fs.readFileSync(GS_PATH, 'utf8');

// Evaluate Code.gs in a sandbox with the GAS surface the therapists path
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

// Roster fixture:
//   w1 therapist (מטפל/ת) at TWO houses, both active, EVERY financial field
//      populated with sentinel values → one entry, both houses, active.
//   w2 psychiatrist (פסיכיאטר/ית) active → included.
//   w3 whitespace-padded ' מטפל/ת ' role → still included.
//   w4 therapist whose only placement is on חל"ד (chld) → active:false.
//   w5 therapist with one active + one chld placement → active:true.
//   w6 guide (מדריך/ה), w7 house manager (מנהל/ת), w8 cook (טבח/ית),
//      w9 role אחר → all excluded.
//   w10 blank name therapist → skipped.
//   w11 terminated therapist: lives ONLY in ArchiveV3, no assignment row →
//      not in the feed (terminated placements are excluded automatically).
//   w12 therapist with an empty startDate → '' passthrough.
//   w13 therapist on חל"ת (chlt), w14 on גמ"ח (final_settlement) → active:false.
//   'ghost' orphaned assignment (no worker) → skipped.
function seedReaders(ctx) {
  ctx.readWorkersSafe = () => [
    { id: 'w1', name: ' אורית מזרחי ', notes: 'סודי', startDate: '2024-01-02', shift_commitment: '4+1' },
    { id: 'w2', name: 'בני לב', notes: '', startDate: '2024-02-03' },
    { id: 'w3', name: 'גדי רם', notes: '', startDate: '2024-03-04' },
    { id: 'w4', name: 'דוד קם', notes: '', startDate: '2024-04-06' },
    { id: 'w5', name: 'הדס און', notes: '', startDate: '2024-06-07' },
    { id: 'w6', name: 'ורד סתיו', notes: '', startDate: '2024-07-08' },
    { id: 'w7', name: 'זיו הר', notes: '', startDate: '2024-08-09' },
    { id: 'w8', name: 'חן ים', notes: '', startDate: '2024-09-10' },
    { id: 'w9', name: 'טל צור', notes: '', startDate: '2024-10-11' },
    { id: 'w10', name: '   ', notes: '', startDate: '2024-11-12' },
    { id: 'w11', name: 'יעל דן', notes: '', startDate: '2024-12-13' },
    { id: 'w12', name: 'כרם זיו', notes: '', startDate: '' },
    { id: 'w13', name: 'לאה בר', notes: '', startDate: '2026-01-14' },
    { id: 'w14', name: 'מור גל', notes: '', startDate: '2026-02-16' },
  ];
  ctx.readAssignmentsSafe = () => [
    { id: 'a1', workerId: 'w1', house: 'ramot', role: 'מטפל/ת', roleDetail: 'אמנות',
      employmentType: 'per_session', salary: 99999, pct: 47, hourlyRate: 777, estHours: 111,
      sessionRate: 444, estSessions: 22, retainerAmount: 5678, allowance: 6000,
      rateIndividual: 333, sessionsIndividual: 8, rateGroup: 222, sessionsGroup: 9,
      rateExternal: 666, externalPatients: 7, status: 'active', notes: 'תנאים' },
    { id: 'a2', workerId: 'w1', house: 'asher', role: 'מטפל/ת', status: 'active', salary: 99999 },
    { id: 'a3', workerId: 'w2', house: 'rehab', role: 'פסיכיאטר/ית', status: 'active', sessionRate: 444 },
    { id: 'a4', workerId: 'w3', house: 'ofroni', role: ' מטפל/ת ', status: 'active' },
    { id: 'a5', workerId: 'w4', house: 'ramot', role: 'מטפל/ת', status: 'chld', statusDate: '2026-07-20' },
    { id: 'a6', workerId: 'w5', house: 'ramot', role: 'מטפל/ת', status: 'chld' },
    { id: 'a7', workerId: 'w5', house: 'rehab', role: 'מטפל/ת', status: 'active' },
    { id: 'a8', workerId: 'w6', house: 'ramot', role: 'מדריך/ה', status: 'active' },
    { id: 'a9', workerId: 'w7', house: 'asher', role: 'מנהל/ת', status: 'active', salary: 99999 },
    { id: 'a10', workerId: 'w8', house: 'ramot', role: 'טבח/ית', status: 'active' },
    { id: 'a11', workerId: 'w9', house: 'rehab', role: 'אחר', status: 'active' },
    { id: 'a12', workerId: 'w10', house: 'ramot', role: 'מטפל/ת', status: 'active' },
    { id: 'a13', workerId: 'ghost', house: 'ramot', role: 'מטפל/ת', status: 'active' },
    { id: 'a14', workerId: 'w12', house: 'asher', role: 'מטפל/ת', status: 'active' },
    { id: 'a15', workerId: 'w13', house: 'ofroni', role: 'מטפל/ת', status: 'chlt' },
    { id: 'a16', workerId: 'w14', house: 'rehab', role: 'פסיכיאטר/ית', status: 'final_settlement' },
  ];
  // w11's only therapist placement was terminated — it lives in ArchiveV3
  // and is absent from the assignments tab, so w11 must not be in the feed.
  ctx.readArchiveV3Safe = () => [
    { id: 'ar1', assignmentId: 'a99', workerId: 'w11', name: 'יעל דן', house: 'ramot',
      role: 'מטפל/ת', terminationDate: '2026-06-30', salary: 99999 },
  ];
}

function feed(ctx) { return plain(ctx.computeTherapistsFeed_()); }

function byName(ctx) {
  const m = {};
  feed(ctx).forEach(t => { m[t.name] = t; });
  return m;
}

// ---------------------------------------------------------------------------
// Field filtering
// ---------------------------------------------------------------------------

test('computeTherapistsFeed_ emits ONLY name/active/houses/startDate', () => {
  const ctx = loadCtx();
  seedReaders(ctx);
  const therapists = feed(ctx);
  assert.ok(therapists.length > 0, 'fixture must produce entries');
  for (const t of therapists) {
    assert.deepStrictEqual(Object.keys(t).sort(), ['active', 'houses', 'name', 'startDate'],
      'every entry carries exactly the four whitelisted fields');
    assert.strictEqual(typeof t.active, 'boolean');
    assert.ok(Array.isArray(t.houses));
  }
});

test('salary and every other stripped field is ABSENT from the feed', () => {
  const ctx = loadCtx();
  seedReaders(ctx);
  const flat = JSON.stringify(feed(ctx));
  for (const bad of ['salary', 'hourlyRate', 'sessionRate', 'estSessions', 'retainerAmount',
    'allowance', 'pct', 'rateIndividual', 'rateGroup', 'rateExternal', 'employmentType',
    'notes', 'shift_commitment', 'roleDetail', 'role_detail', 'gmach', 'workerId', '"id"']) {
    assert.ok(!flat.includes(bad), `field "${bad}" must never appear in the feed`);
  }
  // The fixture's financial/private VALUES must not leak either.
  for (const bad of ['99999', '777', '444', '5678', '6000', '333', '222', '666', '111',
    'סודי', 'תנאים', 'אמנות']) {
    assert.ok(!flat.includes(bad), `fixture value ${bad} must never appear in the feed`);
  }
});

// ---------------------------------------------------------------------------
// Role filter
// ---------------------------------------------------------------------------

test('feed includes מטפל/ת and פסיכיאטר/ית only; all other roles are excluded', () => {
  const ctx = loadCtx();
  seedReaders(ctx);
  const names = feed(ctx).map(t => t.name).sort();
  assert.deepStrictEqual(names,
    ['אורית מזרחי', 'בני לב', 'גדי רם', 'דוד קם', 'הדס און', 'כרם זיו', 'לאה בר', 'מור גל'].sort());
  // מדריך/ה, מנהל/ת, טבח/ית, אחר → out.
  const m = byName(ctx);
  for (const excluded of ['ורד סתיו', 'זיו הר', 'חן ים', 'טל צור']) {
    assert.ok(!(excluded in m), `non-therapist role worker "${excluded}" must be excluded`);
  }
});

test('a whitespace-padded role string still matches (trimmed compare)', () => {
  const ctx = loadCtx();
  seedReaders(ctx);
  const m = byName(ctx);
  assert.ok('גדי רם' in m, "role ' מטפל/ת ' with stray whitespace must be included");
  assert.deepStrictEqual(m['גדי רם'].houses, ['ofroni']);
});

// ---------------------------------------------------------------------------
// One entry per worker / active aggregation
// ---------------------------------------------------------------------------

test('a therapist at two houses is ONE entry with both house ids', () => {
  const ctx = loadCtx();
  seedReaders(ctx);
  const entries = feed(ctx).filter(t => t.name === 'אורית מזרחי');
  assert.strictEqual(entries.length, 1, 'one entry per worker, never per assignment');
  assert.deepStrictEqual(entries[0].houses, ['asher', 'ramot'], 'sorted house ids');
  assert.strictEqual(entries[0].active, true);
  assert.strictEqual(entries[0].name, 'אורית מזרחי', 'name is trimmed');
});

test('chld / chlt / final_settlement on the only placement → active:false; mixed → true', () => {
  const ctx = loadCtx();
  seedReaders(ctx);
  const m = byName(ctx);
  assert.strictEqual(m['דוד קם'].active, false, 'chld alone is not active');
  assert.strictEqual(m['לאה בר'].active, false, 'chlt alone is not active');
  assert.strictEqual(m['מור גל'].active, false, 'final_settlement alone is not active');
  assert.strictEqual(m['הדס און'].active, true, 'one active + one chld placement → active');
  assert.deepStrictEqual(m['הדס און'].houses, ['ramot', 'rehab'],
    'leave placements still contribute their house');
});

test('a blank stored status reads as active (normalizeStatus)', () => {
  const ctx = loadCtx();
  ctx.readWorkersSafe = () => [{ id: 'w1', name: 'א', startDate: '' }];
  ctx.readAssignmentsSafe = () => [{ id: 'a1', workerId: 'w1', house: 'ramot', role: 'מטפל/ת' }];
  assert.strictEqual(feed(ctx)[0].active, true);
});

// ---------------------------------------------------------------------------
// Exclusions and passthroughs
// ---------------------------------------------------------------------------

test('a worker whose only therapist placement was terminated (ArchiveV3) is not in the feed', () => {
  const ctx = loadCtx();
  seedReaders(ctx);
  assert.ok(!('יעל דן' in byName(ctx)),
    'terminated placements live in ArchiveV3, not assignments — excluded automatically');
});

test('orphaned assignment skipped, blank name skipped, empty startDate passes through', () => {
  const ctx = loadCtx();
  seedReaders(ctx);
  const therapists = feed(ctx);
  for (const t of therapists) {
    assert.ok(t.name.trim() !== '', 'blank-name workers never appear');
  }
  // the orphan a13 ('ghost') produced no entry — total count is exactly the 8 named workers
  assert.strictEqual(therapists.length, 8);
  assert.strictEqual(byName(ctx)['כרם זיו'].startDate, '',
    'empty start date is a first-class value, passed through as \'\'');
});

// ---------------------------------------------------------------------------
// Fail-closed auth (end-to-end through doGet)
// ---------------------------------------------------------------------------

function callFeed(ctx, secret) {
  const e = { parameter: { action: 'getTherapistsForTherapists' } };
  if (secret !== undefined) e.parameter.secret = secret;
  return out(ctx.doGet(e));
}

test('THERAPISTS_READ_SECRET unset → 401 error, never data, nothing read (fail-closed)', () => {
  const ctx = loadCtx({ SHARED_SECRET: 'main-secret', HADRACHOT_READ_SECRET: 'hadr-secret' });
  // Prove that an unauthorized request reads NOTHING from the sheet.
  ctx.readWorkersSafe = () => { throw new Error('must not read workers'); };
  ctx.readAssignmentsSafe = () => { throw new Error('must not read assignments'); };
  const body = callFeed(ctx, 'anything');
  assert.strictEqual(body._status, 401);
  assert.strictEqual(body.error, 'unauthorized');
  assert.ok(!('therapists' in body), 'no data key on an unauthorized response');
});

test('missing/empty/wrong/foreign secret → 401, correct secret → the therapists payload', () => {
  const ctx = loadCtx({
    SHARED_SECRET: 'main-secret',
    HADRACHOT_READ_SECRET: 'hadr-secret',
    THERAPISTS_READ_SECRET: 'ther-secret',
  });
  seedReaders(ctx);
  assert.strictEqual(callFeed(ctx)._status, 401);
  assert.strictEqual(callFeed(ctx, '')._status, 401);
  assert.strictEqual(callFeed(ctx, 'wrong-secret')._status, 401);
  // The OTHER surfaces' secrets must not unlock this feed.
  assert.strictEqual(callFeed(ctx, 'main-secret')._status, 401);
  assert.strictEqual(callFeed(ctx, 'hadr-secret')._status, 401);
  for (const s of [undefined, '', 'wrong-secret', 'main-secret', 'hadr-secret']) {
    assert.ok(!('therapists' in callFeed(ctx, s)), 'no therapists key without the right secret');
  }
  const ok = callFeed(ctx, 'ther-secret');
  assert.strictEqual(ok._status, 200);
  assert.ok(Array.isArray(ok.therapists) && ok.therapists.length === 8);
});

test('THERAPISTS_READ_SECRET unlocks neither the roster doGet nor the hadrachot feed', () => {
  const ctx = loadCtx({
    SHARED_SECRET: 'main-secret',
    HADRACHOT_READ_SECRET: 'hadr-secret',
    THERAPISTS_READ_SECRET: 'ther-secret',
  });
  seedReaders(ctx);
  // …not the main roster dump…
  const roster = out(ctx.doGet({ parameter: { secret: 'ther-secret' } }));
  assert.strictEqual(roster._status, 401);
  assert.ok(!('workers' in roster) && !('assignments' in roster),
    'the roster dump must not open for the therapists feed secret');
  // …and not the hadrachot feed.
  const hadr = out(ctx.doGet({ parameter: { action: 'getGuidesForHadrachot', secret: 'ther-secret' } }));
  assert.strictEqual(hadr._status, 401);
  assert.ok(!('guides' in hadr), 'the hadrachot feed must not open for the therapists feed secret');
});

// ---------------------------------------------------------------------------
// Source guards
// ---------------------------------------------------------------------------

// Parse a top-level `const NAME = [ 'a', 'b', ... ]` string-array literal
// out of the Code.gs source (top-level consts are not reachable as vm
// context properties — only function declarations are).
function parseStringArray(name) {
  const m = new RegExp('const ' + name + ' = \\[([^\\]]*)\\]').exec(gs);
  assert.ok(m, `const ${name} should be declared`);
  const out = [];
  const re = /'((?:[^'\\]|\\.)*)'/g;
  let s;
  while ((s = re.exec(m[1])) !== null) out.push(s[1]);
  return out;
}

test('every THERAPISTS_FEED_ROLES value exists in ROLE_OPTIONS (catches a role rename)', () => {
  const feedRoles = parseStringArray('THERAPISTS_FEED_ROLES');
  const roleOptions = parseStringArray('ROLE_OPTIONS');
  assert.deepStrictEqual(feedRoles, ['מטפל/ת', 'פסיכיאטר/ית'],
    'the feed matches exactly the therapist and psychiatrist role strings');
  for (const r of feedRoles) {
    assert.ok(roleOptions.indexOf(r) >= 0,
      `feed role "${r}" must be a byte-exact ROLE_OPTIONS entry — renaming the role in ROLE_OPTIONS without updating THERAPISTS_FEED_ROLES would silently empty the feed`);
  }
});

test('computeTherapistsFeed_ source contains no financial word', () => {
  const start = gs.indexOf('function computeTherapistsFeed_');
  assert.ok(start >= 0, 'builder must exist');
  const fn = gs.slice(start, gs.indexOf('\n}', start));
  for (const bad of FINANCIAL_WORDS) {
    assert.ok(!fn.toLowerCase().includes(bad),
      `computeTherapistsFeed_ must never mention "${bad}"`);
  }
});

test('the feed authorizes via its own property through the constant-time comparator', () => {
  assert.ok(/const THERAPISTS_READ_SECRET_PROP = 'THERAPISTS_READ_SECRET'/.test(gs),
    'the property name is part of the contract');
  const start = gs.indexOf('function therapistsAuthorized_');
  const fn = gs.slice(start, gs.indexOf('\n}', start));
  assert.ok(/THERAPISTS_READ_SECRET_PROP/.test(fn), 'reads its own property');
  assert.ok(/secretMatches_\(/.test(fn), 'uses the shared constant-time compare');
  assert.ok(!/SHARED_SECRET/.test(fn) && !/HADRACHOT/.test(fn),
    'never consults another surface\'s secret');
});

test('no HEADERS_* array gained or lost a column — the feed is read-only, no schema change', () => {
  const m = /const HEADERS_WORKERS = \[([^\]]*)\]/.exec(gs);
  assert.ok(m, 'HEADERS_WORKERS should be declared');
  const cols = m[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert.deepStrictEqual(cols,
    ['id', 'name', 'notes', 'created_at', 'shift_commitment', 'start_date', 'gmach_month'],
    'HEADERS_WORKERS is append-only and position-mapped — the feed itself must not touch it');
});
