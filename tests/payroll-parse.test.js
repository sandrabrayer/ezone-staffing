'use strict';

// Parser guards for בקרת שכר — lib/payroll-parse.js.
//
// The anchor is tests/fixtures/tamhir-2026-08.json: the REAL August 2026
// "תמחיר חודשי כל העובדים" report for company 026 — 93 employee rows across
// six departments, printed company total 1,107,895.88. The parser must
// reproduce those 93 rows byte for byte from the PDF token stream.
//
// Everything else here pins one quirk of that file:
//   - the 4-digit employee number glued to the reversed surname token
//   - a Latin name glued to the תשלומים amount
//   - a row with NO תשלומים value at all - employer contributions only
//   - department headers, and the subtotal / company-total lines being skipped
//   - the reconciliation gate, which must REFUSE an import that does not
//     reproduce the printed total and headcount

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const P = require('../lib/payroll-parse');

const FIXTURES = path.join(__dirname, 'fixtures');
const golden = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'tamhir-2026-08.json'), 'utf8'));
const items = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'tamhir-2026-08.items.json'), 'utf8'));

// ---------------------------------------------------------------------------
// The golden fixture
// ---------------------------------------------------------------------------

test('August 2026: parses to exactly 93 rows and 1107895.88', () => {
  const parsed = P.parseTamhir(items);
  assert.strictEqual(parsed.rows.length, 93, 'the file has 93 employee rows');
  const sum = Math.round(parsed.rows.reduce((a, r) => a + r.total, 0) * 100) / 100;
  assert.strictEqual(sum, 1107895.88, 'the parsed totals must sum to the printed company total');
  assert.strictEqual(parsed.printedTotal, 1107895.88);
  assert.strictEqual(parsed.printedHeadcount, 93);
});

test('the parser reproduces the golden fixture byte for byte', () => {
  const parsed = P.parseTamhir(items);
  assert.strictEqual(
    JSON.stringify(parsed.rows),
    JSON.stringify(golden.rows),
    'a parser change that alters ANY stored value on the real file fails here'
  );
});

test('the golden fixture itself still describes the real report', () => {
  assert.strictEqual(golden.rows.length, 93);
  assert.strictEqual(golden.printedHeadcount, 93);
  assert.strictEqual(golden.printedTotal, 1107895.88);
  const depts = [...new Set(golden.rows.map(r => r.dept))].sort();
  assert.deepStrictEqual(depts, ['001', '002', '003', '004', '005', '006']);
  const perDept = {};
  golden.rows.forEach(r => { perDept[r.dept] = (perDept[r.dept] || 0) + 1; });
  assert.deepStrictEqual(perDept,
    { '001': 11, '002': 18, '003': 21, '004': 11, '005': 22, '006': 10 },
    'the per-department headcounts printed on the report');
  // Every row's components add up to its stated total — true of the real file,
  // and the reason R17 fires on nothing in August.
  golden.rows.forEach((r) => {
    const sum = Math.round((r.tashlumim + r.tagmulim + r.keren + r.pitzuim + r.shonot +
      r.bituach + r.masMaasikim + r.masSachar) * 100) / 100;
    assert.ok(Math.abs(sum - r.total) <= 0.01, `row ${r.empNumber} must add up`);
  });
});

test('the golden fixture covers the three hard rows', () => {
  const byNumber = {};
  golden.rows.forEach(r => { byNumber[r.empNumber] = r; });
  // Latin-script name, glued to its amount in the PDF.
  assert.strictEqual(byNumber['60'].rawName, 'MAKAROV SERGEI');
  assert.strictEqual(byNumber['60'].tashlumim, 16315);
  // Employer contributions only — NO תשלומים at all.
  assert.strictEqual(byNumber['1'].tashlumim, 0);
  assert.strictEqual(byNumber['1'].tagmulim, 1872);
  assert.strictEqual(byNumber['1'].total, 3762.08);
  // The employee number glued to the reversed surname.
  assert.strictEqual(byNumber['33'].rawName, 'רובין סופיה חן');
});

test('the fixture PDF is three pages, like the printed file', () => {
  assert.strictEqual(items.length, 3);
});

// ---------------------------------------------------------------------------
// Token-level quirks
// ---------------------------------------------------------------------------

test('splitEmpNumber: the 4-digit number glued to the reversed surname', () => {
  assert.deepStrictEqual(P.splitEmpNumber('ןיבור0033'), { empNumber: '0033', rest: 'ןיבור' });
  assert.deepStrictEqual(P.splitEmpNumber('יקצוטסולאיב0182'), { empNumber: '0182', rest: 'יקצוטסולאיב' });
});

