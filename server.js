// LAB ARENA — room-based multiplayer server
// Flow: create/join room by 4-digit code -> lobby -> host starts -> match -> back to lobby.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');
const HERO = require('./heromode-server.js');
const NFS = require('./nfs-server.js');   // NFS racing game module (self-contained)
const FIGHT = require('./fight-server.js');   // FRAME TRAP fighter relay (public/tekken): rooms with game === 'tekken'
const NEMESIS = require('./ai/nemesis-bot.js');   // Nemesis Engine: bots that predict where humans will be
const DUMMY = require('./ai/nemesis-dummy.js');   // Nemesis demo: scripted target player for the AI view
const TACTICS = require('./ai/nemesis-tactics.js');   // Nemesis bot movement: cover, peek, hunt

const PORT = process.env.PORT || 8090;
// Listener interface: this computer only by default. LAN parties opt in with HOST=0.0.0.0 (npm run start:lan);
// the Docker image sets HOST=0.0.0.0 because the container's port publish is the boundary there.
const HOST = process.env.HOST || '127.0.0.1';
const TICK_RATE = 20;
const MAX_HP = 100;
const DAMAGE = 25;
const RESPAWN_MS = 3000;
const WIN_KILLS = Number(process.env.WIN_KILLS) || 20;
const MATCH_END_LOBBY_MS = 8000;
const ROOM_CAP = 10;

const PLAYER_COLORS = [0xff4444, 0x44aaff, 0x44ff88, 0xffcc33, 0xcc66ff, 0xff8844, 0x33ffee, 0xff66aa, 0x99ff44, 0x8899ff];

// per-map spawn points — must match the layouts in public/maps.js
const MAP_SPAWNS = {
  monastery: [
    [-98, 6.05, 30], [-104, 6.05, 42], [-92, 6.05, 40], [-95, 6.05, 33], [-101, 6.05, 36],   // west spawn room
    [98, 6.05, -30], [104, 6.05, -42], [92, 6.05, -40], [95, 6.05, -33], [101, 6.05, -36],   // east spawn room
  ],
  cathedral: [
    [-20, 0, -6], [-20, 0, 6],            // narthex corners
    [-10, 0, -6.5], [-10, 0, 6.5],        // side aisles west
    [0, 0, -6.5], [0, 0, 6.5],            // side aisles mid
    [8, 0, -12], [8, 0, 12],              // transept arms
    [17, 0.6, -6], [17, 0.6, 6],          // chancel flanks (raised)
    [-16, 0, 0], [2, 0, 0],               // center aisle
    [17.5, 0, 12.5], [17.5, 0, -12.5],    // sacristy / crypt chapel
    [25, 0, 10], [25, 0, -10],            // ambulatory
    [-20, 3.4, -4],                       // choir loft
  ],
  districts: [
    [-25, 0, -25], [25, 0, -25], [-25, 0, 25], [25, 0, 25],
    [0, 0, -35], [0, 0, 35], [-35, 0, 0], [35, 0, 0],
    [-55, 0, -40], [55, 0, 40], [-40, 0, 55], [40, 0, -55],
    [-45, 5.1, 0], [45, 5.1, 0],
    [0, 5.6, -45], [0, 5.6, 45],
  ],
  shipment: [
    [-8, 0, -11], [11, 0, -11], [-8, 0, 11], [11, 0, 11],
    [-9, 0, 0], [13, 0, 0],
    [-4.5, 0, -13], [4.5, 0, 12.5],
    [2, 2.7, -13.4], [-2, 2.7, 13.4],   // on the north/south fence-line singles
    [-12.1, 2.7, 6.7],                   // on the west cluster's climbable single
  ],
  forge: [
    [-33, 0, -4], [-33, 0, 4], [-30, 0, 0], [-28, 0, -8], [-28, 0, 8],
    [33, 0, -4], [33, 0, 4], [30, 0, 0], [28, 0, -8], [28, 0, 8],
  ],
  village: [
    [0, 0, 28], [-3, 0, 26], [3, 0, 26], [-6, 0, 30], [6, 0, 30],
    [0, 0, -28], [-3, 0, -26], [3, 0, -26], [-6, 0, -30], [6, 0, -30],
  ],
  shrine: [
    [-31, 0, -4], [-31, 0, 4], [-29, 0, 0], [-26, 0, -6], [-26, 0, 6],
    [31, 0, -4], [31, 0, 4], [29, 0, 0], [26, 0, -6], [26, 0, 6],
  ],
  sanctum: [
    [-30, 0, -4], [-30, 0, 4], [-28, 0, 0], [-25, 0, -8], [-25, 0, 8],
    [30, 0, -4], [30, 0, 4], [28, 0, 0], [25, 0, -8], [25, 0, 8],
  ],
  blackout: [
    [-24, 0, -5],
    [-24, 0, 5],
    [-6, 0, -5],
    [-6, 0, 5],
    [-22, 0, -12],
    [20, 0, -5],
    [20, 0, 5],
    [26, 0, -12],
    [14, 0, 15],
    [26, 0, 15],
  ],
  killhouse: [
    [-18, 0, -10], [18, 0, -10], [-18, 0, 10], [18, 0, 10],
    [-13, 0, 0], [13, 0, 0],
    [0, 3.8, 11.4], [0, 3.8, -11.4],   // catwalks
    [0, 3.3, 0],                        // house second floor
  ],
  range: [
    [-8, 0, -24], [-11, 0, -21], [-5, 0, -19],     // N spawn finger
    [1, 0, 27], [-2, 0, 24], [4, 0, 25],           // S spawn finger
    [-19, 1.6, -14], [-15, 1.6, -12],              // range plateau
    [-18, 0, 11], [-12, 0, 20],                    // west lane
    [16, 0, 18], [25, 0, 8],                       // office / east lane
    [14, 0, -8],                                   // NE armory
    [-3, 6.6, 3],                                  // watchtower deck
    [20, 3.6, 13],                                 // office second floor
    [14, 3.3, -5],                                 // rock hill top
  ],
};
const MAP_IDS = Object.keys(MAP_SPAWNS);
const DEFAULT_MAP = 'districts';

