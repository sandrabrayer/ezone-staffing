# Changelog

All notable changes to this project are documented here. Format inspired by [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased] — v3 work in progress

> The full v3 entry will be written when v3 ships; this section is a running journal of v3-only changes that haven't been folded into a release entry yet.

- **Houses expanded from 4 to 7.** Added `pardes` (איזון רעננה - פרדס), `sde_eliezer` (שדה אליעזר), and `hq` (מטה — a pseudo-house for HQ / admin staff who don't belong to a physical house). The validator (`lib/validate.js` and its mirror in `apps-script/Code.gs`) now accepts all seven codes. The v3 Sheet schema is unchanged — rosters live in the unified `assignments` table, so no per-house tabs were added. See `MIGRATION.md` "Houses" for the canonical id → Hebrew name table.
- **Strict per-type assignment validation.** `validateAssignment` (both `lib/validate.js` and the Apps Script mirror) now **rejects** any cost field that doesn't belong to the chosen `employment_type` — e.g. `{employmentType: 'full_time', salary: 18000, hourlyRate: 80}` returns 400 with `hourlyRate not allowed for employmentType=full_time`. Previously such fields were silently zeroed out, which hid inconsistent UIs and let a hostile client smuggle stale data through. Zero / null / undefined / `""` for foreign fields is still accepted (so the migration mappers' outputs, which zero everything not relevant, still round-trip cleanly).

## [2.1.2] — 2026-05-22 — Archive on a dedicated page + Hebrew typo fix

