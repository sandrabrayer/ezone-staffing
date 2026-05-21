'use strict';
// Loads public/index.html in jsdom with all <script> tags executing, and
// asserts no script errors fire. This is the regression suite for the
// duplicate-top-level-identifier bug class:
//   lib/calc.js loads as a classic script and creates global function
//   bindings. The inline <script> in public/index.html then declares
//   `const { ... } = window.EZONE_CALC`. Each const binding is checked
//   against the existing global var environment — any unaliased name
//   that matches a calc.js function throws "Identifier X has already
//   been declared" at script-load time and the page is dead.
//
// Two such bugs reached browser testing before this test existed: `cost`
// in the cloud-port commit, and `todayStr` in the coverage-event redesign.
// Both now caught here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');

// Inline lib/calc.js into the HTML so jsdom doesn't try to fetch it over the
// network. Preserves the classic-script load order: calc.js first, then the
// existing inline <script>. (The collision we're testing for happens exactly
// when both scripts execute in the same realm's global lexical env, which is
// the case here.)
function buildInlinedHtml() {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const calc = fs.readFileSync(path.join(ROOT, 'lib', 'calc.js'), 'utf8');
  const inlined = html.replace(
    /<script src="\/lib\/calc\.js"><\/script>/,
    `<script>${calc}</script>`,
  );
  if (inlined === html) {
    throw new Error('expected <script src="/lib/calc.js"></script> in public/index.html');
  }
  return inlined;
}

function loadPage() {
  const errors = [];
  const vc = new VirtualConsole();
  // jsdomError fires for any uncaught script error during page evaluation —
  // this is where "Identifier X has already been declared" surfaces.
  vc.on('jsdomError', e => {
    errors.push({
      kind: 'jsdomError',
      message: e.message,
      detail: e.detail ? String(e.detail.stack || e.detail.message || e.detail) : '',
    });
  });
  vc.on('error', (...args) => errors.push({ kind: 'consoleError', message: args.map(String).join(' ') }));

  const dom = new JSDOM(buildInlinedHtml(), {
    url: 'http://localhost/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
  });

  // Stub fetch so boot() doesn't try to call the real API.
  dom.window.fetch = async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ houses: { ramot: [], asher: [], ofroni: [], rehab: [] }, events: [] }),
    json: async () => ({ houses: { ramot: [], asher: [], ofroni: [], rehab: [] }, events: [] }),
  });
  return { dom, errors };
}

test('public/index.html loads with no script errors (catches dup-identifier bugs)', async () => {
  const { dom, errors } = loadPage();
  // Give jsdom a tick to finish executing <script> tags and any
  // microtask queued by boot().
  await new Promise(r => setTimeout(r, 150));
  dom.window.close();

  if (errors.length) {
    const summary = errors.map(e => `[${e.kind}] ${e.message}${e.detail ? '\n  ' + e.detail : ''}`).join('\n');
    assert.fail(`expected no script errors when loading public/index.html, got:\n${summary}`);
  }
});

test('public/index.html exposes EZONE_CALC and the inline script destructures cleanly', async () => {
  const { dom, errors } = loadPage();
  await new Promise(r => setTimeout(r, 150));
  // Sanity check: calc.js really did run (EZONE_CALC populated) and the
  // inline script reached its bottom without throwing.
  assert.ok(dom.window.EZONE_CALC, 'window.EZONE_CALC should be set by lib/calc.js');
  assert.equal(typeof dom.window.EZONE_CALC.cost, 'function');
  assert.equal(typeof dom.window.EZONE_CALC.todayStr, 'function');
  dom.window.close();
  assert.equal(errors.length, 0, 'no script errors');
});

test('static audit: no calc.js global is destructured without an alias in the inline script', () => {
  // Belt-and-suspenders catch: this fires even if jsdom can't reproduce the
  // V8 early-error for some future browser-specific reason. A future
  // contributor adding `function foo()` to lib/calc.js and then writing
  // `const { foo } = window.EZONE_CALC` in the inline script would have
  // their PR fail here before they ever opened a browser.
  const calc = fs.readFileSync(path.join(ROOT, 'lib', 'calc.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

  const calcFns = [...calc.matchAll(/^function (\w+)\s*\(/gm)].map(m => m[1]);
  assert.ok(calcFns.length > 0, 'expected at least one top-level function in lib/calc.js');

  const destructureMatch = html.match(/const\s*\{([\s\S]*?)\}\s*=\s*window\.EZONE_CALC\s*;/);
  assert.ok(destructureMatch, 'expected `const { ... } = window.EZONE_CALC` in public/index.html');
  const destructure = destructureMatch[1];

  // For each calc.js global, the destructure must not contain the bare
  // name as a binding (i.e. `name,` or `name }` with no `: alias`).
  const offenders = [];
  for (const name of calcFns) {
    const bareRe = new RegExp(`(^|[\\s,{])${name}\\s*(,|\\}|$)(?!\\s*:)`, 'm');
    if (bareRe.test(destructure)) offenders.push(name);
  }
  assert.deepEqual(offenders, [],
    `These calc.js globals are destructured without renaming and would collide with their global function binding: ${offenders.join(', ')}`);
});
