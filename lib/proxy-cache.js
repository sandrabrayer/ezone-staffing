'use strict';

// In-memory read cache for the Express → Apps Script proxy.
//
// Every page load used to cost one full Apps Script execution (the doGet that
// reads every tab of the Sheet). This sits in front of that call with three
// behaviours, the same pattern as ezone-coordinators PR #142:
//
//   1. COALESCING — identical reads already in flight share one upstream
//      call instead of each starting their own.
//   2. STALE-WHILE-REVALIDATE — a value younger than freshMs is served as a
//      HIT; one younger than freshMs + staleMs is served immediately as STALE
//      while ONE background refresh runs; anything older (or absent) is a
//      MISS that waits for the upstream.
//   3. TARGETED INVALIDATION — a write drops the key(s) it affects. Each key
//      carries a generation counter: invalidate() bumps it, so a read that
//      was already in flight when the write happened can neither populate
//      the cache with pre-write data nor be joined by a post-write reader.
//
// Rules this module keeps, and tests pin:
//   - keys are fixed route names chosen by server code ('data', …) — never a
//     token, PIN, secret or anything derived from a request;
//   - errors are never cached (a failed MISS rejects; a failed background
//     refresh leaves the previous value in place and logs a generic line);
//   - it logs nothing but the key and the outcome.
//
//   4. STALE-ON-ERROR — the last good value of every key is kept apart from
//      the live entry (an invalidation does not drop it). When a MISS fails
//      upstream and such a copy exists, it is served as STALE_ERROR rather
//      than failing the page; the caller says so on screen.
//   5. RESTORE — a value read back from the disk snapshot (lib/cache-
//      snapshot.js) is restored as `restored`: it is NEVER a HIT, only
//      STALE (with a refresh started) for up to restoredStaleMs, and a live
//      value always wins over it.
//
// Per-process, like the login lockout and revocation set. A restart used to
// start cold; the disk snapshot now carries the last good values across it.

function createProxyCache(opts) {
  const o = opts || {};
  const freshMs = Number.isFinite(o.freshMs) ? o.freshMs : 60 * 1000;
  const staleMs = Number.isFinite(o.staleMs) ? o.staleMs : 5 * 60 * 1000;
  const restoredStaleMs = Number.isFinite(o.restoredStaleMs) ? o.restoredStaleMs : 24 * 60 * 60 * 1000;
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const log = typeof o.log === 'function' ? o.log : () => {};
  // Called after every successful load: (key, value, meta). Used for the
  // debounced disk snapshot and the refresh log line.
  const onStore = typeof o.onStore === 'function' ? o.onStore : () => {};
  // Called when a background refresh fails: (key, err).
  const onRefreshError = typeof o.onRefreshError === 'function' ? o.onRefreshError : null;

  const entries = new Map();   // key → { value, storedAt, restored }
  const lastGood = new Map();  // key → { value, storedAt } — survives invalidate()
  const inflight = new Map();  // key → { promise, gen }
  const gens = new Map();      // key → generation counter

  const genOf = (key) => gens.get(key) || 0;

  function assertKey(key) {
    if (typeof key !== 'string' || !/^[a-z][a-z0-9:_-]{0,63}$/i.test(key)) {
      throw new Error('proxy-cache: invalid key');
    }
  }

  function load(key, loader, how) {
    const gen = genOf(key);
    const cur = inflight.get(key);
    if (cur && cur.gen === gen) return cur.promise; // coalesce
    const promise = Promise.resolve()
      .then(() => loader(how || 'user'))
      .then((value) => {
        const storedAt = now();
        if (genOf(key) === gen) entries.set(key, { value, storedAt, restored: false });
        // lastGood only moves forward, and only with data that belongs to the
        // current generation — a raced pre-write read must not land here
        // either.
        if (genOf(key) === gen) lastGood.set(key, { value, storedAt });
        try { onStore(key, value); } catch (_) { /* never breaks a read */ }
        return value;
      })
      .finally(() => {
        const c = inflight.get(key);
        if (c && c.promise === promise) inflight.delete(key);
      });
    inflight.set(key, { promise, gen });
    return promise;
  }

  function refreshInBackground(key, loader) {
    load(key, loader, 'background').catch((err) => {
      if (onRefreshError) onRefreshError(key, err);
      else log(`[cache] background refresh failed key=${key}`);
    });
  }

  // → Promise<{ value, status: 'HIT' | 'STALE' | 'MISS' | 'STALE_ERROR', ageMs }>
  async function get(key, loader) {
    assertKey(key);
    const e = entries.get(key);
    if (e) {
      const age = now() - e.storedAt;
      if (!e.restored && age < freshMs) return { value: e.value, status: 'HIT', ageMs: age };
      const window = e.restored ? restoredStaleMs : freshMs + staleMs;
      if (age < window) {
        refreshInBackground(key, loader);
        return { value: e.value, status: 'STALE', ageMs: age };
      }
      entries.delete(key);
    }
    try {
      const value = await load(key, loader, 'user');
      return { value, status: 'MISS', ageMs: 0 };
    } catch (err) {
      const g = lastGood.get(key);
      if (!g) throw err;
      return { value: g.value, status: 'STALE_ERROR', ageMs: now() - g.storedAt, error: err };
    }
  }

  // Start (or join) a refresh without waiting for it. Used for warm-up and
  // keep-warm; always the background lane.
  function warm(key, loader) {
    assertKey(key);
    return load(key, loader, 'background').then(() => true, (err) => {
      if (onRefreshError) onRefreshError(key, err);
      else log(`[cache] warm-up failed key=${key}`);
      return false;
    });
  }

  // Put a value read back from the disk snapshot. Never overwrites anything
  // already in the cache — a live read always wins. → true when restored.
  function restore(key, value, storedAt) {
    assertKey(key);
    if (entries.has(key) || lastGood.has(key) || inflight.has(key)) return false;
    if (!Number.isFinite(storedAt) || storedAt <= 0) return false;
    entries.set(key, { value, storedAt, restored: true });
    lastGood.set(key, { value, storedAt });
    return true;
  }

  function invalidate(keys) {
    (Array.isArray(keys) ? keys : [keys]).forEach((key) => {
      assertKey(key);
      gens.set(key, genOf(key) + 1);
      entries.delete(key);
      inflight.delete(key);
    });
  }

  function clear() {
    Array.from(new Set([...entries.keys(), ...inflight.keys(), ...gens.keys(), ...lastGood.keys()]))
      .forEach((k) => gens.set(k, genOf(k) + 1));
    entries.clear();
    inflight.clear();
    lastGood.clear();
  }

  function keys() { return Array.from(entries.keys()); }

  // [key, { value, storedAt }] of every last good value, for the snapshot.
  function snapshotPairs() { return Array.from(lastGood.entries()); }

  // The current value of a key without touching the upstream: the live
  // entry, else the last good one. → { value, ageMs, restored } | null
  function peek(key) {
    assertKey(key);
    const e = entries.get(key) || lastGood.get(key);
    if (!e) return null;
    return { value: e.value, ageMs: now() - e.storedAt, restored: !!e.restored };
  }

  return {
    get, warm, restore, invalidate, clear, keys, snapshotPairs, peek,
    freshMs, staleMs, restoredStaleMs,
  };
}

module.exports = { createProxyCache };
