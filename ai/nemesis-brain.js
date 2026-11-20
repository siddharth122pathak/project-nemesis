'use strict';
// Nemesis bot brain (v0.2): runs every server tick for every bot.
//
// v0.2 bots navigate with A* on every map (stairs, jumps, drops), sprint, slide, jump, switch
// weapons, and learn each human opponent DURING the match (see nemesis-learner.js):
//   every tick   the player's coordinates feed the movement model and the aim predictor
//   every 1 s    travel heat map and movement habits update
//   every 1.5 s  the current fight plan is scored from damage dealt vs. taken
//   every kill and death  the plan is scored, and the death spot / killer spot are remembered
//   every 5 s    the player's expertise is re-rated, and the bot switches its play to match
//
// room.nemesisVersion === 1 runs the unchanged v0.1 bot (baseline for the measurements).
const TACTICS_V1 = require('./legacy/nemesis-tactics-v1.js');
const { navFor } = require('./nemesis-nav.js');
const MOVE = require('./nemesis-move.js');
const L = require('./nemesis-learner.js');
const NEMESIS = require('./nemesis-bot.js');

const BOT_SIGHT = 50;
const SPEED = { walk: 7, sprint: 10.5, strafe: 5.5, slide: 13 };
const FOV_COS = Math.cos((65 * Math.PI) / 180);   // 130 degree view
const rand = () => Math.random();
const between = (a, b) => a + Math.random() * (b - a);

const DEFAULT_VERSION = Number(process.env.NEMESIS_VERSION) === 1 ? 1 : 2;
const DEFAULT_LEARN = process.env.NEMESIS_LEARN !== '0';

// ---------------------------------------------------------------- room state
function brainOf(room) {
  if (!room.brain) {
    room.brain = {
      version: room.nemesisVersion || DEFAULT_VERSION,
      learn: room.nemesisLearn !== undefined ? room.nemesisLearn : DEFAULT_LEARN,
      models: new Map(),   // human id -> OpponentModel
      metrics: new Map(),  // bot id -> metrics
      tick: 0,
    };
  }
  return room.brain;
}
const legacy = (room) => brainOf(room).version === 1;

function modelOf(room, id) {
  const b = brainOf(room);
  if (!b.models.has(id)) b.models.set(id, new L.OpponentModel(id, Date.now()));
  return b.models.get(id);
}

function metricsOf(room, bid) {
  const b = brainOf(room);
  if (!b.metrics.has(bid)) {
    b.metrics.set(bid, {
      kills: 0, deaths: 0, events: [], ttk: [], ttd: [], shots: 0, hits: 0, facingErr: 0, firedAway: 0, cancelled: 0,
      stuck: 0, moveSecs: 0, cells: new Set(), sprintSecs: 0, slides: 0, jumps: 0, switches: 0, aliveSecs: 0,
    });
  }
  return b.metrics.get(bid);
}

// ---------------------------------------------------------------- helpers
function face(bot, x, z) {
  const s = bot.ai;
  if (s && s.aimLock && Date.now() < s.aimLock.until) { x = s.aimLock.x; z = s.aimLock.z; }
  const dx = x - bot.pos[0], dz = z - bot.pos[2];
  if (Math.abs(dx) + Math.abs(dz) > 1e-3) bot.ry = Math.atan2(-dx, -dz);
}

function pitchTo(bot, t) {
  const d = Math.hypot(t.pos[0] - bot.pos[0], t.pos[2] - bot.pos[2]) || 1;
  bot.pitch = Math.atan2(t.pos[1] + 1.2 - (bot.pos[1] + 1.6), d);
}

function canNotice(bot, id, o, dist) {
  if (dist < 6) return true;
  const s = bot.ai;
  if (s && s.eng && s.eng.tid === id && Date.now() - s.eng.lastSeen < 1500) return true;
  if (s && Date.now() - (s.hurtAt || 0) < 1500) return true;
  const fx = -Math.sin(bot.ry || 0), fz = -Math.cos(bot.ry || 0);
  return fx * (o.pos[0] - bot.pos[0]) / dist + fz * (o.pos[2] - bot.pos[2]) / dist > FOV_COS;
}

function visible(room, api, a, b) {
  return !api.segmentBlocked(room.map, a.pos[0], a.pos[1] + 1.6, a.pos[2], b.pos[0], b.pos[1] + 1.4, b.pos[2]);
}

