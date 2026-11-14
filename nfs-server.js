// NFS: NEED FOR SEVERANCE — server-side race logic (separate module, mirrors heromode-server.js pattern).
// Everything NFS-specific lives here; server.js only routes rooms with game === 'nfs' into these hooks.
const fs = require('fs');
const path = require('path');

const TRACKS = JSON.parse(fs.readFileSync(path.join(__dirname, 'public', 'nfs', 'tracks.json'), 'utf8'));
const NFS_MAPS = Object.keys(TRACKS);
const SAMPLES = 900;                      // must match public/nfs/nfs-maps.js
const CARS = ['kart-oobi', 'race', 'race-future', 'tractor'];
const ITEM_POOL = ['mushroom', 'mushroom', 'missile', 'missile', 'banana', 'banana', 'star', 'lightning'];
const BOT_NAMES = ['TURBO', 'NITRO', 'BLAZE', 'DRIFT', 'DASH', 'COMET', 'FLASH', 'ZOOM'];
const BOX_RESPAWN_MS = 5000;
const RACE_TIMEOUT_MS = 6 * 60 * 1000;    // race hard stop
const AFTER_FIRST_FINISH_MS = 45 * 1000;  // once someone finishes, everyone has 45s

// ---------- position-based item odds (weights by place fraction 0=leader, 1=last) ----------
// Each item has a base weight + positional bias. Leaders get bananas/single mushroom;
// back of pack gets stars/triple-boost/missiles heavily.
const ITEM_WEIGHTS = {
  //              baseW  leaderBias  trailerBias
  banana:      { base: 20, leader: 35, trailer: 5  },
  mushroom:    { base: 25, leader: 20, trailer: 15 },
  missile:     { base: 18, leader: 5,  trailer: 30 },
  star:        { base: 8,  leader: 2,  trailer: 25 },
  lightning:   { base: 5,  leader: 1,  trailer: 18 },
};

/**
 * Roll an item based on racer's position fraction (0 = 1st place, 1 = last place).
 * Every item is always possible, just weighted.
 */
function rollItem(placeFraction) {
  const f = Math.max(0, Math.min(1, placeFraction));
  const weights = {};
  let total = 0;
  for (const [item, w] of Object.entries(ITEM_WEIGHTS)) {
    const wt = w.base + w.leader * (1 - f) + w.trailer * f;
    weights[item] = wt;
    total += wt;
  }
  let r = Math.random() * total;
  for (const [item, wt] of Object.entries(weights)) {
    r -= wt;
    if (r <= 0) return item;
  }
  return 'mushroom'; // fallback
}

// ---------- shared spline math (identical to client sampleTrack) ----------
function sampleTrack(points, n = SAMPLES) {
  const m = points.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * m;
    const seg = Math.floor(t) % m;
    const u = t - Math.floor(t);
    const p0 = points[(seg - 1 + m) % m], p1 = points[seg], p2 = points[(seg + 1) % m], p3 = points[(seg + 2) % m];
    const u2 = u * u, u3 = u2 * u;
    const c = [];
    for (let a = 0; a < 3; a++) {
      c.push(0.5 * ((2 * p1[a]) + (-p0[a] + p2[a]) * u + (2 * p0[a] - 5 * p1[a] + 4 * p2[a] - p3[a]) * u2 + (-p0[a] + 3 * p1[a] - 3 * p2[a] + p3[a]) * u3));
    }
    out.push(c);
  }
  return out;
}
const SAMPLED = {};
for (const [id, def] of Object.entries(TRACKS)) SAMPLED[id] = sampleTrack(def.points);

function frameAt(mapId, i) {
  const s = SAMPLED[mapId];
  const n = s.length;
  const a = s[(i - 1 + n) % n], b = s[(i + 1) % n];
  const tx = b[0] - a[0], tz = b[2] - a[2];
  const len = Math.hypot(tx, tz) || 1;
  const tan = [tx / len, tz / len];
  return { tan, right: [-tan[1], tan[0]] };   // cross(tan, up) in xz
}

