# E-ZONE Staffing — Phase 0 audit

Read-only audit of `sandrabrayer/ezone-staffing` at `main` (`341897d`,
"Merge pull request #27"), carried out 2026-09-17. **No behaviour was
changed by the PR carrying this document.** Everything below is either an
observation or a pointer to work scheduled in
[`STAFFING_IMPLEMENTATION_PLAN.md`](STAFFING_IMPLEMENTATION_PLAN.md).

---

## 0. What could not be checked, and why

| Check | Status | Reason |
|---|---|---|
| Diff live Railway HTML / JS / `sw.js` against the repo | **BLOCKED** | The session's egress policy refuses `CONNECT ezone-staffing.up.railway.app:443` (proxy answers `403`). No request to the live host was possible, so no drift could be measured. See §1. |
| Live-data run of `runDataIntegrityReportNow()` | **BLOCKED** | Needs the Apps Script editor and the real Sheet. The function ships unrun; §7 and [`STAFFING_DATA_INTEGRITY_REPORT.md`](STAFFING_DATA_INTEGRITY_REPORT.md) explain how Sandra or Moran runs it. |
| Actual Sep 2026 payroll figures | **BLOCKED** | Same reason — the numbers live in the Sheet. Phase 1 proves the month bug with fixtures instead, which is reproducible and does not need production data. |

Everything else in this document was verified against the repository.

---

## 1. Repo vs. live drift

**Not measurable in this session** (see §0). What *can* be stated from the
repository alone:

* **There is no service worker.** `public/` contains exactly
  `index.html` and `emblem.png`. `index.html` contains no
  `navigator.serviceWorker` registration and no `sw.js` reference, and no
  `sw.js` exists anywhere in the tree. The standing "bump the SW cache
  version" rule therefore has **nothing to bump in this repo** — that rule
  comes from the coordinators app, which does have one (`v120`). Recorded
  here so a future session does not invent a version number.
* **Railway serves this repo's `main` directly** (`railway.json`:
  `startCommand: node server.js`, healthcheck `/api/health`). There is no
  build step and no separate deploy branch, so the only drift that can
  exist is "Railway has not redeployed the newest `main` yet", which
  resolves itself.
* **Apps Script is a different story.** `apps-script/**` is pushed to the
  Google project by `.github/workflows/deploy-apps-script.yml` on every
  push to `main`. So `main` and the live `/exec` can only differ for the
  length of one CI run — but equally, **every merge to `main` that touches
  `apps-script/**` is a production Apps Script deploy.**

**Recommended follow-up for Sandra (2 minutes, no code):** open
`https://ezone-staffing.up.railway.app/api/health` in a browser. A JSON
`{"ok":true,...}` confirms the proxy is live. Then open the app, log in, and
confirm the month picker appears on the central view — that is the surface
Phase 1 changes.

---

## 2. Express routes and their auth

`server.js`, in file order.

| Method | Path | Auth | Notes |
|---|---|---|---|
| — | `/*` (static) | **none** | `express.static('public', {index:false})`. Serves `emblem.png`. `index.html` is excluded from the automatic index and served explicitly below. |
| `GET` | `/lib/calc.js` | **none** | Deliberate: the shared pure calculation helper is client-side code. `lib/auth.js` and `lib/validate.js` are **not** exposed. Contains no secrets. |
| `GET` | `/` | **none** | Serves `public/index.html`. The PIN gate is rendered by that page; the *data* behind it is server-gated, so an unauthenticated visitor gets an empty shell and nothing else. |
| `GET` | `/api/health` | **none** | `{ ok, t }`. Required by the Railway healthcheck. Leaks nothing. |
| `POST` | `/api/login` | **none** (by definition) | Rate-limited: 8 attempts / 15 min / IP, in-process `Map`. Constant-time PIN compare (`lib/auth.js checkPin`). Returns an HMAC session token. |
| `GET` | `/api/data` | `requireAuth` | Proxies the Apps Script roster bundle. |
| `GET` | `/api/hadrachot-status` | `requireAuth` | Proxies the hadrachot app's first-supervision feed. Unconfigured → `200 {configured:false}`; upstream failure → `502` with a generic body. |
| `POST` | `/api/action` | `requireAuth` + `validateAction` | Every mutation. Validated server-side *before* the upstream call. |
| any | `/api/*` | — | `404 {error:'not found'}`. |

**Findings**

* **A1 · No route is unauthenticated by mistake.** Every read and write of
  business data (`/api/data`, `/api/action`, `/api/hadrachot-status`) is
  behind `requireAuth`. Confirmed by `tests/server.test.js`.