function findTarget(room, api, bid, bot, alive, notice) {
  let target = null, tDist = BOT_SIGHT;
  for (const [oid, o] of alive) {
    if (oid === bid) continue;
    if (room.mode === 'heroes' && o.team && o.team === bot.team) continue;
    if (room.mode === 'heroes' && !o.bot && !o.hero) continue;
    const d = Math.hypot(o.pos[0] - bot.pos[0], o.pos[2] - bot.pos[2]);
    if (d >= tDist || !notice(bot, oid, o, d)) continue;
    if (!visible(room, api, bot, o)) continue;
    target = [oid, o]; tDist = d;
  }
  return target ? { id: target[0], p: target[1], dist: tDist } : null;
}

// ---------------------------------------------------------------- shooting (shared by v1 and v2)
function maybeShoot(room, api, bid, bot, target, prof) {
  const now = Date.now();
  if (now < (bot.aiNextShot || 0) || now < (bot.switchUntil || 0)) return;
  const t = target.p;
  bot.aiNextShot = now + (api.cooldowns[bot.w] || 500) * (prof ? prof.cooldownMul : 1) * (0.9 + Math.random() * 0.4);
  if (!t.bot) {
    NEMESIS.planShot(room, bid, bot, target.id, t, prof
      ? { reaction: prof.reaction, aimNoise: prof.aimNoise, onPlanned: (aim, r) => lockAim(bot, aim, r * 1000 + 60) } : {});
    return;
  }
  // bot vs. bot: the original LAB ARENA dice roll (unchanged)
  const dx = t.pos[0] - bot.pos[0], dz = t.pos[2] - bot.pos[2];
  const origin = [bot.pos[0], bot.pos[1] + 1.6, bot.pos[2]];
  const len = Math.hypot(dx, t.pos[1] + 1.2 - origin[1], dz) || 1;
  const hitChance = Math.max(0.15, Math.min(0.8, 0.8 - target.dist * 0.011));
  const hit = Math.random() < hitChance;
  const err = hit ? 0 : 0.12;
  const dir = [dx / len + (Math.random() - 0.5) * err, (t.pos[1] + 1.2 - origin[1]) / len + (Math.random() - 0.5) * err, dz / len + (Math.random() - 0.5) * err];
  api.broadcastRoom(room, { t: 'shot', from: bid, origin, dir, w: bot.w });
  if (hit) {
    const head = Math.random() < 0.12;
    const fall = Math.max(0.4, 1 - Math.max(0, target.dist - 12) * 0.02);
    api.applyDamage(room, bid, target.id, Math.round((api.weaponDamage[bot.w] || 25) * fall * (head ? 1.7 : 1)), head, bot.w);
  }
}

// ---------------------------------------------------------------- learning bookkeeping
function learnerTick(room, dt, b) {
  const humans = [], bots = [];
  for (const [id, p] of room.players) {
    if (!p.inGame || p.dead || p.spectator) continue;
    if (p.bot) bots.push(p); else if (Array.isArray(p.pos)) humans.push([id, p]);
  }
  const second = b.tick % 20 === 0, five = b.tick % 100 === 0;
  for (const [id, p] of humans) {
    let near = null, best = Infinity;
    for (const q of bots) { const d = Math.hypot(q.pos[0] - p.pos[0], q.pos[2] - p.pos[2]); if (d < best) { best = d; near = q; } }
    const m = modelOf(room, id);
    m.observe(p, near ? near.pos : null, dt);
    if (second) m.learnTick(room.map, p.pos, Date.now());
    if (five && b.learn) m.assessSkill(Date.now());
  }
}

function profileFor(room, tid) {
  const b = brainOf(room);
  if (!b.learn || !tid || !b.models.has(tid)) return L.PROFILES.average;
  return L.PROFILES[b.models.get(tid).level] || L.PROFILES.average;
}

