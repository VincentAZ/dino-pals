// The two known asset shortfalls, rendered as the child sees them:
//   tall firs at 3 / 6 / 12 m from the game camera height, and the volcano at dusk.
//   OUT=<dir> node tests/shortfalls.mjs
import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const ROOT = '/home/vincent/Repos/dinos/web';
const OUT = process.env.OUT || ROOT + '/tests/shots/shortfalls'; fs.mkdirSync(OUT, { recursive: true });
const PORT = 4600 + Math.floor(Math.random() * 300);
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('localhost')) res(); }));
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--enable-features=Vulkan'] });
const page = await (await browser.newContext({ ...devices['iPad Pro 11'], viewport: { width: 1024, height: 768 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true })).newPage();
const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://localhost:${PORT}/?q=${process.env.Q || 'high'}`); await page.waitForSelector('#splash'); await page.waitForTimeout(300); await page.touchscreen.tap(512, 384);
await page.waitForFunction(() => window.__dino && window.__dino.ready); await page.waitForFunction(() => !window.__dino.busy(), null, { timeout: 90000 }).catch(() => {});
await page.addStyleTag({ content: '#hud{display:none!important}' });
const settle = async () => { for (let i = 0; i < 200; i++) { const b = await page.evaluate(() => { window.__dino.step(2); return window.__dino.busy(); }); if (!b && i > 15) break; await page.waitForTimeout(80); } };
// --- tall firs
await page.evaluate(() => { const a = window.__dino; a.pause(true); a.setTime(12); a.teleportBiome('snow'); });
await settle();
const fir = await page.evaluate(() => window.__dino.vegNear('fir_tree_01'));
console.log('fir', JSON.stringify(fir));
for (const d of [3, 6, 12]) {
  await page.evaluate(([f, d]) => { const a = window.__dino; a.teleport(f[0] + d * 0.8, f[2] + d * 0.6); a.step(4); const g = a.ground(f[0] + d * 0.8, f[2] + d * 0.6); a.clearFx(); a.director([f[0] + d * 0.8, g.h + 2.4, f[2] + d * 0.6], null, [f[0], g.h + 2.6 + d * 0.12, f[2]]); a.step(2); }, [fir, d]);
  await settle();
  await page.evaluate(() => { window.__dino.clearFx(); window.__dino.step(1, 0); });
  await page.screenshot({ path: `${OUT}/fir_${String(d).padStart(2, '0')}m.png` });
}
await page.evaluate(() => window.__dino.director(null));
// --- the snow biome as the child arrives (game camera), noon and dusk
for (const [name, h] of [['snow_arrive', 12], ['snow_arrive_dusk', 19.3]]) {
  await page.evaluate((h) => { const a = window.__dino; a.setTime(h); a.teleportBiome('snow'); }, h);
  await settle();
  await page.evaluate(() => { window.__dino.clearFx(); window.__dino.step(1, 0); });
  await page.screenshot({ path: `${OUT}/${name}.png` });
}
// --- volcano at dusk
const VIEWS = [
  ['volc_meadow', 19.3, `a.teleport(0,-60); a.lookAt(20,-520); a.setView(a.view().yaw, 0.06, 7)`],
  ['volc_lower', 19.3, `a.teleport(-30,-380); a.lookAt(20,-520); a.setView(a.view().yaw, 0.15, 7)`],
  ['volc_biome', 19.3, `a.teleportBiome('volcano')`],
  ['volc_biome_late', 19.9, `a.teleportBiome('volcano')`],
  ['volc_biome_night', 23.0, `a.teleportBiome('volcano')`],
  ['volc_far_night', 22.5, `a.teleport(0,-60); a.lookAt(20,-520); a.setView(a.view().yaw, 0.06, 7)`],
  ['volc_lower_noon', 12.5, `a.teleport(-30,-380); a.lookAt(20,-520); a.setView(a.view().yaw, 0.15, 7)`],
];
for (const [name, h, js] of VIEWS) {
  await page.evaluate(([h, js]) => { const a = window.__dino; a.setTime(h); (new Function('a', js))(a); }, [h, js]);
  await settle();
  await page.evaluate(() => { window.__dino.clearFx(); window.__dino.step(1, 0); });
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(name, JSON.stringify(await page.evaluate(() => { const s = window.__dino.stats(); return { p: s.player, light: s.light, h: s.hours }; })));
}
console.log('errors', errors.length, errors.slice(0, 3));
await browser.close(); try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill(); }
