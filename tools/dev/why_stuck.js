// dev: reproduce a harness run and print the first stuck moments with context
const path = require('path');
const { runOne } = require('../arena-eval.js');
const MOVE = require('../../ai/nemesis-move.js');
const { navFor } = require('../../ai/nemesis-nav.js');
const BR = require('../../ai/nemesis-brain.js');
const orig = BR.tickBots;
let printed = 0, lastPos = null, still = 0;
require.cache[require.resolve('../../ai/nemesis-brain.js')].exports.tickBots = function (room, dt, api) {
  orig(room, dt, api);
  const b = room.players.get('b1');
  if (!b || b.dead) { still = 0; return; }
  if (lastPos && Math.hypot(b.pos[0] - lastPos[0], b.pos[2] - lastPos[2]) < 0.005 && b.ai && !['engage', 'hold'].includes(b.ai.state)) still += dt; else still = 0;
  lastPos = b.pos.slice();
  if (still > 1.5 && printed < 6) {
    printed++; still = -999;
    const nav = navFor(room.map);
    const n = nav.nearest(b.pos[0], b.pos[1], b.pos[2], 6);
    const c = nav.cellOf(b.pos[0], b.pos[2]); const fl = []; for (let m = nav.start[c]; m < nav.start[c + 1]; m++) fl.push(nav.h[m].toFixed(2) + (nav.reach[m] ? '' : 'u'));
    console.log('STUCK state', b.ai.state, 'pos', b.pos.map((v) => v.toFixed(2)).join(','), 'air', b.air, 'vy', b.vy, 'route', b.route ? `${b.route.i}/${b.route.pts.length} next ${JSON.stringify(b.route.pts[b.route.i])}` : 'none',
      '| nearest', n, n >= 0 ? nav.pos(n).map((v) => v.toFixed(2)).join(',') : '', '| floors here', fl.join(' '), '| floorBelow', nav.floorBelow(b.pos[0], b.pos[1] + 0.05, b.pos[2]));
  }
};
const r = runOne(process.argv[2] || 'shipment', process.argv[3] || 'average', { id: process.argv[5] || 'v0.2', version: 2, learn: process.argv[5] !== 'v0.2-nolearn' }, Number(process.argv[4]) || 1, 10);
console.log('stuck', r.stuckPct, r.stuckBy);
