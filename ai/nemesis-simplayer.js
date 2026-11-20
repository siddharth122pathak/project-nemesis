'use strict';
// Scripted human players for the AI demo and the measurement harness. The Nemesis bots treat
// them exactly like real people (they are not bots): they are tracked, predicted, and learned.
//
// Each has a skill level and habits a person would have: a favorite route around the map, a strafe
// rhythm, a preferred weapon per range, and how often they sprint, slide, and jump. They fight back,
// so bots get killed and have something to learn from.
const { navFor } = require('./nemesis-nav.js');
const MOVE = require('./nemesis-move.js');

const SKILLS = {
  beginner: { reaction: 0.65, accuracy: 0.11, strafe: 0.35, sprint: 0.3, slidePerMin: 0, jumpPerMin: 0.5, switchWeapons: false, retreatHp: 0, fov: 0.35 },
  average:  { reaction: 0.42, accuracy: 0.19, strafe: 0.75, sprint: 0.6, slidePerMin: 3, jumpPerMin: 3, switchWeapons: true, retreatHp: 30, fov: 0.0 },
  expert:   { reaction: 0.26, accuracy: 0.29, strafe: 1.0, sprint: 0.85, slidePerMin: 7, jumpPerMin: 6, switchWeapons: true, retreatHp: 45, fov: -0.3 },
};
// human weapons: damage per hit, seconds between shots, best range
const WEAPONS = {
  1: { dmg: 22, rate: 0.13, best: [6, 25] },    // rifle
  2: { dmg: 55, rate: 0.85, best: [0, 8] },     // shotgun
  3: { dmg: 85, rate: 1.35, best: [18, 60] },   // sniper
  4: { dmg: 40, rate: 0.42, best: [4, 18] },    // deagle
};
const SPEED = { walk: 9, sprint: 14, strafe: 7.5, slide: 15 };
const fakeWs = { readyState: 3, send() {} };
const between = (a, b) => a + Math.random() * (b - a);