// ---------- static file server ----------
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.glb': 'model/gltf-binary', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg',
};

const server = http.createServer((req, res) => {
  let urlPath;
  try { urlPath = decodeURIComponent(req.url.split('?')[0]); } catch { res.writeHead(400); return res.end(); }   // bad %-escape: no crash
  if (urlPath === '/') urlPath = '/index.html';
  if (urlPath.endsWith('/')) urlPath += 'index.html';   // /cod/ -> /cod/index.html
  // serve only public/ and node_modules/ (a bare __dirname prefix check let ../ reach .git/, server sources, roblox/)
  const nm = urlPath.startsWith('/node_modules/');
  const baseDir = path.join(__dirname, nm ? 'node_modules' : 'public');
  const filePath = path.join(baseDir, nm ? urlPath.slice('/node_modules'.length) : urlPath);
  if (!filePath.startsWith(baseDir + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------- rooms ----------
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });   // ws default is 100 MiB; every client message is < 1 KB
const rooms = new Map(); // code -> room
let nextId = 1;

function makeCode() {
  let code;
  do { code = String(Math.floor(1000 + Math.random() * 9000)); } while (rooms.has(code));
  return code;
}

function pickSpawn(room, groundOnly = false) {
  let pts = MAP_SPAWNS[room?.map] || MAP_SPAWNS[DEFAULT_MAP];
  if (groundOnly) pts = pts.filter(p => p[1] === 0);   // bots can't climb — elevated spawns sink them into geometry
  return pts[Math.floor(Math.random() * pts.length)].slice();
}

// ---------- bots ----------
// collision AABBs per map (generated from the client maps via __dumpObstacles)
const MAP_AABBS = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'mapdata.json'), 'utf8')); }
  catch { console.warn('[bots] mapdata.json missing — bots will see through walls'); return {}; }
})();
// Ramp data: inclined surfaces for height calculation
const MAP_RAMPS = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'rampdata.json'), 'utf8')); }
  catch { return {}; }
})();

// Get ground height at position, including ramps
function groundHeightAtServer(map, x, z) {
  let h = 0;
  const rampList = MAP_RAMPS[map];
  if (rampList) {
    for (const r of rampList) {
      if (x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ) {
        let t;
        if (r.axis === 'z') {
          t = Math.max(0, Math.min(1, (z - r.minZ) / (r.maxZ - r.minZ)));
        } else {
          t = Math.max(0, Math.min(1, (x - r.minX) / (r.maxX - r.minX)));
        }
        const rampY = r.y0 + t * (r.y1 - r.y0);
        h = Math.max(h, rampY);
      }
    }
  }
  return h;
}

// segment vs AABB (slab method) — true if the segment a->b is blocked
function segmentBlocked(map, ax, ay, az, bx, by, bz) {
  const boxes = MAP_AABBS[map];
  if (!boxes) return false;
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  for (const [x0, y0, z0, x1, y1, z1] of boxes) {
    let t0 = 0, t1 = 1, miss = false;
    for (const [o, d, mn, mx] of [[ax, dx, x0, x1], [ay, dy, y0, y1], [az, dz, z0, z1]]) {
      if (Math.abs(d) < 1e-9) { if (o < mn || o > mx) { miss = true; break; } continue; }
      let a = (mn - o) / d, b = (mx - o) / d;
      if (a > b) [a, b] = [b, a];
      t0 = Math.max(t0, a); t1 = Math.min(t1, b);
      if (t0 > t1) { miss = true; break; }
    }
    if (!miss && t1 > 0 && t0 < 1) return true;
  }
  return false;
}

// point (with player radius) inside any AABB at standing height?
function posBlocked(map, x, z) {
  const boxes = MAP_AABBS[map];
  if (!boxes) return false;
  for (const [x0, y0, z0, x1, y1, z1] of boxes) {
    if (y0 > 1.6 || y1 < 0.3) continue;   // ignore boxes above the head / below the feet
    if (x + 0.45 > x0 && x - 0.45 < x1 && z + 0.45 > z0 && z - 0.45 < z1) return true;
  }
  return false;
}

const BOT_NAMES = ['ATLAS', 'VIPER', 'GHOST', 'JUGGERNAUT', 'ROOK', 'HAVOC', 'NOMAD', 'CIPHER'];
const BOT_WEAPON_DMG = { 1: 25, 2: 60, 3: 70, 4: 45 };       // per burst/shot vs body, pre-falloff
const BOT_COOLDOWN = { 1: 380, 2: 1100, 3: 1900, 4: 700 };   // slower than humans — they're fair, not aimbots
const fakeWs = { readyState: 3, send() {} };
let nextBotId = 1;

function addBot(room) {
  const used = new Set([...room.players.values()].map(p => p.name));
  const name = 'BOT ' + (BOT_NAMES.find(n => !used.has('BOT ' + n)) || 'X' + nextBotId);
  const id = 'b' + nextBotId++;
  room.players.set(id, {
    ws: fakeWs, bot: true, name,
    color: PLAYER_COLORS[room.players.size % PLAYER_COLORS.length],
    pos: pickSpawn(room, true), ry: 0, pitch: 0,
    hp: MAX_HP, kills: 0, deaths: 0, dead: false, inGame: room.started, w: 1 + Math.floor(Math.random() * 4),
    aiWaypoint: null, aiNextShot: 0, aiStuck: 0,
  });
  return id;
}

// ---------- damage (shared by player hits and bot shots) ----------
// gun game: kill ladder of weapon ids; finish the ladder to win
const GUNGAME_LADDER = [4, 2, 1, 3, 4, 2, 1, 3, 4, 2, 1, 3]; // deagle->shotgun->rifle->sniper x3
function ladderWeapon(p) { return GUNGAME_LADDER[Math.min(p.ladder || 0, GUNGAME_LADDER.length - 1)]; }

