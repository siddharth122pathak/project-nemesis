'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Rls, LearnedPredictor, PlayerTracker, aimLead, vec } = require('../ai/nemesis-aim.js');
const { runOne } = require('../tools/eval.js');

const close = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} not within ${tol} of ${b}`);

test('lead aim extrapolates constant velocity', () => {
  const p = aimLead([1, 2], [3, -4], 0.5);
  assert.deepEqual(p, [2.5, 0]);
});

test('RLS recovers a known linear function', () => {
  const rls = new Rls(3, 1.0);
  let s = 1;
  const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647 * 2 - 1; };
  for (let i = 0; i < 500; i++) {
    const a = r(), b = r();
    rls.update([a, b, 1], 2 * a - b + 0.5, -a + 3 * b);
  }
  const [x, y] = rls.predict([0.3, -0.2, 1]);
  close(x, 2 * 0.3 + 0.2 + 0.5, 1e-3);
  close(y, -0.3 - 0.6, 1e-3);
});

test('learned predictor learns steady motion', () => {
  const lp = new LearnedPredictor({ tickRate: 20 });
  let pos = [5, 2];
  const vel = [3, 1];
  for (let t = 0; t < 400; t++) { lp.observe(pos, [20, 12]); pos = vec.add(pos, vec.mul(vel, 1 / 20)); }
  assert.ok(lp.warmedUp);
  const d = lp.predictDisplacement(0.5);
  close(d[0], 1.5, 0.08);
  close(d[1], 0.5, 0.08);
});

test('a respawn teleport clears motion history but keeps learned weights', () => {
  const lp = new LearnedPredictor({ tickRate: 20 });
  let pos = [0, 0];
  for (let t = 0; t < 200; t++) { lp.observe(pos, [10, 10]); pos = vec.add(pos, [0.2, 0]); }
  const w = lp.models[1].wx.slice();
  lp.observe([60, 60], [10, 10]);   // jump of ~80 m in one tick
  assert.equal(lp.snaps.length, 1);
  assert.deepEqual(lp.models[1].wx, w);
});

test('prediction never exceeds max player speed', () => {
  const lp = new LearnedPredictor({ tickRate: 20, maxSpeed: 14.4 });
  let pos = [0, 0];
  for (let t = 0; t < 300; t++) { lp.observe(pos, [0, 20]); pos = vec.add(pos, [0.7, 0]); }
  assert.ok(vec.len(lp.predictDisplacement(1.0)) <= 14.4 + 1e-6);
});

test('learned aim beats naive and lead against a timed strafer', () => {
  const naive = runOne('Strafer', 'naive', 120), lead = runOne('Strafer', 'lead', 120), learned = runOne('Strafer', 'learned', 120);
  const rate = (r) => r.hits / r.shots;
  assert.ok(rate(learned) > rate(lead), `learned ${rate(learned)} vs lead ${rate(lead)}`);
  assert.ok(rate(learned) > rate(naive));
});

test('tracker scores all three modes in parallel', () => {
  const tr = new PlayerTracker({ tickRate: 20, seconds: 0.3 });
  let pos = [0, 10];
  for (let t = 0; t < 300; t++) { tr.observe(pos, [0, 0]); pos = vec.add(pos, [0.4 * Math.sign(Math.sin(t / 15)), 0]); }
  assert.ok(tr.scoreboard.samples > 200);
  for (const m of ['naive', 'lead', 'learned']) assert.ok(Number.isFinite(tr.scoreboard.err[m]));
});

test('learned mode is never worse than lead on any scripted player', () => {
  for (const style of ['Strafer', 'ZigZag', 'Circler', 'Juker']) {
    const lead = runOne(style, 'lead', 120), learned = runOne(style, 'learned', 120);
    assert.ok(learned.hits / learned.shots >= lead.hits / lead.shots - 0.02, `${style}: learned ${learned.hits}/${learned.shots} vs lead ${lead.hits}/${lead.shots}`);
  }
});

test('bot tactics: takes cover from a visible enemy and hunts the predicted spot after losing it', () => {
  const T = require('../ai/nemesis-tactics.js');
  // open field with one wall segment the bot can hide behind
  const wall = { x0: -4, x1: 4, z0: 3, z1: 4 };
  const inWall = (x, z) => x > wall.x0 - 0.45 && x < wall.x1 + 0.45 && z > wall.z0 - 0.45 && z < wall.z1 + 0.45;
  const seg = (ax, az, bx, bz) => { for (let i = 0; i <= 40; i++) { const t = i / 40; if (inWall(ax + (bx - ax) * t, az + (bz - az) * t)) return true; } return false; };
  const api = {
    posBlocked: (_m, x, z) => inWall(x, z) || Math.abs(x) > 30 || Math.abs(z) > 30,
    segmentBlocked: (_m, ax, _ay, az, bx, _by, bz) => seg(ax, az, bx, bz),
    pickSpawn: () => [0, 0, 0],
    predict: () => [-6, 12],
  };
  const room = { map: 'test' };
  const bot = { pos: [0, 0, 0], ry: 0, hp: 100, deaths: 0, w: 1 };
  const enemy = { pos: [12, 0, 6] };
  const seen = new Set();
  const realNow = Date.now, realRandom = Math.random;
  let clock = realNow(), seed = 12345;
  Date.now = () => clock;
  Math.random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };   // repeatable run
  try {
    for (let i = 0; i < 40 * 20; i++) {
      clock += 50;
      const visible = !seg(bot.pos[0], bot.pos[2], enemy.pos[0], enemy.pos[2]);
      T.update(room, 'b1', bot, visible && i < 500 ? ['p1', enemy] : null, 0.05, api);
      seen.add(bot.ai.state);
    }
  } finally {
    Date.now = realNow;
    Math.random = realRandom;
  }
  for (const s of ['engage', 'cover', 'hunt']) assert.ok(seen.has(s), `never entered ${s}: ${[...seen]}`);
});
