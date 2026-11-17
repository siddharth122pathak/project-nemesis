'use strict';
// Glue between the LAB ARENA server's bot loop and the Nemesis aim model.
//
// Original bots rolled a dice for each shot. Nemesis bots aim instead: when a bot decides to shoot
// a human, it predicts where that player will be after a human-like reaction delay, and the shot
// lands on that point. If the player is not there, it misses. So the bot only gets better by
// predicting movement better, not by aiming faster.
const { MODES, PlayerTracker, vec } = require('./nemesis-aim.js');

const TICK_RATE = 20;
const REACTION_S = 0.3;          // decision-to-trigger delay, about human reaction time
const BODY_RADIUS = 0.45;        // matches PLAYER_RADIUS in the client
const AIM_NOISE_PER_M = 0.012;   // aim spread grows with distance (std dev in m per m of range)
const HUD_EVERY_TICKS = 10;      // HUD update twice a second

// Optional movement telemetry (NEMESIS_LOG=path.csv): training and replay data for later milestones.
const LOG = process.env.NEMESIS_LOG ? require('fs').createWriteStream(process.env.NEMESIS_LOG, { flags: 'a' }) : null;
if (LOG) LOG.write('wall_ms,room,tick,player,x,z,bot_x,bot_z,mode\n');

// NEMESIS_NO_BOT_DAMAGE=1: bot hits are scored but deal no damage (used only for demo recordings).
const NO_DAMAGE = process.env.NEMESIS_NO_BOT_DAMAGE === '1';

const START_MODE = MODES.includes(process.env.NEMESIS_MODE) ? process.env.NEMESIS_MODE : 'learned';

function state(room) {
  if (!room.nemesis) room.nemesis = { mode: START_MODE, trackers: new Map(), pending: [], tick: 0 };
  return room.nemesis;
}

function tracker(room, id) {
  const s = state(room);
  if (!s.trackers.has(id)) s.trackers.set(id, new PlayerTracker({ tickRate: TICK_RATE, seconds: REACTION_S }));
  return s.trackers.get(id);
}

