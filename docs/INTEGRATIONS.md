# E-ZONE Staffing — integration contracts

One row per consumer of staffing data. **Staffing is the source of truth for
who works where.** Every feed below is read-only, outbound, and authorized by
its own Script Property secret — no secret unlocks another feed.

> **Frozen.** Consumers match by **exact worker name**. Fields may be
> **added**; nothing may be removed, renamed, or reordered, and no worker name
> may be changed without a coordinated migration on both sides. No feed
> carries a salary, rate, cost, budget, allowance or retainer field — ever.

---

## 1. Coordinators app (רכזים) — guide roster

| | |
|---|---|
| **Source of truth** | staffing `workers` + `assignments` + `archive_v3` |
| **Endpoint** | `GET <staffing /exec>?action=getGuidesForCoordinators&secret=…` |
| **Key** | staffing Script Property `COORDINATORS_READ_SECRET` = coordinators Script Property `STAFFING_GUIDES_SECRET` |
| **Also needed on the consumer** | `STAFFING_SHEETS_URL` = the staffing `/exec` URL |
| **Direction** | staffing → coordinators. One way. The coordinators app cannot add, delete or rename a guide. |
| **Frequency** | on every `getGuides` read in the coordinators app (pull, not push) |
| **Payload** | `{ guides: [ { name, phone, active, houses, startDate } ] }` — one entry **per worker**, sorted by name |
| **Selection** | trimmed `role === 'מדריך/ה'`, current (`assignments`) **or** terminated (`archive_v3`). Terminated guides are published on purpose with `active:false` so the consumer can retire them. |
| **`active`** | `true` iff **any current** guide placement's normalized status is `active`. `chld` / `chlt` / `final_settlement` alone → `false`. Archived-only → `false`. |
| **`houses`** | sorted internal ids of **current** guide placements; for an archived-only guide, the archived placements' houses |
| **Matching** | exact name, **phone as secondary key**, upsert under `LockService` |
| **Error handling** | wrong / missing / unset secret → `401 {error}`, never data. Orphaned assignments and blank names are skipped silently. |
| **Retry** | none on the staffing side. The consumer's sync takes `tryLock(2s)`; on failure it skips the sync entirely. |
| **Failure visibility** | **consumer-side**: feed down ⇒ **zero writes**, the last-synced local roster is served, `rosterSource:'local'` and an amber «לא סונכרן מהסטאפינג» notice. **Staffing-side: the `feed_log` tab and the «סטטוס סנכרון» panel** (Phase 3) show when this consumer last pulled and how many rows it got. Amber past 24 h, grey if it has never pulled. |

## 2. Therapists app — therapist roster

| | |
|---|---|
| **Source of truth** | staffing `workers` + `assignments` |
| **Endpoint** | `GET <staffing /exec>?action=getTherapistsForTherapists&secret=…` |
| **Key** | staffing `THERAPISTS_READ_SECRET` = therapists `STAFFING_THERAPISTS_SECRET` |
| **Also needed on the consumer** | `STAFFING_SHEETS_URL` |
| **Direction** | staffing → therapists. One way. |
| **Frequency** | on every `getData` in the therapists app |
| **Payload** | `{ therapists: [ { name, active, houses, startDate } ] }` — one entry **per worker**, sorted by name |
| **Selection** | trimmed `role` ∈ `{ 'מטפל/ת', 'פסיכיאטר/ית' }`. Terminated placements live in `archive_v3` and are therefore excluded automatically — **unlike the coordinators feed**, which publishes them. |
| **`active`** | `true` iff any therapist-role assignment's normalized status is `active` |
| **Matching** | exact-name upsert; add / deactivate / reactivate only — **never a row delete or rename** |
| **Onward coupling** | downstream matching (including outpatient `TherapistRates`) is exact-string, so a rename must go through staffing **+** the therapists app's `migrateTherapistNames` **+** a `TherapistRates` row rename, together |
| **Error handling** | same fail-closed `401`. Orphans and blank names skipped. |
| **Retry** | none. Unset or unreachable ⇒ **no writes**; the last-synced list is served. |
| **Failure visibility** | consumer-side amber «לא סונכרנה» toast; staffing-side the `feed_log` row and the «סטטוס סנכרון» panel, amber past 24 h. |

## 3. Hadrachot app (הדרכות) — supervision-relevant roster

| | |
|---|---|
| **Source of truth** | staffing `workers` + `assignments` |
| **Endpoint** | `GET <staffing /exec>?action=getGuidesForHadrachot&secret=…` |
| **Key** | staffing `HADRACHOT_READ_SECRET` |
| **Direction** | staffing → hadrachot |
| **Payload** | `{ guides: [ { name, house, role, active, startDate } ] }` — one entry **per assignment** (not per worker), sorted by house then name |
| **`role`** | ASCII, computed server-side: `מדריך/ה`→`guide`, `מנהל/ת`→`manager`, `רכז/ת`→`coordinator`, and `מטפל/ת` **with** `role_detail` `עו"ס` → `social_worker`. `role_detail` itself never leaves the feed. The detail is normalized before comparing (gershayim ״ → ASCII `"`) because hand-entered cells mix quote characters. |
| **`active`** | `(a.status \|\| 'active') === 'active'` — per assignment |
| **Error handling / retry** | as above |
| **Failure visibility** | staffing-side the `feed_log` row and the «סטטוס סנכרון» panel; this consumer pulls rarely, so its staleness threshold is 7 days rather than 24 h. **The row is shown only while the hadrachot integration is configured** (see §4): an app that is not connected is not "never synced", and a permanently red row teaches its reader to ignore the panel. |

