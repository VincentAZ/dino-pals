// Robust throttled frame timing: median / p90 frame time over a 6 s window (after streaming settles),
// at a given CPU throttle. Less noisy than the instantaneous EMA in perf_throttle.mjs.
//   RATE=6 BIOME=meadow node tests/perf_median.mjs
import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/\/$/, '');   // web/ (this script lives in web/tests or web/scripts)
const PORT = 4600 + Math.floor(Math.random() * 300);
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('localhost')) res(); }));
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--enable-features=Vulkan'] });
const ctx = await browser.newContext({ ...devices['iPad Pro 11'], viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.goto(`http://localhost:${PORT}/?q=${process.env.Q || 'high'}`); await page.waitForSelector('#splash'); await page.waitForTimeout(300); await page.touchscreen.tap(590, 410);
await page.waitForFunction(() => window.__dino && window.__dino.ready); await page.waitForFunction(() => !window.__dino.busy(), null, { timeout: 90000 }).catch(() => {});
if (process.env.BIOME) { await page.evaluate((b) => window.__dino.teleportBiome(b), process.env.BIOME); await page.waitForFunction(() => !window.__dino.busy(), null, { timeout: 90000 }).catch(() => {}); }
await page.waitForTimeout(5000);
const cdp = await ctx.newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: +(process.env.RATE || 6) });
await page.waitForTimeout(3000);
const r = await page.evaluate(() => new Promise((res) => { const t = []; let last = performance.now(); const t0 = last; const f = () => { const n = performance.now(); t.push(n - last); last = n; if (n - t0 < 6000) requestAnimationFrame(f); else { t.sort((a, b) => a - b); res({ n: t.length, median: +t[t.length >> 1].toFixed(1), p90: +t[Math.floor(t.length * 0.9)].toFixed(1), tris: window.__dino.stats().triangles }); } }; requestAnimationFrame(f); }));
console.log(JSON.stringify(r));
await browser.close(); try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill(); }
