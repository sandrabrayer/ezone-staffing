'use strict';
// The hearings (שימועים) feature: the hearing entity's validation (shared
// lib/validate.js + the Code.gs mirror), the ASCII↔Hebrew result label
// mapping (stored values stay ASCII, labels are UI-only), and the new tab's
// DOM — table, badges, add form — all behind the existing PIN session gate.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const { validateAction, validateHearing, HEARING_RESULT_VALUES } = require('../lib/validate');

const gs = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

// ---------------------------------------------------------------------------
// validation (lib/validate.js — the proxy rejects bad input before it can
// reach the sheet; Code.gs mirrors the same rules)
// ---------------------------------------------------------------------------

test('validateHearing: a valid hearing round-trips normalized', () => {
  const v = validateHearing({
    workerId: ' w1 ', hearingDate: '2026-08-20',
    reason: '  איחורים חוזרים  ', result: 'warning',
  });
  assert.deepEqual(v, {
    workerId: 'w1', hearingDate: '2026-08-20',
    reason: 'איחורים חוזרים', result: 'warning',
  });
});

test('validateHearing: rejects a missing worker, a bad date, and a non-enum result', () => {
  const base = { workerId: 'w1', hearingDate: '2026-08-20', reason: '', result: 'warning' };
  assert.throws(() => validateHearing({ ...base, workerId: '' }), /workerId required/);
  assert.throws(() => validateHearing({ ...base, hearingDate: '' }), /missing hearingDate/);
  assert.throws(() => validateHearing({ ...base, hearingDate: '20/08/2026' }), /bad hearingDate/);
  assert.throws(() => validateHearing({ ...base, result: '' }), /bad result/);
  assert.throws(() => validateHearing({ ...base, result: 'fired' }), /bad result/);
  // Free text can never reach the result column — even the Hebrew label.
  assert.throws(() => validateHearing({ ...base, result: 'פיטורין' }), /bad result/);
});

test('validateHearing: reason is optional free text, trimmed and capped at 500', () => {
  const empty = validateHearing({ workerId: 'w1', hearingDate: '2026-08-20', result: 'dismissal' });
  assert.equal(empty.reason, '');
  const long = validateHearing({
    workerId: 'w1', hearingDate: '2026-08-20', result: 'dismissal', reason: 'א'.repeat(600),
  });
  assert.equal(long.reason.length, 500);
});

test('validateAction: the four hearing actions dispatch with validated payloads', () => {
  assert.deepEqual(validateAction({ action: 'getHearings' }), { action: 'getHearings' });

  const add = validateAction({
    action: 'addHearing',
    hearing: { workerId: 'w1', hearingDate: '2026-08-20', reason: 'שימוע', result: 'dismissal' },
  });
  assert.equal(add.hearing.result, 'dismissal');

  const upd = validateAction({
    action: 'updateHearing', id: 'hr1',
    hearing: { workerId: 'w1', hearingDate: '2026-08-21', reason: '', result: 'warning' },
  });
  assert.equal(upd.id, 'hr1');
  assert.throws(() => validateAction({
    action: 'updateHearing',
    hearing: { workerId: 'w1', hearingDate: '2026-08-21', result: 'warning' },
  }), /missing id/);

  assert.deepEqual(validateAction({ action: 'deleteHearing', id: 'hr1' }),
    { action: 'deleteHearing', id: 'hr1' });
  assert.throws(() => validateAction({ action: 'deleteHearing' }), /missing id/);
});

// ---------------------------------------------------------------------------
// backend (apps-script/Code.gs) source guards
// ---------------------------------------------------------------------------

test('Code.gs: HEADERS_HEARINGS is the exact append-only contract, in order', () => {
  const m = /const HEADERS_HEARINGS = \[([^\]]*)\]/.exec(gs);
  assert.ok(m, 'HEADERS_HEARINGS should be declared');
  const cols = m[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert.deepEqual(cols,
    ['id', 'worker_id', 'worker_name', 'hearing_date', 'reason', 'result', 'created_at'],
    'the hearings tab is position-mapped — append-only, never reorder');
});

