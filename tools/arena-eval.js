'use strict';
// Milestone 2 measurement harness: what already existed (v0.1) vs. what was built (v0.2).
//
// Runs the real bot code (ai/*.js) in simulated LAB ARENA rooms, much faster than real time:
// one Nemesis bot vs. one scripted human player, on every map, against beginner / average / expert
// players, for three bot versions:
//   v0.1           the bot from Milestone 1 (no navigation, no abilities, no learning)
//   v0.2-nolearn   v0.2 navigation, abilities, and tactics, but learning switched off (ablation)
//   v0.2           everything, learning each player during the match
//
// Usage: node tools/arena-eval.js [minutes=10] [seeds=2] [outDir=eval_out/m2]
const fs = require('fs');
const path = require('path');

let SIM_NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
Date.now = () => SIM_NOW;   // every bot module reads the simulated clock

const W = require('../world.js');
const NEMESIS = require('../ai/nemesis-bot.js');
const BRAIN = require('../ai/nemesis-brain.js');
const SIMP = require('../ai/nemesis-simplayer.js');
const { navFor } = require('../ai/nemesis-nav.js');

const MAPS = ['shipment', 'killhouse', 'range', 'blackout', 'districts', 'monastery'];
const SKILLS = ['beginner', 'average', 'expert'];
const CONFIGS = [
  { id: 'v0.1', version: 1, learn: false },
  { id: 'v0.2-nolearn', version: 2, learn: false },
  { id: 'v0.2', version: 2, learn: true },
];
const DT = 0.05;
const WEAPON_DMG = { 1: 25, 2: 60, 3: 70, 4: 45 };
const COOLDOWN = { 1: 380, 2: 1100, 3: 1900, 4: 700 };

