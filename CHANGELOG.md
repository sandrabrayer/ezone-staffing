# Changelog

All notable changes to this project are documented here. Format inspired by [Keep a Changelog](https://keepachangelog.com/).

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
