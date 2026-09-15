'use strict';

// Structural guards for בקרת שכר. These are the rules that a reviewer cannot
// enforce by reading a diff, so the build enforces them:
//
//   1. NO PARENTHESES in any Hebrew string the payroll tab can render. Hebrew
//      is right to left and a parenthesis flips its direction mid-line, which
//      is exactly how "6.5 אחוז" becomes unreadable on Moran's screen.
//   2. The four new sheet headers match a PINNED array, APPEND-ONLY. The
//      sheets are position-mapped, so a reorder corrupts every stored row.
//   3. NO HOUSE ID LITERAL anywhere in the payroll subsystem except inside
//      DEPT_TO_HOUSE. One mapping, one place.
//   4. The rule catalogue, the two enum mirrors and the test coverage stay in
//      lockstep: a new rule id cannot ship without a test and without being
//      accepted by both validators.
//   5. The rules are pure: no logic in Code.gs, none in the frontend.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const rulesSrc = read('lib', 'payroll-rules.js');
const parseSrc = read('lib', 'payroll-parse.js');
const gs = read('apps-script', 'Code.gs');
const html = read('public', 'index.html');
const validateSrc = read('lib', 'validate.js');
const rulesTestSrc = read('tests', 'payroll-rules.test.js');

const R = require('../lib/payroll-rules');
const V = require('../lib/validate');

// The payroll block inside index.html, delimited by markers so this guard
// never fires on the rest of an app that predates these rules.
function payrollHtmlBlock() {
  const start = html.indexOf('/* PAYROLL-CONTROL:START');
  const end = html.indexOf('/* PAYROLL-CONTROL:END */');
  assert.ok(start >= 0, 'public/index.html must carry the PAYROLL-CONTROL:START marker');
  assert.ok(end > start, 'public/index.html must carry the PAYROLL-CONTROL:END marker');
  return html.slice(start, end);
}

const HEBREW = /[֐-׿]/;

// Every single- or double-quoted literal, and every template-literal chunk,
// that contains a Hebrew letter — reduced to the text a USER actually sees.
// A template literal in this codebase holds markup, so HTML tags and `${...}`
// interpolations are stripped first: `onclick="payrollOpenMonth()"` is code,
// not a Hebrew string, and must not be mistaken for one. What survives is the
// rendered text, which is what the no-parentheses rule is about.
function renderedText(raw) {
  return String(raw)
    .replace(/\$\{[^}]*\}/g, ' ')   // interpolations
    .replace(/<[^>]*>/g, ' ');       // tags, attributes and all
}

function hebrewStrings(src) {
  const out = [];
  const re = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const raw = m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]);
    if (!raw) continue;
    const text = renderedText(raw);
    if (HEBREW.test(text)) out.push(text.replace(/\s+/g, ' ').trim());
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. No parentheses in Hebrew UI strings
// ---------------------------------------------------------------------------

const PAREN = /[()]/;

test('no Hebrew string in lib/payroll-rules.js contains a parenthesis', () => {
  const offenders = hebrewStrings(rulesSrc).filter(s => PAREN.test(s));
  assert.deepStrictEqual(offenders, [],
    'a parenthesis flips the direction of a right-to-left line — use a dash or a space');
});

test('no Hebrew string in lib/payroll-parse.js contains a parenthesis', () => {
  assert.deepStrictEqual(hebrewStrings(parseSrc).filter(s => PAREN.test(s)), []);
});

test('no Hebrew string in the payroll block of index.html contains a parenthesis', () => {
  const block = payrollHtmlBlock();
  const offenders = hebrewStrings(block).filter(s => PAREN.test(s));
  assert.deepStrictEqual(offenders, []);
});

test('every rule message and title is Hebrew and parenthesis-free', () => {
  R.RULE_IDS.forEach((id) => {
    const rule = R.RULES[id];
    assert.ok(HEBREW.test(rule.titleHe), `${id} needs a Hebrew title`);
    assert.ok(!PAREN.test(rule.titleHe), `${id} title must have no parenthesis`);
  });
});

