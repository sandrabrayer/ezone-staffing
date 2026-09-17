'use strict';

// Phase 3 — the additive feed fields and the per-consumer feed log.
//
// Two contracts meet here:
//   1. The feeds are FROZEN: fields may be added, never removed or renamed,
//      and no financial field may ever appear. The additions are workerId +
//      assignmentId(s) + feedGeneratedAt.
//   2. The feed log gives staffing failure visibility it did not have — but
//      it makes a read-only endpoint write, so the write must be impossible
//      before authorization, must never queue behind a lock, and must never
//      break a consumer's sync.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const gs = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');

function fakeSheet(rows) {
  const sh = {
    rows,
    getDataRange() { return { getValues: () => rows.map(r => r.slice()) }; },
    getLastRow() { return rows.length; },
    getLastColumn() { return rows.reduce((m, r) => Math.max(m, r.length), 0); },
    setFrozenRows() {},
    appendRow(r) { rows.push(r.slice()); },
    deleteRow(r) { rows.splice(r - 1, 1); },
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

const FEED_LOG_HEADERS = ['consumer', 'last_served_at', 'last_row_count', 'serve_count', 'status'];

// `lockBehaviour` lets a test simulate a busy lock.
function loadCtx(props, seed, lockBehaviour) {
  const store = Object.assign({ SHEET_ID: 'sheet-1' }, props);
  const tabs = {};
  Object.keys(seed || {}).forEach(k => { tabs[k] = fakeSheet(seed[k].map(r => r.slice())); });
  const lockCalls = [];
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
      getScriptLock() {
        return {
          waitLock() { lockCalls.push('waitLock'); },
          tryLock(ms) {
            lockCalls.push('tryLock:' + ms);
            return lockBehaviour === 'busy' ? false : true;
          },
          releaseLock() {},
        };
      },
    },
    Utilities: {
      formatDate(d, tz, fmt) {
        const iso = d.toISOString();
        return fmt === 'yyyy-MM-dd' ? iso.slice(0, 10) : iso;
      },
    },
    Session: { getScriptTimeZone() { return 'UTC'; } },
    SpreadsheetApp: {
      openById() {
        return {
          getSheetByName(name) { return tabs[name] || null; },
          insertSheet(name) { tabs[name] = fakeSheet([]); return tabs[name]; },
        };
      },
    },
  });
  vm.runInContext(gs, ctx);
  ctx.tabs = tabs;
  ctx.lockCalls = lockCalls;
  return ctx;
}

function out(o) { return JSON.parse(o._text); }
function plain(v) { return JSON.parse(JSON.stringify(v)); }
function constOf(ctx, name) { return plain(vm.runInContext(name, ctx)); }

// Roster fixture with every financial field populated, so a leak would show.
function seedRoster(ctx) {
  ctx.readWorkersSafe = () => [
    { id: 'w1', name: 'מדריכה בשני בתים', phone: '0501111111', startDate: '2024-01-01', notes: 'סודי' },
    { id: 'w2', name: 'מטפלת', phone: '0502222222', startDate: '2024-02-01' },
    { id: 'w3', name: 'מדריך שעזב', phone: '0503333333', startDate: '2024-03-01' },
  ];
  ctx.readAssignmentsSafe = () => [
    { id: 'a1', workerId: 'w1', house: 'ramot', role: 'מדריך/ה', status: 'active',
      employmentType: 'full_time', salary: 99999, pct: 50, hourlyRate: 80, estHours: 100,
      sessionRate: 400, estSessions: 10, retainerAmount: 5000, allowance: 6000, notes: 'תנאים' },
    { id: 'a2', workerId: 'w1', house: 'asher', role: 'מדריך/ה', status: 'active', salary: 88888 },
    { id: 'a3', workerId: 'w2', house: 'pardes', role: 'מטפל/ת', status: 'active', salary: 77777 },
  ];
  ctx.readArchiveV3Safe = () => [
    { id: 'arc1', assignmentId: 'a9', workerId: 'w3', house: 'rehab', role: 'מדריך/ה',
      terminationDate: '2026-08-31', salary: 66666 },
  ];
}

