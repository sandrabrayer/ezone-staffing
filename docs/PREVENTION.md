# Prevention — the guards that stop bad data being created

Phase 0's `runDataIntegrityReportNow()` *finds* bad data. This is the other
half: the guards that stop it happening. Each one exists because of a
specific way the app could previously be wrong.

---

## Duplicate workers

**The problem.** A worker at two houses is **one person with two
assignments**. Entered as two workers, they are counted twice in payroll and
both rows compete for the consumers' exact-name matching. Nothing checked.

**The guard.** `createWorker` compares the new name and phone against every
existing worker, normalized the way the consumers match: padding collapsed,
double spaces collapsed, bidi control marks stripped, Hebrew gershayim ״
folded to `"`, case folded, and for the phone every non-digit dropped. A
match refuses the write with `409` and **names the matching rows**.

**It is a warning, not a veto.** Two people really can share a name. Moran
says so by re-posting with `confirmDuplicate: true`, and only the strict
boolean `true` opens the guard — no truthy string does. The confirmation is
recorded in the audit log, so a duplicate is always a deliberate act with a
name on it.

The same normalization runs in the browser on every keystroke of **both** the
name and the phone field, so the inline warning and the server's refusal
always agree. The warning says the actual cause: **a second house is a second
assignment, not a new worker.**

## Transfer between houses

**The problem.** `moveAssignment` rewrote the `house` cell in place. The fact
that the worker had ever been at the old house was gone, and the old house's
cost simply stopped as if it had never happened.

**The guard.** A transfer now **ends the old placement and starts a new one**
with the same `workerId`:

1. the old placement is frozen into `archive_v3` with
   `termination_date = the day before the transfer date` and reason
   `מעבר תפקיד`;
2. a **new** assignment row is appended at the target house on the same
   terms, with the new appended `effective_from` column set to the transfer
   date;
3. any absence at the house being left is truncated to the same day;
4. the old live row is removed **last**, so a failure anywhere above leaves
   the original placement intact rather than losing it.

The two placements **tile the month exactly** — no gap, no overlap — so with
the Phase 1 engine a mid-month transfer costs **one** month of salary split
across the two houses, not two. `workerId` never changes, so no consumer sees
a departure and an arrival.

The new placement has a **new assignment id**. Callers must use the returned
`assignment`, not the id they sent; the UI reconciles from the server rather
than patching locally, because a local patch cannot represent an archive row.

## Termination

* **A reason is required.** An omitted one becomes the explicit `לא צוין`,
  which is in the dropdown. "No reason" is a choice on the record rather than
  an empty cell. Anything off-enum is still rejected. `אחר` requires detail.
* **The confirmation says what happens to the money**: a future date keeps
  the cost accruing until then, a past or present one zeroes it from that
  date. Moran should not have to guess which.
* **Idempotent.** An assignment that already has an `archive_v3` row cannot
  get a second one — the call is refused with `409` and the existing archive
  id. Double-archiving was the route to a cost counted twice, which is the
  Phase 0 report's `ARCHIVED_STILL_ACTIVE` finding.

## Absences

**The bug found while building this.** The stored `status` was derived as
`active(start, end, today) ? 'active' : 'ended'`, so a **not-yet-started**
absence was stored as `'ended'`. Two consequences, both real:

1. the overlap guard required `status === 'active'`, so **two overlapping
   planned absences were both accepted** and the same leave was recorded
   twice;
2. a planned absence appeared **nowhere** in the UI — it existed in the sheet
   and only there.

**The guard.** `status` is now one of `future` / `active` / `ended`, derived
from the dates on every read, with the stored cell as a cached hint that is
corrected in place. The overlap guard compares **dates** and ignores status
entirely.

Unstaffed positions — an absence row with no worker — may legitimately
overlap each other: two unfilled slots at one house is a real situation. They
are exempt from the guard and shown in **their own list**, visually distinct,
because "nobody is in this slot" and "this person is away" are different
facts and only one of them is about a person.

The house view now has four lists: active employee absences, unstaffed
positions, future absences, and history. A future absence can be **cancelled**
but not "ended" — there is nothing to end yet. An ended one is history and
offers no actions.

## Coverages

Six columns appended to the end of the `coverages` tab:
`replaced_assignment_id`, `role`, `shift_count`, `approval_status`,
`approved_by`, `cancelled`.

* **Idempotent save.** Two coverages are the same event when the worker, both
  houses and both dates match and the earlier is not cancelled. A
  re-submitted form returns the existing row instead of appending a second
  payment.
* **Overlap detection.** One person cannot cover two places at once.
  Cancelled rows are ignored, which is the point of cancelling rather than
  deleting.
* **Unavailable-worker detection.** Someone who is themselves absent in the
  range, or whose placement at the covering house is on חל"ד / חל"ת / גמ"ח,
  cannot be the one covering. **Refused, not warned**: paying an extra to a
  worker who was not there is the mistake this prevents.
* **The replaced placement must be real**, and at the receiving house — a
  link to a placement somewhere else says nothing.
* **Cancel, not delete.** `deleteCoverage` sets `cancelled` and keeps the
  row, so the history survives and the audit trail has something to point
  at. Idempotent; a cancelled coverage stops being charged and stops
  blocking a replacement for the same slot.