function seeded(seed) { let s = seed >>> 0 || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

function runOne(map, skill, cfg, seed, minutes) {
  Math.random = seeded(seed * 1009 + MAPS.indexOf(map) * 97 + SKILLS.indexOf(skill) * 13);   // same dice for every config
  const room = { code: `SIM-${map}-${skill}-${cfg.id}`, map, mode: 'dm', started: true, matchOver: false,
    players: new Map(), nemesisVersion: cfg.version, nemesisLearn: cfg.learn };
  const respawns = [];
  const applyDamage = (r, killerId, targetId, dmg, head, weapon) => {
    const k = r.players.get(killerId), t = r.players.get(targetId);
    if (!k || !t || t.dead || !t.inGame) return;
    t.hp -= dmg;
    t.lastHurt = SIM_NOW;
    BRAIN.onDamage(r, killerId, targetId, dmg, t.hp <= 0);
    SIMP.onSimHurt(r, targetId, killerId);
    if (t.hp > 0) return;
    t.hp = 0; t.dead = true; t.deaths++; k.kills++;
    k.hp = Math.min(100, k.hp + 25);
    respawns.push({ at: SIM_NOW + 3000, id: targetId });
  };
  const api = { posBlocked: W.posBlocked, segmentBlocked: W.segmentBlocked, pickSpawn: W.pickSpawn,
    broadcastRoom() {}, applyDamage, weaponDamage: WEAPON_DMG, cooldowns: COOLDOWN };
  const nemApi = { broadcastRoom() {}, applyDamage, segmentBlocked: W.segmentBlocked, weaponDamage: WEAPON_DMG,
    onShotFired: BRAIN.onShotFired, onShotHit: BRAIN.onShotHit };
  const fakeWs = { readyState: 3, send() {} };
  room.players.set('b1', { ws: fakeWs, bot: true, name: 'BOT ATLAS', color: 0xff4444, pos: W.pickSpawn(room, cfg.version === 1),
    ry: 0, pitch: 0, hp: 100, kills: 0, deaths: 0, dead: false, inGame: true, w: 1, aiWaypoint: null, aiNextShot: 0, aiStuck: 0 });
  const pid = SIMP.addSimPlayer(room, { pickSpawn: W.pickSpawn, color: 0x44ff88, skill, style: 'rhythm', seed, name: 'PLAYER' });
  room.players.get(pid).inGame = true;

  const ticks = Math.round((minutes * 60) / DT);
  const skillSamples = [];
  const t0 = SIM_NOW;
  for (let i = 0; i < ticks; i++) {
    SIM_NOW += DT * 1000;
    while (respawns.length && respawns[0].at <= SIM_NOW) {
      const r = respawns.shift(), p = room.players.get(r.id);
      p.hp = 100; p.dead = false; p.pos = W.pickSpawn(room, !!p.bot && cfg.version === 1);
    }
    SIMP.tickSims(room, DT, api);
    NEMESIS.observe(room);
    BRAIN.tickBots(room, DT, api);
    NEMESIS.tick(room, nemApi);
    if (i % 10 === 0) {
      for (const p of room.players.values()) {
        if (!p.dead && p.hp < 100 && SIM_NOW - (p.lastHurt || 0) > 5000) p.hp = Math.min(100, p.hp + 5);
      }
    }
    if (i % 200 === 0 && i > 0) {
      const m = BRAIN.brainOf(room).models.get(pid);
      skillSamples.push({ t: (SIM_NOW - t0) / 1000, level: m ? m.level : 'average', score: m ? m.skillScore : null });
    }
  }
  const b = BRAIN.brainOf(room);
  const mt = b.metrics.get('b1');
  const bot = room.players.get('b1'), player = room.players.get(pid);
  const nav = navFor(map);
  const walk2m = new Set(nav.reachList.map((n) => { const p = nav.pos(n); return `${Math.floor(p[0] / 2)},${Math.floor(p[2] / 2)},${Math.round(p[1] / 2.5)}`; })).size;
  const perMin = [];
  for (let m = 0; m < minutes; m++) {
    const lo = t0 + m * 60000, hi = lo + 60000;
    perMin.push({ minute: m + 1, kills: mt.events.filter((e) => e.type === 'kill' && e.t > lo && e.t <= hi).length,
      deaths: mt.events.filter((e) => e.type === 'death' && e.t > lo && e.t <= hi).length });
  }
  const med = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, c) => a - c); return +s[s.length >> 1].toFixed(2); };
  const model = b.models.get(pid);
  return {
    map, skill, config: cfg.id, seed, minutes,
    botKills: bot.kills, botDeaths: bot.deaths, kd: +(bot.kills / Math.max(1, bot.deaths)).toFixed(2),
    medianTtk: med(mt.ttk), medianTtd: med(mt.ttd),
    stuckPct: +(100 * mt.stuck / Math.max(1, mt.moveSecs)).toFixed(2), stuckBy: mt.stuckBy || {},
    shots: mt.shots, hits: mt.hits, hitRate: +(100 * mt.hits / Math.max(1, mt.shots)).toFixed(1),
    firedFacingAway: cfg.version === 1 ? mt.facingErr : 0, cancelledTurnedAway: mt.cancelled,
    coveragePct: +(100 * mt.cells.size / Math.max(1, walk2m)).toFixed(1),
    sprintPct: +(100 * mt.sprintSecs / Math.max(1, mt.aliveSecs)).toFixed(1),
    slidesPerMin: +(mt.slides / minutes).toFixed(2), jumpsPerMin: +(mt.jumps / minutes).toFixed(2), switchesPerMin: +(mt.switches / minutes).toFixed(2),
    perMin, skillSamples,
    expertise: model ? model.level : null,
    playerHabits: model ? model.summary() : null,
    planTable: model && cfg.learn ? model.bandit.table('long').sort((x, y) => y.value - x.value).slice(0, 4) : null,
  };
}

function main() {
  const minutes = Number(process.argv[2]) || 10;
  const seeds = Number(process.argv[3]) || 2;
  const outDir = path.resolve(process.argv[4] || 'eval_out/m2');
  fs.mkdirSync(outDir, { recursive: true });
  const runs = [];
  const started = process.hrtime.bigint();
  for (const map of MAPS) {
    navFor(map);
    for (const skill of SKILLS) {
      for (const cfg of CONFIGS) {
        for (let seed = 1; seed <= seeds; seed++) {
          const r = runOne(map, skill, cfg, seed, minutes);
          runs.push(r);
          process.stdout.write(`${map.padEnd(10)} ${skill.padEnd(9)} ${cfg.id.padEnd(13)} seed ${seed}  K/D ${String(r.kd).padStart(5)}  ` +
            `stuck ${String(r.stuckPct).padStart(5)}%  away-shots ${String(r.firedFacingAway).padStart(3)}  coverage ${String(r.coveragePct).padStart(5)}%  ` +
            `rated ${r.expertise}\n`);
        }
      }
    }
  }
  fs.writeFileSync(path.join(outDir, 'runs.json'), JSON.stringify(runs, null, 1));
  const secs = Number(process.hrtime.bigint() - started) / 1e9;
  console.log(`\n${runs.length} runs, ${minutes} simulated minutes each, in ${secs.toFixed(0)} s. Wrote ${outDir}/runs.json`);
}

if (require.main === module) main();
module.exports = { runOne };