function applyDamage(room, killerId, targetId, dmg, head, weapon, weaponName) {
  const killer = room.players.get(killerId);
  const target = room.players.get(targetId);
  if (!killer || !target || target.dead || !target.inGame || room.matchOver) return;
  if (HERO.friendlyFire(room, killer, target)) return;   // hero mode: no team damage
  if (room.mode === 'heroes' && !target.hero) return;     // still on hero select — untouchable
  // POWER BLOCK: 80% mitigation against frontal damage; blocking enough empowers the punch
  if (target.blocking && Date.now() < target.blockUntil && Array.isArray(killer.pos) && Array.isArray(target.pos)) {
    const fx = -Math.sin(target.ry || 0), fz = -Math.cos(target.ry || 0);   // yaw 0 faces -z
    const dx = killer.pos[0] - target.pos[0], dz = killer.pos[2] - target.pos[2];
    const len = Math.hypot(dx, dz) || 1;
    if ((fx * dx + fz * dz) / len > 0) {                  // attacker within the frontal 180°
      const mitigated = Math.round(dmg * 0.8);
      dmg = Math.max(1, dmg - mitigated);
      target.blockedAcc = (target.blockedAcc || 0) + mitigated;
      if (!target.empowered && target.blockedAcc >= 80) {
        target.empowered = true;
        broadcastRoom(room, { t: 'empowered', id: targetId });
      }
    }
  }
  // BREAKER passive (the best defense): ability hits grant temporary overhealth
  if (room.mode === 'heroes' && killer.hero === 'breaker' && (weaponName === 'HAYMAKER' || weaponName === 'QUAKE DROP')) {
    const cap = (killer.maxHp || MAX_HP) + 100;
    killer.hp = Math.min(cap, killer.hp + 25);
    broadcastRoom(room, { t: 'damage', target: killerId, hp: killer.hp, from: killerId });
  }
  target.hp -= dmg;
  target.lastHurt = Date.now();
  if (target.hp > 0) {
    broadcastRoom(room, { t: 'damage', target: targetId, hp: target.hp, from: killerId });
    return;
  }
  target.hp = 0;
  target.dead = true;
  target.diedAt = Date.now();
  target.deaths++;
  killer.kills++;
  killer.hp = Math.min(killer.maxHp || MAX_HP, killer.hp + 25);   // kill reward
  broadcastRoom(room, { t: 'damage', target: killerId, hp: killer.hp, from: killerId });
  broadcastRoom(room, { t: 'death', target: targetId, from: killerId, fromName: killer.name, targetName: target.name, headshot: !!head, weapon: Number(weapon) || 0, weaponName: weaponName || undefined });
  broadcastRoom(room, { t: 'scores', scores: roomScores(room) });

  // win condition: gun game ladder or deathmatch kill count
  let won = false;
  if (room.mode === 'gungame') {
    killer.ladder = (killer.ladder || 0) + 1;
    if (killer.ladder >= GUNGAME_LADDER.length) won = true;
    else {
      killer.w = ladderWeapon(killer);
      if (!killer.bot) killer.ws.send(JSON.stringify({ t: 'forceweapon', w: killer.w, ladder: killer.ladder, ladderLen: GUNGAME_LADDER.length }));
      broadcastRoom(room, { t: 'ladder', id: killerId, ladder: killer.ladder });
    }
  } else if (killer.kills >= WIN_KILLS) {
    won = true;
  }
  if (won && !room.matchOver) {
    room.matchOver = true;
    broadcastRoom(room, { t: 'matchover', winner: killerId, winnerName: killer.name, kills: killer.kills, scores: roomScores(room) });
    console.log(`[room ${room.code}] ${killer.name} wins (${room.mode || 'dm'})`);
    setTimeout(() => backToLobby(room), MATCH_END_LOBBY_MS);
    return;
  }
  setTimeout(() => {
    if (!rooms.has(room.code) || !room.players.has(targetId) || !room.started || room.matchOver) return;
    const spawn = pickSpawn(room, !!target.bot);
    target.hp = target.maxHp || MAX_HP; target.dead = false; target.pos = spawn;
    broadcastRoom(room, { t: 'respawn', id: targetId, pos: spawn, hp: target.hp });
  }, RESPAWN_MS);
}

function broadcastRoom(room, msg, exceptId = null) {
  const data = JSON.stringify(msg);
  for (const [id, p] of room.players) {
    if (id !== exceptId && p.ws.readyState === 1) p.ws.send(data);
  }
}

function publicPlayer(id, p) {
  return { id, name: p.name, color: p.color, pos: p.pos, ry: p.ry, pitch: p.pitch, hp: p.hp, kills: p.kills, deaths: p.deaths, dead: p.dead, w: p.w || 1, team: p.team || null, hero: p.hero || null };
}

function roomScores(room) {
  const s = {};
  for (const [id, p] of room.players) s[id] = { name: p.name, kills: p.kills, deaths: p.deaths };
  return s;
}

function lobbyState(room, extra = {}) {
  return {
    t: 'lobby',
    game: room.game || 'cod',
    code: room.code,
    hostId: room.hostId,
    map: room.map,
    mode: room.mode || 'dm',
    players: [...room.players.entries()].map(([id, p]) => ({ id, name: p.name, color: p.color, host: id === room.hostId, bot: !!p.bot, ...(p.car ? { car: p.car } : {}) })),
    ...extra,
  };
}

// helper bundle passed into the NFS module (keeps nfs-server.js decoupled)
const nfsApi = { broadcastRoom, lobbyState, backToLobby };

function sendGameInit(room, id) {
  const p = room.players.get(id);
  const others = {};
  for (const [oid, op] of room.players) if (oid !== id && op.inGame && !op.spectator) others[oid] = publicPlayer(oid, op);
  p.ws.send(JSON.stringify({
    t: 'init', id, color: p.color, spawn: p.pos, map: room.map, mode: room.mode || 'dm',
    w: p.w, ladder: p.ladder || 0, ladderLen: GUNGAME_LADDER.length,
    team: p.team || null, hero: p.hero || null, maxHp: p.maxHp || MAX_HP, heroes: HERO.HEROES, readyHeroes: HERO.READY_HEROES,
    koth: room.koth ? { red: Math.floor(room.koth.red), blue: Math.floor(room.koth.blue) } : null,
    players: others, scores: roomScores(room), winKills: WIN_KILLS,
    deadLights: room.deadLights ? [...room.deadLights] : [],
  }));
}

