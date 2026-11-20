'use strict';
// Nemesis learner: what a bot learns about each human opponent DURING a match.
//
// It watches the player's coordinates every tick (speed, sprinting, sliding, jumping, weapon
// switches, strafe reversals, where they travel) and every fight (who killed whom, how quickly,
// from where, at what range, with which weapons). From that it updates, while the match runs:
//   1. a heat map of where this player travels        (every 1 s)
//   2. a danger map of where this player kills from    (after every bot death)
//   3. which fight plan works against this player      (every 1.5 s of a fight, and after every kill or death)
//   4. an expertise estimate: beginner / average / expert (every 5 s)
// Nothing is trained ahead of time here; the bot starts each match knowing nothing about the player.

const HEAT_CELL = 4;   // meters per heat/danger cell
const HEAT_HALF_LIFE_S = 150;
const DANGER_HALF_LIFE_S = 300;

// Fight plans the bot chooses between: preferred range x approach.
const RANGES = { close: [3, 9], mid: [9, 20], long: [20, 34] };
const PLANS = [];
for (const range of Object.keys(RANGES)) for (const approach of ['push', 'hold', 'flank']) PLANS.push({ id: `${range}-${approach}`, range, approach });
const WEAPON_FOR_RANGE = { close: 2, mid: 1, long: 3 };   // shotgun, rifle, sniper
const SHORT_WEAPONS = new Set([2, 4]);                     // shotgun, deagle

// Bot behavior per expertise level: how a beginner, average, or expert human plays.
const PROFILES = {
  beginner: { reaction: 0.45, aimNoise: 1.6, cooldownMul: 1.3, approaches: ['push', 'hold'], slide: 0, jump: 0, preaim: false, switchWeapons: false },
  average:  { reaction: 0.32, aimNoise: 1.0, cooldownMul: 1.0, approaches: ['push', 'hold', 'flank'], slide: 0.35, jump: 0.08, preaim: true, switchWeapons: true },
  expert:   { reaction: 0.24, aimNoise: 0.8, cooldownMul: 0.9, approaches: ['push', 'hold', 'flank'], slide: 0.7, jump: 0.2, preaim: true, switchWeapons: true },
};
const LEVELS = ['beginner', 'average', 'expert'];

const ema = (prev, x, a) => (prev === null || prev === undefined ? x : prev + a * (x - prev));
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const key = (x, y, z) => `${Math.floor(x / HEAT_CELL)},${Math.floor(z / HEAT_CELL)},${Math.round((y || 0) / 2.5)}`;
const cellCenter = (k) => { const [i, j, l] = k.split(',').map(Number); return [(i + 0.5) * HEAT_CELL, l * 2.5, (j + 0.5) * HEAT_CELL]; };

