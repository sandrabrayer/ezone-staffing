'use strict';

// Shared harness helper: public/index.html with its classic <script src>
// libraries inlined, so jsdom never reaches for the network.
//
// Centralized on purpose. Every one of these libraries loads as a CLASSIC
// script sharing one global lexical environment, which is the environment
// the duplicate-identifier bug class lives in — so the tests must load them
// the same way the browser does, in the same order. Before this file existed
// the same replace() was copy-pasted into seven test harnesses, and adding a
// library meant editing all seven.
//
// NOT a .test.js file, so `node --test tests/*.test.js` does not run it.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// In load order, which matters: calc.js declares top-level bindings, and the
// later two are wrapped in closures precisely because of that.
const LIBS = ['calc.js', 'cost-engine.js', 'exports.js'];

function buildInlinedHtml() {
  let html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  LIBS.forEach(lib => {
    const src = fs.readFileSync(path.join(ROOT, 'lib', lib), 'utf8');
    const tag = `<script src="/lib/${lib}"></script>`;
    if (!html.includes(tag)) {
      throw new Error(`expected ${tag} in public/index.html`);
    }
    // split/join rather than replace(), so a `$&` inside the library source
    // is never interpreted as a replacement pattern.
    html = html.split(tag).join(`<script>${src}</script>`);
  });
  return html;
}

module.exports = { buildInlinedHtml, LIBS, ROOT };
