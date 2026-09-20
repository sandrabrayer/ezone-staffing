# Data integrity report — how to run it, and what to do with it

`runDataIntegrityReportNow()` is an **editor-run** diagnostic in
`apps-script/Code.gs`. It looks at every staffing tab, lists what does not add
up, and writes the result into the spreadsheet as two tabs Moran can work
from — **«דוח תקינות»** and **«ניקוי נתונים»**. It never touches a data tab:
every write goes through one function that refuses, by name, to write
anywhere except the report tabs it owns.

A third tab, **«שיבוצים חסרים»**, is built by a separate editor function and
goes through the same guarded write path — see
[PAYROLL_VERIFIED_FIXES.md](PAYROLL_VERIFIED_FIXES.md).

---

## Running it

1. Open <https://script.google.com> and open the **ezone-staffing** project.
2. In the function dropdown at the top, choose **`runDataIntegrityReportNow`**.
3. Click **Run**.
4. Open the spreadsheet. Two tabs are now up to date:

| Tab | What it is |
|---|---|
| **«דוח תקינות»** | One row per finding, with the worker's **name**, **house** and **employment type**, a Hebrew «מה לעשות» sentence, and — for a duplicate group — the member ids and the id worth keeping. Overwritten on every run. |
| **«ניקוי נתונים»** | One row per duplicate **group** or record that a decision can act on, with an empty **«החלטה»** column and a dropdown. Overwritten on every run **except** for decisions already entered, which are carried over by their key. |

The Execution log (`Ctrl/Cmd + Enter`) still prints everything, so the run can
also be read without opening the sheet.

### If you want a dated snapshot