function gaussian(rand) {
  const u = rand() || 1e-9, v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

class DecayMap {
  constructor(halfLife) { this.m = new Map(); this.k = Math.log(2) / halfLife; this.t = 0; }
  _decay(now) {
    const dt = (now - this.t) / 1000;
    if (dt <= 0) return;
    const f = Math.exp(-this.k * dt);
    for (const [k, v] of this.m) { const nv = v * f; if (nv < 0.01) this.m.delete(k); else this.m.set(k, nv); }
    this.t = now;
  }
  add(x, y, z, w, now) { this._decay(now); const k = key(x, y, z); this.m.set(k, (this.m.get(k) || 0) + w); }
  at(x, y, z) { return this.m.get(key(x, y, z)) || 0; }
  // strongest cells as [x, y, z, weight]
  top(n) { return [...this.m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => [...cellCenter(k), v]); }
  total() { let s = 0; for (const v of this.m.values()) s += v; return s; }
  sample(rand) {
    const tot = this.total();
    if (tot <= 0) return null;
    let r = rand() * tot;
    for (const [k, v] of this.m) { r -= v; if (r <= 0) return cellCenter(k); }
    return null;
  }
}

// Thompson-sampling bandit over fight plans, per context (player holding a short- or long-range weapon).
class PlanBandit {
  constructor() { this.stats = { short: new Map(), long: new Map() }; }
  _s(ctx, id) { const m = this.stats[ctx]; if (!m.has(id)) m.set(id, { n: 0, mean: 0 }); return m.get(id); }
  choose(ctx, allowed, rand, prior = {}) {
    let best = null, bestV = -Infinity;
    for (const p of PLANS) {
      if (!allowed.includes(p.approach)) continue;
      const s = this._s(ctx, p.id);
      const v = s.mean + (prior[p.id] || 0) / (1 + s.n) + gaussian(rand) * 0.6 / Math.sqrt(1 + s.n);
      if (v > bestV) { bestV = v; best = p; }
    }
    return best;
  }
  update(ctx, id, reward, weight = 1) {
    const s = this._s(ctx, id);
    s.n += weight;
    s.mean += (weight * (reward - s.mean)) / s.n;
  }
  table(ctx) { return PLANS.map((p) => { const s = this._s(ctx, p.id); return { id: p.id, n: +s.n.toFixed(2), value: +s.mean.toFixed(3) }; }); }
}

class OpponentModel {
  constructor(id, now) {
    this.id = id;
    this.start = now;
    this.heat = new Map();     // per map
    this.danger = new Map();   // per map: where the bot died (avoid)
    this.threats = new Map();  // per map: where the player was when it killed the bot (pre-aim these)
    this.bandit = new PlanBandit();
    // movement habits (exponential moving averages, per second)
    this.speed = null; this.sprintFrac = null; this.slidesPerMin = null; this.jumpsPerMin = null;
    this.switchesPerMin = null; this.reversalsPerSec = null;
    this._acc = { t: 0, dist: 0, sprint: 0, slides: 0, jumps: 0, switches: 0, reversals: 0, ticks: 0, fightT: 0 };
    this._last = null; this._lastFlags = {}; this._lastW = null; this._latSign = 0;
    // fights
    this.botKills = 0; this.playerKills = 0;          // bot killed player / player killed bot
    this.botTtk = []; this.playerTtk = [];            // seconds from first sight to the kill
    this.playerKillRanges = []; this.weaponUse = {};  // what the player kills with, and at what range
    this.damageToBots = 0; this.engagedSeconds = 0;
    this.lessons = [];
    this.skillScore = null; this.level = 'average'; this.confidence = 0; this._skillAt = 0;
  }

  heatFor(map) { if (!this.heat.has(map)) this.heat.set(map, new DecayMap(HEAT_HALF_LIFE_S)); return this.heat.get(map); }
  threatsFor(map) { if (!this.threats.has(map)) this.threats.set(map, []); return this.threats.get(map); }
  addThreat(map, pos) { const t = this.threatsFor(map); t.unshift(pos.slice()); if (t.length > 6) t.pop(); }
  dangerFor(map) { if (!this.danger.has(map)) this.danger.set(map, new DecayMap(DANGER_HALF_LIFE_S)); return this.danger.get(map); }

  // every tick: the player's coordinates and movement flags; botPos = nearest bot (for strafe direction)
  observe(p, botPos, dt) {
    const a = this._acc;
    const pos = p.pos;
    if (this._last) {
      const d = Math.hypot(pos[0] - this._last[0], pos[2] - this._last[2]);
      if (d < 3) a.dist += d;   // larger jumps are respawns
      // strafe reversals: only count side-to-side movement while near a bot (a fight), at real strafe speed
      const rx = botPos ? pos[0] - botPos[0] : 0, rz = botPos ? pos[2] - botPos[2] : 0, rl = Math.hypot(rx, rz) || 1;
      if (botPos && rl < 35 && d > 1e-3 && d < 3) {
        a.fightT += dt;
        const lat = ((pos[0] - this._last[0]) * -rz + (pos[2] - this._last[2]) * rx) / rl / dt;
        const sign = lat > 3 ? 1 : lat < -3 ? -1 : 0;
        if (sign && this._latSign && sign !== this._latSign) a.reversals++;
        if (sign) this._latSign = sign;
      }
    }
    if (p.spr) a.sprint += dt;
    if (p.sl && !this._lastFlags.sl) a.slides++;
    if (p.air && !this._lastFlags.air && this._last && pos[1] > this._last[1] + 0.02) a.jumps++;   // a real jump goes up
    if (this._lastW !== null && p.w !== this._lastW) a.switches++;
    a.t += dt; a.ticks++;
    this._last = pos.slice();
    this._lastFlags = { sl: !!p.sl, air: !!p.air };
    this._lastW = p.w;
  }

  // every second: fold the last second into the habit averages and the travel heat map
  learnTick(map, pos, now) {
    const a = this._acc;
    if (a.t <= 0) return;
    const k = 0.15;
    this.speed = ema(this.speed, a.dist / a.t, k);
    this.sprintFrac = ema(this.sprintFrac, a.sprint / a.t, k);
    this.slidesPerMin = ema(this.slidesPerMin, (a.slides / a.t) * 60, k);
    this.jumpsPerMin = ema(this.jumpsPerMin, (a.jumps / a.t) * 60, k);
    this.switchesPerMin = ema(this.switchesPerMin, (a.switches / a.t) * 60, k);
    if (a.fightT > 0.3) this.reversalsPerSec = ema(this.reversalsPerSec, a.reversals / a.fightT, k);
    if (pos) this.heatFor(map).add(pos[0], pos[1], pos[2], 1, now);
    this._acc = { t: 0, dist: 0, sprint: 0, slides: 0, jumps: 0, switches: 0, reversals: 0, ticks: 0, fightT: 0 };
  }

  context(playerWeapon) { return SHORT_WEAPONS.has(playerWeapon) ? 'short' : 'long'; }

  // ---- expertise: 0 (beginner) .. 1 (expert), from fights and movement ----
  assessSkill(now) {
    const t = (now - this.start) / 1000;
    // movement skill: experienced players sprint, slide, jump, swap weapons for the range, and strafe in fights
    const mv = clamp01(clamp01((this.sprintFrac || 0) / 0.75) * 0.3 + clamp01((this.slidesPerMin || 0) / 6) * 0.25 +
      clamp01((this.switchesPerMin || 0) / 6) * 0.2 + clamp01((this.reversalsPerSec || 0) / 1.2) * 0.15 + clamp01((this.jumpsPerMin || 0) / 6) * 0.1);
    const fights = this.botKills + this.playerKills;
    const kd = this.playerKills / Math.max(1, this.botKills);
    const kdS = clamp01(kd / 2.5);
    const med = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; };
    const ttk = med(this.playerTtk);
    const ttkS = ttk === null ? 0.5 : clamp01(1 - (ttk - 1.2) / 6);
    const dps = this.engagedSeconds > 3 ? this.damageToBots / this.engagedSeconds : null;
    const dpsS = dps === null ? 0.5 : clamp01(dps / 45);
    const wFight = Math.min(0.6, fights * 0.1);   // trust fight results more as they accumulate
    const fightS = (kdS * 0.45 + ttkS * 0.25 + dpsS * 0.3);
    const raw = mv * (1 - wFight) + fightS * wFight;
    this.skillScore = ema(this.skillScore, raw, 0.35);
    this.confidence = clamp01(Math.min(t / 60, 1) * 0.6 + Math.min(fights / 6, 1) * 0.4);
    const s = this.skillScore;
    const lvl = this.level;
    // hysteresis so the level does not flicker at a boundary
    if (s < (lvl === 'beginner' ? 0.40 : 0.34)) this.level = 'beginner';
    else if (s > (lvl === 'expert' ? 0.56 : 0.62)) this.level = 'expert';
    else this.level = 'average';
    if (this.level !== lvl && t > 5) this.note(now, `re-rated the player: ${lvl} \u2192 ${this.level} (score ${s.toFixed(2)})`);
    this._skillAt = now;
    return this.level;
  }

  note(now, text) {
    this.lessons.unshift({ t: now, text });
    if (this.lessons.length > 6) this.lessons.pop();
  }

  summary() {
    const r = (x, d = 2) => (x === null || x === undefined ? null : +x.toFixed(d));
    return {
      level: this.level, score: r(this.skillScore), confidence: r(this.confidence),
      speed: r(this.speed), sprint: r(this.sprintFrac), slidesPerMin: r(this.slidesPerMin, 1), jumpsPerMin: r(this.jumpsPerMin, 1),
      switchesPerMin: r(this.switchesPerMin, 1), reversalsPerSec: r(this.reversalsPerSec),
      botKills: this.botKills, playerKills: this.playerKills,
    };
  }
}

// Reward for a finished fight from the bot's point of view: kills are good (faster is better),
// deaths are bad (dying quickly is worse).
function fightReward(outcome, seconds) {
  const quick = 1 - Math.min(seconds, 10) / 10;
  if (outcome === 'kill') return 1 + 0.5 * quick;
  if (outcome === 'death') return -1 - 0.5 * quick;
  return 0;
}

module.exports = { OpponentModel, PlanBandit, DecayMap, PLANS, RANGES, WEAPON_FOR_RANGE, PROFILES, LEVELS, fightReward, HEAT_CELL };