test('splitEmpNumber: a standalone number token, and a leading group', () => {
  assert.deepStrictEqual(P.splitEmpNumber('0060'), { empNumber: '0060', rest: '' });
  assert.deepStrictEqual(P.splitEmpNumber('93'), { empNumber: '93', rest: '' });
  assert.deepStrictEqual(P.splitEmpNumber('0033ןיבור'), { empNumber: '0033', rest: 'ןיבור' });
});

test('splitEmpNumber: a name with no number is left whole', () => {
  assert.deepStrictEqual(P.splitEmpNumber('ןיבור'), { empNumber: '', rest: 'ןיבור' });
});

test('normalizeEmpNumber strips the printed leading zeros', () => {
  assert.strictEqual(P.normalizeEmpNumber('0033'), '33');
  assert.strictEqual(P.normalizeEmpNumber('0001'), '1');
  assert.strictEqual(P.normalizeEmpNumber('185'), '185');
  assert.strictEqual(P.normalizeEmpNumber(''), '');
  assert.strictEqual(P.normalizeEmpNumber(null), '');
});

test('splitLatinGlue: a Latin name glued to the amount', () => {
  assert.deepStrictEqual(P.splitLatinGlue('16,315.00MAKAROV'),
    { amount: 16315, latinName: 'MAKAROV' });
  assert.deepStrictEqual(P.splitLatinGlue('16,315.00MAKAROV SERGEI'),
    { amount: 16315, latinName: 'MAKAROV SERGEI' });
  assert.deepStrictEqual(P.splitLatinGlue('8,087.18'), null, 'a plain amount is not a glue');
  assert.deepStrictEqual(P.splitLatinGlue('רובין'), null, 'Hebrew is never a Latin glue');
});

test('parseAmount: thousands separators, blanks and non-money', () => {
  assert.strictEqual(P.parseAmount('8,087.18'), 8087.18);
  assert.strictEqual(P.parseAmount('340.00'), 340);
  assert.strictEqual(P.parseAmount('1,107,895.88'), 1107895.88);
  assert.strictEqual(P.parseAmount(''), 0, 'a blank cell is zero');
  assert.strictEqual(P.parseAmount(' '), 0);
  assert.strictEqual(P.parseAmount(undefined), 0);
  assert.strictEqual(P.parseAmount('רובין'), null, 'not money at all');
});

test('bandOf maps the documented x bands, and the name zone is not a band', () => {
  assert.strictEqual(P.bandOf(32), 'total');
  assert.strictEqual(P.bandOf(82), 'masSachar');
  assert.strictEqual(P.bandOf(120), 'masMaasikim');
  assert.strictEqual(P.bandOf(182), 'bituach');
  assert.strictEqual(P.bandOf(227), 'shonot');
  assert.strictEqual(P.bandOf(264), 'pitzuim');
  assert.strictEqual(P.bandOf(302), 'keren');
  assert.strictEqual(P.bandOf(352), 'tagmulim');
  assert.strictEqual(P.bandOf(397), 'tashlumim');
  assert.strictEqual(P.bandOf(500), null, 'x beyond the bands is name text');
  assert.strictEqual(P.bandOf(77), null, 'the gaps between bands belong to nobody');
});

// ---------------------------------------------------------------------------
// Line classification
// ---------------------------------------------------------------------------

test('classify: department headers, subtotals, the company total and data', () => {
  assert.strictEqual(P.classify('מחלקה: 001 - רעננה פרדס'), 'deptHeader');
  assert.strictEqual(P.classify('מחלקה: 006 - הולינה'), 'deptHeader');
  assert.strictEqual(P.classify('11 סך למחל. רעננה פרדס'), 'subtotal');
  assert.strictEqual(P.classify('93 סה"כ לחברה'), 'companyTotal');
  assert.strictEqual(P.classify('מספר שם העובד תשלומים תגמולי מעסיק'), 'columnHeader');
  assert.strictEqual(P.classify('תמחיר חודשי כל העובדים'), 'title');
  assert.strictEqual(P.classify('רובין סופיה חן 8,087.18'), 'data');
});

test('subtotal lines and the company total never become employee rows', () => {
  const parsed = P.parseTamhir(items);
  const names = parsed.rows.map(r => r.rawName);
  assert.ok(!names.some(n => n.indexOf('סך למחל') >= 0), 'no subtotal leaked in');
  assert.ok(!names.some(n => n.indexOf('לחברה') >= 0), 'the company total did not leak in');
  assert.strictEqual(parsed.deptSubtotals.length, 6, 'six department subtotals were read and set aside');
  const subtotalSum = Math.round(parsed.deptSubtotals.reduce((a, s) => a + s.total, 0) * 100) / 100;
  assert.strictEqual(subtotalSum, 1107895.88, 'the six subtotals add up to the company total');
});

