'use strict';

// Guards for the read-only getGuidesForCoordinators feed
// (apps-script/Code.gs) — the coordinators app's guide roster sync — and
// for the `phone` column appended to HEADERS_WORKERS that feeds it.
//
// Like tests/therapists-endpoint.test.js, the Apps Script backend has no JS
// harness, so we (1) evaluate Code.gs in a vm sandbox with the GAS services
// mocked and drive doGet end-to-end for the auth behaviour, (2) exercise the
// pure builder computeGuidesForCoordinators_ with overridden readers for the
// field filtering, and (3) drive createWorker / updateWorker /
// readWorkersSafe against an in-memory sheet for the phone round-trip.
//
// The hard rules pinned here:
//   - FIELD FILTERING: the feed carries name / phone / active / houses /
//     startDate and NOTHING else — no salary, cost, rate, pct, allowance,
//     retainer, notes, shift_commitment, gmach_month, role_detail, id.
//   - ONE ENTRY PER WORKER: a guide at two houses is one person with both
//     house ids; active is true iff ANY current guide placement is active.
//   - ROLE FILTER: trimmed role === 'מדריך/ה' only.
//   - TERMINATED GUIDES (ArchiveV3) ARE PUBLISHED with active:false so the
//     consumer can retire them; chld / chlt / final_settlement → false.
//   - PHONE IS TEXT: 10 digits with the leading zero, '' when not entered;
//     a number-coerced cell gets its leading zero back on read.
//   - FAIL-CLOSED AUTH: missing COORDINATORS_READ_SECRET property, missing
//     secret, wrong secret, or any OTHER surface's secret → 401 error, never
//     data — and the coordinators secret unlocks nothing else.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const GS_PATH = path.join(ROOT, 'apps-script', 'Code.gs');
const gs = fs.readFileSync(GS_PATH, 'utf8');

// Evaluate Code.gs in a sandbox with the GAS surface the feed + worker
// paths touch mocked out. `props` seeds the Script Properties store.
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
    LockService: {
      getScriptLock() { return { waitLock() {}, releaseLock() {} }; },
    },
    Utilities: { formatDate(d) { return d.toISOString().slice(0, 10); } },
    Session: { getScriptTimeZone() { return 'UTC'; } },
  });
  vm.runInContext(gs, ctx);
  return ctx;
}

// A ContentService TextOutput mock → the parsed JSON body.
function out(o) { return JSON.parse(o._text); }

function plain(v) { return JSON.parse(JSON.stringify(v)); }

const FINANCIAL_WORDS = ['salary', 'cost', 'rate', 'budget', 'retainer', 'allowance', 'pct', 'amount'];

