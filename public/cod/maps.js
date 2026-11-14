// COD — map registry (extracted from game.js)
// All map geometry lives under mapRoot; game.js adds mapRoot to the scene.
// obstacles[] is the shared collision/raycast list, rebuilt by buildMap().
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MONASTERY } from './monastery_data.js';

export const mapRoot = new THREE.Group();
// ---------------- arena ----------------
export const obstacles = []; // AABBs: {min:Vector3, max:Vector3, mesh}
const staticMeshes = []; // individual box meshes, merged into batched draws after map build
export let mapBoundaryPoly = null;   // convex-ish containment polygon (range map); game clamps players inside

// ===== procedural textures (canvas — no downloads, lots of detail) =====
function makeTex(draw, w = 256, h = 256) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  draw(cv.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
const noise = (ctx, w, h, n, alpha) => {
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = `rgba(${Math.random() > 0.5 ? '255,255,255' : '0,0,0'},${alpha * Math.random()})`;
    ctx.fillRect(Math.random() * w, Math.random() * h, 2, 2);
  }
};
const TEX = {
  concrete: makeTex((c, w, h) => { c.fillStyle = '#b9bfc7'; c.fillRect(0, 0, w, h); noise(c, w, h, 900, 0.09); }),
  panels: makeTex((c, w, h) => {
    c.fillStyle = '#c8cdd4'; c.fillRect(0, 0, w, h); noise(c, w, h, 400, 0.05);
    c.strokeStyle = 'rgba(0,0,0,0.22)'; c.lineWidth = 2;
    for (let x = 0; x <= w; x += 64) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke(); }
    for (let y = 0; y <= h; y += 64) { c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
    c.fillStyle = 'rgba(0,0,0,0.25)';
    for (let x = 32; x < w; x += 64) for (let y = 32; y < h; y += 64) c.fillRect(x - 2, y - 2, 4, 4);
  }),
  tiles: makeTex((c, w, h) => {
    c.fillStyle = '#cfd4da'; c.fillRect(0, 0, w, h); noise(c, w, h, 500, 0.05);
    c.strokeStyle = 'rgba(40,50,60,0.35)'; c.lineWidth = 3;
    for (let x = 0; x <= w; x += 32) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke(); }
    for (let y = 0; y <= h; y += 32) { c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
  }),
  asphalt: makeTex((c, w, h) => { c.fillStyle = '#5a616b'; c.fillRect(0, 0, w, h); noise(c, w, h, 1400, 0.10); }),
  hazard: makeTex((c, w, h) => {
    c.fillStyle = '#e8b40f'; c.fillRect(0, 0, w, h);
    c.fillStyle = '#20242c';
    for (let i = -h; i < w + h; i += 48) {
      c.beginPath(); c.moveTo(i, 0); c.lineTo(i + 24, 0); c.lineTo(i + 24 - h, h); c.lineTo(i - h, h); c.closePath(); c.fill();
    }
  }),
  wood: makeTex((c, w, h) => {
    c.fillStyle = '#9a6b3f'; c.fillRect(0, 0, w, h); noise(c, w, h, 600, 0.08);
    c.strokeStyle = 'rgba(60,35,15,0.5)'; c.lineWidth = 3;
    for (let x = 0; x <= w; x += 42) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke(); }
  }),
  plywood: makeTex((c, w, h) => {
    // raw OSB/plywood sheets: pale tan, wood grain streaks, dark seam lines between 4x8 panels
    c.fillStyle = '#c9aa72'; c.fillRect(0, 0, w, h); noise(c, w, h, 800, 0.07);
    for (let i = 0; i < 60; i++) {                          // grain streaks
      c.fillStyle = `rgba(120,85,40,${0.06 + Math.random() * 0.10})`;
      c.fillRect(Math.random() * w, Math.random() * h, 20 + Math.random() * 60, 2 + Math.random() * 2);
    }
    c.strokeStyle = 'rgba(70,50,25,0.55)'; c.lineWidth = 3;  // panel seams
    for (let x = 0; x <= w; x += 128) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke(); }
    for (let y = 0; y <= h; y += 86) { c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
    c.fillStyle = 'rgba(60,40,20,0.5)';                      // screw dots at seam crossings
    for (let x = 12; x < w; x += 128) for (let y = 10; y < h; y += 86) c.fillRect(x, y, 3, 3);
  }),
  carpet: makeTex((c, w, h) => {
    // worn office carpet: dark blue-grey, speckled, subtle tile seams
    c.fillStyle = '#2a2f3a'; c.fillRect(0, 0, w, h);
    for (let i = 0; i < 2200; i++) {
      c.fillStyle = `rgba(${Math.random() > 0.6 ? '70,80,105' : '18,20,28'},${0.25 * Math.random()})`;
      c.fillRect(Math.random() * w, Math.random() * h, 2, 2);
    }
    c.strokeStyle = 'rgba(0,0,0,0.25)'; c.lineWidth = 2;
    for (let x = 0; x <= w; x += 128) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke(); }
    for (let y = 0; y <= h; y += 128) { c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
  }),
  ceilTile: makeTex((c, w, h) => {
    // drop-ceiling tiles in the dark: near-black grid
    c.fillStyle = '#14161c'; c.fillRect(0, 0, w, h); noise(c, w, h, 300, 0.05);
    c.strokeStyle = 'rgba(0,0,0,0.6)'; c.lineWidth = 4;
    for (let x = 0; x <= w; x += 64) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke(); }
    for (let y = 0; y <= h; y += 64) { c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
  }),
  drywall: makeTex((c, w, h) => {
    // office drywall gone grimy: pale grey-beige, water stains, scuffs
    c.fillStyle = '#8f8d84'; c.fillRect(0, 0, w, h); noise(c, w, h, 700, 0.06);
    for (let i = 0; i < 14; i++) {                          // stains and scuffs
      c.fillStyle = `rgba(40,42,38,${0.05 + Math.random() * 0.09})`;
      const sw = 20 + Math.random() * 70;
      c.fillRect(Math.random() * w, Math.random() * h, sw, sw * (0.4 + Math.random()));
    }
    c.fillStyle = 'rgba(30,30,28,0.35)'; c.fillRect(0, h - 14, w, 14);   // scuffed baseboard line
  }),
  target: makeTex((c, w, h) => {
    // shooting-range target: white board, concentric rings, red bullseye
    c.fillStyle = '#e8e2d4'; c.fillRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2;
    for (const [r, col] of [[100, '#20242c'], [78, '#e8e2d4'], [56, '#20242c'], [36, '#e8e2d4'], [18, '#c23b2e']]) {
      c.fillStyle = col; c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.fill();
    }
    noise(c, w, h, 200, 0.05);
  }),
};

// ===== district palettes — each zone has its own identity (callouts write themselves) =====
const P = {
  plaza:   { wall: 0xe8e4dc, trim: 0xc23b2e, accent: 0xd94f3d, neon: 0xff3b30, name: 'PLAZA' },
  foundry: { wall: 0xc96f3b, trim: 0x6e3a1e, accent: 0xe8892f, neon: 0xff8c1a, name: 'FOUNDRY' },
  docks:   { wall: 0x3f8f96, trim: 0x1e4a52, accent: 0x37b8c4, neon: 0x18e0f0, name: 'DOCKS' },
  skyline: { wall: 0x6b5a9e, trim: 0x3a2f5e, accent: 0x9b6fd4, neon: 0xc36bff, name: 'SKYLINE' },
  gardens: { wall: 0x5f9a52, trim: 0x2f5228, accent: 0x7fc45f, neon: 0x4dff6a, name: 'GARDENS' },
  steel:   { wall: 0x4a525e, trim: 0x2a3038, accent: 0x8a94a2, neon: 0x18e0f0, name: '' },
};

function addBox(x, z, w, h, d, color = 0x9aa7bd, opts = {}) {
  addPlatform(x, 0, z, w, h, d, color, opts);
}

// box with arbitrary base height; opts: {tex, repeat:[u,v], emissive, rough, metal}
function addPlatform(x, yBase, z, w, h, d, color = 0x9aa7bd, opts = {}) {
  const mat = new THREE.MeshStandardMaterial({
    color, roughness: opts.rough ?? 0.8, metalness: opts.metal ?? 0.2,
    emissive: opts.emissive ?? 0x000000, emissiveIntensity: opts.emissiveIntensity ?? 1,
    transparent: !!opts.opacity, opacity: opts.opacity ?? 1,
  });
  if (opts.tex) {
    mat.map = opts.tex.clone();
    mat.map.needsUpdate = true;
    mat.map.repeat.set(opts.repeat?.[0] ?? Math.max(1, Math.round(Math.max(w, d) / 3)), opts.repeat?.[1] ?? Math.max(1, Math.round(h / 3)));
  }
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  if (opts.tex === TEX.wood || opts.tex === TEX.plywood || opts.pen) mesh.userData.pen = true; // thin wood is shoot-through
  mesh.position.set(x, yBase + h / 2, z);
  mesh.castShadow = mesh.receiveShadow = true;
  mapRoot.add(mesh);
  staticMeshes.push(mesh); // merged into batched draw calls after map build
  obstacles.push({
    min: new THREE.Vector3(x - w / 2, yBase, z - d / 2),
    max: new THREE.Vector3(x + w / 2, yBase + h, z + d / 2),
    mesh,
  });
}

// decor: visual only — no collision, no raycast blocking of shots
function addDecor(x, y, z, w, h, d, color, opts = {}) {
  const mat = new THREE.MeshStandardMaterial({
    color, roughness: opts.rough ?? 0.6, metalness: opts.metal ?? 0.3,
    emissive: opts.emissive ?? 0x000000, emissiveIntensity: opts.emissiveIntensity ?? 1.4,
  });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  if (opts.tex === TEX.wood || opts.tex === TEX.plywood || opts.pen) mesh.userData.pen = true; // thin wood is shoot-through
  mesh.position.set(x, y + h / 2, z);
  mesh.raycast = () => {};
  mapRoot.add(mesh);
  staticMeshes.push(mesh);
  return mesh;
}

// glowing neon sign (readable from both sides — two front-facing planes)
function neonSign(text, colorHex, x, y, z, ry = 0, scale = 1) {
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = 128;
  const c = cv.getContext('2d');
  const col = '#' + colorHex.toString(16).padStart(6, '0');
  c.font = 'bold 84px Menlo, monospace';
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.shadowColor = col; c.shadowBlur = 28;
  c.fillStyle = col;
  c.fillText(text, 256, 66);
  c.shadowBlur = 8; c.fillStyle = '#ffffff';
  c.fillText(text, 256, 66);
  const tex = new THREE.CanvasTexture(cv);
  for (const flip of [0, Math.PI]) {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(8 * scale, 2 * scale),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.FrontSide })
    );
    mesh.position.set(x, y, z);
    mesh.rotation.y = ry + flip;
    mesh.raycast = () => {};
    mapRoot.add(mesh);
  }
}

// staircase of 0.5-step boxes (auto-climbable by movement code)
function addStairs(x, z, dirX, dirZ, steps, width = 3, color = 0x8794aa) {
  for (let i = 1; i <= steps; i++) {
    const sx = x + dirX * i * 1.1;
    const sz = z + dirZ * i * 1.1;
    const w = dirX !== 0 ? 1.1 : width;
    const d = dirZ !== 0 ? 1.1 : width;
    addBox(sx, sz, w, i * 0.5, d, color, { tex: TEX.concrete });
  }
}


// rotated box: the visible mesh is truly rotated (and handles shot raycasts);
// collision is approximated by N thin axis-aligned strips laid across the
// rotated footprint. Movement slides along them like stairs along the diagonal.
function addRotatedBox(x, yBase, z, w, h, d, ry, color, opts = {}) {
  const mat = new THREE.MeshStandardMaterial({
    color, roughness: opts.rough ?? 0.8, metalness: opts.metal ?? 0.2,
    emissive: opts.emissive ?? 0x000000, emissiveIntensity: opts.emissiveIntensity ?? 1,
  });
  if (opts.tex) {
    mat.map = opts.tex.clone();
    mat.map.needsUpdate = true;
    mat.map.repeat.set(opts.repeat?.[0] ?? Math.max(1, Math.round(Math.max(w, d) / 3)), opts.repeat?.[1] ?? Math.max(1, Math.round(h / 3)));
  }
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  if (opts.tex === TEX.wood || opts.tex === TEX.plywood || opts.pen) mesh.userData.pen = true; // thin wood is shoot-through
  mesh.position.set(x, yBase + h / 2, z);
  mesh.rotation.y = ry;
  mesh.castShadow = mesh.receiveShadow = true;
  mapRoot.add(mesh); // NOT merged (rotation): one extra draw call per rotated box is fine

  // collision strips: slice the box along its local length into axis-aligned chunks
  // (thin walls get finer slices so the jagged AABB edge stays close to the surface)
  const alongW = w >= d; // slice along the longer local axis
  const len = alongW ? w : d, thick = alongW ? d : w;
  const slices = Math.max(3, Math.ceil(len / (thick < 0.5 ? 0.7 : 1.2)));
  const cos = Math.cos(ry), sin = Math.sin(ry);
  // each strip is centered on the local long axis, sized to cover the rotated cross-section
  const stripLen = len / slices;
  const halfDiag = (Math.abs(stripLen * cos) + Math.abs(thick * sin)) / 2;
  const halfDiagZ = (Math.abs(stripLen * sin) + Math.abs(thick * cos)) / 2;
  for (let i = 0; i < slices; i++) {
    const t = -len / 2 + stripLen * (i + 0.5); // position along the local long axis
    const lx = alongW ? t : 0, lz = alongW ? 0 : t;
    const cx = x + lx * cos + lz * sin;
    const cz = z - lx * sin + lz * cos;
    obstacles.push({
      min: new THREE.Vector3(cx - halfDiag, yBase, cz - halfDiagZ),
      max: new THREE.Vector3(cx + halfDiag, yBase + h, cz + halfDiagZ),
      mesh, // shots raycast the real rotated mesh (duplicates in the list are harmless)
    });
  }
  return mesh;
}

// shared sky dome: warm morning gradient (rebuilt per map so clearMap can dispose it)
function makeMorningSky() {
  const cv = document.createElement('canvas');
  cv.width = 16; cv.height = 256;
  const c = cv.getContext('2d');
  const g = c.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, '#2a5aa8');
  g.addColorStop(0.4, '#6fa8e8');
  g.addColorStop(0.68, '#ffcf8f');
  g.addColorStop(0.85, '#ff9e5a');
  g.addColorStop(1, '#e87840');
  c.fillStyle = g; c.fillRect(0, 0, 16, 256);
  const skyTex = new THREE.CanvasTexture(cv);
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(420, 24, 16),
    new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, fog: false })
  );
  sky.raycast = () => {};
  mapRoot.add(sky);
}