// ---------- curvature precompute (for bot drift detection) ----------
// Curvature at sample i = angle change over a lookahead window (radians per sample).
const CURVATURE = {};
const CURV_WINDOW = 12; // samples to look ahead for curvature estimation
for (const [mapId, samples] of Object.entries(SAMPLED)) {
  const n = samples.length;
  const curv = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const f0 = frameAt(mapId, i);
    const f1 = frameAt(mapId, (i + CURV_WINDOW) % n);
    // angle between tangents
    const dot = f0.tan[0] * f1.tan[0] + f0.tan[1] * f1.tan[1];
    const cross = f0.tan[0] * f1.tan[1] - f0.tan[1] * f1.tan[0];
    curv[i] = Math.abs(Math.atan2(cross, dot)) / CURV_WINDOW;
  }
  CURVATURE[mapId] = curv;
}
// Threshold: if curvature > this, bot should drift
const DRIFT_CURV_THRESHOLD = 0.025; // ~1.4 degrees per sample = meaningful corner

let seq = 1;

// ---------- bot personality generation ----------
function makeBotPersonality() {
  return {
    speedVar: 0.95 + Math.random() * 0.10,      // ±5% max speed variance
    driftAggression: 0.7 + Math.random() * 0.6,  // how eagerly they drift (threshold multiplier)
    itemCaution: 0.3 + Math.random() * 0.7,      // how strategically they use items (higher = smarter)
  };
}

// ---------- lobby helpers ----------
function defaults() { return { map: 'downtown', mode: 'race' }; }

function assignCar(room, wanted) {
  return CARS.includes(wanted) ? wanted : CARS[Math.floor(Math.random() * CARS.length)];
}

function addBot(room) {
  const used = new Set([...room.players.values()].map(p => p.name));
  const name = 'CPU ' + (BOT_NAMES.find(n => !used.has('CPU ' + n)) || 'X' + seq);
  const id = 'nb' + seq++;
  room.players.set(id, {
    ws: { readyState: 3, send() {} }, bot: true, name,
    color: 0xffffff, car: CARS[Math.floor(Math.random() * CARS.length)],
    kills: 0, deaths: 0, hp: 100, dead: false, inGame: false, pos: [0, 0, 0], ry: 0, pitch: 0,
  });
  return id;
}

// ---------- race lifecycle ----------
function startRace(room, api) {
  const mapId = NFS_MAPS.includes(room.map) ? room.map : 'downtown';
  room.map = mapId;
  const def = TRACKS[mapId];
  const samples = SAMPLED[mapId];
  const n = samples.length;
  room.started = true;
  room.matchOver = false;

  const race = room.nfs = {
    mapId, laps: def.laps, width: def.width,
    startedAt: Date.now(), goAt: Date.now() + 3500,
    boxes: [], bananas: new Map(), missiles: new Map(),
    finishOrder: [], endTimer: null, over: false,
    standTick: 0,
  };
  def.boxRows.forEach(() => { for (let k = 0; k < 3; k++) race.boxes.push({ active: true, at: 0 }); });

  const ids = [...room.players.keys()];
  const grid = ids.slice();
  ids.forEach((id, i) => {
    const p = room.players.get(id);
    const back = 6 + Math.floor(i / 2) * 4;
    const si = (n - back) % n;
    const f = frameAt(mapId, si);
    const s = samples[si];
    const lat = (i % 2 === 0 ? -1 : 1) * def.width * 0.22;
    p.inGame = true;
    p.car = p.car || assignCar(room, null);
    const personality = makeBotPersonality();
    p.nfs = {
      pos: [s[0] + f.right[0] * lat, s[1], s[2] + f.right[1] * lat],
      ry: Math.atan2(-f.tan[0], -f.tan[1]),
      speed: 0, lap: 1, samp: si, drift: 0, boost: 0, star: 0, spin: 0,
      item: null, finished: false, finishTime: null,
      // bot fields
      botS: si - SAMPLES, botLap: 1, botSkill: 0.82 + Math.random() * 0.2, botLat: (Math.random() - 0.5) * def.width * 0.4,
      botSpinT: 0, botShockT: 0, botBoostT: 0,
      // NEW: smarter bots
      botPersonality: personality,
      botDrifting: false, botDriftT: 0, botDriftDir: 0,
      botItem: null, botItemCooldown: Date.now() + 6000 + Math.random() * 4000,
      botMissileIncoming: false,
    };
    p.nfs.ry = Math.atan2(-f.tan[0], -f.tan[1]);
  });

  const playersInit = {};
  for (const id of ids) {
    const p = room.players.get(id);
    playersInit[id] = { name: p.name, car: p.car, pos: p.nfs.pos, ry: p.nfs.ry, color: '#fff', bot: !!p.bot };
  }
  for (const [id, p] of room.players) {
    if (p.ws.readyState === 1) {
      p.ws.send(JSON.stringify({ t: 'ninit', map: mapId, laps: def.laps, players: playersInit, grid }));
      p.ws.send(JSON.stringify({ t: 'ncount', ms: race.goAt - Date.now() }));
    }
  }
  console.log(`[room ${room.code}] NFS race started on ${mapId} with ${ids.length} racers`);
}