function startEngagement(room, bot, target, prof) {
  const b = brainOf(room), s = bot.ai, now = Date.now();
  const m = target.p.bot ? null : modelOf(room, target.id);
  const ctx = m ? m.context(target.p.w) : 'long';
  let plan;
  if (b.learn && m) {
    plan = m.bandit.choose(ctx, prof.approaches, rand);
  } else {
    const opts = L.PLANS.filter((p) => prof.approaches.includes(p.approach));
    plan = opts[Math.floor(Math.random() * opts.length)];
  }
  s.eng = { tid: target.id, start: now, lastSeen: now, plan, ctx, dealt: 0, taken: 0, pDealt: 0, pTaken: 0, lastPartial: now };
  s.canShootAt = Math.max(s.canShootAt || 0, now + prof.reaction * 1000 + between(80, 200));
  s.state = 'engage';
  s.until = now + between(2500, 5000);
  // weapon for the plan's range (deathmatch only; gun game locks weapons)
  if (prof.switchWeapons && room.mode !== 'gungame' && room.mode !== 'heroes') {
    const want = L.WEAPON_FOR_RANGE[plan.range];
    if (want && want !== bot.w) {
      bot.w = want;
      bot.switchUntil = now + 600;
      metricsOf(room, s.bid).switches++;
    }
  }
}

function endEngagement(room, bot, outcome) {
  const b = brainOf(room), s = bot.ai;
  if (!s || !s.eng) return;
  const e = s.eng;
  const m = b.models.get(e.tid);
  if (b.learn && m && outcome === 'lost') {
    m.bandit.update(e.ctx, e.plan.id, (e.dealt - e.taken) / 100, 0.5);
  }
  s.eng = null;
}

// Called by the server whenever anyone damages anyone (after health is reduced).
function onDamage(room, attackerId, victimId, dmg, killed) {
  const b = brainOf(room);
  const a = room.players.get(attackerId), v = room.players.get(victimId);
  if (!a || !v) return;
  const now = Date.now();
  // bot dealt damage
  if (a.bot && a.ai && a.ai.eng && a.ai.eng.tid === victimId) { a.ai.eng.dealt += dmg; a.ai.eng.pDealt += dmg; }
  // bot took damage
  if (v.bot) {
    v.ai = v.ai || {};
    v.ai.hurtAt = now;
    v.ai.lastAttacker = attackerId;
    if (v.ai.eng && v.ai.eng.tid === attackerId) { v.ai.eng.taken += dmg; v.ai.eng.pTaken += dmg; }
    if (!a.bot) { const m = modelOf(room, attackerId); m.damageToBots += dmg; }
  }
  if (!killed) return;
  if (a.bot && !v.bot) {
    // bot killed a human
    const mt = metricsOf(room, attackerId);
    const e = a.ai && a.ai.eng && a.ai.eng.tid === victimId ? a.ai.eng : null;
    const ttk = e ? (now - e.start) / 1000 : null;
    mt.kills++;
    mt.events.push({ t: now, type: 'kill' });
    if (ttk !== null) mt.ttk.push(ttk);
    const m = modelOf(room, victimId);
    m.botKills++;
    if (ttk !== null) m.botTtk.push(ttk);
    if (b.learn && e) {
      m.bandit.update(e.ctx, e.plan.id, L.fightReward('kill', ttk));
      m.note(now, `killed ${v.name} in ${ttk.toFixed(1)} s with plan ${e.plan.id} \u2192 plan scored up`);
    }
    if (a.ai) a.ai.eng = null;
  }
  if (v.bot) {
    // a bot died
    const mt = metricsOf(room, victimId);
    const e = v.ai && v.ai.eng && v.ai.eng.tid === attackerId ? v.ai.eng : null;
    const ttd = e ? (now - e.start) / 1000 : (now - (v.ai.lifeStart || now)) / 1000;
    mt.deaths++;
    mt.events.push({ t: now, type: 'death' });
    mt.ttd.push(ttd);
    if (!a.bot) {
      const m = modelOf(room, attackerId);
      const dist = Math.hypot(a.pos[0] - v.pos[0], a.pos[2] - v.pos[2]);
      m.playerKills++;
      m.playerTtk.push(ttd);
      m.playerKillRanges.push(dist);
      m.weaponUse[a.w] = (m.weaponUse[a.w] || 0) + 1;
      if (b.learn) {
        m.addThreat(room.map, a.pos);
        m.dangerFor(room.map).add(v.pos[0], v.pos[1], v.pos[2], 2, now);
        m.dangerFor(room.map).add(a.pos[0], a.pos[1], a.pos[2], 1, now);
        if (e) m.bandit.update(e.ctx, e.plan.id, L.fightReward('death', ttd));
        const wname = { 1: 'rifle', 2: 'shotgun', 3: 'sniper', 4: 'deagle' }[a.w] || 'gun';
        m.note(now, `died to ${a.name} at ${dist.toFixed(0)} m (${wname}) after ${ttd.toFixed(1)} s` +
          (e ? `; plan ${e.plan.id} scored down` : '') + '; will avoid that spot and pre-aim it');
      }
    }
    if (v.ai) v.ai.eng = null;
  }
}

