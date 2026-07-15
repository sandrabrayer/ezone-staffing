'use strict';

// Guards for the worker-level shift_commitment field.
//
// shift_commitment is a per-WORKER contractual weekly commitment for
// instructors (madrich): weekday shifts plus one weekend shift. It rides on
// the worker payload alongside name + notes — never on the assignment (a
// madrich has one contract even when he covers at two houses). The enum keys
// are owned by lib/shift-compliance.js; every layer that references them
// must agree, or an instructor's commitment silently fails to round-trip.
//
// These tests parse the source of apps-script/Code.gs and public/index.html
// as text (there's no JS harness for the Apps Script backend) and assert the
// structural invariants that keep the three layers in sync.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const gs = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const sc = require('../lib/shift-compliance');

const ENUM = ['3+1', '4+1', '5+1'];

// ---------------------------------------------------------------------------
// Shared source of truth
// ---------------------------------------------------------------------------

test('shift-compliance SHIFT_COMMITMENTS keys are exactly the enum', () => {
  assert.deepStrictEqual(Object.keys(sc.SHIFT_COMMITMENTS), ENUM);
  assert.deepStrictEqual(sc.COMMITMENT_VALUES, ENUM);
});

// ---------------------------------------------------------------------------
// Backend: apps-script/Code.gs
// ---------------------------------------------------------------------------

test('HEADERS_WORKERS appends shift_commitment LAST (append-only invariant)', () => {
  const m = /const HEADERS_WORKERS = \[([^\]]*)\]/.exec(gs);
  assert.ok(m, 'HEADERS_WORKERS declaration should be present');
  const cols = m[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert.deepStrictEqual(cols, ['id', 'name', 'notes', 'created_at', 'shift_commitment'],
    'a mid-array insert would shift every stored column and corrupt every row');
  assert.strictEqual(cols[cols.length - 1], 'shift_commitment',
    'shift_commitment must be the LAST header');
});

test('Code.gs whitelist constant matches the enum', () => {
  const m = /const SHIFT_COMMITMENT_VALUES = \[([^\]]*)\]/.exec(gs);
  assert.ok(m, 'SHIFT_COMMITMENT_VALUES should be declared in Code.gs');
  const vals = m[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert.deepStrictEqual(vals, ENUM);
});

test('Code.gs has a server-side validator that throws on bad values', () => {
  assert.ok(/function validateShiftCommitment\s*\(/.test(gs),
    'validateShiftCommitment() should be defined');
  assert.ok(/throw httpError\(400, 'bad shift_commitment'\)/.test(gs),
    'validator should throw on values outside the whitelist');
  assert.ok(/validateShiftCommitment\(w\.shift_commitment\)/.test(gs),
    'validateWorker should run the commitment through the validator');
});

test('Code.gs persists + reads back shift_commitment (round-trip)', () => {
  // Written by createWorker's appendRow and updateWorker's setValue...
  assert.ok(/w\.shiftCommitment/.test(gs), 'writers should persist the validated value');
  // ...and surfaced by readWorkersSafe under the shared key name.
  assert.ok(/shift_commitment: String\(r\[4\] \|\| ''\)/.test(gs),
    'readWorkersSafe should read column index 4 as shift_commitment');
});

test('Code.gs does NOT compute a compliance / qualifies flag (raw value only)', () => {
  // The backend serves raw commitments; compliance math lives only in the
  // shared frontend lib. Match computation patterns (calls / assignments),
  // not the word "compliance" in a comment.
  assert.ok(!/(weekCompliance|monthCompliance|instructorAlert)\s*\(/.test(gs),
    'the backend must not call the compliance functions — that is the frontend lib\'s job');
  assert.ok(!/qualifies\s*[:=]/.test(gs),
    'the backend must not compute a qualifies flag');
});

// ---------------------------------------------------------------------------
// Frontend: public/index.html
// ---------------------------------------------------------------------------

test('index.html shift-commitment select sits ABOVE w_terms', () => {
  const selIdx = html.indexOf('id="w_shiftCommitment_wrap"');
  const termsIdx = html.indexOf('<div id="w_terms">');
  assert.ok(selIdx >= 0, 'w_shiftCommitment_wrap should exist');
  assert.ok(termsIdx >= 0, 'w_terms should exist');
  assert.ok(selIdx < termsIdx,
    'the field must precede w_terms so it survives the multi-house hidden-terms case');
});

test('index.html select options use ASCII enum values with Hebrew labels', () => {
  ENUM.forEach(v => {
    assert.ok(new RegExp('<option value="' + v.replace('+', '\\+') + '"').test(html),
      'option value ' + v + ' should be present as an ASCII enum key');
  });
  // The stored VALUES must never contain Hebrew.
  const optRe = /<option value="([^"]*)">/g;
  let m;
  const selBlock = html.slice(html.indexOf('id="w_shiftCommitment"'), html.indexOf('id="w_shiftCommitment"') + 600);
  while ((m = optRe.exec(selBlock)) !== null) {
    assert.ok(!/[֐-׿]/.test(m[1]), 'option value must be ASCII, got: ' + m[1]);
  }
});

test('index.html frontend whitelist matches the enum', () => {
  const m = /const SHIFT_COMMITMENT_VALUES = \[([^\]]*)\]/.exec(html);
  assert.ok(m, 'SHIFT_COMMITMENT_VALUES should be declared in index.html');
  const vals = m[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert.deepStrictEqual(vals, ENUM);
});

test('index.html gates visibility on the instructor role via onWorkerRoleChange', () => {
  const fn = html.slice(html.indexOf('function onWorkerRoleChange'),
    html.indexOf('function onWorkerTypeChange'));
  assert.ok(/w_shiftCommitment_wrap/.test(fn), 'role handler should toggle the wrap');
  assert.ok(/מדריך\/ה/.test(fn), 'visibility should be gated on the מדריך/ה role');
  assert.ok(/getElementById\('w_shiftCommitment'\)\.value = ''/.test(fn),
    'the value should be cleared when the field is hidden');
});
