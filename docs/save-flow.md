# Save flow — why saving felt slow and uncertain, and what changed

Date: 2026-09-26. Report from Sandra (production): saving workers or placements
is very slow, there is no spinner, and it is not clear whether it saved. One
placement edit (role → «משווק/ת») looked as if it had not persisted.

## How this was measured

The production host cannot be reached from the build environment, so **none of
these numbers are production numbers**. The method is the same as
`docs/perf-open.md`:

- `scripts/measure-save.js` runs the real `server.js` as a child process against
  a **mock Apps Script** that answers every call, read or write, after **3,000 ms**.
- The bench times `POST /api/action` (how long the save button stays busy), plus
  the full reload that some saves waited for.
- The page-side behaviour (race, spinner, messages, preview) is pinned in jsdom
  by `tests/save-flow.test.js`.
- **Before** = `main` at `ad02287`. **After** = this branch.

## A save, end to end

| # | Step | Where | Before | After |
|---|---|---|---|---|
| 1 | Click | `saveWorker()` / `saveAssignment()` / … | `setBusy()`: button disabled, label «שמירה…» (no spinner) | `beginSave()`: spinner + «שומר…» + disabled + `aria-busy`, at once. A second click, Enter or double tap is ignored while it runs. |
| 2 | Client → proxy | `doAction()` → `POST /api/action` | no timeout: a hung save left the button busy until the browser gave up | 30 s timeout → «השמירה לא אושרה — נסו שוב», button re-enabled, background refresh to learn what really got stored |
| 3 | Proxy queue | `lib/upstream.js` | writes shared the **user** lane with reads, FIFO, 2 slots. A write waited for a free slot **and** behind every read queued before it | writes have their **own lane and slot** (`UPSTREAM_WRITE_CONCURRENCY`, default 1). They never wait behind a read, and reads cannot starve them. |
| 4 | Apps Script `doPost` | `Code.gs` | wrote the row and echoed back **the request** | writes the row, reads it **back** from the sheet and returns it (`confirmed: true`), through the same mapper the bundle uses (`assignmentFromRow_` / `workerFromRow_`) |
| 5 | Proxy after the write | `server.js` | drops the cache before and after the write, then re-warms 1.5 s later | unchanged |
| 6 | UI update | save handlers | most patched from the echo. **Terminate, transfer and every fallback path awaited a full reload** — a cache MISS (the write had just dropped the cache), i.e. a second Apps Script execution while the user waited | patches from the confirmed row (terminate / transfer: placement removed, archive row added). A **background** refresh follows every save; nothing waits for it. |
| 7 | Result | toast | success in the neutral colour for 3.2 s; errors in English (`salary not allowed for employmentType=…`) for 3.2 s | green «נשמר» / specific text. Red Hebrew error **with the reason**, 8 s, `role="alert"`. |

## Findings

