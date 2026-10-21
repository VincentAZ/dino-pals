import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
const ROOT = '/home/vincent/Repos/dinos/web';
const PORT = 4600 + Math.floor(Math.random() * 300);
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('localhost')) res(); }));
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--enable-features=Vulkan'] });
const page = await (await browser.newContext({ ...devices['iPad Pro 11'], viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1 })).newPage();
await page.goto(`http://localhost:${PORT}/?q=high`); await page.waitForSelector('#splash'); await page.waitForTimeout(300); await page.touchscreen.tap(590, 410);
await page.waitForFunction(() => window.__dino && window.__dino.ready); await page.waitForFunction(() => !window.__dino.busy(), null, { timeout: 60000 }).catch(() => {});
const SP = process.argv[2] || 'triceratops';
const id = await page.evaluate((sp) => {
  const a = window.__dino; a.pause(true); a.teleport(0, 0); a.setView(0, 0.3, 8);
  let k = 0; const me = a.dinos.find((d) => d.species === sp);
  for (const d of a.dinos) if (d.id !== me.id && Math.hypot(d.x, d.z) < 150) a.command(d.id, { place: [300 + 30 * (k++), 300, 0], stop: true });
  a.command(me.id, { place: [-8, -24, 0], stop: true }); return me.id;
}, SP);
for (let i = 0; i < 100; i++) { const ok = await page.evaluate((id) => { const a = window.__dino; a.step(3); return a.dinos.find((d) => d.id === id).real; }, id); if (ok) break; await page.waitForTimeout(60); }
await page.evaluate((id) => { const a = window.__dino; a.command(id, { place: [-8, -24, 0], stop: true }); a.step(5); a.command(id, { release: true }); a.dropFoodAt(0, -12); }, id);
for (let t = 0; t < 60; t++) {
  const st = await page.evaluate((id) => { const a = window.__dino; a.step(15); const l = a.loco(id); const f = a.foods()[0]; return { t: l ? undefined : null, pos: l.pos, h: l.heading, st: l.state, v: l.speed, tgt: l.target, food: f }; }, id);
  console.log(JSON.stringify(st));
}
console.log(JSON.stringify(await page.evaluate(() => window.__dino.biteLog()), null, 0));
await browser.close(); try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill(); }
