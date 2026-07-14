'use strict';

// Regression guard for the "unknown action" bug class.
//
// The frontend (public/index.html) posts actions to the Apps Script
// backend as { action: '<name>' }. The backend (apps-script/Code.gs)
// dispatches them in a switch and throws httpError(400, 'unknown action')
// for anything with no matching `case`. If the frontend ever posts an
// action string that the backend does not handle, the user sees a bare
// "unknown action" toast and the operation silently fails.
//
// This happened with `moveAssignment` (the "מעבר לבית זה" transfer
// button): the frontend posted it but Code.gs had no case for it.
//
// This test parses both files and asserts every action the frontend
// posts is dispatched by the backend.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const gs = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');

// Frontend: collect every action string literal posted, e.g.
//   { action: 'moveAssignment', ... }
//   action: 'setBudget',
function frontendActions() {
  const out = new Set();
  const re = /action:\s*'([A-Za-z0-9_]+)'/g;
  let m;
  while ((m = re.exec(html)) !== null) out.add(m[1]);
  return out;
}

// Backend: collect every dispatched case label, e.g.
//   case 'moveAssignment': return moveAssignment(body);
function backendCases() {
  const out = new Set();
  const re = /case\s+'([A-Za-z0-9_]+)'\s*:/g;
  let m;
  while ((m = re.exec(gs)) !== null) out.add(m[1]);
  return out;
}

test('every frontend action has a backend dispatch case', () => {
  const actions = frontendActions();
  const cases = backendCases();

  assert.ok(actions.size > 0, 'expected to find frontend actions');
  assert.ok(cases.size > 0, 'expected to find backend cases');

  const missing = [...actions].filter((a) => !cases.has(a));
  assert.deepStrictEqual(
    missing,
    [],
    'frontend posts actions with no backend case (would throw "unknown action"): ' +
      missing.join(', ')
  );
});

test('moveAssignment is wired end to end', () => {
  assert.ok(
    /action:\s*'moveAssignment'/.test(html),
    'frontend should post moveAssignment'
  );
  assert.ok(
    /case\s+'moveAssignment'\s*:/.test(gs),
    'backend should dispatch moveAssignment'
  );
  assert.ok(
    /function\s+moveAssignment\s*\(/.test(gs),
    'backend should define moveAssignment()'
  );
});
