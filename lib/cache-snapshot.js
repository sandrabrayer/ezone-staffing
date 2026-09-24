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
//   - it is ENCRYPTED: AES-256-GCM with the 32-byte key in the Railway
//     variable CACHE_SNAPSHOT_KEY, a fresh random 96-bit IV per write, and
//     the 128-bit tag checked on read. The fs half only takes and returns
//     plaintext through encrypt/decrypt, so there is no code path that puts
//     the plaintext on disk — without a valid key writeSnapshot refuses and
//     writes nothing at all;
//   - no key that looks like a credential is ever written;
//   - a value that looks like an error body is never written;
//   - the file is 0600 (forced on every write, even over an older file) in
//     a 0700 directory, written atomically (tmp+rename);
//   - it is size-capped;
//   - a corrupt, truncated, tampered, wrong-key, wrong-version,
//     future-dated or too-old file is treated exactly like no file;
//   - nothing here logs, and no error it returns carries file contents —
//     only an error code.
//
// The plaintext file an earlier version wrote (read-cache.json) is deleted
// by removeLegacyPlaintext() at boot, key or no key.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VERSION = 1;
const FILE_NAME = 'read-cache.enc';
const LEGACY_PLAINTEXT_FILE = 'read-cache.json';
// File layout: MAGIC | IV (12) | TAG (16) | ciphertext.
const MAGIC = Buffer.from('EZSNAP1\n', 'latin1');
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
// Bound into the tag: a ciphertext made for another purpose, or another app
// sharing the same key by mistake, does not decrypt here.
const AAD = Buffer.from('ezone-staffing/read-cache/v1', 'utf8');
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

// ---- crypto: pure, never throws, never logs ----

// CACHE_SNAPSHOT_KEY → { key: Buffer(32) } | { key: null, reason }.
// Accepted: 64 hex characters, or base64 / base64url that decodes to exactly
// 32 bytes (`openssl rand -base64 32`). Anything else is refused rather than
// stretched: a short or typed-in key must not quietly become a weak one.
// The reason never echoes the value.
function parseKey(raw) {
  const s = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!s) return { key: null, reason: 'no key' };
  if (/^[0-9a-f]{64}$/i.test(s)) return { key: Buffer.from(s, 'hex'), reason: '' };
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) {
    const buf = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (buf.length === KEY_BYTES) return { key: buf, reason: '' };
  }
  return { key: null, reason: 'invalid key' };
}

function isKey(key) { return Buffer.isBuffer(key) && key.length === KEY_BYTES; }

// text → Buffer (MAGIC | IV | TAG | ciphertext). Throws only on a bad key,
// which writeSnapshot checks first.
function encrypt(text, key) {
  if (!isKey(key)) throw new Error('cache-snapshot: invalid key');
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(AAD);
  const ct = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ct]);
}

// Buffer → text, or null for anything that is not an intact file made with
// this key (wrong key, flipped bit, truncated, wrong magic). Never throws.
function decrypt(buf, key) {
  try {
    if (!isKey(key) || !Buffer.isBuffer(buf)) return null;
    if (buf.length < MAGIC.length + IV_BYTES + TAG_BYTES) return null;
    if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) return null;
    const iv = buf.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
    const tag = buf.subarray(MAGIC.length + IV_BYTES, MAGIC.length + IV_BYTES + TAG_BYTES);
    const ct = buf.subarray(MAGIC.length + IV_BYTES + TAG_BYTES);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch (_) {
    return null;
  }
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

// Encrypts `text` with `key` and writes it. Without a valid key it writes
// NOTHING and says so. → { ok, bytes, reason }
function writeSnapshot(dir, text, key) {
  if (!isKey(key)) return { ok: false, bytes: 0, reason: 'no key' };
  let tmp = '';
  try {
    const data = encrypt(text, key);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, FILE_NAME);
    tmp = file + '.tmp';
    // `mode` applies only when the file is CREATED; a tmp left behind by a
    // crash keeps its old mode, so drop it first and chmod regardless.
    try { fs.unlinkSync(tmp); } catch (_) { /* usually absent */ }
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600);
    return { ok: true, bytes: data.length, reason: '' };
  } catch (err) {
    if (tmp) { try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ } }
    return { ok: false, bytes: 0, reason: String((err && err.code) || 'error') };
  }
}

// → { text } | { text: null, reason: 'no key' | 'absent' | 'undecryptable' | <code> }
function readSnapshot(dir, key) {
  if (!isKey(key)) return { text: null, reason: 'no key' };
  let buf;
  try {
    buf = fs.readFileSync(path.join(dir, FILE_NAME));
  } catch (err) {
    return { text: null, reason: err && err.code === 'ENOENT' ? 'absent' : String((err && err.code) || 'error') };
  }
  const text = decrypt(buf, key);
  return text === null ? { text: null, reason: 'undecryptable' } : { text, reason: '' };
}

// The plaintext read-cache.json an earlier version wrote. Deleted, never
// read. → true when a file was removed.
function removeLegacyPlaintext(dir) {
  try {
    fs.unlinkSync(path.join(dir, LEGACY_PLAINTEXT_FILE));
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  VERSION, FILE_NAME, LEGACY_PLAINTEXT_FILE, DEFAULT_MAX_ENTRIES, DEFAULT_MAX_BYTES, KEY_BYTES,
  persistable, serialize, parse, parseKey, encrypt, decrypt,
  probeDir, writeSnapshot, readSnapshot, removeLegacyPlaintext,
};
