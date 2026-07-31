'use strict';

// The מבט כללי dashboard search matches workers by name across ALL houses and
// shows a clickable results list (name / house / role) that navigates to the
// worker's house tab and flashes their row. The cross-house match logic is the
// pure `searchWorkers` in lib/calc.js — unit-tested here — plus source guards
// for the DOM wiring in public/index.html.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { searchWorkers } = require('../lib/calc');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

// A small two-house fixture. שחר is placed at two houses; דנה at one; רון has
// no assignment (nowhere to navigate); a1 is orphaned (no worker).
const WORKERS = [
  { id: 'w1', name: 'שחר מזור' },
  { id: 'w2', name: 'דנה כהן' },
  { id: 'w3', name: 'רון לוי' }, // no assignment
];
const ASSIGNMENTS = [
  { id: 'a1', workerId: 'w1', house: 'ramot', role: 'מדריך/ה' },
  { id: 'a2', workerId: 'w1', house: 'rehab', role: 'רכז/ת' },
  { id: 'a3', workerId: 'w2', house: 'asher', role: 'מטפל/ת' },
  { id: 'a9', workerId: 'ghost', house: 'ramot', role: 'מדריך/ה' }, // orphan
];

// ---------------------------------------------------------------------------
// searchWorkers — cross-house match logic (pure)
// ---------------------------------------------------------------------------

test('searchWorkers: matches by name substring, case-insensitive, across houses', () => {
  const out = searchWorkers('שחר', WORKERS, ASSIGNMENTS);
  // שחר is at two houses → two results, one per placement.
  assert.equal(out.length, 2);
  assert.deepEqual(out.map(r => r.house).sort(), ['ramot', 'rehab']);
  out.forEach(r => {
    assert.equal(r.workerId, 'w1');
    assert.equal(r.name, 'שחר מזור');
  });
  // each result carries the house's own role
  const byHouse = Object.fromEntries(out.map(r => [r.house, r.role]));
  assert.equal(byHouse.ramot, 'מדריך/ה');
  assert.equal(byHouse.rehab, 'רכז/ת');
});

test('searchWorkers: a partial / mid-name substring matches', () => {
  assert.equal(searchWorkers('מזור', WORKERS, ASSIGNMENTS).length, 2); // last name
  assert.equal(searchWorkers('כהן', WORKERS, ASSIGNMENTS).length, 1);
});

test('searchWorkers: empty / whitespace query returns nothing', () => {
  assert.deepEqual(searchWorkers('', WORKERS, ASSIGNMENTS), []);
  assert.deepEqual(searchWorkers('   ', WORKERS, ASSIGNMENTS), []);
  assert.deepEqual(searchWorkers(null, WORKERS, ASSIGNMENTS), []);
});

test('searchWorkers: no match returns empty', () => {
  assert.deepEqual(searchWorkers('אבשלום', WORKERS, ASSIGNMENTS), []);
});

test('searchWorkers: orphan assignments (no worker) are skipped', () => {
  // "מדריך" would match the orphan's role but never a name; the orphan has no
  // worker, so it never appears regardless.
  const all = searchWorkers('', WORKERS, ASSIGNMENTS); // empty → []
  assert.equal(all.length, 0);
  const ghost = searchWorkers('שחר', WORKERS, ASSIGNMENTS).find(r => r.workerId === 'ghost');
  assert.equal(ghost, undefined);
});

test('searchWorkers: a worker with no assignment is not returned (nowhere to navigate)', () => {
  assert.deepEqual(searchWorkers('רון', WORKERS, ASSIGNMENTS), []);
});

test('searchWorkers: results are sorted by name then house; shape is name/house/role/ids', () => {
  const workers = [{ id: 'w1', name: 'בני א' }, { id: 'w2', name: 'אבי ב' }];
  const assignments = [
    { id: 'a1', workerId: 'w1', house: 'rehab', role: 'מדריך/ה' },
    { id: 'a2', workerId: 'w1', house: 'ramot', role: 'רכז/ת' },
    { id: 'a3', workerId: 'w2', house: 'asher', role: 'מטפל/ת' },
  ];
  const out = searchWorkers('א', workers, assignments); // 'א' is in both names
  // Name sort: 'אבי ב' before 'בני א'; within בני, house ramot before rehab.
  assert.deepEqual(out.map(r => [r.name, r.house]),
    [['אבי ב', 'asher'], ['בני א', 'ramot'], ['בני א', 'rehab']]);
  assert.deepEqual(out[0], { workerId: 'w2', assignmentId: 'a3', name: 'אבי ב', house: 'asher', role: 'מטפל/ת' });
});

// ---------------------------------------------------------------------------
// Source guards — dashboard search UI wiring
// ---------------------------------------------------------------------------

test('lib/calc exports searchWorkers and index.html aliases it', () => {
  assert.ok(typeof searchWorkers === 'function');
  assert.ok(/searchWorkers: calcSearchWorkers/.test(html), 'index.html must alias calcSearchWorkers');
});

test('dashboard has a prominent RTL search wired to dashboardSearch, with results + body containers', () => {
  const m = /<input type="text" id="dashSearch"[^>]*>/.exec(html);
  assert.ok(m, 'a #dashSearch input must exist');
  const tag = m[0];
  assert.ok(/dir="rtl"/.test(tag), 'RTL preserved');
  assert.ok(/width:100%/.test(tag) && /font-size:16px/.test(tag), 'full-row, 16px');
  assert.ok(/oninput="dashboardSearch\(this\.value\)"/.test(tag), 'typing runs dashboardSearch');
  assert.ok(/id="dashResults"/.test(html), 'a results container exists');
  assert.ok(/id="dashBody"/.test(html), 'the dashboard body is wrapped so it can hide while searching');
});

test('dashboardSearch: empty restores the body; non-empty renders results via calcSearchWorkers', () => {
  const fn = html.slice(html.indexOf('function dashboardSearch'), html.indexOf('function goToWorker'));
  assert.ok(/calcSearchWorkers\(needle, WORKERS, ASSIGNMENTS\)/.test(fn), 'searches all workers × assignments');
  assert.ok(/results\.style\.display = 'none'/.test(fn) && /body\.style\.display = ''/.test(fn),
    'empty query hides results and shows the dashboard');
  assert.ok(/houseName\(m\.house\)/.test(fn), 'results show the house DISPLAY name');
  assert.ok(/dash-result-role/.test(fn) && /dash-result-name/.test(fn), 'results show name + role');
  assert.ok(/goToWorker\('\$\{escapeHtml\(m\.workerId\)\}','\$\{escapeHtml\(m\.house\)\}'\)/.test(fn),
    'clicking a result navigates to that worker + house');
});

test('goToWorker navigates to the house tab and render() flashes the worker row', () => {
  const gtw = html.slice(html.indexOf('function goToWorker'), html.indexOf('function goToWorker') + 220);
  assert.ok(/pendingHighlightWorker = workerId/.test(gtw) && /go\(house\)/.test(gtw),
    'stash the id, then navigate');
  // render() applies the highlight after a house view is built.
  assert.ok(/houseView\(view\); highlightWorkerRow\(\)/.test(html),
    'render must call highlightWorkerRow after a house view');
  // roster rows expose data-worker so the highlight can find them.
  assert.ok(/<tr data-worker="\$\{wId\}"/.test(html), 'roster rows must carry data-worker');
});
