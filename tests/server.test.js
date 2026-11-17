'use strict';
// End-to-end check: start the real LAB ARENA server, join as a human over WebSocket, add a bot,
// strafe near it, and confirm the bot fires Nemesis-aimed shots and the HUD stream arrives.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const WebSocket = require('ws');

const PORT = 8190 + Math.floor(Math.random() * 500);

test('server runs Nemesis bots against a strafing human', { timeout: 30000 }, async () => {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise((resolve, reject) => {
      server.stdout.on('data', (d) => { if (String(d).includes('running')) resolve(); });
      server.on('exit', (c) => reject(new Error('server exited ' + c)));
    });
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    await new Promise((r) => ws.on('open', r));
    const send = (m) => ws.send(JSON.stringify(m));
    let myId = null, botPos = null, botId = null, hud = null, botShots = 0;
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.you) myId = m.you;
      if (m.t === 'init') myId = m.id;
      if (m.t === 'states') {
        for (const [id, p] of Object.entries(m.players)) if (id.startsWith('b')) { botId = id; botPos = p.pos; }
      }
      if (m.t === 'shot' && m.from && String(m.from).startsWith('b')) botShots++;
      if (m.t === 'nemesis') hud = m;
    });

    send({ t: 'create', name: 'tester', game: 'cod' });
    await new Promise((r) => setTimeout(r, 200));
    send({ t: 'setmap', map: 'range' });
    send({ t: 'addbot' });
    send({ t: 'start' });

    // Strafe left and right 6 m from the bot for 12 seconds of real time.
    const t0 = Date.now();
    while (Date.now() - t0 < 12000) {
      if (botPos) {
        const s = Math.sign(Math.sin((Date.now() - t0) / 600));
        const off = ((Date.now() - t0) % 1200) / 1200 * 4 - 2;
        send({ t: 'state', pos: [botPos[0] + 6, botPos[1], botPos[2] + s * off], ry: 0, pitch: 0, w: 1 });
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    ws.close();
    assert.ok(myId, 'joined a room');
    assert.ok(botId, 'bot is in the match');
    assert.ok(hud, 'received nemesis HUD updates');
    assert.equal(hud.mode, 'learned');
    assert.ok(hud.updates > 50, `model updated ${hud.updates} times`);
    const shots = Object.values(hud.stats).reduce((a, s) => a + s.shots, 0);
    assert.ok(shots > 0 && botShots > 0, `bot fired ${botShots} visible shots, ${shots} scored`);
  } finally {
    server.kill();
  }
});

test('demo mode: a bot hunts the scripted target and streams the AI view', { timeout: 30000 }, async () => {
  const port = PORT + 1;
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise((resolve, reject) => {
      server.stdout.on('data', (d) => { if (String(d).includes('running')) resolve(); });
      server.on('exit', (c) => reject(new Error('server exited ' + c)));
    });
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((r) => ws.on('open', r));
    let pov = null;
    ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.t === 'nemesispov') pov = m; });
    ws.send(JSON.stringify({ t: 'create', name: 'viewer', demo: true }));
    await new Promise((r) => setTimeout(r, 10000));
    ws.close();
    assert.ok(pov, 'received AI view updates');
    assert.equal(pov.targetName, 'TARGET');
    assert.ok(pov.demo && pov.style === 'rhythm');
    assert.ok(pov.updates > 100, `model updated ${pov.updates} times`);
  } finally {
    server.kill();
  }
});