function buildDistricts() {
  const ARENA_HALF = 70; // 140x140 — central zone, mid buildings, outer parkour ring
  makeMorningSky();

  // ===== ground: asphalt base + plaza tiles + district color aprons + glowing lanes =====
  {
    const mkGround = (w, d, x, z, mat, y = 0) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat);
      m.rotation.x = -Math.PI / 2;
      m.position.set(x, y, z);
      m.receiveShadow = true;
      m.raycast = () => {};
      mapRoot.add(m);
      return m;
    };
    const asphaltMat = new THREE.MeshStandardMaterial({ color: 0x757d88, roughness: 0.95, map: TEX.asphalt.clone() });
    asphaltMat.map.repeat.set(30, 30); asphaltMat.map.needsUpdate = true;
    mkGround(ARENA_HALF * 2, ARENA_HALF * 2, 0, 0, asphaltMat);

    const tileMat = new THREE.MeshStandardMaterial({ color: 0xd8dce2, roughness: 0.85, map: TEX.tiles.clone() });
    tileMat.map.repeat.set(16, 16); tileMat.map.needsUpdate = true;
    mkGround(56, 56, 0, 0, tileMat, 0.02);

    // district ground aprons
    for (const [pal, x, z, w, d] of [
      [P.foundry, -45, 0, 42, 44], [P.docks, 45, 0, 42, 44],
      [P.skyline, 0, -50, 64, 32], [P.gardens, 0, 50, 64, 32],
    ]) {
      const m = new THREE.MeshStandardMaterial({ color: pal.wall, roughness: 0.95, transparent: true, opacity: 0.22 });
      mkGround(w, d, x, z, m, 0.015);
    }
    // glowing lane strips from plaza to each district (movement-flow readability)
    for (const [pal, x, z, w, d] of [
      [P.foundry, -36, 0, 18, 1.1], [P.docks, 36, 0, 18, 1.1],
      [P.skyline, 0, -36, 1.1, 18], [P.gardens, 0, 36, 1.1, 18],
    ]) {
      const m = new THREE.MeshBasicMaterial({ color: pal.neon, transparent: true, opacity: 0.55 });
      mkGround(w, d, x, z, m, 0.03);
    }
  }

  // perimeter walls — concrete with hazard base and neon top trim
  const WALL_H = 10;
  addBox(0, -ARENA_HALF - 1, ARENA_HALF * 2 + 4, WALL_H, 2, 0x8f97a2, { tex: TEX.concrete, repeat: [24, 3] });
  addBox(0, ARENA_HALF + 1, ARENA_HALF * 2 + 4, WALL_H, 2, 0x8f97a2, { tex: TEX.concrete, repeat: [24, 3] });
  addBox(-ARENA_HALF - 1, 0, 2, WALL_H, ARENA_HALF * 2 + 4, 0x8f97a2, { tex: TEX.concrete, repeat: [24, 3] });
  addBox(ARENA_HALF + 1, 0, 2, WALL_H, ARENA_HALF * 2 + 4, 0x8f97a2, { tex: TEX.concrete, repeat: [24, 3] });
  // hazard stripe skirting + glow line on top of each wall
  for (const [x, z, w, d] of [[0, -ARENA_HALF, 140, 0.3], [0, ARENA_HALF, 140, 0.3], [-ARENA_HALF, 0, 0.3, 140], [ARENA_HALF, 0, 0.3, 140]]) {
    addDecor(x, 0, z, w, 1.2, d, 0xe8b40f, { rough: 0.7 }).material.map = TEX.hazard;
    addDecor(x, WALL_H - 0.2, z, w, 0.35, d, 0x18e0f0, { emissive: 0x18e0f0, emissiveIntensity: 2 });
  }

  // ================= CENTRAL ZONE: THE PLAZA (white + red) =================
  addBox(0, 0, 8, 5, 8, P.plaza.wall, { tex: TEX.panels, repeat: [3, 2] });      // center tower
  addDecor(0, 5.0, 0, 8.4, 0.3, 8.4, P.plaza.trim);                              // roof cap
  addDecor(0, 2.4, 0, 8.15, 0.25, 8.15, P.plaza.neon, { emissive: P.plaza.neon, emissiveIntensity: 2 }); // glow band
  neonSign('ARENA', P.plaza.neon, 0, 4.0, 4.15, 0, 0.9);
  neonSign('ARENA', P.plaza.neon, 0, 4.0, -4.15, Math.PI, 0.9);
  addDecor(0, 5.3, 0, 0.15, 2.6, 0.15, 0x333a44, { metal: 0.8 });                // antenna
  addDecor(0, 7.9, 0, 0.3, 0.3, 0.3, 0xff3b30, { emissive: 0xff3b30, emissiveIntensity: 3 });

  addBox(-18, -18, 6, 2.5, 6, P.plaza.wall, { tex: TEX.panels });
  addBox(18, 18, 6, 2.5, 6, P.plaza.wall, { tex: TEX.panels });
  addBox(18, -18, 6, 2.5, 6, P.plaza.wall, { tex: TEX.panels });
  addBox(-18, 18, 6, 2.5, 6, P.plaza.wall, { tex: TEX.panels });
  for (const [x, z] of [[-18, -18], [18, 18], [18, -18], [-18, 18]]) {
    addDecor(x, 2.5, z, 6.3, 0.2, 6.3, P.plaza.trim);                            // red cap on each plaza block
  }
  addBox(-10, 8, 3, 3.5, 10, 0xd8d4cc, { tex: TEX.panels });
  addBox(10, -8, 3, 3.5, 10, 0xd8d4cc, { tex: TEX.panels });
  addBox(0, -25, 12, 2, 3, P.plaza.trim, { tex: TEX.concrete });
  addBox(0, 25, 12, 2, 3, P.plaza.trim, { tex: TEX.concrete });
  addBox(-8, -14, 2.5, 1.2, 2.5, 0xb08050, { tex: TEX.wood });                   // wooden crates
  addBox(9, 13, 2.5, 1.2, 2.5, 0xb08050, { tex: TEX.wood });
  addBox(22, 5, 2.5, 1.2, 2.5, 0xb08050, { tex: TEX.wood });
  addBox(-22, -6, 2.5, 1.2, 2.5, 0xb08050, { tex: TEX.wood });
  // stairs onto the center tower roof (y=5) — ascend TOWARD the tower, top step flush with its face
  for (let i = 1; i <= 9; i++) {
    addBox(0, 14.45 - i * 1.1, 3, i * 0.5, 1.1, 0xd0ccc4, { tex: TEX.concrete });
  }

  // ================= REAL BUILDINGS: walls, windows, doors, interior stairs =================
  // rot: 0=door faces +X, 1=door faces -X, 2=door faces +Z, 3=door faces -Z
  function makeBuilding(cx, cz, rot, pal = P.steel) {
    const FH = 3.5, T = 0.4, SLAB = 0.4;
    const WALL = pal.wall, SLABC = 0x9aa2ac, TRIM = pal.trim;

    // local -> world transform (rotates footprint in 90° steps)
    function put(lx, ly, lz, w, h, d, color = WALL, opts = { tex: TEX.panels }) {
      let x = lx, z = lz, ww = w, dd = d;
      if (rot === 1) { x = -lx; z = -lz; }
      else if (rot === 2) { x = -lz; z = lx; ww = d; dd = w; }
      else if (rot === 3) { x = lz; z = -lx; ww = d; dd = w; }
      addPlatform(cx + x, ly, cz + z, ww, h, dd, color, opts);
    }
    function deco(lx, ly, lz, w, h, d, color, opts = {}) {
      let x = lx, z = lz, ww = w, dd = d;
      if (rot === 1) { x = -lx; z = -lz; }
      else if (rot === 2) { x = -lz; z = lx; ww = d; dd = w; }
      else if (rot === 3) { x = lz; z = -lx; ww = d; dd = w; }
      addDecor(cx + x, ly, cz + z, ww, h, dd, color, opts);
    }

    // --- GROUND FLOOR walls (y 0 -> 3.5) ---
    put(6.8, 0, -3.5, T, FH, 5);
    put(6.8, 0, 3.5, T, FH, 5);
    put(6.8, 2.6, 0, T, FH - 2.6, 2);          // lintel over the door
    put(-6.8, 0, 0, T, FH, 12);
    for (const s of [1, -1]) {
      put(-4.5, 0, s * 5.8, 5, FH, T);
      put(4.5, 0, s * 5.8, 5, FH, T);
      put(0, 0, s * 5.8, 4, 1.1, T);           // sill
      put(0, 2.3, s * 5.8, 4, FH - 2.3, T);    // lintel
    }
    // door frame glow
    deco(6.95, 0, -1.1, 0.15, 2.7, 0.2, pal.neon, { emissive: pal.neon, emissiveIntensity: 2 });
    deco(6.95, 0, 1.1, 0.15, 2.7, 0.2, pal.neon, { emissive: pal.neon, emissiveIntensity: 2 });
    // --- INTERIOR STAIRS along -X wall ---
    for (let i = 1; i <= 7; i++) {
      put(-5.5, 0, -4.7 + i * 1.0, 2.2, i * 0.5, 1.0, TRIM, { tex: TEX.concrete });
    }
    // --- FLOOR 2 SLAB (hole above the stair run) ---
    put(1.25, FH, 0, 11.1, SLAB, 12, SLABC, { tex: TEX.concrete });
    put(-5.55, FH, 4.85, 2.4, SLAB, 2.3, SLABC, { tex: TEX.concrete });
    put(-5.55, FH, -5.35, 2.4, SLAB, 1.3, SLABC, { tex: TEX.concrete });
    // --- FLOOR 2 walls with BIG jump-out windows ---
    const F2 = FH + SLAB;
    put(6.8, F2, -5.0, T, FH, 2);
    put(6.8, F2, 0, T, FH, 2);
    put(6.8, F2, 5.0, T, FH, 2);
    put(6.8, F2, -2.5, T, 0.9, 3);
    put(6.8, F2, 2.5, T, 0.9, 3);
    put(-6.8, F2, 0, T, FH, 12);
    for (const s of [1, -1]) {
      put(-4.75, F2, s * 5.8, 4.5, FH, T);
      put(4.75, F2, s * 5.8, 4.5, FH, T);
      put(0, F2, s * 5.8, 5, 0.9, T);
    }
    // accent band between floors
    deco(0, FH - 0.1, -5.95, 13.8, 0.35, 0.12, pal.accent, { emissive: pal.neon, emissiveIntensity: 0.8 });
    deco(0, FH - 0.1, 5.95, 13.8, 0.35, 0.12, pal.accent, { emissive: pal.neon, emissiveIntensity: 0.8 });
    // --- ROOF with knee walls ---
    put(0, F2 + FH, 0, 14, SLAB, 12, SLABC, { tex: TEX.concrete });
    const R = F2 + FH + SLAB;
    put(0, R, -5.8, 14, 0.9, T, TRIM, { tex: TEX.panels });
    put(0, R, 5.8, 14, 0.9, T, TRIM, { tex: TEX.panels });
    put(6.8, R, 0, T, 0.9, 12, TRIM, { tex: TEX.panels });
    put(-6.8, R, 0, T, 0.9, 12, TRIM, { tex: TEX.panels });
    // rooftop clutter: AC unit + pipe + glow strip
    deco(-3, R, 2.5, 2, 1.1, 1.6, 0x7c848e, { metal: 0.6 });
    deco(4, R, -3, 0.5, 1.8, 0.5, 0x666e78, { metal: 0.7 });
    deco(0, R + 0.9, -5.8, 14, 0.18, 0.18, pal.neon, { emissive: pal.neon, emissiveIntensity: 2.2 });
  }

  // WEST + EAST clusters: two buildings facing each other across a 7m alley.
  makeBuilding(-45, -9.5, 2, P.foundry);   // door faces +Z (into the alley)
  makeBuilding(-45, 9.5, 3, P.foundry);    // door faces -Z (into the alley)
  makeBuilding(45, -9.5, 2, P.docks);
  makeBuilding(45, 9.5, 3, P.docks);
  neonSign('FOUNDRY', P.foundry.neon, -45, 8.6, 0, Math.PI / 2, 1.4);
  neonSign('DOCKS', P.docks.neon, 45, 8.6, 0, -Math.PI / 2, 1.4);

  // ================= NORTH & SOUTH SKY BRIDGES (y=5) — Skyline & Gardens =================
  for (const side of [-1, 1]) {
    const bz = side * 45;
    const pal = side < 0 ? P.skyline : P.gardens;
    addPlatform(0, 5, bz, 44, 0.6, 4, 0x8a929e, { tex: TEX.panels, repeat: [12, 1] });
    // guard rails in district color
    addPlatform(0, 5.6, bz - 2.2, 44, 0.9, 0.35, pal.wall, { tex: TEX.panels, repeat: [12, 1] });
    addPlatform(0, 5.6, bz + 2.2, 44, 0.9, 0.35, pal.wall, { tex: TEX.panels, repeat: [12, 1] });
    // glowing edge strips along the deck — visible across the map at night or day
    addDecor(0, 5.62, bz - 2.38, 44, 0.12, 0.1, pal.neon, { emissive: pal.neon, emissiveIntensity: 2.2 });
    addDecor(0, 5.62, bz + 2.38, 44, 0.12, 0.1, pal.neon, { emissive: pal.neon, emissiveIntensity: 2.2 });
    // support pillars with hazard bases
    for (const px of [-16, 0, 16]) {
      addBox(px, bz, 2, 5, 2, pal.trim, { tex: TEX.concrete });
      addDecor(px, 0, bz, 2.2, 0.9, 2.2, 0xe8b40f).material.map = TEX.hazard;
    }
    neonSign(pal.name, pal.neon, 0, 7.2, bz, side < 0 ? 0 : Math.PI, 1.6);
    // stairs at both ends
    for (const end of [-1, 1]) {
      for (let i = 1; i <= 12; i++) {
        addBox(end * (35.7 - i * 1.1), bz, 1.1, i * 0.5, 3, 0x9aa0aa, { tex: TEX.concrete });
      }
    }
  }

  // ================= CORNER SNIPER TOWERS (y=8 perches) =================
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const tx = sx * 60, tz = sz * 60;
    const pal = sz < 0 ? P.skyline : P.gardens;
    addBox(tx, tz, 5, 8, 5, P.steel.wall, { tex: TEX.panels, repeat: [2, 3] });
    addPlatform(tx, 8.0, tz - sz * 3.2, 5, 0.9, 0.4, pal.trim, { tex: TEX.panels });
    addPlatform(tx - sx * 3.2, 8.0, tz, 0.4, 0.9, 5, pal.trim, { tex: TEX.panels });
    // vertical neon corner strips + beacon
    addDecor(tx - sx * 2.6, 0.5, tz - sz * 2.6, 0.2, 7.5, 0.2, pal.neon, { emissive: pal.neon, emissiveIntensity: 2 });
    addDecor(tx, 8.9, tz, 0.12, 2.2, 0.12, 0x333a44, { metal: 0.8 });
    addDecor(tx, 11.1, tz, 0.28, 0.28, 0.28, pal.neon, { emissive: pal.neon, emissiveIntensity: 3 });
  }

  // ================= FLOATING GLIDE PANELS (outer parkour ring) =================
  // holographic movement lanes — translucent with glowing edges so routes read from anywhere
  function glidePanel(px, py, pz, w, h, d, pal) {
    addPlatform(px, py, pz, w, h, d, pal.accent, { tex: TEX.panels, opacity: 0.75, emissive: pal.neon, emissiveIntensity: 0.25 });
    addDecor(px, py + h - 0.08, pz, w + 0.06, 0.14, d + 0.06, pal.neon, { emissive: pal.neon, emissiveIntensity: 2.4 });
  }
  // wall-jump chimneys next to each tower
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const cx = sx * 52, cz = sz * 60;
    const pal = sz < 0 ? P.skyline : P.gardens;
    glidePanel(cx - 1.6, 0.5, cz, 0.4, 8, 5, pal);
    glidePanel(cx + 1.6, 0.5, cz, 0.4, 8, 5, pal);
  }
  // glide panel chains along the outer ring
  const panelChain = [
    [P.foundry, -56, 2.0, -14, 0.4, 6, 6], [P.foundry, -62, 3.0, -26, 0.4, 6, 6], [P.foundry, -56, 4.0, -38, 0.4, 6, 6],
    [P.docks, 56, 2.0, 14, 0.4, 6, 6], [P.docks, 62, 3.0, 26, 0.4, 6, 6], [P.docks, 56, 4.0, 38, 0.4, 6, 6],
    [P.skyline, -38, 2.5, -60, 6, 6, 0.4], [P.skyline, -24, 3.5, -56, 6, 6, 0.4],
    [P.skyline, 38, 2.5, -60, 6, 6, 0.4], [P.skyline, 24, 3.5, -56, 6, 6, 0.4],
    [P.gardens, -38, 2.5, 60, 6, 6, 0.4], [P.gardens, -24, 3.5, 56, 6, 6, 0.4],
    [P.gardens, 38, 2.5, 60, 6, 6, 0.4], [P.gardens, 24, 3.5, 56, 6, 6, 0.4],
  ];
  for (const [pal, px, py, pz, w, h, d] of panelChain) glidePanel(px, py, pz, w, h, d, pal);

  // scattered mid-zone cover — tinted toward the nearest district
  addBox(-35, -20, 3, 3, 8, P.foundry.wall, { tex: TEX.panels });
  addBox(35, 20, 3, 3, 8, P.docks.wall, { tex: TEX.panels });
  addBox(-20, 35, 8, 3, 3, P.gardens.wall, { tex: TEX.panels });
  addBox(20, -35, 8, 3, 3, P.skyline.wall, { tex: TEX.panels });
  addBox(-50, 25, 2.5, 1.2, 2.5, 0xb08050, { tex: TEX.wood });
  addBox(50, -25, 2.5, 1.2, 2.5, 0xb08050, { tex: TEX.wood });
  // light poles at plaza corners (decor with glow heads)
  for (const [lx, lz] of [[-26, -26], [26, 26], [26, -26], [-26, 26]]) {
    addDecor(lx, 0, lz, 0.25, 6, 0.25, 0x39404a, { metal: 0.7 });
    addDecor(lx, 6, lz, 0.8, 0.3, 0.8, 0xfff2cc, { emissive: 0xffe8b0, emissiveIntensity: 2.5 });
  }

  // ===== static batching: merge the hundreds of box meshes into a handful of draws =====
  // Originals stay in the scene invisible — raycasting (shot wall-hits) ignores visibility,
  // so hit detection is untouched; only rendering moves to the merged meshes.
  mergeStaticMeshes();
}

function mergeStaticMeshes() {
  const groups = new Map(); // material signature -> { mat, geos }
  for (const mesh of staticMeshes) {
    const m = mesh.material;
    if (m.transparent) continue; // keep translucent panels as-is (sorting)
    const key = [
      m.map ? m.map.source.uuid : 'none', m.color.getHex(), m.roughness, m.metalness,
      m.emissive.getHex(), m.emissiveIntensity,
    ].join('|');
    let g = groups.get(key);
    if (!g) { g = { mat: m, geos: [] }; groups.set(key, g); }
    mesh.updateMatrixWorld(true);
    const geo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
    // bake per-mesh texture repeat into UVs so one material (repeat 1) serves the group
    if (m.map && (m.map.repeat.x !== 1 || m.map.repeat.y !== 1)) {
      const uv = geo.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * m.map.repeat.x, uv.getY(i) * m.map.repeat.y);
    }
    g.geos.push(geo);
    mesh.visible = false; // stays raycastable, no longer drawn
  }
  for (const { mat, geos } of groups.values()) {
    const merged = mergeGeometries(geos, false);
    if (!merged) continue;
    const mm = mat.clone();
    if (mm.map) { mm.map = mat.map; mm.map.repeat.set(1, 1); }
    const mesh = new THREE.Mesh(merged, mm);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.raycast = () => {}; // hits come from the invisible originals
    mapRoot.add(mesh);
    for (const g of geos) g.dispose();
  }
}

// ================= SHIPMENT — container yard (COD scale: 1.8m character, 6.1m containers) =================
// Real proportions: 20-ft containers are 6.06 x 2.44 x 2.59m; the yard is ~30x30m.
const CONTAINER = { L: 6.1, W: 2.44, H: 2.6 };
// realistic weathered shipping palette (MW2019 tones — no purple toy blocks)
const C_COLORS = [0xa63c2e, 0x2e5f8a, 0x3f7350, 0xc46a2a, 0xcfc9ba, 0xc9a227, 0x6f7a84];
const C_BRANDS = ['COSCO', 'MAERSK', 'EVERLINE', 'HANJIN', 'SEALAND', '', 'COSCO'];

// corrugated container side — vertical ribs, rust streaks, frame rails, optional brand text.
// Grayscale so the material color tints it; cached per brand.
const _corrCache = {};
function corrTex(label = '') {
  if (_corrCache[label]) return _corrCache[label];
  const t = makeTex((c, w, h) => {
    c.fillStyle = '#d8d8d8'; c.fillRect(0, 0, w, h);
    for (let x = 0; x < w; x += 16) {                       // vertical corrugation ribs
      const g = c.createLinearGradient(x, 0, x + 16, 0);
      g.addColorStop(0, 'rgba(0,0,0,0.32)');
      g.addColorStop(0.35, 'rgba(255,255,255,0.16)');
      g.addColorStop(0.65, 'rgba(255,255,255,0.16)');
      g.addColorStop(1, 'rgba(0,0,0,0.32)');
      c.fillStyle = g; c.fillRect(x, 0, 16, h);
    }
    noise(c, w, h, 700, 0.10);
    for (let i = 0; i < 14; i++) {                          // rust streaks bleeding from the top
      c.fillStyle = `rgba(90,45,20,${0.10 + Math.random() * 0.18})`;
      c.fillRect(Math.random() * w, 0, 2 + Math.random() * 3, 30 + Math.random() * 120);
    }
    c.fillStyle = 'rgba(0,0,0,0.42)';                       // top/bottom steel frame rails
    c.fillRect(0, 0, w, 10); c.fillRect(0, h - 10, w, 10);
    if (label) {                                            // shipping-line branding
      c.font = 'bold 58px Arial'; c.textAlign = 'center';
      c.fillStyle = 'rgba(15,15,15,0.45)'; c.fillText(label, w / 2 + 3, h / 2 + 20);
      c.fillStyle = 'rgba(255,255,255,1)'; c.fillText(label, w / 2, h / 2 + 17);
    }
  }, 512, 256);
  _corrCache[label] = t;
  return t;
}
const cTex = (i) => corrTex(C_BRANDS[i % C_BRANDS.length]);

function shippingContainer(x, z, ry, stack = 1, colorIdx = 0) {
  // solid container box (+optional second stacked on top), corrugated ribbed sides
  const { L, W, H } = CONTAINER;
  const horiz = ry === 0;         // ry 0: long side along X, Math.PI/2: along Z
  const w = horiz ? L : W, d = horiz ? W : L;
  for (let s = 0; s < stack; s++) {
    const idx = colorIdx + s;
    const color = C_COLORS[idx % C_COLORS.length];
    addPlatform(x, s * H, z, w, H, d, color, { tex: cTex(idx), repeat: [2, 1], rough: 0.72, metal: 0.35 });
    // door-end detail stripes
    addDecor(x + (horiz ? w / 2 - 0.06 : 0), s * H + 0.3, z + (horiz ? 0 : d / 2 - 0.06),
      horiz ? 0.1 : w * 0.9, H - 0.6, horiz ? d * 0.9 : 0.1, 0x20242c, { rough: 0.9 });
  }
}

function tunnelContainer(x, z, ry, colorIdx = 0) {
  // open container you can walk/shoot through: two side walls + roof slab
  const { L, W, H } = CONTAINER;
  const horiz = ry === 0;
  const color = C_COLORS[colorIdx % C_COLORS.length];
  const tx = { tex: cTex(colorIdx), repeat: [2, 1], rough: 0.72, metal: 0.35 };
  const side = 0.18;
  if (horiz) {
    addPlatform(x, 0, z - W / 2 + side / 2, L, H - 0.2, side, color, tx);
    addPlatform(x, 0, z + W / 2 - side / 2, L, H - 0.2, side, color, tx);
    addPlatform(x, H - 0.2, z, L, 0.2, W, color, tx);
  } else {
    addPlatform(x - W / 2 + side / 2, 0, z, side, H - 0.2, L, color, tx);
    addPlatform(x + W / 2 - side / 2, 0, z, side, H - 0.2, L, color, tx);
    addPlatform(x, H - 0.2, z, W, 0.2, L, color, tx);
  }
}

// diagonal (arbitrary-angle) versions for the MW2019 pinwheel center
function rotatedContainer(x, z, ry, colorIdx = 0, stack = 1) {
  const { L, W, H } = CONTAINER;
  for (let s = 0; s < stack; s++) {
    const idx = colorIdx + s * 2;
    addRotatedBox(x, s * H, z, L, H, W, ry, C_COLORS[idx % C_COLORS.length], { tex: cTex(idx), repeat: [2, 1], rough: 0.72, metal: 0.35 });
  }
}

function rotatedTunnel(x, z, ry, colorIdx = 0) {
  const { L, W, H } = CONTAINER;
  const color = C_COLORS[colorIdx % C_COLORS.length];
  const tx = { tex: cTex(colorIdx), repeat: [2, 1], rough: 0.72, metal: 0.35 };
  const side = 0.18, off = W / 2 - side / 2;
  const cos = Math.cos(ry), sin = Math.sin(ry);
  // two rotated side walls, offset perpendicular to the tunnel axis
  for (const s of [-1, 1]) {
    addRotatedBox(x + s * off * sin, 0, z + s * off * cos, L, H - 0.2, side, ry, color, tx);
  }
  // roof: rotated mesh only, with a single coarse AABB (you can stand on it)
  addRotatedBox(x, H - 0.2, z, L, 0.2, W, ry, color, tx);
}

