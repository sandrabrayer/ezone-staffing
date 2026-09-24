'use strict';

// The copy of /api/data the BROWSER keeps for the instant paint
// (public/index.html, «last-known data»), as a security boundary.
//
// Pinned here, in jsdom with a controlled fetch:
//   - WHAT IS STORED: only LOCAL_COPY_FIELDS. No salary / rate / allowance /
//     payment / budget / hours / sessions / cost field, no notes or reason
//     details, no phone, no monthly actuals, no budgets — checked against a
//     payload carrying all of them, and against the field list of every
//     Code.gs reader, so a new bundle column is dropped until it is judged
//     safe. A kept text field with a run of 5+ digits (an ID or account
//     number typed by hand) is blanked.
//   - The full copy the first version stored (ezone_staff_data_v1) is
//     deleted on every load, token or no token, and never painted.
//   - CLEARED on a failed PIN (401 and lockout 429) and on ANY 401 — the
//     data read, a save, the hearings list and the hadrachot banner alike.
//     Never written without a session token.
//   - PREVIEW: a page painted from the stripped copy shows «₪ …» for every
//     amount, no false «missing data» / «no budget» line, and refuses every
//     form, save and export; the fresh server copy then renders for real.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { buildInlinedHtml, ROOT } = require('./inline-page');

const HTML = buildInlinedHtml();
const GS = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
const TOKEN_KEY = 'ezone_staff_token_v1';
const DATA_KEY = 'ezone_staff_data_v2';
const LEGACY_KEY = 'ezone_staff_data_v1';

// Field names that must never reach browser storage.
const FORBIDDEN_FIELD = /salary|rate|allowance|amount|payment|cost|retainer|budget|hours|sessions|patients|^pct$|notes?$|reasonDetail|phone|bank|account|iban|passport|idNumber|nationalId|^tz$/i;

// A bundle carrying every kind of sensitive value, each one distinctive so
// its absence can be checked in the stored text.
function sensitivePayload(name) {
  return {
    workers: [{
      id: 'w1', name: name || 'ציון מקנזי', createdAt: '2026-01-02T00:00:00.000Z', shift_commitment: '4 משמרות',
      startDate: '2024-01-01', startDateSource: '', gmachMonth: '',
      notes: 'ת.ז 012345678 · בנק לאומי סניף 902 חשבון 12-345-678901',
      phone: '0501234567', bankAccount: '12-345-678901',
    }, {
      id: 'w2', name: 'עובד 204567891', startDate: '2024-02-01', notes: '',
    }],
    assignments: [{
      id: 'a1', workerId: 'w1', house: 'ramot', role: 'מדריך/ה', roleDetail: '', employmentType: 'full_time',
      salary: 12345, pct: 77, hourlyRate: 61, estHours: 43, sessionRate: 211, estSessions: 19,
      retainerAmount: 9191, allowance: 6000, rateIndividual: 313, sessionsIndividual: 7, rateGroup: 414,
      sessionsGroup: 3, rateExternal: 515, externalPatients: 2, notes: 'הסכם שכר מיוחד',
      status: 'active', statusDate: '', effectiveFrom: '', createdAt: '2026-01-02T00:00:00.000Z',
    }],
    absences: [{ id: 'ab1', workerId: 'w1', house: 'ramot', startDate: '2026-09-01', endDate: '2026-09-30',
      reasonType: 'sick', reasonDetail: 'אבחנה רפואית', notes: 'אישור רופא', status: 'active', createdAt: '' }],
    coverages: [{ id: 'c1', absenceId: 'ab1', coveringWorkerId: 'w2', coveringHouse: 'asher', receivingHouse: 'ramot',
      startDate: '2026-09-01', endDate: '2026-09-30', extraPayment: 777, notes: 'תוספת בהסכמה', createdAt: '',
      replacedAssignmentId: 'a1', role: 'מדריך/ה', shiftCount: 4, approvalStatus: 'approved', approvedBy: 'מורן', cancelled: false }],
    archiveV3: [{ id: 'ar1', assignmentId: 'a0', workerId: 'w9', name: 'עזב/ה', house: 'ramot', role: 'מדריך/ה',
      roleDetail: '', employmentType: 'full_time', salary: 8888, pct: 100, hourlyRate: 0, estHours: 0,
      sessionRate: 0, estSessions: 0, retainerAmount: 0, notes: 'סיבת עזיבה אישית', terminationDate: '2026-08-31',
      reasonType: 'resigned', reasonDetail: 'פרטים', archivedAt: '2026-08-31T00:00:00.000Z' }],
    monthlyActuals: [{ id: 'm1', assignmentId: 'a1', month: '2026-09', actualHours: 33, actualSessions: 5, note: 'שעות נוספות' }],
    budgets: [{ id: 'b1', house: 'ramot', month: '2026-09', amount: 150000, instructorsAmount: 90000 }],
    feedLog: [{ consumer: 'coordinators', lastServedAt: '2026-09-24T00:00:00.000Z', lastRowCount: 12, serveCount: 3, status: 'ok' }],
  };
}
const SECRET_VALUES = ['12345', '150000', '90000', '8888', '9191', '6000', '777', '012345678', '678901',
  '0501234567', '204567891', 'בנק', 'אבחנה', 'הסכם שכר', 'אישור רופא', 'סיבת עזיבה', 'שעות נוספות', 'תוספת בהסכמה'];

