#!/usr/bin/env node
'use strict';

/*
 * import_monthly_actuals.js — import a monthly timesheet (.xlsx) into the
 * monthly_actuals tab for hourly / per_session workers.
 *
 * Auth pattern mirrors the rest of the tooling: POST /api/login with the
 * PIN → Bearer token → GET /api/data (workers + assignments) → (optionally)
 * POST /api/action { upsertMonthlyActuals }. No secrets in code — the PIN
 * and base URL come from env or flags.
 *
 * Usage:
 *   node scripts/import_monthly_actuals.js --file <xlsx> --month 2026-07 [--commit]
 *
 * Flags / env:
 *   --file   <path>     required — the .xlsx timesheet
 *   --month  YYYY-MM     required — the month the hours/sessions belong to
 *   --commit             actually write (default is a DRY RUN)
 *   --base   <url>       server base URL     (env EZONE_BASE_URL, default http://localhost:3000)
 *   --pin    <pin>       gate PIN            (env EZONE_PIN or MORAN_PIN)
 *
 * Default is a DRY RUN: it prints matched rows with computed cost
 * (rate × actual) and a clear list of unmatched / ambiguous names, and
 * writes nothing. Only --commit posts upsertMonthlyActuals.
 *
 * Expected columns (matched by header, tolerant of variants):
 *   worker name (שם / name / עובד), house (בית / house — optional),
 *   hours (שעות / hours) and/or sessions (טיפולים / מפגשים / sessions).
 */

const fs = require('fs');
const path = require('path');
const { readXlsxFirstSheet } = require('../lib/xlsx_read');
const { matchActuals, buildUpsertItems } = require('../lib/import_actuals');

// Canonical house id → Hebrew display name. Mirrors public/index.html HOUSES
// and MIGRATION.md "Houses" — keep in sync if the house set changes.
const HOUSES = [
  { id: 'ramot', name: 'בית מאזן רמות השבים' },
  { id: 'asher', name: 'איזון רעננה - אשר' },
  { id: 'ofroni', name: 'קיסריה עפרוני' },
  { id: 'rehab', name: 'קיסריה ריהאב' },
  { id: 'pardes', name: 'איזון רעננה - פרדס' },
  { id: 'sde_eliezer', name: 'שדה אליעזר' },
  { id: 'hq', name: 'מטה' },
];

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

// ---------- arg parsing ----------

function parseArgs(argv) {
  const args = { commit: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--file': args.file = argv[++i]; break;
      case '--month': args.month = argv[++i]; break;
      case '--base': args.base = argv[++i]; break;
      case '--pin': args.pin = argv[++i]; break;
      case '--commit': args.commit = true; break;
      case '--help': case '-h': args.help = true; break;
      default:
        console.error('unknown argument: ' + a);
        args.bad = true;
    }
  }
  return args;
}

function usage() {
  console.log(
    'Usage: node scripts/import_monthly_actuals.js --file <xlsx> --month YYYY-MM [--commit]\n' +
    '       [--base <url>] [--pin <pin>]   (PIN also read from EZONE_PIN / MORAN_PIN)\n' +
    '       default is a DRY RUN — pass --commit to write.');
}

function fail(msg) {
  console.error('שגיאה: ' + msg);
  process.exit(1);
}

// ---------- server I/O ----------

async function login(base, pin) {
  const resp = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: String(pin) }),
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error('login failed (' + resp.status + '): ' + (body.error || ''));
  if (!body.token) throw new Error('login returned no token');
  return body.token;
}

