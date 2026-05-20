'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { signToken, verifyToken, checkPin } = require('../lib/auth');

const SECRET = 'a'.repeat(64);

test('signToken: produces verifiable token', () => {
  const tok = signToken(SECRET, 1);
  assert.equal(verifyToken(SECRET, tok), true);
});

test('verifyToken: rejects token signed with different secret', () => {
  const tok = signToken(SECRET, 1);
  assert.equal(verifyToken('b'.repeat(64), tok), false);
});

test('verifyToken: rejects tampered expiry', () => {
  const tok = signToken(SECRET, 1);
  const [, sig] = tok.split('.');
  const tampered = (Date.now() + 365 * 24 * 60 * 60 * 1000) + '.' + sig;
  assert.equal(verifyToken(SECRET, tampered), false);
});

test('verifyToken: rejects expired token', () => {
  // sign with -1 days (already expired)
  const tok = signToken(SECRET, -1);
  assert.equal(verifyToken(SECRET, tok), false);
});

test('verifyToken: rejects malformed input', () => {
  assert.equal(verifyToken(SECRET, ''), false);
  assert.equal(verifyToken(SECRET, 'no-dot'), false);
  assert.equal(verifyToken(SECRET, '.'), false);
  assert.equal(verifyToken(SECRET, null), false);
  assert.equal(verifyToken(SECRET, undefined), false);
});

test('signToken: requires secret', () => {
  assert.throws(() => signToken('', 1));
});

test('checkPin: matches identical pin', () => {
  assert.equal(checkPin('1234', '1234'), true);
});

test('checkPin: rejects mismatched pin', () => {
  assert.equal(checkPin('1234', '4321'), false);
  assert.equal(checkPin('12345', '1234'), false); // different lengths
});

test('checkPin: rejects empty expected', () => {
  assert.equal(checkPin('1234', ''), false);
});

test('checkPin: rejects non-string input', () => {
  assert.equal(checkPin(1234, '1234'), false);
  assert.equal(checkPin(null, '1234'), false);
});
