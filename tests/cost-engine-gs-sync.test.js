'use strict';

// apps-script/CostEngine.gs must stay a byte-for-byte copy of
// lib/cost-engine.js.
//
// logMonthTotalsNow() is the function that proves a production fix moved the
// money it was supposed to move. That proof is worth nothing if the editor
// prices a month with one engine and the screen with another, so the copy is
// generated (scripts/sync_cost_engine_gs.js) and this test fails the build
// the moment it drifts — including the easy mistake of editing the copy.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'lib', 'cost-engine.js');
const COPY = path.join(ROOT, 'apps-script', 'CostEngine.gs');

test('the generated copy exists and ends with the source, byte for byte', () => {
  assert.ok(fs.existsSync(COPY), 'apps-script/CostEngine.gs must be committed — clasp deploys it');
  const src = fs.readFileSync(SRC, 'utf8');
  const copy = fs.readFileSync(COPY, 'utf8');
  assert.ok(copy.endsWith(src),
    'CostEngine.gs is stale. Run: node scripts/sync_cost_engine_gs.js');
  assert.ok(/GENERATED FILE — DO NOT EDIT/.test(copy.slice(0, copy.length - src.length)),
    'the banner must say the file is generated, above the copied source');
});

test('the sync script agrees that the copy is current', () => {
  // The same check CI would run by hand, driven through the script itself so
  // the script and the test can never disagree about what "in sync" means.
  execFileSync(process.execPath,
    [path.join(ROOT, 'scripts', 'sync_cost_engine_gs.js'), '--check'],
    { cwd: ROOT, stdio: 'pipe' });
});

test('the copy exposes CostEngine on the global, which is how Code.gs reaches it', () => {
  const copy = fs.readFileSync(COPY, 'utf8');
  assert.ok(/root\.CostEngine = API/.test(copy));
  assert.ok(/typeof globalThis !== 'undefined' \? globalThis : this/.test(copy),
    'Apps Script has globalThis; the UMD tail must use it');
  const gs = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
  assert.ok(/function costEngine_\(\)/.test(gs), 'Code.gs reaches the engine through one accessor');
  assert.ok(/CostEngine is not in this Apps Script project/.test(gs),
    'and fails loudly when the file was not deployed, rather than throwing a ReferenceError');
});