// Roster fixture:
//   w1 guide (מדריך/ה) at TWO houses, both active, EVERY financial field
//      populated with sentinel values, phone set → one entry, both houses,
//      active, phone passed through.
//   w2 whitespace-padded ' מדריך/ה ' role → still included.
//   w3 guide whose only placement is on חל"ד (chld) → active:false.
//   w4 guide with one active + one chld placement → active:true.
//   w5 therapist (מטפל/ת), w6 house manager (מנהל/ת), w7 cook (טבח/ית),
//      w8 role אחר → all excluded.
//   w9 blank name guide → skipped.
//   w10 TERMINATED guide: lives ONLY in ArchiveV3 (two archived houses) →
//      published with active:false and the archived houses.
//   w11 guide with a current active placement at rehab AND an archived one
//      at ramot → active:true, houses = ['rehab'] only.
//   w12 guide with an empty startDate and no phone → '' passthrough for both.
//   w13 guide on חל"ת (chlt), w14 on גמ"ח (final_settlement) → active:false.
//   w15 phone stored by Sheets as a NUMBER (leading zero lost) — readers
//      restore it; here the reader already did (fixture holds the text).
//   'ghost' orphaned assignment (no worker) → skipped.
function seedReaders(ctx) {
  ctx.readWorkersSafe = () => [
    { id: 'w1', name: ' אורית מזרחי ', notes: 'סודי', startDate: '2024-01-02', shift_commitment: '4+1', gmachMonth: '', phone: '0501234567' },
    { id: 'w2', name: 'בני לב', notes: '', startDate: '2024-02-03', phone: '0521111111' },
    { id: 'w3', name: 'גדי רם', notes: '', startDate: '2024-03-04', phone: '' },
    { id: 'w4', name: 'דוד קם', notes: '', startDate: '2024-04-06', phone: '' },
    { id: 'w5', name: 'הדס און', notes: '', startDate: '2024-06-07', phone: '0533333333' },
    { id: 'w6', name: 'ורד סתיו', notes: '', startDate: '2024-07-08', phone: '' },
    { id: 'w7', name: 'זיו הר', notes: '', startDate: '2024-08-09', phone: '' },
    { id: 'w8', name: 'חן ים', notes: '', startDate: '2024-09-10', phone: '' },
    { id: 'w9', name: '   ', notes: '', startDate: '2024-11-12', phone: '' },
    { id: 'w10', name: 'יעל דן', notes: '', startDate: '2024-12-13', phone: '0544444444' },
    { id: 'w11', name: 'כרם זיו', notes: '', startDate: '2025-01-01', phone: '' },
    { id: 'w12', name: 'לאה בר', notes: '', startDate: '', phone: '' },
    { id: 'w13', name: 'מור גל', notes: '', startDate: '2026-01-14', phone: '' },
    { id: 'w14', name: 'נועה צח', notes: '', startDate: '2026-02-16', phone: '' },
  ];
  ctx.readAssignmentsSafe = () => [
    { id: 'a1', workerId: 'w1', house: 'ramot', role: 'מדריך/ה', roleDetail: 'בכיר',
      employmentType: 'full_time', salary: 99999, pct: 47, hourlyRate: 777, estHours: 111,
      sessionRate: 444, estSessions: 22, retainerAmount: 5678, allowance: 6000,
      rateIndividual: 333, sessionsIndividual: 8, rateGroup: 222, sessionsGroup: 9,
      rateExternal: 666, externalPatients: 7, status: 'active', notes: 'תנאים' },
    { id: 'a2', workerId: 'w1', house: 'asher', role: 'מדריך/ה', status: 'active', salary: 99999 },
    { id: 'a3', workerId: 'w2', house: 'ofroni', role: ' מדריך/ה ', status: 'active' },
    { id: 'a4', workerId: 'w3', house: 'ramot', role: 'מדריך/ה', status: 'chld', statusDate: '2026-07-20' },
    { id: 'a5', workerId: 'w4', house: 'ramot', role: 'מדריך/ה', status: 'chld' },
    { id: 'a6', workerId: 'w4', house: 'rehab', role: 'מדריך/ה', status: 'active' },
    { id: 'a7', workerId: 'w5', house: 'ramot', role: 'מטפל/ת', status: 'active' },
    { id: 'a8', workerId: 'w6', house: 'asher', role: 'מנהל/ת', status: 'active', salary: 99999 },
    { id: 'a9', workerId: 'w7', house: 'ramot', role: 'טבח/ית', status: 'active' },
    { id: 'a10', workerId: 'w8', house: 'rehab', role: 'אחר', status: 'active' },
    { id: 'a11', workerId: 'w9', house: 'ramot', role: 'מדריך/ה', status: 'active' },
    { id: 'a12', workerId: 'ghost', house: 'ramot', role: 'מדריך/ה', status: 'active' },
    { id: 'a13', workerId: 'w11', house: 'rehab', role: 'מדריך/ה', status: 'active' },
    { id: 'a14', workerId: 'w12', house: 'pardes', role: 'מדריך/ה', status: 'active' },
    { id: 'a15', workerId: 'w13', house: 'ofroni', role: 'מדריך/ה', status: 'chlt' },
    { id: 'a16', workerId: 'w14', house: 'rehab', role: 'מדריך/ה', status: 'final_settlement' },
  ];
  ctx.readArchiveV3Safe = () => [
    { id: 'ar1', assignmentId: 'a90', workerId: 'w10', name: 'יעל דן', house: 'ramot',
      role: 'מדריך/ה', terminationDate: '2026-06-30', reasonType: 'התפטרות', salary: 99999 },
    { id: 'ar2', assignmentId: 'a91', workerId: 'w10', name: 'יעל דן', house: 'asher',
      role: 'מדריך/ה', terminationDate: '2026-06-30', salary: 99999 },
    { id: 'ar3', assignmentId: 'a92', workerId: 'w11', name: 'כרם זיו', house: 'ramot',
      role: 'מדריך/ה', terminationDate: '2025-12-31', salary: 99999 },
    // A terminated THERAPIST placement never enters the guide feed.
    { id: 'ar4', assignmentId: 'a93', workerId: 'w5', name: 'הדס און', house: 'rehab',
      role: 'מטפל/ת', terminationDate: '2025-01-01', salary: 99999 },
  ];
}

