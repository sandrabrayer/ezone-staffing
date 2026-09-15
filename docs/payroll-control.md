# בקרת שכר — payroll control

Monthly reconciliation of the payroll bureau's cost report against the staffing
roster, plus the compliance checks that decide which lines a human has to look
at. **Phase 1 covers salaried employees only** — the תלוש side of the report.
Freelancer invoices (the פרילנס / קבלני משנה block at the bottom of the same
workbook) are phase 2 and are deliberately not modelled.

---

## 1. What it is for

The bureau sends one PDF a month: *תמחיר חודשי כל העובדים*, company 026. It lists
every salaried employee, their salary and every employer cost, grouped by
department, with a per-department subtotal and a company total.

Nobody can usefully read 93 lines of that by hand every month. This tool:

1. parses the PDF **in the browser**, so the file never leaves the machine;
2. refuses the import unless the parsed rows reproduce the bureau's own printed
   total and headcount — the **reconciliation gate**;
3. matches every line to a staffing worker;
4. runs 17 compliance rules over the result;
5. shows Moran **only the flagged lines**, each with the expected and the actual
   value, and makes her approve or reject each one with a written reason;
6. locks the month once nothing is open, after which the run is read-only.

The single highest-value output is the **פנסיה panel**: employees with no
employer pension contribution at all who are past their six-month qualifying
period. That is a real, accruing liability, and it is invisible in the PDF.

---

## 2. The input file

| Property | Value |
|---|---|
| Report | תמחיר חודשי כל העובדים |
| Company | 026 |
| Producer | Microsoft Print to PDF |
| Page size | A4, 595 × 842 pt |
| Pages | 3 |
| Direction | right-to-left Hebrew |

### Column x-coordinate bands

The page is RTL, so the employee number and name sit on the **right** (largest
x) and the total cost on the **left**. `lib/payroll-parse.js` assigns each token
to a band by its x coordinate:

| Field | x band | Column |
|---|---|---|
| `total` | 30–75 | סה"כ עלות |
| `masSachar` | 80–115 | מס שכר |
| `masMaasikim` | 118–165 | מס מעסיקים או עלות הפחתה |
| `bituach` | 180–215 | ביטוח לאומי מעסיק |
| `shonot` | 225–255 | שונות |
| `pitzuim` | 262–295 | פיצויים |
| `keren` | 300–340 | קרן השתלמות |
| `tagmulim` | 350–375 | תגמולי מעסיק |
| `tashlumim` | 395–435 | תשלומים |
| employee number + name | x > 440 | מספר · שם העובד |

### Parsing rules learned from the real file

Each of these is covered by a test in `tests/payroll-parse.test.js`.

- **The 4-digit employee number is GLUED to the end of the reversed surname
  token.** `רובין` with number 33 arrives as `ןיבור0033`. The number is split
  off *before* the Hebrew is un-reversed, because the digits keep their
  left-to-right order while the letters do not.
- **A Latin-script name is GLUED to the amount.** An LTR name inside an RTL line
  collapses onto the תשלומים figure: `16,315.00MAKAROV SERGEI`. Split with
  `/^([\d,]+\.\d{2})([A-Za-z ]+)$/`.
- **A row may legitimately have NO תשלומים value** — employer contributions
  only. In August 2026, employee 1 has `tagmulim` 1,872.00 and `pitzuim`
  1,728.00 with no salary at all. That column must never be used to decide
  whether a line is a data row.
- **Department headers** read `מחלקה: 001 - רעננה פרדס` and apply until the next
  header.
- **Subtotal lines** (`סך למחל. …`) and the **company total** (`סה"כ לחברה`) are
  skipped as employee rows. The company total line supplies the two figures the
  gate checks; the subtotals are kept for cross-checking only.
- **Visual vs logical order.** Microsoft Print to PDF emits RTL runs in *visual*
  order, so each Hebrew token arrives reversed. The parser detects which
  orientation a document uses from the `מחלקה` keyword and handles both, so a
  change of printer driver cannot silently corrupt every name.

### The reconciliation gate

An import is accepted only if **both** hold:

- the sum of the parsed row totals equals the printed company total, to the
  agora; and
- the parsed row count equals the printed headcount.

Anything else is rejected outright with an error naming the delta — never a
partial import. The gate runs **twice**: in the browser before the upload, and
again in Apps Script before anything is written, so a broken or forged client
cannot store a run that does not add up.

The August 2026 file parses to exactly **93 rows** totalling **1,107,895.88**.

### The golden fixture

