# v3 migration — workers + assignments + absence/coverage

This file is the operational playbook for migrating an existing v2 E-ZONE Staffing Sheet to the v3 data model. Treat it as a step-by-step checklist: run **everything against a copy of the Sheet first**, verify, then repeat against production.

---

## What v3 changes

| concept | v2 | v3 |
|---|---|---|
| Employee → house | one home house, hard-coded | one **worker** with N **assignments**, one per house |
| Cost | `salary × pct/100` | per-type: `full_time` / `part_time` / `hourly` / `per_session` / `fixed_retainer` |
| Categories | n/a | Salaried (full/part/hourly) vs Freelancer (session/retainer) |
| Transfer event | one row with `host_house` + `home_house` + `covers_employee_id?` + `bonus_amount` | **two** linked rows: absence (who's missing from where) + coverage (who's helping, providing house, extra payment) |
| Reason values | 7 | **8** (added `אישי`) |
| Termination | per employee → `archive` | per assignment → `archive_v3` |

The legacy tabs (`ramot`/`asher`/`ofroni`/`rehab`, `events`, `history`, `archive`) are **read but never modified** by `migrateToV3`. A separate `finalizeV3` step renames them to `_legacy_*` once you're sure the cutover is stable.

---

## Before/after: sample rows

This is what `migrateToV3` will produce from a tiny synthetic legacy dataset. Use it to sanity-check the mapping before running anything.

### Input (legacy)

**`ramot` tab:**
```
id    | name | role     | salary | pct | notes      | role_detail
e1    | דנה  | אחות     | 18000  | 100 |            |
e2    | יוסי | מטפל/ת   | 12000  |  80 |            | אמנות
```

**`asher` tab:**
```
id    | name  | role    | salary | pct | notes | role_detail
e3    | מורן  | מנהל/ת  | 28000  | 100 |       |
```

**`events` tab:**
```
id   | employee_id | employee_name | home_house | host_house | start_date | end_date   | reason_type | reason_detail | covers_employee_id | bonus_amount | status | created_at
ev1  | e1          | דנה            | ramot      | asher      | 2026-04-01 | 2026-04-15 | חופשה        | חופשה שנתית    | e3                  | 2000          | ended  | 2026-04-01T08:00:00Z
ev2  | e2          | יוסי           | ramot      | asher      | 2026-05-01 | 2026-05-10 | מחלה         |                |                     | 800           | ended  | 2026-05-01T08:00:00Z
```

**`archive` tab:**
```
id    | employee_id | name | role | role_detail | salary | pct | notes | home_house | termination_date | reason_type | reason_detail | archived_at
arc1  | e9          | גילה  | אחות |              | 22000  | 100 |       | ofroni     | 2026-03-30        | התפטרות     |                | 2026-03-25T08:00:00Z
```

### Output (v3)

**`workers`** — 4 rows (e1, e2, e3 from house tabs; e9 from archive):
```json
{ "id": "e1", "name": "דנה",  "notes": "", "createdAt": "<migration time>" }
{ "id": "e2", "name": "יוסי", "notes": "", "createdAt": "<migration time>" }
{ "id": "e3", "name": "מורן", "notes": "", "createdAt": "<migration time>" }
{ "id": "e9", "name": "גילה",  "notes": "", "createdAt": "<migration time>" }
```

**`assignments`** — 3 rows (one per legacy house row):
```json
{
  "id": "a<...>", "workerId": "e1", "house": "ramot",
  "role": "אחות", "roleDetail": "",
  "employmentType": "full_time",
  "salary": 18000, "pct": 0,
  "hourlyRate": 0, "estHours": 0,
  "sessionRate": 0, "estSessions": 0, "retainerAmount": 0,
  "notes": ""
}
{
  "id": "a<...>", "workerId": "e2", "house": "ramot",
  "role": "מטפל/ת", "roleDetail": "אמנות",
  "employmentType": "part_time",
  "salary": 12000, "pct": 80,
  "hourlyRate": 0, "estHours": 0,
  "sessionRate": 0, "estSessions": 0, "retainerAmount": 0,
  "notes": ""
}
```

