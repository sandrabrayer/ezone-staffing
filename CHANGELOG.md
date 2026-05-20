# Changelog

All notable changes to this project are documented here. Format inspired by [Keep a Changelog](https://keepachangelog.com/).

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