// ---------------------------------------------------------------- v1: unchanged v0.1 bot
const v1Api = (api) => ({ posBlocked: api.posBlocked, segmentBlocked: api.segmentBlocked, pickSpawn: api.pickSpawn,
  predict: (room, id, sec) => NEMESIS.predictPosition(room, id, sec) });

function tickV1(room, dt, api, bid, bot, alive) {
  if (bot.pos[1] > 0) bot.pos[1] = Math.max(0, bot.pos[1] - 9 * dt);
  const target = findTarget(room, api, bid, bot, alive, (b, id, o, d) => TACTICS_V1.canNotice(b, id, o, d));
  const move = TACTICS_V1.update(room, bid, bot, target ? [target.id, target.p] : null, dt, v1Api(api));
  if (target && move.shoot) maybeShoot(room, api, bid, bot, target, null);
  return { state: bot.ai ? bot.ai.state : 'patrol', moving: bot.ai && !['hold', 'engage'].includes(bot.ai.state) };
}

// ---------------------------------------------------------------- v2
function freshV2(bot, bid) {
  return { v: 2, bid, state: 'patrol', until: 0, life: bot.deaths, lifeStart: Date.now(), strafe: 1, strafeUntil: 0,
    canShootAt: 0, eng: null, seen: null, slideUntil: 0, slideCd: 0, sprint: false, lastPos: bot.pos.slice(),
    lastCheck: Date.now(), stuckN: 0, searches: 0, hurtAt: 0 };
}

function dangerCost(room, tid) {
  const b = brainOf(room);
  if (!b.learn || !tid || !b.models.has(tid)) return null;
  const dm = b.models.get(tid).dangerFor(room.map);
  if (!dm.m.size) return null;
  const nav = navFor(room.map);
  return (n) => { const p = nav.pos(n); return dm.at(p[0], p[1], p[2]) * 0.6; };
}

function go(room, bot, goal, tid) {
  const nav = navFor(room.map);
  return MOVE.routeTo(nav, bot, goal, dangerCost(room, tid));
}

// a spot near the bot that the threat cannot see
function coverSpot(room, api, bot, threat) {
  const nav = navFor(room.map);
  let best = null, bestScore = Infinity;
  for (let i = 0; i < 28; i++) {
    const a = Math.random() * Math.PI * 2, r = between(2.5, 10);
    const n = nav.nearest(bot.pos[0] + Math.cos(a) * r, bot.pos[1], bot.pos[2] + Math.sin(a) * r, 2);
    if (n < 0) continue;
    const p = nav.pos(n);
    if (Math.abs(p[1] - bot.pos[1]) > 3) continue;
    if (!api.segmentBlocked(room.map, threat[0], threat[1] + 1.6, threat[2], p[0], p[1] + 1.4, p[2])) continue;
    const dT = Math.hypot(p[0] - threat[0], p[2] - threat[2]);
    if (dT < 5) continue;
    const score = Math.hypot(p[0] - bot.pos[0], p[2] - bot.pos[2]) + nav.tight[n] * -0.3;
    if (score < bestScore) { bestScore = score; best = p; }
  }
  return best;
}

// a spot with a clear view of `spot` at roughly the wanted range
function viewSpot(room, api, bot, spot, band, maxR = 8) {
  const nav = navFor(room.map);
  let best = null, bestScore = Infinity;
  for (let i = 0; i < 28; i++) {
    const a = Math.random() * Math.PI * 2, r = between(1, maxR);
    const n = nav.nearest(bot.pos[0] + Math.cos(a) * r, bot.pos[1], bot.pos[2] + Math.sin(a) * r, 2);
    if (n < 0) continue;
    const p = nav.pos(n);
    if (api.segmentBlocked(room.map, p[0], p[1] + 1.6, p[2], spot[0], spot[1] + 1.4, spot[2])) continue;
    const dT = Math.hypot(p[0] - spot[0], p[2] - spot[2]);
    const score = Math.abs(dT - (band[0] + band[1]) / 2) + r * 0.25;
    if (score < bestScore) { bestScore = score; best = p; }
  }
  return best;
}

