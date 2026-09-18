'use strict';

// Phase 4 — the accessibility pass. Five things the brief names: an explicit
// label on every input, keyboard navigation, loading / empty / error states,
// an unsaved-change warning, and a save confirmation.
//
// These are asserted against the REAL page in jsdom, not against a claim in
// a document, because every one of them is the kind of thing that quietly
// regresses the next time a field is added.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM, VirtualConsole } = require('jsdom');
const { buildInlinedHtml } = require('./inline-page');

function loadPage() {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => {
    if (/^Not implemented:/.test(e.message || '')) return;
    errors.push(e.message);
  });
  const dom = new JSDOM(buildInlinedHtml(), {
    url: 'http://localhost/', runScripts: 'dangerously',
    pretendToBeVisual: true, virtualConsole: vc,
  });
  return { dom, errors };
}

function payload(over) {
  return Object.assign({
    workers: [], assignments: [], absences: [], coverages: [], archiveV3: [],
    monthlyActuals: [], budgets: [], hearings: [], feedLog: [],
    houses: { ramot: [], asher: [], ofroni: [], rehab: [], pardes: [], sde_eliezer: [], hq: [] },
    events: [], archive: [],
  }, over || {});
}

async function boot(dom, data, failWith) {
  dom.window.fetch = async () => {
    if (failWith) {
      return { ok: false, status: failWith.status, text: async () => JSON.stringify({ error: failWith.error }) };
    }
    const d = payload(data);
    return { ok: true, status: 200, text: async () => JSON.stringify(d), json: async () => d };
  };
  dom.window.localStorage.setItem('ezone_staff_token_v1', 'fake.token.value');
  await dom.window.boot();
}

function key(dom, target, k, opts) {
  const ev = new dom.window.KeyboardEvent('keydown',
    Object.assign({ key: k, bubbles: true, cancelable: true }, opts || {}));
  (target || dom.window.document).dispatchEvent(ev);
  return ev;
}

// ---------------------------------------------------------------------------
// labels
// ---------------------------------------------------------------------------

test('EVERY form control has a programmatic label', () => {
  const { dom } = loadPage();
  const doc = dom.window.document;
  const fields = [...doc.querySelectorAll('input, select, textarea')]
    .filter(f => f.type !== 'hidden');
  assert.ok(fields.length > 50, 'sanity: the page really does have many fields');

  const unlabelled = fields.filter(f => {
    if (f.id && doc.querySelector(`label[for="${f.id}"]`)) return false;
    if (f.getAttribute('aria-label')) return false;
    if (f.closest('label')) return false;
    return true;
  });
  assert.deepEqual(unlabelled.map(f => f.id || f.type), [],
    'a placeholder is not a label: it disappears the moment you type');
  dom.window.close();
});

test('every label points at a control that actually exists', () => {
  const { dom } = loadPage();
  const doc = dom.window.document;
  const dangling = [...doc.querySelectorAll('label[for]')]
    .map(l => l.getAttribute('for'))
    .filter(id => !doc.getElementById(id));
  assert.deepEqual(dangling, [], 'a label pointing at nothing is worse than none');
  dom.window.close();
});

test('the PIN field is labelled and its error is announced', () => {
  const { dom } = loadPage();
  const doc = dom.window.document;
  assert.ok(doc.querySelector('label[for="pinInput"]'), 'the PIN box has a visible label');
  const err = doc.getElementById('pinErr');
  assert.equal(err.getAttribute('role'), 'alert', 'a wrong code is announced, not only coloured');
  assert.equal(doc.getElementById('pinInput').getAttribute('aria-describedby'), 'pinErr');
  dom.window.close();
});

test('every modal announces itself as a dialog', () => {
  const { dom } = loadPage();
  const doc = dom.window.document;
  const overlays = [...doc.querySelectorAll('.overlay')];
  assert.ok(overlays.length >= 7);
  overlays.forEach(o => {
    assert.equal(o.getAttribute('role'), 'dialog', o.id + ' needs role=dialog');
    assert.equal(o.getAttribute('aria-modal'), 'true', o.id + ' needs aria-modal');
    assert.ok(o.getAttribute('aria-label'), o.id + ' needs a name');
  });
  dom.window.close();
});