test('Code.gs: all four hearing actions are dispatched, defined, and validated', () => {
  for (const action of ['getHearings', 'addHearing', 'updateHearing', 'deleteHearing']) {
    assert.ok(new RegExp(`case\\s+'${action}'\\s*:`).test(gs), `doPost must dispatch ${action}`);
    assert.ok(new RegExp(`function\\s+${action}\\s*\\(`).test(gs), `${action}() must be defined`);
  }
  assert.ok(/function\s+validateHearing\s*\(/.test(gs), 'Code.gs must mirror validateHearing');
  assert.ok(/function\s+ensureHearingsSheet_\s*\(/.test(gs), 'the sheet is auto-created when missing');
  const m = /const HEARING_RESULT_VALUES = \[([^\]]*)\]/.exec(gs);
  assert.ok(m, 'HEARING_RESULT_VALUES should be declared in Code.gs');
  const vals = m[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert.deepEqual(vals, HEARING_RESULT_VALUES, 'the ASCII enum must match lib/validate.js');
});

// ---------------------------------------------------------------------------
// frontend: labels, badges, and the tab's DOM in jsdom
// ---------------------------------------------------------------------------

function buildInlinedHtml() {
  const calcSrc = fs.readFileSync(path.join(ROOT, 'lib', 'calc.js'), 'utf8');
  const inlined = html.replace(
    /<script src="\/lib\/calc\.js"><\/script>/,
    `<script>${calcSrc}</script>`,
  );
  assert.notEqual(inlined, html, 'expected the calc.js script tag');
  return inlined;
}

function loadPage() {
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => {
    if (!/^Not implemented:/.test(e.message || '')) throw e;
  });
  return new JSDOM(buildInlinedHtml(), {
    url: 'http://localhost/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
  });
}

async function authAndBoot(dom, data) {
  const payload = Object.assign({
    workers: [], assignments: [], absences: [], coverages: [], archiveV3: [],
    monthlyActuals: [], budgets: [], hearings: [],
    houses: { ramot: [], asher: [], ofroni: [], rehab: [], pardes: [], sde_eliezer: [], hq: [] },
    events: [], archive: [],
  }, data || {});
  dom.window.fetch = async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  });
  dom.window.localStorage.setItem('ezone_staff_token_v1', 'fake.token');
  await dom.window.boot();
}

const HEARINGS_FIXTURE = {
  workers: [
    { id: 'w1', name: 'אורי לוי', notes: '', shift_commitment: '', startDate: '', gmachMonth: '' },
    { id: 'w2', name: 'דנה כהן', notes: '', shift_commitment: '', startDate: '', gmachMonth: '' },
  ],
  hearings: [
    { id: 'hr1', workerId: 'w1', workerName: 'אורי לוי', hearingDate: '2026-08-10',
      reason: 'איחורים חוזרים', result: 'warning', createdAt: '2026-08-10T08:00:00.000Z' },
    { id: 'hr2', workerId: 'w2', workerName: 'דנה כהן', hearingDate: '2026-08-20',
      reason: 'היעדרות ללא הודעה', result: 'dismissal', createdAt: '2026-08-20T08:00:00.000Z' },
  ],
};

test('labels: the ASCII↔Hebrew hearing-result mapping is exactly the contract', async () => {
  const dom = loadPage();
  await new Promise(r => setTimeout(r, 50));
  // const declarations aren't window properties — assert the source contract
  // directly, then exercise the badge renderer (a hoisted function IS global).
  assert.match(html, /const HEARING_RESULT_VALUES = \['warning', 'dismissal'\]/);
  assert.match(html, /const HEARING_RESULT_LABELS = \{ warning: 'אזהרה', dismissal: 'פיטורין' \}/);
  // Badge rendering: פיטורין red (dismissal class), אזהרה amber (warning
  // class); an unknown value falls back to the warning badge, never free text.
  assert.match(dom.window.hearingResultBadge('dismissal'), /hearing-badge dismissal.*פיטורין/);
  assert.match(dom.window.hearingResultBadge('warning'), /hearing-badge warning.*אזהרה/);
  assert.match(dom.window.hearingResultBadge('junk'), /hearing-badge warning.*אזהרה/);
  dom.window.close();
});

