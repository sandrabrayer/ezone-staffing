'use strict';

// The disk snapshot's encryption (lib/cache-snapshot.js), without a server.
//
// Pinned here:
//   - CACHE_SNAPSHOT_KEY must be exactly 32 bytes (64 hex, or base64 /
//     base64url); a short, long or typed-in value is REFUSED, not stretched,
//     and the refusal never echoes the value.
//   - AES-256-GCM round trip; a fresh IV every write; the plaintext is not in
//     the ciphertext; a flipped bit anywhere, a truncation, a wrong magic or
//     a wrong key reads back as null — never as garbage, never a throw.
//   - writeSnapshot WITHOUT a valid key writes nothing at all; with one the
//     file is 0600 even over an older 0644 file or a stale temp file.
//   - readSnapshot never hands back the undecryptable bytes.
//   - removeLegacyPlaintext deletes the old unencrypted read-cache.json.
// The real-process half (boot log once, no key → no file) is in
// tests/cache-snapshot-boot.test.js.

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const snap = require('../lib/cache-snapshot');

const tmpDir = (p) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), p)), 'cache');
const SALARY_DOC = JSON.stringify({ workers: [{ id: 'w1', name: 'ציון מקנזי' }], assignments: [{ salary: 12345, hourlyRate: 61 }] });

test('parseKey: 64 hex, base64 and base64url of 32 bytes are accepted', () => {
  const raw = crypto.randomBytes(32);
  for (const s of [raw.toString('hex'), raw.toString('hex').toUpperCase(), raw.toString('base64'),
    raw.toString('base64url'), '  ' + raw.toString('base64') + '\n']) {
    const r = snap.parseKey(s);
    assert.ok(r.key && r.key.equals(raw), 'accepted: ' + s.length + ' chars');
    assert.equal(r.reason, '');
  }
});

test('parseKey: missing → "no key"; anything not exactly 32 bytes → "invalid key", never echoed', () => {
  for (const s of [undefined, null, '', '   ']) assert.deepEqual(snap.parseKey(s), { key: null, reason: 'no key' });
  const bad = [
    'correct horse battery staple',               // a passphrase
    crypto.randomBytes(16).toString('base64'),    // AES-128-sized
    crypto.randomBytes(31).toString('hex'),       // 62 hex
    crypto.randomBytes(33).toString('base64'),    // too long
    crypto.randomBytes(32).toString('hex') + 'g', // not hex, not base64 of 32
    'a'.repeat(64) + '==',
  ];
  for (const s of bad) {
    const r = snap.parseKey(s);
    assert.equal(r.key, null, 'refused: ' + s.slice(0, 8));
    assert.equal(r.reason, 'invalid key');
    assert.ok(!JSON.stringify(r).includes(s), 'the value is never echoed');
  }
});

test('encrypt/decrypt: round trip, fresh IV every time, and the plaintext is not in the ciphertext', () => {
  const key = crypto.randomBytes(32);
  const a = snap.encrypt(SALARY_DOC, key);
  const b = snap.encrypt(SALARY_DOC, key);
  assert.equal(snap.decrypt(a, key), SALARY_DOC);
  assert.equal(snap.decrypt(b, key), SALARY_DOC);
  assert.ok(!a.equals(b), 'two writes of the same data differ (random IV)');
  assert.ok(!a.subarray(8, 20).equals(b.subarray(8, 20)), 'the IVs differ');
  for (const needle of ['12345', 'salary', 'hourlyRate', 'workers', Buffer.from('ציון').toString('latin1')]) {
    assert.ok(!a.includes(needle), 'plaintext visible in the file: ' + needle);
  }
  assert.ok(a.subarray(0, 8).equals(Buffer.from('EZSNAP1\n', 'latin1')), 'versioned magic header');
});

test('decrypt: wrong key, any flipped bit, truncation and a wrong header all read as null — never a throw', () => {
  const key = crypto.randomBytes(32);
  const good = snap.encrypt(SALARY_DOC, key);
  assert.equal(snap.decrypt(good, crypto.randomBytes(32)), null, 'wrong key');
  // Flip one bit in the header, the IV, the tag and the ciphertext.
  for (const i of [0, 9, 25, good.length - 1]) {
    const t = Buffer.from(good);
    t[i] ^= 0x01;
    assert.equal(snap.decrypt(t, key), null, 'tampered byte ' + i);
  }
  for (const n of [0, 7, 20, 36, good.length - 1]) assert.equal(snap.decrypt(good.subarray(0, n), key), null, 'truncated to ' + n);
  assert.equal(snap.decrypt(Buffer.from(SALARY_DOC), key), null, 'a plaintext file is not accepted');
  assert.equal(snap.decrypt('not a buffer', key), null);
  assert.equal(snap.decrypt(good, null), null);
  assert.equal(snap.decrypt(good, Buffer.alloc(16)), null, 'a 16-byte key is refused');
});

