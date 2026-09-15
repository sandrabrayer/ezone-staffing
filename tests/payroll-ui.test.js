'use strict';

// Rendering guards for the בקרת שכר tab.
//
// public/index.html is loaded in jsdom with the payroll libraries inlined, so
// the REAL view functions run against the REAL DOM. That turns the static
// checks in tests/payroll-guards.test.js into end-to-end ones: the
// no-parentheses rule is re-checked on the text actually rendered, and the
// escaping is checked by feeding a hostile name through the triage screen.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const golden = JSON.parse(read('tests', 'fixtures', 'tamhir-2026-08.json'));

// jsdom does not fetch external scripts, so every client lib is inlined —
// the same trick tests/page-load.test.js uses for calc.js.
function buildInlinedHtml() {
  let html = read('public', 'index.html');
  ['calc.js', 'payroll-parse.js', 'payroll-rules.js', 'xlsx_write.js'].forEach((file) => {
    const tag = `<script src="/lib/${file}"></script>`;
    assert.ok(html.indexOf(tag) >= 0, `expected ${tag} in public/index.html`);
    html = html.replace(tag, `<script>${read('lib', file)}</script>`);
  });
  return html;
}

function loadPage() {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => {
    if (/^Not implemented:/.test(e.message || '')) return;
    errors.push(e.message + ' ' + (e.detail ? String(e.detail.stack || e.detail) : ''));
  });
  vc.on('error', (...args) => errors.push(args.map(String).join(' ')));
  const dom = new JSDOM(buildInlinedHtml(), {
    runScripts: 'dangerously',
    virtualConsole: vc,
    url: 'https://example.invalid/',
  });
  return { dom, win: dom.window, errors };
}

// Put the page into the signed-in state and render one payroll step.
function renderPayroll(win, state) {
  win.eval(`
    document.getElementById('pinOverlay').style.display = 'none';
    document.getElementById('topbar').style.display = '';
    document.getElementById('app').style.display = '';
    Object.assign(PAYROLL, ${JSON.stringify(state)});
    view = 'payroll';
    render();
  `);
  return win.document.getElementById('app');
}

const RUN = {
  runId: 'pr_test1234', month: '2026-08', importedAt: '2026-09-01T08:00:00.000Z',
  importedBy: 'moran', fileName: 'tamhir-2026-08.pdf',
  rowCount: 2, parsedTotal: 16093.43, printedTotal: 16093.43,
  flaggedCount: 1, status: 'open',
};
const LINES = [
  {
    runId: RUN.runId, lineId: 'L001', empNumber: '33', rawName: 'רובין סופיה חן',
    matchedWorkerId: 'w1', matchStatus: 'number', dept: '001', mappedHouse: 'pardes',
    tashlumim: 8087.18, tagmulim: 0, keren: 0, pitzuim: 0, shonot: 0,
    bituach: 376.28, masMaasikim: 0, masSachar: 0, total: 8463.46,
  },
  {
    runId: RUN.runId, lineId: 'L002', empNumber: '145', rawName: 'ריף ענהאל',
    matchedWorkerId: '', matchStatus: 'unmatched', dept: '002', mappedHouse: '',
    tashlumim: 7300.95, tagmulim: 0, keren: 0, pitzuim: 0, shonot: 0,
    bituach: 329.02, masMaasikim: 0, masSachar: 0, total: 7629.97,
  },
];
const FINDINGS = [
  {
    runId: RUN.runId, lineId: 'L002', ruleId: 'R07', severity: 'critical',
    expected: 'הפרשות פנסיה לאחר 6 חודשי עבודה', actual: 'אין הפרשות כלל',
    messageHe: 'לעובד ריף ענהאל ותק של 24 חודשים ללא הפרשות פנסיה כלל',
    state: 'open', resolvedBy: '', resolvedAt: '', note: '',
  },
  {
    runId: RUN.runId, lineId: 'L002', ruleId: 'R16', severity: 'warning',
    expected: 'שיוך בית מאושר', actual: 'ממתין לאישור',
    messageHe: 'שיוך הבית של מחלקה 002 קיסריה טרם אושר',
    state: 'approved', resolvedBy: 'moran', resolvedAt: '2026-09-01T09:00:00.000Z',
    note: 'אושר מול מורן',
  },
  {
    runId: RUN.runId, lineId: '', ruleId: 'R03', severity: 'critical',
    expected: 'שורת שכר בקובץ', actual: 'אין שורה',
    messageHe: 'לעובד דנה כהן המשובץ בבית שדה אליעזר אין שורה בקובץ השכר',
    state: 'open', resolvedBy: '', resolvedAt: '', note: '',
  },
];

