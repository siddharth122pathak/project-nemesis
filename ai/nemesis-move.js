'use strict';
// Movement on the navigation grid, shared by Nemesis bots and the scripted test players:
// follow a path (walking, jumping up ledges, dropping down), sidestep safely, apply gravity.
const GRAVITY = 22;   // same as the client

// Height of the floor under entity e at its current x/z (the floor it is standing on or just above).
function floorUnder(nav, e) {
  return nav.floorBelow(e.pos[0], e.pos[1] + 0.05, e.pos[2]);
}

// Can e stand at (x, z)? Returns the floor height, allowing a step up of `up` meters.
function standAt(nav, e, x, z, up) {
  return nav.floorNear(x, e.pos[1], z, up);   // stay on the current level; stairs are taken one step at a time
}

// Vertical motion: jumps, falls, and stepping onto stairs. Sets e.air while off the ground.
function settle(nav, e, dt) {
  let ground = floorUnder(nav, e);
  e.vy = e.vy || 0;
  if (ground === null && e.gap > 0) {   // crossing open air off a ledge: keep falling
    e.gap--;
    e.pos[1] += e.vy * dt; e.vy -= GRAVITY * dt; e.air = true;
    return;
  }
  if (ground === null) {
    const above = nav.floorBelow(e.pos[0], e.pos[1] + 0.6, e.pos[2]);
    if (above !== null && e.vy <= 0) { e.pos[1] = above; e.vy = 0; e.air = false; return; }   // step up onto it
    if (e.vy > 0) { e.pos[1] += e.vy * dt; e.vy -= GRAVITY * dt; e.air = true; return; }        // still rising
    snap(nav, e);   // inside geometry: recover onto the nearest floor
    return;
  }
  if (e.vy > 0 || e.pos[1] > ground + 0.05) {
    e.pos[1] += e.vy * dt;
    e.vy -= GRAVITY * dt;
    if (e.pos[1] <= ground) { e.pos[1] = ground; e.vy = 0; e.air = false; } else e.air = true;
  } else {
    e.pos[1] = ground;   // stairs: step up/down instantly, like the client
    e.vy = 0;
    e.air = false;
  }
}

function jump(e, height = 1.0) {
  if (e.air) return false;
  e.vy = Math.sqrt(2 * GRAVITY * height);
  e.air = true;
  return true;
}

// Move horizontally by (dx, dz) if the destination is walkable (step up 0.55 m, or 1.45 m mid-jump).
function tryMove(nav, e, dx, dz, allowGap = false) {
  const up = e.air ? 0.25 : 0.6;   // mid-jump you can only move over floors you are already above
  const x = e.pos[0] + dx, z = e.pos[2] + dz;
  const h = standAt(nav, e, x, z, up);
  if (h === null) {
    // stepping off a ledge into open air (only when the route says to drop here)
    if (allowGap && nav.floorBelow(x, e.pos[1] + 3, z) === null) { e.pos[0] = x; e.pos[2] = z; e.gap = 6; e.air = true; return true; }
    return false;
  }
  e.pos[0] = x; e.pos[2] = z;
  if (!e.air && h > e.pos[1] + 0.02) e.pos[1] = h;   // stepped onto a stair
  return true;
}

// Follow e.route (waypoints [x, y, z, kind]) at `speed`. kind 1 = jump up, 2 = drop down.
// Returns 'moving', 'arrived', or 'blocked'.
function follow(nav, e, speed, dt) {
  const r = e.route;
  if (!r || r.i >= r.pts.length) return 'arrived';
  const w = r.pts[r.i];
  const dx = w[0] - e.pos[0], dz = w[2] - e.pos[2], d = Math.hypot(dx, dz);
  // reached: within a step of the waypoint's floor (stair cells hold two floors), exact after a jump
  if (d < 0.35 && Math.abs(w[1] - e.pos[1]) < (w[3] === 1 ? 0.3 : 0.6)) { r.i++; return r.i >= r.pts.length ? 'arrived' : 'moving'; }
  if (!e.air && d < 1.2 && w[1] - e.pos[1] > 0.45) jump(e, w[1] - e.pos[1] + 0.4);   // ledge ahead: jump onto it
  const step = Math.min(d, speed * dt);
  let moved = d > 1e-6 && tryMove(nav, e, (dx / d) * step, (dz / d) * step, w[3] === 2);
  if (!moved) {
    // slide along obstacles: try the two axis-aligned components
    moved = tryMove(nav, e, (dx / d) * step, 0) || tryMove(nav, e, 0, (dz / d) * step);
  }
  e.moveDir = d > 1e-6 ? [dx / d, dz / d] : e.moveDir;
  return moved ? 'moving' : 'blocked';
}

// Plan a route for e to goal [x, y, z]. extraCost(node) lets the learner steer around danger.
function routeTo(nav, e, goal, extraCost = null) {
  const a = nav.nearest(e.pos[0], e.pos[1], e.pos[2], 6);
  let b = nav.nearest(goal[0], goal[1], goal[2], 8);
  let nodes = nav.path(a, b, extraCost, 45000);
  if (!nodes) {   // unreachable (e.g. a rooftop): go to the floor below it instead
    b = nav.nearest(goal[0], 0, goal[2], 8);
    nodes = nav.path(a, b, extraCost, 45000);
  }
  if (!nodes) { e.route = null; return false; }
  e.route = { pts: nav.waypoints(nodes), i: 0, goal: goal.slice() };
  return true;
}

// Put e on the nearest walkable floor (after a respawn or if it ever ends up inside geometry).
function snap(nav, e) {
  const n = nav.nearest(e.pos[0], e.pos[1], e.pos[2], 12);
  if (n < 0) return false;
  const p = nav.pos(n);
  e.pos[0] = p[0]; e.pos[1] = p[1]; e.pos[2] = p[2];
  e.vy = 0; e.air = false;
  return true;
}

module.exports = { follow, routeTo, tryMove, settle, jump, snap, floorUnder, GRAVITY };