**`absences`** — 2 rows (one per legacy event):
```json
// From ev1 (covers_employee_id=e3 set): e3 was absent FROM asher
{
  "id": "ab<...>", "workerId": "e3", "house": "asher",
  "startDate": "2026-04-01", "endDate": "2026-04-15",
  "reasonType": "חופשה", "reasonDetail": "חופשה שנתית",
  "notes": "", "status": "ended"
}
// From ev2 (covers_employee_id empty): stub absence + marker note
{
  "id": "ab<...>", "workerId": "", "house": "asher",
  "startDate": "2026-05-01", "endDate": "2026-05-10",
  "reasonType": "מחלה", "reasonDetail": "",
  "notes": "יובא ממודל ישן ללא רישום נעדר", "status": "ended"
}
```

**`coverages`** — 2 rows (one per legacy event, linked to the absence above):
```json
{
  "id": "c<...>", "absenceId": "ab<...for-ev1>",
  "coveringWorkerId": "e1", "providingHouse": "ramot",
  "extraPayment": 2000, "notes": "יובא ממודל ישן"
}
{
  "id": "c<...>", "absenceId": "ab<...for-ev2>",
  "coveringWorkerId": "e2", "providingHouse": "ramot",
  "extraPayment": 800, "notes": "יובא ממודל ישן"
}
```

**`archive_v3`** — 1 row (copied from legacy archive):
```json
{
  "id": "arc<...>", "assignmentId": "", "workerId": "e9",
  "name": "גילה", "house": "ofroni",
  "role": "אחות", "roleDetail": "",
  "employmentType": "full_time", "salary": 22000, "pct": 0,
  "hourlyRate": 0, "estHours": 0,
  "sessionRate": 0, "estSessions": 0, "retainerAmount": 0,
  "notes": "",
  "terminationDate": "2026-03-30",
  "reasonType": "התפטרות", "reasonDetail": "",
  "archivedAt": "2026-03-25T08:00:00Z"
}
```

### Mapping rules

- `pct === 100` → `employment_type = full_time`, `pct` stored as `0`.
- `pct < 100`  → `employment_type = part_time`, `pct` preserved (clamped to `[1, 100]`).
- Legacy data **never** maps to hourly / per_session / fixed_retainer — those types are entered manually post-migration.
- Legacy `events` row with `covers_employee_id` set → real absence + coverage.
- Legacy `events` row WITHOUT `covers_employee_id` → **stub absence** (`worker_id=''`, marker note) + real coverage. The FK stays valid and the cost record is preserved.
- Unrecognized legacy `reason_type` values collapse to `אחר`.
- Worker IDs are reused from the legacy `employee_id` field. No `w<...>` prefix — legacy `e<...>` IDs become the new worker IDs unchanged.

---

## Phase 1 — Test on a copy of the Sheet

**Do this first. The whole point is to verify the migration end-to-end before touching production.**

### 1. Copy the Sheet
1. Open the production Sheet.
2. **File → Make a copy**. Name it something like `E-ZONE staffing — v3 migration test`.
3. Keep the copy open. Note the new Sheet ID from its URL (the long string between `/d/` and `/edit`).

