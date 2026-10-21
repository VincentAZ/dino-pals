import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4600 + Math.floor(Math.random() * 300);
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
server.stderr.on('data', (d) => process.stderr.write(d));
await new Promise((res, rej) => { server.stdout.on('data', (d) => { if (String(d).includes('localhost')) res(); }); setTimeout(() => rej(new Error('preview timeout')), 20000); });
console.error('server up');
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--enable-features=Vulkan'] });
const ctx = await browser.newContext({ ...devices['iPad Pro 11'], viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[console]', m.text().slice(0, 200)); });
await page.goto(`http://localhost:${PORT}/?q=high`, { waitUntil: 'load' });
console.error('page loaded'); await page.waitForSelector('#splash'); await page.waitForTimeout(300); console.error('splash');
await page.touchscreen.tap(590, 410);
await page.waitForFunction(() => window.__dino && window.__dino.ready, null, { timeout: 60000 });
console.error('ready');
const script = process.argv[2] || '';
await page.waitForFunction(() => !window.__dino.busy(), null, { timeout: 40000 }).catch(() => {});
await page.waitForTimeout(2500);
if (script) { await page.evaluate(script); await page.waitForFunction(() => !window.__dino.busy(), null, { timeout: 40000 }).catch(() => {}); await page.waitForTimeout(2500); }
const stats = await page.evaluate(() => window.__dino.stats());
console.log(JSON.stringify(stats));
const out = process.argv[3] || path.join(ROOT, 'tests', 'shots', 'probe.png');
await page.screenshot({ path: out });
await browser.close(); try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill(); }
