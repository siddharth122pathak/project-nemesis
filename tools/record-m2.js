// Records the Milestone 2 demo video: a bot learning an expert player, switching cameras and maps.
// Usage: node tools/record-m2.js [port] [outDir]   (server must be running)
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const FF = '/Volumes/workplace/HW/Capstone_Proposal/venv/lib/python3.14/site-packages/imageio_ffmpeg/binaries/ffmpeg-macos-aarch64-v9.0';
(async () => {
  const port = process.argv[2] || 8090, out = path.resolve(process.argv[3] || 'docs/media');
  fs.mkdirSync(out, { recursive: true });
  const tmp = fs.mkdtempSync('/tmp/rec-');
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: tmp, size: { width: 1280, height: 720 } } });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/cod/?demo=1&map=killhouse&skill=expert`);
  const cam = (c) => page.evaluate((m) => { const a = window.__aipov; a.camMode = m; a.cam = null; a.look = null; a.fly.pos = null; }, c);
  await page.waitForTimeout(4000);
  for (const [map, steps] of [['killhouse', ['third', 'first', 'world', 'third']], ['shipment', ['third', 'world', 'first']], ['blackout', ['third', 'world']]]) {
    if (map !== 'killhouse') { await page.keyboard.press('KeyM'); await page.waitForTimeout(500); if (map === 'blackout') { await page.keyboard.press('KeyM'); await page.keyboard.press('KeyM'); } await page.waitForTimeout(3000); }
    for (const c of steps) { await cam(c); await page.waitForTimeout(12000); }
  }
  const vpath = await page.video().path();
  await ctx.close(); await browser.close();
  const mp4 = path.join(out, 'nemesis_m2_demo.mp4');
  require('child_process').execFileSync(FF, ['-loglevel', 'error', '-y', '-i', vpath, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '24', mp4]);
  console.log('wrote', mp4);
})();
