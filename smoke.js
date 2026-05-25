'use strict';
// v3 end-to-end smoke test. Hits the local Express server, which proxies
// to Apps Script + Sheet. Exercises the full worker/assignment/absence/
// coverage/archive_v3 lifecycle, including cost attribution + the
// auto-truncate-absence side effect of terminateAssignment.
//
// Prerequisites:
//   - `npm start` already running (assumes PORT from .env)
//   - The target sheet has gone through setupSheetsV3 + migrateToV3
//     (see MIGRATION.md). The v3 tabs must exist; legacy tabs are
//     ignored by these flows.
//
// Run with: node --env-file=.env smoke.js
//
// Cleanup: this script restores the sheet to ALMOST baseline. The
// terminateAssignment step writes an archive_v3 row, and that row
// references the absentee worker via workerId — so deleteWorker on the
// absentee returns 409 (FK guard). Smoke verifies the 409 fires and
// then leaves the sheet at "+1 worker, +1 archive_v3 row" vs baseline,
// matching v2 smoke's "+1 event, +1 archive" outcome.

const BASE = `http://127.0.0.1:${Number(process.env.PORT) || 3000}`;
const PIN = process.env.MORAN_PIN || '';

function log(stage, info) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${stage}`, info !== undefined ? JSON.stringify(info) : '');
}
function fail(stage, detail) {
  console.error(`[FAIL] ${stage}:`, detail);
  process.exit(1);
}

function today() { return new Date().toISOString().slice(0, 10); }
function plusDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

async function jget(path, token) {
  const r = await fetch(BASE + path, {
    headers: token ? { authorization: 'Bearer ' + token } : {},
  });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}
async function jpost(path, payload, token) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: Object.assign(
      { 'content-type': 'application/json' },
      token ? { authorization: 'Bearer ' + token } : {}
    ),
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}

// Inline per-type cost — kept independent from lib/calc.js so smoke
// catches any divergence between the calc lib and what the server
// stores. (If smoke ever stops agreeing with calc, one of them has
// a bug.)
function assignmentCostInline(a) {
  switch (a.employmentType) {
    case 'full_time':
      return Math.max(0, Math.round(Number(a.salary) || 0));
    case 'part_time': {
      const s = Math.max(0, Number(a.salary) || 0);
      const p = Math.max(0, Math.min(100, Number(a.pct) || 0));
      return Math.round(s * p / 100);
    }
    case 'hourly':
      return Math.round(Math.max(0, Number(a.hourlyRate) || 0) * Math.max(0, Number(a.estHours) || 0));
    case 'per_session':
      return Math.round(Math.max(0, Number(a.sessionRate) || 0) * Math.max(0, Number(a.estSessions) || 0));
    case 'fixed_retainer':
      return Math.max(0, Math.round(Number(a.retainerAmount) || 0));
    default:
      return 0;
  }
}
function houseAssignmentsCost(assignments, house) {
  return assignments.filter(a => a.house === house).reduce((s, a) => s + assignmentCostInline(a), 0);
}
function isAbsenceActive(ab, tsDate) {
  if (!ab || String(ab.status) === 'ended') return false;
  return ab.startDate && ab.endDate && ab.startDate <= tsDate && tsDate <= ab.endDate;
}
function coverageExtraForHouse(coverages, absences, house, tsDate) {
  return coverages.reduce((s, c) => {
    const parent = absences.find(a => a.id === c.absenceId);
    if (!parent) return s;
    if (parent.house !== house) return s;
    if (!isAbsenceActive(parent, tsDate)) return s;
    return s + (Number(c.extraPayment) || 0);
  }, 0);
}

(async () => {
  // 1. health
  {
    const r = await jget('/api/health');
    if (r.status !== 200 || !r.body.ok) fail('health', r);
    log('health ok');
  }

  // 2. login
  let token;
  {
    const r = await jpost('/api/login', { pin: PIN });
    if (r.status !== 200 || !r.body.token) fail('login', r);
    token = r.body.token;
    log('login ok', { expiresInDays: r.body.expiresInDays });
  }

  // 3. baseline. The v3 doGet returns workers/assignments/absences/
  //    coverages/archiveV3 plus legacy passthrough keys (houses/events/
  //    archive) for the transition window. We only read the v3 keys.
  let baseline;
  {
    const r = await jget('/api/data', token);
    if (r.status !== 200) fail('GET /api/data baseline', r);
    baseline = r.body;
    for (const k of ['workers', 'assignments', 'absences', 'coverages', 'archiveV3']) {
      if (!Array.isArray(baseline[k])) fail(`baseline: ${k} missing (Apps Script not redeployed or migrateToV3 not run?)`, baseline);
    }
    log('baseline', {
      workers: baseline.workers.length,
      assignments: baseline.assignments.length,
      absences: baseline.absences.length,
      coverages: baseline.coverages.length,
      archiveV3: baseline.archiveV3.length,
    });
  }

  const tag = 'SMOKE-' + Date.now();

  // 4. createWorker A — the absentee. Lives at ramot.
  let workerA;
  {
    const r = await jpost('/api/action', {
      action: 'createWorker',
      worker: { name: tag + '-A', notes: 'smoke absentee' },
    }, token);
    if (r.status !== 200 || !r.body.ok || !r.body.worker || !r.body.worker.id) fail('createWorker A', r);
    workerA = r.body.worker;
    log('createWorker A ok', { id: workerA.id, name: workerA.name });
  }

  // 5. createWorker B — the helper. Lives at asher; will cover for A.
  let workerB;
  {
    const r = await jpost('/api/action', {
      action: 'createWorker',
      worker: { name: tag + '-B', notes: 'smoke helper' },
    }, token);
    if (r.status !== 200 || !r.body.ok || !r.body.worker || !r.body.worker.id) fail('createWorker B', r);
    workerB = r.body.worker;
    log('createWorker B ok', { id: workerB.id, name: workerB.name });
  }

  // 6. addAssignment A → ramot, part_time 12000 × 80% = 9600
  const aSalary = 12000;
  const aPct = 80;
  const expectedACost = Math.round(aSalary * aPct / 100);
  let assignmentA;
  {
    const r = await jpost('/api/action', {
      action: 'addAssignment',
      assignment: {
        workerId: workerA.id, house: 'ramot',
        role: 'מטפל/ת', roleDetail: 'אמנות',
        employmentType: 'part_time', salary: aSalary, pct: aPct,
        notes: 'smoke',
      },
    }, token);
    if (r.status !== 200 || !r.body.ok || !r.body.assignment || !r.body.assignment.id) fail('addAssignment A', r);
    assignmentA = r.body.assignment;
    if (assignmentA.roleDetail !== 'אמנות') fail('addAssignment A: roleDetail not persisted', assignmentA);
    log('addAssignment A ok', { id: assignmentA.id, house: assignmentA.house, expectedCost: expectedACost });
  }

  // 7. addAssignment B → asher, full_time 15000
  const bSalary = 15000;
  let assignmentB;
  {
    const r = await jpost('/api/action', {
      action: 'addAssignment',
      assignment: {
        workerId: workerB.id, house: 'asher',
        role: 'אחות', roleDetail: '',
        employmentType: 'full_time', salary: bSalary,
        notes: 'smoke',
      },
    }, token);
    if (r.status !== 200 || !r.body.ok || !r.body.assignment) fail('addAssignment B', r);
    assignmentB = r.body.assignment;
    log('addAssignment B ok', { id: assignmentB.id, house: assignmentB.house });
  }

  // 7a. strictness guard: adding hourlyRate to a full_time assignment
  // must 400. This is the proof that v3 strictness landed end-to-end.
  {
    const r = await jpost('/api/action', {
      action: 'addAssignment',
      assignment: {
        workerId: workerB.id, house: 'ofroni',
        role: 'אחות', employmentType: 'full_time',
        salary: 1000, hourlyRate: 80,
      },
    }, token);
    if (r.status !== 400 || !/hourlyRate not allowed/.test(r.body.error || '')) {
      fail('strictness: full_time + hourlyRate should 400', r);
    }
    log('strictness ok', { error: r.body.error });
  }

  // 8. cost attribution at ramot grew by exactly assignmentCost(A).
  {
    const r = await jget('/api/data', token);
    if (r.status !== 200) fail('GET /api/data after add', r);
    const before = houseAssignmentsCost(baseline.assignments, 'ramot');
    const after = houseAssignmentsCost(r.body.assignments, 'ramot');
    if (after - before !== expectedACost) {
      fail('cost attribution after addAssignment A', { before, after, expectedDelta: expectedACost });
    }
    log('cost: ramot grew by exact assignment cost', { delta: expectedACost });
  }

  // 9. logAbsence: worker A absent from ramot, today → +7, חופשה
  const startDate = today();
  const endDate = plusDays(7);
  let absence;
  {
    const r = await jpost('/api/action', {
      action: 'logAbsence',
      absence: {
        workerId: workerA.id, house: 'ramot',
        startDate, endDate,
        reasonType: 'חופשה', reasonDetail: 'smoke vacation',
        notes: 'smoke',
      },
    }, token);
    if (r.status !== 200 || !r.body.ok || !r.body.absence || !r.body.absence.id) fail('logAbsence', r);
    absence = r.body.absence;
    if (absence.status !== 'active') fail('logAbsence: expected active status (range covers today)', absence);
    log('logAbsence ok', { id: absence.id, status: absence.status });
  }

  // 10. addCoverage: B covers for the absence; comes from asher; extra 2000.
  const extraPayment = 2000;
  let coverage;
  {
    const r = await jpost('/api/action', {
      action: 'addCoverage',
      coverage: {
        absenceId: absence.id,
        coveringWorkerId: workerB.id,
        providingHouse: 'asher',
        extraPayment,
        notes: 'smoke coverage',
      },
    }, token);
    if (r.status !== 200 || !r.body.ok || !r.body.coverage || !r.body.coverage.id) fail('addCoverage', r);
    coverage = r.body.coverage;
    log('addCoverage ok', { id: coverage.id, extra: coverage.extraPayment });
  }

  // 11. cost attribution: ramot now = baseline_ramot + A's assignment
  //     + coverage extra (accrues to absence.house=ramot). asher just
  //     has B's assignment; the coverage extra goes to ramot, not asher.
  {
    const r = await jget('/api/data', token);
    if (r.status !== 200) fail('GET /api/data after coverage', r);
    const t = today();
    const ramotAsg = houseAssignmentsCost(r.body.assignments, 'ramot');
    const ramotExtra = coverageExtraForHouse(r.body.coverages, r.body.absences, 'ramot', t);
    const ramotBase = houseAssignmentsCost(baseline.assignments, 'ramot');
    if (ramotAsg - ramotBase !== expectedACost) {
      fail('cost: ramot assignment delta wrong', { delta: ramotAsg - ramotBase, expected: expectedACost });
    }
    if (ramotExtra !== extraPayment) {
      fail('cost: ramot coverage extra wrong', { actual: ramotExtra, expected: extraPayment });
    }
    const asherAsg = houseAssignmentsCost(r.body.assignments, 'asher');
    const asherExtra = coverageExtraForHouse(r.body.coverages, r.body.absences, 'asher', t);
    const asherBase = houseAssignmentsCost(baseline.assignments, 'asher');
    if (asherAsg - asherBase !== bSalary) {
      fail('cost: asher assignment delta wrong', { delta: asherAsg - asherBase, expected: bSalary });
    }
    if (asherExtra !== 0) {
      fail('cost: asher should have zero coverage extra (coverage extras go to absence.house, not providingHouse)', { asherExtra });
    }
    log('cost attribution ok', {
      ramotAsgDelta: expectedACost, ramotExtra,
      asherAsgDelta: bSalary, asherExtra,
    });
  }

  // 12. terminateAssignment A's assignment today. Snapshots to archive_v3,
  //     removes the assignment row, auto-truncates the active absence at
  //     the same (worker, house) to end_date=today + status=ended.
  {
    const r = await jpost('/api/action', {
      action: 'terminateAssignment',
      id: assignmentA.id,
      terminationDate: today(),
      reasonType: 'התפטרות',
      reasonDetail: 'smoke termination',
    }, token);
    if (r.status !== 200 || !r.body.ok) fail('terminateAssignment', r);
    if (!r.body.archive || r.body.archive.assignmentId !== assignmentA.id) {
      fail('terminateAssignment: archive snapshot missing or wrong assignmentId', r.body);
    }
    if (r.body.autoEndedAbsences !== 1) {
      fail('terminateAssignment: expected exactly 1 auto-ended absence', r.body);
    }
    log('terminateAssignment ok', {
      archiveId: r.body.archive.id,
      autoEndedAbsences: r.body.autoEndedAbsences,
    });
  }

  // 13. verify post-terminate
  {
    const r = await jget('/api/data', token);
    if (r.status !== 200) fail('GET /api/data after terminate', r);
    const stillAssigned = r.body.assignments.find(a => a.id === assignmentA.id);
    if (stillAssigned) fail('terminate: assignment row not removed', stillAssigned);
    const archived = r.body.archiveV3.find(a => a.assignmentId === assignmentA.id);
    if (!archived) fail('terminate: archive_v3 row missing', r.body.archiveV3);
    if (archived.terminationDate !== today()) fail('terminate: wrong terminationDate', archived);
    const truncated = r.body.absences.find(a => a.id === absence.id);
    if (!truncated) fail('terminate: parent absence missing', r.body.absences);
    if (truncated.endDate !== today()) fail('terminate: absence endDate not pulled to today', truncated);
    if (truncated.status !== 'ended') fail('terminate: absence status should be ended (terminationDate=today)', truncated);
    log('verify terminate ok', {
      archived: { id: archived.id, terminationDate: archived.terminationDate },
      absence: { endDate: truncated.endDate, status: truncated.status },
    });
  }

  // 14. cost attribution post-terminate: ramot back to baseline.
  //     A's assignment is gone, and the coverage extra is 0 because its
  //     parent absence is no longer active.
  {
    const r = await jget('/api/data', token);
    const t = today();
    const ramotAsg = houseAssignmentsCost(r.body.assignments, 'ramot');
    const ramotExtra = coverageExtraForHouse(r.body.coverages, r.body.absences, 'ramot', t);
    const ramotBase = houseAssignmentsCost(baseline.assignments, 'ramot');
    if (ramotAsg !== ramotBase) {
      fail('cost: ramot assignment cost did not return to baseline post-terminate',
        { now: ramotAsg, baseline: ramotBase });
    }
    if (ramotExtra !== 0) {
      fail('cost: ramot coverage extra should be 0 after parent absence ended',
        { actual: ramotExtra });
    }
    log('cost post-terminate ok', { ramotAsg, ramotExtra });
  }

  // 15. cleanup: deleteCoverage. (Required before deleteAbsence — server
  //     rejects with 409 otherwise.)
  {
    const r = await jpost('/api/action', { action: 'deleteCoverage', id: coverage.id }, token);
    if (r.status !== 200 || !r.body.ok) fail('deleteCoverage', r);
    log('deleteCoverage ok');
  }

  // 16. deleteAbsence (FK lock released).
  {
    const r = await jpost('/api/action', { action: 'deleteAbsence', id: absence.id }, token);
    if (r.status !== 200 || !r.body.ok) fail('deleteAbsence', r);
    log('deleteAbsence ok');
  }

  // 17. deleteAssignment B + deleteWorker B (no FK refs).
  {
    let r = await jpost('/api/action', { action: 'deleteAssignment', id: assignmentB.id }, token);
    if (r.status !== 200 || !r.body.ok) fail('deleteAssignment B', r);
    log('deleteAssignment B ok');
    r = await jpost('/api/action', { action: 'deleteWorker', id: workerB.id }, token);
    if (r.status !== 200 || !r.body.ok) fail('deleteWorker B', r);
    log('deleteWorker B ok');
  }

  // 18. deleteWorker A — EXPECTED to 409 (archive_v3 still references A).
  //     This is also the FK-guard proof; if the guard misfires, smoke
  //     would surface it as a 200 here.
  {
    const r = await jpost('/api/action', { action: 'deleteWorker', id: workerA.id }, token);
    if (r.status !== 409) fail('deleteWorker A: expected 409 due to archive_v3 reference', r);
    log('deleteWorker A 409 ok (expected — archive ref)', { error: r.body.error });
  }

  // 19. final state: vs baseline, +1 worker (A) and +1 archive_v3 row.
  //     Assignments / absences / coverages all back to baseline length.
  {
    const r = await jget('/api/data', token);
    if (r.status !== 200) fail('GET /api/data final', r);
    const deltas = {
      workers:     r.body.workers.length     - baseline.workers.length,
      assignments: r.body.assignments.length - baseline.assignments.length,
      absences:    r.body.absences.length    - baseline.absences.length,
      coverages:   r.body.coverages.length   - baseline.coverages.length,
      archiveV3:   r.body.archiveV3.length   - baseline.archiveV3.length,
    };
    log('final deltas', deltas);
    if (deltas.workers !== 1)      fail('final: workers delta', deltas);
    if (deltas.assignments !== 0)  fail('final: assignments delta', deltas);
    if (deltas.absences !== 0)     fail('final: absences delta', deltas);
    if (deltas.coverages !== 0)    fail('final: coverages delta', deltas);
    if (deltas.archiveV3 !== 1)    fail('final: archiveV3 delta', deltas);
  }

  console.log('\nSMOKE TEST PASSED');
  process.exit(0);
})().catch(e => { console.error('uncaught', e); process.exit(1); });