// a reachable spot to the side of the target (flank), at the plan's range
function flankSpot(room, bot, t, band) {
  const nav = navFor(room.map);
  const ang = Math.atan2(bot.pos[2] - t.pos[2], bot.pos[0] - t.pos[0]);
  const side = Math.random() < 0.5 ? 1 : -1;
  for (let i = 0; i < 10; i++) {
    const a = ang + side * between(1.1, 1.9), r = between(band[0], band[1]);
    const n = nav.nearest(t.pos[0] + Math.cos(a) * r, t.pos[1], t.pos[2] + Math.sin(a) * r, 2);
    if (n >= 0) return nav.pos(n);
  }
  return null;
}

function patrolGoal(room, bot, tid) {
  const b = brainOf(room), nav = navFor(room.map);
  if (b.learn) {
    // go where the opponent usually travels
    const ids = tid ? [tid] : [...b.models.keys()];
    for (const id of ids) {
      const m = b.models.get(id);
      if (!m) continue;
      const heat = m.heatFor(room.map);
      if (heat.total() > 6 && Math.random() < 0.7) {
        const c = heat.sample(rand);
        if (c) { const n = nav.nearest(c[0] + between(-2, 2), c[1], c[2] + between(-2, 2), 4); if (n >= 0) return nav.pos(n); }
      }
    }
  }
  const n = nav.randomNode(rand);
  return n >= 0 ? nav.pos(n) : null;
}

function enter(s, state, ms) { s.state = state; s.until = Date.now() + ms; }

