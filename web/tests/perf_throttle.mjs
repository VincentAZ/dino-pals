import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/\/$/, '');   // web/ (this script lives in web/tests or web/scripts)
const PORT = 4600 + Math.floor(Math.random() * 300);
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('localhost')) res(); }));
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--enable-features=Vulkan'] });
const ctx = await browser.newContext({ ...devices['iPad Pro 11'], viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.goto(`http://localhost:${PORT}/?q=${process.argv[2] || 'high'}`); await page.waitForSelector('#splash'); await page.waitForTimeout(300); await page.touchscreen.tap(590, 410);
await page.waitForFunction(() => window.__dino && window.__dino.ready); await page.waitForFunction(() => !window.__dino.busy(), null, { timeout: 90000 }).catch(() => {});
if (process.env.BIOME) { await page.evaluate(([b, h]) => { const a = window.__dino; a.teleportBiome(b); if (h) a.setTime(+h); }, [process.env.BIOME, process.env.HOUR]); await page.waitForFunction(() => !window.__dino.busy(), null, { timeout: 90000 }).catch(() => {}); }
await page.waitForTimeout(4000);
const cdp = await ctx.newCDPSession(page);
for (const rate of [1, 4, 6]) {
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
  await page.evaluate(() => window.__dino.food());
  await page.waitForTimeout(9000);
  const s = await page.evaluate(() => window.__dino.stats());
  console.log(`cpu x${rate}: fps ${s.fps} frameMs ${s.frameMs} dinoMs ${s.dinoMs} max ${s.dinoMaxMs} route ${JSON.stringify(s.route)} animated ${s.dinos.animated} tris ${s.triangles} calls ${s.calls}`);
}
await browser.close(); try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill(); }
