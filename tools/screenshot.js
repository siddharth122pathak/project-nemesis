// Dev helper: opens the game in headless Chromium, starts a match with one Nemesis bot,
// strafes for a while, and saves docs/images/gameplay.png. Usage: node tools/screenshot.js [port]
const { chromium } = require('playwright');
(async () => {
  const port = process.argv[2] || 8090;
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto(`http://127.0.0.1:${port}/cod/`);
  await page.waitForTimeout(2500);
  await page.click('[data-nav="scrPlay"]').catch((e) => console.log('nav', e.message));
  await page.waitForTimeout(500);
  await page.fill('#nameInput', 'SID').catch(() => {});
  await page.click('[data-map="shipment"]').catch(() => {});
  await page.click('#createBtn');
  await page.waitForTimeout(1500);
  await page.$eval('#addBotBtn', (b) => b.click());
  await page.waitForTimeout(500);
  await page.$eval('#startBtn', (b) => b.click());
  await page.waitForTimeout(4000);
  for (let i = 0; i < 24; i++) {
    const key = i % 2 ? 'KeyA' : 'KeyD';
    await page.keyboard.down(key); await page.waitForTimeout(900); await page.keyboard.up(key);
  }
  await page.screenshot({ path: 'docs/images/gameplay.png' });
  console.log(await page.evaluate(() => document.getElementById('nemesisHud')?.textContent));
  await browser.close();
})();
