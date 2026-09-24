# Marketer role — «משווק/ת» + «עמלה לפי מקרה»

Added September 24, 2026.

## What it is

| | Stored value | Label |
|---|---|---|
| Role | `משווק/ת` (Hebrew, stored verbatim like every role) | משווק/ת |
| Employment type | `per_case_commission` (ASCII, like every type) | עמלה לפי מקרה |

A marketer is paid a commission for each closed case. There is **no fixed rate
and no monthly count**, so the type's allowed cost fields are empty:

- the worker form and the assignment form hide every rate / count field and
  show a hint instead;
- validation (`lib/validate.js` and the Apps Script mirror) accepts the
  placement with no rate, and **rejects** any rate or count sent with it;
- the cost engine prices it with rule `COMMISSION_PER_CASE`: base cost 0,
  counted as a confirmed zero (not missing data). An allowance (רכב / דלק)
  still adds to the monthly cost.

The role and the type are independent: a marketer can be on another type if
that is the real arrangement. Picking «משווק/ת» in the role select
pre-selects «עמלה לפי מקרה»; opening an existing record never changes its type.

## Feeds — a marketer never leaves staffing

Each cross-app feed reads an allowlist of roles. «משווק/ת» is in none of them:

| Feed | Roles it reads |
|---|---|
| `getTherapistsForTherapists` | מטפל/ת, פסיכיאטר/ית |
| `getTherapistsForCoordinators` | מטפל/ת, פסיכיאטר/ית |
| `getGuidesForCoordinators` | מדריך/ה |

`tests/marketer-role.test.js` pins this through the pure builders AND through
`doGet` with each feed's own secret.

## Migration — `marketersMigrationPreviewNow()` / `applyMarketersMigrationNow()`

Before this role existed, marketers were entered as role «אחר» with פירוט
«משווק». To move them:

1. Wait for the Deploy Apps Script workflow run to go green.
2. Apps Script editor → choose `marketersMigrationPreviewNow` → **Run** (dry
   run — writes nothing). Open **Execution log**. Each `row |` line is one
   placement to be changed:
   `row | ציון מקנזי | <house> | <assignment id> | אחר/«משווק» → משווק/ת | <old type> → per_case_commission | kept: salary=… allowance=…`
3. If the list is right, choose **`applyMarketersMigrationNow`** → **Run**.
   Its first log line is `THIS RUN WRITES — …`, then the same report as the
   preview, starting with `APPLIED.` Running it a second time is harmless: it
   plans nothing and writes nothing.

| Dry run — writes nothing | Writes |
|---|---|
| `marketersMigrationPreviewNow()` | **`applyMarketersMigrationNow()`** |

Same naming rule as every other maintenance run (`docs/PAYROLL_VERIFIED_FIXES.md`).

Rules it keeps:

- Only role «אחר» (trimmed) with a פירוט of exactly `משווק`, `משווקת` or
  `משווק/ת` (whitespace collapsed). Any other «אחר» is left alone.
- Writes exactly two cells per placement: `role` and `employment_type`.
- Deletes nothing: `role_detail` and every cost column keep their values
  (they are ignored for commission pricing) and are printed in the report.
- One audit row per changed field (`action = migrateMarketers`).
- The bundle cache is dropped after a write, so the app shows the change on
  the next load.
- Idempotent: a second run plans nothing and writes nothing.

## Tests

`tests/marketer-role.test.js` — validation (proxy + Apps Script), enum parity
across the four mirrors, labels, cost, the three feeds, the migration
(dry run, exact cells, audit, idempotency), the pair
`marketersMigrationPreviewNow` / `applyMarketersMigrationNow` (warning first,
same report, idempotent, not an HTTP action) and the form wiring. The naming
rule itself is pinned in `tests/editor-run-pairs.test.js`.
