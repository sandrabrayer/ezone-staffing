# Initial load — measurements and fixes (PC slowness + PWA install)

Date: 2026-09-23. Scope: the first page load of
https://ezone-staffing.up.railway.app on a PC, and "app can't be installed" on
phones.

## How this was measured

The production host could not be reached from the build environment (its
network policy blocks the Railway domain), so nothing below is a production
number. Instead:

1. **Request inventory** — read from the code (`server.js`, `public/index.html`,
   `apps-script/Code.gs`) and confirmed in a real browser.
2. **Browser bench** — headless Chromium (Playwright, CDP throttling at 40 ms
   RTT / 20 Mbit/s down / 5 Mbit/s up, an ordinary office connection) loading
   the app from a local server. The **before** run used `main` at `efe2e62`,
   the **after** run used this branch. Both used the same **mock Apps Script**
   upstream, which answers every call after a fixed **3,000 ms** (a stand-in
   for one whole-Sheet Apps Script execution). The mock returns a synthetic
   ~356 KB payload of the real shape (140 workers, 140 assignments, 1,260
   monthly-actual rows, 120 absences, 60 archive rows). Every figure is the
   median of 3 runs.
3. **Apps Script call counts** — `doGet` run in a `vm` sandbox against
   `Code.gs` before and after, counting `SpreadsheetApp` calls.
4. **Timing logs** — the server now writes one `[timing]` line per request and
   one `[upstream]` line per Apps Script call (see "Verify in production").

The 3,000 ms upstream delay is an assumption, not a measurement. Only the
production `[upstream]` log lines give the real Apps Script time. The bench
still shows where the time went and what each fix removes, because both runs
used the same upstream.

## Findings (before)

| # | Finding | Evidence |
|---|---|---|
| 1 | **Nothing painted until the data arrived.** `boot()` hid the topbar and showed a full-screen spinner until `/api/data` returned, so the user saw a blank page for the whole Apps Script execution. | bench: shell and data both at **3.4 s** |
| 2 | **Every page load ran a full Apps Script execution.** No cache anywhere, so each load and each reload paid the upstream time again. | bench: repeat load still **3.2 s** |
| 3 | **Inside that execution the spreadsheet was opened 26 times.** Every reader called `ss()`, and `ss()` called `SpreadsheetApp.openById` each time: 8 v3 tabs + feed_log + 7 legacy houses + events + archive, most legacy tabs looked up under two names. | sandbox: `openById` **26** per `doGet` |
| 4 | **The data request started last.** `/api/data` was only requested after the 215 KB HTML and all three libraries had downloaded and run. | request waterfall |
| 5 | **Nothing was compressed.** 215 KB of HTML, 106 KB of JS and the JSON were all sent raw. | 695 KB on the first load |
| 6 | **The libraries were never cacheable.** `/lib/*.js` were `no-cache` with no version in the URL, so every load revalidated all three. | response headers |
| 7 | The initial load was already **one** Apps Script call (`doGet` returns every tab), not several in sequence. So candidate (a), "collapse sequential calls", had no sequential calls to remove. The one call itself was the slow part (items 2–3). | `loadData()` / `doGet` |

**PWA.** There was **no manifest, no service worker and no icons at all**.
`/manifest.webmanifest` and `/sw.js` were 404s, so no browser could offer to
install the app. The suspected PIN-gated manifest was **not** the cause: the PIN
gate is a client-side overlay plus `requireAuth` on `/api/*`, and Express never
gated static files.

## Fixes

| Fix | Where |
|---|---|
| **Shell first.** The topbar and house tabs paint immediately. The loading state sits under them instead of over a blank page. | `public/index.html` `boot()` + `.boot` CSS |
| **Data request starts in `<head>`.** When a session token exists, `/api/data` is fetched before the libraries load. `loadData()` uses that response once and falls back to a normal fetch if it failed. | `public/index.html` |
| **Proxy read cache.** Coalesces identical in-flight reads and serves stale-while-revalidate: `X-Cache: HIT` under 60 s, `STALE` up to 5 min more (answered immediately, one refresh runs in the background), `MISS` after that. Every write action invalidates. A read that was in flight during a write can't put pre-write data back (generation counter). The cache is re-filled in the background 1.5 s after the last write, and warmed on server start. | `lib/proxy-cache.js`, `server.js` |
| **One `openById` per execution.** `ss()` is memoized; Apps Script resets globals for every request. | `apps-script/Code.gs` |
| **`getInitialBundle_` + CacheService.** The page-load read is one named function that `doGet` returns (also reachable as `action=getInitialBundle`). The bundle is cached in the script cache for 300 s: chunked under a version token, invalidated before and after every `doPost` and by any non-`doGet` execution that opens the Sheet. `feedLog` is always read fresh. | `apps-script/Code.gs` |
| **gzip** for everything except `/api/login` and `/api/logout`. | `server.js` (`compression`) |
| **Cache headers.** `/lib/*.js?v=<sha>` get `max-age=1y, immutable` (the URL changes when the file does). `index.html` is `no-cache` with an ETag, so repeat loads get a 304. `sw.js` and the manifest are `no-cache`. PNGs get `max-age=7d`. `/api/*` is `no-store`. | `server.js` |
| **PWA.** Added the manifest, a real 192/512/maskable/180 green "E" icon set, the service worker, `<link rel="manifest">`, `apple-touch-icon`, and the apple/theme metas. | `public/`, `scripts/gen-icons.js` |