const triageState = (over) => Object.assign({
  step: 'triage', month: '2026-08', run: RUN,
  lines: LINES, findings: FINDINGS, previousTotals: {}, runs: [RUN],
  draft: null, error: '', filter: 'all', busy: false,
}, over || {});

// ---------------------------------------------------------------------------

test('the page still boots cleanly with the payroll libraries loaded', () => {
  const { win, errors } = loadPage();
  assert.deepStrictEqual(errors, [], 'no script error on load');
  assert.ok(win.PayrollRules, 'lib/payroll-rules.js exposes window.PayrollRules');
  assert.ok(win.PayrollParse, 'lib/payroll-parse.js exposes window.PayrollParse');
  assert.ok(win.XlsxWrite, 'lib/xlsx_write.js exposes window.XlsxWrite');
});

test('the topbar carries a בקרת שכר tab that switches the view', () => {
  const { win } = loadPage();
  renderPayroll(win, { step: 'upload' });
  const labels = [...win.document.querySelectorAll('#houseSwitch button')].map(b => b.textContent);
  assert.ok(labels.indexOf('בקרת שכר') >= 0, 'the tab is in the switch');
  assert.strictEqual(win.eval('view'), 'payroll');
});

test('the upload step offers a month, a file and the analyse button', () => {
  const { win, errors } = loadPage();
  const app = renderPayroll(win, { step: 'upload', month: '2026-08' });
  assert.strictEqual(app.querySelector('#pr_month').value, '2026-08');
  assert.strictEqual(app.querySelector('#pr_file').getAttribute('type'), 'file');
  assert.ok(/pdf/i.test(app.querySelector('#pr_file').getAttribute('accept')));
  assert.strictEqual(app.querySelector('#pr_analyze').textContent, 'ניתוח הקובץ');
  assert.deepStrictEqual(errors, []);
});

test('a FAILED reconciliation gate is shown as a refusal, with no way to save', () => {
  const { win } = loadPage();
  const app = renderPayroll(win, {
    step: 'preview',
    error: 'סכום השורות שנקראו אינו תואם את סה"כ החברה המודפס. הפרש 12.34 שקלים',
    draft: {
      fileName: 'bad.pdf', month: '2026-08', lines: [], findings: [],
      gate: {
        ok: false, parsedCount: 92, parsedTotal: 1099432.42,
        printedCount: 93, printedHeadcount: 93, printedTotal: 1107895.88,
        problems: [],
      },
    },
  });
  const text = app.textContent;
  assert.ok(text.indexOf('בדיקת ההתאמה נכשלה') >= 0, 'the gate result leads');
  assert.ok(text.indexOf('12.34') >= 0, 'and the delta is on screen');
  assert.ok(app.querySelector('.pr-gate.bad'), 'styled as a failure');
  const buttons = [...app.querySelectorAll('button')].map(b => b.textContent);
  assert.ok(buttons.indexOf('שמירת הייבוא') < 0, 'a rejected file cannot be saved');
});

test('a PASSING gate shows the counters and offers the save', () => {
  const { win } = loadPage();
  const app = renderPayroll(win, {
    step: 'preview',
    draft: {
      fileName: 'tamhir.pdf', month: '2026-08', lines: LINES, findings: FINDINGS,
      summary: { total: 2, clean: 1, warning: 0, critical: 1, findings: 3, orphanFindings: 1 },
      gate: {
        ok: true, parsedCount: 2, parsedTotal: 16093.43,
        printedHeadcount: 2, printedTotal: 16093.43, problems: [],
      },
    },
  });
  assert.ok(app.querySelector('.pr-gate.ok'));
  const counters = [...app.querySelectorAll('.pr-counter')].map(c => c.textContent);
  assert.ok(counters.some(c => c.indexOf('תקין') >= 0));
  assert.ok(counters.some(c => c.indexOf('לבדיקה') >= 0));
  assert.ok(counters.some(c => c.indexOf('חריג') >= 0));
  assert.ok([...app.querySelectorAll('button')].some(b => b.textContent === 'שמירת הייבוא'));
});

test('the triage screen shows each finding with its expected and actual value', () => {
  const { win, errors } = loadPage();
  const app = renderPayroll(win, triageState());
  assert.deepStrictEqual(errors, []);
  const cards = [...app.querySelectorAll('.pr-finding')];
  assert.ok(cards.length >= 3, 'every finding is rendered');
  const r07 = cards.find(c => c.textContent.indexOf('R07') >= 0);
  assert.ok(r07);
  assert.ok(r07.textContent.indexOf('צפוי') >= 0 && r07.textContent.indexOf('בפועל') >= 0,
    'expected and actual sit side by side');
  assert.ok(r07.textContent.indexOf('אין הפרשות כלל') >= 0);
  assert.ok(r07.classList.contains('critical'));
});

