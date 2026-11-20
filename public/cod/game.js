// COD — client
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
// Post-processing imports for bloom and SSAO
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';

// ---------------- config ----------------
const EYE_HEIGHT = 1.6;
const MOVE_SPEED = 9;
const SPRINT_MULT = 1.6;
const JUMP_VEL = 8;
const GRAVITY = 22;
const PLAYER_RADIUS = 0.45;
const STATE_SEND_HZ = 20;
const WALL_GLIDE_FALL = -2.2;   // capped fall speed while gliding on a wall
const WALL_JUMP_PUSH = 9;       // horizontal kick off the wall

// ---------------- weapons ----------------
// dmg = body shot; headshots multiply by headMult
// kick = {z: viewmodel push, rot: viewmodel rotation}
// pattern = camera recoil per consecutive shot [pitchUp, yawDrift] (radians); spray resets after a pause
// falloff = { start, end, min }: full dmg to start(m), scales to min multiplier at end(m)
// action = bolt/pump cycle { delay, dur } within the cooldown; scope=true means overlay ADS (sniper)
const WEAPONS = [
  null, // 1-indexed
  { name: 'RIFLE',   key: '1', dmg: 25, headMult: 2.0, cooldown: 180,  pellets: 1, spread: 0,     color: 0x44aaff, freq: 880,
    mag: 30, reload: 2400, kick: { z: 0.10, rot: 0.12, recover: 11 },   // 2400 = native speed of the baked VM reload clip
    pattern: [[0.007,0],[0.0085,0.001],[0.009,-0.0015],[0.009,0.002],[0.0085,-0.003],[0.007,0.0035],[0.0065,-0.0035],[0.0065,0.0035]],
    recovery: 6.5, falloff: { start: 25, end: 60, min: 0.7 }, ads: true, adsFov: 58, auto: true,
    adsPos: { x: 0.0, y: -0.145, z: -0.30 },
    tracer: { style: 'tracer', color: 0x33aaff } },
  { name: 'SHOTGUN', key: '2', dmg: 15, headMult: 1.5, cooldown: 850,  pellets: 8, spread: 0.075, color: 0xffaa33, freq: 300,
    mag: 6,  reload: 2200, kick: { z: 0.38, rot: 0.30, recover: 8 },
    pattern: [[0.014,0]], recovery: 4.5, falloff: { start: 5, end: 22, min: 0.2 },
    ads: true, adsFov: 62, adsSpread: 0.045, action: { delay: 220, dur: 380, freq: 210 },
    adsPos: { x: 0.0, y: -0.13, z: -0.28 },
    tracer: { style: 'tracer', color: 0xffaa33 } },
  { name: 'SNIPER',  key: '3', dmg: 70, headMult: 2.0, cooldown: 1300, pellets: 1, spread: 0,     color: 0xff44ff, freq: 1500,
    mag: 5,  reload: 2500, kick: { z: 0.42, rot: 0.40, recover: 6 },
    pattern: [[0.022,0]], recovery: 3.5, ads: true, scope: true, adsFov: 21.7, hipSpread: 0.025,   // 21.7° = exactly 4x zoom from 75° base
    action: { delay: 320, dur: 520, freq: 340 },
    tracer: { style: 'beam', color: 0xff55ff, radius: 0.05 } },
  { name: 'DEAGLE',  key: '4', dmg: 45, headMult: 2.5, cooldown: 400,  pellets: 1, spread: 0,     color: 0xffd700, freq: 550,
    mag: 7,  reload: 2400, kick: { z: 0.16, rot: 0.34, recover: 7.5 },   // procedural recoil + slide blowback
    pattern: [[0.007,0],[0.008,0.002],[0.008,-0.0025],[0.009,0.003]], recovery: 5.0,
    falloff: { start: 18, end: 45, min: 0.6 }, ads: true, adsFov: 55,
    adsPos: { x: 0.0, y: -0.05, z: -0.30 },
    tracer: { style: 'tracer', color: 0xffd700 } },
];
let currentWeapon = 1;

// ammo state — per-weapon magazine persists across switches; reserves are infinite
const ammo = { 1: 30, 2: 6, 3: 5, 4: 7 };
let reloading = false;
let adsActive = false;

// ---------------- three.js setup ----------------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xbfd8f0);   // morning sky
scene.fog = new THREE.Fog(0xcfe0f0, 110, 340);

const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 500);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5)); // 2x retina = 4x fragment cost; 1.5 is visually equal in motion
renderer.shadowMap.enabled = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);
window.__renderer = renderer; // debug/perf instrumentation hook

// ============================================================================
// POST-PROCESSING: EffectComposer with bloom and SSAO for indoor realism
// ============================================================================
const composer = new EffectComposer(renderer);
window.__composer = composer; // debug: access composer for tests
const renderPass = new RenderPass(scene, camera);
composer.addPass(renderPass);

// SSAO: contact shadows in corners and under furniture — subtle, don't crush the dark scene
const ssaoPass = new SSAOPass(scene, camera, innerWidth, innerHeight);
ssaoPass.kernelRadius = 0.35;      // small radius for contact shadows
ssaoPass.minDistance = 0.0005;
ssaoPass.maxDistance = 0.02;
ssaoPass.output = SSAOPass.OUTPUT.Default;
composer.addPass(ssaoPass);

// Bloom: emissives glow (EXIT signs, vending, server LEDs, muzzle flash, tracers)
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(innerWidth, innerHeight),
  0.55,   // strength — glow without washing scene grey
  0.4,    // radius — soft falloff
  0.85    // threshold — only bright emissives bloom
);
composer.addPass(bloomPass);

// Output pass for correct color space
const outputPass = new OutputPass();
composer.addPass(outputPass);

// Post-processing state: controlled by quality tiers
let composerEnabled = true;
let ssaoEnabled = true;

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
  ssaoPass.setSize(innerWidth, innerHeight);
  bloomPass.setSize(innerWidth, innerHeight);
});

// lights — defaults are the bright-morning rig; per-map identity applied in applyAtmosphere()
const hemi = new THREE.HemisphereLight(0xcfe4ff, 0x9a8a6a, 0.95);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffe9c4, 1.6);
sun.position.set(50, 35, 25);   // low morning sun angle
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -100; sun.shadow.camera.right = 100;
sun.shadow.camera.top = 100; sun.shadow.camera.bottom = -100;
scene.add(sun);
const fill = new THREE.DirectionalLight(0xdfeaff, 0.35);
fill.position.set(-40, 30, -30);
scene.add(fill);

// ---------------- adaptive quality: hold 60fps on weak GPUs ----------------
// Tiers step down when fps sags, back up when there's headroom. Applied changes:
// pixel ratio (biggest fragment cost), shadow map size, shadows on/off, antialias stays.
// Post-processing: composer/bloom/SSAO controlled per tier for indoor maps.
// Indoor shadows: strongest N point lights get castShadow (capped for perf).
const QUALITY_TIERS = [
  // ultra is OPT-IN only (?quality=ultra or settings) — SSAO costs ~35fps; the watchdog never auto-upgrades into tier 0
  { name: 'ultra',  px: 1.5,  shadows: true,  shadowSize: 2048, composer: true,  ssao: true,  indoorShadows: 5, flashlightShadow: true },
  { name: 'high',   px: 1.25, shadows: true,  shadowSize: 2048, composer: true,  ssao: false, indoorShadows: 5, flashlightShadow: true },
  { name: 'medium', px: 1.25, shadows: true,  shadowSize: 1024, composer: true,  ssao: false, indoorShadows: 3, flashlightShadow: true },
  { name: 'low',    px: 1.0,  shadows: true,  shadowSize: 512,  composer: true,  ssao: false, indoorShadows: 0, flashlightShadow: false },
  { name: 'potato', px: 0.85, shadows: false, shadowSize: 512,  composer: false, ssao: false, indoorShadows: 0, flashlightShadow: false },
];
let qualityTier = 0;
// URL param to force quality tier: ?quality=high|medium|low|potato (also disables FPS watchdog)
const forceQualityParam = new URLSearchParams(location.search).get('quality');
const forceQualityIdx = forceQualityParam ? QUALITY_TIERS.findIndex(t => t.name === forceQualityParam) : -1;
if (forceQualityIdx >= 0) qualityTier = forceQualityIdx;

function applyQuality(i) {
  qualityTier = Math.max(0, Math.min(QUALITY_TIERS.length - 1, i));
  const q = QUALITY_TIERS[qualityTier];
  renderer.setPixelRatio(Math.min(devicePixelRatio, q.px));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = q.shadows;
  sun.castShadow = q.shadows;
  if (sun.shadow.mapSize.x !== q.shadowSize) {
    sun.shadow.mapSize.set(q.shadowSize, q.shadowSize);
    if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; } // force realloc at new size
  }
  // material shadow state is baked per-program; flag a recompile when toggling shadows
  scene.traverse(o => { if (o.isMesh && o.material) o.material.needsUpdate = true; });
  
  // Post-processing tier control
  composerEnabled = q.composer;
  ssaoEnabled = q.ssao;
  ssaoPass.enabled = q.ssao;
  
  // Resize composer when quality changes pixel ratio
  composer.setSize(innerWidth, innerHeight);
  ssaoPass.setSize(innerWidth, innerHeight);
  bloomPass.setSize(innerWidth, innerHeight);
  
  // Update indoor shadow casters based on tier
  updateIndoorShadowCasters(q.indoorShadows, q.flashlightShadow);
}
// fps watchdog: sample over 2s windows; drop a tier under 50fps, climb after 3 good windows >58
let fpsFrames = 0, fpsT0 = performance.now(), fpsGoodStreak = 0, fpsCurrent = 0;

// GPU identification — catches the #1 cause of a strong PC running at 30fps:
// the browser silently falling back to SOFTWARE rendering (SwiftShader / Basic Render Driver)
const GPU_NAME = (() => {
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
  } catch { return 'unknown'; }
})();
const SOFTWARE_RENDERING = /swiftshader|software|basic render|llvmpipe/i.test(GPU_NAME);
if (SOFTWARE_RENDERING) {
  document.getElementById('gpuWarn').style.display = 'block';
  document.getElementById('gpuWarn').textContent =
    '⚠ BROWSER IS SOFTWARE-RENDERING (no GPU!) — enable "Use hardware acceleration" in browser settings and relaunch';
}
console.log(`[gpu] ${GPU_NAME}${SOFTWARE_RENDERING ? '  << SOFTWARE FALLBACK — this is why fps is low' : ''}`);

// F3 perf overlay: fps, frame time, gpu, tier, resolution, draw calls
let perfHudOn = false;
addEventListener('keydown', (e) => {
  if (e.code === 'F3') {
    e.preventDefault();
    perfHudOn = !perfHudOn;
    document.getElementById('perfHud').style.display = perfHudOn ? 'block' : 'none';
  }
});
function updatePerfHud() {
  if (!perfHudOn) return;
  const info = renderer.info.render;
  const q = QUALITY_TIERS[qualityTier];
  const el = document.getElementById('perfHud');
  el.textContent =
    `FPS ${fpsCurrent.toFixed(0)}  (${(1000 / Math.max(1, fpsCurrent)).toFixed(1)}ms)\n` +
    `GPU ${GPU_NAME.slice(0, 48)}${SOFTWARE_RENDERING ? '  ⚠SOFTWARE' : ''}\n` +
    `quality ${q.name}  px ${renderer.getPixelRatio()}  shadows ${renderer.shadowMap.enabled ? sun.shadow.mapSize.x : 'off'}\n` +
    `res ${renderer.domElement.width}x${renderer.domElement.height}  calls ${info.calls}  tris ${(info.triangles / 1000).toFixed(1)}k`;
  el.style.color = fpsCurrent >= 55 ? '#8fb' : fpsCurrent >= 40 ? '#fd5' : '#f66';
}

// Upgrade backoff: if stepping up to a tier immediately tanks fps, remember it and
// stop retrying that tier (doubling cooldown each failure). Kills the 60fps->drop->60fps
// oscillation where the watchdog endlessly re-attempts an upgrade the GPU can't hold.
let lastUpgrade = { tier: -1, at: 0 };
const upgradeBlockUntil = new Map();   // tier -> earliest retry timestamp
const upgradeBackoffMs = new Map();    // tier -> current cooldown
function fpsWatchdog() {
  fpsFrames++;
  const now = performance.now();
  if (now - fpsT0 < 2000) return;
  const fps = fpsFrames / ((now - fpsT0) / 1000);
  fpsCurrent = fps;
  fpsFrames = 0; fpsT0 = now;
  updatePerfHud();
  // Skip auto-adjustment if quality was forced via URL param
  if (forceQualityIdx >= 0) return;
  if (fps < 50 && qualityTier < QUALITY_TIERS.length - 1) {
    // If we're bailing out of a tier we only just upgraded into, blacklist it with backoff
    if (lastUpgrade.tier === qualityTier && now - lastUpgrade.at < 12000) {
      const cd = upgradeBackoffMs.get(qualityTier) || 60000;
      upgradeBlockUntil.set(qualityTier, now + cd);
      upgradeBackoffMs.set(qualityTier, Math.min(cd * 2, 10 * 60000));
      console.log(`[quality] upgrade to ${QUALITY_TIERS[qualityTier].name} failed (${fps.toFixed(0)}fps) — blocking retries for ${Math.round(cd / 1000)}s`);
    }
    applyQuality(qualityTier + 1);
    fpsGoodStreak = 0;
    console.log(`[quality] ${fps.toFixed(0)}fps -> stepping down to ${QUALITY_TIERS[qualityTier].name}`);
  } else if (fps > 58 && qualityTier > 1 && ++fpsGoodStreak >= 3) {   // >1: ultra is opt-in only
    const target = qualityTier - 1;
    if ((upgradeBlockUntil.get(target) || 0) > now) { fpsGoodStreak = 0; return; }
    lastUpgrade = { tier: target, at: now };
    applyQuality(target);
    fpsGoodStreak = 0;
    console.log(`[quality] ${fps.toFixed(0)}fps headroom -> back up to ${QUALITY_TIERS[qualityTier].name}`);
  }
}

// ---------------- map system (see maps.js) ----------------
import { MAPS, mapRoot, obstacles, buildMap as buildMapRaw, getCurrentMap, getMapBounds, mapLights, mapAmbience, mapBoundaryPoly } from './maps.js';
scene.add(mapRoot);

// Track which point lights currently have shadows enabled (for cleanup on tier/map change)
let shadowCastingLights = [];

// Enable castShadow on the strongest N point lights (excluding muzzle flash pool and flashlight)
// This is called after buildMap and when quality tier changes
function updateIndoorShadowCasters(maxCount, flashlightShadow) {
  // Clear previous shadow casters
  for (const light of shadowCastingLights) {
    light.castShadow = false;
    if (light.shadow?.map) { light.shadow.map.dispose(); light.shadow.map = null; }
  }
  shadowCastingLights = [];
  
  // Flashlight shadow (single frustum SpotLight — cheap, dramatic effect)
  // Note: flashlightSpot is defined later in the file, so we check if it exists
  if (typeof flashlightSpot !== 'undefined') {
    flashlightSpot.castShadow = flashlightShadow && renderer.shadowMap.enabled;
    if (flashlightShadow && flashlightSpot.castShadow) {
      flashlightSpot.shadow.mapSize.set(1024, 1024);
      flashlightSpot.shadow.camera.near = 0.3;
      flashlightSpot.shadow.camera.far = 28;
      flashlightSpot.shadow.bias = -0.002;
    }
  }
  
  // Skip if no indoor shadows requested or shadows disabled globally
  if (maxCount <= 0 || !renderer.shadowMap.enabled) return;
  
  // Collect all point lights from mapRoot, excluding muzzle flash pool
  // Sort by intensity descending to get the strongest lights
  const candidates = [];
  mapRoot.traverse(obj => {
    if (obj.isPointLight) {
      // Skip muzzle flash pool lights (they have userData.active/life)
      if (obj.userData.active !== undefined) return;
      // Skip lights that are part of mapLights and currently OFF
      const ml = mapLights.find(m => m.light === obj);
      if (ml && !ml.on) return;
      candidates.push(obj);
    }
  });
  
  // Sort by intensity (highest first)
  candidates.sort((a, b) => b.intensity - a.intensity);
  
  // Enable shadows on the top N lights
  const count = Math.min(maxCount, candidates.length);
  for (let i = 0; i < count; i++) {
    const light = candidates[i];
    light.castShadow = true;
    // PointLight shadows = 6 cube faces, so keep mapSize modest
    light.shadow.mapSize.set(512, 512);
    light.shadow.camera.near = 0.2;
    light.shadow.camera.far = light.distance > 0 ? light.distance : 20;
    light.shadow.bias = -0.003;  // tune to avoid acne/peter-panning
    light.shadow.normalBias = 0.02;
    shadowCastingLights.push(light);
  }
  
  // Ensure floors and walls receive shadows (traverse mapRoot)
  mapRoot.traverse(obj => {
    if (obj.isMesh) {
      // Set receiveShadow on solid meshes (not decor with disabled raycast)
      obj.receiveShadow = true;
    }
  });
}

// fit the shadow frustum to the map: a 32m Shipment doesn't need a 200m shadow box
function buildMap(id) {
  buildMapRaw(id);
  applyAtmosphere(id);
  const B = getMapBounds();
  const r = Math.max(B.x, B.z) + 12;
  sun.shadow.camera.left = -r; sun.shadow.camera.right = r;
  sun.shadow.camera.top = r; sun.shadow.camera.bottom = -r;
  sun.shadow.camera.updateProjectionMatrix();
  
  // Set up indoor shadow casters based on current quality tier
  const q = QUALITY_TIERS[qualityTier];
  updateIndoorShadowCasters(q.indoorShadows, q.flashlightShadow);
}

// ---- per-map lighting identity ----
// Low-poly flat colors carry no detail: light does ALL the visual work. Each map gets its
// own time-of-day story — warm key vs cool ambient for shading contrast, depth haze scaled
// to the map's sightlines for distance readability, exposure as a grading knob.
const ATMOSPHERES = {
  //           fog color   near far   hemi sky   ground     int   sun col   int  position        fill int  exposure
  districts: { fog: 0xc8dcee, near: 70, far: 300, sky: 0xbfd9ff, gnd: 0x9a8258, hi: 0.85, sun: 0xffdfa8, si: 1.85, spos: [50, 40, 25], fi: 0.4, exp: 1.15 },  // clear noon: hot warm key, blue sky bounce
  shipment:  { fog: 0xe6c093, near: 26, far: 130, sky: 0x9fb4d4, gnd: 0x8a5e38, hi: 0.7,  sun: 0xffab5e, si: 2.1,  spos: [60, 18, 35], fi: 0.3, exp: 1.1  },  // golden hour: low blazing sun, long shadows
  killhouse: { fog: 0xafbcc6, near: 22, far: 110, sky: 0xa8c2dc, gnd: 0x565650, hi: 0.6,  sun: 0xfff3da, si: 1.35, spos: [30, 45, 10], fi: 0.35, exp: 1.05 }, // overcast morning through skylights
  blackout:  { fog: 0x05070c, near: 9,  far: 55,  sky: 0x1a2438, gnd: 0x0a0c10, hi: 0.16, sun: 0x223048, si: 0.05, spos: [50, 35, 25], fi: 0.0, exp: 0.98 },  // 3am: fixtures are the only real light
  range:     { fog: 0xd8c9a8, near: 60, far: 260, sky: 0xc4d8f0, gnd: 0xb89468, hi: 0.95, sun: 0xffe4a8, si: 1.8,  spos: [35, 52, 30], fi: 0.55, exp: 1.15 }, // hot tropical noon: high sun, bright dust bounce
  monastery: { fog: 0x0e1428, near: 55, far: 260, sky: 0x4a5a90, gnd: 0x2e2418, hi: 0.75, sun: 0x9ab0e8, si: 0.9, spos: [40, 60, 30], fi: 0.35, exp: 1.3 }, // moonlit night: readable dark — cool moon key, candle interiors carry
};
function applyAtmosphere(id) {
  const a = ATMOSPHERES[id] || ATMOSPHERES.districts;
  scene.fog.color.setHex(a.fog);
  scene.fog.near = a.near; scene.fog.far = a.far;
  scene.background = new THREE.Color(a.fog);   // haze and horizon meet — sells the depth
  hemi.color.setHex(a.sky); hemi.groundColor.setHex(a.gnd); hemi.intensity = a.hi;
  sun.color.setHex(a.sun); sun.intensity = a.si;
  sun.position.set(a.spos[0], a.spos[1], a.spos[2]);
  fill.intensity = a.fi;
  renderer.toneMappingExposure = a.exp;
}
buildMap('districts'); // default; rebuilt on match init if the host picked another map

// ============================================================================
// DARKNESS GAMEPLAY SYSTEMS: muzzle flash lighting, flashlight, shootable lights,
// hot tracers, ambient soundscape
// ============================================================================

// ---- MUZZLE FLASH LIGHT POOL (pooled PointLights for local + remote shots) ----
const FLASH_POOL_SIZE = 3;
const flashPool = [];
for (let i = 0; i < FLASH_POOL_SIZE; i++) {
  const pl = new THREE.PointLight(0xffa550, 0, 12, 2);
  pl.userData.active = false;
  pl.userData.life = 0;
  scene.add(pl);
  flashPool.push(pl);
}
function fireMuzzleFlashLight(worldPos) {
  // skip if camera too far (>40m perf optimization)
  if (camera.position.distanceTo(worldPos) > 40) return;
  // find an inactive light, or steal the oldest
  let best = flashPool[0];
  for (const p of flashPool) {
    if (!p.userData.active) { best = p; break; }
    if (p.userData.life < best.userData.life) best = p;
  }
  best.position.copy(worldPos);
  best.intensity = 12;
  best.userData.active = true;
  best.userData.life = performance.now();
}
function updateFlashPool(dt) {
  for (const p of flashPool) {
    if (!p.userData.active) continue;
    p.intensity = Math.max(0, p.intensity - dt * 180); // ~60ms full decay
    if (p.intensity <= 0) { p.userData.active = false; p.intensity = 0; }
  }
}

// ---- FLASHLIGHT (T key toggle) ----
let flashlightOn = false;
var flashlightSpot = new THREE.SpotLight(0xfff5e6, 0, 28, 0.35, 0.4, 1.5);
flashlightSpot.visible = false;
scene.add(flashlightSpot);
scene.add(flashlightSpot.target);
// remote flashlights: Map<remoteId, SpotLight>
const remoteFlashlights = new Map();
const MAX_REMOTE_FL = 4;

function toggleFlashlight() {
  flashlightOn = !flashlightOn;
  flashlightSpot.visible = flashlightOn;
  flashlightSpot.intensity = flashlightOn ? 3.5 : 0;
  // click sound
  sfx(1800, 0.04, 'square', 0.06);
}
function updateLocalFlashlight() {
  if (!flashlightOn) return;
  // attach to camera position + direction
  flashlightSpot.position.copy(camera.position);
  const fwd = camera.getWorldDirection(new THREE.Vector3());
  flashlightSpot.target.position.copy(camera.position).addScaledVector(fwd, 5);
}
function updateRemoteFlashlights() {
  // collect remote players with fl=true, sorted by distance
  const flPlayers = [];
  for (const [id, r] of remotes) {
    if (r.fl && !r.dead) {
      const d = camera.position.distanceTo(r.group.position);
      flPlayers.push({ id, r, d });
    }
  }
  flPlayers.sort((a, b) => a.d - b.d);
  const active = new Set();
  for (let i = 0; i < Math.min(MAX_REMOTE_FL, flPlayers.length); i++) {
    const { id, r } = flPlayers[i];
    active.add(id);
    let spot = remoteFlashlights.get(id);
    if (!spot) {
      spot = new THREE.SpotLight(0xfff5e6, 3.5, 28, 0.35, 0.4, 1.5);
      scene.add(spot);
      scene.add(spot.target);
      remoteFlashlights.set(id, spot);
    }
    spot.visible = true;
    spot.intensity = 3.5;
    // position at their eye height, aim along their yaw+pitch
    const eyePos = r.group.position.clone().add(new THREE.Vector3(0, 1.6, 0));
    spot.position.copy(eyePos);
    const ry = r.targetRy || 0;
    const pitch = r.aimPitch || 0;
    const dir = new THREE.Vector3(-Math.sin(ry) * Math.cos(pitch), Math.sin(pitch), -Math.cos(ry) * Math.cos(pitch));
    spot.target.position.copy(eyePos).addScaledVector(dir, 5);
  }
  // hide unused
  for (const [id, spot] of remoteFlashlights) {
    if (!active.has(id)) { spot.visible = false; spot.intensity = 0; }
  }
}

// ---- SHOOTABLE LIGHTS ----
function killMapLight(idx, withFX) {
  const entry = mapLights[idx];
  if (!entry || !entry.on) return;
  entry.on = false;
  entry.light.intensity = 0;
  entry.mesh.material.emissive.setHex(0x050505);
  entry.mesh.material.emissiveIntensity = 0.05;
  entry.mesh.material.userData.dead = true;
  if (withFX) {
    const pos = entry.mesh.position.clone();
    // spark burst
    for (let i = 0; i < 8; i++) {
      const sm = new THREE.MeshBasicMaterial({ color: i % 2 ? 0xffdd66 : 0xfff6d0, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false });
      const s = new THREE.Mesh(FX.sparkGeo || new THREE.BoxGeometry(0.014, 0.014, 0.05), sm);
      s.position.copy(pos);
      const v = new THREE.Vector3((Math.random() - 0.5) * 5, -Math.random() * 4 - 1, (Math.random() - 0.5) * 5);
      addEffect(s, 0.4 + Math.random() * 0.2, (dt2, e) => {
        v.y -= 12 * dt2;
        s.position.addScaledVector(v, dt2);
        sm.opacity = e.ttl / e.ttl0;
      });
    }
    // falling glass grit
    for (let i = 0; i < 5; i++) {
      const gm = new THREE.MeshBasicMaterial({ color: 0xccd5dd, transparent: true, opacity: 0.8 });
      const g = new THREE.Mesh(FX.gritGeo || new THREE.BoxGeometry(0.02, 0.02, 0.02), gm);
      g.position.copy(pos);
      const v = new THREE.Vector3((Math.random() - 0.5) * 2, -Math.random() * 2 - 0.5, (Math.random() - 0.5) * 2);
      addEffect(g, 0.6, (dt2, e) => {
        v.y -= 10 * dt2;
        g.position.addScaledVector(v, dt2);
        gm.opacity = (e.ttl / e.ttl0) * 0.8;
      });
    }
    // pop/fizzle sound
    sfx(2200, 0.06, 'square', 0.08);
    sfx(600, 0.12, 'triangle', 0.04);
  }
}

// ---- AMBIENT SOUNDSCAPE ----
let ambienceNodes = []; // { source, gain, panner, kind }
function buildAmbience() {
  stopAmbience();
  if (!mapAmbience.length) return;
  if (audioCtx.state === 'suspended') audioCtx.resume();
  for (const a of mapAmbience) {
    let source, gain, panner;
    gain = audioCtx.createGain();
    // distance-based gain (manual like other positional audio in this game)
    gain.gain.value = 0;
    // we use a simple gain node and update distance manually in the loop
    // for consistent behavior with the game's existing positional sfx pattern
    if (a.kind === 'hvac') {
      // low brown-noise rumble ~55Hz
      source = audioCtx.createBufferSource(); source.buffer = noiseBuf; source.loop = true;
      const lp = audioCtx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 80;
      const bp = audioCtx.createBiquadFilter(); bp.type = 'peaking'; bp.frequency.value = 55; bp.gain.value = 12; bp.Q.value = 1.5;
      source.connect(lp).connect(bp).connect(gain).connect(audioCtx.destination);
    } else if (a.kind === 'serverfan') {
      // broadband whir 300-800Hz
      source = audioCtx.createBufferSource(); source.buffer = noiseBuf; source.loop = true;
      const bp = audioCtx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 500; bp.Q.value = 0.8;
      source.connect(bp).connect(gain).connect(audioCtx.destination);
    } else if (a.kind === 'vending') {
      // 120Hz hum + faint noise
      source = audioCtx.createOscillator(); source.type = 'sawtooth'; source.frequency.value = 120;
      const lp = audioCtx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 300;
      source.connect(lp).connect(gain).connect(audioCtx.destination);
    } else if (a.kind === 'flickerbuzz') {
      // 100Hz buzz that randomly stutters
      source = audioCtx.createOscillator(); source.type = 'square'; source.frequency.value = 100;
      const lp = audioCtx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 400;
      source.connect(lp).connect(gain).connect(audioCtx.destination);
    } else continue;
    source.start();
    ambienceNodes.push({ source, gain, x: a.x, y: a.y, z: a.z, kind: a.kind, stutterNext: 0 });
  }
}
function updateAmbience() {
  const now = performance.now();
  for (const a of ambienceNodes) {
    const dx = camera.position.x - a.x, dy = camera.position.y - a.y, dz = camera.position.z - a.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    // quiet levels: max vol 0.12 at source, falls off with distance
    let vol = Math.max(0, 0.12 * (1 - dist / 20));
    // flickerbuzz random stutter
    if (a.kind === 'flickerbuzz' && now > a.stutterNext) {
      a.stutterNext = now + 80 + Math.random() * 300;
      if (Math.random() < 0.3) vol = 0;
    }
    a.gain.gain.value = vol;
  }
}
function stopAmbience() {
  for (const a of ambienceNodes) {
    try { a.source.stop(); } catch {}
    try { a.gain.disconnect(); } catch {}
  }
  ambienceNodes = [];
}

// ---- DEBUG HOOKS ----
if (new URLSearchParams(location.search).get('debug')) {
  window.__lights = () => mapLights.map(l => ({ on: l.on, pos: l.mesh.position.toArray().map(v => +v.toFixed(2)), hasRaycast: l.mesh.raycast !== (() => {}).toString }));
  window.__fl = () => flashlightOn;
  window.__lightTest = (idx) => {
    // Force-kill a light locally for testing (bypasses server)
    if (idx >= 0 && idx < mapLights.length && mapLights[idx].on) {
      killMapLight(idx, true);
      return true;
    }
    return false;
  };
}

// ---------------- local player state ----------------
const player = {
  pos: new THREE.Vector3(0, 0, 20), // feet position
  vel: new THREE.Vector3(),
  knock: new THREE.Vector3(),       // wall-jump impulse
  wallNormal: null,
  wallSliding: false,
  eyeH: EYE_HEIGHT,
  yaw: 0, pitch: 0,
  onGround: true,
  hp: 100, dead: false,
};