* **Payment counted once, at the receiving house** — enforced by the Phase 1
  engine, pinned by its tests.

**Backward compatibility:** a coverage row written before these columns
existed reads back as `approval_status = 'approved'` and `cancelled = false`.
Blank is treated as *approved*, never as *pending* — a backlog of work Moran
never created would be worse than useless — and never as cancelled, so
nothing that was being paid silently stops being paid.

## Phone numbers

Already correct before Phase 2, and now pinned by tests: `^0\d{9}$` after
stripping spaces and dashes, validated in the browser **and** in
`lib/validate.js` **and** in `Code.gs`; stored as text with the `@` number
format so Sheets cannot eat the leading zero; and restored defensively on
read for any cell Sheets already coerced to a number.

**Nothing is sent onward until the save succeeds.** `saveWorker` validates
the phone *before* any request, and creates the worker *before* the
assignment — so a malformed number produces zero requests, and a failed
worker create never leaves an orphan assignment.

## Audit log

A new append-only `audit_log` tab: `ts`, `action`, `entity`, `entity_id`,
`field`, `before`, `after`, `reason`. **One row per field changed**, so "who
changed what, from what, to what" is answerable without diffing snapshots.

It is created on first use and **never read by any feed** — the three feed
key-set guard tests keep it that way. It may carry salary values, because it
lives in the same HR-only spreadsheet the roster does.

**Best-effort by design: `auditLog_` never throws.** A logging failure must
not fail Moran's save — the same rule `rebuildDigestSafe` follows for the
digest. A test makes the audit tab unwritable and asserts the mutation still
succeeds.

---

## Security hardening

Closing findings **A3**–**A6** from [`STAFFING_AUDIT.md`](STAFFING_AUDIT.md).

### A3 · Brute-force lockout

Two layers. A per-IP window — 8 wrong PINs in 15 minutes locks that IP out —
and **escalation**: each further lockout doubles, 15 min → 30 → 60 …, capped
at 24 hours. A patient attacker gets a handful of guesses per day instead of
8 per quarter hour. A **correct** PIN clears the counter, so Moran mistyping
twice and then getting it right leaves no residue. While locked out, even the
correct PIN is refused — otherwise the lockout would be trivially bypassed by
whoever just found it. `Retry-After` tells the client when to come back.

The 401 body is **byte-identical** for a wrong PIN of any length, and never
says how many tries are left. The attempt map is bounded at 5,000 keys,
evicting oldest-first, so spoofed source addresses cannot grow it forever.

### A4 · Session revocation

A token is now `<expiresAt>.<jti>.<hmac>`, where `jti` is 16 random bytes.
`POST /api/logout` adds the `jti` to a revocation set and the token stops
working; the set is pruned by each token's own expiry, so it cannot grow
without bound. Two logins now produce two different tokens.

**Known limit, stated rather than hidden:** the revocation set lives in
process memory, so a Railway restart forgets it and a revoked-but-unexpired
token works again. Rotating `SESSION_SECRET` remains the hard revocation. For
a single-user app with no database this is the honest trade; the alternative
is a Sheets round-trip on every request.

**Tokens in the previous two-part format are not accepted**, so Moran
re-enters her PIN once after this deploys. That is the safe direction.

### A5 · Error bodies

A **4xx** from Apps Script is a validation result — short, deliberate, often
Hebrew, written to be shown to Moran verbatim — and is relayed, along with
the structured detail the UI acts on (`duplicates`, `conflictId`,
`archiveId`), which previously was discarded by the proxy and by `apiFetch`.

A **5xx** is an internal failure, and its message could carry up to 200
characters of whatever Apps Script returned — including Google's sign-in HTML
when a deployment loses anonymous access. Those now get a generic Hebrew
sentence; the detail stays in the Railway log, where it is useful and not
public.

### A6 · Security headers

`Content-Security-Policy`, `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
`Permissions-Policy` and HSTS on every response.

**The CSP has to allow `'unsafe-inline'`** for script and style: the app is
one HTML page with a large inline `<script>`. That is a real weakening of
what a CSP can do about injected script, and it is stated rather than papered
over — the value here is the rest of the policy: no external script or style
source, no framing, no object, `base-uri 'none'`, and connections only to our
own origin. Moving the inline script to a file with a nonce is a worthwhile
follow-up, not a Phase 2 change.

---

## Deliberately NOT changed

* **`readAbsencesSafe`'s write-back** still happens on read (finding B4). The
  correction is now three-way rather than one-way, but `doGet` is still not
  read-only. Making it so is a behaviour change for a separate PR.
* **`MORAN_PIN` is not renamed** to `APP_PIN` (finding A2). Renaming it would
  take the live app down between saving the Railway variable and the
  redeploy.
* **`SESSION_DAYS` default stays 7.** Shortening it would sign Moran out
  more often; it is a product decision, not a fix.
* **The query-string secret stays** (finding A7). Apps Script web apps cannot
  read custom request headers — this is forced by the platform.
* **No feed payload changed.** All three key-set guard tests pass untouched.