async function getData(base, token) {
  const resp = await fetch(base + '/api/data', {
    headers: { 'Authorization': 'Bearer ' + token },
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error('GET /api/data failed (' + resp.status + '): ' + (body.error || ''));
  return body;
}

async function postAction(base, token, payload) {
  const resp = await fetch(base + '/api/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify(payload),
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error('POST /api/action failed (' + resp.status + '): ' + (body.error || ''));
  return body;
}

// ---------- report ----------

function fmt(n) { return '₪' + Number(n || 0).toLocaleString('en-US'); }

function printReport(result, month) {
  const { matched, unmatched, ambiguous } = result;
  console.log('\n=== התאמות (matched) — חודש ' + month + ' ===');
  if (!matched.length) {
    console.log('  (אין)');
  } else {
    let total = 0;
    matched.forEach(m => {
      total += m.cost;
      const qty = m.type === 'hourly' ? m.quantity + ' ש\'' : m.quantity + ' מפגשים';
      console.log(
        '  ✓ ' + m.name + ' · ' + m.house + ' · ' + m.type +
        ' · ' + qty + ' × ' + fmt(m.rate) + ' = ' + fmt(m.cost));
    });
    console.log('  ----');
    console.log('  סה״כ עלות מחושבת: ' + fmt(total) + ' (' + matched.length + ' שיבוצים)');
  }

  if (ambiguous.length) {
    console.log('\n=== דו-משמעי (ambiguous) — לא ייכתב ===');
    ambiguous.forEach(x => console.log(
      '  ? שורה ' + x.rowNumber + ': ' + x.name +
      (x.house ? ' [' + x.house + ']' : '') + ' — ' + x.reason));
  }

  if (unmatched.length) {
    console.log('\n=== לא הותאם (unmatched) — לא ייכתב ===');
    unmatched.forEach(x => console.log(
      '  ✗ שורה ' + x.rowNumber + ': ' + x.name +
      (x.house ? ' [' + x.house + ']' : '') + ' — ' + x.reason));
  }
  console.log('');
}

// ---------- main ----------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); return; }
  if (args.bad) { usage(); process.exit(1); }
  if (!args.file) fail('חסר --file');
  if (!args.month) fail('חסר --month');
  if (!MONTH_RE.test(args.month)) fail('פורמט חודש שגוי (צריך YYYY-MM): ' + args.month);

  const base = (args.base || process.env.EZONE_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
  const pin = args.pin || process.env.EZONE_PIN || process.env.MORAN_PIN;
  if (!pin) fail('חסר PIN — הגדר/י EZONE_PIN או השתמש/י ב---pin');

  const filePath = path.resolve(args.file);
  if (!fs.existsSync(filePath)) fail('הקובץ לא נמצא: ' + filePath);

  let rows;
  try {
    rows = readXlsxFirstSheet(fs.readFileSync(filePath));
  } catch (e) {
    fail('קריאת ה-Excel נכשלה: ' + e.message);
  }
  console.log('נקראו ' + rows.length + ' שורות מ-' + path.basename(filePath));

  console.log('מתחבר/ת ל-' + base + ' …');
  let token, data;
  try {
    token = await login(base, pin);
    data = await getData(base, token);
  } catch (e) {
    fail(e.message);
  }
  const workers = Array.isArray(data.workers) ? data.workers : [];
  const assignments = Array.isArray(data.assignments) ? data.assignments : [];
  console.log('נטענו ' + workers.length + ' עובדים/ות ו-' + assignments.length + ' שיבוצים.');

  const result = matchActuals({ rows, workers, assignments, houses: HOUSES });
  if (result.error) fail(result.error);
  printReport(result, args.month);

  if (!args.commit) {
    console.log('DRY RUN — לא בוצעו שינויים. הרץ/י שוב עם --commit כדי לכתוב את ' +
      result.matched.length + ' הרשומות.');
    return;
  }

  if (!result.matched.length) {
    console.log('אין רשומות להעלאה — לא נשלח דבר.');
    return;
  }

  const items = buildUpsertItems(result.matched, args.month);
  console.log('כותב/ת ' + items.length + ' רשומות (upsertMonthlyActuals) …');
  try {
    const res = await postAction(base, token, { action: 'upsertMonthlyActuals', items });
    console.log('הצלחה: ' + (res.count != null ? res.count : items.length) + ' רשומות עודכנו/נוצרו.');
  } catch (e) {
    fail(e.message);
  }
}

main().catch(e => fail(e && e.message ? e.message : String(e)));