function startMatch(room) {
  room.started = true;
  room.matchOver = false;
  room.deadLights = new Set();          // shootable map lights back on each match
  for (const [id, p] of room.players) {
    p.kills = 0; p.deaths = 0;
    p.hp = MAX_HP; p.dead = false;
    p.pos = pickSpawn(room, !!p.bot);
    p.inGame = true;
    p.ladder = 0;
    if (room.mode === 'gungame') p.w = ladderWeapon(p);   // everyone starts at the bottom of the ladder
  }
  if (room.mode === 'heroes') HERO.initHeroMatch(room);
  for (const [id] of room.players) sendGameInit(room, id);
  console.log(`[room ${room.code}] ${room.mode || 'dm'} match started with ${room.players.size} players`);
}

function backToLobby(room) {
  if (!rooms.has(room.code)) return;
  room.started = false;
  room.matchOver = false;
  for (const [, p] of room.players) {
    p.inGame = false; p.dead = false; p.hp = MAX_HP; p.kills = 0; p.deaths = 0;
  }
  broadcastRoom(room, lobbyState(room, { backFromMatch: true }));
  console.log(`[room ${room.code}] back to lobby`);
}

function removeFromRoom(ws) {
  const room = ws.room;
  if (!room || !rooms.has(room.code)) return;
  const id = ws.playerId;
  const p = room.players.get(id);
  if (!p) return;
  room.players.delete(id);
  if (room.game === 'tekken') FIGHT.onLeave(room, id);   // frees the seat, tells the other fighter (fleft)
  console.log(`[room ${room.code}] ${p.name} left (${room.players.size} remain)`);
  const humans = [...room.players.entries()].filter(([, q]) => !q.bot && !q.dummy);
  if (humans.length === 0) {   // bots alone can't keep a room alive
    rooms.delete(room.code);
    console.log(`[room ${room.code}] deleted (no humans left)`);
    return;
  }
  if (room.hostId === id) {
    room.hostId = humans[0][0];   // host must be human
  }
  if (room.started) {
    broadcastRoom(room, { t: 'left', id });
    broadcastRoom(room, { t: 'scores', scores: roomScores(room) });
  } else {
    broadcastRoom(room, lobbyState(room));
  }
}

