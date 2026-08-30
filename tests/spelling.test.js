'use strict';
// Hebrew spelling regressions. Add tests here when a typo gets through
// — they're cheap (millisecond grep over text files) and prevent the
// same word from drifting back in via copy-paste or auto-complete.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', '.claude', 'coverage']);
const TEXT_EXT_RE = /\.(html|js|mjs|cjs|md|json|gs|css|txt|yml|yaml)$/i;

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(path.join(dir, entry.name));
    } else if (entry.isFile() && TEXT_EXT_RE.test(entry.name)) {
      // Skip this file itself — it literally has to contain the typo
      // as a test fixture for the assertion to be meaningful.
      if (path.resolve(dir, entry.name) === __filename) continue;
      yield path.join(dir, entry.name);
    }
  }
}

test('spelling: "אורכיב" (typo) never appears anywhere in the repo', () => {
  // The correct Hebrew spelling is ארכיב (without the extra ו). The typo
  // אורכיב reached production once via the section header — this test
  // keeps it from drifting back in.
  const offenders = [];
  for (const file of walk(ROOT)) {
    const content = fs.readFileSync(file, 'utf8');
    if (content.includes('אורכיב')) {
      offenders.push(path.relative(ROOT, file));
    }
  }
  assert.deepEqual(
    offenders, [],
    `Found the typo "אורכיב" in: ${offenders.join(', ') || '(none)'}. Correct spelling is ארכיב (no ו after the א).`,
  );
});

test('spelling: dashboard renders "ארכיב עובדים" (correct spelling) as the section header', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.ok(
    html.includes('ארכיב עובדים'),
    'expected the correctly-spelled section header "ארכיב עובדים" in public/index.html',
  );
});

// The chlt status label. The correct Hebrew is חל"ת (חופשה ללא תשלום);
// the typo חל"ט shipped in every label map / badge / dropdown. These
// guards scan the SHIPPED sources only (frontend, Apps Script, lib) —
// historical CHANGELOG entries and old test names keep their original
// text. Both quote variants are matched: U+0022 (") and U+05F4 (״).
const SHIPPED_SOURCES = [
  path.join('public', 'index.html'),
  path.join('apps-script', 'Code.gs'),
  path.join('lib', 'calc.js'),
  path.join('lib', 'validate.js'),
  path.join('lib', 'migrate.js'),
  path.join('lib', 'shift-compliance.js'),
  path.join('lib', 'auth.js'),
  path.join('lib', 'import_actuals.js'),
  path.join('lib', 'xlsx_read.js'),
  'server.js',
];
const CHLT_TYPO_RE = new RegExp('חל["״]ט');

test('spelling: the chlt label typo (tet instead of tav) appears nowhere in shipped sources', () => {
  const offenders = [];
  for (const rel of SHIPPED_SOURCES) {
    const content = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    if (CHLT_TYPO_RE.test(content)) offenders.push(rel);
  }
  assert.deepEqual(
    offenders, [],
    `Found the typo (chlt spelled with a tet) in: ${offenders.join(', ') || '(none)'}. The correct label ends with a tav.`,
  );
});

test('spelling: the chlt status label renders with the correct spelling (ends with tav)', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.ok(html.includes('חל"ת'), 'expected the corrected chlt label in public/index.html');
  // The stored ASCII value is untouched — only the display label changed.
  assert.match(html, /chlt:\s*'חל"ת'/, 'STATUS_LABELS must map chlt to the corrected label');
  assert.match(html, /<option value="chlt">חל"ת<\/option>/, 'the status dropdown must show the corrected label');
});
