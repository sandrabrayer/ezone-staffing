/* E-ZONE staffing — service worker.
 *
 * Exists for two reasons: it makes the app installable (Chrome/Android wants
 * a registered worker with a fetch handler), and it lets a repeat load paint
 * the shell from cache when the network is slow.
 *
 * What it will NEVER touch — these go straight to the network, untouched:
 *   - /api/*          (salary data, the PIN login, the session token)
 *   - any request carrying an Authorization header
 *   - any non-GET request
 *   - any other origin (Apps Script /exec, googleusercontent, fonts, …)
 *
 * Strategies for what it does handle (same-origin GET only):
 *   - page navigations + index.html → network-first, cached copy only when
 *     offline (so a deploy is picked up on the very next load);
 *   - /lib/*.js?v=<content hash>    → cache-first: the URL changes whenever
 *     the file does, so a cached copy can never be stale;
 *   - icons, emblem, manifest       → network-first with cache fallback.
 *
 * Bump CACHE_VERSION on any change to this file or to the precached shell;
 * activate() deletes every other ezone-staffing-* cache.
 */
'use strict';

const CACHE_VERSION = 'v2';
const CACHE_PREFIX = 'ezone-staffing-';
const CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;

const PRECACHE = [
  '/',
  '/manifest.webmanifest',
  '/emblem.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
];

// The single gate every request passes through. Exported for tests via
// self.__swShouldHandle (harmless in the browser).
function shouldHandle(request) {
  if (!request || request.method !== 'GET') return false;
  let url;
  try { url = new URL(request.url); } catch (e) { return false; }
  if (url.origin !== self.location.origin) return false;
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return false;
  if (request.headers && request.headers.get && request.headers.get('authorization')) return false;
  if (url.pathname === '/sw.js') return false;
  return true;
}
self.__swShouldHandle = shouldHandle;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME)
        .map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function networkFirst(request, cacheKey) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const resp = await fetch(request);
    if (resp && resp.ok && resp.type === 'basic') {
      cache.put(cacheKey || request, resp.clone());
    }
    return resp;
  } catch (err) {
    const hit = await cache.match(cacheKey || request);
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirstVersioned(request) {
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(request);
  if (hit) return hit;
  const resp = await fetch(request);
  if (resp && resp.ok && resp.type === 'basic') {
    // Drop older ?v= copies of the same file so the cache does not grow
    // by one entry per deploy.
    const path = new URL(request.url).pathname;
    const keys = await cache.keys();
    await Promise.all(keys
      .filter((k) => new URL(k.url).pathname === path && k.url !== request.url)
      .map((k) => cache.delete(k)));
    cache.put(request, resp.clone());
  }
  return resp;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (!shouldHandle(request)) return; // browser default — never cached
  const url = new URL(request.url);

  if (request.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html') {
    event.respondWith(networkFirst(request, '/'));
    return;
  }
  if (url.pathname.startsWith('/lib/') && url.searchParams.has('v')) {
    event.respondWith(cacheFirstVersioned(request));
    return;
  }
  event.respondWith(networkFirst(request));
});