// progress metric for standings: laps done + fraction of track
function progressOf(p) {
  const s = p.nfs;
  if (!s) return 0;
  if (s.finished) return 1e9 - s.finishPlace;
  return s.lap * SAMPLES + s.samp;
}

function standings(room) {
  return [...room.players.entries()]
    .filter(([, p]) => p.nfs)
    .sort((a, b) => progressOf(b[1]) - progressOf(a[1]))
    .map(([id]) => id);
}

function finish(room, id, api) {
  const p = room.players.get(id);
  const race = room.nfs;
  if (!p?.nfs || p.nfs.finished || race.over) return;
  p.nfs.finished = true;
  p.nfs.finishTime = Date.now() - race.goAt;
  race.finishOrder.push(id);
  p.nfs.finishPlace = race.finishOrder.length;
  api.broadcastRoom(room, { t: 'nfinish', id, name: p.name, place: p.nfs.finishPlace, time: p.nfs.finishTime });
  if (race.finishOrder.length === 1 && !race.endTimer) {
    race.endTimer = setTimeout(() => endRace(room, api), AFTER_FIRST_FINISH_MS);
  }
  const humansLeft = [...room.players.values()].filter(q => !q.bot && q.nfs && !q.nfs.finished).length;
  if (humansLeft === 0) endRace(room, api);
}

function endRace(room, api) {
  const race = room.nfs;
  if (!race || race.over) return;
  race.over = true;
  clearTimeout(race.endTimer);
  const order = standings(room);
  const results = order.map(id => {
    const p = room.players.get(id);
    return { id, name: p.name, time: p.nfs.finished ? p.nfs.finishTime : null };
  });
  api.broadcastRoom(room, { t: 'nover', results });
  console.log(`[room ${room.code}] NFS race over — winner ${results[0]?.name}`);
  setTimeout(() => api.backToLobby(room), 9000);
}