function tickV2(room, dt, api, bid, bot, alive) {
  const b = brainOf(room), nav = navFor(room.map), now = Date.now();
  if (!bot.ai || bot.ai.v !== 2 || bot.ai.life !== bot.deaths || bot.ai.map !== room.map) {
    const hurtAt = bot.ai ? bot.ai.hurtAt : 0;
    bot.ai = freshV2(bot, bid);
    bot.ai.map = room.map;
    bot.ai.hurtAt = hurtAt;
    MOVE.snap(nav, bot);
    bot.route = null;
  }
  const s = bot.ai;
  const target = findTarget(room, api, bid, bot, alive, canNotice);
  const tid = target ? target.id : s.eng ? s.eng.tid : s.seen ? s.seen.tid : null;
  const prof = profileFor(room, tid);
  let speed = SPEED.walk, wantMove = false, shoot = false;
  s.sprint = false;

  // --- engagement start / partial learning every 1.5 s ---
  if (target) {
    if (!s.eng || s.eng.tid !== target.id || now - s.eng.lastSeen > 6000) { endEngagement(room, bot, 'lost'); startEngagement(room, bot, target, prof); }
    s.eng.lastSeen = now;
    s.seen = { tid: target.id, pos: target.p.pos.slice(), at: now };
    if (!['engage', 'cover'].includes(s.state)) enter(s, 'engage', between(2500, 5000));
  } else if (s.eng && now - s.eng.lastSeen > 6000) {
    endEngagement(room, bot, 'lost');
  }
  if (s.eng && b.learn && now - s.eng.lastPartial > 1500) {
    const m = b.models.get(s.eng.tid);
    if (m && (s.eng.pDealt || s.eng.pTaken)) m.bandit.update(s.eng.ctx, s.eng.plan.id, (s.eng.pDealt - s.eng.pTaken) / 100, 0.25);
    s.eng.pDealt = 0; s.eng.pTaken = 0; s.eng.lastPartial = now;
  }
  if (s.eng && b.models.has(s.eng.tid)) b.models.get(s.eng.tid).engagedSeconds += dt;
  const plan = s.eng ? s.eng.plan : null;
  const band = plan ? L.RANGES[plan.range] : [9, 20];

  // --- lost sight: hunt where the model predicts the target went ---
  if (!target && s.seen && ['engage', 'peek'].includes(s.state) && now - s.seen.at > 700) {
    const guess = NEMESIS.predictPosition(room, s.seen.tid, 1.0);
    const goal = guess ? [guess[0], s.seen.pos[1], guess[1]] : s.seen.pos;
    enter(s, 'hunt', 8000);
    s.searches = 0;
    if (!go(room, bot, goal, s.seen.tid)) go(room, bot, s.seen.pos, s.seen.tid);
  }

  switch (s.state) {
    case 'engage': {
      const t = target ? target.p : { pos: s.seen ? s.seen.pos : bot.pos };
      const dx = t.pos[0] - bot.pos[0], dz = t.pos[2] - bot.pos[2], dist = Math.hypot(dx, dz) || 1;
      const rx = dx / dist, rz = dz / dist;
      if (plan && plan.approach === 'flank' && dist > band[1] + 2 && !s.flanked) {
        const f = flankSpot(room, bot, t, band);
        s.flanked = true;
        if (f && go(room, bot, f, tid)) { enter(s, 'flank', 6000); break; }
      }
      // strafe on an irregular rhythm, keep the plan's range
      if (now > s.strafeUntil) {
        s.strafe = Math.random() < 0.75 ? -s.strafe : s.strafe;
        s.strafeUntil = now + between(350, 1200);
        if (Math.random() < prof.jump && MOVE.jump(bot, 0.9)) metricsOf(room, bid).jumps++;
      }
      const keep = dist > band[1] ? 0.9 : dist < band[0] ? -0.9 : plan && plan.approach === 'push' ? 0.25 : 0;
      let mx = -rz * s.strafe + rx * keep, mz = rx * s.strafe + rz * keep;
      const ml = Math.hypot(mx, mz) || 1; mx /= ml; mz /= ml;
      // slide in when pushing toward the plan's range
      if (keep > 0.5 && now > s.slideCd && Math.random() < prof.slide * dt * 2) {
        s.slideUntil = now + 550; s.slideCd = now + 3000; metricsOf(room, bid).slides++;
      }
      const sp = now < s.slideUntil ? SPEED.slide : SPEED.strafe;
      if (!MOVE.tryMove(nav, bot, mx * sp * dt, mz * sp * dt)) { s.strafe = -s.strafe; s.strafeUntil = now + between(300, 800); }
      face(bot, t.pos[0], t.pos[2]);
      if (target) pitchTo(bot, target.p);
      shoot = !!target && now >= s.canShootAt;
      const hurt = bot.hp < 50 && now - (s.hurtAt || 0) < 400;
      if (now > s.until || (hurt && Math.random() < 0.6)) {
        const c = coverSpot(room, api, bot, t.pos);
        if (c && go(room, bot, c, tid)) enter(s, 'cover', 4500);
        else s.until = now + between(2000, 4000);
      }
      break;
    }
    case 'flank': {
      speed = SPEED.sprint; s.sprint = true; wantMove = true;
      const r = MOVE.follow(nav, bot, speed, dt);
      if (bot.moveDir) face(bot, bot.pos[0] + bot.moveDir[0], bot.pos[2] + bot.moveDir[1]);
      if (r !== 'moving' || now > s.until) enter(s, 'engage', between(2500, 4500));
      break;
    }
    case 'cover': {
      speed = SPEED.sprint; s.sprint = true; wantMove = true;
      const r = MOVE.follow(nav, bot, speed, dt);
      if (bot.moveDir) face(bot, bot.pos[0] + bot.moveDir[0], bot.pos[2] + bot.moveDir[1]);
      if (r !== 'moving' || now > s.until) enter(s, 'hold', between(800, 1800));
      break;
    }
    case 'hold': {
      if (s.seen) face(bot, s.seen.pos[0], s.seen.pos[2]);
      if (target && target.dist < 7) { enter(s, 'engage', between(2000, 4000)); break; }
      if (now > s.until) {
        const spot = s.seen ? s.seen.pos : bot.pos;
        const p = viewSpot(room, api, bot, spot, band, 7);
        if (p && go(room, bot, p, tid)) { enter(s, 'peek', 3000); s.canShootAt = now + 150; }
        else enter(s, 'patrol', 0);
      }
      break;
    }
    case 'peek': {
      wantMove = true;
      const r = MOVE.follow(nav, bot, SPEED.walk, dt);
      if (s.seen) face(bot, s.seen.pos[0], s.seen.pos[2]);
      if (r !== 'moving' || now > s.until) enter(s, 'hunt', 0);
      break;
    }
    case 'hunt':
    case 'search': {
      speed = SPEED.sprint; s.sprint = true; wantMove = true;
      const r = bot.route ? MOVE.follow(nav, bot, speed, dt) : 'arrived';
      if (bot.moveDir) face(bot, bot.pos[0] + bot.moveDir[0], bot.pos[2] + bot.moveDir[1]);
      if (r !== 'moving' || now > s.until) {
        if (s.searches >= 3 || !s.seen) { enter(s, 'patrol', 0); bot.route = null; break; }
        s.searches++;
        // search around the last sighting; with learning, prefer where this player usually goes
        let goal = null;
        const m = b.learn && s.seen ? b.models.get(s.seen.tid) : null;
        if (m) {
          const near = m.heatFor(room.map).top(30).filter((c) => Math.hypot(c[0] - s.seen.pos[0], c[2] - s.seen.pos[2]) < 25);
          if (near.length) { const c = near[Math.floor(Math.random() * Math.min(5, near.length))]; goal = [c[0], c[1], c[2]]; }
        }
        if (!goal) { const a = Math.random() * Math.PI * 2, d = between(3, 8); goal = [s.seen.pos[0] + Math.cos(a) * d, s.seen.pos[1], s.seen.pos[2] + Math.sin(a) * d]; }
        enter(s, 'search', 5000);
        go(room, bot, goal, s.seen.tid);
      }
      break;
    }
    default: {   // patrol
      s.flanked = false;
      if (!bot.route || now > s.until || bot.route.i >= bot.route.pts.length) {
        const g = patrolGoal(room, bot, null);
        s.until = now + 20000;
        if (g) go(room, bot, g, null);
        s.sprintLeg = prof === L.PROFILES.beginner ? Math.random() < 0.3 : Math.random() < 0.8;
      }
      speed = s.sprintLeg ? SPEED.sprint : SPEED.walk;
      s.sprint = s.sprintLeg;
      wantMove = true;
      const r = MOVE.follow(nav, bot, speed, dt);
      if (r === 'arrived') bot.route = null;
      // check the spots this player killed it from (pre-aim), otherwise look where it walks
      let looked = false;
      if (b.learn && prof.preaim) {
        for (const [id, m] of b.models) {
          for (const th of m.threatsFor(room.map)) {
            const d = Math.hypot(th[0] - bot.pos[0], th[2] - bot.pos[2]);
            if (d < 22 && d > 3 && !api.segmentBlocked(room.map, bot.pos[0], bot.pos[1] + 1.6, bot.pos[2], th[0], th[1] + 1.4, th[2])) {
              face(bot, th[0], th[2]); looked = true; break;
            }
          }
          if (looked) break;
        }
      }
      if (!looked && bot.moveDir) face(bot, bot.pos[0] + bot.moveDir[0], bot.pos[2] + bot.moveDir[1]);
    }
  }

  MOVE.settle(nav, bot, dt);
  if (shoot && target) maybeShoot(room, api, bid, bot, target, prof);
  bot.spr = s.sprint && wantMove;
  bot.sl = now < s.slideUntil;
  bot.state = s.state;

  // stuck detection: wanted to move but went nowhere for 1 s -> replan
  if (now - s.lastCheck >= 1000) {
    const moved = Math.hypot(bot.pos[0] - s.lastPos[0], bot.pos[2] - s.lastPos[2]);
    if (wantMove && moved < 0.3) {
      s.stuckN++;
      if (s.stuckN >= 2) { MOVE.snap(nav, bot); bot.route = null; s.until = 0; if (s.state !== 'patrol') enter(s, 'patrol', 0); s.stuckN = 0; }
      else if (bot.route && bot.route.goal) go(room, bot, bot.route.goal, tid);
    } else s.stuckN = 0;
  }
  return { state: s.state, moving: wantMove };
}