// ---- procedural props (COD-scale set dressing) ----
function burnBarrel(x, z) {
  // rusty oil drum with a glowing fire mouth + flame light — the MW2019 centerpiece
  const drum = new THREE.Mesh(
    new THREE.CylinderGeometry(0.32, 0.32, 0.95, 14),
    new THREE.MeshStandardMaterial({ color: 0x6e3a24, roughness: 0.9, metalness: 0.35 })
  );
  drum.position.set(x, 0.475, z);
  drum.castShadow = true;
  mapRoot.add(drum);
  const fire = new THREE.Mesh(
    new THREE.CylinderGeometry(0.26, 0.29, 0.12, 12),
    new THREE.MeshStandardMaterial({ color: 0xff7722, emissive: 0xff5500, emissiveIntensity: 3.5 })
  );
  fire.position.set(x, 0.98, z);
  fire.raycast = () => {};
  mapRoot.add(fire);
  const glow = new THREE.PointLight(0xff7733, 2.2, 9, 1.6);
  glow.position.set(x, 1.5, z);
  mapRoot.add(glow);
  obstacles.push({ min: new THREE.Vector3(x - 0.34, 0, z - 0.34), max: new THREE.Vector3(x + 0.34, 1.0, z + 0.34), mesh: drum });
}

function palletStack(x, z, count = 3, ry = 0) {
  // wooden pallets: slat boards over runners, stacked with slight rotation jitter
  for (let i = 0; i < count; i++) {
    const p = new THREE.Group();
    const wood = new THREE.MeshStandardMaterial({ color: 0xa8824f, roughness: 0.85, map: TEX.wood.clone() });
    for (let s = 0; s < 5; s++) {
      const slat = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.035, 0.16), wood);
      slat.position.set(0, 0.12, -0.5 + s * 0.25);
      p.add(slat);
    }
    for (const rx of [-0.5, 0, 0.5]) {
      const runner = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 1.2), wood);
      runner.position.set(rx, 0.055, 0);
      p.add(runner);
    }
    p.position.set(x, i * 0.16, z);
    p.rotation.y = ry + (i % 2) * 0.12;
    p.traverse(o => { if (o.isMesh) o.castShadow = true; });
    mapRoot.add(p);
  }
  const proxy = new THREE.Mesh(new THREE.BoxGeometry(1.3, count * 0.16 + 0.05, 1.3), new THREE.MeshBasicMaterial());
  proxy.position.set(x, (count * 0.16 + 0.05) / 2, z);
  proxy.visible = false;
  mapRoot.add(proxy);
  obstacles.push({
    min: new THREE.Vector3(x - 0.65, 0, z - 0.65),
    max: new THREE.Vector3(x + 0.65, count * 0.16 + 0.05, z + 0.65),
    mesh: proxy,
  });
}

function forklift(x, z, ry) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.9, 1.9),
    new THREE.MeshStandardMaterial({ color: 0xd9a013, roughness: 0.5, metalness: 0.4 }));
  body.position.y = 0.75;
  g.add(body);
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.85, 1.0),
    new THREE.MeshStandardMaterial({ color: 0x2a2f38, roughness: 0.6, metalness: 0.5 }));
  cabin.position.set(0, 1.6, 0.15);
  g.add(cabin);
  const mastMat = new THREE.MeshStandardMaterial({ color: 0x3a4048, metalness: 0.7, roughness: 0.4 });
  for (const mx of [-0.35, 0.35]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.1, 2.4, 0.12), mastMat);
    rail.position.set(mx, 1.2, -1.05);
    g.add(rail);
  }
  for (const fx of [-0.32, 0.32]) {
    const forkArm = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.05, 1.1), mastMat);
    forkArm.position.set(fx, 0.12, -1.65);
    g.add(forkArm);
  }
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x14161c, roughness: 0.9 });
  for (const [wx, wz] of [[-0.55, 0.6], [0.55, 0.6], [-0.55, -0.55], [0.55, -0.55]]) {
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.22, 12), wheelMat);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(wx, 0.3, wz);
    g.add(wheel);
  }
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  mapRoot.add(g);
  addRotatedBox(x, 0, z, 1.3, 2.05, 3.2, ry, 0xd9a013, { rough: 0.5 }).visible = false; // collision + raycast proxy
}

// green construction fence with steel posts + barbed-wire coil — the real Shipment perimeter.
// Visible height ~2.5m; an invisible tall collision wall above keeps players in bounds.
function fenceRun(x, z, len, horiz) {
  const FH = 2.5;
  const w = horiz ? len : 0.14, d = horiz ? 0.14 : len;
  // green panel
  addPlatform(x, 0, z, w, FH, d, 0x3e6b3a, { tex: TEX.panels, repeat: [Math.max(2, len / 3), 1], rough: 0.85, metal: 0.15 });
  // steel posts every ~3m
  const posts = Math.floor(len / 3);
  for (let i = 0; i <= posts; i++) {
    const t = -len / 2 + (len / posts) * i;
    addDecor(x + (horiz ? t : 0.1), 0, z + (horiz ? 0.1 : t), 0.12, FH + 0.5, 0.12, 0x8a919c, { metal: 0.75, rough: 0.4 });
  }
  // barbed-wire coil along the top (decor cylinder look via thin boxes)
  addDecor(x, FH + 0.28, z, horiz ? len : 0.3, 0.3, horiz ? 0.3 : len, 0xb8bec8, { metal: 0.85, rough: 0.35 });
  addDecor(x, FH + 0.28, z, horiz ? len : 0.16, 0.44, horiz ? 0.16 : len, 0x9aa1ac, { metal: 0.85, rough: 0.35 });
  // invisible tall wall above the fence: no escaping the yard (proxy AABB, never drawn/merged)
  const proxy = new THREE.Mesh(new THREE.BoxGeometry(w, 8, d), new THREE.MeshBasicMaterial());
  proxy.position.set(x, FH + 4, z);
  proxy.visible = false;
  mapRoot.add(proxy);
  obstacles.push({
    min: new THREE.Vector3(x - w / 2, FH, z - d / 2),
    max: new THREE.Vector3(x + w / 2, FH + 8, z + d / 2),
    mesh: proxy,
  });
}

function dumpster(x, z, ry) {
  // green waste dumpster with black lid, like the reference's GNT HAULING units
  addRotatedBox(x, 0, z, 2.0, 1.15, 1.1, ry, 0x2f5e33, { tex: TEX.panels, repeat: [2, 1], rough: 0.7, metal: 0.3 });
  const lidY = 1.15;
  const lid = addRotatedBox(x, lidY, z, 2.02, 0.12, 1.12, ry, 0x1c2024, { rough: 0.6, metal: 0.4 });
  lid.raycast = () => {};
}

function floodTower(x, z) {
  // corner light tower — Shipment's actual skyline (no crane in MW2019)
  addDecor(x, 0, z, 0.28, 7.5, 0.28, 0x5a626e, { metal: 0.7, rough: 0.45 });
  addDecor(x, 7.5, z, 1.5, 0.35, 0.5, 0x3a4048, { metal: 0.6 });
  addDecor(x, 7.35, z, 1.3, 0.12, 0.42, 0xfff2cc, { emissive: 0xffe8b0, emissiveIntensity: 2.8 });
}

function buildShipment() {
  const HALF = 16; // 32x32 yard
  makeMorningSky();
  // dark cracked asphalt yard (the real map's ground, not light concrete)
  const pad = new THREE.MeshStandardMaterial({ color: 0x6a7078, roughness: 0.96, map: TEX.asphalt.clone() });
  pad.map.repeat.set(14, 14); pad.map.needsUpdate = true;
  const g = new THREE.Mesh(new THREE.PlaneGeometry(HALF * 2 + 10, HALF * 2 + 10), pad);
  g.rotation.x = -Math.PI / 2; g.receiveShadow = true; g.raycast = () => {};
  mapRoot.add(g);
  // painted parking stalls (white bars along north + south edges, like the top-down reference)
  for (let i = -3; i <= 3; i++) {
    addDecor(i * 3.4, 0.01, -HALF + 3.5, 0.18, 0.02, 5, 0xd8dce2, { rough: 0.9 });
    addDecor(i * 3.4, 0.01, HALF - 3.5, 0.18, 0.02, 5, 0xd8dce2, { rough: 0.9 });
  }
  addDecor(0, 0.01, -HALF + 1, HALF * 2 - 4, 0.02, 0.18, 0xd8dce2, { rough: 0.9 });
  addDecor(0, 0.01, HALF - 1, HALF * 2 - 4, 0.02, 0.18, 0xd8dce2, { rough: 0.9 });

  // ---- perimeter: green construction fence + barbed wire (the real Shipment boundary) ----
  fenceRun(0, -HALF - 0.1, HALF * 2 + 0.6, true);
  fenceRun(0, HALF + 0.1, HALF * 2 + 0.6, true);
  fenceRun(-HALF - 0.1, 0, HALF * 2 + 0.6, false);
  fenceRun(HALF + 0.1, 0, HALF * 2 + 0.6, false);

  // ---- the WEST stack cluster: the big irregular container mountain (map's landmark wall) ----
  // Mixed 2- and 3-high stacks just inside the fence, like both references show.
  shippingContainer(-HALF + 1.4, -9, Math.PI / 2, 3, 0);
  shippingContainer(-HALF + 1.4, -2.7, Math.PI / 2, 2, 2);
  shippingContainer(-HALF + 1.4, 3.6, Math.PI / 2, 3, 4);
  shippingContainer(-HALF + 1.4, 9.9, Math.PI / 2, 2, 1);
  shippingContainer(-HALF + 3.9, -5.8, Math.PI / 2, 2, 5);   // second row, lower — creates the stepped skyline
  shippingContainer(-HALF + 3.9, 6.7, Math.PI / 2, 1, 3);    // climbable single in front

  // ---- the MW2019 center: four containers at 45° in a pinwheel around the barrel ----
  const D = 5.6, A = Math.PI / 4;
  rotatedContainer(-D, -D, A, 0, 3);     // NW: triple stack — the center landmark tower
  rotatedContainer(D, D, A, 1, 2);       // SE: double stack
  rotatedTunnel(D, -D, -A, 2);           // NE tunnel, angled \
  rotatedTunnel(-D, D, -A, 3);           // SW tunnel, angled \
  burnBarrel(0, 0);                      // dead center, the landmark

  // ---- scattered singles: north red, south blue at the fence line, east diagonal pair ----
  shippingContainer(2, -HALF + 2.6, 0, 1, 0);               // north single (red, like the ref)
  shippingContainer(-2, HALF - 2.6, 0, 1, 1);               // south single (blue)
  rotatedContainer(HALF - 3.2, -3.5, 0.35, 1, 1);           // east skewed singles
  rotatedContainer(HALF - 3.6, 3.8, -0.3, 3, 1);

  // ---- set dressing ----
  palletStack(-HALF + 6.2, HALF - 3, 4, 0.3);
  palletStack(HALF - 3.2, -HALF + 3.2, 5, 0.7);
  palletStack(6.5, -HALF + 2.4, 2, 1.2);
  forklift(HALF - 3.5, HALF - 4, -0.9);
  dumpster(-4.5, HALF - 1.9, 0.15);                          // dumpsters along the south fence
  dumpster(4.8, HALF - 1.9, -0.1);
  addBox(HALF - 2.4, 8.6, 2.2, 1.2, 2.2, 0xb08050, { tex: TEX.wood }); // crate cluster east

  // ---- corner floodlight towers (the actual Shipment skyline) ----
  floodTower(-HALF + 0.9, -HALF + 0.9);
  floodTower(HALF - 0.9, -HALF + 0.9);
  floodTower(-HALF + 0.9, HALF - 0.9);
  floodTower(HALF - 0.9, HALF - 0.9);

  neonSign('SHIPMENT', 0xffaa33, 0, 6.4, -HALF - 0.6, 0, 1.5);
  mergeStaticMeshes();
}

// ================= KILLHOUSE — training warehouse (COD4 inspired) =================
// One enclosed 42x26m warehouse, 9m walls, skylight roof strips. A two-story
// plywood house in the center, catwalks along both long walls, a rafter plank
// crossing over the house roof, plywood barriers forming CQB lanes.
function buildKillhouse() {
  const HX = 21, HZ = 13, WALL_H = 9;
  makeMorningSky(); // visible through the skylights
  // roof blocks the sun — interior needs its own ambient fill (lives in mapRoot, disposed with the map)
  mapRoot.add(new THREE.AmbientLight(0xf2ead8, 1.1)); // warm fill so shaded undersides stay readable

  // concrete slab floor
  const slab = new THREE.MeshStandardMaterial({ color: 0xa39a88, roughness: 0.95, map: TEX.concrete.clone() });
  slab.map.repeat.set(14, 9); slab.map.needsUpdate = true;
  const g = new THREE.Mesh(new THREE.PlaneGeometry(HX * 2, HZ * 2), slab);
  g.rotation.x = -Math.PI / 2; g.receiveShadow = true; g.raycast = () => {};
  mapRoot.add(g);

  // ---- warehouse shell: corrugated steel, like the real training facility ----
  const shell = { tex: corrTex(''), repeat: [10, 3], rough: 0.65, metal: 0.4 };
  addBox(0, -HZ - 0.5, HX * 2 + 2, WALL_H, 1, 0x7d848e, shell);
  addBox(0, HZ + 0.5, HX * 2 + 2, WALL_H, 1, 0x7d848e, shell);
  addBox(-HX - 0.5, 0, 1, WALL_H, HZ * 2 + 2, 0x7d848e, { ...shell, repeat: [6, 3] });
  addBox(HX + 0.5, 0, 1, WALL_H, HZ * 2 + 2, 0x7d848e, { ...shell, repeat: [6, 3] });
  // roof strips with skylight gaps (sun beams reach inside; also caps wall jumps)
  for (const rz of [-HZ + 2.2, 0, HZ - 2.2]) {
    addPlatform(0, WALL_H, rz, HX * 2 + 2, 0.4, 4.4, 0x646c78, { tex: TEX.panels, repeat: [12, 1] });
  }
  // steel roof trusses spanning the skylight gaps (decor — the COD4 rafter skyline)
  for (const tx of [-14, -7, 0, 7, 14]) {
    addDecor(tx, WALL_H - 0.9, 0, 0.3, 0.3, HZ * 2, 0x4a5058, { metal: 0.7, rough: 0.4 });
    addDecor(tx, WALL_H - 1.7, 0, 0.18, 1.4, 0.18, 0x4a5058, { metal: 0.7, rough: 0.4 });
  }
  // high window bands on the long walls (glow panels — daylight through dirty glass)
  for (const side of [-1, 1]) {
    for (const wx of [-14, -7, 0, 7, 14]) {
      addDecor(wx, 6.6, side * (HZ + 0.02), 3.6, 1.4, 0.1, 0xdfe8f2, { emissive: 0xcfdcea, emissiveIntensity: 0.9 });
    }
  }
  // hanging work lights under the roof
  for (const lx of [-12, 0, 12]) {
    addDecor(lx, WALL_H - 0.5, 0, 3.2, 0.15, 0.5, 0xfff2cc, { emissive: 0xffe8b0, emissiveIntensity: 2.6 });
  }

  // ---- central two-story house (plywood mockup, real interior) ----
  const HW = 5.5, HD = 4, T = 0.22, F1 = 3, ROOF = 6; // half-width/depth, wall thickness, floor heights
  const wood = { tex: TEX.plywood, repeat: [3, 1], rough: 0.85, metal: 0.02 };
  // ground-floor walls with doorway (south) and window cuts (east/west)
  addBox(0, -HD, HW * 2, F1, T, 0xc9aa72, wood);                                  // north wall
  addBox(-HW + 1.5, HD, HW * 2 - 3 - 1.4, F1, T, 0xc9aa72, wood);                 // south wall left of door
  addBox(HW - 1.2, HD, 2.4, F1, T, 0xc9aa72, wood);                               // south wall right of door
  addPlatform(0, 1.9, HD, 1.4, 1.1, T, 0xc9aa72, wood);                           // header above the doorway
  for (const sx of [-1, 1]) {                                                     // east/west: window sill + header
    addPlatform(sx * HW, 0, 0, T, 1.0, HD * 2, 0xc9aa72, wood);                   // sill band
    addPlatform(sx * HW, 2.1, 0, T, 0.9, HD * 2, 0xc9aa72, wood);                 // header band
    addPlatform(sx * HW, 1.0, -HD + 0.8, T, 1.1, 1.6, 0xc9aa72, wood);            // window mullions
    addPlatform(sx * HW, 1.0, HD - 0.8, T, 1.1, 1.6, 0xc9aa72, wood);
  }
  // second-floor slab with a hole above the full stair run (west wall) — proven pattern
  // from the DISTRICTS buildings: steps rise through the hole, nothing overhead.
  addPlatform(1.15, F1, 0, 8.6, 0.3, HD * 2, 0xb2925c, wood);      // main slab (east of hole)
  addPlatform(-4.35, F1, 3.4, 2.4, 0.3, 1.2, 0xb2925c, wood);      // slab strip past stair top
  addPlatform(-4.35, F1, -3.8, 2.4, 0.3, 0.4, 0xb2925c, wood);     // slab sliver at stair base
  // interior stairs along the west wall (6 steps x 0.5 = 3.0, flush with slab)
  for (let i = 1; i <= 6; i++) {
    addPlatform(-4.4, 0, -3.9 + i * 1.0, 2.0, i * 0.5, 1.0, 0xa8895a, { tex: TEX.plywood, repeat: [2, 1] });
  }
  // second-floor walls: big open windows all around (jump-out floor)
  addPlatform(0, F1 + 2.2, -HD, HW * 2, 0.8, T, 0xc9aa72, wood);                  // north header
  addPlatform(0, F1 + 2.2, HD, HW * 2, 0.8, T, 0xc9aa72, wood);                   // south header
  addPlatform(0, F1, -HD, HW * 2, 0.9, T, 0xc9aa72, wood);                        // north sill
  addPlatform(0, F1, HD, HW * 2, 0.9, T, 0xc9aa72, wood);                         // south sill
  for (const sx of [-1, 1]) {
    addPlatform(sx * HW, F1, 0, T, 0.9, HD * 2, 0xc9aa72, wood);
    addPlatform(sx * HW, F1 + 2.2, 0, T, 0.8, HD * 2, 0xc9aa72, wood);
    addPlatform(sx * HW, F1 + 0.9, 0, T, 1.3, 1.2, 0xc9aa72, wood);               // center mullion
  }
  // house roof (walkable)
  addPlatform(0, ROOF, 0, HW * 2 + 0.4, 0.25, HD * 2 + 0.4, 0xa8895a, wood);
  neonSign('KILLHOUSE', 0xffaa33, 0, ROOF + 1.4, -HD - 0.3, 0, 1.2);

  // ---- perimeter catwalks along the long walls (y=3.5) with stairs at both ends ----
  for (const side of [-1, 1]) {
    const cz = side * (HZ - 1.6);
    addPlatform(0, 3.5, cz, 30, 0.3, 2.6, 0x6b675e, { tex: TEX.panels, repeat: [10, 1] });
    addDecor(0, 3.8, cz + side * 1.25, 30, 1.0, 0.08, 0x8a94a2, { metal: 0.7 });   // rail (decor: shots pass, bodies don't need it)
    // stair runs land flush at the deck ends (0.5 steps, auto-climbable)
    for (const end of [-1, 1]) {
      for (let i = 1; i <= 7; i++) {
        addPlatform(end * (22.9 - i * 1.1), 0, cz, 1.1, i * 0.5, 2.4, 0x59626e, { tex: TEX.concrete });
      }
    }
  }

  // ---- plywood room mockups: L- and T-shaped partial walls per the COD4 minimap ----
  const ply = { tex: TEX.plywood, repeat: [3, 1], rough: 0.85 };
  const PLYC = 0xc9aa72, PH = 2.2, PT = 0.25;
  // west half: two L-shaped room corners
  addBox(-15, -6, 5, PH, PT, PLYC, ply);            // L1: wall along X
  addBox(-12.6, -8, PT, PH, 4.2, PLYC, ply);        //     wall along Z
  addBox(-15, 6.5, 4, PH, PT, PLYC, ply);           // L2
  addBox(-17, 4.4, PT, PH, 4.4, PLYC, ply);
  // east half: T-shaped mockup + straight lane wall
  addBox(14.5, -6.5, 6, PH, PT, PLYC, ply);         // T: crossbar
  addBox(14.5, -4.2, PT, PH, 4.4, PLYC, ply);       //    stem
  addBox(16.5, 6, 5, PH, PT, PLYC, ply);            // straight wall
  // short freestanding walls scattered mid-lanes (half-height, vaultable sightline breaks)
  addBox(-7, -9.5, 3, 1.3, PT, PLYC, ply);
  addBox(7, 9.5, 3, 1.3, PT, PLYC, ply);
  addBox(0, -10.5, 2.6, 1.3, PT, PLYC, ply);
  // angled crates (the minimap's scattered diagonal boxes)
  addRotatedBox(-9, 8.5, 3.2, 1.4, 1.6, 0.5, 0xb08050, { tex: TEX.wood });
  addRotatedBox(9.5, -9.2, 3.0, 1.4, 1.5, -0.65, 0xb08050, { tex: TEX.wood });
  addRotatedBox(5.5, 5.8, 2.4, 1.2, 1.4, 0.9, 0xb08050, { tex: TEX.wood });
  // crate stacks in two corners
  addBox(-18.5, -10.5, 2.4, 1.3, 2.4, 0xb08050, { tex: TEX.wood });
  addPlatform(-18.5, 1.3, -10.5, 1.8, 1.2, 1.8, 0x8a6238, { tex: TEX.wood });
  addBox(18.5, 10.5, 2.4, 1.3, 2.4, 0xb08050, { tex: TEX.wood });
  addPlatform(18.5, 1.3, 10.5, 1.8, 1.2, 1.8, 0x8a6238, { tex: TEX.wood });

  // ---- shooting-range corner (SE, like the minimap's target circle) ----
  for (const [tx, tz] of [[19.2, 4.5], [19.2, 7.5]]) {
    addDecor(tx, 0.9, tz, 0.12, 1.5, 1.2, 0xe8e2d4, { rough: 0.85 }).material.map = TEX.target.clone();
  }
  addBox(17.2, 6, 0.2, 1.1, 4.5, PLYC, ply);        // firing-line barrier facing the targets

  // ---- cross-plank: catwalk-to-catwalk flank through the east lane (y=3.5) ----
  addPlatform(10, 3.5, 0, 1.0, 0.2, HZ * 2 - 5.2, 0x39404a, { tex: TEX.panels, repeat: [1, 6], metal: 0.6 });

  // ---- wall-jump chimney west of the house: two plywood training panels, hazard-striped tops ----
  for (const px of [-6.9, -8.6]) {
    addPlatform(px, 0.5, 0, 0.35, 5.5, 4, 0xc9aa72, { tex: TEX.plywood, repeat: [2, 2], rough: 0.85 });
    addDecor(px, 6.0, 0, 0.42, 0.14, 4.06, 0xe8b40f, { rough: 0.7 }).material.map = TEX.hazard.clone();
  }

  mergeStaticMeshes();
}

