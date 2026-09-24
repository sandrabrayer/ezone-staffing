'use strict';

// House manager names (public/index.html, HOUSE_MANAGERS).
//
// Pinned here:
//   - the manager of every house, exactly: ramot אורן, asher דליה, pardes חן;
//     ofroni חנן and rehab רנטה unchanged; sde_eliezer and hq none;
//   - both screens that show a manager (the dashboard house card and the
//     house header) show exactly that, through houseMgr();
//   - the names are DEFINED IN ONE PLACE ONLY: one HOUSE_MANAGERS map, no
//     `mgr:` field left on HOUSES or anywhere else, each name a string
//     literal exactly once across the app's source, and no doc keeps a copy.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { buildInlinedHtml, ROOT } = require('./inline-page');

const EXPECTED = {
  ramot: 'אורן',
  asher: 'דליה',
  ofroni: 'חנן',
  rehab: 'רנטה',
  pardes: 'חן',
  sde_eliezer: '',
  hq: '',
};
const OLD = ['שחר', 'עידו'];

function response(body) {
  return {
    ok: true, status: 200,
    headers: { get: (k) => (String(k).toLowerCase() === 'x-cache' ? 'HIT' : null) },
    text: async () => JSON.stringify(body),
  };
}

function loadPage() {
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { if (!/^Not implemented:/.test(e.message || '')) throw e; });
  const dom = new JSDOM(buildInlinedHtml(), {
    url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(window) {
      window.localStorage.setItem('ezone_staff_token_v1', 't.k');
      window.fetch = async (url) => (String(url) === '/api/data'
        ? response({ workers: [], assignments: [], absences: [], coverages: [], archiveV3: [], monthlyActuals: [], budgets: [], feedLog: [] })
        : response({ configured: false }));
    },
  });
  return { dom, w: dom.window, doc: dom.window.document };
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));

test('the manager of every house, exactly', async () => {
  const { dom, w } = loadPage();
  await tick(20);
  const map = JSON.parse(JSON.stringify(w.eval('HOUSE_MANAGERS')));
  assert.deepStrictEqual(map, EXPECTED);
  const houseIds = JSON.parse(JSON.stringify(w.eval('HOUSES.map(h => h.id)')));
  assert.deepStrictEqual(Object.keys(map).sort(), houseIds.slice().sort(), 'one entry per house, no extra');
  houseIds.forEach((id) => assert.strictEqual(w.eval(`houseMgr(${JSON.stringify(id)})`), EXPECTED[id], id));
  assert.strictEqual(w.eval("houseMgr('nope')"), '', 'unknown house → no manager');
  assert.strictEqual(w.eval("houseMgr('toString')"), '', 'never a prototype property');
  dom.window.close();
});

test('the dashboard house cards show exactly these managers', async () => {
  const { dom, w, doc } = loadPage();
  await tick(20);
  w.go('central');
  const boxes = [...doc.querySelectorAll('.house-box')];
  const houses = JSON.parse(JSON.stringify(w.eval('HOUSES')));
  assert.equal(boxes.length, houses.length);
  boxes.forEach((box, i) => {
    const id = houses[i].id;
    const pill = box.querySelector('.hb-mgr');
    if (EXPECTED[id]) assert.equal(pill && pill.textContent, 'מנהל: ' + EXPECTED[id], id);
    else assert.equal(pill, null, id + ' shows no manager');
  });
  const text = doc.getElementById('app').textContent;
  OLD.forEach((n) => assert.ok(!text.includes('מנהל: ' + n), 'old manager still shown: ' + n));
  dom.window.close();
});

test('each house header shows exactly its manager', async () => {
  const { dom, w, doc } = loadPage();
  await tick(20);
  Object.keys(EXPECTED).forEach((id) => {
    w.go(id);
    const el = doc.querySelector('.head .mgr');
    if (EXPECTED[id]) assert.equal(el && el.textContent, 'מנהל הבית: ' + EXPECTED[id], id);
    else assert.equal(el, null, id + ' shows no manager');
  });
  dom.window.close();
});

// ---------------------------------------------------------------------------
// defined in one place only
// ---------------------------------------------------------------------------

function sourceFiles() {
  const out = [path.join(ROOT, 'public', 'index.html'), path.join(ROOT, 'public', 'sw.js'),
    path.join(ROOT, 'server.js'), path.join(ROOT, 'shift-compliance.js'), path.join(ROOT, 'smoke.js')];
  for (const dir of ['lib', 'apps-script', 'scripts']) {
    fs.readdirSync(path.join(ROOT, dir)).filter((f) => /\.(js|gs|html)$/.test(f))
      .forEach((f) => out.push(path.join(ROOT, dir, f)));
  }
  return out.filter((f) => fs.existsSync(f)).map((f) => ({ f: path.relative(ROOT, f), text: fs.readFileSync(f, 'utf8') }));
}

test('HOUSE_MANAGERS is the only definition — no `mgr` field, no second manager map', () => {
  const files = sourceFiles();
  const defs = [];
  files.forEach(({ f, text }) => {
    // A value built FROM the accessor (e.g. `const mgrPill = houseMgr(id) …`)
    // is a use, not a definition.
    [...text.matchAll(/\b(?:const|let|var|function)\s+(\w*(?:[Mm]anager|MANAGER|[Mm]gr)\w*)(.*)$/gm)]
      .filter((m) => !/houseMgr\(/.test(m[2]))
      .forEach((m) => defs.push(f + ':' + m[1]));
    assert.ok(!/\bmgr\s*:/.test(text), f + ' still has a `mgr:` field');
    assert.ok(!/\w\.mgr\b/.test(text), f + ' reads `.mgr` instead of houseMgr()');
  });
  assert.deepStrictEqual(defs.sort(), ['public/index.html:HOUSE_MANAGERS', 'public/index.html:houseMgr'].sort());
});

test('each manager name is a string literal exactly once in the app source', () => {
  const files = sourceFiles();
  Object.values(EXPECTED).filter(Boolean).concat(OLD).forEach((name) => {
    const re = new RegExp(`(['"\`])${name}\\1`, 'g');
    const hits = files.flatMap(({ f, text }) => [...text.matchAll(re)].map(() => f));
    const want = OLD.includes(name) ? [] : ['public/index.html'];
    assert.deepStrictEqual(hits, want, `'${name}' as a literal in: ${hits.join(', ') || 'nowhere'}`);
  });
});

test('no doc keeps its own copy of the manager names (CHANGELOG records history and is exempt)', () => {
  const names = Object.values(EXPECTED).filter(Boolean).concat(OLD).join('|');
  const re = new RegExp(`מנהל(?:\\s+הבית)?\\s*[:—–-]\\s*(?:${names})(?![\\u0590-\\u05FF])`);
  const mds = [];
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((d) => {
    if (d.name === 'node_modules' || d.name.startsWith('.')) return;
    const p = path.join(dir, d.name);
    if (d.isDirectory()) walk(p);
    else if (d.name.endsWith('.md') && d.name !== 'CHANGELOG.md') mds.push(p);
  });
  walk(ROOT);
  assert.ok(mds.length > 5, 'found the docs');
  mds.forEach((p) => assert.ok(!re.test(fs.readFileSync(p, 'utf8')), path.relative(ROOT, p) + ' lists manager names'));
});