// ---------------------------------------------------------------- main entry
function tickBots(room, dt, api) {
  const b = brainOf(room);
  b.tick++;
  learnerTick(room, dt, b);
  const alive = [...room.players.entries()].filter(([, q]) => q.inGame && !q.dead && !q.spectator);
  for (const [bid, bot] of room.players) {
    if (!bot.bot || !bot.inGame || bot.dead) continue;
    const mt = metricsOf(room, bid);
    const before = bot.pos.slice();
    const r = b.version === 1 ? tickV1(room, dt, api, bid, bot, alive) : tickV2(room, dt, api, bid, bot, alive);
    // metrics (same rules for v1 and v2)
    mt.aliveSecs += dt;
    const mv = Math.hypot(bot.pos[0] - before[0], bot.pos[2] - before[2]);
    if (r.moving) {
      mt.moveSecs += dt;
      mt._win = (mt._win || 0) + mv; mt._winT = (mt._winT || 0) + dt;
      if (mt._winT >= 1) {
        if (mt._win < 0.3) { mt.stuck += mt._winT; mt.stuckBy = mt.stuckBy || {}; mt.stuckBy[r.state] = (mt.stuckBy[r.state] || 0) + mt._winT; }
        mt._win = 0; mt._winT = 0;
      }
    }
    if (bot.spr) mt.sprintSecs += dt;
    mt.cells.add(`${Math.floor(bot.pos[0] / 2)},${Math.floor(bot.pos[2] / 2)},${Math.round(bot.pos[1] / 2.5)}`);
  }
}

