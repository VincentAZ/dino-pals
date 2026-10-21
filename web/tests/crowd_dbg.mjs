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
const ids = await page.evaluate(() => {
  const a = window.__dino; a.pause(true); const sps = ['triceratops', 'stegosaurus', 'iguanodon', 'velociraptor', 'pachycephalosaurus'];
  const ids = []; let k = 0; for (const d of a.dinos) if (Math.hypot(d.x, d.z) < 120) a.command(d.id, { place: [300 + 30 * (k++), 300, 0], stop: true });
  sps.forEach((sp, i) => { const d = a.dinos.find((x) => x.species === sp); const ang = (i / sps.length) * Math.PI * 2; a.command(d.id, { place: [Math.cos(ang) * 14, -30 + Math.sin(ang) * 14, Math.atan2(-Math.cos(ang), -Math.sin(ang))], stop: true }); ids.push(d.id); });
  return ids;
});
for (let i = 0; i < 80; i++) { const ok = await page.evaluate((ids) => { const a = window.__dino; a.step(3); return ids.every((id) => a.dinos.find((d) => d.id === id).real); }, ids); if (ok) break; await page.waitForTimeout(50); }
await page.evaluate((ids) => { const a = window.__dino; ids.forEach((id, i) => { const ang = (i / ids.length) * Math.PI * 2 + Math.PI; a.command(id, { walkTo: [Math.cos(ang) * 14, -30 + Math.sin(ang) * 14] }); }); }, ids);
for (let t = 0; t < 12; t++) {
  const st = await page.evaluate((ids) => { const a = window.__dino; a.step(60); return ids.map((id) => { const l = a.loco(id); return `${id.split('-')[1].slice(0,5)} p${l.pos} v${l.speed} yv${l.yawVel} T${l.target} D${l.detour} an${l.animated}`; }); }, ids);
  console.log(`t=${(t + 1) * 2}s`); for (const s of st) console.log('  ', s);
}
await browser.close(); try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill(); }
