# E-ZONE Ecosystem Status — updated September 24, 2026

Add this file to the knowledge of EVERY E-Zone app Project (all eight), replacing
the July 22 version, so any future chat/session starts from the true state. The
Sep 10 revision was the UNION of every repo's copy (the per-repo sections that had
drifted — Dashboard git history, Therapists roster source, Managers Sep 5–10 work,
Logistics access code — are folded in below); the same file lives in all repos.

**Sep 24, 2026 revision** adds the coordinators work of Sep 17–24 (PRs #174–#189 —
staffing-synced guides + therapists, commitments, fixed shifts, the constraints window,
רכז edit rules, meeting day, table view, name search, departed staff, admin name tools,
batched saves, house aliases). See "Coordinators — Sep 17–24, 2026" below.

**Sep 24, 2026 revision (staffing)** adds the staffing work of Sep 23–24 (PRs #39–#45 —
fast open + PWA, npm audit, the audit-workflow trigger fix, the coordinators therapist
feed, shift minimums handed back to coordinators, the marketer role, and the
fast-open caches). See "Staffing — Sep 23–24, 2026" below.

**Sep 16, 2026 revision** corrects two ecosystem-wide rules that were stated too
absolutely (Apps Script auto-deploy; Railway deploys gated on CI) and records the
coordinators incident of Sep 15–16. See "⚠️ Corrections to ecosystem-wide rules"
immediately below — read those two before acting on anything else in this file.

## ⚠️ Corrections to ecosystem-wide rules (Sep 16, 2026)

1. **Apps Script deploy is NOT automatic in every repo.** In `ezone-coordinators`
   the `deploy-apps-script.yml` workflow is `workflow_dispatch` ONLY — there is
   deliberately no `push:` trigger, and `test/workflow-policy.test.js` fails the
   build if one is ever added. After any merge that touches `Code.gs`: GitHub →
   Actions → "Deploy Apps Script" → Run workflow → `main` (or `npm run deploy:gas`
   locally). **Check each repo's workflow `on:` block before assuming auto-deploy;
   do not trust the July 22 "rollout complete" line for coordinators.**
