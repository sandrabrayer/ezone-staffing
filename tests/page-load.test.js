'use strict';
// Loads public/index.html in jsdom with all <script> tags executing, and
// asserts no script errors fire. This is the regression suite for the
// duplicate-top-level-identifier bug class:
//   lib/calc.js loads as a classic script and creates global function
//   bindings. The inline <script> in public/index.html then declares
//   `const { ... } = window.EZONE_CALC`. Each const binding is checked
//   against the existing global var environment — any unaliased name
//   that matches a calc.js function throws "Identifier X has already
//   been declared" at script-load time and the page is dead.
//
// Two such bugs reached browser testing before this test existed: `cost`
// in the cloud-port commit, and `todayStr` in the coverage-event redesign.
// Both now caught here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');

// Inline lib/calc.js into the HTML so jsdom doesn't try to fetch it over the
// network. Preserves the classic-script load order: calc.js first, then the
// existing inline <script>. (The collision we're testing for happens exactly
// when both scripts execute in the same realm's global lexical env, which is
// the case here.)
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
  // jsdomError fires for any uncaught script error during page evaluation —
  // this is where "Identifier X has already been declared" surfaces.
  vc.on('jsdomError', e => {
    // jsdom emits "Not implemented" jsdomError events for things it
    // intentionally doesn't ship (window.scrollTo, etc). These aren't
    // page bugs — filter them out to keep this suite focused on real
    // script errors like duplicate identifiers / runtime exceptions.
    if (/^Not implemented:/.test(e.message || '')) return;
    errors.push({
      kind: 'jsdomError',
      message: e.message,
      detail: e.detail ? String(e.detail.stack || e.detail.message || e.detail) : '',
    });
  });
  vc.on('error', (...args) => errors.push({ kind: 'consoleError', message: args.map(String).join(' ') }));

  const dom = new JSDOM(buildInlinedHtml(), {
    url: 'http://localhost/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
  });

  // Default fetch stub — empty v3 payload. Individual tests that need
  // to drive the auth+data path call authAndBoot() below to seed a token
  // and stub fetch with their fixture data before manually invoking
  // boot(). The v3 doGet response shape is workers/assignments/absences/
  // coverages/archiveV3 plus a legacy passthrough (houses/events/archive)
  // — included here so the stub is byte-compatible with the real server
  // response during the v2→v3 transition window.
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

