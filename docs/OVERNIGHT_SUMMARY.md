# Overnight run — summary

Five PRs, stacked, every one based on `main`. **Nothing was merged.** Sandra
merges, in the order below.

Suite: **591 → 783 tests**, all green at every step.

---

## 1 · The PRs

| # | PR | Phase | State | Tests before → after | Touches `apps-script/**`? |
|---|---|---|---|---|---|
| 1 | [#29](https://github.com/sandrabrayer/ezone-staffing/pull/29) | 0 — audit + read-only diagnostics | ready | 591 → 606 | **YES — merging deploys Apps Script** |
| 2 | [#30](https://github.com/sandrabrayer/ezone-staffing/pull/30) | 1 — monthly cost engine | ready | 606 → 647 | no |
| 3 | [#31](https://github.com/sandrabrayer/ezone-staffing/pull/31) | 2 — prevention | ready | 647 → 715 | **YES — merging deploys Apps Script** |
| 4 | [#32](https://github.com/sandrabrayer/ezone-staffing/pull/32) | 3 — integrations | ready | 715 → 735 | **YES — merging deploys Apps Script** |
| 5 | [#33](https://github.com/sandrabrayer/ezone-staffing/pull/33) | 4 — reporting + UX | ready | 735 → 783 | no |

No PR is a draft. No PR was merged, and none pushed to `main`.

In every case the `/exec` URL is unchanged — the deploy workflow publishes a
new version of the **existing** deployment.

## 2 · Merge order

**#29 → #30 → #31 → #32 → #33**, in that order, one at a time.

Each branch is stacked on the previous one, so **its diff against `main`
includes the earlier phases until those merge.** Merging in order makes each
diff shrink to just that phase's work. Merging out of order will produce
conflicts.

After each merge, check the **Deploy Apps Script** run for the three PRs that
touch `apps-script/**` and confirm its final step, *"Verify the web app still
answers anonymously"*, is green. A red one means the deployment lost
"Anyone, even anonymous" access and the consumer apps are receiving Google's
sign-in HTML instead of JSON; the step's own error message carries the
recovery clicks.

## 3 · The Sep 2026 payroll number, before and after

I could not read production data — the session's egress policy refuses
`CONNECT ezone-staffing.up.railway.app:443` with a `403`, and the Sheet needs
the Apps Script editor. So this is the brief's own case as a fixture: one
worker on ₪10,000 employed since 2020, one on ₪8,000 whose start date is
`2026-12-01`.

| Month | Before | After |
|---|---|---|
| 08/2026 | 18,000 | **10,000** |
| **09/2026** | **18,000** | **10,000** |
| 10/2026 | 18,000 | **10,000** |
| 12/2026 | 18,000 | 18,000 |

Before, every month returned 18,000: the future starter was billed three
months early and **the number never moved**. After, it moves, and it moves in
the right month. Reproduce it any time with
`node --test tests/cost-engine.test.js`.

### Why it was broken

Not the month picker — the frontend already passed the selected month to
every total. The month was **thrown away by the calculation**:
`monthlyAssignmentCost()` in `lib/calc.js` takes **no month argument at
all**; `startDate` was read by **no cost function whatsoever**; termination
and coverage extras were evaluated against **today**, not the selected month;
and nothing was prorated. The budget lookup *did* take the month — the
balance only *looked* frozen because the cost was frozen.

## 4 · Skipped or blocked, and why

| Item | Status | Why |
|---|---|---|
| **Diff the live Railway HTML / JS / `sw.js` against the repo** | **BLOCKED** | The egress policy refuses the live host (`403` on `CONNECT`). No request was possible, so no drift could be measured. |
| **SW cache bump** | **N/A, not skipped** | **There is no service worker in this repo.** `public/` holds only `index.html` and `emblem.png`, and `index.html` registers none. That rule comes from the coordinators app, which has one at `v120`. Recorded so nobody invents a version number. |
| **Running `runDataIntegrityReportNow()` on live data** | **BLOCKED** | Needs the Apps Script editor and the real Sheet. It ships unrun; see step 3 below. |
| **Real Sep 2026 payroll figures** | **BLOCKED** | Same reason. Proved with fixtures instead, which is reproducible and needs no production data. |
| **The hadrachot first-supervision reminder** | **NOT WIRED, deliberately** | The brief says wire it only if the existing feed supports it. It does not: the two Railway variables are optional and unverifiable from here, the failure mode is silent so a misconfigured URL and a genuine "nobody is overdue" look identical, and no delivery channel is specified. A reminder that cannot be verified end-to-end is worse than none. Written up with a two-step recommendation in `docs/CONSUMER_MIGRATION.md`. |
| **Editing the coordinators / therapists repos** | **OUT OF SCOPE by instruction** | Shipped as ready-to-paste prompts in `docs/CONSUMER_MIGRATION.md`. |
| **`doGet` still writes to the Sheet** | **left as is** | `readAbsencesSafe` writes back corrected absence statuses as a side effect of reading (finding **B4**). Changing it is a behaviour change that belongs in its own PR. Phase 0's diagnostic uses a separate read-only reader so *it* writes nothing. |
| **`MORAN_PIN` → `APP_PIN`** | **left as is** | Finding **A2**. Renaming it would take the live app down between saving the Railway variable and the redeploy. Sandra's call, not a code change. |
| **The query-string shared secret** | **accepted** | Finding **A7**. Apps Script web apps cannot read custom request headers — forced by the platform. |
| **A full WCAG audit** | **not claimed** | Contrast ratios, heading order and landmark structure were not systematically checked. The five items the brief names are done, each with a test. |
| **CSP `'unsafe-inline'`** | **remains** | The app is one page with a large inline `<script>`. Moving it to a file with a nonce is the right follow-up; it is not a Phase 2 change. |

## 5 · Rules to confirm with Moran

The full list. Each is a **named constant** with the current behaviour
implemented, and — where there is a sensible alternative — that alternative
implemented and tested too, so changing one is a one-line decision.

### From the cost engine — `docs/COST_RULES.md`

1. **`PRORATION_METHOD` = `calendar_days`.** *Does a worker who starts, leaves
   or transfers mid-month cost a full month, or only the days worked?*
   **This is the one rule I chose rather than preserved, and the one that
   needs an answer.** The app had no behaviour to preserve — it ignored dates
   entirely, which is the bug. And a full month **cannot** satisfy the brief's
   own requirement that a mid-month transfer must not double count: both
   houses would charge a full month for the same person. `'none'` is
   implemented, tested and one line away.
2. **`LEAVE_PRORATION` = `whole_month`.** *Does going on חל"ד / חל"ת
   mid-month zero the whole month, or only from that date?* Current
   behaviour preserved. `'from_status_date'` implemented and tested.
3. **`CHLD_PAID_BY_EMPLOYER` = `false`.** *Is חל"ד paid by the employer?*
   Currently it costs 0. In Israel maternity leave is normally paid by
   ביטוח לאומי, so 0 is probably right — but it is a money decision.
4. **`ABSENCE_REDUCES_COST` = `false`.** *Does a logged absence reduce the
   month's cost?* Currently no: only a *status* zeroes cost. The engine still
   reports `absenceDays` per line so the UI can explain a number without
   changing it.
5. **`ASSIGNMENT_START_SOURCE` = `effectiveFrom_or_createdAt`.** *Is
   `created_at` a reliable placement start for rows migrated from v2?* It only
   matters when it falls inside the month being costed, so a migrated row can
   skew at most the single month it was migrated in.
6. **Coverage payments are charged to the receiving house, once.** Stated
   because it is a money decision, not a technical one.

### From prevention — `docs/PREVENTION.md`

7. **Is a coverage by an absent worker ever legitimate?** Currently refused
   outright. If a real case exists — absent from one house while covering
   another — it becomes a warning with a confirm, like the duplicate guard.
8. **Should a new coverage default to `pending` or `approved`?** New rows are
   `pending`, legacy rows read as `approved`. Nothing acts on it yet; if
   nobody will work a pending queue, `approved` is the kinder default.
9. **Who counts as `approved_by`?** Free text today. If it should be a fixed
   list of managers, that is an enum.
10. **`לא צוין` is stored in Hebrew.** The ASCII-stored-values rule yields to
    the existing column convention — `reason_type` has always held Hebrew
    enum values, and mixing an ASCII sentinel in would be worse. Flagged
    rather than decided silently.

### From integrations — `docs/CONSUMER_MIGRATION.md`

11. **Are the sync-staleness thresholds right?** 24 hours for coordinators
    and therapists, 7 days for hadrachot. Display only — nothing acts on
    them and no alert is sent.
12. **Should a long-silent consumer do more than turn amber?** It could raise
    a banner. I did not, because an alert Moran cannot act on is noise.

## 6 · Manual steps for Sandra

### After each merge

1. **Check the deploy run** — <https://github.com/sandrabrayer/ezone-staffing/actions/workflows/deploy-apps-script.yml>.
   Only PRs **#29, #31 and #32** trigger it. Confirm the final *"Verify the
   web app still answers anonymously"* step is green.
2. **Railway redeploys `server.js` automatically.** No build step.

### Configuration

3. **No Railway variable changes and no Script Property changes are needed
   for any of the five PRs.** Every new tab — `audit_log`, `feed_log`, the
   appended columns on `assignments` and `coverages` — is created
   automatically with its headers on first use.

### One user-visible change worth warning Moran about

4. **After #31 merges, Moran must enter her PIN once more.** The session
   token format changed so that logout can actually revoke a session. Once,
   expected.
5. **Also tell her a transfer now works differently**: moving someone between
   houses **ends** the old placement and **starts** a new one, so the house
   she moved them *from* keeps its history and its cost up to the transfer
   date. The confirmation dialog says so.

### Two things only you can do

6. **Run the integrity report.** <https://script.google.com> → the
   **ezone-staffing** project → function dropdown → **`runDataIntegrityReportNow`**
   → **Run** → **Execution log**. It is **read-only**; the last log line says
   so. Send me the log and I will fold the real findings into a follow-up.
   `runDataIntegrityReportToSheetNow` does the same and also creates one new
   `IntegrityReport_YYYYMMDD` tab.
7. **Check whether `HADRACHOT_STATUS_URL` and `HADRACHOT_STATUS_SECRET` are
   set on the staffing Railway service** — <https://railway.app> → the
   ezone-staffing service → Variables. I could not. If they are not set, the
   first-supervision banner has been doing **nothing, silently**, since it
   shipped.

### When you want the consumers migrated

8. Open a Claude Code session on the coordinators repo and on the therapists
   repo, and paste the matching prompt from **`docs/CONSUMER_MIGRATION.md`**.
   Both apps keep working untouched until then — that is what "additive"
   buys. **I edited neither repository.**

### Answer the rules

9. **Rule 1 (`PRORATION_METHOD`) is the only decision that changes numbers.**
   The other eleven are either already at current behaviour or affect nothing
   yet.

## 7 · Rollback

Any PR reverts on its own. In every case **the `/exec` URL is unchanged** —
the workflow publishes a new version of the existing deployment, never a new
one.

| PR | Notes on reverting |
|---|---|
| #29 | The next `main` push redeploys the previous `Code.gs`. Any `IntegrityReport_*` tab can be deleted by hand; nothing reads it. |
| #30 | `lib/calc.js` keeps every export it has today and is functionally unchanged, so the previous numbers return exactly. |
| #31 | The appended columns and the `audit_log` tab are simply ignored by the reverted readers — never deleted, so no data is lost and re-applying is safe. The one thing a revert does not undo is the session format: Moran enters her PIN once more. |
| #32 | The added feed fields disappear and consumers fall back to name matching — **which is why the migration prompts specify `workerId` with a permanent name fallback, never `workerId` alone.** |
| #33 | Nothing persists. No `Code.gs` change either way. |

## 8 · Where things are written down

| File | What |
|---|---|
| `docs/STAFFING_AUDIT.md` | Routes, actions, secrets, tabs, 9 numbered findings, the traced root cause |
| `docs/STAFFING_IMPLEMENTATION_PLAN.md` | Per-phase files, schema additions, rollback, deploy checklist, "not changed" list |
| `docs/INTEGRATIONS.md` | Per consumer: source of truth, endpoint, fields, key, direction, frequency, errors, retry, failure visibility |
| `docs/STAFFING_DATA_INTEGRITY_REPORT.md` | How to run the report, every finding code, the safe cleanup process |
| `docs/COST_RULES.md` | The engine's settled rules, and the ones to confirm |
| `docs/PREVENTION.md` | Every guard, and the security hardening |
| `docs/CONSUMER_MIGRATION.md` | Ready-to-paste consumer prompts; the hadrachot write-up |
| `docs/REPORTS_AND_UX.md` | The thirteen exports and the accessibility pass |
| `CHANGELOG.md` | One entry per phase, at the top |