Choose **`runDataIntegrityReportToSheetNow`** instead. It does everything
above **and** creates **one new tab** named `IntegrityReport_YYYYMMDD` (or
`IntegrityReport_YYYYMMDD_HHmm` if today's name is already taken), in ASCII
columns, for export and diffing. It only ever *creates* a tab — it never
opens, edits or deletes an existing one. Old snapshot tabs can be deleted by
hand whenever they are no longer wanted.

### Reading it

«דוח תקינות» columns: `חומרה`, `קוד`, `סוג רשומה`, `מזהה`, `שם העובד/ת`,
`בית`, `סוג העסקה`, `סיווג`, `מה לעשות`, `פירוט`, `מזהים בקבוצה`,
`מומלץ לשמור`, `worker_id`, `assignment_id`. Findings are sorted worst first.

Finding **codes** stay ASCII — they are identifiers, not prose. Everything
meant for a person to read is Hebrew.

| Severity | Meaning |
|---|---|
| `error` | the data is internally inconsistent — a number somewhere is wrong |
| `warn` | probably a mistake, and worth Moran's eyes, but the app still works |
| `info` | expected-but-notable; usually nothing to do |

---

## What it checks

| Code | Severity | What it means |
|---|---|---|
| `DUP_WORKER_NAME` | error | Two or more worker rows share a name once padding, double spaces, bidi marks and Hebrew gershayim are normalized away. Almost always the same person entered twice — and therefore **counted twice in payroll**. |
| `DUP_WORKER_PHONE` | error | Two worker rows share a phone number (dashes and spaces ignored). Same story. |
| `DUP_ASSIGNMENT` | error | One worker has more than one assignment row **at the same house**. A second house is legitimate; a second row at the *same* house is a double count. |
| `ORPHAN_ASSIGNMENT` | error | An assignment whose `worker_id` has no row in `workers`. It is silently dropped from every feed and from every name-based view, but still carries cost. |
| `ARCHIVED_STILL_ACTIVE` | error | An assignment exists in **both** `assignments` and `archive_v3`. Its cost is counted twice — once live, once as a pending termination. |
| `FUTURE_START_ACTIVE` | error | The worker's `start_date` is in the future, yet they hold live assignments that are billed today. |
| `INVALID_HOUSE` | error | A house id outside `ramot / asher / ofroni / rehab / pardes / sde_eliezer / hq`. |
| `INVALID_EMPLOYMENT_TYPE` | error | An employment type outside the five frozen values. |
| `NEGATIVE_RATE` | error | A negative salary, rate, retainer or allowance. |
| `BLANK_NAME` | error | A worker row with no name. Every feed skips it. |
| `MISSING_START_DATE` | warn | A worker with live assignments and no `start_date`. The placement is still priced in full — a wrong start date is worse than a missing one — but the cost line is tagged `missingStartDate` and its money is reported in the **missing-data bucket**, never as confirmed or estimated. See `docs/COST_RULES.md`. |
| `MISSING_RATE` | warn | The placement's cost fields are missing or zero for its employment type, so it costs **0** every month: `salary` for full/part time, `hourly_rate` or `est_hours` for hourly, `retainer_amount` for a retainer, or all four rate×count products for `per_session`. Also flags a `part_time` `pct` outside 1–100. |
| `SMOKE_RECORD` | warn | The name looks like a test or demo leftover (`smoke`, `test`, `dummy`, `בדיקה`, `דמו`, `טסט`, …). |
| `NAME_SYNC_RISK` | warn | The name would **fail an exact-match sync** to the coordinators / therapists apps: leading or trailing whitespace, a double space, a bidi control character, a Hebrew geresh/gershayim where the consumer has an ASCII quote, or a curly quote. These are invisible on screen and are the classic cause of "the guide disappeared from the coordinators app". |
| `ABSENCE_OVERLAP` | warn | Two absences overlap for the same worker **and** house. |
| `ORPHAN_ABSENCE` / `ORPHAN_COVERAGE` | warn | The absence's worker, or the coverage's covering worker, has no row in `workers`. |
| `ESTIMATED_START_DATE` | info | The worker's `start_date` was reconstructed from the payroll book (`start_date_source = 'payroll_floor'`), so the true start is that month **or earlier**. No action is required; entering the exact date clears the tag. The row exists so an approximation cannot quietly become the record — see [PAYROLL_VERIFIED_FIXES.md](PAYROLL_VERIFIED_FIXES.md). |
| `WORKER_NO_ASSIGNMENT` | warn / info | A worker with no assignment at all, **cross-checked against `archive_v3`** and classified in the `סיווג` column: `probably_departed` (`info`) when an archived placement exists — the detail names the house and the termination date — or `never_assigned` (`warn`) when there is no trace anywhere. **Nothing is archived automatically on the strength of this**; it is a reading, not a verdict. |
| `UNSTAFFED_POSITION` | info | An absence with no worker: an unstaffed position, not an employee absence. Expected — recorded so the two are not confused. |
| `DANGLING_COVERAGE_LINK` | info | The coverage points at an absence that has since been deleted. The coverage still stands on its own. |
| `ORPHAN_ACTUALS` | info | A `monthly_actuals` row for an assignment that no longer exists (terminated or deleted). Harmless history. |

---

## Duplicates are reported per GROUP, not per row

A duplicate is one question about several rows, so it is one finding. The
`DUP_WORKER_NAME` / `DUP_WORKER_PHONE` row carries:

* `מזהים בקבוצה` — every member id;
* the `פירוט` line — each member's **name, phone, houses, assignment count
  and created timestamp**, so the decision can be made from the report alone;
* `מומלץ לשמור` — the **oldest id that carries assignments**. Merging into an
  empty row would move every placement for nothing. When no member holds a
  placement, the oldest row by `created_at` is recommended and the detail
  says so.

Ten member rows across four real duplicates are therefore **four findings**,
not ten.

---

## «ניקוי נתונים» — deciding, then applying

The worksheet has one row per group or record and one column to fill in:
**«החלטה»**, a dropdown of exactly four values.

| Decision | What `applyCleanupDecisionsForRealNow` does |
|---|---|
| **השאר** | Nothing. The finding is accepted as it is. |
| **מזג** | Keeps the id in `מומלץ לשמור` (or whatever you put there), moves the other members' **assignments, absences and coverages** onto it, then **archives** the emptied worker rows with the reason `merge into <id>`. |
| **העבר לארכיון** | Archives that one worker row, with the «הערה» text as the reason. |
| **תקן** | Nothing automatic — it is a manual edit. The row is reported as needing one. |

The dropdown offered **«העבר לארכיב»** in its first version. That spelling is
no longer offered, but a decision picked while it was is still applied, and a
rebuild rewrites it to «העבר לארכיון» so it never sits in the tab as a value
the dropdown rejects. A worksheet filled in over several days must not lose a
row because the wording changed under it.

Rules that hold whatever the decision says:

* **Nothing is ever deleted.** "Archive" means the worker row is **moved** to
  the append-only `workers_archive` tab, keeping its id, name, phone, notes,
  start date, the decision, the reason, the keeper id and a timestamp.
* **A merge that would place one worker at the same house twice is refused**
  and reported as a conflict — that is exactly the double count the report
  exists to find. Resolve it by hand first.
* **Archiving a worker who still holds a live assignment is refused**, since
  it would orphan that cost. Terminate the placement first.
* **Everything applied is written to the audit log**, one row per field, with
  the reason — the same trail a mutation from the app leaves.
* The functions are **editor-run only**. No HTTP action reaches them, and
  `tests/data-cleanup.test.js` pins that.

### Dry run, always first

```
applyCleanupDecisionsNow()          // DRY RUN — logs the plan, writes nothing
applyCleanupDecisionsForRealNow()   // applies it
```

Both are picked from the **function dropdown** and started with **Run** — no
argument is ever typed, because the Run button always calls with none. That
is why the one that writes has its own name: `applyCleanupDecisionsNow` is
what somebody picks by accident, so it stays a dry run whatever happens, and
`applyCleanupDecisionsForRealNow` says `THIS RUN WRITES …` in its first log
line before doing anything.

Underneath, `dryRun` still defaults to **true** and only the literal `false`
applies anything: `applyCleanupDecisionsNow(true)`, `(1)` and `(null)` are
all dry runs. A dry run reports what it
*would* do — which assignments would move, onto which keeper, which rows
would be archived, and which rows it is skipping and why — and touches
nothing, not even the audit log.

Paste the dry-run log into the ticket or the CHANGELOG entry before applying.

---

## The safe cleanup process

**Never edit the Sheet by hand to fix one of these.** Rows are
position-mapped and headers are append-only; a hand edit in the wrong column
silently corrupts every row below it. Use this four-step process instead.

### 1 · Flag

Run `runDataIntegrityReportNow()`. **«דוח תקינות»** is the work list and
**«ניקוי נתונים»** is the decision sheet. Nothing in the data has changed.

### 2 · Moran confirms

Send Moran the `error` rows first. Each one needs a human decision that no
script can make:

* `DUP_WORKER_NAME` — **are these two people, or one person twice?** Two
  different people really can share a name. If it is one person, **which row
  is the keeper** (the one whose id is already referenced by assignments,
  absences and coverages)?
* `ARCHIVED_STILL_ACTIVE` — did this person actually leave, and on what date?
* `FUTURE_START_ACTIVE` — is the start date wrong, or is the assignment early?
* `MISSING_RATE` — what is the real rate? A zero is not a fix.

Write the decision in the **«החלטה»** column of «ניקוי נתונים». Nothing
proceeds without it: a row left blank is skipped and reported as skipped.

### 3 · Dry run

`applyCleanupDecisionsNow()` covers the decisions above. Any *other* fix ships
as an **editor-run function with `dryRun = true` by default**,
in the same shape as `migrateGuideNamesNow` in the coordinators app and
`dryRunMigrateToV3` / `dryRunMigratePerSessionRatesToThreeRate` here:

* the default call **logs the exact plan** — every row it would touch, the
  before value and the after value — and **writes nothing**;
* only an explicit `dryRun = false` applies it;
* it is **append-only and idempotent**: no row delete, no rename, no header
  reorder, and running it twice changes nothing the second time;
* it is **reversible**: the plan log *is* the rollback instructions.

Paste the dry-run log into the ticket or the CHANGELOG entry before applying.

### 4 · Apply, then re-run

Run `applyCleanupDecisionsForRealNow`, then
run `runDataIntegrityReportNow()` again. The findings you fixed must be gone
and **no new ones may have appeared**. If any did, stop and revert using the
dry-run log and the audit trail — `audit_log` has one row per field changed,
and `workers_archive` still holds every row that was retired.

---

## What this report is *not*

* It is **not** a payroll check. It says a rate is missing, never that a rate
  is wrong.
* It **cannot see the consumer apps.** `NAME_SYNC_RISK` flags names that look
  fragile; it cannot tell you whether the coordinators app currently has a
  matching row.
* It **does not fix anything**, by design. Detection and repair are separate
  so a bad detection can never damage data.
