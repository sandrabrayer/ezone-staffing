# E-ZONE Staffing — Cloud Version

Workforce manager for the four E-ZONE houses (Ramot, Asher, Ofroni, Rehab). Single user: Moran, HR.

**Stack**
- Frontend: single-page HTML (RTL Hebrew), served from `public/`.
- Backend: Express proxy (`server.js`) — no DB; persists to a Google Sheet via Apps Script.
- Storage: Google Sheet, one tab per house + a `history` tab (append-only).
- Auth: PIN gate (Moran-only) in front of a signed-session token.
- Deploy: Railway.

---

## Repo layout

```
.
├── apps-script/
│   ├── Code.gs          # paste into Apps Script editor
│   └── appsscript.json  # Apps Script manifest
├── lib/
│   ├── auth.js          # HMAC token + constant-time PIN compare
│   ├── calc.js          # cost / weighted totals (shared with browser)
│   └── validate.js      # server-side input validation
├── public/
│   └── index.html       # cloud SPA
├── tests/
│   ├── auth.test.js
│   ├── calc.test.js
│   ├── server.test.js
│   └── validate.test.js
├── server.js            # Express app
├── package.json
├── railway.json
├── .env.example
├── CHANGELOG.md
└── ezone-staffing.html  # original prototype (kept for reference)
```

---

## Setup — end to end

### 1. Create the Google Sheet
1. Create a new Google Sheet. Note the **Sheet ID** — the long string in the URL between `/d/` and `/edit`.
2. You don't need to create the tabs by hand. The Apps Script `setupSheets()` helper will do it on first run.

### 2. Bind the Apps Script
1. From the Sheet, **Extensions → Apps Script**.
2. Replace the contents of `Code.gs` with `apps-script/Code.gs`.
3. Also replace the manifest: in the Apps Script editor, **Project settings → "Show 'appsscript.json' manifest file in editor"**, then paste `apps-script/appsscript.json`.
4. **Project settings → Script properties → Add script property**:
   - `SHEET_ID` → the Sheet ID from step 1.
   - `SHARED_SECRET` → generate a long random hex string. Save this — you'll paste the same value into Railway in step 4. Generate with:
     ```bash
     node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
     ```
5. Save, then in the Apps Script editor select `setupSheets` from the function dropdown and **Run**. Grant the requested permissions (read/write your Sheets). This creates the five tabs with header rows.
6. **Deploy → New deployment → Web app**:
   - Description: `E-ZONE staffing API`.
   - Execute as: **Me**.
   - Who has access: **Anyone**.
   - Click **Deploy**, authorize, and **copy the Web app URL** (ends in `/exec`). Save it — this is `APPS_SCRIPT_URL`.

> **Note on access = "Anyone"**: this is necessary because Railway calls the URL anonymously. Security is enforced by the `SHARED_SECRET` query param checked in `authorized()` — without the secret, every request returns `401`.

### 3. Local dev (optional)
```bash
cp .env.example .env
# fill in APPS_SCRIPT_URL, SHARED_SECRET (same value as Apps Script), MORAN_PIN, SESSION_SECRET
npm install
npm test
npm start
# open http://localhost:3000
```