wss.on('connection', (ws) => {
  ws.playerId = String(nextId++);
  ws.room = null;

  ws.on('message', (raw) => {
    // FRAME TRAP rooms: size cap (2 KB) + per-connection rate limit (120/s, burst 240) before parsing
    if (ws.room?.game === 'tekken' && !FIGHT.admit(ws, raw)) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== 'object') return;   // "null" / numbers / strings used to crash the switch below
    // one crafted message must never take the whole hub down: {"name":{"toString":1}} made String() throw and killed the
    // process (every game). The body below is unchanged, only wrapped (not re-indented).
    try {
    const id = ws.playerId;
    const room = ws.room;
    const p = room?.players.get(id);

    // NFS rooms: all game-specific messages are n-prefixed and handled by the module
    if (room?.game === 'nfs' && typeof msg.t === 'string' && msg.t.startsWith('n')) {
      return NFS.handle(room, id, msg, nfsApi);
    }
    // FRAME TRAP rooms speak only f-prefixed messages (relay inside the room); everything else is ignored
    if (room?.game === 'tekken') {
      if (typeof msg.t === 'string' && msg.t[0] === 'f') FIGHT.handle(room, id, msg);
      return;
    }

    switch (msg.t) {
      case 'create': {
        if (room) return;
        const code = makeCode();
        const game = ['underwatch', 'nfs', 'unknown', 'tekken'].includes(msg.game) ? msg.game : 'cod';
        const gameDefaults = game === 'nfs' ? NFS.defaults()
          : game === 'tekken' ? FIGHT.defaults()
          : game === 'underwatch' ? { map: 'forge', mode: 'heroes' }
          : { map: DEFAULT_MAP, mode: 'dm' };
        const newRoom = { code, hostId: id, started: false, matchOver: false, game,
          map: gameDefaults.map, mode: gameDefaults.mode, players: new Map() };
        rooms.set(code, newRoom);
        const demo = game === 'cod' && !!msg.demo;   // Nemesis demo: you watch, a bot hunts a scripted target
        if (demo) { newRoom.map = MAP_IDS.includes(msg.map) ? msg.map : 'range'; newRoom.mode = 'dm'; }
        newRoom.players.set(id, {
          ws, name: String(msg.name || 'player').slice(0, 16),
          color: PLAYER_COLORS[0],
          pos: pickSpawn(newRoom), ry: 0, pitch: 0,
          hp: MAX_HP, kills: 0, deaths: 0, dead: false, inGame: false, w: 1,
          spectator: demo,
        });
        ws.room = newRoom;
        if (demo) {
          addBot(newRoom);
          DUMMY.addDummy(newRoom, { pickSpawn, playerColor: PLAYER_COLORS[2], style: msg.style === 'random' ? 'random' : 'rhythm' });
          startMatch(newRoom);
          console.log(`[room ${code}] Nemesis demo started on ${newRoom.map}`);
          break;
        }
        ws.send(JSON.stringify(lobbyState(newRoom, { you: id })));
        if (game === 'tekken') FIGHT.onCreate(newRoom, id);   // seat 0 + froom state
        console.log(`[room ${code}] created by ${newRoom.players.get(id).name}`);
        break;
      }
      case 'join': {
        if (room) return;
        const target = rooms.get(String(msg.code));
        if (!target) return ws.send(JSON.stringify({ t: 'error', msg: 'Room not found — check the code' }));
        if (msg.probe) return ws.send(JSON.stringify({ t: 'roomgame', code: target.code, game: target.game || 'cod' }));
        if (target.players.size >= ROOM_CAP) return ws.send(JSON.stringify({ t: 'error', msg: 'Room is full' }));
        if (target.game === 'tekken' && !FIGHT.canJoin(target)) return ws.send(JSON.stringify({ t: 'error', msg: 'Room is full' }));
        if (target.game === 'nfs' && target.started) return ws.send(JSON.stringify({ t: 'error', msg: 'Race in progress — try again in a minute' }));
        target.players.set(id, {
          ws, name: String(msg.name || 'player').slice(0, 16),
          color: PLAYER_COLORS[target.players.size % PLAYER_COLORS.length],
          pos: pickSpawn(target), ry: 0, pitch: 0,
          hp: MAX_HP, kills: 0, deaths: 0, dead: false, inGame: false, w: 1,
          spectator: !!msg.spectate,   // Nemesis AI view: invisible, untargetable observer
        });
        ws.room = target;
        const pl = target.players.get(id);
        console.log(`[room ${target.code}] ${pl.name} joined (${target.players.size} players)`);
        if (target.game === 'tekken') { FIGHT.onJoin(target, id); break; }   // seat 1 or spectator; froom to everyone
        if (target.started) {
          // drop into the running match
          pl.inGame = true;
          sendGameInit(target, id);
          if (pl.spectator) break;   // nobody else needs to know an observer joined
          broadcastRoom(target, { t: 'joined', player: publicPlayer(id, pl) }, id);
          broadcastRoom(target, { t: 'scores', scores: roomScores(target) });
        } else {
          const lobbyMsg = lobbyState(target);
          pl.ws.send(JSON.stringify({ ...lobbyMsg, you: id }));
          broadcastRoom(target, lobbyMsg, id);
        }
        break;
      }
      case 'start': {
        if (!room || room.started || room.hostId !== id) return;
        if (room.game === 'nfs') { NFS.startRace(room, nfsApi); break; }
        startMatch(room);
        break;
      }
      case 'setmap': {
        // host picks the map in the lobby; everyone sees the selection
        if (!room || room.started || room.hostId !== id) return;
        const validMaps = room.game === 'nfs' ? NFS.NFS_MAPS : MAP_IDS;
        if (!validMaps.includes(msg.map)) return;
        room.map = msg.map;
        broadcastRoom(room, lobbyState(room));
        console.log(`[room ${room.code}] map set to ${room.map}`);
        break;
      }
      case 'setmode': {
        // host picks the game mode in the lobby
        if (!room || room.started || room.hostId !== id) return;
        const allowed = (room.game === 'underwatch') ? ['heroes'] : ['dm', 'gungame'];
        if (!allowed.includes(msg.mode)) return;
        room.mode = msg.mode;
        broadcastRoom(room, lobbyState(room));
        console.log(`[room ${room.code}] mode set to ${room.mode}`);
        break;
      }
      case 'addbot': {
        // host adds an AI player (lobby or mid-match)
        if (!room || room.hostId !== id) return;
        if (room.players.size >= ROOM_CAP) return;
        if (room.game === 'nfs') {
          if (room.started) return;   // nfs bots join in the lobby only
          NFS.addBot(room);
          broadcastRoom(room, lobbyState(room));
          break;
        }
        const botId = addBot(room);
        const bot = room.players.get(botId);
        console.log(`[room ${room.code}] ${bot.name} added (${room.players.size} players)`);
        if (room.started) {
          if (room.mode === 'gungame') { bot.ladder = 0; bot.w = ladderWeapon(bot); }
          broadcastRoom(room, { t: 'joined', player: publicPlayer(botId, bot) });
          broadcastRoom(room, { t: 'scores', scores: roomScores(room) });
        } else {
          broadcastRoom(room, lobbyState(room));
        }
        break;
      }
      case 'nemesismode': {
        // host cycles the bots' aim mode: naive -> lead -> learned
        if (!room || room.hostId !== id) return;
        broadcastRoom(room, { t: 'nemesismode', mode: NEMESIS.cycleMode(room) });
        break;
      }
      case 'nemesisstyle': {
        // host switches the demo target between a learnable rhythm and random reversals
        if (!room || room.hostId !== id) return;
        const style = DUMMY.toggleStyle(room);
        if (style) broadcastRoom(room, { t: 'nemesisstyle', style });
        break;
      }
      case 'nemesisreset': {
        if (!room || room.hostId !== id) return;
        NEMESIS.resetModels(room);
        break;
      }
      case 'removebot': {
        // host removes the most recently added bot
        if (!room || room.hostId !== id) return;
        const botIds = [...room.players.keys()].filter(k => room.players.get(k).bot);
        if (!botIds.length) return;
        const botId = botIds[botIds.length - 1];
        room.players.delete(botId);
        if (room.started) {
          broadcastRoom(room, { t: 'left', id: botId });
          broadcastRoom(room, { t: 'scores', scores: roomScores(room) });
        } else {
          broadcastRoom(room, lobbyState(room));
        }
        break;
      }
      case 'state': {
        if (!p || !room.started || p.dead || p.spectator) return;
        if (Array.isArray(msg.pos) && msg.pos.length === 3) p.pos = msg.pos.map(Number);
        p.ry = Number(msg.ry) || 0;
        p.pitch = Number(msg.pitch) || 0;
        p.w = Number(msg.w) || p.w || 1;
        p.ads = !!msg.ads;
        p.fl = !!msg.fl;
        p.rel = !!msg.rel;
        p.sl = !!msg.sl;
        p.wj = !!msg.wj;
        p.air = !!msg.air;
        p.spr = !!msg.spr;
        break;
      }
      case 'lightout': {
        if (!room || !room.started) break;
        const li = Number(msg.i);
        if (!Number.isInteger(li) || li < 0 || li > 200) break;
        room.deadLights = room.deadLights || new Set();
        if (room.deadLights.has(li)) break;          // already dead — no re-broadcast
        room.deadLights.add(li);
        broadcastRoom(room, { t: 'lightout', i: li, from: id });
        break;
      }
      case 'shoot': {
        if (!p || !room.started || p.dead) return;
        broadcastRoom(room, { t: 'shot', from: id, origin: msg.origin, dir: msg.dir, w: msg.w }, id);
        break;
      }
      case 'nade': {
        // throwable release: relay to everyone else; clients simulate the projectile.
        // A dead player gets a 1s grace window — dying mid-cook DROPS the live grenade.
        if (!p || !room.started || (p.dead && Date.now() - (p.diedAt || 0) > 1000)) return;
        if (!Array.isArray(msg.pos) || msg.pos.length !== 3 || !Array.isArray(msg.vel) || msg.vel.length !== 3) return;
        const kind = msg.kind === 'flash' ? 'flash' : 'frag';
        const relay = { t: 'nade', from: id, kind, pos: msg.pos.map(Number), vel: msg.vel.map(Number) };
        if (Number.isFinite(msg.fuse)) relay.fuse = Math.min(Math.max(Number(msg.fuse), 120), 3000);
        broadcastRoom(room, relay, id);
        break;
      }
      case 'nadeboom': {
        // detonation from the thrower: daze enemy bots near the blast (humans handle
        // their own blind/damage client-side; frag damage to bots arrives via 'hit')
        if (!p || !room.started) return;
        if (!Array.isArray(msg.pos)) return;
        const [bx, , bz] = msg.pos.map(Number);
        const isFlash = msg.kind === 'flash';
        const R = isFlash ? 13 : 8;
        const dazeMs = isFlash ? 3200 : 1500;
        for (const [, q] of room.players) {
          if (!q.bot || q.dead) continue;
          if (Math.hypot(q.pos[0] - bx, q.pos[2] - bz) <= R)
            q.aiNextShot = Math.max(q.aiNextShot || 0, Date.now() + dazeMs);
        }
        break;
      }
      case 'nadeself': {
        // your own grenade caught you — self damage, grenade suicide in the feed
        if (!p || !room.started || p.dead || room.matchOver) return;
        const dmg = Math.max(1, Math.min(150, Math.round(Number(msg.dmg) || 0)));
        p.hp -= dmg;
        p.lastHurt = Date.now();
        if (p.hp <= 0) {
          p.hp = 0;
          p.dead = true;
          p.diedAt = Date.now();
          p.deaths++;
          broadcastRoom(room, { t: 'death', target: id, from: id, fromName: p.name, targetName: p.name, weaponName: 'GRENADE', nade: true });
          broadcastRoom(room, { t: 'scores', scores: roomScores(room) });
          setTimeout(() => {
            if (!rooms.has(room.code) || !room.players.has(id) || !room.started) return;
            const spawn = pickSpawn(room);
            p.hp = MAX_HP; p.dead = false; p.pos = spawn;
            broadcastRoom(room, { t: 'respawn', id, pos: spawn, hp: MAX_HP });
          }, RESPAWN_MS);
        } else {
          broadcastRoom(room, { t: 'damage', target: id, hp: p.hp, from: id });
        }
        break;
      }
      case 'falldmg': {
        if (!p || !room.started || p.dead || room.matchOver) return;
        const dmg = Math.max(1, Math.min(150, Math.round(Number(msg.dmg) || 0)));
        p.hp -= dmg;
        p.lastHurt = Date.now();
        if (p.hp <= 0) {
          p.hp = 0;
          p.dead = true;
          p.diedAt = Date.now();
          p.deaths++;
          broadcastRoom(room, { t: 'death', target: id, from: id, fromName: p.name, targetName: p.name, fall: true });
          broadcastRoom(room, { t: 'scores', scores: roomScores(room) });
          setTimeout(() => {
            if (!rooms.has(room.code) || !room.players.has(id) || !room.started) return;
            const spawn = pickSpawn(room);
            p.hp = MAX_HP; p.dead = false; p.pos = spawn;
            broadcastRoom(room, { t: 'respawn', id, pos: spawn, hp: MAX_HP });
          }, RESPAWN_MS);
        } else {
          broadcastRoom(room, { t: 'damage', target: id, hp: p.hp, from: id });
        }
        break;
      }
      case 'heropick': {
        if (!p || room.mode !== 'heroes' || !HERO.READY_HEROES.includes(msg.hero)) return;
        p.hero = msg.hero;
        p.maxHp = HERO.heroMaxHp(msg.hero);
        p.hp = p.maxHp;   // fresh pool on pick (players are in select grace anyway)
        broadcastRoom(room, { t: 'heropick', id, hero: msg.hero, hp: p.hp, maxHp: p.maxHp });
        break;
      }
      case 'ability': {
        // replication envelope: clients simulate their own abilities; others render them
        if (!p || !room.started || p.dead || room.mode !== 'heroes') return;
        broadcastRoom(room, { t: 'ability', from: id, hero: p.hero, name: String(msg.name || ''), data: msg.data }, id);
        // stun grenade landing: daze enemy bots near the blast (human daze is client-side)
        if (msg.name === 'stunland' && Array.isArray(msg.data?.pos)) {
          const [bx, , bz] = msg.data.pos.map(Number);
          for (const [, q] of room.players) {
            if (!q.bot || q.dead || (q.team && q.team === p.team)) continue;
            if (Math.hypot(q.pos[0] - bx, q.pos[2] - bz) <= 5) q.aiNextShot = Date.now() + 1500;
          }
        }
        // BREAKER quake drop landing: daze enemy bots in the shockwave
        if (msg.name === 'quakeland' && Array.isArray(msg.data?.pos)) {
          const [bx, , bz] = msg.data.pos.map(Number);
          for (const [, q] of room.players) {
            if (!q.bot || q.dead || (q.team && q.team === p.team)) continue;
            if (Math.hypot(q.pos[0] - bx, q.pos[2] - bz) <= 6) q.aiNextShot = Date.now() + 1200;
          }
        }
        // BREAKER haymaker connecting: knock the bot BACK along the punch, wall slams hit extra
        if (msg.name === 'punchhit' && msg.data?.id) {
          const q = room.players.get(String(msg.data.id));
          if (q && q.bot && !q.dead && (!q.team || q.team !== p.team) && Array.isArray(msg.data.dir)) {
            q.aiNextShot = Date.now() + 1200;
            const [dx, dz] = msg.data.dir.map(Number);
            const len = Math.hypot(dx, dz) || 1;
            const emp = !!msg.data.emp;
            const dist = (5 + (Number(msg.data.t) || 0) * 4) * (emp ? 1.6 : 1);
            // step the bot backward until a wall stops it
            let travelled = 0, slammed = false;
            while (travelled < dist) {
              const step = Math.min(0.5, dist - travelled);
              const nx = q.pos[0] + (dx / len) * step, nz = q.pos[2] + (dz / len) * step;
              if (segmentBlocked(room.map, q.pos[0], 1, q.pos[2], nx, 1, nz)) { slammed = true; break; }
              q.pos[0] = nx; q.pos[2] = nz;
              travelled += step;
            }
            if (slammed) {
              // wall slam: bonus damage credited to the puncher + longer daze + impact fx for everyone
              q.aiNextShot = Date.now() + 1800;
              applyDamage(room, id, String(msg.data.id), Math.round(40 * (emp ? 1.5 : 1)), false, 2, 'HAYMAKER');
              broadcastRoom(room, { t: 'ability', from: id, hero: 'breaker', name: 'punchwall', data: { kind: 'wallfx', pos: [q.pos[0], 1.2, q.pos[2]] } });
            }
          }
        }
        if (msg.name === 'punchwall' && msg.data?.id) {
          const q = room.players.get(String(msg.data.id));
          if (q && q.bot && !q.dead && (!q.team || q.team !== p.team)) q.aiNextShot = Date.now() + 1800;
        }
        // a punched HUMAN reports slamming into a wall — bonus damage credited to the puncher
        if (msg.name === 'wallslammed' && msg.data?.attacker) {
          const atk = room.players.get(String(msg.data.attacker));
          if (atk && atk.hero === 'breaker' && (!atk.team || atk.team !== p.team) && Date.now() - (p.lastPunchedAt || 0) < 1500) {
            applyDamage(room, String(msg.data.attacker), id, 40, false, 2, 'HAYMAKER');
            broadcastRoom(room, { t: 'ability', from: String(msg.data.attacker), hero: 'breaker', name: 'punchwall', data: { kind: 'wallfx', pos: p.pos } });
          }
        }
        // record punch timestamps on human victims (validates wallslammed reports)
        if (msg.name === 'punchhit' && msg.data?.id) {
          const victim = room.players.get(String(msg.data.id));
          if (victim && !victim.bot) victim.lastPunchedAt = Date.now();
        }
        // BREAKER power block state (server applies the frontal mitigation in applyDamage)
        if (msg.name === 'blockstart') { p.blocking = true; p.blockUntil = Date.now() + 2600; p.blockedAcc = p.blockedAcc || 0; }
        if (msg.name === 'blockend') { p.blocking = false; }
        // the empowered punch is spent on release
        if (msg.name === 'haymaker' && p.empowered) { p.empowered = false; p.blockedAcc = 0; }
        break;
      }
      case 'hit': {
        if (p && p.spectator) return;
        if (!p || !room.started || p.dead || room.matchOver) return;
        const target = room.players.get(String(msg.target));
        if (!target || target.dead || !target.inGame) return;
        const cap = room.mode === 'heroes' ? 300 : 150;   // hero kits legitimately crit up to 250
        const dmg = Math.max(1, Math.min(cap, Math.round(Number(msg.dmg) || DAMAGE)));
        const wn = typeof msg.wn === 'string' ? msg.wn.slice(0, 20) : undefined;
        applyDamage(room, id, String(msg.target), dmg, !!msg.head, msg.w, wn);
        break;
      }
    }
    } catch (e) { console.warn('[server] dropped a bad message:', (e && e.message) || e); }
  });

  // protocol errors (frame > maxPayload, bad opcode / UTF-8) arrive as 'error' events: unhandled, they killed the process
  ws.on('error', (e) => console.warn('[server] socket error:', (e && (e.code || e.message)) || e));
  ws.on('close', () => removeFromRoom(ws));
});