function feed(ctx) { return plain(ctx.computeGuidesForCoordinators_()); }

function byName(ctx) {
  const m = {};
  feed(ctx).forEach(g => { m[g.name] = g; });
  return m;
}

// ---------------------------------------------------------------------------
// Field filtering
// ---------------------------------------------------------------------------

test('computeGuidesForCoordinators_ emits ONLY name/phone/active/houses/startDate', () => {
  const ctx = loadCtx();
  seedReaders(ctx);
  const rows = feed(ctx);
  assert.ok(rows.length > 0, 'fixture should yield entries');
  rows.forEach(g => {
    assert.deepStrictEqual(Object.keys(g).sort(), ['active', 'houses', 'name', 'phone', 'startDate']);
    assert.strictEqual(typeof g.name, 'string');
    assert.strictEqual(typeof g.phone, 'string');
    assert.strictEqual(typeof g.active, 'boolean');
    assert.ok(Array.isArray(g.houses));
    assert.strictEqual(typeof g.startDate, 'string');
  });
});

test('salary and every other stripped field is ABSENT from the feed (keys AND sentinel values)', () => {
  const ctx = loadCtx();
  seedReaders(ctx);
  const text = JSON.stringify(feed(ctx));
  ['salary', 'pct', 'hourlyRate', 'estHours', 'sessionRate', 'estSessions', 'retainerAmount',
    'allowance', 'rateIndividual', 'rateGroup', 'rateExternal', 'notes', 'roleDetail', 'role_detail',
    'employmentType', 'shift_commitment', 'gmachMonth', 'gmach_month', 'workerId', 'terminationDate',
    'reasonType', '"id"'].forEach(k => {
    assert.ok(!text.includes(k), `${k} must not leave the feed`);
  });
  ['99999', '5678', '6000', '777', '4+1', 'סודי', 'תנאים', 'בכיר', 'התפטרות'].forEach(v => {
    assert.ok(!text.includes(v), `sentinel ${v} must not leave the feed`);
  });
});

// ---------------------------------------------------------------------------
// Role filter + aggregation
// ---------------------------------------------------------------------------

test('feed includes מדריך/ה only; therapist / manager / cook / אחר are excluded', () => {
  const ctx = loadCtx();
  seedReaders(ctx);
  const names = feed(ctx).map(g => g.name);
  ['אורית מזרחי', 'בני לב', 'גדי רם', 'דוד קם', 'יעל דן', 'כרם זיו', 'לאה בר', 'מור גל', 'נועה צח'].forEach(n => {
    assert.ok(names.includes(n), `${n} should be in the feed`);
  });
  ['הדס און', 'ורד סתיו', 'זיו הר', 'חן ים'].forEach(n => {
    assert.ok(!names.includes(n), `${n} must not be in the feed`);
  });
  assert.strictEqual(names.length, 9);
});