// ---------- message handling ----------
function handle(room, id, msg, api) {
  const p = room.players.get(id);
  if (!p) return;
  const race = room.nfs;
  switch (msg.t) {
    case 'ncar': {
      if (room.started) return;
      if (CARS.includes(msg.car)) { p.car = msg.car; api.broadcastRoom(room, api.lobbyState(room)); }
      break;
    }
    case 'nstate': {
      if (!race || !p.nfs || p.nfs.finished) return;
      if (Array.isArray(msg.pos) && msg.pos.length === 3) p.nfs.pos = msg.pos.map(Number);
      p.nfs.ry = Number(msg.ry) || 0;
      p.nfs.speed = Number(msg.speed) || 0;
      p.nfs.samp = Math.max(0, Math.min(SAMPLES - 1, Number(msg.samp) || 0));
      p.nfs.drift = Number(msg.drift) || 0;
      p.nfs.boost = msg.boost ? 1 : 0;
      p.nfs.star = msg.star ? 1 : 0;
      p.nfs.spin = msg.spin ? 1 : 0;
      const lap = Number(msg.lap) || 1;
      if (lap > p.nfs.lap) {
        p.nfs.lap = lap;
        if (lap > race.laps) finish(room, id, api);
      }
      break;
    }
    case 'nbox': {
      if (!race || p.nfs?.item) return;
      const b = race.boxes[msg.bi];
      if (!b || !b.active) return;
      b.active = false; b.at = Date.now();
      api.broadcastRoom(room, { t: 'nboxstate', bi: msg.bi, active: false });
      // POSITION-BASED ITEM ODDS: weighted roll by place fraction
      const order = standings(room);
      const place = order.indexOf(id) + 1;
      const total = order.length;
      const placeFraction = total <= 1 ? 0 : (place - 1) / (total - 1); // 0=1st, 1=last
      const item = rollItem(placeFraction);
      p.nfs.item = item;
      if (p.ws.readyState === 1) p.ws.send(JSON.stringify({ t: 'nitem', item }));
      break;
    }
    case 'nuse': {
      if (!race || !p.nfs) return;
      const item = p.nfs.item === msg.item ? p.nfs.item : msg.item;
      p.nfs.item = null;
      useItem(room, id, item, msg, api);
      break;
    }
    case 'nslip': {
      if (!race) return;
      if (race.bananas.has(msg.bid)) {
        race.bananas.delete(msg.bid);
        api.broadcastRoom(room, { t: 'nbanana', remove: msg.bid });
      }
      break;
    }
    case 'nmhit': {
      if (race?.missiles.has(msg.mid)) race.missiles.delete(msg.mid);
      break;
    }
    case 'ndone': {
      if (race && p.nfs && p.nfs.lap > race.laps) finish(room, id, api);
      break;
    }
  }
}

function useItem(room, id, item, msg, api) {
  const race = room.nfs;
  const p = room.players.get(id);
  api.broadcastRoom(room, { t: 'nuse', id, item }, id);
  if (item === 'banana' && Array.isArray(msg.pos)) {
    const bid = 'bn' + seq++;
    race.bananas.set(bid, msg.pos.map(Number));
    api.broadcastRoom(room, { t: 'nbanana', add: { bid, pos: msg.pos } });
  } else if (item === 'missile') {
    // target: next racer ahead of the shooter (or leader if shooter is 1st)
    const order = standings(room);
    const myIdx = order.indexOf(id);
    const target = myIdx > 0 ? order[myIdx - 1] : order.find(x => x !== id);
    if (target) {
      const mid = 'ms' + seq++;
      race.missiles.set(mid, { target, from: id });
      api.broadcastRoom(room, { t: 'nmissile', mid, from: id, target });
      // *** MISSILE LOCK WARNING: broadcast nlock to the room ***
      api.broadcastRoom(room, { t: 'nlock', target });
      // Mark bot targets so they can react (use star if they have it)
      const tp = room.players.get(target);
      if (tp?.bot && tp.nfs) tp.nfs.botMissileIncoming = true;
      if (tp?.bot) {
        const sp = p.nfs.pos, dp = tp.nfs.pos;
        const eta = Math.min(6000, (Math.hypot(sp[0] - dp[0], sp[2] - dp[2]) / 30) * 1000 + 600);
        setTimeout(() => {
          if (!race.missiles.has(mid) || race.over || !tp.nfs) return;
          race.missiles.delete(mid);
          if (tp.nfs) tp.nfs.botMissileIncoming = false;
          if (tp.nfs.star) return;
          tp.nfs.botSpinT = 1.2;
          api.broadcastRoom(room, { t: 'nspin', id: target });
        }, eta);
      }
    }
  } else if (item === 'lightning') {
    api.broadcastRoom(room, { t: 'nshock', except: id });
    for (const [oid, o] of room.players) {
      if (oid === id || !o.nfs || o.nfs.finished) continue;
      if (o.bot && !o.nfs.star) { o.nfs.botSpinT = 1.2; o.nfs.botShockT = 3; }
    }
  } else if (item === 'star' && p.bot !== true) {
    p.nfs.star = 1;
    setTimeout(() => { if (p.nfs) p.nfs.star = 0; }, 6000);
  }
  // mushroom: client-side boost, already broadcast via nuse
}

