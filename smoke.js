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

  // 3. baseline data
  let baseline;
  {
    const r = await jget('/api/data', token);
    if (r.status !== 200) fail('GET /api/data baseline', r);
    baseline = r.body;
    const counts = Object.fromEntries(Object.entries(baseline.houses).map(([h, arr]) => [h, arr.length]));
    log('baseline', { houseCounts: counts, historyRows: baseline.history.length });
  }

  // 4. add employee to ramot
  const empName = 'SMOKE-TEST-' + Date.now();
  let empId;
  {
    const r = await jpost('/api/action', {
      action: 'addEmployee',
      house: 'ramot',
      employee: { name: empName, role: 'בודק', salary: 9000, pct: 80, notes: 'smoke' },
    }, token);
    if (r.status !== 200 || !r.body.ok || !r.body.employee || !r.body.employee.id) fail('addEmployee', r);
    empId = r.body.employee.id;
    log('addEmployee ok', { id: empId, name: empName });
  }

  // 5. verify employee shows up
  {
    const r = await jget('/api/data', token);
    if (r.status !== 200) fail('GET /api/data after add', r);
    const found = r.body.houses.ramot.find(e => e.id === empId);
    if (!found) fail('verify add: not in ramot', r.body.houses.ramot);
    if (found.name !== empName) fail('verify add: name mismatch', found);
    log('verify add ok', { house: 'ramot', id: empId });
  }

  // 6. move ramot -> asher
  {
    const r = await jpost('/api/action', {
      action: 'moveEmployee',
      fromHouse: 'ramot',
      toHouse: 'asher',
      id: empId,
      reasonType: 'צורך תפעולי',
      reason: 'smoke test move',
      date: '2026-05-20',
    }, token);
    if (r.status !== 200 || !r.body.ok) fail('moveEmployee', r);
    log('moveEmployee ok', r.body.moved);
  }

  // 7. verify history row appears + employee in asher, not in ramot
  {
    const r = await jget('/api/data', token);
    if (r.status !== 200) fail('GET /api/data after move', r);
    const inAsher = r.body.houses.asher.find(e => e.id === empId);
    const inRamot = r.body.houses.ramot.find(e => e.id === empId);
    if (!inAsher) fail('verify move: not in asher', r.body.houses.asher);
    if (inRamot) fail('verify move: still in ramot', inRamot);
    const newHistory = r.body.history.filter(h => h.name === empName);
    if (newHistory.length !== 1) fail('verify move: history row missing', { count: newHistory.length, all: r.body.history.slice(-3) });
    const h = newHistory[0];
    if (h.from !== 'ramot' || h.to !== 'asher' || h.reasonType !== 'צורך תפעולי') fail('verify move: history fields wrong', h);
    log('verify move ok', { historyRow: h });
  }

  // 8. clean up — delete employee from asher
  {
    const r = await jpost('/api/action', {
      action: 'deleteEmployee',
      house: 'asher',
      id: empId,
    }, token);
    if (r.status !== 200 || !r.body.ok) fail('deleteEmployee', r);
    log('deleteEmployee ok');
  }

  // 9. final verification — houses back to baseline, history has +1 row (append-only by design)
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
    const histDelta = r.body.history.length - baseline.history.length;
    log('final state ok', { houseCounts: counts, historyDelta: histDelta });
    if (histDelta !== 1) {
      console.warn('[warn] history delta is', histDelta, '— expected exactly 1');
    }
  }

  console.log('\nSMOKE TEST PASSED');
  process.exit(0);
})().catch(e => { console.error('uncaught', e); process.exit(1); });
