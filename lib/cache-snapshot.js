'use strict';

// The proxy read cache, written to disk and read back at boot.
//
// The cache lives in memory, so every restart and every deploy used to start
// cold: the first person to open the app afterwards waited for a full Apps
// Script execution. The server now writes the cache to
// <CACHE_SNAPSHOT_DIR>/read-cache.json and restores it at boot, where the
// restored copy is served as STALE (never as fresh) while a refresh runs.
// Same pattern as ezone-coordinators (docs/cache-snapshot.md there).
//
// The pure half (serialize / parse) has no fs, no timers and no globals, so
// every rule is testable without a disk. The fs half (writeSnapshot /
// readSnapshot / probeDir) never throws: a snapshot is an optimisation,
// never a dependency.
//
// The file holds salary data. So:
//   - no key that looks like a credential is ever written;
//   - a value that looks like an error body is never written;
//   - the file is 0600 in a 0700 directory, written atomically (tmp+rename);
//   - it is size-capped;
//   - a corrupt, truncated, wrong-version, future-dated or too-old file is
//     treated exactly like no file.

const fs = require('fs');
const path = require('path');

const VERSION = 1;
const FILE_NAME = 'read-cache.json';
const DEFAULT_MAX_ENTRIES = 20;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const SECRETISH = /secret|token|password|pin|key|auth/i;

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function persistable(key, entry) {
  if (typeof key !== 'string' || !/^[a-z][a-z0-9:_-]{0,63}$/i.test(key) || SECRETISH.test(key)) return false;
  if (!entry || typeof entry !== 'object') return false;
  if (!isPlainObject(entry.value)) return false;
  if (entry.value.error !== undefined || entry.value._status >= 400) return false;
  if (!(typeof entry.storedAt === 'number' && isFinite(entry.storedAt) && entry.storedAt > 0)) return false;
  return true;
}

// pairs: iterable of [key, { value, storedAt }] → { text, count }
function serialize(pairs, opts) {
  const o = opts || {};
  const now = typeof o.now === 'number' ? o.now : Date.now();
  const maxEntries = o.maxEntries || DEFAULT_MAX_ENTRIES;
  const maxBytes = o.maxBytes || DEFAULT_MAX_BYTES;
  let rows = [];
  Array.from(pairs || []).forEach((pair) => {
    const key = pair && pair[0];
    const entry = pair && pair[1];
    if (!persistable(key, entry)) return;
    rows.push({ key, storedAt: entry.storedAt, value: entry.value });
  });
  rows.sort((a, b) => b.storedAt - a.storedAt);
  rows = rows.slice(0, maxEntries);
  const doc = { v: VERSION, savedAt: now, entries: rows };
  let text = JSON.stringify(doc);
  while (text.length > maxBytes && doc.entries.length) {
    doc.entries = doc.entries.slice(0, Math.floor(doc.entries.length / 2));
    text = JSON.stringify(doc);
  }
  return { text, count: doc.entries.length };
}

// text → { savedAt, entries: [{ key, value, storedAt }] } or null. Never throws.
function parse(text, opts) {
  const o = opts || {};
  const now = typeof o.now === 'number' ? o.now : Date.now();
  const maxAgeMs = typeof o.maxAgeMs === 'number' ? o.maxAgeMs : 0;
  let doc;
  try { doc = JSON.parse(String(text || '')); } catch (_) { return null; }
  if (!isPlainObject(doc) || doc.v !== VERSION || !Array.isArray(doc.entries)) return null;
  if (!(typeof doc.savedAt === 'number' && isFinite(doc.savedAt) && doc.savedAt > 0)) return null;
  if (doc.savedAt > now + 60000) return null;
  if (maxAgeMs > 0 && now - doc.savedAt > maxAgeMs) return null;
  const entries = [];
  doc.entries.slice(0, DEFAULT_MAX_ENTRIES).forEach((row) => {
    if (!isPlainObject(row)) return;
    const entry = { value: row.value, storedAt: row.storedAt };
    if (!persistable(row.key, entry)) return;
    if (entry.storedAt > now + 60000) return;
    if (maxAgeMs > 0 && now - entry.storedAt > maxAgeMs) return;
    entries.push({ key: row.key, value: entry.value, storedAt: entry.storedAt });
  });
  return { savedAt: doc.savedAt, entries };
}

// ---- fs half: never throws ----

// Can we create and write the directory? → { ok, reason }
function probeDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const probe = path.join(dir, '.probe-' + process.pid);
    fs.writeFileSync(probe, 'ok', { mode: 0o600 });
    fs.unlinkSync(probe);
    return { ok: true, reason: '' };
  } catch (err) {
    return { ok: false, reason: String((err && err.code) || 'error') };
  }
}

function writeSnapshot(dir, text) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, FILE_NAME);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch (_) { /* best effort */ }
    return { ok: true, bytes: Buffer.byteLength(text), reason: '' };
  } catch (err) {
    return { ok: false, bytes: 0, reason: String((err && err.code) || 'error') };
  }
}

// → { text } | { text: null, reason }
function readSnapshot(dir) {
  try {
    return { text: fs.readFileSync(path.join(dir, FILE_NAME), 'utf8'), reason: '' };
  } catch (err) {
    return { text: null, reason: err && err.code === 'ENOENT' ? 'absent' : String((err && err.code) || 'error') };
  }
}

module.exports = {
  VERSION, FILE_NAME, DEFAULT_MAX_ENTRIES, DEFAULT_MAX_BYTES,
  persistable, serialize, parse, probeDir, writeSnapshot, readSnapshot,
};