// ---------------------------------------------------------------------------
// additive fields
// ---------------------------------------------------------------------------

test('the coordinators feed adds workerId and assignmentIds, keeping all five originals', () => {
  const ctx = loadCtx({}, { workers: [[]] });
  seedRoster(ctx);
  const guides = plain(ctx.computeGuidesForCoordinators_());
  const byName = {};
  guides.forEach(g => { byName[g.name] = g; });

  const two = byName['מדריכה בשני בתים'];
  assert.deepStrictEqual(Object.keys(two).sort(),
    ['active', 'assignmentIds', 'houses', 'name', 'phone', 'startDate', 'workerId']);
  assert.strictEqual(two.workerId, 'w1');
  assert.deepStrictEqual(two.assignmentIds, ['a1', 'a2'],
    'one entry per WORKER, so the ids are a sorted list — a scalar would be a lie here');
  assert.deepStrictEqual(two.houses, ['asher', 'ramot']);
  assert.strictEqual(two.assignmentIds.length, two.houses.length,
    'the two arrays must describe the same placements');
  // The five original fields are untouched.
  assert.strictEqual(two.phone, '0501111111');
  assert.strictEqual(two.active, true);
  assert.strictEqual(two.startDate, '2024-01-01');
});

test('an archived-only guide carries the ORIGINAL placement id, so it can be retired', () => {
  const ctx = loadCtx({}, { workers: [[]] });
  seedRoster(ctx);
  const gone = plain(ctx.computeGuidesForCoordinators_())
    .find(g => g.name === 'מדריך שעזב');
  assert.ok(gone);
  assert.strictEqual(gone.active, false);
  assert.strictEqual(gone.workerId, 'w3');
  assert.deepStrictEqual(gone.assignmentIds, ['a9'],
    'the archive row keeps the id the consumer stored while they were current');
  assert.deepStrictEqual(gone.houses, ['rehab']);
});

test('the therapists feed adds workerId and assignmentIds', () => {
  const ctx = loadCtx({}, { workers: [[]] });
  seedRoster(ctx);
  const t = plain(ctx.computeTherapistsFeed_())[0];
  assert.deepStrictEqual(Object.keys(t).sort(),
    ['active', 'assignmentIds', 'houses', 'name', 'startDate', 'workerId']);
  assert.strictEqual(t.workerId, 'w2');
  assert.deepStrictEqual(t.assignmentIds, ['a3']);
});

test('the hadrachot feed adds SCALAR workerId and assignmentId — it is per placement', () => {
  const ctx = loadCtx({}, { workers: [[]] });
  seedRoster(ctx);
  const guides = plain(ctx.computeGuidesForHadrachot_());
  guides.forEach(g => {
    assert.deepStrictEqual(Object.keys(g).sort(),
      ['active', 'assignmentId', 'house', 'name', 'role', 'startDate', 'workerId']);
    assert.ok(g.workerId && g.assignmentId);
  });
  // The two-house guide appears TWICE here, once per placement, each with its
  // own assignmentId — which is exactly why this feed gets scalars.
  const both = guides.filter(g => g.workerId === 'w1');
  assert.strictEqual(both.length, 2);
  assert.deepStrictEqual(both.map(g => g.assignmentId).sort(), ['a1', 'a2']);
});

test('adding ids leaked no financial field into any feed', () => {
  const ctx = loadCtx({}, { workers: [[]] });
  seedRoster(ctx);
  const texts = [
    JSON.stringify(plain(ctx.computeGuidesForCoordinators_())),
    JSON.stringify(plain(ctx.computeTherapistsFeed_())),
    JSON.stringify(plain(ctx.computeGuidesForHadrachot_())),
  ];
  texts.forEach(flat => {
    ['salary', 'hourlyRate', 'sessionRate', 'retainerAmount', 'allowance', 'pct',
      'employmentType', 'notes', 'roleDetail'].forEach(k => {
      assert.ok(!flat.includes(k), k + ' must never appear in a feed');
    });
    ['99999', '88888', '77777', '66666', '5000', '6000', 'סודי', 'תנאים'].forEach(v => {
      assert.ok(!flat.includes(v), 'value ' + v + ' must never appear in a feed');
    });
  });
});