* **A2 · The PIN env var is `MORAN_PIN`, not `APP_PIN`.** The standing
  ecosystem note lists `APP_PIN` as the Railway PIN variable across E-ZONE
  apps; this app has always used `MORAN_PIN` (`server.js:12`, `.env.example`).
  It is **not** a bug — but it is a trap for anyone rotating PINs across
  apps from a checklist. Listed as a manual item, not changed: renaming it
  would take the live app down between saving the Railway variable and the
  redeploy. See `STAFFING_IMPLEMENTATION_PLAN.md` § "Not changed".
* **A3 · Login lockout is rate limiting only, and it is per-process.** 8
  attempts per 15 minutes per IP, held in a `Map` that a Railway restart
  clears. There is no escalating lockout and no separate counter for
  "this PIN has been wrong N times in a row" regardless of source IP.
  Sufficient for a single-user app, worth hardening. → Phase 2.
* **A4 · Sessions cannot be revoked.** The token is
  `HMAC(SESSION_SECRET, "moran:<expiresAt>")` with a 7-day default TTL.
  Logout clears `localStorage` client-side; the token stays valid until it
  expires. There is no server-side session store and no `jti`. Rotating
  `SESSION_SECRET` is the only revocation mechanism. → Phase 2.
* **A5 · Error bodies from `/api/data` and `/api/action` echo the upstream
  message.** `res.status(...).json({ error: err.message })`. Apps Script
  error messages are all short internal strings (`'assignment not found'`,
  `'bad role'`) and never contain a secret — but `callAppsScript` throws
  `'upstream non-JSON: ' + text.slice(0,200)`, which would relay 200
  characters of whatever Apps Script returned. If the deployment ever loses
  anonymous access it returns Google's sign-in HTML, so this leaks page
  markup, not credentials. Low severity; tightened in Phase 2 by sending a
  generic body and keeping the detail in the server log.
* **A6 · No `Content-Security-Policy`, `X-Frame-Options` or
  `Referrer-Policy`.** `x-powered-by` is disabled; nothing else is set. → Phase 2.
* **A7 · The secret travels in the query string.** `callAppsScript` appends
  `?secret=<SHARED_SECRET>` because Apps Script web apps cannot read custom
  request headers. This is forced by the platform, is how every E-ZONE app
  does it, and is over TLS — but it means the secret can appear in
  intermediary logs. **Not changed** (changing it would break the frozen
  cross-app contract). Recorded so it is a known, accepted risk.

---

## 3. Apps Script surfaces and their secrets

`apps-script/Code.gs`. Each surface is routed **before** the general gate
and authorized by exactly one Script Property, compared in constant time by
`secretMatches_`, which **fails closed**: an unset stored secret matches
nothing.

| Entry point | Action | Secret | Direction |
|---|---|---|---|
| `doGet` | *(none — default)* | `SHARED_SECRET` | Full roster bundle → the Express proxy only |
| `doGet` | `getGuidesForHadrachot` | `HADRACHOT_READ_SECRET` | → hadrachot app |
| `doGet` | `getTherapistsForTherapists` | `THERAPISTS_READ_SECRET` | → therapists app |
| `doGet` | `getGuidesForCoordinators` | `COORDINATORS_READ_SECRET` | → coordinators app |
| `doPost` | 22 actions (below) | `SHARED_SECRET` | ← the Express proxy only |

`doPost` actions: `createWorker`, `updateWorker`, `deleteWorker`,
`setWorkerStartDates`, `addAssignment`, `updateAssignment`,
`deleteAssignment`, `moveAssignment`, `terminateAssignment`, `logAbsence`,
`endAbsence`, `deleteAbsence`, `addCoverage`, `deleteCoverage`,
`upsertMonthlyActuals`, `getMonthlyActuals`, `setBudget`, `getBudgets`,
`getHearings`, `addHearing`, `updateHearing`, `deleteHearing`.

**Findings**

* **B1 · Secret isolation holds, and it is already tested.** Each feed's
  handler checks only its own property. `tests/coordinators-endpoint.test.js`,
  `tests/therapists-endpoint.test.js` and `tests/hadrachot-endpoint.test.js`
  each assert that *every other* surface's secret returns `401`. Good.
* **B2 · Contract guard tests already pin each feed's key set.** All three
  test files assert the exact `Object.keys(...).sort()` of a feed entry.
  The frozen-contract requirement is therefore already satisfied; Phase 3's
  additive fields will have to update these three pins deliberately, which
  is exactly the intent.
