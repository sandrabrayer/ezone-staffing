# NewGuides digest — contract

The E-ZONE **staffing** app publishes a small, read-only digest of upcoming
guide/employee arrivals for the **coordinators** app to consume (the same
cross-app pattern already proven by logistics + kitchen).

Staffing is the **sole writer** of a standalone spreadsheet it creates and
owns. The coordinators app (and `brayersandra@gmail.com`) read it; nobody
else writes it.

---

## Schema (frozen, append-only)

Tab name: **`NewGuides`** — a single tab in the digest spreadsheet. Row 1 is
the header (frozen). One row per (guide/employee × house) arrival.

| column      | type                    | notes                                                        |
|-------------|-------------------------|--------------------------------------------------------------|
| `house`     | text (canonical id)     | one of `ramot` / `raanana` / `efroni` / `rehab`              |
| `guideName` | text                    | the guide/employee display name                              |
| `startDate` | date `YYYY-MM-DD`       | the date the guide is placed at the house                    |
| `role`      | text, optional          | Hebrew role label (e.g. `מדריך/ה`); may be empty             |
| `updatedAt` | ISO 8601, UTC (`…Z`)    | when the digest row was last rebuilt                         |

**Append-only contract.** Columns are matched by header. Never reorder,
rename, or remove a column; any new column is added on the **end** only.

### HARD RULE — no financial fields

The digest carries **names, dates, and roles only**. No `salary`, `cost`,
`rate`, `budget`, `allowance`, `pct`, `retainer`, or any other financial value
is ever read into or written to the digest — not now, not in any future
column.

---

## Membership window

A guide appears in the digest when their **`startDate` falls within the
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
  house, role, or start date rebuilds the tab from scratch (`doPost` →
  `rebuildDigestSafe`). Best-effort — a digest failure never fails the write.
- **Periodic backstop:** a time-based trigger reruns `rebuildDigest` every
  6 hours, catching anything the inline rebuild missed and picking up dates
  that roll into/out of the window with no write.

---

## Setup (one-time)

Run from the Apps Script editor, in order:

1. **`setupDigestSpreadsheet`** — creates the spreadsheet, adds the
   `NewGuides` tab + frozen header, shares it read-only with
   `brayersandra@gmail.com`, stores the id in `DIGEST_SHEET_ID`, does a first
   rebuild, and logs the spreadsheet id + URL. Idempotent (reuses an existing
   spreadsheet if the property already points at one).
2. **`installDigestTrigger`** — installs the 6-hour backstop trigger.
   Idempotent (clears any existing `rebuildDigest` triggers first).

Read the spreadsheet id from the execution log after step 1.