// ---------------------------------------------------------------------------
// feedGeneratedAt
// ---------------------------------------------------------------------------

test('every feed response carries feedGeneratedAt at the TOP level', () => {
  const secrets = {
    COORDINATORS_READ_SECRET: 'c-secret',
    THERAPISTS_READ_SECRET: 't-secret',
    HADRACHOT_READ_SECRET: 'h-secret',
  };
  const cases = [
    ['getGuidesForCoordinators', 'c-secret', 'guides'],
    ['getTherapistsForTherapists', 't-secret', 'therapists'],
    ['getGuidesForHadrachot', 'h-secret', 'guides'],
  ];
  cases.forEach(([action, secret, key]) => {
    const ctx = loadCtx(secrets, { workers: [[]], feed_log: [FEED_LOG_HEADERS] });
    seedRoster(ctx);
    const body = out(ctx.doGet({ parameter: { action, secret } }));
    assert.strictEqual(body._status, 200, action);
    assert.ok(Array.isArray(body[key]), action + ' still returns its array under the same key');
    assert.match(body.feedGeneratedAt, /^\d{4}-\d{2}-\d{2}T/, action + ' carries a timestamp');
    // It is a property of the FEED, so it is NOT repeated on every entry.
    body[key].forEach(e => assert.ok(!('feedGeneratedAt' in e)));
  });
});

// ---------------------------------------------------------------------------
// feed log
// ---------------------------------------------------------------------------

test('serving a feed records the pull, once per consumer, upserted in place', () => {
  const ctx = loadCtx({ COORDINATORS_READ_SECRET: 'c-secret' },
    { workers: [[]], feed_log: [FEED_LOG_HEADERS] });
  seedRoster(ctx);

  ctx.doGet({ parameter: { action: 'getGuidesForCoordinators', secret: 'c-secret' } });
  let rows = ctx.tabs.feed_log.rows;
  assert.strictEqual(rows.length, 2, 'header plus one consumer row');
  assert.strictEqual(rows[1][0], 'coordinators');
  assert.strictEqual(rows[1][2], 2, 'two guides in the fixture — w1 and w3');
  assert.strictEqual(rows[1][3], 1, 'serve count');
  assert.strictEqual(rows[1][4], 'ok');

  ctx.doGet({ parameter: { action: 'getGuidesForCoordinators', secret: 'c-secret' } });
  rows = ctx.tabs.feed_log.rows;
  assert.strictEqual(rows.length, 2, 'STILL one row — not one row per pull');
  assert.strictEqual(rows[1][3], 2, 'the count went up instead');
});

test('each consumer gets its own row', () => {
  const ctx = loadCtx({
    COORDINATORS_READ_SECRET: 'c-secret',
    THERAPISTS_READ_SECRET: 't-secret',
  }, { workers: [[]], feed_log: [FEED_LOG_HEADERS] });
  seedRoster(ctx);
  ctx.doGet({ parameter: { action: 'getGuidesForCoordinators', secret: 'c-secret' } });
  ctx.doGet({ parameter: { action: 'getTherapistsForTherapists', secret: 't-secret' } });
  const names = ctx.tabs.feed_log.rows.slice(1).map(r => r[0]).sort();
  assert.deepStrictEqual(names, ['coordinators', 'therapists']);
});

test('an UNAUTHORIZED pull writes NOTHING — auth comes first', () => {
  const ctx = loadCtx({ COORDINATORS_READ_SECRET: 'c-secret' },
    { workers: [[]], feed_log: [FEED_LOG_HEADERS] });
  seedRoster(ctx);
  ['', 'wrong', 't-secret'].forEach(secret => {
    const body = out(ctx.doGet({ parameter: { action: 'getGuidesForCoordinators', secret } }));
    assert.strictEqual(body._status, 401);
  });
  assert.strictEqual(ctx.tabs.feed_log.rows.length, 1,
    'an unauthenticated caller must never be able to make us write');
});