// Drives the app through auth: seeds a token in localStorage, replaces
// fetch with a stub that serves the given data, then awaits boot() —
// the same function the inline script calls at startup. After this
// returns, the app is on the central view with WORKERS/ASSIGNMENTS/
// ABSENCES/COVERAGES/ARCHIVE_V3 populated and the topbar visible.
// Callers can then navigate via dom.window.go('archive') and inspect
// the DOM.
async function authAndBoot(dom, {
  workers = [], assignments = [], absences = [], coverages = [], archiveV3 = [],
} = {}) {
  const data = {
    workers, assignments, absences, coverages, archiveV3,
    // legacy passthrough — empty in v3-only state
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

test('public/index.html loads with no script errors (catches dup-identifier bugs)', async () => {
  const { dom, errors } = loadPage();
  // Give jsdom a tick to finish executing <script> tags and any
  // microtask queued by boot().
  await new Promise(r => setTimeout(r, 150));
  dom.window.close();

  if (errors.length) {
    const summary = errors.map(e => `[${e.kind}] ${e.message}${e.detail ? '\n  ' + e.detail : ''}`).join('\n');
    assert.fail(`expected no script errors when loading public/index.html, got:\n${summary}`);
  }
});

test('public/index.html exposes EZONE_CALC and the inline script destructures cleanly', async () => {
  const { dom, errors } = loadPage();
  await new Promise(r => setTimeout(r, 150));
  // Sanity check: calc.js really did run (EZONE_CALC populated) and the
  // inline script reached its bottom without throwing. v3 renames the
  // legacy `cost` helper to `assignmentCost` — assert the new surface.
  assert.ok(dom.window.EZONE_CALC, 'window.EZONE_CALC should be set by lib/calc.js');
  assert.equal(typeof dom.window.EZONE_CALC.assignmentCost, 'function');
  assert.equal(typeof dom.window.EZONE_CALC.todayStr, 'function');
  assert.equal(typeof dom.window.EZONE_CALC.houseTotal, 'function');
  assert.equal(typeof dom.window.EZONE_CALC.splitByCategory, 'function');
  dom.window.close();
  assert.equal(errors.length, 0, 'no script errors');
});

// ---------- archive view tests ----------
// The archive lives on a dedicated view reached via the topbar link.
// These tests pin: (1) the dashboard never re-introduces an archive section,
// (2) the archive view renders archive rows sorted newest-first,
// (3) every view is auth-gated by the PIN — no token means the PIN overlay,
//     not the app, regardless of which view someone might try to reach.

// archive_v3 row factory. Distinct from the legacy `archive` shape:
//   - `house` (not `homeHouse`) — v3 collapses to a single house field
//   - `assignmentId` + `workerId` (not `employeeId`)
//   - `employmentType` carries the type code; legacy data uses
//     full_time/part_time via the migration mapper
function arch(over) {
  return Object.assign({
    id: 'a1', assignmentId: '', workerId: 'w1', name: 'Test',
    house: 'ramot', role: 'אחות', roleDetail: '',
    employmentType: 'full_time',
    salary: 18000, pct: 0,
    hourlyRate: 0, estHours: 0, sessionRate: 0, estSessions: 0, retainerAmount: 0,
    notes: '',
    terminationDate: '2026-05-01',
    reasonType: 'התפטרות', reasonDetail: '', archivedAt: '',
  }, over);
}

test('dashboard view does NOT render an archive section anymore', async () => {
  const { dom, errors } = loadPage();
  await authAndBoot(dom, { archiveV3: [arch()] });
  // After boot completes, default view is 'central'. The archive section
  // used to live here as a collapsible — now it's a separate page.
  const archiveTable = dom.window.document.querySelector('.archive-table');
  assert.equal(archiveTable, null,
    'centralView() should not render .archive-table — the archive moved to its own view');
  // Sanity: we ARE on central.
  const h1 = dom.window.document.querySelector('.head h1');
  assert.ok(h1 && /מבט כללי/.test(h1.textContent),
    'expected to be on the central dashboard view by default');
  // The topbar should expose the navigation link.
  const navLink = [...dom.window.document.querySelectorAll('.topbar-link')]
    .find(el => /ארכיב עובדים/.test(el.textContent));
  assert.ok(navLink, 'topbar should expose a navigation link to the archive view');
  dom.window.close();
  assert.equal(errors.length, 0, errors.length ? JSON.stringify(errors) : '');
});

test('archive view renders archive rows from /api/data, sorted newest-first', async () => {
  const { dom, errors } = loadPage();
  await authAndBoot(dom, {
    archiveV3: [
      arch({ id: 'a1', name: 'דנה כהן', terminationDate: '2026-05-01', reasonType: 'התפטרות' }),
      arch({ id: 'a2', name: 'יוסי לוי', terminationDate: '2026-05-15', reasonType: 'פיטורין', house: 'asher' }),
    ],
  });
  dom.window.go('archive');
  // Re-render is synchronous; DOM is up-to-date after go() returns.
  const table = dom.window.document.querySelector('.archive-table');
  assert.ok(table, 'archive-table should be in DOM after navigating to the archive view');
  const rows = table.querySelectorAll('tbody tr');
  assert.equal(rows.length, 2, 'two archive entries should render as two rows');
  // Sort order: newest termination date first → יוסי (2026-05-15) before דנה (2026-05-01).
  assert.equal(rows[0].querySelector('td').textContent.trim(), 'יוסי לוי',
    'rows should be sorted by termination date descending');
  // Sanity: the page header says ארכיב עובדים.
  const h1 = dom.window.document.querySelector('.head h1');
  assert.ok(h1 && /ארכיב עובדים/.test(h1.textContent),
    'archive view header should read "ארכיב עובדים"');
  dom.window.close();
  assert.equal(errors.length, 0, errors.length ? JSON.stringify(errors) : '');
});

test('every view (incl. archive) is gated by the PIN — no token shows the PIN overlay', async () => {
  const { dom, errors } = loadPage(); // boot() runs the no-token branch
  await new Promise(r => setTimeout(r, 80));
  const pinOverlay = dom.window.document.getElementById('pinOverlay');
  const app = dom.window.document.getElementById('app');
  const topbar = dom.window.document.getElementById('topbar');
  assert.equal(pinOverlay.style.display, 'flex',
    'PIN overlay should be visible when there is no session token');
  assert.equal(app.style.display, 'none',
    'app container should stay hidden until auth');
  assert.equal(topbar.style.display, 'none',
    'topbar (and its archive link) should stay hidden until auth');
  // Belt-and-suspenders: no archive content rendered into the (hidden) app.
  assert.equal(dom.window.document.querySelector('.archive-table'), null);
  dom.window.close();
  assert.equal(errors.length, 0, errors.length ? JSON.stringify(errors) : '');
});

// ---------- dashboard join view ("היעדרויות פעילות ברשת") ----------
// Pins: (1) the section renders one row per active absence; (2) linked
// rows show the covering worker + the arrow; (3) orphan rows get the
// .net-orphan class + the ⚠️ ללא מחליף badge; (4) sort puts orphans
// before covered absences; (5) the stat sub-line carries the orphan
// count.

test('dashboard renders the "היעדרויות פעילות ברשת" join section', async () => {
  const { dom, errors } = loadPage();
  // Wide date range so isAbsenceActive(today) is true regardless of
  // when the test runs over the next few months.
  const wide = { startDate: '2026-05-01', endDate: '2026-07-31' };
  await authAndBoot(dom, {
    workers: [
      { id: 'w1', name: 'עידו',  notes: '', createdAt: '' },
      { id: 'w2', name: 'שחר',  notes: '', createdAt: '' },
      { id: 'w3', name: 'דנה',  notes: '', createdAt: '' },
    ],
    // Assignments — give every worker a home so the FK rules in the UI's
    // form filters wouldn't trip. The dashboard JOIN itself doesn't
    // read assignments, but the fixture matches a realistic shape.
    assignments: [
      { id: 'a1', workerId: 'w1', house: 'ramot',  role: 'מטפל/ת', roleDetail: '', employmentType: 'full_time', salary: 1000, pct: 0, hourlyRate: 0, estHours: 0, sessionRate: 0, estSessions: 0, retainerAmount: 0, notes: '', createdAt: '' },
      { id: 'a2', workerId: 'w2', house: 'asher',  role: 'מטפל/ת', roleDetail: '', employmentType: 'full_time', salary: 1000, pct: 0, hourlyRate: 0, estHours: 0, sessionRate: 0, estSessions: 0, retainerAmount: 0, notes: '', createdAt: '' },
      { id: 'a3', workerId: 'w3', house: 'ofroni', role: 'מטפל/ת', roleDetail: '', employmentType: 'full_time', salary: 1000, pct: 0, hourlyRate: 0, estHours: 0, sessionRate: 0, estSessions: 0, retainerAmount: 0, notes: '', createdAt: '' },
    ],
    absences: [
      // Covered: עידו absent at ramot, shahar covers
      { id: 'ab1', workerId: 'w1', house: 'ramot',  ...wide, reasonType: 'חופשה', reasonDetail: '', notes: '', status: 'active', createdAt: '' },
      // Orphan: דנה absent at ofroni, no coverage
      { id: 'ab2', workerId: 'w3', house: 'ofroni', ...wide, reasonType: 'מחלה',  reasonDetail: '', notes: '', status: 'active', createdAt: '' },
    ],
    coverages: [
      // shahar (asher) → ramot, linked to עידו's absence
      { id: 'c1', absenceId: 'ab1', coveringWorkerId: 'w2', coveringHouse: 'asher', receivingHouse: 'ramot', ...wide, extraPayment: 1000, notes: '', createdAt: '' },
    ],
  });

  const doc = dom.window.document;

  // Section heading appears
  const sectionHeads = [...doc.querySelectorAll('.section-head h2')].map(el => el.textContent);
  assert.ok(sectionHeads.some(t => /היעדרויות פעילות ברשת/.test(t)),
    'expected the "היעדרויות פעילות ברשת" section heading on the dashboard');

  // Exactly 2 rows
  const rows = [...doc.querySelectorAll('.net-absence-row')];
  assert.equal(rows.length, 2, 'one row per active absence');

  // Sort: orphan (ab2, דנה) first, then covered (ab1, עידו)
  assert.ok(rows[0].classList.contains('net-orphan'),
    'orphan absence should sort first');
  assert.ok(/דנה/.test(rows[0].textContent), 'first row should be דנה (orphan)');
  assert.ok(/⚠️ ללא מחליף/.test(rows[0].textContent),
    'orphan row should show the "ללא מחליף" badge');

  // Second row: covered → arrow + covering worker name + source house
  assert.ok(!rows[1].classList.contains('net-orphan'));
  assert.ok(/עידו/.test(rows[1].textContent), 'second row should be עידו (covered)');
  assert.ok(/מחליפה:/.test(rows[1].textContent),
    'covered row should include the מחליפה: prefix');
  assert.ok(/שחר/.test(rows[1].textContent),
    'covered row should name the covering worker');
  assert.ok(rows[1].querySelector('.net-arrow'),
    'covered row should render the arrow span');

  // Stat sub-line shows orphan count
  const absStatLabel = [...doc.querySelectorAll('.stat .lbl')]
    .find(el => /נעדרים פעילים היום/.test(el.textContent));
  assert.ok(absStatLabel, 'expected the "נעדרים פעילים היום" stat card');
  const sub = absStatLabel.parentElement.querySelector('.sub');
  assert.ok(/2 פעילות/.test(sub.textContent),
    'stat sub-line should report total active count');
  assert.ok(/1 ללא מחליף/.test(sub.textContent),
    'stat sub-line should report the 1 orphan');

  dom.window.close();
  assert.equal(errors.length, 0, errors.length ? JSON.stringify(errors) : '');
});

test('dashboard join: empty state renders cleanly when no active absences', async () => {
  const { dom, errors } = loadPage();
  await authAndBoot(dom, {});  // all v3 tables empty

  const doc = dom.window.document;
  // The new section still renders, but with the empty-state text.
  assert.ok(
    [...doc.querySelectorAll('.section-head h2')]
      .some(el => /היעדרויות פעילות ברשת/.test(el.textContent)),
    'section heading is always present on the dashboard',
  );
  // No rows; the .empty placeholder takes over.
  assert.equal(doc.querySelectorAll('.net-absence-row').length, 0);
  const empty = [...doc.querySelectorAll('.empty')]
    .find(el => /אין היעדרויות פעילות ברשת/.test(el.textContent));
  assert.ok(empty, 'expected the documented empty-state copy');

  // Sub-line drops the "X ללא מחליף" suffix when orphanCount=0
  const sub = [...doc.querySelectorAll('.stat .lbl')]
    .find(el => /נעדרים פעילים היום/.test(el.textContent))
    .parentElement.querySelector('.sub');
  assert.ok(/0 פעילות/.test(sub.textContent));
  assert.ok(!/ללא מחליף/.test(sub.textContent),
    'sub-line omits the orphan-count piece when 0');

  dom.window.close();
  assert.equal(errors.length, 0, errors.length ? JSON.stringify(errors) : '');
});

// Stub absences (workerId='') are a v3.1 first-class shape — "position
// open, no identified absentee". The dashboard surfaces them with a
// placeholder name so Moran sees the open slot.
test('dashboard join: stub absence renders with "(ללא רישום נעדר/ת)" placeholder', async () => {
  const { dom, errors } = loadPage();
  await authAndBoot(dom, {
    absences: [{
      id: 'abStub', workerId: '', house: 'ramot',
      startDate: '2026-05-01', endDate: '2026-07-31',
      reasonType: 'מחלה', reasonDetail: '', notes: '',
      status: 'active', createdAt: '',
    }],
  });
  const doc = dom.window.document;
  const stub = doc.querySelector('.net-absence-row .net-stub-name');
  assert.ok(stub && /ללא רישום נעדר\/ת/.test(stub.textContent),
    'stub absence should render the placeholder name in .net-stub-name');
  dom.window.close();
  assert.equal(errors.length, 0, errors.length ? JSON.stringify(errors) : '');
});

// ---------- per-house "+ עובד חדש" button ----------
// Worker creation used to be reachable only through the assignment
// form's "+ צור עובד/ת חדש/ה" pseudo-option. Moran couldn't find it
// from the house view. This commit surfaces it as a top-level button
// alongside "+ שיבוץ חדש".

test('house view shows both "+ שיבוץ חדש" and "+ עובד חדש" buttons in the roster section', async () => {
  const { dom, errors } = loadPage();
  await authAndBoot(dom, {});
  dom.window.go('ramot');
  const doc = dom.window.document;

  // Both buttons live in the same section-head as the roster count pill.
  const rosterSection = [...doc.querySelectorAll('.section-head')]
    .find(sh => /צוות הבית/.test(sh.textContent));
  assert.ok(rosterSection, 'expected the "צוות הבית" roster section-head');

  const btnTexts = [...rosterSection.querySelectorAll('button')].map(b => b.textContent.trim());
  assert.ok(btnTexts.some(t => /\+ שיבוץ חדש/.test(t)),
    'roster section should still expose the "+ שיבוץ חדש" button');
  assert.ok(btnTexts.some(t => /\+ עובד חדש/.test(t)),
    'roster section should expose the new "+ עובד חדש" button alongside it');

  dom.window.close();
  assert.equal(errors.length, 0, errors.length ? JSON.stringify(errors) : '');
});

test('"+ עובד חדש" opens the worker dialog in CREATE mode (no workerId)', async () => {
  // jsdom doesn't really click — but openWorker() with no arg is the
  // create path. The button's onclick is `openWorker()` (zero args),
  // so calling it directly is equivalent to a click for our purposes.
  const { dom, errors } = loadPage();
  await authAndBoot(dom, {});
  dom.window.go('ramot');

  const doc = dom.window.document;
  const overlay = doc.getElementById('workerOverlay');
  assert.ok(!overlay.classList.contains('show'),
    'worker overlay should be hidden before button click');

  dom.window.openWorker();  // simulates the button's onclick handler

  assert.ok(overlay.classList.contains('show'),
    'worker overlay should be visible after open');
  assert.equal(doc.getElementById('workerModalTitle').textContent, 'עובד/ת חדש/ה',
    'title should read create-mode header');
  // No worker fields beyond name + notes — confirm via the form body.
  const body = overlay.querySelector('.modal-body');
  const inputs = [...body.querySelectorAll('input, select, textarea')].map(el => el.id);
  assert.deepEqual(inputs, ['w_name', 'w_notes'],
    'create dialog should expose only the worker-level fields');
  // Delete button hidden in create mode.
  assert.equal(doc.getElementById('workerDeleteBtn').style.display, 'none');

  dom.window.close();
  assert.equal(errors.length, 0, errors.length ? JSON.stringify(errors) : '');
});

test('standalone create flow: fill name → save → toast + worker count increments → modal closed', async () => {
  // Full integration through saveWorker(). Stubs fetch to handle both
  // the POST /api/action (createWorker) and the subsequent GET /api/data
  // refresh that saveWorker awaits before re-rendering.
  const { dom, errors } = loadPage();
  await authAndBoot(dom, {});
  dom.window.go('ramot');

  dom.window.openWorker();
  dom.window.document.getElementById('w_name').value = 'דנה כהן';

  const newWorker = { id: 'wNew', name: 'דנה כהן', notes: '', createdAt: '' };
  const refreshed = {
    workers: [newWorker], assignments: [], absences: [], coverages: [], archiveV3: [],
    houses: { ramot: [], asher: [], ofroni: [], rehab: [], pardes: [], sde_eliezer: [], hq: [] },
    events: [], archive: [],
  };
  dom.window.fetch = async (url, init) => {
    if (init && init.method === 'POST'){
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ ok: true, worker: newWorker }),
      };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(refreshed) };
  };

  await dom.window.saveWorker();

  // Modal closed.
  assert.ok(!dom.window.document.getElementById('workerOverlay').classList.contains('show'),
    'worker overlay should close on successful save');

  // Standalone toast — the longer "אפשר להוסיף שיבוץ ידנית" hint.
  const toast = dom.window.document.getElementById('toast');
  assert.match(toast.textContent, /העובד נוסף.*אפשר להוסיף שיבוץ ידנית/,
    'standalone create flow should show the documented toast (different from the in-assignment-form sub-flow toast)');

  // Worker count visibly incremented — the dashboard re-renders after
  // saveWorker; navigate back to verify.
  dom.window.go('central');
  const workerStatVal = [...dom.window.document.querySelectorAll('.stat')]
    .find(el => /סה״כ עובדים/.test(el.textContent))
    .querySelector('.val');
  assert.equal(workerStatVal.textContent.trim(), '1',
    'central stat card should reflect the new worker count');

  dom.window.close();
  assert.equal(errors.length, 0, errors.length ? JSON.stringify(errors) : '');
});

