// Same views rendered in Chromium and in WebKit (Safari's engine) with an iPad profile, to check the
// GPU-compressed assets (KTX2 conifer needles, terrain layers, dinosaur and food textures) transcode and
// render in Safari, not just in Chrome. Paused + stepped, so both engines see the same frame.
import { chromium, webkit, devices } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const ROOT = '/home/vincent/Repos/dinos/web';
const OUT = ROOT + '/tests/shots/parity'; fs.mkdirSync(OUT, { recursive: true });
const PORT = 4600 + Math.floor(Math.random() * 300);
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('127.0.0.1')) res(); }));
const VIEWS = process.env.SKY ? [{ name: 'sky', js: `const a=window.__dino; a.teleport(0,0); a.setView(0.6,-0.32,7); return 'none'` }, { name: 'sky2', js: `const a=window.__dino; a.teleportBiome('snow'); a.setView(2.2,-0.3,7); return 'none'` }] : [
  { name: 'fir-young-close', js: `const a=window.__dino; a.teleportBiome('snow'); return 'veg:fir_sapling_medium:4.5:1.6'` },
  { name: 'conifer-mid', js: `const a=window.__dino; a.teleportBiome('snow'); return 'veg:fir_tree_01:14:3'` },
  { name: 'volcano-slope', js: `const a=window.__dino; a.teleportBiome('volcano'); a.setView(a.view().yaw, 0.55, 5); return 'none'` },
  { name: 'trex-close', js: `const a=window.__dino; a.teleport(0,0); const d=a.dinos.find(x=>x.species==='trex'&&!x.baby); a.command(d.id,{place:[0,-10,0],stop:true}); return 'dino:'+d.id` },
  { name: 'food-pile', js: `const a=window.__dino; a.teleport(0,0); a.setView(0,0.55,4); a.dropFoodAt(0,-3); return 'none'` },
];
const engines = (process.env.ENGINES || 'chromium,webkit').split(',');
for (const eng of engines) {
  const browser = eng === 'webkit' ? await webkit.launch({ headless: true }) : await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--enable-features=Vulkan'] });
  const ctx = await browser.newContext({ ...devices['iPad Pro 11'], viewport: { width: 1024, height: 768 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(String(e).slice(0, 300))); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
  await page.goto(`http://127.0.0.1:${PORT}/?q=high`, { waitUntil: 'load' });
  await page.waitForSelector('#splash', { timeout: 60000 }); await page.waitForTimeout(500); await page.touchscreen.tap(512, 384);
  await page.waitForFunction(() => window.__dino && window.__dino.ready, null, { timeout: 180000 });
  const fmt = await page.evaluate(() => { const g = document.querySelector('#app canvas').getContext('webgl2'); return ['WEBGL_compressed_texture_astc', 'WEBGL_compressed_texture_etc', 'WEBGL_compressed_texture_s3tc', 'EXT_texture_compression_bptc'].filter((e) => g.getExtension(e)).map((e) => e.replace(/^.*texture_(compression_)?/, '')); });
  console.log(eng, 'compressed formats:', fmt.join(',') || 'none (RGBA fallback)');
  for (const v of VIEWS) {
    const target = await page.evaluate((js) => { window.__dino.pause(true); window.__dino.setTime(12); return (new Function(js))(); }, v.js);
    // let streaming finish (step the world while waiting)
    for (let i = 0; i < 240; i++) { const busy = await page.evaluate(() => { window.__dino.step(2); return window.__dino.busy(); }); if (!busy && i > 20) break; await page.waitForTimeout(100); }
    await page.evaluate((target) => {
      const a = window.__dino; a.clearFx();
      if (target.startsWith('veg:')) { const [, id, dist, h] = target.split(':'); const p = a.vegNear(id); if (p) { const g = a.stats().player; a.director([p[0] + +dist * 0.7, p[1] + +h, p[2] + +dist * 0.7], null, [p[0], p[1] + +h * 0.9, p[2]]); } }
      else if (target.startsWith('dino:')) { const id = target.slice(5); a.watch(id, 0.8, 0.12, 9, 0.5); }
      a.step(2);
    }, target);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/${v.name}_${eng}.png` });
    await page.evaluate(() => { const a = window.__dino; a.director(null); a.watch(null); });
  }
  console.log(eng, 'errors', errors.length, errors.slice(0, 4));
  await browser.close();
}
try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill(); }