## Before / after (bench, medians)

| Scenario | Before: shell | Before: data | After: shell | After: data |
|---|---:|---:|---:|---:|
| First visit (empty browser cache) | 3,397 ms | 3,421 ms | **186 ms** | **195 ms** |
| Repeat visit (same browser) | 3,164 ms | 3,188 ms | **110 ms** | **164 ms** |
| Reload immediately after a save | 3,161 ms | 3,179 ms | **106 ms** | 3,115 ms ¹ |
| Reload a few seconds after a save | 3,162 ms | 3,183 ms | **118 ms** | **159 ms** |

¹ A reload within ~1.5 s of a write, before the background re-warm has
finished, still waits for one upstream read. The shell is on screen the whole
time, and the new Code.gs makes that read cheaper (see below).

| Bytes and requests | Before | After |
|---|---:|---:|
| Requests on first load | 7 | 8 (the extra one is the new 192 px icon) |
| Bytes on the wire, first load | 694,623 | **116,500** |
| `index.html` | 215,732 | 61,058 (gzip) |
| `lib/*.js` (3 files) | 106,520 | 34,791 (gzip), then 0 (immutable) |
| Bytes, repeat load | 4,757 (all revalidated) | 8,443 (libs from cache, `/api/data` body sent) |

`/api/data` compressed from 360 KB to 7 KB here, but the synthetic payload is
unusually repetitive. Expect real salary data to compress about 5–10×.

**Apps Script execution (sandbox call counts, one `doGet`):**

| | Before | After, cache miss | After, cache hit |
|---|---:|---:|---:|
| `SpreadsheetApp.openById` | 26 | **1** | **1** |
| `getDataRange().getValues()` | 10 | 10 | **1** (feed_log only) |

## Verify in production (after merge)

1. Railway logs now carry, per request:
   `[timing] GET /api/data 200 12.3ms cache=HIT`. Per Apps Script call:
   `[upstream] GET 200 2345ms bytes=…` followed by
   `[upstream] bundle gas_cache=hit|miss`. Compare the first `gas_cache=miss`
   duration after deploy with a `gas_cache=hit` one. That gap is the real
   Apps Script saving; the table above cannot give it.
2. `STAFFING_PIN=… node scripts/measure-load.js https://ezone-staffing.up.railway.app`
   prints every initial-load request (status, type, encoding, size, TTFB) and
   `/api/data` three times with `X-Cache`. It also checks the PWA files. The PIN
   is read from the environment and never printed, and the session is revoked
   at the end.
3. DevTools → Network: `/api/data` shows `Server-Timing: proxy;desc="HIT"`.

## Staleness bounds (what the caches can and cannot see)

- A write through the app invalidates both caches at once.
- A direct edit in the Google Sheet, or an import run straight against Apps
  Script, is invisible to the caches until they expire. The Apps Script cache
  lasts ≤ 300 s. The proxy can serve an older copy for ≤ 60 s fresh plus
  ≤ 5 min stale, and the stale window triggers a refresh. To see such an edit
  immediately, run `clearBundleCacheNow` in the Apps Script editor and restart
  the Railway service, or save any change in the app.
- Absence status is derived from dates at read time. A cached bundle can
  therefore show yesterday's "active" for up to the cache lifetime after
  midnight.

## Security notes

- The proxy cache has one fixed key, `data`, and refuses any other key shape.
  `requireAuth` runs before it on every request, so a warm cache is never
  served without a valid session.
- No PIN, token, `SHARED_SECRET` or upstream URL is logged. The new `[timing]`
  lines carry the path only, never the query string. Upstream error messages
  are redacted before logging. A test drives login, data, a write and an
  upstream failure, then scans every log line.
- `/api/*` responses are `Cache-Control: no-store`.
- The service worker handles only same-origin GETs. It never touches `/api/*`,
  requests with an `Authorization` header, non-GET requests, or any other
  origin (Apps Script, googleusercontent, fonts). All of this is pinned by
  tests.
- The Apps Script cache holds the same data the Sheet does, inside the same
  script project. An unauthorized `doGet` reads nothing and caches nothing.
