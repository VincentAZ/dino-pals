// Pterosaur low pass: trigger a flyby and film it from the child's camera looking up.
import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const ROOT = '/home/vincent/Repos/dinos/web';
const OUT = ROOT + '/tests/shots/flyby'; fs.mkdirSync(OUT, { recursive: true });
const PORT = 4600 + Math.floor(Math.random() * 300);
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('localhost')) res(); }));
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--enable-features=Vulkan'] });
const page = await (await browser.newContext({ ...devices['iPad Pro 11'], viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true })).newPage();
const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://localhost:${PORT}/?q=high`); await page.waitForSelector('#splash'); await page.waitForTimeout(300); await page.touchscreen.tap(590, 410);
await page.waitForFunction(() => window.__dino && window.__dino.ready); await page.waitForFunction(() => !window.__dino.busy(), null, { timeout: 90000 }).catch(() => {});
const id = await page.evaluate(() => { const a = window.__dino; a.pause(true); a.setTime(12); a.teleport(0, 0); const p = a.dinos.find((d) => d.species === 'ornithocheirus'); a.command(p.id, { place: [20, -20, 0] }); return p.id; });
for (let i = 0; i < 150; i++) { const r = await page.evaluate((id) => { window.__dino.step(3); return window.__dino.dinos.find((d) => d.id === id).real; }, id); if (r) break; await page.waitForTimeout(50); }
await page.evaluate((id) => { const a = window.__dino; a.flyby(id); a.setView(0, -0.05, 6); }, id);
const ys = [];
for (let f = 0; f < 8; f++) { await page.evaluate(() => window.__dino.step(45)); const xy = await page.evaluate((id) => { const a = window.__dino; const d = a.dinos.find((x) => x.id === id); return [d.x, d.y, d.z]; }, id); ys.push(xy.map((v) => +v.toFixed(1))); await page.evaluate((id) => { const a = window.__dino; const d = a.dinos.find((x) => x.id === id); a.lookAt(d.x, d.z); a.setView(a.view().yaw, -0.25, 6); a.step(1, 0); }, id); await page.screenshot({ path: `${OUT}/f${f}.png` }); }
console.log('positions', JSON.stringify(ys));
console.log('errors', errors.length, errors.slice(0, 3));
await browser.close(); try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill(); }
