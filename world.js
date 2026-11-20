'use strict';
// Shared map geometry for the LAB ARENA server, the Nemesis bots, and the offline test harness:
// spawn points, collision boxes, line of sight, and the Firing Range boundary.
const fs = require('fs');
const path = require('path');

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

// Firing Range has no wall around it: players are clamped to this polygon (from public/cod/maps.js,
// expanded 2.6 m outward exactly as the client does).
const RANGE_POLY = [[24.8,1.6],[29.7,7.4],[31.5,14.1],[28.4,19.7],[22.1,22.5],[15.4,23.3],[10,23.8],[6.4,26.7],[2.4,30.9],[-2.8,31.2],[-7.6,29.1],[-12.1,27.3],[-16.2,24.9],[-19.2,21.3],[-21.8,17.6],[-25.1,14.5],[-27.7,10.7],[-28.4,6.2],[-28.4,1.6],[-27.9,-2.8],[-27.6,-7.4],[-27.8,-12.8],[-27,-18.7],[-24,-23.7],[-18.9,-26.3],[-13.8,-28.8],[-8.2,-29],[-2.8,-22.5],[0.5,-16.9],[3.2,-14.8],[6,-13.5],[10.6,-14.3],[17.1,-15],[21.4,-12.3],[22.8,-7.6],[22.5,-2.8]]
  .map(([x, z]) => { const dx = x - 1.0, dz = z - 2.2, L = Math.hypot(dx, dz); return [x + dx / L * 2.6, z + dz / L * 2.6]; });
const MAP_BOUNDARY = { range: RANGE_POLY };

function insideBoundary(map, x, z) {
  const P = MAP_BOUNDARY[map];
  if (!P) return true;
  let inside = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    if ((P[i][1] > z) !== (P[j][1] > z) && x < ((P[j][0] - P[i][0]) * (z - P[i][1])) / (P[j][1] - P[i][1]) + P[i][0]) inside = !inside;
  }
  return inside;
}

// groundOnly: legacy (v0.1) bots could not climb, so they only used ground-level spawns.
function pickSpawn(room, groundOnly = false) {
  let pts = MAP_SPAWNS[room?.map] || MAP_SPAWNS[DEFAULT_MAP];
  if (groundOnly) {
    const ground = pts.filter(p => p[1] === 0);   // legacy bots can't climb: elevated spawns sink them into geometry
    if (ground.length) pts = ground;
  }
  return pts[Math.floor(Math.random() * pts.length)].slice();
}

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

module.exports = { MAP_SPAWNS, MAP_IDS, DEFAULT_MAP, MAP_AABBS, MAP_RAMPS, MAP_BOUNDARY, pickSpawn, groundHeightAtServer, segmentBlocked, posBlocked, insideBoundary };