// ---------- registry ----------
// ===================== BLACKOUT — sealed office floor, lights out =====================
// One office floor at 3am: no windows, no sky, no natural light. Every photon comes from
// dying fluorescents, vending machines, server LEDs and EXIT signs. Ready-or-Not energy.
// Expanded: ~64x42m footprint, 9 zones: server room, open office, lobby, corridor, storage,
// break room, bathrooms, elevator lobby, executive office, conference room.

// Flat-color materials (was: PBR photo textures — flattened for low-poly art cohesion).
// Colors are the measured average of each original texture, so the map's palette is preserved.
const _pbrCache = {};
const FLAT_PBR = {
  carpet: 0x352e25, ceiltile: 0x564a3f, concrete: 0x6a6258, drywall: 0x8c8674,
  metal: 0x3d311c, tiles: 0x896e54, wood: 0x5d2a17,
};
function loadPBR(name, repeatU, repeatV, opts = {}) {
  const key = `${name}_${repeatU}_${repeatV}_${opts.color ?? 'x'}`;
  if (_pbrCache[key]) return _pbrCache[key];
  const c = new THREE.Color(FLAT_PBR[name] ?? 0x808080);
  if (opts.color != null) c.multiply(new THREE.Color(opts.color));
  const mat = new THREE.MeshStandardMaterial({
    color: c,
    roughness: opts.roughness ?? 0.85,
    metalness: opts.metalness ?? 0.05,
    flatShading: true,
  });
  _pbrCache[key] = mat;
  return mat;
}

// Flatten a model's materials to their average texture color: samples each baseColor map
// into a tiny canvas, averages it, drops all maps. Realistic props become palette props.
const _flatColorCache = new Map();
function avgTexColor(tex) {
  if (!tex?.image?.width) return null;
  if (_flatColorCache.has(tex.uuid)) return _flatColorCache.get(tex.uuid);
  const cv = document.createElement('canvas');
  cv.width = cv.height = 16;
  const ctx = cv.getContext('2d');
  try { ctx.drawImage(tex.image, 0, 0, 16, 16); } catch (e) { return null; }
  const d = ctx.getImageData(0, 0, 16, 16).data;
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
  const n = d.length / 4;
  const col = new THREE.Color(r / n / 255, g / n / 255, b / n / 255).convertSRGBToLinear();
  _flatColorCache.set(tex.uuid, col);
  return col;
}
function flattenMaterials(model) {
  model.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (m.map) {
        const c = avgTexColor(m.map);
        if (c) { const tint = m.color.clone(); m.color.copy(c).multiply(tint); m.map = null; }
      }
      if (m.emissiveMap) {
        const c = avgTexColor(m.emissiveMap);
        if (c) { m.emissive.copy(c); m.emissiveMap = null; }
      }
      m.normalMap = null; m.roughnessMap = null; m.metalnessMap = null; m.aoMap = null;
      m.flatShading = true;
      m.needsUpdate = true;
    }
  });
}

// ===== GLB prop loader for BLACKOUT map =====
const _propLoader = new GLTFLoader();
const _propCache = new Map();

/**
 * Load a GLB prop asynchronously. Returns a promise resolving to a cloned scene.
 * Props have raycast disabled (collision boxes handle hit detection).
 * @param {string} name - filename without .glb
 * @param {THREE.Group} targetRoot - mapRoot to add to (captured to guard against map switch)
 */
