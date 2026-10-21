// Long-session memory: tour every biome several times; GPU geometries / textures and the JS heap must
// plateau (streamed terrain, vegetation and dinosaurs are released when left behind), not grow per lap.
import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
import { GL_TRACK } from './gltrack.mjs';
const ROOT = '/home/vincent/Repos/dinos/web';
const PORT = 4600 + Math.floor(Math.random() * 300);
const LAPS = +(process.env.LAPS || 4);
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('localhost')) res(); }));
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--enable-features=Vulkan', '--enable-precise-memory-info', '--js-flags=--expose-gc'] });
const ctx = await browser.newContext({ ...devices['iPad Pro 11'], viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
await ctx.addInitScript(GL_TRACK);
const page = await ctx.newPage();
const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://localhost:${PORT}/?q=high`); await page.waitForSelector('#splash'); await page.waitForTimeout(300); await page.touchscreen.tap(590, 410);
await page.waitForFunction(() => window.__dino && window.__dino.ready); await page.waitForFunction(() => !window.__dino.busy(), null, { timeout: 90000 }).catch(() => {});
const biomes = ['meadow', 'jungle', 'volcano', 'beach', 'swamp', 'snow', 'canyon', 'lake'];
const rows = [];
for (let lap = 0; lap < LAPS; lap++) {
  for (const b of biomes) {
    await page.evaluate((b) => { const a = window.__dino; a.teleportBiome(b); a.food(); }, b);
    await page.waitForFunction(() => !window.__dino.busy(), null, { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(2500);
  }
  await page.evaluate(() => { window.__dino.teleportBiome('meadow'); });
  await page.waitForFunction(() => !window.__dino.busy(), null, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(3000);
  const m = await page.evaluate(() => { if (window.gc) window.gc(); const s = window.__dino.stats(); return { geo: s.geometries, tex: s.textures, gpuTexMB: window.__texMB(), heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(0) : -1, fps: s.fps }; });
  rows.push(m); console.log(`lap ${lap + 1}`, JSON.stringify(m));
}
const first = rows[1] ?? rows[0], last = rows[rows.length - 1];
const ok = last.geo <= first.geo * 1.15 + 30 && last.tex <= first.tex * 1.15 + 10 && last.gpuTexMB <= first.gpuTexMB * 1.15 + 20 && (last.heapMB < 0 || last.heapMB <= first.heapMB * 1.3 + 30) && errors.length === 0;
console.log('errors', errors.length, errors.slice(0, 2));
console.log(ok ? 'LEAK PASSED (plateau after lap 2)' : 'LEAK FAILED (still growing)');
await browser.close(); try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill(); }
process.exit(ok ? 0 : 1);