// ---------- bot AI (runs inside the room tick) ----------
const BOT_SPEED = 5.2;            // m/s, slightly slower than sprinting humans
const BOT_SIGHT = 50;             // engagement range (m)
const tacticsApi = { posBlocked, segmentBlocked, pickSpawn, predict: (room, id, sec) => NEMESIS.predictPosition(room, id, sec) };
function tickBots(room, dt) {
  const alive = [...room.players.entries()].filter(([, q]) => q.inGame && !q.dead && !q.spectator);
  for (const [bid, bot] of room.players) {
    if (!bot.bot || !bot.inGame || bot.dead) continue;
    // fall toward the ground if spawned elevated (bots live at ground level)
    if (bot.pos[1] > 0) bot.pos[1] = Math.max(0, bot.pos[1] - 9 * dt);

    // --- target: nearest living opponent with line of sight ---
    let target = null, tDist = BOT_SIGHT;
    let dbgNear = 0, dbgBlocked = 0;
    for (const [oid, o] of alive) {
      if (oid === bid) continue;
      if (room.mode === 'heroes' && o.team && o.team === bot.team) continue;   // no teammates
      if (room.mode === 'heroes' && !o.bot && !o.hero) continue;               // still picking a hero
      const d = Math.hypot(o.pos[0] - bot.pos[0], o.pos[2] - bot.pos[2]);
      if (d < tDist) {
        if (!TACTICS.canNotice(bot, oid, o, d)) continue;   // outside the bot's field of view
        dbgNear++;
        if (segmentBlocked(room.map, bot.pos[0], bot.pos[1] + 1.6, bot.pos[2], o.pos[0], o.pos[1] + 1.4, o.pos[2])) { dbgBlocked++; continue; }
        target = [oid, o]; tDist = d;
      }
    }
    if (process.env.BOT_DEBUG && Math.random() < 0.05) {
      console.log(`[bot ${bid}] pos=(${bot.pos[0].toFixed(1)},${bot.pos[2].toFixed(1)}) near=${dbgNear} blocked=${dbgBlocked} target=${target ? target[0] : 'none'}`);
    }

    // Nemesis tactics: patrol, engage, take cover, peek, and hunt the predicted position
    const move = TACTICS.update(room, bid, bot, target, dt, tacticsApi);
    if (target && move.shoot) {
      const [tid, t] = target;
      const dx = t.pos[0] - bot.pos[0], dz = t.pos[2] - bot.pos[2];
      // shoot on cooldown with distance-scaled accuracy
      const now = Date.now();
      if (now >= (bot.aiNextShot || 0)) {
        bot.aiNextShot = now + (BOT_COOLDOWN[bot.w] || 500) * (0.9 + Math.random() * 0.4);
        // Nemesis: against humans, aim at the predicted position instead of rolling for a hit
        if (!t.bot) { NEMESIS.planShot(room, bid, bot, tid, t); continue; }
        const origin = [bot.pos[0], bot.pos[1] + 1.6, bot.pos[2]];
        const len = Math.hypot(dx, t.pos[1] + 1.2 - origin[1], dz) || 1;
        const hitChance = Math.max(0.15, Math.min(0.8, 0.8 - tDist * 0.011));
        const hit = Math.random() < hitChance;
        const err = hit ? 0 : 0.12;   // misses visibly streak past
        const dir = [dx / len + (Math.random() - 0.5) * err, (t.pos[1] + 1.2 - origin[1]) / len + (Math.random() - 0.5) * err, dz / len + (Math.random() - 0.5) * err];
        broadcastRoom(room, { t: 'shot', from: bid, origin, dir, w: bot.w });
        if (hit) {
          const head = Math.random() < 0.12;
          const base = BOT_WEAPON_DMG[bot.w] || 25;
          const fall = Math.max(0.4, 1 - Math.max(0, tDist - 12) * 0.02);   // rough falloff
          applyDamage(room, bid, tid, Math.round(base * fall * (head ? 1.7 : 1)), head, bot.w);
        }
      }
    }
  }
}