async function loadProp(name, targetRoot) {
  const path = `/cod/models/props/${name}.glb`;
  let gltf = _propCache.get(name);
  if (!gltf) {
    gltf = await new Promise((resolve, reject) => {
      _propLoader.load(path, resolve, undefined, reject);
    });
    _propCache.set(name, gltf);
  }
  // Clone the scene so each placement is independent
  const model = gltf.scene.clone();
  // Low-poly cohesion: strip photo textures down to their average flat color
  flattenMaterials(model);
  // Disable raycast on all meshes (collision boxes handle bullets/movement)
  model.traverse((o) => {
    if (o.isMesh) {
      o.raycast = () => {};
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  return model;
}

/**
 * Place a prop at position with scale/rotation, guarded against map switch.
 * @param {string} name - prop filename without .glb
 * @param {THREE.Group} targetRoot - reference to the mapRoot at call time
 * @param {number} x - world X
 * @param {number} y - world Y (base)
 * @param {number} z - world Z
 * @param {Object} opts - { scale, rotY, rotX, rotZ }
 */
async function placeProp(name, targetRoot, x, y, z, opts = {}) {
  try {
    const model = await loadProp(name, targetRoot);
    // Guard: if map changed while loading, don't add
    if (!targetRoot.parent) return;
    // Auto-scale: targetH = desired real-world height in meters (models come in wildly
    // different native units), computed from the measured bounding box. Falls back to opts.scale.
    const box = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3(); box.getSize(size);
    let s = 1;
    if (opts.targetH != null && size.y > 1e-6) s = opts.targetH / size.y;
    else if (opts.scale != null) s = opts.scale;
    model.scale.setScalar(s);
    if (opts.rotY != null) model.rotation.y = opts.rotY;
    if (opts.rotX != null) model.rotation.x = opts.rotX;
    if (opts.rotZ != null) model.rotation.z = opts.rotZ;
    // Ground the model: shift so its (scaled) bounding-box bottom sits at y
    model.position.set(x, y - box.min.y * s, z);
    targetRoot.add(model);
  } catch (e) {
    console.warn(`Failed to load prop ${name}:`, e);
  }
}

function buildBlackout() {
  const HX = 32, HZ = 21, CEIL = 4.0;

  // the dark itself: barely-there cool ambient so pitch-black corners stay navigable
  mapRoot.add(new THREE.AmbientLight(0x3d4a66, 1.2));

  // PBR carpet floor
  const carpetMat = loadPBR('carpet', 16, 11, { roughness: 0.97, color: 0x505868 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(HX * 2, HZ * 2), carpetMat);
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; floor.raycast = () => {};
  mapRoot.add(floor);

  // PBR ceiling tile
  const ceilMat = loadPBR('ceiltile', 22, 14, { roughness: 0.95, color: 0x1e222c });
  // sealed shell: perimeter walls + FULL ceiling (no gaps — zero sky)
  const wallOpt = { tex: TEX.drywall, repeat: [12, 2], rough: 0.9, metal: 0.02 };
  addBox(0, -HZ - 0.4, HX * 2 + 1.6, CEIL, 0.8, 0x6e6c64, wallOpt);
  addBox(0, HZ + 0.4, HX * 2 + 1.6, CEIL, 0.8, 0x6e6c64, wallOpt);
  addBox(-HX - 0.4, 0, 0.8, CEIL, HZ * 2 + 1.6, 0x6e6c64, { ...wallOpt, repeat: [7, 2] });
  addBox(HX + 0.4, 0, 0.8, CEIL, HZ * 2 + 1.6, 0x6e6c64, { ...wallOpt, repeat: [7, 2] });
  // ceiling with PBR material
  const ceilGeo = new THREE.PlaneGeometry(HX * 2 + 1.6, HZ * 2 + 1.6);
  const ceilMesh = new THREE.Mesh(ceilGeo, ceilMat);
  ceilMesh.rotation.x = Math.PI / 2; ceilMesh.position.y = CEIL + 0.2;
  ceilMesh.receiveShadow = true; ceilMesh.raycast = () => {};
  mapRoot.add(ceilMesh);
  // collision ceiling (invisible)
  addPlatform(0, CEIL, 0, HX * 2 + 1.6, 0.4, HZ * 2 + 1.6, 0x2b303c, { tex: TEX.ceilTile, repeat: [22, 14], rough: 0.95 });

  // ---- interior walls (drywall, doorway cuts with headers) ----
  // LAYOUT (64x42m):
  // West wing: server room (-32 to -14, full depth)
  // Center: open office (-14 to 8, -9 to 9), corridor (full width, z=-9 to -15)
  // East wing: lobby (8 to 32, -9 to 9)
  // South strip: storage (-32 to -8, z=9 to 21), break room (-8 to 8, z=9 to 21),
  //              bathrooms (8 to 20, z=9 to 21), elevator lobby (20 to 32, z=9 to 21)
  // North strip: corridor (-32 to 32, z=-9 to -15), conference room (-32 to -16, z=-15 to -21),
  //              executive office (16 to 32, z=-15 to -21)
  const dw = { tex: TEX.drywall, repeat: [4, 2], rough: 0.9, metal: 0.02 };
  const header = (x, z, w, d) => addPlatform(x, 2.4, z, w, CEIL - 2.4, d, 0x6e6c64, dw);

  // === SERVER ROOM west wall at x=-14 (doors at z=-5 and z=5) ===
  addBox(-14, -15, 0.5, CEIL, 11.6, 0x6e6c64, dw);
  addBox(-14, -1, 0.5, CEIL, 5.6, 0x6e6c64, dw);
  addBox(-14, 8, 0.5, CEIL, 5.6, 0x6e6c64, dw);
  addBox(-14, 15, 0.5, CEIL, 11.6, 0x6e6c64, dw);
  header(-14, -5, 0.5, 2.8); header(-14, 5, 0.5, 2.8);

  // === LOBBY east wall at x=8 (double door z=0, single at z=-6) ===
  addBox(8, -14, 0.5, CEIL, 7.6, 0x6e6c64, dw);
  addBox(8, -3, 0.5, CEIL, 3.6, 0x6e6c64, dw);
  addBox(8, 6, 0.5, CEIL, 5.6, 0x6e6c64, dw);
  addBox(8, 14.5, 0.5, CEIL, 12.6, 0x6e6c64, dw);
  header(8, 0, 0.5, 3.6); header(8, -7, 0.5, 2.0);

  // === NORTH corridor wall at z=-9 (doors at x=-22, x=-5, x=5, x=22) ===
  addBox(-29, -9, 5.5, CEIL, 0.5, 0x6e6c64, dw);
  addBox(-14.5, -9, 10.5, CEIL, 0.5, 0x6e6c64, dw);
  addBox(0, -9, 7.6, CEIL, 0.5, 0x6e6c64, dw);
  addBox(14, -9, 10.6, CEIL, 0.5, 0x6e6c64, dw);
  addBox(28.5, -9, 6.5, CEIL, 0.5, 0x6e6c64, dw);
  header(-22, -9, 2.6, 0.5); header(-5, -9, 2.4, 0.5);
  header(5, -9, 2.4, 0.5); header(22, -9, 2.6, 0.5);

  // === SOUTH wall at z=9 (doors at x=-22, x=-2, x=12, x=25) ===
  addBox(-29.5, 9, 4.5, CEIL, 0.5, 0x6e6c64, dw);
  addBox(-13.5, 9, 14.5, CEIL, 0.5, 0x6e6c64, dw);
  addBox(5.5, 9, 10.5, CEIL, 0.5, 0x6e6c64, dw);
  addBox(18, 9, 5.6, CEIL, 0.5, 0x6e6c64, dw);
  addBox(29, 9, 5.6, CEIL, 0.5, 0x6e6c64, dw);
  header(-22, 9, 2.6, 0.5); header(-2, 9, 2.4, 0.5);
  header(12, 9, 2.4, 0.5); header(25, 9, 2.4, 0.5);

  // === FAR NORTH wall at z=-15 (separates corridor from conf/exec) ===
  addBox(-29, -15, 5.5, CEIL, 0.5, 0x6e6c64, dw);
  addBox(-16.5, -15, 8.5, CEIL, 0.5, 0x6e6c64, dw);
  addBox(0, -15, 12.6, CEIL, 0.5, 0x6e6c64, dw);
  addBox(16.5, -15, 8.5, CEIL, 0.5, 0x6e6c64, dw);
  addBox(29, -15, 5.5, CEIL, 0.5, 0x6e6c64, dw);
  header(-24, -15, 2.4, 0.5); header(24, -15, 2.4, 0.5);

  // === Conference/exec divider at x=-16 and x=16 (north wing internal) ===
  addBox(-16, -18, 0.5, CEIL, 5.6, 0x6e6c64, dw);
  addBox(16, -18, 0.5, CEIL, 5.6, 0x6e6c64, dw);

  // === Break room / bathroom / elevator dividers (south wing) ===
  // Break-bathroom divider at x=8 (door at z=15)
  addBox(8, 12, 0.5, CEIL, 5.6, 0x6e6c64, dw);
  addBox(8, 18.5, 0.5, CEIL, 4.6, 0x6e6c64, dw);
  header(8, 15, 0.5, 2.4);
  // Bathroom-elevator divider at x=20 (door at z=15)
  addBox(20, 12, 0.5, CEIL, 5.6, 0x6e6c64, dw);
  addBox(20, 18.5, 0.5, CEIL, 4.6, 0x6e6c64, dw);
  header(20, 15, 0.5, 2.4);
  // Storage-break divider at x=-8 (door at z=15)
  addBox(-8, 12, 0.5, CEIL, 5.6, 0x6e6c64, dw);
  addBox(-8, 18.5, 0.5, CEIL, 4.6, 0x6e6c64, dw);
  header(-8, 15, 0.5, 2.4);

  // ---- ceiling fluorescents: most are DEAD, a few alive, one flickering ----
  const deadPanel = { rough: 0.6, metal: 0.1 };
  const panels = [
    // corridor (north strip)
    [-22, -12, false], [-8, -12, false], [5, -12, true], [18, -12, false],
    // server room
    [-24, -3, true], [-24, 5, false], [-20, 0, false],
    // open office: mostly dead
    [-4, -2, false], [0, 4, true], [-6, 5, false], [4, -5, false],
    // lobby
    [20, -2, true], [20, 6, false], [26, 0, false],
    // storage: dead — red light zone
    [-22, 15, false], [-16, 15, false],
    // break room
    [-2, 15, false], [2, 18, false],
    // bathrooms
    [14, 15, false], [14, 18, false],
    // elevator lobby
    [26, 15, false],
    // conference room
    [-24, -18, false],
    // executive office
    [24, -18, false],
  ];
  for (const [px, pz, on] of panels) {
    addDecor(px, CEIL - 0.10, pz, 2.9, 0.10, 1.4, 0x1a1e26, { rough: 0.5, metal: 0.3 });
    if (!on) addDecor(px, CEIL - 0.18, pz, 2.5, 0.09, 1.0, 0x232833, { ...deadPanel });
    if (on) {
      const l = new THREE.PointLight(0xdfe9ff, 7, 10, 1.6); l.position.set(px, CEIL - 0.7, pz); mapRoot.add(l);
      const g = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.09, 1.0),
        new THREE.MeshStandardMaterial({ color: 0xeef4ff, emissive: 0xd8e6ff, emissiveIntensity: 1.25, roughness: 0.4 }));
      g.position.set(px, CEIL - 0.18, pz); mapRoot.add(g);
      mapLights.push({ mesh: g, light: l, on: true });
    }
  }
  // the flickering corridor light: its own decor + material handle + point light
  const flickGeo = new THREE.BoxGeometry(2.6, 0.12, 1.1);
  const flickerMat = new THREE.MeshStandardMaterial({ color: 0xeef4ff, emissive: 0xd8e6ff, emissiveIntensity: 1.25, roughness: 0.4 });
  const flick = new THREE.Mesh(flickGeo, flickerMat);
  flick.position.set(-12, CEIL - 0.18, -12); flick.raycast = () => {};
  mapRoot.add(flick);
  const flickLight = new THREE.PointLight(0xcfe0ff, 9, 12, 1.8);
  flickLight.position.set(-12, CEIL - 0.6, -12);
  mapRoot.add(flickLight);
  mapLights.push({ mesh: flick, light: flickLight, on: true, flicker: true });
  flickerTimer = setInterval(() => {
    if (!flickerMat.userData.dead) {
      const on = Math.random() > 0.32;
      const v = on ? (0.5 + Math.random() * 0.9) : 0.04;
      flickerMat.emissiveIntensity = v;
      flickLight.intensity = on ? 3 + v * 6 : 0.15;
    }
  }, 110);

  // ---- room lights (few, cheap, moody) ----
  const pl = (x, y, z, color, i, d) => { const l = new THREE.PointLight(color, i, d, 1.8); l.position.set(x, y, z); mapRoot.add(l); };
  pl(-24, 3.0, 0, 0x3b7bff, 26, 22);       // server room: cold blue
  pl(20, 2.9, 2, 0xffc890, 22, 20);         // lobby: last warm lamp
  pl(-2, 3.2, 0, 0x8fa3c8, 14, 18);         // open office: pale spill
  pl(5, 3.4, -12, 0xbfd4ff, 12, 13);        // corridor east (steady one)
  pl(-22, 2.6, 16, 0xff2a1e, 22, 18);       // storage: red emergency light
  pl(-2, 3.0, 15, 0xbfe8d0, 3.5, 9);        // break room: soft humming mint-white glow
  pl(14, 2.8, 16, 0xc8e0ff, 5, 10);         // bathroom: one buzzing light
  pl(26, 3.0, 14, 0xffa040, 6, 10);         // elevator lobby: warm call-button glow
  pl(-24, 2.8, -18, 0xdfe9ff, 3, 10);       // conference room: dim panel spill
  pl(24, 3.0, -18, 0xffe8b0, 8, 12);        // executive office: desk lamp

  // ---- SERVER ROOM (west, x:-32 to -14): rack rows with LED faces ----
  for (const rz of [-6, -2, 2, 6]) {
    for (const rx of [-30, -27, -24, -21, -18]) {
      addBox(rx, rz, 1.1, 2.5, 0.8, 0x14181f, { metal: 0.6, rough: 0.35 });
      for (const lz of [-0.22, 0, 0.22]) {
        addDecor(rx + 0.57, 0.6 + Math.random() * 1.4, rz + lz, 0.02, 0.1, 0.1, 0x0a0e14,
          { emissive: Math.random() > 0.5 ? 0x2266ff : 0x22ddaa, emissiveIntensity: 2.2 });
      }
    }
  }
  addDecor(-24, CEIL - 0.5, 0, 12, 0.25, 0.5, 0x20242c, { metal: 0.6 });   // cable tray
  addDecor(-24, CEIL - 0.5, 4, 12, 0.25, 0.5, 0x20242c, { metal: 0.6 });   // second cable tray

  // ---- OPEN OFFICE (center, x:-14 to 8, z:-9 to 9): cubicle pods + overturned desks ----
  const cubi = { rough: 0.85, metal: 0.05 };
  for (const [cx, cz] of [[-10, -4], [-4, -4], [2, -4], [-10, 3], [-4, 3], [2, 3]]) {
    addBox(cx, cz, 4.4, 1.35, 0.12, 0x59636f, cubi);                     // pod cross walls
    addBox(cx, cz, 0.12, 1.35, 3.6, 0x59636f, cubi);
    for (const [dx, dz] of [[-1.1, -0.95], [1.1, 0.95]]) {
      addBox(cx + dx, cz + dz, 1.7, 0.72, 0.75, 0x4a4038, cubi);         // desks
      if (Math.random() > 0.4) addDecor(cx + dx, 1.05, cz + dz, 0.6, 0.42, 0.06, 0x0b0e14,
        { emissive: 0x1a2c4a, emissiveIntensity: 1.1 }); // dead-blue monitors
    }
  }
  addRotatedBox(6, 0, -1, 1.8, 0.8, 0.9, 0.9, 0x4a4038, cubi);           // overturned desk cover
  addRotatedBox(-12, 0, 7, 1.8, 0.8, 0.9, -0.7, 0x4a4038, cubi);
  // copier against the lobby wall
  addBox(6, 7, 1.4, 1.2, 0.9, 0x9aa0a8, { rough: 0.5 });

  // ---- LOBBY (east, x:8 to 32, z:-9 to 9): reception desk, vending glow, couches ----
  addBox(18, -1, 0.9, 1.15, 5.5, 0x3a3f4a, { rough: 0.6 });              // reception counter
  addBox(21, -3, 2.2, 1.15, 0.9, 0x3a3f4a, { rough: 0.6 });              // counter L-return
  addBox(30, -5, 1.6, 2.3, 1.1, 0x161a22, { rough: 0.4 });               // vending machines
  addBox(30, -2.5, 1.6, 2.3, 1.1, 0x161a22, { rough: 0.4 });
  addDecor(29.1, 1.15, -5, 0.04, 1.9, 0.85, 0x081018, { emissive: 0xff2244, emissiveIntensity: 2.0 });
  addDecor(29.1, 1.15, -2.5, 0.04, 1.9, 0.85, 0x081018, { emissive: 0x2288ff, emissiveIntensity: 2.0 });
  addBox(18, 6, 3.6, 0.75, 1.2, 0x40372e, { rough: 0.9 });               // couches
  addBox(24, 6, 1.2, 0.75, 3.6, 0x40372e, { rough: 0.9 });
  addBox(28, 7, 2.6, 1.0, 1.6, 0x3a3f4a, { rough: 0.6 });                // lobby side table
  // water cooler (procedural: bottle + stand)
  addDecor(12, 0, 7.5, 0.4, 1.0, 0.4, 0x5a626e, { metal: 0.4 });         // stand base
  addDecor(12, 1.0, 7.5, 0.3, 0.6, 0.3, 0x88c4ff, { emissive: 0x2266ff, emissiveIntensity: 0.5 }); // water bottle

  // ---- CORRIDOR (north strip, z:-9 to -15): clutter ----
  addBox(-18, -12, 3.4, 0.78, 1.6, 0x5a4632, { tex: TEX.wood, repeat: [3, 1], rough: 0.7 });  // table
  for (const chx of [-19.6, -16.4]) addBox(chx, -13.4, 0.7, 0.9, 0.7, 0x2e333c, cubi);        // chairs
  addBox(10, -13, 2.6, 1.3, 0.8, 0x757b84, { rough: 0.5 });              // copy machines
  addBox(26, -12, 0.9, 1.3, 2.4, 0x757b84, { rough: 0.5 });
  addRotatedBox(0, 0, -11.5, 0.9, 1.3, 0.8, 0.5, 0x757b84, { rough: 0.5 });

  // ---- CONFERENCE ROOM (NW, x:-32 to -16, z:-15 to -21): big table + chairs ----
  addBox(-24, -18, 5.6, 0.78, 2.4, 0x5a4632, { tex: TEX.wood, repeat: [4, 2], rough: 0.7 });
  for (let i = 0; i < 4; i++) {
    addBox(-27 + i * 2.2, -16.5, 0.7, 0.9, 0.7, 0x2e333c, cubi);
    addBox(-27 + i * 2.2, -19.5, 0.7, 0.9, 0.7, 0x2e333c, cubi);
  }
  // whiteboard on back wall
  addDecor(-24, 1.4, -20.6, 3.6, 1.8, 0.08, 0xe8e4dc, { rough: 0.3 });
  addDecor(-24, 2.45, -20.6, 3.8, 0.12, 0.1, 0x4a525e, { metal: 0.5 });

  // ---- EXECUTIVE OFFICE (NE, x:16 to 32, z:-15 to -21): big desk, glass partition ----
  addBox(24, -18.5, 2.8, 0.78, 1.4, 0x3a2a1a, { tex: TEX.wood, repeat: [2, 1], rough: 0.7 });
  addBox(24, -18.5, 0.6, 0.42, 0.6, 0x0b0e14, { emissive: 0x334466, emissiveIntensity: 0.8 }); // monitor
  // executive chair (procedural: seat + back + post + base star)
  addDecor(24, 0.4, -17.2, 0.55, 0.08, 0.55, 0x1a1a1a, { rough: 0.9 });  // seat
  addDecor(24, 0.5, -17.0, 0.5, 0.7, 0.1, 0x1a1a1a, { rough: 0.9 });    // back
  addDecor(24, 0, -17.2, 0.1, 0.4, 0.1, 0x555555, { metal: 0.6 });       // post
  // glass partition (translucent)
  addPlatform(16.5, 0, -18, 0.2, CEIL, 5.6, 0x88bbcc, { opacity: 0.25, rough: 0.1, metal: 0.05 });
  // bookshelf on back wall
  addBox(20, -20.4, 4.8, 2.0, 0.7, 0x5a4632, { tex: TEX.wood, repeat: [3, 1], rough: 0.8 });

  // ---- BREAK ROOM (south center, x:-8 to 8, z:9 to 21): kitchen counter, fridge, tables ----
  const tileOpt = { tex: TEX.tiles, repeat: [3, 2], rough: 0.8, metal: 0.02 };
  // tile floor patch for kitchen area
  addDecor(0, 0.01, 15, 15.5, 0.02, 11.5, 0x707068, tileOpt);
  // L-shaped counter along south wall
  addBox(-5, 19.8, 5.6, 0.95, 0.7, 0x4a4038, { tex: TEX.wood, repeat: [3, 1], rough: 0.7 });
  addBox(5.5, 17, 0.7, 0.95, 5.6, 0x4a4038, { tex: TEX.wood, repeat: [1, 3], rough: 0.7 });
  // fridge (tall dark box with handle)
  addBox(-6.5, 18, 0.8, 2.0, 0.9, 0x3a4048, { metal: 0.5, rough: 0.4 });
  addDecor(-6.1, 1.2, 18, 0.05, 0.6, 0.05, 0xc0c0c0, { metal: 0.8 });   // handle
  // microwave on counter
  addDecor(-2, 1.25, 19.8, 0.5, 0.35, 0.4, 0x2a2f38, { metal: 0.3 });
  // coffee machine
  addDecor(1, 1.25, 19.8, 0.3, 0.4, 0.3, 0x1a1a1a, { emissive: 0x22ff44, emissiveIntensity: 1.0 });
  // break tables
  addBox(-2, 13, 1.4, 0.75, 1.4, 0xd0ccc4, { rough: 0.6 });
  addBox(3, 13, 1.4, 0.75, 1.4, 0xd0ccc4, { rough: 0.6 });
  // chairs around tables
  for (const [cx, cz] of [[-3.2, 13], [-0.8, 13], [1.8, 13], [4.2, 13]]) {
    addDecor(cx, 0.4, cz, 0.45, 0.05, 0.45, 0x4a525e, { rough: 0.7 });
  }
  // humming green glow fixture (break room light - a live one)
  const breakBulb = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.09, 0.8),
    new THREE.MeshStandardMaterial({ color: 0xeeffee, emissive: 0x66ffaa, emissiveIntensity: 0.6, roughness: 0.4 }));
  breakBulb.position.set(-2, CEIL - 0.18, 15); mapRoot.add(breakBulb);
  const breakLight = new THREE.PointLight(0x66ffaa, 4, 9, 1.6);
  breakLight.position.set(-2, CEIL - 0.6, 15); mapRoot.add(breakLight);
  mapLights.push({ mesh: breakBulb, light: breakLight, on: true });

  // ---- BATHROOMS (south-east center, x:8 to 20, z:9 to 21): stalls, sinks, broken buzzer ----
  // tile floor
  addDecor(14, 0.01, 15, 11.5, 0.02, 11.5, 0x606870, tileOpt);
  // stall partitions (3 stalls along east wall)
  for (let i = 0; i < 3; i++) {
    const sz = 11 + i * 3.2;
    addBox(17, sz, 0.12, 2.2, 2.8, 0x8a94a2, { metal: 0.3, rough: 0.5 });  // partition wall
    addBox(18.2, sz + 1.5, 0.6, 2.2, 0.12, 0x8a94a2, { metal: 0.3 });      // partition return
  }
  // sinks (counter + mirror on west-facing wall)
  addBox(10, 14, 3.6, 0.85, 0.6, 0xd0ccc4, { rough: 0.4 });
  addDecor(9.5, 1.4, 14, 0.06, 1.2, 3.0, 0xaabbcc, { rough: 0.1, metal: 0.2 });  // mirror
  // broken buzzing light (the bathroom buzzer)
  const buzzMat = new THREE.MeshStandardMaterial({ color: 0xeef4ff, emissive: 0xc8e0ff, emissiveIntensity: 0.6, roughness: 0.4 });
  const buzzMesh = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.09, 0.8), buzzMat);
  buzzMesh.position.set(14, CEIL - 0.18, 16); mapRoot.add(buzzMesh);
  const buzzLight = new THREE.PointLight(0xc8e0ff, 3, 8, 1.6);
  buzzLight.position.set(14, CEIL - 0.6, 16); mapRoot.add(buzzLight);
  mapLights.push({ mesh: buzzMesh, light: buzzLight, on: true });

  // ---- ELEVATOR LOBBY (SE corner, x:20 to 32, z:9 to 21): closed doors, one stuck open ----
  // elevator door frames (brushed metal)
  for (let i = 0; i < 2; i++) {
    const ez = 13 + i * 5;
    // door frame
    addBox(30, ez, 2.4, 2.6, 0.3, 0x5a626e, { metal: 0.7, rough: 0.3 });
    // doors (closed on first, stuck half-open on second)
    if (i === 0) {
      addBox(30, ez, 0.12, 2.4, 2.2, 0x7a848e, { metal: 0.8, rough: 0.25 });  // closed doors
      // call button (lit)
      addDecor(29.1, 1.2, ez, 0.08, 0.15, 0.15, 0x0a0e14, { emissive: 0xffa040, emissiveIntensity: 3.0 });
    } else {
      // stuck half-open: left panel + gap + right panel
      addBox(30, ez - 0.7, 0.12, 2.4, 0.8, 0x7a848e, { metal: 0.8, rough: 0.25 });
      addBox(30, ez + 0.7, 0.12, 2.4, 0.8, 0x7a848e, { metal: 0.8, rough: 0.25 });
      // dark void inside (deep box behind the gap)
      addDecor(31, 0, ez, 1.8, 2.4, 2.0, 0x050608, { rough: 1.0 });
    }
  }
  // waiting bench
  addBox(24, 15, 2.8, 0.55, 0.7, 0x40372e, { rough: 0.9 });

  // ---- STORAGE (south-west, x:-32 to -8, z:9 to 21): shelving + crates under the red light ----
  for (const sx of [-28, -22, -16, -12]) {
    addBox(sx, 15, 4.2, 2.2, 1.0, 0x3c424c, { metal: 0.55, rough: 0.5 });     // shelf racks
  }
  for (const [bx, bz, br] of [[- 10, 14, 0.4], [-14, 18, -0.3], [-20, 17, 0.9], [-26, 19, 0.2]]) {
    addRotatedBox(bx, 0, bz, 1.1, 1.0, 1.1, br, 0x6e5638, { tex: TEX.wood, repeat: [1, 1], rough: 0.85 });
  }
  addBox(-28, 18, 1.0, 1.9, 1.0, 0x8a3d2e, { rough: 0.6 });             // barrel
  addBox(-30, 16, 1.4, 0.9, 2.6, 0x4a5058, { metal: 0.5 });              // metal shelving unit
  // potted plant (procedural: pot + foliage clusters)
  addDecor(-10, 0, 18.5, 0.4, 0.5, 0.4, 0x6e4a2e, { rough: 0.9 });      // pot
  addDecor(-10, 0.6, 18.5, 0.6, 0.5, 0.6, 0x2a5e2a, { rough: 0.95 });   // foliage sphere

  // ---- EXIT signs: green glow over every doorway (the only wayfinding in the dark) ----
  const exitDoors = [
    [-14, -5, Math.PI / 2], [-14, 5, Math.PI / 2],       // server room doors
    [8, 0, Math.PI / 2], [8, -7, Math.PI / 2],           // lobby doors
    [-22, -9, 0], [-5, -9, 0], [5, -9, 0], [22, -9, 0], // corridor south wall
    [-22, 9, 0], [-2, 9, 0], [12, 9, 0], [25, 9, 0],    // south wing doors
    [-24, -15, 0], [24, -15, 0],                          // conf/exec doors
    [8, 15, Math.PI / 2], [20, 15, Math.PI / 2],         // bathroom/elevator doors
    [-8, 15, Math.PI / 2],                                // break/storage door
  ];
  for (const [ex, ez, ry] of exitDoors) {
    const sign = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.26, 0.08),
      new THREE.MeshStandardMaterial({ color: 0x061206, emissive: 0x2bff55, emissiveIntensity: 2.4 }));
    sign.position.set(ex, 2.62, ez); sign.rotation.y = ry; sign.raycast = () => {};
    mapRoot.add(sign);
  }

  // positional ambience for game.js soundscape
  mapAmbience.push(
    { x: -3, y: 3.5, z: 0, kind: 'hvac' },
    { x: -24, y: 1.5, z: 0, kind: 'serverfan' },
    { x: -20, y: 1.5, z: 4, kind: 'serverfan' },
    { x: 30, y: 1.2, z: -3.8, kind: 'vending' },
    { x: -12, y: 3.5, z: -12, kind: 'flickerbuzz' },
    { x: 14, y: 3.5, z: 16, kind: 'flickerbuzz' },  // bathroom buzzer
    { x: -2, y: 2.0, z: 15, kind: 'hvac' },         // break room fridge hum
    { x: 26, y: 2.0, z: 14, kind: 'hvac' },         // elevator machinery
  );

  // ==== ARCHITECTURAL TRIM: door frames, baseboards, ceiling grid, paper clutter ====
  const trimColor = 0x2a2f38;  // dark painted wood/metal

  // Door frames: jambs (0.08m wide x 2.6m tall) + lintel (0.08m thick) around each doorway
  const doorFrames = [
    // Server room doors
    { x: -14, z: -5, rot: 0 }, { x: -14, z: 5, rot: 0 },
    // Lobby doors
    { x: 8, z: 0, rot: 0, wide: true }, { x: 8, z: -7, rot: 0 },
    // Corridor south wall doors
    { x: -22, z: -9, rot: Math.PI / 2 }, { x: -5, z: -9, rot: Math.PI / 2 },
    { x: 5, z: -9, rot: Math.PI / 2 }, { x: 22, z: -9, rot: Math.PI / 2 },
    // South wing doors
    { x: -22, z: 9, rot: Math.PI / 2 }, { x: -2, z: 9, rot: Math.PI / 2 },
    { x: 12, z: 9, rot: Math.PI / 2 }, { x: 25, z: 9, rot: Math.PI / 2 },
    // Conference/exec doors
    { x: -24, z: -15, rot: Math.PI / 2 }, { x: 24, z: -15, rot: Math.PI / 2 },
    // Bathroom/elevator internal doors
    { x: 8, z: 15, rot: 0 }, { x: 20, z: 15, rot: 0 }, { x: -8, z: 15, rot: 0 },
  ];
  for (const df of doorFrames) {
    const w = df.wide ? 1.8 : 1.3;  // door half-width
    const horiz = Math.abs(df.rot) > 0.1;
    // Jambs
    if (horiz) {
      addDecor(df.x - w - 0.04, 0, df.z, 0.08, 2.6, 0.15, trimColor, { metal: 0.3 });
      addDecor(df.x + w + 0.04, 0, df.z, 0.08, 2.6, 0.15, trimColor, { metal: 0.3 });
      addDecor(df.x, 2.5, df.z, w * 2 + 0.16, 0.1, 0.15, trimColor, { metal: 0.3 });  // lintel
    } else {
      addDecor(df.x, 0, df.z - w - 0.04, 0.15, 2.6, 0.08, trimColor, { metal: 0.3 });
      addDecor(df.x, 0, df.z + w + 0.04, 0.15, 2.6, 0.08, trimColor, { metal: 0.3 });
      addDecor(df.x, 2.5, df.z, 0.15, 0.1, w * 2 + 0.16, trimColor, { metal: 0.3 });  // lintel
    }
  }

  // Baseboards: 0.1m tall strips along wall bottoms (slightly darker than walls)
  const baseColor = 0x3a3e46;
  // Perimeter baseboards
  addDecor(0, 0.05, -HZ + 0.15, HX * 2 - 1, 0.1, 0.08, baseColor, { rough: 0.85 });
  addDecor(0, 0.05, HZ - 0.15, HX * 2 - 1, 0.1, 0.08, baseColor, { rough: 0.85 });
  addDecor(-HX + 0.15, 0.05, 0, 0.08, 0.1, HZ * 2 - 1, baseColor, { rough: 0.85 });
  addDecor(HX - 0.15, 0.05, 0, 0.08, 0.1, HZ * 2 - 1, baseColor, { rough: 0.85 });
  // Internal wall baseboards (major walls)
  addDecor(-14, 0.05, 0, 0.08, 0.1, 19, baseColor, { rough: 0.85 });  // server room wall
  addDecor(8, 0.05, -3, 0.08, 0.1, 17, baseColor, { rough: 0.85 });   // lobby wall
  addDecor(0, 0.05, -9, 30, 0.1, 0.08, baseColor, { rough: 0.85 });   // north corridor
  addDecor(0, 0.05, 9, 30, 0.1, 0.08, baseColor, { rough: 0.85 });    // south wing
  addDecor(0, 0.05, -15, 30, 0.1, 0.08, baseColor, { rough: 0.85 });  // far north

  // Ceiling grid T-bars: dark metal strips every 2m (using InstancedMesh for efficiency)
  const tbarGeoX = new THREE.BoxGeometry(0.03, 0.06, HZ * 2);
  const tbarGeoZ = new THREE.BoxGeometry(HX * 2, 0.06, 0.03);
  const tbarMat = new THREE.MeshStandardMaterial({ color: 0x1a1e24, roughness: 0.7, metalness: 0.5 });
  // X-direction bars
  for (let x = -HX + 2; x < HX; x += 2) {
    const bar = new THREE.Mesh(tbarGeoX, tbarMat);
    bar.position.set(x, CEIL - 0.03, 0);
    bar.raycast = () => {};
    mapRoot.add(bar);
  }
  // Z-direction bars
  for (let z = -HZ + 2; z < HZ; z += 2) {
    const bar = new THREE.Mesh(tbarGeoZ, tbarMat);
    bar.position.set(0, CEIL - 0.03, z);
    bar.raycast = () => {};
    mapRoot.add(bar);
  }

  // Paper clutter: small white/grey quads scattered on floors in office/corridor areas
  const paperGeo = new THREE.PlaneGeometry(0.15, 0.22);
  const paperColors = [0xe8e4dc, 0xd8d4cc, 0xc8c4bc, 0xf0ece4];
  const paperLocations = [
    // Open office
    [-8, -3], [-5, -5], [-2, -2], [0, 4], [3, -4], [-10, 2], [-7, 5], [4, 1],
    // Corridor
    [-20, -11], [-15, -13], [-8, -12], [2, -13], [12, -11], [18, -14], [24, -11],
    // Conference room
    [-26, -17], [-22, -19], [-20, -17],
    // Storage
    [-18, 14], [-24, 16], [-12, 17],
  ];
  for (const [px, pz] of paperLocations) {
    const paper = new THREE.Mesh(paperGeo,
      new THREE.MeshStandardMaterial({ color: paperColors[Math.floor(Math.random() * paperColors.length)], roughness: 0.95 }));
    paper.rotation.x = -Math.PI / 2;
    paper.rotation.z = Math.random() * Math.PI * 2;
    paper.position.set(px + (Math.random() - 0.5) * 0.5, 0.01, pz + (Math.random() - 0.5) * 0.5);
    paper.raycast = () => {};
    mapRoot.add(paper);
  }

  // ==== ASYNC GLB PROP LOADING (models replace primitive decor boxes) ====
  // Capture mapRoot reference for async safety
  const thisMapRoot = mapRoot;

  // SERVER ROOM: server racks (replace some of the primitive racks)
  placeProp('serverrack', thisMapRoot, -30, 0, -6, { targetH: 2.1, rotY: Math.PI / 2 });
  placeProp('serverrack', thisMapRoot, -30, 0, 2, { targetH: 2.1, rotY: Math.PI / 2 });
  placeProp('serverrack', thisMapRoot, -24, 0, -2, { targetH: 2.1, rotY: Math.PI / 2 });
  placeProp('serverrack', thisMapRoot, -18, 0, 6, { targetH: 2.1, rotY: Math.PI / 2 });

  // OPEN OFFICE: chairs at cubicle pods and monitors on desks
  // Chairs at cubicle positions (6 pods x 2 desks = 12 potential chair spots)
  for (const [cx, cz] of [[-10, -4], [-4, -4], [2, -4], [-10, 3], [-4, 3], [2, 3]]) {
    for (const [dx, dz] of [[-1.1, -0.95], [1.1, 0.95]]) {
      // Chair behind each desk
      const chairX = cx + dx + (dx > 0 ? 0.8 : -0.8);
      const chairZ = cz + dz;
      placeProp('chair', thisMapRoot, chairX, 0, chairZ, { targetH: 0.95, rotY: dx > 0 ? -Math.PI / 2 : Math.PI / 2 });
      // Monitor on desk (50% chance)
      if (Math.random() > 0.5) {
        placeProp('monitor', thisMapRoot, cx + dx, 0.72, cz + dz, { targetH: 0.45, rotY: dx > 0 ? Math.PI : 0 });
      }
    }
  }

  // LOBBY: vending machines (keep emissive glow planes, add model behind), couches, water cooler
  // Vending machines at x=30, z=-5 and z=-2.5 (models placed slightly behind the emissive faces)
  placeProp('vending', thisMapRoot, 30.3, 0, -5, { targetH: 1.9, rotY: -Math.PI / 2 });
  placeProp('vending2', thisMapRoot, 30.3, 0, -2.5, { targetH: 1.8, rotY: -Math.PI / 2 });
  // Water cooler (replace procedural)
  placeProp('watercooler', thisMapRoot, 12, 0, 7.5, { targetH: 1.2, rotY: Math.PI });
  // Potted plant in lobby area
  placeProp('plant', thisMapRoot, 28, 0, 7, { targetH: 1.1 });

  // CORRIDOR: chairs at the table
  placeProp('chair', thisMapRoot, -19.6, 0, -13.4, { targetH: 0.95, rotY: Math.PI / 4 });
  placeProp('chair', thisMapRoot, -16.4, 0, -13.4, { targetH: 0.95, rotY: -Math.PI / 4 });

  // CONFERENCE ROOM: chairs around the table (8 chairs)
  for (let i = 0; i < 4; i++) {
    placeProp('chair', thisMapRoot, -27 + i * 2.2, 0, -16.2, { targetH: 0.95, rotY: Math.PI });
    placeProp('chair', thisMapRoot, -27 + i * 2.2, 0, -19.8, { targetH: 0.95, rotY: 0 });
  }

  // EXECUTIVE OFFICE: chair, desk lamp, monitor
  placeProp('chair', thisMapRoot, 24, 0, -17, { targetH: 0.95, rotY: Math.PI });
  placeProp('desklamp', thisMapRoot, 22.5, 0.78, -18.5, { targetH: 0.5 });
  placeProp('monitor', thisMapRoot, 24.5, 0.78, -18.5, { targetH: 0.45, rotY: Math.PI });

  // BREAK ROOM: fridge, chairs at tables, potted plant
  placeProp('fridge', thisMapRoot, -6.5, 0, 18, { targetH: 1.8, rotY: Math.PI / 2 });
  // Chairs around break tables
  for (const [cx, cz] of [[-3.2, 13], [-0.8, 13], [1.8, 13], [4.2, 13]]) {
    placeProp('chair', thisMapRoot, cx, 0, cz, { targetH: 0.95, rotY: Math.random() * Math.PI * 2 });
  }
  placeProp('plant', thisMapRoot, 6, 0, 19, { targetH: 1.1 });

  // STORAGE: potted plant
  placeProp('plant', thisMapRoot, -10, 0, 18.5, { targetH: 1.1 });

  mergeStaticMeshes();
}

