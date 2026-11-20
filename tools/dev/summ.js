const R = require('../../eval_out/m2/runs.json'); const C = ['v0.1', 'v0.2-nolearn', 'v0.2'];
const sum = (a, f) => a.reduce((s, r) => s + f(r), 0), avg = (a, f) => a.length ? sum(a, f) / a.length : 0;
for (const c of C) { const a = R.filter((r) => r.config === c); const k = sum(a, (r) => r.botKills), d = sum(a, (r) => r.botDeaths);
  console.log(c.padEnd(13), 'K', k, 'D', d, 'KD', (k / d).toFixed(2), 'stuck', avg(a, (r) => r.stuckPct).toFixed(1), 'maxstuck', Math.max(...a.map((r) => r.stuckPct)), 'away', sum(a, (r) => r.firedFacingAway), 'cov', avg(a, (r) => r.coveragePct).toFixed(1)); }
for (const s of ['beginner', 'average', 'expert']) console.log(s.padEnd(9), C.map((c) => { const a = R.filter((r) => r.config === c && r.skill === s); return c + ' ' + (sum(a, (r) => r.botKills) / Math.max(1, sum(a, (r) => r.botDeaths))).toFixed(2); }).join(' | '));
for (const s of ['average', 'expert']) for (const c of C) { const a = R.filter((r) => r.config === c && r.skill === s); const row = [];
  for (let m = 0; m < 10; m += 2) { const k = sum(a, (r) => r.perMin[m].kills + r.perMin[m + 1].kills), d = sum(a, (r) => r.perMin[m].deaths + r.perMin[m + 1].deaths); row.push((k / Math.max(1, k + d)).toFixed(2)); }
  console.log(s, c.padEnd(13), 'kill share per 2 min', row.join(' ')); }
const v = R.filter((r) => r.config === 'v0.2');
console.log('expertise end', v.filter((r) => r.expertise === r.skill).length + '/' + v.length, '60s', v.filter((r) => { const x = r.skillSamples.find((q) => q.t >= 60); return x && x.level === r.skill; }).length + '/' + v.length);
