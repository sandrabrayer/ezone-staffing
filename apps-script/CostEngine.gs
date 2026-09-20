// ============================================================
// GENERATED FILE — DO NOT EDIT.
//
// A byte-for-byte copy of lib/cost-engine.js, so the Apps Script
// editor functions and the browser price a month with ONE engine.
// Edit lib/cost-engine.js and run:
//
//   node scripts/sync_cost_engine_gs.js
//
// tests/cost-engine-gs-sync.test.js fails if this copy is stale.
//
// The UMD tail assigns globalThis.CostEngine, which is how Code.gs
// reaches it (module is undefined in Apps Script, so the Node branch
// is simply skipped).
// ============================================================
'use strict';

// ============================================================
// E-ZONE staffing — the monthly cost engine.
//
// ONE pure function computes what a month costs. The backend serves raw
// data; the UI renders; nothing else multiplies a rate by a count.
//
//   costForMonth(workers, assignments, absences, coverages, budgets, month, extra)
//
// `extra` (optional) carries the two inputs the brief's signature does not
// name but the calculation needs:
//   { archive, monthlyActuals, prorationMethod, today }
// `archive` is the archive_v3 list — a terminated placement still costs
// money in the months before its termination date, so it cannot be left
// out. `monthlyActuals` is what turns an estimate into a confirmed number.
//
// Returns:
//   {
//     month, daysInMonth, monthStart, monthEnd,
//     lines: [ {                       // one per assignment AND per coverage
//       kind, workerId, assignmentId, house, role, employmentType,
//       cost, source, bucket, rule, basis,
//       daysCounted, daysInMonth, daysEmployed,
//       missingData: [ '...' ], missingStartDate: true|false,
//       startDateSource, startDateEstimated: true|false,
//     } ],
//     hasActuals,                      // did THIS month record any real
//                                      // hours / sessions at all?
//     totals:  { actualConfirmed, estimated, missingDataCost,
//                projectedTotal, missingData },
//     byHouse: { <house>: { ...totals, instructorsCost, budget,
//                           instructorsBudget, variance, instructorsVariance } },
//     rulesApplied: { <RULE>: <count> },
//   }
//
// THREE money buckets, not two. `actualConfirmed` + `estimated` +
// `missingDataCost` = `projectedTotal`, always. The third bucket exists
// because a number computed from incomplete data is neither confirmed nor
// estimated: it is a number nobody should defend until the data is filled
// in. `missingData` stays a COUNT of such lines, as it always was.
//
// EVERY line carries a trace — which rule fired, how many days were
// counted, and whether the number came from a recorded actual, an
// estimate, or nothing at all. That trace is what makes a number arguable
// with Moran instead of merely displayed at her.
//
// Undefined business rules are implemented as the app behaves TODAY and
// named as a constant, so changing one is a one-line decision rather than
// an archaeology expedition. See RULES_TO_CONFIRM at the bottom.
// ============================================================

