'use strict';
// Demo target player for the AI view. It counts as a human target (the Nemesis bot aims at it with
// the prediction models), but it is driven by a script with a learnable habit:
//   rhythm - strafes left/right, reversing every ~1.1 s (the bot should learn this)
//   random - reverses at random times (nothing to learn; learned mode should fall back to lead)
// It stays 8-12 m from the nearest bot with line of sight, so the fight is always on camera.
const SPEED = 9;           // walking speed, same as a human player
const NEAR = 8, FAR = 12;  // preferred range to the bot (m)

const fakeWs = { readyState: 3, send() {} };

function addDummy(room, { pickSpawn, playerColor, style = 'rhythm' }) {
  const id = 'd' + Math.floor(Math.random() * 1e6);
  room.players.set(id, {
    ws: fakeWs, dummy: true, name: 'TARGET', color: playerColor,
    pos: pickSpawn(room, true), ry: 0, pitch: 0, hp: 100, kills: 0, deaths: 0, dead: false,
    inGame: room.started, w: 1,
    dm: { style, sign: 1, timer: 0, interval: 1.1, noLos: 0 },
  });
  return id;
}

// Put the dummy 10 m from the bot, at an angle with clear ground and line of sight.
function placeNear(room, d, bot, api) {
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2 + Math.random() * 0.2;
    const x = bot.pos[0] + Math.cos(a) * 10, z = bot.pos[2] + Math.sin(a) * 10;
    if (api.posBlocked(room.map, x, z)) continue;
    if (api.segmentBlocked(room.map, bot.pos[0], bot.pos[1] + 1.6, bot.pos[2], x, 1.4, z)) continue;
    d.pos = [x, 0, z];
    return true;
  }
  return false;
}

function tickDummies(room, dt, api) {
  const bots = [...room.players.values()].filter((q) => q.bot && q.inGame && !q.dead);
  for (const d of room.players.values()) {
    if (!d.dummy || !d.inGame || d.dead || !bots.length) continue;
    const s = d.dm;
    let bot = bots[0], best = Infinity;
    for (const b of bots) {
      const dist = Math.hypot(b.pos[0] - d.pos[0], b.pos[2] - d.pos[2]);
      if (dist < best) { best = dist; bot = b; }
    }
    // keep the fight in view: if the bot cannot see us for 2 s, step back into its sight
    const los = !api.segmentBlocked(room.map, bot.pos[0], bot.pos[1] + 1.6, bot.pos[2], d.pos[0], d.pos[1] + 1.4, d.pos[2]);
    s.noLos = los && best < 25 ? 0 : s.noLos + dt;
    if (s.noLos > 2 || !s.placed) { s.placed = placeNear(room, d, bot, api) || s.placed; s.noLos = 0; continue; }

    s.timer += dt;
    if (s.timer >= s.interval) {
      s.timer = 0;
      s.sign = -s.sign;
      s.interval = s.style === 'random' ? 0.25 + Math.random() * 1.1 : 1.1;
    }
    const rx = (bot.pos[0] - d.pos[0]) / (best || 1), rz = (bot.pos[2] - d.pos[2]) / (best || 1);
    const toward = best > FAR ? 0.6 : best < NEAR ? -0.6 : 0;
    let mx = -rz * s.sign + rx * toward, mz = rx * s.sign + rz * toward;
    const ml = Math.hypot(mx, mz) || 1;
    mx /= ml; mz /= ml;
    const nx = d.pos[0] + mx * SPEED * dt, nz = d.pos[2] + mz * SPEED * dt;
    if (!api.posBlocked(room.map, nx, nz)) { d.pos[0] = nx; d.pos[2] = nz; }
    else { s.sign = -s.sign; s.timer = 0; }   // hit a wall: reverse early
    d.ry = Math.atan2(-rx, -rz);              // face the bot
  }
}

function toggleStyle(room) {
  let style = null;
  for (const d of room.players.values()) {
    if (!d.dummy) continue;
    d.dm.style = d.dm.style === 'rhythm' ? 'random' : 'rhythm';
    d.dm.interval = 1.1;
    style = d.dm.style;
  }
  return style;
}

module.exports = { addDummy, tickDummies, toggleStyle };