test('the feed log takes the lock with tryLock and SKIPS when it is busy', () => {
  const ctx = loadCtx({ COORDINATORS_READ_SECRET: 'c-secret' },
    { workers: [[]], feed_log: [FEED_LOG_HEADERS] }, 'busy');
  seedRoster(ctx);
  const body = out(ctx.doGet({ parameter: { action: 'getGuidesForCoordinators', secret: 'c-secret' } }));

  assert.strictEqual(body._status, 200, 'the consumer is still served');
  assert.strictEqual(body.guides.length, 2, 'with its full payload');
  assert.strictEqual(ctx.tabs.feed_log.rows.length, 1, 'and the log was simply skipped');
  assert.ok(ctx.lockCalls.some(c => c.startsWith('tryLock:')),
    'tryLock, never waitLock — a feed pull must never queue behind a mutation');
  assert.ok(!ctx.lockCalls.includes('waitLock'));
});

test('a feed-log failure never breaks the feed', () => {
  const ctx = loadCtx({ COORDINATORS_READ_SECRET: 'c-secret' }, { workers: [[]] });
  seedRoster(ctx);
  ctx.feedLogSheet_ = () => { throw new Error('no access to the feed log'); };
  const body = out(ctx.doGet({ parameter: { action: 'getGuidesForCoordinators', secret: 'c-secret' } }));
  assert.strictEqual(body._status, 200);
  assert.strictEqual(body.guides.length, 2, 'a consumer sync must never fail because logging did');
});

test('recordFeedServed_ ignores a consumer it does not know', () => {
  const ctx = loadCtx({}, { workers: [[]], feed_log: [FEED_LOG_HEADERS] });
  ctx.recordFeedServed_('some-other-app', 5, 'ok');
  assert.strictEqual(ctx.tabs.feed_log.rows.length, 1, 'only the three real consumers are logged');
});

test('readFeedLogSafe tolerates a missing tab and reads back what was written', () => {
  const none = loadCtx({}, { workers: [[]] });
  assert.deepStrictEqual(plain(none.readFeedLogSafe()), [], 'nothing has pulled yet');

  const ctx = loadCtx({ COORDINATORS_READ_SECRET: 'c-secret' },
    { workers: [[]], feed_log: [FEED_LOG_HEADERS] });
  seedRoster(ctx);
  ctx.doGet({ parameter: { action: 'getGuidesForCoordinators', secret: 'c-secret' } });
  const log = plain(ctx.readFeedLogSafe());
  assert.strictEqual(log.length, 1);
  assert.strictEqual(log[0].consumer, 'coordinators');
  assert.strictEqual(log[0].lastRowCount, 2);
  assert.strictEqual(log[0].serveCount, 1);
  assert.strictEqual(log[0].status, 'ok');
  assert.match(log[0].lastServedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('the feed_log headers are append-only and the consumer list is frozen', () => {
  const ctx = loadCtx({}, { workers: [[]] });
  assert.deepStrictEqual(constOf(ctx, 'HEADERS_FEED_LOG'), FEED_LOG_HEADERS);
  assert.deepStrictEqual(constOf(ctx, 'FEED_CONSUMERS'),
    ['coordinators', 'therapists', 'hadrachot']);
});

test('the main doGet payload carries feedLog for the sync-status panel', () => {
  const ctx = loadCtx({ SHARED_SECRET: 'main-secret' }, {
    workers: [[]],
    feed_log: [FEED_LOG_HEADERS,
      ['coordinators', '2026-09-17T08:00:00.000Z', 42, 7, 'ok']],
  });
  const body = out(ctx.doGet({ parameter: { secret: 'main-secret' } }));
  assert.strictEqual(body._status, 200);
  assert.strictEqual(body.feedLog.length, 1);
  assert.strictEqual(body.feedLog[0].consumer, 'coordinators');
  assert.strictEqual(body.feedLog[0].lastRowCount, 42);
});

test('the feed log is not reachable without the main secret either', () => {
  const ctx = loadCtx({ SHARED_SECRET: 'main-secret' }, {
    workers: [[]], feed_log: [FEED_LOG_HEADERS, ['coordinators', '2026-09-17T08:00:00.000Z', 42, 7, 'ok']],
  });
  const body = out(ctx.doGet({ parameter: { secret: 'nope' } }));
  assert.strictEqual(body._status, 401);
  assert.ok(!('feedLog' in body));
});
