// Records the full Milestone 2 feature tour with on-screen captions.
// Usage: node tools/record-showcase.js [port] [outFile]   (server must be running)
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const FF = process.env.FFMPEG || '/Volumes/workplace/HW/Capstone_Proposal/venv/lib/python3.14/site-packages/imageio_ffmpeg/binaries/ffmpeg-macos-aarch64-v9.0';

(async () => {
  const port = process.argv[2] || 8090;
  const out = path.resolve(process.argv[3] || 'docs/media/nemesis_m2_showcase.mp4');
  const tmp = fs.mkdtempSync('/tmp/rec-');
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: tmp, size: { width: 1280, height: 720 } } });
  const page = await ctx.newPage();
  const wait = (s) => page.waitForTimeout(s * 1000);
  const key = (k) => page.keyboard.press(k);
  const cam = (c) => page.evaluate((m) => { const a = window.__aipov; a.camMode = m; a.cam = null; a.look = null; a.fly.pos = null; }, c);

  // caption bar at the bottom, chapter tag at the top right
  const caption = (chapter, text) => page.evaluate(([c, t]) => {
    let el = document.getElementById('tourCap');
    if (!el) {
      el = document.createElement('div'); el.id = 'tourCap';
      el.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);max-width:1000px;padding:12px 22px;background:#000d;color:#fff;font:600 19px/1.4 Helvetica,Arial,sans-serif;border-radius:10px;border-bottom:3px solid #ff5544;z-index:9999;text-align:center;box-shadow:0 4px 20px #0008';
      document.body.appendChild(el);
      const tag = document.createElement('div'); tag.id = 'tourTag';
      tag.style.cssText = 'position:fixed;right:24px;top:64px;padding:6px 14px;background:#ff5544;color:#fff;font:800 14px Helvetica,Arial,sans-serif;letter-spacing:2px;border-radius:6px;z-index:9999';
      document.body.appendChild(tag);
    }
    el.innerHTML = t; el.style.display = t ? 'block' : 'none';
    const tag = document.getElementById('tourTag'); tag.textContent = c; tag.style.display = c ? 'block' : 'none';
  }, [chapter, text]);

  const card = (html, secs) => page.evaluate(([h]) => {
    let el = document.getElementById('tourCard');
    if (!el) {
      el = document.createElement('div'); el.id = 'tourCard';
      el.style.cssText = 'position:fixed;inset:0;background:linear-gradient(135deg,#0b0f14ee,#2a0d0dee);color:#fff;z-index:10000;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:Helvetica,Arial,sans-serif;text-align:center';
      document.body.appendChild(el);
    }
    el.innerHTML = h; el.style.display = h ? 'flex' : 'none';
  }, [html]).then(() => (secs ? wait(secs) : null));

  await page.goto(`http://127.0.0.1:${port}/cod/?demo=1&map=killhouse&skill=average`);
  await card(`<div style="font-size:54px;font-weight:900;letter-spacing:6px;color:#ff5544">NEMESIS ENGINE</div>
    <div style="font-size:26px;margin-top:10px">Milestone 2 &middot; v0.2 bots</div>
    <div style="font-size:19px;margin-top:28px;color:#cbd5dc;line-height:1.6">Bots that find their way around every map,<br>sprint, slide, jump and swap weapons,<br>and learn how you play while the match is running.</div>
    <div style="font-size:15px;margin-top:30px;color:#8a99a5">Siddharth Pathak &middot; Full Sail CSMS Capstone</div>`, 6);
  await page.evaluate(() => { window.__aipov.noKeys = true; });
  await card('');
  await wait(2);

  // 1. third person
  await caption('3RD PERSON', 'Over-the-shoulder camera on the bot. The <span style="color:#5df">cyan line</span> is the route it planned across the map.');
  await wait(9);
  await caption('3RD PERSON', 'The panel shows what it is doing right now: its state, fight plan, weapon, and abilities (SPRINT / SLIDE / JUMP chips).');
  await wait(10);
  await caption('ABILITIES', 'It sprints on long moves, slides into fights, jumps while strafing, and swaps guns for the range: shotgun close, rifle mid, sniper long.');
  await wait(12);

  // 2. first person
  await cam('first');
  await caption('1ST PERSON', 'Through the bot\'s eyes. This is exactly where it is looking. Shots only fire when it is facing its target (the facing bug is fixed).');
  await wait(14);

  // 3. world camera, flying around
  await cam('world');
  await caption('WORLD CAMERA', 'A free world camera can fly anywhere on the map, so you can watch the bot and the player at the same time.');
  await wait(3);
  await page.keyboard.down('KeyW'); await wait(1.2); await page.keyboard.up('KeyW');
  await page.mouse.move(640, 360); await page.mouse.down();
  for (let i = 0; i < 30; i++) { await page.mouse.move(640 + i * 4, 360, { steps: 1 }); await wait(0.05); }
  await page.mouse.up();
  await page.keyboard.down('KeyA'); await wait(1); await page.keyboard.up('KeyA');
  await wait(4);
  await cam('world');   // reset the free camera next to the bot again
  await wait(3);

  // 4. what it learned
  await cam('world');
  await caption('LEARNING', '<span style="color:#fc3">Yellow tiles</span>: where this player usually goes (updated every second). When the bot patrols, it heads there.');
  await wait(11);
  await caption('LEARNING', '<span style="color:#f45">Red tiles</span>: where the bot died. <span style="color:#f45">Red arrows</span>: where it was shot from. Next life it avoids those spots and pre-aims them.');
  await wait(11);
  await cam('third');
  await caption('LEARNING', 'After every kill or death the bot scores its fight plan and writes a lesson in the panel. Plans that work on this player get picked more often.');
  await wait(13);

  // 5. expertise
  await key('KeyK');   // average -> expert
  await caption('SKILL LEVEL', 'The player is now playing at EXPERT level. Every 5 seconds the bot re-rates the player\'s skill from how they move and fight.');
  await wait(14);
  await caption('SKILL LEVEL', 'The "player skill" line in the panel shows its rating. Against an expert the bot reacts faster, aims tighter, and slides and jumps more.');
  await wait(16);
  await key('KeyK');   // expert -> beginner
  await caption('SKILL LEVEL', 'Now the player is a BEGINNER. Once the bot rates them, it eases off: slower reactions, wider aim, no slides or flanks.');
  await wait(18);
  await key('KeyK'); await key('KeyK');   // back to expert for the map tour

  // 6. all maps
  const maps = ['RANGE', 'BLACKOUT', 'DISTRICTS', 'MONASTERY', 'SHIPMENT'];
  const views = ['world', 'third', 'world', 'third', 'world'];
  const notes = ['', ' Blackout is a night map, so it is dark.', '', '', ''];
  for (let i = 0; i < maps.length; i++) {
    await key('KeyM');
    await wait(1.5);
    await cam(views[i]);
    await caption('ALL MAPS', `${maps[i]}: same bot, same learning. It plans routes around walls, up stairs, onto ledges and off drops.${notes[i]}`);
    await wait(10);
  }

  // 7. panel sizes
  await cam('third');
  await key('KeyH'); await key('KeyH');
  await caption('3RD PERSON', 'The same match without the panel: the bot moving, fighting and adapting on its own.');
  await wait(9);
  await key('KeyH');
  await caption('', '');

  // 8. results (numbers from docs/MILESTONE2.md, 162 simulated matches)
  const row = (a, b, c) => `<tr><td style="padding:8px 20px;text-align:left">${a}</td><td style="padding:8px 20px;color:#9aa5ad">${b}</td><td style="padding:8px 20px;color:#4fe08f;font-weight:800">${c}</td></tr>`;
  await card(`<div style="font-size:34px;font-weight:900;color:#ff5544;letter-spacing:3px">MEASURED: v0.1 vs v0.2</div>
    <div style="font-size:16px;color:#8a99a5;margin:8px 0 20px">162 simulated matches &middot; 6 maps &times; 3 player skills &times; 3 seeds &middot; 10 min each</div>
    <table style="font-size:21px;border-collapse:collapse">
      <tr style="color:#8a99a5;font-size:15px"><td></td><td style="padding:4px 20px">v0.1</td><td style="padding:4px 20px">v0.2</td></tr>
      ${row('Time stuck while moving', '21.9%', '0.2%')}
      ${row('Shots fired while facing away', '186', '0')}
      ${row('Map reached', '27%', '52%')}
      ${row('Sprint / slide / jump / weapon swap', 'never', 'all used')}
      ${row('K/D against expert players', '0.26', '0.45')}
      ${row('Player skill rated right after 60 s', 'n/a', '45 of 54 runs')}
    </table>`, 10);

  const vpath = await page.video().path();
  await ctx.close(); await browser.close();
  require('child_process').execFileSync(FF, ['-loglevel', 'error', '-y', '-i', vpath, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '23', '-movflags', '+faststart', out]);
  console.log('wrote', out);
})();