* **B3 · No feed exposes a financial field.** Verified by reading the three
  builders and by the `FINANCIAL_WORDS` scans in the existing tests.
* **B4 · `doGet` writes to the Sheet.** `readAbsencesSafe()` lazily corrects
  a stale `status='active'` to `'ended'` and **writes that back**
  (`Code.gs`, `readAbsencesSafe`). So the "read-only" default `doGet` is
  not read-only. It is harmless in intent, but it means a plain read can
  contend for the sheet and can fail on a permissions change. The Phase 0
  integrity report deliberately uses a new `readAbsencesReadOnly_()` so the
  diagnostic itself writes nothing. The `doGet` behaviour is **left as is**
  (changing it is a behaviour change and belongs in a later phase).
* **B5 · `getMonthlyActuals` / `getBudgets` / `getHearings` are reads served
  over `doPost`.** Consistent with the proxy's single write route; noted so
  nobody assumes `doPost` ⇒ mutation when auditing.
* **B6 · The digest writes to a *second* spreadsheet** (`DIGEST_SHEET_ID`),
  rebuilt best-effort after roster-changing actions. A digest failure never
  fails the user's mutation (`rebuildDigestSafe`). Correct design; recorded
  because it is a non-obvious second data store.

---

## 4. Environment variables and Script Properties (names only)

No value is recorded anywhere in this repository or in these documents.

### Railway environment variables (`server.js`, `.env.example`)

| Name | Required | Purpose |
|---|---|---|
| `APPS_SCRIPT_URL` | yes | The Apps Script `/exec` URL. |
| `SHARED_SECRET` | yes | Must equal the Apps Script `SHARED_SECRET` property. |
| `MORAN_PIN` | yes | Moran's login PIN. **Server-side only** — never reaches the browser. |
| `SESSION_SECRET` | yes | HMAC key for session tokens. ≥32 chars enforced at startup. |
| `SESSION_DAYS` | no (7) | Session lifetime. |
| `PORT` | no | Set by Railway. |
| `HADRACHOT_STATUS_URL` | no | The hadrachot app's first-supervision feed. Unset ⇒ feature off. |
| `HADRACHOT_STATUS_SECRET` | no | Its secret. Unset ⇒ feature off. |
| `NODE_ENV` | no | `test` skips the startup secret check. |

Startup **fails loudly** (`process.exit(1)`) when any required variable is
missing — the right behaviour.

### Apps Script Script Properties

| Name | Set by | Purpose |
|---|---|---|
| `SHARED_SECRET` | manual | Gates `doGet` (default) + all of `doPost`. |
| `SHEET_ID` | manual | The staffing spreadsheet id. |
| `HADRACHOT_READ_SECRET` | manual | Gates the hadrachot feed only. |
| `THERAPISTS_READ_SECRET` | manual | Gates the therapists feed only. |
| `COORDINATORS_READ_SECRET` | manual | Gates the coordinators feed only. |
| `V3_MIGRATION_DONE` | the script | `'true'` once `migrateToV3` succeeded. |
| `DIGEST_SHEET_ID` | the script | The standalone digest spreadsheet. |

### GitHub secrets / variables (deploy workflow)

`CLASPRC_JSON` (secret), `DEPLOYMENT_ID` (secret),
`APPS_SCRIPT_EXEC_URL` (repository *variable*, non-secret).

---

## 5. Sheet tabs and headers

Headers are **position-mapped** by `_readAll`/`_writeAll`-style readers, so
they are **append-only**. A mid-array insert shifts every stored value one
column right and corrupts every row.

| Tab | Headers (in order) |
|---|---|
| `workers` | `id, name, notes, created_at, shift_commitment, start_date, gmach_month, phone` |
| `assignments` | `id, worker_id, house, role, role_detail, employment_type, salary, pct, hourly_rate, est_hours, session_rate, est_sessions, retainer_amount, notes, created_at, allowance, status, status_date, rate_individual, sessions_individual, rate_group, sessions_group, rate_external, external_patients` |
| `absences` | `id, worker_id, house, start_date, end_date, reason_type, reason_detail, notes, status, created_at` |
| `coverages` | `id, absence_id, covering_worker_id, covering_house, receiving_house, start_date, end_date, extra_payment, notes, created_at` |
| `archive_v3` | `id, assignment_id, worker_id, name, house, role, role_detail, employment_type, salary, pct, hourly_rate, est_hours, session_rate, est_sessions, retainer_amount, notes, termination_date, reason_type, reason_detail, archived_at, rate_individual, sessions_individual, rate_group, sessions_group, rate_external, external_patients` |
| `monthly_actuals` | `id, assignment_id, month, actual_hours, actual_sessions, note, created_at, updated_at` |
| `budgets` | `id, house, month, amount, created_at, updated_at, instructors_amount` |
| `hearings` | `id, worker_id, worker_name, hearing_date, reason, result, created_at` |
| `_legacy_ramot` / `_legacy_asher` / `_legacy_ofroni` / `_legacy_rehab` | `id, name, role, salary, pct, notes, role_detail` — read-only transition tabs |
| `_legacy_events` | `id, employee_id, employee_name, home_house, host_house, start_date, end_date, reason_type, reason_detail, covers_employee_id, bonus_amount, status, created_at` |
| `_legacy_history`, `_legacy_archive` | legacy, read-only |

