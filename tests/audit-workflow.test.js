'use strict';

// Guards for the dependency-audit CI check (.github/workflows/audit.yml).
//
// The audit MUST stay a separate workflow: Railway gates deploys on the
// "Tests" check, and a newly published advisory must not silently block a
// deploy of unrelated work. It audits production dependencies only, at
// high+ severity, on pull requests and on pushes to main.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WF = path.join(__dirname, '..', '.github', 'workflows');
const audit = fs.readFileSync(path.join(WF, 'audit.yml'), 'utf8');
const tests = fs.readFileSync(path.join(WF, 'test.yml'), 'utf8');

test('audit.yml runs npm audit on production deps at high+', () => {
  assert.match(audit, /^\s+run: npm audit --audit-level=high --omit=dev\s*$/m);
});

test('audit.yml triggers on pull_request and on push to main', () => {
  assert.match(audit, /^on:\s*\n\s+pull_request:\s*\n\s+push:\s*\n\s+branches:\s*\n\s+- main\s*$/m);
});

test('audit.yml is read-only (contents: read) and installs nothing', () => {
  assert.match(audit, /^permissions:\s*\n\s+contents: read\s*$/m);
  assert.equal(/npm (ci|install)\b/.test(audit), false, 'audit reads the lockfile; no install, no lifecycle scripts');
});

test('the Tests workflow (the deploy gate) does NOT run npm audit', () => {
  assert.equal(/npm audit/.test(tests), false);
  assert.match(tests, /^name: Tests\s*$/m);
});