test('every parsed row carries the department header above it', () => {
  const parsed = P.parseTamhir(items);
  parsed.rows.forEach((r) => {
    assert.ok(/^\d{3}$/.test(r.dept), `row ${r.empNumber} has a 3-digit department`);
    assert.ok(r.deptName, `row ${r.empNumber} has a department name`);
  });
  assert.strictEqual(parsed.rows[0].dept, '001');
  assert.strictEqual(parsed.rows[0].deptName, 'רעננה פרדס');
  assert.strictEqual(parsed.rows[parsed.rows.length - 1].dept, '006');
  assert.strictEqual(parsed.rows[parsed.rows.length - 1].deptName, 'הולינה');
});

// ---------------------------------------------------------------------------
// Both text orientations
// ---------------------------------------------------------------------------

const X = {
  total: 32, masSachar: 82, masMaasikim: 120, bituach: 182, shonot: 227,
  pitzuim: 264, keren: 302, tagmulim: 352, tashlumim: 397,
};
const rev = (s) => s.split('').reverse().join('');

// Build a one-page document: a department header, a column header and rows.
function page(lines) {
  const out = [];
  lines.forEach((tokens, i) => {
    const y = 800 - i * 19;
    tokens.forEach(t => out.push({ str: t.str, x: t.x, y }));
  });
  return [out];
}
function nameTokens(tokens) {
  return tokens.map((t, i) => ({ str: t, x: 556 - i * 34 }));
}

test('detectReversed: visual-order Hebrew is detected and restored', () => {
  assert.strictEqual(P.detectReversed(items), true, 'the real file is visual order');
  const logical = page([nameTokens(['מחלקה:', '001', '-', 'רעננה', 'פרדס'])]);
  assert.strictEqual(P.detectReversed(logical), false);
});

test('a logical-order producer parses identically', () => {
  const doc = page([
    nameTokens(['מחלקה:', '001', '-', 'רעננה', 'פרדס']),
    nameTokens(['מספר', 'שם העובד', 'תשלומים']),
    nameTokens(['0033', 'רובין', 'סופיה', 'חן']).concat([
      { str: '8,087.18', x: X.tashlumim },
      { str: '376.28', x: X.bituach },
      { str: '8,463.46', x: X.total },
    ]),
    nameTokens(['1', 'סה"כ לחברה']).concat([{ str: '8,463.46', x: X.total }]),
  ]);
  const parsed = P.parseTamhir(doc);
  assert.strictEqual(parsed.rows.length, 1);
  assert.deepStrictEqual(parsed.rows[0], {
    empNumber: '33', rawName: 'רובין סופיה חן', dept: '001', deptName: 'רעננה פרדס',
    tashlumim: 8087.18, tagmulim: 0, keren: 0, pitzuim: 0, shonot: 0,
    bituach: 376.28, masMaasikim: 0, masSachar: 0, total: 8463.46,
  });
  assert.ok(P.reconcile(parsed).ok);
});

test('a row with NO tashlumim value is still a row', () => {
  const doc = page([
    nameTokens([rev('מחלקה:'), '003', '-', rev('רמות'), rev('השבים')]),
    nameTokens([rev('מזור') + '0001', rev('שחר')]).concat([
      // no tashlumim token at all — employer contributions only
      { str: '1,872.00', x: X.tagmulim },
      { str: '1,728.00', x: X.pitzuim },
      { str: '162.08', x: X.bituach },
      { str: '3,762.08', x: X.total },
    ]),
    nameTokens(['1', rev('סה"כ'), rev('לחברה')]).concat([{ str: '3,762.08', x: X.total }]),
  ]);
  const parsed = P.parseTamhir(doc);
  assert.strictEqual(parsed.rows.length, 1, 'the missing תשלומים column must not drop the row');
  assert.strictEqual(parsed.rows[0].tashlumim, 0);
  assert.strictEqual(parsed.rows[0].tagmulim, 1872);
  assert.strictEqual(parsed.rows[0].total, 3762.08);
  assert.strictEqual(parsed.rows[0].rawName, 'מזור שחר');
});