// ================= FIRING RANGE — military training camp (94x74m) =================
// Faithful adaptation of the BO1 classic (per the BO/CODM minimaps):
//   NW: live-fire range — roofed firing shed, 6 staggered target lanes, backstop berm
//   W:  two ANGLED BARRACKS with walkable interiors (bunks, lockers, window peeks)
//   C:  climbable WATCHTOWER (the power position everyone fights over) + hut cluster
//   CE: the ROCK HILL — terraced high ground with crate cover
//   E:  two-story OFFICE with interior stairs and a big center-facing window
//   S:  green-roof MESS HALL with a long fightable interior
//   Dressing: sandbag lines, hescos, barrels, tires, cable spools, jeeps,
//   floodlight towers, camo nets, range signage, painted lane numbers.
function buildRange() {
  makeMorningSky();
  const DIRT = 0xa8845a, DIRT2 = 0x8f6f48, SAND = 0xc9b088;
  const OLIVE = 0x6b7345, OLIVE_D = 0x545a36, GREENRF = 0x4a6b3a;
  const WOODP = 0x6b5638, WOODL = 0x8a7048;
  const PLANK = { tex: TEX.wood };

  // --- sandbag line: one collision row + bag-shaped decor caps on top ---
  function sandbags(cx, cz, len, horiz, ry = 0, yb = 0) {
    const cos = Math.cos(ry), sin = Math.sin(ry);
    if (ry) addRotatedBox(cx, yb, cz, horiz ? len : 1.1, 0.82, horiz ? 1.1 : len, ry, 0xa89468, { rough: 1.0 });
    else addPlatform(cx, yb, cz, horiz ? len : 1.1, 0.82, horiz ? 1.1 : len, 0xa89468, { rough: 1.0 });
    const n = Math.max(2, Math.round(len / 1.1));
    for (let i = 0; i < n; i++) {
      const t = -len / 2 + (i + 0.5) * (len / n);
      const lx = horiz ? t : 0, lz = horiz ? 0 : t;
      const x = cx + lx * cos + lz * sin, z = cz - lx * sin + lz * cos;
      const c = [0xb09c70, 0x9c8a60, 0xa89468][i % 3];
      const bag = addDecor(x, yb + 0.78, z, horiz ? 0.98 : 0.72, 0.34, horiz ? 0.72 : 0.98, c, { rough: 1.0 });
      bag.rotation.y = ry + (Math.random() - 0.5) * 0.15;
    }
  }
  // --- oil drum ---
  function drum(x, z, color = 0x8a3a2a, yb = 0) {
    addPlatform(x, yb, z, 0.75, 1.1, 0.75, color, { metal: 0.4, rough: 0.6 });
    addDecor(x, yb + 0.34, z, 0.8, 0.09, 0.8, 0x2a2a2a, { metal: 0.5 });
    addDecor(x, yb + 0.7, z, 0.8, 0.09, 0.8, 0x2a2a2a, { metal: 0.5 });
  }
  // --- tire stack: slim collision core hidden inside larger decor rings ---
  function tires(x, z, n = 3) {
    addBox(x, z, 0.7, n * 0.32, 0.7, 0x141416, { rough: 0.95 });
    for (let i = 0; i < n; i++) {
      const ring = addDecor(x, i * 0.32, z, 1.05, 0.3, 1.05, 0x1c1c1e, { rough: 0.95 });
      ring.rotation.y = Math.random();
      addDecor(x, i * 0.32 + 0.08, z, 0.55, 0.16, 0.55, 0x0c0c0e, { rough: 1.0 });  // hub hole shadow
    }
  }
  // --- hesco barrier ---
  function hesco(x, z, w = 1.4, d = 1.4, yb = 0) {
    addPlatform(x, yb, z, w, 1.35, d, 0xb5a06e, { tex: TEX.concrete, rough: 1.0 });
    addDecor(x, yb + 1.32, z, w + 0.08, 0.1, d + 0.08, 0x6f7a64, { metal: 0.5 });
  }
  // --- floodlight tower ---
  function floodlight(x, z, aimRy = 0) {
    addBox(x, z, 0.4, 6.5, 0.4, 0x3a3f34, { metal: 0.6 });
    const head = addDecor(x, 6.4, z, 1.5, 0.5, 0.4, 0x2c2c2c, { metal: 0.6 });
    head.rotation.y = aimRy;
    const lamp = addDecor(x, 6.45, z, 1.3, 0.34, 0.2, 0xfff2cc, { emissive: 0xffedb8, emissiveIntensity: 2.2 });
    lamp.rotation.y = aimRy;
  }
  // --- camo net canopy ---
  function camoNet(x, z, w, d, h = 2.9) {
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      addDecor(x + sx * w / 2, 0, z + sz * d / 2, 0.14, h, 0.14, 0x4a4534, { rough: 0.9 });
    }
    const net = addDecor(x, h, z, w + 0.8, 0.14, d + 0.8, 0x556042, { rough: 1.0 });
    net.material.transparent = true; net.material.opacity = 0.85;
  }
  const crate = (x, z, s = 1.3, h = 1.1, c = WOODL, yb = 0) => addPlatform(x, yb, z, s, h, s, c, PLANK);
  // --- low-poly palm: tilted segmented trunk + fan of leaf slabs (decor except trunk base) ---
  function palm(x, z, h = 6, lean = 0.12, ry = 0, yb = 0) {
    addPlatform(x, yb, z, 0.42, 1.4, 0.42, 0x6e5638, { rough: 0.9 });        // climbable/collidable base
    let px = x, pz = z, py = yb;
    const segs = 5, dx = Math.cos(ry) * lean, dz = Math.sin(ry) * lean;
    for (let i = 0; i < segs; i++) {
      const t = addDecor(px, py, pz, 0.38 - i * 0.04, h / segs + 0.1, 0.38 - i * 0.04, i % 2 ? 0x7a6242 : 0x6e5638, { rough: 0.95 });
      t.rotation.y = i * 0.5;
      py += h / segs; px += dx; pz += dz;
    }
    for (let i = 0; i < 7; i++) {
      const a = i / 7 * Math.PI * 2 + ry;
      const leaf = addDecor(px + Math.cos(a) * 1.15, py - 0.15, pz + Math.sin(a) * 1.15, 2.5, 0.1, 0.62, i % 2 ? 0x4f7a3a : 0x5d8a44, { rough: 0.9 });
      leaf.rotation.y = -a; leaf.rotation.z = 0.32 * Math.cos(a) - 0.18; leaf.rotation.x = 0.3 * Math.sin(a);
    }
    addDecor(px, py - 0.3, pz, 0.5, 0.45, 0.5, 0x5a4630, { rough: 0.95 });    // crown nut cluster
  }
  // --- dry scrub tuft (pure decor) ---
  function scrub(x, z, s = 1, yb = 0) {
    for (let i = 0; i < 3; i++) {
      const b = addDecor(x + (Math.random() - 0.5) * 0.7 * s, yb, z + (Math.random() - 0.5) * 0.7 * s,
        (0.5 + Math.random() * 0.5) * s, (0.3 + Math.random() * 0.35) * s, (0.5 + Math.random() * 0.4) * s,
        [0x8a8a4a, 0x7a8446, 0x9a9456][i % 3], { rough: 1.0 });
      b.rotation.y = Math.random() * 3;
    }
  }
  // --- military jeep ---
  function jeep(x, z, ry) {
    const cos = Math.cos(ry), sin = Math.sin(ry);
    const put = (lx, ly, lz, w, h, d, c, o = {}) => {
      const wx = x + lx * cos + lz * sin, wz = z - lx * sin + lz * cos;
      const m = addDecor(wx, ly, wz, w, h, d, c, o);
      m.rotation.y = ry;
      return m;
    };
    addRotatedBox(x, 0.55, z, 3.9, 0.85, 1.9, ry, OLIVE_D, { tex: TEX.panels, repeat: [2, 1] });
    put(-0.4, 1.4, 0, 2.2, 0.5, 1.7, OLIVE, { rough: 0.8 });
    put(0.75, 1.4, 0, 0.1, 0.8, 1.6, 0xbcd2dd, { rough: 0.2, metal: 0.4 });
    put(-1.55, 1.4, 0, 0.6, 0.55, 1.3, 0x33382a, { rough: 0.9 });
    for (const [lx, lz] of [[-1.35, -1.0], [-1.35, 1.0], [1.25, -1.0], [1.25, 1.0]]) {
      put(lx, 0, lz, 0.8, 0.8, 0.28, 0x181818, { rough: 0.95 });
    }
    put(1.95, 0.55, 0, 0.15, 0.35, 1.7, 0x2c2f26, { metal: 0.5 });
    // hull collision from ground so you can't walk under it
    addBox(x, z, Math.abs(3.6 * cos) + Math.abs(1.7 * sin), 1.4, Math.abs(3.6 * sin) + Math.abs(1.7 * cos), OLIVE_D, { opacity: 0.0 });
  }

  // ===== TERRAIN v3: the EXACT playable-area polygon traced from the BO minimap =====
  // The real Firing Range is a ~60m organic blob — the boundary hugs the structures.
  // BOUNDARY_POLY below is machine-traced from the minimap (red = out of bounds).
  const PLAT = 1.6;
  const BOUNDARY_POLY = [[24.8,1.6],[29.7,7.4],[31.5,14.1],[28.4,19.7],[22.1,22.5],[15.4,23.3],[10,23.8],[6.4,26.7],[2.4,30.9],[-2.8,31.2],[-7.6,29.1],[-12.1,27.3],[-16.2,24.9],[-19.2,21.3],[-21.8,17.6],[-25.1,14.5],[-27.7,10.7],[-28.4,6.2],[-28.4,1.6],[-27.9,-2.8],[-27.6,-7.4],[-27.8,-12.8],[-27,-18.7],[-24,-23.7],[-18.9,-26.3],[-13.8,-28.8],[-8.2,-29],[-2.8,-22.5],[0.5,-16.9],[3.2,-14.8],[6,-13.5],[10.6,-14.3],[17.1,-15],[21.4,-12.3],[22.8,-7.6],[22.5,-2.8]];
  // containment: the game clamps players to this polygon every frame (see game.js) —
  // expanded +2.6m so standing on the berm tops is fine but nothing beyond is
  mapBoundaryPoly = BOUNDARY_POLY.map(([x, z]) => {
    const dx = x - 1.0, dz = z - 2.2, L = Math.hypot(dx, dz);
    return [x + dx / L * 2.6, z + dz / L * 2.6];
  });
  {
    // jungle base far beyond the boundary
    const jungle = new THREE.Mesh(
      new THREE.PlaneGeometry(180, 160),
      new THREE.MeshStandardMaterial({ color: 0x39502e, roughness: 1.0 })
    );
    jungle.rotation.x = -Math.PI / 2; jungle.position.set(0, -0.03, 2);
    jungle.receiveShadow = true; jungle.raycast = () => {};
    mapRoot.add(jungle);
    // dirt floor shaped EXACTLY like the playable polygon (+2m skirt under the berms)
    const shape = new THREE.Shape();
    const CX = 1.0, CZ = 2.2;   // polygon centroid (for the skirt expansion)
    BOUNDARY_POLY.forEach(([x, z], i) => {
      const dx = x - CX, dz = z - CZ, L = Math.hypot(dx, dz);
      const ex = x + dx / L * 3.5, ez = z + dz / L * 3.5;
      if (i === 0) shape.moveTo(ex, -ez); else shape.lineTo(ex, -ez);
    });
    const dirtMat = new THREE.MeshStandardMaterial({ color: DIRT, roughness: 1.0, map: TEX.asphalt.clone() });
    dirtMat.map.repeat.set(18, 18); dirtMat.map.needsUpdate = true;
    const floor = new THREE.Mesh(new THREE.ShapeGeometry(shape), dirtMat);
    floor.rotation.x = -Math.PI / 2; floor.position.y = 0.0;
    floor.receiveShadow = true; floor.raycast = () => {};
    mapRoot.add(floor);
    // worn sand roads
    const mk = (w, d, x, z, y = 0.02) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d),
        new THREE.MeshStandardMaterial({ color: SAND, roughness: 1.0, transparent: true, opacity: 0.45 }));
      m.rotation.x = -Math.PI / 2; m.position.set(x, y, z);
      m.receiveShadow = true; m.raycast = () => {};
      mapRoot.add(m); return m;
    };
    mk(4, 16, -8, -18);           // N finger road
    mk(30, 4, -8, 6);             // west-center drag
    mk(4, 18, 2, 20);             // S finger road
    mk(14, 3.5, 14, 5);           // east lane
  }

  // ===== BOUNDARY: berm wall + jungle mass along every polygon edge =====
  for (let i = 0; i < BOUNDARY_POLY.length; i++) {
    const [x1, z1] = BOUNDARY_POLY[i];
    const [x2, z2] = BOUNDARY_POLY[(i + 1) % BOUNDARY_POLY.length];
    const mx = (x1 + x2) / 2, mz = (z1 + z2) / 2;
    const dx = x2 - x1, dz = z2 - z1;
    const len = Math.hypot(dx, dz);
    const ry = -Math.atan2(dz, dx);
    // outward normal (away from centroid)
    let nx = mx - 1.0, nz = mz - 2.2;
    const nl = Math.hypot(nx, nz); nx /= nl; nz /= nl;
    // 4m dirt berm on the line
    addRotatedBox(mx + nx * 1.2, 0, mz + nz * 1.2, len + 2.2, 4, 2.4, ry, DIRT2, { tex: TEX.concrete, repeat: [Math.max(2, Math.round(len / 3)), 2] });
    // jungle mass behind it (visual bulk so the overhead reads organic, not rectangular)
    const j = addDecor(mx + nx * 5.5, 0.5, mz + nz * 5.5, len + 4, 3.2 + (i % 3) * 0.9, 7, [0x3f5a33, 0x466339, 0x39502e][i % 3], { rough: 1.0 });
    j.rotation.y = ry;
    // fence posts + wire on the berm top
    if (i % 2 === 0) {
      addDecor(mx + nx * 1.2, 4, mz + nz * 1.2, 0.2, 1.2, 0.2, 0x5d4a30, { rough: 0.9 });
      const wire = addDecor(mx + nx * 1.2, 5.05, mz + nz * 1.2, len + 1, 0.05, 0.05, 0x3a3a3a, { metal: 0.7 });
      wire.rotation.y = ry;
    }
    // palms scattered outside (decor only)
    if (i % 3 === 0) {
      const px2 = mx + nx * 9, pz2 = mz + nz * 9;
      let hy = 0;
      for (let s = 0; s < 5; s++) { const t = addDecor(px2, hy, pz2, 0.36, 1.5, 0.36, s % 2 ? 0x7a6242 : 0x6e5638, { rough: 0.95 }); t.raycast = () => {}; hy += 1.4; }
      for (let s = 0; s < 6; s++) {
        const a = s / 6 * Math.PI * 2;
        const leaf = addDecor(px2 + Math.cos(a) * 1.1, hy - 0.2, pz2 + Math.sin(a) * 1.1, 2.4, 0.1, 0.6, s % 2 ? 0x4f7a3a : 0x5d8a44, { rough: 0.9 });
        leaf.rotation.y = -a; leaf.rotation.z = 0.3 * Math.cos(a) - 0.16; leaf.raycast = () => {};
      }
    }
  }

  // ===== NW PLATEAU: the range sits on high ground (fitted inside the blob's NW lobe) =====
  addBox(-19.5, -17, 15, PLAT, 16, DIRT2, { tex: TEX.concrete, repeat: [6, 1] });
  addDecor(-19.5, PLAT, -9.15, 15.2, 0.35, 0.4, 0x6e5a3c, { rough: 0.95 });
  addDecor(-12.15, PLAT, -17, 0.4, 0.35, 16.2, 0x6e5a3c, { rough: 0.95 });
  addDecor(-19.5, 0.5, -8.9, 15, 1.0, 0.25, 0x7a6242, { rough: 1.0 });
  addDecor(-12, 0.5, -17, 0.25, 1.0, 16, 0x7a6242, { rough: 1.0 });
  // dirt ramp descending NORTH off the plateau into the N spawn finger (0.4 rises, walkable both ways)
  for (let i = 0; i < 3; i++) addBox(-14, -25.6 - i * 1.2, 5.5, 1.2 - i * 0.4, 1.2, DIRT2, { tex: TEX.concrete });
  // stairs down the SOUTH edge into the west drag
  for (let i = 0; i < 4; i++) addBox(-16, -8.4 + i * 1.05, 3, PLAT - (i + 1) * 0.4 + 0.4, 1.05, 0x8a7560, { tex: TEX.concrete });

  // ============ PLATEAU: THE SHOOTING RANGE ============
  {
    const FX = -19.5, FZ = -13;
    for (const px of [-4.5, 0, 4.5]) addPlatform(FX + px, PLAT, FZ - 0.1, 0.35, 3.2, 0.35, WOODP, PLANK);   // posts merged with the bench line
    addPlatform(FX, PLAT + 3.2, FZ + 0.9, 16.5, 0.25, 4.4, OLIVE_D, { tex: TEX.panels, repeat: [6, 1] });
    addDecor(FX, PLAT + 3.42, FZ + 0.9, 17, 0.14, 4.8, 0x454a30, { rough: 0.9 });
    addDecor(FX, PLAT + 3.16, FZ + 0.9, 16.3, 0.02, 4.2, 0xc4bda6, { rough: 0.9 });
    addPlatform(FX, PLAT, FZ, 10, 1.1, 0.5, 0x7a6242, PLANK);   // wide gaps at both ends to walk downrange
    for (const px of [-4.5, 0, 4.5]) addPlatform(FX + px, PLAT, FZ - 0.9, 0.25, 1.5, 1.7, WOODL, PLANK);
    for (let i = 0; i < 4; i++) neonSign(String(i + 1), 0xffd24a, FX - 6 + i * 4, PLAT + 2.55, FZ + 0.45, 0, 0.28);
    addPlatform(FX - 1, PLAT, -23.2, 15, 2.6, 1.8, DIRT2, { tex: TEX.concrete, repeat: [5, 1] });   // backstop berm
    for (let i = 0; i < 5; i++) {
      const tx = FX - 6.5 + i * 3.2, tz = -21.6 + (i % 2) * 2.2;
      addDecor(tx, PLAT, tz, 0.18, 1.5, 0.18, 0x5d4a30, { rough: 0.9 });
      const board = addDecor(tx, PLAT + 1.5, tz, 1.3, 1.6, 0.1, 0xe8e2d4, { pen: true });
      board.material.map = TEX.target; board.material.map.needsUpdate = true;
    }
    addPlatform(FX - 3, PLAT, -18, 3.5, 1.0, 1.3, DIRT2, { tex: TEX.concrete });
    neonSign('RANGE 7', 0xffb347, FX, PLAT + 4.5, FZ + 3.0, 0, 0.9);
    crate(FX + 6.3, FZ - 1.5, 1.5, 0.8, OLIVE, PLAT); crate(FX + 6.3, FZ - 1.5, 1.2, 1.4, OLIVE_D, PLAT);
    sandbags(FX + 4, FZ + 3.2, 4.5, true, 0, PLAT);
    drum(FX - 6, FZ + 3, 0x8a3a2a, PLAT); drum(FX - 5, FZ + 3.9, 0x4a5a3a, PLAT);
    // overlook nest on the plateau lip
    sandbags(-20.5, -10, 4, true, 0, PLAT);
    scrub(-25, -12, 1.0, PLAT); palm(-25.5, -20, 5.5, 0.12, 0.8, PLAT);
  }

  // ============ CENTER: THE WATCHTOWER ============
  {
    const TX = -3, TZ = 3;
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) addBox(TX + sx * 1.9, TZ + sz * 1.9, 0.45, 6.2, 0.45, WOODP, PLANK);
    for (const s of [-1, 1]) {
      addDecor(TX + s * 1.9, 2.6, TZ, 0.16, 0.16, 3.9, 0x5d4a30, { rough: 0.9 });
      addDecor(TX, 4.4, TZ + s * 1.9, 3.9, 0.16, 0.16, 0x5d4a30, { rough: 0.9 });
    }
    addPlatform(TX, 6.2, TZ, 5.8, 0.35, 5.8, 0x7a6242, { tex: TEX.wood, repeat: [4, 1] });
    addPlatform(TX, 6.55, TZ + 2.75, 5.8, 1.05, 0.3, OLIVE_D, { tex: TEX.panels });
    addPlatform(TX + 2.75, 6.55, TZ, 0.3, 1.05, 5.2, OLIVE_D, { tex: TEX.panels });
    addPlatform(TX - 2.75, 6.55, TZ + 1.25, 0.3, 1.05, 2.7, OLIVE_D, { tex: TEX.panels });   // west wall south segment
    addPlatform(TX - 2.75, 6.55, TZ - 2.05, 0.3, 1.05, 1.1, OLIVE_D, { tex: TEX.panels });   // west wall north segment — gap = stair entry
    addPlatform(TX, 6.55, TZ - 2.75, 5.8, 1.05, 0.3, OLIVE_D, { tex: TEX.panels });
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) addBox(TX + sx * 2.5, TZ + sz * 2.5, 0.28, 9.7, 0.28, WOODP, PLANK);
    addPlatform(TX, 9.7, TZ, 6.6, 0.3, 6.6, OLIVE, { tex: TEX.panels, repeat: [2, 2] });
    addDecor(TX, 10.0, TZ, 0.14, 1.6, 0.14, 0x333a2a, { metal: 0.7 });
    addDecor(TX, 11.6, TZ, 0.26, 0.26, 0.26, 0xff5533, { emissive: 0xff5533, emissiveIntensity: 2.6 });
    for (let i = 1; i <= 13; i++) addBox(TX - 3.4 - (13 - i) * 0.7, TZ - 0.8, 1.05, i * 0.5, 2.2, 0x8a7560, { tex: TEX.concrete });   // steep run climbing east along the tower's west flank (rock band owns the east, mess owns the far west)
    sandbags(TX + 4.6, TZ, 5, false);   // bags moved to the east base (stairs are west now)
    drum(TX - 1.6, TZ + 3.6, 0x4a5a3a);
  }

  // ============ HUT builder ============
  function hut(cx, cz, ry) {
    const T = 0.3, H = 2.7, cos = Math.cos(ry), sin = Math.sin(ry);
    const seg = (lx, lz, w, d, yb = 0, hh = H, c = 0xcfc8b2, o = { tex: TEX.panels, repeat: [2, 1] }) => addRotatedBox(
      cx + lx * cos + lz * sin, yb, cz - lx * sin + lz * cos,
      w, hh, d, ry, c, o);
    seg(0, -2.3, 5.6, T);
    seg(-1.9, 2.3, 1.8, T); seg(1.9, 2.3, 1.8, T);
    seg(0, 2.3, 2.0, T, 2.1, H - 2.1);
    for (const s of [-1, 1]) {
      seg(s * 2.8, -1.75, T, 1.1); seg(s * 2.8, 1.75, T, 1.1);
      seg(s * 2.8, 0, T, 1.4, 0, 1.0);
      seg(s * 2.8, 0, T, 1.4, 2.1, H - 2.1);
    }
    seg(0, -2.32, 5.7, 0.1, 0, 0.5, 0x6b5638, PLANK);
    seg(-1.9, 2.32, 1.9, 0.1, 0, 0.5, 0x6b5638, PLANK);
    seg(1.9, 2.32, 1.9, 0.1, 0, 0.5, 0x6b5638, PLANK);
    seg(-1.05, 2.34, 0.14, 0.12, 0, 2.1, 0x6b5638, PLANK);
    seg(1.05, 2.34, 0.14, 0.12, 0, 2.1, 0x6b5638, PLANK);
    const roof = addRotatedBox(cx, H, cz, 6.4, 0.22, 5.4, ry, 0x8a5a48, { metal: 0.35, rough: 0.6 });
    roof.rotation.z = 0.05;
    const under = addRotatedBox(cx, H - 0.02, cz, 6.2, 0.02, 5.2, ry, 0xbab4a0, { rough: 0.9 });
    under.raycast = () => {};
    addRotatedBox(cx + 1.4 * cos, 0, cz - 1.4 * sin, 2.0, 0.55, 1.0, ry, 0x4a5a3a, { rough: 0.9 });
    crate(cx - 1.6 * cos - 0.9 * sin, cz + 1.6 * sin - 0.9 * cos, 0.9, 0.7, OLIVE_D);
  }

  // ============ TOP-CENTER: THE LODGE COMPLEX — connected L of buildings (per the real map) ============
  // two huts joined by a covered breezeway + attached third room, forming an L you fight through
  hut(-6, -6, 0.45);
  // attached open-sided room on the NW (the L's foot): two walls + roof, fully open south+east
  addRotatedBox(-9.3, 0, -9.3, 0.3, 2.7, 5.2, 0.45, 0xcfc8b2, { tex: TEX.panels, repeat: [2, 1] });
  addRotatedBox(-6.8, 0, -12.4, 5.2, 2.7, 0.3, 0.45, 0xcfc8b2, { tex: TEX.panels, repeat: [2, 1] });
  addRotatedBox(-7.9, 2.7, -9.6, 6.0, 0.22, 5.8, 0.45, 0x8a5a48, { metal: 0.35, rough: 0.6 });
  addRotatedBox(-9.0, 0, -11.8, 0.3, 2.7, 0.3, 0.45, WOODP, PLANK);   // corner post
  crate(-9.8, -13.2, 0.9, 0.7, OLIVE_D);   // single crate tucked at the room's back corner
  sandbags(-3, -2, 5, true, 0.45);
  camoNet(-6, -6, 7.4, 6.4, 3.1);

  // ============ E: THE ROCK CLIFF (impassable — the map flows AROUND it, per the real map) ============
  {
    const ROCK = 0x7d7466, ROCK2 = 0x8d8272, ROCK3 = 0x6a6156;
    // tall sheer masses forming the bean-shaped cliff: x 3..18, z -9.5..6
    addRotatedBox(8, 0, -3, 11, 6.5, 8, 0.35, ROCK, { tex: TEX.concrete, repeat: [4, 2] });
    addRotatedBox(13, 0, 1, 10, 6.5, 8, -0.2, ROCK3, { tex: TEX.concrete, repeat: [4, 2] });
    addRotatedBox(9.5, 0, 4.5, 8, 6.5, 6.5, 0.15, ROCK, { tex: TEX.concrete, repeat: [3, 2] });
    addRotatedBox(6, 0, -5.5, 7, 5.5, 5, 0.5, ROCK2, { tex: TEX.concrete, repeat: [3, 2] });
    addRotatedBox(15.5, 0, -3.5, 6, 5.8, 6, 0.1, ROCK2, { tex: TEX.concrete, repeat: [2, 2] });
    // crown + strata bands (decor)
    addDecor(10.5, 6.5, 0.5, 10, 0.8, 7, ROCK2, { rough: 1.0 });
    addDecor(9, 3.2, 0, 14.5, 0.18, 10.5, 0x9a8f7c, { rough: 1.0 });
    addDecor(10, 5.1, 0.5, 12.5, 0.15, 8.5, 0x9a8f7c, { rough: 1.0 });
    // scree + boulders at the base (small, walkable-past)
    for (let i = 0; i < 12; i++) {
      const a = i / 12 * Math.PI * 2, rr = 8.6 + (i % 3);
      const sc = addDecor(10.5 + Math.cos(a) * rr, 0, 0 + Math.sin(a) * rr * 0.72, 0.7 + (i % 3) * 0.3, 0.4, 0.6 + (i % 2) * 0.4, [ROCK, ROCK2, ROCK3][i % 3], { rough: 1.0 });
      sc.rotation.y = i * 1.7;
    }
    for (const [bx, bz, s] of [[1.5, -8, 1.4], [20.5, 3.5, 1.5], [21, -4, 1.2], [4, 5.5, 1.3]]) {
      const b2 = addRotatedBox(bx, 0, bz, s, s * 0.7, s * 0.9, Math.random() * 1.5, ROCK, { rough: 1.0 });
      b2.rotation.z = 0.15;
    }
    scrub(2, -3, 0.9); scrub(18.5, 4.5, 0.8);
  }

  // ============ SOUTH ROCK BAND (second yellow blocker — forces the S road around) ============
  {
    const ROCK = 0x7d7466, ROCK2 = 0x8d8272;
    addRotatedBox(3.2, 0, 13, 6.8, 5, 3.6, 0.18, ROCK, { tex: TEX.concrete, repeat: [3, 2] });
    addRotatedBox(1, 0, 12, 3.5, 5.6, 3, -0.1, ROCK2, { tex: TEX.concrete, repeat: [2, 2] });
    addDecor(2.5, 5, 12.5, 5.5, 0.6, 3, ROCK2, { rough: 1.0 });
    addDecor(2.5, 2.6, 12.5, 7.4, 0.15, 4.1, 0x9a8f7c, { rough: 1.0 });
    for (const [bx, bz, s] of [[-1.2, 9.5, 1.1], [6.8, 12.8, 1.2]]) {
      const b2 = addRotatedBox(bx, 0, bz, s, s * 0.6, s * 0.8, Math.random() * 2, ROCK, { rough: 1.0 });
      b2.rotation.z = 0.12;
    }
    scrub(6.5, 9, 0.7);
  }

  // ============ BARRACKS builder ============
  function barracks(cx, cz, ry, WALLB = OLIVE, ROOFB = GREENRF, RIDGE = 0x3d5730) {
    const T = 0.32, H = 3.0, cos = Math.cos(ry), sin = Math.sin(ry);
    const W2 = (lx, lz) => [cx + lx * cos + lz * sin, cz - lx * sin + lz * cos];
    const seg = (lx, lz, w, d, yb = 0, hh = H, c = WALLB, o = { tex: TEX.panels, repeat: [3, 1] }) => {
      const [x, z] = W2(lx, lz); return addRotatedBox(x, yb, z, w, hh, d, ry, c, o);
    };
    for (const s of [-1, 1]) {
      let lx = -6.5;
      for (const [w, isWin] of [[2.2, 0], [1.4, 1], [1.6, 0], [1.4, 1], [1.6, 0], [1.4, 1], [2.2, 0]]) {
        if (isWin) { seg(lx + w / 2, s * 3, w, T, 0, 1.05); seg(lx + w / 2, s * 3, w, T, 2.15, H - 2.15); }
        else seg(lx + w / 2, s * 3, w, T);
        lx += w;
      }
    }
    for (const e of [-1, 1]) {
      seg(e * 6.5, -1.95, T, 2.1); seg(e * 6.5, 1.95, T, 2.1);
      seg(e * 6.5, 0, T, 1.8, 2.1, H - 2.1);
    }
    seg(0, -1.55, 14, 3.3, H, 0.24, ROOFB, { metal: 0.4, rough: 0.6 });
    seg(0, 1.55, 14, 3.3, H, 0.24, ROOFB, { metal: 0.4, rough: 0.6 });
    seg(0, 0, 14.4, 0.8, H + 0.2, 0.24, RIDGE, { metal: 0.4, rough: 0.6 });
    for (const s of [-1, 1]) for (const wx of [-3.35, -0.35, 2.65]) {
      seg(wx + 0.7, s * 3.05, 1.6, 0.08, 0.95, 0.12, 0xe0dcd0, { rough: 0.8 });
      seg(wx + 0.7, s * 3.05, 1.6, 0.08, 2.1, 0.12, 0xe0dcd0, { rough: 0.8 });
    }
    for (const e of [-1, 1]) {
      seg(e * 6.55, -1.0, 0.1, 0.14, 0, 2.15, 0xe0dcd0, { rough: 0.8 });
      seg(e * 6.55, 1.0, 0.1, 0.14, 0, 2.15, 0xe0dcd0, { rough: 0.8 });
      seg(e * 7.3, 0, 1.3, 2.2, 0, 0.25, 0x8a8f7c, { tex: TEX.concrete });
    }
    seg(0, -3.2, 14.6, 0.1, 0, 0.45, RIDGE, { rough: 0.8 });
    seg(0, 3.2, 14.6, 0.1, 0, 0.45, RIDGE, { rough: 0.8 });
    for (const s of [-1, 1]) {
      seg(-3.4, s * 1.9, 2.4, 1.1, 0, 0.55, 0x4a5a3a, { rough: 0.9 });
      seg(-3.4, s * 1.9, 2.4, 1.1, 1.15, 0.18, 0x556446, { rough: 0.9 });
      seg(3.4, s * 1.9, 2.4, 1.1, 0, 0.55, 0x4a5a3a, { rough: 0.9 });
      seg(3.4, s * 1.9, 2.4, 1.1, 1.15, 0.18, 0x556446, { rough: 0.9 });
    }
    seg(0, -2.4, 1.6, 0.55, 0, 1.9, 0x5a6152, { metal: 0.4 });
    const [fx, fz] = W2(0, 1.6); crate(fx, fz, 0.9, 0.6, 0x7a6242);
  }

  // ============ W: THE LONG BARRACKS — back against the west boundary (per the real map) ============
  barracks(-22.5, 8.5, 0.62);                                // hugging the west edge, angled with the boundary
  sandbags(-8, 10, 5, false, 0.4);
  drum(-25.5, 15); drum(-24.5, 16.2, 0x4a5a3a); tires(-9, 8);

  // ============ SW: GREEN-ROOF MESS HALL (bottom-left, back against the boundary, 80% scale) ============
  {
    const MX = -12, MZ = 20.5, T = 0.35, H = 3.0, ry = 0.55, SC = 0.8;
    const cos = Math.cos(ry), sin = Math.sin(ry);
    const seg = (lx, lz, w, d, yb = 0, hh = H, c = OLIVE, o = { tex: TEX.panels, repeat: [3, 1] }) =>
      addRotatedBox(MX + lx * SC * cos + lz * sin, yb, MZ - lx * SC * sin + lz * cos, w * SC, hh, d, ry, c, o);
    seg(0, 4, 19, T);
    let fx = -9.5;
    for (const [w, kind] of [[4, 0], [2.5, 2], [3, 0], [2.5, 1], [3, 0], [2.5, 2], [1.5, 0]]) {
      if (kind === 0) seg(fx + w / 2, -4, w, T);
      else if (kind === 1) { seg(fx + w / 2, -4, w, T, 0, 1.05); seg(fx + w / 2, -4, w, T, 2.2, H - 2.2); }
      else seg(fx + w / 2, -4, w, T, 2.25, H - 2.25);
      fx += w;
    }
    for (const e of [-1, 1]) {
      seg(e * 9.5, -2.1, T / SC, 3.6); seg(e * 9.5, 2.9, T / SC, 2.4);
      seg(e * 9.5, 0.4, T / SC, 2.4, 0, 1.05); seg(e * 9.5, 0.4, T / SC, 2.4, 2.2, H - 2.2);
    }
    seg(0, -2.1, 19.6, 4.4, H, 0.24, GREENRF, { metal: 0.4, rough: 0.6 });
    seg(0, 2.1, 19.6, 4.4, H, 0.24, GREENRF, { metal: 0.4, rough: 0.6 });
    seg(0, 0, 20, 0.9, H + 0.2, 0.24, 0x3d5730, { metal: 0.4 });
    for (const tz of [-1.6, 1.6]) {
      seg(-3, tz, 7, 1.0, 0, 0.85, WOODL, PLANK);
      seg(5, tz, 4.5, 1.0, 0, 0.85, WOODL, PLANK);
    }
    seg(7.8, 2.9, 2.2, 1.4, 0, 1.0, 0x5a6152, { metal: 0.4 });
    neonSign('MESS HALL', 0x9fd45f, MX - 4 * sin, 3.7, MZ - 4 * cos - 0.4, ry, 0.75);
    drum(MX - 9, MZ - 2.5); tires(MX + 8.5, MZ - 6, 4);
  }

  // ============ SE: OFFICE COMPOUND (two-story HQ on the east lobe) ============
  {
    const OX = 18.5, OZ = 13, T = 0.4, FH = 3.2;
    const WALLC = 0xc4b48c;
    addBox(OX + 5.8, OZ, T, FH, 12, WALLC, { tex: TEX.panels, repeat: [4, 1] });
    addBox(OX - 5.8, OZ - 4, T, FH, 4, WALLC, { tex: TEX.panels });
    addBox(OX - 5.8, OZ + 4, T, FH, 4, WALLC, { tex: TEX.panels });
    addPlatform(OX - 5.8, 2.3, OZ, T, FH - 2.3, 4.2, WALLC, { tex: TEX.panels });
    for (const s of [-1, 1]) {
      addBox(OX - 3.5, OZ + s * 6, 5, FH, T, WALLC, { tex: TEX.panels });
      addBox(OX + 3.5, OZ + s * 6, 5, FH, T, WALLC, { tex: TEX.panels });
      addBox(OX, OZ + s * 6, 2, 1.05, T, WALLC, { tex: TEX.panels });
      addPlatform(OX, 2.2, OZ + s * 6, 2, FH - 2.2, T, WALLC, { tex: TEX.panels });
    }
    for (let i = 1; i <= 7; i++) addBox(OX + 4.4, OZ - 4.9 + i * 1.05, 2.4, i * 0.5, 1.05, 0x8a8f7c, { tex: TEX.concrete });
    addPlatform(OX - 1.2, FH, OZ, 9.2, 0.35, 12, 0x9ba189, { tex: TEX.concrete, repeat: [3, 3] });
    addPlatform(OX + 4.4, FH, OZ + 4.6, 2.4, 0.35, 2.8, 0x9ba189, { tex: TEX.concrete });
    const F2 = FH + 0.35;
    addPlatform(OX + 5.8, F2, OZ, T, FH - 0.4, 12, WALLC, { tex: TEX.panels, repeat: [4, 1] });
    for (const s of [-1, 1]) addPlatform(OX - 5.8, F2, OZ + s * 4.4, T, FH - 0.4, 3.2, WALLC, { tex: TEX.panels });
    addPlatform(OX - 5.8, F2, OZ, T, 1.0, 6, WALLC, { tex: TEX.panels });
    for (const s of [-1, 1]) {
      addPlatform(OX - 3, F2, OZ + s * 6, 5.6, FH - 0.4, T, WALLC, { tex: TEX.panels });
      addPlatform(OX + 3.5, F2, OZ + s * 6, 4.6, FH - 0.4, T, WALLC, { tex: TEX.panels });
      addPlatform(OX + 0.5, F2, OZ + s * 6, 1.6, 1.0, T, WALLC, { tex: TEX.panels });
    }
    addPlatform(OX, F2 + FH - 0.4, OZ, 12, 0.35, 12.4, 0x8f9582, { tex: TEX.concrete, repeat: [4, 4] });
    const R = F2 + FH;
    for (const [dx, dz, w, d] of [[0, -6, 12, 0.3], [0, 6, 12, 0.3], [5.8, 0, 0.3, 12], [-5.8, 0, 0.3, 12]]) {
      addPlatform(OX + dx, R - 0.05, OZ + dz, w, 0.85, d, 0x7c8270, { tex: TEX.panels });
    }
    addDecor(OX - 2, R + 0.8, OZ + 2, 1.8, 1.0, 1.4, 0x767c6a, { metal: 0.5 });
    addDecor(OX, FH - 0.06, OZ - 6.02, 12.2, 0.28, 0.1, 0xe0dcd0, { rough: 0.8 });
    addDecor(OX, FH - 0.06, OZ + 6.02, 12.2, 0.28, 0.1, 0xe0dcd0, { rough: 0.8 });
    addDecor(OX - 5.85, FH - 0.06, OZ, 0.1, 0.28, 12.2, 0xe0dcd0, { rough: 0.8 });
    addDecor(OX - 4.6, 0, OZ, 2.4, 0.06, 4.4, 0xe8b40f, { rough: 0.9 }).material.map = TEX.hazard;
    neonSign('HQ', 0x9fd45f, OX - 6.05, 2.7, OZ, Math.PI / 2, 0.7);
    addBox(OX - 2, OZ - 3, 2.2, 0.8, 1.0, 0x7a6242, PLANK);
    addBox(OX + 1.5, OZ + 3, 2.2, 0.8, 1.0, 0x7a6242, PLANK);
    hesco(OX - 8.5, OZ + 4.5);
    crate(OX - 8, OZ + 5, 1.3, 1.1);
  }

  // (armory removed — that spot is the cliff's north go-around corridor now)
  crate(20, -8, 1.2, 1.0); drum(21, -9.2, 0x4a5a3a);   // corridor-edge cover

  // ============ E BUMP: MOTOR POOL carport (the small east lobe) ============
  {
    const VX = 28.5, VZ = 12;
    for (const [px2, pz2] of [[-2.2, -2.8], [-2.2, 2.8], [2.2, -2.8], [2.2, 2.8]]) {
      addBox(VX + px2, VZ + pz2, 0.4, 3.6, 0.4, 0x5a6152, { metal: 0.5 });
    }
    addPlatform(VX, 3.6, VZ, 5.8, 0.25, 7.0, 0x9aa4a8, { metal: 0.45, rough: 0.55 });
    addDecor(VX, 3.56, VZ, 5.4, 0.02, 6.6, 0xc4bda6, { rough: 0.9 });
    jeep(VX + 0.5, VZ, 1.62);
    crate(VX - 2, VZ + 3.5, 1.1, 0.9);
    neonSign('MOTOR POOL', 0x8fb4d4, VX - 3.5, 4.3, VZ, Math.PI / 2, 0.6);
  }

  // ============ S FINGER: FUEL DUMP guarding the spawn road ============
  {
    const UX = 9.5, UZ = 22.5;
    addBox(UX, UZ, 4.6, 2.4, 2.4, 0x8a6a30, { metal: 0.5, rough: 0.5 });
    addDecor(UX, 2.4, UZ, 4.7, 0.3, 0.5, 0x6e5426, { metal: 0.5 });
    addBox(UX + 3.2, UZ + 0.8, 0.8, 1.3, 0.8, 0x8a3a2a, { metal: 0.4 });
    for (let i = 0; i < 3; i++) drum(UX - 1 + i * 1.15, UZ + 3.4, [0x8a3a2a, 0x4a5a3a, 0x8a6a30][i]);
    hesco(UX - 1.5, UZ - 3.2);
    neonSign('FUEL', 0xffb347, UX - 3, 2.2, UZ - 2.4, 0, 0.5);
  }

  // ============ FLAGPOLE at the center-south crossroads ============
  {
    const PX = 5, PZ = 15;
    addDecor(PX, 0, PZ, 0.16, 9.5, 0.16, 0xd8d4cc, { metal: 0.7 });
    const flag = addDecor(PX + 0.85, 8.3, PZ, 1.7, 1.05, 0.06, 0xc23b2e, { rough: 0.9, emissive: 0x330d0a, emissiveIntensity: 0.5 });
    flag.rotation.y = 0.3;
    addBox(PX, PZ, 1.3, 0.5, 1.3, 0x8f959c, { tex: TEX.concrete });
  }

  // ============ CONNECTIVE COVER ============
  // (jeep wreck removed — it plugged the cliff's north go-around mouth)
  sandbags(-14, -21, 4, false, 0, PLAT);              // plateau lip nest covering the N finger
  sandbags(13.5, 9.5, 4, true, 0.4);                  // hill/office gap (south side, lane open)
  hesco(-1.5, 11); hesco(5.5, 12);                    // chicane posts — road passes between
  addBox(-6.5, 20.5, 5, 1.7, 0.25, 0x7a6242, PLANK);   // fence: mess yard to the S road
  addDecor(-6.5, 1.7, 20.5, 5.4, 0.12, 0.3, 0x6b5638, { rough: 0.9 });
  addBox(9, 18, 5, 1.1, 0.5, 0xb5a888, { tex: TEX.concrete });   // low wall on S road
  drum(18, -8); drum(19.2, -7.4, 0x4a5a3a);
  tires(-15, 22, 3);
  floodlight(-7, -16, 0.6); floodlight(11, 15, -2.2); floodlight(-21, 13, -0.7);

  // ============ INSIDE VEGETATION ============
  palm(-9, 13, 5.5, 0.1, 0.8); palm(16, 1, 5.5, 0.09, 4.2); palm(-2, 25, 6, 0.11, 2.0);
  palm(23, 19, 5.5, 0.1, 3.4); palm(-22, 1, 5, 0.12, 1.2);
  for (const [sx, sz, ss] of [[-24, 8, 1.0], [-16, 22, 0.9], [4, 27, 0.9], [14, 20, 0.8],
    [20, -6, 0.9], [6, -12, 0.8], [-10, 0, 0.7], [1, 7, 0.6], [-20, -5, 0.9], [10, 26, 0.8]]) scrub(sx, sz, ss);
  for (const [tx, tz, ry2, len] of [[-8, -18, 1.57, 9], [2, 20, 1.5, 9], [-6, 6, 0.06, 12]]) {
    for (const s of [-0.55, 0.55]) {
      const tr = addDecor(tx + Math.sin(ry2) * s, 0.012, tz + Math.cos(ry2) * s, len, 0.012, 0.3, 0x6e5838, { rough: 1.0 });
      tr.rotation.y = ry2; tr.material.transparent = true; tr.material.opacity = 0.5;
    }
  }

  mergeStaticMeshes();
}