2. **Railway deploys are gated on the GitHub Tests check.** If the Tests workflow
   fails on the deployed branch, Railway marks the deploy **SKIPPED** ("CI check
   suite failed") and production silently keeps the previous commit. After every
   merge: verify the **Active** commit hash in Railway → Deployments. A skipped
   deploy can be forced via ⋮ → Redeploy, but fix CI first.

## Deployment ground truth (branches re-verified July 22, 2026)

| App | Repo | Deploys branch |
|---|---|---|
| Outpatient | ezone-outpatient | **claude/youthful-volta-laarnk** (UNIFIED — see below) |
| Dashboard | E-Zone-Dashboard | claude/build-ezone-dashboard-QOg5s |
| Therapists | ezone-therapists | claude/inspiring-tesla-jipobw |
| Managers | ezone-managers | main |
| Staffing | ezone-staffing | main |
| Kitchen | ezone-kitchen | main |
| Coordinators | ezone-coordinators | main |
| Logistics | sandrabrayer-ezone-logistics | main |

⚠️ Verify the Railway-connected branch in the Railway dashboard before any work —
it is NOT stored in the repo and has been silently switched before (July 3:
outpatient was switched dashboard-hKjf9 → volta, orphaning a day of work). The
clasp CI deploy workflow, by contrast, DOES store the deployed branch (its
`branches:` list) in the repo — see "Apps Script deployment" below.

## Apps Script deployment — clasp CI (per-repo trigger; verify the `on:` block)

Every E-Zone app's Apps Script backend deploys from GitHub Actions via clasp. No
more hand-pasting `Code.gs` into the editor. The workflow was rolled out and
verified green across all six apps on 22/07/2026 (ezone-therapists already ran
this exact setup — it was the template the six were matched to).

**What changed since:** the rollout line used to say the deploy is *automatic on
push* everywhere. That is no longer true of every repo — see correction 1 at the
top of this file. The clasp mechanics below are unchanged and still correct; only
the TRIGGER varies per repo, so read a repo's workflow `on:` block rather than
assuming.

- **Automatic via GitHub Actions** — `.github/workflows/deploy-apps-script.yml`,
  clasp pinned to `@google/clasp@3.3.0`, hardened workflow: it fails loudly and
  early (before touching the live deployment) if a secret is missing or
  `CLASPRC_JSON` isn't valid JSON, and it requires clasp's `Deployed …@<version>`
  confirmation on the redeploy step — so a rejected deployment ID can never pass
  as a green no-op. Runners use `actions/checkout@v5` + `actions/setup-node@v5`
  (Node 24 native — clears the Node 20 deprecation warning) with the clasp
  toolchain on `node-version: '22'`.
- **Trigger — PER REPO, check the `on:` block.** Two shapes exist:
  - *Auto on push* (the 22/07/2026 rollout default): a push/merge to the app's
    **deployed branch** touching `apps-script/**` (also `.clasp.json` or the
    workflow file itself), plus `workflow_dispatch` for manual runs.
  - *Manual only* — **`ezone-coordinators`**: `workflow_dispatch:` and nothing
    else. Verified in the workflow file on 16/09/2026 and pinned by
    `test/workflow-policy.test.js`, which asserts the file has no `push:` trigger.
    The repo rule is a deliberate one: `Code.gs` changes go in an isolated commit
    and are deployed by hand after merge (`npm run deploy:gas`, or Actions → Run
    workflow). **Do not add a push trigger here.**

  Either way a `concurrency` group serializes runs so two deploys can't race the
  same deployment.
- **Redeploys the EXISTING deployment (same `/exec` URL)** — `clasp push -f`
  uploads `apps-script/**`, then `clasp deploy -i <DEPLOYMENT_ID>` republishes
  the existing deployment as a NEW VERSION. The deployment ID is reused, so **the
  `/exec` URL never changes** and no consumer (Railway `APPS_SCRIPT_URL`, sibling
  apps) has to be re-pointed.
- **Secrets (per repo)** — `CLASPRC_JSON` (clasp OAuth tokens from a local
  `clasp login`) + `DEPLOYMENT_ID` (the existing Web App deployment ID, starts
  with `AKfyc…`). Both live ONLY in GitHub Secrets, never in git; the workflow
  `rm`s the runner's token copy at job end (`if: always()`).
- **Token-refresh procedure** — clasp OAuth tokens expire / can be revoked. To
  refresh: run `clasp login` locally (clasp 3.x) → copy the fresh
  `~/.clasprc.json` → update the **`CLASPRC_JSON`** secret **in all six repos**
  (the SAME value everywhere — they share one deploying Google account) → re-run
  the failed deploy job. `DEPLOYMENT_ID` and the per-repo Script IDs are
  unchanged.

### Per-app deployed branch (verified 22/07/2026)

| App | Repo | Deployed branch |
|---|---|---|
| Staffing | ezone-staffing | `main` |
| Kitchen | ezone-kitchen | `main` |
| Coordinators | ezone-coordinators | `main` |
| Outpatient | ezone-outpatient | `claude/youthful-volta-laarnk` |
| Logistics | sandrabrayer-ezone-logistics | `main` |
| Dashboard | E-Zone-Dashboard | `claude/build-ezone-dashboard-QOg5s` |

Each app's workflow **`on:` block** (and its `branches:` list, where it has one)
plus its `.clasp.json` Script ID are the source of truth for that app's deploy;
the deployment ID lives only in the repo's `DEPLOYMENT_ID` secret. Only
`ezone-coordinators` has been re-verified since 22/07/2026 (manual-only, above) —
for the others, open the workflow and read the `on:` block before relying on a
merge to deploy. Setup, token-refresh, and the manual fallback are
documented per repo in `DEPLOY.md`.

### ⛔ OBSOLETE — manual copy-paste redeploy (superseded by clasp CI)

The old manual procedure — open the Apps Script editor, **paste** `Code.gs`, Save,
Deploy → Manage deployments → New version of the EXISTING deployment — is
**SUPERSEDED** by the clasp CI above and must no longer be used for routine
deploys. (Note: this obsoletes *hand-pasting into the editor*, not the manual
**triggering** of the clasp workflow — in `ezone-coordinators` a manual
`workflow_dispatch` run, or `npm run deploy:gas`, IS the routine path, and it
still deploys via clasp.) It is retained only as an emergency fallback (see each repo's
`DEPLOY.md` → "Manual fallback", which uses clasp locally, not the editor). The
CI path is the ecosystem's standard; hand-pasting was the ecosystem's most
error-prone operation (accidental "New deployment" → the `/exec` URL changes →
every consumer breaks).

## Coordinators (רכזים) — Sep 10, 2026: PRs #139–#148 shipped (all merged to `main`, Code.gs redeployed)

Ten coordinators PRs merged Sep 9–10, 2026, one at a time off `main`, Railway
auto-deployed each, and every `Code.gs` change went out as an isolated commit +
manual "Deploy Apps Script" run afterwards (no auto-deploy trigger — policy unchanged).
Suite at #148: **1221 tests green** (`node --test --test-concurrency=1`).

| PR | What shipped | Code.gs |
|---|---|---|
| #139 | **Guide roster is staffing-owned.** `getGuides` syncs from staffing's read-only `getGuidesForCoordinators` feed on every read (name match, phone as secondary key, upsert under LockService; local rows never deleted/renamed; feed down → zero writes, `rosterSource:'local'` + amber notice). Add / remove / rename retired in the app (410 routes, denylist); only «עריכת מינימום» stays. Inactive guides greyed in the picker, red chips on today/future. | yes |
| #140 | **Guide-name migration** `migrateGuideNamesNow(dryRun)` — editor-run, dry-run default; aligns three guide spellings to staffing's and deactivates one departed guide; rewrites references house-scoped across ShiftAssignments / SwapRequests / PickupRequests / Constraints / TrainingRecords. | yes |
| #141 | **קופה קטנה limit 1,000 → 2,000 ₪/month** — single `PETTY_CASH_LIMIT` constant (guard test forbids other literals), admin-only `POST /api/petty-cash/migrate-limit` (dry run unless `confirm:true`), Guide §14. | yes |
| #142 | **Perf**: `getHouseBundle` (one execution per house open) + `getCorrectionState`, sheet cache TTL 300 s, staffing sync `tryLock(2s)`; proxy request **coalescing**, targeted invalidation (`WRITE_INVALIDATES`), stale-while-revalidate (`X-Cache: HIT / STALE / MISS`), warm-up ≤3 in flight. Diagnosis + Railway verification in `docs/perf-bundle.md`. | yes |
| #143 | **Soft delete** in תקציב רווחה + קופה קטנה — 🗑 with a required reason (2–120), `deletedAt/deletedBy/reason` appended columns, summaries skip deleted rows, «רישומים שנמחקו» collapsed section, amber «תיקון עודף» instead of a negative balance. | yes |
| #144 | **Hard block on manual edits** — double shift + one free day per week (+ cap 6) enforced on every manual path (tap-to-correct, draft override, post-publish correction, swap request, swap approval) via `getCorrectionState`; no override flag; picker greys violators with the reason; one shared Hebrew reason map (`REASON_HE`). | no |
| #145 | **WhatsApp group send** — «📤 שליחה לקבוצת המדריכים — כל החודש»: the full schedule (every date × shift, ❗ on unfilled from the board model), `wa.me/?text=` without a number, «העתקה», weekly parts «חלק i/n» over 1,200 chars; the same week button on the ראשי card and the weekly view. Pure builder `lib/whatsapp.js scheduleMessage`. | no |
| #146 | **Team-meeting day per house** — `Houses.MEETING_DAY` (raanana Tue · ramot Mon · rehab Tue · pardes Sun · efroni Thu) is the source of truth; scheduler soft term 50,000 (≥1 shift/week on the meeting day, below the 100,000 minimum, above load); «ישיבת צוות» chip on the board, ראשי and «המשמרות שלי». | no |
| #147 | **Visit order + psychiatrists** — `InpatientSessions.visitOrder` (appended), `inpatientSession` op `move`, «פסיכיאטר/ית» tag from `Therapists.role`. (Superseded on the UI side by #148: order is now by time.) | yes |
| #148 | **לוז מטפלים restructured, therapist-first + timed** — `InpatientSessions.time` (appended, 'HH:MM' text) **required** on add, **no two sessions of one therapist at the same time on a day**, op `setTime`; UI = «שיבוץ לפי מטפל/ת» cards (workdays from `TherapistWorkdays` → «HH:MM · מטופל» slots, off-day confirm) + derived read-only «לוז שבועי» with filters; legacy rows «ללא שעה» + «הגדרת שעה». **Also: house labels always Hebrew** — `Houses.label()` everywhere, staffing ids (`asher` / `ofroni` / `hapardes`) mapped at read, `hapardes → pardes` in the staffing sync map, `test/house-label-guard.test.js`. | yes |

### Script Properties added in this run (never in code)

| App | Property | Purpose |
|---|---|---|
| **Staffing** | `COORDINATORS_READ_SECRET` | Unlocks ONLY the read-only `doGet?action=getGuidesForCoordinators` feed (name · phone · active · houses · startDate — no financial data). Set on the staffing Apps Script (staffing PR #26). |
| **Coordinators** | `STAFFING_SHEETS_URL` | The staffing Apps Script `/exec` URL the guide sync calls. |
| **Coordinators** | `STAFFING_GUIDES_SECRET` | = staffing's `COORDINATORS_READ_SECRET`. Missing / mismatched → sync skipped, local roster served, amber «לא סונכרן מהסטאפינג» notice. |

Both coordinators properties are set and verified (roster line shows «מנוהלת במערכת
הסטאפינג»). The `script.external_request` scope was authorized once by running
`previewStaffingGuideSyncNow` from the editor. No Railway variables were added.

### Coordinators conventions confirmed this run

- One PR at a time, branched off `main`, PR base `main`; explicit-path `git add`;
  CHANGELOG + Guide.html + tests in every PR; SW cache bumped on any asset change
  (now `v120`); `Code.gs` changes in isolated commits, deploy manual after merge.
- Sheets headers are append-only — new columns this run: `WelfareLog` /
  `PettyCashLog` (`deletedAt`, `deletedBy`, `reason`), `InpatientSessions`
  (`visitOrder`, `time`). `_ensureSheet` writes a new header cell on the first
  write after deploy; `_isTimeHeader` pins `time` columns to text.
- The staffing feed is the roster's source of truth; `InpatientAssignments` stays
  dead; no financial data beyond תקציב רווחה + קופה קטנה.

## Coordinators incident — Sep 15–16, 2026 (PRs #158–#164)

**Symptom:** app failed to load across all houses; tabs stuck on «טוען…»; 502s in
the console; auto-scheduler looked broken. **No data was lost.**

**Root cause (three layers):**

- **Load.** 13 tabs × 5 houses; one page load + a tab switch = 12–20 concurrent
  Apps Script calls. Google throttles bursts by answering **HTTP 404 with an HTML
  page** ("unable to open the file") — these never appear as failed executions in
  the Apps Script Executions list, which is why the cause stayed invisible for a
  day. Apps Script reads are 1–30 s each.
- **Proxy.** `fetchUpstream` had no concurrency cap for user reads (only the
  warm-up and the scheduler went through `runPool`). The HTML response threw at
  `JSON.parse`, mapped to 502, with no retry and no stale fallback. The cache was
  in-memory only, wiped by every deploy (four on Sep 15).
- **Client.** PR #153's 15 s read deadline was applied to 9 of ~20 read call sites
  (ראשי, board, therapists); every tab from לוז קבוצות יומי down had **no**
  deadline and hung forever. PR #154's `editReady` gate waited on two unbounded
  reads, so the «הפעל שיבוץ אוטומטי» button could stay grey indefinitely.

**Decision:** nothing from PRs #152–#155 was reverted — each was a correct idea
applied incompletely. PR #156 (scheduler timeouts) was merged, reverted the same
day (PR #157), and re-implemented as PR F (#161).

**Fixes shipped** — all merged to `main`, SW cache `v129`, `Code.gs` deployed
manually after #158. PR numbers and merge commits verified against GitHub on
16/09/2026:

| PR | Merge commit | What |
|---|---|---|
| #158 | `182b39c` | Global upstream queue (concurrency 3), 404-HTML detection + retry, stale-on-error, full failure logging (`outcome=` `upstream=` `q=`), `Code.gs` chunked CacheService (values >100 KB — ShiftAssignments, Constraints — were silently never cached). **Code.gs redeployed manually.** |
| #160 | `dbaaff7` | Every tab read bounded (60 s) with «נסו שוב»; a tab switch no longer spawns parallel copies of a read; the read timeout is a TOTAL budget including retries; background warm-up capped at concurrency−1 so a slot is always free for users; per-tab priming instead of the 18–22-key house bundle. |
| #161 (F) | `24ad63c` | `runSchedule` 150 s client deadline; 120 s server run deadline (`504 schedule_timeout`, nothing written); `getStaffingDigest` folded into the read pool (three sequential upstream phases → two); expiring in-flight lock that releases only its own entry; scheduler budget returns the best draft + `budget_exhausted` red cells; editor reads 60 s + «נסו שוב לטעון נתוני עריכה». |
| #162 (G) | `cbc3819` | Shared spinner: `window.Api` wrapped ONCE, so every async action shows a loading state; «מריץ שיבוץ…» with elapsed seconds; guard test fails the build on any raw POST `fetch` in `public/`. |
| #163 (H) | `1a08eaf` | Cache snapshot to disk (every 5 min + on SIGTERM), restored at boot and served as STALE while refreshing. **Requires a Railway volume** (below) to survive a redeploy. |
| #164 (I) | `4dfc177` | Warm-up phase 2: lower-tab datasets (13 keys/house + 5 house-free) after the schedule phase, at `background` priority. Snapshot persistence rule aligned with the proxy's own cacheable rule. |

**PR #159** (CI timing robustness) was **closed without merging** — its work was
folded into #160. Do not cite it as shipped.

**Railway configuration (coordinators):**

- Volume mounted at `/data`; variable `CACHE_SNAPSHOT_DIR=/data/cache`. Without
  the volume the snapshot survives a process restart but NOT a redeploy (a new
  deploy is a new filesystem). Boot log shows
  `[proxy] cache snapshot restored entries=N ageMs=…`; `absent` means the volume
  is not wired up.
- **Upstream concurrency is `UPSTREAM_MAX_CONCURRENT = 3`, a hard-coded constant
  in `server.js` — there is NO environment override.** Setting an
  `UPSTREAM_CONCURRENCY` variable in Railway does nothing. Lowering it to 2 (if
  404s persist) is a one-line code change plus a PR, not a dashboard edit.
- `WARM_LOWER_TABS=0` skips warm-up phase 2 if it ever needs to be turned off.
- `railway.json` restart policy is `ON_FAILURE`; one restart per deploy is normal.

**What to watch in the Railway log:**

- `warm phase=schedule complete …` then `warm phase=lower-tabs … failed=0`. A
  non-zero `failed=` is preceded by one line per failure carrying the scrubbed
  Google reason.
- `upstream retry … kind=html status=404` — occasional is fine; frequent means
  the concurrency cap should come down (code change, see above).
- Every user read: `[proxy] GET action=… house=… ms=… cache=… upstream=… outcome=… q=n/3`
  (the field is `q=`, not `queue=`).

**Not the cause (measured — do not re-investigate):** the scheduling algorithm
(~90 ms at real size: 14 guides, a full 31-day month, pinned by
`test/scheduler-performance.test.js`), the #144/#146 hard rules, the Apps Script
write path (already one `setValues`), the service worker, Railway crashes, and
server-side coalescing (it works — the duplicate log lines were client copies).

## Coordinators conventions — additions (Sep 16, 2026)

- Verify the Railway **Active** commit hash after every merge (a red CI check
  makes the deploy SKIPPED and production silently stays on the old commit).
- `Code.gs` changes: isolated commit, then a manual "Deploy Apps Script" run.
- **SW cache version is monotonic — and the #156 revert is the cautionary tale.**
  #156 bumped `public/sw.js` to `v125`; its revert (#157) put the file back to
  **`v124`**, i.e. the revert *decreased* the live version, which is exactly what
  the monotonic rule forbids. The recovery was to skip the reused number: the next
  bump (#158) went to **`v126`**, not back to v125. When reverting a PR that
  bumped the SW, bump FORWARD past the reverted number rather than restoring the
  old one.
- Timing-sensitive tests need wall-clock margins, not fixed sleeps or tick counts.
  A tick count is not a time budget: under CPU load a loop can burn 244 ticks in
  2 ms of wall time, which is how two cold-start tests failed on CI while passing
  locally. (Current serial suite: ~88 s locally, ~90 s in CI — they are close;
  the earlier "CI is ~3× local" note no longer holds.)
- One PR at a time; Claude Code may merge on green when explicitly authorized for
  a batch, waiting ~5 min between merges for Railway to deploy and warm.

## Coordinators — Sep 17–24, 2026: PRs #174–#189 shipped (all merged to `main`)

Every `Code.gs`-touching PR was followed by a manual "Deploy Apps Script" run on `main`
(runs #53–#62, all green). SW cache is now **`v150`**. Earlier this
window, #165–#173 shipped per-tab bundles, a warm ראשי, cross-house guide conflicts,
«training is informational only» and the guide-phone backfill.

**What changed for users (the current rules):**

- **Staffing is the source of truth for BOTH rosters.**
  - Guides (`getGuidesForCoordinators`) and therapists (`getTherapistsForCoordinators`,
    the same `STAFFING_GUIDES_SECRET`) are synced on every read: exact name, phone as a
    secondary match, under LockService.
  - The sync never deletes or renames a row. If the feed is down, it writes nothing and
    the UI shows an amber «לא סונכרן».
  - Manual therapist add / rename / move / delete is retired (routes answer 410).
- **Departed staff** (staffing `active:false`) leave every working list, picker and
  scheduler input, and are shown only in the collapsed «עובדים שסיימו (N)». This is
  separate from the local «בחופשה» (`onLeave`).
- **Shift commitments (התחייבויות משמרות):**
  - Model: weekly min–max, weekend inside the week or separate (per week / per month),
    5/6 alternating weeks, and a gap filler.
  - The scheduler pursues the minimum and treats an explicit commitment as a cap.
  - «עריכת מינימום» edits the commitment. An admin import (dry run → hash-confirmed)
    loads the commitments, with «אישור הצעה» for near-miss names.
- **Fixed shifts (משמרות קבועות):**
  - A weekly pattern the scheduler pre-places.
  - A conflicting occurrence is left empty and flagged: «קבוע» chip and amber notice.
- **Constraints window:** open from the **20th until the last day of the previous
  month**, Israel time. It is enforced at the proxy and in `Code.gs`, with a pre-open
  banner.
- **רכז edits after the auto pass:**
  - **Blocked:** a double shift, no free day in a rolling 7 days, and night → morning.
  - **Everything else is amber** («⚠ שימו לב») and still allowed.
  - «החלפה» on each chip.
  - Swaps and pickups keep every rule.
- **Meeting day (ישיבת צוות) = a workday:**
  - It is never the week's free day.
  - It is **not** counted toward the commitment.
  - Guides with a weekly max ≥ 5 are preferred on it.
  - For a רכז it shows as amber only.
- **Board «תצוגת טבלה»:**
  - A roster matrix: ב/א/ל cells, «ק» for fixed shifts, red and amber rule marks,
    totals vs. the commitment, and per-shift coverage.
  - On a narrow screen it shows a single week.
  - Clicking a cell opens the same editor.
- **«חיפוש שם»** on every people list (one shared module, `lib/name-search.js`).
- **Admin tools** (dry run first, nothing ever deleted):
  - «יישור שמות לסטאפינג»: phone / similarity proposals; renames in place plus
    house-scoped references.
  - «מטפלים שלא בסטאפינג»:
    - activity evidence from our own data;
    - link or «סימון כסיים/ה»;
    - CSV export for HR.
  - `GET /api/admin/house-aliases`: counts of alias-stored rows.
- **Staffing name checks count guides only** (#188). The digest lists every employee,
  so the roster warning and «אין התאמה» now count feed guides, or digest rows with a
  guide `role`. The warning should now be about 0.
- **House aliases** (#189): `hapardes`, `asher`, `ofroni` and Hebrew labels resolve at
  read in the scheduler, the therapist and patient reads, the leave toggle and the
  compliance digest. They used to be silently excluded. The sheet is never rewritten.
- **Speed:**
  - «לוז מטפלים» reads are warmed at boot (5-min TTL).
  - Saves are batched. Sheets calls before → after:
    - guide sync, 40 changes: 120 → 28;
    - blocked days: 60 → 8;
    - month reset: ~65 → 5;
    - commitments import: ~49–98 → 2.

| PR | Merge | What | Code.gs |
|---|---|---|---|
| #174 | `7cfb88c` | «עריכת מינימום» Save fixed (client crash + רכז house scope) | — |
| #175 | `904ed81` | Departed guides leave the working lists («עובדים שסיימו») | — |
| #176 | `2c87c13` | «חיפוש שם» on every people list | — |
| #177 | `a5425d9` | Shift commitments: model, scheduler, «עריכת מינימום», admin import | ✅ #53 |
| #178 | `53c7264` | Fixed weekly shifts | ✅ #54 |
| #179 | `da816db` | Constraints window opens on the 20th (Israel time) | ✅ #55 |
| #180 | `ecdab38` | רכז edits: only the safety rules block; the rest is amber; «החלפה» | ✅ #56 |
| #181 | `78d9e7a` | Therapist roster synced from staffing; window closes end of M−1; night→morning blocks | ✅ #57 |
| #182 | `22ba5db` | «לוז מטפלים» reads warmed in phase 1 (5-min TTL) | — |
| #183 | `a8e2d78` | «תצוגת טבלה» roster matrix | — |
| #184 | `edc9701` | Meeting day = workday; high-commitment preference | — |
| #185 | `5c25b8d` | «יישור שמות לסטאפינג»; import staffing spelling + «אישור הצעה»; batched import | ✅ #58 |
| #186 | `e4e4515` | «מטפלים שלא בסטאפינג» + CSV; SKIPped feed houses logged | ✅ #59 |
| #187 | `b76a0f0` | Batched Sheets writes on the slow save paths | ✅ #60 |
| #188 | `f5a89b5` | Staffing name checks count guides only | ✅ #61 |
| #189 | `7c0e3f2` | House aliases resolved at read | ✅ #62 |

`0740def` is an empty commit made only to re-trigger a Railway build after #180.

**Railway notes (coordinators):**

- `UPSTREAM_CONCURRENCY` in Railway is still **not read**: `UPSTREAM_MAX_CONCURRENT = 3`
  is hard-coded, so a dashboard value of 2 does nothing.
- The cache snapshot (`CACHE_SNAPSHOT_DIR=/data/cache`) was reported as not restoring
  after deploys. This was **deliberately deferred** by the owner on Sep 24 (the app is
  fine); it was investigated but not changed.
- The boot log is silent when there is no snapshot file, and periodic saves are
  quiet. Only the SIGTERM save logs, and it appears in the **old** deployment's log.

## Staffing — Sep 23–24, 2026: PRs #39–#45 shipped (all merged to `main`)

**Apps Script deploy in staffing IS automatic:** `deploy-apps-script.yml` runs on a
push to `main` that touches `apps-script/**` (plus `workflow_dispatch`). Every
`Code.gs` PR below deployed green (runs #23–#29; #44 and #45 also had a manual run).

**Standing rule for Claude sessions in staffing** (`CLAUDE.md`): never merge PRs,
never push to `main`, never dispatch deploy workflows. Open the PR and stop —
Sandra merges manually.

**What changed for users (the current rules):**

- **The app opens fast** (#39, #45).
  - The shell paints at once, and the data request starts in `<head>`.
  - Proxy read cache: coalescing, 24 h stale-while-revalidate, stale-on-error,
    keep-warm every 10 min.
  - One upstream queue (`UPSTREAM_CONCURRENCY`, default 2). Reads retry on Google's
    404/quota HTML; writes never retry.
  - `Code.gs`: one spreadsheet open per execution, a cached page-load bundle, and a
    lean `view=app` bundle.
  - A disk snapshot is restored at boot, and the browser paints its last copy at
    once with «מתעדכן…» (see "Railway notes" for the security follow-up).
- **Installable PWA** (#39): manifest, icons, and a service worker that never touches
  `/api/*`.
- **Coordinators therapist roster comes from staffing** (#42 → #43):
  - Feed: `getTherapistsForCoordinators`. Key: staffing `COORDINATORS_READ_SECRET` =
    coordinators `STAFFING_GUIDES_SECRET`. Compared in constant time, fails closed.
  - Guide shift minimums moved here in #42 and went back to coordinators in #43.
  - `getGuidesForCoordinators` is back to its original key set.
  - `assignments` columns 25–27 (`weekday_min`, `weekend_min`, `allowed_shifts`)
    are RETIRED/RESERVED and never reused.
- **Placement edit fix** (#42): `updateAssignment` wrote 24 values into a
  25-column range. Editing a placement could fail and blank `effective_from`.
- **Marketer role «משווק/ת» + employment type «עמלה לפי מקרה»** (`per_case_commission`, #44).
  - No rate and no count. Cost = allowance only, never «missing data».
  - Never appears in any feed: therapists, coordinators-therapists or
    coordinators-guides.
  - Editor migration `migrateMarketersNow()` moves «אחר» + «משווק» placements.
- **Dependencies and CI** (#40, #41):
  - `npm audit fix` bumped qs, body-parser and express; undici is dev-only.
  - A separate production-deps `audit.yml` was added.
  - #41 removed `audit.yml`'s push-to-`main` trigger. Railway's "wait for CI" gates a
    deploy on EVERY workflow that runs on a push to the deployed branch, so a new
    advisory could have skipped deploys. It now runs on PRs, weekly and by hand.

| PR | Merge | What | Code.gs (deploy run) |
|---|---|---|---|
| #39 | `2b4c152` | Faster first load on PC + installable PWA | ✅ #23 |
| #40 | `da010db` | npm audit advisories + production-deps audit check | — |
| #41 | `c9db0fd` | `audit.yml`: no push-to-main trigger (PR + weekly + manual) | — |
| #42 | `4e709c6` | Coordinators feeds: therapist feed (+ minimums, later removed); `updateAssignment` width fix | ✅ #24 |
| #43 | `31a01d6` | Shift minimums stay in coordinators; therapist feed kept | ✅ #25 |
| #44 | `8068ca6` | Marketer role + per-case commission; `migrateMarketersNow` | ✅ #26 (+ #27 manual) |
| #45 | `7ff702f` | Open fast: upstream queue, retries, stale-on-error, disk snapshot, instant paint | ✅ #29 (+ #28 manual) |

**Railway notes (staffing):**

- The service variables are `APPS_SCRIPT_URL`, `MORAN_PIN`, `PORT`, `SESSION_DAYS`,
  `SESSION_SECRET` and `SHARED_SECRET`. `HADRACHOT_STATUS_*` is unset, so the banner
  is off.
- The #45 snapshot lives in `<RAILWAY_VOLUME_MOUNT_PATH>/staffing-cache`. The boot
  log line is `[proxy] cache snapshot dir=… writable=… restored entries=N`.
- **#45 stored both caches unencrypted:**
  - the disk snapshot was plain JSON with salaries, rates, allowances and budgets;
  - the browser copy was the whole bundle.
  The cache-security PR opened Sep 24 (branch `claude/compassionate-cray-ee672j`)
  encrypts the snapshot with AES-256-GCM and strips the browser copy to an allowlist
  with no money fields (`docs/cache-security.md`).
- **After that PR merges, the snapshot stays OFF until `CACHE_SNAPSHOT_KEY` is set**
  in Railway. Use 32 random bytes: `openssl rand -base64 32`. Until then the boot log
  says `[proxy] snapshot disabled: no key`.

**Open, not merged (as of Sep 24):**

- #38 — zero-argument `*ForRealNow` twins for the dry-run-first editor functions.
- #28 — «בקרת שכר» monthly payroll control.
- The Sep 24 PR above. It also adds `applyMarketersMigrationNow()` (the zero-argument
  twin of `migrateMarketersNow(false)`), corrects three house manager names, and adds
  the `CLAUDE.md` rule.

## Outpatient: the two production lines are UNIFIED (July 4, PR #56)

- `claude/ezone-outpatient-dashboard-hKjf9` and `claude/youthful-volta-laarnk`
  had **no common git ancestor** (unrelated histories) and both accumulated real
  features. PR #56 merged dashboard INTO volta (`--allow-unrelated-histories`).
- **claude/youthful-volta-laarnk is now the single canonical production branch.**
  Treat `dashboard-hKjf9` as dead — do not commit there.
- Restored dashboard features now live on volta: createLead endpoint
  (fail-closed via `CREATE_LEAD_SECRET`), LockService around `_saveAll`,
  persisted paymentStatus/paymentDate/nextBillingDate, backdated payment dates,
  renewal anchored on stored nextBillingDate, card extra-charge paid/unpaid
  toggle, optimistic saves, urgency-sorted patient cards, two-panel patient-card
  redesign, סניף location dropdown/source-of-truth, frequency unit שבוע/חודש.
- **CLIENTS_HEADERS is APPEND-ONLY** (33 cols). `_readAll/_writeAll` map the
  live sheet BY POSITION and `_ensureSheet` never migrates data — NEVER reorder
  or remove mid-array columns; append only. Guard tests enforce the exact order.

## Outpatient therapist-payout subsystem (shipped July 1–4)

- "תשלומי מטפלים" tab: monthly per-therapist totals (pre-VAT / with VAT),
  detail toggle, mark-forwarded-to-payroll, Excel/CSV export (UTF-8 BOM).
- Pipeline: therapists app marks a session → posts `recordSessionOutcome`
  (secret `SESSION_OUTCOME_SECRET`, set on BOTH Apps Scripts, fail-closed) →
  outpatient writes a `SessionLog` row → payout tab reads `getSessionLog`.
- **Pay rates live in the `TherapistRates` sheet** (name / flatRate /
  intakeRate / followupRate), auto-seeded, cached 120s (edits apply ≤2 min).
  Names must EXACTLY match the therapists app's full names (e.g.
  'ד"ר מיכאל שפרינץ', 'הילה תבור'). Unknown names fail closed. ~14 newer
  therapists still have blank rates — fill before their sessions can record.
- Credit/quota engine: `creditsOwed` persisted per client, single-cell writes.
- Perf: `loadAll` is PARALLEL (Promise.all, guard-tested); session save writes
  one cell, not the whole Clients sheet.
- Deferred: "+ הוסף סשן חסר"/"תיקון סשן" correction modal; historical backfill
  of sessions recorded before the pipeline existed.

## Managers bonus overhaul shipped July 4, 2026 (PRs #5, #7)

- ALL bonus math now lives ONLY in the frontend (`lib/bonus-eligibility.js`);
  the Apps Script backend's bonus fields (qualifies, lockedIn, projectedBonus,
  quarterly*) are ignored everywhere — backend supplies raw data only
  (avgDaily, treatmentDays, treatmentDaysSoFar, manager names). This ended the
  recurring two-systems-out-of-sync bug. Pending: strip the dead bonus code
  from the live "ezone dashboard" Apps Script.
- Model: tier by average daily occupancy — Ramot 17/19/20, Ra'anana 10/12/14,
  Efroni, Rehab & Pardes 10/12/13 → 2,000/2,500/3,000₪. Treatment-days gate is FIXED
  per house: threshold × 30 (Ramot 510, others 300), independent of month
  length and tier.
- Settled previous-month bonus ("בונוס לתשלום") is the headline: trophy
  winners banner (house + manager + amount), per-card rows, KPI total —
  computed on the 1st for the finished month.
- Quarterly 5,000₪ computed locally: windows anchored May 2026 (May–Jul,
  Aug–Oct…), each finished month's settled bonus must be ≥2,000₪; first
  possible payout end of July 2026. Frontend fetches each finished window
  month via `managersOverview&month=YYYY-MM`.
- Day counts run from the 1st (never front-dated); readability pass
  (text-mute 0.72, small fonts 12–13px). Tests: 36 via `node --test`.
- Efroni house-id checked: data-entry app and backend both use 'arfoni'
  consistently — no mismatch.

## Managers: bonus month labelling (September 8, 2026)

- **Settled vs running month are now two labelled blocks everywhere**
  (`בונוס אוגוסט 2026 — סופי (לתשלום)` / `ספטמבר 2026 — חודש נוכחי (בתהליך)`).
  A settled month shows a final state only (`זכאי · מדרגה X · Y ₪` or
  `לא זכאי · המכסה לא הושלמה (441/510)`) — never `בדרך`/`בתהליך`/`חסרים`.
  Hero banners lead with the settled month; running-month progress is a
  secondary line with the month name and `בתהליך`.
- **Running month = ACTUAL days-so-far from the 1st + a separately labelled
  `צפי לסוף החודש` projection.** A tier is shown as achieved only when
  settled-and-met or locked in; otherwise `מדרגה הבאה: N (P מטופלים/יום) ·
  ממוצע נוכחי X`.
- **Single days-so-far figure**: `public/bonus-view.js` → `daysSoFar` (daily
  chart summed to today; else the feed's `treatmentDaysSoFar` capped at
  elapsed × capacity) feeds the KPI, hero, progress bar and house card. The
  feed's raw `treatmentDaysSoFar` is front-dated (366 vs 102 on 8 Sep) and is
  no longer shown as-is.
- **Stray "2500" under the manager name**: the card rendered the feed's
  `type` field verbatim. House type now comes from `HOUSE_LABELS` only; feed
  manager/name strings pass through `BonusView.safeLabel`. Tests assert no
  backend bonus field reaches the DOM (`test/app-render.test.js`).
- New module `public/bonus-view.js` (labelling only; math stays in
  `lib/bonus-eligibility.js`). Tests: 113 via `node --test`. SW cache v7.
  Details: `docs/bonus-month-labelling.md`. Still pending: strip the dead
  bonus code from the live dashboard Apps Script (unchanged by this work).

## Managers: occupancy history picker (September 10, 2026)

- Every house tab opens with a **"היסטוריית תפוסה"** card: a month picker
  (current month back to the May 2026 quarterly anchor, up to 12 months)
  that shows a past month's daily occupancy chart, `ימי טיפול` vs the fixed
  gate, daily average and settled status — always `(סופי)`, never `בתהליך`.
- Data: `managersOverview&month=YYYY-MM` (shared `fetchMonthOverview_`
  helper); the daily chart from that payload or one
  `managersHouse&house=…&month=…` attempt accepted only when its `month`
  matches. Fetch errors show an explicit error state. **The picker never
  touches the bonus KPIs / hero / cards** (snapshot-tested). SW cache v9,
  tests 125. Details: `docs/occupancy-history-view.md`. Backend unchanged:
  whether the month overview carries a per-house `dailyChart` is decided in
  the dashboard Apps Script.

## Managers: bonus history month picker (September 10, 2026)

- **"חודש בונוס" picker on the overview and on every house tab**: the
  running month (default) plus every finished month back to the May 2026
  quarterly anchor, no cap. One page-wide selection; `חזרה לחודש נוכחי`
  restores the live view. A finished month renders the WHOLE page settled
  through `BonusView.settledMonthView` — `יולי 2026 — סופי`, tier reached,
  amount, gate result — KPIs, winners banner, network chart, house cards,
  house hero, month split, days bar, tier track, quarterly block
  (anchored to the selected month's window, with `מאי ✓ · יוני ✗ · יולי ✓`
  marks) and breakdown. Never `בתהליך` / `בדרך` / `חסרים` / `צפי`; the
  next-tier card is hidden; days-so-far of a finished month = full-month
  total.
- Data: the existing `managersOverview&month=YYYY-MM` fetch only (selected
  month + finished months of its window, ≤ 3 requests), cached per month in
  memory for the life of the page; explicit error state, retried on
  re-select. **No new endpoints, no Apps Script changes.** The running month
  is byte-for-byte unchanged (snapshot-tested). SW cache v10, tests 136.
  Details: `docs/bonus-month-labelling.md` → "Bonus history month picker".

## Managers: house roster (5 houses, current as of September 5, 2026)

The Managers app (`ezone-managers`) covers FIVE houses. Hardcoded fallbacks
live in `HOUSE_LABELS` (`public/app.js`) and `HOUSE_BONUS`
(`lib/bonus-eligibility.js`); the live feed's `manager` field, when present,
still takes precedence over the hardcoded name. `test/house-coverage.test.js`
and `test/ecosystem-status-doc.test.js` fail CI if any enumeration (or this
table) drifts.

| Key | House | Manager | Type | Eligibility threshold | Capacity |
|---|---|---|---|---|---|
| raanana | רעננה אשר | שחר | בית מאזן | 10 | 14 |
| ramot | רמות השבים | אורן | בית מאזן | 17 | 20 |
| efroni | קיסריה עפרוני | חנן | תחלואה כפולה | 10 | 13 |
| rehab | קיסריה ריהאב | רנטה | גמילה | 10 | 13 |
| pardes | רעננה הפרדס | חן | תחלואה כפולה | 10 | 13 |

- רעננה הפרדס (`pardes`) was added August 24, 2026 with Efroni's bonus
  parameters; the shared dashboard Apps Script must return `pardes` in
  `managersOverview` / `managersHouse` for its live data to appear.
- Manager history: raanana עידו → שחר (Aug 24, 2026); ramot שחר → אורן
  (Aug 25, 2026). Ra'anana's שחר and Ramot's former שחר are different people.
- Efroni's backend house-id is `arfoni` (data-entry app and backend agree);
  the frontend key is `efroni`.

## Apps Script topology (July 4)

- Outpatient Apps Script: **ONE active deployment** (URL ending FOwWYIw/exec);
  two accidental extra deployments created July 4 were archived. All three
  consumers point at it: outpatient `SHEETS_URL`, therapists
  `OUTPATIENT_SHEETS_URL`, dashboard `OUTPATIENT_LEAD_URL`.
- Dashboard backend: ONE Apps Script serves Dashboard (SHEETS_URL), Managers
  (APPS_SCRIPT_URL), Therapists (DASHBOARD_SHEETS_URL) — rotate together.
- Secrets (Script Properties, never in code): SESSION_OUTCOME_SECRET (new,
  both outpatient+therapists), CREATE_LEAD_SECRET (outpatient — set it to
  enable Dashboard→Outpatient lead handoff), DEBT_STATUS_SECRET,
  TREATMENT_PLANS_SECRET, OCCUPANCY_SECRET, OUTPATIENT_LEAD_SECRET,
  WINBACK_SOURCE_SECRET, APP_PIN (Railway; Logistics uses SHARED_ACCESS_CODE —
  its shared login code, which replaced APP_PIN there). Coordinators' staffing
  pair (STAFFING_SHEETS_URL / STAFFING_GUIDES_SECRET) and staffing's
  COORDINATORS_READ_SECRET: see the Sep 10 coordinators section above.

## Therapists: roster source = the ezone-staffing feed

- The Therapists app's therapist list is SYNCED from ezone-staffing (workers
  with role מטפל/ת) on every getData — `getTherapistsForTherapists`. Names are
  edited in the STAFFING app; `active` is overwritten by every sync (exact-name
  upsert, add/deactivate/reactivate only — never a row delete or rename; all
  downstream matching, incl. outpatient TherapistRates, is exact-string, so
  renames go through staffing + `migrateTherapistNames` + a TherapistRates row
  rename together).
- Secret pairing: staffing's `THERAPISTS_READ_SECRET` = therapists'
  `STAFFING_THERAPISTS_SECRET` (plus `STAFFING_SHEETS_URL` on the therapists
  Apps Script). Unset/unreachable ⇒ NO writes; the last-synced list is served
  and the UI shows an amber "לא סונכרנה" toast. (The coordinators app follows
  the same pattern for guides — see the Sep 10 section.)

## Dashboard git history: the deploy branch is an ORPHAN SNAPSHOT (verified Aug 9, 2026)

`claude/build-ezone-dashboard-QOg5s`'s root commit (`62f5f7b`, "Merge pull
request #18", June 17 2026) has **no parents** — the branch began life that day
as a flattened snapshot of everything through PR #18. The original PR #1–#18
history (phase-2a…2e work) is git-disconnected from it; the old `feature/phase-2*`
and early `claude/*` branches still carry that severed line, which is why they
show alarming "50–64 commits not on the deploy branch" counts. **This is an
artifact, not lost work** — an Aug 9 audit verified the snapshot contains the
full pre-#18 content and that every documented feature since is present at HEAD.
Do not launch a lost-work hunt (or merge one of those stale branches) because of
those counts; content-level comparison, not commit ancestry, is the correct
check against pre-June-17 branches.

## Known pitfalls (hard-won, extended July 4)

- **[OBSOLETE for routine deploys — Apps Script now deploys automatically via
  clasp CI; see "Apps Script deployment" above. Kept as history / emergency
  fallback only.]** Apps Script NEVER auto-syncs from GitHub: paste Code.gs →
  Save → deploy a NEW VERSION of the EXISTING deployment. Wrong choices seen this
  week: new deployment (URL changes, consumers break) and access flipped off
  "Anyone" (consumers get Google's HTML page → "Non-JSON from Apps Script").
- GitHub web editor nests paths when creating files inside a folder — type only
  the filename when already in the folder. Browser re-downloads add " (N)"
  suffixes — drag FOLDERS to the upload page, not loose files.
- Claude Code opens PRs against the repo DEFAULT branch — always verify PR base
  = the deployed branch. PRs #33/#55 were closed for this; #56 was correct.
- Railway variable changes apply only to deployments started after saving.
- PIN inputs have maxlength (Outpatient 6, Dashboard 6) — keep APP_PIN within.

## Next tracks (in priority order, updated September 16, 2026)

1. **Corrupted-rows cleanup** (dashboard + outpatient) — unchanged, still open.
2. **Coordinators follow-ups (Sep 24):** run «יישור שמות לסטאפינג» and the commitments
   import; review «מטפלים שלא בסטאפינג»; check `GET /api/admin/house-aliases`; the cache
   snapshot restore after a redeploy is still open (deferred). Also: watch the incident
   fixes — phase-2 `failed=`
   counts and `kind=html status=404` frequency in the Railway log. If 404s persist
   at the current cap, consider either lowering `UPSTREAM_MAX_CONCURRENT` to 2 (a
   code change — there is no env override) or a small Apps Script-side bundle
   endpoint per tab.
3. **Apply the coordinators proxy pattern to the other Railway apps** before they
   hit the same wall — global upstream queue, 404-HTML detection + retry,
   stale-on-error, and the cache-snapshot volume. **Therapists and outpatient have
   the most tabs and are the most exposed.**
4. **Outpatient housekeeping**: set GitHub default branch = volta; delete stale
   claude/* branches (incl. dashboard-hKjf9 after a grace period); fill the
   blank TherapistRates rows; review `matchStatus:"no_match"` SessionLog rows.
5. **Outpatient mobile/PWA** ("the phone option"): manifest + service worker +
   letter-E green icons + mobile CSS pass — same recipe as therapists.
6. **Therapists carryovers** (Task 4): `_cancelFutureBookings` on patient delete
   (verify deployed); live end-to-end quota test (Yarden→Vered); plan-change
   history.
7. **Logistics**: mobile-responsive, then hardening (חירום auto-approval,
   LockService, deferral wake-up).
8. **Managers + Logistics auth** to the ezone-staffing standard.
9. **Design tokens** across apps; then feature tracks (plan-compliance,
   occupancy forecast, debt aging). Managers bonus distance-to-target: shipped
   July 4.
10. **Dashboard Apps Script cleanup**: strip dead bonus logic (frontend now
    ignores it); keep raw-data endpoints only.
