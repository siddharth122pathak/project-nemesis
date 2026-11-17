'use strict';
// Nemesis bot movement: a small state machine so the bot fights like a player instead of a turret.
//
//   patrol  no enemy known: walk between spawn areas
//   engage  enemy in sight: strafe on an irregular rhythm, keep the weapon's preferred range,
//           shoot only after a human-like reaction delay; every few seconds (or when hurt) break off
//   cover   run to a nearby spot the enemy cannot see (no shooting)
//   hold    wait in cover for a moment (reload / reset)
//   peek    step out to a spot with a view of where the enemy was, pre-aimed
//   hunt    lost sight: go to where the aim model PREDICTS the enemy went, not where they are
//   search  look around the predicted spot, then give up and patrol
//
// The bot never reads positions it cannot see: hunt uses the last sighting plus a forecast.
const SPEED = 5.2;                                              // m/s, slower than a sprinting human
const BANDS = { 1: [9, 18], 2: [3, 8], 3: [16, 30], 4: [7, 14] };  // preferred range per weapon (m)
const rand = (a, b) => a + Math.random() * (b - a);

function freshState(bot) {
  return { state: 'patrol', until: 0, goal: null, strafe: 1, strafeUntil: 0, canShootAt: 0,
    lastHp: bot.hp, deaths: bot.deaths, seen: null, sawTarget: false, targetId: null, searches: 0 };
}

function aiState(bot) {
  if (!bot.ai || bot.ai.deaths !== bot.deaths) bot.ai = freshState(bot);   // fresh brain after a respawn
  return bot.ai;
}

// Move p toward goal [x, z]; slides around obstacles by trying angled directions.
function steer(room, p, goal, speed, dt, api, arriveDist = 0.8) {
  const dx = goal[0] - p.pos[0], dz = goal[1] - p.pos[2];
  const d = Math.hypot(dx, dz);
  if (d < arriveDist) return { reached: true, moved: false };
  const base = Math.atan2(dz, dx), step = Math.min(d, speed * dt);
  for (const off of [0, 0.5, -0.5, 1.0, -1.0, 1.6, -1.6, 2.3, -2.3]) {
    const a = base + off, nx = p.pos[0] + Math.cos(a) * step, nz = p.pos[2] + Math.sin(a) * step;
    if (!api.posBlocked(room.map, nx, nz)) { p.pos[0] = nx; p.pos[2] = nz; return { reached: false, moved: true, dir: [Math.cos(a), Math.sin(a)] }; }
  }
  return { reached: false, moved: false };
}

function face(bot, x, z) {
  const dx = x - bot.pos[0], dz = z - bot.pos[2];
  if (Math.abs(dx) + Math.abs(dz) > 1e-3) bot.ry = Math.atan2(-dx, -dz);
}

function walkable(room, a, x, z, api) {
  return !api.posBlocked(room.map, x, z) && !api.segmentBlocked(room.map, a.pos[0], 1.0, a.pos[2], x, 1.0, z);
}

// A nearby spot the threat cannot see, reachable in a straight line.
function findCover(room, bot, threat, api) {
  let best = null, bestScore = Infinity;
  for (let i = 0; i < 32; i++) {
    const a = Math.random() * Math.PI * 2, r = rand(2, 8);
    const x = bot.pos[0] + Math.cos(a) * r, z = bot.pos[2] + Math.sin(a) * r;
    if (!walkable(room, bot, x, z, api)) continue;
    if (!api.segmentBlocked(room.map, threat[0], threat[1] + 1.6, threat[2], x, 1.4, z)) continue;
    const dT = Math.hypot(x - threat[0], z - threat[2]);
    if (dT < 4) continue;
    const score = r + Math.max(0, 10 - dT) * 0.4;
    if (score < bestScore) { bestScore = score; best = [x, z]; }
  }
  return best;
}

// A nearby spot with a clear view of the threat's (last known) position, inside the weapon's range.
function findPeek(room, bot, threat, band, api) {
  let best = null, bestScore = Infinity;
  for (let i = 0; i < 32; i++) {
    const a = Math.random() * Math.PI * 2, r = rand(1.5, 6);
    const x = bot.pos[0] + Math.cos(a) * r, z = bot.pos[2] + Math.sin(a) * r;
    if (!walkable(room, bot, x, z, api)) continue;
    if (api.segmentBlocked(room.map, x, 1.6, z, threat[0], threat[1] + 1.4, threat[2])) continue;
    const dT = Math.hypot(x - threat[0], z - threat[2]);
    const score = Math.abs(dT - (band[0] + band[1]) / 2) + r * 0.3;
    if (score < bestScore) { bestScore = score; best = [x, z]; }
  }
  return best;
}

// Bots have a field of view: they notice enemies in front of them (about 130 degrees), anyone very
// close, anyone they were already fighting, and whoever just shot them. No 360-degree radar.
function canNotice(bot, id, other, dist) {
  if (dist < 6) return true;
  const s = bot.ai;
  if (s && s.targetId === id && s.seen && Date.now() - s.seen.at < 1500) return true;
  if (s && Date.now() - (s.hurtAt || 0) < 1500) return true;
  const fx = -Math.sin(bot.ry || 0), fz = -Math.cos(bot.ry || 0);
  const dx = (other.pos[0] - bot.pos[0]) / dist, dz = (other.pos[2] - bot.pos[2]) / dist;
  return fx * dx + fz * dz > Math.cos((65 * Math.PI) / 180);
}

function enter(s, state, now, ms, goal = null) {
  s.state = state;
  s.until = now + ms;
  s.goal = goal;
}

