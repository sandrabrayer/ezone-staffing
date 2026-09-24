'use strict';

// Guards for the dependency-audit CI check (.github/workflows/audit.yml).
//
// Railway's "wait for CI" gates a deploy on EVERY workflow that runs on a
// push to the deployed branch (main), not just "Tests". A newly published
// advisory must never skip a deploy of unrelated work, so the audit:
//   - has NO push trigger at all (pull_request into main + weekly schedule +
//     workflow_dispatch only);
//   - is NOT a step inside the Tests workflow;
//   - audits production dependencies only, at high+ severity;
//   - is read-only and installs nothing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WF = path.join(__dirname, '..', '.github', 'workflows');
const audit = fs.readFileSync(path.join(WF, 'audit.yml'), 'utf8');
const tests = fs.readFileSync(path.join(WF, 'test.yml'), 'utf8');

// The `on:` block: from `on:` to the next top-level key.
const onBlock = /^on:\s*\n([\s\S]*?)^\S/m.exec(audit)[1];

test('audit.yml runs npm audit on production deps at high+', () => {
  assert.match(audit, /^\s+run: npm audit --audit-level=high --omit=dev\s*$/m);
});

test('audit.yml has NO push trigger (a push:main run can skip a Railway deploy)', () => {
  assert.equal(/^\s*push\s*:/m.test(onBlock), false, 'no push trigger of any kind');
  assert.equal(/^\s*(release|create|workflow_run)\s*:/m.test(onBlock), false);
});

test('audit.yml triggers: pull_request into main, weekly schedule, workflow_dispatch', () => {
  assert.match(onBlock, /^\s{2}pull_request:\s*\n\s{4}branches:\s*\n\s{6}- main\s*$/m);
  assert.match(onBlock, /^\s{2}schedule:\s*\n\s{4}- cron: '0 6 \* \* 0'\s*$/m);
  assert.match(onBlock, /^\s{2}workflow_dispatch:\s*$/m);
});

test('audit.yml is read-only (contents: read) and installs nothing', () => {
  assert.match(audit, /^permissions:\s*\n\s+contents: read\s*$/m);
  assert.equal(/npm (ci|install)\b/.test(audit), false, 'audit reads the lockfile; no install, no lifecycle scripts');
});

test('the Tests workflow (the deploy gate) does NOT run npm audit', () => {
  assert.equal(/npm audit/.test(tests), false);
  assert.match(tests, /^name: Tests\s*$/m);
});
