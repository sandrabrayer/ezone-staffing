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