// ================= MONASTERY (Nine Lives cathedral port) =================
// Stylized hand-painted textures (OW direction): big shapes, painterly blotches, no photo noise.
const MTEX = {};
function monasteryTex() {
  if (MTEX.flag) return;
  MTEX.flag = makeTex((c, w, h) => {           // warm flagstones
    c.fillStyle = '#7a6444'; c.fillRect(0, 0, w, h);
    const cell = 64;
    for (let y = 0; y < h; y += cell) for (let x = 0; x < w; x += cell) {
      const t = Math.random();
      c.fillStyle = `rgb(${110 + t * 40},${88 + t * 34},${58 + t * 24})`;
      c.fillRect(x + 3, y + 3, cell - 6, cell - 6);
      c.fillStyle = 'rgba(255,235,200,0.10)'; c.fillRect(x + 3, y + 3, cell - 6, 5); // top edge light
      c.fillStyle = 'rgba(30,18,8,0.25)'; c.fillRect(x + 3, y + cell - 9, cell - 6, 6);
    }
  }, 512, 512);
  MTEX.block = makeTex((c, w, h) => {          // sandstone block courses
    c.fillStyle = '#2e2015'; c.fillRect(0, 0, w, h);
    const bw = 128, bh = 52;
    for (let y = 0, row = 0; y < h; y += bh, row++) {
      for (let x = -((row % 2) * bw / 2); x < w; x += bw) {
        const t = Math.random();
        c.fillStyle = `rgb(${125 + t * 35},${97 + t * 28},${62 + t * 20})`;
        c.fillRect(x + 3, y + 3, bw - 6, bh - 6);
        c.fillStyle = 'rgba(255,240,210,0.12)'; c.fillRect(x + 3, y + 3, bw - 6, 4);
        c.fillStyle = 'rgba(20,12,5,0.22)'; c.fillRect(x + 3, y + bh - 8, bw - 6, 5);
      }
    }
  }, 512, 512);
  MTEX.plaster = makeTex((c, w, h) => {        // warm cream plaster, big soft blotches
    c.fillStyle = '#b59a70'; c.fillRect(0, 0, w, h);
    for (let i = 0; i < 26; i++) {
      const r = 40 + Math.random() * 90;
      const g = c.createRadialGradient(Math.random() * w, Math.random() * h, 0, Math.random() * w, Math.random() * h, r);
      const dark = Math.random() > 0.5;
      g.addColorStop(0, dark ? 'rgba(120,92,58,0.20)' : 'rgba(230,205,160,0.18)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g; c.fillRect(0, 0, w, h);
    }
  }, 512, 512);
  MTEX.glass = makeTex((c, w, h) => {          // stained glass mosaic
    const cols = ['#26128a', '#c21b26', '#e8920d', '#0d5b8c', '#7a1470', '#1b8a4a'];
    for (let y = 0; y < h; y += 24) for (let x = 0; x < w; x += 24) {
      c.fillStyle = cols[(Math.random() * cols.length) | 0]; c.fillRect(x, y, 24, 24);
    }
    c.strokeStyle = 'rgba(10,8,6,0.85)'; c.lineWidth = 3;
    for (let x = 0; x <= w; x += 24) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke(); }
    for (let y = 0; y <= h; y += 24) { c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
  }, 256, 256);
}
const MMATS = {
  flag:    () => ({ tex: MTEX.flag, color: 0xffffff, rough: 0.85 }),
  block:   () => ({ tex: MTEX.block, color: 0xffffff, rough: 0.85 }),
  plaster: () => ({ tex: MTEX.plaster, color: 0xffffff, rough: 0.9 }),
  grass:   () => ({ color: 0x2c5e22, rough: 0.95 }),
  dirt:    () => ({ color: 0x5c4228, rough: 0.95 }),
  ceil:    () => ({ color: 0x241c36, rough: 0.95 }),
  wood:    () => ({ color: 0x59300f, rough: 0.6 }),
  gold:    () => ({ color: 0xd9a030, rough: 0.3, metal: 0.8 }),
  iron:    () => ({ color: 0x1a1a1e, rough: 0.5, metal: 0.9 }),
  grave:   () => ({ color: 0x9a9aa8, rough: 0.9 }),
  water:   () => ({ color: 0x0a2036, rough: 0.05 }),
  bush:    () => ({ color: 0x1e4a14, rough: 0.95 }),
  flame:   () => ({ color: 0xffa040, emissive: 0xff8020, emissiveIntensity: 3.5 }),
  banV:    () => ({ color: 0x48197f, emissive: 0x8030f0, emissiveIntensity: 0.35 }),
  banA:    () => ({ color: 0xb3610f, emissive: 0xff8020, emissiveIntensity: 0.35 }),
  glass:   () => ({ tex: MTEX.glass, color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.55, rough: 0.4 }),
};
function buildMonastery() {
  monasteryTex();
  // world floor far below play space (crypt floor is y=0..0.5; nothing at world y<0)
  addPlatform(0, -0.6, 0, 340, 0.5, 200, 0x14100c, { rough: 1 });
  for (const [x0, y0, z0, x1, y1, z1, mat, flags] of MONASTERY.boxes) {
    const spec = (MMATS[mat] || MMATS.block)();
    const w = x1 - x0, hh = y1 - y0, d = z1 - z0;
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    if (flags & 1) {
      const m = addDecor(cx, y0, cz, w, hh, d, spec.color ?? 0xffffff, spec);
      if (spec.tex) {
        m.material.map = spec.tex.clone(); m.material.map.needsUpdate = true;
        m.material.map.repeat.set(Math.max(1, Math.round(Math.max(w, d) / 3)), Math.max(1, Math.round(hh / 3)));
      }
      if (spec.emissive) { m.material.emissive = new THREE.Color(spec.emissive); m.material.emissiveIntensity = spec.emissiveIntensity ?? 1; }
    } else {
      addPlatform(cx, y0, cz, w, hh, d, spec.color ?? 0xffffff, {
        tex: spec.tex, rough: spec.rough, metal: spec.metal,
        emissive: spec.emissive, emissiveIntensity: spec.emissiveIntensity,
        pen: !!(flags & 2),
      });
    }
  }
  // ritual circles: glowing violet rings (decor)
  for (const [x, y, z] of MONASTERY.circles) {
    for (const r of [3.2, 2.5]) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(r, 0.06, 8, 48),
        new THREE.MeshStandardMaterial({ color: 0x7030ff, emissive: 0x7a3cff, emissiveIntensity: 4 })
      );
      ring.rotation.x = -Math.PI / 2; ring.position.set(x, y, z); ring.raycast = () => {};
      mapRoot.add(ring);
    }
    const gl = new THREE.PointLight(0x8040ff, 1.6, 14); gl.position.set(x, y + 1.2, z); mapRoot.add(gl);
  }
  // rose windows: stained-glass discs on the nave end walls (decor)
  for (const [x, y, z, r] of MONASTERY.discs) {
    const disc = new THREE.Mesh(
      new THREE.CylinderGeometry(r, r, 0.1, 32),
      new THREE.MeshStandardMaterial({ map: MTEX.glass.clone(), emissive: 0xffffff, emissiveIntensity: 0.5, emissiveMap: MTEX.glass })
    );
    disc.rotation.z = Math.PI / 2; disc.position.set(x, y, z); disc.raycast = () => {};
    mapRoot.add(disc);
  }
  // interior lights
  for (const [x, y, z, col, inten, dist] of MONASTERY.lights) {
    const L = new THREE.PointLight(col, inten, dist);
    L.position.set(x, y, z); mapRoot.add(L);
  }
  mergeStaticMeshes();
}