// pace systems: slide, kill rewards, streaks
let queueSlide = false, slideUntil = 0, lastSlideAt = 0;
let speedBoostUntil = 0;
let myKillTimes = [];
const keys = {};
// test hook: ?debug=1 exposes movement internals for headless collision tests
if (new URLSearchParams(location.search).get('debug')) {
  window.__player = () => ({ pos: player.pos.toArray(), onGround: player.onGround, wall: !!player.wallNormal, spent: (player.wallHops || 0) >= 2, hp: player.hp, dead: player.dead });
  window.__nades = () => ({ inv: { ...nadeInv }, live: liveNades.map(n => ({ kind: n.kind, pos: n.pos.toArray().map(v => +v.toFixed(2)), rest: n.rest, mine: n.mine, fuseLeft: Math.round(n.fuseAt - performance.now()) })), throwing: !!throwAnim, cooking: !!(throwAnim && throwAnim.holding), cookFuseLeft: throwAnim ? Math.round(throwAnim.fuseAt - performance.now()) : null, blind: flashBlind ? +document.getElementById('flashBlind').style.opacity : 0, shake: +nadeShake.toFixed(4) });
  window.__throwNade = (kind, cookMs = 0) => { tryThrowNade(kind); if (throwAnim) setTimeout(releaseNadeThrow, Math.max(0, cookMs)); };
  window.__holdNade = (kind) => tryThrowNade(kind);            // press without release (cook until __releaseNade)
  window.__releaseNade = () => releaseNadeThrow();
  window.__refillNades = () => resetNades();
  window.__nadeEvents = [];   // { ev: spawn|bounce|boom, kind, pos, mine, t } — framerate-independent assertions
  window.__freezeThrow = (t) => { window.__throwFreezeT = t; };   // pin throw anim at offset t ms (null to resume)
  window.__setPos = (x, y, z, yaw, pitch) => { player.pos.set(x, y, z); player.vel.set(0, 0, 0); if (yaw !== undefined) player.yaw = yaw; if (pitch !== undefined) player.pitch = pitch; };
  window.__remotes = () => [...remotes.entries()].map(([id, r]) => ({ id, pos: r.group.position.toArray(), w: r.weapon, dead: r.dead, hasSoldier: !!r.soldier, anim: r.animState, sl: !!r.sl, air: !!r.air, spr: !!r.spr, clips: r.actions ? Object.keys(r.actions) : [], gunParent: r.gunModels?.[r.weapon]?.parent?.type }));
  window.__keys = keys;
  // bone introspection: read/override the hold pose on the first remote (tuning HOLD_QUATS)
  window.__bones = () => {
    const r = [...remotes.values()][0];
    if (!r?.poseBones) return null;
    return r.poseBones.map(pb => ({ name: pb.bone.name, quat: [...pb.quat] }));
  };
  window.__setBone = (name, q) => {
    for (const r of remotes.values()) {
      if (!r.poseBones) continue;
      for (const pb of r.poseBones) if (pb.bone.name.includes(name)) pb.quat = q;
    }
  };
  // gunplay hooks: fire the real shoot() path, read recoil/ammo state, force weapon/ADS
  window.__shoot = () => shoot();
  window.__gun = () => ({ w: currentWeapon, recoilPitch, recoilYaw, sprayIdx, ammo: ammo[currentWeapon], ads: adsActive, action: !!actionAnim, fov: camera.fov });
  window.__setWeapon = (n) => { switchWeapon(n); lastShot = 0; ammo[n] = WEAPONS[n].mag; };
  window.__setAds = (on) => setAds(on);
  window.__vm = () => {   // viewmodel introspection: grips found, arms attached, node names
    const out = { w: currentWeapon, grips: [], armMeshes: 0, names: [] };
    const v = new THREE.Vector3();
    weaponModels[currentWeapon].traverse(o => {
      if (o.name) out.names.push(o.name);
      if (o.name === 'GripR' || o.name === 'GripL') {
        o.getWorldPosition(v);
        const ndc = v.clone().project(camera);
        out.grips.push({ name: o.name, children: o.children.length,
          ndc: [+ndc.x.toFixed(2), +ndc.y.toFixed(2), +ndc.z.toFixed(3)],
          scale: +o.getWorldScale(new THREE.Vector3()).x.toFixed(4) });
      }
      if (o.material === ARM_MATS.glove || o.material === ARM_MATS.sleeve) out.armMeshes++;
    });
    out.pos = gunGroup.position.toArray().map(v2 => +v2.toFixed(3));
    return out;
  };
  window.__hold = (on) => { fireHeld = !!on; };
  window.__perf = () => ({ fps: +fpsCurrent.toFixed(1), calls: renderer.info.render.calls, tris: renderer.info.render.triangles, tier: QUALITY_TIERS[qualityTier].name });
  window.__sway = (x, y) => { swayImpYaw += x; swayImpPitch += y; };
  window.__vmState = () => ({
    sway: { yaw: +vmSway.yaw.toFixed(4), pitch: +vmSway.pitch.toFixed(4), roll: +vmSway.roll.toFixed(4) },
    sprintPose: +sprintPose.toFixed(3), sprinting, landDip: +landDip.toFixed(3),
    drawing: !!drawAnim, rotY: +gunGroup.rotation.y.toFixed(3), rotX: +gunGroup.rotation.x.toFixed(3) });
  window.__aim = () => {   // where do the sight AimPoint and visible dot actually project?
    const wr = vmWrapper();
    const out = { w: currentWeapon, adsPos: WEAPONS[currentWeapon].adsPos,
      container: weaponModels[currentWeapon].position.toArray(),
      gun: gunGroup.position.toArray().map(x => +x.toFixed(4)), rot: gunGroup.rotation.toArray().slice(0, 3).map(x => +(+x).toFixed(4)) };
    let aim = null, dot = null;
    wr?.traverse(o => { if (o.name === 'AimPoint') aim = o; if (o.name === 'rd_dot') dot = o; });
    const v = new THREE.Vector3();
    if (aim) { aim.getWorldPosition(v); const n = v.clone().project(camera); out.aimNdc = [+n.x.toFixed(3), +n.y.toFixed(3)]; }
    if (dot) { dot.getWorldPosition(v); const n = v.clone().project(camera); out.dotNdc = [+n.x.toFixed(3), +n.y.toFixed(3)]; }
    if (aim) { aim.getWorldPosition(v); camera.worldToLocal(v); out.aimCam = v.toArray().map(x => +x.toFixed(4)); }
    if (wr) out.wrapperScale = +wr.getWorldScale(new THREE.Vector3()).x.toFixed(4);
    out.expectedAim = wr?.userData?.aim ? wr.userData.aim.toArray().map(x => +x.toFixed(4)) : null;
    return out;
  };
  window.__reload = (drain) => { if (drain !== undefined) ammo[currentWeapon] = drain; startReload(); };
  window.__reloadState = () => {
    const out = { reloading, ammo: ammo[currentWeapon], anim: reloadAnim ? reloadAnim.type : null };
    const wr = vmWrapper();
    if (wr?.userData?.shell) {
      const v = new THREE.Vector3(); wr.userData.shell.getWorldPosition(v);
      const ndc = v.project(camera);
      out.shell = { vis: wr.userData.shell.visible, ndc: [+ndc.x.toFixed(2), +ndc.y.toFixed(2)] };
    }
    return out;
  };
  // dump collision AABBs (for generating server-side bot navigation/LOS data)
  window.__dumpObstacles = () => obstacles.map(o => [
    +o.min.x.toFixed(2), +o.min.y.toFixed(2), +o.min.z.toFixed(2),
    +o.max.x.toFixed(2), +o.max.y.toFixed(2), +o.max.z.toFixed(2),
  ]);
  // visual dump: world-space box + material color per map mesh (for engine ports)
  window.__dumpMapMeshes = () => {
    const out = [];
    const box = new THREE.Box3();
    mapRoot.updateMatrixWorld(true);
    mapRoot.traverse(o => {
      if (!o.isMesh || !o.geometry) return;
      box.setFromObject(o);
      if (!isFinite(box.min.x) || box.isEmpty()) return;
      const c = o.material?.color ? '#' + o.material.color.getHexString() : null;
      out.push({
        b: [+box.min.x.toFixed(2), +box.min.y.toFixed(2), +box.min.z.toFixed(2),
            +box.max.x.toFixed(2), +box.max.y.toFixed(2), +box.max.z.toFixed(2)],
        c, geo: o.geometry.type,
      });
    });
    return out;
  };
  window.__quality = (i) => { if (i !== undefined) applyQuality(i); return { tier: qualityTier, name: QUALITY_TIERS[qualityTier].name, px: renderer.getPixelRatio(), shadows: renderer.shadowMap.enabled, composerEnabled, ssaoEnabled }; };
}
let myId = null;
let roomMode = 'dm';   // 'dm' | 'gungame' (gungame locks manual weapon switching)
let myColor = 0xffffff;
let inMatch = false;
let lastShot = 0;
let pointerLocked = false;
let everLocked = false;

// ---------------- sensitivity ----------------
let sensitivity = Math.min(3, Math.max(0.1, parseFloat(localStorage.getItem('labarena_sens')) || 1));
let adsSensMult = Math.min(2, Math.max(0.1, parseFloat(localStorage.getItem('labarena_ads_sens')) || 1));

function applyAdsSens(v) {
  adsSensMult = Math.min(2, Math.max(0.1, Math.round(v * 20) / 20));
  localStorage.setItem('labarena_ads_sens', String(adsSensMult));
  const txt = adsSensMult.toFixed(2);
  for (const [slider, label] of [['adsSensJoinSlider', 'adsSensJoinVal'], ['adsSensSlider', 'adsSensVal']]) {
    const s = document.getElementById(slider);
    const l = document.getElementById(label);
    if (s) s.value = adsSensMult;
    if (l) l.textContent = txt;
  }
}

function applySens(v, toast = false) {
  sensitivity = Math.min(3, Math.max(0.1, Math.round(v * 20) / 20));
  localStorage.setItem('labarena_sens', String(sensitivity));
  const txt = sensitivity.toFixed(2);
  for (const [slider, label] of [['sensJoinSlider', 'sensJoinVal'], ['sensSlider', 'sensVal']]) {
    const s = document.getElementById(slider);
    const l = document.getElementById(label);
    if (s) s.value = sensitivity;
    if (l) l.textContent = txt;
  }
  if (toast) showSensToast(`SENS ${txt}`);
}

let toastTimer = null;
function showSensToast(text) {
  const t = document.getElementById('sensToast');
  t.textContent = text;
  t.style.display = 'block';
  t.style.opacity = 1;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.style.opacity = 0, 1200);
}

// ---------------- 3D assets (loaded async; primitives remain as fallback) ----------------
const gltfLoader = new GLTFLoader();
const assets = { soldier: null, soldierClips: null, guns: {} };

// per-weapon viewmodel fit: target length in meters (MW2-style near-realsize)
const VIEW_FIT = { 1: { len: 0.92, z: 0 }, 2: { len: 0.98, z: 0 }, 3: { len: 1.2, z: 0 }, 4: { len: 0.34, z: 0 } };
const HAND_FIT = { 1: 1.05, 2: 0.8, 3: 1.1, 4: 0.35 };   // rifle raised: AK suppressor stretches the bbox
const ADS_EYE_DIST = -0.22;  // how far in front of the eye the sight's optical center sits when aiming
// MW2-style hip pose: gun big and close, stock anchored toward the bottom-right corner,
// slight inward yaw + roll so the muzzle points toward upper-center like the reference
const HIP_POS = { x: 0.24, y: -0.26, z: -0.46 };
const HIP_ROT = { x: 0.03, y: 0.10, z: 0.02 };
const HIP_POS_W = {
  1: { x: 0.22, y: -0.19, z: -0.42 },   // rifle VM: raised so the baked mag swap stays on screen
  2: { x: 0.20, y: -0.21, z: -0.46 },   // shotgun: raise so the receiver + pump stay on screen
  4: { x: 0.15, y: -0.17, z: -0.30 },   // deagle: big and close, center-right (low-poly VM reference)
};
function hipPos() { return HIP_POS_W[currentWeapon] || HIP_POS; }

// normalize a gun GLB: center it, scale to a target length (models natively point -Z, our forward)
// finds the 'AimPoint' empty (red dot / scope optical center) and stores its fitted-local
// position on wrapper.userData.aim so ADS can center the sight on the camera axis.
function fitGun(scene3d, targetLen, zOffset = 0) {
  const box = new THREE.Box3().setFromObject(scene3d);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const wrapper = new THREE.Group();
  scene3d.position.sub(center);
  const s = targetLen / Math.max(size.z, 0.001);
  wrapper.scale.setScalar(s);
  wrapper.position.z = zOffset;
  wrapper.add(scene3d);
  let aim = null;
  wrapper.traverse(o => {
    if (o.isMesh) { o.castShadow = true; o.userData.part = 'body'; }
    if (o.name === 'AimPoint') aim = o;
  });
  if (aim) {
    wrapper.userData.aim = aim.position.clone().sub(center).multiplyScalar(s).add(new THREE.Vector3(0, 0, zOffset));
    wrapper.userData.muzzleZ = -size.z * s / 2 + zOffset;   // front tip of the fitted model
  }
  return wrapper;
}

gltfLoader.load('./models/soldier.glb', (g) => {
  assets.soldier = g.scene;
  assets.soldierClips = g.animations;
  // upgrade any remotes that joined before the model finished loading
  for (const [id, r] of remotes) upgradeRemoteVisual(id, r);
}, undefined, (e) => console.warn('soldier model failed to load, using capsules', e));

const GUN_FILES = { 1: 'rifle', 2: 'shotgun', 3: 'sniper', 4: 'deagle' };
for (const [idx, name] of Object.entries(GUN_FILES)) {
  gltfLoader.load(`./models/${name}.glb`, (g) => {
    assets.guns[idx] = g.scene;
    applyGunModel(Number(idx));
    for (const r of remotes.values()) applyRemoteGunModel(r, Number(idx));
  }, undefined, () => console.warn(`${name} model failed, keeping primitive`));
}
// ---- animated low-poly viewmodels (wichowiczs: baked reload performances, CC-BY-NC) ----
// Each clip is a PURE RELOAD — no fire action exists; firing is procedural bolt blowback.
// trim = pixel-measured ADS correction so the dot sits on the fire axis (720p/55° -> 0.318mm/px)
const VM_CFG = {
  1: { file: 'rifle_vm',  SC: 1.5, reload: [0.02, 2.42], idle: 2.44, muzzleZ: -0.31, boltAmp: 0.03, trim: { x: 0, y: 0 }, rlLift: 0.10, rlX: -0.08 },
  4: { file: 'deagle_vm', SC: 1.5, reload: [0.54, 2.92], idle: 2.98, muzzleZ: -0.23, boltAmp: 0.05, trim: { x: 0.0033, y: 0.0140 } },
};
const vms = {};   // idx -> { mixer, segAct, idleAct, seg, w, slideBones, slideKick, slideDirs }
for (const [vmIdx, cfg] of Object.entries(VM_CFG)) {
  gltfLoader.load(`./models/${cfg.file}.glb`, (g) => {
    assets['vm' + vmIdx] = g;
    applyGunModel(Number(vmIdx));
  }, undefined, () => console.warn(`${cfg.file} failed, keeping static model`));
}
// ---- throwables: Sketchfab PBR models (M67 frag by Vextin, flashbang by MaX3Dd — CC-BY) ----
// normalized on load: centered at origin, scaled to real-world height, +Y up
assets.nades = {};
for (const [kind, file, targetH] of [['frag', 'grenade', 0.115], ['flash', 'flashbang', 0.15]]) {
  gltfLoader.load(`./models/${file}.glb`, (g) => {
    const s = g.scene;
    const box = new THREE.Box3().setFromObject(s);
    const size = box.getSize(new THREE.Vector3());
    const scale = targetH / Math.max(size.x, size.y, size.z);
    const center = box.getCenter(new THREE.Vector3());
    const wrap = new THREE.Group();
    s.position.copy(center).multiplyScalar(-scale);
    s.scale.setScalar(scale);
    wrap.add(s);
    wrap.traverse(o => { if (o.isMesh) { o.raycast = () => {}; o.castShadow = false; } });
    assets.nades[kind] = wrap;
  }, undefined, () => console.warn(`${file} model failed, using sphere fallback`));
}
function buildAnimVM(idx, container) {
  const cfg = VM_CFG[idx], gltf = assets['vm' + idx];
  const wasVisible = container.visible;
  container.clear();
  const wrapper = new THREE.Group();
  wrapper.add(gltf.scene);
  wrapper.traverse(o => {
    if (o.isMesh || o.isSkinnedMesh) { o.frustumCulled = false; o.castShadow = false; o.userData.part = 'body'; }
  });
  container.add(wrapper);
  const SC = cfg.SC;                    // screen presence: big low-poly viewmodel
  wrapper.scale.setScalar(SC);
  const mixer = new THREE.AnimationMixer(gltf.scene);
  const clip = gltf.animations[0];
  const idleClip = clip.clone(); idleClip.name = 'PewPewIdle';
  const segAct = mixer.clipAction(clip);
  const idleAct = mixer.clipAction(idleClip);
  for (const act of [segAct, idleAct]) { act.play(); act.paused = true; }
  idleAct.time = cfg.idle; segAct.time = cfg.idle;
  segAct.setEffectiveWeight(0); idleAct.setEffectiveWeight(1);
  mixer.update(0);
  const slideBones = [];
  gltf.scene.traverse(o => { if (o.isBone && /bolt/i.test(o.name)) slideBones.push(o); });
  vms[idx] = { mixer, segAct, idleAct, seg: null, w: 0, slideBones, slideKick: null, slideDirs: null, boltAmp: cfg.boltAmp };
  let aim = null;
  wrapper.traverse(o => { if (o.name === 'AimPoint') aim = o; });
  if (aim) {
    const a = aim.position.clone().multiplyScalar(SC);
    wrapper.userData.aim = a;
    WEAPONS[idx].adsPos = { x: -a.x + cfg.trim.x, y: -a.y + cfg.trim.y, z: ADS_EYE_DIST - a.z };
  }
  MUZZLE_Z[idx] = cfg.muzzleZ * SC;
  container.visible = wasVisible;
}
const remotes = new Map(); // id -> { group, body, nameSprite, targetPos, targetRy, hp, name, dead }

// ---- weapon hold pose ----
// Mixamo Idle/Run clips don't hold a weapon, so guns are parented to the RightHand bone
// and the arm chain is overridden each frame with a two-handed carry pose.
// Quaternions captured via rigtest.html pose tuning (local bone space).
const HOLD_QUATS = {
  // The trooper's own mocap Rifle-Idle carry pose (frame 0), pinned so every clip
  // (run/sprint/slide/jump) keeps both hands on the gun. Old model's tuned pose does
  // not transfer — the Blender re-bind gave the arm bones different local frames.
  RightShoulder: [0.6291, -0.4564, 0.4813, 0.4053],
  RightArm:      [0.2976, -0.1887, -0.2528, 0.9010],
  RightForeArm:  [0, 0, -0.7537, 0.6572],
  RightHand:     [0.2319, 0.3191, 0.1079, 0.9126],
  LeftShoulder:  [0.6497, 0.4283, -0.5196, 0.3527],
  LeftArm:       [0.2726, 0.0892, 0.1757, 0.9417],
  LeftForeArm:   [0, 0, 0.6227, 0.7824],
  LeftHand:      [-0.0691, -0.8753, -0.0643, 0.4742],
};
// gun anchor inside the palm: meters (bone-scale is compensated at attach time)
// aligned so the gun lies along the right-hand -> left-hand line of the carry pose
const GUN_GRIP = { pos: [0.0245, 0.1919, 0.0133], rot: [1.64, -0.1269, -1.4283] };

function makeNameSprite(name, colorHex) {
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 64;
  const ctx = cv.getContext('2d');
  ctx.font = 'bold 34px Menlo, monospace';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#000000aa';
  ctx.fillRect(0, 8, 256, 48);
  ctx.fillStyle = '#' + colorHex.toString(16).padStart(6, '0');
  ctx.fillText(name, 128, 44);
  const tex = new THREE.CanvasTexture(cv);
  // depthTest ON: walls occlude the tag — no more free wallhack on enemy positions
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: true, depthWrite: false }));
  sprite.scale.set(2.6, 0.65, 1);
  return sprite;
}

// swap a remote's capsule visuals for the animated soldier (hitboxes stay, invisible)
function upgradeRemoteVisual(id, r) {
  if (!assets.soldier || r.soldier) return;
  const clone = SkeletonUtils.clone(assets.soldier);
  clone.traverse(o => {
    if (o.isMesh || o.isSkinnedMesh) {
      o.castShadow = true;
      o.material = o.material.clone();
      // subtle team hue only (12%): a strong tint would crush the trooper's PBR textures.
      // Name tag carries team identity.
      // MULTIPLY the subtle team hue into the material's own base color — replacing it
      // wipes untextured (baseColorFactor-only) models like the low-poly character to solid white.
      o.material.color.multiply(new THREE.Color(r.color).lerp(new THREE.Color(0xffffff), 0.88));
      // team-colored fresnel rim: silhouette edges glow in the player's color, so enemies
      // read instantly against flat low-poly backgrounds at any distance (the MW2019 trick).
      {
        const rimC = new THREE.Color(r.color);
        o.material.onBeforeCompile = (shader) => {
          shader.uniforms.rimColor = { value: rimC };
          shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', '#include <common>\nuniform vec3 rimColor;')
            .replace('#include <emissivemap_fragment>',
              '#include <emissivemap_fragment>\n' +
              'float rimF = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 3.0);\n' +
              'totalEmissiveRadiance += rimColor * rimF * 0.45;');
        };
      }
      o.material.needsUpdate = true;
      o.raycast = () => {};   // visuals are not hitboxes — the capsule/head handle damage
    }
  });
  r.group.add(clone);
  r.soldier = clone;
  r.mixer = new THREE.AnimationMixer(clone);
  // full locomotion set from the trooper GLB; one-shot clips clamp at their final pose
  r.actions = {};
  for (const cn of ['Idle', 'Run', 'Sprint', 'Jump', 'Fall', 'WallJump', 'Slide']) {
    const clip = THREE.AnimationClip.findByName(assets.soldierClips, cn);
    if (!clip) continue;
    const a = r.mixer.clipAction(clip);
    if (cn === 'Jump' || cn === 'WallJump' || cn === 'Slide') { a.setLoop(THREE.LoopOnce); a.clampWhenFinished = true; }
    r.actions[cn.toLowerCase()] = a;
  }
  r.actions.idle?.play();
  r.animState = 'idle';
  r.lastPos = r.group.position.clone();
  // hide the primitive body — it remains the raycast hitbox
  for (const part of r.hitboxParts) part.visible = false;

  // ---- gun-to-hand attachment ----
  // find the arm bones (GLTFLoader strips the "mixamorig:" prefix punctuation)
  const bones = {};
  clone.traverse(o => { if (o.isBone) bones[o.name.replace(/^mixamorig:?/, '')] = o; });
  const hand = bones.RightHand;
  if (hand) {
    clone.updateMatrixWorld(true);
    const ws = new THREE.Vector3();
    hand.getWorldScale(ws);
    const inv = 1 / (ws.x || 1);           // mixamo bones are 0.01 world scale
    const anchor = new THREE.Group();
    anchor.position.set(GUN_GRIP.pos[0] * inv, GUN_GRIP.pos[1] * inv, GUN_GRIP.pos[2] * inv);
    anchor.rotation.set(...GUN_GRIP.rot);
    anchor.scale.setScalar(inv);
    hand.add(anchor);
    // move gun containers from the chest offset into the palm
    for (const k in r.gunModels) {
      const gm = r.gunModels[k];
      gm.position.set(0, 0, 0);
      gm.rotation.set(0, 0, 0);
      anchor.add(gm);
    }
    // arm bones driven by the hold pose every frame (after mixer update)
    r.poseBones = [];
    for (const [name, q] of Object.entries(HOLD_QUATS)) {
      if (bones[name]) r.poseBones.push({ bone: bones[name], quat: q });
    }
    r.spineBone = bones.Spine1 || bones.Spine2 || bones.Spine || null;   // aim-pitch matching
    r.headBone = bones.Head || bones.Neck || null;                       // headshot flinch snap
    r.armBones = [bones.RightArm, bones.LeftArm].filter(Boolean);        // ADS raise
  }
}

function applyRemoteGunModel(r, idx) {
  if (!assets.guns[idx] || !r.gunModels[idx]) return;
  const container = r.gunModels[idx];
  const wasVisible = container.visible;
  container.clear();
  const wrap = fitGun(assets.guns[idx].clone(true), HAND_FIT[idx] || 0.8);
  container.add(wrap);
  container.userData.magNodes = [];
  wrap.traverse(o => {
    if (/^mag\d*$/.test(o.name)) container.userData.magNodes.push({ node: o, pos: o.position.clone(), quat: o.quaternion.clone() });
  });
  container.visible = wasVisible;
}

function applyGunModel(idx) {
  if (VM_CFG[idx] && assets['vm' + idx]) { buildAnimVM(idx, weaponModels[idx]); return; }
  if (!assets.guns[idx] || !weaponModels[idx]) return;
  const container = weaponModels[idx];
  const wasVisible = container.visible;
  container.clear();
  const fit = VIEW_FIT[idx] || { len: 0.55, z: 0 };
  const wrapper = fitGun(assets.guns[idx].clone(true), fit.len, fit.z);
  container.add(wrapper);
  attachViewmodelArms(wrapper, idx);
  // reload animation rig: removable mag nodes (mag, mag0..3 — not the shotgun's fixed magtube)
  // with rest transforms, so the reload tick can move them and snap them back
  wrapper.userData.magNodes = [];
  wrapper.traverse(o => {
    if (/^mag\d*$/.test(o.name)) wrapper.userData.magNodes.push({ node: o, pos: o.position.clone(), quat: o.quaternion.clone() });
  });
  if (wrapper.userData.gripL) {
    const gl = wrapper.userData.gripL;
    wrapper.userData.gripLRest = gl.position.clone();
  }
  if (idx === 2) {   // shotgun: shell prop for the one-by-one insert, lives in model-local space
    const shell = new THREE.Group();
    const hull = new THREE.Mesh(new THREE.CylinderGeometry(0.0105, 0.0105, 0.05, 10),
      new THREE.MeshStandardMaterial({ color: 0xc22222, roughness: 0.6 }));
    hull.rotation.x = Math.PI / 2;
    shell.add(hull);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.0112, 0.0112, 0.012, 10),
      new THREE.MeshStandardMaterial({ color: 0xd4af37, roughness: 0.35, metalness: 0.6 }));
    base.rotation.x = Math.PI / 2;
    base.position.z = 0.028;
    shell.add(base);
    shell.traverse(o => { if (o.isMesh) o.raycast = () => {}; });
    shell.visible = false;
    shell.position.set(0.005, 0.045, -0.015);  // pinched at the fingertips, nose toward the port
    shell.rotation.x = -0.35;
    if (wrapper.userData.gripL) wrapper.userData.gripL.add(shell);  // the hand carries the shell
    wrapper.userData.shell = shell;
  }
  container.visible = wasVisible;
  const w = WEAPONS[idx];
  if (wrapper.userData.muzzleZ !== undefined) MUZZLE_Z[idx] = wrapper.userData.muzzleZ - 0.03;
  // align ADS to the sight: gunGroup pose that puts the AimPoint on the camera axis,
  // ADS_EYE_DIST in front of the eye (red dot ends up exactly under the crosshair).
  // The offset is read from the real scene graph (walks every node matrix from the
  // container down to the AimPoint) — robust to whatever parenting the GLB export used.
  if (w.ads && !w.scope) {
    let aimNode = null;
    wrapper.traverse(o => { if (o.name === 'AimPoint') aimNode = o; });
    if (aimNode) {
      const chain = [];
      for (let n = aimNode; n && n !== gunGroup; n = n.parent) chain.unshift(n);   // container included (deagle scales its group)
      const m = new THREE.Matrix4();
      for (const c of chain) { c.updateMatrix(); m.multiply(c.matrix); }
      const a = new THREE.Vector3().setFromMatrixPosition(m);
      wrapper.userData.aim = a.clone();
      w.adsPos = { x: -a.x, y: -a.y, z: ADS_EYE_DIST - a.z };
    }
  }
}

// ---- first-person arms (MW2-style: gloved hands on the grips, forearms toward the body) ----
const ARM_MATS = {
  // trooper armor palette — matches the futuristic soldier model
  glove: new THREE.MeshStandardMaterial({ color: 0x41454c, roughness: 0.55, metalness: 0.25 }),   // gunmetal armored gloves
  gloveHi: new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.4, metalness: 0.35 }),  // light armor plate knuckles
  sleeve: new THREE.MeshStandardMaterial({ color: 0x2b2e34, roughness: 0.7, metalness: 0.15 }),   // dark undersuit
  plate: new THREE.MeshStandardMaterial({ color: 0x51565e, roughness: 0.5, metalness: 0.3 }),    // forearm armor shell
  accent: new THREE.MeshStandardMaterial({ color: 0xd96a1e, roughness: 0.5, emissive: 0x341403 }), // orange trim
};
// per-weapon arm layout in gun-local space (gun forward = -Z, camera side = +Z)
// dir = forearm direction from wrist toward the elbow/body; roll/pitch = hand orientation on the grip
// MAGWELL_HAND: where the support hand reaches to grab the mag during reload,
// relative to its handguard rest (gun-local meters). AK mag well sits ~0.19m behind GripL.
const MAGWELL_HAND = {
  1: { x: 0.03, y: -0.12, z: 0.19 },   // rifle: off the handguard, back to the mag well
  3: { x: 0.03, y: -0.12, z: 0.17 },   // sniper: similar reach
  4: { x: 0.0,  y: -0.09, z: 0.06 },   // pistol: heel of the grip
};
const ARM_DIRS = {
  1: { r: { dir: [0.45, -0.7, 0.8] },  l: { dir: [-0.55, -0.85, 0.65], pitch: 1.45 } },  // rifle: support hand under the handguard
  2: { r: { dir: [0.45, -0.7, 0.8] },  l: { dir: [-0.55, -0.85, 0.65], pitch: 1.45 } },  // shotgun: hand on the pump
  3: { r: { dir: [0.45, -0.7, 0.8] },  l: { dir: [-0.55, -0.85, 0.65], pitch: 1.45 } },  // sniper: fore stock
  4: { r: { dir: [0.35, -0.8, 0.75] }, l: { dir: [-0.5, -0.9, 0.6],   roll: 0.5 } },     // deagle: support hand rolled in
};
// a gloved hand wrapped around a vertical grip: palm slab on the near side,
// four finger segments curling around the front, thumb hooking the far side
function makeViewHand(side) {   // side: +1 = right hand (palm on +X), -1 = left
  const g = new THREE.Group();
  const s = side;
  // palm: vertical slab hugging the grip side
  const palm = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.092, 0.062), ARM_MATS.glove);
  palm.position.set(s * 0.034, -0.01, 0.008);
  g.add(palm);
  // knuckle pad on the back of the hand
  const knuckle = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.05, 0.05), ARM_MATS.gloveHi);
  knuckle.position.set(s * 0.042, 0.02, 0.006);
  g.add(knuckle);
  // four fingers: stacked segments curling around the front of the grip (-Z side)
  for (let i = 0; i < 4; i++) {
    const y = 0.028 - i * 0.023;
    const f1 = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.019, 0.022), ARM_MATS.glove);
    f1.position.set(s * 0.012, y, -0.026);
    f1.rotation.y = -s * 0.35;
    g.add(f1);
    const f2 = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.018, 0.034), ARM_MATS.glove);
    f2.position.set(-s * 0.024, y, -0.02);
    f2.rotation.y = -s * 0.9;
    g.add(f2);
  }
  // thumb: wraps the near-top, pointing forward
  const thumb = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, 0.05), ARM_MATS.glove);
  thumb.position.set(s * 0.028, 0.032, -0.018);
  thumb.rotation.y = s * 0.4;
  g.add(thumb);
  return g;
}
function makeViewArm(side, layout, foreLen) {
  const g = new THREE.Group();
  const hand = makeViewHand(side);
  if (layout.roll) hand.rotation.z = layout.roll * -side;
  // pitch: rotate the hand so the fingers wrap a horizontal handguard from below
  if (layout.pitch) hand.rotation.x = layout.pitch;
  g.add(hand);
  // forearm: tapered cylinder from the wrist toward the body, undersuit-colored
  const dir = new THREE.Vector3(...layout.dir).normalize();
  const fore = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.055, foreLen, 10), ARM_MATS.sleeve);
  fore.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().negate());
  fore.position.copy(dir).multiplyScalar(foreLen / 2 + 0.03);
  g.add(fore);
  // armor shell riding the outside of the forearm (trooper-style plate)
  const plate = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.055, foreLen * 0.42, 10, 1, false, -Math.PI * 0.55, Math.PI * 1.1), ARM_MATS.plate);
  plate.quaternion.copy(fore.quaternion);
  plate.position.copy(dir).multiplyScalar(foreLen * 0.66 + 0.03);
  g.add(plate);
  // orange accent ring at the plate's wrist edge
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.043, 0.007, 6, 14), ARM_MATS.accent);
  ring.quaternion.copy(fore.quaternion);
  ring.rotateX(Math.PI / 2);
  ring.position.copy(dir).multiplyScalar(foreLen * 0.28 + 0.03);
  g.add(ring);
  // wrist: armored cuff bridging hand and sleeve
  const wrist = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.034, 0.07, 10), ARM_MATS.glove);
  wrist.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().negate());
  wrist.position.copy(dir).multiplyScalar(0.055);
  g.add(wrist);
  g.traverse(o => { if (o.isMesh) { o.castShadow = false; o.raycast = () => {}; } });
  return g;
}
function attachViewmodelArms(wrapper, idx) {
  const dirs = ARM_DIRS[idx] || ARM_DIRS[1];
  const inv = 1 / (wrapper.scale.x || 1);   // arms are authored in meters
  const grips = { r: null, l: null };
  wrapper.traverse(o => {
    if (o.name === 'GripR') grips.r = o;
    if (o.name === 'GripL') grips.l = o;
  });
  if (grips.r) { const a = makeViewArm(+1, dirs.r, 0.42); a.scale.setScalar(inv); grips.r.add(a); }
  if (grips.l) { const a = makeViewArm(-1, dirs.l, 0.48); a.scale.setScalar(inv); grips.l.add(a); }
  wrapper.userData.gripL = grips.l;
  wrapper.userData.gripR = grips.r;
}

