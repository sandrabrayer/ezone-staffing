# Slow app open — measurements and fixes

Date: 2026-09-24. Complaint: «הסטאפינג לוקח הרבה זמן להיפתח».
Follow-up to `docs/perf-load.md` (Sep 23), which fixed the first-visit
waterfall. This round is about **when** an open still waits for Apps Script,
and what happens when Apps Script misbehaves.

## How this was measured

The production host is blocked from the build environment (the agent proxy
refuses the Railway domain), so **none of these numbers are production
numbers**. Same method as `docs/perf-load.md`:

- The real `server.js` as a child process, `NODE_ENV=production`.
- A **mock Apps Script** over HTTP that answers every call after **3,000 ms**
  with a synthetic ~250 KB bundle of the real shape (140 workers, 140
  placements, 1,260 monthly actuals, 120 absences, 60 archive rows). It can
  also answer Google's 404 page ("Sorry, unable to open the file at this
  time") on demand.
- Headless Chromium (Playwright), CDP throttling 40 ms RTT / 20 Mbit/s down.
- **Time to first useful screen** = navigation start → `#app` rendered with
  data and the loading spinner gone. Every request fired on open is recorded
  with its duration and `X-Cache`.
- **Before** = `main` at `31a01d6` (the code the complaint was about). **After**
  = this branch. Same mock, same browser, same script.

The "idle" scenario compresses real time: before, it runs with the production
windows scaled down (fresh 1 s, stale 2 s) so an open after the stale window
can be reproduced in seconds. After, it runs with the new default stale
window and the same 1 s fresh window.

## What fires on open

| # | Request | Blocks the first render? |
|---|---|---|
| 1 | `GET /` (61 KB gzip) | yes (the shell) |
| 2 | `/lib/calc.js`, `/lib/cost-engine.js`, `/lib/exports.js` | yes (versioned, cached a year after the first visit) |
| 3 | `GET /api/data` — started from `<head>` | **before: yes**, after: no when a copy exists |
| 4 | `/emblem.png`, `/icons/icon-192.png` | no |
| 5 | `GET /api/hadrachot-status` | no (fired after render) |
| 6 | `GET /api/data/hearings` (new, lazy) | no — only when שימועים opens |

`/api/data` is the only request that can take seconds, and only when the
proxy has to call Apps Script (`X-Cache: MISS`).

## Findings (before)

| # | Finding | Evidence |
|---|---|---|
| 1 | **An open after ~6 minutes of nobody using the app waited for Apps Script.** The proxy's copy was served for 60 s fresh + 5 min stale, then dropped: the next open was a MISS. Moran opens the app sporadically, so most opens were in this case. | scenario 3: 3,136 ms, `/api/data` 3,027 ms MISS |
| 2 | **Every restart / redeploy started cold.** The cache was memory-only; the boot warm-up helped only whoever opened after it had finished. | scenarios 5–6: ~3,000 ms MISS |
| 3 | **One Apps Script hiccup = an error page.** Google's 404/quota HTML became a 502 with no retry and no fallback to the copy the proxy already held (the coordinators Sep 15–16 incident, same code shape). | scenarios 4, 7, 8: error page |
| 4 | **Nothing bounded concurrent Apps Script executions.** Warm-up, re-warm after writes and user reads could all run at once. | code: `fetch` called directly |
| 5 | **The first render always waited for the network**, even when the browser had shown the same data a minute earlier. | code: `boot()` awaited `loadData()` |
| 6 | The page downloaded legacy v2 tabs it never reads (`houses`, `events`, `archive`), and Apps Script read them (up to 9 full-sheet reads) on every cache miss. | code + sandbox |

## Fixes

