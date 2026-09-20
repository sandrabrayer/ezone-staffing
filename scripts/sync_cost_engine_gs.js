#!/usr/bin/env node
'use strict';

// ============================================================
// apps-script/CostEngine.gs is a GENERATED COPY of lib/cost-engine.js.
//
// The editor-run reporting functions in Code.gs (logMonthTotalsNow) must
// produce the same shekel the screen shows. The only way to guarantee that
// is to run the SAME code — not a second implementation that agrees today
// and drifts next month. clasp pushes every file under apps-script/, so the
// copy deploys with Code.gs, and tests/cost-engine-gs-sync.test.js fails the
// build the moment the two files differ.
//
//   node scripts/sync_cost_engine_gs.js          → rewrite the copy
//   node scripts/sync_cost_engine_gs.js --check  → exit 1 if it is stale
//
// The source file is never edited by this script: lib/cost-engine.js stays
// the one place a cost rule changes.
// ============================================================

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'lib', 'cost-engine.js');
const OUT = path.join(ROOT, 'apps-script', 'CostEngine.gs');

const BANNER = [
  '// ============================================================',
  '// GENERATED FILE — DO NOT EDIT.',
  '//',
  '// A byte-for-byte copy of lib/cost-engine.js, so the Apps Script',
  '// editor functions and the browser price a month with ONE engine.',
  '// Edit lib/cost-engine.js and run:',
  '//',
  '//   node scripts/sync_cost_engine_gs.js',
  '//',
  '// tests/cost-engine-gs-sync.test.js fails if this copy is stale.',
  '//',
  '// The UMD tail assigns globalThis.CostEngine, which is how Code.gs',
  '// reaches it (module is undefined in Apps Script, so the Node branch',
  '// is simply skipped).',
  '// ============================================================',
  '',
].join('\n');

function expected() {
  return BANNER + fs.readFileSync(SRC, 'utf8');
}

const want = expected();
const check = process.argv.includes('--check');
const have = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null;

if (check) {
  if (have === want) {
    console.log('apps-script/CostEngine.gs is in sync with lib/cost-engine.js');
    process.exit(0);
  }
  console.error('apps-script/CostEngine.gs is STALE. Run: node scripts/sync_cost_engine_gs.js');
  process.exit(1);
}

fs.writeFileSync(OUT, want);
console.log('wrote ' + path.relative(ROOT, OUT) + ' (' + want.length + ' bytes)');