## 4. Hadrachot app → staffing — first-supervision status (the only inbound feed)

| | |
|---|---|
| **Source of truth** | the **hadrachot** app |
| **Endpoint** | staffing `GET /api/hadrachot-status` (Express) → proxies `HADRACHOT_STATUS_URL` with `HADRACHOT_STATUS_SECRET` |
| **Key** | Railway env vars `HADRACHOT_STATUS_URL` + `HADRACHOT_STATUS_SECRET` — **both optional, and neither is currently set.** Railway carries exactly six service variables: `APPS_SCRIPT_URL`, `MORAN_PIN`, `PORT`, `SESSION_DAYS`, `SESSION_SECRET`, `SHARED_SECRET`. The integration is therefore **out of scope**, and the app renders nothing for it. |
| **Direction** | hadrachot → staffing |
| **Frequency** | once per dashboard render |
| **Payload** | relayed verbatim under `data`; staffing never interprets it server-side. All flag logic (the 30-day grace rule, `firstHadrachaFlags`) is client-side in `lib/calc.js`. |
| **Error handling** | **unconfigured** → `200 {configured:false}`; **any upstream failure** → `5xx` with a generic body. In **both** cases the client renders **nothing** — never a false alert. The browser never sees the secret. The client stores the answer in `HADRACHOT_CONFIGURED`: while it is not `true`, **the whole feature is invisible** — no «הדרכה ראשונה» banner and no «הדרכות» row in the sync panel — and an unconfigured answer is final, so nothing is retried. **The code is kept, not deleted**: set the two env vars and everything returns on the next load. |
| **Retry** | none |
| **Failure visibility** | **none — silent by design.** A misconfigured URL and a healthy "nobody is overdue" look identical to Moran. The `feed_log` panel does NOT cover this: it logs feeds staffing *serves*, not the one it *consumes*. What is missing, and the two-step fix, is written up in [`CONSUMER_MIGRATION.md`](CONSUMER_MIGRATION.md). |

## 5. NewGuides digest (outbound, spreadsheet-to-spreadsheet)

| | |
|---|---|
| **Source of truth** | staffing |
| **Endpoint** | none — a **second Google Spreadsheet** (`DIGEST_SHEET_ID`), created and written solely by the staffing Apps Script. Tabs: `NewGuides`, `GuidesRoster`, `NewlyHired`, `NewlyDeparted`. See [`../DIGEST-CONTRACT.md`](../DIGEST-CONTRACT.md). |
| **Key** | Google Sheets sharing (`DIGEST_READER_EMAIL`), not a secret |
| **Direction** | staffing → readers |
| **Frequency** | rebuilt best-effort after any roster-changing action, plus a periodic trigger (`installDigestTrigger`) as the backstop |
| **Error handling** | `rebuildDigestSafe` swallows failures: **a digest failure must never fail Moran's mutation** |
| **Failure visibility** | **none.** A silently failing digest is invisible until someone reads a stale tab. The periodic trigger limits the damage. |

## 6. Railway proxy → staffing Apps Script (internal)

| | |
|---|---|
| **Endpoint** | `APPS_SCRIPT_URL` with `?secret=SHARED_SECRET` |
| **Direction** | both (GET roster bundle, POST mutations) |
| **Frequency** | every `/api/data` and `/api/action` |
| **Error handling** | non-JSON upstream → `502`; upstream `_status ≥ 400` is re-thrown with that status |
| **Retry** | **none** — a transient Apps Script hiccup surfaces to Moran as an error |
| **Failure visibility** | a Hebrew error in the UI; details in the Railway log |

---

## Contract summary — what may change

| Feed | Current key set | May never do |
|---|---|---|
| `getGuidesForCoordinators` | `workerId`, `assignmentIds`, `name`, `phone`, `active`, `houses`, `startDate` | remove or rename any of them; change a worker name; expose money |
| `getTherapistsForTherapists` | `workerId`, `assignmentIds`, `name`, `active`, `houses`, `startDate` | remove or rename any of them; expose money |
| `getGuidesForHadrachot` | `workerId`, `assignmentId`, `name`, `house`, `role`, `active`, `startDate` | remove or rename any of them; expose `role_detail` or money |

All three responses also carry **`feedGeneratedAt`** at the **top level** —
it is a property of the feed, not of a worker, so it is not repeated on every
entry. A consumer that wants a per-row timestamp calls that field `syncedAt`:
its own field, at its own write time.

`workerId` + `assignmentId(s)` were added in Phase 3, **additively**. The
coordinators and therapists feeds are one entry per **worker**, so their ids
are a sorted **list** — a scalar would be wrong for a worker at two houses.
The hadrachot feed is one entry per **placement**, so both of its ids are
scalars. See [`CONSUMER_MIGRATION.md`](CONSUMER_MIGRATION.md).

Each feed's exact key set is pinned by a guard test
(`tests/coordinators-endpoint.test.js`, `tests/therapists-endpoint.test.js`,
`tests/hadrachot-endpoint.test.js`). Adding a field means updating that pin
deliberately — which is the point.