> **If the project lives inside a Google Drive / OneDrive synced folder:**
> `npm install` can be extremely slow or even hang because of file-sync interference. Either:
> 1. Clone the project to a non-synced folder (e.g. `C:\dev\ezone-staffing\`) for local dev, **or**
> 2. Install dependencies to a sibling folder and point Node at it:
>    ```powershell
>    mkdir C:\ezone-deps; cd C:\ezone-deps
>    '{"dependencies":{"express":"^4.19.2"}}' | Out-File -Encoding utf8 package.json
>    npm install
>    $env:NODE_PATH="C:\ezone-deps\node_modules"; npm test
>    ```
> Railway and any other deploy target install in a normal filesystem, so this is only a local concern.

### 4. Deploy on Railway
1. Create a **new Railway project** from this repo (push it to GitHub first, separate repo per the brief).
2. Railway detects Node automatically (`npm install` then `npm start`).
3. **Variables → New Variable** — add four:
   - `APPS_SCRIPT_URL` — the `/exec` URL from step 2.6
   - `SHARED_SECRET`   — same value as in Apps Script Script Properties
   - `MORAN_PIN`       — Moran's PIN (digits, 4–12 chars)
   - `SESSION_SECRET`  — different long random hex (32+ bytes)
4. Optional: `SESSION_DAYS` (default `7`).
5. Deploy. Open the public URL → enter the PIN → the app loads.
6. Health check: `GET /api/health` → `{"ok":true,...}`.

---

## Sheet schema

Each house tab (`ramot`, `asher`, `ofroni`, `rehab`):

| id  | name | role | salary | pct | notes |
|-----|------|------|--------|-----|-------|

`history` tab (append-only — never overwritten or deleted):

| timestamp | name | from_house | to_house | reason_type | reason | date |
|-----------|------|------------|----------|-------------|--------|------|

- `id` is opaque (e.g. `e<base36-ts><rand>`). Sheet's row order is not significant.
- Cost is `round(salary * pct / 100)` and is computed client-side (not stored).
- `reason_type` is one of: `כיסוי חוסר`, `העברה קבועה`, `צורך תפעולי`, `אחר`.

---

## API

All `/api/data` and `/api/action` requests require `Authorization: Bearer <token>` where the token comes from `POST /api/login`.

| Method | Path           | Auth | Body                                  | Returns |
|--------|----------------|------|---------------------------------------|---------|
| GET    | `/api/health`  | —    | —                                     | `{ok:true}` |
| POST   | `/api/login`   | —    | `{pin}`                               | `{token, expiresInDays}` |
| GET    | `/api/data`    | Bearer | —                                   | `{houses:{...}, history:[...]}` |
| POST   | `/api/action`  | Bearer | `{action, ...}`                     | varies |

### `/api/action` payloads

```jsonc
// add
{ "action": "addEmployee",
  "house": "ramot",
  "employee": { "name": "...", "role": "...", "salary": 24000, "pct": 100, "notes": "" } }

// update
{ "action": "updateEmployee",
  "house": "ramot", "id": "e123",
  "employee": { ... } }

// delete
{ "action": "deleteEmployee",
  "house": "ramot", "id": "e123" }

// move (atomic — delete from source, append to target, append history)
{ "action": "moveEmployee",
  "fromHouse": "ramot", "toHouse": "asher",
  "id": "e123",
  "reasonType": "כיסוי חוסר",
  "reason": "...",
  "date": "2026-05-20" }
```

---

## Security

- **Three independent secrets, all in env vars**:
  - `SHARED_SECRET` — between Express and Apps Script. Apps Script rejects requests without it.
  - `MORAN_PIN` — gates the PIN screen. Compared in constant time.
  - `SESSION_SECRET` — signs session tokens (HMAC-SHA256). Server-only, never sent to the client.
- The Apps Script URL is **never exposed to the browser**. Only the Express server knows it.
- Session tokens are stateless (`<expiresAt>.<hmac>`) and stored in the browser's `localStorage`. Server verifies signature + expiry on every request.
- Login is rate-limited (8 attempts / 15 min / IP, in-memory).
- All inputs validated server-side (`lib/validate.js`) before being proxied to Apps Script. Apps Script validates again as a second line of defence.
- HTML output is HTML-escaped (`escapeHtml`).
- History is append-only — `moveEmployee` is the only path that writes it, and the Apps Script function never deletes rows from `history`.

If a secret leaks: rotate `SHARED_SECRET` in both the Apps Script Script Properties and Railway env vars; rotate `SESSION_SECRET` in Railway (this invalidates all existing tokens — Moran will need to re-enter her PIN).

---

## Testing

```bash
npm test
```

Covers:
- `lib/calc` — cost computation, rounding, weighted totals.
- `lib/auth` — token sign / verify / tamper / expiry; PIN compare.
- `lib/validate` — input shapes, length caps, date format, reason types, same-house rejection.
- `server.js` — full HTTP round-trip with a mocked Apps Script upstream, including add/update/delete/move flows and history append on move.

---

## Migrating Moran's existing data

The Sheet starts empty (only header rows). Moran will enter the workforce from scratch the first time she logs in.