function gaussian() {
  const u = Math.random() || 1e-9, v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Every tick: let each human's model watch them, relative to the nearest bot.
function observe(room) {
  const s = state(room);
  s.tick++;
  const bots = [...room.players.values()].filter((q) => q.bot && q.inGame && !q.dead);
  if (!bots.length) return;
  for (const [id, p] of room.players) {
    if (p.bot || p.spectator || !p.inGame || p.dead || !Array.isArray(p.pos)) continue;
    const pos = [p.pos[0], p.pos[2]];
    let near = bots[0], best = Infinity;
    for (const b of bots) {
      const d = vec.len(vec.sub(pos, [b.pos[0], b.pos[2]]));
      if (d < best) { best = d; near = b; }
    }
    tracker(room, id).observe(pos, [near.pos[0], near.pos[2]]);
    if (LOG) LOG.write(`${Date.now()},${room.code},${s.tick},${id},${pos[0].toFixed(3)},${pos[1].toFixed(3)},${near.pos[0].toFixed(3)},${near.pos[2].toFixed(3)},${s.mode}\n`);
  }
}

// Called when a bot's cooldown allows a shot at a human. Queues the shot to fire after the reaction delay.
function planShot(room, botId, bot, targetId, target) {
  const s = state(room);
  const tr = tracker(room, targetId);
  if (!tr.predictor.lastPos) return;
  const aim = tr.aimPoint(s.mode, REACTION_S);
  s.pending.push({ due: s.tick + Math.round(REACTION_S * TICK_RATE), botId, targetId, aim, aimY: target.pos[1] + 1.2, mode: s.mode });
}

// Fire queued shots whose reaction delay has passed and resolve hits against where the player really is.
function resolveShots(room, api) {
  const s = state(room);
  const still = [];
  for (const shot of s.pending) {
    if (shot.due > s.tick) { still.push(shot); continue; }
    const bot = room.players.get(shot.botId), t = room.players.get(shot.targetId);
    if (!bot || !t || bot.dead || t.dead) continue;
    const origin = [bot.pos[0], bot.pos[1] + 1.6, bot.pos[2]];
    const range = Math.hypot(shot.aim[0] - origin[0], shot.aim[1] - origin[2]) || 1;
    const sigma = AIM_NOISE_PER_M * range;
    const aim = [shot.aim[0] + gaussian() * sigma, shot.aim[1] + gaussian() * sigma];
    const aimY = shot.aimY + gaussian() * sigma * 0.5;
    const dx = aim[0] - origin[0], dy = aimY - origin[1], dz = aim[1] - origin[2];
    const L = Math.hypot(dx, dy, dz) || 1;
    api.broadcastRoom(room, { t: 'shot', from: shot.botId, origin, dir: [dx / L, dy / L, dz / L], w: bot.w });
    s.lastShot = { tick: s.tick, botId: shot.botId, targetId: shot.targetId, aim, mode: shot.mode, decidedAt: shot.aim };

    const st = tracker(room, shot.targetId).stats[shot.mode];
    st.shots++;
    const miss = vec.len(vec.sub(aim, [t.pos[0], t.pos[2]]));
    const vertical = Math.abs(aimY - (t.pos[1] + 1.0));
    const blocked = api.segmentBlocked(room.map, origin[0], origin[1], origin[2], t.pos[0], t.pos[1] + 1.4, t.pos[2]);
    if (miss < BODY_RADIUS && vertical < 1.0 && !blocked) {
      st.hits++;
      if (NO_DAMAGE || t.dummy) continue;   // demo/recording: count the hit, keep the target alive
      const head = Math.random() < 0.12;   // same headshot share as the original bots
      const base = api.weaponDamage[bot.w] || 25;
      const fall = Math.max(0.4, 1 - Math.max(0, range - 12) * 0.02);
      api.applyDamage(room, shot.botId, shot.targetId, Math.round(base * fall * (head ? 1.7 : 1)), head, bot.w);
    }
  }
  s.pending = still;
}

// Twice a second, tell each human how well each model is predicting them.
function sendHud(room) {
  const s = state(room);
  if (s.tick % HUD_EVERY_TICKS) return;
  for (const [id, p] of room.players) {
    if (p.bot || p.spectator || !p.ws || p.ws.readyState !== 1 || !s.trackers.has(id)) continue;
    const tr = s.trackers.get(id);
    p.ws.send(JSON.stringify({
      t: 'nemesis', mode: s.mode, horizon: REACTION_S,
      err: tr.scoreboard.err, stats: tr.stats,
      updates: tr.predictor.updates, warm: tr.predictor.warmedUp, choice: tr.choice,
    }));
  }
}

// AI view: every other tick, send observers what the first bot sees and predicts about its target.
function sendPov(room, api) {
  const s = state(room);
  if (s.tick % 2) return;
  const watchers = [...room.players.values()].filter((p) => p.spectator && p.ws && p.ws.readyState === 1);
  if (!watchers.length) return;
  const botEntry = [...room.players.entries()].find(([, q]) => q.bot && q.inGame);
  if (!botEntry) return;
  const [botId, bot] = botEntry;
  let target = null, best = Infinity;
  for (const [id, p] of room.players) {
    if (p.bot || p.spectator || !p.inGame || p.dead || !s.trackers.has(id)) continue;
    const d = Math.hypot(p.pos[0] - bot.pos[0], p.pos[2] - bot.pos[2]);
    if (d < best) { best = d; target = [id, p]; }
  }
  const dummy = [...room.players.values()].find((p) => p.dummy);
  const msg = { t: 'nemesispov', botId, botPos: bot.pos, botDead: !!bot.dead, mode: s.mode, horizon: REACTION_S,
    botState: bot.ai ? bot.ai.state : 'patrol', botGoal: bot.ai && bot.ai.goal ? bot.ai.goal : null,
    demo: !!dummy, style: dummy ? dummy.dm.style : null };
  if (target) {
    const [tid, t] = target;
    const tr = s.trackers.get(tid);
    msg.los = !api.segmentBlocked(room.map, bot.pos[0], bot.pos[1] + 1.6, bot.pos[2], t.pos[0], t.pos[1] + 1.4, t.pos[2]);
    Object.assign(msg, {
      targetId: tid, targetName: t.name, targetPos: t.pos, predictions: tr.predictor.lastPos ? tr.predictAll(REACTION_S) : null,
      err: tr.scoreboard.err, stats: tr.stats, updates: tr.predictor.updates, warm: tr.predictor.warmedUp,
      choice: tr.choice,
    });
  }
  if (s.lastShot && s.tick - s.lastShot.tick < 12) msg.lastShot = s.lastShot;
  const data = JSON.stringify(msg);
  for (const w of watchers) w.ws.send(data);
}

function tick(room, api) {
  resolveShots(room, api);
  sendHud(room);
  sendPov(room, api);
}

function cycleMode(room) {
  const s = state(room);
  s.mode = MODES[(MODES.indexOf(s.mode) + 1) % MODES.length];
  return s.mode;
}

function resetModels(room) { state(room).trackers.clear(); }

// Where the learned model expects player `id` to be `seconds` from now ([x, z]), or null if unknown.
function predictPosition(room, id, seconds) {
  const tr = state(room).trackers.get(id);
  if (!tr || !tr.predictor.lastPos) return null;
  return tr.predictAll(seconds).learned;
}

module.exports = { observe, planShot, tick, cycleMode, resetModels, predictPosition, REACTION_S, TICK_RATE };
