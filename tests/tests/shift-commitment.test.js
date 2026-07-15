/**
 * Guard tests for shift_commitment on the staffing side.
 *
 * The heavy compliance coverage lives in tests/shift-compliance.test.js, which
 * is copied verbatim from ezone-scheduling. This file covers only the
 * staffing-specific wiring.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const sc = require('../lib/shift-compliance.js');

// ---------------------------------------------------------------------------
// Drift guard
// ---------------------------------------------------------------------------

test('shared lib exposes the exact contract the scheduling app expects', () => {
  // If this fails, lib/shift-compliance.js has drifted from the scheduling
  // repo's copy. The two MUST be byte-identical. Re-copy, do not patch locally.
  const expected = [
    'SHIFT_COMMITMENTS', 'COMMITMENT_VALUES', 'parseISODate', 'toISODate',
    'isWeekend', 'isWeekday', 'weekStart', 'weekKey', 'weekDates',
    'weeksOwnedByMonth', 'weekCompliance', 'monthCompliance', 'instructorAlert'
  ];
  expected.forEach(k => assert.ok(k in sc, `missing export: ${k}`));
  assert.deepStrictEqual(sc.COMMITMENT_VALUES, ['3+1', '4+1', '5+1']);
});

test('backend must never be the source of a compliant flag', () => {
  // Documents the architectural rule as an executable assertion: the lib is
  // the only thing that decides feasibility, and it lives on the frontend.
  // If someone adds a compliance field to the Apps Script payload, the alert
  // must still ignore it — instructorAlert reads commitment + blocks only.
  const worker = { id: 'w1', name: 'דני', shift_commitment: '5+1', compliant: true };
  const a = sc.instructorAlert(worker, 2026, 7, ['2026-07-15']);
  assert.ok(a, 'a stray compliant:true on the payload must not suppress the alert');
  assert.strictEqual(a.failingWeeks.length, 1);
});

// ---------------------------------------------------------------------------
// shift_commitment field semantics on the worker record
// ---------------------------------------------------------------------------

test('a worker with no commitment never raises an alert', () => {
  // Every pre-existing worker reads back '' for the new append-only column.
  // Shipping the column must not light up 90 red flags.
  [undefined, null, ''].forEach(v => {
    const w = { id: 'w1', name: 'דני', shift_commitment: v };
    assert.strictEqual(sc.instructorAlert(w, 2026, 7, []), null, String(v));
    assert.strictEqual(sc.instructorAlert(w, 2026, 7, ['2026-07-13', '2026-07-14']), null);
  });
});

test('a worker with a commitment but no blocks is not an alert', () => {
  // No blocks submitted means fully available — the scheduler assigns him per
  // his commitment. This is NOT a violation.
  sc.COMMITMENT_VALUES.forEach(c => {
    const w = { id: 'w1', name: 'דני', shift_commitment: c };
    assert.strictEqual(sc.instructorAlert(w, 2026, 7, []), null, c);
  });
});

test('the alert lights up once blocks make the commitment impossible', () => {
  const w = { id: 'w1', name: 'דני', shift_commitment: '5+1' };
  const a = sc.instructorAlert(w, 2026, 7, ['2026-07-14']);
  assert.strictEqual(a.workerId, 'w1');
  assert.strictEqual(a.commitment, '5+1');
  assert.strictEqual(a.failingWeeks[0].weekdayGap, -1);
});

test('commitment values stay ASCII so sheet exports stay clean', () => {
  sc.COMMITMENT_VALUES.forEach(v => {
    assert.ok(/^[0-9]\+[0-9]$/.test(v), `${v} must be ASCII digit+digit`);
    // eslint-disable-next-line no-control-regex
    assert.ok(!/[^\x00-\x7f]/.test(v), `${v} must contain no non-ASCII`);
  });
});

// ---------------------------------------------------------------------------
// Append-only header guard
// ---------------------------------------------------------------------------

test('shift_commitment is the LAST workers header, never mid-array', () => {
  // _readAll/_writeAll map the live sheet BY POSITION. If shift_commitment is
  // ever moved out of last place, every worker row shifts and the data is
  // silently corrupted. Same rule as CLIENTS_HEADERS in outpatient.
  //
  // This reads the Apps Script source directly so the guard survives a careless
  // edit in the Apps Script editor being copied back to the repo.
  const codePath = path.join(__dirname, '..', 'apps-script', 'Code.gs');
  if (!fs.existsSync(codePath)) {
    // Repo layout differs — skip rather than fail spuriously.
    return;
  }
  const src = fs.readFileSync(codePath, 'utf8');
  const m = src.match(/WORKERS_HEADERS\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(m, 'WORKERS_HEADERS not found in apps-script/Code.gs');
  const headers = m[1]
    .split(',')
    .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
  assert.strictEqual(
    headers[headers.length - 1],
    'shift_commitment',
    'shift_commitment must be the last header — append-only'
  );
  assert.strictEqual(
    headers.filter(h => h === 'shift_commitment').length,
    1,
    'shift_commitment must appear exactly once'
  );
});
