import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/\/$/, '');   // web/ (this script lives in web/tests or web/scripts)
const PORT = 4600 + Math.floor(Math.random() * 300);
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('localhost')) res(); }));
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--enable-features=Vulkan'] });
const page = await (await browser.newContext({ ...devices['iPad Pro 11'], viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1 })).newPage();
await page.goto(`http://localhost:${PORT}/?q=high`); await page.waitForSelector('#splash'); await page.waitForTimeout(300); await page.touchscreen.tap(590, 410);
await page.waitForFunction(() => window.__dino && window.__dino.ready); await page.waitForFunction(() => !window.__dino.busy(), null, { timeout: 60000 }).catch(() => {});
const SPS = ['triceratops', 'stegosaurus', 'paluxysaurus'];
const ids = await page.evaluate((sps) => {
  const a = window.__dino; a.pause(true); a.teleport(0, 0); a.setView(0, 0.3, 8);
  const ids = []; let k = 0;
  for (const d of a.dinos) if (Math.hypot(d.x, d.z) < 150) a.command(d.id, { place: [300 + 30 * (k++), 300, 0], stop: true });
  sps.forEach((sp, i) => { const d = a.dinos.find((x) => x.species === sp); a.command(d.id, { place: [-25 + 25 * i, -45, 0], stop: true }); ids.push(d.id); });
  return ids;
}, SPS);
for (let i = 0; i < 100; i++) { const ok = await page.evaluate((ids) => { const a = window.__dino; a.step(3); return ids.every((id) => a.dinos.find((d) => d.id === id).real); }, ids); if (ok) break; await page.waitForTimeout(60); }
await page.evaluate((ids) => { const a = window.__dino; ids.forEach((id, i) => a.command(id, { place: [-25 + 25 * i, -45, 0], stop: true })); a.step(10); for (const id of ids) a.command(id, { release: true }); a.dropFoodAt(0, -12); }, ids);
for (let t = 0; t < 34; t++) {
  const r = await page.evaluate((id) => { const a = window.__dino; a.step(30); const l = a.loco(id); return { pos: l.pos, h: l.heading, st: l.state, ph: l.ph, v: l.speed, standAt: l.standAt, item: l.standItem, bite: l.biteItem, repo: l.repo, trim: l.trim, slot: l.slot, pa: l.progressAge }; }, ids[0]);
  console.log(JSON.stringify(r));
}
await browser.close(); try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill(); }