function addRemote(info) {
  const group = new THREE.Group();

  const bodyMat = new THREE.MeshStandardMaterial({ color: info.color, roughness: 0.5, metalness: 0.3 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(PLAYER_RADIUS, 0.9, 6, 12), bodyMat);
  body.position.y = 0.9;
  body.castShadow = true;
  body.userData.part = 'body';
  group.add(body);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.28, 12, 12),
    new THREE.MeshStandardMaterial({ color: 0xffddbb, roughness: 0.6 }));
  head.position.y = 1.75;
  head.userData.part = 'head';
  group.add(head);

  // visor to show facing direction
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.12, 0.1),
    new THREE.MeshStandardMaterial({ color: 0x22ddff, emissive: 0x1188aa }));
  visor.position.set(0, 1.78, -0.24);
  visor.userData.part = 'head';
  group.add(visor);

  // held weapon: one mini model per weapon type, visibility follows their actual loadout
  // positioned at the soldier's hands (right side, chest height, slightly forward)
  const gunModels = { 1: makeRifle(), 2: makeShotgun(), 3: makeSniper(), 4: makeDeagle() };
  for (const k in gunModels) {
    gunModels[k].position.set(0.22, 1.12, -0.28);
    gunModels[k].rotation.y = -0.08;
    gunModels[k].scale.setScalar(1.0);
    gunModels[k].visible = Number(k) === (info.w || 1);
    gunModels[k].traverse(o => { o.raycast = () => {}; });   // guns are not hitboxes
    group.add(gunModels[k]);
  }

  const nameSprite = makeNameSprite(info.name, info.color);
  nameSprite.position.y = 2.35;
  nameSprite.raycast = () => {};   // name tags are not a hitbox
  group.add(nameSprite);

  group.position.fromArray(info.pos);
  scene.add(group);

  remotes.set(info.id, {
    group, body, gunModels, weapon: info.w || 1,
    hitboxParts: [body, head, visor],
    targetPos: new THREE.Vector3().fromArray(info.pos),
    targetRy: info.ry || 0,
    hp: info.hp, name: info.name, dead: info.dead || false, color: info.color,
  });
  const rr = remotes.get(info.id);
  upgradeRemoteVisual(info.id, rr);                       // if soldier already loaded
  for (const idx in assets.guns) applyRemoteGunModel(rr, Number(idx));
  if (info.dead) group.visible = false;
}

function setRemoteWeapon(r, w) {
  if (!WEAPONS[w] || r.weapon === w) return;
  r.weapon = w;
  for (const k in r.gunModels) r.gunModels[k].visible = Number(k) === w;
}

// death crumple: the soldier pitches over at the feet, slumps, and fades from view
function playDeathAnim(r) {
  if (r.dying) return;
  r.dying = true;
  const g = r.group;
  const startRx = g.rotation.x, startY = g.position.y;
  // three death reads: forward crumple, backward sprawl, side spin-drop — plus their
  // momentum carries the body (dying mid-sprint slides you forward; deaths stop looking identical)
  const styleRoll = Math.random();
  const dir = styleRoll < 0.45 ? 1 : (styleRoll < 0.8 ? -1 : 0);
  const spin = dir === 0 ? (Math.random() < 0.5 ? 1 : -1) : 0;
  const fall = (dir !== 0 ? dir : (Math.random() < 0.5 ? 0.3 : -0.3)) * (Math.PI / 2) * (0.88 + Math.random() * 0.1);
  const twist = spin ? spin * (Math.PI / 2) * 0.95 : (Math.random() - 0.5) * 0.5;
  const spinY = spin * Math.PI * (0.7 + Math.random() * 0.4);
  // momentum: recent travel per second, capped — body keeps sliding as it drops
  const mv = new THREE.Vector3().subVectors(g.position, r.lastPos).multiplyScalar(8);
  if (mv.length() > 5) mv.setLength(5);
  mv.y = 0;
  const startRyD = g.rotation.y;
  addEffect(new THREE.Object3D(), 1.0, (dt, e) => {
    const t = 1 - e.ttl / e.ttl0;
    const ease = t < 0.6 ? (t / 0.6) * (t / 0.6) : 1;           // accelerates into the ground, then rests
    g.rotation.x = startRx + fall * ease;
    g.rotation.z = twist * ease;
    if (spin) g.rotation.y = startRyD + spinY * ease;
    g.position.y = startY - 0.18 * ease;
    g.position.x += mv.x * dt * (1 - ease * 0.8);               // momentum bleeds off as they hit dirt
    g.position.z += mv.z * dt * (1 - ease * 0.8);
    if (e.ttl <= 0) {
      // stain where they fell, fading out slowly
      const sm = new THREE.MeshBasicMaterial({ color: 0x4a0e0e, transparent: true, opacity: 0.42, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 });
      const stain = new THREE.Mesh(FX.stainGeo || (FX.stainGeo = new THREE.CircleGeometry(0.55, 12)), sm);
      stain.rotation.x = -Math.PI / 2;
      stain.rotation.z = Math.random() * Math.PI;
      stain.position.set(g.position.x + dir * 0.5 * Math.sin(g.rotation.y), 0.02, g.position.z + dir * 0.5 * Math.cos(g.rotation.y));
      addEffect(stain, 8, (dt2, e2) => { if (e2.ttl < 3) sm.opacity = 0.42 * (e2.ttl / 3); if (e2.ttl <= 0) sm.dispose(); });
      g.visible = false;
      g.rotation.x = startRx; g.rotation.z = 0; g.position.y = startY;
      r.dying = false;
    }
  });
}

function removeRemote(id) {
  const r = remotes.get(id);
  if (r) { scene.remove(r.group); remotes.delete(id); }
}

// ---------------- weapon viewmodel ----------------
// shared effect resources (defined early — used by viewmodel muzzle flash and tracers)
const FX = {
  boltGeo: new THREE.CylinderGeometry(1, 1, 1, 6, 1, true),
  sparkGeo: new THREE.BoxGeometry(0.06, 0.06, 0.06),
  flashTex: (() => {
    const cv = document.createElement('canvas'); cv.width = cv.height = 64;
    const c = cv.getContext('2d');
    const g = c.createRadialGradient(32, 32, 2, 32, 32, 30);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.3, 'rgba(255,225,170,0.85)');
    g.addColorStop(1, 'rgba(255,180,80,0)');
    c.fillStyle = g; c.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(cv);
  })(),
};

const gunGroup = new THREE.Group();
gunGroup.position.set(0.25, -0.30, -0.46);   // MW2-style hip pose (kept in sync with HIP_POS)
camera.add(gunGroup);
scene.add(camera);

const GUNMETAL = 0x2c2c36, DARK = 0x1a1a22, WOOD = 0x6b4a2f, GOLD = 0xc9a227;
function gpart(group, geo, color, x, y, z, opts = {}) {
  const mat = new THREE.MeshStandardMaterial({ color, metalness: opts.metal ?? 0.6, roughness: opts.rough ?? 0.35, emissive: opts.emissive ?? 0x000000 });
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  if (opts.rx) m.rotation.x = opts.rx;
  if (opts.rz) m.rotation.z = opts.rz;
  group.add(m);
  return m;
}

function makeRifle() {
  const g = new THREE.Group();
  gpart(g, new THREE.BoxGeometry(0.07, 0.09, 0.42), GUNMETAL, 0, 0, -0.05);          // receiver
  gpart(g, new THREE.CylinderGeometry(0.018, 0.018, 0.34, 8), DARK, 0, 0.005, -0.42, { rx: Math.PI / 2 }); // barrel
  gpart(g, new THREE.BoxGeometry(0.05, 0.15, 0.07), DARK, 0, -0.1, -0.06, { rx: 0.15 }); // magazine
  gpart(g, new THREE.BoxGeometry(0.06, 0.08, 0.16), GUNMETAL, 0, -0.015, 0.22);      // stock
  gpart(g, new THREE.BoxGeometry(0.012, 0.03, 0.012), DARK, 0, 0.06, -0.5);          // front sight
  gpart(g, new THREE.BoxGeometry(0.05, 0.05, 0.1), DARK, 0, 0.07, 0.02);             // rear sight block
  return g;
}

function makeShotgun() {
  const g = new THREE.Group();
  gpart(g, new THREE.CylinderGeometry(0.03, 0.03, 0.5, 10), GUNMETAL, 0, 0.02, -0.3, { rx: Math.PI / 2 }); // fat barrel
  gpart(g, new THREE.CylinderGeometry(0.022, 0.022, 0.42, 8), DARK, 0, -0.035, -0.26, { rx: Math.PI / 2 }); // tube mag
  gpart(g, new THREE.BoxGeometry(0.075, 0.075, 0.16), WOOD, 0, -0.035, -0.28, { metal: 0.1, rough: 0.7 }); // pump
  gpart(g, new THREE.BoxGeometry(0.08, 0.11, 0.2), GUNMETAL, 0, 0, 0.02);            // receiver
  gpart(g, new THREE.BoxGeometry(0.07, 0.1, 0.2), WOOD, 0, -0.02, 0.22, { metal: 0.1, rough: 0.7, rx: -0.1 }); // stock
  return g;
}

function makeSniper() {
  const g = new THREE.Group();
  gpart(g, new THREE.CylinderGeometry(0.016, 0.016, 0.7, 8), DARK, 0, 0.01, -0.5, { rx: Math.PI / 2 });  // long barrel
  gpart(g, new THREE.BoxGeometry(0.035, 0.045, 0.06), GUNMETAL, 0, 0.01, -0.83);     // muzzle brake
  gpart(g, new THREE.BoxGeometry(0.07, 0.09, 0.36), GUNMETAL, 0, 0, -0.02);          // receiver
  gpart(g, new THREE.CylinderGeometry(0.032, 0.032, 0.24, 12), DARK, 0, 0.095, -0.1, { rx: Math.PI / 2 }); // scope tube
  gpart(g, new THREE.CylinderGeometry(0.026, 0.026, 0.02, 12), 0x88ccff, 0, 0.095, -0.225, { rx: Math.PI / 2, emissive: 0x224466 }); // lens
  gpart(g, new THREE.BoxGeometry(0.02, 0.04, 0.03), GUNMETAL, 0, 0.06, -0.16);       // scope mounts
  gpart(g, new THREE.BoxGeometry(0.02, 0.04, 0.03), GUNMETAL, 0, 0.06, -0.02);
  gpart(g, new THREE.BoxGeometry(0.06, 0.1, 0.22), GUNMETAL, 0, -0.01, 0.24);        // stock
  gpart(g, new THREE.BoxGeometry(0.05, 0.14, 0.06), DARK, 0, -0.1, 0.02, { rx: 0.1 }); // magazine
  return g;
}

function makeDeagle() {
  const g = new THREE.Group();
  gpart(g, new THREE.BoxGeometry(0.045, 0.06, 0.2), GOLD, 0, 0.02, -0.08, { metal: 0.85, rough: 0.25 }); // slide
  gpart(g, new THREE.BoxGeometry(0.048, 0.018, 0.2), DARK, 0, -0.015, -0.08);   // frame rail
  gpart(g, new THREE.CylinderGeometry(0.011, 0.011, 0.05, 8), DARK, 0, 0.025, -0.2, { rx: Math.PI / 2 }); // muzzle
  gpart(g, new THREE.BoxGeometry(0.04, 0.1, 0.055), 0x2a2020, 0, -0.07, 0.0, { rx: 0.22, rough: 0.6 }); // grip
  gpart(g, new THREE.BoxGeometry(0.01, 0.02, 0.01), DARK, 0, 0.055, 0.02);      // rear sight
  gpart(g, new THREE.BoxGeometry(0.008, 0.018, 0.008), DARK, 0, 0.052, -0.17);  // front sight
  g.scale.setScalar(0.85);
  return g;
}

const weaponModels = { 1: makeRifle(), 2: makeShotgun(), 3: makeSniper(), 4: makeDeagle() };
for (const n in weaponModels) {
  gunGroup.add(weaponModels[n]);
  weaponModels[n].visible = Number(n) === currentWeapon;
}

// muzzle flash light + sprite — small, snappy, positioned at each weapon's actual muzzle
const MUZZLE_Z = { 1: -0.62, 2: -0.58, 3: -0.88, 4: -0.24 };
const muzzleLight = new THREE.PointLight(0xffcc66, 0, 3);
muzzleLight.position.set(0, 0, -0.6);
gunGroup.add(muzzleLight);
const muzzleFlash = new THREE.Sprite(new THREE.SpriteMaterial({
  map: FX.flashTex, color: 0xffd9a0, transparent: true, opacity: 0,
  blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
}));
muzzleFlash.position.set(0.0, 0.01, MUZZLE_Z[1]);
muzzleFlash.scale.setScalar(0.18);
gunGroup.add(muzzleFlash);

// viewmodel animation state
let gunRotKick = 0;      // recoil rotation impulse (recovers)
const sightPinQ = new THREE.Quaternion(), sightPinV = new THREE.Vector3();   // parallax-free sight scratch
// camera recoil: accumulated offsets that recover toward 0 (spray control)
let recoilPitch = 0, recoilYaw = 0;
let sprayIdx = 0;        // consecutive-shot index into the weapon's recoil pattern
const SPRAY_RESET_MS = 350; // gap that resets the spray back to first-shot recoil
let actionAnim = null;   // { start, end } — bolt/pump viewmodel cycle window
let playerMoving = false;

// ---- procedural viewmodel motion (MW-style) ----
// sway: spring-damped lag behind mouse flicks; strafe: velocity tilt; landDip: touchdown impulse
const vmSway = { yaw: 0, pitch: 0, roll: 0 };
const tuckRay = new THREE.Raycaster();      // wall-tuck forward probe
const tuckDir = new THREE.Vector3();
let swayImpYaw = 0, swayImpPitch = 0;    // decaying mouse impulses
let landDip = 0, wasGrounded = true, fallVel = 0;
let sprinting = false, sprintEndAt = -1e9;
let sprintPose = 0;                       // eased 0..1 blend into the sprint carry
let drawAnim = null;                      // { start, end } — weapon raise on switch
let inspectAnim = null;                   // { start, end } — F key weapon inspect twirl
let killPunch = 0;                        // FOV punch on kill confirm

// ---------------- tracers & effects ----------------
const effects = []; // { obj, ttl, ttl0, update? }
const YAXIS = new THREE.Vector3(0, 1, 0);

function addEffect(obj, ttl, update) {
  obj.raycast = () => {};
  scene.add(obj);
  effects.push({ obj, ttl, ttl0: ttl, update });
}

// weapon shot visual — hitscan tracers (OW/COD style):
// an instant thin line from muzzle to impact that fades in ~90ms,
// plus a white-hot streak racing down it. No traveling glow-ball.
function spawnShot(origin, dir, wIdx, dist = 120) {
  const t = (WEAPONS[wIdx] || WEAPONS[1]).tracer;
  if (t.style === 'beam') {
    // railgun beam: outer colored glow + bright white core, fading and thinning
    // start 1.5 further out so the near end doesn't flare across the camera
    const start = origin.clone().addScaledVector(dir, 1.5);
    const len = Math.max(1, dist - 1.5);
    for (const [radius, color, op] of [[t.radius, t.color, 0.55], [t.radius * 0.32, 0xffffff, 0.95]]) {
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: op, blending: THREE.AdditiveBlending, depthWrite: false });
      const m = new THREE.Mesh(FX.boltGeo, mat);
      m.scale.set(radius, len, radius);
      m.quaternion.setFromUnitVectors(YAXIS, dir);
      m.position.copy(start).addScaledVector(dir, len / 2);
      addEffect(m, 0.38, (dt, e) => {
        mat.opacity = op * (e.ttl / e.ttl0);
        m.scale.x = m.scale.z = radius * (0.35 + 0.65 * e.ttl / e.ttl0);
      });
    }
    return;
  }
  const start = origin.clone().addScaledVector(dir, 0.4);
  const len = Math.max(0.5, dist - 0.4);
  const q = new THREE.Quaternion().setFromUnitVectors(YAXIS, dir);

  // instant full-length tracer line — thin, weapon-colored, gone in a blink
  const mat = new THREE.MeshBasicMaterial({ color: t.color, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending });
  const line = new THREE.Mesh(FX.boltGeo, mat);
  line.scale.set(0.038, len, 0.038);
  line.quaternion.copy(q);
  line.position.copy(start).addScaledVector(dir, len / 2);
  addEffect(line, 0.09, (dt, e) => {
    const k = e.ttl / e.ttl0;
    mat.opacity = 0.9 * k;
    line.scale.x = line.scale.z = 0.038 * (0.4 + 0.6 * k);
  });

  // white-hot streak racing down the line — reads as the bullet without being a slow projectile
  const sLen = Math.min(7, len * 0.6);
  const smat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending });
  const streak = new THREE.Mesh(FX.boltGeo, smat);
  streak.scale.set(0.045, sLen, 0.045);
  streak.quaternion.copy(q);
  let head = sLen;
  streak.position.copy(start).addScaledVector(dir, head - sLen / 2);
  addEffect(streak, 0.45, (dt, e) => {
    head += 550 * dt; // ~4x faster than the old bolts — hitscan feel
    if (head >= len) { e.ttl = 0; return; }
    const l = Math.min(sLen, len - head);
    streak.scale.y = l;
    streak.position.copy(start).addScaledVector(dir, head - l / 2);
  });
}

// damage numbers: floating text popping off the enemy at the hit point
function spawnDamageNumber(point, dmg, head = false) {
  const cv = document.createElement('canvas');
  cv.width = 128; cv.height = 64;
  const ctx = cv.getContext('2d');
  ctx.font = `bold ${head ? 44 : 36}px Menlo, monospace`;
  ctx.textAlign = 'center';
  ctx.lineWidth = 6;
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.strokeText(dmg, 64, 44);
  ctx.fillStyle = head ? '#ffd700' : '#ffffff';
  ctx.fillText(dmg, 64, 44);
  const tex = new THREE.CanvasTexture(cv);
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 1, depthTest: false, depthWrite: false });
  const sp = new THREE.Sprite(mat);
  const s0 = head ? 0.85 : 0.65;
  sp.scale.set(s0 * 2, s0, 1);
  sp.position.copy(point).add(new THREE.Vector3((Math.random() - 0.5) * 0.5, 0.25, (Math.random() - 0.5) * 0.5));
  const drift = (Math.random() - 0.5) * 0.8;
  addEffect(sp, 0.7, (dt, e) => {
    const t = 1 - e.ttl / e.ttl0;           // 0 -> 1 over lifetime
    sp.position.y += dt * (1.6 - t * 1.1);  // rises fast, decelerates
    sp.position.x += drift * dt * 0.3;
    const pop = t < 0.12 ? 1 + (0.12 - t) * 3 : 1; // brief pop-in
    sp.scale.set(s0 * 2 * pop, s0 * pop, 1);
    mat.opacity = t > 0.55 ? 1 - (t - 0.55) / 0.45 : 1;
    if (e.ttl <= 0) { tex.dispose(); mat.dispose(); }
  });
}

// ---- impacts: per-material effects + persistent bullet holes ----
// metal (metalness > .45) → bright sparks + ricochet ping | concrete/wood → dust puff
let liveDecals = 0;
function spawnBulletHole(point, hit) {
  if (!hit?.face || liveDecals > 48) return;
  const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize();
  const mat = new THREE.MeshBasicMaterial({ color: 0x141414, transparent: true, opacity: 0.85,
    polygonOffset: true, polygonOffsetFactor: -2, depthWrite: false });
  const d = new THREE.Mesh(FX.holeGeo || (FX.holeGeo = new THREE.CircleGeometry(0.034, 8)), mat);
  d.position.copy(point).addScaledVector(n, 0.006);
  d.lookAt(point.clone().add(n));
  d.rotateZ(Math.random() * Math.PI);
  liveDecals++;
  addEffect(d, 9, (dt, e) => {
    if (e.ttl < 2) mat.opacity = 0.85 * (e.ttl / 2);
    if (e.ttl <= 0) { liveDecals--; mat.dispose(); }
  });
}
function surfaceKind(obj) {
  const m = obj?.material;
  return m && (m.metalness || 0) > 0.45 ? 'metal' : 'concrete';
}
function spawnImpact(point, colorHex = 0xffaa55, hit = null) {
  const kind = hit ? surfaceKind(hit.object) : 'generic';
  // core flash (all kinds)
  const sm = new THREE.SpriteMaterial({ map: FX.flashTex, color: kind === 'metal' ? 0xffe9a0 : colorHex, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
  const sp = new THREE.Sprite(sm);
  sp.position.copy(point);
  sp.scale.setScalar(kind === 'metal' ? 0.5 : 0.4);
  addEffect(sp, 0.16, (dt, e) => {
    sp.scale.setScalar(0.45 + (1 - e.ttl / e.ttl0) * 0.9);
    sm.opacity = 0.95 * (e.ttl / e.ttl0);
  });
  if (kind === 'metal') {
    // hot sparks: fast, gravity-arced, bright yellow-white; occasional ricochet whine
    for (let i = 0; i < 7; i++) {
      const smat = new THREE.MeshBasicMaterial({ color: i % 2 ? 0xffdd66 : 0xfff6d0, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false });
      const s = new THREE.Mesh(FX.sparkGeo || (FX.sparkGeo = new THREE.BoxGeometry(0.014, 0.014, 0.05)), smat);
      s.position.copy(point);
      const v = new THREE.Vector3((Math.random() - 0.5) * 7, Math.random() * 5 + 1.5, (Math.random() - 0.5) * 7);
      addEffect(s, 0.3 + Math.random() * 0.25, (dt, e) => {
        v.y -= 22 * dt;
        s.position.addScaledVector(v, dt);
        if (v.lengthSq() > 0.1) s.lookAt(s.position.clone().add(v));
        smat.opacity = e.ttl / e.ttl0;
      });
    }
    if (Math.random() < 0.3) { sfx(2400 + Math.random() * 900, 0.1, 'triangle', 0.035); }
    else sfx(1500, 0.04, 'square', 0.025);
  } else {
    // dust puff: matte billow drifting up + a few falling grit chips
    for (let i = 0; i < 2; i++) {
      const dm = new THREE.SpriteMaterial({ map: FX.flashTex, color: 0x8f8676, transparent: true, opacity: 0.4, depthWrite: false });
      const dp = new THREE.Sprite(dm);
      dp.position.copy(point).add(new THREE.Vector3((Math.random() - 0.5) * 0.12, (Math.random() - 0.5) * 0.12, (Math.random() - 0.5) * 0.12));
      dp.scale.setScalar(0.22);
      addEffect(dp, 0.5 + i * 0.15, (dt, e) => {
        dp.position.y += dt * 0.55;
        dp.scale.setScalar(0.22 + (1 - e.ttl / e.ttl0) * 0.75);
        dm.opacity = 0.4 * (e.ttl / e.ttl0);
      });
    }
    for (let i = 0; i < 3; i++) {
      const gm = new THREE.MeshBasicMaterial({ color: 0x7a7264, transparent: true, opacity: 0.9 });
      const g = new THREE.Mesh(FX.gritGeo || (FX.gritGeo = new THREE.BoxGeometry(0.02, 0.02, 0.02)), gm);
      g.position.copy(point);
      const v = new THREE.Vector3((Math.random() - 0.5) * 3.2, Math.random() * 2.8 + 0.6, (Math.random() - 0.5) * 3.2);
      addEffect(g, 0.45, (dt, e) => {
        v.y -= 14 * dt;
        g.position.addScaledVector(v, dt);
        gm.opacity = e.ttl / e.ttl0;
      });
    }
  }
  if (hit) spawnBulletHole(point, hit);
}
// blood puff on player hits: dark red burst + falling droplets — reads without the hitmarker
function spawnBlood(point, head = false) {
  const bm = new THREE.SpriteMaterial({ map: FX.flashTex, color: 0x8f1010, transparent: true, opacity: 0.85, depthWrite: false });
  const bp = new THREE.Sprite(bm);
  bp.position.copy(point);
  bp.scale.setScalar(head ? 0.5 : 0.38);
  addEffect(bp, 0.28, (dt, e) => {
    bp.scale.setScalar((head ? 0.5 : 0.38) + (1 - e.ttl / e.ttl0) * 0.65);
    bm.opacity = 0.85 * (e.ttl / e.ttl0);
  });
  for (let i = 0; i < (head ? 6 : 4); i++) {
    const dm = new THREE.MeshBasicMaterial({ color: 0x7c0d0d, transparent: true, opacity: 0.95 });
    const dMesh = new THREE.Mesh(FX.dropGeo || (FX.dropGeo = new THREE.SphereGeometry(0.02, 5, 4)), dm);
    dMesh.position.copy(point);
    const v = new THREE.Vector3((Math.random() - 0.5) * 3.4, Math.random() * 2.4 + 0.4, (Math.random() - 0.5) * 3.4);
    addEffect(dMesh, 0.5, (dt, e) => {
      v.y -= 18 * dt;
      dMesh.position.addScaledVector(v, dt);
      dm.opacity = e.ttl / e.ttl0;
    });
  }
}

// brass shell casing: ejects right+up from the gun, tumbles with gravity, fades on the ground
function spawnCasing() {
  const mat = new THREE.MeshBasicMaterial({ color: 0xd4a017, transparent: true, opacity: 1 });
  const c = new THREE.Mesh(FX.casingGeo || (FX.casingGeo = new THREE.BoxGeometry(0.018, 0.045, 0.018)), mat);
  const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  const camFwd = camera.getWorldDirection(new THREE.Vector3());
  c.position.copy(camera.position).addScaledVector(camFwd, 0.7).addScaledVector(camRight, 0.3).add(new THREE.Vector3(0, -0.15, 0));
  const vel = camRight.clone().multiplyScalar(1.4 + Math.random()).add(new THREE.Vector3(0, 2.2 + Math.random(), 0));
  const spin = new THREE.Vector3(Math.random() * 14, Math.random() * 14, Math.random() * 14);
  const floorY = player.pos.y + 0.03;
  let tinked = false;
  addEffect(c, 1.1, (dt, e) => {
    vel.y -= 16 * dt;
    c.position.addScaledVector(vel, dt);
    if (c.position.y < floorY) {
      if (!tinked) { tinked = true; sfx(3400 + Math.random() * 1200, 0.05, 'triangle', 0.022); }
      c.position.y = floorY; vel.set(0, 0, 0); spin.set(0, 0, 0);
    }
    c.rotation.x += spin.x * dt; c.rotation.y += spin.y * dt; c.rotation.z += spin.z * dt;
    if (e.ttl < 0.3) mat.opacity = e.ttl / 0.3;
  });
}

// muzzle smoke: a soft grey puff drifting up from the barrel, expanding as it fades
function spawnSmoke(scale = 1) {
  const sm = new THREE.SpriteMaterial({ map: FX.flashTex, color: 0x9a9a9a, transparent: true, opacity: 0.32, depthWrite: false });
  const sp = new THREE.Sprite(sm);
  const camFwd = camera.getWorldDirection(new THREE.Vector3());
  const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  sp.position.copy(camera.position).addScaledVector(camFwd, 1.1).addScaledVector(camRight, 0.14).add(new THREE.Vector3(0, -0.1, 0));
  sp.scale.setScalar(0.18 * scale);
  addEffect(sp, 0.7, (dt, e) => {
    sp.position.y += dt * 0.5;
    sp.scale.setScalar((0.18 + (1 - e.ttl / e.ttl0) * 0.5) * scale);
    sm.opacity = 0.32 * (e.ttl / e.ttl0);
  });
}

// ============================================================================
// THROWABLES: frag grenade (G) + flashbang (V)
// Trust model matches bullets: the thrower's client simulates + applies damage;
// everyone else receives the throw over the wire and simulates the same physics
// locally for visuals. Flash blindness is always computed by the VICTIM's client
// from its own camera (distance, line of sight, view angle).
// ============================================================================
const NADES = {
  frag:  { name: 'GRENADE', max: 2, fuse: 2800, speed: 16.5, up: 5.2, radius: 8, maxDmg: 135, minDmg: 18 },
  flash: { name: 'FLASHBANG', max: 2, fuse: 1900, speed: 16.5, up: 5.2, radius: 16 },
};
const nadeInv = { frag: NADES.frag.max, flash: NADES.flash.max };
const liveNades = [];        // { kind, pos, vel, mesh, fuseAt, mine, rest }
let throwAnim = null;        // { kind, start, releaseAt, end, released, vm }
let nadeShake = 0;           // camera shake amplitude, decays in animate()
let flashBlind = null;       // { start, hold, fade } for the white overlay
const nadeRay = new THREE.Raycaster();

function resetNades() {
  nadeInv.frag = NADES.frag.max;
  nadeInv.flash = NADES.flash.max;
  updateNadeHud();
}
function clearLiveNades() {
  for (const n of liveNades) scene.remove(n.mesh);
  liveNades.length = 0;
  if (throwAnim) { camera.remove(throwAnim.vm); setCookingHud(throwAnim.kind, false); }
  throwAnim = null;
}
function updateNadeHud() {
  const f = document.getElementById('nadeFrag');
  const s = document.getElementById('nadeFlash');
  f.innerHTML = `G 💣 <b>${nadeInv.frag}</b>`;
  s.innerHTML = `V ⚡ <b>${nadeInv.flash}</b>`;
  f.className = nadeInv.frag ? '' : 'empty';
  s.className = nadeInv.flash ? '' : 'empty';
}

function nadeMesh(kind) {
  if (assets.nades?.[kind]) return assets.nades[kind].clone(true);
  // fallback while the GLB loads: small dark sphere / gray cylinder
  const geo = kind === 'frag' ? new THREE.SphereGeometry(0.055, 12, 10) : new THREE.CylinderGeometry(0.03, 0.03, 0.13, 12);
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: kind === 'frag' ? 0x3a4a3a : 0x555a60, roughness: 0.5, metalness: 0.4 }));
  m.raycast = () => {};
  const g = new THREE.Group(); g.add(m);
  return g;
}

