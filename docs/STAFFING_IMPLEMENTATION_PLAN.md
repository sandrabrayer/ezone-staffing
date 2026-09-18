# E-ZONE Staffing — implementation plan (Phases 0–4)

Companion to [`STAFFING_AUDIT.md`](STAFFING_AUDIT.md). One PR per phase,
each branched off the previous one, **every PR based on `main`**.

> **Merging is production.** `.github/workflows/deploy-apps-script.yml`
> pushes `apps-script/**` to the live Google Apps Script project and
> redeploys the **existing** deployment on every push to `main`. The `/exec`
> URL never changes — but the code behind it does, the moment a PR touching
> `apps-script/**` merges. Sandra merges; nothing here merges itself.

---

## Merge order

| # | Phase | Branch | Touches `apps-script/**`? |
|---|---|---|---|
| 1 | 0 — audit + read-only diagnostics | `claude/beautiful-cori-wle33g` | **yes** (adds `runDataIntegrityReportNow`) |
| 2 | 1 — monthly cost engine | `…-phase-1` | see that PR |
| 3 | 2 — prevention | `…-phase-2` | see that PR |
| 4 | 3 — integrations | `…-phase-3` | see that PR |
| 5 | 4 — reporting + UX | `…-phase-4` | see that PR |

Each PR description carries a `Merge order: #X after #Y` line at the top.

---

## Phase 0 — audit + read-only diagnostics *(this PR)*

### Files

| File | Change |
|---|---|
| `docs/STAFFING_AUDIT.md` | **new** — the audit |
| `docs/STAFFING_IMPLEMENTATION_PLAN.md` | **new** — this file |
| `docs/INTEGRATIONS.md` | **new** — per-consumer contracts |
| `docs/STAFFING_DATA_INTEGRITY_REPORT.md` | **new** — how to run the report, and the cleanup process |
| `apps-script/Code.gs` | **added** `runDataIntegrityReportNow`, `runDataIntegrityReportToSheetNow`, `computeDataIntegrityReport_`, `readAllForIntegrity_`, `readAbsencesReadOnly_` and their constants — appended at the end of the file. **No existing function, constant or header array was modified.** |
| `tests/data-integrity.test.js` | **new** — 15 tests |
| `CHANGELOG.md` | entry |

### Schema additions

**None.** Phase 0 adds no column to any tab. The optional
`IntegrityReport_YYYYMMDD` tab is a brand-new tab created on demand and read
by nobody.

### Rollback

Revert the PR. The `/exec` URL is unchanged; the next `main` push redeploys
the previous `Code.gs`. Any `IntegrityReport_*` tab already created can be
deleted by hand — nothing reads it.

### Deploy checklist

1. Merge → the **Deploy Apps Script** workflow runs (this PR touches
   `apps-script/**`).
2. Confirm the workflow's final step, *"Verify the web app still answers
   anonymously"*, is green. A red one means the deployment lost
   "Anyone, even anonymous" access and the consumer apps are getting
   Google's sign-in HTML — the step's own error message carries the
   8-click recovery.
3. Railway redeploys `server.js` automatically. No env var changes.
4. Optional: run `runDataIntegrityReportNow()` from the Apps Script editor.

### Explicitly **not** changed in Phase 0

* No Express route, no auth logic, no validation.
* No `doGet` / `doPost` behaviour — the new functions are reachable **only**
  from the Apps Script editor. Neither entry point calls them.
* `readAbsencesSafe`'s lazy status write-back (finding **B4**) is left
  exactly as it is. The report uses a separate read-only reader instead.
* No sheet header, no row, no enum, no house id, no worker name.
* No feed payload. All three key-set guard tests still pass untouched.
* `.clasp.json`, the deploy workflow, and the `/exec` URL.
* `MORAN_PIN` is **not** renamed to `APP_PIN` (finding **A2**) — renaming it
  would take the live app down between saving the Railway variable and the
  redeploy. It is a manual decision for Sandra, not a code change.

---

## Phase 1 — monthly cost engine

**Top priority. Fixes: changing the month changes the label but not the numbers.**

### Files

| File | Change |
|---|---|
| `lib/cost-engine.js` | **new** — the single pure engine: `costForMonth(...)` |
| `tests/cost-engine.test.js` | **new** — the 20 cases, starting with the failing month test |
| `lib/calc.js` | delegates the month-aware paths to the engine; existing exports kept |
| `public/index.html` | the selected month on every total; actual / estimate / missing-data badges |
| `apps-script/Code.gs` | **no change planned** — the backend serves raw data; calculation does not belong there |

### The engine

```
costForMonth(workers, assignments, absences, coverages, budgets, 'YYYY-MM')
  → { lines: [ { workerId, assignmentId, house, cost, basis,
                 rule, daysCounted, source } ],
      totals: { actualConfirmed, estimated, projectedTotal, missingData } }
```

