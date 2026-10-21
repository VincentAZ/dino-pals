import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
const ROOT = '/home/vincent/Repos/dinos/web';
const PORT = 4600 + Math.floor(Math.random() * 300);
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('localhost')) res(); }));
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--enable-features=Vulkan'] });
const page = await (await browser.newContext({ ...devices['iPad Pro 11'], viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1 })).newPage();
await page.goto(`http://localhost:${PORT}/?q=high`); await page.waitForSelector('#splash'); await page.waitForTimeout(300); await page.touchscreen.tap(590, 410);
await page.waitForFunction(() => window.__dino && window.__dino.ready);
const id = await page.evaluate(() => { const a = window.__dino; a.pause(true); a.teleport(0, 0); a.setView(0, 0.2, 7); const me = a.dinos.find((d) => d.species === 'trex'); let k = 0; for (const d of a.dinos) if (d.id !== me.id && Math.hypot(d.x, d.z) < 120) a.command(d.id, { place: [300 + 30 * (k++), 300, 0], stop: true }); a.command(me.id, { place: [8, -30, -0.4], stop: true }); return me.id; });
for (let i = 0; i < 100; i++) { const r = await page.evaluate((id) => { const a = window.__dino; a.step(3); return a.dinos.find((d) => d.id === id).real; }, id); if (r) break; await page.waitForTimeout(50); }
await page.evaluate((id) => { const a = window.__dino; a.command(id, { place: [8, -30, -0.4], stop: true }); a.command(id, { release: true }); a.step(20); a.dropFoodAt(0, -14); }, id);

for (let t = 0; t < 12; t++) console.log(JSON.stringify(await page.evaluate((id) => { const a = window.__dino; a.step(30); const l = a.loco(id); return { pos: l.pos, h: l.heading, st: l.state, v: l.speed, sniff: l.sniff, target: l.target, pa: l.progressAge, food: a.foods()[0] }; }, id)));
await browser.close(); try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill(); }