test('worker dialog: inline dup-name warning shows when an existing name is entered (but save still allowed)', async () => {
  const { dom, errors } = loadPage();
  await authAndBoot(dom, {
    workers: [{ id: 'w1', name: 'דנה', notes: '', createdAt: '' }],
  });
  dom.window.go('ramot');
  dom.window.openWorker();

  const doc = dom.window.document;
  const inp = doc.getElementById('w_name');
  const warning = doc.getElementById('w_nameDupWarning');

  // Hidden by default.
  assert.equal(warning.style.display, 'none');

  // Typing a fresh name → still hidden.
  inp.value = 'יוסי';
  dom.window.onWorkerNameInput();
  assert.equal(warning.style.display, 'none');

  // Typing a name that already exists → warning visible (but save not blocked).
  inp.value = 'דנה';
  dom.window.onWorkerNameInput();
  assert.notEqual(warning.style.display, 'none',
    'warning should surface when the name matches an existing worker');
  // workerSaveBtn is still enabled — the warning is soft, not a gate.
  assert.equal(doc.getElementById('workerSaveBtn').disabled, false);

  // Trim trailing whitespace works the same way (exact-trim match).
  inp.value = '  דנה  ';
  dom.window.onWorkerNameInput();
  assert.notEqual(warning.style.display, 'none');

  dom.window.close();
  assert.equal(errors.length, 0, errors.length ? JSON.stringify(errors) : '');
});