### 2. Create a separate Apps Script project for the copy
1. From the copied Sheet: **Extensions → Apps Script**. This creates a **new** Apps Script project bound to the copy.
2. **Verify** the new project is bound to the copy (not production): the URL contains the copy's name in the breadcrumb.
3. Replace the contents of `Code.gs` with the v3 `apps-script/Code.gs` from this branch.
4. Also replace `appsscript.json` if it differs (it shouldn't for v3).
5. **Project settings → Script properties → Add script property:**
   - `SHEET_ID` = the copy's Sheet ID (NOT production)
   - `SHARED_SECRET` = any test value, e.g. `test-secret-aaaaaaaa` (NOT production's secret)

### 3. Deploy as a test Web App
1. **Deploy → New deployment → Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone**
2. Copy the **/exec** URL. This is your test `APPS_SCRIPT_URL`.

### 4. Run `setupSheetsV3`
1. In the Apps Script editor, select `setupSheetsV3` from the function dropdown.
2. Click **Run**. Grant requested permissions if asked.
3. Open the Sheet (the copy) and confirm five new tabs appeared with frozen header rows: `workers`, `assignments`, `absences`, `coverages`, `archive_v3`.
4. Legacy tabs (`ramot`/`asher`/`ofroni`/`rehab`/`events`/`history`/`archive`) should still exist unchanged.

### 5. **DRY RUN** the migration
1. Select `dryRunMigrateToV3` from the function dropdown.
2. Click **Run**.
3. Click **Execution log** (or **View → Logs**). You should see counts for each new tab plus 1–2 sample rows of each shape (workers / assignments / absences / coverages / archive_v3).
4. **Compare the samples to the legacy data they came from.** Are roles preserved? Are part_time pct values correct? Do absences point at the right house?
5. If anything looks wrong, stop here. Nothing has been written yet.

### 6. Run the real migration
1. Once dry-run output looks right, select `migrateToV3` and click **Run**.
2. Check the execution log — it logs `migrateToV3 ok: {workers: N, assignments: N, absences: N, coverages: N, archiveV3: N}`.
3. Open the Sheet and inspect each new tab. Rows should match the dry-run counts.

### 7. (Optional) Drive the v3 UI against the copy locally
1. In a clone of this repo on your machine: `cp .env.example .env` and set:
   - `APPS_SCRIPT_URL` = the test Web App URL from step 3
   - `SHARED_SECRET` = the test value from step 2.5
   - `MORAN_PIN` = any test PIN
   - `SESSION_SECRET` = any 32+ char random hex
2. `npm install && npm test && npm start`
3. Open `http://localhost:3000`, enter the test PIN, and exercise the v3 UI. **All your writes hit the copy, not production.**

### 8. Test rollback against the copy
1. In the Apps Script editor, select `rollbackV3` and click **Run**.
2. Confirm: the five v3 tabs are deleted; the `V3_MIGRATION_DONE` Script Property is cleared; legacy tabs are unchanged.
3. Re-run `setupSheetsV3` → `dryRunMigrateToV3` → `migrateToV3` to confirm the migration is idempotent over rollback.

---

## Phase 2 — Production cutover

Only do this after Phase 1 looks clean.

### Pre-flight
1. **Make a copy of the production Sheet for safety** (File → Make a copy). Set it aside untouched.
2. Pick a quiet time (Moran not actively using the app — the cutover window has ~3 minutes where writes shouldn't happen).
3. Have this MIGRATION.md open in another tab.

### Cutover order
1. **Paste the new `Code.gs`** into the *production* Apps Script project (bound to the production Sheet).
2. **Deploy → Manage deployments → Edit the existing Web App → New version → Deploy.** This keeps the same `/exec` URL so Railway's `APPS_SCRIPT_URL` env var doesn't need to change.
3. Run `setupSheetsV3` in the editor.
4. Run `dryRunMigrateToV3` — eyeball the counts.
5. Run `migrateToV3`.
6. Inspect the new tabs in the production Sheet.
7. Push the v3 UI to Railway (just merge `v3-worker-redesign` to `main`).
8. Wait for Railway to deploy (1–2 min). Reload the app. Confirm the new UI loads with the migrated data.

### After ~1 week of stable operation
1. Run `finalizeV3` once. This renames `ramot`/`asher`/`ofroni`/`rehab`/`events`/`history`/`archive` to `_legacy_*`.
2. The v3 UI is unaffected (it only reads the v3 tabs). The legacy data is preserved in the Sheet under the prefixed names.

---

## Rollback

### Before `finalizeV3`
1. In the Apps Script editor, redeploy the **previous** version of `Code.gs` from the deployment dropdown (Manage deployments → switch back to the v2 version).
2. Run `rollbackV3` — deletes the v3 tabs.
3. Done. Legacy data was never modified.

### After `finalizeV3`
1. Redeploy the previous `Code.gs` version (as above).
2. In the Sheet, rename `_legacy_ramot` → `ramot`, same for the other three houses, plus `_legacy_events` → `events`, `_legacy_archive` → `archive`, `_legacy_history` → `history`.
3. Run `rollbackV3` to drop the v3 tabs.
4. **Anything Moran entered through the v3 UI between finalize and rollback is lost** — it only exists in the v3 tabs. The Sheet's File → Version history is the last-resort recovery path.

### Absolute worst case
- Restore from the manual production-Sheet copy you made in the Pre-flight step.

---

## Notes on safety

- **No automatic destructive operations.** `migrateToV3` only appends; `rollbackV3` only deletes v3 tabs; `finalizeV3` only renames. None of these touches the original cell contents of `ramot`/`asher`/`ofroni`/`rehab`/`events`/`archive`.
- **Idempotency.** `migrateToV3` refuses to re-run while the `V3_MIGRATION_DONE` Script Property is set. To re-run, call `rollbackV3` first.
- **Auth.** The same shared-secret auth used in v2 protects v3 — no changes there.
- **Test SHEET_ID and SHARED_SECRET are different from production.** This is enforced by you in step 2.5 of Phase 1; the script has no way to know otherwise.