function rng(seed) { let s = seed >>> 0 || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

function addSimPlayer(room, { pickSpawn, color, skill = 'average', style = 'rhythm', name = 'TARGET', seed = 1, weapon = 1 }) {
  const id = 'd' + Math.floor(Math.random() * 1e6);
  room.players.set(id, {
    ws: fakeWs, dummy: true, name, color, pos: pickSpawn(room, false), ry: 0, pitch: 0, hp: 100, kills: 0, deaths: 0, dead: false,
    inGame: room.started, w: weapon, sim: { skill, style, seed, home: weapon, route: null, routeI: 0, rand: rng(seed), sign: 1, flipAt: 0,
      seenAt: 0, fireAt: 0, slideUntil: 0, slideCd: 0, life: -1, threatId: null, lastSeen: 0 },
  });
  return id;
}

// A fixed loop of 4-5 spots this player keeps walking (a learnable travel habit).
function makeRoute(nav, s, map) {
  const r = rng(s.seed * 7919 + map.length * 31);
  const pts = [];
  for (let i = 0; i < 40 && pts.length < 5; i++) {
    const n = nav.randomNode(r);
    if (n < 0) continue;
    const p = nav.pos(n);
    if (pts.every((q) => Math.hypot(q[0] - p[0], q[2] - p[2]) > 12)) pts.push(p);
  }
  s.loop = pts;
  s.map = map;
}

function tickSims(room, dt, api) {
  if (!room.started) return;
  const nav = navFor(room.map);
  const now = Date.now();
  const bots = [...room.players.entries()].filter(([, q]) => q.bot && q.inGame && !q.dead);
  for (const [id, p] of room.players) {
    if (!p.sim || !p.inGame || p.dead) continue;
    const s = p.sim, sk = SKILLS[s.skill] || SKILLS.average;
    if (s.life !== p.deaths || s.map !== room.map) {
      s.life = p.deaths;
      if (s.map !== room.map || !s.loop) makeRoute(nav, s, room.map);
      MOVE.snap(nav, p);
      p.route = null;
      p.w = s.home;
      s.routeI = Math.floor(s.rand() * s.loop.length);
    }
    // nearest visible bot within the player's view
    let target = null, best = 45;
    const fx = -Math.sin(p.ry || 0), fz = -Math.cos(p.ry || 0);
    for (const [bid, b] of bots) {
      const d = Math.hypot(b.pos[0] - p.pos[0], b.pos[2] - p.pos[2]);
      if (d > best) continue;
      const dot = (fx * (b.pos[0] - p.pos[0]) + fz * (b.pos[2] - p.pos[2])) / (d || 1);
      const shotAt = s.threatId === bid && now - (s.hurtAt || 0) < 2000;
      if (d > 5 && dot < sk.fov && !shotAt) continue;
      if (api.segmentBlocked(room.map, p.pos[0], p.pos[1] + 1.6, p.pos[2], b.pos[0], b.pos[1] + 1.4, b.pos[2])) continue;
      target = [bid, b, d]; best = d;
    }
    p.spr = false;
    if (target) {
      const [bid, b, d] = target;
      if (s.threatId !== bid || now - s.lastSeen > 1500) s.fireAt = now + sk.reaction * 1000 * between(0.8, 1.3);
      s.threatId = bid; s.lastSeen = now;
      p.ry = Math.atan2(-(b.pos[0] - p.pos[0]), -(b.pos[2] - p.pos[2]));
      p.pitch = Math.atan2(b.pos[1] + 1.2 - (p.pos[1] + 1.6), d || 1);
      // weapon for the range
      if (sk.switchWeapons && now > (s.switchCd || 0)) {
        const want = d < 7 ? 2 : d > 24 ? 3 : s.home === 4 ? 4 : 1;
        if (want !== p.w) { p.w = want; s.fireAt = Math.max(s.fireAt, now + 500); s.switchCd = now + 2500; }
      }
      // strafe: steady rhythm or random reversals
      if (now > s.flipAt) {
        s.sign = -s.sign;
        s.flipAt = now + (s.style === 'random' ? between(250, 1300) : 1100 * between(0.92, 1.08));
        if (Math.random() < (sk.jumpPerMin / 60) * 4) MOVE.jump(p, 0.9);
      }
      const rx = (b.pos[0] - p.pos[0]) / (d || 1), rz = (b.pos[2] - p.pos[2]) / (d || 1);
      const lowHp = p.hp < sk.retreatHp;
      const keep = lowHp ? -1 : d > 22 ? 0.6 : d < 5 ? -0.6 : 0;
      if (!lowHp && d > 6 && now > s.slideCd && Math.random() < (sk.slidePerMin / 60) * dt * 6) { s.slideUntil = now + 550; s.slideCd = now + 2500; }
      const sp = now < s.slideUntil ? SPEED.slide : SPEED.strafe;
      let mx = -rz * s.sign * sk.strafe + rx * keep, mz = rx * s.sign * sk.strafe + rz * keep;
      const ml = Math.hypot(mx, mz);
      if (ml > 0.05) { mx /= ml; mz /= ml; if (!MOVE.tryMove(nav, p, mx * sp * dt, mz * sp * dt)) s.sign = -s.sign; }
      // shoot
      const wpn = WEAPONS[p.w] || WEAPONS[1];
      if (now >= s.fireAt) {
        s.fireAt = now + wpn.rate * 1000;
        // harder to hit a bot that is strafing fast, sliding, or in the air
        const lateral = b.ai && b.ai.state === 'engage' ? 0.8 : 1;
        const moving = (b.sl || b.air) ? 0.6 : 1;
        const inBand = d >= wpn.best[0] && d <= wpn.best[1] ? 1 : 0.55;
        const far = Math.max(0.35, 1 - d / 70);   // people miss more at long range
        const chance = sk.accuracy * inBand * lateral * moving * far * (lowHp ? 0.8 : 1);
        api.broadcastRoom(room, { t: 'shot', from: id, origin: [p.pos[0], p.pos[1] + 1.6, p.pos[2]], dir: [rx, Math.sin(p.pitch), rz], w: p.w });
        if (Math.random() < chance) {
          const head = Math.random() < 0.15 * sk.accuracy * 3;
          const fall = p.w === 2 ? Math.max(0.2, 1 - Math.max(0, d - 6) * 0.08) : 1;
          api.applyDamage(room, id, bid, Math.round(wpn.dmg * fall * (head ? 1.6 : 1)), head, p.w);
        }
      }
    } else {
      // walk the habit loop
      if (!p.route || p.route.i >= p.route.pts.length) {
        s.routeI = (s.routeI + 1) % s.loop.length;
        MOVE.routeTo(nav, p, s.loop[s.routeI]);
        s.sprintLeg = Math.random() < sk.sprint;
        if (sk.switchWeapons) p.w = s.home;
      }
      const sp = s.sprintLeg ? SPEED.sprint : SPEED.walk;
      if (p.route) {
        const r = MOVE.follow(nav, p, sp, dt);
        if (r === 'blocked') p.route = null;
        p.spr = s.sprintLeg;
        if (p.moveDir) p.ry = Math.atan2(-p.moveDir[0], -p.moveDir[1]);
        if (s.sprintLeg && now > s.slideCd && Math.random() < (sk.slidePerMin / 60) * dt * 0.5) { s.slideUntil = now + 550; s.slideCd = now + 3000; }
        if (Math.random() < (sk.jumpPerMin / 60) * dt * 0.5) MOVE.jump(p, 0.9);
      }
    }
    MOVE.settle(nav, p, dt);
    p.sl = now < s.slideUntil;
  }
}

function onSimHurt(room, victimId, attackerId) {
  const p = room.players.get(victimId);
  if (p && p.sim) { p.sim.hurtAt = Date.now(); p.sim.threatId = attackerId; }
}

function setStyle(room, style) {
  for (const p of room.players.values()) if (p.sim) { p.sim.style = style || (p.sim.style === 'rhythm' ? 'random' : 'rhythm'); }
  const any = [...room.players.values()].find((p) => p.sim);
  return any ? any.sim.style : null;
}

function cycleSkill(room) {
  const order = ['beginner', 'average', 'expert'];
  let out = null;
  for (const p of room.players.values()) if (p.sim) { p.sim.skill = order[(order.indexOf(p.sim.skill) + 1) % 3]; out = p.sim.skill; }
  return out;
}

module.exports = { addSimPlayer, tickSims, onSimHurt, setStyle, cycleSkill, SKILLS };
