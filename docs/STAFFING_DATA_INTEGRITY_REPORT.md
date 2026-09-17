# Data integrity report — how to run it, and what to do with it

`runDataIntegrityReportNow()` is an **editor-run, read-only** diagnostic in
`apps-script/Code.gs`. It looks at every staffing tab and lists what does not
add up. It **never** changes, deletes, renames or reorders anything.

---

## Running it

1. Open <https://script.google.com> and open the **ezone-staffing** project.
2. In the function dropdown at the top, choose **`runDataIntegrityReportNow`**.
3. Click **Run**.
4. Open **Execution log** (`Ctrl/Cmd + Enter`). The report is printed there:
   row counts, a count per severity, a count per finding code, then one line
   per finding.

Nothing is written. The last log line says so explicitly.

### If you want the findings as a sheet

Choose **`runDataIntegrityReportToSheetNow`** instead. It prints the same log
**and** creates **one new tab** named `IntegrityReport_YYYYMMDD` (or
`IntegrityReport_YYYYMMDD_HHmm` if today's name is already taken). It only
ever *creates* a tab — it never opens, edits or deletes an existing one. Old
report tabs can be deleted by hand whenever they are no longer wanted.

### Reading it

Columns: `severity`, `code`, `entity`, `entity_id`, `worker_id`,
`assignment_id`, `house`, `detail`. Findings are sorted worst first.

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
| `MISSING_START_DATE` | warn | A worker with live assignments and no `start_date`. Every month-aware rule then falls back to "always employed". |
| `MISSING_RATE` | warn | The placement's cost fields are missing or zero for its employment type, so it costs **0** every month: `salary` for full/part time, `hourly_rate` or `est_hours` for hourly, `retainer_amount` for a retainer, or all four rate×count products for `per_session`. Also flags a `part_time` `pct` outside 1–100. |
| `SMOKE_RECORD` | warn | The name looks like a test or demo leftover (`smoke`, `test`, `dummy`, `בדיקה`, `דמו`, `טסט`, …). |
| `NAME_SYNC_RISK` | warn | The name would **fail an exact-match sync** to the coordinators / therapists apps: leading or trailing whitespace, a double space, a bidi control character, a Hebrew geresh/gershayim where the consumer has an ASCII quote, or a curly quote. These are invisible on screen and are the classic cause of "the guide disappeared from the coordinators app". |
| `ABSENCE_OVERLAP` | warn | Two absences overlap for the same worker **and** house. |
| `ORPHAN_ABSENCE` / `ORPHAN_COVERAGE` | warn | The absence's worker, or the coverage's covering worker, has no row in `workers`. |
| `WORKER_NO_ASSIGNMENT` | warn / info | A worker with no assignment at all. `info` when archived placements exist (they simply left); `warn` when there is nothing at all — the row does nothing. |
| `UNSTAFFED_POSITION` | info | An absence with no worker: an unstaffed position, not an employee absence. Expected — recorded so the two are not confused. |
| `DANGLING_COVERAGE_LINK` | info | The coverage points at an absence that has since been deleted. The coverage still stands on its own. |
| `ORPHAN_ACTUALS` | info | A `monthly_actuals` row for an assignment that no longer exists (terminated or deleted). Harmless history. |

---

## The safe cleanup process

**Never edit the Sheet by hand to fix one of these.** Rows are
position-mapped and headers are append-only; a hand edit in the wrong column
silently corrupts every row below it. Use this four-step process instead.

### 1 · Flag

Run `runDataIntegrityReportToSheetNow()`. The new
`IntegrityReport_YYYYMMDD` tab is the work list. Nothing has changed yet.

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

Write the decision next to the row. Nothing proceeds without it.

### 3 · Dry run

Any fix ships as an **editor-run function with `dryRun = true` by default**,
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

Run the fix with `dryRun = false`, then run
`runDataIntegrityReportNow()` again. The findings you fixed must be gone and
**no new ones may have appeared**. If any did, stop and revert using the
dry-run log.

---

## What this report is *not*

* It is **not** a payroll check. It says a rate is missing, never that a rate
  is wrong.
* It **cannot see the consumer apps.** `NAME_SYNC_RISK` flags names that look
  fragile; it cannot tell you whether the coordinators app currently has a
  matching row.
* It **does not fix anything**, by design. Detection and repair are separate
  so a bad detection can never damage data.
