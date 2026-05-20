'use strict';

function cost(emp) {
  if (!emp) return 0;
  const salary = Number(emp.salary) || 0;
  const pct = Number(emp.pct) || 0;
  return Math.round(salary * (pct / 100));
}

function houseCost(list) {
  return (list || []).reduce((s, e) => s + cost(e), 0);
}

function houseGross(list) {
  return (list || []).reduce((s, e) => s + (Number(e.salary) || 0), 0);
}

function avgPct(list) {
  const arr = list || [];
  if (!arr.length) return 0;
  return Math.round(arr.reduce((s, e) => s + (Number(e.pct) || 0), 0) / arr.length);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { cost, houseCost, houseGross, avgPct };
}
if (typeof window !== 'undefined') {
  window.EZONE_CALC = { cost, houseCost, houseGross, avgPct };
}