// ---------------------------------------------------------------------------
// keyboard
// ---------------------------------------------------------------------------

test('Escape closes an open modal', async () => {
  const { dom } = loadPage();
  await boot(dom, {});
  const doc = dom.window.document;
  dom.window.openWorker(null, 'ramot');
  assert.ok(doc.getElementById('workerOverlay').classList.contains('show'));
  key(dom, null, 'Escape');
  assert.ok(!doc.getElementById('workerOverlay').classList.contains('show'),
    'Escape must close the dialog');
  dom.window.close();
});

test('Escape on a DIRTY form asks before discarding, and a "no" keeps it open', async () => {
  const { dom } = loadPage();
  await boot(dom, {});
  const doc = dom.window.document;
  dom.window.openWorker(null, 'ramot');
  const nameInput = doc.getElementById('w_name');
  nameInput.value = 'עובדת חדשה';
  nameInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

  const asked = [];
  dom.window.confirm = (m) => { asked.push(m); return false; };
  key(dom, null, 'Escape');
  assert.equal(asked.length, 1, 'it asked');
  assert.match(asked[0], /שינויים שלא נשמרו/);
  assert.ok(doc.getElementById('workerOverlay').classList.contains('show'),
    'a "no" must keep the typed work on screen');

  dom.window.confirm = () => true;
  key(dom, null, 'Escape');
  assert.ok(!doc.getElementById('workerOverlay').classList.contains('show'),
    'and a "yes" closes it');
  dom.window.close();
});

test('a CLEAN form closes on Escape with no question', async () => {
  const { dom } = loadPage();
  await boot(dom, {});
  const doc = dom.window.document;
  dom.window.openWorker(null, 'ramot');
  let asked = 0;
  dom.window.confirm = () => { asked++; return true; };
  key(dom, null, 'Escape');
  assert.equal(asked, 0, 'nothing was typed, so nothing is at risk');
  assert.ok(!doc.getElementById('workerOverlay').classList.contains('show'));
  dom.window.close();
});

test('a successful save clears the flag, so closing afterwards asks nothing', async () => {
  const { dom } = loadPage();
  await boot(dom, {});
  const doc = dom.window.document;
  dom.window.openWorker(null, 'ramot');
  doc.getElementById('w_name').dispatchEvent(new dom.window.Event('input', { bubbles: true }));

  dom.window.toastSaved('העובד/ת נשמר/ה');

  let asked = 0;
  dom.window.confirm = () => { asked++; return true; };
  key(dom, null, 'Escape');
  assert.equal(asked, 0, 'a save that worked must not be followed by a discard question');
  dom.window.close();
});

test('opening a fresh modal never inherits the previous one\'s dirty state', async () => {
  const { dom } = loadPage();
  await boot(dom, {});
  const doc = dom.window.document;
  dom.window.openWorker(null, 'ramot');
  doc.getElementById('w_name').dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  dom.window.confirm = () => true;
  key(dom, null, 'Escape');

  dom.window.openBudget('ramot');
  let asked = 0;
  dom.window.confirm = () => { asked++; return true; };
  key(dom, null, 'Escape');
  assert.equal(asked, 0, 'a new dialog starts clean');
  dom.window.close();
});

test('Tab is kept inside the open dialog', async () => {
  const { dom } = loadPage();
  await boot(dom, {});
  const doc = dom.window.document;
  dom.window.openWorker(null, 'ramot');
  const overlay = doc.getElementById('workerOverlay');
  const items = dom.window.focusablesIn(overlay);
  assert.ok(items.length > 2, 'the dialog has focusable content');

  items[items.length - 1].focus();
  const fwd = key(dom, doc.activeElement, 'Tab');
  assert.ok(fwd.defaultPrevented, 'Tab on the last control is intercepted');
  assert.equal(doc.activeElement, items[0], 'and wraps to the first');

  const back = key(dom, doc.activeElement, 'Tab', { shiftKey: true });
  assert.ok(back.defaultPrevented);
  assert.equal(doc.activeElement, items[items.length - 1], 'shift-Tab wraps the other way');
  dom.window.close();
});