// One tick of movement. target = [id, player] if an enemy is in sight, else null.
// Returns { shoot } - whether the bot may fire this tick.
function update(room, bid, bot, target, dt, api) {
  const s = aiState(bot);
  const now = Date.now();
  const hurt = bot.hp < s.lastHp;
  s.lastHp = bot.hp;
  if (hurt) s.hurtAt = now;
  const band = BANDS[bot.w] || BANDS[1];

  if (target) {
    const [tid, t] = target;
    const gap = s.seen ? now - s.seen.at : Infinity;
    if (s.targetId !== tid || gap > 1000) s.canShootAt = Math.max(s.canShootAt, now + rand(350, 650));   // reaction to a new sighting
    s.sawTarget = true;
    s.targetId = tid;
    s.seen = { tid, pos: t.pos.slice(), at: now };
    if (s.state !== 'engage' && s.state !== 'cover') enter(s, 'engage', now, rand(2500, 5000));
  } else if (s.sawTarget && now - s.seen.at > 700) {
    // Lost sight for 0.7 s (not just a pillar flicker): chase the model's forecast of where they
    // went, not their real position.
    s.sawTarget = false;
    if (s.state === 'engage' || s.state === 'peek') {
      const guess = api.predict(room, s.seen.tid, 1.0);
      const goal = guess && !api.posBlocked(room.map, guess[0], guess[1]) ? guess : [s.seen.pos[0], s.seen.pos[2]];
      enter(s, 'hunt', now, 7000, goal);
      s.searches = 0;
    }
  }

  switch (s.state) {
    case 'engage': {
      if (!target && !s.seen) { enter(s, 'patrol', now, 0); return { shoot: false }; }
      const t = target ? target[1] : { pos: s.seen.pos };   // brief loss of sight: keep fighting toward the last spot
      const dx = t.pos[0] - bot.pos[0], dz = t.pos[2] - bot.pos[2], dist = Math.hypot(dx, dz) || 1;
      const rx = dx / dist, rz = dz / dist;
      if (now > s.strafeUntil) { s.strafe = Math.random() < 0.75 ? -s.strafe : s.strafe; s.strafeUntil = now + rand(400, 1300); }
      const keep = dist > band[1] ? 0.8 : dist < band[0] ? -0.8 : 0;
      const mx = -rz * s.strafe + rx * keep, mz = rx * s.strafe + rz * keep;
      const r = steer(room, bot, [bot.pos[0] + mx * 2, bot.pos[2] + mz * 2], SPEED * 0.75, dt, api, 0.05);
      if (!r.moved) { s.strafe = -s.strafe; s.strafeUntil = now + rand(400, 900); }
      face(bot, t.pos[0], t.pos[2]);
      if (now > s.until || (hurt && Math.random() < 0.5)) {
        const c = findCover(room, bot, t.pos, api);
        if (c) enter(s, 'cover', now, 4000, c);
        else s.until = now + rand(2000, 4000);
      }
      return { shoot: !!target && now >= s.canShootAt };
    }
    case 'cover': {
      const r = steer(room, bot, s.goal, SPEED, dt, api);
      if (s.seen) face(bot, s.seen.pos[0], s.seen.pos[2]);
      if (r.reached || now > s.until || !r.moved) enter(s, 'hold', now, rand(900, 2000), s.goal);
      return { shoot: false };
    }
    case 'hold': {
      if (target && Math.hypot(target[1].pos[0] - bot.pos[0], target[1].pos[2] - bot.pos[2]) < 6) {
        enter(s, 'engage', now, rand(2000, 4000));   // being flanked in cover: fight back
        return { shoot: now >= s.canShootAt };
      }
      if (now > s.until) {
        const threat = s.seen ? s.seen.pos : bot.pos;
        const p = findPeek(room, bot, threat, band, api);
        enter(s, 'peek', now, 3000, p || [threat[0], threat[2]]);
        s.canShootAt = now + 200;   // pre-aimed at the last known spot
      }
      return { shoot: false };
    }
    case 'peek': {
      const r = steer(room, bot, s.goal, SPEED * 0.9, dt, api);
      if (s.seen) face(bot, s.seen.pos[0], s.seen.pos[2]);
      if (r.reached || now > s.until || !r.moved) {
        const guess = s.seen ? api.predict(room, s.seen.tid, 1.0) : null;
        enter(s, 'hunt', now, 7000, guess || (s.seen ? [s.seen.pos[0], s.seen.pos[2]] : null));
        s.searches = 0;
      }
      return { shoot: false };
    }
    case 'hunt':
    case 'search': {
      if (!s.goal) { enter(s, 'patrol', now, 0); return { shoot: false }; }
      const r = steer(room, bot, s.goal, SPEED, dt, api);
      if (r.dir) face(bot, bot.pos[0] + r.dir[0], bot.pos[2] + r.dir[1]);
      if (r.reached || !r.moved || now > s.until) {
        if (s.searches >= 3) { enter(s, 'patrol', now, 0); return { shoot: false }; }
        s.searches++;
        const a = Math.random() * Math.PI * 2, d = rand(3, 7);
        enter(s, 'search', now, 4000, [s.goal[0] + Math.cos(a) * d, s.goal[1] + Math.sin(a) * d]);
      }
      return { shoot: false };
    }
    default: {   // patrol
      if (!s.goal || now > s.until) {
        const p = api.pickSpawn(room, true);
        enter(s, 'patrol', now, 15000, [p[0] + rand(-3, 3), p[2] + rand(-3, 3)]);
      }
      const r = steer(room, bot, s.goal, SPEED * 0.8, dt, api, 1.5);
      if (r.dir) face(bot, bot.pos[0] + r.dir[0], bot.pos[2] + r.dir[1]);
      if (r.reached || !r.moved) s.until = 0;
      return { shoot: false };
    }
  }
}

module.exports = { update, steer, aiState, canNotice, BANDS };