`tests/fixtures/tamhir-2026-08.json` holds those 93 parsed rows and is asserted
byte for byte against the parser's output.

**Provenance.** The rows, the department split, the printed company total and
the printed headcount are the **real August 2026 figures**, taken from the
bureau's own report for company 026 (`עלות שכר אוגוסט איזון.xlsx` on the shared
Drive, which is that report exported to a workbook). Every row's components were
verified to sum to its stated total, and the 93 totals to sum to 1,107,895.88.

`tests/fixtures/tamhir-2026-08.items.json` is the pdfjs **token stream** the
parser consumes. The source PDF was not in the repository, so this stream was
reconstructed from the real row data plus the column bands and glue quirks
documented above. It is therefore a faithful model of the layout, not a capture
of it. The parser accepts both text orientations and both glued and unglued
number forms precisely so that this reconstruction cannot be the only shape it
handles — but the **first real import should still be diffed against the
fixture** before the month is locked. If the real PDF tokenises differently,
replace `tamhir-2026-08.items.json` with a real capture:

```js
// in the browser console, on the payroll tab, with the PDF selected
const pages = await payrollReadPdf(document.getElementById('pr_file').files[0]);
copy(JSON.stringify(pages));
```

The 93 rows in `tamhir-2026-08.json` do **not** change — they are the real data,
and the parser must keep reproducing them.

> The fixture contains real salary figures. It lives in a private repository and
> should stay there.

---

## 3. House mapping

`DEPT_TO_HOUSE` in `lib/payroll-rules.js` is the **only** place a house id may
appear in the payroll subsystem. `tests/payroll-guards.test.js` fails the build
if one shows up in a rule, an endpoint or the UI.

| Dept | Bureau name | House | Status |
|---|---|---|---|
| 001 | רעננה פרדס | `pardes` | confirmed |
| 002 | קיסריה | `null` | **TO BE CONFIRMED** |
| 003 | רמות השבים | `ramot` | confirmed |
| 004 | מטה | `hq` | confirmed |
| 005 | רעננה אשר | `asher` | confirmed |
| 006 | הולינה | `null` | **TO BE CONFIRMED** |

**Two mappings are open and must be settled with Moran:**

- **002 קיסריה** — the staffing app has *two* Caesarea houses, `ofroni`
  (קיסריה עפרוני) and `rehab` (קיסריה ריהאב), and the bureau prints a single
  קיסריה department. Which house a קיסריה line belongs to cannot be derived from
  the report. In August 2026 this is **18 of the 93 lines**.
- **006 הולינה** — no corresponding house exists in the staffing app at all.
  **10 lines** in August 2026.

A `null` never silently becomes a house. Every line in an unmapped department
raises **R16**, and a run cannot be locked while any finding is open — so the
month cannot be closed until the mapping is decided.

**שדה אליעזר has no payroll department.** A worker placed there therefore never
appears in the file, which surfaces as **R03**. That is intended behaviour, not
a mapping gap.

---

## 4. The rules

All 17 live in `lib/payroll-rules.js` as pure functions. Ids are stable — they
are written into `PayrollFindings` rows. Every rule has a fail path *and* a pass
path in `tests/payroll-rules.test.js`; a guard test fails the build if one does
not.

| Id | Severity | Fires when |
|---|---|---|
| R01 | חריג | The employee number and the name both fail to match a staffing worker, or the match is ambiguous |
| R02 | חריג | The matched worker was terminated in `archive_v3` before the payroll month |
| R03 | חריג | An active worker with a current placement has no line in the file |
| R04 | חריג | The same employee number appears more than once in the file |
| R05 | לבדיקה | The mapped house differs from the worker's current placement house |
| R06 | חריג | Zero תשלומים but a non-zero total — employer cost with no salary |
| R07 | חריג | **No employer pension at all**, תשלומים ≥ 1,500, and tenure > 6 months |
| R08 | לבדיקה | `start_date` is missing, so pension compliance cannot be evaluated |
| R09 | לבדיקה | תגמולי מעסיק above 7.5 % of תשלומים |
| R10 | לבדיקה | פיצויים above 9 % of תשלומים |
| R11 | לבדיקה | The פיצויים : תגמולים ratio is neither 6 / 6.5 nor 8.33 / 6.5, tolerance 1 % |
| R12 | לבדיקה | ביטוח לאומי מעסיק below 3 % of תשלומים when תשלומים > 1,000 |
| R13 | לבדיקה | ביטוח לאומי מעסיק above 7.9 % of תשלומים |
| R14 | לבדיקה | תשלומים below 1,000 — verify entitlement |
| R15 | לבדיקה | Total cost per worker differs from the previous imported month by more than 15 % |
| R16 | לבדיקה | The department is absent from `DEPT_TO_HOUSE`, or present with an unconfirmed house |
| R17 | חריג | The row components do not sum to the stated total, tolerance one agora |

