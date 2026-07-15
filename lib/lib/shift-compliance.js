/**
 * shift-compliance.js
 *
 * Single source of truth for instructor weekly shift-commitment compliance.
 *
 * SHARED FILE — copied VERBATIM into:
 *   - ezone-scheduling/lib/shift-compliance.js   (this repo)
 *   - ezone-staffing/lib/shift-compliance.js
 * Guard tests in BOTH repos must be identical. If you change this file,
 * change it in both and run both test suites. Frontend-only: the backend
 * serves raw blocks and raw commitments, never a computed compliant flag.
 * See EZONE-ECOSYSTEM-STATUS.md — managers bonus two-systems-out-of-sync bug.
 *
 * Model
 * -----
 * Week unit  : Sunday–Saturday. A week straddling a month boundary is ONE
 *              week, counted whole, owned by the month its Sunday falls in.
 * Weekday    : Sunday–Thursday  (JS getDay 0,1,2,3,4)
 * Weekend    : Friday–Saturday  (JS getDay 5,6)
 * Holidays   : treated as ordinary days. The rakezet may override any single
 *              assignment; overrides are per-assignment flags, not calendar rules.
 * Blocks     : dates an instructor declared he cannot work. No blocks on file
 *              means fully available — NOT an alert.
 *
 * All dates are ISO 'YYYY-MM-DD' strings, interpreted as local calendar days.
 * We never construct Date from a bare 'YYYY-MM-DD' (that parses as UTC and
 * shifts a day in +02/+03 Israel); we parse the parts explicitly.
 */

'use strict';

/** Contractual commitment options. Enum — never free text. */
var SHIFT_COMMITMENTS = {
  '3+1': { weekday: 3, weekend: 1 },
  '4+1': { weekday: 4, weekend: 1 },
  '5+1': { weekday: 5, weekend: 1 }
};

var COMMITMENT_VALUES = ['3+1', '4+1', '5+1'];

var WEEKDAY_DAYS = [0, 1, 2, 3, 4]; // Sun–Thu
var WEEKEND_DAYS = [5, 6];          // Fri–Sat

var ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse an ISO date string into a local Date at midnight.
 * Returns null on anything malformed or non-existent (e.g. 2026-02-30).
 */
function parseISODate(iso) {
  if (typeof iso !== 'string' || !ISO_DATE_RE.test(iso)) return null;
  var y = Number(iso.slice(0, 4));
  var m = Number(iso.slice(5, 7));
  var d = Number(iso.slice(8, 10));
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  var dt = new Date(y, m - 1, d);
  // Reject rollovers: new Date(2026,1,30) silently becomes March 2.
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) {
    return null;
  }
  return dt;
}

/** Format a Date as local ISO 'YYYY-MM-DD'. */
function toISODate(dt) {
  var y = String(dt.getFullYear()).padStart(4, '0');
  var m = String(dt.getMonth() + 1).padStart(2, '0');
  var d = String(dt.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

function isWeekend(dt) {
  return WEEKEND_DAYS.indexOf(dt.getDay()) !== -1;
}

function isWeekday(dt) {
  return WEEKDAY_DAYS.indexOf(dt.getDay()) !== -1;
}

/** The Sunday that starts the Sun–Sat week containing `dt`. */
function weekStart(dt) {
  var s = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
  s.setDate(s.getDate() - s.getDay()); // getDay 0 = Sunday
  return s;
}

/** ISO date of the Sunday starting the week containing an ISO date. */
function weekKey(iso) {
  var dt = parseISODate(iso);
  if (!dt) return null;
  return toISODate(weekStart(dt));
}

/** The 7 ISO dates of the Sun–Sat week starting at `sundayISO`. */
function weekDates(sundayISO) {
  var start = parseISODate(sundayISO);
  if (!start) return [];
  var out = [];
  for (var i = 0; i < 7; i++) {
    var d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    out.push(toISODate(d));
  }
  return out;
}

/**
 * Every Sun–Sat week owned by a month.
 * Ownership rule: a week belongs to the month its SUNDAY falls in. So a week
 * beginning Sun Aug 30 belongs to August even though most of it is September.
 *
 * @param {number} year  full year, e.g. 2026
 * @param {number} month 1-12
 * @returns {string[]} ISO dates of each owned week's Sunday, ascending
 */
function weeksOwnedByMonth(year, month) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return [];
  }
  var out = [];
  var cursor = new Date(year, month - 1, 1);
  var last = new Date(year, month, 0).getDate();
  for (var day = 1; day <= last; day++) {
    var dt = new Date(year, month - 1, day);
    if (dt.getDay() === 0) out.push(toISODate(dt));
  }
  // A month can open mid-week; that partial week's Sunday sits in the previous
  // month and is owned there. Nothing to add — by design.
  return out;
}

