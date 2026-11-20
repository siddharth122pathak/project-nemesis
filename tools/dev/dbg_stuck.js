
let NOW=Date.UTC(2026,10,20); Date.now=()=>NOW;
const W=require('../../world.js'),NEM=require('../../ai/nemesis-bot.js'),BR=require('../../ai/nemesis-brain.js'),SIMP=require('../../ai/nemesis-simplayer.js');
let s=5;Math.random=()=>{s=(s*1664525+1013904223)>>>0;return s/4294967296};
const room={code:'x',map:process.argv[2]||'shipment',mode:'dm',started:true,players:new Map(),nemesisVersion:2,nemesisLearn:false};
const api={posBlocked:W.posBlocked,segmentBlocked:W.segmentBlocked,pickSpawn:W.pickSpawn,broadcastRoom(){},applyDamage(){},weaponDamage:{1:25},cooldowns:{1:380}};
room.players.set('b1',{ws:{readyState:3},bot:true,name:'B',pos:W.pickSpawn(room,false),ry:0,pitch:0,hp:100,kills:0,deaths:0,dead:false,inGame:true,w:1});
const counts={};let last=null,stuckBy={};
for(let i=0;i<20*120;i++){NOW+=50;BR.tickBots(room,0.05,api);const b=room.players.get('b1');
 const st=b.ai.state;counts[st]=(counts[st]||0)+1;
 if(i%20===0){if(last){const mv=Math.hypot(b.pos[0]-last[0],b.pos[2]-last[2]);if(mv<0.3){const k=st+'|route:'+(b.route?(b.route.i+'/'+b.route.pts.length):'none');stuckBy[k]=(stuckBy[k]||0)+1}}last=b.pos.slice();}}
console.log(counts, stuckBy, BR.metricsOf(room,'b1').stuck.toFixed(1), BR.metricsOf(room,'b1').moveSecs.toFixed(1));
