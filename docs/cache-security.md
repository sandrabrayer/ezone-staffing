# Cache security — what the two #45 caches hold

PR #45 added two copies of the `/api/data` bundle outside the Sheet so the app
opens fast: a **disk snapshot** on the server and a **local copy** in the
browser. Both held everything, in the clear. This page records exactly which
fields each one stores now, and the rules that keep it that way.

The bundle's fields are the ones `apps-script/Code.gs` readers emit
(`readWorkersSafe`, `readAssignmentsSafe`, …). The **record ids** below (`id`,
`workerId`, `assignmentId`, …) are the app's own generated keys such as
`w1lq3x9ab` — **no national ID number (ת"ז) and no bank detail is a field
anywhere in the bundle**. The only places one could appear are free-text
fields typed by hand (notes, reason details), which is why the browser copy
drops those.

## (a) Server disk snapshot — `lib/cache-snapshot.js`

| | Before (#45) | Now |
|---|---|---|
| File | `<dir>/read-cache.json`, **plain JSON** | `<dir>/read-cache.enc`, **AES-256-GCM** |
| Key | — | Railway variable `CACHE_SNAPSHOT_KEY` (32 random bytes, base64 or hex) |
| No key | written anyway | **nothing written, nothing read**; boot logs `[proxy] snapshot disabled: no key` once |
| Mode | 0600 on create | 0600 forced on every write (also over an older 0644 file), dir 0700, atomic tmp+rename |
| Old plaintext file | — | deleted at boot, key or no key (`[proxy] removed the old unencrypted cache snapshot`) |
| Logs | entry count, bytes, reason | unchanged — never the key, never any content |

Fields in the file (unchanged — the server needs the full bundle to serve a
restart; what changed is that it is unreadable without the key):

| Collection | Fields |
|---|---|
| workers | id, name, notes, createdAt, shift_commitment, startDate, gmachMonth, phone, startDateSource |
| assignments | id, workerId, house, role, roleDetail, employmentType, **salary, pct, hourlyRate, estHours, sessionRate, estSessions, retainerAmount**, notes, createdAt, **allowance**, status, statusDate, **rateIndividual, sessionsIndividual, rateGroup, sessionsGroup, rateExternal, externalPatients**, effectiveFrom |
| absences | id, workerId, house, startDate, endDate, reasonType, reasonDetail, notes, status, createdAt |
| coverages | id, absenceId, coveringWorkerId, coveringHouse, receivingHouse, startDate, endDate, **extraPayment**, notes, createdAt, replacedAssignmentId, role, shiftCount, approvalStatus, approvedBy, cancelled |
| archiveV3 | id, assignmentId, workerId, name, house, role, roleDetail, employmentType, **salary, pct, hourlyRate, estHours, sessionRate, estSessions, retainerAmount**, notes, terminationDate, reasonType, reasonDetail, archivedAt, **rateIndividual, sessionsIndividual, rateGroup, sessionsGroup, rateExternal, externalPatients** |
| monthlyActuals | id, assignmentId, month, **actualHours, actualSessions**, note, createdAt, updatedAt |
| budgets | id, house, month, **amount**, createdAt, updatedAt, **instructorsAmount** |
| hearings | id, workerId, workerName, hearingDate, reason, result, createdAt |
| feedLog | consumer, lastServedAt, lastRowCount, serveCount, status |

The legacy v2 keys (`houses`, `events`, `archive`, `_compat`) and `_gasCache`
are dropped before anything is cached, as before.

### Encryption details

- AES-256-GCM, a fresh random 96-bit IV per write, 128-bit tag checked on
  read, AAD `ezone-staffing/read-cache/v1`. Layout: `EZSNAP1\n | IV | tag | ciphertext`.
- `writeSnapshot` takes the plaintext and encrypts it itself; without a valid
  key it returns `no key` and touches nothing. There is no code path that
  writes the plaintext.
- A file with a wrong key, a flipped bit, a truncation or the wrong header is
  treated as no file (`restored entries=0 (ignored (cannot decrypt: wrong key or damaged))`)
  and is overwritten by the next save.
- A key that is not exactly 32 bytes is refused (`snapshot disabled: invalid key`),
  never stretched into a weak one, and never echoed.

### The Railway variable

Railway → the staffing service → **Variables** → New Variable:

- Name: `CACHE_SNAPSHOT_KEY`
- Value: the output of `openssl rand -base64 32`
  (or `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`)

Generate it once, paste it only into Railway, keep no other copy. Changing it
later is safe: the next boot ignores the old file and writes a new one.
Until it is set, the snapshot is off and a restart is a cold start — exactly
the behaviour before #45.

## (b) Browser local copy — `public/index.html`

| | Before (#45) | Now |
|---|---|---|
| Storage | `localStorage['ezone_staff_data_v1']` — the whole `/api/data` body | `localStorage['ezone_staff_data_v2']` — an **allowlist** (below) |
| Money / cost fields | all of them | **none** |
| Free text (notes, reason details), phone | kept | **dropped** |
| Kept text with a 5+ digit run (typed ID / account no.) | kept | **blanked** |
| Cleared on | logout, a 401 on the data read, 72 h | logout, **any** 401 (data, save, hearings, hadrachot), **a failed PIN** (401 and lockout 429), 72 h |
| Written without a token | possible (debounced save) | never |
| The v1 copy | — | deleted on every page load, token or no token |

Fields stored now (`LOCAL_COPY_FIELDS`):

| Collection | Kept | Dropped |
|---|---|---|
| workers | id, name, createdAt, shift_commitment, startDate, startDateSource, gmachMonth | notes, phone |
| assignments | id, workerId, house, role, roleDetail, employmentType, status, statusDate, effectiveFrom, createdAt | salary, pct, hourlyRate, estHours, sessionRate, estSessions, retainerAmount, allowance, rateIndividual, sessionsIndividual, rateGroup, sessionsGroup, rateExternal, externalPatients, notes |
| absences | id, workerId, house, startDate, endDate, reasonType, status, createdAt | reasonDetail, notes |
| coverages | id, absenceId, coveringWorkerId, coveringHouse, receivingHouse, startDate, endDate, replacedAssignmentId, role, shiftCount, approvalStatus, approvedBy, cancelled, createdAt | extraPayment, notes |
| archiveV3 | id, assignmentId, workerId, name, house, role, roleDetail, employmentType, terminationDate, reasonType, archivedAt | salary and every rate / count field, notes, reasonDetail |
| monthlyActuals | *(nothing — stored as `[]`)* | everything (hours / sessions are cost inputs) |
| budgets | *(nothing — stored as `[]`)* | everything (money) |
| feedLog | consumer, lastServedAt, lastRowCount, serveCount, status | — |
| hearings | *(never in the browser copy — loaded lazily, not stored)* | — |

A field or collection that is not on the list is dropped, so a column added to
the bundle later stays out of the browser until someone decides it is safe.

### The preview

Because the browser copy has no money in it, a page painted from it is a
**preview** until the fresh server copy lands (usually a second or two, with
«מתעדכן…» in the topbar):

- every amount reads `₪ …` — never `₪0`;
- no «חסרים נתונים», «אין תקציב» or «לא הוזנו נתוני אמת» line (they would be
  false on stripped data);
- every form (worker, placement, termination, budget, absence, coverage,
  hearing), every save and every export is refused with
  «הנתונים העדכניים עדיין נטענים — אפשר לערוך ולהפיק דוחות בעוד רגע».

Nothing is ever edited or exported from the stripped copy, so a zero that
only exists because a field was withheld can never be written back.

The service worker never touches `/api/*` (`public/sw.js`), so there is no
third copy.

## Tests

| File | Covers |
|---|---|
| `tests/snapshot-security.test.js` | key parsing, AES-256-GCM round trip, fresh IV, tamper / truncation / wrong key, no write without a key, 0600, no logging in the module |
| `tests/cache-snapshot-boot.test.js` | real process: encrypted 0600 file, no key → no file + one log line, invalid key, another key's file, legacy plaintext deleted, no key or data in logs |
| `tests/local-copy-security.test.js` | stored fields vs. a payload with every sensitive kind, allowlist vs. the Code.gs readers, digit-run scrub, v1 purge, no write without a token, cleared on PIN failure and on any 401, the preview (placeholders, no false lines, forms / saves / exports refused, real figures after the refresh), the guard on every form opener |
