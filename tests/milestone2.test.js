'use strict';
const test = require('node:test');
const assert = require('node:assert');
const W = require('../world.js');
const { navFor } = require('../ai/nemesis-nav.js');
const MOVE = require('../ai/nemesis-move.js');
const BRAIN = require('../ai/nemesis-brain.js');
const L = require('../ai/nemesis-learner.js');

const MAPS = ['shipment', 'killhouse', 'range', 'blackout', 'districts', 'monastery'];
const seeded = (seed) => { let s = seed; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; };

test('nav: every map has a walkable grid and spawns connect to each other', () => {
  for (const map of MAPS) {
    const nav = navFor(map);
    assert.ok(nav.reachList.length > 1000, `${map} walkable nodes`);
    const sp = W.MAP_SPAWNS[map];
    const a = nav.nearest(sp[0][0], sp[0][1], sp[0][2], 12);
    for (let i = 1; i < sp.length; i++) {
      const b = nav.nearest(sp[i][0], sp[i][1], sp[i][2], 12);
      assert.ok(nav.path(b, a, null, 60000), `${map}: spawn ${i} -> spawn 0`);
    }
  }
});

test('move: bots walk random routes to the end without getting stuck', () => {
  const rnd = seeded(11);
  let ok = 0, total = 0;
  for (const map of MAPS) {
    const nav = navFor(map);
    for (let k = 0; k < 15; k++) {
      const e = { pos: nav.pos(nav.randomNode(rnd)) };
      if (!MOVE.routeTo(nav, e, nav.pos(nav.randomNode(rnd)))) continue;
      total++;
      for (let t = 0; t < 90; t += 0.05) {
        const r = MOVE.follow(nav, e, 6.5, 0.05);
        MOVE.settle(nav, e, 0.05);
        if (r === 'arrived') { ok++; break; }
      }
    }
  }
  assert.ok(total >= 80 && ok / total >= 0.95, `arrived ${ok}/${total}`);
});

test('facing fix: v0.2 cancels a shot when the bot faces away; v0.1 fires it anyway', () => {
  for (const [version, expected] of [[1, true], [2, false]]) {
    const room = { code: 't' + version, map: 'shipment', players: new Map(), nemesisVersion: version };
    const bot = { bot: true, pos: [0, 0, 0], ry: 0, deaths: 0 };   // ry 0 faces -z
    room.players.set('b', bot);
    assert.strictEqual(BRAIN.onShotFired(room, 'b', bot, [0, 10]), expected, `v${version} shooting behind`);
    assert.strictEqual(BRAIN.onShotFired(room, 'b', bot, [0, -10]), true, `v${version} shooting ahead`);
    const m = BRAIN.metricsOf(room, 'b');
    assert.strictEqual(m.firedAway, version === 1 ? 1 : 0);
  }
});

test('learning: a death marks the danger spot, the killer spot, a lesson, and scores the plan down', () => {
  const room = { code: 'learn', map: 'shipment', players: new Map(), nemesisVersion: 2, nemesisLearn: true };
  const bot = { bot: true, name: 'B', pos: [5, 0, 5], ry: 0, deaths: 0, hp: 0 };
  const human = { name: 'P', pos: [5, 0, 20], ry: 0, w: 3, hp: 100 };
  room.players.set('b', bot); room.players.set('p', human);
  const m = BRAIN.modelOf(room, 'p');
  bot.ai = { v: 2, life: 0, lifeStart: Date.now() - 4000, eng: { tid: 'p', start: Date.now() - 4000, ctx: 'long', plan: L.PLANS[0], dealt: 0, taken: 0, pDealt: 0, pTaken: 0 } };
  const before = m.bandit.table('long').find((x) => x.id === L.PLANS[0].id).value;
  BRAIN.onDamage(room, 'p', 'b', 100, true);
  assert.ok(m.dangerFor('shipment').at(5, 0, 5) > 0, 'danger at death spot');
  assert.strictEqual(m.threatsFor('shipment').length, 1, 'killer spot remembered');
  assert.strictEqual(m.playerKills, 1);
  assert.ok(m.lessons.length >= 1 && /died/.test(m.lessons[0].text), 'lesson written');
  const after = m.bandit.table('long').find((x) => x.id === L.PLANS[0].id).value;
  assert.ok(after < before, `plan value ${before} -> ${after}`);
});

test('expertise: scripted beginner and expert players are rated correctly within a few minutes', () => {
  const { runOne } = require('../tools/arena-eval.js');
  const realNow = Date.now, realRandom = Math.random;
  try {
    const beg = runOne('districts', 'beginner', { id: 'v0.2', version: 2, learn: true }, 1, 4);
    const exp = runOne('range', 'expert', { id: 'v0.2', version: 2, learn: true }, 1, 4);
    assert.strictEqual(beg.expertise, 'beginner');
    assert.strictEqual(exp.expertise, 'expert');
    for (const r of [beg, exp]) {
      assert.ok(r.stuckPct < 5, `stuck ${r.stuckPct}%`);
      assert.strictEqual(r.firedFacingAway, 0);
      assert.ok(r.sprintPct > 10, 'sprints');
    }
    // matched to the player: full move set vs. an expert, toned down vs. a beginner
    assert.ok(exp.jumpsPerMin > 0 && exp.slidesPerMin > 0 && exp.switchesPerMin > 0, 'expert: jumps, slides, weapon swaps');
    // (vs. a beginner it starts at 'average', so a few early moves are expected before it re-rates)
    assert.ok(beg.slidesPerMin + beg.switchesPerMin < exp.slidesPerMin + exp.switchesPerMin, 'fewer advanced moves vs. a beginner');
  } finally { Date.now = realNow; Math.random = realRandom; }
});
