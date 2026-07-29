# Staffing digest — contract

The E-ZONE **staffing** app publishes a small, read-only digest of
guide/employee data for the **coordinators** app to consume (the same
cross-app pattern already proven by logistics + kitchen).

Staffing is the **sole writer** of a standalone spreadsheet it creates and
owns. The coordinators app (and `brayersandra@gmail.com`) read it; nobody
else writes it.

The digest spreadsheet has **two tabs**, both rebuilt together on every
relevant roster write and by the periodic trigger:

- **`NewGuides`** — the near-term arrivals window (guides whose start date
  falls in the current week or the next two weeks).
- **`GuidesRoster`** — the **full** active-guide roster with each guide's
  employment start date, independent of any date window.

---

## Schema — `NewGuides` (frozen, append-only)

Tab name: **`NewGuides`**. Row 1 is the header (frozen). One row per
(guide/employee × house) arrival.

| column      | type                    | notes                                                        |
|-------------|-------------------------|--------------------------------------------------------------|
| `house`     | text (canonical id)     | one of `ramot` / `raanana` / `efroni` / `rehab`              |
| `guideName` | text                    | the guide/employee display name                              |
| `startDate` | date `YYYY-MM-DD`       | the date the guide is placed at the house                    |
| `role`      | text, optional          | Hebrew role label (e.g. `מדריך/ה`); may be empty             |
| `updatedAt` | ISO 8601, UTC (`…Z`)    | when the digest row was last rebuilt                         |

**Append-only contract.** Columns are matched by header. Never reorder,
rename, or remove a column; any new column is added on the **end** only.

---

## Schema — `GuidesRoster` (frozen, append-only)

Tab name: **`GuidesRoster`**. Row 1 is the header (frozen). One row per
**active** (guide/employee × house) placement — the full roster, with **no**
date-window filter, so a coordinator always has every guide currently at their
house.

| column      | type                    | notes                                                        |
|-------------|-------------------------|--------------------------------------------------------------|
| `house`     | text (canonical id)     | one of `ramot` / `raanana` / `efroni` / `rehab` (same mapping as `NewGuides`) |
| `guideName` | text                    | the guide/employee display name                              |
| `startDate` | date `YYYY-MM-DD`, may be empty | the guide's **employment start date** (תאריך תחילת עבודה); `''` when not yet entered |
| `updatedAt` | ISO 8601, UTC (`…Z`)    | when the roster row was last rebuilt                         |

Notes:

- **`startDate` here is the worker-level employment start date**, a distinct
  field from `NewGuides.startDate` (which is the per-house placement date). It
  is entered per employee (edit dialog or the bulk fill-in view) and starts
  **empty** for existing employees — an empty `startDate` is valid and expected
  until a date is filled in.
- **All active guides** are listed regardless of when they started; a guide
  placed at two houses appears once per house.
- Same rows as the roster minus excluded houses (see mapping below) and
  orphaned assignments (no matching worker).

**Append-only contract.** Columns are matched by header. Never reorder,
rename, or remove a column; any new column is added on the **end** only.

---

## HARD RULE — no financial fields (both tabs)

The digest carries **names, dates, and roles only**. No `salary`, `cost`,
`rate`, `budget`, `allowance`, `pct`, `retainer`, or any other financial value
is ever read into or written to **either** tab — not now, not in any future
column.

---

## Membership window (`NewGuides` only)

The `GuidesRoster` tab has **no** membership window — it always lists every
active guide. The window below applies to **`NewGuides`** only.

A guide appears in `NewGuides` when their **`startDate` falls within the
current week or the next two weeks** — i.e. arrivals the house coordinator
should prepare for.

The window is inclusive: from the **Sunday** of the current week (weeks start
Sunday — Israel) through the **Saturday two weeks later** (a 21-day span),
evaluated in the `Asia/Jerusalem` script timezone.

**What `startDate` is.** The staffing app records when a guide is placed at a
house (the assignment's creation date); it has no separate future-dated
"planned start" field. So in practice the digest lists guides added during the
current week. The forward-looking window is retained so that if a future-dated
start is ever recorded, it surfaces automatically without a schema change.

---

## House id mapping

Digest houses use canonical ids. Internal staffing house ids are mapped, and
non-physical / pre-opening houses are **excluded**:

| internal id   | Hebrew display   | digest id  | included? |
|---------------|------------------|------------|-----------|
| `ramot`       | רמות השבים       | `ramot`    | ✅        |
| `asher`       | רעננה אשר        | `raanana`  | ✅        |
| `ofroni`      | קיסריה עפרוני    | `efroni`   | ✅        |
| `rehab`       | קיסריה ריהאב     | `rehab`    | ✅        |
| `pardes`      | איזון רעננה - פרדס (הפרדס) | —  | ❌ pre-opening |
| `sde_eliezer` | שדה אליעזר       | —          | ❌ pre-opening |
| `hq`          | מטה              | —          | ❌ admin pseudo-house |

---

## Ownership & freshness

- **Spreadsheet:** a standalone Google Sheet the staffing app creates and owns.
  Its id is stored in the `DIGEST_SHEET_ID` Apps Script property. Shared
  **read-only** (Viewer) with `brayersandra@gmail.com`.
- **Rebuild on write:** every roster write that can change a guide's name,
  house, role, or start date — including the bulk `setWorkerStartDates` action —
  rebuilds **both tabs** from scratch (`doPost` → `rebuildDigestSafe`).
  Best-effort — a digest failure never fails the write.
- **Periodic backstop:** a time-based trigger reruns `rebuildDigest` every
  6 hours, catching anything the inline rebuild missed and picking up dates
  that roll into/out of the `NewGuides` window with no write.

---

## Setup (one-time)

Run from the Apps Script editor, in order:

1. **`setupDigestSpreadsheet`** — creates the spreadsheet, adds the
   `NewGuides` tab + frozen header, shares it read-only with
   `brayersandra@gmail.com`, stores the id in `DIGEST_SHEET_ID`, does a first
   rebuild (which also creates the `GuidesRoster` tab), and logs the
   spreadsheet id + URL. Idempotent (reuses an existing spreadsheet if the
   property already points at one).
2. **`installDigestTrigger`** — installs the 6-hour backstop trigger.
   Idempotent (clears any existing `rebuildDigest` triggers first).

Read the spreadsheet id from the execution log after step 1.