- **Spelling**: section header had the wrong Hebrew — an extra ו between the leading א and the ר (the typo can't be written literally here because `tests/spelling.test.js` would catch it). The correct Hebrew is `ארכיב` (no ו after the א). Fixed every occurrence in `public/index.html` and `CHANGELOG.md`. New `tests/spelling.test.js` walks the whole repo on every test run and asserts the typo never appears again, plus asserts the dashboard nav uses the correctly-spelled `ארכיב עובדים`.
- **Archive moved off the dashboard**: the collapsed `ארכיב עובדים` section is gone from `centralView`. The archive now lives on its own SPA view, reached via a small `ארכיב עובדים` link in the topbar (right of the house tabs, before `יציאה`). Same dark-navy + gold theme; the view has its own page title, a single accent stat card showing the total, and the full table sorted newest-first.
- **Auth gating unchanged but pinned**: the archive view is part of the same SPA, gated by the existing PIN flow — `boot()` only renders any view (including archive) after `loadData()` succeeds against the auth-required `/api/data` endpoint. A new page-load test asserts this explicitly: with no token, the PIN overlay shows, the app container stays hidden, and no `.archive-table` ever reaches the DOM.
- **No Apps Script changes** — the data contract (`{ houses, events, archive }`) is unchanged. Railway picks this up on push; no manual redeploy needed.

### Tests added
- `tests/spelling.test.js`: repo-wide grep for the wrong spelling (extra ו), plus the dashboard's `ארכיב עובדים` correctness check.
- `tests/page-load.test.js`: dashboard view does NOT contain `.archive-table`; archive view renders archive rows sorted newest-first; PIN gate shows when there's no token (and no archive content leaks into the hidden app container). A new `authAndBoot()` helper seeds a session token via `localStorage`, stubs `fetch`, and awaits `boot()` so tests can drive the post-auth state deterministically.

## [2.1.0] — 2026-05-21 — Termination flow + archive + dashboard tweaks

Adds an explicit "end of employment" workflow with an archive tab, removes the past-events list from the dashboard, and tightens the row actions.

### Termination flow (new)
- New row-action button **`הפסקת עבודה`** opens a dialog: required termination date (defaults to today, **future dates are allowed** — explicit support for the "schedule end of employment for end of month" workflow), optional reason from `התפטרות / פיטורין / סיום חוזה / מעבר תפקיד / אחר`, optional note.
- New API action `terminateEmployee`. Under a script lock the Apps Script: snapshots the employee row from their home tab, auto-truncates any `active` coverage event whose subject is this employee (`end_date = min(current_end, terminationDate)`, status recomputed against today), appends to the new `archive` tab, then deletes the row from the home tab.
- The action is the natural cleanup: the employee disappears from the active roster everywhere immediately, while their cost continues to count until `terminationDate` arrives (see contract below).

### Cost attribution contract (extended)
```
pendingTerminations(archive, today) = archive rows where termination_date > today
pendingHomeCost(house)              = Σ salary × pct/100 over pending terminations whose home_house = house
homeCost(house)                     = Σ base × pct/100 over active roster + pendingHomeCost(house)
hostBonus(house)                    = unchanged: Σ event.bonusAmount where host_house = house AND active(today)
houseTotal(house)                   = homeCost(house) + hostBonus(house)
networkTotal                        = Σ homeCost(all) + Σ active bonuses
```
Base salary still appears in **exactly one** house total. A terminated employee with `termination_date > today` continues to count in their home house (no double-count, just deferred). On the day `today >= termination_date`, the archive row stops contributing — and because the action also pulls any of their active events' `end_date` in to `termination_date`, any associated bonus stops on the same day. The auto-truncation means the existing `isActive`/`activeBonus` logic naturally handles terminated subjects without a separate guard.

### Data model
- New **`archive`** tab (13 columns):
  ```
  id | employee_id | name | role | role_detail | salary | pct | notes |
  home_house | termination_date | reason_type | reason_detail | archived_at
  ```
  The snapshot lets cost reconstruction work without joining back to the active roster (the row is gone from the home tab by the time the dashboard renders).
- `setupSheets()` adds it idempotently.
- House tabs, events tab, and history tab are unchanged.

### API changes
- `terminateEmployee` action added.
- `/api/data` response shape grows: `{ houses, events, archive }`. The client tolerates the field being missing (old Apps Script deploys still work; archive defaults to `[]`).
- All other actions are unchanged.

### UI changes
- Dashboard section heading renamed: `אירועי כיסוי פעילים` → **`שיבוץ החלפות בין בתים`** (both the stat-card label and the section H2).
- The `אירועי כיסוי קודמים` section is removed from the dashboard. The data still gets recorded in the `events` tab — the Sheet stays the audit-of-record. The dashboard simply doesn't render past events anymore.
- New section **`ארכיב עובדים`** replaces it in the same screen position. Read-only table with `שם · בית · תפקיד · תאריך סיום · סיבה · הערה`. Rows are sorted by termination date, newest first. Dates render `DD/MM/YYYY` via the existing helper. (Moved to a dedicated SPA view in [2.1.2].)
- Row action buttons restyled and reordered: `תיעוד מעבר · עריכה · הפסקת עבודה · מחיקה`. Default is the visible outline (no longer using the `--muted` ghost). Two new hover modifiers — `.btn-accent-hover` (gold tint, used on `עריכה`) and `.btn-danger-hover` (soft red, used on `הפסקת עבודה` and `מחיקה`).
- House cards show a `כולל עובדים בתקופת הודעה {₪}` sub-line when there are pending terminations whose date is still in the future.

### Tests
- `tests/calc.test.js`: pending-termination assertions (past date contributes 0, future date still contributes, no double-counting in `networkTotal`, backward-compat when `archive` arg is omitted).
- `tests/validate.test.js`: `terminateEmployee` happy-path, accepts future dates, accepts missing reason, rejects unknown reason, rejects missing fields, rejects malformed date, caps long reasonDetail.
- `tests/server.test.js`: add → terminate round-trip (gone from roster + present in archive + active event auto-ended to terminationDate); future-date variant (event stays `active` until then).
- `smoke.js`: rewritten — add employee → start coverage → cost-attribution sanity check → **terminate today** (this is also the cleanup) → assert employee gone from roster, in archive, event auto-ended to today with `status=ended`, ramot home cost back to baseline, events +1 + archive +1. The previous `endCoverage` + `deleteEmployee` smoke steps are subsumed by the termination flow.

### Migration / rollout
1. Pull main; the Express server can deploy as soon as Railway picks up the push.
2. Redeploy `apps-script/Code.gs` to the bound Apps Script project (paste in the editor, Manage Deployments → edit existing → New version → Deploy).
3. Run `setupSheets()` once in the Apps Script editor — idempotent, adds the `archive` tab if missing.
4. No data migration needed; `archive` starts empty.

## [2.0.0] — 2026-05-21 — Coverage event model

Major redesign of how staff transfers are recorded. The old "move employee from house A to house B" model is replaced by a temporary-coverage model.

### Core principle
Every employee has **one home house**. Their base salary always stays attributed to the home house. Transfers between houses are **always temporary coverage events** with an optional bonus paid to the helping employee. Base salary is never double-counted.

### Cost attribution rules (contract)
```
homeCost(house)    = Σ (employee.salary × pct/100) for employees living here
hostBonus(house)   = Σ event.bonusAmount  where host_house = house AND active(today)
houseTotal(house)  = homeCost(house) + hostBonus(house)
networkTotal       = Σ homeCost(all houses) + Σ active bonuses

active(today)      ⇔ start_date ≤ today ≤ end_date     (inclusive)
```
Base salary appears in **exactly one** house total (the home). Bonuses appear only while active, only in the host. `status` in the sheet is a hint — date math is the source of truth, and the backend lazily corrects stale `active` rows to `ended` on every read.

### Data model
- House tabs (`ramot`/`asher`/`ofroni`/`rehab`): added column 7 **`role_detail`** for role specialization. Employees stay in their home tab permanently.
- New **`events`** tab: `id | employee_id | employee_name | home_house | host_house | start_date | end_date | reason_type | reason_detail | covers_employee_id | bonus_amount | status | created_at`.
- Legacy `history` tab is kept untouched as a backup. Run **`migrateHistoryToEvents()`** in Apps Script once after deploy to copy every legacy row into `events` as a single-day `ended` event.

### API changes
- `moveEmployee` action — **removed**.
- `startCoverage` — new. Server rejects overlapping active events for the same employee (HTTP 409) and rejects same home/host.
- `endCoverage` — new. Sets `end_date = today` (if still in future) and marks `status = 'ended'`.
- `/api/data` response shape: `{ houses, events }`. The `history` key is gone.
- `addEmployee` / `updateEmployee`: `role` is constrained to a closed set of 9 dropdown values; `roleDetail` field added (required when `role === 'אחר'`).
- `REASON_TYPES` updated to: `חופשה`, `חל״ת`, `מחלה`, `חופשת לידה`, `ניתוח`, `צורך תפעולי`, `אחר`.

### UI changes
- Accent color switched to burnt orange (`#A4561F`) so the app is visually distinct from the other E-ZONE apps.
- Role field is a dropdown of 9 values. Conditional second field appears for "מטפל/ת" (התמחות / סוג טיפול) and "אחר" (פרט/י תפקיד).
- Move dialog replaced with **"תיעוד מעבר זמני"** including `מחליף/ה את` dropdown and bonus amount.
- Home view: roster rows get a badge **"כרגע עוזר/ת ב{X} עד {Y}"** when employee has an active outgoing event.
- Host view: new section **"עוזרים זמניים / כיסוי"** listing incoming active coverage. Base salary stays out of this house's totals — only the bonus is counted.
- Central dashboard: new **"אירועי כיסוי פעילים"** section above the renamed **"אירועי כיסוי קודמים"** (was "היסטוריית העברות"). House cards show home count + house total (with a "כולל בונוסי כיסוי" line when applicable).

### Migration / rollout
1. Re-deploy `apps-script/Code.gs` to the bound Apps Script project. Run `setupSheets()` — idempotently adds the `events` tab and appends `role_detail` as column 7 of each house tab.
2. Run `migrateHistoryToEvents()` once to backfill ended events from the legacy `history` tab.
3. Existing employees whose `role` isn't in the new dropdown still display correctly. On first edit, the form defaults them to `role = 'אחר'` with the original text preserved in `roleDetail`.

### Removed
- The stale standalone `ezone-staffing.html` at the repo root (which was not served by Express).

## [1.0.0] — 2026-05-19

Initial cloud release. Prototype `ezone-staffing.html` (localStorage-only) converted to a full Express + Apps Script + Google Sheets app.

### Added
- `apps-script/Code.gs` — `doGet`/`doPost` web app with `addEmployee`, `updateEmployee`, `deleteEmployee`, `moveEmployee`. Move is atomic under a `LockService` script lock and appends to an append-only `history` tab. Shared-secret auth via `secret=` query param. Includes a `setupSheets()` helper that creates the five tabs with header rows on first run.
- `apps-script/appsscript.json` — Web App manifest, executes as user, anyone can call (security via shared secret).
- `server.js` — Express proxy. Routes:
  - `GET /api/health`
  - `POST /api/login` — PIN gate, returns an HMAC-signed session token. Rate-limited to 8 attempts per 15 minutes per IP.
  - `GET /api/data` and `POST /api/action` — auth-gated, proxied to Apps Script with `SHARED_SECRET` injected server-side. Apps Script URL is never exposed to the browser.
- `lib/auth.js` — HMAC-SHA256 stateless session tokens, constant-time PIN comparison via `crypto.timingSafeEqual`.
- `lib/validate.js` — Server-side input validation: house allowlist, employee field trimming + length caps, ISO date format, reason-type allowlist, same-source-and-target rejection.
- `lib/calc.js` — Shared (CommonJS + browser) helpers for cost computation, weighted totals, gross totals, average percentage.
- `public/index.html` — Cloud version of the prototype. PIN gate overlay, boot spinner, Hebrew error toasts, busy-state buttons, automatic re-prompt on token expiry. UI/RTL/visual design preserved verbatim from the prototype. Client output is HTML-escaped.
- `tests/` — Node built-in test runner. Covers calc rounding, token sign/verify/tamper/expiry, validation rules, and full HTTP round-trips (add/update/delete/move + history append) against a mocked Apps Script upstream.
- `README.md` — End-to-end setup, deploy steps, API contract, security notes.
- `railway.json` — Railway build/deploy config.

### Security
- Three independent secrets, all in env vars: `SHARED_SECRET` (server↔Apps Script), `MORAN_PIN` (gate), `SESSION_SECRET` (token signing).
- Server refuses to start without all four required env vars (or `SESSION_SECRET` shorter than 32 chars).
- Constant-time comparisons for both PIN and token signature.
- All inputs validated server-side before reaching Apps Script; Apps Script re-validates.
- Apps Script URL is server-only; the browser only talks to `/api/*`.
