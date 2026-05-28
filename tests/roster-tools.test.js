'use strict';
// Tests for two roster-management features added on top of the v3 UI:
//
//   1. Worker cascade-delete — a "מחיקת עובד/ת + כל השיבוצים" button in
//      the worker dialog that removes all of a worker's assignments and
//      then the worker, in one action. Shown ONLY when the worker's sole
//      references are assignments (no absence/coverage/archive history).
//
//   2. Per-house roster search — a search box on each house view that
//      filters the שכירים/פרילנסרים tables by worker name, in place,
//      without losing input focus, and without touching the headline
//      stat numbers.
//
// Mirrors the harness in page-load.test.js: inline lib/calc.js into the
// HTML, run it in jsdom, drive auth via authAndBoot(), then poke the
// exposed globals (which is what the inline <script>'s onclick handlers
// call anyway).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');

function buildInlinedHtml() {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const calc = fs.readFileSync(path.join(ROOT, 'lib', 'calc.js'), 'utf8');
  const inlined = html.replace(
    /<script src="\/lib\/calc\.js"><\/script>/,
    `<script>${calc}</script>`,
  );
  if (inlined === html) {
    throw new Error('expected <script src="/lib/calc.js"></script> in public/index.html');
  }
  return inlined;
}

function loadPage() {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => {
    if (/^Not implemented:/.test(e.message || '')) return;
    errors.push({ kind: 'jsdomError', message: e.message });
  });
  vc.on('error', (...args) => errors.push({ kind: 'consoleError', message: args.map(String).join(' ') }));

  const dom = new JSDOM(buildInlinedHtml(), {
    url: 'http://localhost/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
  });

  const emptyV3 = () => ({
    workers: [], assignments: [], absences: [], coverages: [], archiveV3: [],
    houses: { ramot: [], asher: [], ofroni: [], rehab: [], pardes: [], sde_eliezer: [], hq: [] },
    events: [], archive: [],
  });
  dom.window.fetch = async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify(emptyV3()),
    json: async () => emptyV3(),
  });
  return { dom, errors };
}

async function authAndBoot(dom, {
  workers = [], assignments = [], absences = [], coverages = [], archiveV3 = [],
} = {}) {
  const data = {
    workers, assignments, absences, coverages, archiveV3,
    houses: { ramot: [], asher: [], ofroni: [], rehab: [], pardes: [], sde_eliezer: [], hq: [] },
    events: [], archive: [],
  };
  dom.window.fetch = async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify(data),
    json: async () => data,
  });
  dom.window.localStorage.setItem('ezone_staff_token_v1', 'fake.token');
  await dom.window.boot();
}

// Fixture factories ---------------------------------------------------

function worker(over) {
  return Object.assign({ id: 'w1', name: 'בדיקה', notes: '', createdAt: '' }, over);
}
function assignment(over) {
  return Object.assign({
    id: 'a1', workerId: 'w1', house: 'ramot',
    role: 'מדריך/ה', roleDetail: '', employmentType: 'hourly',
    salary: 0, pct: 0, hourlyRate: 45, estHours: 140,
    sessionRate: 0, estSessions: 0, retainerAmount: 0,
    notes: '', createdAt: '',
  }, over);
}
function absence(over) {
  return Object.assign({
    id: 'ab1', workerId: 'w1', house: 'ramot',
    startDate: '2026-05-01', endDate: '2026-07-31',
    reasonType: 'מחלה', reasonDetail: '', notes: '',
    status: 'active', createdAt: '',
  }, over);
}

// ---------- cascade-delete button visibility ----------

test('worker dialog: NO refs → plain מחיקה button shown, cascade hidden', async () => {
  const { dom, errors } = loadPage();
  await authAndBoot(dom, { workers: [worker()] });
  dom.window.openWorker('w1');
  const doc = dom.window.document;
  assert.equal(doc.getElementById('workerDeleteBtn').style.display, '',
    'plain delete should be visible for a worker with no references');
  assert.equal(doc.getElementById('workerDeleteCascadeBtn').style.display, 'none',
    'cascade delete should be hidden when there are no assignments');
  dom.window.close();
  assert.equal(errors.length, 0, JSON.stringify(errors));
});