test('an OPEN finding offers אישור and דחייה; a resolved one shows its note instead', () => {
  const { win } = loadPage();
  const app = renderPayroll(win, triageState());
  const cards = [...app.querySelectorAll('.pr-finding')];
  const open = cards.find(c => c.textContent.indexOf('R07') >= 0);
  const openButtons = [...open.querySelectorAll('button')].map(b => b.textContent);
  assert.deepStrictEqual(openButtons, ['אישור', 'דחייה']);
  assert.ok(open.querySelector('button').getAttribute('onclick').indexOf("'L002','R07','approve'") >= 0);

  const resolved = cards.find(c => c.textContent.indexOf('R16') >= 0);
  assert.strictEqual(resolved.querySelectorAll('button').length, 0, 'no second decision');
  assert.ok(resolved.textContent.indexOf('אושר') >= 0);
  assert.ok(resolved.textContent.indexOf('אושר מול מורן') >= 0, 'the note is visible');
});

test('a LOCKED run offers no decisions at all', () => {
  const { win } = loadPage();
  const app = renderPayroll(win, triageState({ run: Object.assign({}, RUN, { status: 'locked' }) }));
  assert.ok(app.textContent.indexOf('נעול') >= 0);
  assert.strictEqual(app.querySelectorAll('.pr-finding-actions').length, 0);
  const lock = [...app.querySelectorAll('button')].find(b => b.textContent === 'נעילת חודש');
  assert.ok(lock.disabled, 'and the lock button stays disabled');
});

test('נעילת חודש is disabled while findings are open and enabled when none are', () => {
  const { win } = loadPage();
  const withOpen = renderPayroll(win, triageState());
  const lockA = [...withOpen.querySelectorAll('button')].find(b => b.textContent === 'נעילת חודש');
  assert.ok(lockA.disabled, 'two findings are still open');
  assert.ok(withOpen.textContent.indexOf('ממצאים פתוחים 2') >= 0, 'and the count is stated');

  const allResolved = FINDINGS.map(f => Object.assign({}, f, { state: 'approved', note: 'נבדק' }));
  const clean = renderPayroll(win, triageState({ findings: allResolved }));
  const lockB = [...clean.querySelectorAll('button')].find(b => b.textContent === 'נעילת חודש');
  assert.ok(!lockB.disabled);
  assert.ok(clean.textContent.indexOf('אין ממצאים פתוחים') >= 0);
});

test('the פנסיה panel lists every R07 and R08 row with its tenure', () => {
  const { win } = loadPage();
  const app = renderPayroll(win, triageState());
  const panel = [...app.querySelectorAll('.tablecard')]
    .find(c => c.textContent.indexOf('פנסיה') >= 0);
  assert.ok(panel, 'the pension panel is rendered');
  const head = [...panel.querySelectorAll('th')].map(th => th.textContent);
  assert.ok(head.indexOf('ותק בחודשים') >= 0);
  const body = panel.querySelector('tbody').textContent;
  assert.ok(body.indexOf('R07') >= 0);
  assert.ok(body.indexOf('ריף ענהאל') >= 0);
  // No matched worker in this fixture, so the tenure is honestly unknown
  // rather than guessed at.
  assert.ok(body.indexOf('לא ידוע') >= 0);
});

test('a run-level R03 gets its own block, since it has no line to sit on', () => {
  const { win } = loadPage();
  const app = renderPayroll(win, triageState());
  assert.ok(app.textContent.indexOf('עובדים ללא שורה בקובץ') >= 0);
  assert.ok(app.textContent.indexOf('דנה כהן') >= 0);
});

test('the default filter shows FLAGGED lines only', () => {
  const { win } = loadPage();
  const flagged = renderPayroll(win, triageState({ filter: 'flagged' }));
  const rows = [...flagged.querySelectorAll('.pr-line')];
  assert.strictEqual(rows.length, 1, 'only the line with findings');
  assert.ok(rows[0].textContent.indexOf('ריף ענהאל') >= 0);

  const all = renderPayroll(win, triageState({ filter: 'all' }));
  assert.strictEqual(all.querySelectorAll('.pr-line').length, 2);

  const clean = renderPayroll(win, triageState({ filter: 'clean' }));
  const cleanRows = [...clean.querySelectorAll('.pr-line')];
  assert.strictEqual(cleanRows.length, 1);
  assert.ok(cleanRows[0].textContent.indexOf('רובין סופיה חן') >= 0);
});