Every line carries a **trace**: which rule fired, how many days were counted,
and whether the number came from a recorded actual, an estimate, or nothing
at all. That trace is what makes the numbers arguable with Moran.

### Schema additions

**None expected.** The engine reads `start_date` (already on `workers`),
`status` / `status_date` (already on `assignments`) and `termination_date`
(already on `archive_v3`). If a case needs a field that does not exist, it is
**appended** to the end of a tab and called out in that PR.

### Rollback

Revert the PR. `lib/calc.js` keeps its current exports throughout, so a
revert restores the previous numbers exactly.

---

## Phase 2 — prevention

Duplicate guard on add worker (name **and** phone); transfer modelled as
*end the old assignment + start a new one with the same `workerId`*;
termination confirmation with a required reason or `לא צוין`; absence
overlap blocking and active/future/history views; coverage overlap and
availability detection with approval fields; phone validation before save;
and an append-only `AuditLog` tab.

### Schema additions — **append-only, at the end of each tab**

| Tab | Appended columns |
|---|---|
| `coverages` | `replaced_assignment_id`, `role`, `shift_count`, `approval_status`, `approved_by`, `cancelled` |
| `AuditLog` (**new tab**) | `ts`, `action`, `entity`, `entity_id`, `field`, `before`, `after`, `reason` |

`AuditLog` may carry salary values — the tab is HR-only. **They must never
reach a feed**; the Phase 3 key-set guards enforce that.

### Rollback

Revert the PR. Appended columns are simply ignored by the reverted readers —
they are never deleted, so no data is lost and re-applying is safe.

---

## Phase 3 — integrations (staffing side only)

Add `workerId`, `assignmentId` and `feedGeneratedAt` to all three feeds
(**additive** — no field removed or renamed, no worker name changed), a
`lastFeedServed` log per consumer, and a «סטטוס סנכרון» panel showing the
last pull per consumer. Ship `docs/CONSUMER_MIGRATION.md` with ready-to-paste
prompts for the coordinators and therapists repos.

**No other repository is edited.**

### Schema additions

| Tab | Appended columns |
|---|---|
| `FeedLog` (**new tab**) | `ts`, `consumer`, `status`, `row_count` |

### Rollback

Revert the PR. The added feed fields disappear; consumers that had already
switched to `workerId` fall back to name matching, which is why the migration
prompts specify **`workerId` with a name fallback**, never `workerId` alone.

---

## Phase 4 — reporting + UX

Read-only CSV exports with a UTF-8 BOM (monthly payroll, actual vs estimate,
by house, by role, salaried vs freelance, absences, coverages, missing start
dates, missing rates, unassigned, duplicates, budget exceptions) and an
accessibility pass: an explicit label on every input, keyboard navigation,
loading / empty / error states, an unsaved-change warning and a save
confirmation.

### Schema additions

**None.** Exports are read-only projections of data already held.

### Rollback

Revert the PR. Nothing persists.

---

## Standing constraints that apply to every phase

1. **No destructive data change.** No row delete, no rename, no header
   reorder. Headers are append-only and position-mapped — new columns go at
   the **end** only. Any data fix is an editor-run function with
   `dryRun = true` by default that logs a plan first.
2. **Never create a new Apps Script deployment**; never change the `/exec`
   URL; never edit `.clasp.json` or the deploy workflow unless asked.
3. **Cross-app contracts are frozen** — additive changes only, exact worker
   names preserved, each secret unlocking only its own feed (constant-time,
   fail-closed), no salary / rate / cost field in any feed. Each feed's key
   set stays pinned by a guard test.
4. **Frozen values**: houses `ramot, asher, ofroni, rehab, pardes,
   sde_eliezer, hq`; employment types `full_time, part_time, hourly,
   per_session, fixed_retainer`; statuses including `חל"ד` / `חל"ת` /
   `final_settlement`. `archive_v3` rows stay out of active views and feeds.
5. **Identity**: `workerId` + `assignmentId` internally, everywhere. Names
   are display only. Missing ids get backfilled by a dry-run-first editor
   function, never on read.
6. **Calculation lives in one shared pure lib**, not in the UI and not
   duplicated in `Code.gs`. The backend serves raw data.
7. **Every PR** carries a CHANGELOG entry, tests that pass under
   `node --test`, security review notes, and a clear commit message.
   `Code.gs` changes go in their own commit. Coupled backend + frontend
   changes ship in the **same** PR.
8. **Hebrew UI strings carry no parentheses**; stored values stay ASCII; RTL
   is preserved.
9. **There is no service worker in this repo** — nothing to cache-bust. See
   `STAFFING_AUDIT.md` §1.
