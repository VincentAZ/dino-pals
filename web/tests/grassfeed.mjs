// Feeding as the child sees it, in the meadow's tall grass: the pile must stay visible and the grass
// must part around the pile, the dinosaurs' feet and the explorer.
import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/\/$/, '');   // web/ (this script lives in web/tests or web/scripts)
const OUT = ROOT + '/tests/shots/grassfeed'; fs.mkdirSync(OUT, { recursive: true });
const PORT = 4600 + Math.floor(Math.random() * 300);
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('localhost')) res(); }));
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--enable-features=Vulkan'] });
const page = await (await browser.newContext({ ...devices['iPad Pro 11'], viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true })).newPage();
const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://localhost:${PORT}/?q=high${process.env.QS ?? ''}`); await page.waitForSelector('#splash'); await page.waitForTimeout(300); await page.touchscreen.tap(590, 410);
await page.waitForFunction(() => window.__dino && window.__dino.ready); await page.waitForFunction(() => !window.__dino.busy(), null, { timeout: 90000 }).catch(() => {});
await page.waitForTimeout(3000);
await page.evaluate(() => { const a = window.__dino; a.setTime(13); a.pause(true); a.step(10); a.food(); a.step(5); });
for (let i = 0; i < 8; i++) {
  await page.evaluate(() => window.__dino.step(75));
  await page.screenshot({ path: `${OUT}/f${i}.png` });
}
await page.evaluate(() => { const a = window.__dino; const v = a.view(); a.setView(v.yaw, 0.12, 4.5); a.step(1, 0); });
await page.screenshot({ path: `${OUT}/low.png` });
// side views of every dinosaur near the pile, with pose data
const near = await page.evaluate(() => window.__dino.dinos.filter((d) => Math.hypot(d.x, d.z + 5.5) < 12 && d.real).map((d) => d.id));
for (const id of near) {
  const info = await page.evaluate((id) => { const a = window.__dino; a.watch(id, 1.57, 0.08, 9, 0.4); a.step(1, 0); const l = a.loco(id); const p = a.probeDino(id); return { id, state: l.state, ph: l.ph, maxReach: l.maxReach, crouch: l.crouch, spine: p && p.spine1, root: p && p.root, slot: l.slot }; }, id);
  console.log('pose', JSON.stringify(info));
  await page.screenshot({ path: `${OUT}/side_${id}.png` });
}
await page.evaluate(() => window.__dino.watch(null));
console.log(JSON.stringify(await page.evaluate(() => ({ foods: window.__dino.foods(), bites: window.__dino.biteLog().length }))));
console.log('errors', errors.length, errors.slice(0, 3));
await browser.close(); try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill(); }
