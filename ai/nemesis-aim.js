'use strict';
// Nemesis aim model: predicts where a player will be so the boss bot can aim there.
// Three modes are compared side by side:
//   naive   - aim at where the player was when the bot decided to shoot
//   lead    - assume the player keeps their current velocity
//   learned - an online model that learns this player's movement habits while they play
//
// Positions are [x, z] on the ground plane in meters. Runs at the server tick rate.

const MODES = ['naive', 'lead', 'learned'];

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, s) => [a[0] * s, a[1] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const len = (a) => Math.hypot(a[0], a[1]);
const norm = (a) => { const l = len(a); return l > 1e-6 ? [a[0] / l, a[1] / l] : [0, 0]; };
const perp = (a) => [-a[1], a[0]];
const clampLen = (a, m) => { const l = len(a); return l > m ? mul(a, m / l) : a; };

// Recursive least squares with a forgetting factor: learns y = W x one sample at a time.
class Rls {
  constructor(dim, forgetting = 0.995, initVariance = 100) {
    this.dim = dim; this.lambda = forgetting; this.init = initVariance;
    this.reset();
  }

  reset() {
    const D = this.dim;
    this.P = Array.from({ length: D }, (_, i) => Array.from({ length: D }, (_, j) => (i === j ? this.init : 0)));
    this.wx = new Array(D).fill(0);
    this.wy = new Array(D).fill(0);
  }

  predict(x) {
    let px = 0, py = 0;
    for (let i = 0; i < this.dim; i++) { px += this.wx[i] * x[i]; py += this.wy[i] * x[i]; }
    return [px, py];
  }

  update(x, yx, yy) {
    const D = this.dim, P = this.P;
    const Px = new Array(D).fill(0);
    for (let i = 0; i < D; i++) for (let j = 0; j < D; j++) Px[i] += P[i][j] * x[j];
    let denom = this.lambda;
    for (let i = 0; i < D; i++) denom += x[i] * Px[i];
    const [px, py] = this.predict(x);
    const ex = yx - px, ey = yy - py;
    for (let i = 0; i < D; i++) { const g = Px[i] / denom; this.wx[i] += g * ex; this.wy[i] += g * ey; }
    // Pause forgetting when P is already large, so unused directions do not blow up.
    let trace = 0;
    for (let i = 0; i < D; i++) trace += P[i][i];
    const lam = trace > this.init * D ? 1 : this.lambda;
    for (let i = 0; i < D; i++) for (let j = 0; j < D; j++) P[i][j] = (P[i][j] - (Px[i] / denom) * Px[j]) / lam;
    // Keep P symmetric; round-off otherwise degrades the model over long sessions.
    for (let i = 0; i < D; i++) for (let j = i + 1; j < D; j++) P[i][j] = P[j][i] = 0.5 * (P[i][j] + P[j][i]);
  }
}

function aimNaive(pos) { return pos.slice(); }

// Where the player will be after `seconds` if they keep their velocity (hitscan: no bullet flight).
function aimLead(pos, vel, seconds) { return add(pos, mul(vel, seconds)); }

const FEATURES = 12;

class LearnedPredictor {
  // tickRate: observations per second. maxSpeed: fastest a player moves (m/s), used to normalize.
  constructor({ tickRate = 20, maxSpeed = 14.4, forgetting = 0.995 } = {}) {
    this.tickRate = tickRate;
    this.maxSpeed = maxSpeed;
    this.horizons = [0.25, 0.5, 0.75, 1.0].map((s) => Math.round(s * tickRate));
    this.lags = [0, 0.1, 0.2, 0.4].map((s) => Math.round(s * tickRate));
    this.warmup = Math.round(6 * tickRate);
    this.models = this.horizons.map(() => new Rls(FEATURES, forgetting));
    this.updates = 0;
    this.clearHistory();
  }

  clearHistory() {
    this.holds = this.holds || [];   // seconds the player held each strafe direction (kept across respawns)
    this.vel = [];      // newest first
    this.snaps = [];    // newest first: { x, pos, radial }
    this.heldTicks = 0;
    this.lastSign = 0;
    this.lastPos = null;
    this.lastVel = [0, 0];
  }

  reset() {
    this.holds = [];
    this.clearHistory();
    for (const m of this.models) m.reset();
    this.updates = 0;
  }

  get warmedUp() { return this.updates >= this.warmup; }

  features(pos, shooterPos, radial) {
    // Motion in the shooter's frame (toward/away, left/right), so "strafes left then
    // reverses" looks the same anywhere on the map.
    const lateral = perp(radial);
    const x = new Array(FEATURES).fill(0);
    this.lags.forEach((lag, i) => {
      const v = this.vel[Math.min(lag, this.vel.length - 1)] || [0, 0];
      x[2 * i] = dot(v, radial) / this.maxSpeed;
      x[2 * i + 1] = dot(v, lateral) / this.maxSpeed;
    });
    x[8] = len(sub(pos, shooterPos)) / 40;
    // How long the player has kept strafing one way; captures timed reversals.
    const held = Math.min(this.heldTicks / (1.5 * this.tickRate), 1);
    x[9] = x[1] * held;
    x[10] = x[1] * held * held;   // lets a linear model bend: reversals come after a typical hold time
    x[11] = 1;
    return x;
  }

  // Call once per tick with the player's position and the position of the bot that is watching.
  observe(pos, shooterPos) {
    if (this.lastPos && len(sub(pos, this.lastPos)) > this.maxSpeed * 3 / this.tickRate) {
      this.clearHistory();   // teleport (respawn): history no longer describes continuous motion
    }
    const vel = this.lastPos ? mul(sub(pos, this.lastPos), this.tickRate) : [0, 0];
    let radial = norm(sub(pos, shooterPos));
    if (len(radial) < 0.5) radial = [1, 0];

    const lat = dot(vel, perp(radial));
    const sign = lat > 0.5 ? 1 : lat < -0.5 ? -1 : 0;
    if (sign !== 0 && sign !== this.lastSign) {
      if (this.lastSign !== 0 && this.heldTicks >= 2) {
        this.holds.push(this.heldTicks / this.tickRate);
        if (this.holds.length > 40) this.holds.shift();
      }
      this.heldTicks = 0;
      this.lastSign = sign;
    } else this.heldTicks++;

    this.vel.unshift(vel);
    if (this.vel.length > Math.max(...this.lags) + 1) this.vel.pop();
    this.snaps.unshift({ x: this.features(pos, shooterPos, radial), pos: pos.slice(), radial });
    if (this.snaps.length > this.horizons[this.horizons.length - 1] + 1) this.snaps.pop();

    // The future has arrived for older snapshots: learn from what the player actually did.
    this.horizons.forEach((h, k) => {
      if (this.snaps.length <= h) return;
      const s = this.snaps[h];
      const disp = sub(pos, s.pos);
      const scale = this.maxSpeed * h / this.tickRate;
      this.models[k].update(s.x, dot(disp, s.radial) / scale, dot(disp, perp(s.radial)) / scale);
      if (k === 0) this.updates++;
    });
    this.lastPos = pos.slice();
    this.lastVel = vel;
  }

  horizonDisplacement(k) {
    const now = this.snaps[0];
    if (!now) return [0, 0];
    const scale = this.maxSpeed * this.horizons[k] / this.tickRate;
    const y = mul(this.models[k].predict(now.x), scale);
    const world = add(mul(now.radial, y[0]), mul(perp(now.radial), y[1]));
    return clampLen(world, scale);   // nobody moves faster than max speed
  }

  predictDisplacement(seconds) {
    const t = Math.max(0, seconds * this.tickRate), H = this.horizons;
    if (t <= H[0]) return mul(this.horizonDisplacement(0), t / H[0]);
    for (let k = 1; k < H.length; k++) {
      if (t <= H[k]) {
        const u = (t - H[k - 1]) / (H[k] - H[k - 1]);
        return add(mul(this.horizonDisplacement(k - 1), 1 - u), mul(this.horizonDisplacement(k), u));
      }
    }
    return mul(this.horizonDisplacement(H.length - 1), t / H[H.length - 1]);
  }

  // Rhythm forecast: from this player's own strafe hold times, how likely is a reversal in the next
  // `seconds`, and when? Commits to one outcome (keep going or reverse) instead of averaging them.
  rhythmPoint(seconds) {
    const now = this.snaps[0];
    if (!now || !this.lastPos) return null;
    const held = this.heldTicks / this.tickRate;
    const later = this.holds.filter((d) => d > held);
    if (this.holds.length < 6 || later.length < 3) return aimLead(this.lastPos, this.lastVel, seconds);
    const soon = later.filter((d) => d <= held + seconds).map((d) => d - held).sort((a, b) => a - b);
    const lat = perp(now.radial);
    const vr = dot(this.lastVel, now.radial), vl = dot(this.lastVel, lat);
    let latDisp = vl * seconds;
    if (soon.length / later.length >= 0.5) {
      const tau = soon[soon.length >> 1];          // median time until the reversal
      latDisp = vl * tau - vl * (seconds - tau);   // reverse at the same speed
    }
    return add(this.lastPos, add(mul(now.radial, vr * seconds), mul(lat, latDisp)));
  }

  // Aim point `seconds` ahead; uses constant-velocity lead until the model has warmed up.
  aim(seconds) {
    if (!this.lastPos) return [0, 0];
    if (!this.warmedUp) return aimLead(this.lastPos, this.lastVel, seconds);
    return add(this.lastPos, this.predictDisplacement(seconds));
  }
}

// Scores predictors in parallel against where the player actually was `seconds` later:
// mean error (meters) and the share of predictions that would have hit (within hitRadius).
const SCORED = ['naive', 'lead', 'model', 'rhythm', 'learned'];
class Scoreboard {
  constructor({ tickRate = 20, seconds = 0.5, memorySeconds = 10, hitRadius = 0.45 } = {}) {
    this.delay = Math.round(seconds * tickRate);
    this.alpha = 1 / (memorySeconds * tickRate);
    this.hitRadius = hitRadius;
    this.pending = [];
    this.err = Object.fromEntries(SCORED.map((k) => [k, 0]));
    this.hit = Object.fromEntries(SCORED.map((k) => [k, 0]));
    this.samples = 0;
  }

  record(predictions, actualPos) {
    this.pending.push(predictions);
    if (this.pending.length <= this.delay) return;
    const old = this.pending.shift();
    for (const m of SCORED) {
      if (!old[m]) continue;
      const e = len(sub(old[m], actualPos));
      // Soft hit: a near-miss counts partly, because the bot's aim has spread on top of the guess.
      const w = this.hitRadius * 0.75;
      const h = Math.exp(-(e * e) / (2 * w * w));
      this.err[m] = this.samples === 0 ? e : this.err[m] + this.alpha * (e - this.err[m]);
      this.hit[m] = this.samples === 0 ? h : this.hit[m] + this.alpha * (h - this.hit[m]);
    }
    this.samples++;
  }

  clear() { this.pending = []; }
}

// One tracker per human player: owns their predictor and scoreboard.
// "learned" mode learns two things about each player. First, how they move: an RLS movement model
// and the rhythm of their strafes (hold times). Second, which aiming strategy actually lands on
// them: the RLS forecast, the rhythm forecast, or a plain straight-line lead. The second part
// matters because a squared-error model aims at the average of the player's options (keep going
// vs. reverse) and can miss both, where committing to the likely one would hit.
const CANDIDATES = ['lead', 'model', 'rhythm'];
class PlayerTracker {
  constructor(opts = {}) {
    this.seconds = opts.seconds || 0.5;
    this.choice = 'lead';
    this.predictor = new LearnedPredictor(opts);
    this.scoreboard = new Scoreboard(opts);
    this.stats = { naive: { shots: 0, hits: 0 }, lead: { shots: 0, hits: 0 }, learned: { shots: 0, hits: 0 } };
  }

  observe(pos, shooterPos) {
    const p = this.predictor;
    const jumped = p.lastPos && len(sub(pos, p.lastPos)) > p.maxSpeed * 3 / p.tickRate;
    if (jumped) this.scoreboard.clear();
    p.observe(pos, shooterPos);
    this.scoreboard.record(this.predictAll(this.seconds), pos);
    this.updateChoice();
  }

  // Pick the strategy with the better recent hit share; switch only on a clear margin.
  updateChoice() {
    const h = this.scoreboard.hit;
    if (!this.predictor.warmedUp || this.scoreboard.samples < 40) { this.choice = 'lead'; return; }
    let best = this.choice;
    for (const c of CANDIDATES) if (h[c] > h[best] + 0.03) best = c;
    this.choice = best;
  }

  predictAll(seconds) {
    const p = this.predictor;
    if (!p.lastPos) return { naive: [0, 0], lead: [0, 0], model: [0, 0], rhythm: [0, 0], learned: [0, 0] };
    const out = {
      naive: aimNaive(p.lastPos),
      lead: aimLead(p.lastPos, p.lastVel, seconds),
      model: p.warmedUp ? add(p.lastPos, p.predictDisplacement(seconds)) : aimLead(p.lastPos, p.lastVel, seconds),
      rhythm: p.rhythmPoint(seconds) || aimLead(p.lastPos, p.lastVel, seconds),
    };
    out.learned = out[this.choice];
    return out;
  }

  aimPoint(mode, seconds) {
    const p = this.predictor;
    if (mode === 'naive') return aimNaive(p.lastPos);
    if (mode === 'lead') return aimLead(p.lastPos, p.lastVel, seconds);
    return this.predictAll(seconds).learned;
  }
}

module.exports = { MODES, Rls, LearnedPredictor, Scoreboard, PlayerTracker, aimNaive, aimLead, vec: { sub, add, mul, dot, len, norm, perp } };
