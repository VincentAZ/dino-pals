// Wading: find shallow water (swamp pools, lake and river margins) and film a dinosaur crossing it.
import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/\/$/, '');   // web/ (this script lives in web/tests or web/scripts)
const OUT = ROOT + '/tests/shots/wade'; fs.mkdirSync(OUT, { recursive: true });
const PORT = 4600 + Math.floor(Math.random() * 300);
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('localhost')) res(); }));
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--enable-features=Vulkan'] });
const page = await (await browser.newContext({ ...devices['iPad Pro 11'], viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true })).newPage();
const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://localhost:${PORT}/?q=high`); await page.waitForSelector('#splash'); await page.waitForTimeout(300); await page.touchscreen.tap(590, 410);
await page.waitForFunction(() => window.__dino && window.__dino.ready); await page.waitForFunction(() => !window.__dino.busy(), null, { timeout: 90000 }).catch(() => {});
// a straight 16 m crossing: dry, then >= 4 m of 0.1-0.35 m deep water, then dry
const spot = await page.evaluate(() => {
  const a = window.__dino;
  const centers = [a.biomes.swamp, a.biomes.lake, [0, 0]];
  for (const [cx, cz] of centers) for (let r = 0; r < 260; r += 6) for (let k = 0; k < 24; k++) {
    const ang = (k / 24) * Math.PI * 2; const x = cx + Math.cos(ang) * r, z = cz + Math.sin(ang) * r;
    for (let dk = 0; dk < 4; dk++) {
      const dir = (dk / 4) * Math.PI; const dx = Math.cos(dir), dz = Math.sin(dir);
      const samples = []; for (let s = -8; s <= 8; s += 1) { const g = a.ground(x + dx * s, z + dz * s); samples.push(g.water < 0 ? (g.h > 0.4 ? 0 : -9) : g.water - g.h); }
      if (samples[0] !== 0 || samples[16] !== 0) continue;
      if (samples.some((v) => v > 0.33 || v === -9)) continue;
      if (samples.filter((v) => v > 0.1).length < 4) continue;
      return { x, z, dx, dz };
    }
  }
  return null;
});
console.log('spot', JSON.stringify(spot));
if (spot) {
  for (const sp of ['triceratops', 'trex']) {
    const id = await page.evaluate(([spot, sp]) => { const a = window.__dino; a.pause(true); a.setTime(12); a.teleport(spot.x - spot.dz * 14, spot.z + spot.dx * 14); const me = a.dinos.find((d) => d.species === sp && !d.baby); a.command(me.id, { place: [spot.x - spot.dx * 9, spot.z - spot.dz * 9, Math.atan2(spot.dx, spot.dz)], stop: true }); return me.id; }, [spot, sp]);
    for (let i = 0; i < 150; i++) { const r = await page.evaluate((id) => { window.__dino.step(3); return window.__dino.dinos.find((d) => d.id === id).real; }, id); if (r) break; await page.waitForTimeout(50); }
    await page.evaluate(([id, spot]) => { const a = window.__dino; a.command(id, { place: [spot.x - spot.dx * 9, spot.z - spot.dz * 9, Math.atan2(spot.dx, spot.dz)], stop: true }); a.step(20); a.command(id, { walkTo: [spot.x + spot.dx * 10, spot.z + spot.dz * 10] }); a.watch(id, -1.1, 0.55, 12, 0.2); }, [id, spot]);
    for (let f = 0; f < 6; f++) { await page.evaluate(() => window.__dino.step(25)); await page.screenshot({ path: `${OUT}/${sp}_${f}.png` }); }
    console.log(sp, JSON.stringify(await page.evaluate((id) => { const l = window.__dino.loco(id); return { pos: l.pos, state: l.state, blocked: l.blocked }; }, id)));
    await page.evaluate((id) => { const a = window.__dino; a.watch(null); a.command(id, { place: [400, 400, 0], stop: true }); }, id);
  }
}
console.log('errors', errors.length, errors.slice(0, 3));
await browser.close(); try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill(); }
