# Consumer migration — switching to `workerId` with a name fallback

Staffing's three read-only feeds now carry stable ids **additively**. Nothing
was removed or renamed, so **every consumer keeps working untouched** — this
document is how they stop depending on exact names when their owners are
ready.

> **Nothing in this document edits another repository.** The two sections
> below are prompts to paste into a Claude Code session opened on *that*
> repo. They are written as instructions to whoever does that work, not as
> changes to this one.

---

## What changed on the staffing side

| Feed | Added | Shape |
|---|---|---|
| `getGuidesForCoordinators` | `workerId`, `assignmentIds` | one entry **per worker**, so the ids are a sorted **list** |
| `getTherapistsForTherapists` | `workerId`, `assignmentIds` | same |
| `getGuidesForHadrachot` | `workerId`, `assignmentId` | one entry **per placement**, so both are **scalars** |
| all three | `feedGeneratedAt` | **top level** of the response, not per entry |

`feedGeneratedAt` is a property of the feed, not of a worker, so it sits
beside `guides` / `therapists` rather than being repeated on every row. A
consumer that wants a per-row timestamp calls that field `syncedAt` — its
own field, written at its own write time, not ours.

### Why a list and not a scalar

A guide placed at **two houses is one person with two placements**. The
coordinators and therapists feeds publish one entry per *worker*, so a single
`assignmentId` would be a lie for exactly the people most likely to cause
trouble. `assignmentIds` is sorted and always describes the same placements
as the existing `houses` array. The hadrachot feed is per *placement*, so it
gets scalars.

### What is still frozen

`name` is unchanged and remains authoritative until a consumer switches.
No field was removed or renamed, no worker name changed, no secret changed,
and no feed carries a salary, rate, cost, budget, allowance or retainer
field. Each feed's exact key set is pinned by a guard test in this repo, so
adding a field is always a deliberate act.

---

## Migration shape — for both consumers

The target is **`workerId` first, name as fallback**, never `workerId` alone:

1. **Append** a `workerId` column to the consumer's roster sheet. Append-only
   — it goes at the end.
2. On each sync, match in this order:
   - a local row whose `workerId` equals the feed's → **the match**;
   - else a local row whose *normalized* name equals the feed's → **the
     match, and back-fill its `workerId` now**;
   - else → a new row.
3. **Never delete or rename a local row.** Add, deactivate, reactivate, and
   back-fill `workerId` only, exactly as today.
4. Keep the name fallback **permanently**. It costs one comparison and it is
   what makes the migration safe to roll back: if staffing's feed reverts to
   the pre-Phase-3 shape, a consumer matching on `workerId` alone would see
   its entire roster as new people.
5. Normalize names the same way staffing does before comparing — **strip bidi
   control marks, collapse whitespace, fold the Hebrew gershayim ״ to `"` and
   the geresh ׳ to `'`, then trim and case-fold.** These are invisible on
   screen and are the classic cause of "the guide disappeared".

---

## Prompt to paste into the **coordinators** repo

```
Staffing's read-only guide feed (getGuidesForCoordinators) now carries two
additional fields, additively: workerId (string, never blank) and
assignmentIds (a sorted array of the worker's current guide placements, or
of the archived ones for a guide who has left). The response also carries
feedGeneratedAt at the top level. Nothing was removed or renamed: name,
phone, active, houses and startDate are all unchanged, and name is still
authoritative.

Task: switch the guide sync to match on workerId, with name as a permanent
fallback.

1. Append a workerId column to the Guides sheet. APPEND-ONLY — it goes at
   the end of the header array, because the readers map columns by position
   and a mid-array insert would shift every stored value one column right.

2. In the staffing sync, replace the exact-name match with, in order:
     a. a local guide whose workerId equals the feed entry's workerId;
     b. else a local guide whose NORMALIZED name equals the feed entry's
        normalized name — and when this hits, write the feed's workerId onto
        that local row (the back-fill);
     c. else a new guide row.
   Normalize a name by stripping bidi control marks (U+200E, U+200F,
   U+202A–U+202E, U+2066–U+2069, U+FEFF), folding U+05F4 gershayim to the
   ASCII double quote and U+05F3 geresh to the ASCII single quote,
   collapsing runs of whitespace to one space, trimming, and lower-casing.

3. Keep the name fallback permanently. Do NOT match on workerId alone: if
   staffing's feed ever reverts to its previous shape, a workerId-only match
   would treat the entire roster as new people.

4. Everything else about the sync is unchanged, and these rules still hold:
   never delete a local row, never rename one, run under LockService, and
   when the feed is unreachable or its secret is wrong, make ZERO writes,
   serve the last-synced local roster, and show the amber
   «לא סונכרן מהסטאפינג» notice.

5. Optionally store feedGeneratedAt as a syncedAt column on each row it
   touched — your own field, written at your write time.

6. Tests: a guide matched by workerId when the name has changed in staffing;
   a guide matched by name when workerId is not yet stored locally, with the
   back-fill asserted; a guide matched by name whose stored name differs only
   by padding, a double space or a gershayim; a new guide added; a departed
   guide deactivated and NOT deleted; and the feed-down path proven to write
   nothing.

Do not change the secret, the endpoint, or any other field.
```

