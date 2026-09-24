'use strict';

// The Express → Apps Script upstream: ONE global queue, a classifier for the
// answers Google gives instead of JSON, and a deadline on every call.
//
// Same pattern as ezone-coordinators after its Sep 15–16 incident
// (docs/cold-start-502.md there): a burst of simultaneous executions makes
// Apps Script answer HTTP 200/404 with an HTML page ("Sorry, unable to open
// the file at this time", quota pages) instead of JSON. The proxy used to
// turn that straight into a 502 for the user. Now:
//
//   1. every upstream call — user reads, writes, boot warm-up, background
//      refreshes, keep-warm — waits for a slot in ONE queue capped at
//      UPSTREAM_CONCURRENCY (default 2). Two lanes: a user request always
//      takes the next free slot ahead of queued background work;
//   2. classifyUpstream() says whether a non-JSON answer is worth retrying;
//   3. fetchWithDeadline() gives up after a fixed time instead of Node's
//      ~300 s default.
//
// Nothing here logs a URL, a header or a body: the upstream URL carries
// SHARED_SECRET in its query string.

function createUpstreamQueue(opts) {
  const o = opts || {};
  const limit = Math.max(1, Math.min(6, Math.floor(Number(o.concurrency) || 2)));
  const lanes = { user: [], background: [] };
  let active = 0;

  function pump() {
    while (active < limit) {
      const next = lanes.user.shift() || lanes.background.shift();
      if (!next) return;
      active++;
      Promise.resolve()
        .then(next.fn)
        .then(next.resolve, next.reject)
        .finally(() => { active--; pump(); });
    }
  }

  // run(fn, lane) → the promise fn returns, once a slot was free.
  function run(fn, lane) {
    return new Promise((resolve, reject) => {
      (lane === 'background' ? lanes.background : lanes.user).push({ fn, resolve, reject });
      pump();
    });
  }

  function depth() {
    return { active, queued: lanes.user.length + lanes.background.length, limit };
  }

  return { run, depth, limit };
}

// What a non-JSON (or error-status) upstream answer means.
//   'quota'     — a throttle / quota page. Retryable.
//   'html'      — any other HTML page, including Google's 404 "unable to open
//                 the file" page that Apps Script returns under load. Retryable.
//   'transient' — 429 or 5xx. Retryable.
//   'nonjson'   — anything else that is not JSON. Not retryable: it will not
//                 fix itself.
function classifyUpstream(status, text) {
  const head = String(text || '').slice(0, 400);
  const looksHtml = /^\s*(<!DOCTYPE|<html)/i.test(head);
  const quotaWords = /too many times|rate limit|quota|exceeded maximum|service invoked|try again later|temporarily unavailable/i.test(head);
  if (looksHtml || quotaWords) return { kind: quotaWords ? 'quota' : 'html', retryable: true };
  if (status === 429 || status >= 500) return { kind: 'transient', retryable: true };
  return { kind: 'nonjson', retryable: false };
}

// fetch() with an AbortController deadline. A timeout rejects with an error
// tagged { retryable: true, upstreamKind: 'timeout' }.
async function fetchWithDeadline(fetchImpl, url, init, ms) {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  let timer = null;
  const opts = Object.assign({}, init, ctrl ? { signal: ctrl.signal } : {});
  try {
    return await Promise.race([
      fetchImpl(url, opts),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          if (ctrl) ctrl.abort();
          reject(Object.assign(new Error('upstream timeout after ' + ms + 'ms'),
            { status: 504, retryable: true, upstreamKind: 'timeout', upstreamStatus: 0 }));
        }, ms);
        if (timer.unref) timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = { createUpstreamQueue, classifyUpstream, fetchWithDeadline };
