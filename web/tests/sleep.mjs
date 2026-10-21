import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/\/$/, '');   // web/ (this script lives in web/tests or web/scripts) const OUT = ROOT + '/tests/shots/sleep'; fs.mkdirSync(OUT, { recursive: true });
const PORT = 4600 + Math.floor(Math.random() * 300);
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('localhost')) res(); }));
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--enable-features=Vulkan'] });
const page = await (await browser.newContext({ ...devices['iPad Pro 11'], viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1 })).newPage();
const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://localhost:${PORT}/?q=high`); await page.waitForSelector('#splash'); await page.waitForTimeout(300); await page.touchscreen.tap(590, 410);
await page.waitForFunction(() => window.__dino && window.__dino.ready); await page.waitForFunction(() => !window.__dino.busy(), null, { timeout: 60000 }).catch(() => {});
await page.evaluate(() => { const a = window.__dino; a.pause(true); a.setTime(23.5); a.setView(Math.PI * 0.95, 0.22, 9); a.step(30); });
for (let i = 0; i < 6; i++) { await page.evaluate(() => window.__dino.step(60)); }
await page.screenshot({ path: `${OUT}/night_wide.png` });
const tri = await page.evaluate(() => window.__dino.dinos.find((d) => d.species === 'triceratops' && !d.baby && Math.hypot(d.x, d.z) < 40).id);
await page.evaluate((id) => window.__dino.watch(id, -1.3, 0.12, 9, 0.35), tri);
for (let f = 0; f < 4; f++) { await page.evaluate(() => window.__dino.step(20)); await page.screenshot({ path: `${OUT}/night_trike_${f}.png` }); }
console.log('states', JSON.stringify(await page.evaluate(() => { const c = {}; for (const d of window.__dino.dinos) if (Math.hypot(d.x, d.z) < 60) c[d.state] = (c[d.state] || 0) + 1; return c; })));
await page.evaluate(() => { const a = window.__dino; a.setTime(7.5); });
for (let f = 0; f < 6; f++) { await page.evaluate(() => window.__dino.step(15)); await page.screenshot({ path: `${OUT}/dawn_trike_${f}.png` }); }
console.log('states dawn', JSON.stringify(await page.evaluate(() => { const c = {}; for (const d of window.__dino.dinos) if (Math.hypot(d.x, d.z) < 60) c[d.state] = (c[d.state] || 0) + 1; return c; })));
console.log('errors', errors.length);
await browser.close(); try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill(); }