test('PAYROLL.filter defaults to flagged, so Moran reviews only what is flagged', () => {
  const { win } = loadPage();
  assert.strictEqual(win.eval('PAYROLL.filter'), 'flagged');
});

// ---------------------------------------------------------------------------
// Escaping and the no-parentheses rule, checked on the RENDERED text
// ---------------------------------------------------------------------------

test('a hostile name from the PDF is escaped, never injected', () => {
  const { win, errors } = loadPage();
  const nasty = '<img src=x onerror="window.__pwned=1">';
  const app = renderPayroll(win, triageState({
    lines: [Object.assign({}, LINES[0], { rawName: nasty })],
    findings: [],
    filter: 'all',
  }));
  assert.strictEqual(win.eval('typeof window.__pwned'), 'undefined');
  assert.strictEqual(app.querySelectorAll('img').length, 0, 'no element was created');
  assert.ok(app.textContent.indexOf(nasty) >= 0, 'it is shown as literal text');
  assert.deepStrictEqual(errors, []);
});

test('an id with a quote in it cannot break out of an onclick handler', () => {
  const { win } = loadPage();
  const app = renderPayroll(win, triageState({
    findings: [Object.assign({}, FINDINGS[0], { lineId: "L002'),alert(1),('" })],
    lines: LINES,
    filter: 'all',
  }));
  const onclicks = [...app.querySelectorAll('.pr-finding-actions button')]
    .map(b => b.getAttribute('onclick'));
  onclicks.forEach((h) => {
    assert.ok(/^payrollResolve\('[A-Za-z0-9_-]*','[A-Za-z0-9_-]*','(approve|reject)'\)$/.test(h),
      'the handler is exactly one call with three sanitised arguments: ' + h);
  });
});

test('NO PARENTHESES in the Hebrew the payroll tab actually renders', () => {
  const { win } = loadPage();
  const screens = [
    { step: 'upload', month: '2026-08' },
    {
      step: 'preview',
      error: 'סכום השורות שנקראו אינו תואם את סה"כ החברה המודפס. הפרש 12.34 שקלים',
      draft: {
        fileName: 'bad.pdf', month: '2026-08', lines: [], findings: [],
        gate: { ok: false, parsedCount: 92, parsedTotal: 1, printedHeadcount: 93, printedTotal: 2, problems: [] },
      },
    },
    triageState(),
    triageState({ filter: 'flagged' }),
    triageState({ run: Object.assign({}, RUN, { status: 'locked' }) }),
  ];
  screens.forEach((state, i) => {
    const app = renderPayroll(win, state);
    const offenders = app.textContent.split('\n')
      .map(s => s.trim())
      .filter(s => /[֐-׿]/.test(s) && /[()]/.test(s));
    assert.deepStrictEqual(offenders, [], `screen ${i} renders a parenthesis in Hebrew`);
  });
});

test('the rendered tab names no house id — only Hebrew house labels', () => {
  const { win } = loadPage();
  const app = renderPayroll(win, triageState());
  const V = require('../lib/validate');
  V.HOUSE_IDS.forEach((id) => {
    assert.ok(app.textContent.indexOf(id) < 0, `the raw house id '${id}' reached the screen`);
  });
});

// ---------------------------------------------------------------------------
// The libraries the tab depends on work inside the browser realm too
// ---------------------------------------------------------------------------

test('the real August file parses and reconciles inside the page', () => {
  const { win } = loadPage();
  const items = read('tests', 'fixtures', 'tamhir-2026-08.items.json');
  const out = win.eval(`(function(){
    const parsed = window.PayrollParse.parseTamhir(${items});
    const gate = window.PayrollParse.reconcile(parsed);
    return JSON.stringify({ rows: parsed.rows.length, ok: gate.ok, total: gate.parsedTotal });
  })()`);
  assert.deepStrictEqual(JSON.parse(out), { rows: 93, ok: true, total: 1107895.88 });
});

test('the rules run in the page and agree with the Node result', () => {
  const { win } = loadPage();
  const R = require('../lib/payroll-rules');
  const expected = R.evaluateRun({ month: '2026-08', runId: 'pr_x', rows: golden.rows, workers: [] });
  const out = win.eval(`JSON.stringify(window.PayrollRules.evaluateRun(${JSON.stringify({
    month: '2026-08', runId: 'pr_x', rows: golden.rows, workers: [],
  })}))`);
  assert.deepStrictEqual(JSON.parse(out), JSON.parse(JSON.stringify(expected)),
    'one rule engine, the same answer on both sides');
});