## Prompt to paste into the **therapists** repo

```
Staffing's read-only therapist feed (getTherapistsForTherapists) now carries
two additional fields, additively: workerId (string, never blank) and
assignmentIds (a sorted array of that worker's therapist placements). The
response also carries feedGeneratedAt at the top level. Nothing was removed
or renamed: name, active, houses and startDate are unchanged, and name is
still authoritative.

Task: switch the therapist roster sync to match on workerId, with name as a
permanent fallback.

1. Append a workerId column to the Therapists sheet. APPEND-ONLY, at the end
   of the header array.

2. In the sync, match in order: workerId; else NORMALIZED name, back-filling
   workerId onto the matched row; else a new row. Normalize a name by
   stripping bidi control marks (U+200E, U+200F, U+202A–U+202E,
   U+2066–U+2069, U+FEFF), folding U+05F4 to the ASCII double quote and
   U+05F3 to the ASCII single quote, collapsing whitespace, trimming, and
   lower-casing.

3. Keep the name fallback permanently — do not match on workerId alone.

4. IMPORTANT, and specific to this app: downstream matching is still
   exact-STRING on the name, including outpatient's TherapistRates. So this
   change does NOT make renames safe on its own. A rename still has to go
   through staffing, then migrateTherapistNames here, then a TherapistRates
   row rename — together, as now. What workerId buys you is that the SYNC
   stops creating a duplicate therapist when a name changes in staffing; it
   does not fix the downstream string matching. Say so in the PR description
   so nobody assumes renames are now free.

5. Everything else is unchanged: add / deactivate / reactivate only, never a
   row delete or rename; unset or unreachable feed ⇒ NO writes, serve the
   last-synced list, show the amber «לא סונכרנה» toast.

6. Tests: matched by workerId after a staffing rename; matched by name with
   the workerId back-fill asserted; matched by name across padding and
   gershayim differences; a new therapist added; one deactivated rather than
   deleted; and the feed-down path proven to write nothing.

Do not change the secret, the endpoint, or any other field.
```

---

## The hadrachot first-supervision reminder — what is missing

The brief asks to wire this **only if the existing feed already supports
it**. It does not. Here is exactly what is there and what is not, so the
decision can be made without re-deriving it.

### What exists today

* **Staffing → hadrachot** (`getGuidesForHadrachot`, secret
  `HADRACHOT_READ_SECRET`): who is supervision-relevant. Working.
* **Hadrachot → staffing** (`GET /api/hadrachot-status`, a server-side proxy
  over `HADRACHOT_STATUS_URL` + `HADRACHOT_STATUS_SECRET`): who has completed
  their first supervision. Working **when configured**.
* The 30-day grace rule and the dashboard banner: `firstHadrachaFlags` in
  `lib/calc.js`, client-side. Working.

### What is missing

1. **The two Railway variables may not be set.** `HADRACHOT_STATUS_URL` and
   `HADRACHOT_STATUS_SECRET` are **optional on purpose** — unset means the
   feature is off and the UI shows nothing. From here it is impossible to
   tell whether they are set, because reading Railway's configuration needs
   Railway access. **They go on the STAFFING app in Railway**, not on
   hadrachot, and the value of `HADRACHOT_STATUS_SECRET` must equal whatever
   secret the hadrachot Apps Script checks on its status endpoint.
2. **The failure mode is silent, by design and by mistake.** Unconfigured
   answers `200 {configured:false}`; any upstream failure is a `5xx`; in
   **both** cases the client renders nothing rather than a false alert. That
   is right for avoiding false alarms and wrong for noticing a misconfigured
   URL: a broken feed and a genuine "nobody is overdue" look **identical** to
   Moran. The Phase 3 `feed_log` panel does **not** cover this — it logs
   feeds staffing *serves*, not the one it *consumes*.
3. **There is no reminder, only a banner.** Nothing sends anything. A
   reminder needs a delivery channel — a Sheet tab Moran checks, an email, a
   WhatsApp link — and none is specified.

### Recommendation

Not wired, deliberately: a reminder that cannot be verified end-to-end is
worse than none. Two small, independent steps, in order:

1. **Confirm the two Railway variables on the staffing app** and check the
   dashboard banner appears for a guide who is genuinely overdue. That alone
   makes the existing feature real.
2. **Then** add an explicit «מצב חיבור להדרכות» line to the סטטוס סנכרון
   panel, fed by the existing `/api/hadrachot-status` response: *not
   configured* / *reachable* / *unreachable*. That converts the silent
   failure into a visible one **without** risking a false alert, because it
   reports the connection rather than the supervision status.

Step 2 is a small, self-contained follow-up PR. Step 1 needs Railway access
and five minutes.