Second spreadsheet (`DIGEST_SHEET_ID`), written only by this script:
`NewGuides`, `GuidesRoster`, `NewlyHired`, `NewlyDeparted` — see
`DIGEST-CONTRACT.md`.

**Frozen enums** (mirrored in `lib/validate.js` and `Code.gs`, and pinned by
tests): houses `ramot, asher, ofroni, rehab, pardes, sde_eliezer, hq`;
employment types `full_time, part_time, hourly, per_session, fixed_retainer`;
statuses `active, chld, chlt, final_settlement`; allowances `0, 2000, 6000`.

---

## 6. The monthly cost engine — root cause of the reported bug

**Symptom (reported):** switching the cost month between 08/2026, 09/2026
and 10/2026 changes the label but not the numbers; budget and balance stay
the same.

**Root cause — confirmed by reading the code, and reproduced with a failing
test in Phase 1.** The bug is *not* in the month picker. The frontend
wiring is correct: `onMonthChange` sets `selectedMonth`, re-renders, and
`ensureMonth()` is passed to `houseMonthlyTotal`, `networkMonthlyTotal`,
`budgetForHouse` and `instructorsBudgetForHouse` (`public/index.html`,
`monthPickerHtml` / `houseMonthTotal` / `totalCostMonth` / `budgetLineHtml`).

The month is then **thrown away** by the calculation:

1. **`monthlyAssignmentCost(a, actual)` (`lib/calc.js`) does not take a
   month at all.** It takes a pre-resolved `actual` row. For
   `full_time`, `part_time` and `fixed_retainer` it returns
   `assignmentCost(a)` — a constant. For `hourly` and `per_session` it
   returns the constant estimate **unless** a `monthly_actuals` row exists
   for that exact `(assignmentId, month)`. So **the only thing that can
   vary by month today is an uploaded actuals row.** With no actuals
   uploaded — the normal state — every month returns byte-identical
   numbers.
2. **No date field is consulted.** `startDate` is never read by any cost
   function (it is used only by the first-supervision flags). A worker
   whose `start_date` is `2026-12-01` therefore contributes **full cost in
   September 2026**, which is the specific case in the brief.
3. **Termination is evaluated against *today*, not the selected month.**
   `pendingHouseCost(archive, house, today)` counts an archived assignment
   while `terminationDate > today`. Selecting October does not move that
   boundary, and selecting a past month does not restore a worker who had
   already left.
4. **Coverage extras are also evaluated against *today*.**
   `coverageExtra(..., today)` and `activeCoveragesByHouse(..., today)` are
   passed `today` from `houseMonthlyTotal` / `networkMonthlyTotal` **by
   design** (documented in the source). Correct for a "who is covering
   right now" panel; wrong for "what did/will September cost".
5. **There is no proration anywhere.** A mid-month start or end costs a
   full month.
6. **`budget` does vary by month — but only if a month row exists.**
   `budgetForHouse` resolves month-specific → `default`. With only a
   `default` row (the likely live state), the budget is genuinely the same
   every month. The *balance* then looks frozen because cost is frozen, not
   because the budget lookup is broken. Both halves of the reported symptom
   are explained by (1)–(5).

**Also found while tracing:**

* **C1 · Possible double count of the instructors line.**
  `houseMonthlyInstructorsCost` sums the house's `מדריך/ה` assignments —
  which are a **subset** of `houseMonthlyAssignmentsCost`, the house total.
  The UI renders the instructors row as an indented sub-row of the house
  row (`instructorsSubRow`), which reads as a breakdown, not an addition —
  and the totals do **not** add them together, so **there is no arithmetic
  double count in the code today**. The risk is presentational: neither
  total is labelled with what it includes, so "house 120,000 / instructors
  40,000" can be read as 160,000. Phase 1 labels both explicitly and adds a
  test pinning that the instructors figure is a subset, never an addend.