### Notes on the rules that are easy to get wrong

- **R07 is the primary rule.** "No employer pension at all" means neither
  תגמולי מעסיק nor פיצויים. **קרן השתלמות is a study fund, not pension, and never
  satisfies R07.** If `start_date` is missing, the rule emits **R08 instead,
  never R07** — a pension finding is never asserted against an unknown tenure.
- **R11** accepts exactly the two legal splits, 6 / 6.5 and 8.33 / 6.5, within a
  1 % relative tolerance. It stays silent when there is no pension at all
  (that is R07's job) and fires when there are פיצויים with no תגמולים.
- **R02** uses the *latest* archive row per worker, so a rehire is not flagged.
- **R15** needs a previous imported month; a first import has nothing to compare
  against and stays silent.
- Percentage rules skip rows with zero תשלומים — there is nothing to take a
  percentage of, and R06 is the finding that matters on such a row.

### What the rules find in the real August 2026 file

Running the rules over the golden fixture (no roster loaded) gives, besides the
93 unmatched-worker findings: **R16** ×28 (the two unconfirmed departments),
**R12** ×5, **R14** ×6, **R09** ×4, **R10** ×4, **R06** ×1 and **R13** ×1.
**R17 and R11 fire on nothing** — the bureau's arithmetic is sound and every
pension split in the file is legal, which is the check that these two rules
describe reality rather than a guess.

---

## 5. Matching a line to a worker

In this order, and never any other:

1. **Employee number**, if the staffing worker has one bound.
2. **Exact full-name match.**
3. **Normalised match** — double spaces collapsed, Hebrew punctuation dropped
   (geresh, gershayim, maqaf and their ASCII lookalikes).
4. Otherwise **unmatched**.

A hit on more than one worker at any step is `matchStatus: "ambiguous"`, binds
nobody, and raises R01. **Nothing is ever fuzzy-matched into a payment
decision** — a prefix is not a match.

### `payrollEmpNumber`

`workers` gained an appended `payroll_emp_number` column so Moran can bind a
worker to a bureau employee number **once, permanently**. Stored as TEXT with
leading zeros stripped, so the printed `0033` and a typed `33` are one key. The
same key-presence rule as every other appended worker column applies: an omitted
key leaves the binding alone, an explicit `''` clears it — an older client can
never unbind a worker by accident.

---

## 6. Schema

Four new tabs. **Headers are APPEND-ONLY and position-mapped**, like every other
tab in this sheet: a new column goes on the END, never in the middle.
`tests/payroll-guards.test.js` pins each array exactly.

**PayrollRuns** — one row per import

```
runId, month, importedAt, importedBy, fileName,
rowCount, parsedTotal, printedTotal, flaggedCount, status
```

`status` is `open` or `locked`.

**PayrollLines** — one row per employee line

```
runId, lineId, empNumber, rawName, matchedWorkerId, matchStatus,
dept, mappedHouse,
tashlumim, tagmulim, keren, pitzuim, shonot, bituach,
masMaasikim, masSachar, total
```

`matchStatus` is one of `number` / `exact` / `normalized` / `ambiguous` /
`unmatched`. `mappedHouse` is blank when the department's house is not confirmed.

**PayrollFindings** — one row per rule hit

```
runId, lineId, ruleId, severity, expected, actual, messageHe,
state, resolvedBy, resolvedAt, note
```

`severity` is `critical` or `warning`; `state` is `open` / `approved` /
`rejected`. `lineId` is blank for a run-level finding — R03 names a worker who
has no line at all.

**PayrollApprovalLog** — append-only audit trail

```
runId, lineId, action, actor, timestamp, note
```

One row per approve, reject and lock. It survives a re-import of the month.

---

## 7. Endpoints

All four ride the existing `SHARED_SECRET` gate. **No new secret, no new public
surface, nothing added to Script Properties.** Every write takes
`LockService.getScriptLock()` *after* validating its input, and releases it in a
`finally`.

| Action | Verb | Notes |
|---|---|---|
| `importPayrollRun` | `doPost` | Re-asserts the reconciliation gate server-side. Refuses a locked month with 409. Returns the minted `runId` and the runs it supersedes. |
| `getPayrollRun` | `doGet` | By `runId`, by `month` (newest run of that month) or neither (the run index). Also returns the previous month's per-employee totals as raw data for R15. Proxied as `GET /api/payroll/run`. |
| `resolvePayrollFinding` | `doPost` | Approve or reject one finding. **A note of 2–200 characters is mandatory.** Refused on a locked run. Appends to `PayrollApprovalLog`. |
| `lockPayrollRun` | `doPost` | Refused while any finding is open, and names how many. A second lock is a 409, not a silent no-op. |

The backend stores **raw data only**. It validates that a `ruleId` is one of the
17 known ids; it never decides which rule applies. A guard test asserts no
threshold and no house mapping exists in `Code.gs`.

### Input validation

Both the Express proxy (`lib/validate.js`) and Apps Script validate every field,
independently and fail-closed: month format, file name (path separators and
control characters stripped), run id shape, line id shape, employee number,
department, house id, match status, severity, rule id, note length, amount
range, line count cap, finding count cap, and duplicate line ids.

---

## 8. Monthly operating procedure

1. The bureau sends the month's *תמחיר חודשי כל העובדים* PDF.
2. Open **בקרת שכר** in the staffing app. Pick the payroll month and the file,
   then **ניתוח הקובץ**. The file is read in the browser; it is never uploaded
   anywhere.
3. Read the **בדיקת ההתאמה** panel.
   - **Passed** → the parsed rows reproduce the bureau's printed total and
     headcount. Continue.
   - **Failed** → the delta is named on screen. Do **not** proceed. Either the
     PDF is not the expected report, or the layout changed and the parser needs
     updating. Send the file on rather than working around it.
4. **שמירת הייבוא** stores the run. The triage screen opens showing
   **flagged lines only**.
5. Work the **פנסיה** panel first. Every R07 row is an accruing liability; every
   R08 row is a missing `start_date` in the staffing roster — fill it in, and
   the next import will answer the pension question properly.
6. Work the remaining findings. Each shows the expected and actual value side by
   side. **אישור** or **דחייה**, each requiring a note of 2–200 characters. The
   note is what makes the decision auditable a year later, so write what was
   checked, not "ok".
7. R01 findings usually mean a worker has no `payrollEmpNumber` bound yet. Bind
   it on the worker record once and it will match on its own from then on.
8. **ייצוא לאקסל** produces the reviewed run as an .xlsx.
9. When no finding is open, **נעילת חודש**. The run becomes read-only and the
   month can no longer be re-imported.

### When the layout changes

`lib/payroll-parse.js` is the only file that knows about the PDF. If the bureau
changes the report, adjust `COLUMN_BANDS` there and add a test to
`tests/payroll-parse.test.js` for whatever the new file does. The golden fixture
must keep parsing to its 93 rows — if a change breaks it, the change is wrong.

---

## 9. Where things live

| File | Role |
|---|---|
| `lib/payroll-parse.js` | PDF token stream → rows, and the reconciliation gate |
| `lib/payroll-rules.js` | `DEPT_TO_HOUSE`, matching, all 17 rules, the summary counters |
| `lib/xlsx_write.js` | Minimal .xlsx writer for the export |
| `apps-script/Code.gs` | The four endpoints, the four tabs, raw storage only |
| `lib/validate.js` | Proxy-side validation of the four actions |
| `server.js` | Serves the client libs and pdfjs same-origin; `GET /api/payroll/run` |
| `public/index.html` | The tab, between the `PAYROLL-CONTROL:START` / `END` markers |
| `tests/payroll-*.test.js` | Parser, rules, endpoints, guards, UI, export |

### House conventions this feature follows

- **No parentheses in any Hebrew UI string.** A parenthesis flips the direction
  of a right-to-left line and makes it unreadable. Guard-tested twice: on the
  source, and on the text the tab actually renders in jsdom.
- **No house id literal** outside `DEPT_TO_HOUSE`.
- **Append-only, position-mapped sheet headers.**
- **pdfjs is served same-origin** from `node_modules`, never from a CDN: an HR
  document must not have a third-party script in its path.
- The shared `/lib` scripts are classic `<script>`s in one global lexical scope,
  so a top-level name may not be declared in two of them. Guard-tested.

### Not in phase 1

- **Freelancer invoices.** The same workbook carries a פרילנס / קבלני משנה block
  with a separate total. It is not parsed, not stored and not checked.
- No service worker cache bump: this app has no service worker. The
  `sw.js` convention belongs to the coordinators and managers apps.
