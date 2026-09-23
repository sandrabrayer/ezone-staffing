'use strict';

// Perf — the Apps Script side of the page load (apps-script/Code.gs).
//
// Pinned here:
//   - CONTRACT: getInitialBundle_ (what doGet returns) carries exactly what
//     the separate readers return — same keys, same values — so the bundle
//     and the per-tab reads can never drift apart.
//   - ONE SPREADSHEET OPEN per execution (ss() memo), one getDataRange read
//     per tab.
//   - CacheService: a second read is served from the cache without touching
//     the Sheet; every doPost invalidates (before and after the write), and a
//     read that raced a write can never resurrect the pre-write copy; feedLog
//     is never cached; a bundle bigger than one 100 KB cache value is chunked
//     and survives Hebrew + surrogate pairs; no CacheService → plain reads.
//   - FAIL-CLOSED: an unauthorized doGet reads nothing and caches nothing.
//   - GUARD: sheet header arrays are append-only against the snapshot below.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const gs = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
const SECRET = 'bundle-test-secret-0123456789';

function fakeSheet(rows, counters) {
  const sh = {
    rows,
    getDataRange() {
      counters.dataRange++;
      return { getValues: () => rows.map(r => r.slice()) };
    },
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

// In-memory CacheService.getScriptCache() with the 100 KB value cap.
function fakeCache() {
  const store = new Map();
  const calls = { get: 0, getAll: 0, put: 0, putAll: 0 };
  const cap = (k, v) => {
    if (Buffer.byteLength(String(v), 'utf8') > 100 * 1024) throw new Error('Argument too large: ' + k);
  };
  return {
    store, calls,
    get(k) { calls.get++; return store.has(k) ? store.get(k) : null; },
    getAll(keys) { calls.getAll++; const o = {}; keys.forEach(k => { if (store.has(k)) o[k] = store.get(k); }); return o; },
    put(k, v) { calls.put++; cap(k, v); store.set(k, String(v)); },
    putAll(map) { calls.putAll++; Object.keys(map).forEach(k => { cap(k, map[k]); store.set(k, String(map[k])); }); },
    remove(k) { store.delete(k); },
  };
}

function seedTabs() {
  return {
    workers: [
      ['id', 'name', 'notes', 'created_at', 'shift_commitment', 'start_date', 'gmach_month', 'phone', 'start_date_source'],
      ['w1', 'דנה כהן', 'הערה', '2025-01-01T00:00:00.000Z', '4+1', '2024-03-01', '', '0501234567', ''],
      ['w2', 'יוסי לוי 😀', '', '2025-02-01T00:00:00.000Z', '', '', '', '', ''],
    ],
    assignments: [
      ['id', 'worker_id', 'house', 'role', 'role_detail', 'employment_type', 'salary', 'pct'],
      ['a1', 'w1', 'ramot', 'מדריך/ה', '', 'full_time', 9000, 100],
    ],
    absences: [
      ['id', 'worker_id', 'house', 'start_date', 'end_date', 'reason_type', 'reason_detail', 'notes', 'status', 'created_at'],
      ['ab1', 'w1', 'ramot', '2020-01-01', '2020-01-05', 'sick', '', '', 'ended', '2020-01-01T00:00:00.000Z'],
    ],
    coverages: [['id']],
    archive_v3: [['id']],
    monthly_actuals: [
      ['id', 'assignment_id', 'month', 'actual_hours', 'actual_sessions', 'note', 'created_at', 'updated_at'],
      ['m1', 'a1', '2026-08', 120, '', '', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'],
    ],
    budgets: [['id']],
    hearings: [['id']],
    feed_log: [
      ['consumer', 'last_served_at', 'last_row_count', 'serve_count', 'status'],
      ['coordinators', '2026-09-01T00:00:00.000Z', 10, 3, 'ok'],
    ],
    ramot: [['id', 'name'], ['r1', 'ותיק']],
  };
}

function loadCtx(opts) {
  const o = opts || {};
  const counters = { openById: 0, dataRange: 0 };
  const tabs = {};
  const seed = o.seed || seedTabs();
  Object.keys(seed).forEach(k => { tabs[k] = fakeSheet(seed[k].map(r => r.slice()), counters); });
  const props = Object.assign({ SHEET_ID: 'sheet-1', SHARED_SECRET: SECRET }, o.props || {});
  const sandbox = {
    Logger: { log() {} },
    PropertiesService: {
      getScriptProperties() {
        return { getProperty(k) { return Object.prototype.hasOwnProperty.call(props, k) ? props[k] : null; } };
      },
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput(s) { return { _text: s, setMimeType() { return this; } }; },
    },
    LockService: { getScriptLock() { return { waitLock() {}, tryLock() { return true; }, releaseLock() {} }; } },
    Utilities: { formatDate(d, tz, fmt) { const iso = d.toISOString(); return fmt === 'yyyy-MM-dd' ? iso.slice(0, 10) : iso; } },
    Session: { getScriptTimeZone() { return 'UTC'; } },
    SpreadsheetApp: {
      openById() {
        counters.openById++;
        return {
          getSheetByName(name) { return tabs[name] || null; },
          insertSheet(name) { tabs[name] = fakeSheet([], counters); return tabs[name]; },
        };
      },
    },
  };
  if (o.cache) sandbox.CacheService = { getScriptCache() { return o.cache; } };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(gs, ctx);
  ctx.tabs = tabs;
  ctx.counters = counters;
  return ctx;
}

const plain = v => JSON.parse(JSON.stringify(v));
const out = o => JSON.parse(o._text);
const get = (ctx, params) => out(ctx.doGet({ parameter: Object.assign({ secret: SECRET }, params || {}) }));
// A fresh Apps Script execution: globals (the ss() memo, the read-only flag)
// are reset for every real request; the vm context is not, so reset them.
function newExecution(ctx) {
  vm.runInContext('SS_MEMO_ = null; SS_MEMO_ID_ = null; READ_ONLY_EXECUTION_ = false;', ctx);
}

// ---------------------------------------------------------------------------
// contract
// ---------------------------------------------------------------------------

test('contract: the bundle equals the separate reader calls, key for key', () => {
  const ctx = loadCtx();
  const bundle = plain(ctx.getInitialBundle_());
  newExecution(ctx);
  const houses = {};
  vm.runInContext('HOUSE_IDS', ctx).forEach(h => { houses[h] = plain(ctx.readLegacyHouseSafe(h)); });
  const separate = {
    workers: plain(ctx.readWorkersSafe()),
    assignments: plain(ctx.readAssignmentsSafe()),
    absences: plain(ctx.readAbsencesSafe()),
    coverages: plain(ctx.readCoveragesSafe()),
    archiveV3: plain(ctx.readArchiveV3Safe()),
    monthlyActuals: plain(ctx.readMonthlyActualsSafe()),
    budgets: plain(ctx.readBudgetsSafe()),
    hearings: plain(ctx.readHearingsSafe()),
    feedLog: plain(ctx.readFeedLogSafe()),
    houses,
    events: plain(ctx.readLegacyEventsSafe()),
    archive: plain(ctx.readLegacyArchiveSafe()),
    _compat: true,
  };
  assert.strictEqual(bundle._gasCache, 'off', 'no CacheService in this sandbox');
  delete bundle._gasCache;
  assert.deepStrictEqual(bundle, separate);
  assert.strictEqual(bundle.workers.length, 2);
  assert.strictEqual(bundle.houses.ramot.length, 1);
});

test('contract: doGet with no action and action=getInitialBundle return the same bundle', () => {
  const ctx = loadCtx();
  const a = get(ctx);
  newExecution(ctx);
  const b = get(ctx, { action: 'getInitialBundle' });
  assert.strictEqual(a._status, 200);
  assert.deepStrictEqual(a, b);
  for (const k of ['workers', 'assignments', 'absences', 'coverages', 'archiveV3', 'monthlyActuals',
    'budgets', 'hearings', 'feedLog', 'houses', 'events', 'archive', '_compat']) {
    assert.ok(k in a, 'bundle key ' + k);
  }
});

test('one spreadsheet open per execution, one getDataRange per tab', () => {
  const ctx = loadCtx();
  get(ctx);
  assert.strictEqual(ctx.counters.openById, 1, 'ss() is memoized for the execution');
  // 12 v3/legacy tabs present or absent — each PRESENT tab read exactly once.
  const present = Object.keys(ctx.tabs).length;
  assert.ok(ctx.counters.dataRange <= present, `${ctx.counters.dataRange} reads for ${present} tabs`);
});

// ---------------------------------------------------------------------------
// CacheService
// ---------------------------------------------------------------------------

test('second read is served from CacheService without touching the Sheet', () => {
  const cache = fakeCache();
  const ctx = loadCtx({ cache });
  const first = get(ctx);
  assert.strictEqual(first._gasCache, 'miss');
  newExecution(ctx);
  ctx.counters.dataRange = 0;
  const second = get(ctx);
  assert.strictEqual(second._gasCache, 'hit');
  assert.strictEqual(ctx.counters.dataRange, 1, 'only the (uncached) feed_log tab is read');
  delete first._gasCache; delete second._gasCache;
  assert.deepStrictEqual(second, first, 'a cached bundle is identical to a fresh one');
});

test('every doPost invalidates: the next read goes back to the Sheet and sees the write', () => {
  const cache = fakeCache();
  const ctx = loadCtx({ cache });
  get(ctx);
  newExecution(ctx);
  const r = out(ctx.doPost({
    parameter: { secret: SECRET },
    postData: { contents: JSON.stringify({ action: 'createWorker', worker: { name: 'עובדת חדשה' } }) },
  }));
  assert.strictEqual(r._status, 200, JSON.stringify(r));
  newExecution(ctx);
  const after = get(ctx);
  assert.strictEqual(after._gasCache, 'miss');
  assert.ok(after.workers.some(w => w.name === 'עובדת חדשה'), 'the new worker is visible');
});

test('a failed doPost still invalidates (a partial write must not leave a stale cache)', () => {
  const cache = fakeCache();
  const ctx = loadCtx({ cache });
  get(ctx);
  const ver = cache.store.get('bundle:ver');
  newExecution(ctx);
  const r = out(ctx.doPost({ parameter: { secret: SECRET }, postData: { contents: '{"action":"nope"}' } }));
  assert.strictEqual(r._status, 400);
  assert.notStrictEqual(cache.store.get('bundle:ver'), ver);
});

test('a read that raced a write cannot resurrect the pre-write snapshot', () => {
  const cache = fakeCache();
  const ctx = loadCtx({ cache });
  // Reader takes the version token, then a write lands, then the reader stores.
  const verBefore = vm.runInContext('bundleCacheVersion_(scriptCache_())', ctx);
  const staleCore = plain(ctx.computeInitialBundleCore_());
  ctx.invalidateBundleCache_();
  ctx.writeBundleCache_(cache, verBefore, staleCore);
  newExecution(ctx);
  assert.strictEqual(get(ctx)._gasCache, 'miss', 'the old token is never read again');
});

test('an evicted version token is a miss, never a stale hit', () => {
  const cache = fakeCache();
  const ctx = loadCtx({ cache });
  get(ctx);
  cache.store.delete('bundle:ver');
  newExecution(ctx);
  assert.strictEqual(get(ctx)._gasCache, 'miss');
});

test('a non-doGet execution that opens the spreadsheet flushes the cache (editor migrations, triggers)', () => {
  const cache = fakeCache();
  const ctx = loadCtx({ cache });
  get(ctx);
  const ver = cache.store.get('bundle:ver');
  newExecution(ctx);
  ctx.ss(); // e.g. an editor-run *Now() function
  assert.notStrictEqual(cache.store.get('bundle:ver'), ver);
});

test('feedLog is never cached — it is read fresh on every hit', () => {
  const cache = fakeCache();
  const ctx = loadCtx({ cache });
  get(ctx);
  ctx.tabs.feed_log.rows[1][3] = 99;
  newExecution(ctx);
  const b = get(ctx);
  assert.strictEqual(b._gasCache, 'hit');
  assert.strictEqual(b.feedLog[0].serveCount, 99);
  for (const v of cache.store.values()) assert.ok(!v.includes('coordinators'), 'feed log not in the cache');
});

test('a bundle larger than one cache value is chunked and round-trips Hebrew + emoji exactly', () => {
  const seed = seedTabs();
  for (let i = 0; i < 1500; i++) {
    seed.workers.push(['w' + (i + 10), 'עובד/ת מספר ' + i + ' 😀🙂', 'הערה ארוכה '.repeat(8), '', '', '', '', '', '']);
  }
  const cache = fakeCache();
  const ctx = loadCtx({ seed, cache });
  const first = get(ctx);
  const ver = cache.store.get('bundle:ver');
  const n = Number(cache.store.get('bundle:' + ver + ':n'));
  assert.ok(n > 1, 'split into ' + n + ' chunks');
  newExecution(ctx);
  const second = get(ctx);
  assert.strictEqual(second._gasCache, 'hit');
  delete first._gasCache; delete second._gasCache;
  assert.deepStrictEqual(second, first);
});

test('chunkString_ never splits a surrogate pair', () => {
  const ctx = loadCtx();
  const s = 'a😀b😀c😀';
  for (let size = 1; size <= 4; size++) {
    const parts = plain(ctx.chunkString_(s, Math.max(size, 2)));
    assert.strictEqual(parts.join(''), s);
    parts.forEach(p => {
      const last = p.charCodeAt(p.length - 1);
      assert.ok(!(last >= 0xD800 && last <= 0xDBFF), 'no dangling high surrogate');
    });
  }
});

test('a broken CacheService falls back to reading the Sheet', () => {
  const broken = {
    get() { throw new Error('boom'); }, getAll() { throw new Error('boom'); },
    put() { throw new Error('boom'); }, putAll() { throw new Error('boom'); }, remove() {},
  };
  const ctx = loadCtx({ cache: broken });
  const b = get(ctx);
  assert.strictEqual(b._status, 200);
  assert.strictEqual(b.workers.length, 2);
});

test('fail-closed: an unauthorized doGet reads no tab and caches nothing', () => {
  const cache = fakeCache();
  const ctx = loadCtx({ cache });
  const r = out(ctx.doGet({ parameter: { secret: 'wrong' } }));
  assert.strictEqual(r._status, 401);
  assert.deepStrictEqual(Object.keys(r).sort(), ['_status', 'error']);
  assert.strictEqual(ctx.counters.dataRange, 0);
  assert.strictEqual(cache.store.size, 0);
});

test('the cache holds no secret', () => {
  const cache = fakeCache();
  const ctx = loadCtx({ cache });
  get(ctx);
  for (const [k, v] of cache.store) {
    assert.ok(!k.includes(SECRET) && !v.includes(SECRET));
  }
});

// ---------------------------------------------------------------------------
// guard: header arrays are append-only
// ---------------------------------------------------------------------------

// Snapshot of every HEADERS_* array as of this change. A header array may
// only GROW at the end: _ensureSheet/ensureHeaders map the live sheet by
// position, so a reorder, rename or removal silently shifts every column.
const HEADERS_SNAPSHOT = {
  HEADERS_WORKERS: ['id', 'name', 'notes', 'created_at', 'shift_commitment', 'start_date', 'gmach_month', 'phone', 'start_date_source'],
  HEADERS_AUDIT_LOG: ['ts', 'action', 'entity', 'entity_id', 'field', 'before', 'after', 'reason'],
  HEADERS_FEED_LOG: ['consumer', 'last_served_at', 'last_row_count', 'serve_count', 'status'],
  HEADERS_ASSIGNMENTS: ['id', 'worker_id', 'house', 'role', 'role_detail', 'employment_type', 'salary', 'pct', 'hourly_rate', 'est_hours', 'session_rate', 'est_sessions', 'retainer_amount', 'notes', 'created_at', 'allowance', 'status', 'status_date', 'rate_individual', 'sessions_individual', 'rate_group', 'sessions_group', 'rate_external', 'external_patients', 'effective_from'],
  HEADERS_ABSENCES: ['id', 'worker_id', 'house', 'start_date', 'end_date', 'reason_type', 'reason_detail', 'notes', 'status', 'created_at'],
  HEADERS_COVERAGES: ['id', 'absence_id', 'covering_worker_id', 'covering_house', 'receiving_house', 'start_date', 'end_date', 'extra_payment', 'notes', 'created_at', 'replaced_assignment_id', 'role', 'shift_count', 'approval_status', 'approved_by', 'cancelled'],
  HEADERS_MONTHLY_ACTUALS: ['id', 'assignment_id', 'month', 'actual_hours', 'actual_sessions', 'note', 'created_at', 'updated_at'],
  HEADERS_BUDGETS: ['id', 'house', 'month', 'amount', 'created_at', 'updated_at', 'instructors_amount'],
  HEADERS_HEARINGS: ['id', 'worker_id', 'worker_name', 'hearing_date', 'reason', 'result', 'created_at'],
  HEADERS_HOUSE: ['id', 'name', 'role', 'salary', 'pct', 'notes', 'role_detail'],
  HEADERS_EVENTS: ['id', 'employee_id', 'employee_name', 'home_house', 'host_house', 'start_date', 'end_date', 'reason_type', 'reason_detail', 'covers_employee_id', 'bonus_amount', 'status', 'created_at'],
  HEADERS_ARCHIVE: ['id', 'employee_id', 'name', 'role', 'role_detail', 'salary', 'pct', 'notes', 'home_house', 'termination_date', 'reason_type', 'reason_detail', 'archived_at'],
  HEADERS_WORKERS_ARCHIVE: ['id', 'name', 'notes', 'created_at', 'shift_commitment', 'start_date', 'gmach_month', 'phone', 'decision', 'reason', 'keeper_id', 'archived_at', 'start_date_source'],
};

test('guard: every HEADERS_* array still starts with its snapshot (append-only)', () => {
  const ctx = loadCtx();
  for (const [name, snap] of Object.entries(HEADERS_SNAPSHOT)) {
    const now = plain(vm.runInContext(name, ctx));
    assert.deepStrictEqual(now.slice(0, snap.length), snap, `${name} must only grow at the end`);
  }
});