// position broadcast + out-of-combat regen, per room
let regenTick = 0;
setInterval(() => {
  regenTick++;
  for (const room of rooms.values()) {
    if (!room.started || room.players.size === 0) continue;
    if (room.game === 'nfs') { NFS.tick(room, 1 / TICK_RATE, nfsApi); continue; }
    if (!room.matchOver) {
      DUMMY.tickDummies(room, 1 / TICK_RATE, { posBlocked, segmentBlocked, steer: TACTICS.steer });
      NEMESIS.observe(room);
      tickBots(room, 1 / TICK_RATE);
      NEMESIS.tick(room, { broadcastRoom, applyDamage, segmentBlocked, weaponDamage: BOT_WEAPON_DMG });
    }
    if (room.mode === 'heroes' && !room.matchOver && room.koth) {
      // temporary overhealth (BREAKER passive) decays back to the pool
      if (regenTick % 10 === 0) {
        for (const [pid, q] of room.players) {
          const cap = q.maxHp || MAX_HP;
          if (!q.dead && q.hp > cap) {
            q.hp = Math.max(cap, q.hp - 5);
            broadcastRoom(room, { t: 'damage', target: pid, hp: q.hp, from: pid });
          }
        }
      }
      const r = HERO.tickKoth(room, 1 / TICK_RATE);
      if (regenTick % 10 === 0 || r.changed) broadcastRoom(room, r.state);
      if (r.winner) {
        room.matchOver = true;
        broadcastRoom(room, { t: 'matchover', winner: r.winner, winnerName: r.winner.toUpperCase() + ' TEAM', kills: 0, scores: roomScores(room), teamWin: r.winner });
        console.log(`[room ${room.code}] ${r.winner} team wins koth`);
        setTimeout(() => backToLobby(room), MATCH_END_LOBBY_MS);
      }
    }
    const state = {};
    for (const [id, p] of room.players) if (p.inGame && !p.spectator) state[id] = { pos: p.pos, ry: p.ry, pitch: p.pitch, w: p.w || 1, ads: !!p.ads, rel: !!p.rel, fl: !!p.fl, sl: !!p.sl, wj: !!p.wj, air: !!p.air, spr: !!p.spr };
    broadcastRoom(room, { t: 'states', players: state });

    if (regenTick % 10 === 0) {
      const nowT = Date.now();
      for (const [id, p] of room.players) {
        const cap = p.maxHp || MAX_HP;
        if (p.inGame && !p.dead && p.hp > 0 && p.hp < cap && nowT - (p.lastHurt || 0) > 5000) {
          p.hp = Math.min(cap, p.hp + Math.max(5, Math.round(cap * 0.05)));
          broadcastRoom(room, { t: 'damage', target: id, hp: p.hp, from: null });
        }
      }
    }
  }
}, 1000 / TICK_RATE);