| Fix | Where |
|---|---|
| **One upstream queue**, `UPSTREAM_CONCURRENCY` (default **2**), two lanes: a user request takes the next free slot ahead of queued background work. Every call goes through it: reads, writes, warm-up, refresh, keep-warm. | `lib/upstream.js`, `server.js` |
| **404-HTML detection + retry**: `classifyUpstream` marks HTML / quota pages, 429 and 5xx retryable. **Reads** retry twice (400 ms, 1,200 ms). **Writes are never retried** (a write that timed out may have happened). Deadlines: 45 s reads, 120 s writes. | `lib/upstream.js`, `server.js` |
| **Stale-on-error**: the last good copy is kept apart from the live entry; a read that fails upstream serves it as `X-Cache: STALE_ERROR` instead of an error. With no copy at all: the Hebrew 502, nothing cached. | `lib/proxy-cache.js` |
| **Stale-while-revalidate for 24 h** (was 5 min): an old copy is answered at once (`STALE`) while one refresh runs. Plus **keep-warm**: a background re-read every 10 min. | `server.js` |
| **Cache snapshot on disk**, restored at boot (served `STALE`, never as fresh, refresh started), saved 5 s after each refresh, every 5 min, and on SIGTERM. **Encrypted** (AES-256-GCM, `CACHE_SNAPSHOT_KEY`; no key → no snapshot at all), atomic, 0600, size-capped, no secret, a bad or undecryptable file = no file. See `docs/cache-security.md`. | `lib/cache-snapshot.js`, `server.js` |
| **Boot warm-up** (kept) through the background lane, after the restore. | `server.js` |
| **First render never waits on Apps Script**: the browser keeps a stripped copy of the last data it loaded (localStorage, same profile as the session token; no money fields — `docs/cache-security.md`) and paints it at once as a read-only preview with «מתעדכן…» in the topbar; the fresh copy replaces it. A `STALE` answer triggers follow-up requests (3 s, 6 s, 12 s, 20 s); a failure keeps the copy on screen and the pill says «לא עודכן · נתונים מ-HH:MM · נסי שוב». A refresh never re-renders under an open form or while typing. | `public/index.html` |
| **Lazy parts**: `/api/data` no longer carries `hearings`; the שימועים screen fetches `/api/data/hearings` (same cache entry, no extra Apps Script call) when it opens. Legacy keys are dropped. | `server.js`, `public/index.html` |
| **Code.gs lean bundle** `doGet?view=app`: skips the legacy v2 tabs; cached under its own prefix of the same version token (one invalidation drops both). The bundle was already chunked in CacheService (as coordinators #158), and a chunk overflow is now logged instead of silent. | `apps-script/Code.gs` |
| **Logs**: `[proxy] GET action=data ms=… cache=… upstream=… outcome=… q=n/2` per request (and `POST action=<name>`), `[proxy] upstream retry` / `recovered` / `failed, serving stale`, and at boot `[proxy] upstream concurrency=2 volume mount=…` + `[proxy] cache snapshot dir=… writable=… restored entries=N`. | `server.js` |

## Before / after (time to first useful screen, mock Apps Script = 3 s)

| Scenario | Before | After |
|---|---:|---:|
| 1. Cold after a deploy, first visit, empty browser, no snapshot | 2,972 ms | 2,982 ms ¹ |
| 2. Warm reopen, same browser | 190 ms | 172 ms |
| 3. **Reopen after idle past the old stale window** | **3,136 ms** | **167 ms** |
| 5. **Restart / redeploy, returning user** | **3,014 ms** | **204 ms** |
| 6. **Restart / redeploy, new browser** (snapshot only) | **2,970 ms** | **213 ms** |
| 7. Cold server + Apps Script answers 404 HTML once | error page | 3,004 ms ² |
| 8. After a save, Apps Script down, same browser | error page | 166 ms ³ |
| 8b. After a save, Apps Script down, new browser | error page | 10,293 ms ⁴ |

¹ Nothing exists anywhere yet (no snapshot, no browser copy), so the first
open still waits for one Apps Script execution. With a volume this happens
once per volume, not once per deploy.
² The warm-up hit the 404 page, retried after 400 ms, and the user joined
that call.
³ Painted from the browser's copy; «מתעדכן…», then «לא עודכן · נסי שוב».
⁴ Three attempts (3 s each + back-off), then the saved copy
(`STALE_ERROR`). The worst case left: it needs a new browser, a save just
before, and Apps Script down at the same time.

In production each "before" number is roughly **one real Apps Script
execution** (the coordinators logs show 4–30 s under load); the "after"
numbers do not contain one, so the saving grows with the real Apps Script
time.

Verified in a real browser: the page painted in 143 ms with «מתעדכן…», the
pill cleared after ~3.2 s when the refreshed copy landed, and logout
removed the browser copy.

## Configuration (Railway variables — all optional)

| Variable | Default | Meaning |
|---|---|---|
| **`CACHE_SNAPSHOT_KEY`** | *(unset → snapshot OFF)* | 32 random bytes, base64 or hex — `openssl rand -base64 32`. Encrypts the snapshot (AES-256-GCM). Without it no snapshot is written or read and boot logs `[proxy] snapshot disabled: no key` once. |
| `CACHE_SNAPSHOT_DIR` | `<RAILWAY_VOLUME_MOUNT_PATH>/staffing-cache` when a volume is mounted, else `<repo>/.cache` | Where the snapshot lives. **Must be on the volume** to survive a redeploy. |
| `CACHE_SNAPSHOT` | `1` | `0` turns the snapshot off. |
| `CACHE_SNAPSHOT_MAX_AGE_MS` | `86400000` (24 h) | An older file is ignored; also how long a restored copy may be served. |
| `CACHE_SNAPSHOT_INTERVAL_MS` | `300000` | Periodic save; SIGTERM always saves. |
| `UPSTREAM_CONCURRENCY` | `2` | Max simultaneous Apps Script executions (1–6). |
| `DATA_CACHE_STALE_MS` | `86400000` | How long an old copy is served at once while refreshing. |
| `DATA_CACHE_KEEPWARM_MS` | `600000` | Background re-read interval; `0` = off. |
| `UPSTREAM_READ_TIMEOUT_MS` / `UPSTREAM_WRITE_TIMEOUT_MS` | `45000` / `120000` | Deadlines. |

Railway sets `RAILWAY_VOLUME_MOUNT_PATH` itself on a service with a volume,
so the directory needs no variable: the boot log shows the one it chose.
**`CACHE_SNAPSHOT_KEY` is required for the snapshot to exist at all** — until
it is set, a restart is a cold start (exactly as before #45).
Setting `CACHE_SNAPSHOT_DIR` explicitly to `<mount path>/staffing-cache` pins
it (the mount path is the one in Railway → service → Volumes, e.g. `/data`
→ `/data/staffing-cache`).

## Verify in production (after deploy)

1. Railway → Deploy logs, at boot:
   - `[proxy] upstream concurrency=2 volume mount=/data` (your mount path;
     `none` means Railway exposes no volume to this service);
   - `[proxy] cache snapshot dir=/data/staffing-cache writable=true restored entries=0 (absent)`
     on the first deploy, then `restored entries=1 (ok) ageMs=…` on every
     later one. `writable=false` means the directory is not usable: fix the
     path.
2. Per open: `[proxy] GET action=data ms=3 cache=STALE upstream=- outcome=ok q=1/2`.
   Grep for `outcome=stale_after_error` and `upstream retry` to see how
   often Apps Script misbehaves.
3. `[proxy] cache snapshot saved entries=1 bytes=… reason=refresh` a few
   seconds after each refresh.
4. In the app: open it after a break — it shows data at once with «מתעדכן…»,
   which disappears within seconds.

## Staleness and safety

- A save in the app invalidates the proxy copy and the Apps Script cache at
  once, and the page patches its own copy; nothing new here.
- An edit made **directly in the Sheet** reaches the page within the keep-warm
  interval (≤ 10 min) plus the Apps Script cache TTL (≤ 5 min); after
  `clearBundleCacheNow` in the editor, within about a minute.
- The **disk snapshot** holds the same data as the Sheet, ENCRYPTED with
  AES-256-GCM under `CACHE_SNAPSHOT_KEY` (fresh IV per write, tag checked on
  read): mode 0600 in a 0700 directory on the service's own volume, no
  credential or secret inside, replaced only by a newer snapshot. No key →
  no snapshot. The unencrypted `read-cache.json` the first version wrote is
  deleted at boot. `CACHE_SNAPSHOT=0` disables it.
- The **browser copy** is an ALLOWLIST of names, houses, roles, dates and
  statuses — no salary / rate / allowance / payment / budget / hours field,
  no notes, no phone (`docs/cache-security.md`). A page painted from it is a
  read-only preview (amounts «₪ …», forms, saves and exports refused) until
  the fresh copy lands. It lives in the same browser profile that already
  holds the session token, is deleted on logout, on ANY 401, on a failed
  PIN and after 72 h, and is never read or written without a token.
- `/api/data/hearings` is behind the same `requireAuth`; the cache key is
  still the fixed `data`.

## Tests

| File | Covers |
|---|---|
| `tests/perf-open.test.js` | queue cap and lanes, classifier, deadline, 404-HTML retry on reads, no retry on writes, stale-on-error, the Hebrew 502, the log line, lazy route, lean request, no secret in logs, snapshot rules and fs safety |
| `tests/cache-snapshot-boot.test.js` | a real process: boot log lines, SIGTERM snapshot (0600, encrypted, no secret), the next process answering from it at once, the volume default, an unwritable dir, `CACHE_SNAPSHOT=0`, no key / invalid key → no file and one log line, another key's file ignored and replaced, the legacy plaintext file deleted, no key or data in any log line |
| `tests/snapshot-security.test.js` | key parsing (32 bytes only, never echoed), AES-256-GCM round trip, fresh IV, tamper / truncation / wrong key → null, no write without a key, 0600 over an old 0644 file, no logging in the module |
| `tests/local-copy-security.test.js` | what the browser copy may hold, when it is cleared, and the preview |
| `tests/perf-open-page.test.js` | instant paint from the browser copy with «מתעדכן…», STALE follow-up, failure keeps the copy, no token / logout / 401 / old copy / blocked storage, no re-render under an open form, hearings fetched lazily |
| `tests/perf-bundle.test.js` | Code.gs `view=app`: legacy reads skipped, v3 keys identical, own cache prefix, one invalidation drops both |