test('worker dialog: ONLY assignments → cascade button shown, plain hidden', async () => {
  const { dom, errors } = loadPage();
  await authAndBoot(dom, {
    workers: [worker()],
    assignments: [assignment({ id: 'a1' }), assignment({ id: 'a2', house: 'asher' })],
  });
  dom.window.openWorker('w1');
  const doc = dom.window.document;
  assert.equal(doc.getElementById('workerDeleteBtn').style.display, 'none',
    'plain delete should be hidden when assignments exist');
  assert.notEqual(doc.getElementById('workerDeleteCascadeBtn').style.display, 'none',
    'cascade delete should be visible when the only refs are assignments');
  // Sub-header should mention the count (2 assignments).
  assert.match(doc.getElementById('workerModalSub').textContent, /2 השיבוצים/,
    'sub-header should report how many assignments will be removed');
  dom.window.close();
  assert.equal(errors.length, 0, JSON.stringify(errors));
});

test('worker dialog: absence history → BOTH delete buttons hidden (deletion blocked)', async () => {
  const { dom, errors } = loadPage();
  await authAndBoot(dom, {
    workers: [worker()],
    assignments: [assignment()],
    absences: [absence()],
  });
  dom.window.openWorker('w1');
  const doc = dom.window.document;
  assert.equal(doc.getElementById('workerDeleteBtn').style.display, 'none');
  assert.equal(doc.getElementById('workerDeleteCascadeBtn').style.display, 'none',
    'cascade must be blocked when real absence history exists');
  assert.match(doc.getElementById('workerModalSub').textContent, /לא אפשרית/,
    'sub-header should explain deletion is blocked');
  dom.window.close();
  assert.equal(errors.length, 0, JSON.stringify(errors));
});

// ---------- cascade-delete behaviour ----------

test('deleteWorkerCascade: deletes every assignment then the worker, in order', async () => {
  const { dom, errors } = loadPage();
  await authAndBoot(dom, {
    workers: [worker()],
    assignments: [assignment({ id: 'a1' }), assignment({ id: 'a2', house: 'asher' })],
  });
  dom.window.openWorker('w1');

  // Capture the POST action sequence; stub GET refresh to "empty" so the
  // post-delete reload reflects a now-gone worker.
  const calls = [];
  const emptyV3 = {
    workers: [], assignments: [], absences: [], coverages: [], archiveV3: [],
    houses: { ramot: [], asher: [], ofroni: [], rehab: [], pardes: [], sde_eliezer: [], hq: [] },
    events: [], archive: [],
  };
  dom.window.fetch = async (url, init) => {
    if (init && init.method === 'POST') {
      const body = JSON.parse(init.body);
      calls.push(body);
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(emptyV3) };
  };
  // Auto-confirm the window.confirm() guard.
  dom.window.confirm = () => true;

  await dom.window.deleteWorkerCascade();

  // Expect: deleteAssignment a1, deleteAssignment a2, then deleteWorker w1.
  assert.equal(calls.length, 3, 'two assignment deletes + one worker delete');
  assert.deepEqual(
    calls.map(c => c.action),
    ['deleteAssignment', 'deleteAssignment', 'deleteWorker'],
    'assignments must be deleted before the worker (server 409s otherwise)',
  );
  assert.equal(calls[2].id, 'w1', 'final call deletes the worker');
  const deletedAsgIds = calls.slice(0, 2).map(c => c.id).sort();
  assert.deepEqual(deletedAsgIds, ['a1', 'a2'], 'both assignments targeted');

  // Modal closed + success toast.
  assert.ok(!dom.window.document.getElementById('workerOverlay').classList.contains('show'));
  assert.match(dom.window.document.getElementById('toast').textContent, /נמחקו/);
  dom.window.close();
  assert.equal(errors.length, 0, JSON.stringify(errors));
});

