import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
const ROOT = '/home/vincent/Repos/dinos/web';
const PORT = 4600 + Math.floor(Math.random() * 300);
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('localhost')) res(); }));
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--enable-features=Vulkan'] });
const page = await (await browser.newContext({ ...devices['iPad Pro 11'], viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2 })).newPage();
await page.goto(`http://localhost:${PORT}/?q=high`); await page.waitForSelector('#splash'); await page.waitForTimeout(300); await page.touchscreen.tap(590, 410);
await page.waitForFunction(() => window.__dino && window.__dino.ready); await page.waitForFunction(() => !window.__dino.busy(), null, { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(8000);
// CPU cost of the dinosaur update, measured in the real loop
const s1 = await page.evaluate(() => window.__dino.stats());
console.log('real loop: fps', s1.fps, 'frameMs', s1.frameMs, 'dinoMs', s1.dinoMs, 'dinos', JSON.stringify(s1.dinos));
// worst case: 16 animated dinos walking near the player, timed with step()
const t = await page.evaluate(() => {
  const a = window.__dino; a.pause(true);
  const land = a.dinos.filter((d) => ['trex','triceratops','stegosaurus','paluxysaurus','velociraptor','iguanodon','ankylosaurus','sauropelta','pachycephalosaurus','allosaurus','spinosaurus','carnotaurus'].includes(d.species)).slice(0, 16);
  land.forEach((d, i) => { a.command(d.id, { place: [-40 + (i % 4) * 22, -30 - Math.floor(i / 4) * 22, 0], stop: true }); });
  return land.map((d) => d.id);
});
for (let i = 0; i < 100; i++) { const ok = await page.evaluate((ids) => { const a = window.__dino; a.step(2); return ids.every((id) => a.dinos.find((d) => d.id === id).real); }, t); if (ok) break; await page.waitForTimeout(80); }
const res = await page.evaluate((ids) => {
  const a = window.__dino;
  ids.forEach((id, i) => a.command(id, { walkTo: [60 - (i % 4) * 22, -30 - Math.floor(i / 4) * 22 + 40] }));
  a.step(30);
  const t0 = performance.now(); a.step(120); const ms = (performance.now() - t0) / 120;
  return { msPerFrameIncludingRender: +ms.toFixed(2), dinoMs: a.stats().dinoMs, animated: a.stats().dinos };
}, t);
console.log('16 walking:', JSON.stringify(res));
await browser.close(); try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill(); }