| # | Question | Answer (before) | Evidence |
|---|---|---|---|
| 1 | Can a write wait behind keep-warm / background reads? | **Yes.** Both slots can be taken by reads: a keep-warm or «מתעדכן…» refresh, plus a post-save reload started after `invalidate()` dropped read coalescing. The write then waits for one of them to finish, and behind any read queued ahead of it in the same FIFO lane. | bench scenario 2: **5,958 ms** instead of 3,011 |
| 2 | **The «role change did not persist» report** | **Reproduced.** A `/api/data` read that started before the save (e.g. the «מתעדכן…» follow-up refresh after opening the app) landed after it and was applied wholesale. The saved row was painted over with the pre-save one: the role went back from «משווק/ת» to «אחר» on screen. The data was saved; the screen said it was not. Editing again from that screen could have written the old values back. | jsdom repro on `main`: `after save: משווק/ת` → `after in-flight refresh landed: אחר` |
| 3 | Can a save be refused because the page is still in the stripped preview (#46)? | Yes, by design: every form opener and `doAction` refuse. It was **not silent** (a toast), but the buttons looked clickable and the toast lasted 3.2 s. If the refresh kept failing, everything stayed refused with only that toast. | `blockedInPreview()` |
| 4 | Is any refusal or error silent? | Not silent, but **easy to miss and unreadable**: 3.2 s toasts in the neutral colour; validation errors in English straight from the validator; a hung save had no deadline. | code |
| 5 | Does the UI re-fetch the full bundle after every save? | Not every save, but **terminate, transfer and every fallback path** did, and blocked on it. Because the write had just invalidated the cache, that reload was always a MISS: a second full Apps Script execution. | bench scenario 3: **6,020 ms** until the form closed |
| 6 | Worker form (where placements are edited) | Every edit sent **updateWorker, then updateAssignment**, one after the other — even when only the role changed. That is two Apps Script executions. | bench scenario 4: **6,017 ms** |
| 7 | Placement role change «אחר» → «משווק/ת» + «עמלה לפי מקרה» | The current page already sends only the type's allowed cost fields. The validator accepts `per_case_commission` without them, and rejects a leftover `salary` (`salary not allowed for employmentType=per_case_commission`). That rejection **was shown, but in English**. It is not what hid Sandra's edit — finding 2 is. | `V.validateAction` check |
| 8 | Latent bug found on the way | The standalone placement modal (`openAssignment`, not linked from any screen) crashed on open: it pre-filled per-session inputs it does not have. | jsdom |

## Fixes

- **Write priority** (`lib/upstream.js`, `server.js`): a separate write lane with
  its own slot.
  - At most `UPSTREAM_CONCURRENCY` reads (2) plus `UPSTREAM_WRITE_CONCURRENCY`
    writes (1) run at once.
  - Writes queue only behind writes, which Code.gs serializes under LockService
    anyway.
- **Saved-row confirmation** (`Code.gs`): `addAssignment`, `updateAssignment`,
  `createWorker` and `updateWorker` return the row read back from the sheet.
- **No stale overwrite** (`public/index.html`): `doAction` counts writes in
  flight. `loadData` discards any read that overlapped a write and schedules a
  fresh one. The confirmed row stays on screen until a post-save read replaces it.
- **Nothing waits for a full reload**: the form closes on the confirmed row, and
  one background refresh (`refreshAfterSave`, with «מתעדכן…» in the topbar)
  follows every save.
- **Button**: `beginSave()` shows spinner, «שומר…», disabled and `aria-busy`, and
  refuses a second submit.
- **Result**: `toastSaved()` in green; `saveErrorText()` turns every failure into
  Hebrew and keeps the reason:
  - field not allowed for the type → which field and which type;
  - 400 → the invalid value;
  - 404 → the record was not found;
  - 409 → the conflict;
  - offline → no connection to the server;
  - timeout.
- **Timeout**: 30 s → «השמירה לא אושרה — נסו שוב», then a background refresh.
- **Preview**: every save, edit, delete or export button shows
  «טוען נתונים עדכניים…» and is disabled. The modal save buttons show the same
  label. All of them re-enable by themselves the moment fresh data lands
  (`syncPreviewButtons`).
- **Marketer**:
  - `stripForeignCostFields()` removes every cost field the type does not allow
    before sending, whatever the hidden inputs hold.
  - The worker form writes the worker row only when something about the person
    changed, so a role-only edit is **one** write.
- `openAssignment` / `saveAssignment` skip inputs the modal does not have.
- Service worker cache `v5` → `v6`, so installed copies pick up the new page.

## Before / after

Mock Apps Script at 3,000 ms per call. "User waits" is the time from click
until the button is free again and the form is closed.

| Scenario | Before — user waits | After — user waits |
|---|---|---|
| 1 · a save with nothing else running | 3,011 ms | 3,012 ms |
| 2 · a save while two reads are in flight and one is queued | **5,958 ms** | **3,007 ms** |
| 3 · terminate / fallback save (was: save + blocking full reload) | **6,020 ms** | **3,010 ms**, with the full reload finishing in the background |
| 4 · worker form, role change only (was: two writes) | **6,017 ms** | **3,010 ms** |

Scenario 1 is Apps Script's own execution time; nothing on our side can shorten
it. What changed is that nothing else is added on top of it, and the user sees
exactly what happened.

Re-run: `node scripts/measure-save.js`. For the worker form after the fix, run
`SAVE_WRITES=1 node scripts/measure-save.js`, since the bench mimics the client
there.

## Tests

`tests/save-flow.test.js` (15) pins:
- write priority under load;
- no starvation;
- the proxy wiring;
- spinner and disabled state;
- no double submit;
- the success, failure and timeout messages;
- the Hebrew error mapping;
- the stale-read race (the «role did not persist» case);
- the marketer payload accepted by the proxy validator;
- the one-write role change;
- the preview button state and its automatic release.
