const { runOne } = require('../arena-eval.js');
const BR = require('../../ai/nemesis-brain.js');
for (const cfg of [{id:'v0.1',version:1,learn:false},{id:'v0.2-nolearn',version:2,learn:false},{id:'v0.2',version:2,learn:true}]) {
  const h=process.hrtime.bigint();
  const r = runOne(process.argv[2]||'shipment', process.argv[3]||'average', cfg, Number(process.argv[4])||1, Number(process.argv[5])||5);
  const s=Number(process.hrtime.bigint()-h)/1e9;
  console.log(cfg.id.padEnd(13), s.toFixed(1)+'s', JSON.stringify({k:r.botKills,d:r.botDeaths,kd:r.kd,ttk:r.medianTtk,ttd:r.medianTtd,stuck:r.stuckPct,hit:r.hitRate,away:r.firedFacingAway,canc:r.cancelledTurnedAway,cov:r.coveragePct,spr:r.sprintPct,sl:r.slidesPerMin,j:r.jumpsPerMin,sw:r.switchesPerMin,lvl:r.expertise,perMin:r.perMin.map(m=>m.kills+'/'+m.deaths).join(' ')}), JSON.stringify(r.stuckBy||{}));
}
