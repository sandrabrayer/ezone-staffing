# The monthly cost engine — rules, and the ones still to confirm

`lib/cost-engine.js` holds **all** of the staffing app's cost arithmetic.
The Apps Script backend serves raw data; the UI renders; nothing else
multiplies a rate by a count.

```
costForMonth(workers, assignments, absences, coverages, budgets, 'YYYY-MM',
             { archive, monthlyActuals, prorationMethod, leaveProration })
```

`archive` and `monthlyActuals` are not in the brief's signature but the
calculation needs both: a terminated placement still costs money in the
months before its termination date, and a recorded actual is what turns an
estimate into a confirmed number.

---

## What the engine returns

| | |
|---|---|
| `lines[]` | one per assignment **and** one per coverage |
| `totals` | `actualConfirmed`, `estimated`, `missingDataCost`, `projectedTotal`, `missingData` |
| `byHouse[house]` | the same totals, plus `instructorsCost`, `budget`, `instructorsBudget`, `variance`, `instructorsVariance` |
| `rulesApplied` | how many lines each rule produced — a one-glance sanity check |

`actualConfirmed + estimated + missingDataCost === projectedTotal`, always,
and the houses always sum to the network. Both are pinned by tests.

`missingData` on `totals` is a **count of lines**, not a sum of shekels: a
line with a missing rate contributes 0 to the money and 1 to this counter.
`missingDataCost` is the shekels — see the three buckets below.

`hasActuals` says whether **this month** recorded any real hours or sessions
at all, and `actualsForMonth` how many rows. It is per month, not per sheet:
August having data says nothing about September.

### Three money buckets

`source` says how a line was **priced**. `bucket` says how far the number can
be **trusted**, and those are different questions:

| `bucket` | Meaning |
|---|---|
| `confirmed` | a recorded actual, or a confirmed zero such as an unpaid status |
| `estimated` | the estimate on the assignment — or **anything at all** in a month with no recorded actuals |
| `missing` | priced in full, but the worker has **no start date**, so nobody knows since when it accrues |
| `none` | nothing priced it; the line costs 0 |

The third bucket exists because a number computed from incomplete data is
neither confirmed nor an estimate: it is a number nobody should defend until
the gap is filled. It is still **counted in `projectedTotal`** — the worker is
not dropped — and the UI marks every such line with an amber
**«חסר תאריך תחילה»** chip.

### Every line carries a trace

`workerId`, `assignmentId`, `house`, `rule`, `basis`, `source`,
`daysCounted`, `daysEmployed`, `daysInMonth`, `missingData[]`. The UI shows
`rule · basis` as the cost cell's tooltip, so a surprising number can be
explained on the spot instead of being argued about.

| `source` | Meaning |
|---|---|
| `actual` | a recorded `monthly_actuals` row, a fixed salary, or a **known zero** such as an unpaid leave status |
| `estimate` | the one-time estimate on the assignment was used |
| `none` | there was nothing to price with — see `missingData` |

---

## The settled rules

* **A month is only charged for placements that were live in it.** A future
  start costs 0; a placement terminated before the month costs 0; a
  placement terminated *during* or *after* the month costs up to its
  termination date, which is the last paid day.
* **A placement has its own start**, taken from `effectiveFrom` if one is
  ever appended, else the date part of `created_at`, else the worker's
  employment start. Without it a transfer's new house would charge from the
  1st.
* **An assignment that is also in `archive_v3` is counted once**, from the
  archive row — the one carrying the termination date. The Phase 0 integrity
  report flags that state as `ARCHIVED_STILL_ACTIVE`.
* **A coverage's extra payment is charged once, to the receiving house**,
  in any month its own date range touches. The covering house keeps paying
  its own worker's assignment, which is already counted.
* **A recorded `0` is a confirmed zero**, not a fallback to the estimate.
* **An allowance outside the whitelist `0 / 2000 / 6000` is ignored**, never
  charged.
* **`pct` on a `part_time` placement is an informational label, not a
  multiplier.** The `salary` field is the amount actually paid for that
  placement — Moran types the real per-house figure and splits a multi-house
  salary herself. This mirrors `assignmentBaseCost()` in `lib/calc.js`, and a
  parity test pins the two together: an engine that scaled by `pct` would
  have silently halved every part-time cost in the app.
* **The instructors line is a SUBSET of the house total, never an addend.**
  A house at 8,000 with 3,000 of instructors is 8,000, not 11,000. Pinned by
  a test in both the engine and the DOM.
* **The selected month drives the budget too**: a month-specific row wins
  over the `default` row; a month row whose instructors line is blank falls
  through to the default; no row at all means **`אין תקציב`**, not zero.
* **A missing start date is flagged, never guessed at.** The placement is
  priced as if always employed — a wrong start date is worse than a missing
  one — and the line carries `missingData: ['startDate']` **and**
  `missingStartDate: true`, which sends its money to `missingDataCost`
  instead of letting it pass as confirmed. The bill does not move; what
  changes is that the page stops presenting it as solid. See
  `MISSING_START_DATE_HANDLING` below.
* **A month with no recorded actuals reports no confirmed money.** With
  `monthly_actuals` empty for the month, `actualConfirmed` is **₪0**, the
  whole figure sits in `estimated`, and the UI says **«לא הוזנו נתוני אמת»**
  beside it. One recorded row is enough to bucket the month line by line
  again. See `ZERO_ACTUALS_POLICY` below.

