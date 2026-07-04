# E-ZONE Ecosystem Status — updated July 4, 2026

Add this file to the knowledge of EVERY E-Zone app Project (all six), replacing
the July 3 version, so any future chat/session starts from the true state.

## Deployment ground truth (verified July 4, 2026)

| App | Repo | Railway deploys branch |
|---|---|---|
| Outpatient | ezone-outpatient | **claude/youthful-volta-laarnk** (UNIFIED — see below) |
| Dashboard | E-Zone-Dashboard | claude/build-ezone-dashboard-QOg5s |
| Therapists | ezone-therapists | claude/inspiring-tesla-jipobw |
| Managers | ezone-managers | main |
| Staffing | ezone-staffing | main |
| Logistics | sandrabrayer-ezone-logistics | main |

⚠️ Verify the Railway-connected branch in the Railway dashboard before any work —
it is NOT stored in the repo and has been silently switched before (July 3:
outpatient was switched dashboard-hKjf9 → volta, orphaning a day of work).

## Outpatient: the two production lines are UNIFIED (July 4, PR #56)

- `claude/ezone-outpatient-dashboard-hKjf9` and `claude/youthful-volta-laarnk`
  had **no common git ancestor** (unrelated histories) and both accumulated real
  features. PR #56 merged dashboard INTO volta (`--allow-unrelated-histories`).
- **claude/youthful-volta-laarnk is now the single canonical production branch.**
  Treat `dashboard-hKjf9` as dead — do not commit there.
- Restored dashboard features now live on volta: createLead endpoint
  (fail-closed via `CREATE_LEAD_SECRET`), LockService around `_saveAll`,
  persisted paymentStatus/paymentDate/nextBillingDate, backdated payment dates,
  renewal anchored on stored nextBillingDate, card extra-charge paid/unpaid
  toggle, optimistic saves, urgency-sorted patient cards, two-panel patient-card
  redesign, סניף location dropdown/source-of-truth, frequency unit שבוע/חודש.
- **CLIENTS_HEADERS is APPEND-ONLY** (33 cols). `_readAll/_writeAll` map the
  live sheet BY POSITION and `_ensureSheet` never migrates data — NEVER reorder
  or remove mid-array columns; append only. Guard tests enforce the exact order.

## Outpatient therapist-payout subsystem (shipped July 1–4)

- "תשלומי מטפלים" tab: monthly per-therapist totals (pre-VAT / with VAT),
  detail toggle, mark-forwarded-to-payroll, Excel/CSV export (UTF-8 BOM).
- Pipeline: therapists app marks a session → posts `recordSessionOutcome`
  (secret `SESSION_OUTCOME_SECRET`, set on BOTH Apps Scripts, fail-closed) →
  outpatient writes a `SessionLog` row → payout tab reads `getSessionLog`.
- **Pay rates live in the `TherapistRates` sheet** (name / flatRate /
  intakeRate / followupRate), auto-seeded, cached 120s (edits apply ≤2 min).
  Names must EXACTLY match the therapists app's full names (e.g.
  'ד"ר מיכאל שפרינץ', 'הילה תבור'). Unknown names fail closed. ~14 newer
  therapists still have blank rates — fill before their sessions can record.
- Credit/quota engine: `creditsOwed` persisted per client, single-cell writes.
- Perf: `loadAll` is PARALLEL (Promise.all, guard-tested); session save writes
  one cell, not the whole Clients sheet.
- Deferred: "+ הוסף סשן חסר"/"תיקון סשן" correction modal; historical backfill
  of sessions recorded before the pipeline existed.

## Managers bonus overhaul shipped July 4, 2026 (PRs #5, #7)

- ALL bonus math now lives ONLY in the frontend (`lib/bonus-eligibility.js`);
  the Apps Script backend's bonus fields (qualifies, lockedIn, projectedBonus,
  quarterly*) are ignored everywhere — backend supplies raw data only
  (avgDaily, treatmentDays, treatmentDaysSoFar, manager names). This ended the
  recurring two-systems-out-of-sync bug. Pending: strip the dead bonus code
  from the live "ezone dashboard" Apps Script.