// Loaded in the browser as a CLASSIC script alongside lib/calc.js, which
// means both files share one global lexical environment. calc.js declares
// SALARIED_TYPES, EMPLOYMENT_TYPES and friends at top level, so this file
// keeps every binding inside a closure and exposes exactly one name:
// module.exports in Node, window.CostEngine in the browser. Without the
// closure the page dies at load with "Identifier ... has already been
// declared" — the bug class tests/page-load.test.js exists to catch.
(function (root, factory) {
  const API = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root) root.CostEngine = API;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---------- frozen enums (mirror lib/validate.js and Code.gs) ----------

  const SALARIED_TYPES = ['full_time', 'part_time', 'hourly'];
  const FREELANCER_TYPES = ['per_session', 'fixed_retainer'];
  const EMPLOYMENT_TYPES = SALARIED_TYPES.concat(FREELANCER_TYPES);

  // Statuses that pay nothing: חל"ד / חל"ת / גמ"ח.
  const UNPAID_STATUSES = ['chld', 'chlt', 'final_settlement'];
  const WORKER_STATUSES = ['active'].concat(UNPAID_STATUSES);

  const ALLOWANCE_VALUES = [0, 2000, 6000];
  const INSTRUCTOR_ROLE = 'מדריך/ה';

  // ---------- named business rules that are NOT settled ----------
  // Each one is the behaviour the app has today. Changing a value here
  // changes the numbers everywhere at once, which is the point.

  // How a month in which the placement was live for only part of the month
  // is priced.
  //   'calendar_days' — cost × (days live in the month / days in month),
  //                     rounded to the nearest shekel. THE DEFAULT.
  //   'none'          — live for any part of the month ⇒ the full month is
  //                     charged.
  //
  // THIS IS THE ONE RULE HERE THAT IS CHOSEN RATHER THAN PRESERVED, and it
  // is deliberate. The app had no behaviour to preserve: it ignored dates
  // entirely and charged every placement a full month in every month, which
  // is the bug being fixed. 'none' cannot satisfy the brief's own
  // requirement that a mid-month transfer must not double count — under it
  // the old house and the new house would each charge a full month for the
  // same person in the same month. Calendar-day proration makes the two
  // halves sum to exactly one month, which is also how payroll reads.
  // 'none' remains available, is tested, and is one line away.
  const PRORATION_METHODS = ['calendar_days', 'none'];
  const PRORATION_METHOD = 'calendar_days';

  // Where a PLACEMENT's own start date comes from, as opposed to the
  // worker's employment start. A transfer ends one assignment and starts
  // another for the same worker, so without a per-placement start the new
  // house would charge from the 1st of the month.
  //   assignment.effectiveFrom  — an explicit field, if one is ever appended
  //   assignment.createdAt      — the row's creation date, which for a
  //                               transfer IS the transfer date
  //   worker.startDate          — the fallback
  // createdAt only ever matters when it falls INSIDE the month being
  // costed; for every earlier month the placement covers the whole month
  // anyway. A v2-migrated row whose createdAt is the migration date can
  // therefore only skew the one month it was migrated in.
  const ASSIGNMENT_START_SOURCE = 'effectiveFrom_or_createdAt';

  // Whether an unpaid status (חל"ד / חל"ת / גמ"ח) zeroes the WHOLE month or
  // only the days from status_date onward.
  //   'whole_month' — the app's behaviour today.
  //   'from_status_date' — charge the days before status_date.
  const LEAVE_PRORATION_METHODS = ['whole_month', 'from_status_date'];
  const LEAVE_PRORATION = 'whole_month';

  // Whether חל"ד (maternity leave) is paid by the employer. Today it is not:
  // חל"ד sits in UNPAID_STATUSES and costs 0. In Israel maternity leave is
  // normally paid by ביטוח לאומי, not the employer, so 0 is the likely
  // correct answer — but it is Moran's call, not this file's.
  const CHLD_PAID_BY_EMPLOYER = false;

  // Whether a logged absence (חופשה / מחלה / …) reduces the month's cost.
  // Today it does not: an absence is a staffing event, and the salary is
  // paid regardless. Only a STATUS (חל"ד / חל"ת) zeroes cost.
  const ABSENCE_REDUCES_COST = false;

  // What a MISSING employment start date does to a line's money.
  //   'missing_data_bucket' — the placement is still counted and still
  //                           priced exactly as before (a wrong start date
  //                           is worse than a missing one), but the line is
  //                           tagged missingStartDate and its cost is
  //                           reported in the missing-data bucket rather
  //                           than in confirmed or estimated. THE DEFAULT.
  //   'always_employed'     — the previous behaviour: the blank date was
  //                           silently read as "employed for the whole of
  //                           history", and the cost landed in
  //                           actualConfirmed as if it were solid.
  // The pricing is identical under both; what changes is whether the number
  // is presented as trustworthy. Thirty workers were being billed for every
  // month of history on the strength of a blank cell, which is a money bug
  // precisely because nothing on screen said so.
  const MISSING_START_DATE_HANDLINGS = ['missing_data_bucket', 'always_employed'];
  const MISSING_START_DATE_HANDLING = 'missing_data_bucket';

  // Whether a month with NO monthly_actuals rows at all may report any
  // confirmed-actual money.
  //   'estimate_only' — it may not: with no real hours or sessions recorded
  //                     anywhere, confirmed is ₪0 and the whole figure is an
  //                     estimate. THE DEFAULT.
  //   'trust_terms'   — contractual amounts (a salary, a retainer, a
  //                     coverage payment) count as confirmed even when no
  //                     actuals exist.
  // A month that records even one actual is unaffected: each line is then
  // bucketed on its own merits, as before.
  const ZERO_ACTUALS_POLICIES = ['estimate_only', 'trust_terms'];
  const ZERO_ACTUALS_POLICY = 'estimate_only';

  // A start date reconstructed from the first month a worker appears in the
  // payroll book is a FLOOR, not a date: the true start is that month or
  // earlier. worker.startDateSource says so, and the line carries it through
  // to the screen.
  //   'price_as_given' — the floor is used exactly like any other start
  //                      date (it is the best information there is), but
  //                      every line it prices is tagged startDateEstimated
  //                      so no view can present the DATE as confirmed.
  //                      THE DEFAULT.
  //   'missing_data'   — treat a floor like a blank date and send the money
  //                      to the missing-data bucket.
  // Why the money is NOT moved by default: for any month after the floor
  // month the start date does not affect the figure at all — the worker is
  // employed for the whole month either way — so demoting a confirmed
  // August actual because January is approximate would make the report less
  // honest, not more. What a floor CAN hide is cost in the months BEFORE
  // it, which is reported as a count rather than guessed at.
  const PAYROLL_FLOOR_HANDLINGS = ['price_as_given', 'missing_data'];
  const PAYROLL_FLOOR_HANDLING = 'price_as_given';
  // The value written in the worker's start_date_source column by
  // applyVerifiedFixesNow. Mirrors START_DATE_SOURCE_PAYROLL_FLOOR in
  // apps-script/Code.gs.
  const START_DATE_SOURCE_PAYROLL_FLOOR = 'payroll_floor';

  // A list for the PR description and for the UI, so these never become
  // silent folklore.
  const RULES_TO_CONFIRM = [
    { id: 'PRORATION_METHOD', value: PRORATION_METHOD,
      question: 'Does a worker who starts, leaves or transfers mid-month cost a full month, or only the days worked? CHOSEN, not preserved: days worked. The app previously ignored dates entirely, so there was no behaviour to keep, and a full month would double count a mid-month transfer.' },
    { id: 'ASSIGNMENT_START_SOURCE', value: ASSIGNMENT_START_SOURCE,
      question: 'A placement\'s own start date is taken from its created_at when no explicit field exists. Is created_at a reliable placement start for rows migrated from v2?' },
    { id: 'LEAVE_PRORATION', value: LEAVE_PRORATION,
      question: 'Does going on חל"ד / חל"ת mid-month zero the whole month, or only from that date? Today: the whole month.' },
    { id: 'CHLD_PAID_BY_EMPLOYER', value: CHLD_PAID_BY_EMPLOYER,
      question: 'Is חל"ד paid by the employer? Today: no, it costs 0.' },
    { id: 'ABSENCE_REDUCES_COST', value: ABSENCE_REDUCES_COST,
      question: 'Does a logged absence reduce the month cost? Today: no, only a status does.' },
    { id: 'COVERAGE_HOUSE', value: 'receiving',
      question: 'A coverage payment is charged to the receiving house, once. Today: yes.' },
    { id: 'MISSING_START_DATE_HANDLING', value: MISSING_START_DATE_HANDLING,
      question: 'A placement whose worker has no start date is still priced in full — but is that cost confirmed money, or missing-data money? Today: missing-data. It is counted in the total and tagged, never silently treated as solid.' },
    { id: 'ZERO_ACTUALS_POLICY', value: ZERO_ACTUALS_POLICY,
      question: 'In a month where no real hours or sessions were recorded at all, may any figure be called confirmed? Today: no — confirmed is ₪0 and the whole month is an estimate.' },
    { id: 'PAYROLL_FLOOR_HANDLING', value: PAYROLL_FLOOR_HANDLING,
      question: 'A start date recovered from the payroll book is a floor (that month or earlier). Today: it prices the month exactly as a known date would, but every line is tagged startDateEstimated so the DATE is never shown as confirmed. Months before the floor may be understated; the report counts those lines.' },
  ];

  // ---------- small helpers ----------

  function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  function isMonth(m) { return MONTH_RE.test(String(m || '')); }
  function isDate(d) { return DATE_RE.test(String(d || '')); }

  // Days in 'YYYY-MM'. Day 0 of the NEXT month is the last day of this one,
  // which also gets February and a leap year right without a special case.
  function daysInMonth(month) {
    const y = Number(String(month).slice(0, 4));
    const m = Number(String(month).slice(5, 7));
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
  }

  function monthStart(month) { return String(month) + '-01'; }
  function monthEnd(month) { return String(month) + '-' + pad2(daysInMonth(month)); }

  // The month a 'YYYY-MM-DD' falls in.
  function monthOf(date) { return String(date || '').slice(0, 7); }

  // Inclusive day count between two 'YYYY-MM-DD' strings; 0 when b < a.
  // December → January crosses a year boundary with no special case because
  // Date.UTC does the arithmetic.
  function daysBetweenInclusive(a, b) {
    if (!isDate(a) || !isDate(b)) return 0;
    if (b < a) return 0;
    const ms = Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z');
    return Math.round(ms / 86400000) + 1;
  }

  function maxDate(a, b) { return a > b ? a : b; }
  function minDate(a, b) { return a < b ? a : b; }

  function normalizeStatus(v) {
    const s = String(v || '').trim();
    return WORKER_STATUSES.indexOf(s) >= 0 ? s : 'active';
  }

  function isUnpaidStatus(status) {
    return UNPAID_STATUSES.indexOf(normalizeStatus(status)) >= 0;
  }

  function allowanceValue(a) {
    const v = num(a && a.allowance);
    return ALLOWANCE_VALUES.indexOf(v) >= 0 ? v : 0;
  }

  function isInstructorRole(role) {
    return String(role || '').trim() === INSTRUCTOR_ROLE;
  }

  // A recorded quantity is usable only when it is a real number. A blank
  // cell reads back as null and means "not recorded", which is NOT the same
  // as a recorded 0 — a therapist who genuinely held 0 sessions this month
  // costs 0, and that is a confirmed number, not an estimate.
  function hasRecorded(v) {
    return v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
  }

  // ---------- base (un-prorated) monthly cost of one placement ----------
  // Returns { cost, source, rule, basis, missingData }.
  //   source 'actual'   — a recorded monthly_actuals row was used
  //          'estimate' — the one-time estimate on the assignment was used
  //          'none'     — nothing to price with
  // `basis` is the human-readable arithmetic, for the trace.

  function baseCost(a, actual) {
    const allowance = allowanceValue(a);
    const type = String(a.employmentType || '');
    const missingData = [];

    if (EMPLOYMENT_TYPES.indexOf(type) < 0) {
      return { cost: 0, source: 'none', rule: 'UNKNOWN_TYPE', basis: 'employment type "' + type + '" is not recognized', missingData: ['employmentType'] };
    }

    if (type === 'full_time') {
      const salary = Math.max(0, num(a.salary));
      if (salary <= 0) missingData.push('salary');
      return {
        cost: Math.round(salary) + allowance,
        source: salary > 0 ? 'actual' : 'none',
        rule: 'FIXED_SALARY',
        basis: 'salary ' + salary + (allowance ? ' + allowance ' + allowance : ''),
        missingData: missingData,
      };
    }

    if (type === 'part_time') {
      // `pct` is an INFORMATIONAL LABEL, not a multiplier. The salary field
      // is the amount actually paid for this placement: Moran types the real
      // per-house amount and splits a multi-house salary herself. Scaling by
      // pct here would silently halve every part-time cost in the app.
      // Mirrors assignmentBaseCost() in lib/calc.js — do not "fix" this.
      const salary = Math.max(0, num(a.salary));
      const pct = num(a.pct);
      if (salary <= 0) missingData.push('salary');
      return {
        cost: Math.round(salary) + allowance,
        source: salary > 0 ? 'actual' : 'none',
        rule: 'FIXED_SALARY',
        basis: 'salary ' + salary + (pct ? ' at a ' + pct + '% role' : '')
          + (allowance ? ' + allowance ' + allowance : ''),
        missingData: missingData,
      };
    }

    if (type === 'fixed_retainer') {
      const amount = Math.max(0, num(a.retainerAmount));
      if (amount <= 0) missingData.push('retainerAmount');
      return {
        cost: Math.round(amount) + allowance,
        source: amount > 0 ? 'actual' : 'none',
        rule: 'RETAINER',
        basis: 'retainer ' + amount + (allowance ? ' + allowance ' + allowance : ''),
        missingData: missingData,
      };
    }

    if (type === 'hourly') {
      const rate = Math.max(0, num(a.hourlyRate));
      if (rate <= 0) missingData.push('hourlyRate');
      if (actual && hasRecorded(actual.actualHours)) {
        const hours = Math.max(0, num(actual.actualHours));
        return {
          cost: Math.round(rate * hours) + allowance,
          source: rate > 0 ? 'actual' : 'none',
          rule: 'HOURLY_ACTUAL',
          basis: 'rate ' + rate + ' x ' + hours + ' recorded hours' + (allowance ? ' + allowance ' + allowance : ''),
          missingData: missingData,
        };
      }
      const est = Math.max(0, num(a.estHours));
      if (est <= 0) missingData.push('estHours');
      return {
        cost: Math.round(rate * est) + allowance,
        source: missingData.length ? 'none' : 'estimate',
        rule: 'HOURLY_ESTIMATE',
        basis: 'rate ' + rate + ' x ' + est + ' estimated hours' + (allowance ? ' + allowance ' + allowance : ''),
        missingData: missingData,
      };
    }

    // per_session: three independent products (individual / group / external)
    // plus the legacy single rate x count pair for rows predating the split.
    const indRate = Math.max(0, num(a.rateIndividual)) || Math.max(0, num(a.sessionRate));
    const grpExt = Math.max(0, num(a.rateGroup)) * Math.max(0, num(a.sessionsGroup))
      + Math.max(0, num(a.rateExternal)) * Math.max(0, num(a.externalPatients));

    if (actual && hasRecorded(actual.actualSessions)) {
      // Actuals record the count of INDIVIDUAL sessions actually held. Group
      // and external have no per-month actuals of their own, so their
      // estimates ride along — which is why the line is only as confirmed as
      // its individual part.
      const sessions = Math.max(0, num(actual.actualSessions));
      if (indRate <= 0) missingData.push('rateIndividual');
      return {
        cost: Math.round(indRate * sessions) + Math.round(grpExt) + allowance,
        source: indRate > 0 ? (grpExt > 0 ? 'estimate' : 'actual') : 'none',
        rule: 'PER_SESSION_ACTUAL',
        basis: 'individual ' + indRate + ' x ' + sessions + ' recorded'
          + (grpExt ? ' + group/external estimate ' + Math.round(grpExt) : '')
          + (allowance ? ' + allowance ' + allowance : ''),
        missingData: missingData,
      };
    }

    const legacy = Math.max(0, num(a.sessionRate)) * Math.max(0, num(a.estSessions));
    const modern = Math.max(0, num(a.rateIndividual)) * Math.max(0, num(a.sessionsIndividual));
    const est = (modern || legacy) + grpExt;
    if (est <= 0) missingData.push('sessionRates');
    return {
      cost: Math.round(est) + allowance,
      source: est > 0 ? 'estimate' : 'none',
      rule: 'PER_SESSION_ESTIMATE',
      basis: 'estimated sessions ' + Math.round(est) + (allowance ? ' + allowance ' + allowance : ''),
      missingData: missingData,
    };
  }

  // ---------- one assignment, one month ----------

  // A placement's own start date: an explicit effectiveFrom, else the date
  // part of created_at, else ''. See ASSIGNMENT_START_SOURCE.
  function assignmentStartDate(a) {
    if (!a) return '';
    if (isDate(a.effectiveFrom)) return a.effectiveFrom;
    const created = String(a.createdAt || '').slice(0, 10);
    return isDate(created) ? created : '';
  }

  function lineForAssignment(ctx, a, opts) {
    const month = ctx.month;
    const mStart = ctx.monthStart;
    const mEnd = ctx.monthEnd;
    const worker = ctx.workerById[a.workerId] || null;
    const missingData = [];

    const line = {
      kind: 'assignment',
      workerId: String(a.workerId || ''),
      assignmentId: String(a.id || ''),
      workerName: worker ? String(worker.name || '') : '',
      house: String(a.house || ''),
      role: String(a.role || ''),
      employmentType: String(a.employmentType || ''),
      status: normalizeStatus(a.status),
      terminated: !!(opts && opts.terminationDate),
      cost: 0,
      source: 'none',
      bucket: 'none',
      rule: '',
      basis: '',
      daysInMonth: ctx.daysInMonth,
      daysCounted: 0,
      daysEmployed: 0,
      missingData: missingData,
      missingStartDate: false,
      // Where the worker's start date came from, and whether that makes the
      // DATE an estimate. '' on every worker whose date was entered by hand.
      startDateSource: '',
      startDateEstimated: false,
    };

    if (!worker) missingData.push('worker');

    // --- employment window ---
    // A blank start date is NOT treated as "starts today": a wrong start date
    // is worse than a missing one, so the placement is priced as if it had
    // always been employed. What it is NOT is trustworthy: the line is
    // tagged, and bucketOf sends its money to missingDataCost instead of
    // letting it pass as confirmed (MISSING_START_DATE_HANDLING).
    const rawStart = worker ? String(worker.startDate || '').trim() : '';
    const employmentStart = isDate(rawStart) ? rawStart : '';
    if (!employmentStart) {
      missingData.push('startDate');
      if (ctx.missingStartDateHandling === 'missing_data_bucket') {
        line.missingStartDate = true;
      }
    }
    // A date recovered from the payroll book is a floor, never a confirmed
    // date — see PAYROLL_FLOOR_HANDLING. The money is priced as given; the
    // tag is what stops any view calling the date solid.
    line.startDateSource = worker ? String(worker.startDateSource || '').trim() : '';
    if (employmentStart && line.startDateSource === START_DATE_SOURCE_PAYROLL_FLOOR) {
      line.startDateEstimated = true;
      if (ctx.payrollFloorHandling === 'missing_data') line.missingStartDate = true;
    }

    // The placement's own start (a transfer's new row starts mid-month) and
    // the worker's employment start are both floors: the later one wins.
    const placementStart = assignmentStartDate(a);
    const startDate = (employmentStart && placementStart)
      ? maxDate(employmentStart, placementStart)
      : (employmentStart || placementStart);
    line.placementStart = placementStart;

    const terminationDate = opts && isDate(opts.terminationDate) ? opts.terminationDate : '';

    if (startDate && startDate > mEnd) {
      line.rule = 'NOT_STARTED';
      line.basis = 'employment starts ' + startDate + ', after ' + month;
      return line;
    }
    // Termination date is the LAST day the placement costs money. A placement
    // terminated on 2026-08-31 costs nothing from September onward.
    if (terminationDate && terminationDate < mStart) {
      line.rule = 'ENDED_BEFORE_MONTH';
      line.basis = 'terminated ' + terminationDate + ', before ' + month;
      return line;
    }

    const effStart = startDate ? maxDate(startDate, mStart) : mStart;
    const effEnd = terminationDate ? minDate(terminationDate, mEnd) : mEnd;
    line.daysEmployed = daysBetweenInclusive(effStart, effEnd);

    // --- unpaid status ---
    if (isUnpaidStatus(a.status)) {
      line.rule = 'UNPAID_STATUS';
      line.basis = 'status ' + normalizeStatus(a.status) + ' is unpaid';
      line.source = 'actual';   // a confirmed zero, not a guess
      if (ctx.leaveProration === 'from_status_date') {
        const sd = isDate(a.statusDate) ? a.statusDate : '';
        if (sd && sd > effStart && sd <= effEnd) {
          const paidDays = daysBetweenInclusive(effStart, ctx.prevDay(sd));
          const base = baseCost(a, ctx.actualFor(a.id));
          line.cost = Math.round(base.cost * paidDays / ctx.daysInMonth);
          line.daysCounted = paidDays;
          line.basis += '; paid through ' + ctx.prevDay(sd);
          base.missingData.forEach(m => missingData.push(m));
          return line;
        }
      }
      return line;
    }

    // --- base cost, then proration ---
    const base = baseCost(a, ctx.actualFor(a.id));
    base.missingData.forEach(m => missingData.push(m));
    line.rule = base.rule;
    line.basis = base.basis;
    line.source = base.source;

    if (line.daysEmployed >= ctx.daysInMonth) {
      line.daysCounted = ctx.daysInMonth;
      line.cost = base.cost;
    } else if (ctx.prorationMethod === 'calendar_days') {
      line.daysCounted = line.daysEmployed;
      line.cost = Math.round(base.cost * line.daysEmployed / ctx.daysInMonth);
      line.basis += '; prorated ' + line.daysEmployed + '/' + ctx.daysInMonth + ' days';
      line.rule = base.rule + '_PRORATED';
    } else {
      // PRORATION_METHOD 'none' — live for any part of the month charges the
      // whole month. daysCounted reports what was billed, daysEmployed the
      // truth, so the trace shows the gap rather than hiding it.
      line.daysCounted = ctx.daysInMonth;
      line.cost = base.cost;
      line.basis += '; live ' + line.daysEmployed + '/' + ctx.daysInMonth
        + ' days, charged in full (PRORATION_METHOD=none)';
    }

    return line;
  }

  // ---------- one coverage, one month ----------
  // The extra payment is charged ONCE, to the RECEIVING house — where the
  // help went — for any month the coverage's own date range touches. It is
  // deliberately not charged to the covering house: that house keeps paying
  // its own worker's assignment, which is already counted.

  function lineForCoverage(ctx, c) {
    const worker = ctx.workerById[c.coveringWorkerId] || null;
    const line = {
      kind: 'coverage',
      workerId: String(c.coveringWorkerId || ''),
      assignmentId: '',
      coverageId: String(c.id || ''),
      workerName: worker ? String(worker.name || '') : '',
      house: String(c.receivingHouse || ''),
      coveringHouse: String(c.coveringHouse || ''),
      role: String(c.role || ''),
      employmentType: '',
      status: 'active',
      terminated: false,
      cost: 0,
      source: 'actual',
      bucket: 'confirmed',
      rule: 'COVERAGE_EXTRA',
      basis: '',
      daysInMonth: ctx.daysInMonth,
      daysCounted: 0,
      daysEmployed: 0,
      missingData: [],
      missingStartDate: false,
    };

    const s = isDate(c.startDate) ? c.startDate : '';
    const e = isDate(c.endDate) ? c.endDate : '';
    if (!s || !e) {
      line.rule = 'COVERAGE_NO_DATES';
      line.missingData.push('dates');
      line.source = 'none';
      return line;
    }
    if (e < ctx.monthStart || s > ctx.monthEnd) {
      line.rule = 'COVERAGE_OUT_OF_MONTH';
      line.basis = s + '..' + e + ' does not touch ' + ctx.month;
      return line;
    }
    if (!line.house) {
      line.rule = 'COVERAGE_NO_RECEIVING_HOUSE';
      line.missingData.push('receivingHouse');
      line.source = 'none';
      line.basis = 'no receiving house — the payment belongs nowhere until it is set';
      return line;
    }
    if (c.cancelled === true || String(c.cancelled || '').toLowerCase() === 'true') {
      line.rule = 'COVERAGE_CANCELLED';
      line.basis = 'cancelled';
      return line;
    }

    line.daysCounted = daysBetweenInclusive(maxDate(s, ctx.monthStart), minDate(e, ctx.monthEnd));
    line.daysEmployed = line.daysCounted;
    line.cost = Math.max(0, Math.round(num(c.extraPayment)));
    line.basis = 'extra payment ' + line.cost + ' to ' + line.house + ' for ' + s + '..' + e;
    return line;
  }

  // ---------- budgets ----------
  // Most specific wins: a row for the exact month overrides the 'default' row.

  function budgetForMonth(budgets, house, month) {
    const list = (budgets || []).filter(b => b && b.house === house);
    const specific = list.find(b => String(b.month) === String(month));
    if (specific) return Math.max(0, num(specific.amount));
    const def = list.find(b => String(b.month) === 'default');
    if (def) return Math.max(0, num(def.amount));
    return null;
  }

  function hasInstructorsBudget(b) {
    if (!b) return false;
    const v = b.instructorsAmount;
    return v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
  }

  // Same specificity rule, except that a month row whose instructors line is
  // blank falls THROUGH to the default — so setting only a total for one
  // month never hides the default instructors budget.
  function instructorsBudgetForMonth(budgets, house, month) {
    const list = (budgets || []).filter(b => b && b.house === house);
    const specific = list.find(b => String(b.month) === String(month));
    if (specific && hasInstructorsBudget(specific)) return Math.max(0, num(specific.instructorsAmount));
    const def = list.find(b => String(b.month) === 'default');
    if (def && hasInstructorsBudget(def)) return Math.max(0, num(def.instructorsAmount));
    return null;
  }

  function varianceOf(budget, cost) {
    const c = Math.max(0, num(cost));
    if (budget === null || budget === undefined) {
      return { budget: null, cost: c, variance: null, pct: null, status: 'none' };
    }
    const b = Math.max(0, num(budget));
    const variance = b - c;
    let pct;
    if (b > 0) pct = Math.round((c / b) * 1000) / 10;
    else pct = c > 0 ? Infinity : 0;
    let status;
    if (c <= b) status = 'ok';
    else if (c <= b * 1.1) status = 'warn';
    else status = 'over';
    return { budget: b, cost: c, variance: variance, pct: pct, status: status };
  }

  // ---------- the engine ----------

  function emptyTotals() {
    return {
      actualConfirmed: 0, estimated: 0, missingDataCost: 0,
      projectedTotal: 0, missingData: 0,
    };
  }

  // Which of the three money buckets a line's cost belongs to. `source` says
  // how the number was PRICED; `bucket` says how much it can be trusted, and
  // those are not the same question:
  //   'missing'   — priced, but a required date is missing. Counted in the
  //                 total, never presented as confirmed or estimated.
  //   'confirmed' — a recorded actual, or a confirmed zero (an unpaid
  //                 status, a placement that had not started).
  //   'estimated' — the one-time estimate on the assignment, or anything at
  //                 all in a month where no actuals were recorded (see
  //                 ZERO_ACTUALS_POLICY).
  //   'none'      — nothing priced it; the line costs 0.
  function bucketOf(line, monthHasActuals) {
    if (line.missingStartDate) return 'missing';
    if (line.source === 'estimate') return 'estimated';
    if (line.source === 'actual') {
      return monthHasActuals ? 'confirmed' : 'estimated';
    }
    return 'none';
  }

  function addToTotals(t, line) {
    if (line.bucket === 'estimated') t.estimated += line.cost;
    else if (line.bucket === 'confirmed') t.actualConfirmed += line.cost;
    else if (line.bucket === 'missing') t.missingDataCost += line.cost;
    if (line.missingData.length) t.missingData += 1;
    t.projectedTotal += line.cost;
  }

  function costForMonth(workers, assignments, absences, coverages, budgets, month, extra) {
    const opts = extra || {};
    const m = isMonth(month) ? String(month) : '';
    if (!m) throw new Error('costForMonth: month must be YYYY-MM');

    const archive = opts.archive || [];
    const actuals = opts.monthlyActuals || [];
    const prorationMethod = PRORATION_METHODS.indexOf(opts.prorationMethod) >= 0
      ? opts.prorationMethod : PRORATION_METHOD;
    const leaveProration = LEAVE_PRORATION_METHODS.indexOf(opts.leaveProration) >= 0
      ? opts.leaveProration : LEAVE_PRORATION;

    const workerById = Object.create(null);
    (workers || []).forEach(w => { if (w && w.id) workerById[w.id] = w; });

    const actualsIndex = Object.create(null);
    let actualsForMonth = 0;
    (actuals || []).forEach(r => {
      if (!r || !r.assignmentId || !r.month) return;
      actualsIndex[r.assignmentId + '|' + r.month] = r;
      if (String(r.month) === m) actualsForMonth += 1;
    });
    // Did this month record ANY real hours or sessions? With monthly_actuals
    // empty, every figure on screen is a projection from the terms on the
    // assignment — and saying so is the difference between a number Moran
    // can sign off and a number she cannot.
    const hasActuals = actualsForMonth > 0 || ZERO_ACTUALS_POLICY !== 'estimate_only';

    const ctx = {
      month: m,
      monthStart: monthStart(m),
      monthEnd: monthEnd(m),
      daysInMonth: daysInMonth(m),
      workerById: workerById,
      prorationMethod: prorationMethod,
      leaveProration: leaveProration,
      missingStartDateHandling: MISSING_START_DATE_HANDLING,
      payrollFloorHandling: PAYROLL_FLOOR_HANDLING,
      actualFor(assignmentId) { return actualsIndex[assignmentId + '|' + m] || null; },
      prevDay(ymd) {
        const t = Date.parse(ymd + 'T00:00:00Z') - 86400000;
        return new Date(t).toISOString().slice(0, 10);
      },
    };

    const lines = [];

    // Live placements. A placement that ALSO has an archive row is already
    // terminated — the archive row carries the termination date and the
    // frozen terms, so the live row is skipped rather than counted twice.
    // (The Phase 0 integrity report flags that state as ARCHIVED_STILL_ACTIVE.)
    const archivedByAssignmentId = Object.create(null);
    (archive || []).forEach(r => {
      if (r && r.assignmentId) archivedByAssignmentId[r.assignmentId] = r;
    });

    (assignments || []).forEach(a => {
      if (!a) return;
      const arc = archivedByAssignmentId[a.id];
      if (arc) return;   // counted once, from the archive row below
      lines.push(lineForAssignment(ctx, a, {}));
    });

    // Terminated placements still cost money in the months before their
    // termination date. The archive row carries the frozen terms, so the
    // reconstruction needs no join back to the live list.
    (archive || []).forEach(r => {
      if (!r) return;
      const a = {
        id: r.assignmentId || r.id,
        workerId: r.workerId,
        house: r.house,
        role: r.role,
        roleDetail: r.roleDetail,
        employmentType: r.employmentType,
        salary: r.salary, pct: r.pct,
        hourlyRate: r.hourlyRate, estHours: r.estHours,
        sessionRate: r.sessionRate, estSessions: r.estSessions,
        retainerAmount: r.retainerAmount,
        allowance: r.allowance,
        status: 'active',
        rateIndividual: r.rateIndividual, sessionsIndividual: r.sessionsIndividual,
        rateGroup: r.rateGroup, sessionsGroup: r.sessionsGroup,
        rateExternal: r.rateExternal, externalPatients: r.externalPatients,
      };
      lines.push(lineForAssignment(ctx, a, { terminationDate: r.terminationDate }));
    });

    // Coverages — counted once each, at the receiving house.
    (coverages || []).forEach(c => { if (c) lines.push(lineForCoverage(ctx, c)); });

    // Absences do not change cost today (ABSENCE_REDUCES_COST=false); they
    // are surfaced as a per-line day count so the UI can explain a number
    // without changing it.
    if (!ABSENCE_REDUCES_COST) {
      const absDays = Object.create(null);
      (absences || []).forEach(x => {
        if (!x || !x.workerId) return;
        const s = isDate(x.startDate) ? x.startDate : '';
        const e = isDate(x.endDate) ? x.endDate : '';
        if (!s || !e) return;
        if (e < ctx.monthStart || s > ctx.monthEnd) return;
        const k = x.workerId + '|' + String(x.house || '');
        absDays[k] = (absDays[k] || 0)
          + daysBetweenInclusive(maxDate(s, ctx.monthStart), minDate(e, ctx.monthEnd));
      });
      lines.forEach(l => {
        if (l.kind !== 'assignment') return;
        l.absenceDays = absDays[l.workerId + '|' + l.house] || 0;
      });
    }

    // ---- bucket every line, then aggregate ----
    // One pass, after every line exists, so assignment lines and coverage
    // lines are bucketed by exactly the same rule.
    lines.forEach(l => { l.bucket = bucketOf(l, hasActuals); });

    const totals = emptyTotals();
    const byHouse = Object.create(null);
    const rulesApplied = Object.create(null);

    lines.forEach(l => {
      rulesApplied[l.rule] = (rulesApplied[l.rule] || 0) + 1;
      addToTotals(totals, l);
      const h = l.house;
      if (!h) return;   // a line with nowhere to go accrues nowhere
      if (!byHouse[h]) {
        byHouse[h] = Object.assign(emptyTotals(), {
          instructorsCost: 0, instructorsEstimated: 0,
          budget: null, instructorsBudget: null,
          variance: null, instructorsVariance: null,
        });
      }
      addToTotals(byHouse[h], l);
      if (l.kind === 'assignment' && isInstructorRole(l.role)) {
        byHouse[h].instructorsCost += l.cost;
        // The אומדן badge asks how the number was PRICED, not which bucket
        // it lands in: a line priced from an estimate still shows the badge
        // even when a missing start date sends its money elsewhere.
        if (l.source === 'estimate') byHouse[h].instructorsEstimated += l.cost;
      }
    });

    // Budgets must be resolved for houses that have one even when they have
    // no cost this month — otherwise an empty house silently loses its
    // budget line instead of showing a full balance.
    (budgets || []).forEach(b => {
      if (!b || !b.house) return;
      if (!byHouse[b.house]) {
        byHouse[b.house] = Object.assign(emptyTotals(), {
          instructorsCost: 0, instructorsEstimated: 0,
          budget: null, instructorsBudget: null,
          variance: null, instructorsVariance: null,
        });
      }
    });

    Object.keys(byHouse).forEach(h => {
      const hb = byHouse[h];
      hb.budget = budgetForMonth(budgets, h, m);
      hb.instructorsBudget = instructorsBudgetForMonth(budgets, h, m);
      hb.variance = varianceOf(hb.budget, hb.projectedTotal);
      hb.instructorsVariance = varianceOf(hb.instructorsBudget, hb.instructorsCost);
    });

    return {
      month: m,
      monthStart: ctx.monthStart,
      monthEnd: ctx.monthEnd,
      daysInMonth: ctx.daysInMonth,
      prorationMethod: prorationMethod,
      leaveProration: leaveProration,
      hasActuals: hasActuals,
      actualsForMonth: actualsForMonth,
      // How many of this month's lines are priced off a payroll-floor start
      // date, and how many were zeroed BECAUSE the floor falls after this
      // month — the second number is the one that may be understating the
      // month, since the true start could be earlier than the floor.
      startDateEstimatedLines: lines.filter(l => l.startDateEstimated).length,
      startDateFloorNotStarted: lines.filter(
        l => l.startDateEstimated && l.rule === 'NOT_STARTED').length,
      lines: lines,
      totals: totals,
      byHouse: byHouse,
      rulesApplied: rulesApplied,
    };
  }

  // ---------- convenience projections for the UI ----------

  // The lines belonging to one house, in render order.
  function linesForHouse(report, house) {
    return report.lines.filter(l => l.house === house);
  }

  // The one line for an assignment, for a roster row's cost cell.
  function lineForAssignmentId(report, assignmentId) {
    return report.lines.find(l => l.kind === 'assignment' && l.assignmentId === assignmentId) || null;
  }

  const API = {
    costForMonth,
    budgetForMonth,
    instructorsBudgetForMonth,
    varianceOf,
    linesForHouse,
    lineForAssignmentId,
    daysInMonth,
    monthStart,
    monthEnd,
    monthOf,
    daysBetweenInclusive,
    baseCost,
    isInstructorRole,
    SALARIED_TYPES,
    FREELANCER_TYPES,
    EMPLOYMENT_TYPES,
    UNPAID_STATUSES,
    INSTRUCTOR_ROLE,
    PRORATION_METHOD,
    PRORATION_METHODS,
    ASSIGNMENT_START_SOURCE,
    assignmentStartDate,
    LEAVE_PRORATION,
    LEAVE_PRORATION_METHODS,
    MISSING_START_DATE_HANDLING,
    MISSING_START_DATE_HANDLINGS,
    ZERO_ACTUALS_POLICY,
    ZERO_ACTUALS_POLICIES,
    PAYROLL_FLOOR_HANDLING,
    PAYROLL_FLOOR_HANDLINGS,
    START_DATE_SOURCE_PAYROLL_FLOOR,
    CHLD_PAID_BY_EMPLOYER,
    ABSENCE_REDUCES_COST,
    RULES_TO_CONFIRM,
  };

  return API;
});