function tryThrowNade(kind) {
  if (!myId || !inMatch || player.dead || photoMode || throwAnim) return;
  if (document.getElementById('joinOverlay').style.display !== 'none') return;
  if (nadeInv[kind] <= 0) { sfx(220, 0.06, 'square', 0.04); return; }   // dry click
  cancelReload();
  setAds(false);
  inspectAnim = null;
  nadeInv[kind]--;
  updateNadeHud();
  // viewmodel: fist + grenade swapped in while the gun dips away
  const vm = new THREE.Group();
  const hand = makeViewHand(1);
  hand.scale.setScalar(1.35);
  vm.add(hand);
  const nm = nadeMesh(kind);
  nm.position.set(-0.005, -0.012, -0.03);
  nm.rotation.z = 0.25;
  vm.add(nm);
  vm.traverse(o => { if (o.isMesh) o.raycast = () => {}; });
  vm.position.set(0.3, -0.45, -0.55);
  camera.add(vm);
  const now = performance.now();
  // pin pulls NOW — fuse starts ticking in your hand (hold key to cook, release to throw)
  throwAnim = { kind, start: now, fuseAt: now + NADES[kind].fuse, holding: true, whipAt: 0, released: false, vm, nadeNode: nm, lastTick: 0 };
  setCookingHud(kind, true);
  sfx(1400, 0.03, 'square', 0.03);   // pin flick
}

function setCookingHud(kind, on) {
  const el = document.getElementById(kind === 'frag' ? 'nadeFrag' : 'nadeFlash');
  if (el) el.classList.toggle('cooking', !!on);
}

// keyup → commit the throw (whip starts once the cock-back finishes)
function releaseNadeThrow() {
  if (!throwAnim || !throwAnim.holding) return;
  throwAnim.holding = false;
  throwAnim.whipAt = Math.max(performance.now(), throwAnim.start + 300);
}

// throw viewmodel choreography — runs every frame from animate()
// phases: raise (0-130) → cock back (130-300) → HOLD while key down (cooking, fuse ticks)
//         → on release: whip (80ms) → follow-through (260ms). Cook too long = pops in hand.
function updateThrowAnim(now) {
  if (!throwAnim) return;
  const a = throwAnim;
  if (window.__throwFreezeT != null) now = a.start + window.__throwFreezeT;   // debug capture freeze
  const t = now - a.start;
  const vm = a.vm;
  const cfg = NADES[a.kind];

  // cooked too long — detonates in your hand (fps-independent, checked first)
  if (!a.released && now >= a.fuseAt) {
    a.released = true;
    setCookingHud(a.kind, false);
    camera.remove(vm);
    throwAnim = null;
    const inHand = { kind: a.kind, pos: player.pos.clone().add(new THREE.Vector3(0, 1.2, 0)), vel: new THREE.Vector3(), mesh: null, mine: true, rest: true };
    try { detonateNade(inHand); } catch (err) { console.warn('in-hand detonation error', err); }
    drawAnim = { start: now, end: now + 200 };
    return;
  }

  // cook warning ticks: beep faster as the fuse runs down (frag only — flash pop is survivable)
  if (a.holding && t > 600) {
    const left = a.fuseAt - now;
    const period = left < 700 ? 130 : left < 1400 ? 260 : 480;
    if (now - a.lastTick > period) { a.lastTick = now; sfx(a.kind === 'frag' ? 1150 : 900, 0.03, 'square', 0.035); }
  }

  // release: 30ms into the whip the grenade leaves the hand with REMAINING fuse
  if (!a.released && !a.holding && now >= a.whipAt + 30) {
    a.released = true;
    setCookingHud(a.kind, false);
    a.nadeNode.visible = false;   // grenade leaves the hand
    const dir = camera.getWorldDirection(new THREE.Vector3());
    const origin = camera.position.clone().addScaledVector(dir, 0.5).add(new THREE.Vector3(0, -0.05, 0));
    const vel = dir.clone().multiplyScalar(cfg.speed).add(new THREE.Vector3(0, cfg.up, 0)).add(player.vel.clone().multiplyScalar(0.35));
    const fuseLeft = Math.max(120, a.fuseAt - now);
    window.__lastThrowFuse = Math.round(fuseLeft);   // test introspection (latency-immune)
    spawnNade(a.kind, origin, vel, true, fuseLeft);
    send({ t: 'nade', kind: a.kind, pos: origin.toArray(), vel: vel.toArray(), fuse: Math.round(fuseLeft) });
    sfx(500, 0.05, 'triangle', 0.04);   // whoosh tick
  }

  const lerp = (p0, p1, k) => p0 + (p1 - p0) * k;
  if (t < 130) {           // raise from below
    const k = t / 130, e = 1 - (1 - k) * (1 - k);
    vm.position.set(lerp(0.30, 0.30, e), lerp(-0.45, -0.20, e), lerp(-0.55, -0.42, e));
    vm.rotation.set(lerp(0.5, 0.1, e), 0, 0.15);
  } else if (t < 300 || a.holding) {   // cock back — held HIGH but IN VIEW while cooking
    const k = Math.min(1, (t - 130) / 170), e = k * k * (3 - 2 * k);
    vm.position.set(lerp(0.30, 0.36, e), lerp(-0.20, -0.06, e), lerp(-0.42, -0.36, e));
    vm.rotation.set(lerp(0.1, 0.55, e), lerp(0, -0.18, e), 0.15);
    if (a.holding && t >= 300) {       // cooking idle: subtle tense tremble that grows with the fuse
      const danger = 1 - Math.max(0, a.fuseAt - now) / cfg.fuse;
      const amp = 0.004 + danger * 0.012;
      vm.position.x += Math.sin(now * 0.021) * amp;
      vm.position.y += Math.sin(now * 0.017 + 1.7) * amp;
    }
  } else {
    const w = now - a.whipAt;
    if (w < 80) {          // whip forward
      const k = Math.max(0, w) / 80, e = k * k;
      vm.position.set(lerp(0.36, 0.08, e), lerp(-0.06, 0.02, e), lerp(-0.36, -0.72, e));
      vm.rotation.set(lerp(0.55, -0.7, e), lerp(-0.18, 0.1, e), 0.15);
    } else if (w < 340) {  // follow-through, hand falls away
      const k = (w - 80) / 260, e = k * k;
      vm.position.set(lerp(0.08, 0.26, e), lerp(0.02, -0.5, e), lerp(-0.72, -0.6, e));
      vm.rotation.set(lerp(-0.7, -0.2, e), 0.1, 0.15);
    } else {               // done
      camera.remove(vm);
      throwAnim = null;
      drawAnim = { start: now, end: now + 200 };   // quick gun re-raise
    }
  }
}

function spawnNade(kind, pos, vel, mine, fuseMs) {
  const mesh = nadeMesh(kind);
  mesh.position.copy(pos);
  scene.add(mesh);
  const spin = new THREE.Vector3(Math.random() * 8 + 6, Math.random() * 4, Math.random() * 8 + 4);
  liveNades.push({ kind, pos: pos.clone(), vel: vel.clone(), mesh, spin, mine: !!mine, fuseAt: performance.now() + (fuseMs ?? NADES[kind].fuse), rest: false });
  window.__nadeEvents?.push({ ev: 'spawn', kind, pos: pos.toArray().map(v => +v.toFixed(2)), mine: !!mine, t: Math.round(performance.now()) });
}

// highest obstacle top under (x,z) at or below height y — grenade floor
function nadeFloorAt(x, z, y) {
  let h = 0;
  for (const ob of obstacles) {
    if (x > ob.min.x - 0.05 && x < ob.max.x + 0.05 && z > ob.min.z - 0.05 && z < ob.max.z + 0.05) {
      if (ob.max.y <= y + 0.06) h = Math.max(h, ob.max.y);
    }
  }
  return h;
}

function updateNades(dt) {
  const now = performance.now();
  for (let i = liveNades.length - 1; i >= 0; i--) {
    const n = liveNades[i];
    if (now >= n.fuseAt) {
      scene.remove(n.mesh);
      liveNades.splice(i, 1);
      try { detonateNade(n); } catch (err) { console.warn('nade detonation error', err); }
      continue;
    }
    if (!n.rest) {
      const R = 0.06, REST = 0.42;
      n.vel.y -= GRAVITY * dt;
      const prevY = n.pos.y;
      n.pos.addScaledVector(n.vel, dt);
      // walls: push out of AABBs and reflect (same closest-point trick as the player)
      for (const ob of obstacles) {
        if (n.pos.y - R >= ob.max.y || n.pos.y + R <= ob.min.y) continue;
        const cx = Math.max(ob.min.x, Math.min(n.pos.x, ob.max.x));
        const cz = Math.max(ob.min.z, Math.min(n.pos.z, ob.max.z));
        const dx = n.pos.x - cx, dz = n.pos.z - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= R * R) continue;
        // came from above the box? land on it instead of a side reflection
        if (prevY - R >= ob.max.y - 0.02) continue;   // floor pass below handles it
        if (d2 > 1e-9) {
          const d = Math.sqrt(d2), nx = dx / d, nz = dz / d;
          n.pos.x += nx * (R - d); n.pos.z += nz * (R - d);
          const dot = n.vel.x * nx + n.vel.z * nz;
          if (dot < 0) { n.vel.x -= (1 + REST) * dot * nx; n.vel.z -= (1 + REST) * dot * nz; nadeTink(n); }
        } else {
          // fully inside (thin wall clipped at speed): reflect the dominant axis
          const pen = [n.pos.x - ob.min.x, ob.max.x - n.pos.x, n.pos.z - ob.min.z, ob.max.z - n.pos.z];
          const m = Math.min(...pen);
          if (m === pen[0]) { n.pos.x = ob.min.x - R; n.vel.x = -Math.abs(n.vel.x) * REST; }
          else if (m === pen[1]) { n.pos.x = ob.max.x + R; n.vel.x = Math.abs(n.vel.x) * REST; }
          else if (m === pen[2]) { n.pos.z = ob.min.z - R; n.vel.z = -Math.abs(n.vel.z) * REST; }
          else { n.pos.z = ob.max.z + R; n.vel.z = Math.abs(n.vel.z) * REST; }
          nadeTink(n);
        }
      }
      // arena bounds
      const B = getMapBounds();
      if (n.pos.x < -B.x + R) { n.pos.x = -B.x + R; n.vel.x = Math.abs(n.vel.x) * REST; }
      if (n.pos.x > B.x - R) { n.pos.x = B.x - R; n.vel.x = -Math.abs(n.vel.x) * REST; }
      if (n.pos.z < -B.z + R) { n.pos.z = -B.z + R; n.vel.z = Math.abs(n.vel.z) * REST; }
      if (n.pos.z > B.z - R) { n.pos.z = B.z - R; n.vel.z = -Math.abs(n.vel.z) * REST; }
      // floor bounce / roll / rest
      const floor = nadeFloorAt(n.pos.x, n.pos.z, prevY);
      if (n.pos.y < floor + R) {
        n.pos.y = floor + R;
        if (Math.abs(n.vel.y) > 1.6) {
          n.vel.y = -n.vel.y * REST;
          n.vel.x *= 0.72; n.vel.z *= 0.72;
          nadeTink(n);
        } else {
          n.vel.y = 0;
          const f = Math.exp(-dt * 3.2);       // rolling friction
          n.vel.x *= f; n.vel.z *= f;
          if (n.vel.lengthSq() < 0.02) { n.vel.set(0, 0, 0); n.rest = true; }
        }
      }
      // tumble in flight, settle when resting
      n.mesh.rotation.x += n.spin.x * dt;
      n.mesh.rotation.z += n.spin.z * dt;
      n.spin.multiplyScalar(n.rest ? 0 : Math.exp(-dt * 0.8));
      n.mesh.position.copy(n.pos);
    }
    // fuse glint: flashbang blinks faster as it's about to pop
    const left = n.fuseAt - now;
    if (n.kind === 'flash' && left < 900 && Math.floor(now / 90) % 2 === 0 && Math.floor(now / 90) !== n._blink) {
      n._blink = Math.floor(now / 90);
      const bm = new THREE.SpriteMaterial({ map: FX.flashTex, color: 0xffffff, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false });
      const bs = new THREE.Sprite(bm);
      bs.position.copy(n.pos);
      bs.scale.setScalar(0.22);
      addEffect(bs, 0.07, (d, e) => { bm.opacity = 0.8 * (e.ttl / e.ttl0); });
    }
  }
}

function nadeTink(n) {
  const d = camera.position.distanceTo(n.pos);
  if (d > 40) return;
  const vol = Math.max(0.01, 0.09 * (1 - d / 40));
  sfx(n.kind === 'frag' ? 620 : 780, 0.045, 'square', vol);
}

function detonateNade(n) {
  const cfg = NADES[n.kind];
  window.__nadeEvents?.push({ ev: 'boom', kind: n.kind, pos: n.pos.toArray().map(v => +v.toFixed(2)), mine: !!n.mine, t: Math.round(performance.now()) });
  const meshes = [...new Set(obstacles.map(o => o.mesh))];
  const blast = n.pos.clone().add(new THREE.Vector3(0, 0.12, 0));
  const losTo = (target) => {
    const to = target.clone().sub(blast);
    const dist = to.length();
    if (dist < 0.01) return true;
    nadeRay.set(blast, to.normalize());
    nadeRay.far = dist - 0.1;
    return nadeRay.intersectObjects(meshes, false).length === 0;
  };
  const myDist = camera.position.distanceTo(blast);

  if (n.kind === 'frag') {
    explosionFX(n.pos);
    sfxExplosion(myDist);
    if (myDist < 24) nadeShake = Math.max(nadeShake, 0.06 * (1 - myDist / 24) + 0.008);
    if (n.mine) {
      // damage remotes (players + bots) — same trust model as hitscan
      for (const [id, r] of remotes) {
        if (r.dead) continue;
        const chest = r.group.position.clone().add(new THREE.Vector3(0, 1.1, 0));
        const d = chest.distanceTo(blast);
        if (d > cfg.radius || !losTo(chest)) continue;
        const dmg = Math.max(1, Math.round(cfg.maxDmg + (cfg.minDmg - cfg.maxDmg) * (d / cfg.radius)));
        send({ t: 'hit', target: id, dmg, head: false, w: 0, wn: cfg.name });
        spawnDamageNumber(chest, dmg, false);
        spawnBlood(chest, false);
        showHitMarker('body');
      }
      // self damage — the classic cooked-too-long suicide
      const meC = player.pos.clone().add(new THREE.Vector3(0, 1.0, 0));
      const dMe = meC.distanceTo(blast);
      if (dMe <= cfg.radius && losTo(meC)) {
        const dmg = Math.max(1, Math.round(cfg.maxDmg + (cfg.minDmg - cfg.maxDmg) * (dMe / cfg.radius)));
        send({ t: 'nadeself', dmg });
      }
      send({ t: 'nadeboom', kind: 'frag', pos: n.pos.toArray() });
    }
  } else {
    flashFX(n.pos);
    // blindness: MY view of the detonation, regardless of who threw it
    if (myDist < cfg.radius && !player.dead) {
      let k = 1 - myDist / cfg.radius;
      const eye = camera.position.clone();
      if (!losTo(eye)) k *= 0.12;                           // behind a wall: faint bloom only
      else {
        const toBlast = blast.clone().sub(eye).normalize();
        const facing = camera.getWorldDirection(new THREE.Vector3()).dot(toBlast);
        if (facing < 0.1) k *= 0.35;                        // looking away saves your eyes
      }
      if (k > 0.04) {
        const now = performance.now();
        flashBlind = { start: now, hold: 300 + 1500 * k, fade: 700 + 2300 * k, k: Math.min(1, k * 1.25) };
        sfxFlashRing(Math.min(1, k * 1.3));
      }
    }
    sfxFlashBang(myDist);
    if (n.mine) send({ t: 'nadeboom', kind: 'flash', pos: n.pos.toArray() });
  }
}

// ---- detonation VFX ----
function explosionFX(pos) {
  const p = pos.clone();
  // core flash sprites
  for (const [color, scale, ttl] of [[0xffffff, 3.2, 0.14], [0xffa838, 5.2, 0.24]]) {
    const sm = new THREE.SpriteMaterial({ map: FX.flashTex, color, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false });
    const sp = new THREE.Sprite(sm);
    sp.position.copy(p).add(new THREE.Vector3(0, 0.3, 0));
    sp.scale.setScalar(scale * 0.4);
    addEffect(sp, ttl, (dt, e) => {
      const k = 1 - e.ttl / e.ttl0;
      sp.scale.setScalar(scale * (0.4 + k * 0.9));
      sm.opacity = e.ttl / e.ttl0;
    });
  }
  // fireball: expanding additive shells
  for (const [color, r0, r1, ttl, op] of [[0xff6a1a, 0.5, 3.4, 0.34, 0.85], [0xffd090, 0.3, 2.2, 0.22, 0.95]]) {
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: op, blending: THREE.AdditiveBlending, depthWrite: false });
    const ball = new THREE.Mesh(new THREE.SphereGeometry(1, 18, 14), mat);
    ball.position.copy(p).add(new THREE.Vector3(0, 0.35, 0));
    ball.scale.setScalar(r0);
    addEffect(ball, ttl, (dt, e) => {
      const k = 1 - e.ttl / e.ttl0;
      ball.scale.setScalar(r0 + (r1 - r0) * Math.sqrt(k));
      mat.opacity = op * (e.ttl / e.ttl0);
    });
  }
  // ground shockwave ring
  {
    const mat = new THREE.MeshBasicMaterial({ color: 0xffcf9a, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.82, 1, 40), mat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(p.x, nadeFloorAt(p.x, p.z, p.y) + 0.06, p.z);
    addEffect(ring, 0.5, (dt, e) => {
      const k = 1 - e.ttl / e.ttl0;
      ring.scale.setScalar(0.6 + k * 11);
      mat.opacity = 0.7 * (e.ttl / e.ttl0);
    });
  }
  // hot sparks
  for (let i = 0; i < 16; i++) {
    const smat = new THREE.MeshBasicMaterial({ color: i % 2 ? 0xffc050 : 0xfff2c0, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false });
    const s = new THREE.Mesh(FX.sparkGeo || (FX.sparkGeo = new THREE.BoxGeometry(0.014, 0.014, 0.05)), smat);
    s.position.copy(p).add(new THREE.Vector3(0, 0.2, 0));
    const a = Math.random() * Math.PI * 2;
    const v = new THREE.Vector3(Math.cos(a) * (3 + Math.random() * 9), 3 + Math.random() * 8, Math.sin(a) * (3 + Math.random() * 9));
    addEffect(s, 0.4 + Math.random() * 0.45, (dt, e) => {
      v.y -= 24 * dt;
      s.position.addScaledVector(v, dt);
      if (v.lengthSq() > 0.1) s.lookAt(s.position.clone().add(v));
      smat.opacity = e.ttl / e.ttl0;
    });
  }
  // debris chunks
  for (let i = 0; i < 10; i++) {
    const dm = new THREE.MeshBasicMaterial({ color: 0x2a2622, transparent: true, opacity: 1 });
    const d = new THREE.Mesh(FX.debrisGeo || (FX.debrisGeo = new THREE.BoxGeometry(0.07, 0.07, 0.07)), dm);
    d.position.copy(p).add(new THREE.Vector3(0, 0.15, 0));
    d.rotation.set(Math.random() * 3, Math.random() * 3, 0);
    const a = Math.random() * Math.PI * 2;
    const v = new THREE.Vector3(Math.cos(a) * (2 + Math.random() * 6), 4 + Math.random() * 7, Math.sin(a) * (2 + Math.random() * 6));
    addEffect(d, 0.7 + Math.random() * 0.5, (dt, e) => {
      v.y -= 22 * dt;
      d.position.addScaledVector(v, dt);
      d.rotation.x += 8 * dt; d.rotation.y += 6 * dt;
      dm.opacity = Math.min(1, e.ttl / 0.25);
    });
  }
  // smoke column
  for (let i = 0; i < 6; i++) {
    const sm = new THREE.SpriteMaterial({ map: FX.flashTex, color: 0x555049, transparent: true, opacity: 0.5, depthWrite: false });
    const sp = new THREE.Sprite(sm);
    sp.position.copy(p).add(new THREE.Vector3((Math.random() - 0.5) * 1.4, 0.4 + i * 0.35, (Math.random() - 0.5) * 1.4));
    const grow = 1.6 + Math.random() * 1.4;
    sp.scale.setScalar(1.1);
    addEffect(sp, 1.8 + Math.random() * 0.9, (dt, e) => {
      const k = 1 - e.ttl / e.ttl0;
      sp.position.y += dt * (1.4 - k);
      sp.scale.setScalar(1.1 + k * grow);
      sm.opacity = 0.5 * (e.ttl / e.ttl0);
    });
  }
  // scorch mark
  {
    const mat = new THREE.MeshBasicMaterial({ color: 0x0a0a0a, transparent: true, opacity: 0.75, depthWrite: false });
    const mark = new THREE.Mesh(new THREE.CircleGeometry(1.5, 24), mat);
    mark.rotation.x = -Math.PI / 2;
    mark.position.set(p.x, nadeFloorAt(p.x, p.z, p.y) + 0.02, p.z);
    addEffect(mark, 14, (dt, e) => { if (e.ttl < 3) mat.opacity = 0.75 * (e.ttl / 3); });
  }
  // light burst
  {
    const light = new THREE.PointLight(0xffa040, 90, 30, 1.8);
    light.position.copy(p).add(new THREE.Vector3(0, 0.8, 0));
    addEffect(light, 0.32, (dt, e) => { light.intensity = 90 * (e.ttl / e.ttl0); });
  }
}

function flashFX(pos) {
  const p = pos.clone().add(new THREE.Vector3(0, 0.15, 0));
  for (const [scale, ttl] of [[7, 0.3], [3, 0.16]]) {
    const sm = new THREE.SpriteMaterial({ map: FX.flashTex, color: 0xffffff, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false });
    const sp = new THREE.Sprite(sm);
    sp.position.copy(p);
    sp.scale.setScalar(scale * 0.5);
    addEffect(sp, ttl, (dt, e) => {
      const k = 1 - e.ttl / e.ttl0;
      sp.scale.setScalar(scale * (0.5 + k));
      sm.opacity = e.ttl / e.ttl0;
    });
  }
  const light = new THREE.PointLight(0xffffff, 160, 36, 1.6);
  light.position.copy(p).add(new THREE.Vector3(0, 0.5, 0));
  addEffect(light, 0.28, (dt, e) => { light.intensity = 160 * (e.ttl / e.ttl0); });
  for (let i = 0; i < 3; i++) {
    const sm = new THREE.SpriteMaterial({ map: FX.flashTex, color: 0xbdbdbd, transparent: true, opacity: 0.4, depthWrite: false });
    const sp = new THREE.Sprite(sm);
    sp.position.copy(p).add(new THREE.Vector3((Math.random() - 0.5) * 0.8, 0.2, (Math.random() - 0.5) * 0.8));
    sp.scale.setScalar(0.8);
    addEffect(sp, 1.1, (dt, e) => {
      sp.position.y += dt * 0.8;
      sp.scale.setScalar(0.8 + (1 - e.ttl / e.ttl0) * 1.6);
      sm.opacity = 0.4 * (e.ttl / e.ttl0);
    });
  }
}

// ---- detonation audio (synth, layered on the shot bus) ----
function sfxExplosion(dist) {
  if (audioCtx.state === 'suspended') audioCtx.resume();
  const vol = Math.max(0.1, Math.min(1, 1.15 - dist / 55));
  const t = audioCtx.currentTime, bus = shotBus(vol);
  shotThump(bus, t, { from: 68, to: 26, gain: 1.5, dur: 0.75 });                          // deep concussion
  shotNoise(bus, t, { type: 'lowpass', freq: 230, gain: 1.2, dur: 0.85 });                // body rumble
  shotNoise(bus, t, { type: 'bandpass', freq: 750, q: 0.5, gain: 0.9, dur: 0.32 });       // mid crack
  shotNoise(bus, t, { type: 'highpass', freq: 2800, gain: 0.6, dur: 0.12 });              // snap
  for (let i = 0; i < 5; i++)                                                             // debris patter
    shotNoise(bus, t, { type: 'bandpass', freq: 900 + Math.random() * 1800, q: 6, gain: 0.16, dur: 0.05, delay: 0.2 + Math.random() * 0.55 });
}
function sfxFlashBang(dist) {
  if (audioCtx.state === 'suspended') audioCtx.resume();
  const vol = Math.max(0.08, Math.min(1, 1.1 - dist / 45));
  const t = audioCtx.currentTime, bus = shotBus(vol);
  shotNoise(bus, t, { type: 'highpass', freq: 3800, gain: 1.2, dur: 0.09 });              // piercing crack
  shotNoise(bus, t, { type: 'bandpass', freq: 1500, q: 1, gain: 0.8, dur: 0.16 });
  shotThump(bus, t, { from: 120, to: 60, gain: 0.7, dur: 0.3 });
}
function sfxFlashRing(k) {
  // tinnitus whine after getting flashed — fades with the blindness
  const t = audioCtx.currentTime;
  const o = audioCtx.createOscillator();
  o.type = 'sine'; o.frequency.setValueAtTime(3900, t);
  o.frequency.exponentialRampToValueAtTime(3500, t + 2.4);
  const g = audioCtx.createGain();
  g.gain.setValueAtTime(0.10 * k, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 2.2 + 1.6 * k);
  o.connect(g).connect(audioCtx.destination);
  o.start(t); o.stop(t + 4);
}

// ---------------- audio (tiny synth, no assets) ----------------
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