test('a whitespace-padded role string still matches (trimmed compare)', () => {
  const ctx = loadCtx();
  seedReaders(ctx);
  assert.ok(byName(ctx)['בני לב']);
});

test('a guide at two houses is ONE entry with both house ids (sorted), name trimmed', () => {
  const ctx = loadCtx();
  seedReaders(ctx);
  const g = byName(ctx)['אורית מזרחי'];
  assert.ok(g, 'name is trimmed');
  assert.deepStrictEqual(g.houses, ['asher', 'ramot']);
  assert.strictEqual(g.active, true);
  assert.strictEqual(g.phone, '0501234567');
  assert.strictEqual(g.startDate, '2024-01-02');
  assert.strictEqual(feed(ctx).filter(x => x.name === 'אורית מזרחי').length, 1);
});

test('chld / chlt / final_settlement on the only placement → active:false; mixed → true', () => {
  const ctx = loadCtx();
  seedReaders(ctx);
  const m = byName(ctx);
  assert.strictEqual(m['גדי רם'].active, false, 'chld');
  assert.strictEqual(m['מור גל'].active, false, 'chlt');
  assert.strictEqual(m['נועה צח'].active, false, 'final_settlement');
  assert.strictEqual(m['דוד קם'].active, true, 'one active + one chld');
  assert.deepStrictEqual(m['דוד קם'].houses, ['ramot', 'rehab']);
});

test('a blank stored status reads as active (normalizeStatus)', () => {
  const ctx = loadCtx();
  ctx.readWorkersSafe = () => [{ id: 'w1', name: 'א', startDate: '', phone: '' }];
  ctx.readAssignmentsSafe = () => [{ id: 'a1', workerId: 'w1', house: 'ramot', role: 'מדריך/ה', status: '' }];
  ctx.readArchiveV3Safe = () => [];
  assert.strictEqual(feed(ctx)[0].active, true);
});

test('a TERMINATED guide (ArchiveV3 only) IS published with active:false and the archived houses', () => {
  const ctx = loadCtx();
  seedReaders(ctx);
  const g = byName(ctx)['יעל דן'];
  assert.ok(g, 'terminated guides are published so the consumer can retire them');
  assert.strictEqual(g.active, false);
  assert.deepStrictEqual(g.houses, ['asher', 'ramot']);
  assert.strictEqual(g.phone, '0544444444');
});

test('a current placement wins over an archived one: current status + current houses only', () => {
  const ctx = loadCtx();
  seedReaders(ctx);
  const g = byName(ctx)['כרם זיו'];
  assert.strictEqual(g.active, true);
  assert.deepStrictEqual(g.houses, ['rehab']);
});

test('a terminated therapist placement never enters the guide feed', () => {
  const ctx = loadCtx();
  seedReaders(ctx);
  assert.ok(!byName(ctx)['הדס און']);
});

test('orphaned assignment skipped, blank name skipped, empty startDate / phone pass through', () => {
  const ctx = loadCtx();
  seedReaders(ctx);
  const rows = feed(ctx);
  assert.ok(!rows.some(g => g.name.trim() === ''), 'blank name skipped');
  assert.strictEqual(rows.length, 9, 'orphan (ghost) skipped');
  const g = byName(ctx)['לאה בר'];
  assert.strictEqual(g.startDate, '');
  assert.strictEqual(g.phone, '');
  assert.deepStrictEqual(g.houses, ['pardes']);
});

test('entries are sorted by name', () => {
  const ctx = loadCtx();
  seedReaders(ctx);
  const names = feed(ctx).map(g => g.name);
  assert.deepStrictEqual(names, names.slice().sort((a, b) => a.localeCompare(b)));
});