test('deleteWorkerCascade: refuses when absence history exists, makes no calls', async () => {
  const { dom, errors } = loadPage();
  await authAndBoot(dom, {
    workers: [worker()],
    assignments: [assignment()],
    absences: [absence()],
  });
  dom.window.openWorker('w1');

  const calls = [];
  dom.window.fetch = async (url, init) => {
    if (init && init.method === 'POST') { calls.push(JSON.parse(init.body)); return { ok: true, status: 200, text: async () => '{}' }; }
    return { ok: true, status: 200, text: async () => '{}' };
  };
  dom.window.confirm = () => true;  // even if confirmed, guard must block

  await dom.window.deleteWorkerCascade();

  assert.equal(calls.length, 0, 'no delete calls should fire when history exists');
  assert.match(dom.window.document.getElementById('toast').textContent, /לא אפשרית/);
  dom.window.close();
  assert.equal(errors.length, 0, JSON.stringify(errors));
});

test('deleteWorkerCascade: user cancels the confirm → no calls', async () => {
  const { dom, errors } = loadPage();
  await authAndBoot(dom, {
    workers: [worker()],
    assignments: [assignment()],
  });
  dom.window.openWorker('w1');

  const calls = [];
  dom.window.fetch = async (url, init) => {
    if (init && init.method === 'POST') { calls.push(JSON.parse(init.body)); return { ok: true, status: 200, text: async () => '{}' }; }
    return { ok: true, status: 200, text: async () => '{}' };
  };
  dom.window.confirm = () => false;  // user clicks "cancel"

  await dom.window.deleteWorkerCascade();
  assert.equal(calls.length, 0, 'cancelling the confirm must abort before any call');
  dom.window.close();
  assert.equal(errors.length, 0, JSON.stringify(errors));
});

// ---------- per-house roster search ----------

test('house view renders a roster search box', async () => {
  const { dom, errors } = loadPage();
  await authAndBoot(dom, {});
  dom.window.go('ramot');
  const inp = dom.window.document.getElementById('rosterSearch');
  assert.ok(inp, 'house view should render the #rosterSearch input');
  assert.equal(inp.getAttribute('placeholder'), 'חיפוש עובד/ת לפי שם…');
  dom.window.close();
  assert.equal(errors.length, 0, JSON.stringify(errors));
});

test('roster search filters rows by worker name, in place', async () => {
  const { dom, errors } = loadPage();
  await authAndBoot(dom, {
    workers: [
      worker({ id: 'w1', name: 'דנה כהן' }),
      worker({ id: 'w2', name: 'יוסי לוי' }),
      worker({ id: 'w3', name: 'דני מזרחי' }),
    ],
    assignments: [
      assignment({ id: 'a1', workerId: 'w1' }),
      assignment({ id: 'a2', workerId: 'w2' }),
      assignment({ id: 'a3', workerId: 'w3' }),
    ],
  });
  dom.window.go('ramot');
  const doc = dom.window.document;

  // All three in the salaried table to start (hourly = salaried category).
  let rows = doc.querySelectorAll('#rosterSalaried tbody tr');
  assert.equal(rows.length, 3, 'all three workers shown before filtering');

  // Type "דנ" → matches דנה כהן and דני מזרחי, not יוסי.
  dom.window.onRosterFilterInput('דנ');
  rows = [...doc.querySelectorAll('#rosterSalaried tbody tr')];
  const names = rows.map(r => r.querySelector('.link-name').textContent.trim());
  assert.deepEqual(names.sort(), ['דנה כהן', 'דני מזרחי'].sort(),
    'only names containing the term remain');

  // Count pill reflects the filtered count.
  assert.equal(doc.getElementById('rosterSalariedCount').textContent, '2',
    'salaried count pill tracks the filtered rows');

  // Clearing restores all three.
  dom.window.onRosterFilterInput('');
  rows = doc.querySelectorAll('#rosterSalaried tbody tr');
  assert.equal(rows.length, 3, 'clearing the term restores the full roster');

  dom.window.close();
  assert.equal(errors.length, 0, JSON.stringify(errors));
});