/**
 * Compliance for ONE Sun–Sat week.
 *
 * @param {string} commitment  '3+1' | '4+1' | '5+1'
 * @param {string} sundayISO   ISO date of the week's Sunday
 * @param {string[]} blocked   ISO dates the instructor blocked (any range; we filter)
 * @returns {object|null} null when there is no commitment on file
 */
function weekCompliance(commitment, sundayISO, blocked) {
  var req = SHIFT_COMMITMENTS[commitment];
  if (!req) return null; // no commitment on file -> no alert, ever

  var dates = weekDates(sundayISO);
  if (dates.length !== 7) return null;

  var blockedSet = Object.create(null);
  (blocked || []).forEach(function (b) {
    if (typeof b === 'string' && ISO_DATE_RE.test(b)) blockedSet[b] = true;
  });

  var availWeekday = 0;
  var availWeekend = 0;
  var blockedInWeek = [];

  dates.forEach(function (iso) {
    var dt = parseISODate(iso);
    if (blockedSet[iso]) {
      blockedInWeek.push(iso);
      return;
    }
    if (isWeekend(dt)) availWeekend++;
    else availWeekday++;
  });

  var weekdayGap = availWeekday - req.weekday;
  var weekendGap = availWeekend - req.weekend;

  return {
    weekStart: sundayISO,
    commitment: commitment,
    requiredWeekday: req.weekday,
    requiredWeekend: req.weekend,
    availableWeekday: availWeekday,
    availableWeekend: availWeekend,
    weekdayGap: weekdayGap,
    weekendGap: weekendGap,
    weekdayShort: weekdayGap < 0,
    weekendShort: weekendGap < 0,
    feasible: weekdayGap >= 0 && weekendGap >= 0,
    blockedDates: blockedInWeek
  };
}

/**
 * Compliance across every week a month owns.
 *
 * @param {string} commitment
 * @param {number} year
 * @param {number} month 1-12
 * @param {string[]} blocked ISO dates
 * @returns {object|null}
 */
function monthCompliance(commitment, year, month, blocked) {
  if (!SHIFT_COMMITMENTS[commitment]) return null;
  var weeks = weeksOwnedByMonth(year, month).map(function (sun) {
    return weekCompliance(commitment, sun, blocked);
  });
  var failing = weeks.filter(function (w) { return !w.feasible; });
  return {
    year: year,
    month: month,
    commitment: commitment,
    weeks: weeks,
    failingWeeks: failing,
    feasible: failing.length === 0
  };
}

/**
 * Alert payload for one instructor, or null when there is nothing to raise.
 * Both apps render from this — same input, same output, no divergence.
 *
 * @param {object} worker { id, name, shift_commitment }
 * @param {number} year
 * @param {number} month 1-12
 * @param {string[]} blocked
 */
function instructorAlert(worker, year, month, blocked) {
  if (!worker || !worker.shift_commitment) return null;
  var res = monthCompliance(worker.shift_commitment, year, month, blocked);
  if (!res || res.feasible) return null;
  return {
    workerId: worker.id,
    workerName: worker.name,
    commitment: worker.shift_commitment,
    year: year,
    month: month,
    failingWeeks: res.failingWeeks.map(function (w) {
      return {
        weekStart: w.weekStart,
        weekdayGap: w.weekdayGap,
        weekendGap: w.weekendGap,
        availableWeekday: w.availableWeekday,
        availableWeekend: w.availableWeekend
      };
    })
  };
}

var api = {
  SHIFT_COMMITMENTS: SHIFT_COMMITMENTS,
  COMMITMENT_VALUES: COMMITMENT_VALUES,
  parseISODate: parseISODate,
  toISODate: toISODate,
  isWeekend: isWeekend,
  isWeekday: isWeekday,
  weekStart: weekStart,
  weekKey: weekKey,
  weekDates: weekDates,
  weeksOwnedByMonth: weeksOwnedByMonth,
  weekCompliance: weekCompliance,
  monthCompliance: monthCompliance,
  instructorAlert: instructorAlert
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else if (typeof window !== 'undefined') {
  // Namespaced to avoid the duplicate-identifier blank-page bug class.
  window.ShiftCompliance = api;
}