// ---------------------------------------------------------------------------
// Fail-closed auth (end-to-end through doGet)
// ---------------------------------------------------------------------------

function callFeed(ctx, secret) {
  const e = { parameter: { action: 'getGuidesForCoordinators' } };
  if (secret !== undefined) e.parameter.secret = secret;
  return out(ctx.doGet(e));
}

const OTHER_PROPS = {
  SHARED_SECRET: 'main-secret',
  HADRACHOT_READ_SECRET: 'hadr-secret',
  THERAPISTS_READ_SECRET: 'ther-secret',
};

test('COORDINATORS_READ_SECRET unset → 401 error, never data, nothing read (fail-closed)', () => {
  const ctx = loadCtx(OTHER_PROPS);
  ctx.readWorkersSafe = () => { throw new Error('must not read workers'); };
  ctx.readAssignmentsSafe = () => { throw new Error('must not read assignments'); };
  ctx.readArchiveV3Safe = () => { throw new Error('must not read archive'); };
  const body = callFeed(ctx, 'anything');
  assert.strictEqual(body._status, 401);
  assert.strictEqual(body.error, 'unauthorized');
  assert.ok(!('guides' in body), 'no data key on an unauthorized response');
});

test('missing/empty/wrong/foreign secret → 401, correct secret → the guides payload', () => {
  const ctx = loadCtx(Object.assign({ COORDINATORS_READ_SECRET: 'coord-secret' }, OTHER_PROPS));
  seedReaders(ctx);
  for (const s of [undefined, '', 'wrong-secret', 'main-secret', 'hadr-secret', 'ther-secret']) {
    const b = callFeed(ctx, s);
    assert.strictEqual(b._status, 401, String(s));
    assert.ok(!('guides' in b), 'no guides key without the right secret');
  }
  const ok = callFeed(ctx, 'coord-secret');
  assert.strictEqual(ok._status, 200);
  assert.ok(Array.isArray(ok.guides) && ok.guides.length === 9);
});

test('COORDINATORS_READ_SECRET unlocks neither the roster doGet nor the other two feeds', () => {
  const ctx = loadCtx(Object.assign({ COORDINATORS_READ_SECRET: 'coord-secret' }, OTHER_PROPS));
  seedReaders(ctx);
  const roster = out(ctx.doGet({ parameter: { secret: 'coord-secret' } }));
  assert.strictEqual(roster._status, 401);
  assert.ok(!('workers' in roster) && !('assignments' in roster));
  const hadr = out(ctx.doGet({ parameter: { action: 'getGuidesForHadrachot', secret: 'coord-secret' } }));
  assert.strictEqual(hadr._status, 401);
  assert.ok(!('guides' in hadr));
  const ther = out(ctx.doGet({ parameter: { action: 'getTherapistsForTherapists', secret: 'coord-secret' } }));
  assert.strictEqual(ther._status, 401);
  assert.ok(!('therapists' in ther));
});

// ---------------------------------------------------------------------------
// Worker phone round-trip (createWorker / updateWorker / readWorkersSafe)
// ---------------------------------------------------------------------------

// Minimal in-memory sheet: rows[0] is the header row. Enough surface for
// createWorker / updateWorker / readWorkersSafe / findRow / ensureHeaders.
function fakeSheet(rows) {
  const formats = {};
  const sh = {
    rows,
    formats,
    getDataRange() { return { getValues: () => rows.map(r => r.slice()) }; },
    getLastRow() { return rows.length; },
    getLastColumn() { return rows.reduce((m, r) => Math.max(m, r.length), 0); },
    setFrozenRows() {},
    appendRow(r) { rows.push(r.slice()); },
    getRange(r, c, nr, nc) {
      const range = {
        getValue() { return (rows[r - 1] || [])[c - 1]; },
        getValues() {
          const outRows = [];
          for (let i = 0; i < (nr || 1); i++) {
            const row = rows[r - 1 + i] || [];
            const v = [];
            for (let j = 0; j < (nc || 1); j++) v.push(row[c - 1 + j] === undefined ? '' : row[c - 1 + j]);
            outRows.push(v);
          }
          return outRows;
        },
        setValue(v) { while (rows.length < r) rows.push([]); rows[r - 1][c - 1] = v; return range; },
        setValues(vals) {
          vals.forEach((row, i) => { while (rows.length < r + i) rows.push([]); row.forEach((v, j) => { rows[r - 1 + i][c - 1 + j] = v; }); });
          return range;
        },
        setNumberFormat(f) { formats[r + ':' + c] = f; return range; },
      };
      return range;
    },
  };
  return sh;
}