function sfx(freq, dur, type = 'square', vol = 0.08) {
  if (audioCtx.state === 'suspended') audioCtx.resume();
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(vol, audioCtx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
  o.connect(g).connect(audioCtx.destination);
  o.start(); o.stop(audioCtx.currentTime + dur);
}

// ---- gunshot synths: each weapon has a structurally different sound, not just filter tweaks ----
// AK: dry supersonic crack + mech cycle | shotgun: sub boom + long rumble + pellet rattle
// sniper: sharp report + echo tail (feedback delay) | deagle: tight bark + metallic slide ring
const noiseBuf = (() => {
  const len = Math.floor(audioCtx.sampleRate * 1.0);
  const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
})();
const shotCurve = (() => {  // soft-clip distortion for punch
  const c = new Float32Array(256);
  for (let i = 0; i < 256; i++) { const x = i / 128 - 1; c[i] = Math.tanh(2.8 * x); }
  return c;
})();
// footstep: filtered noise scuff + low body thump. Pitch jitter keeps repeats organic.
// Sprint steps are heavier (lower thump, more noise) — you can HEAR someone rushing you.
// Surface comes from the map: shipment's deck CLANKS, blackout's carpet muffles.
const MAP_SURFACE = { districts: 'concrete', shipment: 'metal', killhouse: 'concrete', blackout: 'carpet', range: 'concrete' };
function sfxFootstep(vol, sprint) {
  if (audioCtx.state === 'suspended') audioCtx.resume();
  const surf = MAP_SURFACE[getCurrentMap()] || 'concrete';
  if (surf === 'carpet') vol *= 0.6;
  const t = audioCtx.currentTime;
  const jit = 0.9 + Math.random() * 0.25;
  const src = audioCtx.createBufferSource(); src.buffer = noiseBuf;
  const f = audioCtx.createBiquadFilter(); f.type = 'lowpass';
  f.frequency.value = (surf === 'carpet' ? 230 : sprint ? 520 : 420) * jit;
  const g = audioCtx.createGain();
  g.gain.setValueAtTime(vol * (sprint ? 1.35 : 1), t);
  g.gain.exponentialRampToValueAtTime(0.001, t + (sprint ? 0.09 : 0.07));
  src.connect(f).connect(g).connect(audioCtx.destination);
  src.start(t); src.stop(t + 0.1);
  const o = audioCtx.createOscillator(); o.type = 'sine';
  o.frequency.value = (sprint ? 62 : 74) * jit;
  const og = audioCtx.createGain();
  og.gain.setValueAtTime(vol * 0.8, t);
  og.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
  o.connect(og).connect(audioCtx.destination);
  o.start(t); o.stop(t + 0.07);
  if (surf === 'metal') {   // deck plate ring
    const m = audioCtx.createBufferSource(); m.buffer = noiseBuf;
    const bp = audioCtx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 950 * jit; bp.Q.value = 9;
    const mg = audioCtx.createGain();
    mg.gain.setValueAtTime(vol * 0.5, t);
    mg.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    m.connect(bp).connect(mg).connect(audioCtx.destination);
    m.start(t); m.stop(t + 0.17);
  }
}
// helpers: build one-shot layers into a destination node
function shotNoise(dest, t, { type = 'bandpass', freq = 1000, q = 1, gain = 1, dur = 0.15, delay = 0 }) {
  const src = audioCtx.createBufferSource(); src.buffer = noiseBuf;
  const f = audioCtx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
  const g = audioCtx.createGain();
  g.gain.setValueAtTime(0.0001, t + delay);
  g.gain.exponentialRampToValueAtTime(gain, t + delay + 0.004);
  g.gain.exponentialRampToValueAtTime(0.001, t + delay + dur);
  src.connect(f).connect(g).connect(dest);
  src.start(t + delay, Math.random() * 0.3); src.stop(t + delay + dur + 0.05);
}
function shotThump(dest, t, { from = 90, to = 45, gain = 0.9, dur = 0.25, delay = 0 }) {
  const o = audioCtx.createOscillator(); o.type = 'sine';
  o.frequency.setValueAtTime(from, t + delay);
  o.frequency.exponentialRampToValueAtTime(to, t + delay + dur);
  const g = audioCtx.createGain();
  g.gain.setValueAtTime(gain, t + delay);
  g.gain.exponentialRampToValueAtTime(0.001, t + delay + dur);
  o.connect(g).connect(dest);
  o.start(t + delay); o.stop(t + delay + dur + 0.02);
}
function shotPing(dest, t, { freq = 2200, gain = 0.2, dur = 0.2, delay = 0, type = 'triangle' }) {
  const o = audioCtx.createOscillator(); o.type = type; o.frequency.value = freq;
  const g = audioCtx.createGain();
  g.gain.setValueAtTime(gain, t + delay);
  g.gain.exponentialRampToValueAtTime(0.001, t + delay + dur);
  o.connect(g).connect(dest);
  o.start(t + delay); o.stop(t + delay + dur + 0.02);
}
function shotBus(vol) {   // master with soft clip; returns { in, t }
  const master = audioCtx.createGain(); master.gain.value = vol;
  const shaper = audioCtx.createWaveShaper(); shaper.curve = shotCurve;
  shaper.connect(master).connect(audioCtx.destination);
  return shaper;
}
const GUN_SHOT_FN = {
  1: () => {  // AK-47: hard dry crack, mid snap, fast decay, bolt-cycle tick — no boom
    const t = audioCtx.currentTime, bus = shotBus(0.5);
    shotNoise(bus, t, { type: 'highpass', freq: 6000, gain: 1.0, dur: 0.025 });          // supersonic crack
    shotNoise(bus, t, { type: 'bandpass', freq: 1700, q: 1.2, gain: 0.9, dur: 0.09 });   // dry mid snap
    shotNoise(bus, t, { type: 'bandpass', freq: 650, q: 1.0, gain: 0.5, dur: 0.13 });    // short low body
    shotThump(bus, t, { from: 110, to: 70, gain: 0.5, dur: 0.07 });                      // tight punch, no rumble
    shotPing(bus, t, { freq: 3100, gain: 0.1, dur: 0.03, delay: 0.045, type: 'square' }); // bolt cycling tick
  },
  2: () => {  // Shotgun: sub-heavy BOOM, long lowpass rumble tail, pellet/shell rattle
    const t = audioCtx.currentTime, bus = shotBus(0.72);
    shotNoise(bus, t, { type: 'highpass', freq: 2500, gain: 0.7, dur: 0.03 });           // blast snap
    shotNoise(bus, t, { type: 'bandpass', freq: 420, q: 0.4, gain: 1.0, dur: 0.30 });    // wide boom
    shotNoise(bus, t, { type: 'lowpass', freq: 300, gain: 0.8, dur: 0.55 });             // long rolling rumble
    shotThump(bus, t, { from: 70, to: 34, gain: 1.0, dur: 0.4 });                        // chest sub drop
    for (let i = 0; i < 3; i++)                                                          // pellet rattle
      shotNoise(bus, t, { type: 'bandpass', freq: 1400 + i * 600, q: 6, gain: 0.16, dur: 0.05, delay: 0.05 + i * 0.035 });
  },
  3: () => {  // Sniper: violent report + echo tail rolling off into the distance
    const t = audioCtx.currentTime, bus = shotBus(0.75);
    shotNoise(bus, t, { type: 'highpass', freq: 4500, gain: 1.0, dur: 0.03 });           // crack
    shotNoise(bus, t, { type: 'bandpass', freq: 900, q: 0.7, gain: 1.0, dur: 0.28 });    // report body
    shotThump(bus, t, { from: 62, to: 30, gain: 1.0, dur: 0.45 });                       // deep sub
    // echo tail: feedback delay, lowpassed so each repeat is duller and farther away
    const echoIn = audioCtx.createGain(); echoIn.gain.value = 0.5;
    const dly = audioCtx.createDelay(1.0); dly.delayTime.value = 0.21;
    const fb = audioCtx.createGain(); fb.gain.value = 0.42;
    const lp = audioCtx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
    echoIn.connect(dly); dly.connect(lp).connect(fb).connect(dly); lp.connect(bus);
    shotNoise(echoIn, t, { type: 'bandpass', freq: 800, q: 0.8, gain: 1.0, dur: 0.15 });
  },
  4: () => {  // Deagle: tight hard bark + metallic slide ring + brass ping
    const t = audioCtx.currentTime, bus = shotBus(0.58);
    shotNoise(bus, t, { type: 'highpass', freq: 5200, gain: 1.0, dur: 0.02 });           // sharp snap
    shotNoise(bus, t, { type: 'bandpass', freq: 1300, q: 1.5, gain: 0.9, dur: 0.11 });   // bark
    shotThump(bus, t, { from: 95, to: 60, gain: 0.65, dur: 0.10 });                      // .50AE punch
    shotPing(bus, t, { freq: 2400, gain: 0.22, dur: 0.16, delay: 0.008 });               // metallic slide ring
    shotPing(bus, t, { freq: 4200, gain: 0.08, dur: 0.25, delay: 0.10, type: 'sine' });  // brass tinkle
  },
};
function sfxGunshot(wIdx) {
  if (audioCtx.state === 'suspended') audioCtx.resume();
  (GUN_SHOT_FN[wIdx] || GUN_SHOT_FN[1])();
}
// mechanical rack (pump/bolt): two short filtered-noise clunks
function sfxRack(hz = 900) {
  if (audioCtx.state === 'suspended') audioCtx.resume();
  const t = audioCtx.currentTime;
  const src = audioCtx.createBufferSource(); src.buffer = noiseBuf;
  const bp = audioCtx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = hz; bp.Q.value = 2.5;
  const g = audioCtx.createGain();
  g.gain.setValueAtTime(0.35, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
  src.connect(bp).connect(g).connect(audioCtx.destination);
  src.start(t, Math.random() * 0.3); src.stop(t + 0.09);
}
const sfxShoot = () => { sfx(880, 0.08, 'square'); sfx(220, 0.12, 'sawtooth', 0.05); };
const sfxHit = () => sfx(1320, 0.1, 'sine', 0.12);
const sfxHurt = () => sfx(160, 0.25, 'sawtooth', 0.12);
const sfxDeath = () => { sfx(400, 0.5, 'sawtooth', 0.1); sfx(100, 0.7, 'triangle', 0.12); };

// ---------------- input ----------------
let jumpQueued = false;
document.addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (e.code === 'Tab') {
    e.preventDefault();
    if (myId) document.getElementById('scoreboard').style.display = 'block';
  }
  if (e.code === 'Space' && !e.repeat) jumpQueued = true;   // !repeat: holding space must not machine-gun jumps
  if (e.code === 'Digit1') switchWeapon(1, true);
  if (e.code === 'Digit2') switchWeapon(2, true);
  if (e.code === 'Digit3') switchWeapon(3, true);
  if (e.code === 'Digit4') switchWeapon(4, true);
  if (e.code === 'KeyR') startReload();
  if (e.code === 'KeyF' && myId && !player.dead && !reloading && !adsActive && !actionAnim && !inspectAnim)
    inspectAnim = { start: performance.now(), end: performance.now() + 2400 };
  if (e.code === 'KeyT' && myId && !player.dead) toggleFlashlight();
  if (e.code === 'KeyG' && !e.repeat) tryThrowNade('frag');
  if (e.code === 'KeyV' && !e.repeat) tryThrowNade('flash');
  if (e.code === 'KeyC') queueSlide = true;
  if (e.code === 'BracketLeft') applySens(sensitivity - 0.05, true);
  if (e.code === 'BracketRight') applySens(sensitivity + 0.05, true);
  // Nemesis: N cycles the bots' aim mode (host), Shift+N resets the learned models, H hides the panel
  if (e.code === 'KeyN' && !e.repeat) send({ t: e.shiftKey ? 'nemesisreset' : 'nemesismode' });
  if (e.code === 'KeyH' && !e.repeat) nemesisHudHidden = !nemesisHudHidden;
  if (e.code === 'KeyB' && !e.repeat) send({ t: 'nemesisstyle' });   // demo: switch the target's movement
});
document.addEventListener('keyup', (e) => {
  keys[e.code] = false;
  if (e.code === 'KeyG' || e.code === 'KeyV') releaseNadeThrow();
  if (e.code === 'Tab') document.getElementById('scoreboard').style.display = 'none';
});

document.addEventListener('mousemove', (e) => {
  if (!pointerLocked) return;
  const adsScale = adsActive ? 0.35 * adsSensMult : 1;   // ADS multiplier is user-tunable in settings
  player.yaw -= e.movementX * 0.0022 * sensitivity * adsScale;
  player.pitch -= e.movementY * 0.0022 * sensitivity * adsScale;
  player.pitch = Math.max(-1.45, Math.min(1.45, player.pitch));
  // viewmodel lag: the gun trails the flick and eases back (heavier while ADS)
  const swayK = (adsActive ? 0.25 : 1) * 0.00016;
  swayImpYaw = Math.max(-0.075, Math.min(0.075, swayImpYaw + e.movementX * swayK));
  swayImpPitch = Math.max(-0.06, Math.min(0.06, swayImpPitch + e.movementY * swayK * 0.8));
});

document.addEventListener('pointerlockchange', () => {
  pointerLocked = document.pointerLockElement === renderer.domElement;
  const panel = document.getElementById('settingsPanel');
  if (pointerLocked) {
    everLocked = true;
    panel.style.display = 'none';
  } else if (inMatch && everLocked) {
    panel.style.display = 'block';   // ESC pressed mid-game -> pause/settings
  } else {
    panel.style.display = 'none';
  }
});

renderer.domElement.addEventListener('click', () => {
  if (!pointerLocked && inMatch) renderer.domElement.requestPointerLock();
});

let fireHeld = false;
document.addEventListener('mousedown', (e) => {
  if (!pointerLocked) return;
  if (e.button === 0) { fireHeld = true; shoot(); }
  if (e.button === 2) setAds(true);
});
document.addEventListener('mouseup', (e) => {
  if (e.button === 0) fireHeld = false;
  if (e.button === 2) setAds(false);
});
document.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------------- shooting ----------------
const raycaster = new THREE.Raycaster();

function shoot() {
  const w = WEAPONS[currentWeapon];
  const now = performance.now();
  if (player.dead || reloading || now - lastShot < w.cooldown) return;
  if (throwAnim) return;                                         // mid grenade throw
  if (drawAnim && now < drawAnim.end) return;                    // still raising the weapon
  if (sprinting) { shoot.sprintSuppressUntil = now + 450; return; }   // trigger pull breaks sprint — gun snaps down first
  if (now - sprintEndAt < 150) return;                           // sprint-to-fire delay (the snap-down)
  inspectAnim = null;                                            // firing snaps out of inspect
  if (ammo[currentWeapon] <= 0) { sfx(200, 0.06, 'square', 0.05); startReload(); return; }  // dry click
  lastShot = now;
  ammo[currentWeapon]--;
  updateAmmoHud();
  sfxGunshot(currentWeapon);
  if (vms[currentWeapon]) {
    vms[currentWeapon].slideKick = now;   // procedural bolt/slide blowback (clip has no fire action)
    // last round: the bolt/slide locks visibly OPEN — you see empty before the HUD says it
    if (ammo[currentWeapon] === 0) vms[currentWeapon].lockOpen = true;
  }

  // recoil: viewmodel show (big, cosmetic) + pattern-driven camera climb (small, the real cost)
  if (now - (shoot._lastAt || 0) > SPRAY_RESET_MS || shoot._lastW !== currentWeapon) sprayIdx = 0;
  shoot._lastAt = now; shoot._lastW = currentWeapon;
  // first-shot pushback: the opening shot of a burst shoves noticeably harder than
  // sustained fire — the single biggest "each trigger pull matters" cue in modern FPS anim
  const firstMult = sprayIdx === 0 ? 1.5 : 1;
  const vmScale = (adsActive ? 0.45 : 1) * firstMult;   // ADS keeps the sights readable (MW-style)
  gunGroup.position.z = (adsActive && !w.scope && w.adsPos ? w.adsPos.z : hipPos().z) + w.kick.z * vmScale;
  gunRotKick += w.kick.rot * vmScale;
  const pat = w.pattern[Math.min(sprayIdx, w.pattern.length - 1)];
  sprayIdx++;
  const adsRecoil = adsActive ? 0.55 : 1;               // aiming steadies the gun
  recoilPitch += pat[0] * adsRecoil;
  recoilYaw += (pat[1] + (Math.random() - 0.5) * 0.0015) * adsRecoil;
  muzzleLight.intensity = 3;
  muzzleFlash.position.z = MUZZLE_Z[currentWeapon] ?? -0.6;
  muzzleLight.position.z = muzzleFlash.position.z;
  muzzleFlash.material.opacity = 1;
  muzzleFlash.material.rotation = Math.random() * Math.PI * 2;
  muzzleFlash.scale.setScalar(0.13 + Math.random() * 0.09);
  // DARKNESS: fire pooled scene light at the world-space muzzle position
  { const muzzleWorld = new THREE.Vector3(0, 0, MUZZLE_Z[currentWeapon] ?? -0.6);
    gunGroup.localToWorld(muzzleWorld); fireMuzzleFlashLight(muzzleWorld); }
  // shell casing (action weapons eject when the bolt/pump cycles) + muzzle smoke
  if (w.action) setTimeout(() => { if (!player.dead) spawnCasing(); }, w.action.delay + w.action.dur * 0.4);
  else spawnCasing();
  spawnSmoke(w.pellets > 1 ? 2.0 : w.name === 'SNIPER' ? 1.8 : 1);

  const origin = camera.getWorldPosition(new THREE.Vector3());
  const baseDir = camera.getWorldDirection(new THREE.Vector3());
  const damageByTarget = new Map();   // id -> { dmg, head }

  // spread: scoped sniper is laser-accurate, sloppy from the hip; shotgun tightens when aiming
  let spread = w.spread;
  if (w.scope) spread = adsActive ? 0 : (w.hipSpread || 0);
  else if (adsActive && w.adsSpread !== undefined) spread = w.adsSpread;

  // damage falloff: full to start(m), linear down to min at end(m)
  const falloffMult = (dist) => {
    const f = w.falloff;
    if (!f || dist <= f.start) return 1;
    if (dist >= f.end) return f.min;
    return 1 - (1 - f.min) * (dist - f.start) / (f.end - f.start);
  };
  // dedupe: rotated boxes push the same mesh into obstacles multiple times
  const rayMeshes = [...new Set(obstacles.map(o => o.mesh))];

  for (let i = 0; i < w.pellets; i++) {
    const dir = baseDir.clone();
    if (spread > 0) {
      dir.x += (Math.random() - 0.5) * spread * 2;
      dir.y += (Math.random() - 0.5) * spread * 2;
      dir.z += (Math.random() - 0.5) * spread * 2;
      dir.normalize();
    }

    send({ t: 'shoot', origin: origin.toArray(), dir: dir.toArray(), w: currentWeapon });

    // raycast walls — one THIN WOODEN surface can be shot through at reduced damage.
    // (three.js culls back faces, so exit points come from the obstacle AABB, not a second hit)
    raycaster.set(origin, dir);
    raycaster.far = 250;
    const wallHits = raycaster.intersectObjects(rayMeshes, false);
    let wallDist = Infinity, penMult = 1, penPoint = null;
    if (wallHits.length) {
      const first = wallHits[0];
      let thickness = Infinity;
      if (first.object.userData.pen) {
        for (const o of obstacles) {                     // find the AABB the ray entered
          if (o.mesh !== first.object) continue;
          let t0 = -Infinity, t1 = Infinity, miss = false;
          for (const ax of ['x', 'y', 'z']) {
            const d = dir[ax];
            if (Math.abs(d) < 1e-9) { if (origin[ax] < o.min[ax] || origin[ax] > o.max[ax]) { miss = true; break; } continue; }
            let a = (o.min[ax] - origin[ax]) / d, b = (o.max[ax] - origin[ax]) / d;
            if (a > b) [a, b] = [b, a];
            t0 = Math.max(t0, a); t1 = Math.min(t1, b);
          }
          if (!miss && t1 >= t0 && t0 <= first.distance + 0.05 && t1 >= first.distance - 0.05) {
            thickness = Math.min(thickness, t1 - first.distance);
          }
        }
      }
      if (thickness < 0.7) {                             // thin wood: shoot through, damage reduced
        const next = wallHits.find(h => h.object !== first.object);
        wallDist = next ? next.distance : Infinity;
        penMult = 0.6;
        penPoint = first.point;
      } else {
        wallDist = first.distance;
      }
    }

    let bestId = null, bestDist = Infinity, bestPoint = null, bestPart = 'body';
    for (const [id, r] of remotes) {
      if (r.dead) continue;
      const hits = raycaster.intersectObject(r.group, true);
      if (hits.length && hits[0].distance < bestDist) {
        bestDist = hits[0].distance;
        bestId = id;
        bestPoint = hits[0].point;
        bestPart = hits[0].object.userData.part || 'body';
      }
    }

    // shot visual with true travel distance (muzzle-offset start)
    const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const visStart = origin.clone().addScaledVector(dir, 0.9).addScaledVector(camRight, 0.14).add(new THREE.Vector3(0, -0.12, 0));
    spawnShot(visStart, dir, currentWeapon, Math.min(bestDist, wallDist, 200));
    if (penPoint && bestDist > wallHits[0].distance) spawnImpact(penPoint, 0xb08050); // splinters on the plank

    // DARKNESS: check if a live map light was hit
    if (mapLights.length) {
      const liveLightMeshes = mapLights.map((l, idx) => l.on ? l.mesh : null).filter(Boolean);
      if (liveLightMeshes.length) {
        const lhits = raycaster.intersectObjects(liveLightMeshes, false);
        if (lhits.length && lhits[0].distance <= wallDist + 0.5) {
          const hitMesh = lhits[0].object;
          const li = mapLights.findIndex(l => l.mesh === hitMesh);
          if (li >= 0 && mapLights[li].on) {
            send({ t: 'lightout', i: li });
          }
        }
      }
    }

    if (bestId && bestDist < wallDist) {
      const isHead = bestPart === 'head';
      const throughWood = penPoint && bestDist > wallHits[0].distance;
      const pelletDmg = Math.max(1, Math.round(w.dmg * (isHead ? w.headMult : 1) * falloffMult(bestDist) * (throughWood ? penMult : 1)));
      const cur = damageByTarget.get(bestId) || { dmg: 0, head: false };
      cur.dmg += pelletDmg;
      cur.head = cur.head || isHead;
      cur.point = bestPoint;
      damageByTarget.set(bestId, cur);
      spawnBlood(bestPoint, isHead);
    } else if (wallHits.length) {
      const blocker = wallHits.find(h => h.distance >= wallDist - 0.001) || wallHits[0];
      spawnImpact(blocker.point, w.tracer.color, blocker);
    }
  }

  if (damageByTarget.size) {
    let anyHead = false;
    for (const [target, info] of damageByTarget) {
      send({ t: 'hit', target, dmg: info.dmg, head: info.head, w: currentWeapon });
      anyHead = anyHead || info.head;
      if (info.point) spawnDamageNumber(info.point, info.dmg, info.head);
      // directional flinch: the victim jerks AWAY from the bullet, harder on headshots
      const tr = remotes.get(target);
      if (tr) {
        tr.flinchDir = baseDir.clone().setY(0).normalize();
        tr.flinch = info.head ? 1.35 : 1;
        tr.flinchHead = info.head;
      }
    }
    if (anyHead) { sfx(1800, 0.12, 'sine', 0.14); sfx(2400, 0.08, 'sine', 0.08); }
    else sfxHit();
    showHitMarker(anyHead ? 'head' : 'body');
  }

  // auto-reload when the mag runs dry
  if (ammo[currentWeapon] <= 0) setTimeout(startReload, 300);

  // bolt/pump action: viewmodel cycles during the cooldown (sniper bolt, shotgun pump)
  if (w.action && ammo[currentWeapon] > 0) {
    actionAnim = { start: now + w.action.delay, end: now + w.action.delay + w.action.dur };
    setTimeout(() => {
      sfxRack(w.action.freq * 3);                                                // rack back
      setTimeout(() => sfxRack(w.action.freq * 4.2), w.action.dur * 0.55);       // slam forward
    }, w.action.delay);
  }
}

// hit marker: X of 4 ticks at the crosshair — white on hit, gold on headshot, red on kill
let hitMarkerTimer = null;
function showHitMarker(kind = 'body') {
  const hm = document.getElementById('hitMarker');
  const cfg = {
    body: { color: '#ffffff', scale: 1,    hold: 110 },
    head: { color: '#ffd700', scale: 1.35, hold: 200 },
    kill: { color: '#ff4444', scale: 1.6,  hold: 320 },
  }[kind] || { color: '#ffffff', scale: 1, hold: 110 };
  // kill sting only — body/head shot tones already play in the shoot path (sfxHit/headshot pair)
  if (kind === 'kill') { sfx(880, 0.07, 'square', 0.06); sfx(520, 0.16, 'square', 0.055); }
  hm.style.display = 'block'; // .hud default is display:none — opacity alone never shows it
  for (const tick of hm.children) tick.style.background = cfg.color;
  // punch: start scaled up, snap back
  hm.style.transform = `translate(-50%,-50%) scale(${cfg.scale * 1.25})`;
  hm.style.opacity = 1;
  requestAnimationFrame(() => { hm.style.transform = `translate(-50%,-50%) scale(${cfg.scale})`; });
  clearTimeout(hitMarkerTimer);
  hitMarkerTimer = setTimeout(() => { hm.style.opacity = 0; }, cfg.hold);
}

// ---- reload animation ----
// mag weapons: mag rocks out and drops (hand follows), fresh mag rides back up, bolt rack
// shotgun: shells pushed into the loading port one by one, each adds a round, then pump
let reloadAnim = null;
function vmWrapper() { return weaponModels[currentWeapon]?.children[0]; }

function startReload() {
  const w = WEAPONS[currentWeapon];
  if (reloading || player.dead || ammo[currentWeapon] >= w.mag) return;
  reloading = true;
  inspectAnim = null;
  setAds(false);
  updateAmmoHud();
  const now = performance.now();
  if (currentWeapon === 2) {
    const shells = w.mag - ammo[currentWeapon];
    const LEAD = 350, SHELL_MS = 440, PUMP = 480;
    reloadAnim = { type: 'shells', start: now, lead: LEAD, shellMs: SHELL_MS, shells, loaded: 0,
                   pumpAt: now + LEAD + shells * SHELL_MS, end: now + LEAD + shells * SHELL_MS + PUMP, sfx: {} };
  } else {
    // tactical reload: swapping a non-empty mag is quicker than recharging from bolt-lock
    const emptyMag = ammo[currentWeapon] === 0;
    const dur = Math.round(w.reload * (emptyMag ? 1 : 0.87));
    // low-mag urgency: a quiet mag-rattle as the hand grabs the fresh one
    if (ammo[currentWeapon] > 0 && ammo[currentWeapon] < w.mag * 0.25) {
      sfx(210, 0.04, 'square', 0.035);
      setTimeout(() => sfx(260, 0.035, 'square', 0.03), 70);
    }
    reloadAnim = { type: 'mag', start: now, end: now + dur, sfx: {} };
    const vmR = vms[currentWeapon];
    if (vmR) { const [t0, t1] = VM_CFG[currentWeapon].reload; vmR.seg = { t0, t1, start: now, dur }; }
  }
}

function finishReloadVisuals() {
  const wr = vmWrapper();
  if (wr && wr.userData) {
    for (const m of wr.userData.magNodes || []) { m.node.position.copy(m.pos); m.node.quaternion.copy(m.quat); m.node.visible = true; }
    if (wr.userData.gripL && wr.userData.gripLRest) wr.userData.gripL.position.copy(wr.userData.gripLRest);
    if (wr.userData.shell) wr.userData.shell.visible = false;
  }
}

function cancelReload() {
  if (vms[currentWeapon]) { vms[currentWeapon].lockOpen = false; vms[currentWeapon].slideKick = null; }
  if (!reloading) return;
  reloading = false;
  finishReloadVisuals();
  reloadAnim = null;
  updateAmmoHud();
}

// eased 0→1→0 "down and back" curve split at `mid`
function outAndBack(t, mid) {
  if (t < mid) { const u = t / mid; return u * u * (3 - 2 * u); }
  const u = (t - mid) / (1 - mid);
  return 1 - u * u * (3 - 2 * u);
}

function updateReloadAnim(now) {
  if (!reloadAnim) return 0;
  const w = WEAPONS[currentWeapon];
  const wr = vmWrapper();
  const ud = wr?.userData;
  let rackRot = 0;

  if (now >= reloadAnim.end) {              // done: refill (mag weapons), restore rig
    if (reloadAnim.type === 'mag') ammo[currentWeapon] = w.mag;
    if (vms[currentWeapon]) { vms[currentWeapon].lockOpen = false; vms[currentWeapon].slideKick = null; }
    reloading = false;
    reloadAnim = null;
    finishReloadVisuals();
    updateAmmoHud();
    return 0;
  }

  if (reloadAnim.type === 'mag') {
    const t = (now - reloadAnim.start) / (reloadAnim.end - reloadAnim.start);
    // sound cues + physical impulses through the sway spring, fired once each:
    // the spring's lag/settle gives the weighty overlapping feel of CoD/BF reloads
    if (t > 0.12 && !reloadAnim.sfx.out) { reloadAnim.sfx.out = 1; sfxRack(560); swayImpPitch += 0.03; }
    if (t > 0.74 && !reloadAnim.sfx.in) { reloadAnim.sfx.in = 1; sfxRack(400); swayImpPitch -= 0.06; swayImpYaw += 0.02; }   // mag slap: gun jolts up
    if (t > 0.88 && !reloadAnim.sfx.rack) { reloadAnim.sfx.rack = 1; sfxRack(900); swayImpYaw -= 0.04; swayImpPitch += 0.045; } // rack: sharp back-jerk
    if (ud && ud.magNodes?.length) {
      // Real CoD beats: rip the old mag out → it FREE-FALLS out of frame (gravity+tumble,
      // never returns) → hand dives off-screen to the pouch → fresh mag ENTERS FROM BELOW
      // carried by the hand → rocks in nose-first → slap → charge.
      const magScale = currentWeapon === 4 ? 0.55 : 1;     // pistol geometry is smaller
      let magY = 0, magZ = 0, magTilt = 0, magVis = true;
      if (t < 0.10) {                                       // still seated (hand reaching)
      } else if (t < 0.16) {                                // rock-out: unlatch, nose tips forward
        const u = (t - 0.10) / 0.06;
        magTilt = -0.55 * u; magY = -0.03 * u;
      } else if (t < 0.40) {                                // FREE-FALL: accelerating drop + tumble, exits frame
        const u = (t - 0.16) / 0.24;
        magY = -0.03 - 1.15 * u * u; magZ = 0.06 * u;
        magTilt = -0.55 - 1.3 * u;
        magVis = magY > -0.85;
      } else if (t < 0.46) {                                // gone; well is EMPTY while hand is at the pouch
        magVis = false;
      } else if (t < 0.72) {                                // FRESH mag rises from below frame, in the hand
        const u = (t - 0.46) / 0.26; const e = u * u * (3 - 2 * u);
        magY = -0.75 * (1 - e); magZ = 0.10 * (1 - e);
        magTilt = -0.45 * (1 - e * e);                      // nose-up entry, rocks level as it seats
        magVis = magY > -0.72;
      }                                                     // >=0.72: seated (slap impulse fires at 0.74)
      for (const m of ud.magNodes) {
        m.node.position.set(m.pos.x, m.pos.y + magY * magScale, m.pos.z + magZ * magScale);
        m.node.quaternion.copy(m.quat);
        m.node.rotateX(magTilt);
        m.node.visible = magVis;
      }
      // support hand choreography (CoD-style): arc back to the mag well, drop the old
      // mag, carry the fresh one up, sweep UP to the charging handle, rack it back
      // sharply, then snap back to the handguard. Arcs + the sway-spring impulses
      // above give the overlapping weighty motion instead of robotic slides.
      if (ud.gripL && ud.gripLRest) {
        const mw = MAGWELL_HAND[currentWeapon] || MAGWELL_HAND[1];
        const CH = { x: 0.04, y: 0.10, z: 0.33 };   // charging handle: up + back over the receiver
        const ss = (u) => u * u * (3 - 2 * u);
        let px = 0, py = 0, pz = 0;
        const POUCH = { x: mw.x + 0.02, y: mw.y - 0.42, z: mw.z + 0.10 };  // below frame edge
        if (t < 0.10) {                    // reach back to the well and grip the mag
          const u = ss(t / 0.10);
          px = mw.x * u; py = mw.y * u - Math.sin(u * Math.PI) * 0.03; pz = mw.z * u;
        } else if (t < 0.16) {             // rip: hand rides the unlatching mag
          px = mw.x; py = mw.y - 0.03 * ((t - 0.10) / 0.06); pz = mw.z;
        } else if (t < 0.42) {             // hand dives off-screen to the pouch (mag falls free)
          const u = ss((t - 0.16) / 0.26);
          px = mw.x + (POUCH.x - mw.x) * u; py = mw.y + (POUCH.y - mw.y) * u; pz = mw.z + (POUCH.z - mw.z) * u;
        } else if (t < 0.46) {             // at the pouch, grabbing the fresh mag
          px = POUCH.x; py = POUCH.y; pz = POUCH.z;
        } else if (t < 0.72) {             // carry the fresh mag up into the well
          const u = ss((t - 0.46) / 0.26);
          px = POUCH.x + (mw.x - POUCH.x) * u; py = POUCH.y + (mw.y - POUCH.y) * u; pz = POUCH.z + (mw.z - POUCH.z) * u;
        } else if (t < 0.84) {             // seat + slap, hand settles at the well
          px = mw.x; py = mw.y; pz = mw.z;
        } else if (t < 0.92) {             // sweep up and over to the charging handle
          const u = ss((t - 0.84) / 0.08);
          px = mw.x + (CH.x - mw.x) * u;
          py = mw.y + (CH.y - mw.y) * u + Math.sin(u * Math.PI) * 0.02;
          pz = mw.z + (CH.z - mw.z) * u;
        } else if (t < 0.97) {             // rack: sharp pull toward the shoulder, quick release
          const pull = Math.sin(Math.min(1, (t - 0.92) / 0.05) * Math.PI);
          px = CH.x; py = CH.y; pz = CH.z + pull * 0.10;
        } else {                           // snap back to the handguard
          const u = ss((t - 0.97) / 0.03);
          px = CH.x * (1 - u); py = CH.y * (1 - u); pz = CH.z * (1 - u);
        }
        ud.gripL.position.set(ud.gripLRest.x + px, ud.gripLRest.y + py, ud.gripLRest.z + pz);
      }
    }
    if (t > 0.92) rackRot = -0.28 * Math.sin(Math.min(1, (t - 0.92) / 0.06) * Math.PI);   // bolt rack tip, synced to the hand pull
  } else {   // shells
    const { lead, shellMs, shells } = reloadAnim;
    const et = now - reloadAnim.start - lead;
    const idx = Math.floor(et / shellMs);
    if (et >= 0 && idx < shells) {
      const st = (et - idx * shellMs) / shellMs;          // 0..1 within this shell
      // count the round + thunk exactly once per shell, as it seats
      if (st > 0.8 && reloadAnim.loaded === idx) {
        reloadAnim.loaded++;
        ammo[currentWeapon] = Math.min(w.mag, ammo[currentWeapon] + 1);
        sfxRack(340);
        updateAmmoHud();
      }
      if (ud?.shell) ud.shell.visible = st < 0.82;   // seats into the port right as the hand arrives
      // left hand carries each shell from below up to the port
      if (ud?.gripL && ud.gripLRest) {
        const carry = outAndBack(st, 0.72);
        ud.gripL.position.set(ud.gripLRest.x + carry * 0.02, ud.gripLRest.y - 0.20 + carry * 0.13, ud.gripLRest.z + carry * 0.10);
      }
    }
    if (!reloadAnim.sfx.pump && now >= reloadAnim.pumpAt) {
      reloadAnim.sfx.pump = 1;
      if (ud?.shell) ud.shell.visible = false;
      if (ud?.gripL && ud.gripLRest) ud.gripL.position.copy(ud.gripLRest);
      actionAnim = { start: now, end: reloadAnim.end };   // reuse the pump cycle visual
      sfxRack(210); setTimeout(() => sfxRack(260), 200);
    }
  }
  return rackRot;
}