server.on('error', (e) => { console.error(`[server] cannot listen on ${HOST}:${PORT} — ${e.code || e.message}`); process.exit(1); });
server.listen(PORT, HOST, () => {
  const nets = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        const isPrivate = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(net.address);
        candidates.push({ name, address: net.address, isPrivate, isWifi: /^en\d/.test(name) });
      }
    }
  }
  candidates.sort((a, b) => (b.isWifi - a.isWifi) || (b.isPrivate - a.isPrivate));
  const ip = candidates.length ? candidates[0].address : 'localhost';
  const loopback = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';
  console.log('==============================================');
  console.log('  LAB ARENA server running (room system)');
  console.log(`  Bound to ${HOST}:${PORT}` + (loopback ? '  (this computer only)' : HOST === '0.0.0.0' || HOST === '::' ? '  (ALL interfaces: anyone on your network can connect)' : ''));
  if (loopback) {
    console.log(`  Open:  http://localhost:${PORT}`);
    console.log('  LAN party? restart with  HOST=0.0.0.0 npm run start:lan  (or HOST=0.0.0.0 node server.js)');
  } else {
    console.log(`  Everyone open:  http://${HOST === '0.0.0.0' || HOST === '::' ? ip : HOST}:${PORT}`);
  }
  console.log('==============================================');
});
