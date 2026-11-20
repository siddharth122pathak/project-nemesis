'use strict';
// Nemesis navigation: a 2.5D walkable grid built from a map's collision boxes, plus A* pathfinding.
//
// Each 0.5 m cell can hold several floors (ground, rooftops, upper storeys). A floor is walkable if a
// standing player fits on it without touching any box. Neighboring floors connect when the height
// change is a step (<= 0.65 m), a jump (<= 1.3 m up), or a drop (<= 4.5 m down). Bots therefore climb
// stairs, hop onto crates, drop off ledges, and never walk into walls.
const { MAP_AABBS, MAP_SPAWNS, insideBoundary } = require('./../world.js');

const CELL = 0.5;
const RADIUS = 0.42;    // player radius (client uses 0.45; slightly smaller avoids blocking doorways)
const HEAD = 1.75;      // standing height
const STEP = 0.55, JUMP = 1.4, DROP = 4.5;   // step: client lifts players onto ledges <= 0.52 m
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

class MinHeap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    let i = k.length;
    k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v, top = v[0];
    const lk = k.pop(), lv = v.pop();
    if (k.length) {
      let i = 0;
      const n = k.length;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}

class NavGrid {
  constructor(map, boxes = MAP_AABBS[map] || [], spawns = MAP_SPAWNS[map] || []) {
    this.map = map;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const b of boxes) { x0 = Math.min(x0, b[0]); x1 = Math.max(x1, b[3]); z0 = Math.min(z0, b[2]); z1 = Math.max(z1, b[5]); }
    for (const p of spawns) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); z0 = Math.min(z0, p[2]); z1 = Math.max(z1, p[2]); }
    if (!isFinite(x0)) { x0 = z0 = -40; x1 = z1 = 40; }
    this.ox = x0 - 1; this.oz = z0 - 1;
    this.nx = Math.ceil((x1 - x0 + 2) / CELL); this.nz = Math.ceil((z1 - z0 + 2) / CELL);
    this._build(boxes);
    this._reach(spawns);
  }

  cellOf(x, z) {
    const i = Math.floor((x - this.ox) / CELL), j = Math.floor((z - this.oz) / CELL);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) return -1;
    return j * this.nx + i;
  }
  cx(c) { return this.ox + ((c % this.nx) + 0.5) * CELL; }
  cz(c) { return this.oz + (Math.floor(c / this.nx) + 0.5) * CELL; }

  _build(boxes) {
    const N = this.nx * this.nz;
    const lists = new Array(N);
    // bucket each box into the cells its footprint (grown by the player radius) touches
    boxes.forEach((b, bi) => {
      if (b[4] - b[1] < 0.02) return;
      const i0 = Math.max(0, Math.floor((b[0] - RADIUS - this.ox) / CELL)), i1 = Math.min(this.nx - 1, Math.floor((b[3] + RADIUS - this.ox) / CELL));
      const j0 = Math.max(0, Math.floor((b[2] - RADIUS - this.oz) / CELL)), j1 = Math.min(this.nz - 1, Math.floor((b[5] + RADIUS - this.oz) / CELL));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const c = j * this.nx + i;
        (lists[c] || (lists[c] = [])).push(bi);
      }
    });
    const start = new Int32Array(N + 1);
    const hs = [];
    for (let c = 0; c < N; c++) {
      start[c] = hs.length;
      const x = this.cx(c), z = this.cz(c);
      if (!insideBoundary(this.map, x, z)) continue;
      const near = lists[c] || [];
      // candidate floors: the ground, plus the top of every box under the cell center
      const cand = [0];
      for (const bi of near) {
        const b = boxes[bi];
        if (x >= b[0] && x <= b[3] && z >= b[2] && z <= b[5] && b[4] > 0.05 && b[4] < 40) cand.push(b[4]);
      }
      cand.sort((a, b) => a - b);
      let last = -99;
      for (const h of cand) {
        if (h - last < 0.05) continue;
        // a standing player (radius RADIUS, up to h+HEAD) must not overlap any box
        let ok = true;
        for (const bi of near) {
          const b = boxes[bi];
          // boxes whose top is within stepping height are stairs/ledges you step onto, not walls (client: 0.52 m)
          if (b[1] < h + HEAD && b[4] > h + 0.52 &&
              x + RADIUS > b[0] && x - RADIUS < b[3] && z + RADIUS > b[2] && z - RADIUS < b[5]) { ok = false; break; }
        }
        if (ok) { hs.push(h); last = h; }
      }
    }
    start[N] = hs.length;
    this.start = start;
    this._boxes = boxes; this._lists = lists;
    this.h = Float32Array.from(hs);
    this.nodeCell = new Int32Array(hs.length);
    for (let c = 0; c < N; c++) for (let n = start[c]; n < start[c + 1]; n++) this.nodeCell[n] = c;
    // how hemmed-in each floor is (0..8 blocked neighbors): paths prefer open ground
    this.tight = new Uint8Array(hs.length);
    for (let n = 0; n < hs.length; n++) {
      let blocked = 0;
      for (const [di, dj] of DIRS) if (this._neighborNode(n, di, dj, STEP) < 0) blocked++;
      this.tight[n] = blocked;
    }
  }

  // the floor in cell (i+di, j+dj) reachable from node n within maxUp, preferring the closest height
  _neighborNode(n, di, dj, maxUp, maxDown = STEP) {
    const c = this.nodeCell[n], i = (c % this.nx) + di, j = Math.floor(c / this.nx) + dj;
    if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) return -1;
    const c2 = j * this.nx + i, h = this.h[n];
    let best = -1, bestD = Infinity;
    for (let m = this.start[c2]; m < this.start[c2 + 1]; m++) {
      const dh = this.h[m] - h;
      if (dh > maxUp || dh < -maxDown) continue;
      if (Math.abs(dh) < bestD) { bestD = Math.abs(dh); best = m; }
    }
    return best;
  }

  // true if cell (i+di, j+dj) has nothing at or above node n's height to bump into (open air)
  _gap(n, di, dj) {
    const c = this.nodeCell[n], i = (c % this.nx) + di, j = Math.floor(c / this.nx) + dj;
    if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) return false;
    const c2 = j * this.nx + i, h = this.h[n];
    for (let m = this.start[c2]; m < this.start[c2 + 1]; m++) if (this.h[m] > h - STEP) return false;
    // no box in that cell reaches above the ledge (otherwise it is a wall, not a gap)
    const x = this.cx(c2), z = this.cz(c2);
    for (const bi of this._lists[c2] || []) {
      const b = this._boxes[bi];
      if (b[4] > h + 0.1 && b[1] < h + HEAD && x + 0.15 > b[0] && x - 0.15 < b[3] && z + 0.15 > b[2] && z - 0.15 < b[5]) return false;
    }
    return true;
  }

  // outgoing edges of node n: [neighbor, cost, kind] with kind 0 walk, 1 jump, 2 drop
  edges(n) {
    const out = [];
    for (let d = 0; d < 8; d++) {
      const [di, dj] = DIRS[d];
      const diag = d >= 4;
      let m = this._neighborNode(n, di, dj, STEP, STEP), kind = 0;
      if (m < 0 && !diag) { m = this._neighborNode(n, di, dj, JUMP, STEP); if (m >= 0) kind = 1; }
      if (m < 0 && !diag) { m = this._neighborNode(n, di, dj, STEP, DROP); if (m >= 0) kind = 2; }
      if (m < 0 && !diag && this._gap(n, di, dj)) {
        // walk off a ledge: the strip next to a wall is too narrow to stand in, so land one cell further out
        m = this._neighborNode(n, 2 * di, 2 * dj, -STEP, DROP);
        if (m >= 0) kind = 2;
      }
      if (m < 0) continue;
      if (diag && (this._neighborNode(n, di, 0, STEP) < 0 || this._neighborNode(n, 0, dj, STEP) < 0)) continue;   // no corner cutting
      const base = diag ? 1.4142 * CELL : CELL;
      out.push([m, base * (1 + this.tight[m] * 0.12) + (kind === 1 ? 1.2 : kind === 2 ? 0.4 : 0), kind]);
    }
    return out;
  }

  _reach(spawns) {
    // floors reachable from any spawn; everything else (inside walls, outside the map) is ignored
    this.reach = new Uint8Array(this.h.length);
    const q = [];
    for (const p of spawns) {
      const n = this.nodeAt(p[0], p[1], p[2], false);
      if (n >= 0 && !this.reach[n]) { this.reach[n] = 1; q.push(n); }
    }
    const fwd = this.reach, seeds = q.slice(), rev = [];
    while (q.length) {
      const n = q.pop();
      for (const [m] of this.edges(n)) {
        (rev[m] || (rev[m] = [])).push(n);
        if (!fwd[m]) { fwd[m] = 1; q.push(m); }
      }
    }
    // keep only floors you can also walk back out of (drops are one-way: a pit you can't leave is a trap)
    const back = new Uint8Array(this.h.length);
    for (const n of seeds) { back[n] = 1; q.push(n); }
    while (q.length) {
      const n = q.pop();
      for (const m of rev[n] || []) if (fwd[m] && !back[m]) { back[m] = 1; q.push(m); }
    }
    this.reach = back;
    this.reachList = [];
    for (let n = 0; n < this.reach.length; n++) if (this.reach[n]) this.reachList.push(n);
  }

  // the floor a player at (x, y, z) is standing on, or -1
  nodeAt(x, y, z, reachableOnly = true) {
    const c = this.cellOf(x, z);
    if (c < 0) return -1;
    let best = -1, bestD = Infinity;
    for (let m = this.start[c]; m < this.start[c + 1]; m++) {
      if (reachableOnly && this.reach && !this.reach[m]) continue;
      const dh = y - this.h[m];
      if (dh < -0.8) continue;   // floor is above the player's knees
      const d = Math.abs(dh);
      if (d < bestD) { bestD = d; best = m; }
    }
    return best;
  }

  // nearest reachable floor to (x, y, z), searching outward up to `radius` meters
  nearest(x, y, z, radius = 8) {
    const n = this.nodeAt(x, y, z);
    if (n >= 0) return n;
    const c = this.cellOf(Math.max(this.ox, Math.min(this.ox + this.nx * CELL - 0.01, x)), Math.max(this.oz, Math.min(this.oz + this.nz * CELL - 0.01, z)));
    const ci = c % this.nx, cj = Math.floor(c / this.nx);
    const R = Math.ceil(radius / CELL);
    let best = -1, bestD = Infinity;
    for (let r = 1; r <= R && best < 0; r++) {
      for (let j = cj - r; j <= cj + r; j++) for (let i = ci - r; i <= ci + r; i++) {
        if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== r || i < 0 || j < 0 || i >= this.nx || j >= this.nz) continue;
        const cc = j * this.nx + i;
        for (let m = this.start[cc]; m < this.start[cc + 1]; m++) {
          if (!this.reach[m]) continue;
          const d = Math.hypot(this.cx(cc) - x, this.cz(cc) - z) + Math.abs(this.h[m] - y) * 0.5;
          if (d < bestD) { bestD = d; best = m; }
        }
      }
    }
    return best;
  }

  pos(n) { const c = this.nodeCell[n]; return [this.cx(c), this.h[n], this.cz(c)]; }

  // reachable floor at (x, z) closest to height y, at most `up` above it (where a walker steps to)
  floorNear(x, y, z, up) {
    const c = this.cellOf(x, z);
    if (c < 0) return null;
    let best = null, bestD = Infinity;
    for (let m = this.start[c]; m < this.start[c + 1]; m++) {
      if (!this.reach[m]) continue;
      const h = this.h[m];
      if (h > y + up || h < y - 4.5) continue;
      const d = Math.abs(h - y);
      if (d < bestD) { bestD = d; best = h; }
    }
    return best;
  }

  // highest reachable floor at (x, z) whose height is <= y (what you'd stand on), or null
  floorBelow(x, y, z) {
    const c = this.cellOf(x, z);
    if (c < 0) return null;
    let best = null;
    for (let m = this.start[c]; m < this.start[c + 1]; m++) {
      if (!this.reach[m]) continue;
      const h = this.h[m];
      if (h <= y + 1e-3 && (best === null || h > best)) best = h;
    }
    return best;
  }

  randomNode(rand = Math.random) { return this.reachList.length ? this.reachList[Math.floor(rand() * this.reachList.length)] : -1; }

  // A* from node a to node b. extraCost(node) lets the learner make paths avoid dangerous areas.
  path(a, b, extraCost = null, maxExpand = 60000) {
    if (a < 0 || b < 0) return null;
    if (a === b) return [a];
    const [bx, , bz] = this.pos(b);
    const g = new Map([[a, 0]]), came = new Map(), kindOf = new Map();
    const open = new MinHeap();
    const hfn = (n) => { const [x, , z] = this.pos(n); return Math.hypot(x - bx, z - bz); };
    open.push(hfn(a), a);
    const closed = new Set();
    let expanded = 0;
    while (open.size) {
      const n = open.pop();
      if (n === b) break;
      if (closed.has(n)) continue;
      closed.add(n);
      if (++expanded > maxExpand) return null;
      const gn = g.get(n);
      for (const [m, cost, kind] of this.edges(n)) {
        if (closed.has(m)) continue;
        const ng = gn + cost + (extraCost ? extraCost(m) : 0);
        if (ng < (g.has(m) ? g.get(m) : Infinity)) {
          g.set(m, ng); came.set(m, n); kindOf.set(m, kind);
          open.push(ng + hfn(m), m);
        }
      }
    }
    if (!came.has(b)) return null;
    const out = [b];
    let n = b;
    while (came.has(n)) { n = came.get(n); out.push(n); }
    out.reverse();
    out.kinds = out.map((m) => kindOf.get(m) || 0);
    return out;
  }

  // straight walk from node a to b stays on floors within a step of each other (for path smoothing)
  clearLine(a, b) {
    const [ax, ah, az] = this.pos(a), [bx, bh, bz] = this.pos(b);
    const d = Math.hypot(bx - ax, bz - az), steps = Math.ceil(d / (CELL * 0.5));
    let h = ah;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps, x = ax + (bx - ax) * t, z = az + (bz - az) * t;
      const c = this.cellOf(x, z);
      if (c < 0) return false;
      let ok = false;
      for (let m = this.start[c]; m < this.start[c + 1]; m++) {
        if (this.reach[m] && Math.abs(this.h[m] - h) <= STEP * 0.8 && this.tight[m] < 3) { h = this.h[m]; ok = true; break; }
      }
      if (!ok) return false;
    }
    return Math.abs(h - bh) <= STEP;
  }

  // waypoints [x, y, z, kind] along a node path, skipping intermediate nodes where the line is clear
  waypoints(nodes) {
    if (!nodes || !nodes.length) return [];
    const kinds = nodes.kinds || nodes.map(() => 0);
    const out = [];
    let i = 0;
    while (i < nodes.length - 1) {
      let j = i + 1;
      // never skip over a jump or drop: those must be taken at the exact edge
      for (let k = Math.min(nodes.length - 1, i + 24); k > i + 1; k--) {
        let special = false;
        for (let q = i + 1; q <= k; q++) if (kinds[q]) { special = true; break; }
        if (!special && this.clearLine(nodes[i], nodes[k])) { j = k; break; }
      }
      const p = this.pos(nodes[j]);
      out.push([p[0], p[1], p[2], kinds[j]]);
      i = j;
    }
    return out;
  }
}

const cache = new Map();
function navFor(map) {
  if (!cache.has(map)) cache.set(map, new NavGrid(map));
  return cache.get(map);
}

module.exports = { NavGrid, navFor, CELL, STEP, JUMP, DROP };