* **C2 · `totalCost()` (month-blind) still exists alongside
  `totalCostMonth()`.** Only the month-aware one is rendered today, but the
  month-blind `networkTotal` / `houseTotal` / `workerTotalCost` remain
  reachable and are what the worker-level view uses — so a worker card and
  a house card can disagree. Phase 1 routes everything through one engine.
* **C3 · `hasRecorded()` correctly distinguishes a recorded `0` from a
  blank cell.** Good — this is the subtle case, and it is already right.
* **C4 · Leave zeroes cost for the whole month regardless of when the leave
  started.** `isUnpaid(a)` is a status flag on the assignment with no date
  arithmetic, so a worker who went on חל"ת on the 25th costs nothing for
  that entire month. Whether that matches payroll reality is a **rule to
  confirm with Moran**; current behaviour is preserved and named in Phase 1.

---

## 7. Prevention gaps (input for Phase 2)

Verified present and working — **do not rebuild these**:

* Absence and coverage date order (`endDate < startDate` → `400`), in both
  `lib/validate.js` and `Code.gs`.
* Phone format `^0\d{9}$` with space/dash stripping, stored as text with the
  `@` number format so the leading zero survives, and restored defensively
  on read (`formatPhoneCell`).
* `receivingHouse` must differ from `coveringHouse`.
* Every mutation holds `LockService.getScriptLock()`.
* Termination snapshots the assignment's full terms into `archive_v3`,
  auto-truncates the matching active absence, and deletes the live row.

Genuinely missing:

* **D1 · No duplicate guard on `createWorker`.** Nothing compares the new
  name or phone to existing rows. A second house entered as a second person
  is the single most likely source of duplicate workers and double-counted
  cost.
* **D2 · No absence overlap check.** Two overlapping absences for the same
  `(worker, house)` are both accepted.
* **D3 · Coverage has no overlap or availability check**, no `role`, no
  shift count, no approval fields, no cancel flag, and no idempotency key.
* **D4 · Termination has no required reason.** `reasonType` is optional
  (`''` is accepted) and `reasonDetail` may be blank.
* **D5 · Termination is not idempotent.** Calling it twice on an id that
  was already archived returns `404` (the live row is gone), which is safe —
  but there is no guard against two archive rows for one assignment if the
  first call partially failed. The Phase 0 report's `ARCHIVED_STILL_ACTIVE`
  check detects the bad state.
* **D6 · There is no audit log.** No tab records who changed what, when,
  from what to what. For an HR system holding salary data this is the
  biggest single gap.
* **D7 · `moveAssignment` is a transfer primitive but is not modelled as
  "end one assignment, start another".** History of the old placement is
  not preserved as an archive row.

---

## 8. Test suite

`npm test` → `node --test tests/*.test.js`. **591 tests, all passing**, on
`main` with dependencies installed.

One operational note: `tests/date-format.test.js`,
`tests/final-settlement.test.js`, `tests/hadrachot-proxy.test.js`,
`tests/hearings.test.js`, `tests/page-load.test.js`,
`tests/roster-tools.test.js` and `tests/server.test.js` all `require('jsdom')`,
which is a **devDependency**. Running `npm test` after a bare `npm install
--production` (or with no install at all) reports **7 failing files** that
are not real failures. CI runs `npm ci`, so CI is correct. Anyone running
the suite locally must `npm install` first.

---

## 9. Finding index

| ID | Severity | Area | Phase |
|---|---|---|---|
| A1 | ok | every data route is authenticated | — |
| A2 | info | PIN var is `MORAN_PIN`, not `APP_PIN` | manual |
| A3 | medium | login lockout is per-process rate limiting only | 2 |
| A4 | medium | sessions cannot be revoked; logout is client-side | 2 |
| A5 | low | upstream error text relayed to the browser | 2 |
| A6 | low | no CSP / frame / referrer headers | 2 |
| A7 | accepted | shared secret travels in the query string | — |
| B1–B3 | ok | secret isolation, key-set pins, no financial leakage | — |
| B4 | low | `doGet` writes back corrected absence statuses | — |
| B5–B6 | info | reads over `doPost`; second digest spreadsheet | — |
| C1 | medium | instructors line is unlabelled and reads as an addend | 1 |
| C2 | medium | month-blind totals coexist with month-aware ones | 1 |
| C4 | rule | leave zeroes a whole month regardless of start day | 1 |
| **§6** | **high** | **month selection does not affect cost** | **1** |
| D1–D7 | high | no duplicate guard, overlap check, audit log | 2 |
