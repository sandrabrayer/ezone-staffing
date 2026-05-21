'use strict';
// E2E smoke test: hits the local Express server, which proxies to Apps Script + Sheet.
// Run with: node --env-file=.env smoke.js
// Assumes the server is already running on PORT (default 3000) with the same .env.

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

  // 3. baseline
  let baseline;
  {
    const r = await jget('/api/data', token);
    if (r.status !== 200) fail('GET /api/data baseline', r);
    baseline = r.body;
    if (!Array.isArray(baseline.events)) fail('baseline: events missing', baseline);
    const counts = Object.fromEntries(Object.entries(baseline.houses).map(([h, arr]) => [h, arr.length]));
    log('baseline', {
      houseCounts: counts,
      events: baseline.events.length,
      activeEvents: baseline.events.filter(e => e.status === 'active').length,
    });
  }

  // 4. add employee to ramot
  const empName = 'SMOKE-' + Date.now();
  const empSalary = 12000;
  const empPct = 80;
  const expectedBase = Math.round(empSalary * empPct / 100); // 9600
  let empId;
  {
    const r = await jpost('/api/action', {
      action: 'addEmployee',
      house: 'ramot',
      employee: {
        name: empName,
        role: 'מטפל/ת',
        roleDetail: 'אמנות',
        salary: empSalary,
        pct: empPct,
        notes: 'smoke',
      },
    }, token);
    if (r.status !== 200 || !r.body.ok || !r.body.employee || !r.body.employee.id) fail('addEmployee', r);
    empId = r.body.employee.id;
    if (r.body.employee.roleDetail !== 'אמנות') fail('addEmployee: roleDetail not persisted', r.body);
    log('addEmployee ok', { id: empId, role: r.body.employee.role, roleDetail: r.body.employee.roleDetail });
  }

  // 5. verify employee in ramot
  {
    const r = await jget('/api/data', token);
    if (r.status !== 200) fail('GET /api/data after add', r);
    const found = r.body.houses.ramot.find(e => e.id === empId);
    if (!found) fail('verify add: not in ramot', r.body.houses.ramot);
    if (found.role !== 'מטפל/ת') fail('verify add: role mismatch', found);
    log('verify add ok', { id: empId });
  }

  // 6. start coverage event: ramot → asher
  const bonus = 2000;
  const startDate = today();
  const endDate = plusDays(7);
  let eventId;
  {
    const r = await jpost('/api/action', {
      action: 'startCoverage',
      employeeId: empId,
      homeHouse: 'ramot',
      hostHouse: 'asher',
      startDate,
      endDate,
      reasonType: 'חופשה',
      reasonDetail: 'smoke test coverage',
      bonusAmount: bonus,
    }, token);
    if (r.status !== 200 || !r.body.ok || !r.body.event || !r.body.event.id) fail('startCoverage', r);
    eventId = r.body.event.id;
    if (r.body.event.status !== 'active') fail('startCoverage: expected active status', r.body.event);
    log('startCoverage ok', { eventId, hostHouse: r.body.event.hostHouse, bonus: r.body.event.bonusAmount });
  }

  // 7. verify: employee still in ramot (NOT moved), event is active in asher, bonus is set
  {
    const r = await jget('/api/data', token);
    if (r.status !== 200) fail('GET /api/data after startCoverage', r);
    const inRamot = r.body.houses.ramot.find(e => e.id === empId);
    const inAsher = r.body.houses.asher.find(e => e.id === empId);
    if (!inRamot) fail('verify start: employee should still be in ramot', r.body.houses.ramot);
    if (inAsher) fail('verify start: employee should NOT be in asher (old move model)', inAsher);

    const ev = r.body.events.find(e => e.id === eventId);
    if (!ev) fail('verify start: event missing from /api/data', r.body.events);
    if (ev.status !== 'active') fail('verify start: event not active', ev);
    if (ev.hostHouse !== 'asher') fail('verify start: hostHouse wrong', ev);
    if (Number(ev.bonusAmount) !== bonus) fail('verify start: bonus mismatch', ev);
    if (ev.employeeId !== empId) fail('verify start: employeeId mismatch', ev);
    log('verify start ok', { eventStatus: ev.status, bonus: ev.bonusAmount });
  }

  // 8. cost attribution sanity check: compute homeCost(ramot) before & after — must be unchanged.
  //    The base salary attributes to home regardless of coverage status.
  {
    const r = await jget('/api/data', token);
    const ramotRoster = r.body.houses.ramot;
    const homeCost = ramotRoster.reduce(
      (s, e) => s + Math.round((Number(e.salary) || 0) * (Number(e.pct) || 0) / 100),
      0,
    );
    const baselineRamotCost = baseline.houses.ramot.reduce(
      (s, e) => s + Math.round((Number(e.salary) || 0) * (Number(e.pct) || 0) / 100),
      0,
    );
    if (homeCost - baselineRamotCost !== expectedBase) {
      fail('cost attribution: ramot home cost did not grow by exactly the new employee base',
        { baseline: baselineRamotCost, now: homeCost, expectedDelta: expectedBase });
    }
    log('cost attribution ok', { ramotHomeCostDelta: expectedBase });
  }

  // 9. end the coverage event
  {
    const r = await jpost('/api/action', {
      action: 'endCoverage',
      eventId,
    }, token);
    if (r.status !== 200 || !r.body.ok) fail('endCoverage', r);
    if (r.body.status !== 'ended') fail('endCoverage: expected ended status', r.body);
    log('endCoverage ok', { eventId, endDate: r.body.endDate });
  }

  // 10. verify event moved to ended
  {
    const r = await jget('/api/data', token);
    const ev = r.body.events.find(e => e.id === eventId);
    if (!ev) fail('verify end: event missing', r.body.events);
    if (ev.status !== 'ended') fail('verify end: status not ended', ev);
    log('verify end ok', { status: ev.status, endDate: ev.endDate });
  }

  // 11. cleanup — delete employee
  {
    const r = await jpost('/api/action', {
      action: 'deleteEmployee',
      house: 'ramot',
      id: empId,
    }, token);
    if (r.status !== 200 || !r.body.ok) fail('deleteEmployee', r);
    log('deleteEmployee ok');
  }

  // 12. final verification — houses back to baseline; events length grew by 1 (append-only).
  {
    const r = await jget('/api/data', token);
    if (r.status !== 200) fail('GET /api/data final', r);
    const stillThere =
      r.body.houses.ramot.find(e => e.id === empId) ||
      r.body.houses.asher.find(e => e.id === empId) ||
      r.body.houses.ofroni.find(e => e.id === empId) ||
      r.body.houses.rehab.find(e => e.id === empId);
    if (stillThere) fail('cleanup: employee still present', stillThere);
    const counts = Object.fromEntries(Object.entries(r.body.houses).map(([h, arr]) => [h, arr.length]));
    const baseCounts = Object.fromEntries(Object.entries(baseline.houses).map(([h, arr]) => [h, arr.length]));
    for (const h of ['ramot', 'asher', 'ofroni', 'rehab']) {
      if (counts[h] !== baseCounts[h]) fail(`cleanup: ${h} count drifted`, { before: baseCounts[h], after: counts[h] });
    }
    const eventsDelta = r.body.events.length - baseline.events.length;
    log('final state ok', { houseCounts: counts, eventsDelta });
    if (eventsDelta !== 1) {
      console.warn('[warn] events delta is', eventsDelta, '— expected exactly 1');
    }
  }

  console.log('\nSMOKE TEST PASSED');
  process.exit(0);
})().catch(e => { console.error('uncaught', e); process.exit(1); });
