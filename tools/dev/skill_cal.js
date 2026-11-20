// dev: skill score over time for each true skill level, to calibrate the expertise thresholds
const { runOne } = require('../arena-eval.js');
for (const map of ['shipment', 'killhouse', 'range', 'districts']) for (const sk of ['beginner', 'average', 'expert']) {
  const scores = [];
  for (let seed = 1; seed <= 2; seed++) {
    const r = runOne(map, sk, { id: 'v0.2', version: 2, learn: true }, seed, 6);
    scores.push(r.skillSamples.filter((x) => [30, 60, 120, 240, 350].some((t) => Math.abs(x.t - t) < 6)).map((x) => `${x.t.toFixed(0)}s:${x.score === null ? '-' : x.score.toFixed(2)}`).join(' ') + ` | habits ${JSON.stringify(r.playerHabits)}`);
  }
  console.log(map, sk, '\n  ' + scores.join('\n  '));
}