function setAds(on) {
  if (on) inspectAnim = null;
  const w = WEAPONS[currentWeapon];
  adsActive = on && !!w.ads && !player.dead && !reloading;
  const scoped = adsActive && !!w.scope;
  document.getElementById('scopeOverlay').style.display = scoped ? 'block' : 'none';
  document.getElementById('crosshair').style.display = adsActive ? 'none' : (myId ? 'block' : 'none');
  gunGroup.visible = !scoped;   // scope hides the gun; other weapons raise to center (viewmodel lerp)
}

function switchWeapon(n, manual = false) {
  if (manual && roomMode === 'gungame') return;   // gun game: the ladder picks your gun
  if (!WEAPONS[n] || n === currentWeapon) return;
  cancelReload();
  setAds(false);
  currentWeapon = n;
  for (const k in weaponModels) weaponModels[k].visible = Number(k) === n;
  // draw personality: deagle flicks in fast with a wrist snap, shotgun/sniper shoulder
  // with a heavy two-beat, rifle does a chamber-check tilt when it hasn't been out in 20s
  {
    const nowD = performance.now();
    const styles = { 1: { ms: 340 }, 2: { ms: 470, heavy: 1 }, 3: { ms: 470, heavy: 1 }, 4: { ms: 250, snap: 1 } };
    const st = { ...(styles[currentWeapon] || { ms: 340 }) };
    switchWeapon._drawn = switchWeapon._drawn || {};
    if (currentWeapon === 1 && nowD - (switchWeapon._drawn[1] || 0) > 20000) { st.ms = 680; st.check = 1; }
    switchWeapon._drawn[currentWeapon] = nowD;
    drawAnim = { start: nowD, end: nowD + st.ms, style: st };
  }
  inspectAnim = null;
  sfxRack(700);
  sfx(500 + n * 120, 0.06, 'sine', 0.06);
  updateWeaponHud();
  updateAmmoHud();
}

// ---------------- movement & collision ----------------
function collideAABBs(pos) {
  // push player out of obstacle AABBs (XZ only, plus standing on top)
  // returns the wall normal if we're pressed against a wall, else null
  let wallNormal = null;
  for (const ob of obstacles) {
    // allow standing on low obstacles
    if (pos.y >= ob.max.y - 0.01) continue;
    if (pos.y + 1.7 <= ob.min.y) continue;

    const closestX = Math.max(ob.min.x, Math.min(pos.x, ob.max.x));
    const closestZ = Math.max(ob.min.z, Math.min(pos.z, ob.max.z));
    const dx = pos.x - closestX;
    const dz = pos.z - closestZ;
    const distSq = dx * dx + dz * dz;
    // STAIR FIX (frame-rate independent): ledges within stepping height of the feet
    // use a tiny collision radius, so the player's center can get close enough for
    // groundHeightAt's lift (reach 0.5*R beyond the face) to engage. Previously,
    // climbing depended on per-frame penetration depth — at high fps (small moves
    // per frame) collision held the player outside the lift's reach and stairs
    // behaved like walls.
    const steppable = player.onGround && ob.max.y - pos.y <= 0.52 && ob.max.y > pos.y;
    const R = steppable ? 0.05 : PLAYER_RADIUS;
    if (distSq < R * R) {
      if (distSq > 1e-9) {
        const dist = Math.sqrt(distSq);
        const push = R - dist;
        pos.x += (dx / dist) * push;
        pos.z += (dz / dist) * push;
        if (!steppable) wallNormal = new THREE.Vector3(dx / dist, 0, dz / dist);
      } else {
        // inside the box: push out along smallest axis
        const pushL = pos.x - ob.min.x + PLAYER_RADIUS;
        const pushR = ob.max.x - pos.x + PLAYER_RADIUS;
        const pushB = pos.z - ob.min.z + PLAYER_RADIUS;
        const pushF = ob.max.z - pos.z + PLAYER_RADIUS;
        const m = Math.min(pushL, pushR, pushB, pushF);
        if (m === pushL) { pos.x = ob.min.x - PLAYER_RADIUS; wallNormal = new THREE.Vector3(-1, 0, 0); }
        else if (m === pushR) { pos.x = ob.max.x + PLAYER_RADIUS; wallNormal = new THREE.Vector3(1, 0, 0); }
        else if (m === pushB) { pos.z = ob.min.z - PLAYER_RADIUS; wallNormal = new THREE.Vector3(0, 0, -1); }
        else { pos.z = ob.max.z + PLAYER_RADIUS; wallNormal = new THREE.Vector3(0, 0, 1); }
      }
    }
  }
  // arena bounds (perimeter walls count for gliding too)
  const B = getMapBounds();
  if (pos.x < -B.x + PLAYER_RADIUS) { pos.x = -B.x + PLAYER_RADIUS; wallNormal = new THREE.Vector3(1, 0, 0); }
  if (pos.x > B.x - PLAYER_RADIUS) { pos.x = B.x - PLAYER_RADIUS; wallNormal = new THREE.Vector3(-1, 0, 0); }
  if (pos.z < -B.z + PLAYER_RADIUS) { pos.z = -B.z + PLAYER_RADIUS; wallNormal = new THREE.Vector3(0, 0, 1); }
  if (pos.z > B.z - PLAYER_RADIUS) { pos.z = B.z - PLAYER_RADIUS; wallNormal = new THREE.Vector3(0, 0, -1); }
  return wallNormal;
}

function groundHeightAt(x, z) {
  let h = 0;
  for (const ob of obstacles) {
    if (x > ob.min.x - PLAYER_RADIUS * 0.5 && x < ob.max.x + PLAYER_RADIUS * 0.5 &&
        z > ob.min.z - PLAYER_RADIUS * 0.5 && z < ob.max.z + PLAYER_RADIUS * 0.5) {
      if (ob.max.y <= player.pos.y + 0.5) h = Math.max(h, ob.max.y);
    }
  }
  return h;
}

function updatePlayer(dt) {
  if (photoMode) {
    camera.position.set(player.pos.x, player.pos.y + EYE_HEIGHT, player.pos.z);
    camera.rotation.set(0, 0, 0);
    camera.rotateY(player.yaw);
    camera.rotateX(player.pitch);
    return;
  }
  if (player.dead) return;

  const forward = new THREE.Vector3(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
  const right = new THREE.Vector3(-forward.z, 0, forward.x);

  const move = new THREE.Vector3();
  if (keys['KeyW']) move.add(forward);
  if (keys['KeyS']) move.sub(forward);
  if (keys['KeyD']) move.add(right);
  if (keys['KeyA']) move.sub(right);
  if (move.lengthSq() > 0) move.normalize();

  const nowMs = performance.now();

  // slide: burst of ground momentum, lowers the camera, 2s cooldown.
  // CHAINING: landing from a slide-jump and sliding again within 1.2s stacks bonus speed
  // (up to 3 links) — the Krunker loop: slide -> jump -> land -> slide, faster each link.
  if (queueSlide) {
    queueSlide = false;
    if (player.onGround && move.lengthSq() > 0 && nowMs - lastSlideAt > 2000) {
      lastSlideAt = nowMs;
      slideUntil = nowMs + 450;
      const chainAlive = nowMs - (player.slideJumpLandAt || -1e9) < 1200;
      player.slideChain = chainAlive ? Math.min((player.slideChain || 0) + 1, 3) : 0;
      player.knock.addScaledVector(move, 11 + player.slideChain * 2);
      const cap = 19 + player.slideChain * 2;
      if (player.knock.length() > cap) player.knock.setLength(cap);
      sfx(140 + player.slideChain * 30, 0.28, 'sawtooth', 0.09);
    }
  }

  const boost = nowMs < speedBoostUntil ? 1.25 : 1;
  const speed = MOVE_SPEED * boost * (keys['ShiftLeft'] || keys['ShiftRight'] ? SPRINT_MULT : 1);
  player.pos.x += move.x * speed * dt;
  player.pos.z += move.z * speed * dt;

  // local footsteps: stride is distance-based so cadence tracks actual speed.
  // Own steps are quiet — they're feel, not information.
  if (player.onGround && move.lengthSq() > 0 && nowMs > slideUntil) {
    const sprintingNow = keys['ShiftLeft'] || keys['ShiftRight'];
    player.strideAcc = (player.strideAcc || 0) + speed * dt;
    if (player.strideAcc > (sprintingNow ? 2.6 : 2.1)) {
      player.strideAcc = 0;
      sfxFootstep(0.022, sprintingNow);
    }
  } else player.strideAcc = 0;

  // momentum (wall-jump boosts) — decays slowly in air, fast on ground: keep the speed alive while airborne
  player.pos.x += player.knock.x * dt;
  player.pos.z += player.knock.z * dt;
  player.knock.multiplyScalar(Math.max(0, 1 - dt * (player.onGround ? 6 : 1.2)));

  // jump / wall jump (player.wallNormal comes from last frame's collision)
  const ground = groundHeightAt(player.pos.x, player.pos.z);
  if (jumpQueued) {
    if (player.onGround) {
      player.vel.y = JUMP_VEL;
      player.onGround = false;
      // slide-jump: hopping out of an active slide keeps the burst alive (knock decays
      // 5x slower airborne) and slightly extends it forward — momentum carries through the air
      if (nowMs < slideUntil) {
        slideUntil = nowMs;                          // stand the camera back up
        lastSlideAt = nowMs - 1500;                  // shorten cooldown so the next link flows
        player.slideJumped = true;
        if (move.lengthSq() > 0) player.knock.addScaledVector(move, 1.5);
        const cap = 20 + (player.slideChain || 0) * 1.5;
        if (player.knock.length() > cap) player.knock.setLength(cap);
      }
    } else if (player.wallNormal && (player.wallHops || 0) < 2 && performance.now() - (player.lastWallJump || 0) > 200) {
      // BO3-style: kick off the wall AND convert it into forward speed; chains build momentum.
      // wallHops: max 2 jumps per wall contact — resets on landing or grabbing a fresh wall,
      // so chimney chains work but no wall can be climbed forever
      const now = performance.now();
      player.wallChain = (now - (player.lastWallJump || 0) < 1600) ? Math.min((player.wallChain || 0) + 1, 3) : 0;
      player.lastWallJump = now;
      player.wallHops = (player.wallHops || 0) + 1;
      player.vel.y = JUMP_VEL * 0.95;
      const dir = move.lengthSq() > 0 ? move.clone() : forward.clone();
      player.knock.copy(player.wallNormal).multiplyScalar(6)
        .addScaledVector(dir, 8 + player.wallChain * 2.5);
      player.knock.y = 0;
      if (player.knock.length() > 19) player.knock.setLength(19);
      sfx(700 + player.wallChain * 120, 0.1, 'triangle', 0.07);
    }
    jumpQueued = false;
  }

  player.vel.y -= GRAVITY * dt;

  // wall glide / wall RUN: hugging a wall while falling slows the descent;
  // holding W while on the wall = wall run (even slower fall + speed builds along the wall)
  player.wallSliding = false;
  if (!player.onGround && player.wallNormal && player.vel.y < 0) {
    const wallRunning = keys['KeyW'];
    const cap = wallRunning ? -1.2 : WALL_GLIDE_FALL;
    if (player.vel.y < cap) player.vel.y = cap;
    player.wallSliding = true;
    if (wallRunning) {
      // accelerate along the wall plane
      const along = forward.clone().addScaledVector(player.wallNormal, -forward.dot(player.wallNormal));
      if (along.lengthSq() > 0.01) {
        player.knock.addScaledVector(along.normalize(), dt * 14);
        if (player.knock.length() > 14) player.knock.setLength(14);
      }
    }
  }

  player.pos.y += player.vel.y * dt;

  if (player.pos.y <= ground) {
    // landing — no fall damage (jump off anything freely); heavy landings just thud
    if (!player.onGround && -player.vel.y > 13.5) sfx(90, 0.2, 'sawtooth', 0.1);
    if (!player.onGround && player.slideJumped) {   // chain window opens on touchdown
      player.slideJumped = false;
      player.slideJumpLandAt = performance.now();
    }
    player.pos.y = ground;
    player.vel.y = 0;
    player.onGround = true;
  } else if (player.pos.y > ground + 0.02) {
    player.onGround = false;
  }

  const wn = collideAABBs(player.pos);
  // polygon containment (range map): if outside the boundary, pull back toward the map center.
  // Frame-rate independent — no wall can be tunneled because the test is on position, not surfaces.
  if (mapBoundaryPoly) {
    const P = mapBoundaryPoly;
    let inside = false;
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
      if ((P[i][1] > player.pos.z) !== (P[j][1] > player.pos.z) &&
          player.pos.x < (P[j][0] - P[i][0]) * (player.pos.z - P[i][1]) / (P[j][1] - P[i][1]) + P[i][0]) inside = !inside;
    }
    if (!inside) {
      // hard revert to the last known inside position — cannot be outrun at any frame rate
      if (player.lastInside) {
        player.pos.x = player.lastInside.x;
        player.pos.z = player.lastInside.z;
      } else {
        player.pos.x = 1.0; player.pos.z = 2.2;   // fallback: map center
      }
      player.vel.x = 0; player.vel.z = 0;
    } else {
      player.lastInside = { x: player.pos.x, z: player.pos.z };
    }
  }
  // reset wall hops on FRESH wall contact (after leaving a wall) or on landing
  if ((wn && !player.wallNormal) || player.onGround) player.wallHops = 0;
  player.wallNormal = wn;

  // camera height dips during a slide
  const targetEye = nowMs < slideUntil ? 0.95 : EYE_HEIGHT;
  player.eyeH += (targetEye - player.eyeH) * Math.min(1, dt * 10);

  camera.position.set(player.pos.x, player.pos.y + player.eyeH, player.pos.z);
  camera.rotation.set(0, 0, 0);
  camera.rotateY(player.yaw + recoilYaw);
  camera.rotateX(Math.min(1.45, player.pitch + recoilPitch));

  // camera roll: eased instead of binary — leans into slides/wall-runs, settles out smoothly.
  // Damage tilt: the camera kicks AWAY from the hit direction so you feel where it came from.
  {
    const rollTarget = (player.wallSliding ? 0.04 : 0) + (nowMs < slideUntil ? -0.06 : 0);
    player.camRoll = (player.camRoll || 0) + (rollTarget - (player.camRoll || 0)) * Math.min(1, dt * 10);
    player.dmgTilt = (player.dmgTilt || 0) * Math.max(0, 1 - dt * 6);
    const totalRoll = player.camRoll + player.dmgTilt;
    if (Math.abs(totalRoll) > 0.0004) camera.rotateZ(totalRoll);
  }

  playerMoving = move.lengthSq() > 0;
  const wantSprint = (keys['ShiftLeft'] || keys['ShiftRight']) && playerMoving && !adsActive && !player.dead && !reloading
    && nowMs > (shoot.sprintSuppressUntil || 0);   // firing cancels sprint (CoD sprint-out)
  if (sprinting && !wantSprint) sprintEndAt = performance.now();
  sprinting = wantSprint;
}

// ---------------- networking ----------------
let ws = null;
// Nemesis AI view (?spectate=1): an invisible observer rides along in the bot's eyes and sees
// where each aim model thinks the target will be. Gray = naive, yellow = lead, green = learned.
const AIPOV_Q = new URLSearchParams(location.search);
const AIPOV = window.__aipov = { demo: AIPOV_Q.get('demo') === '1', on: AIPOV_Q.get('spectate') === '1' || AIPOV_Q.get('demo') === '1', data: null, at: 0, markers: null, cam: null, look: null };
if (AIPOV.on) document.body.classList.add('aipov');
const AIPOV_COLORS = { naive: 0xaaaaaa, lead: 0xf0c83c, learned: 0x50dc78 };
function aiPovSetup() {
  if (AIPOV.markers) return;
  document.body.classList.add('aipov');
  AIPOV.markers = {};
  for (const k of ['naive', 'lead', 'learned']) {
    const g = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: AIPOV_COLORS[k], transparent: true, opacity: 0.35, depthTest: false });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(PLAYER_RADIUS, 0.9, 4, 10), mat);
    body.position.y = 0.9; body.renderOrder = 999;
    const ringMat = new THREE.MeshBasicMaterial({ color: AIPOV_COLORS[k], transparent: true, opacity: 0.9, depthTest: false, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.62, 32), ringMat);
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.05; ring.renderOrder = 999;
    g.add(body, ring);
    g.traverse((o) => { o.raycast = () => {}; });
    scene.add(g);
    AIPOV.markers[k] = g;
  }
  const lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
  AIPOV.line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0xff5544, transparent: true, opacity: 0.8, depthTest: false }));
  AIPOV.line.renderOrder = 999; AIPOV.line.raycast = () => {};
  scene.add(AIPOV.line);
  const shotMat = new THREE.MeshBasicMaterial({ color: 0xff3322, transparent: true, opacity: 0.9, depthTest: false });
  AIPOV.shot = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 12), shotMat);
  AIPOV.shot.renderOrder = 1000; AIPOV.shot.raycast = () => {};
  scene.add(AIPOV.shot);
  // where the bot is heading (cover spot, peek spot, or the predicted position it is hunting)
  const goalMat = new THREE.MeshBasicMaterial({ color: 0x55aaff, transparent: true, opacity: 0.85, depthTest: false });
  AIPOV.goal = new THREE.Mesh(new THREE.OctahedronGeometry(0.35), goalMat);
  AIPOV.goal.renderOrder = 1000; AIPOV.goal.raycast = () => {};
  scene.add(AIPOV.goal);
}
// Camera modes for watching a bot: [V] cycles WORLD (free camera) -> 3RD PERSON (over its shoulder) -> 1ST PERSON (its eyes).
const AIPOV_MODES = ['third', 'first', 'world'];
const AIPOV_MODE_TEXT = { third: '3RD PERSON', first: '1ST PERSON (bot eyes)', world: 'WORLD (free camera)' };
AIPOV.camMode = AIPOV_MODES.includes(AIPOV_Q.get('cam')) ? AIPOV_Q.get('cam') : 'third';
AIPOV.fly = { pos: null, yaw: 0, pitch: -0.9, keys: {}, drag: false };
AIPOV.showLearned = true;
function aiPovKeys(e, down) {
  if (!AIPOV.on) return;
  AIPOV.fly.keys[e.code] = down;
  if (!down || e.repeat) return;
  if (e.code === 'KeyV') {
    AIPOV.camMode = AIPOV_MODES[(AIPOV_MODES.indexOf(AIPOV.camMode) + 1) % AIPOV_MODES.length];
    AIPOV.cam = null; AIPOV.look = null;
    if (AIPOV.camMode === 'world') AIPOV.fly.pos = null;
    showSensToast(`CAMERA: ${AIPOV_MODE_TEXT[AIPOV.camMode]}`);
  }
  if (e.code === 'KeyM' && AIPOV.demo) send({ t: 'nemesismap' });
  if (e.code === 'KeyK' && AIPOV.demo) send({ t: 'nemesisskill' });
  if (e.code === 'KeyL') AIPOV.showLearned = !AIPOV.showLearned;
  if (e.code === 'KeyH') AIPOV.hudSize = ((AIPOV.hudSize || 0) + 1) % 3;   // full -> small -> hidden
}
addEventListener('keydown', (e) => aiPovKeys(e, true));
addEventListener('keyup', (e) => aiPovKeys(e, false));
addEventListener('mousedown', (e) => { if (AIPOV.on && AIPOV.camMode === 'world') AIPOV.fly.drag = true; });
addEventListener('mouseup', () => { AIPOV.fly.drag = false; });
addEventListener('mousemove', (e) => {
  if (!AIPOV.on || AIPOV.camMode !== 'world' || !AIPOV.fly.drag) return;
  AIPOV.fly.yaw -= e.movementX * 0.004;
  AIPOV.fly.pitch = Math.max(-1.5, Math.min(1.2, AIPOV.fly.pitch - e.movementY * 0.004));
});
function aiPovOverlays() {
  if (AIPOV.route) return;
  AIPOV.route = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x55ddff, transparent: true, opacity: 0.9, depthTest: false }));
  AIPOV.route.renderOrder = 998; AIPOV.route.raycast = () => {}; AIPOV.route.frustumCulled = false;
  scene.add(AIPOV.route);
  const tile = new THREE.PlaneGeometry(1.8, 1.8).rotateX(-Math.PI / 2);
  const mk = (n, col) => {
    const m = new THREE.InstancedMesh(tile, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.32, depthWrite: false }), n);
    m.count = 0; m.renderOrder = 997; m.raycast = () => {}; m.frustumCulled = false; scene.add(m); return m;
  };
  AIPOV.heat = mk(80, 0xffcc33);     // where the player usually goes
  AIPOV.danger = mk(30, 0xff3344);   // where the bot died
  AIPOV.threats = [];
  for (let i = 0; i < 6; i++) {
    const t = new THREE.Mesh(new THREE.ConeGeometry(0.35, 0.8, 4).rotateX(Math.PI), new THREE.MeshBasicMaterial({ color: 0xff3344, depthTest: false, transparent: true, opacity: 0.85 }));
    t.visible = false; t.renderOrder = 1000; t.raycast = () => {}; scene.add(t); AIPOV.threats.push(t);
  }
  AIPOV.cross = document.createElement('div');
  AIPOV.cross.style.cssText = 'position:fixed;left:50%;top:50%;width:22px;height:22px;margin:-11px 0 0 -11px;border:2px solid #ff5544;border-radius:50%;pointer-events:none;display:none;z-index:50;box-shadow:0 0 6px #000';
  document.body.appendChild(AIPOV.cross);
}
function aiPovLearned(d) {
  const L = d.learned;
  if (!L) return;
  const m4 = new THREE.Matrix4();
  const fill = (mesh, cells) => {
    const max = Math.max(1e-3, ...cells.map((c) => c[3]));
    mesh.count = Math.min(cells.length, mesh.instanceMatrix.count);
    for (let i = 0; i < mesh.count; i++) {
      const c = cells[i], k = 0.35 + 0.65 * (c[3] / max);
      m4.makeScale(k, 1, k).setPosition(c[0], c[1] + 0.06, c[2]);
      mesh.setMatrixAt(i, m4);
    }
    mesh.instanceMatrix.needsUpdate = true;
  };
  fill(AIPOV.heat, L.heat || []);
  fill(AIPOV.danger, L.danger || []);
  AIPOV.threatPts = L.threats || [];
}
function aiPovUpdate(dt) {
  const d = AIPOV.data;
  if (!AIPOV.on || !d) return;
  aiPovSetup();
  aiPovOverlays();
  if (d.learned && d.learned !== AIPOV.lastLearned) { AIPOV.lastLearned = d.learned; aiPovLearned(d); }
  const mode = AIPOV.camMode;
  const bot = remotes.get(d.botId);
  const tgt = d.targetId ? remotes.get(d.targetId) : null;
  for (const r of remotes.values()) r.group.visible = !r.dead;
  if (bot) bot.group.traverse((o) => { if (o.isSprite) o.visible = mode === 'world'; });
  const botPos = bot ? bot.group.position.clone() : new THREE.Vector3().fromArray(d.botPos);
  const tgtPos = tgt ? tgt.group.position.clone() : null;
  const head = botPos.clone().add(new THREE.Vector3(0, 1.7, 0));
  const k = 1 - Math.exp(-dt * 10);
  if (mode === 'first') {
    // through the bot's eyes: its real yaw/pitch, as the server sees it
    const yaw = d.botRy || 0, pitch = d.botPitch || 0;
    const eye = botPos.clone().add(new THREE.Vector3(0, d.botFlags && d.botFlags.sl ? 0.9 : 1.62, 0));
    const dir = new THREE.Vector3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
    AIPOV.cam = AIPOV.cam ? AIPOV.cam.lerp(eye, 1 - Math.exp(-dt * 25)) : eye;
    const lookAt = AIPOV.cam.clone().add(dir);
    AIPOV.look = AIPOV.look ? AIPOV.look.lerp(lookAt, 1 - Math.exp(-dt * 18)) : lookAt;
    if (bot) bot.group.visible = false;
  } else if (mode === 'world') {
    // free camera: WASD move, Q/E down/up, Shift fast, hold the mouse button and drag to look
    const f = AIPOV.fly;
    if (!f.pos) { f.pos = botPos.clone().add(new THREE.Vector3(0, 22, 18)); f.yaw = 0; f.pitch = -0.85; }
    const sp = (f.keys.ShiftLeft || f.keys.ShiftRight ? 40 : 14) * dt;
    const fw = new THREE.Vector3(-Math.sin(f.yaw), 0, -Math.cos(f.yaw)), rt = new THREE.Vector3(Math.cos(f.yaw), 0, -Math.sin(f.yaw));
    if (f.keys.KeyW) f.pos.addScaledVector(fw, sp);
    if (f.keys.KeyS) f.pos.addScaledVector(fw, -sp);
    if (f.keys.KeyD) f.pos.addScaledVector(rt, sp);
    if (f.keys.KeyA) f.pos.addScaledVector(rt, -sp);
    if (f.keys.KeyE || f.keys.Space) f.pos.y += sp;
    if (f.keys.KeyQ) f.pos.y -= sp;
    AIPOV.cam = f.pos.clone();
    AIPOV.look = f.pos.clone().add(new THREE.Vector3(-Math.sin(f.yaw) * Math.cos(f.pitch), Math.sin(f.pitch), -Math.cos(f.yaw) * Math.cos(f.pitch)));
  } else {
    // over the bot's shoulder, looking at its target (or where it is heading)
    let aimPt = tgtPos;
    if (!aimPt || !d.los) {
      const yaw = d.botRy || 0;
      aimPt = botPos.clone().add(new THREE.Vector3(-Math.sin(yaw) * 6, 0, -Math.cos(yaw) * 6));
    }
    const fwd = aimPt.clone().sub(botPos).setY(0);
    if (fwd.lengthSq() < 1e-4) fwd.set(0, 0, -1);
    fwd.normalize();
    let eye = botPos.clone().addScaledVector(fwd, -3).add(new THREE.Vector3(0.8 * fwd.z, 3.1, -0.8 * fwd.x));
    const back = eye.clone().sub(head), backLen = back.length();
    raycaster.set(head, back.normalize());
    raycaster.far = backLen;
    const hitWall = raycaster.intersectObjects(obstacles.map((ob) => ob.mesh), false)[0];
    if (hitWall) eye = head.clone().addScaledVector(back, Math.max(0.2, hitWall.distance - 0.35));
    if (bot) bot.group.visible = !bot.dead && eye.distanceTo(head) > 1.3;
    const lookAt = aimPt.clone().add(new THREE.Vector3(0, 1.0, 0));
    AIPOV.cam = AIPOV.cam ? AIPOV.cam.lerp(eye, k) : eye;
    AIPOV.look = AIPOV.look ? AIPOV.look.lerp(lookAt, 1 - Math.exp(-dt * 6)) : lookAt;
  }
  camera.position.copy(AIPOV.cam);
  camera.up.set(0, 1, 0);
  camera.lookAt(AIPOV.look);
  gunGroup.visible = false;
  AIPOV.cross.style.display = mode === 'first' ? 'block' : 'none';

  const y = tgt ? tgt.group.position.y : 0;
  for (const m of ['naive', 'lead', 'learned']) {
    const g = AIPOV.markers[m];
    const p = d.predictions && d.predictions[m];
    g.visible = !!p && !!tgt && !tgt.dead && mode !== 'first';
    if (!p) continue;
    g.position.lerp(new THREE.Vector3(p[0], y, p[1]), g.userData.placed ? 1 - Math.exp(-dt * 12) : 1);
    g.userData.placed = true;
    const active = m === d.mode;
    g.children[0].material.opacity = active ? 0.5 : 0.18;
    g.children[1].material.opacity = active ? 1 : 0.45;
  }
  const act = AIPOV.markers[d.mode];
  AIPOV.line.visible = !!(act && act.visible);
  if (AIPOV.line.visible) AIPOV.line.geometry.setFromPoints([botPos.clone().add(new THREE.Vector3(0, 1.6, 0)), act.position.clone().add(new THREE.Vector3(0, 1.1, 0))]);
  // the route the bot planned (A* over the map), from its feet to its goal
  const pts = [botPos.clone().add(new THREE.Vector3(0, 0.15, 0))].concat((d.route || []).map((p) => new THREE.Vector3(p[0], p[1] + 0.15, p[2])));
  AIPOV.route.visible = pts.length > 1 && mode !== 'first';
  if (AIPOV.route.visible) AIPOV.route.geometry.setFromPoints(pts);
  AIPOV.goal.visible = !!d.botGoal && mode !== 'first';
  if (AIPOV.goal.visible) {
    const last = d.route && d.route.length ? d.route[d.route.length - 1] : null;
    AIPOV.goal.position.set(d.botGoal[0], (last ? last[1] : 0) + 1.2 + Math.sin(performance.now() / 250) * 0.15, d.botGoal[1]);
    AIPOV.goal.rotation.y += dt * 2;
    AIPOV.goal.material.color.setHex(d.botState === 'hunt' || d.botState === 'search' ? 0xff9933 : d.botState === 'patrol' ? 0xffcc33 : 0x55aaff);
  }
  AIPOV.shot.visible = !!d.lastShot;
  if (d.lastShot) AIPOV.shot.position.set(d.lastShot.aim[0], y + 1.2, d.lastShot.aim[1]);
  const showL = AIPOV.showLearned && d.learn !== false;
  AIPOV.heat.visible = showL && mode !== 'first';
  AIPOV.danger.visible = showL && mode !== 'first';
  AIPOV.threats.forEach((t, i) => {
    const p = (AIPOV.threatPts || [])[i];
    t.visible = showL && !!p;
    if (p) t.position.set(p[0], p[1] + 2.6 + Math.sin(performance.now() / 300 + i) * 0.15, p[2]);
  });
  aiPovHud(d, bot);
}
function aiPovHud(d, bot) {
  const el = document.getElementById('aiPovHud');
  if (!el) return;
  const size = AIPOV.hudSize || 0;
  el.style.visibility = size === 2 ? 'hidden' : 'visible';
  el.style.fontSize = '11px'; el.style.lineHeight = '1.35'; el.style.padding = '8px 12px'; el.style.maxWidth = '560px';
  const er = d.err || {}, st = d.stats || {};
  const rate = (m) => { const x = st[m] || { shots: 0, hits: 0 }; return x.shots ? `${Math.round(100 * x.hits / x.shots)}% (${x.hits}/${x.shots})` : '--'; };
  const name = bot ? bot.name : 'BOT';
  const STATE_TEXT = {
    engage: ['FIGHTING', '#ff7766', 'strafing, keeping its planned range, shooting'],
    flank: ['FLANKING', '#ff99cc', 'sprinting around to a side angle (planned route in cyan)'],
    cover: ['TAKING COVER', '#66aaff', 'running to a spot the player cannot see'],
    hold: ['IN COVER', '#66aaff', 'waiting before it peeks'],
    peek: ['PEEKING', '#66aaff', 'stepping out pre-aimed at the last known spot'],
    hunt: ['HUNTING', '#ffaa44', 'lost sight: going where the model PREDICTS the player went'],
    search: ['SEARCHING', '#ffaa44', 'checking spots the player likes (yellow tiles)'],
    patrol: ['PATROLLING', '#9ab', d.learn === false ? 'roaming the map' : 'roaming toward places this player usually goes'],
  };
  const st0 = STATE_TEXT[d.botState] || STATE_TEXT.patrol;
  const f = d.botFlags || {};
  const WN = { 1: 'RIFLE', 2: 'SHOTGUN', 3: 'SNIPER', 4: 'DEAGLE' };
  const chips = [f.spr && 'SPRINT', f.sl && 'SLIDE', f.air && 'JUMP'].filter(Boolean).map((x) => `<b style="color:#000;background:#5df;padding:0 4px;border-radius:3px">${x}</b>`).join(' ');
  const LV = { beginner: '#7f7', average: '#fc4', expert: '#f66' };
  const head = `<div style="font-size:14px;letter-spacing:2px;color:#ff6655">AI VIEW &middot; ${name} <span style="font-size:10px;color:#9ab;letter-spacing:1px">v0.${d.version === 1 ? 1 : 2}${d.learn === false ? ' (learning off)' : ''} &middot; ${(d.map || '').toUpperCase()} &middot; camera ${AIPOV_MODE_TEXT[AIPOV.camMode]}</span></div>`;
  const stateLine = `<div style="margin-top:4px">bot is <b style="color:${st0[1]}">${st0[0]}</b> <span style="color:#9ab">&middot; ${st0[2]}</span></div>`
    + `<div>weapon <b>${WN[f.w] || '--'}</b> ${chips}${d.plan ? ` &middot; plan <b>${d.plan.toUpperCase()}</b>` : ''}${d.score ? ` &middot; life ${d.score.lives} (${d.lifeSecs || 0}s) &middot; K ${d.score.kills} / D ${d.score.deaths}` : ''}</div>`;
  const keys = `<div style="color:#9ab;font-size:11px;margin-top:6px">[V] camera &middot; [L] learned map &middot; [H] panel size${AIPOV.demo ? ' &middot; [M] next map &middot; [K] player skill &middot; [B] strafe style' : ''} &middot; [N] aim mode &middot; [Shift+N] forget player${AIPOV.camMode === 'world' ? '<br>world camera: WASD move, Q/E down/up, Shift fast, drag mouse to look' : ''}</div>`;
  if (!d.targetId) {
    el.innerHTML = head + stateLine + `<div style="color:#fc8">no human player in this match yet.</div>`
      + `<div style="color:#9ab">play in another browser WINDOW side by side, or open <b>/cod/?demo=1</b>.</div>` + keys;
    return;
  }
  let learned = '';
  if (d.expertise) {
    const e = d.expertise, h = d.habits || {};
    learned += `<div style="margin-top:6px">player skill: <b style="color:${LV[e.level]}">${e.level.toUpperCase()}</b> <span style="color:#9ab">(score ${e.score === null ? '--' : e.score.toFixed(2)}, ${Math.round(100 * (e.confidence || 0))}% sure)${d.targetSkill ? ` &middot; scripted as ${d.targetSkill}` : ''}</span></div>`;
    learned += `<div style="color:#cde">habits: ${h.speed ?? '--'} m/s &middot; sprints ${h.sprint === null || h.sprint === undefined ? '--' : Math.round(100 * h.sprint) + '%'} &middot; ${h.slidesPerMin ?? '--'} slides/min &middot; ${h.jumpsPerMin ?? '--'} jumps/min &middot; ${h.switchesPerMin ?? '--'} swaps/min &middot; ${h.reversalsPerSec ?? '--'} strafe flips/s</div>`;
    if (d.planTable && d.planTable.length) learned += `<div style="color:#cde">plans that work on this player: ${d.planTable.map((p) => `${p.id} <b>${p.n < 0.05 ? 'untried' : (p.value >= 0 ? '+' : '') + p.value.toFixed(2)}</b>`).join(' &middot; ')}</div>`;
    if (d.lessons && d.lessons.length && size === 0) learned += `<div style="color:#fda;margin-top:3px">${d.lessons.slice(0, 2).map((l) => '&bull; ' + l).join('<br>')}</div>`;
  }
  const line = (m, label, col) => `<div style="color:${col}">${m === d.mode ? '&#9654;' : '&nbsp;&nbsp;'} ${label.padEnd(8, ' ').replace(/ /g, '&nbsp;')} error ${(er[m] || 0).toFixed(2)} m &nbsp; hits ${rate(m)}</div>`;
  if (size === 1) { el.innerHTML = head + stateLine + learned.split('<div style="color:#cde')[0] + keys; return; }
  el.innerHTML = head
    + `<div>target <b>${d.targetName || '--'}</b> &middot; aim <b>${String(d.mode).toUpperCase()}</b> &middot; ${d.los ? '<span style="color:#7f7">can see</span>' : '<span style="color:#f88">no line of sight</span>'}</div>`
    + stateLine + learned
    + `<div style="height:4px"></div>` + line('naive', 'NAIVE', '#bbb') + line('lead', 'LEAD', '#f0c83c') + line('learned', 'LEARNED', '#50dc78')
    + `<div style="color:#9ab;font-size:11px">cyan line = planned route &middot; yellow tiles = where the player goes &middot; red tiles/arrows = where the bot died / was shot from</div>`
    + keys;
}