- Model: tier by average daily occupancy — Ramot 17/19/20, Ra'anana 10/12/14,
  Efroni & Rehab 10/12/13 → 2,000/2,500/3,500₪. Treatment-days gate is FIXED
  per house: threshold × 30 (Ramot 510, others 300), independent of month
  length and tier.
- Settled previous-month bonus ("בונוס לתשלום") is the headline: trophy
  winners banner (house + manager + amount), per-card rows, KPI total —
  computed on the 1st for the finished month.
- Quarterly 5,000₪ computed locally: windows anchored May 2026 (May–Jul,
  Aug–Oct…), each finished month's settled bonus must be ≥2,000₪; first
  possible payout end of July 2026. Frontend fetches each finished window
  month via `managersOverview&month=YYYY-MM`.
- Day counts run from the 1st (never front-dated); readability pass
  (text-mute 0.72, small fonts 12–13px). Tests: 36 via `node --test`.
- Efroni house-id checked: data-entry app and backend both use 'arfoni'
  consistently — no mismatch.

## Apps Script topology (July 4)

- Outpatient Apps Script: **ONE active deployment** (URL ending FOwWYIw/exec);
  two accidental extra deployments created July 4 were archived. All three
  consumers point at it: outpatient `SHEETS_URL`, therapists
  `OUTPATIENT_SHEETS_URL`, dashboard `OUTPATIENT_LEAD_URL`.
- Dashboard backend: ONE Apps Script serves Dashboard (SHEETS_URL), Managers
  (APPS_SCRIPT_URL), Therapists (DASHBOARD_SHEETS_URL) — rotate together.
- Secrets (Script Properties, never in code): SESSION_OUTCOME_SECRET (new,
  both outpatient+therapists), CREATE_LEAD_SECRET (outpatient — set it to
  enable Dashboard→Outpatient lead handoff), DEBT_STATUS_SECRET,
  TREATMENT_PLANS_SECRET, OCCUPANCY_SECRET, OUTPATIENT_LEAD_SECRET,
  WINBACK_SOURCE_SECRET, APP_PIN (Railway).

## Known pitfalls (hard-won, extended July 4)

- Apps Script NEVER auto-syncs from GitHub: paste Code.gs → Save → deploy a NEW
  VERSION of the EXISTING deployment. Wrong choices seen this week: new
  deployment (URL changes, consumers break) and access flipped off "Anyone"
  (consumers get Google's HTML page → "Non-JSON from Apps Script").
- GitHub web editor nests paths when creating files inside a folder — type only
  the filename when already in the folder. Browser re-downloads add " (N)"
  suffixes — drag FOLDERS to the upload page, not loose files.
- Claude Code opens PRs against the repo DEFAULT branch — always verify PR base
  = the deployed branch. PRs #33/#55 were closed for this; #56 was correct.
- Railway variable changes apply only to deployments started after saving.
- PIN inputs have maxlength (Outpatient 6, Dashboard 6) — keep APP_PIN within.

## Next tracks (in priority order)

1. **Outpatient housekeeping**: set GitHub default branch = volta; delete stale
   claude/* branches (incl. dashboard-hKjf9 after a grace period); fill the
   blank TherapistRates rows; review `matchStatus:"no_match"` SessionLog rows.
2. **Outpatient mobile/PWA** ("the phone option"): manifest + service worker +
   letter-E green icons + mobile CSS pass — same recipe as therapists.
3. **Therapists carryovers**: `_cancelFutureBookings` on patient delete (verify
   deployed); live end-to-end quota test (Yarden→Vered); plan-change history.
4. **Logistics**: mobile-responsive, then hardening (חירום auto-approval,
   LockService, deferral wake-up).
5. **Managers + Logistics auth** to the ezone-staffing standard.
6. **Design tokens** across apps; then feature tracks (plan-compliance,
   occupancy forecast, debt aging). Managers bonus distance-to-target: shipped
   July 4.
7. **Dashboard Apps Script cleanup**: strip dead bonus logic (frontend now
   ignores it); keep raw-data endpoints only.
