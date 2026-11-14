'use strict';
// Headless evaluation: scripted test players with known movement habits fight a Nemesis bot in
// an open field, once per aim mode. Uses the same reaction delay, aim noise, and hit radius as
// the game server, so the hit rates are comparable to real play.
//
// Usage: node tools/eval.js [seconds]   (writes eval_out/eval_results.csv and eval_out/learning_curve.csv)
const fs = require('fs');
const path = require('path');
const { MODES, PlayerTracker, vec } = require('../ai/nemesis-aim.js');

const TICK = 20, DT = 1 / TICK;
const REACTION = 0.3, NOISE_PER_M = 0.012, RADIUS = 0.45, COOLDOWN = 0.38;
const SPEED = 9;   // walking speed in LAB ARENA (m/s)
const STYLES = ['Strafer', 'ZigZag', 'Circler', 'Juker'];

// Small seeded RNG so every mode sees exactly the same player movement and noise.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function gauss(r) { const u = r() || 1e-9, v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

function runOne(style, mode, seconds) {
  const moveR = rng(7), noiseR = rng(42);
  const tr = new PlayerTracker({ tickRate: TICK, seconds: REACTION });
  let player = [0, 15], sign = 1, timer = 0, interval = style === 'ZigZag' ? 0.5 : 1.2;
  const pending = [];
  let cooldown = 1, shots = 0, hits = 0, winShots = 0, winHits = 0;
  const windows = [], curve = [];
  const history = [];   // player positions by tick, to resolve delayed shots

  for (let tick = 1; tick <= seconds * TICK; tick++) {
    const t = tick * DT;
    const bot = [6 * Math.sin(t * 0.4), 0];   // the bot strafes slowly too
    // --- scripted player movement ---
    timer += DT;
    if (timer >= interval) { timer = 0; sign = -sign; if (style === 'Juker') interval = 0.3 + 0.7 * moveR(); }
    const radial = vec.norm(vec.sub(bot, player)), lateral = vec.perp(radial);
    const range = vec.len(vec.sub(bot, player));
    const keep = vec.mul(radial, Math.max(-1, Math.min(1, (range - 15) * 0.4)));
    let dir;
    if (style === 'Circler') dir = vec.add(lateral, keep);
    else if (style === 'ZigZag') dir = vec.add(vec.norm(vec.add(vec.mul(lateral, sign), vec.mul(radial, 0.6))), keep);
    else dir = vec.add(vec.mul(lateral, sign), keep);
    const dl = vec.len(dir);
    if (dl > 1) dir = vec.mul(dir, 1 / dl);
    player = vec.add(player, vec.mul(dir, SPEED * DT));
    history[tick] = player;

    tr.observe(player, bot);

    // --- bot shooting: decide now, fire after the reaction delay ---
    cooldown -= DT;
    if (cooldown <= 0) {
      cooldown = COOLDOWN;
      pending.push({ due: tick + Math.round(REACTION * TICK), aim: tr.aimPoint(mode, REACTION), from: bot });
    }
    while (pending.length && pending[0].due <= tick) {
      const s = pending.shift();
      const sigma = NOISE_PER_M * vec.len(vec.sub(s.aim, s.from));
      const aim = [s.aim[0] + gauss(noiseR) * sigma, s.aim[1] + gauss(noiseR) * sigma];
      shots++; winShots++;
      if (vec.len(vec.sub(aim, player)) < RADIUS) { hits++; winHits++; }
    }

    if (tick % (5 * TICK) === 0) curve.push([t, tr.scoreboard.err.naive, tr.scoreboard.err.lead, tr.scoreboard.err.learned]);
    if (tick % (30 * TICK) === 0) { windows.push([winShots, winHits]); winShots = winHits = 0; }
  }
  return { shots, hits, windows, curve };
}

function main() {
  const seconds = Number(process.argv[2]) || 180;
  const outDir = path.join(process.cwd(), 'eval_out');
  fs.mkdirSync(outDir, { recursive: true });
  const results = ['bot,mode,window_start_s,shots,hits,hit_rate'];
  const curveRows = ['bot,time_s,err_naive,err_lead,err_learned'];
  const summary = {};
  const pct = (h, s) => (s ? (100 * h / s).toFixed(1) + '%' : '--');

  console.log(`Nemesis bot hit rate per 30 s window (${seconds} s per run, reaction ${REACTION} s)\n`);
  for (const style of STYLES) {
    summary[style] = {};
    for (const mode of MODES) {
      const r = runOne(style, mode, seconds);
      summary[style][mode] = r.hits / r.shots;
      r.windows.forEach(([s, h], i) => results.push(`${style},${mode},${i * 30},${s},${h},${s ? h / s : 0}`));
      if (mode === 'learned') r.curve.forEach((c) => curveRows.push([style, ...c.map((v) => +v.toFixed(3))].join(',')));
      console.log(`${style.padEnd(8)} ${mode.padEnd(8)} ${r.windows.map(([s, h]) => pct(h, s).padStart(7)).join(' ')}   overall ${pct(r.hits, r.shots)}`);
    }
    console.log('');
  }
  fs.writeFileSync(path.join(outDir, 'eval_results.csv'), results.join('\n') + '\n');
  fs.writeFileSync(path.join(outDir, 'learning_curve.csv'), curveRows.join('\n') + '\n');
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(`Wrote ${outDir}/eval_results.csv, learning_curve.csv, summary.json`);
}

if (require.main === module) main();
module.exports = { runOne };
