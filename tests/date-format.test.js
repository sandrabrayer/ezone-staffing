'use strict';

// Israel timezone so a coerced status_date like "… GMT+0300" formats to the
// intended local day. Set before any Date is constructed. The offset-string
// assertions below stay timezone-independent regardless.
process.env.TZ = 'Asia/Jerusalem';

// Guards for the shared date formatter (fmtDate) and the leave badge in
// public/index.html. The reported bug: a worker on חל"ד / חל"ט showed the leave
// start date as a raw JS Date string ("Thu Jul 16 2026 00:00:00 GMT+0300 …")
// because fmtDate passed through anything that wasn't a clean YYYY-MM-DD. Now
// fmtDate is the ONE formatter and always yields DD/MM/YYYY (or ''), and the
// badge shows only the label with the date as plain text beside it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

// Load index.html in jsdom with calc.js inlined (same approach as
// tests/page-load.test.js) so fmtDate / leaveBadge are callable as globals.
function loadPage() {
  const calc = fs.readFileSync(path.join(ROOT, 'lib', 'calc.js'), 'utf8');
  const inlined = html.replace(/<script src="\/lib\/calc\.js"><\/script>/, `<script>${calc}</script>`);
  const vc = new VirtualConsole();
  const dom = new JSDOM(inlined, { url: 'http://localhost/', runScripts: 'dangerously', virtualConsole: vc });
  return dom.window;
}

const RAW_DATE_STR = 'Thu Jul 16 2026 00:00:00 GMT+0300 (Israel Daylight Time)';
const DDMMYYYY = /^\d{2}\/\d{2}\/\d{4}$/;

// ---------------------------------------------------------------------------
// fmtDate — the one shared DD/MM/YYYY formatter
// ---------------------------------------------------------------------------

test('fmtDate: ISO YYYY-MM-DD → DD/MM/YYYY (string surgery, tz-safe)', () => {
  const win = loadPage();
  assert.equal(win.fmtDate('2026-07-16'), '16/07/2026');
  assert.equal(win.fmtDate('2026-07-16T00:00:00Z'), '16/07/2026'); // ISO prefix
  win.close();
});

test('fmtDate: already DD/MM/YYYY passes through unchanged', () => {
  const win = loadPage();
  assert.equal(win.fmtDate('16/07/2026'), '16/07/2026');
  win.close();
});

test('fmtDate: empty / null / unparseable → empty string, never raw junk', () => {
  const win = loadPage();
  assert.equal(win.fmtDate(''), '');
  assert.equal(win.fmtDate(null), '');
  assert.equal(win.fmtDate(undefined), '');
  assert.equal(win.fmtDate('not a date'), '');
  win.close();
});

test('fmtDate: a Date object never renders raw — formats to DD/MM/YYYY', () => {
  const win = loadPage();
  const out = win.fmtDate(new win.Date('Jul 16 2026')); // local midnight → tz-safe day
  assert.equal(out, '16/07/2026');
  win.close();
});

test('fmtDate: a JS Date-STRING (the coerced status_date bug) formats cleanly', () => {
  const win = loadPage();
  // Local-midnight string → exact day is tz-safe.
  assert.equal(win.fmtDate('Jul 16 2026'), '16/07/2026');
  // The real-world value carries an explicit offset; assert it is CLEAN
  // DD/MM/YYYY and leaks none of the raw Date tokens (day value is tz-dependent
  // so we don't pin it, but the format + no-raw guarantee is the fix).
  const out = win.fmtDate(RAW_DATE_STR);
  assert.match(out, DDMMYYYY, `expected DD/MM/YYYY, got ${JSON.stringify(out)}`);
  assert.doesNotMatch(out, /GMT|Israel|Daylight|Thu|Jul/, 'no raw Date tokens may leak');
  win.close();
});

// ---------------------------------------------------------------------------
// leaveBadge — label-only pill + plain date text, no raw Date string
// ---------------------------------------------------------------------------

test('leaveBadge: חל"ד renders a label-only pill plus plain formatted date, no raw Date string', () => {
  const win = loadPage();
  const out = win.leaveBadge({ status: 'chld', statusDate: RAW_DATE_STR });
  assert.doesNotMatch(out, /GMT|Israel|Daylight|Thu/, 'the raw Date string must not appear');
  assert.match(out, /class="leave-badge"/, 'the status label is a leave-badge pill');
  assert.match(out, /class="leave-since"/, 'the date is separate plain text');
  assert.match(out, /מ־\d{2}\/\d{2}\/\d{4}/, 'the date shows as מ־DD/MM/YYYY on the row');
  win.close();
});

test('leaveBadge: חל"ט behaves the same', () => {
  const win = loadPage();
  const out = win.leaveBadge({ status: 'chlt', statusDate: '2026-05-02' });
  assert.doesNotMatch(out, /GMT|Israel/, 'no raw Date string');
  assert.match(out, /class="leave-badge"/);
  assert.match(out, /מ־02\/05\/2026/);
  win.close();
});

test('leaveBadge: an active worker gets no badge', () => {
  const win = loadPage();
  assert.equal(win.leaveBadge({ status: 'active', statusDate: '' }), '');
  win.close();
});

// ---------------------------------------------------------------------------
// Source guards — no raw Date rendering remains
// ---------------------------------------------------------------------------

test('source: the leave badge routes the date through fmtDate, never raw', () => {
  const fn = html.slice(html.indexOf('function leaveBadge'), html.indexOf('function leaveBadge') + 800);
  assert.ok(/fmtDate\(a\.statusDate\)/.test(fn), 'statusDate must be formatted via fmtDate');
  assert.ok(!/\$\{[^}]*a\.statusDate[^}]*\}/.test(fn) || /fmtDate\(a\.statusDate\)/.test(fn),
    'statusDate must not be interpolated raw');
  // The label lives in the pill; the date is outside it (leave-since), so the
  // pill can never overflow with a long date string again.
  assert.ok(/class="leave-badge"/.test(fn) && /class="leave-since"/.test(fn),
    'label-only pill + separate date text');
});

test('source: no display path stringifies a Date object for rendering', () => {
  // Date-specific stringifiers that would leak a raw Date string into the DOM.
  // (Number#toLocaleString in the money helper is unrelated and allowed.)
  for (const bad of ['.toDateString(', '.toLocaleDateString(']) {
    assert.ok(!html.includes(bad), `raw Date rendering "${bad}" must not appear`);
  }
});

// ---------------------------------------------------------------------------
// Dashboard worker-name search (מבט כללי)
// ---------------------------------------------------------------------------

test('source: dashboard has a prominent RTL worker-name search wired to filterDashboard', () => {
  const m = /<input type="text" id="dashSearch"[^>]*>/.exec(html);
  assert.ok(m, 'a search input with id dashSearch must exist on the dashboard');
  const tag = m[0];
  assert.ok(/dir="rtl"/.test(tag), 'RTL preserved');
  assert.ok(/width:100%/.test(tag), 'full-row width');
  assert.ok(/font-size:16px/.test(tag), '16px font');
  assert.ok(/oninput="filterDashboard\(this\.value\)"/.test(tag), 'typing filters the dashboard');
  assert.ok(/function filterDashboard/.test(html), 'filterDashboard must be defined');
  assert.ok(/data-name="\$\{escapeHtml\(nameKey\)\}"/.test(html),
    'network rows must carry data-name for the filter');
});