test('hearings DOM: the שימועים tab renders the table with names, dates, reasons and badges', async () => {
  const dom = loadPage();
  await authAndBoot(dom, HEARINGS_FIXTURE);
  dom.window.go('hearings');
  const doc = dom.window.document;
  const appHtml = doc.getElementById('app').innerHTML;
  assert.ok(appHtml.includes('אורי לוי') && appHtml.includes('דנה כהן'), 'worker names shown');
  assert.ok(appHtml.includes('איחורים חוזרים'), 'free-text reason shown');
  assert.ok(appHtml.includes('10/08/2026') && appHtml.includes('20/08/2026'),
    'dates go through fmtDate (DD/MM/YYYY)');
  const badges = [...doc.querySelectorAll('.hearing-badge')];
  assert.equal(badges.length, 2);
  assert.ok(badges.some(b => b.classList.contains('dismissal') && b.textContent === 'פיטורין'));
  assert.ok(badges.some(b => b.classList.contains('warning') && b.textContent === 'אזהרה'));
  // Newest first: the dismissal (20/08) row precedes the warning (10/08) row.
  assert.ok(appHtml.indexOf('דנה כהן') < appHtml.indexOf('אורי לוי'), 'sorted by date, newest first');
  dom.window.close();
});

test('hearings DOM: the add form opens with a worker picker, date, reason and result dropdown', async () => {
  const dom = loadPage();
  await authAndBoot(dom, HEARINGS_FIXTURE);
  dom.window.go('hearings');
  dom.window.openHearing();
  const doc = dom.window.document;
  assert.ok(doc.getElementById('hearingOverlay').classList.contains('show'), 'modal opens');
  const workerOptions = [...doc.querySelectorAll('#hr_worker option')];
  assert.deepEqual(workerOptions.map(o => o.value), ['', 'w1', 'w2'],
    'worker picker lists the existing workers behind an explicit-choice blank');
  assert.equal(doc.getElementById('hr_date').type, 'date');
  assert.ok(doc.getElementById('hr_reason'), 'free-text reason field');
  const resultOptions = [...doc.querySelectorAll('#hr_result option')];
  assert.deepEqual(resultOptions.map(o => o.value), ['warning', 'dismissal'],
    'result dropdown stores ASCII values only');
  assert.deepEqual(resultOptions.map(o => o.textContent), ['אזהרה', 'פיטורין'],
    'result dropdown shows the Hebrew labels');
  dom.window.close();
});

test('hearings gate: the tab data rides the PIN-gated payload and the actions post to /api/action', () => {
  // All data arrives via loadData() → apiFetch('/api/data') (Bearer-token
  // session, 401 → PIN gate) and every mutation goes through doAction() →
  // POST /api/action behind the same requireAuth middleware — no separate
  // unauthenticated path exists for hearings.
  assert.match(html, /HEARINGS = Array\.isArray\(d\.hearings\)/,
    'hearings load from the same authenticated /api/data payload');
  for (const action of ['addHearing', 'updateHearing', 'deleteHearing']) {
    assert.ok(new RegExp(`action:\\s*'${action}'`).test(html), `frontend posts ${action} via doAction`);
  }
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(server, /app\.get\('\/api\/data', requireAuth/,
    '/api/data stays behind the session gate');
  assert.match(server, /app\.post\('\/api\/action', requireAuth/,
    '/api/action stays behind the session gate');
});

test('hearings Hebrew strings carry no parentheses', () => {
  // The tab's UI copy (view + modal) must not use parentheses — mirror of
  // the house rule guarded for the hadracha banner.
  const viewStart = html.indexOf('function hearingsView');
  const viewSrc = html.slice(viewStart, html.indexOf('function renderSwitch', viewStart));
  const hebrewStrings = viewSrc.match(/[֐-׿][^<>`'"]*/g) || [];
  for (const s of hebrewStrings) {
    assert.ok(!s.includes('(') && !s.includes(')'), `Hebrew string with parentheses: ${s}`);
  }
  const modalStart = html.indexOf('id="hearingOverlay"');
  const modalSrc = html.slice(modalStart, html.indexOf('<div class="toast"', modalStart));
  const modalHebrew = modalSrc.match(/[֐-׿][^<>`'"]*/g) || [];
  for (const s of modalHebrew) {
    assert.ok(!s.includes('(') && !s.includes(')'), `Hebrew string with parentheses: ${s}`);
  }
});