test('a Latin-script row: the name is recovered from the glued amount', () => {
  const doc = page([
    nameTokens([rev('מחלקה:'), '003', '-', rev('רמות'), rev('השבים')]),
    nameTokens(['0060']).concat([
      { str: '16,315.00MAKAROV SERGEI', x: X.tashlumim },
      { str: '1,001.87', x: X.bituach },
      { str: '17,316.87', x: X.total },
    ]),
    nameTokens(['1', rev('סה"כ'), rev('לחברה')]).concat([{ str: '17,316.87', x: X.total }]),
  ]);
  const parsed = P.parseTamhir(doc);
  assert.strictEqual(parsed.rows.length, 1);
  assert.strictEqual(parsed.rows[0].rawName, 'MAKAROV SERGEI');
  assert.strictEqual(parsed.rows[0].empNumber, '60');
  assert.strictEqual(parsed.rows[0].tashlumim, 16315);
});

test('items on the same printed line are grouped despite sub-pixel jitter', () => {
  const lines = P.toLines([
    { str: 'a', x: 500, y: 700 },
    { str: 'b', x: 400, y: 700.4 },
    { str: 'c', x: 300, y: 682 },
  ]);
  assert.strictEqual(lines.length, 2, 'a 0.4pt difference is the same line');
  assert.deepStrictEqual(lines[0].items.map(i => i.str), ['a', 'b'], 'sorted right to left');
  assert.deepStrictEqual(lines[1].items.map(i => i.str), ['c']);
});

// ---------------------------------------------------------------------------
// The reconciliation gate
// ---------------------------------------------------------------------------

test('the gate passes on the real file', () => {
  const gate = P.reconcile(P.parseTamhir(items));
  assert.strictEqual(gate.ok, true);
  assert.deepStrictEqual(gate.problems, []);
  assert.strictEqual(gate.parsedTotal, 1107895.88);
  assert.strictEqual(gate.parsedCount, 93);
});

test('the gate REJECTS a total mismatch and names the delta', () => {
  const parsed = P.parseTamhir(items);
  parsed.rows[0].total = Math.round((parsed.rows[0].total + 12.34) * 100) / 100;
  const gate = P.reconcile(parsed);
  assert.strictEqual(gate.ok, false);
  const problem = gate.problems.find(p => p.code === 'totalMismatch');
  assert.ok(problem, 'a total mismatch must be reported');
  assert.strictEqual(problem.expected, 1107895.88);
  assert.strictEqual(problem.delta, 12.34);
  assert.ok(problem.messageHe.indexOf('12.34') >= 0, 'the message names the delta');
});

test('the gate REJECTS a row-count mismatch and names the delta', () => {
  const parsed = P.parseTamhir(items);
  const dropped = parsed.rows.pop();
  parsed.printedTotal = Math.round((parsed.printedTotal - dropped.total) * 100) / 100;
  const gate = P.reconcile(parsed);
  assert.strictEqual(gate.ok, false);
  const problem = gate.problems.find(p => p.code === 'countMismatch');
  assert.ok(problem, 'a count mismatch must be reported');
  assert.strictEqual(problem.expected, 93);
  assert.strictEqual(problem.actual, 92);
  assert.strictEqual(problem.delta, -1);
  assert.ok(problem.messageHe.indexOf('-1') >= 0);
});

test('the gate REJECTS a file with no printed company total', () => {
  const gate = P.reconcile({ rows: golden.rows, printedTotal: null, printedHeadcount: null });
  assert.strictEqual(gate.ok, false);
  assert.deepStrictEqual(gate.problems.map(p => p.code).sort(),
    ['missingPrintedHeadcount', 'missingPrintedTotal']);
});

test('parseAndReconcile throws on a bad file and returns on a good one', () => {
  const ok = P.parseAndReconcile(items);
  assert.strictEqual(ok.gate.ok, true);
  assert.strictEqual(ok.parsed.rows.length, 93);

  const broken = page([
    nameTokens([rev('מחלקה:'), '001', '-', rev('רעננה'), rev('פרדס')]),
    nameTokens([rev('רובין') + '0033']).concat([
      { str: '8,087.18', x: X.tashlumim },
      { str: '8,463.46', x: X.total },
    ]),
    nameTokens(['5', rev('סה"כ'), rev('לחברה')]).concat([{ str: '99,999.99', x: X.total }]),
  ]);
  assert.throws(() => P.parseAndReconcile(broken), /PayrollParseError|לא תואם|אינו תואם/);
});

test('parseTamhir rejects a non-array input rather than guessing', () => {
  assert.throws(() => P.parseTamhir(null), /pages must be an array/);
  assert.throws(() => P.parseTamhir('x'), /pages must be an array/);
});