// ---------- bot item AI: purposeful usage based on situation ----------
function botTryUseItem(room, id, p, order, api) {
  const race = room.nfs;
  const s = p.nfs;
  if (!s.botItem || Date.now() < s.botItemCooldown) return;
  const item = s.botItem;
  const place = order.indexOf(id) + 1;
  const total = order.length;
  const personality = s.botPersonality;

  // Decision logic by item type:
  if (item === 'banana') {
    // Drop when in 1st-3rd with someone within ~10m behind
    if (place <= 3) {
      const behind = order[place]; // racer behind us (0-indexed: place is the one behind)
      if (behind) {
        const bp = room.players.get(behind);
        if (bp?.nfs) {
          const dist = Math.hypot(s.pos[0] - bp.nfs.pos[0], s.pos[2] - bp.nfs.pos[2]);
          if (dist < 12) {
            s.botItem = null;
            s.botItemCooldown = Date.now() + 3000;
            const bid = 'bn' + seq++;
            // Drop behind the bot
            const f = frameAt(race.mapId, s.samp);
            const dropPos = [s.pos[0] + f.tan[0] * 2.2, s.pos[1], s.pos[2] + f.tan[1] * 2.2];
            race.bananas.set(bid, dropPos);
            api.broadcastRoom(room, { t: 'nuse', id, item: 'banana' });
            api.broadcastRoom(room, { t: 'nbanana', add: { bid, pos: dropPos } });
            return;
          }
        }
      }
    }
  } else if (item === 'missile') {
    // Fire when someone is ahead and within reasonable range
    if (place > 1) {
      const ahead = order[place - 2]; // racer ahead (0-indexed)
      if (ahead) {
        const ap = room.players.get(ahead);
        if (ap?.nfs) {
          const dist = Math.hypot(s.pos[0] - ap.nfs.pos[0], s.pos[2] - ap.nfs.pos[2]);
          if (dist < 50) { // within missile effective range
            s.botItem = null;
            s.botItemCooldown = Date.now() + 3000;
            // Use the full useItem flow for missile (gets nlock, targeting, etc)
            useItem(room, id, 'missile', {}, api);
            return;
          }
        }
      }
    }
  } else if (item === 'mushroom') {
    // Use on straights (low curvature ahead)
    const curv = CURVATURE[race.mapId];
    const si = ((Math.floor(s.botS) % SAMPLES) + SAMPLES) % SAMPLES;
    const lookAhead = curv[(si + 20) % SAMPLES];
    if (lookAhead < DRIFT_CURV_THRESHOLD * 0.6) {
      s.botItem = null;
      s.botItemCooldown = Date.now() + 2000;
      s.botBoostT = 1.4;
      api.broadcastRoom(room, { t: 'nuse', id, item: 'mushroom' });
      return;
    }
  } else if (item === 'star') {
    // Use when missile incoming OR mid-pack (not leading, not last)
    if (s.botMissileIncoming || (place > 2 && place < total - 1)) {
      s.botItem = null;
      s.botItemCooldown = Date.now() + 2000;
      s.star = 1;
      s.botMissileIncoming = false;
      api.broadcastRoom(room, { t: 'nuse', id, item: 'star' });
      setTimeout(() => { if (s) s.star = 0; }, 6000);
      return;
    }
  } else if (item === 'lightning') {
    // Use when mid-pack or behind (place > 2)
    if (place > 2) {
      s.botItem = null;
      s.botItemCooldown = Date.now() + 5000;
      api.broadcastRoom(room, { t: 'nuse', id, item: 'lightning' });
      api.broadcastRoom(room, { t: 'nshock', except: id });
      for (const [oid, o] of room.players) {
        if (oid === id || !o.nfs || o.nfs.finished) continue;
        if (o.bot && !o.nfs.star) { o.nfs.botSpinT = 1.2; o.nfs.botShockT = 3; }
      }
      return;
    }
  }
}