test('Tab is NOT intercepted when no dialog is open', async () => {
  const { dom } = loadPage();
  await boot(dom, {});
  const ev = key(dom, null, 'Tab');
  assert.ok(!ev.defaultPrevented, 'ordinary page navigation must stay ordinary');
  dom.window.close();
});

test('Ctrl+Enter saves the open form, so the save button need not be tabbed to', async () => {
  const { dom } = loadPage();
  await boot(dom, {});
  const doc = dom.window.document;
  dom.window.openBudget('ramot');
  // Stub the real handler: this test is about the shortcut reaching the
  // button, not about saving. Letting saveBudget actually run would leave
  // an async POST in flight after the window is closed.
  let saved = 0;
  dom.window.saveBudget = () => { saved++; };
  const save = doc.querySelector('#budgetOverlay .modal-foot .btn-primary');
  assert.ok(save, 'the dialog has a primary save button');
  key(dom, null, 'Enter', { ctrlKey: true });
  assert.equal(saved, 1, 'Ctrl+Enter pressed the save button');
  dom.window.close();
});

test('a click on the backdrop closes, a click inside does not', async () => {
  const { dom } = loadPage();
  await boot(dom, {});
  const doc = dom.window.document;
  const overlay = doc.getElementById('workerOverlay');

  dom.window.openWorker(null, 'ramot');
  doc.getElementById('w_name').dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
  assert.ok(overlay.classList.contains('show'), 'a click on a field must not close the dialog');

  overlay.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
  assert.ok(!overlay.classList.contains('show'), 'a click on the backdrop closes it');
  dom.window.close();
});

test('there is a visible focus ring for keyboard users', () => {
  const { dom } = loadPage();
  const css = [...dom.window.document.querySelectorAll('style')]
    .map(s => s.textContent).join('\n');
  assert.match(css, /:focus-visible/, 'keyboard focus must be visible');
  assert.match(css, /outline:\s*3px solid/, 'and unmistakable against this palette');
  dom.window.close();
});

// ---------------------------------------------------------------------------
// loading / empty / error states
// ---------------------------------------------------------------------------

test('the loading state is announced, not just spun', () => {
  const { dom } = loadPage();
  const boot_ = dom.window.document.getElementById('boot');
  assert.equal(boot_.getAttribute('role'), 'status');
  assert.equal(boot_.getAttribute('aria-live'), 'polite');
  assert.match(boot_.textContent, /טוען/, 'a spinner alone says nothing to a screen reader');
  dom.window.close();
});

test('a failed load shows a PERSISTENT error with a retry, not a fading toast', async () => {
  const { dom } = loadPage();
  await boot(dom, {}, { status: 502, error: 'שגיאה בשרת. נסי שוב בעוד רגע.' });
  const doc = dom.window.document;
  const err = doc.querySelector('.load-error');
  assert.ok(err, 'a failed load must leave something on screen');
  assert.equal(err.getAttribute('role'), 'alert');
  assert.match(err.textContent, /לא ניתן לטעון את הנתונים/);
  assert.match(err.textContent, /נסי שוב/, 'and a way back without a manual refresh');
  assert.ok(err.querySelector('button'), 'the retry is a real button');
  dom.window.close();
});

test('a 401 goes back to the PIN gate rather than the error state', async () => {
  const { dom } = loadPage();
  await boot(dom, {}, { status: 401, error: 'unauthorized' });
  const doc = dom.window.document;
  assert.equal(doc.querySelector('.load-error'), null, 'an expired session is not a server error');
  assert.equal(doc.getElementById('pinOverlay').style.display, 'flex');
  dom.window.close();
});

test('the retry button re-runs the load and recovers', async () => {
  const { dom } = loadPage();
  await boot(dom, {}, { status: 502, error: 'שגיאה' });
  assert.ok(dom.window.document.querySelector('.load-error'));

  // Now let the load succeed.
  const d = payload({});
  dom.window.fetch = async () => ({
    ok: true, status: 200, text: async () => JSON.stringify(d), json: async () => d,
  });
  await dom.window.retryBoot();
  assert.equal(dom.window.document.querySelector('.load-error'), null, 'recovered');
  assert.match(dom.window.document.body.textContent, /מבט כללי/, 'and rendered the app');
  dom.window.close();
});

