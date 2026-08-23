'use strict';

// First-hadracha alert banner: (1) behavioural tests for the pure flag logic
// in lib/calc.js — firstHadrachaFlags / parseHadrachotStatus / daysSince —
// which runs ENTIRELY in the frontend; (2) source guards over
// public/index.html for the banner wiring (proxy-only fetch, fail-quiet,
// Hebrew text with no parentheses).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const calc = require('../lib/calc');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

const TODAY = '2026-08-19';

function guide(id, name, startDate) {
  return { id, name, startDate };
}
function asg(id, workerId, opts) {
  return Object.assign({ id, workerId, house: 'ramot', role: 'מדריך/ה', status: 'active' }, opts);
}

// ---------------------------------------------------------------------------
// daysSince
// ---------------------------------------------------------------------------

test('daysSince: whole-day UTC arithmetic; junk/empty → null', () => {
  assert.strictEqual(calc.daysSince('2026-08-11', TODAY), 8);
  assert.strictEqual(calc.daysSince('2026-08-12', TODAY), 7);
  assert.strictEqual(calc.daysSince(TODAY, TODAY), 0);
  assert.strictEqual(calc.daysSince('2026-08-25', TODAY), -6);
  assert.strictEqual(calc.daysSince('', TODAY), null);
  assert.strictEqual(calc.daysSince('not-a-date', TODAY), null);
  assert.strictEqual(calc.daysSince('2026-08-11', ''), null);
});

// ---------------------------------------------------------------------------
// firstHadrachaFlags — the 30-day rule
// ---------------------------------------------------------------------------

test('the 30-day boundary is strict: exactly 30 days is NOT flagged, 31 days IS', () => {
  assert.strictEqual(calc.FIRST_HADRACHA_GRACE_DAYS, 30);
  const workers = [
    guide('w30', 'בדיוק שלושים', '2026-07-20'),   // 30 days → not flagged
    guide('w31', 'שלושים ואחד', '2026-07-19'),    // 31 days → flagged
  ];
  const assignments = [asg('a1', 'w30'), asg('a2', 'w31')];
  const flags = calc.firstHadrachaFlags(workers, assignments, [], TODAY);
  assert.deepStrictEqual(flags.overdue, ['שלושים ואחד']);
  assert.deepStrictEqual(flags.missingStart, []);
});

test('a guide whose first hadracha is completed is never flagged, whitespace-tolerant', () => {
  const workers = [guide('w1', 'דנה לוי', '2026-01-01')];
  const assignments = [asg('a1', 'w1')];
  // Exact name → excluded.
  assert.deepStrictEqual(
    calc.firstHadrachaFlags(workers, assignments, ['דנה לוי'], TODAY).overdue, []);
  // Same name with stray whitespace in the feed → still excluded.
  assert.deepStrictEqual(
    calc.firstHadrachaFlags(workers, assignments, ['  דנה   לוי '], TODAY).overdue, []);
  // Someone ELSE completed → still flagged.
  assert.deepStrictEqual(
    calc.firstHadrachaFlags(workers, assignments, ['אחר לגמרי'], TODAY).overdue, ['דנה לוי']);
});

test('empty start_date → the separate missing-start warning, never overdue', () => {
  const workers = [guide('w1', 'ללא תאריך', ''), guide('w2', 'גם ללא', undefined)];
  const assignments = [asg('a1', 'w1'), asg('a2', 'w2')];
  const flags = calc.firstHadrachaFlags(workers, assignments, [], TODAY);
  assert.deepStrictEqual(flags.overdue, []);
  assert.deepStrictEqual(flags.missingStart.sort(), ['גם ללא', 'ללא תאריך'].sort());
});

test('only ACTIVE staff count: leave statuses and non-supervision roles are excluded', () => {
  const workers = [
    guide('w1', 'בחל"ד', '2026-01-01'),
    guide('w2', 'טבחית ותיקה', '2026-01-01'),
    guide('w3', 'מדריך פעיל', '2026-01-01'),
  ];
  const assignments = [
    asg('a1', 'w1', { status: 'chld' }),
    asg('a2', 'w2', { role: 'טבח/ית' }),
    asg('a3', 'w3'),
  ];
  const flags = calc.firstHadrachaFlags(workers, assignments, [], TODAY);
  assert.deepStrictEqual(flags.overdue, ['מדריך פעיל']);
  assert.deepStrictEqual(flags.missingStart, []);
});

test('all supervision roles are covered — guide, social worker, house manager, coordinator', () => {
  const workers = [
    guide('w1', 'מדריך חדש', '2026-01-01'),
    guide('w2', 'עובדת סוציאלית', '2026-01-01'),
    guide('w3', 'מנהלת בית', '2026-01-01'),
    guide('w4', 'רכזת חדשה', '2026-01-01'),
  ];
  const assignments = [
    asg('a1', 'w1'),                          // מדריך/ה (helper default)
    asg('a2', 'w2', { role: 'מטפל/ת' }),
    asg('a3', 'w3', { role: 'מנהל/ת' }),
    asg('a4', 'w4', { role: 'רכז/ת' }),
  ];
  const flags = calc.firstHadrachaFlags(workers, assignments, [], TODAY);
  assert.deepStrictEqual(flags.overdue.slice().sort(),
    ['מדריך חדש', 'מנהלת בית', 'עובדת סוציאלית', 'רכזת חדשה'].sort());
  assert.deepStrictEqual(calc.HADRACHA_ROLES, ['מדריך/ה', 'מטפל/ת', 'מנהל/ת', 'רכז/ת']);
});

