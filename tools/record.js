'use strict';
// Records a short gameplay clip from the bot's point of view.
//
// One headless browser plays as a human (host) and strafes in front of a Nemesis bot while cycling
// the aim mode: naive, then lead, then learned (reset first, so it learns from scratch on camera).
// A second, invisible "AI view" observer rides in the bot's eyes and is recorded to video.
// Screenshots are saved along the way.
//
// Usage: node tools/record.js [port] [outDir]
//   needs the server running:  NEMESIS_NO_BOT_DAMAGE=1 PORT=8090 npm start
//   (no-damage keeps the scripted player alive so the camera stays on the fight; hits are still scored)
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const port = process.argv[2] || 8090;
const outDir = path.resolve(process.argv[3] || 'docs/media');
const base = `http://127.0.0.1:${port}/cod/`;
const PHASE_S = { naive: 20, lead: 20, learned: 55 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startHost(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  await page.goto(base + '?debug=1');
  await page.waitForTimeout(2500);
  await page.click('[data-nav="scrPlay"]');
  await page.fill('#nameInput', 'SID');
  await page.click('[data-map="range"]');
  await page.click('#createBtn');
  await page.waitForTimeout(1500);
  await page.$eval('#addBotBtn', (b) => b.click());
  await page.waitForTimeout(400);
  const code = (await page.textContent('#roomCode')).trim();
  await page.$eval('#startBtn', (b) => b.click());
  await page.waitForTimeout(2500);
  return { page, code };
}

async function startObserver(browser, code) {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: outDir, size: { width: 1280, height: 720 } },
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { if (!/pointer lock/i.test(e.message)) console.log('[observer]', e.message); });
  await page.goto(`${base}?name=AIVIEW&code=${code}&spectate=1&quality=low`);
  await page.waitForTimeout(3000);
  return { ctx, page };
}

// Scripted human: faces the bot, keeps 6-11 m away, and strafes left/right on a steady rhythm
// (a habit the bot can learn). Uses the game's ?debug hooks to read positions and set facing.
async function strafe(page, seconds, flipMs = 1100) {
  const t0 = Date.now();
  let dir = 'KeyD';
  while (Date.now() - t0 < seconds * 1000) {
    const st = await page.evaluate(() => {
      const me = window.__player(), bot = window.__remotes().find((r) => r.id.startsWith('b') && !r.dead);
      if (bot && !me.dead) {
        const dx = bot.pos[0] - me.pos[0], dz = bot.pos[2] - me.pos[2];
        window.__setPos(me.pos[0], me.pos[1], me.pos[2], Math.atan2(-dx, -dz), 0);
        return Math.hypot(dx, dz);
      }
      return null;
    });
    // swap only the strafe key so movement never stalls between holds
    await page.keyboard.down(dir);
    await page.keyboard.up(dir === 'KeyD' ? 'KeyA' : 'KeyD');
    if (st !== null && st > 11) await page.keyboard.down('KeyW'); else await page.keyboard.up('KeyW');
    if (st !== null && st < 6) await page.keyboard.down('KeyS'); else await page.keyboard.up('KeyS');
    await page.waitForTimeout(flipMs);
    dir = dir === 'KeyD' ? 'KeyA' : 'KeyD';
  }
  for (const k of ['KeyD', 'KeyA', 'KeyW', 'KeyS']) await page.keyboard.up(k);
}

// Wait (up to 12 s) until the bot can see the target, so screenshots show the fight, not a wall.
async function snap(page, name, hostPage) {
  const t0 = Date.now();
  while (Date.now() - t0 < 12000) {
    const ok = await page.evaluate(() => { const d = window.__aipov && window.__aipov.data; return !!(d && d.los && d.predictions); });
    if (ok) break;
    if (hostPage) await strafe(hostPage, 1.1); else await page.waitForTimeout(200);
  }
  await page.screenshot({ path: path.join(outDir, name) });
  console.log('saved', name);
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const host = await startHost(browser);
  console.log('room', host.code);
  const obs = await startObserver(browser, host.code);

  // learned -> naive
  await host.page.keyboard.press('KeyN');
  await strafe(host.page, PHASE_S.naive / 2);
  await snap(obs.page, 'aiview_naive.png', host.page);
  await strafe(host.page, PHASE_S.naive / 2);

  // naive -> lead
  await host.page.keyboard.press('KeyN');
  await strafe(host.page, PHASE_S.lead / 2);
  await snap(obs.page, 'aiview_lead.png', host.page);
  await strafe(host.page, PHASE_S.lead / 2);

  // lead -> learned, wiped so it learns on camera
  await host.page.keyboard.press('KeyN');
  await host.page.keyboard.down('ShiftLeft');
  await host.page.keyboard.press('KeyN');
  await host.page.keyboard.up('ShiftLeft');
  await strafe(host.page, 6);
  await snap(obs.page, 'aiview_learned_start.png', host.page);
  await strafe(host.page, PHASE_S.learned - 12);
  await snap(obs.page, 'aiview_learned_trained.png', host.page);
  await snap(host.page, 'player_view.png');
  await strafe(host.page, 6);

  const video = obs.page.video();
  await obs.ctx.close();
  const raw = await video.path();
  const webm = path.join(outDir, 'aiview_raw.webm');
  fs.renameSync(raw, webm);
  console.log('video', webm);
  await browser.close();
})();