const HEADERS = ['id', 'name', 'notes', 'created_at', 'shift_commitment', 'start_date', 'gmach_month', 'phone'];

test('createWorker persists phone in column 8 as TEXT (number format "@") and echoes it', () => {
  const ctx = loadCtx();
  const sh = fakeSheet([HEADERS.slice()]);
  ctx.sheetByName = () => sh;
  const res = plain(ctx.createWorker({ worker: { name: 'רון', phone: '050-123-4567' } }));
  assert.strictEqual(res.worker.phone, '0501234567');
  const row = sh.rows[1];
  assert.strictEqual(row[7], '0501234567', 'phone lands in the appended 8th column');
  assert.strictEqual(sh.formats['2:8'], '@', 'text format forced so the leading zero survives');
});

test('createWorker without a phone writes a blank cell and no format', () => {
  const ctx = loadCtx();
  const sh = fakeSheet([HEADERS.slice()]);
  ctx.sheetByName = () => sh;
  const res = plain(ctx.createWorker({ worker: { name: 'רון' } }));
  assert.strictEqual(res.worker.phone, '');
  assert.strictEqual(sh.rows[1][7], '');
  assert.strictEqual(sh.formats['2:8'], undefined);
});

test('updateWorker: phone key present → written (text format); absent → stored value untouched and echoed', () => {
  const ctx = loadCtx();
  // Legacy sheet: header row still 7 columns wide, data row without a phone.
  const sh = fakeSheet([HEADERS.slice(0, 7), ['w1', 'רון', '', '2025-01-01T00:00:00Z', '', '2025-01-01', '']]);
  ctx.sheetByName = () => sh;
  const r1 = plain(ctx.updateWorker({ id: 'w1', worker: { name: 'רון', phone: '0521111111' } }));
  assert.strictEqual(r1.worker.phone, '0521111111');
  assert.strictEqual(sh.rows[1][7], '0521111111');
  assert.strictEqual(sh.formats['2:8'], '@');
  assert.strictEqual(sh.rows[0][7], 'phone', 'ensureHeaders labels the appended column');
  // Older client that never sends phone must not wipe it.
  const r2 = plain(ctx.updateWorker({ id: 'w1', worker: { name: 'רון' } }));
  assert.strictEqual(r2.worker.phone, '0521111111');
  assert.strictEqual(sh.rows[1][7], '0521111111');
  // Explicit '' clears it.
  const r3 = plain(ctx.updateWorker({ id: 'w1', worker: { name: 'רון', phone: '' } }));
  assert.strictEqual(r3.worker.phone, '');
  assert.strictEqual(sh.rows[1][7], '');
});

test('updateWorker / createWorker reject a malformed phone before any write', () => {
  const ctx = loadCtx();
  const sh = fakeSheet([HEADERS.slice(), ['w1', 'רון', '', '', '', '', '', '']]);
  ctx.sheetByName = () => sh;
  ['501234567', '+972501234567', '05012345678', 'abc'].forEach(v => {
    assert.throws(() => ctx.updateWorker({ id: 'w1', worker: { name: 'רון', phone: v } }), /bad phone/, v);
    assert.throws(() => ctx.createWorker({ worker: { name: 'רון', phone: v } }), /bad phone/, v);
  });
  assert.strictEqual(sh.rows.length, 2, 'nothing appended');
  assert.strictEqual(sh.rows[1][7], '', 'nothing written');
});