test('roster search: no match shows the empty-soft placeholder, headline stat unchanged', async () => {
  const { dom, errors } = loadPage();
  await authAndBoot(dom, {
    workers: [worker({ id: 'w1', name: 'דנה כהן' })],
    assignments: [assignment({ id: 'a1', workerId: 'w1' })],
  });
  dom.window.go('ramot');
  const doc = dom.window.document;

  // Headline stat (שיבוצים בבית) = 1 before filtering.
  const statVal = doc.querySelector('.stat.accent .val').textContent.trim();
  assert.equal(statVal, '1');

  dom.window.onRosterFilterInput('לא-קיים');
  // Salaried table now shows the empty-soft placeholder, no data rows.
  const dataRows = [...doc.querySelectorAll('#rosterSalaried tbody tr')]
    .filter(tr => tr.querySelector('.link-name'));
  assert.equal(dataRows.length, 0, 'no matching rows render');
  assert.ok(doc.querySelector('#rosterSalaried .empty-soft'),
    'empty-soft placeholder should appear when nothing matches');

  // Headline stat is unchanged — search narrows tables only.
  assert.equal(doc.querySelector('.stat.accent .val').textContent.trim(), '1',
    'house stat card must not be affected by the roster filter');

  dom.window.close();
  assert.equal(errors.length, 0, JSON.stringify(errors));
});

test('roster filter resets when navigating to another house', async () => {
  const { dom, errors } = loadPage();
  await authAndBoot(dom, {
    workers: [worker({ id: 'w1', name: 'דנה' })],
    assignments: [assignment({ id: 'a1', workerId: 'w1' })],
  });
  dom.window.go('ramot');
  dom.window.onRosterFilterInput('דנה');
  // Navigate away and back; the search box should be empty again.
  dom.window.go('asher');
  dom.window.go('ramot');
  const inp = dom.window.document.getElementById('rosterSearch');
  assert.equal(inp.value, '', 'navigating between views clears the roster filter');
  dom.window.close();
  assert.equal(errors.length, 0, JSON.stringify(errors));
});

// ---------- filtering semantics (through the public oninput path) ----------
// filterRoster() is an internal helper (lexical scope, not on window), so
// we exercise it the way the UI does: drive onRosterFilterInput() and read
// the rendered rows. Covers case-insensitive Latin, Hebrew, and trimming.

test('roster search: case-insensitive Latin, Hebrew, and whitespace trimming', async () => {
  const { dom, errors } = loadPage();
  await authAndBoot(dom, {
    workers: [
      worker({ id: 'w1', name: 'Dana' }),
      worker({ id: 'w2', name: 'דנה' }),
    ],
    assignments: [
      assignment({ id: 'a1', workerId: 'w1' }),
      assignment({ id: 'a2', workerId: 'w2' }),
    ],
  });
  dom.window.go('ramot');
  const doc = dom.window.document;
  const shown = () => [...doc.querySelectorAll('#rosterSalaried tbody tr')]
    .filter(tr => tr.querySelector('.link-name'))
    .map(tr => tr.querySelector('.link-name').textContent.trim());

  // Empty / whitespace-only → both shown.
  dom.window.onRosterFilterInput('');
  assert.equal(shown().length, 2, 'empty term shows everyone');
  dom.window.onRosterFilterInput('   ');
  assert.equal(shown().length, 2, 'whitespace-only term shows everyone');

  // Case-insensitive Latin match + trimming.
  dom.window.onRosterFilterInput('  DANA  ');
  assert.deepEqual(shown(), ['Dana'], 'case-insensitive, trimmed Latin match');

  // Hebrew match.
  dom.window.onRosterFilterInput('דנה');
  assert.deepEqual(shown(), ['דנה'], 'Hebrew match');

  // No match.
  dom.window.onRosterFilterInput('zzz');
  assert.equal(shown().length, 0, 'no match → none shown');

  dom.window.close();
  assert.equal(errors.length, 0, JSON.stringify(errors));
});
