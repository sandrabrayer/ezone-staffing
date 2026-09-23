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
// Per-process, like the login lockout and revocation set: a Railway restart
// starts cold (and the startup warm-up fills it again).

function createProxyCache(opts) {
  const o = opts || {};
  const freshMs = Number.isFinite(o.freshMs) ? o.freshMs : 60 * 1000;
  const staleMs = Number.isFinite(o.staleMs) ? o.staleMs : 5 * 60 * 1000;
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const log = typeof o.log === 'function' ? o.log : () => {};

  const entries = new Map();   // key → { value, storedAt }
  const inflight = new Map();  // key → { promise, gen }
  const gens = new Map();      // key → generation counter

  const genOf = (key) => gens.get(key) || 0;

  function assertKey(key) {
    if (typeof key !== 'string' || !/^[a-z][a-z0-9:_-]{0,63}$/i.test(key)) {
      throw new Error('proxy-cache: invalid key');
    }
  }

  function load(key, loader) {
    const gen = genOf(key);
    const cur = inflight.get(key);
    if (cur && cur.gen === gen) return cur.promise; // coalesce
    const promise = Promise.resolve()
      .then(loader)
      .then((value) => {
        if (genOf(key) === gen) entries.set(key, { value, storedAt: now() });
        return value;
      })
      .finally(() => {
        const c = inflight.get(key);
        if (c && c.promise === promise) inflight.delete(key);
      });
    inflight.set(key, { promise, gen });
    return promise;
  }

  // → Promise<{ value, status: 'HIT' | 'STALE' | 'MISS' }>
  async function get(key, loader) {
    assertKey(key);
    const e = entries.get(key);
    if (e) {
      const age = now() - e.storedAt;
      if (age < freshMs) return { value: e.value, status: 'HIT' };
      if (age < freshMs + staleMs) {
        load(key, loader).catch(() => log(`[cache] background refresh failed key=${key}`));
        return { value: e.value, status: 'STALE' };
      }
      entries.delete(key);
    }
    const value = await load(key, loader);
    return { value, status: 'MISS' };
  }

  // Start (or join) a refresh without waiting for it. Used for warm-up.
  function warm(key, loader) {
    assertKey(key);
    return load(key, loader).then(() => true, () => {
      log(`[cache] warm-up failed key=${key}`);
      return false;
    });
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
    Array.from(new Set([...entries.keys(), ...inflight.keys(), ...gens.keys()]))
      .forEach((k) => gens.set(k, genOf(k) + 1));
    entries.clear();
    inflight.clear();
  }

  function keys() { return Array.from(entries.keys()); }

  return { get, warm, invalidate, clear, keys, freshMs, staleMs };
}

module.exports = { createProxyCache };