// ---------- per-tick: bots + state broadcast + standings ----------
function tick(room, dt, api) {
  const race = room.nfs;
  if (!race || race.over) return;
  const now = Date.now();
  const samples = SAMPLED[race.mapId];
  const n = samples.length;
  const raceOn = now >= race.goAt;
  const curv = CURVATURE[race.mapId];

  // hard timeout
  if (now - race.startedAt > RACE_TIMEOUT_MS) return endRace(room, api);

  // box respawns
  race.boxes.forEach((b, bi) => {
    if (!b.active && now - b.at > BOX_RESPAWN_MS) {
      b.active = true;
      api.broadcastRoom(room, { t: 'nboxstate', bi, active: true });
    }
  });

  // bots: advance along the spline with drift, rubber-banding, item AI
  const order = standings(room);
  const totalRacers = order.length;
  for (const [id, p] of room.players) {
    if (!p.bot || !p.nfs || p.nfs.finished) continue;
    const s = p.nfs;
    if (!raceOn) continue;
    if (s.botSpinT > 0) { s.botSpinT -= dt; s.spin = 1; continue; }
    s.spin = 0;
    s.botShockT = Math.max(0, s.botShockT - dt);
    s.botBoostT = Math.max(0, s.botBoostT - dt);

    const place = order.indexOf(id) + 1;
    const personality = s.botPersonality || { speedVar: 1, driftAggression: 1, itemCaution: 0.5 };

    // --- GENTLE RUBBER-BANDING (position-aware, capped) ---
    // Bots in last 25% get up to +8% speed; bots leading a human by a lot get up to -6%
    let rubberBand = 1.0;
    const placeFrac = totalRacers <= 1 ? 0.5 : (place - 1) / (totalRacers - 1);
    if (placeFrac >= 0.75) {
      // Last 25%: boost up to +8%
      rubberBand = 1 + 0.08 * ((placeFrac - 0.75) / 0.25);
    } else if (place === 1) {
      // Leading bot: check distance to nearest human
      let nearestHumanDist = 0;
      for (const [hid, hp] of room.players) {
        if (hp.bot || !hp.nfs || hp.nfs.finished) continue;
        const hDist = Math.abs(progressOf(p) - progressOf(hp));
        nearestHumanDist = Math.max(nearestHumanDist, hDist);
      }
      // If leading by more than 1/4 track, slow down proportionally (cap -6%)
      if (nearestHumanDist > SAMPLES * 0.25) {
        const excess = Math.min(1, (nearestHumanDist - SAMPLES * 0.25) / (SAMPLES * 0.5));
        rubberBand = 1 - 0.06 * excess;
      }
    }

    // --- DRIFT DETECTION + MINI-TURBO ---
    const si0 = ((Math.floor(s.botS) % n) + n) % n;
    const lookSamp = (si0 + 8) % n;
    const curvAhead = curv[lookSamp];
    const driftThreshold = DRIFT_CURV_THRESHOLD * (1 / personality.driftAggression);

    if (!s.botDrifting && curvAhead > driftThreshold && Math.abs(s.speed) > 14) {
      // Enter drift: determine direction from curvature sign
      const f0 = frameAt(race.mapId, si0);
      const f1 = frameAt(race.mapId, (si0 + CURV_WINDOW) % n);
      const cross = f0.tan[0] * f1.tan[1] - f0.tan[1] * f1.tan[0];
      s.botDrifting = true;
      s.botDriftT = 0;
      s.botDriftDir = cross > 0 ? 1 : -1;
    }
    if (s.botDrifting) {
      s.botDriftT += dt;
      s.drift = s.botDriftDir;
      // Exit drift when curvature drops back (or after max 3s)
      if (curvAhead < driftThreshold * 0.5 || s.botDriftT > 3.0) {
        // Mini-turbo boost tiers (matching client: 0.8s → tier1, 1.6s → tier2)
        if (s.botDriftT > 1.6) { s.botBoostT = Math.max(s.botBoostT, 0.9); }
        else if (s.botDriftT > 0.8) { s.botBoostT = Math.max(s.botBoostT, 0.5); }
        s.botDrifting = false;
        s.botDriftT = 0;
        s.botDriftDir = 0;
        s.drift = 0;
      }
    } else {
      s.drift = 0;
    }

    // --- SPEED CALCULATION with personality + rubber-banding ---
    const baseSpeed = 26 * s.botSkill * personality.speedVar;
    let speed = baseSpeed * rubberBand
      * (s.botShockT > 0 ? 0.55 : 1)
      * (s.botBoostT > 0 ? 1.4 : 1)
      * (s.botDrifting ? 0.92 : 1); // slight speed penalty while drifting (like players)

    // --- ITEM PICKUP (bots grab boxes they pass near) ---
    // Grant items to bots periodically (simulates box pickup without exact box collision)
    if (!s.botItem && now > s.botItemCooldown) {
      const botPlaceFrac = totalRacers <= 1 ? 0.5 : (place - 1) / (totalRacers - 1);
      s.botItem = rollItem(botPlaceFrac);
      s.botItemCooldown = now + 7000 + Math.random() * 5000;
    }

    // --- ITEM USAGE AI ---
    botTryUseItem(room, id, p, order, api);

    // --- ADVANCE along track ---
    const a = samples[si0], b2 = samples[(si0 + 1) % n];
    const segLen = Math.max(0.3, Math.hypot(b2[0] - a[0], b2[2] - a[2]));
    s.botS += (speed * dt) / segLen;
    if (s.botS >= n) { s.botS -= n; s.botLap++; s.lap = s.botLap; if (s.botLap > race.laps) { finish(room, id, api); continue; } }
    const si = ((Math.floor(s.botS) % n) + n) % n;
    const f = frameAt(race.mapId, si);
    const sm = samples[si];
    // lateral movement: drift pushes sideways, otherwise gentle wander
    if (s.botDrifting) {
      s.botLat += s.botDriftDir * 3.5 * dt; // slide sideways during drift
    } else {
      s.botLat += (Math.random() - 0.5) * 2 * dt;
    }
    s.botLat = Math.max(-race.width * 0.32, Math.min(race.width * 0.32, s.botLat));
    s.pos = [sm[0] + f.right[0] * s.botLat, sm[1], sm[2] + f.right[1] * s.botLat];
    s.ry = Math.atan2(-f.tan[0], -f.tan[1]);
    s.speed = speed;
    s.samp = si;
    s.boost = s.botBoostT > 0 ? 1 : 0;
  }

  // broadcast states
  const state = {};
  for (const [id, p] of room.players) {
    if (!p.nfs) continue;
    state[id] = { pos: p.nfs.pos, ry: p.nfs.ry, speed: p.nfs.speed, drift: p.nfs.drift, boost: p.nfs.boost, star: p.nfs.star, spin: p.nfs.spin };
  }
  api.broadcastRoom(room, { t: 'nstates', players: state });

  // standings every ~0.5s
  if (++race.standTick % 10 === 0) api.broadcastRoom(room, { t: 'nstand', order });
}

function onLeave(room) {
  // if all humans finished/left mid-race, tick() and removeFromRoom handle cleanup already
}

module.exports = { NFS_MAPS, CARS, defaults, addBot, startRace, handle, tick, onLeave, rollItem };