test('a guide at two houses is flagged once; orphan assignments are skipped', () => {
  const workers = [guide('w1', 'שני בתים', '2026-01-01')];
  const assignments = [
    asg('a1', 'w1', { house: 'ramot' }),
    asg('a2', 'w1', { house: 'asher' }),
    asg('a3', 'ghost'),
  ];
  const flags = calc.firstHadrachaFlags(workers, assignments, [], TODAY);
  assert.deepStrictEqual(flags.overdue, ['שני בתים']);
});

test('future-dated start is never overdue', () => {
  const workers = [guide('w1', 'עתידי', '2026-09-01')];
  const flags = calc.firstHadrachaFlags(workers, [asg('a1', 'w1')], [], TODAY);
  assert.deepStrictEqual(flags.overdue, []);
  assert.deepStrictEqual(flags.missingStart, []);
});

test('no usable completions data (null/undefined) → NOTHING flagged, ever', () => {
  const workers = [guide('w1', 'ותיק בלי הדרכה', '2026-01-01'), guide('w2', 'בלי תאריך', '')];
  const assignments = [asg('a1', 'w1'), asg('a2', 'w2')];
  for (const completed of [null, undefined, 'junk', {}]) {
    const flags = calc.firstHadrachaFlags(workers, assignments, completed, TODAY);
    assert.deepStrictEqual(flags, { overdue: [], missingStart: [] },
      'no data must mean no banner — not "everyone is overdue"');
  }
});

// ---------------------------------------------------------------------------
// parseHadrachotStatus — the feed contract
// ---------------------------------------------------------------------------

test('parseHadrachotStatus: guides-array shape → names with firstHadrachaDone === true', () => {
  const names = calc.parseHadrachotStatus({ guides: [
    { name: 'דנה לוי', firstHadrachaDone: true },
    { name: 'יואב כהן', firstHadrachaDone: false },
    { name: 'בלי דגל' },
    { name: '', firstHadrachaDone: true },
    null,
  ] });
  assert.deepStrictEqual(names, ['דנה לוי']);
});

test('parseHadrachotStatus: completed-names shape → the names, normalized', () => {
  assert.deepStrictEqual(
    calc.parseHadrachotStatus({ completed: [' דנה  לוי ', '', 'יואב כהן'] }),
    ['דנה לוי', 'יואב כהן']);
});

test('parseHadrachotStatus: unrecognized payloads → null, never an empty list', () => {
  for (const junk of [null, undefined, 'str', 42, [], {}, { guides: 'x' }, { completed: 'x' }, { other: [] }]) {
    assert.strictEqual(calc.parseHadrachotStatus(junk), null,
      'unrecognized payload must be "no data", not "nobody completed": ' + JSON.stringify(junk));
  }
});

test('parseHadrachotStatus: an empty guides array is VALID data — an empty list, not null', () => {
  assert.deepStrictEqual(calc.parseHadrachotStatus({ guides: [] }), []);
});

// ---------------------------------------------------------------------------
// Frontend source guards (public/index.html)
// ---------------------------------------------------------------------------

test('the banner is rendered on the central dashboard', () => {
  assert.ok(/\$\{hadrachaBannerHtml\(\)\}/.test(html),
    'centralView must include the banner slot');
  assert.ok(html.includes('function hadrachaBannerHtml'), 'banner builder must exist');
});

test('status is fetched ONLY through the server proxy, never a direct URL', () => {
  assert.ok(/apiFetch\('\/api\/hadrachot-status'\)/.test(html),
    'the frontend must go through /api/hadrachot-status');
  assert.ok(!html.includes('HADRACHOT_STATUS_URL'),
    'the upstream URL must never reach the browser');
  assert.ok(!html.includes('HADRACHOT_STATUS_SECRET') && !html.includes('HADRACHOT_READ_SECRET'),
    'no hadrachot secret name may appear in the page');
});

test('fail-quiet: banner renders nothing without usable data, and boot never awaits the feed', () => {
  const fn = html.slice(html.indexOf('function hadrachaBannerHtml'),
    html.indexOf('function centralView'));
  assert.ok(/if \(!Array\.isArray\(HADRACHOT_COMPLETED\)\) return '';/.test(fn),
    'no data → empty string, before any flag math');
  const boot = html.slice(html.indexOf('async function boot'), html.indexOf('async function boot') + 700);
  assert.ok(/\n\s*loadHadrachotStatus\(\);/.test(boot),
    'boot kicks the feed off fire-and-forget');
  assert.ok(!/await loadHadrachotStatus/.test(boot),
    'a slow/unreachable feed must never delay app boot');
});

test('the Hebrew banner strings contain no parentheses', () => {
  for (const name of ['HADRACHA_BANNER_TITLE', 'HADRACHA_OVERDUE_TEXT', 'HADRACHA_MISSING_START_TEXT']) {
    const m = new RegExp(`const ${name} = '([^']*)';`).exec(html);
    assert.ok(m, `${name} must be declared as a plain string const`);
    assert.ok(!/[()]/.test(m[1]), `${name} must not contain parentheses: "${m[1]}"`);
    assert.ok(/[֐-׿]/.test(m[1]), `${name} must be Hebrew text`);
  }
});

test('the banner wording matches the 30-day all-roles rule', () => {
  const overdue = /const HADRACHA_OVERDUE_TEXT = '([^']*)';/.exec(html)[1];
  const missing = /const HADRACHA_MISSING_START_TEXT = '([^']*)';/.exec(html)[1];
  assert.ok(overdue.includes('30'), 'overdue line must state the 30-day deadline');
  assert.ok(!overdue.includes('7 ימים') && !/מ־7/.test(overdue), 'the old 7-day wording must be gone');
  for (const text of [overdue, missing]) {
    assert.ok(!text.includes('מדריכים'),
      'banner lines cover all supervision roles, not only guides: ' + text);
  }
});
