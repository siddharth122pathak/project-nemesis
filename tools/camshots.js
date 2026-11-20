// Saves screenshots of the AI demo in all three camera modes on a few maps.
// Usage: node tools/camshots.js [port] [outDir]   (server must be running)
const { chromium } = require('playwright');
(async () => {
  const port = process.argv[2] || 8090, out = process.argv[3] || 'docs/images/m2';
  require('fs').mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const maps = (process.env.MAPS || 'shipment,killhouse,range,blackout,districts,monastery').split(',');
  for (const map of maps) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('pageerror', (e) => console.log(map, 'pageerror', e.message));
    await page.goto(`http://127.0.0.1:${port}/cod/?demo=1&map=${map}&skill=${process.env.SKILL || 'expert'}`);
    await page.waitForTimeout(Number(process.env.WARM || 45000));
    for (const cam of ['third', 'first', 'world']) {
      await page.evaluate((c) => { window.__aipov.camMode = c; window.__aipov.cam = null; window.__aipov.look = null; window.__aipov.fly.pos = null; }, cam);
      await page.waitForTimeout(1500);
      await page.screenshot({ path: `${out}/${map}_${cam}.png` });
    }
    const info = await page.evaluate(() => { const d = window.__aipov.data || {}; return { state: d.botState, route: (d.route || []).length, lvl: d.expertise && d.expertise.level, score: d.score, flags: d.botFlags, hud: document.getElementById('aiPovHud').innerText.slice(0, 900) }; });
    console.log(map, JSON.stringify(info));
    await page.close();
  }
  await browser.close();
})();