test('writeSnapshot without a valid key writes NOTHING — not even the directory', () => {
  for (const key of [undefined, null, '', Buffer.alloc(16), 'a'.repeat(32)]) {
    const dir = tmpDir('snap-nokey-');
    const w = snap.writeSnapshot(dir, SALARY_DOC, key);
    assert.deepEqual(w, { ok: false, bytes: 0, reason: 'no key' });
    assert.equal(fs.existsSync(dir), false, 'nothing created');
  }
});

test('writeSnapshot: the file on disk is ciphertext, 0600 even over an old 0644 file and a stale temp', () => {
  const key = crypto.randomBytes(32);
  const dir = tmpDir('snap-mode-');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, snap.FILE_NAME);
  fs.writeFileSync(file, 'old', { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  fs.writeFileSync(file + '.tmp', 'crash leftover', { mode: 0o666 });
  fs.chmodSync(file + '.tmp', 0o666);

  const w = snap.writeSnapshot(dir, SALARY_DOC, key);
  assert.equal(w.ok, true);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(file + '.tmp'), false);
  const raw = fs.readFileSync(file);
  assert.equal(w.bytes, raw.length);
  assert.ok(!raw.includes('12345') && !raw.includes('salary'), 'no plaintext on disk');
  assert.equal(snap.readSnapshot(dir, key).text, SALARY_DOC);
});

test('readSnapshot: no key, wrong key and damage are reasons — the bytes are never handed back', () => {
  const key = crypto.randomBytes(32);
  const dir = tmpDir('snap-read-');
  snap.writeSnapshot(dir, SALARY_DOC, key);
  assert.deepEqual(snap.readSnapshot(dir, null), { text: null, reason: 'no key' });
  assert.deepEqual(snap.readSnapshot(dir, crypto.randomBytes(32)), { text: null, reason: 'undecryptable' });
  fs.writeFileSync(path.join(dir, snap.FILE_NAME), SALARY_DOC);
  assert.deepEqual(snap.readSnapshot(dir, key), { text: null, reason: 'undecryptable' });
  assert.deepEqual(snap.readSnapshot(path.join(dir, 'none'), key), { text: null, reason: 'absent' });
});

test('removeLegacyPlaintext deletes only the old unencrypted read-cache.json', () => {
  const key = crypto.randomBytes(32);
  const dir = tmpDir('snap-legacy-');
  snap.writeSnapshot(dir, SALARY_DOC, key);
  fs.writeFileSync(path.join(dir, 'read-cache.json'), SALARY_DOC);
  assert.equal(snap.LEGACY_PLAINTEXT_FILE, 'read-cache.json');
  assert.notEqual(snap.FILE_NAME, snap.LEGACY_PLAINTEXT_FILE);
  assert.equal(snap.removeLegacyPlaintext(dir), true);
  assert.equal(fs.existsSync(path.join(dir, 'read-cache.json')), false);
  assert.ok(fs.existsSync(path.join(dir, snap.FILE_NAME)), 'the encrypted file stays');
  assert.equal(snap.removeLegacyPlaintext(dir), false, 'nothing left to remove');
  assert.equal(snap.removeLegacyPlaintext(path.join(dir, 'missing')), false, 'never throws');
});

test('lib/cache-snapshot.js has no logging and no plaintext write path', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cache-snapshot.js'), 'utf8');
  assert.ok(!/console\./.test(src), 'the module never logs');
  // Every writeFileSync of the snapshot takes the encrypted buffer (`data`);
  // the only other one is the probe's literal 'ok'.
  const writes = [...src.matchAll(/writeFileSync\(([^,]+),\s*([^,)]+)/g)].map((m) => m[2].trim());
  assert.deepEqual(writes.sort(), ["'ok'", 'data'].sort());
  assert.match(src, /'aes-256-gcm'/);
});