function response(body, opts) {
  const o = opts || {};
  const headers = { 'x-cache': o.xcache || 'HIT' };
  return {
    ok: (o.status || 200) < 400, status: o.status || 200,
    headers: { get: (k) => headers[String(k).toLowerCase()] || null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

function loadPage({ token, storage, fetchImpl }) {
  const calls = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { if (!/^Not implemented:/.test(e.message || '')) throw e; });
  const dom = new JSDOM(HTML, {
    url: 'http://localhost/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      if (token) window.localStorage.setItem(TOKEN_KEY, token);
      Object.keys(storage || {}).forEach((k) => window.localStorage.setItem(k, JSON.stringify(storage[k])));
      window.fetch = (url, init) => { calls.push(String(url)); return fetchImpl(String(url), init); };
    },
  });
  return { dom, calls, w: dom.window, doc: dom.window.document };
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
const stored = (w) => w.localStorage.getItem(DATA_KEY);
const everyKey = (obj, out) => {
  if (Array.isArray(obj)) obj.forEach((v) => everyKey(v, out));
  else if (obj && typeof obj === 'object') Object.keys(obj).forEach((k) => { out.push(k); everyKey(obj[k], out); });
  return out;
};

// ---------------------------------------------------------------------------
// what is stored
// ---------------------------------------------------------------------------

test('after a load, the stored copy holds no money, no ID or bank number, no notes, no phone', async () => {
  const { dom, w } = loadPage({
    token: 't.k',
    fetchImpl: async (url) => (url === '/api/data' ? response(sensitivePayload()) : response({ configured: false })),
  });
  await tick(20);
  const text = stored(w);
  assert.ok(text, 'a copy was stored');
  for (const v of SECRET_VALUES) assert.ok(!text.includes(v), 'stored in the browser: ' + v);
  const doc = JSON.parse(text);
  // Field names inside the rows (the collection names are fixed: `budgets`
  // is kept only as an empty list).
  const keys = everyKey(Object.values(doc.data), []);
  const bad = keys.filter((k) => FORBIDDEN_FIELD.test(k));
  assert.deepEqual(bad, [], 'forbidden field names in storage');
  // What IS kept is enough to paint the structure.
  assert.equal(doc.data.workers[0].name, 'ציון מקנזי');
  assert.equal(doc.data.assignments[0].role, 'מדריך/ה');
  assert.equal(doc.data.assignments[0].employmentType, 'full_time');
  assert.deepEqual(doc.data.budgets, []);
  assert.deepEqual(doc.data.monthlyActuals, []);
  // The in-memory arrays (the fresh server copy) are untouched.
  assert.equal(w.eval('ASSIGNMENTS[0].salary'), 12345);
  dom.window.close();
});

test('every stored row has ONLY allowlisted fields — an unknown new column is dropped', async () => {
  const p = sensitivePayload();
  p.workers[0].futureColumn = 'x';
  p.newCollection = [{ id: 'n1', salary: 1 }];
  const { dom, w } = loadPage({
    token: 't.k',
    fetchImpl: async (url) => (url === '/api/data' ? response(p) : response({ configured: false })),
  });
  await tick(20);
  const allow = JSON.parse(JSON.stringify(w.eval('LOCAL_COPY_FIELDS')));
  const data = JSON.parse(stored(w)).data;
  assert.deepEqual(Object.keys(data).sort(), Object.keys(allow).sort(), 'only known collections');
  Object.keys(data).forEach((coll) => data[coll].forEach((row) => {
    Object.keys(row).forEach((k) => assert.ok(allow[coll].includes(k), `${coll}.${k} is not allowlisted`));
  }));
  dom.window.close();
});

test('a kept text field carrying a long digit run (ID / account number) is blanked', async () => {
  const { dom, w } = loadPage({
    token: 't.k',
    fetchImpl: async (url) => (url === '/api/data' ? response(sensitivePayload()) : response({ configured: false })),
  });
  await tick(20);
  const red = (d) => JSON.parse(JSON.stringify(w.redactForLocal(d)));
  const one = (name) => red({ workers: [{ id: 'w', name }] }).workers[0].name;
  for (const s of ['עובד 204567891', 'ת.ז. 20456-7891', 'חשבון 12-345-678901', '0501234567']) assert.equal(one(s), '', s);
  for (const s of ['ציון מקנזי', 'דנה 2', 'משמרת 24/7', '']) assert.equal(one(s), s, 'kept: ' + s);
  // Ids and dates are never scrubbed.
  const a = red({ assignments: [{ id: 'a1700000000000', createdAt: '2026-01-02T00:00:00.000Z' }] }).assignments[0];
  assert.deepEqual(a, { id: 'a1700000000000', createdAt: '2026-01-02T00:00:00.000Z' });
  dom.window.close();
});

test('the allowlist is checked against the fields every Code.gs reader actually emits', () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only' });
  const m = /const LOCAL_COPY_FIELDS = (\{[\s\S]*?\n\});/.exec(HTML);
  assert.ok(m, 'LOCAL_COPY_FIELDS in public/index.html');
  const allow = dom.window.eval('(' + m[1] + ')');
  const readers = {
    workers: 'readWorkersSafe', assignments: 'readAssignmentsSafe', absences: 'readAbsencesSafe',
    coverages: 'readCoveragesSafe', archiveV3: 'readArchiveV3Safe', monthlyActuals: 'readMonthlyActualsSafe',
    budgets: 'readBudgetsSafe', feedLog: 'readFeedLogSafe',
  };
  Object.keys(readers).forEach((coll) => {
    const start = GS.indexOf('function ' + readers[coll] + '(');
    assert.ok(start >= 0, readers[coll]);
    const body = GS.slice(start, GS.indexOf('\n}\n', start));
    const emitted = [...body.matchAll(/^\s{4,8}(\w+):/gm)].map((x) => x[1]);
    assert.ok(emitted.length >= 3, readers[coll] + ' fields parsed');
    const kept = allow[coll];
    assert.ok(Array.isArray(kept), coll + ' has an entry');
    kept.forEach((f) => assert.ok(emitted.includes(f), `${coll}.${f} is not a field ${readers[coll]} emits`));
    kept.forEach((f) => assert.ok(!FORBIDDEN_FIELD.test(f), `${coll}.${f} must not be kept`));
    // And every money field the reader emits is indeed left out.
    emitted.filter((f) => FORBIDDEN_FIELD.test(f)).forEach((f) => assert.ok(!kept.includes(f), `${coll}.${f}`));
  });
  assert.deepEqual(allow.budgets, [], 'budgets are money');
  assert.deepEqual(allow.monthlyActuals, [], 'actual hours/sessions are cost inputs');
  dom.window.close();
});

test('the full copy the first version stored (v1) is deleted on load — with or without a token — and never painted', async () => {
  for (const token of ['t.k', null]) {
    const gate = deferred();
    const { dom, w, doc } = loadPage({
      token,
      storage: { [LEGACY_KEY]: { savedAt: Date.now(), data: sensitivePayload('עותק ישן מלא') } },
      fetchImpl: async (url) => { if (url === '/api/data') await gate.promise; return response(sensitivePayload()); },
    });
    await tick(10);
    assert.equal(w.localStorage.getItem(LEGACY_KEY), null, 'v1 deleted (token=' + !!token + ')');
    assert.ok(!doc.getElementById('app').innerHTML.includes('עותק ישן מלא'), 'never painted');
    gate.resolve();
    await tick(10);
    dom.window.close();
  }
});

test('no local copy is ever written without a session token', async () => {
  const { dom, w } = loadPage({
    token: 't.k',
    fetchImpl: async (url) => (url === '/api/data' ? response(sensitivePayload()) : response({ configured: false })),
  });
  await tick(20);
  w.localStorage.removeItem(TOKEN_KEY);
  w.localStorage.removeItem(DATA_KEY);
  w.writeLocalData(sensitivePayload());
  assert.equal(stored(w), null);
  dom.window.close();
});

// ---------------------------------------------------------------------------
// when it is cleared
// ---------------------------------------------------------------------------

for (const status of [401, 429]) {
  test(`a failed PIN (${status}) clears the local copy`, async () => {
    const { dom, w, doc } = loadPage({
      token: null,
      storage: { [DATA_KEY]: { v: 2, savedAt: Date.now(), data: { workers: [{ id: 'w1', name: 'x' }] } } },
      fetchImpl: async (url) => (url === '/api/login' ? response({ error: 'קוד שגוי' }, { status }) : response({})),
    });
    await tick(10);
    assert.ok(stored(w), 'present before the attempt');
    doc.getElementById('pinInput').value = '0000';
    await w.submitPin();
    assert.equal(stored(w), null, 'cleared on PIN failure');
    assert.equal(doc.getElementById('pinOverlay').style.display, 'flex', 'still at the PIN gate');
    dom.window.close();
  });
}

test('ANY 401 clears the local copy and the token: a save, the hearings list, the hadrachot banner', async () => {
  const cases = [
    ['/api/action', (w) => w.doAction({ action: 'setBudget' }).catch(() => {})],
    ['/api/data/hearings', (w) => w.loadHearings()],
    ['/api/hadrachot-status', (w) => w.loadHadrachotStatus()],
  ];
  for (const [route, trigger] of cases) {
    let deny = false;
    const { dom, w, doc } = loadPage({
      token: 't.k',
      fetchImpl: async (url) => {
        if (deny && url === route) return response({ error: 'unauthorized' }, { status: 401 });
        if (url === '/api/data') return response(sensitivePayload());
        if (url === '/api/data/hearings') return response({ hearings: [] });
        return response({ configured: false });
      },
    });
    await tick(20);
    assert.ok(stored(w), route + ': a copy exists first');
    deny = true;
    await trigger(w);
    await tick(5);
    assert.equal(stored(w), null, route + ': 401 cleared the copy');
    assert.equal(w.localStorage.getItem(TOKEN_KEY), null, route + ': and the token');
    assert.equal(doc.getElementById('pinOverlay').style.display, 'flex', route + ': back to the PIN');
    dom.window.close();
  }
});

// ---------------------------------------------------------------------------
// the preview painted from the stripped copy
// ---------------------------------------------------------------------------

async function previewPage() {
  const gate = deferred();
  // What an earlier session stored — i.e. the redacted form.
  const local = { v: 2, savedAt: Date.now() - 60e3, data: sensitivePayload() };
  const r = loadPage({
    token: 't.k', storage: { [DATA_KEY]: local },
    fetchImpl: async (url) => {
      if (url === '/api/data') { await gate.promise; return response(sensitivePayload()); }
      if (url === '/api/action') return response({ ok: true });
      return response({ configured: false });
    },
  });
  await tick(15);
  return Object.assign(r, { gate });
}

test('preview: amounts read «₪ …» — no ₪0, no false «missing data» or «no budget», nothing from storage beyond the allowlist', async () => {
  const { dom, w, doc, gate } = await previewPage();
  assert.equal(w.eval('DATA_PREVIEW'), true);
  assert.equal(w.eval('ASSIGNMENTS[0].salary'), undefined, 'the stripped copy is what is in memory');
  const html = doc.getElementById('app').innerHTML;
  assert.ok(html.length > 300, 'painted without waiting');
  assert.ok(html.includes('₪ …'), 'amounts are placeholders');
  assert.ok(!/₪\s?\d/.test(html), 'no real-looking amount, not even ₪0');
  for (const t of ['חסרים נתונים', 'ללא נתונים מלאים', 'אין תקציב', 'לא הוזנו נתוני אמת', '% משרה']) {
    assert.ok(!html.includes(t), 'false line in preview: ' + t);
  }
  w.go('ramot');
  const house = doc.getElementById('app').innerHTML;
  assert.ok(house.includes('ציון מקנזי'), 'the structure is there');
  assert.ok(!/₪\s?\d/.test(house) && !house.includes('% משרה'), 'house view: no amounts either');
  gate.resolve();
  await tick(20);
  dom.window.close();
});

test('preview: every form, every save and every export is refused; nothing is sent', async () => {
  const { dom, w, doc, calls, gate } = await previewPage();
  const openers = [
    ['openBudget', ['ramot'], 'budgetOverlay'], ['openWorker', [null, 'ramot'], 'workerOverlay'],
    ['openAssignment', [{ house: 'ramot' }], 'assignmentOverlay'], ['openTerminate', ['a1'], 'termOverlay'],
    ['openAbsence', [{ house: 'ramot' }], 'absenceOverlay'], ['openCoverage', [{ house: 'ramot' }], 'coverageOverlay'],
    ['openHearing', [null], 'hearingOverlay'],
  ];
  const blocked = w.eval('PREVIEW_BLOCKED_TEXT');
  for (const [fn, args, overlay] of openers) {
    doc.getElementById('toast').textContent = '';
    w[fn](...args);
    assert.ok(!doc.getElementById(overlay).classList.contains('show'), fn + ' must not open in preview');
    assert.equal(doc.getElementById('toast').textContent, blocked, fn + ' says why');
  }
  await assert.rejects(() => w.doAction({ action: 'setBudget', house: 'ramot' }), new RegExp(blocked));
  let blobs = 0;
  w.URL.createObjectURL = () => { blobs++; return 'blob:x'; };
  w.downloadExport(w.eval('csvExportKinds()[0].kind'));
  assert.equal(blobs, 0, 'no export built from the stripped copy');
  assert.ok(!calls.includes('/api/action'), 'no write request was made');

  // The fresh copy lands: real amounts, and the forms work again.
  gate.resolve();
  await tick(20);
  assert.equal(w.eval('DATA_PREVIEW'), false);
  w.go('ramot');
  assert.match(doc.getElementById('app').innerHTML, /₪12,345/, 'the real amount, once known');
  w.openBudget('ramot');
  assert.ok(doc.getElementById('budgetOverlay').classList.contains('show'), 'forms open after the refresh');
  dom.window.close();
});

test('every form opener in the page starts with the preview guard', () => {
  const openers = [...HTML.matchAll(/^(?:async )?function (open\w+)\(([^)]*)\)\{\n(.*)$/gm)]
    .filter((m) => m[1] !== 'openModalEntry');
  assert.ok(openers.length >= 7, 'found the openers: ' + openers.map((m) => m[1]).join(', '));
  openers.forEach((m) => assert.equal(m[3].trim(), 'if (blockedInPreview()) return;', m[1]));
  assert.match(HTML, /function downloadExport\(kind\)\{\n\s+if \(blockedInPreview\(\)\) return;/);
  assert.match(HTML, /async function doAction\(payload\)\{[\s\S]{0,200}if \(DATA_PREVIEW\)/);
});