test('readWorkersSafe reads phone from column 8 and restores a leading zero Sheets stripped', () => {
  const ctx = loadCtx();
  const sh = fakeSheet([HEADERS.slice(),
    ['w1', 'רון', '', '', '', '', '', '0501234567'],
    ['w2', 'דנה', '', '', '', '', '', 501234567],        // coerced to a number by Sheets
    ['w3', 'גיל', '', '', '', '', '', '501234567'],      // 9-digit text (zero lost upstream)
    ['w4', 'ליה', '', '', '', '', '']]);                 // legacy row, no 8th cell
  ctx.sheetByNameOrNull = () => sh;
  const m = {};
  plain(ctx.readWorkersSafe()).forEach(w => { m[w.id] = w; });
  assert.strictEqual(m.w1.phone, '0501234567');
  assert.strictEqual(m.w2.phone, '0501234567');
  assert.strictEqual(m.w3.phone, '0501234567');
  assert.strictEqual(m.w4.phone, '');
  Object.values(m).forEach(w => assert.strictEqual(typeof w.phone, 'string'));
});

// ---------------------------------------------------------------------------
// Source guards
// ---------------------------------------------------------------------------

function parseStringArray(name) {
  const m = new RegExp('const ' + name + ' = \\[([^\\]]*)\\]').exec(gs);
  assert.ok(m, `const ${name} should be declared`);
  const outArr = [];
  const re = /'((?:[^'\\]|\\.)*)'/g;
  let s;
  while ((s = re.exec(m[1])) !== null) outArr.push(s[1]);
  return outArr;
}

test('COORDINATORS_FEED_ROLE is a byte-exact ROLE_OPTIONS entry (catches a role rename)', () => {
  const roles = parseStringArray('ROLE_OPTIONS');
  const m = /const COORDINATORS_FEED_ROLE = '([^']+)'/.exec(gs);
  assert.ok(m, 'COORDINATORS_FEED_ROLE should be declared');
  assert.ok(roles.includes(m[1]), `${m[1]} must be a ROLE_OPTIONS entry`);
  assert.strictEqual(m[1], 'מדריך/ה');
});

test('computeGuidesForCoordinators_ source contains no financial word', () => {
  const m = /function computeGuidesForCoordinators_\(\) \{[\s\S]*?\n\}/.exec(gs);
  assert.ok(m, 'builder should be present');
  FINANCIAL_WORDS.forEach(w => {
    assert.ok(!new RegExp(w, 'i').test(m[0]), `builder must never mention ${w}`);
  });
});

test('the feed authorizes via its own property through the constant-time comparator', () => {
  const m = /function coordinatorsAuthorized_\(e\) \{[\s\S]*?\n\}/.exec(gs);
  assert.ok(m);
  const fn = m[0];
  assert.ok(/COORDINATORS_READ_SECRET_PROP/.test(fn));
  assert.ok(/secretMatches_\(/.test(fn), 'must use the shared constant-time comparator');
  assert.ok(!/SHARED_SECRET/.test(fn) && !/HADRACHOT/.test(fn) && !/THERAPISTS/.test(fn),
    'never consults another surface\'s secret');
  assert.ok(/case 'getGuidesForCoordinators'/.test(gs) === false, 'GET-only: never a doPost case');
});

test('HEADERS_WORKERS: phone is APPENDED LAST — every earlier column keeps its index', () => {
  assert.deepStrictEqual(parseStringArray('HEADERS_WORKERS'), HEADERS);
  assert.ok(/phone: formatPhoneCell\(r\[7\]\)/.test(gs), 'readWorkersSafe reads index 7 as phone');
});
