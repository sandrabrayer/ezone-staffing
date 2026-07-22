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
    monthlyActuals: [],
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
  monthlyActuals = [], budgets = [],
} = {}) {
  const data = {
    workers, assignments, absences, coverages, archiveV3, monthlyActuals, budgets,
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

test('worker dialog: shift commitment is instructor-gated and prefilled from the worker', async () => {
  const { dom, errors } = loadPage();
  await authAndBoot(dom, {
    workers: [{ id: 'w1', name: 'משה', notes: '', createdAt: '', shift_commitment: '4+1' }],
    assignments: [{ id: 'a1', workerId: 'w1', house: 'ramot', role: 'מדריך/ה',
      employmentType: 'full_time', salary: 12000 }],
  });
  dom.window.go('ramot');
  const doc = dom.window.document;

  // Open the instructor: field visible, value read off the WORKER (not asg).
  dom.window.openWorker('w1', 'ramot');
  const wrap = doc.getElementById('w_shiftCommitment_wrap');
  const sel = doc.getElementById('w_shiftCommitment');
  assert.ok(!wrap.classList.contains('hidden'), 'instructor role → field visible');
  assert.equal(sel.value, '4+1', 'prefilled from worker.shift_commitment');

  // It must sit ABOVE w_terms so it survives the hidden-terms multi-house case.
  const terms = doc.getElementById('w_terms');
  assert.ok(
    (wrap.compareDocumentPosition(terms) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    'shift commitment field must precede w_terms in the DOM');

  // Switch the role away from מדריך/ה → hidden AND cleared.
  doc.getElementById('w_role').value = 'אחות';
  dom.window.onWorkerRoleChange();
  assert.ok(wrap.classList.contains('hidden'), 'non-instructor role → field hidden');
  assert.equal(sel.value, '', 'value cleared when the field is hidden');

  dom.window.close();
  assert.equal(errors.length, 0, errors.length ? JSON.stringify(errors) : '');
});

test('worker dialog: a non-instructor worker never shows a commitment value', async () => {
  const { dom, errors } = loadPage();
  await authAndBoot(dom, {
    workers: [{ id: 'w2', name: 'נועה', notes: '', createdAt: '', shift_commitment: '' }],
    assignments: [{ id: 'a2', workerId: 'w2', house: 'ramot', role: 'אחות',
      employmentType: 'full_time', salary: 15000 }],
  });
  dom.window.go('ramot');
  const doc = dom.window.document;

  dom.window.openWorker('w2', 'ramot');
  assert.ok(doc.getElementById('w_shiftCommitment_wrap').classList.contains('hidden'),
    'nurse role → commitment field hidden');
  assert.equal(doc.getElementById('w_shiftCommitment').value, '');

  dom.window.close();
  assert.equal(errors.length, 0, errors.length ? JSON.stringify(errors) : '');
});

test('saveWorker sends shift_commitment on the WORKER payload, never on the assignment', async () => {
  const { dom, errors } = loadPage();
  await authAndBoot(dom, {
    workers: [{ id: 'w1', name: 'משה', notes: '', createdAt: '', shift_commitment: '3+1' }],
    assignments: [{ id: 'a1', workerId: 'w1', house: 'ramot', role: 'מדריך/ה',
      employmentType: 'full_time', salary: 12000 }],
  });
  dom.window.go('ramot');
  const doc = dom.window.document;
  dom.window.openWorker('w1', 'ramot');

  // Manager bumps the contractual commitment.
  doc.getElementById('w_shiftCommitment').value = '5+1';

  const posts = [];
  const refreshed = {
    workers: [], assignments: [], absences: [], coverages: [], archiveV3: [],
    houses: { ramot: [], asher: [], ofroni: [], rehab: [], pardes: [], sde_eliezer: [], hq: [] },
    events: [], archive: [],
  };
  dom.window.fetch = async (url, init) => {
    if (init && init.method === 'POST') {
      const body = JSON.parse(init.body);
      posts.push(body);
      if (body.action === 'updateWorker' || body.action === 'createWorker') {
        return { ok: true, status: 200, text: async () => JSON.stringify({
          ok: true, worker: { id: 'w1', name: 'משה', notes: '', shift_commitment: body.worker.shift_commitment } }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, assignment: { id: 'a1' } }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(refreshed) };
  };

  await dom.window.saveWorker();

  const workerPost = posts.find(p => p.action === 'updateWorker');
  assert.ok(workerPost, 'a worker update should be posted');
  assert.equal(workerPost.worker.shift_commitment, '5+1',
    'the commitment must ride on the worker payload');

  const asgPost = posts.find(p => p.action === 'updateAssignment' || p.action === 'addAssignment');
  assert.ok(asgPost, 'an assignment write should be posted');
  assert.equal('shift_commitment' in asgPost.assignment, false,
    'the commitment must NOT be on the assignment object');

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

// ---------- month view (monthly actuals) ----------
// The cost view carries a month picker; hourly / per_session costs reflect
// the selected month's actuals, falling back to the estimate + an "אומדן"
// badge when no actuals exist. Fixed types are unchanged. House + grand
// totals reflect the selected month.

function wk(over) {
  return Object.assign({ id: 'w1', name: 'מדריך בדיקה', notes: '', createdAt: '' }, over);
}
function hourlyAsg(over) {
  return Object.assign({
    id: 'h1', workerId: 'w1', house: 'ramot', role: 'מדריך/ה', roleDetail: '',
    employmentType: 'hourly', salary: 0, pct: 0,
    hourlyRate: 60, estHours: 100, sessionRate: 0, estSessions: 0,
    retainerAmount: 0, allowance: 0, status: 'active', statusDate: '', notes: '',
  }, over);
}
function actualRow(over) {
  return Object.assign({
    id: 'ma1', assignmentId: 'h1', month: '', actualHours: null,
    actualSessions: null, note: '', createdAt: '', updatedAt: '',
  }, over);
}

test('month view: house view renders a month picker defaulting to the current month', async () => {
  const { dom, errors } = loadPage();
  await authAndBoot(dom, { workers: [wk()], assignments: [hourlyAsg()] });
  dom.window.go('ramot');
  const picker = dom.window.document.querySelector('#monthPick');
  assert.ok(picker, 'expected a #monthPick month input in the house view');
  assert.match(picker.value, /^\d{4}-(0[1-9]|1[0-2])$/, 'picker defaults to a YYYY-MM value');
  assert.equal(picker.value, dom.window.EZONE_CALC.currentMonth());
  dom.window.close();
  assert.equal(errors.length, 0, 'no script errors');
});

test('month view: hourly cost falls back to the estimate WITH an אומדן badge when no actuals', async () => {
  const { dom } = loadPage();
  await authAndBoot(dom, { workers: [wk()], assignments: [hourlyAsg()] });
  dom.window.go('ramot');
  const doc = dom.window.document;
  // Estimate = 60 × 100 = 6000. The cost cell should show it and be badged.
  const badge = doc.querySelector('.est-badge');
  assert.ok(badge, 'expected an אומדן badge on the estimate fallback');
  const moneyCells = [...doc.querySelectorAll('#rosterSalaried td.money')];
  assert.ok(moneyCells.some(td => /6,?000/.test(td.textContent)), 'estimate 6000 shown');
  dom.window.close();
});

test('month view: hourly cost uses rate × actualHours when actuals exist for the month (no badge)', async () => {
  const { dom } = loadPage();
  const month = dom.window.EZONE_CALC.currentMonth();
  await authAndBoot(dom, {
    workers: [wk()],
    assignments: [hourlyAsg()],
    monthlyActuals: [actualRow({ month, actualHours: 92 })],
  });
  dom.window.go('ramot');
  const doc = dom.window.document;
  assert.equal(doc.querySelector('.est-badge'), null, 'no אומדן badge when actuals exist');
  const moneyCells = [...doc.querySelectorAll('#rosterSalaried td.money')];
  // 60 × 92 = 5520.
  assert.ok(moneyCells.some(td => /5,?520/.test(td.textContent)), 'actual cost 5520 shown');
  dom.window.close();
});

test('month view: changing the month switches a cell from actual to estimate', async () => {
  const { dom } = loadPage();
  const month = dom.window.EZONE_CALC.currentMonth();
  await authAndBoot(dom, {
    workers: [wk()],
    assignments: [hourlyAsg()],
    monthlyActuals: [actualRow({ month, actualHours: 92 })],
  });
  dom.window.go('ramot');
  const doc = dom.window.document;
  // Current month → actual, no badge.
  assert.equal(doc.querySelector('.est-badge'), null);
  // Switch to a different month with no actuals → estimate + badge.
  const other = month.endsWith('-01') ? month.slice(0, 5) + '02' : month.slice(0, 5) + '01';
  dom.window.onMonthChange(other);
  assert.ok(dom.window.document.querySelector('.est-badge'),
    'switching to a month without actuals shows the estimate badge');
  dom.window.close();
});

test('month view: house total reflects the selected month actuals', async () => {
  const { dom } = loadPage();
  const month = dom.window.EZONE_CALC.currentMonth();
  await authAndBoot(dom, {
    workers: [wk()],
    assignments: [hourlyAsg()],
    monthlyActuals: [actualRow({ month, actualHours: 92 })],
  });
  dom.window.go('ramot');
  const doc = dom.window.document;
  // The accent-less cost stat shows the month total = 5520 (not the 6000 estimate).
  const costStat = [...doc.querySelectorAll('.stat')].find(s => {
    const lbl = s.querySelector('.lbl');
    return lbl && /עלות/.test(lbl.textContent);
  });
  assert.ok(costStat, 'expected a cost stat card');
  assert.match(costStat.querySelector('.val').textContent, /5,?520/,
    'house cost stat reflects the actual, not the estimate');
  dom.window.close();
});

test('month view: fixed-salary cost is unchanged and never badged', async () => {
  const { dom } = loadPage();
  await authAndBoot(dom, {
    workers: [wk({ id: 'w2', name: 'אחות' })],
    assignments: [{
      id: 'ft1', workerId: 'w2', house: 'ramot', role: 'אחות', roleDetail: '',
      employmentType: 'full_time', salary: 18000, pct: 0,
      hourlyRate: 0, estHours: 0, sessionRate: 0, estSessions: 0,
      retainerAmount: 0, allowance: 0, status: 'active', statusDate: '', notes: '',
    }],
  });
  dom.window.go('ramot');
  const doc = dom.window.document;
  assert.equal(doc.querySelector('.est-badge'), null, 'full_time is never an estimate');
  const moneyCells = [...doc.querySelectorAll('#rosterSalaried td.money')];
  assert.ok(moneyCells.some(td => /18,?000/.test(td.textContent)), 'full_time salary shown as-is');
  dom.window.close();
});

// ---------- per_session 3-rate worker modal + leave status ----------

function perSessionAsg(over) {
  return Object.assign({
    id: 'ps1', workerId: 'w1', house: 'ramot', role: 'מטפל/ת', roleDetail: 'אמנות',
    employmentType: 'per_session', salary: 0, pct: 0,
    hourlyRate: 0, estHours: 0, sessionRate: 0, estSessions: 0, retainerAmount: 0,
    rateIndividual: 300, sessionsIndividual: 10,
    rateGroup: 200, sessionsGroup: 4,
    rateExternal: 150, externalPatients: 6,
    allowance: 0, status: 'active', statusDate: '', notes: '',
  }, over);
}

test('per_session modal: shows the three rate groups + a live monthly total', async () => {
  const { dom, errors } = loadPage();
  await authAndBoot(dom, {
    workers: [wk({ id: 'w1', name: 'מטפלת' })],
    assignments: [perSessionAsg()],
  });
  dom.window.openWorker('w1', 'ramot');
  const doc = dom.window.document;
  // The three new groups are visible; the legacy single pair is gone.
  for (const id of ['w_rateIndividual', 'w_sessionsIndividual', 'w_rateGroup',
                    'w_sessionsGroup', 'w_rateExternal', 'w_externalPatients']) {
    const field = doc.getElementById(id).closest('.field');
    assert.ok(!field.classList.contains('hidden'), id + ' should be visible for per_session');
  }
  assert.equal(doc.getElementById('w_sessionRate'), null, 'legacy w_sessionRate input removed');
  // Live total = 300*10 + 200*4 + 150*6 = 4700.
  const totalWrap = doc.getElementById('w_perSessionTotal_wrap');
  assert.ok(!totalWrap.classList.contains('hidden'), 'total shown for per_session');
  assert.match(doc.getElementById('w_perSessionTotal').textContent, /4,?700/);
  dom.window.close();
  assert.equal(errors.length, 0, errors.length ? JSON.stringify(errors) : '');
});

test('per_session modal: editing recomputes the live total as rates change', async () => {
  const { dom } = loadPage();
  await authAndBoot(dom, {
    workers: [wk({ id: 'w1', name: 'מטפלת' })],
    assignments: [perSessionAsg({ rateGroup: 0, sessionsGroup: 0, rateExternal: 0, externalPatients: 0 })],
  });
  dom.window.openWorker('w1', 'ramot');
  const doc = dom.window.document;
  assert.match(doc.getElementById('w_perSessionTotal').textContent, /3,?000/, 'individual-only 300×10');
  doc.getElementById('w_rateGroup').value = '250';
  doc.getElementById('w_sessionsGroup').value = '4';
  dom.window.updateWorkerPerSessionTotal();
  assert.match(doc.getElementById('w_perSessionTotal').textContent, /4,?000/, '3000 + 250×4');
  dom.window.close();
});

test('leave status: saving חל"ד posts status + start date on the assignment', async () => {
  const { dom } = loadPage();
  await authAndBoot(dom, {
    workers: [wk({ id: 'w1', name: 'מטפלת' })],
    assignments: [perSessionAsg()],
  });
  dom.window.openWorker('w1', 'ramot');
  const doc = dom.window.document;
  doc.getElementById('w_status').value = 'chld';
  dom.window.onWorkerStatusChange();
  assert.ok(!doc.getElementById('w_statusDate_wrap').classList.contains('hidden'),
    'selecting חל"ד reveals the start-date field');
  doc.getElementById('w_statusDate').value = '2026-07-01';

  const posts = [];
  dom.window.fetch = async (url, init) => {
    if (init && init.method === 'POST') {
      const body = JSON.parse(init.body);
      posts.push(body);
      const echo = body.action === 'createWorker' || body.action === 'updateWorker'
        ? { ok: true, worker: Object.assign({ id: 'w1' }, body.worker) }
        : { ok: true, assignment: Object.assign({ id: 'ps1' }, body.assignment) };
      return { ok: true, status: 200, text: async () => JSON.stringify(echo), json: async () => echo };
    }
    return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) };
  };
  await dom.window.saveWorker();

  const asgPost = posts.find(p => p.action === 'updateAssignment' || p.action === 'addAssignment');
  assert.ok(asgPost, 'an assignment action was posted');
  assert.equal(asgPost.assignment.status, 'chld', 'status posted');
  assert.equal(asgPost.assignment.statusDate, '2026-07-01', 'leave start date posted');
  // The three rate groups ride along in the same payload.
  assert.equal(asgPost.assignment.rateIndividual, 300);
  assert.equal(asgPost.assignment.sessionsGroup, 4);
  dom.window.close();
});

test('leave status: חל"ד without a start date is blocked with an error toast', async () => {
  const { dom } = loadPage();
  await authAndBoot(dom, {
    workers: [wk({ id: 'w1', name: 'מטפלת' })],
    assignments: [perSessionAsg()],
  });
  dom.window.openWorker('w1', 'ramot');
  const doc = dom.window.document;
  doc.getElementById('w_status').value = 'chld';
  dom.window.onWorkerStatusChange();
  doc.getElementById('w_statusDate').value = '';   // missing

  let posted = false;
  dom.window.fetch = async () => { posted = true; return { ok: true, status: 200, text: async () => '{}' }; };
  await dom.window.saveWorker();
  assert.equal(posted, false, 'save is blocked — nothing posted');
  const toast = doc.getElementById('toast');
  assert.ok(/תאריך/.test(toast.textContent), 'an error toast about the missing date is shown');
  dom.window.close();
});

// ---------- additional-house dropdown ----------

test('additional-house dropdown: defaults to "ללא" (empty value) for a no-op', async () => {
  const { dom } = loadPage();
  await authAndBoot(dom, {
    workers: [wk({ id: 'w1', name: 'מטפלת' })],
    assignments: [perSessionAsg()],
  });
  dom.window.openWorker('w1', 'ramot');
  const doc = dom.window.document;
  const sel = doc.getElementById('w_targetHouse');
  assert.equal(sel.value, '', 'default selection is the empty "ללא" option');
  assert.equal(sel.options[0].textContent, 'ללא');
  // Clicking "add" with "ללא" selected is a guarded no-op (no throw, no post).
  let posted = false;
  dom.window.fetch = async () => { posted = true; return { ok: true, status: 200, text: async () => '{}' }; };
  dom.window.addWorkerHouse();
  assert.equal(posted, false, 'empty additional house does not post');
  dom.window.close();
});

// ---------- budgets (Part 4) ----------
// Central view: a "תקציב מול עלות" section with one row per house
// (budget/cost/variance/status) + a combined summary row. House view: a
// budget line + edit control. Colors: green within, amber over ≤10%,
// red over >10%.

function budgetRow(over) {
  return Object.assign({
    id: 'bud1', house: 'ramot', month: '', amount: 0, createdAt: '', updatedAt: '',
  }, over);
}

test('budgets: central view renders a budget-vs-cost summary table with a combined row', async () => {
  const { dom, errors } = loadPage();
  const month = dom.window.EZONE_CALC.currentMonth();
  await authAndBoot(dom, {
    workers: [wk()],
    assignments: [hourlyAsg()],                        // estimate 6000 at ramot
    budgets: [budgetRow({ house: 'ramot', month, amount: 100000 })],
  });
  const doc = dom.window.document;
  const table = doc.querySelector('.budget-table');
  assert.ok(table, 'expected a .budget-table in the central view');
  const summary = table.querySelector('.bud-summary');
  assert.ok(summary, 'expected a combined summary row');
  dom.window.close();
  assert.equal(errors.length, 0, 'no script errors');
});

test('budgets: cost within budget shows the green (bud-ok) status', async () => {
  const { dom } = loadPage();
  const month = dom.window.EZONE_CALC.currentMonth();
  await authAndBoot(dom, {
    workers: [wk()],
    assignments: [hourlyAsg()],                        // 6000 estimate
    budgets: [budgetRow({ house: 'ramot', month, amount: 100000 })],
  });
  const doc = dom.window.document;
  const ramotRow = [...doc.querySelectorAll('.budget-table tbody tr')]
    .find(tr => /רמות/.test(tr.textContent));
  assert.ok(ramotRow, 'expected a ramot budget row');
  assert.ok(ramotRow.className.includes('bud-ok-row') || ramotRow.querySelector('.bud-ok'),
    'ramot within budget should read as green/ok');
  dom.window.close();
});

test('budgets: cost over budget by >10% shows the red (bud-over) status', async () => {
  const { dom } = loadPage();
  const month = dom.window.EZONE_CALC.currentMonth();
  await authAndBoot(dom, {
    workers: [wk()],
    assignments: [hourlyAsg()],                        // 6000 estimate
    budgets: [budgetRow({ house: 'ramot', month, amount: 5000 })],  // over by 20%
  });
  const doc = dom.window.document;
  const ramotRow = [...doc.querySelectorAll('.budget-table tbody tr')]
    .find(tr => /רמות/.test(tr.textContent));
  assert.ok(ramotRow.querySelector('.bud-over'), 'over budget by >10% should read as red/over');
  dom.window.close();
});

test('budgets: house view shows a budget line + edit control', async () => {
  const { dom } = loadPage();
  const month = dom.window.EZONE_CALC.currentMonth();
  await authAndBoot(dom, {
    workers: [wk()],
    assignments: [hourlyAsg()],
    budgets: [budgetRow({ house: 'ramot', month, amount: 100000 })],
  });
  dom.window.go('ramot');
  const doc = dom.window.document;
  assert.ok(doc.querySelector('.house-budget .bud-line'), 'house view budget line');
  const editBtn = [...doc.querySelectorAll('.house-budget button')]
    .find(b => /תקציב/.test(b.textContent));
  assert.ok(editBtn, 'house view budget edit control');
  dom.window.close();
});

test('budgets: openBudget → saveBudget posts setBudget and updates the view', async () => {
  const { dom } = loadPage();
  await authAndBoot(dom, { workers: [wk()], assignments: [hourlyAsg()] });
  dom.window.go('ramot');

  // Capture the setBudget POST and echo back a budget row (as the server does).
  let posted = null;
  const month = dom.window.EZONE_CALC.currentMonth();
  dom.window.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    posted = body;
    const budget = Object.assign({ id: 'budX', createdAt: '', updatedAt: '' }, body.budget);
    return { ok: true, status: 200,
      text: async () => JSON.stringify({ ok: true, budget }),
      json: async () => ({ ok: true, budget }) };
  };

  dom.window.openBudget('ramot');
  dom.window.document.getElementById('bg_amount').value = '95000';
  await dom.window.saveBudget();

  assert.ok(posted, 'a POST should have been made');
  assert.equal(posted.action, 'setBudget');
  assert.equal(posted.budget.house, 'ramot');
  assert.equal(posted.budget.month, month, 'defaults to the selected month (not default)');
  assert.equal(posted.budget.amount, 95000);
  // Overlay closed after save.
  assert.ok(!dom.window.document.getElementById('budgetOverlay').classList.contains('show'));
  dom.window.close();
});

test('budgets: "כברירת מחדל" checkbox posts month=default', async () => {
  const { dom } = loadPage();
  await authAndBoot(dom, { workers: [wk()], assignments: [hourlyAsg()] });
  dom.window.go('ramot');
  let posted = null;
  dom.window.fetch = async (url, init) => {
    posted = JSON.parse(init.body);
    const budget = Object.assign({ id: 'budX' }, posted.budget);
    return { ok: true, status: 200,
      text: async () => JSON.stringify({ ok: true, budget }),
      json: async () => ({ ok: true, budget }) };
  };
  dom.window.openBudget('ramot');
  dom.window.document.getElementById('bg_amount').value = '80000';
  dom.window.document.getElementById('bg_default').checked = true;
  await dom.window.saveBudget();
  assert.equal(posted.budget.month, 'default');
  dom.window.close();
});

// ---------- instructors budget split (מדריכים sub-row) ----------

test('budgets: house with an instructors budget renders an indented מדריכים sub-row', async () => {
  const { dom, errors } = loadPage();
  const month = dom.window.EZONE_CALC.currentMonth();
  await authAndBoot(dom, {
    workers: [wk()],
    assignments: [hourlyAsg()],   // מדריך/ה hourly, no actuals → 6000 estimate
    budgets: [budgetRow({ house: 'ramot', month, amount: 100000, instructorsAmount: 50000 })],
  });
  const doc = dom.window.document;
  const sub = doc.querySelector('.budget-table .bud-sub');
  assert.ok(sub, 'expected an indented מדריכים sub-row');
  assert.match(sub.textContent, /מדריכים/, 'sub-row labeled מדריכים');
  assert.match(sub.textContent, /אומדן/, 'estimate instructor cost shows the אומדן badge');
  dom.window.close();
  assert.equal(errors.length, 0, 'no script errors');
});

test('budgets: house without an instructors budget renders no sub-row', async () => {
  const { dom } = loadPage();
  const month = dom.window.EZONE_CALC.currentMonth();
  await authAndBoot(dom, {
    workers: [wk()],
    assignments: [hourlyAsg()],
    budgets: [budgetRow({ house: 'ramot', month, amount: 100000 })], // total only
  });
  const doc = dom.window.document;
  assert.equal(doc.querySelector('.budget-table .bud-sub'), null,
    'no instructors budget → no מדריכים sub-row');
  dom.window.close();
});

test('budgets: editor has a תקציב מדריכים input that prefills from the row', async () => {
  const { dom } = loadPage();
  const month = dom.window.EZONE_CALC.currentMonth();
  await authAndBoot(dom, {
    workers: [wk()],
    assignments: [hourlyAsg()],
    budgets: [budgetRow({ house: 'ramot', month, amount: 100000, instructorsAmount: 42000 })],
  });
  dom.window.openBudget('ramot');
  const doc = dom.window.document;
  const instrInput = doc.getElementById('bg_instructors');
  assert.ok(instrInput, 'expected a bg_instructors input');
  assert.equal(String(instrInput.value), '42000', 'prefilled from the existing instructors line');
  dom.window.close();
});

test('budgets: saveBudget posts instructorsAmount alongside the total', async () => {
  const { dom } = loadPage();
  await authAndBoot(dom, { workers: [wk()], assignments: [hourlyAsg()] });
  dom.window.go('ramot');
  let posted = null;
  dom.window.fetch = async (url, init) => {
    posted = JSON.parse(init.body);
    const budget = Object.assign({ id: 'budX' }, posted.budget);
    return { ok: true, status: 200,
      text: async () => JSON.stringify({ ok: true, budget }),
      json: async () => ({ ok: true, budget }) };
  };
  dom.window.openBudget('ramot');
  dom.window.document.getElementById('bg_amount').value = '120000';
  dom.window.document.getElementById('bg_instructors').value = '48000';
  await dom.window.saveBudget();
  assert.equal(posted.budget.amount, 120000);
  assert.equal(posted.budget.instructorsAmount, 48000);
  dom.window.close();
});

test('budgets: blank instructors input posts instructorsAmount=null', async () => {
  const { dom } = loadPage();
  await authAndBoot(dom, { workers: [wk()], assignments: [hourlyAsg()] });
  dom.window.go('ramot');
  let posted = null;
  dom.window.fetch = async (url, init) => {
    posted = JSON.parse(init.body);
    const budget = Object.assign({ id: 'budX' }, posted.budget);
    return { ok: true, status: 200,
      text: async () => JSON.stringify({ ok: true, budget }),
      json: async () => ({ ok: true, budget }) };
  };
  dom.window.openBudget('ramot');
  dom.window.document.getElementById('bg_amount').value = '120000';
  dom.window.document.getElementById('bg_instructors').value = '';
  await dom.window.saveBudget();
  assert.equal(posted.budget.instructorsAmount, null);
  dom.window.close();
});
