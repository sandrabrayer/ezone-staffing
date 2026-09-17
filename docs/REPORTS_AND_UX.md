# Reports and UX

Phase 4. Two independent pieces: the CSV exports, and the accessibility pass.

---

## The CSV exports

Thirteen read-only reports, in `lib/exports.js`. Pure functions: data in, a
CSV string out. No fetch, no writes, no stored state.

```
buildExport(kind, ctx) -> { filename, csv, rowCount, label }
```

### The numbers cannot disagree with the screen

Every cost figure comes from the **same `lib/cost-engine.js` report the page
is currently rendering** — the UI hands its live `COST` object to the
exporter rather than letting it recompute. A test proves the handed-in report
is honoured (it passes a report for a *different* month and asserts the
output changes), so "the export said 118,000 and the screen said 121,000"
cannot happen.

Where relevant, each row also carries the engine's **trace**: the rule that
fired, the arithmetic behind it, days counted, whether the number came from a
recorded actual or an estimate, and the `workerId` / `assignmentId`. A
surprising figure can be argued about from the file alone.

### The reports

| Button | File | What it answers |
|---|---|---|
| שכר חודשי | `payroll-YYYY-MM.csv` | one row per placement, with the full trace |
| בפועל מול אומדן | `actual-vs-estimate-YYYY-MM.csv` | how much of the month is confirmed, plus a totals row |
| לפי בית | `by-house-YYYY-MM.csv` | per house with that month's budget; the rows sum to the network row |
| לפי תפקיד | `by-role-YYYY-MM.csv` | every placement counted once |
| שכירים מול פרילנסרים | `salaried-vs-freelance-YYYY-MM.csv` | per line plus a subtotal per category |
| היעדרויות | `absences.csv` | all of them, with the derived status, unstaffed positions marked apart |
| החלפות | `coverages.csv` | including **cancelled** ones — the history is the point |
| חסרי תאריך תחילת עבודה | `missing-start-dates.csv` | placed workers with no start date |
| שיבוצים ללא תעריף | `missing-rates-YYYY-MM.csv` | placements whose cost fields cannot produce a number |
| עובדים ללא שיבוץ | `unassigned.csv` | separating "left" from "never placed" |
| כפילויות עובדים | `duplicates.csv` | by normalized name **and** by phone |
| חריגות תקציב | `budget-exceptions-YYYY-MM.csv` | over budget, **or** costing money with no budget at all |
| מצבת עובדים | `roster-YYYY-MM.csv` | the whole roster as a snapshot |

### CSV mechanics that are load-bearing, not decoration

* **UTF-8 BOM.** Without it, Excel on Windows renders Hebrew as mojibake.
* **CRLF line endings.** Without them, Excel treats the file as one row.
* **Quoting** of any cell containing a comma, a quote or a newline, with
  quotes doubled.
* **`0` is a value, not an empty cell** — asserted, because it is the easy
  one to get wrong.

### Formula injection is neutralized

Worker names and notes are **free text typed by a person**. Excel and Sheets
treat a cell beginning with `=`, `+`, `-`, `@`, a tab or a carriage return as
a **formula**. A note of `=1+1` becomes arithmetic; `=HYPERLINK("http://…")`
in a file someone forwards is a live payload.

Any cell starting with one of those characters gets a leading apostrophe —
Excel's own "treat this as text" prefix. The text is **preserved**, not
silently mangled, and a value that merely *contains* one of those characters
(`a-b`) is left alone, because only the first character matters. A test
drives a worker literally named `=HYPERLINK(...)` through a real export and
asserts the cell is inert and the text still readable.

### Read-only by construction

No export posts anything, stores anything, or touches its input — a test runs
all thirteen over one fixture and asserts the input object is byte-identical
afterwards. A report with no rows says **`אין נתונים לדוח …`** rather than
downloading an empty file.

---

## The accessibility pass

### An explicit label on every input

**60 of 62 form controls had no programmatic label.** The page had visible
`<label>` text, but without `for=`, so nothing connected it to its field: a
screen reader announced 60 unnamed boxes, and clicking a label did not focus
its input.

Every one now has `for=`. The PIN field gained a visible label and
`aria-describedby` pointing at its error, which is `role="alert"` so a wrong
code is **announced** rather than only turning red. The two search boxes got
labels that are visually hidden but present — a placeholder is not a label,
because it disappears the moment you type.

Two tests hold this: **zero unlabelled controls**, and **no label pointing at
a control that does not exist**. A new field cannot be added without one.

### Keyboard navigation

* **Escape** closes the open dialog.
* **Tab** is kept inside it. Without this, a keyboard user tabs out of an
  open dialog into the page behind and cannot tell where they are. Hidden
  fields — the per-type cost inputs — are skipped.
* **Ctrl/Cmd+Enter** saves, so the save button need not be tabbed past every
  field to reach.
* **A visible focus ring** on everything reachable, via `:focus-visible` so a
  mouse click does not draw one. The browser default is easy to lose against
  this palette.
* **Clicking the backdrop** closes; clicking inside does not.
* Every modal carries `role="dialog"`, `aria-modal="true"` and a name.

### Loading, empty and error states

* **Loading** is `role="status"` with `aria-live` and the words «טוען נתונים».
  A spinner alone says nothing to a screen reader.
* **Error:** a failed initial load used to be a toast that faded after three
  seconds over an empty screen, with no way back but a manual refresh. It is
  now a **persistent** `role="alert"` panel with a **נסי שוב** button that
  re-runs the load. A **401 still goes to the PIN gate** — an expired session
  is not a server error.
* **Empty states** are sentences, and a test asserts none is a bare gap.

### Unsaved-change warning

Any edit inside an open dialog marks the form dirty, via one delegated
listener rather than an `oninput` on sixty fields. Closing it — by Escape, by
the backdrop, or by **ביטול** — then asks **«יש שינויים שלא נשמרו. לסגור בלי
לשמור?»**, and a *no* keeps the typed work on screen. `beforeunload` asks the
browser to prompt when leaving the page with an open dirty form.

The flag is cleared when a dialog opens **and** when one closes, so a new
dialog never inherits the last one's state; and a **successful save clears
it**, so the discard question can never fire after a save that worked. All
four of those are tested, because each is a way this class of feature goes
wrong.

### Save confirmation

The toast is `role="status"` / `aria-live="polite"` / `aria-atomic="true"`, so
a confirmation is **announced** and read whole. Every successful save goes
through `toastSaved()`, which announces and clears the dirty flag together —
one call rather than two things to remember.

---

## Deliberately NOT done

* **No `Code.gs` change**, so merging Phase 4 does **not** deploy Apps
  Script. Exports are projections of data the browser already holds; putting
  them server-side would add a route, a payload and a way to be wrong.
* **No server-side export route**, for the same reason. The files never leave
  the browser.
* **No new dependency.** The CSV writer is thirty lines, and a library would
  have to be audited for the formula-injection behaviour anyway.
* **A full WCAG audit is not claimed.** Contrast ratios, heading order and
  landmark structure were not systematically checked. What is claimed is
  exactly the five items the brief names, each with a test.
* **The CSP still needs `'unsafe-inline'`** (Phase 2, finding A6). Moving the
  inline script to a file with a nonce remains the right follow-up and is out
  of scope here.