// The guard has to be able to FAIL, or it guards nothing.
test('the parenthesis guard actually detects a parenthesis', () => {
  const offenders = hebrewStrings("const x = 'תגמולי מעסיק (אחוז)';").filter(s => PAREN.test(s));
  assert.deepStrictEqual(offenders, ['תגמולי מעסיק (אחוז)']);
});

// ---------------------------------------------------------------------------
// 2. Sheet headers: pinned, append-only
// ---------------------------------------------------------------------------

const EXPECTED_HEADERS = {
  HEADERS_PAYROLL_RUNS: [
    'runId', 'month', 'importedAt', 'importedBy', 'fileName',
    'rowCount', 'parsedTotal', 'printedTotal', 'flaggedCount', 'status',
  ],
  HEADERS_PAYROLL_LINES: [
    'runId', 'lineId', 'empNumber', 'rawName', 'matchedWorkerId', 'matchStatus',
    'dept', 'mappedHouse',
    'tashlumim', 'tagmulim', 'keren', 'pitzuim', 'shonot', 'bituach',
    'masMaasikim', 'masSachar', 'total',
  ],
  HEADERS_PAYROLL_FINDINGS: [
    'runId', 'lineId', 'ruleId', 'severity', 'expected', 'actual', 'messageHe',
    'state', 'resolvedBy', 'resolvedAt', 'note',
  ],
  HEADERS_PAYROLL_APPROVAL_LOG: [
    'runId', 'lineId', 'action', 'actor', 'timestamp', 'note',
  ],
};

function gsStringArray(name) {
  const m = new RegExp('const ' + name + ' = \\[([\\s\\S]*?)\\];').exec(gs);
  assert.ok(m, name + ' should be declared in Code.gs');
  return m[1].split(',')
    .map(s => s.trim().replace(/\/\/.*$/, '').trim().replace(/^'|'$/g, ''))
    .filter(Boolean);
}

Object.keys(EXPECTED_HEADERS).forEach((name) => {
  test(`${name} matches the pinned array exactly, in order`, () => {
    assert.deepStrictEqual(gsStringArray(name), EXPECTED_HEADERS[name],
      'these tabs are position-mapped: append at the END, never reorder, rename or remove');
  });
});