test('empty states are real sentences, not blank tables', async () => {
  const { dom } = loadPage();
  await boot(dom, {});
  dom.window.go('ramot');
  const doc = dom.window.document;
  const empties = [...doc.querySelectorAll('.empty, .empty-soft')];
  assert.ok(empties.length > 0, 'an empty house explains itself');
  empties.forEach(e => assert.ok(e.textContent.trim().length > 4,
    'an empty state with no words is just a gap: ' + JSON.stringify(e.textContent)));
  dom.window.close();
});

// ---------------------------------------------------------------------------
// save confirmation
// ---------------------------------------------------------------------------

test('confirmations are ANNOUNCED, not only shown', () => {
  const { dom } = loadPage();
  const t = dom.window.document.getElementById('toast');
  assert.equal(t.getAttribute('role'), 'status');
  assert.equal(t.getAttribute('aria-live'), 'polite');
  assert.equal(t.getAttribute('aria-atomic'), 'true',
    'the whole message is read, not just the characters that changed');
  dom.window.close();
});

test('a save confirmation actually reaches the toast', async () => {
  const { dom } = loadPage();
  await boot(dom, {});
  dom.window.toastSaved('התקציב נשמר');
  const t = dom.window.document.getElementById('toast');
  assert.equal(t.textContent, 'התקציב נשמר');
  assert.match(t.className, /show/);
  dom.window.close();
});

// ---------------------------------------------------------------------------
// the exports section
// ---------------------------------------------------------------------------

test('every export is reachable as a real button with Hebrew text', async () => {
  const { dom } = loadPage();
  await boot(dom, {});
  const buttons = [...dom.window.document.querySelectorAll('.export-btn')];
  assert.equal(buttons.length, dom.window.StaffingExports.REPORT_KINDS.length,
    'one button per report');
  buttons.forEach(b => {
    assert.equal(b.tagName, 'BUTTON', 'keyboard-reachable by construction');
    assert.equal(b.getAttribute('type'), 'button', 'and never submits anything');
    assert.match(b.textContent, /[֐-׿]/, 'labelled in Hebrew');
    assert.ok(!/[()]/.test(b.textContent), 'no parentheses in Hebrew UI text');
  });
  dom.window.close();
});

test('an export with no rows says so instead of downloading an empty file', async () => {
  const { dom } = loadPage();
  await boot(dom, {});
  // Nothing in the fixture, so the duplicates report has no rows.
  dom.window.downloadExport('duplicates');
  const t = dom.window.document.getElementById('toast');
  assert.match(t.textContent, /אין נתונים לדוח/);
  dom.window.close();
});

test('an export builds from the page state and reports how many rows it wrote', async () => {
  const { dom } = loadPage();
  await boot(dom, {
    workers: [
      { id: 'w1', name: 'דנה כהן', notes: '', createdAt: '', startDate: '2020-01-01', phone: '' },
      { id: 'w2', name: 'דנה כהן', notes: '', createdAt: '', startDate: '2020-01-01', phone: '' },
    ],
    assignments: [{
      id: 'a1', workerId: 'w1', house: 'ramot', role: 'מדריך/ה', roleDetail: '',
      employmentType: 'full_time', salary: 10000, pct: 100, hourlyRate: 0, estHours: 0,
      sessionRate: 0, estSessions: 0, retainerAmount: 0, notes: '',
      createdAt: '2020-01-01T00:00:00.000Z', allowance: 0, status: 'active', statusDate: '',
    }],
  });

  // Capture the download rather than performing one.
  const created = [];
  dom.window.URL.createObjectURL = () => 'blob:fake';
  dom.window.URL.revokeObjectURL = () => {};
  const origCreate = dom.window.document.createElement.bind(dom.window.document);
  dom.window.document.createElement = (tag) => {
    const el = origCreate(tag);
    if (tag === 'a') { el.click = () => created.push(el.download); }
    return el;
  };

  dom.window.downloadExport('duplicates');
  assert.deepEqual(created, ['duplicates.csv']);
  assert.match(dom.window.document.getElementById('toast').textContent, /2 שורות/,
    'both sides of the duplicate pair');
  dom.window.close();
});
