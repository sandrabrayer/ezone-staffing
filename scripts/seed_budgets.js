#!/usr/bin/env node
'use strict';

/*
 * seed_budgets.js — seed the per-house monthly budgets (total + instructors)
 * into the budgets tab via the setBudget action.
 *
 * Auth pattern mirrors scripts/import_monthly_actuals.js: POST /api/login with
 * the PIN -> Bearer token -> POST /api/action { setBudget } per house. No
 * secrets in code — the PIN and base URL come from env or flags.
 *
 * Usage:
 *   node scripts/seed_budgets.js [--month default] [--commit]
 *
 * Flags / env:
 *   --month  <default|YYYY-MM>  which budget month to seed (default: 'default',
 *                               the fallback used for every month without a
 *                               specific override)
 *   --commit                    actually write (default is a DRY RUN)
 *   --base   <url>              server base URL (env EZONE_BASE_URL, default
 *                               http://localhost:3000)
 *   --pin    <pin>              gate PIN (env EZONE_PIN or MORAN_PIN)
 *
 * Default is a DRY RUN: it prints the budgets it WOULD seed (total +
 * instructors + the instructors share of total) and writes nothing. Only
 * --commit posts setBudget.
 *
 * Houses without a budget in the seed table (pardes / sde_eliezer / hq) are
 * intentionally skipped — they have no total and no instructors line.
 */

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

// The seed table. total = house TOTAL monthly budget; instructors = the
// מדריך/ה sub-line. Houses not listed here are seeded with nothing.
const SEED = [
  { house: 'ramot',  total: 228109, instructors: 72744 },
  { house: 'asher',  total: 190476, instructors: 60620 },
  { house: 'ofroni', total: 186779, instructors: 60620 },
  { house: 'rehab',  total: 166430, instructors: 60620 },
  // pardes / sde_eliezer / hq: no budget seeded.
];

// ---------- arg parsing ----------

function parseArgs(argv) {
  const args = { commit: false, month: 'default' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
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
    'Usage: node scripts/seed_budgets.js [--month default|YYYY-MM] [--commit]\n' +
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

function pct(part, whole) {
  if (!whole) return '—';
  return (Math.round((part / whole) * 1000) / 10) + '%';
}

function printPlan(month) {
  console.log('\n=== תקציבים לזריעה — חודש ' + month + ' ===');
  SEED.forEach(s => {
    console.log(
      '  ' + s.house.padEnd(12) +
      ' כולל ' + fmt(s.total) +
      ' · מדריכים ' + fmt(s.instructors) +
      ' (' + pct(s.instructors, s.total) + ' מהכולל)');
  });
  console.log('  ----');
  console.log('  ' + SEED.length + ' בתים · pardes / sde_eliezer / hq — ללא תקציב');
  console.log('');
}

// ---------- main ----------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); return; }
  if (args.bad) { usage(); process.exit(1); }
  if (args.month !== 'default' && !MONTH_RE.test(args.month)) {
    fail('פורמט חודש שגוי (צריך default או YYYY-MM): ' + args.month);
  }

  printPlan(args.month);

  if (!args.commit) {
    console.log('DRY RUN — לא בוצעו שינויים. הרץ/י שוב עם --commit כדי לכתוב את ' +
      SEED.length + ' התקציבים.');
    return;
  }

  const base = (args.base || process.env.EZONE_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
  const pin = args.pin || process.env.EZONE_PIN || process.env.MORAN_PIN;
  if (!pin) fail('חסר PIN — הגדר/י EZONE_PIN או השתמש/י ב---pin');

  console.log('מתחבר/ת ל-' + base + ' …');
  let token;
  try {
    token = await login(base, pin);
  } catch (e) {
    fail(e.message);
  }

  let ok = 0;
  for (const s of SEED) {
    const budget = {
      house: s.house,
      month: args.month,
      amount: s.total,
      instructorsAmount: s.instructors,
    };
    try {
      const res = await postAction(base, token, { action: 'setBudget', budget });
      const verb = res && res.updated ? 'עודכן' : 'נוצר';
      console.log('  ✓ ' + s.house + ' — ' + verb + ' (' + fmt(s.total) +
        ' · מדריכים ' + fmt(s.instructors) + ')');
      ok++;
    } catch (e) {
      console.error('  ✗ ' + s.house + ' — נכשל: ' + e.message);
    }
  }
  console.log('\nהסתיים: ' + ok + '/' + SEED.length + ' תקציבים נכתבו.');
  if (ok < SEED.length) process.exit(1);
}

main().catch(e => fail(e && e.message ? e.message : String(e)));