test('worker dialog edit mode: editing without changing the name does NOT trigger the dup warning against itself', async () => {
  const { dom, errors } = loadPage();
  await authAndBoot(dom, {
    workers: [{ id: 'w1', name: 'דנה', notes: '', createdAt: '' }],
  });
  dom.window.openWorker('w1');

  const warning = dom.window.document.getElementById('w_nameDupWarning');
  assert.equal(warning.style.display, 'none',
    'opening the dialog on an existing worker must not flag the worker as a dup of itself');

  dom.window.close();
  assert.equal(errors.length, 0, errors.length ? JSON.stringify(errors) : '');
});

test('static audit: no calc.js global is destructured without an alias in the inline script', () => {
  // Belt-and-suspenders catch: this fires even if jsdom can't reproduce the
  // V8 early-error for some future browser-specific reason. A future
  // contributor adding `function foo()` to lib/calc.js and then writing
  // `const { foo } = window.EZONE_CALC` in the inline script would have
  // their PR fail here before they ever opened a browser.
  const calc = fs.readFileSync(path.join(ROOT, 'lib', 'calc.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

  const calcFns = [...calc.matchAll(/^function (\w+)\s*\(/gm)].map(m => m[1]);
  assert.ok(calcFns.length > 0, 'expected at least one top-level function in lib/calc.js');

  const destructureMatch = html.match(/const\s*\{([\s\S]*?)\}\s*=\s*window\.EZONE_CALC\s*;/);
  assert.ok(destructureMatch, 'expected `const { ... } = window.EZONE_CALC` in public/index.html');
  const destructure = destructureMatch[1];

  // For each calc.js global, the destructure must not contain the bare
  // name as a binding (i.e. `name,` or `name }` with no `: alias`).
  const offenders = [];
  for (const name of calcFns) {
    const bareRe = new RegExp(`(^|[\\s,{])${name}\\s*(,|\\}|$)(?!\\s*:)`, 'm');
    if (bareRe.test(destructure)) offenders.push(name);
  }
  assert.deepEqual(offenders, [],
    `These calc.js globals are destructured without renaming and would collide with their global function binding: ${offenders.join(', ')}`);
});