export const MAPS = {
  districts: { name: 'DISTRICTS', desc: 'open streets · five zones · long sightlines', build: buildDistricts, bounds: { x: 70, z: 70 } },
  shipment:  { name: 'SHIPMENT',  desc: 'container yard · tiny · pure chaos', build: buildShipment, bounds: { x: 16, z: 16 } },
  killhouse: { name: 'KILLHOUSE', desc: 'training warehouse · tight + vertical', build: buildKillhouse, bounds: { x: 21, z: 13 } },
  blackout:  { name: 'BLACKOUT',  desc: 'sealed office floor · lights out · CQB', build: buildBlackout, bounds: { x: 32, z: 21 } },
  range:     { name: 'FIRING RANGE', desc: 'training camp · elevated range · 3 lanes', build: buildRange, bounds: { x: 36, z: 36 } },
  monastery: { name: 'MONASTERY', desc: 'gothic cathedral · crypt + bridge · 5v5 scale', build: buildMonastery, bounds: { x: 112, z: 48 } },
};

export function getMapBounds() {
  return (MAPS[currentMap] || MAPS.districts).bounds;
}

let currentMap = null;
export function getCurrentMap() { return currentMap; }

export function buildMap(id) {
  mapBoundaryPoly = null;
  if (!MAPS[id]) id = 'districts';
  if (currentMap === id) return;
  clearMap();
  currentMap = id;
  MAPS[id].build();
  mapRoot.updateMatrixWorld(true);
}

// Destructible map lights: { mesh, light, on } — game.js raycasts mesh, kills emissive+light.
// Populated by map builders (currently blackout only). Index order is deterministic.
export const mapLights = [];
// Positional ambience emitters: { x, y, z, kind } kind: hvac|serverfan|vending|flickerbuzz
export const mapAmbience = [];

let flickerTimer = null;
export function clearMap() {
  mapLights.length = 0;
  mapAmbience.length = 0;
  if (flickerTimer) { clearInterval(flickerTimer); flickerTimer = null; }
  currentMap = null;
  obstacles.length = 0;
  staticMeshes.length = 0;
  for (const child of [...mapRoot.children]) {
    mapRoot.remove(child);
    child.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          if (m.map) m.map.dispose();
          m.dispose();
        }
      }
    });
  }
}