---

## Rules to confirm with Moran

Each is a named constant in `lib/cost-engine.js`. Changing one changes every
number at once, which is the point.

### 1 · `PRORATION_METHOD` — currently `'calendar_days'`

**Does a worker who starts, leaves or transfers mid-month cost a full month,
or only the days worked?** Today: **only the days worked**, by calendar days.

**This is the one rule here that was chosen rather than preserved**, and it
needs Moran's yes. The app had no behaviour to preserve — it ignored dates
entirely and charged every placement a full month in every month, which is
precisely the bug being fixed. A full month cannot satisfy the requirement
that a **mid-month transfer must not double count**: the old house and the
new house would each charge a full month for the same person in the same
month. Calendar-day proration makes the two halves sum to exactly one month.

`'none'` is implemented, tested, and one line away if payroll says a partial
month is paid in full.

### 2 · `LEAVE_PRORATION` — currently `'whole_month'`

**Does going on חל"ד or חל"ת mid-month zero the whole month, or only from
that date?** Today: **the whole month**, which is what the app does now.
`'from_status_date'` is implemented and tested, and pays the days before the
status date.

### 3 · `CHLD_PAID_BY_EMPLOYER` — currently `false`

**Is חל"ד paid by the employer?** Today: **no**, it costs 0. In Israel
maternity leave is normally paid by ביטוח לאומי rather than the employer, so
0 is probably right — but it is Moran's call, not the code's.

### 4 · `ABSENCE_REDUCES_COST` — currently `false`

**Does a logged absence reduce the month's cost?** Today: **no**. An absence
is a staffing event; the salary is paid regardless. Only a *status* zeroes
cost. The engine still reports `absenceDays` per line so the UI can explain
a number without changing it.

### 5 · `ASSIGNMENT_START_SOURCE` — currently `'effectiveFrom_or_createdAt'`

**Is `created_at` a reliable placement start for rows migrated from v2?**
It only ever matters when it falls *inside* the month being costed — every
earlier month covers the whole month anyway — so a migrated row can only
skew the single month it was migrated in. If that is a problem, the fix is
an appended `effective_from` column, not a change of rule.

### 6 · Coverage payments go to the receiving house, once

Stated here because it is a money decision, not a technical one. Today: yes.

### 7 · `MISSING_START_DATE_HANDLING` — currently `'missing_data_bucket'`

**A placement whose worker has no start date is still priced in full — but is
that cost confirmed money, or missing-data money?** Today:
**missing-data money**. It is counted in the total, tagged on the line, shown
with an amber «חסר תאריך תחילה» chip, and reported in `missingDataCost`.

The alternative, `'always_employed'`, is what the app did before: the blank
cell was read as "employed for the whole of history" and the cost landed in
`actualConfirmed` as if it were solid. Thirty workers were being billed for
every month of history on the strength of a blank cell, with nothing on
screen saying so. The pricing is identical under both settings; only the
honesty of the presentation changes.

**The fix is not a rule change — it is filling the dates in.** The
«וותק ותאריכי קליטה» screen lists exactly those workers, chip and all.

### 8 · `ZERO_ACTUALS_POLICY` — currently `'estimate_only'`

**In a month where no real hours or sessions were recorded at all, may any
figure be called confirmed?** Today: **no**. `actualConfirmed` is ₪0 and the
whole month is an estimate, labelled «לא הוזנו נתוני אמת».

`monthly_actuals` is currently empty for every month, so this is the state
the app is actually in. The alternative, `'trust_terms'`, would count
contractual amounts — a salary, a retainer, a coverage payment — as confirmed
even with nothing recorded. That is defensible, and it is Moran's call, not
this file's.

### 9 · `PAYROLL_FLOOR_HANDLING` — currently `'price_as_given'`

**A start date recovered from the payroll book is a floor — the true start is
that month or earlier. Does the money it prices stay trustworthy?** Today:
**the money is priced exactly as it would be with a known date, and the DATE
is marked as an estimate everywhere it appears.**

Those dates arrive through `applyVerifiedFixesNow` (see
[PAYROLL_VERIFIED_FIXES.md](PAYROLL_VERIFIED_FIXES.md)) and are stored with
`start_date_source = 'payroll_floor'` on the worker row. The engine copies it
onto every line as `startDateSource` and sets `startDateEstimated`, the UI
shows a grey dashed «תאריך משוער» chip, the roster and «עובדים ללא שיבוץ»
exports carry a «מקור התאריך» column, and the integrity report keeps the
worker visible with an `ESTIMATED_START_DATE` (info) row.

**Why the money is not demoted.** For any month *after* the floor month the
start date does not affect the figure at all — the worker is employed for the
whole month either way — so moving a confirmed August actual into another
bucket because January is approximate would make the report less honest, not
more. What a floor *can* hide is cost in the months *before* it, where the
line reads `NOT_STARTED` and ₪0; those lines are counted in the report as
`startDateFloorNotStarted` rather than guessed at.

The alternative, `'missing_data'`, treats a floor exactly like a blank date
and sends its money to `missingDataCost`. One line to change.

**The fix is not a rule change — it is entering the exact date.** Typing one
on the «וותק ותאריכי קליטה» screen clears the tag automatically, because a
person's answer outranks a reconstruction.
