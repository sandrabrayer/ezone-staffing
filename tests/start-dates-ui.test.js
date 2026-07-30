'use strict';

// Source guards for the start-date UI work (public/index.html). The frontend
// has no JS harness for these view builders, so — like the other frontend
// guards in this suite (worker-shift-commitment, action-parity) — we parse
// index.html as text and assert the structural invariants that the three UI
// changes depend on. Behavioural digest logic is covered in tests/digest.test.js.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// ---------------------------------------------------------------------------
// 1. Bulk screen — title + prominent search field
// ---------------------------------------------------------------------------

test('bulk screen title is renamed to וותק ותאריכי קליטה', () => {
  assert.ok(html.includes('<h1>וותק ותאריכי קליטה</h1>'),
    'the start-dates screen h1 must be the new title');
});

test('bulk screen search field is prominent: full-width, 16px, visible border, RTL', () => {
  const m = /<input type="text" id="sdSearch"[^>]*>/.exec(html);
  assert.ok(m, 'a search input with id sdSearch must exist');
  const tag = m[0];
  assert.ok(/dir="rtl"/.test(tag), 'search field must preserve RTL');
  assert.ok(/width:100%/.test(tag), 'search field spans the full row');
  assert.ok(/font-size:16px/.test(tag), 'search field font is 16px');
  assert.ok(/border:1px solid var\(--line-strong\)/.test(tag), 'search field has a visible border');
  assert.ok(/oninput="applyStartDatesFilter\(\)"/.test(tag), 'typing re-applies the combined filter');
});

// ---------------------------------------------------------------------------
// 3. Bulk screen — "הצג רק ללא תאריך" toggle, default off
// ---------------------------------------------------------------------------

test('bulk screen has the "הצג רק ללא תאריך" toggle, unchecked by default', () => {
  const m = /<input type="checkbox" id="sdOnlyMissing"[^>]*>/.exec(html);
  assert.ok(m, 'a checkbox with id sdOnlyMissing must exist');
  assert.ok(!/checked/.test(m[0]), 'the toggle must default to OFF (not checked)');
  assert.ok(html.includes('הצג רק ללא תאריך'), 'the toggle label text must be present');
  assert.ok(/onchange="applyStartDatesFilter\(\)"/.test(m[0]), 'toggling re-applies the filter');
});

test('applyStartDatesFilter combines the name search with the missing-only toggle', () => {
  const fn = html.slice(html.indexOf('function applyStartDatesFilter'),
    html.indexOf('function applyStartDatesFilter') + 700);
  assert.ok(/getElementById\('sdSearch'\)/.test(fn), 'reads the search box');
  assert.ok(/getElementById\('sdOnlyMissing'\)/.test(fn), 'reads the toggle');
  assert.ok(/data-has-date/.test(fn), 'filters on the row\'s data-has-date flag');
});

test('bulk rows carry data-has-date so the toggle needs no WORKERS lookup', () => {
  assert.ok(/<tr id="sdrow_\$\{id\}" data-name="\$\{nameKey\}" data-has-date="\$\{w\.startDate \? '1' : '0'\}">/.test(html),
    'each bulk row must expose data-has-date reflecting whether a date is set');
});

// ---------------------------------------------------------------------------
// 2. Per-house roster — inline-editable start date + "טרם הוזן" badge
// ---------------------------------------------------------------------------

test('roster start-date cell is an inline date input that saves this one worker', () => {
  const fn = html.slice(html.indexOf('function workerStartDateCell'),
    html.indexOf('function saveRosterStartDate'));
  assert.ok(/<input type="date" id="rsd_\$\{id\}"/.test(fn), 'renders a per-worker date input');
  assert.ok(/onchange="saveRosterStartDate\('\$\{id\}'\)"/.test(fn), 'editing saves inline');
  assert.ok(/טרם הוזן/.test(fn), 'an undated worker shows a טרם הוזן badge');
});

test('saveRosterStartDate writes ONLY this worker via setWorkerStartDates', () => {
  const fn = html.slice(html.indexOf('async function saveRosterStartDate'),
    html.indexOf('async function saveRosterStartDate') + 800);
  assert.ok(/action: 'setWorkerStartDates', updates: \[\{ id: workerId, startDate \}\]/.test(fn),
    'single-worker batch — never touches any other worker');
  assert.ok(/workerStartDateCell\(workerId\)/.test(fn), 're-renders the cell so the badge toggles');
});