// Nemesis panel: how well each aim model predicts where you will be (server-side, per player)
let nemesisHudHidden = false;
function renderNemesisHud(m) {
  const el = document.getElementById('nemesisHud');
  if (!el) return;
  el.style.display = nemesisHudHidden ? 'none' : 'block';
  const row = (k, label) => {
    const st = m.stats[k] || { shots: 0, hits: 0 };
    const rate = st.shots ? Math.round(100 * st.hits / st.shots) + '%' : '--';
    const bar = '#'.repeat(Math.min(20, Math.round((m.err[k] || 0) * 4)));
    return `${k === m.mode ? '>' : ' '} ${label.padEnd(8)} err ${(m.err[k] || 0).toFixed(2)}m ${bar.padEnd(20)} hit ${rate} (${st.shots})`;
  };
  el.textContent = `NEMESIS BOT AIM  [N] mode  [Shift+N] reset  [H] hide\n`
    + `predicting where you'll be in ${m.horizon}s  ${m.warm ? 'model trained' : 'model warming up'} (${m.updates} updates, using ${m.choice || 'lead'})\n`
    + [row('naive', 'Naive'), row('lead', 'Lead'), row('learned', 'Learned')].join('\n');
}
function send(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

function connect(action, name, code) {
  const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${wsProto}://${location.host}`);
  ws.onopen = () => send(action === 'create'
    ? { t: 'create', name, ...(AIPOV.demo ? { demo: true, map: AIPOV_Q.get('map') || 'shipment', style: AIPOV_Q.get('style') || 'rhythm', skill: AIPOV_Q.get('skill') || 'average' } : {}) }
    : { t: 'join', name, code, spectate: AIPOV.on });
  ws.onclose = (ev) => {
    if (ev.target.intentional) return;
    document.getElementById('ping').textContent = 'DISCONNECTED — refresh to rejoin';
    document.getElementById('ping').style.color = '#f44';
    document.getElementById('landingError').textContent = 'connection lost — refresh the page';
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    switch (msg.t) {
      case 'error': {
        document.getElementById('landingError').textContent = msg.msg || 'something went wrong';
        ws.intentional = true;
        try { ws.close(); } catch {}
        ws = null;
        break;
      }
      case 'lobby': {
        if (msg.you) myId = msg.you;
        if (msg.backFromMatch) returnToLobby();
        renderLobby(msg);
        break;
      }
      case 'init': {
        myId = msg.id;
        myColor = msg.color;
        inMatch = true;
        roomMode = msg.mode || 'dm';
        buildMap(msg.map || 'districts'); // no-op if already built
        // DARKNESS: process already-dead lights for mid-match joiners
        if (msg.deadLights && msg.deadLights.length) {
          for (const li of msg.deadLights) killMapLight(li, false);
        }
        // DARKNESS: start ambient soundscape for this map
        buildAmbience();
        // clear any remotes from a previous match in this room
        for (const rid of [...remotes.keys()]) removeRemote(rid);
        player.dead = false;
        player.hp = 100;
        player.vel.set(0, 0, 0);
        player.knock.set(0, 0, 0);
        for (const k in ammo) ammo[k] = WEAPONS[k].mag;
        cancelReload();
        player.pos.fromArray(msg.spawn);
        for (const id in msg.players) addRemote(msg.players[id]);
        updateScoreboard(msg.scores);
        if (roomMode === 'gungame') {
          switchWeapon(msg.w || 4);
          updateLadderHud(msg.ladder || 0, msg.ladderLen || 12);
        } else {
          document.getElementById('ladderHud').style.display = 'none';
        }
        startGame();
        break;
      }
      case 'forceweapon': {
        // gun game: your kill advanced the ladder — new gun, full mag
        switchWeapon(msg.w);
        ammo[msg.w] = WEAPONS[msg.w].mag;
        cancelReload();
        updateAmmoHud();
        updateLadderHud(msg.ladder, msg.ladderLen);
        sfx(1200, 0.1, 'sine', 0.1); sfx(1600, 0.12, 'sine', 0.08);
        break;
      }
      case 'joined': {
        addRemote(msg.player);
        killFeed(`${msg.player.name} entered the arena`);
        break;
      }
      case 'left': removeRemote(msg.id); break;
      case 'states': {
        for (const id in msg.players) {
          if (id === myId) continue;
          const r = remotes.get(id);
          if (!r) continue;
          const st = msg.players[id];
          r.targetPos.fromArray(st.pos);
          r.targetRy = st.ry;
          r.aimPitch = st.pitch || 0;
          r.ads = !!st.ads;
          r.fl = !!st.fl;
          if (st.rel && !r.rel) r.reloadAnim = { start: performance.now(), dur: (WEAPONS[st.w || 1] || WEAPONS[1]).reload };
          if (!st.rel) r.reloadAnim = null;
          r.rel = !!st.rel;
          r.sl = !!st.sl;
          if (st.wj && !r.wj) r.wallJumpAt = performance.now();   // edge: trigger the clip once
          r.wj = !!st.wj;
          r.air = !!st.air;
          r.spr = !!st.spr;
          setRemoteWeapon(r, st.w || 1);
        }
        break;
      }
      case 'nemesis': renderNemesisHud(msg); break;
      case 'nemesispov': AIPOV.data = msg; AIPOV.at = performance.now(); break;
      case 'nemesismode': showSensToast(`BOT AIM: ${String(msg.mode).toUpperCase()}`); break;
      case 'nemesisstyle': showSensToast(`TARGET MOVES: ${msg.style === 'random' ? 'RANDOM JUKES' : 'STEADY RHYTHM'}`); break;
      case 'nemesisskill': showSensToast(`PLAYER SKILL: ${String(msg.skill).toUpperCase()} (watch the bot figure it out)`); break;
      case 'shot': {
        const o = new THREE.Vector3().fromArray(msg.origin);
        const d = new THREE.Vector3().fromArray(msg.dir);
        raycaster.set(o, d);
        raycaster.far = 200;
        const wh = raycaster.intersectObjects(obstacles.map(ob => ob.mesh), false);
        const dist = wh.length ? wh[0].distance : 150;
        spawnShot(o.clone().addScaledVector(d, 0.8), d, msg.w || 1, dist);
        if (wh.length) spawnImpact(wh[0].point, (WEAPONS[msg.w] || WEAPONS[1]).tracer.color, wh[0]);
        sfx(660, 0.05, 'square', 0.03);
        // DARKNESS: fire pooled flash light at remote shot origin
        fireMuzzleFlashLight(o);
        break;
      }
      case 'lightout': {
        const li = msg.i;
        if (li >= 0 && li < mapLights.length && mapLights[li].on) {
          killMapLight(li, true);
        }
        break;
      }
      case 'nade': {
        // someone threw a grenade: simulate the same physics locally for visuals;
        // flash blindness is computed on MY end when it pops; frag damage comes via 'hit'
        if (!Array.isArray(msg.pos) || !Array.isArray(msg.vel)) break;
        const kind = msg.kind === 'flash' ? 'flash' : 'frag';
        const fuseLeft = Number.isFinite(msg.fuse) ? Math.min(Math.max(msg.fuse, 120), NADES[kind].fuse) : undefined;
        spawnNade(kind, new THREE.Vector3().fromArray(msg.pos), new THREE.Vector3().fromArray(msg.vel), false, fuseLeft);
        break;
      }
      case 'damage': {
        if (msg.target === myId) {
          const isHurt = msg.hp < player.hp;
          player.hp = msg.hp;
          updateHealth();
          if (isHurt) {
            sfxHurt();
            flashDamage();
            if (msg.from && msg.from !== myId) showDamageDir(msg.from);
          }
        } else {
          const r = remotes.get(msg.target);
          if (r) {
            if (msg.hp < r.hp && !r.dead) r.flinch = 1;   // upper-body jerk on taking a hit
            r.hp = msg.hp;
          }
        }
        break;
      }
      case 'death': {
        const isMe = msg.target === myId;
        killFeedKill(msg.from, msg.fromName, msg.target, msg.targetName, msg.weapon, msg.headshot, msg.fall, msg.weaponName, msg.nade);
        // my kill: heal comes from the server; celebrate + speed boost + streak tracking
        if (msg.from === myId && !isMe && !msg.fall) {
          showHitMarker('kill');
          killPunch = 1;
          const nowMs = performance.now();
          myKillTimes = myKillTimes.filter(t => nowMs - t < 4500);
          myKillTimes.push(nowMs);
          speedBoostUntil = nowMs + 3000;
          const n = myKillTimes.length;
          if (n === 2) announce('DOUBLE KILL');
          else if (n === 3) announce('TRIPLE KILL');
          else if (n === 4) announce('QUAD KILL');
          else if (n >= 5) announce('RAMPAGE', '#f44');
          else announce('+25 HP · SPEED BOOST', '#6f8', true);
          sfx(880 + n * 110, 0.15, 'sine', 0.1);
        }
        if (isMe) {
          player.dead = true;
          player.hp = 0;
          setAds(false);
          cancelReload();
          // died mid-cook: the live grenade DROPS at your feet with its remaining fuse
          if (throwAnim && !throwAnim.released) {
            const a = throwAnim;
            const fuseLeft = Math.max(120, a.fuseAt - performance.now());
            const dropPos = player.pos.clone().add(new THREE.Vector3(0, 0.8, 0));
            const dropVel = new THREE.Vector3((Math.random() - 0.5) * 1.5, 1.2, (Math.random() - 0.5) * 1.5);
            spawnNade(a.kind, dropPos, dropVel, true, fuseLeft);
            send({ t: 'nade', kind: a.kind, pos: dropPos.toArray(), vel: dropVel.toArray(), fuse: Math.round(fuseLeft) });
            setCookingHud(a.kind, false);
            camera.remove(a.vm);
            throwAnim = null;
          }
          // DARKNESS: flashlight clears on death
          flashlightOn = false; flashlightSpot.visible = false; flashlightSpot.intensity = 0;
          updateHealth();
          sfxDeath();
          document.getElementById('deathBy').textContent = msg.fall
            ? 'gravity wins this round — respawning...'
            : msg.nade && msg.from === myId
              ? '💥 cooked by your own grenade — respawning...'
              : `${msg.headshot ? 'headshotted' : 'taken out'} by ${msg.fromName} — respawning...`;
          document.getElementById('deathOverlay').style.display = 'flex';
        } else {
          const r = remotes.get(msg.target);
          if (r) { r.dead = true; playDeathAnim(r); }
        }
        break;
      }
      case 'respawn': {
        if (msg.id === myId) {
          player.dead = false;
          player.hp = msg.hp;
          player.pos.fromArray(msg.pos);
          player.vel.set(0, 0, 0);
          player.knock.set(0, 0, 0);
          for (const k in ammo) ammo[k] = WEAPONS[k].mag;   // respawn with full mags
          resetNades();
          cancelReload();
          updateAmmoHud();
          updateHealth();
          document.getElementById('deathOverlay').style.display = 'none';
        } else {
          const r = remotes.get(msg.id);
          if (r) {
            r.dead = false;
            r.hp = msg.hp;
            r.targetPos.fromArray(msg.pos);
            r.group.position.fromArray(msg.pos);
            r.group.visible = true;
          }
        }
        break;
      }
      case 'scores': updateScoreboard(msg.scores); break;
      case 'matchover': {
        document.getElementById('matchWinner').textContent = `${msg.winnerName} WINS`;
        document.getElementById('matchOverlay').style.display = 'flex';
        document.getElementById('scoreboard').style.display = 'block';
        updateScoreboard(msg.scores);
        sfx(523, 0.25, 'sine', 0.12); sfx(659, 0.25, 'sine', 0.1);
        setTimeout(() => { sfx(784, 0.4, 'sine', 0.12); }, 220);
        break;
      }
      case 'matchreset': {
        document.getElementById('matchOverlay').style.display = 'none';
        document.getElementById('deathOverlay').style.display = 'none';
        document.getElementById('scoreboard').style.display = 'none';
        const me = msg.players[myId];
        if (me) {
          player.pos.fromArray(me.pos);
          player.hp = me.hp;
          player.dead = false;
          player.vel.set(0, 0, 0);
          player.knock.set(0, 0, 0);
          for (const k in ammo) ammo[k] = WEAPONS[k].mag;   // fresh round, full mags
          resetNades();
          clearLiveNades();
          cancelReload();
          updateAmmoHud();
          updateHealth();
        }
        for (const id in msg.players) {
          if (id === myId) continue;
          const r = remotes.get(id);
          if (r) {
            r.dead = false;
            r.hp = 100;
            r.targetPos.fromArray(msg.players[id].pos);
            r.group.position.fromArray(msg.players[id].pos);
            r.group.visible = true;
          }
        }
        myKillTimes = [];
        announce('NEW MATCH — FIRST TO 20', '#4af');
        break;
      }
    }
  };
}

// send my state at fixed rate
setInterval(() => {
  if (!myId || !inMatch || player.dead) return;
  send({ t: 'state', pos: player.pos.toArray(), ry: player.yaw, pitch: player.pitch, w: currentWeapon, ads: adsActive, rel: reloading, fl: flashlightOn,
         sl: performance.now() < slideUntil,                                  // power slide active
         wj: performance.now() - (player.lastWallJump || 0) < 400,            // wall-jump just fired (edge window)
         air: !player.onGround, spr: sprinting });
}, 1000 / STATE_SEND_HZ);

// ---------------- HUD ----------------
function updateHealth() {
  document.getElementById('healthLabel').textContent = `HP ${player.hp}`;
  const fill = document.getElementById('healthFill');
  fill.style.width = player.hp + '%';
  fill.style.background = player.hp > 50
    ? 'linear-gradient(90deg,#2d5,#4f8)'
    : player.hp > 25 ? 'linear-gradient(90deg,#da3,#fc4)' : 'linear-gradient(90deg,#d33,#f55)';
}

function updateScoreboard(scores) {
  const rows = Object.entries(scores)
    .sort((a, b) => b[1].kills - a[1].kills)
    .map(([id, s]) =>
      `<tr><td>${id === myId ? '▶ ' : ''}${esc(s.name)}</td><td class="num">${s.kills} K</td><td class="num">${s.deaths} D</td></tr>`)
    .join('');
  document.getElementById('scoreTable').innerHTML = rows;
}

// red arc at the screen edge pointing toward whoever shot you
function showDamageDir(fromId) {
  const r = remotes.get(fromId);
  if (!r) return;
  const dx = r.group.position.x - player.pos.x;
  const dz = r.group.position.z - player.pos.z;
  const worldAng = Math.atan2(dx, dz);
  const facing = Math.atan2(-Math.sin(player.yaw), -Math.cos(player.yaw));
  const deg = -(worldAng - facing) * 180 / Math.PI;
  // camera kicks away from the hit: right-side hits roll the view left and vice versa
  const rel = ((worldAng - facing + Math.PI) % (Math.PI * 2)) - Math.PI;
  player.dmgTilt = Math.sin(rel) * 0.045;

  const arc = document.createElement('div');
  arc.className = 'dmgArc';
  arc.style.transform = `rotate(${deg}deg) translateY(-165px)`;
  document.getElementById('dmgDirWrap').appendChild(arc);
  setTimeout(() => arc.style.opacity = 0, 500);
  setTimeout(() => arc.remove(), 950);
}

let announceTimer = null;
function announce(text, color = '#ffd700', small = false) {
  const el = document.getElementById('announce');
  el.textContent = text;
  el.style.color = color;
  el.style.fontSize = small ? '18px' : '36px';
  el.style.display = 'block';
  el.style.opacity = 1;
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => el.style.opacity = 0, small ? 1100 : 1700);
}

function updateLadderHud(ladder, len) {
  const el = document.getElementById('ladderHud');
  el.style.display = 'block';
  el.textContent = `GUN GAME  ${ladder + 1} / ${len}`;
}
function updateAmmoHud() {
  const w = WEAPONS[currentWeapon];
  const mag = document.getElementById('ammoMag');
  mag.textContent = ammo[currentWeapon];
  mag.className = ammo[currentWeapon] <= Math.ceil(w.mag * 0.25) ? 'low' : '';
  document.getElementById('reloadLabel').style.display = reloading ? 'block' : 'none';
}

function updateWeaponHud() {
  document.getElementById('weaponHud').innerHTML = WEAPONS
    .filter(Boolean)
    .map((w, i) =>
      `<span class="wslot${i + 1 === currentWeapon ? ' active' : ''}" style="${i + 1 === currentWeapon ? `border-color:#${w.color.toString(16).padStart(6, '0')}` : ''}">${w.key} ${w.name}</span>`)
    .join('');
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

function colorFor(id) {
  if (id === myId) return myColor;
  const r = remotes.get(id);
  return r ? r.color : 0xffffff;
}
const hexCss = (c) => '#' + c.toString(16).padStart(6, '0');

// Valorant-style kill entry: [Killer] [WEAPON ◉] [Victim] — or a fall death
function killFeedKill(fromId, fromName, targetId, targetName, weaponIdx, headshot, fall, weaponName, nade) {
  const div = document.createElement('div');
  if (fall) {
    div.className = 'kfEntry' + (targetId === myId ? ' myDeath' : '');
    div.innerHTML =
      `<span class="kfName" style="color:${hexCss(colorFor(targetId))}">${esc(targetName)}</span>` +
      `<span class="kfWeapon">💀 FELL</span>`;
    addFeedEntry(div, 6000);
    return;
  }
  const w = WEAPONS[weaponIdx];
  const label = weaponName ? `${nade || weaponName === 'GRENADE' || weaponName === 'FLASHBANG' ? '💥 ' : ''}${esc(weaponName)}` : (w ? w.name : 'GUN');
  div.className = 'kfEntry' + (fromId === myId ? ' myKill' : '') + (targetId === myId ? ' myDeath' : '');
  div.innerHTML =
    `<span class="kfName" style="color:${hexCss(colorFor(fromId))}">${esc(fromName)}</span>` +
    `<span class="kfWeapon">${label}${headshot ? ' <span class="kfHead">◉</span>' : ''}</span>` +
    `<span class="kfName" style="color:${hexCss(colorFor(targetId))}">${esc(targetName)}</span>`;
  addFeedEntry(div, 6000);
}

// plain info entry (joins, etc.)
function killFeed(text) {
  const div = document.createElement('div');
  div.className = 'kfInfo';
  div.textContent = text;
  addFeedEntry(div, 4000);
}

function addFeedEntry(div, ttl) {
  const feed = document.getElementById('killFeed');
  feed.prepend(div);                      // newest on top, like Valorant
  while (feed.children.length > 6) feed.lastChild.remove();
  setTimeout(() => { div.classList.add('kfOut'); setTimeout(() => div.remove(), 400); }, ttl);
}

function flashDamage() {
  renderer.domElement.style.filter = 'saturate(2) brightness(1.3) hue-rotate(-20deg)';
  setTimeout(() => renderer.domElement.style.filter = '', 100);
}

// ---------------- join flow ----------------
// photo mode: ?photo=x,y,z,yaw,pitch — free camera for screenshots, no join
let photoMode = false;
{
  const pp = new URLSearchParams(location.search).get('photo');
  if (pp) {
    const mapParam = new URLSearchParams(location.search).get('map');
    if (mapParam) buildMap(mapParam);
    const [px, py, pz, yw, pt] = pp.split(',').map(Number);
    photoMode = true;
    player.pos.set(px || 0, py || 2, pz || 0);
    player.yaw = yw || 0;
    player.pitch = pt || 0;
    document.getElementById('joinOverlay').style.display = 'none';
    // test hook: fire a shot visual from the camera (photo mode only)
    window.__fx = (wIdx) => {
      const o = camera.getWorldPosition(new THREE.Vector3());
      const d = camera.getWorldDirection(new THREE.Vector3());
      raycaster.set(o, d);
      raycaster.far = 250;
      const wh = raycaster.intersectObjects(obstacles.map(ob => ob.mesh), false);
      const dist = wh.length ? wh[0].distance : 150;
      const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
      spawnShot(o.clone().addScaledVector(d, 0.9).addScaledVector(camRight, 0.14).add(new THREE.Vector3(0, -0.12, 0)), d, wIdx, dist);
      if (wh.length) spawnImpact(wh[0].point, WEAPONS[wIdx].tracer.color);
      muzzleFlash.position.z = MUZZLE_Z[wIdx] ?? -0.6;
      muzzleFlash.material.opacity = 1;
      muzzleFlash.scale.setScalar(0.16);
      muzzleLight.intensity = 3;
    };
    window.__hm = showHitMarker;
    window.__obs = () => obstacles.map(o => ({ min: o.min.toArray().map(v => +v.toFixed(1)), max: o.max.toArray().map(v => +v.toFixed(1)) }));
    window.__dmg = (x, y, z, d, h) => spawnDamageNumber(new THREE.Vector3(x, y, z), d, h);
    window.__name = (x, y, z, n) => { const s = makeNameSprite(n || 'ENEMY', 0xff6655); s.position.set(x, y, z); s.raycast = () => {}; scene.add(s); };
    window.__fxDebug = () => effects.map(e => ({ ttl: Number(e.ttl.toFixed(2)), pos: e.obj.position.toArray().map(v => Number(v.toFixed(1))), scale: e.obj.scale.toArray().map(v => Number(v.toFixed(2))) }));
  }
}

document.getElementById('createBtn').addEventListener('click', () => enterRoom('create'));
// Nemesis demo (?demo=1): create a room that starts straight away with a bot and a scripted target
if (AIPOV.demo) setTimeout(() => {
  document.getElementById('nameInput').value = 'VIEWER';
  enterRoom('create');
}, 300);
// shell handoff: /?name=X&create=1 or /?name=X&code=1234 auto-connects past the local landing
{
  const q = new URLSearchParams(location.search);
  const qName = q.get('name');
  if (qName && !q.get('photo')) {
    localStorage.setItem('playerName', qName);   // the game's own prefill reads this after us
    document.getElementById('nameInput').value = qName;
    setTimeout(() => { document.getElementById('nameInput').value = qName; }, 0);
    if (q.get('create')) setTimeout(() => enterRoom('create'), 100);
    else if (q.get('code')) {
      const ci = document.getElementById('codeInput');
      if (ci) ci.value = q.get('code');
      setTimeout(() => enterRoom('join'), 100);
    }
  }
}

document.getElementById('joinBtn').addEventListener('click', () => enterRoom('join'));
document.getElementById('codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') enterRoom('join'); });
document.getElementById('startBtn').addEventListener('click', () => send({ t: 'start' }));
document.getElementById('addBotBtn').addEventListener('click', () => send({ t: 'addbot' }));
document.getElementById('rmBotBtn').addEventListener('click', () => send({ t: 'removebot' }));

// sensitivity UI wiring
document.getElementById('sensJoinSlider').addEventListener('input', (e) => applySens(parseFloat(e.target.value)));
document.getElementById('sensSlider').addEventListener('input', (e) => applySens(parseFloat(e.target.value)));
document.getElementById('adsSensJoinSlider').addEventListener('input', (e) => applyAdsSens(parseFloat(e.target.value)));
document.getElementById('adsSensSlider').addEventListener('input', (e) => applyAdsSens(parseFloat(e.target.value)));
document.getElementById('resumeBtn').addEventListener('click', () => {
  // panel hides via pointerlockchange once the lock actually engages
  try {
    const p = renderer.domElement.requestPointerLock();
    if (p && p.catch) p.catch(() => showSensToast('click again to resume'));
  } catch { showSensToast('click again to resume'); }
});
applySens(sensitivity);   // sync sliders/labels with saved value
applyAdsSens(adsSensMult);

function enterRoom(action) {
  const err = document.getElementById('landingError');
  const nameEl = document.getElementById('nameInput');
  err.textContent = '';
  nameEl.classList.remove('err');
  const name = nameEl.value.trim();
  if (!name) {
    err.textContent = 'enter your name first';
    nameEl.classList.add('err');
    nameEl.focus();
    return;
  }
  localStorage.setItem('labarena_name', name);
  let code = null;
  if (action === 'join') {
    code = document.getElementById('codeInput').value.trim();
    if (!/^\d{4}$/.test(code)) { err.textContent = 'enter the 4-digit room code'; document.getElementById('codeInput').focus(); return; }
  }
  if (ws) { try { ws.close(); } catch {} }
  window.__menuPickApplied = action !== 'create';   // only the creator pushes the menu picks
  connect(action, name, code);
}

// prefill remembered name; clear error styling while typing
document.getElementById('nameInput').value = localStorage.getItem('labarena_name') || '';
document.getElementById('nameInput').addEventListener('input', (e) => {
  e.target.classList.remove('err');
  document.getElementById('landingError').textContent = '';
});

function renderLobby(msg) {
  document.getElementById('landingPanel').style.display = 'none';
  document.getElementById('lobbyPanel').style.display = 'flex';
  document.getElementById('joinOverlay').style.display = 'flex';
  document.getElementById('roomCode').textContent = msg.code;
  const isHost = msg.hostId === myId;
  // apply the mode/map chosen on the PLAY screen (host only, once per room)
  if (isHost && window.__menuPick && !window.__menuPickApplied) {
    window.__menuPickApplied = true;
    if (window.__menuPick.map && window.__menuPick.map !== (msg.map || 'districts')) send({ t: 'setmap', map: window.__menuPick.map });
    if (window.__menuPick.mode && window.__menuPick.mode !== (msg.mode || 'dm')) send({ t: 'setmode', mode: window.__menuPick.mode });
  }
  document.getElementById('startBtn').style.display = isHost ? 'block' : 'none';
  document.getElementById('waitingMsg').style.display = isHost ? 'none' : 'block';

  // map selector: host clicks to pick, everyone sees the selection
  const mapPick = document.getElementById('mapPick');
  mapPick.innerHTML = '';
  const selected = msg.map || 'districts';
  for (const [mid, m] of Object.entries(MAPS)) {
    const card = document.createElement('div');
    card.className = 'mapCard' + (mid === selected ? ' selected' : '') + (isHost ? ' pickable' : '');
    card.innerHTML = `<img class="mImg" src="./previews/${mid}.jpg" alt=""><div class="mBody"><div class="mName">${m.name}</div><div class="mDesc">${m.desc}</div></div>`;
    if (isHost && mid !== selected) card.addEventListener('click', () => send({ t: 'setmap', map: mid }));
    mapPick.appendChild(card);
  }

  // mode selector: DEATHMATCH or GUN GAME (host picks)
  const modePick = document.getElementById('modePick');
  modePick.innerHTML = '';
  const mode = msg.mode || 'dm';
  for (const [mid, label, desc] of [['dm', 'DEATHMATCH', 'first to 20 kills'], ['gungame', 'GUN GAME', 'every kill swaps your gun · finish the ladder']]) {
    const card = document.createElement('div');
    card.className = 'mapCard txt' + (mid === mode ? ' selected' : '') + (isHost ? ' pickable' : '');
    card.innerHTML = `<div class="mBody"><div class="mName">${label}</div><div class="mDesc">${desc}</div></div>`;
    if (isHost && mid !== mode) card.addEventListener('click', () => send({ t: 'setmode', mode: mid }));
    modePick.appendChild(card);
  }

  // AI controls (host only)
  const botCount = msg.players.filter(pl => pl.bot).length;
  document.getElementById('botCtl').style.display = isHost ? 'flex' : 'none';
  document.getElementById('botCount').textContent = botCount ? `${botCount} AI` : '';

  const slots = document.getElementById('slots');
  slots.innerHTML = '';
  for (let i = 0; i < 10; i++) {
    const pl = msg.players[i];
    const div = document.createElement('div');
    div.className = 'slot' + (pl ? ' filled' : '');
    if (pl) {
      div.style.color = hexCss(pl.color);
      div.innerHTML = `${esc(pl.name)}${pl.host ? '<span class="crown">👑</span>' : ''}${pl.bot ? ' <span style="color:#8899bb;font-size:10px">🤖</span>' : ''}`;
    } else {
      div.textContent = 'EMPTY';
    }
    slots.appendChild(div);
  }
}