test('every payroll sheet is created through ensureHeaders, which only fills blanks', () => {
  const start = gs.indexOf('function ensurePayrollSheets_');
  assert.ok(start >= 0);
  const fn = gs.slice(start, gs.indexOf('\n}\n', start));
  ['PAYROLL_RUNS_TAB', 'PAYROLL_LINES_TAB', 'PAYROLL_FINDINGS_TAB', 'PAYROLL_APPROVAL_LOG_TAB']
    .forEach(tab => assert.ok(fn.indexOf(tab) >= 0, `${tab} must be ensured`));
  assert.ok(fn.indexOf('ensureHeaders(') >= 0, 'headers go through the shared helper');
  assert.ok(!/deleteColumn|insertColumn|setValues\(\[\[/.test(fn),
    'creating a tab must never migrate or rewrite existing data');
});

test('the readers map every payroll column by POSITION, matching the pinned order', () => {
  // A reader that skipped an index would silently shift every later field.
  const lines = gs.slice(gs.indexOf('function readPayrollLinesSafe_'));
  EXPECTED_HEADERS.HEADERS_PAYROLL_LINES.forEach((_col, i) => {
    assert.ok(lines.indexOf('r[' + i + ']') >= 0,
      `readPayrollLinesSafe_ must read column index ${i}`);
  });
});

// ---------------------------------------------------------------------------
// 3. No house id literal outside DEPT_TO_HOUSE
// ---------------------------------------------------------------------------

const HOUSE_IDS = V.HOUSE_IDS;

function deptToHouseBlock() {
  const start = rulesSrc.indexOf('const DEPT_TO_HOUSE = {');
  assert.ok(start >= 0, 'DEPT_TO_HOUSE must exist');
  const end = rulesSrc.indexOf('};', start);
  return rulesSrc.slice(start, end + 2);
}

test('DEPT_TO_HOUSE is the ONLY place a house id appears in lib/payroll-rules.js', () => {
  const block = deptToHouseBlock();
  const rest = rulesSrc.replace(block, '');
  HOUSE_IDS.forEach((id) => {
    const quoted = new RegExp("['\"]" + id + "['\"]");
    assert.ok(!quoted.test(rest),
      `house id '${id}' must not appear outside DEPT_TO_HOUSE — the rules are house-agnostic`);
  });
});

test('no house id literal in lib/payroll-parse.js — the parser knows nothing about houses', () => {
  HOUSE_IDS.forEach((id) => {
    assert.ok(!new RegExp("['\"]" + id + "['\"]").test(parseSrc), `'${id}' leaked into the parser`);
  });
});

test('no house id literal in the payroll block of index.html', () => {
  const block = payrollHtmlBlock();
  HOUSE_IDS.forEach((id) => {
    assert.ok(!new RegExp("['\"]" + id + "['\"]").test(block),
      `'${id}' leaked into the payroll UI — render houseName(...) instead`);
  });
});

test('no house id literal in the payroll endpoints of Code.gs', () => {
  const start = gs.indexOf('// בקרת שכר — payroll control endpoints');
  assert.ok(start >= 0, 'the payroll section must be delimited by its banner comment');
  const block = gs.slice(start);
  HOUSE_IDS.forEach((id) => {
    assert.ok(!new RegExp("['\"]" + id + "['\"]").test(block),
      `'${id}' leaked into the backend — it validates through isHouse(), it never names a house`);
  });
});

test('DEPT_TO_HOUSE covers the six real departments and confirms only four', () => {
  assert.deepStrictEqual(Object.keys(R.DEPT_TO_HOUSE).sort(),
    ['001', '002', '003', '004', '005', '006']);
  assert.strictEqual(R.DEPT_TO_HOUSE['001'].house, 'pardes');
  assert.strictEqual(R.DEPT_TO_HOUSE['003'].house, 'ramot');
  assert.strictEqual(R.DEPT_TO_HOUSE['004'].house, 'hq');
  assert.strictEqual(R.DEPT_TO_HOUSE['005'].house, 'asher');
  assert.strictEqual(R.DEPT_TO_HOUSE['002'].house, null, 'קיסריה is TO BE CONFIRMED');
  assert.strictEqual(R.DEPT_TO_HOUSE['006'].house, null, 'הולינה is TO BE CONFIRMED');
});

test('every confirmed house in DEPT_TO_HOUSE is a REAL staffing house id', () => {
  Object.keys(R.DEPT_TO_HOUSE).forEach((dept) => {
    const house = R.DEPT_TO_HOUSE[dept].house;
    if (house === null) return;
    assert.ok(HOUSE_IDS.indexOf(house) >= 0, `${dept} maps to an unknown house '${house}'`);
  });
});

test('שדה אליעזר is deliberately absent from DEPT_TO_HOUSE', () => {
  const mapped = Object.keys(R.DEPT_TO_HOUSE).map(d => R.DEPT_TO_HOUSE[d].house);
  assert.ok(mapped.indexOf('sde_eliezer') < 0,
    'it has no payroll department — a worker placed there raises R03 instead');
});

// ---------------------------------------------------------------------------
// 4. The rule catalogue stays in lockstep
// ---------------------------------------------------------------------------

const EXPECTED_RULE_IDS = [
  'R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07', 'R08', 'R09',
  'R10', 'R11', 'R12', 'R13', 'R14', 'R15', 'R16', 'R17',
];

test('the rule catalogue is exactly R01..R17', () => {
  assert.deepStrictEqual(R.RULE_IDS, EXPECTED_RULE_IDS);
});

test('every rule has a stable id, a severity and a Hebrew title', () => {
  R.RULE_IDS.forEach((id) => {
    const rule = R.RULES[id];
    assert.strictEqual(rule.id, id, 'the id inside the rule must match its key');
    assert.ok(['critical', 'warning'].indexOf(rule.severity) >= 0, `${id} needs a known severity`);
    assert.ok(rule.titleHe && rule.titleHe.length > 3, `${id} needs a Hebrew title`);
  });
});

test('both validators accept exactly the catalogued rule ids', () => {
  assert.deepStrictEqual(V.PAYROLL_RULE_IDS.slice().sort(), EXPECTED_RULE_IDS);
  assert.deepStrictEqual(gsStringArray('PAYROLL_RULE_IDS').sort(), EXPECTED_RULE_IDS);
});

test('the enums are mirrored between the proxy and Apps Script', () => {
  assert.deepStrictEqual(gsStringArray('PAYROLL_MATCH_STATUSES'), V.PAYROLL_MATCH_STATUSES);
  assert.deepStrictEqual(gsStringArray('PAYROLL_SEVERITIES'), V.PAYROLL_SEVERITIES);
  assert.deepStrictEqual(gsStringArray('PAYROLL_RESOLVE_ACTIONS'), V.PAYROLL_DECISIONS);
});

test('the caps are mirrored between the proxy and Apps Script', () => {
  const gsNum = (name) => {
    const m = new RegExp('const ' + name + ' = (-?[\\d.]+);').exec(gs);
    assert.ok(m, name + ' should be declared in Code.gs');
    return Number(m[1]);
  };
  assert.strictEqual(gsNum('PAYROLL_MAX_LINES'), V.PAYROLL_MAX_LINES);
  assert.strictEqual(gsNum('PAYROLL_MAX_FINDINGS'), V.PAYROLL_MAX_FINDINGS);
  assert.strictEqual(gsNum('PAYROLL_AMOUNT_MAX'), V.PAYROLL_AMOUNT_MAX);
  assert.strictEqual(gsNum('PAYROLL_NOTE_MIN'), V.PAYROLL_NOTE_MIN);
  assert.strictEqual(gsNum('PAYROLL_NOTE_MAX'), V.PAYROLL_NOTE_MAX);
});

test('every rule id has BOTH a fail path and a pass path in the rule tests', () => {
  EXPECTED_RULE_IDS.forEach((id) => {
    // [^;] rather than [^)]: the argument is often an inline run({...}) call,
    // whose own parentheses would otherwise end the match.
    assert.ok(new RegExp("(^|[^!])fired\\([^;]{0,400}'" + id + "'").test(rulesTestSrc),
      `${id} must be asserted to fire somewhere in tests/payroll-rules.test.js`);
    assert.ok(new RegExp("!fired\\([^;]{0,400}'" + id + "'").test(rulesTestSrc),
      `${id} must also be asserted NOT to fire on a clean row`);
  });
});

// ---------------------------------------------------------------------------
// 5. The rules are pure, and they live in exactly one place
// ---------------------------------------------------------------------------

test('lib/payroll-rules.js is pure — no clock, no randomness, no I/O', () => {
  assert.ok(!/Date\.now\(|new Date\(\)|Math\.random\(/.test(rulesSrc),
    'a rule that reads the clock cannot be tested or re-run over an old month');
  assert.ok(!/require\(|fetch\(|localStorage|SpreadsheetApp/.test(rulesSrc));
});

test('lib/payroll-parse.js is pure and dependency-free', () => {
  assert.ok(!/require\(|fetch\(|SpreadsheetApp/.test(parseSrc));
});

test('no rule id and no threshold appears in Code.gs outside the enum mirror', () => {
  // Code.gs stores raw data. It validates that a ruleId is one of the known
  // ones and never decides which rule applies.
  assert.ok(gs.indexOf('PENSION_MIN_TASHLUMIM') < 0, 'a threshold in the backend is a second source of truth');
  assert.ok(gs.indexOf('TAGMULIM_MAX_PCT') < 0);
  assert.ok(gs.indexOf('DEPT_TO_HOUSE') < 0, 'the house mapping never reaches the backend');
});

test('the frontend decides nothing — it calls the rules, it does not re-implement them', () => {
  const block = payrollHtmlBlock();
  assert.ok(block.indexOf('PayrollRules.evaluateRun(') >= 0, 'the UI calls the rule engine');
  assert.ok(block.indexOf('PayrollParse.parseTamhir(') >= 0, 'and the parser');
  assert.ok(block.indexOf('PayrollParse.reconcile(') >= 0, 'and the reconciliation gate');
  EXPECTED_RULE_IDS.forEach((id) => {
    // R07 / R08 are named once, as the pension panel's filter — a list of two
    // ids, not a re-implementation. Nothing else may name a rule.
    if (id === 'R07' || id === 'R08') return;
    assert.ok(block.indexOf("'" + id + "'") < 0,
      `${id} is named in the UI — rule logic belongs in lib/payroll-rules.js`);
  });
});

test('the payroll libs are served to the browser, and the server-only libs are not', () => {
  const server = read('server.js');
  assert.ok(/CLIENT_LIBS\s*=\s*\[[^\]]*'payroll-parse\.js'/.test(server));
  assert.ok(/CLIENT_LIBS\s*=\s*\[[^\]]*'payroll-rules\.js'/.test(server));
  assert.ok(!/CLIENT_LIBS\s*=\s*\[[^\]]*'validate\.js'/.test(server), 'validate.js stays server-only');
  assert.ok(!/CLIENT_LIBS\s*=\s*\[[^\]]*'auth\.js'/.test(server), 'auth.js stays server-only');
});

test('pdfjs is served same-origin, never from a CDN', () => {
  const server = read('server.js');
  assert.ok(server.indexOf('/vendor/pdf.min.mjs') >= 0);
  const block = payrollHtmlBlock();
  assert.ok(block.indexOf("import('/vendor/pdf.min.mjs')") >= 0);
  assert.ok(!/https?:\/\//.test(block.replace(/^\s*\/\/.*$/gm, '')),
    'the payroll tab must not reach any external origin — the report stays in the browser');
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

test('the four payroll actions are dispatched by the backend and validated by the proxy', () => {
  ['importPayrollRun', 'getPayrollRun', 'resolvePayrollFinding', 'lockPayrollRun'].forEach((a) => {
    assert.ok(new RegExp("case '" + a + "':").test(gs), `${a} must have a backend dispatch case`);
    assert.ok(new RegExp("case '" + a + "':").test(validateSrc), `${a} must be validated by the proxy`);
  });
});

test('getPayrollRun is reachable through doGet, as the read endpoint', () => {
  assert.ok(/e\.parameter\.action === 'getPayrollRun'/.test(gs), 'doGet routes it');
  assert.ok(/handle\(e, function \(\) \{ return getPayrollRun\(e\.parameter\); \}\)/.test(gs),
    'and it goes through the ordinary SHARED_SECRET gate, not a new surface');
  assert.ok(read('server.js').indexOf("app.get('/api/payroll/run'") >= 0,
    'the proxy exposes it as a GET');
});

test('every payroll write is wrapped in LockService and validates before it locks', () => {
  ['importPayrollRun', 'resolvePayrollFinding', 'lockPayrollRun'].forEach((fn) => {
    const start = gs.indexOf('function ' + fn + '(');
    assert.ok(start >= 0, fn + ' must exist');
    const body = gs.slice(start, gs.indexOf('\n}\n', start));
    assert.ok(body.indexOf('LockService.getScriptLock()') >= 0, fn + ' must take the script lock');
    assert.ok(body.indexOf('lock.releaseLock()') >= 0, fn + ' must release it in a finally');
    const lockAt = body.indexOf('LockService.getScriptLock()');
    assert.ok(body.slice(0, lockAt).indexOf('payroll') >= 0 || body.slice(0, lockAt).indexOf('validate') >= 0,
      fn + ' must validate its input BEFORE taking the lock');
  });
});

test('the reconciliation gate is re-asserted server-side, not trusted from the client', () => {
  const start = gs.indexOf('function importPayrollRun(');
  const body = gs.slice(start, gs.indexOf('\n}\n', start));
  assert.ok(body.indexOf('reconciliation failed') >= 0,
    'Apps Script must refuse a run whose rows do not reproduce the printed figures');
  assert.ok(body.indexOf('printedHeadcount') >= 0 && body.indexOf('parsedTotal') >= 0);
});

test('a locked run is read-only: no resolve, no re-import of the month', () => {
  const resolve = gs.slice(gs.indexOf('function resolvePayrollFinding('));
  assert.ok(resolve.indexOf("'run is locked'") >= 0);
  const imp = gs.slice(gs.indexOf('function importPayrollRun('));
  assert.ok(imp.indexOf('is locked') >= 0);
  const lock = gs.slice(gs.indexOf('function lockPayrollRun('));
  assert.ok(lock.indexOf('cannot lock: ') >= 0, 'and locking demands zero open findings');
});

test('no secret and no URL is hardcoded anywhere in the payroll code', () => {
  [rulesSrc, parseSrc, payrollHtmlBlock()].forEach((src) => {
    assert.ok(!/SHARED_SECRET|SECRET\s*=\s*['"][^'"]/.test(src));
  });
  const start = gs.indexOf('// בקרת שכר — payroll control endpoints');
  const block = gs.slice(start);
  assert.ok(!/['"]https?:\/\//.test(block), 'the backend calls no external service for payroll');
  assert.ok(block.indexOf("getProperty('") < 0,
    'payroll adds no Script Property of its own — it rides the existing SHARED_SECRET gate');
});

// ---------------------------------------------------------------------------
// 6. The shared libraries are classic <script>s in ONE global lexical scope
// ---------------------------------------------------------------------------

// Every /lib script the page loads, plus the inline script, evaluates in the
// SAME global lexical environment. A top-level `const` declared twice is a
// hard SyntaxError that silently kills every script after it — the app boots
// with a blank payroll tab and no clue why. This caught exactly that: three
// libraries each declaring `const api`.
test('no top-level declaration collides between any two scripts the page loads', () => {
  const tags = [...html.matchAll(/<script src="\/lib\/([^"]+)"><\/script>/g)].map(m => m[1]);
  assert.ok(tags.length >= 4, 'the page loads the shared libraries as classic scripts');

  const declarationsIn = (src) => {
    const names = new Set();
    const re = /^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm;
    let m;
    while ((m = re.exec(src)) !== null) names.add(m[1]);
    return names;
  };

  const scopes = {};
  tags.forEach((file) => { scopes['lib/' + file] = declarationsIn(read('lib', file)); });
  const inline = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)]
    .map(m => m[1]).join('\n');
  scopes['index.html inline'] = declarationsIn(inline);

  const owners = {};
  Object.keys(scopes).forEach((file) => {
    scopes[file].forEach((name) => { (owners[name] = owners[name] || []).push(file); });
  });
  const collisions = Object.keys(owners)
    .filter(name => owners[name].length > 1)
    .map(name => `${name} in ${owners[name].join(' + ')}`);
  assert.deepStrictEqual(collisions, [],
    'a duplicate top-level declaration is a SyntaxError that kills the rest of the page');
});

// A literal control character makes a source file binary, and the browser
// mangles it when re-parsing the script inside a document — which turned a
// perfectly valid Node regex into "Range out of order in character class".
test('no shared library contains a literal control character', () => {
  ['payroll-parse.js', 'payroll-rules.js', 'xlsx_write.js', 'calc.js'].forEach((file) => {
    const src = read('lib', file);
    const bad = [];
    for (let i = 0; i < src.length; i++) {
      const c = src.charCodeAt(i);
      if (c < 32 && c !== 10 && c !== 9 && c !== 13) bad.push(`${file}:${i} U+${c.toString(16)}`);
    }
    assert.deepStrictEqual(bad, [], 'write \\uXXXX escapes, never the character itself');
  });
});
