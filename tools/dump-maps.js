// Regenerates mapdata.json (collision boxes per map) from the game client itself, so the server's
// line-of-sight and bot navigation match what players collide with. Usage: node tools/dump-maps.js [port]
const fs = require('fs');
const { chromium } = require('playwright');
const MAPS = ['districts', 'shipment', 'killhouse', 'blackout', 'range', 'monastery'];
(async () => {
  const port = process.argv[2] || 8090;
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
  const out = JSON.parse(fs.readFileSync('mapdata.json', 'utf8'));
  for (const m of MAPS) {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/cod/?debug=1&quality=potato&map=${m}&photo=0,40,0,0,-1.4`);
    await page.waitForFunction(() => typeof window.__dumpObstacles === 'function', null, { timeout: 30000 });
    await page.waitForTimeout(2500);
    const boxes = await page.evaluate(() => window.__dumpObstacles());
    console.log(m, 'boxes', boxes.length, 'was', (out[m] || []).length);
    out[m] = boxes;
    await page.close();
  }
  fs.writeFileSync('mapdata.json', JSON.stringify(out));
  await browser.close();
})();