// after a match ends: tear down game state and show the lobby again
function returnToLobby() {
  inMatch = false;
  document.exitPointerLock?.();
  setAds(false);
  cancelReload();
  player.dead = false;
  myKillTimes = [];
  // DARKNESS: cleanup
  stopAmbience();
  flashlightOn = false; flashlightSpot.visible = false; flashlightSpot.intensity = 0;
  for (const [, spot] of remoteFlashlights) { spot.visible = false; spot.intensity = 0; }
  for (const rid of [...remotes.keys()]) removeRemote(rid);
  for (const el of document.querySelectorAll('.hud')) el.style.display = 'none';
  document.getElementById('killFeed').innerHTML = '';
  document.getElementById('announce').style.opacity = 0;
}

function startGame() {
  document.getElementById('joinOverlay').style.display = 'none';
  const alwaysHidden = new Set(['deathOverlay', 'hitMarker', 'scoreboard', 'settingsPanel', 'sensToast', 'scopeOverlay', 'matchOverlay',
    'ladderHud', 'gpuWarn', 'perfHud']); // mode-specific: their own code shows them
  for (const el of document.querySelectorAll('.hud')) {
    if (!alwaysHidden.has(el.id)) el.style.display = 'block';
  }
  updateHealth();
  updateWeaponHud();
  updateAmmoHud();
  resetNades();
  clearLiveNades();
  renderer.domElement.requestPointerLock();
}

// ---------------- main loop ----------------
const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  const preVelY = player.vel.y;
  updatePlayer(dt);
  if (!wasGrounded && player.onGround) landDip = Math.min(0.15, Math.max(0.04, -preVelY * 0.012));
  wasGrounded = player.onGround;

  // ---- viewmodel & camera animation ----
  // menu cinematic: while the menu/lobby overlay is up, fly a slow orbit over the map
  const inMenu = document.getElementById('joinOverlay').style.display !== 'none';
  if (inMenu) {
    const tM = performance.now() * 0.00006;
    const bnd = getMapBounds();
    const r = Math.max(bnd.x, bnd.z) * 0.62;
    camera.position.set(Math.cos(tM) * r, 13 + Math.sin(tM * 2.7) * 3.5, Math.sin(tM) * r);
    camera.lookAt(Math.sin(tM * 0.5) * 6, 3.5, Math.cos(tM * 0.4) * 6);
    camera.rotation.z += Math.sin(tM * 3.1) * 0.012;   // gentle drift roll
    gunGroup.visible = false;
  } else {
    gunGroup.visible = !photoMode && !(adsActive && WEAPONS[currentWeapon].scope) && !throwAnim;
  }
  // full-auto: keep firing while the trigger is held (shoot() self-gates on cooldown/ammo)
  if (fireHeld && WEAPONS[currentWeapon].auto && !player.dead) shoot();
  // pose target: MW2-style hip (big, close, canted) or the weapon's sight-aligned ADS pose
  const wNow = WEAPONS[currentWeapon];
  const adsPose = adsActive && !wNow.scope && wNow.adsPos;
  const hp = hipPos();
  const baseZ = (adsPose ? wNow.adsPos.z : hp.z) + sprintPose * 0.05;
  // recoil recovery toward the pose's base z; heavy guns fall back slower (kick.recover rate)
  const kickRec = wNow.kick.recover || 10;
  gunGroup.position.z += (baseZ - gunGroup.position.z) * Math.min(1, dt * kickRec * 1.2);
  gunRotKick += (0 - gunRotKick) * Math.min(1, dt * kickRec);
  // camera recoil recovery: only after firing stops (so sprays actually climb), then eases back
  if (performance.now() - (shoot._lastAt || 0) > wNow.cooldown + 60) {
    const rec = (wNow.recovery || 5) * dt;
    recoilPitch += (0 - recoilPitch) * Math.min(1, rec);
    recoilYaw += (0 - recoilYaw) * Math.min(1, rec);
    if (Math.abs(recoilPitch) < 0.0004) recoilPitch = 0;
    if (Math.abs(recoilYaw) < 0.0004) recoilYaw = 0;
  }
  // reload pose: slight dip + yaw so the mag well stays visible while the animation plays
  const reloadRack = updateReloadAnim(performance.now());
  // ---- procedural viewmodel motion: mouse-lag sway, strafe tilt, land dip, breath, sprint carry, draw ----
  const nowVm = performance.now();
  swayImpYaw *= Math.exp(-dt * 7);                     // impulses bleed off → gun eases back
  swayImpPitch *= Math.exp(-dt * 7);
  vmSway.yaw += (swayImpYaw - vmSway.yaw) * Math.min(1, dt * 14);
  vmSway.pitch += (swayImpPitch - vmSway.pitch) * Math.min(1, dt * 14);
  const camRvm = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  const strafeVel = Math.max(-1, Math.min(1, player.vel.dot(camRvm) / 8));
  vmSway.roll += ((-strafeVel * 0.05) - vmSway.roll) * Math.min(1, dt * 8);
  landDip = Math.max(0, landDip - landDip * dt * 6.5 - dt * 0.015);
  // sprint carry eases at 9/s normally, but WHIPS down (22/s with a slight negative overshoot)
  // right after sprint ends — the gun visibly hustles to firing position (CoD sprint-out)
  {
    const snapWin = performance.now() - sprintEndAt < 300 && !sprinting;
    const spTarget = sprinting ? 1 : (snapWin ? -0.05 : 0);
    sprintPose += (spTarget - sprintPose) * Math.min(1, dt * (snapWin ? 22 : 9));
  }
  // wall tuck: muzzle poking into a wall pulls the gun up and in (throttled forward probe)
  if (nowVm - (vmSway.tuckCheckAt || 0) > 90) {
    vmSway.tuckCheckAt = nowVm;
    tuckRay.set(camera.position, camera.getWorldDirection(tuckDir));
    tuckRay.far = 1.0;
    const hit = tuckRay.intersectObjects(obstacles.map(ob => ob.mesh), false)[0];
    vmSway.tuckTarget = hit ? Math.min(1, (1.0 - hit.distance) / 0.55) : 0;
  }
  vmSway.tuck = (vmSway.tuck || 0) + ((vmSway.tuckTarget || 0) - (vmSway.tuck || 0)) * Math.min(1, dt * 8);
  // idle fidget: stand still ~9s and the hands do a small unprompted weapon adjust
  if (playerMoving || adsActive || reloading || nowVm - lastShot < 2000) vmSway.idleSince = nowVm;
  if (nowVm - (vmSway.idleSince || nowVm) > 9000 && !inspectAnim && !drawAnim) {
    inspectAnim = { start: nowVm, end: nowVm + 1500, fidget: true };
    vmSway.idleSince = nowVm;
  }
  // breath FADES over ~0.3s instead of hard-cutting when you move — constant breathing
  // while running reads robotic; the ease in/out is what sells a living viewmodel
  vmSway.breathAmp = (vmSway.breathAmp || 0)
    + (((!playerMoving && !adsActive && !reloading) ? 1 : 0) - (vmSway.breathAmp || 0)) * Math.min(1, dt * 3.5);
  const breath = Math.sin(nowVm * 0.0019) * vmSway.breathAmp;
  let drawY = 0, drawRot = 0, drawRoll = 0;
  if (drawAnim) {
    if (nowVm >= drawAnim.end) drawAnim = null;
    else {
      const dT = (nowVm - drawAnim.start) / (drawAnim.end - drawAnim.start);
      const st = drawAnim.style || {};
      if (st.snap) {
        // deagle: fast rise with a back-ease overshoot + wrist roll flick
        const c1 = 1.7, e = 1 + (c1 + 1) * Math.pow(dT - 1, 3) + c1 * Math.pow(dT - 1, 2);
        drawY = -0.26 * (1 - e);
        drawRot = -0.6 * (1 - e);
        drawRoll = -0.55 * (1 - Math.min(1, dT * 1.6));
      } else if (st.heavy) {
        // shotgun/sniper: heavier rise with a shoulder-seat second beat
        const eD = 1 - Math.pow(1 - dT, 3);
        drawY = -0.42 * (1 - eD) - Math.sin(Math.min(1, Math.max(0, (dT - 0.55) / 0.45)) * Math.PI) * 0.02;
        drawRot = -1.0 * (1 - eD);
      } else if (st.check && dT > 0.42) {
        // rifle chamber-check: raise, then roll the gun to glance at the ejection port, settle
        const c = (dT - 0.42) / 0.58;
        drawRoll = Math.sin(c * Math.PI) * 0.5;
        drawRot = Math.sin(c * Math.PI) * 0.12;
        drawY = Math.sin(c * Math.PI) * 0.02;
      } else {
        const rT = st.check ? Math.min(1, dT / 0.42) : dT;  // check-style: rise completes early, tilt follows
        const eD = 1 - Math.pow(1 - rT, 3);              // ease-out: fast rise, soft settle
        drawY = -0.34 * (1 - eD);
        drawRot = -0.85 * (1 - eD);
      }
    }
  }
  const swayAmt = adsActive ? 0.22 : 1;                // sights stay readable while aiming
  // weapon inspect: slow full twirl with a tilt, ease in/out, brings the gun up close
  let insY = 0, insRotY = 0, insRotZ = 0, insRotX = 0;
  if (inspectAnim) {
    if (nowVm >= inspectAnim.end) inspectAnim = null;
    else {
      const iT = (nowVm - inspectAnim.start) / (inspectAnim.end - inspectAnim.start);
      const eIn = Math.min(1, iT / 0.12), eOut = Math.min(1, (1 - iT) / 0.12);
      const env = Math.min(eIn, eOut);                 // ease in and out of the twirl
      if (inspectAnim.fidget) {
        // idle fidget: no twirl — a small grip re-seat and tilt, like adjusting the hold
        insRotY = Math.sin(iT * Math.PI) * 0.22;
        insRotZ = Math.sin(iT * Math.PI) * 0.12 * env;
        insRotX = Math.sin(iT * Math.PI * 2) * 0.05 * env;
        insY = 0.015 * env;
      } else {
        insRotY = iT * Math.PI * 2;                      // one full turn over the inspect
        insRotZ = Math.sin(iT * Math.PI) * 0.35 * env;
        insRotX = Math.sin(iT * Math.PI * 2) * 0.15 * env;
        insY = 0.05 * env;
      }
    }
  }
  // shell reload lifts the gun toward center so the loading port is on screen;
  // mag reload also LIFTS + pulls toward center — a dip hides the whole mag swap below frame
  const rlShells = reloadAnim && reloadAnim.type === 'shells';
  const vmBaked = !!vms[currentWeapon];   // baked clip choreographs the reload — no procedural offsets
  const bobAmp = 0.012 + sprintPose * 0.014, bobHz = 0.012 + sprintPose * 0.0035;
  const bob = playerMoving && !reloading && !adsPose ? Math.sin(performance.now() * bobHz) * bobAmp : 0;
  const targetY = (adsPose ? wNow.adsPos.y : hp.y) + (reloading ? (vmBaked ? (VM_CFG[currentWeapon].rlLift || 0) : (rlShells ? 0.09 : 0.08)) : 0) + bob
    + breath * 0.0045 - landDip * 0.8 - sprintPose * 0.055 + drawY + insY + (vmSway.tuck || 0) * 0.07;
  gunGroup.position.y += (targetY - gunGroup.position.y) * Math.min(1, dt * (adsPose ? 14 : 8));
  const targetX = (adsPose ? wNow.adsPos.x : hp.x) + (rlShells ? -0.10 : (reloadAnim ? (vmBaked ? (VM_CFG[currentWeapon].rlX || 0) : -0.06) : 0))
    + vmSway.yaw * 0.35 * swayAmt - sprintPose * 0.05;
  gunGroup.position.x += (targetX - gunGroup.position.x) * Math.min(1, dt * (adsPose ? 14 : 10));
  // animated deagle viewmodel: scrub the baked clip along the active segment,
  // crossfading segment<->idle weights so segment ends never snap the pose
  const vm = vms[currentWeapon];
  if (vm) {
    if (vm.seg) {
      const p = Math.min(1, (performance.now() - vm.seg.start) / vm.seg.dur);
      vm.segAct.time = vm.seg.t0 + p * (vm.seg.t1 - vm.seg.t0);
      if (p >= 1) vm.seg = null;
    }
    const targetW = vm.seg ? 1 : 0;
    vm.w += (targetW - vm.w) * Math.min(1, dt * (vm.seg ? 30 : 9));   // fast in, soft out
    vm.segAct.setEffectiveWeight(vm.w);
    vm.idleAct.setEffectiveWeight(1 - vm.w);
    vm.mixer.update(0);
    // procedural slide blowback: snap back in 30% of the cycle, spring return over the rest
    if ((vm.slideKick !== null || vm.lockOpen) && vm.slideBones.length) {
      const e = vm.slideKick !== null ? (performance.now() - vm.slideKick) / 130 : 1;
      if (e >= 1 && !vm.lockOpen) { vm.slideKick = null; }
      else {
        if (!vm.slideDirs) {   // lazy: gun-backward direction expressed in each slide bone's parent frame
          const wq = new THREE.Quaternion(), back = new THREE.Vector3();
          vmWrapper().getWorldQuaternion(wq);
          vm.slideDirs = vm.slideBones.map(b => {
            const pq = b.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
            const ws = b.parent.getWorldScale(new THREE.Vector3()).x || 1;
            return { dir: back.set(0, 0, 1).applyQuaternion(wq).applyQuaternion(pq).normalize().clone(), ws };
          });
        }
        // lockOpen: slide stays pinned fully back on an empty mag (released by the reload)
        const k = vm.lockOpen ? Math.min(1, e < 0.3 ? e / 0.3 : 1) : (e < 0.3 ? e / 0.3 : 1 - (e - 0.3) / 0.7);
        for (let i = 0; i < vm.slideBones.length; i++) {
          const { dir, ws } = vm.slideDirs[i];
          vm.slideBones[i].position.addScaledVector(dir, vm.boltAmp * k / ws);
        }
      }
    }
  }
  // bolt/pump cycle: tip down + pull back, sin-eased across the action window
  let actionRot = 0;
  if (actionAnim) {
    const nowA = performance.now();
    if (nowA > actionAnim.end) actionAnim = null;
    else if (nowA > actionAnim.start) {
      const t = (nowA - actionAnim.start) / (actionAnim.end - actionAnim.start);
      const ease = Math.sin(t * Math.PI);
      actionRot = -0.22 * ease;
      gunGroup.position.z += 0.05 * ease;
    }
  }
  const targetRot = (adsPose ? 0 : HIP_ROT.x) + gunRotKick + (reloading && !vmBaked ? -0.14 : 0) + actionRot + reloadRack
    + (vmSway.pitch * 2.0 + landDip * 1.5) * swayAmt + breath * 0.003 + sprintPose * 0.38 + drawRot + insRotX + (vmSway.tuck || 0) * 0.55;
  gunGroup.rotation.x += (targetRot - gunGroup.rotation.x) * Math.min(1, dt * 10);
  // hip cant eases out to zero while aiming so the sight lines up dead straight;
  // mag reload yaws the gun to show the mag well; shell reload rolls it so the port faces camera
  const rlType = reloadAnim ? reloadAnim.type : null;
  const rotY = (adsActive ? 0 : HIP_ROT.y + (rlType === 'mag' ? 0.38 : rlType === 'shells' ? 0.12 : 0))
    + vmSway.yaw * 2.4 * swayAmt + sprintPose * 0.5 + insRotY;
  const rotZ = (adsActive ? 0 : HIP_ROT.z + (rlType === 'shells' ? 0.55 : rlType === 'mag' ? 0.10 : 0))
    + (vmSway.roll + vmSway.yaw * 1.1) * swayAmt + sprintPose * 0.24 + insRotZ + drawRoll;
  gunGroup.rotation.y += (rotY - gunGroup.rotation.y) * Math.min(1, dt * (inspectAnim ? 20 : 10));
  gunGroup.rotation.z += (rotZ - gunGroup.rotation.z) * Math.min(1, dt * 10);
  // parallax-free sight: recoil pitches the gun about the group origin, which swings the optic
  // (and its dot) below the fire line while the muzzle climbs. Counter-move the wrapper so the
  // AimPoint stays pinned on the camera axis at ADS — how a real red dot behaves.
  {
    const wrap = vmWrapper();
    const aimL = wrap && wrap.userData.aim;
    if (aimL) {
      if (!wrap.userData.basePos) wrap.userData.basePos = wrap.position.clone();
      const bp = wrap.userData.basePos;
      if (adsPose) {
        sightPinQ.setFromEuler(gunGroup.rotation).invert();
        sightPinV.copy(aimL).applyQuaternion(sightPinQ).sub(aimL);
        wrap.position.set(bp.x + sightPinV.x, bp.y + sightPinV.y, bp.z + sightPinV.z);
      } else if (!wrap.position.equals(bp)) {
        wrap.position.copy(bp);
      }
    }
  }
  // scope zoom
  killPunch = Math.max(0, killPunch - dt * 4);
  // low-HP heartbeat: under 25hp a lub-dub pulses, quickening as health drops
  if (player.hp > 0 && player.hp <= 25 && !player.dead) {
    const beatGap = 620 + player.hp * 18;   // 25hp -> ~1.07s, 5hp -> ~0.71s
    if (nowVm - (vmSway.lastBeat || 0) > beatGap) {
      vmSway.lastBeat = nowVm;
      sfx(52, 0.09, 'sine', 0.09);
      setTimeout(() => sfx(44, 0.1, 'sine', 0.07), 150);
    }
  }
  // crosshair bloom: gap widens with movement, airtime and fire — accuracy state at a glance
  {
    const xh = document.getElementById('crosshair');
    if (xh) {
      const moveB = playerMoving ? (sprinting ? 0.55 : 0.3) : 0;
      const airB = player.onGround ? 0 : 0.5;
      const fireB = Math.min(0.7, Math.abs(gunRotKick) * 3);
      const target = 1 + moveB + airB + fireB;
      vmSway.xhBloom = (vmSway.xhBloom || 1) + (target - (vmSway.xhBloom || 1)) * Math.min(1, dt * 10);
      if (Math.abs(vmSway.xhBloom - (vmSway.xhApplied || 0)) > 0.01) {
        vmSway.xhApplied = vmSway.xhBloom;
        xh.style.transform = `translate(-50%, -50%) scale(${vmSway.xhBloom.toFixed(3)})`;
        xh.style.opacity = Math.max(0.55, 1.35 - vmSway.xhBloom * 0.35).toFixed(2);
      }
    }
  }
  const targetFov = (adsActive ? (WEAPONS[currentWeapon].adsFov || 75) : 75) - killPunch * 5
    + (sprinting ? 3 : 0);   // sprint widens the view slightly — speed you can feel
  if (Math.abs(camera.fov - targetFov) > 0.02) {
    camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 12);
    camera.updateProjectionMatrix();
  }
  // muzzle flash decay
  muzzleLight.intensity = Math.max(0, muzzleLight.intensity - dt * 30);
  muzzleFlash.material.opacity = Math.max(0, muzzleFlash.material.opacity - dt * 25);

  // interpolate remote players + drive their animations
  for (const r of remotes.values()) {
    if (r.dying) continue;                                       // death anim owns the transform
    r.group.position.lerp(r.targetPos, Math.min(1, dt * 12));
    let dy = r.targetRy - r.group.rotation.y;
    dy = ((dy + Math.PI) % (Math.PI * 2)) - Math.PI;
    r.group.rotation.y += dy * Math.min(1, dt * 12);
    if (r.flinch) {                                              // hit reaction: jerk AWAY from the bullet
      r.flinch = Math.max(0, r.flinch - dt * 5);
      const s = Math.sin(Math.min(1, r.flinch) * Math.PI);
      if (r.flinchDir) {
        // bullet dir in the body's local frame: fore/aft -> pitch, lateral -> roll
        const cy = Math.cos(-r.group.rotation.y), sy = Math.sin(-r.group.rotation.y);
        const lx = r.flinchDir.x * cy - r.flinchDir.z * sy;
        const lz = r.flinchDir.x * sy + r.flinchDir.z * cy;
        r.group.rotation.x = -0.15 * lz * s;      // shot from front pitches back, from behind pitches forward
        r.group.rotation.z = -0.12 * lx * s;      // side hits roll away
        if (r.flinchHead && r.headBone) r.headBone.rotateX(-0.3 * s);   // head snap
      } else {
        r.group.rotation.x = -0.14 * s;           // unknown shooter (network hp drop): default jerk back
      }
      if (r.flinch === 0) { r.flinchDir = null; r.flinchHead = false; r.group.rotation.z = 0; }
    } else if (r.group.rotation.x !== 0 && !r.dead) r.group.rotation.x = 0;

    if (r.mixer) {
      // movement state machine: relayed flags take priority, then ground speed
      const dist = r.group.position.distanceTo(r.lastPos);
      const vyDelta = r.group.position.y - r.lastPos.y;
      const mvx = r.group.position.x - r.lastPos.x, mvz = r.group.position.z - r.lastPos.z;
      r.lastPos.copy(r.group.position);
      const spd = dt > 0 ? dist / dt : 0;
      const nowA = performance.now();
      // turn-in-place: a standing player whose yaw swings >~30° gets a brief shuffle-step
      // (feet visibly reposition) instead of rotating like a statue on a turntable
      if (spd < 1.2 && !r.air && !r.sl) {
        r.turnAcc = (r.turnAcc || 0) + Math.abs(dy) * Math.min(1, dt * 12);   // rotation actually applied this frame
        if (r.turnAcc > 0.5) { r.turnAcc = 0; r.shuffleUntil = nowA + 280; }
      } else r.turnAcc = 0;
      // landing bend: knees absorb the impact for ~200ms after touching down; takeoff stretches
      const wasAir = r.wasAir || false;
      if (wasAir && !r.air) r.landBendAt = nowA;
      if (!wasAir && r.air && vyDelta > 0.004) r.stretchAt = nowA;
      r.wasAir = !!r.air;
      let want;
      if (r.sl && r.actions.slide) want = 'slide';
      else if (nowA - (r.wallJumpAt || -1e9) < 600 && r.actions.walljump) want = 'walljump';
      else if (r.air) want = (vyDelta > 0.004 && r.actions.jump) ? 'jump' : (r.actions.fall ? 'fall' : 'idle');
      else if (spd > 1.2) want = (r.spr && r.actions.sprint) ? 'sprint' : 'run';
      else if (nowA < (r.shuffleUntil || 0) && r.actions.run) want = 'run';   // the shuffle
      else want = 'idle';
      if (want !== r.animState && r.actions[want]) {
        r.actions[r.animState]?.fadeOut(0.15);
        r.actions[want].reset().fadeIn(0.15).play();
        r.animState = want;
      }
      // feet track actual ground speed
      if (r.animState === 'run' && r.actions.run) r.actions.run.timeScale = Math.min(1.8, Math.max(0.8, spd / 6));
      if (r.animState === 'sprint' && r.actions.sprint) r.actions.sprint.timeScale = Math.min(1.6, Math.max(0.9, spd / 9));
      // directional locomotion: there is only a FORWARD run clip, so strafing/backpedaling
      // reads as moonwalking. Legs (whole model) twist toward the travel direction (clamped),
      // the spine counter-twists to keep torso + gun on the player's real aim, and moving
      // backward keeps the body on aim with the run clip played in reverse.
      let twistT = 0, backpedal = false;
      if (!r.air && !r.sl && spd > 1.2) {
        const wrapA = a => ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
        let la = wrapA(Math.atan2(mvx, mvz) - r.targetRy);   // travel dir relative to facing
        if (Math.abs(la) > 2.1) { backpedal = true; la = wrapA(la + Math.PI); }
        twistT = Math.max(-1.05, Math.min(1.05, la));        // clamp legs to ±60°
      }
      r.bodyTwist = (r.bodyTwist || 0) + (twistT - (r.bodyTwist || 0)) * Math.min(1, dt * 9);
      if (r.soldier) {
        r.soldier.rotation.y = r.bodyTwist;
        // landing bend: 200ms crouch-absorb after touchdown; takeoff: brief 90ms stretch up
        let dipY = 0;
        const nowB = performance.now();
        const lb = (nowB - (r.landBendAt || -1e9)) / 200;
        if (lb >= 0 && lb < 1) dipY = -0.10 * Math.sin(lb * Math.PI);
        const st = (nowB - (r.stretchAt || -1e9)) / 90;
        if (st >= 0 && st < 1) dipY = 0.05 * Math.sin(st * Math.PI);
        r.soldier.position.y = dipY;
      }
      // remote footsteps: information warfare — hearing a sprint closing in matters more
      // than seeing it. Distance-attenuated, inaudible past ~26m, sprint carries further.
      if (!r.air && !r.sl && !r.dead && spd > 1.2) {
        r.strideAcc = (r.strideAcc || 0) + dist;
        if (r.strideAcc > (r.spr ? 2.6 : 2.1)) {
          r.strideAcc = 0;
          const d = r.group.position.distanceTo(player.pos);
          const maxD = r.spr ? 26 : 18;
          if (d < maxD) sfxFootstep(0.09 * (1 - d / maxD), !!r.spr);
        }
      } else r.strideAcc = 0;
      if (backpedal && (r.animState === 'run' || r.animState === 'sprint')) {
        const a = r.actions[r.animState];
        if (a && a.timeScale > 0) a.timeScale = -a.timeScale;
      }
      r.mixer.update(dt);
      // weapon hold: override the arm chain so both hands stay on the gun
      if (r.poseBones) for (const pb of r.poseBones) pb.bone.quaternion.fromArray(pb.quat);
      // torso follows their real aim pitch — you can read who is watching your angle
      if (r.spineBone) r.spineBone.rotateX(-(r.aimPitch || 0) * 0.55);
      // counter-twist: torso (and the gun in the hands) stays on aim while the legs strafe
      if (r.spineBone && Math.abs(r.bodyTwist) > 0.02) r.spineBone.rotateY(-r.bodyTwist * 0.8);
      // ADS: shoulders come up into an aim stance
      if (r.ads && r.armBones) for (const ab of r.armBones) ab.rotateX(-0.22);
      // remote reload: their mag visibly drops out and returns
      if (r.reloadAnim) {
        const cont = r.gunModels[r.weapon];
        const mags = cont?.userData?.magNodes;
        if (mags?.length) {
          const t = Math.min(1, (performance.now() - r.reloadAnim.start) / r.reloadAnim.dur);
          let drop = 0;
          if (t < 0.5) { const u = t / 0.34; drop = Math.min(1, u * u * (3 - 2 * Math.min(1, u))); }
          else if (t < 0.9) { const u = (t - 0.5) / 0.4; drop = 1 - u * u * (3 - 2 * u); }
          for (const m of mags) {
            m.node.position.set(m.pos.x, m.pos.y - drop * 0.2, m.pos.z + drop * 0.04);
            m.node.visible = drop < 0.97;
          }
          if (t >= 1) { r.reloadAnim = null; for (const m of mags) { m.node.position.copy(m.pos); m.node.visible = true; } }
        }
      }
      // sniper scope glint: bright flare when they are scoped in AND lined up on you
      if (r.weapon === 3 && r.ads && !r.dead) {
        if (!r.glint) {
          const gm = new THREE.SpriteMaterial({ map: FX.flashTex, color: 0xfff2b0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false });
          r.glint = new THREE.Sprite(gm);
          r.glint.raycast = () => {};
          scene.add(r.glint);
        }
        const aimDir = new THREE.Vector3(-Math.sin(r.targetRy), Math.sin(r.aimPitch || 0), -Math.cos(r.targetRy)).normalize();
        const toMe = camera.position.clone().sub(r.group.position.clone().add(new THREE.Vector3(0, 1.5, 0)));
        const d = toMe.length();
        const align = aimDir.dot(toMe.normalize());
        const on = align > 0.985 && d > 4;
        r.glint.position.copy(r.group.position).add(new THREE.Vector3(0, 1.52, 0)).addScaledVector(aimDir, 0.5);
        r.glint.material.opacity += ((on ? 0.95 : 0) - r.glint.material.opacity) * Math.min(1, dt * 10);
        r.glint.scale.setScalar((0.55 + Math.sin(performance.now() * 0.02) * 0.1) * Math.min(2.4, d * 0.06 + 0.6));
      } else if (r.glint) r.glint.material.opacity = Math.max(0, r.glint.material.opacity - dt * 8);
    }
  }

  // effects: run updates, fade, clean up (geometry is shared — dispose materials only)
  for (let i = effects.length - 1; i >= 0; i--) {
    const e = effects[i];
    e.ttl -= dt;
    if (e.update) e.update(dt, e);
    if (e.ttl <= 0) {
      scene.remove(e.obj);
      e.obj.material?.dispose();
      effects.splice(i, 1);
    }
  }

  // DARKNESS: per-frame updates
  updateFlashPool(dt);
  updateLocalFlashlight();
  updateRemoteFlashlights();
  updateAmbience();

  // THROWABLES: throw viewmodel, projectile physics, blind overlay, blast shake
  updateThrowAnim(performance.now());
  updateNades(dt);
  if (flashBlind) {
    const el = document.getElementById('flashBlind');
    const tB = performance.now() - flashBlind.start;
    if (tB < flashBlind.hold) el.style.opacity = flashBlind.k;
    else if (tB < flashBlind.hold + flashBlind.fade) {
      const k = 1 - (tB - flashBlind.hold) / flashBlind.fade;
      el.style.opacity = flashBlind.k * k * k;
    } else { el.style.opacity = 0; flashBlind = null; }
  }
  if (nadeShake > 0.0005) {
    camera.rotation.x += (Math.random() - 0.5) * nadeShake;
    camera.rotation.z += (Math.random() - 0.5) * nadeShake * 0.7;
    nadeShake *= Math.exp(-dt * 7);
  } else nadeShake = 0;

  aiPovUpdate(dt);
  // Render with composer (bloom+SSAO) or raw renderer based on quality tier
  if (composerEnabled) {
    composer.render();
  } else {
    renderer.render(scene, camera);
  }
  fpsWatchdog();
}
// start medium unless quality was forced via URL param
applyQuality(forceQualityIdx >= 0 ? forceQualityIdx : 2);   // default: medium
animate();
