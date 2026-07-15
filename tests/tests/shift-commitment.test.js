/**
 * Guard tests for lib/shift-compliance.js
 *
 * SHARED FILE — must be IDENTICAL in ezone-scheduling and ezone-staffing.
 * If these pass in one repo and fail in the other, the shared lib has drifted.
 *
 * Run: node --test tests/
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const sc = require('../lib/shift-compliance.js');

// ---------------------------------------------------------------------------
// Calendar primitives
// ---------------------------------------------------------------------------

test('parseISODate accepts a real date', () => {
  const d = sc.parseISODate('2026-07-15');
  assert.strictEqual(d.getFullYear(), 2026);
  assert.strictEqual(d.getMonth(), 6);
  assert.strictEqual(d.getDate(), 15);
});

test('parseISODate rejects malformed and non-existent dates', () => {
  ['', 'x', '2026-7-15', '15/07/2026', '2026-13-01', '2026-02-30', '2025-02-29']
    .forEach(v => assert.strictEqual(sc.parseISODate(v), null, `should reject ${v}`));
});

test('parseISODate does not shift a day via UTC parsing', () => {
  // The classic bug: new Date('2026-07-15') is UTC midnight -> Jul 15 03:00 in
  // Israel, but in a negative-offset zone it becomes Jul 14. We parse parts.
  assert.strictEqual(sc.toISODate(sc.parseISODate('2026-07-15')), '2026-07-15');
  assert.strictEqual(sc.toISODate(sc.parseISODate('2026-01-01')), '2026-01-01');
});

test('weekend is Friday and Saturday; weekday is Sunday through Thursday', () => {
  // 2026-07-12 is a Sunday.
  const expected = {
    '2026-07-12': 'weekday', // Sun
    '2026-07-13': 'weekday', // Mon
    '2026-07-14': 'weekday', // Tue
    '2026-07-15': 'weekday', // Wed
    '2026-07-16': 'weekday', // Thu
    '2026-07-17': 'weekend', // Fri
    '2026-07-18': 'weekend'  // Sat
  };
  Object.keys(expected).forEach(iso => {
    const dt = sc.parseISODate(iso);
    const got = sc.isWeekend(dt) ? 'weekend' : 'weekday';
    assert.strictEqual(got, expected[iso], iso);
    assert.strictEqual(sc.isWeekday(dt), !sc.isWeekend(dt), iso);
  });
});

test('weekKey maps every day of a week to the same Sunday', () => {
  ['2026-07-12', '2026-07-13', '2026-07-15', '2026-07-17', '2026-07-18']
    .forEach(iso => assert.strictEqual(sc.weekKey(iso), '2026-07-12', iso));
  // The next day starts a new week.
  assert.strictEqual(sc.weekKey('2026-07-19'), '2026-07-19');
});

test('weekDates returns 7 consecutive days starting Sunday', () => {
  assert.deepStrictEqual(sc.weekDates('2026-07-12'), [
    '2026-07-12', '2026-07-13', '2026-07-14', '2026-07-15',
    '2026-07-16', '2026-07-17', '2026-07-18'
  ]);
});

test('weekDates crosses a month boundary correctly', () => {
  // Sun 2026-08-30 -> week runs into September.
  assert.deepStrictEqual(sc.weekDates('2026-08-30'), [
    '2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02',
    '2026-09-03', '2026-09-04', '2026-09-05'
  ]);
});

test('weekDates crosses a year boundary correctly', () => {
  // Sun 2026-12-27 -> week runs into 2027.
  assert.deepStrictEqual(sc.weekDates('2026-12-27'), [
    '2026-12-27', '2026-12-28', '2026-12-29', '2026-12-30',
    '2026-12-31', '2027-01-01', '2027-01-02'
  ]);
});

// ---------------------------------------------------------------------------
// Week ownership — a week belongs to the month its SUNDAY falls in
// ---------------------------------------------------------------------------

test('weeksOwnedByMonth lists every Sunday in the month', () => {
  assert.deepStrictEqual(sc.weeksOwnedByMonth(2026, 7), [
    '2026-07-05', '2026-07-12', '2026-07-19', '2026-07-26'
  ]);
});

test('a week straddling a month boundary is owned by its Sunday month', () => {
  const aug = sc.weeksOwnedByMonth(2026, 8);
  // Sun Aug 30 opens a week that is mostly September — August still owns it.
  assert.ok(aug.includes('2026-08-30'));
  const sep = sc.weeksOwnedByMonth(2026, 9);
  assert.ok(!sep.includes('2026-08-30'));
  // September's first owned week starts Sun Sep 6, not Sep 1 (a Tuesday).
  assert.strictEqual(sep[0], '2026-09-06');
});

test('weeksOwnedByMonth rejects bad input', () => {
  [[2026, 0], [2026, 13], [2026.5, 7], ['2026', 7]].forEach(([y, m]) => {
    assert.deepStrictEqual(sc.weeksOwnedByMonth(y, m), []);
  });
});

// ---------------------------------------------------------------------------
// Week compliance — the core alert math
// ---------------------------------------------------------------------------

test('no blocks means fully available and feasible for every commitment', () => {
  sc.COMMITMENT_VALUES.forEach(c => {
    const r = sc.weekCompliance(c, '2026-07-12', []);
    assert.strictEqual(r.availableWeekday, 5, c);
    assert.strictEqual(r.availableWeekend, 2, c);
    assert.strictEqual(r.feasible, true, c);
  });
});

test('missing commitment yields null — never an alert', () => {
  [null, undefined, '', 'x', '6+1', '3+2', 3].forEach(c => {
    assert.strictEqual(sc.weekCompliance(c, '2026-07-12', []), null, String(c));
  });
});

test('instructor blocking both weekend days is infeasible on weekend', () => {
  const r = sc.weekCompliance('3+1', '2026-07-12', ['2026-07-17', '2026-07-18']);
  assert.strictEqual(r.availableWeekend, 0);
  assert.strictEqual(r.weekendGap, -1);
  assert.strictEqual(r.weekendShort, true);
  assert.strictEqual(r.weekdayShort, false);
  assert.strictEqual(r.feasible, false);
});

test('blocking one weekend day still leaves the single weekend shift feasible', () => {
  const r = sc.weekCompliance('5+1', '2026-07-12', ['2026-07-17']);
  assert.strictEqual(r.availableWeekend, 1);
  assert.strictEqual(r.weekendGap, 0);
  assert.strictEqual(r.feasible, true);
});

test('5+1 is infeasible the moment any weekday is blocked', () => {
  const r = sc.weekCompliance('5+1', '2026-07-12', ['2026-07-14']);
  assert.strictEqual(r.availableWeekday, 4);
  assert.strictEqual(r.weekdayGap, -1);
  assert.strictEqual(r.weekdayShort, true);
  assert.strictEqual(r.feasible, false);
});

test('3+1 tolerates two blocked weekdays, breaks on three', () => {
  const two = sc.weekCompliance('3+1', '2026-07-12', ['2026-07-13', '2026-07-14']);
  assert.strictEqual(two.weekdayGap, 0);
  assert.strictEqual(two.feasible, true);

  const three = sc.weekCompliance('3+1', '2026-07-12',
    ['2026-07-13', '2026-07-14', '2026-07-15']);
  assert.strictEqual(three.weekdayGap, -1);
  assert.strictEqual(three.feasible, false);
});

test('4+1 boundary: exactly one blocked weekday is fine, two is not', () => {
  const one = sc.weekCompliance('4+1', '2026-07-12', ['2026-07-13']);
  assert.strictEqual(one.weekdayGap, 0);
  assert.strictEqual(one.feasible, true);

  const two = sc.weekCompliance('4+1', '2026-07-12', ['2026-07-13', '2026-07-16']);
  assert.strictEqual(two.weekdayGap, -1);
  assert.strictEqual(two.feasible, false);
});

test('weekday and weekend shortfalls are reported independently', () => {
  const r = sc.weekCompliance('5+1', '2026-07-12',
    ['2026-07-13', '2026-07-17', '2026-07-18']);
  assert.strictEqual(r.weekdayShort, true);
  assert.strictEqual(r.weekendShort, true);
  assert.strictEqual(r.weekdayGap, -1);
  assert.strictEqual(r.weekendGap, -1);
  assert.strictEqual(r.feasible, false);
});

test('blocks outside the week are ignored', () => {
  const r = sc.weekCompliance('5+1', '2026-07-12',
    ['2026-07-05', '2026-07-19', '2026-08-01']);
  assert.strictEqual(r.availableWeekday, 5);
  assert.strictEqual(r.availableWeekend, 2);
  assert.deepStrictEqual(r.blockedDates, []);
  assert.strictEqual(r.feasible, true);
});

test('duplicate and malformed blocks do not corrupt the count', () => {
  const r = sc.weekCompliance('4+1', '2026-07-12',
    ['2026-07-13', '2026-07-13', 'garbage', null, undefined, 42]);
  assert.strictEqual(r.availableWeekday, 4);
  assert.deepStrictEqual(r.blockedDates, ['2026-07-13']);
  assert.strictEqual(r.feasible, true);
});

test('blocks landing in the spillover half of a straddling week still count', () => {
  // Week Sun Aug 30 -> Sat Sep 5. Blocking Sep 4 (Fri) + Sep 5 (Sat) kills the
  // weekend shift even though those dates are in the NEXT calendar month.
  const r = sc.weekCompliance('3+1', '2026-08-30', ['2026-09-04', '2026-09-05']);
  assert.strictEqual(r.availableWeekend, 0);
  assert.strictEqual(r.feasible, false);
});

// ---------------------------------------------------------------------------
// Month compliance
// ---------------------------------------------------------------------------

test('monthCompliance covers every owned week and passes when unblocked', () => {
  const r = sc.monthCompliance('4+1', 2026, 7, []);
  assert.strictEqual(r.weeks.length, 4);
  assert.strictEqual(r.feasible, true);
  assert.deepStrictEqual(r.failingWeeks, []);
});

test('monthCompliance flags only the failing week', () => {
  const r = sc.monthCompliance('5+1', 2026, 7, ['2026-07-15']); // Wed, week of Jul 12
  assert.strictEqual(r.feasible, false);
  assert.strictEqual(r.failingWeeks.length, 1);
  assert.strictEqual(r.failingWeeks[0].weekStart, '2026-07-12');
});

test('monthCompliance returns null without a commitment', () => {
  assert.strictEqual(sc.monthCompliance(null, 2026, 7, []), null);
  assert.strictEqual(sc.monthCompliance('9+9', 2026, 7, []), null);
});

test('August owns the straddling week, September does not double-count it', () => {
  const blocked = ['2026-09-04', '2026-09-05']; // Fri+Sat of the Aug-30 week
  const aug = sc.monthCompliance('3+1', 2026, 8, blocked);
  const sep = sc.monthCompliance('3+1', 2026, 9, blocked);
  assert.strictEqual(aug.feasible, false);
  assert.strictEqual(aug.failingWeeks[0].weekStart, '2026-08-30');
  assert.strictEqual(sep.feasible, true); // Sep's own weeks are untouched
});

// ---------------------------------------------------------------------------
// Alert payload — what BOTH apps render
// ---------------------------------------------------------------------------

test('no alert when the instructor has no commitment on file', () => {
  const w = { id: 'w1', name: 'דני', shift_commitment: null };
  assert.strictEqual(sc.instructorAlert(w, 2026, 7, ['2026-07-13']), null);
});

test('no alert when the month is feasible', () => {
  const w = { id: 'w1', name: 'דני', shift_commitment: '3+1' };
  assert.strictEqual(sc.instructorAlert(w, 2026, 7, ['2026-07-13']), null);
});

test('alert carries worker identity and per-week gaps', () => {
  const w = { id: 'w1', name: 'דני', shift_commitment: '5+1' };
  const a = sc.instructorAlert(w, 2026, 7, ['2026-07-15', '2026-07-17', '2026-07-18']);
  assert.strictEqual(a.workerId, 'w1');
  assert.strictEqual(a.workerName, 'דני');
  assert.strictEqual(a.commitment, '5+1');
  assert.strictEqual(a.failingWeeks.length, 1);
  assert.strictEqual(a.failingWeeks[0].weekStart, '2026-07-12');
  assert.strictEqual(a.failingWeeks[0].weekdayGap, -1);
  assert.strictEqual(a.failingWeeks[0].weekendGap, -1);
});

test('instructorAlert tolerates a null worker', () => {
  assert.strictEqual(sc.instructorAlert(null, 2026, 7, []), null);
  assert.strictEqual(sc.instructorAlert({}, 2026, 7, []), null);
});

test('the same inputs give the same alert — both apps cannot diverge', () => {
  const w = { id: 'w9', name: 'רון', shift_commitment: '4+1' };
  const blocked = ['2026-07-13', '2026-07-14'];
  const a = sc.instructorAlert(w, 2026, 7, blocked);
  const b = sc.instructorAlert(w, 2026, 7, blocked.slice());
  assert.deepStrictEqual(a, b);
});
