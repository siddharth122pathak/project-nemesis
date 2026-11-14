// LAB ARENA — HERO MODE (server) — self-contained; delete this file + 3 hooks in server.js to remove the mode.
// Team-based king-of-the-hill with hero kits. Teams: 'red' | 'blue'.

const KOTH_ZONES = {
  // per-map capture zone: [x, z, radius]
  districts: [0, 0, 7],
  shipment: [0, 0, 5.5],
  killhouse: [0, 9, 5],   // east of the center house — fighting THROUGH the house for it
  forge: [0, 0, 7.7],      // the raised octagon platform
  village: [0, 0, 5.5],    // inside the point building
  shrine: [0, 0, 5.8],     // the shrine dais
  sanctum: [0, 1.5, 5.2],  // the gilded circle — the pit yawns just north of it
};
const SCORE_TO_WIN = 100;
const SCORE_RATE = 6;        // points/sec while a team holds the zone
const HEROES = ['maverick', 'longbow', 'breaker', 'aegis', 'spirit', 'goliath'];
const READY_HEROES = ['maverick', 'longbow', 'breaker'];   // implemented so far; others show as locked
// per-hero stats (health matches the archetype's current values; tanks get big pools later)
const HERO_STATS = {
  maverick: { hp: 225 },
  longbow: { hp: 250 }, breaker: { hp: 525 }, aegis: { hp: 300 }, spirit: { hp: 250 }, goliath: { hp: 600 },
};
function heroMaxHp(heroId) { return HERO_STATS[heroId]?.hp || 225; }

// assign teams alternating by join order (host red, next blue, ...)
function assignTeams(room) {
  let i = 0;
  for (const [, p] of room.players) {
    p.team = i % 2 === 0 ? 'red' : 'blue';
    p.color = p.team === 'red' ? 0xff5544 : 0x44aaff;
    i++;
  }
}

function initHeroMatch(room) {
  assignTeams(room);
  room.koth = { red: 0, blue: 0, holder: null, contested: false };
  for (const [, p] of room.players) {
    if (p.bot) {
      p.hero = READY_HEROES[Math.floor(Math.random() * READY_HEROES.length)];
      p.w = p.hero === 'longbow' ? 3 : 4;   // bots fight with the closest gun archetype
    }
    if (p.hero) { p.maxHp = heroMaxHp(p.hero); p.hp = p.maxHp; }
  }
}

// returns true when damage should be blocked (same team, hero mode only)
function friendlyFire(room, killer, target) {
  return room.mode === 'heroes' && killer !== target && killer?.team && killer.team === target?.team;
}

// zone occupancy + scoring; returns a state patch to broadcast (or null)
function tickKoth(room, dt) {
  const zone = KOTH_ZONES[room.map] || KOTH_ZONES.districts;
  const inside = { red: 0, blue: 0 };
  for (const [, p] of room.players) {
    if (!p.inGame || p.dead || !p.team) continue;
    const d = Math.hypot(p.pos[0] - zone[0], p.pos[2] - zone[1]);
    if (d <= zone[2]) inside[p.team]++;
  }
  const k = room.koth;
  const prevHolder = k.holder, prevContested = k.contested;
  k.contested = inside.red > 0 && inside.blue > 0;
  if (!k.contested) {
    if (inside.red > 0) k.holder = 'red';
    else if (inside.blue > 0) k.holder = 'blue';
    else k.holder = null;
    if (k.holder) k[k.holder] = Math.min(SCORE_TO_WIN, k[k.holder] + SCORE_RATE * dt);
  }
  const winner = k.red >= SCORE_TO_WIN ? 'red' : k.blue >= SCORE_TO_WIN ? 'blue' : null;
  return {
    changed: k.holder !== prevHolder || k.contested !== prevContested,
    state: { t: 'koth', red: Math.floor(k.red), blue: Math.floor(k.blue), holder: k.holder, contested: k.contested, zone },
    winner,
  };
}

module.exports = { KOTH_ZONES, SCORE_TO_WIN, HEROES, READY_HEROES, HERO_STATS, heroMaxHp, initHeroMatch, friendlyFire, tickKoth };