// Facing check at the moment a delayed shot fires (called from nemesis-bot.js).
function onShotFired(room, bid, bot, aim) {
  const b = brainOf(room), mt = metricsOf(room, bid);
  const fx = -Math.sin(bot.ry || 0), fz = -Math.cos(bot.ry || 0);
  const dx = aim[0] - bot.pos[0], dz = aim[1] - bot.pos[2], d = Math.hypot(dx, dz) || 1;
  const angle = (Math.acos(Math.max(-1, Math.min(1, (fx * dx + fz * dz) / d))) * 180) / Math.PI;
  if (angle > 30) mt.facingErr++;
  if (b.version === 1) { mt.shots++; if (angle > 30) mt.firedAway++; return true; }   // v0.1 fired regardless (the bug)
  if (angle > 35) { mt.cancelled++; return false; }       // v0.2: turned away during the reaction delay
  if (angle > 30) mt.firedAway++;
  bot.ry = Math.atan2(-dx, -dz);
  mt.shots++;
  return true;
}

function onShotHit(room, bid) { metricsOf(room, bid).hits++; }

// Lock the bot's facing toward its aim point for the reaction delay of a queued shot.
function lockAim(bot, aim, ms) {
  if (bot.ai && bot.ai.v === 2) bot.ai.aimLock = { until: Date.now() + ms, x: aim[0], z: aim[1] };
}

// Everything the AI view needs to show what this bot is thinking.
function povExtras(room, botId, targetId) {
  const b = brainOf(room), bot = room.players.get(botId);
  if (!bot) return {};
  const s = bot.ai || {};
  const out = {
    version: b.version, learn: b.learn,
    botState: s.state || 'patrol', botRy: bot.ry || 0, botPitch: bot.pitch || 0,
    botFlags: { spr: !!bot.spr, sl: !!bot.sl, air: !!bot.air, w: bot.w },
    botGoal: bot.route && bot.route.goal ? [bot.route.goal[0], bot.route.goal[2]] : null,
    route: bot.route ? bot.route.pts.slice(bot.route.i, bot.route.i + 40).map((p) => [+p[0].toFixed(1), +p[1].toFixed(1), +p[2].toFixed(1)]) : [],
    plan: s.eng ? s.eng.plan.id : null,
    lifeSecs: s.lifeStart ? Math.round((Date.now() - s.lifeStart) / 1000) : 0,
  };
  const mt = b.metrics.get(botId);
  if (mt) out.score = { kills: mt.kills, deaths: mt.deaths, lives: mt.deaths + 1 };
  const m = targetId ? b.models.get(targetId) : null;
  if (m) {
    out.expertise = { level: m.level, score: m.skillScore, confidence: m.confidence };
    out.habits = m.summary();
    out.lessons = m.lessons.slice(0, 4).map((l) => l.text);
    if (s.eng) out.planTable = m.bandit.table(s.eng.ctx).sort((x, y) => y.value - x.value).slice(0, 4);
    if (!b.learnedSentAt || Date.now() - b.learnedSentAt >= 1000) {
      b.learnedSentAt = Date.now();
      out.learned = {
        heat: m.heatFor(room.map).top(80).map((c) => c.map((v) => +v.toFixed(2))),
        danger: m.dangerFor(room.map).top(30).map((c) => c.map((v) => +v.toFixed(2))),
        threats: m.threatsFor(room.map).map((p) => p.map((v) => +v.toFixed(2))),
      };
    }
  }
  return out;
}

function resetLearning(room) { const b = brainOf(room); b.models.clear(); }

module.exports = { tickBots, onDamage, onShotFired, onShotHit, lockAim, povExtras, resetLearning, brainOf, modelOf, metricsOf, legacy };
