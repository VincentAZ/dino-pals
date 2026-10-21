import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const ROOT = '/home/vincent/Repos/dinos/web';
const OUT = ROOT + '/tests/shots/look'; fs.mkdirSync(OUT, { recursive: true });
const PORT = 4600 + Math.floor(Math.random() * 300);
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('localhost')) res(); }));
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--enable-features=Vulkan'] });
const page = await (await browser.newContext({ ...devices['iPad Pro 11'], viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1 })).newPage();
const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://localhost:${PORT}/?q=high`); await page.waitForSelector('#splash'); await page.waitForTimeout(300); await page.touchscreen.tap(590, 410);
await page.waitForFunction(() => window.__dino && window.__dino.ready); await page.waitForFunction(() => !window.__dino.busy(), null, { timeout: 60000 }).catch(() => {});
for (const [biome, sp, prefix, az, el, dist] of [['meadow', 'ornithocheirus', 'ptero', -1.57, 0.05, 10], ['beach', 'mosasaurus', 'mosa', -1.57, 0.35, 26], ['beach', 'pistosaurus', 'pisto', -1.57, 0.3, 9]]) {
  await page.evaluate((b) => { const a = window.__dino; a.pause(false); a.setTime(13); a.teleportBiome(b); }, biome);
  await page.waitForTimeout(4000);
  await page.waitForFunction(() => !window.__dino.busy(), null, { timeout: 60000 }).catch(() => {});
  const id = await page.evaluate((sp) => { const a = window.__dino; a.pause(true); const p = a.stats().player; const ds = a.dinos.filter((d) => d.species === sp).sort((x, y) => Math.hypot(x.x - p.x, x.z - p.z) - Math.hypot(y.x - p.x, y.z - p.z)); return ds[0].id; }, sp);
  for (let i = 0; i < 100; i++) { const r = await page.evaluate((id) => { const a = window.__dino; a.step(3); return a.dinos.find((d) => d.id === id).real; }, id); if (r) break; await page.waitForTimeout(50); }
  await page.evaluate(([id, az, el, dist]) => window.__dino.watch(id, az, el, dist, 0.3), [id, az, el, dist]);
  for (let f = 0; f < 12; f++) { await page.evaluate(() => window.__dino.step(5)); await page.screenshot({ path: `${OUT}/${prefix}_${String(f).padStart(2, '0')}.png` }); }
  console.log(prefix, JSON.stringify(await page.evaluate((id) => window.__dino.probeVis(id), id)));
  await page.evaluate(() => window.__dino.watch(null));
}
console.log('errors', errors.length);
await browser.close(); try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill(); }
