// Renders splash hero images from the game itself (director camera, controls hidden).
//   node tests/hero.mjs  -> tests/shots/hero/hero_<n>.png
import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const ROOT = '/home/vincent/Repos/dinos/web';
const OUT = ROOT + '/tests/shots/hero'; fs.mkdirSync(OUT, { recursive: true });
const PORT = 4600 + Math.floor(Math.random() * 300);
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('localhost')) res(); }));
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--enable-features=Vulkan'] });
const page = await (await browser.newContext({ ...devices['iPad Pro 11'], viewport: { width: 1366, height: 1024 }, deviceScaleFactor: 1.5, hasTouch: true, isMobile: true })).newPage();
const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://localhost:${PORT}/?q=high`); await page.waitForSelector('#splash'); await page.waitForTimeout(300); await page.touchscreen.tap(600, 500);
await page.waitForFunction(() => window.__dino && window.__dino.ready); await page.waitForFunction(() => !window.__dino.busy(), null, { timeout: 90000 }).catch(() => {});
await page.waitForTimeout(2000);
await page.addStyleTag({ content: '#hud{display:none!important}' });
const SHOTS = JSON.parse(process.env.SHOTS || '[]');
for (const [i, sh] of SHOTS.entries()) {
  await page.evaluate((sh) => {
    const a = window.__dino; a.pause(true); a.setTime(sh.hour ?? 17.2); a.teleport(sh.player[0], sh.player[1]);
    const ids = {}; let k = 0;
    for (const [sp, x, z, h] of sh.cast) { const d = a.dinos.find((q) => q.species === sp && !q.baby && !Object.values(ids).includes(q.id)); if (d) { ids[sp + k++] = d.id; a.command(d.id, { place: [x, z, h], stop: true }); } }
    for (const d of a.dinos) if (!Object.values(ids).includes(d.id) && Math.hypot(d.x - sh.player[0], d.z - sh.player[1]) < 90) a.command(d.id, { place: [300 + Math.random() * 100, 300 + Math.random() * 100, 0], stop: true });
    window.__heroIds = ids;
  }, sh);
  for (let t = 0; t < 120; t++) { const ok = await page.evaluate(() => Object.values(window.__heroIds).every((id) => window.__dino.dinos.find((d) => d.id === id).real)); if (ok) break; await page.evaluate(() => window.__dino.step(3)); await page.waitForTimeout(60); }
  await page.waitForFunction(() => !window.__dino.busy(), null, { timeout: 30000 }).catch(() => {});
  await page.evaluate((sh) => { const a = window.__dino; for (const [sp, x, z, h] of sh.cast) { const id = Object.entries(window.__heroIds).find(([k]) => k.startsWith(sp))?.[1]; if (id) a.command(id, { place: [x, z, h], stop: true }); } a.teleport(sh.cam[0], sh.cam[2]); a.step(40); const gy = a.stats().player.y; if (sh.eye) a.teleport(sh.eye[0], sh.eye[1]); a.step(2); if (sh.roar) { const id = Object.entries(window.__heroIds).find(([k]) => k.startsWith(sh.roar))?.[1]; if (id) { a.command(id, { release: true }); const xy = a.screenOf(id); if (xy) a.tapAt(xy[0], xy[1]); a.step(sh.roarFrames ?? 28); } } a.clearFx(); if (sh.nofp) a.showFootprints(false); const y = gy; a.director([sh.cam[0], y + sh.cam[1], sh.cam[2]], null, [sh.look[0], y + sh.look[1], sh.look[2]]); a.step(2); }, sh);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/hero_${i}.png` });
}
console.log('errors', errors.length, errors.slice(0, 3));
await browser.close(); try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill(); }
