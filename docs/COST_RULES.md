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
| `totals` | `actualConfirmed`, `estimated`, `projectedTotal`, `missingData` |
| `byHouse[house]` | the same totals, plus `instructorsCost`, `budget`, `instructorsBudget`, `variance`, `instructorsVariance` |
| `rulesApplied` | how many lines each rule produced — a one-glance sanity check |

`actualConfirmed + estimated === projectedTotal`, always, and the houses
always sum to the network. Both are pinned by tests.

`missingData` on `totals` is a **count of lines**, not a sum of shekels: a
line with a missing rate contributes 0 to the money and 1 to this counter.

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
  priced as if always employed and the line carries `missingData:
  ['startDate']` — a wrong start date is worse than a missing one.

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
